import { Hono } from 'hono';
import { batchWeek, DAY_MS, LOG_SOURCES, localDate, READING_LIMITS, type Aeration, type Behavior, type LogData, type Pond, type Setting } from './domain.ts';
import type { Repo } from './db.ts';
import { knowledge } from './knowledge.ts';
import { AiFailed, AiUnavailable, type Ai, type CaptureKind } from './ai.ts';
import type { SaveCapture } from './captures.ts';
import { computeNowcast } from './nowcast.ts';
import { assessPond, classifyReading, limitsFor, overallLevel, type Limits, type Threshold } from './rules.ts';
import { geocode as defaultGeocode, getWeather as defaultGetWeather } from './weather.ts';

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
  for (const key of READINGS) {
    const v = num(body.readings?.[key], key, { min: READING_LIMITS[key][0], max: READING_LIMITS[key][1] });
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

  const aeration = oneOf(body.aeration, ['on', 'weak', 'off'] as const, 'aerasi');
  if (aeration) data.aeration = aeration;

  const waterChangePct = num(body.waterChangePct, 'ganti air', { min: 0, max: 100 });
  if (waterChangePct) data.waterChangePct = waterChangePct;

  const note = text(body.note, 'catatan');
  if (note) data.note = note;

  if (Object.keys(data).length === 0) throw new BadRequest('Catatan kosong');
  return data;
}

function pondProfile(body: Record<string, any>) {
  return {
    areaM2: num(body.areaM2, 'luas kolam', { min: 0.01 }) ?? null,
    setting: oneOf<Setting>(body.setting, ['outdoor', 'indoor'], 'tempat kolam') ?? null,
    shaded: typeof body.shaded === 'boolean' ? body.shaded : null,
    aeration: oneOf<Aeration>(body.aeration, ['full', 'partial', 'none'], 'aerasi') ?? null,
    depthCm: num(body.depthCm, 'kedalaman air', { min: 1, max: 500 }) ?? null,
  };
}

export interface ApiDeps {
  clock?: () => Date;
  getWeather?: typeof defaultGetWeather;
  geocode?: typeof defaultGeocode;
  ai?: Ai;
  saveCapture?: SaveCapture;
}

const MAX_IMAGES = 24;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

export function createApi(
  repo: Repo,
  { clock = () => new Date(), getWeather = defaultGetWeather, geocode = defaultGeocode, ai, saveCapture }: ApiDeps = {},
) {
  const api = new Hono();

  api.onError((err, c) => {
    if (err instanceof BadRequest) return c.json({ error: err.message }, 400);
    if (err instanceof AiUnavailable) return c.json({ error: err.message }, 503);
    if (err instanceof AiFailed) {
      console.error(err.message);
      return c.json({ error: 'AI gagal membaca. Coba lagi, atau isi manual.' }, 502);
    }
    console.error(err);
    return c.json({ error: 'Terjadi kesalahan di server' }, 500);
  });

  const timezone = () => repo.getFarm()?.timezone ?? 'Asia/Jakarta';

  function pondState(pond: Pond, now: Date) {
    const tz = timezone();
    const batch = repo.activeBatch(pond.id);
    const logs = repo.logsSince(pond.id, new Date(now.getTime() - 7 * DAY_MS).toISOString());

    let program = null;
    if (batch) {
      const week = batchWeek(batch, now, tz);
      const stage = batch.phase === 'glass_eel' ? (stages.find((s) => week >= s.weeks[0] && week <= s.weeks[1]) ?? null) : null;
      const dead = repo.totalMortality(batch.id);
      const estimatedAlive = batch.initialCount !== null ? Math.max(0, batch.initialCount - dead) : null;
      program = {
        week,
        stage,
        beyondProgram: batch.phase === 'glass_eel' && week > 12,
        estimatedAlive,
        totalDead: dead,
        density: estimatedAlive !== null && pond.areaM2 ? estimatedAlive / pond.areaM2 : null,
      };
    }
    return { batch, logs, program };
  }

  function pondSummary(pond: Pond) {
    const now = clock();
    const { batch, logs, program } = pondState(pond, now);
    const findings = assessPond(logs, thresholds, now, { phase: batch?.phase, density: program?.density ?? undefined });

    const latest: Partial<Record<(typeof READINGS)[number], { value: number; at: string }>> = {};
    for (const log of logs) {
      for (const key of READINGS) {
        const v = log.data.readings?.[key];
        if (v !== undefined && !latest[key]) latest[key] = { value: v, at: log.loggedAt };
      }
    }

    // Limits and a status for the three hand-measured readings, so the app can put a word
    // ("terlalu dingin") and a target band next to every number.
    const limits: Partial<Record<'temperature' | 'ph' | 'tds', Limits>> = {};
    const status: Partial<Record<'temperature' | 'ph' | 'tds', ReturnType<typeof classifyReading>>> = {};
    for (const key of ['temperature', 'ph', 'tds'] as const) {
      const t = thresholds.find((x) => x.id === key);
      if (!t) continue;
      limits[key] = limitsFor(t, batch?.phase);
      if (latest[key]) status[key] = classifyReading(latest[key]!.value, limits[key]!);
    }

    const lastLogAt = logs[0]?.loggedAt ?? null;
    return { ...pond, batch, program, latest, limits, status, lastLogAt, findings, level: overallLevel(findings) };
  }

  /** Days in a row with at least one measured reading on any pond, counting today or, if not yet, yesterday. */
  function streakDays() {
    const now = clock();
    const tz = timezone();
    const days = new Set<string>();
    for (const pond of repo.listPonds()) {
      for (const log of repo.logsSince(pond.id, new Date(now.getTime() - 60 * DAY_MS).toISOString())) {
        if (Object.keys(log.data.readings ?? {}).length) days.add(localDate(new Date(log.loggedAt), tz));
      }
    }
    let streak = 0;
    let day = now.getTime();
    if (!days.has(localDate(new Date(day), tz))) day -= DAY_MS;
    while (days.has(localDate(new Date(day), tz))) {
      streak++;
      day -= DAY_MS;
    }
    return streak;
  }

  /** Estimated conditions for every pond. Weather failures degrade the estimate, never the response. */
  async function nowcastAll() {
    const now = clock();
    const farm = repo.getFarm();
    let weather: Awaited<ReturnType<typeof getWeather>>['hours'] = [];
    let weatherError: string | null = null;
    if (farm?.lat != null && farm.lon != null) {
      try {
        weather = (await getWeather(farm.lat, farm.lon, now.getTime())).hours;
      } catch (err) {
        weatherError = (err as Error).message;
      }
    } else {
      weatherError = 'Lokasi tambak belum diatur';
    }
    const ponds = repo.listPonds().map((pond) => {
      const { batch, logs, program } = pondState(pond, now);
      return computeNowcast({
        pond,
        phase: batch?.phase,
        density: program?.density ?? undefined,
        logs,
        weather,
        thresholds,
        now: now.getTime(),
        timezone: timezone(),
      });
    });
    // The next hours for the weather card; the full series stays on the server.
    const hours = weather
      .filter((h) => h.t >= now.getTime() - 3600_000 && h.t <= now.getTime() + 24 * 3600_000)
      .map(({ t, airTemp, rain, cloud }) => ({ t, airTemp, rain, cloud }));
    return { generatedAt: now.getTime(), weather: { available: weather.length > 0, error: weatherError, place: farm?.locationName ?? null, hours }, ponds };
  }

  api.get('/farm', (c) => {
    const farm = repo.getFarm();
    return c.json({ farm, ponds: farm ? repo.listPonds().map(pondSummary) : [], today: localDate(clock(), timezone()), streak: farm ? streakDays() : 0 });
  });

  api.put('/farm', async (c) => {
    const body = await c.req.json();
    const locationName = text(body.locationName, 'lokasi');
    let lat = num(body.lat, 'lintang', { min: -90, max: 90 }) ?? null;
    let lon = num(body.lon, 'bujur', { min: -180, max: 180 }) ?? null;
    // No GPS: look the place name up so the weather still works.
    if ((lat === null || lon === null) && locationName) {
      const place = await geocode(locationName).catch(() => null);
      if (place) ({ lat, lon } = place);
    }
    repo.saveFarm({
      name: text(body.name, 'nama tambak', true)!,
      locationName,
      lat,
      lon,
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
      ...pondProfile(body),
    });
    return c.json({ pond: pondSummary(pond) }, 201);
  });

  api.put('/ponds/:id', async (c) => {
    const pond = repo.getPond(Number(c.req.param('id')));
    if (!pond) return c.json({ error: 'Kolam tidak ditemukan' }, 404);
    const body = await c.req.json();
    // Only fields present in the body change.
    const profile = pondProfile(body);
    const kept = Object.fromEntries(Object.entries(profile).map(([k, v]) => [k, k in body ? v : pond[k as keyof typeof profile]]));
    repo.updatePond({
      ...pond,
      ...(kept as typeof profile),
      name: text(body.name, 'nama kolam') ?? pond.name,
      kind: 'kind' in body ? text(body.kind, 'jenis kolam') : pond.kind,
      volumeL: 'volumeL' in body ? (num(body.volumeL, 'volume', { min: 0 }) ?? null) : pond.volumeL,
    });
    return c.json({ pond: pondSummary(repo.getPond(pond.id)!) });
  });

  api.get('/nowcast', async (c) => c.json(await nowcastAll()));

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

  api.get('/ai', (c) => c.json({ mode: ai?.mode ?? 'off' }));

  // Photo, voice note or daily video → a draft log. Nothing is saved to the pond here:
  // the farmer reviews the draft in the Record form and saves it as a normal log.
  api.post('/ponds/:id/capture', async (c) => {
    const pond = repo.getPond(Number(c.req.param('id')));
    if (!pond) return c.json({ error: 'Kolam tidak ditemukan' }, 404);
    if (!ai || ai.mode === 'off') throw new AiUnavailable('AI belum aktif. Isi manual dulu, atau coba lagi nanti.');
    const form = await c.req.parseBody({ all: true });
    const kind = oneOf<CaptureKind>(form.kind, ['photo', 'voice', 'video'], 'jenis rekaman');
    if (!kind) throw new BadRequest('jenis rekaman wajib diisi');
    const field = oneOf(form.field, ['temperature', 'ph', 'tds'] as const, 'kolom');
    const images = ([] as unknown[]).concat(form.image ?? []).filter((f): f is File => f instanceof File);
    const audio = form.audio instanceof File ? form.audio : undefined;
    if (images.length > MAX_IMAGES || images.some((f) => f.size > MAX_IMAGE_BYTES)) throw new BadRequest('Gambar terlalu banyak atau terlalu besar');
    if (audio && audio.size > MAX_AUDIO_BYTES) throw new BadRequest('Rekaman suara terlalu panjang');
    if (kind === 'photo' && !images.length) throw new BadRequest('Foto belum ada');
    if (kind === 'voice' && !audio) throw new BadRequest('Rekaman suara belum ada');
    if (kind === 'video' && !images.length && !audio) throw new BadRequest('Video belum ada');

    const batch = repo.activeBatch(pond.id);
    const started = Date.now();
    const draft = await ai.draft({ kind, field, images, audio, pondName: pond.name, phase: batch?.phase });
    await saveCapture?.(
      { pondId: pond.id, kind, field, at: clock().toISOString(), ms: Date.now() - started, draft },
      [...images.map((blob, i) => ({ name: `image-${i}.jpg`, blob })), ...(audio ? [{ name: `audio.${audio.type.includes('wav') ? 'wav' : 'webm'}`, blob: audio }] : [])],
    ).catch((err) => console.error('capture not stored:', err));
    return c.json({ draft });
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
      source: oneOf(body.source, LOG_SOURCES, 'sumber') ?? 'manual',
      data: parseLogData(body),
    });
    return c.json({ log, pond: pondSummary(pond) }, 201);
  });

  return api;
}
