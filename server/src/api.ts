import { Hono } from 'hono';
import { batchWeek, DAY_MS, localDate, type Behavior, type LogData, type Pond } from './domain.ts';
import type { Repo } from './db.ts';
import { knowledge } from './knowledge.ts';
import { assessPond, overallLevel, type Threshold } from './rules.ts';

const thresholds = knowledge.thresholds.parameters as Threshold[];
const stages = knowledge.nurseryProgram.stages as { weeks: [number, number]; name: string; feed: string; mesh_mm: string; water: string }[];

const BEHAVIORS: Behavior[] = ['normal', 'surfacing', 'gathering_inlet', 'not_eating', 'lethargic'];
const READINGS = ['temperature', 'ph', 'tds', 'do', 'tan', 'no2'] as const;

class BadRequest extends Error {}

function num(v: unknown, field: string, { min = -Infinity, max = Infinity } = {}): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new BadRequest(`${field} tidak valid`);
  return n;
}

function text(v: unknown, field: string, required = false): string | null {
  if (v === undefined || v === null || String(v).trim() === '') {
    if (required) throw new BadRequest(`${field} wajib diisi`);
    return null;
  }
  return String(v).trim().slice(0, 200);
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], field: string): T | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (!allowed.includes(v as T)) throw new BadRequest(`${field} tidak valid`);
  return v as T;
}

function parseLogData(body: Record<string, any>): LogData {
  const data: LogData = {};
  const readings: LogData['readings'] = {};
  const limits: Record<(typeof READINGS)[number], [number, number]> = {
    temperature: [0, 45], ph: [0, 14], tds: [0, 50000], do: [0, 30], tan: [0, 50], no2: [0, 50],
  };
  for (const key of READINGS) {
    const v = num(body.readings?.[key], key, { min: limits[key][0], max: limits[key][1] });
    if (v !== undefined) readings[key] = v;
  }
  if (Object.keys(readings).length) data.readings = readings;

  const leftover = oneOf(body.feeding?.leftover, ['none', 'little', 'much'] as const, 'sisa pakan');
  if (leftover) data.feeding = { leftover };

  const mortality = num(body.mortality, 'jumlah mati', { min: 0, max: 1_000_000 });
  if (mortality) data.mortality = Math.round(mortality);

  if (Array.isArray(body.behavior)) {
    const behavior = body.behavior.map((b: unknown) => oneOf(b, BEHAVIORS, 'perilaku')!).filter(Boolean);
    if (behavior.length) data.behavior = [...new Set(behavior)] as Behavior[];
  }

  const color = oneOf(body.water?.color, ['clear', 'green', 'brown', 'cloudy'] as const, 'warna air');
  const smell = oneOf(body.water?.smell, ['normal', 'foul'] as const, 'bau air');
  if (color || smell) data.water = { ...(color && { color }), ...(smell && { smell }) };

  const waterChangePct = num(body.waterChangePct, 'ganti air', { min: 0, max: 100 });
  if (waterChangePct) data.waterChangePct = waterChangePct;

  const note = text(body.note, 'catatan');
  if (note) data.note = note;

  if (Object.keys(data).length === 0) throw new BadRequest('Catatan kosong');
  return data;
}

export function createApi(repo: Repo, clock: () => Date = () => new Date()) {
  const api = new Hono();

  api.onError((err, c) => {
    if (err instanceof BadRequest) return c.json({ error: err.message }, 400);
    console.error(err);
    return c.json({ error: 'Terjadi kesalahan di server' }, 500);
  });

  const timezone = () => repo.getFarm()?.timezone ?? 'Asia/Jakarta';

  function pondSummary(pond: Pond) {
    const now = clock();
    const tz = timezone();
    const batch = repo.activeBatch(pond.id);
    const logs = repo.logsSince(pond.id, new Date(now.getTime() - 7 * DAY_MS).toISOString());
    const findings = assessPond(logs, thresholds, now);

    let program = null;
    if (batch) {
      const week = batchWeek(batch, now, tz);
      const stage = batch.phase === 'glass_eel' ? (stages.find((s) => week >= s.weeks[0] && week <= s.weeks[1]) ?? null) : null;
      const dead = repo.totalMortality(batch.id);
      program = {
        week,
        stage,
        beyondProgram: batch.phase === 'glass_eel' && week > 12,
        estimatedAlive: batch.initialCount !== null ? Math.max(0, batch.initialCount - dead) : null,
        totalDead: dead,
      };
    }

    const latest: Partial<Record<(typeof READINGS)[number], { value: number; at: string }>> = {};
    for (const log of logs) {
      for (const key of READINGS) {
        const v = log.data.readings?.[key];
        if (v !== undefined && !latest[key]) latest[key] = { value: v, at: log.loggedAt };
      }
    }

    return { ...pond, batch, program, latest, findings, level: overallLevel(findings) };
  }

  api.get('/farm', (c) => {
    const farm = repo.getFarm();
    return c.json({ farm, ponds: farm ? repo.listPonds().map(pondSummary) : [], today: localDate(clock(), timezone()) });
  });

  api.put('/farm', async (c) => {
    const body = await c.req.json();
    repo.saveFarm({
      name: text(body.name, 'nama tambak', true)!,
      locationName: text(body.locationName, 'lokasi'),
      lat: num(body.lat, 'lintang', { min: -90, max: 90 }) ?? null,
      lon: num(body.lon, 'bujur', { min: -180, max: 180 }) ?? null,
      timezone: text(body.timezone, 'zona waktu') ?? 'Asia/Jakarta',
    });
    return c.json({ farm: repo.getFarm() });
  });

  api.post('/ponds', async (c) => {
    const body = await c.req.json();
    const pond = repo.addPond({
      name: text(body.name, 'nama kolam', true)!,
      kind: text(body.kind, 'jenis kolam'),
      volumeL: num(body.volumeL, 'volume', { min: 0 }) ?? null,
    });
    return c.json({ pond: pondSummary(pond) }, 201);
  });

  api.delete('/ponds/:id', (c) => {
    repo.archivePond(Number(c.req.param('id')));
    return c.body(null, 204);
  });

  api.get('/ponds/:id', (c) => {
    const pond = repo.getPond(Number(c.req.param('id')));
    if (!pond) return c.json({ error: 'Kolam tidak ditemukan' }, 404);
    const since = new Date(clock().getTime() - 14 * DAY_MS).toISOString();
    return c.json({ pond: pondSummary(pond), logs: repo.logsSince(pond.id, since) });
  });

  api.post('/ponds/:id/batches', async (c) => {
    const pond = repo.getPond(Number(c.req.param('id')));
    if (!pond) return c.json({ error: 'Kolam tidak ditemukan' }, 404);
    const body = await c.req.json();
    const stockedAt = text(body.stockedAt, 'tanggal tebar', true)!;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(stockedAt)) throw new BadRequest('tanggal tebar tidak valid');
    repo.startBatch(
      {
        pondId: pond.id,
        phase: oneOf(body.phase, ['glass_eel', 'elver'] as const, 'fase') ?? 'glass_eel',
        stockedAt,
        initialCount: num(body.initialCount, 'jumlah tebar', { min: 0 }) ?? null,
      },
      localDate(clock(), timezone()),
    );
    return c.json({ pond: pondSummary(pond) }, 201);
  });

  api.post('/ponds/:id/logs', async (c) => {
    const pond = repo.getPond(Number(c.req.param('id')));
    if (!pond) return c.json({ error: 'Kolam tidak ditemukan' }, 404);
    const body = await c.req.json();
    const loggedAt = body.loggedAt ? new Date(body.loggedAt) : clock();
    if (Number.isNaN(loggedAt.getTime())) throw new BadRequest('waktu catat tidak valid');
    const log = repo.addLog({
      pondId: pond.id,
      batchId: repo.activeBatch(pond.id)?.id ?? null,
      loggedAt: loggedAt.toISOString(),
      source: 'manual',
      data: parseLogData(body),
    });
    return c.json({ log, pond: pondSummary(pond) }, 201);
  });

  return api;
}
