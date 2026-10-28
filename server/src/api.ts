import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { batchWeek, DAY_MS, LOG_SOURCES, localDate, READING_LIMITS, type Aeration, type Behavior, type LogData, type Pond, type Setting } from './domain.ts';
import type { FarmRepo, Repo, Role } from './db.ts';
import { attemptLimiter, AuthError, checkPin, hashPin, hashToken, inviteCode, newToken, normalizePhone, tempPin, verifyPin } from './auth.ts';
import { knowledge } from './knowledge.ts';
import { AiFailed, AiUnavailable, type Ai, type CaptureKind, type ChatProvider } from './ai.ts';
import { runBriefing, type Briefing, type BriefingInput } from './agent.ts';
import { countDeadEels, type SamProvider } from './sam.ts';
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
  /** One name per deployment, so the preview and production on one domain keep separate logins. */
  cookieName?: string;
  /** Phone of the shared demo account behind "Coba demo"; unset turns the button off. */
  demoPhone?: string | null;
  /** Real AI reads per farm per day, so one farm cannot use up everyone's credits; 0 = no cap. */
  farmAiCap?: number;
  /** Models for the evening briefing agent, tried in order; empty = rules-only briefings. */
  agentProviders?: ChatProvider[];
  /** Meta Model API access for SAM 3.1 (counting dead eels in a photo). */
  sam?: SamProvider | null;
}

const MAX_IMAGES = 24;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const SESSION_DAYS = 90;
const INVITE_DAYS = 7;

type Env = { Variables: { userId: number; farmId: number | null; tokenHash: string; role: Role | null; r: FarmRepo } };

export function createApi(
  store: Repo,
  { clock = () => new Date(), getWeather = defaultGetWeather, geocode = defaultGeocode, ai, saveCapture, cookieName = 'synteel_session', demoPhone = null, farmAiCap = 0, agentProviders = [], sam = null }: ApiDeps = {},
) {
  const api = new Hono<Env>();
  const limiter = attemptLimiter();
  const aiUse = new Map<number, { day: string; used: number }>();

  /** Counts one real AI read for the farm; refuses once the farm's daily cap is reached. */
  function useAi(farmId: number) {
    if (!farmAiCap || ai?.mode !== 'meta') return;
    const day = clock().toISOString().slice(0, 10);
    const u = aiUse.get(farmId);
    const used = u?.day === day ? u.used : 0;
    if (used >= farmAiCap) throw new AiUnavailable('Jatah baca AI tambak ini untuk hari ini sudah habis. Rekaman disimpan di HP; ketik sendiri tetap bisa.');
    aiUse.set(farmId, { day, used: used + 1 });
  }

  api.onError((err, c) => {
    if (err instanceof BadRequest) return c.json({ error: err.message }, 400);
    if (err instanceof AuthError) return c.json({ error: err.message, code: err.status === 401 ? 'auth' : undefined }, err.status);
    if (err instanceof AiUnavailable) return c.json({ error: err.message }, 503);
    if (err instanceof AiFailed) {
      console.error(err.message);
      return c.json({ error: 'AI gagal membaca. Coba lagi, atau isi manual.' }, 502);
    }
    console.error(err);
    return c.json({ error: 'Terjadi kesalahan di server' }, 500);
  });

  const timezone = (r: FarmRepo) => r.getFarm()?.timezone ?? 'Asia/Jakarta';

  function pondState(r: FarmRepo, pond: Pond, now: Date) {
    const tz = timezone(r);
    const batch = r.activeBatch(pond.id);
    const logs = r.logsSince(pond.id, new Date(now.getTime() - 7 * DAY_MS).toISOString());

    let program = null;
    if (batch) {
      const week = batchWeek(batch, now, tz);
      const stage = batch.phase === 'glass_eel' ? (stages.find((s) => week >= s.weeks[0] && week <= s.weeks[1]) ?? null) : null;
      const dead = r.totalMortality(batch.id);
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

  function pondSummary(r: FarmRepo, pond: Pond) {
    const now = clock();
    const { batch, logs, program } = pondState(r, pond, now);
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
  function streakDays(r: FarmRepo) {
    const now = clock();
    const tz = timezone(r);
    const days = new Set<string>();
    for (const pond of r.listPonds()) {
      for (const log of r.logsSince(pond.id, new Date(now.getTime() - 60 * DAY_MS).toISOString())) {
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

  /** Estimated conditions for every pond of one farm. Weather failures degrade the estimate, never the response. */
  async function nowcastAll(r: FarmRepo) {
    const now = clock();
    const farm = r.getFarm();
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
    const ponds = r.listPonds().map((pond) => {
      const { batch, logs, program } = pondState(r, pond, now);
      return computeNowcast({
        pond,
        phase: batch?.phase,
        density: program?.density ?? undefined,
        logs,
        weather,
        thresholds,
        now: now.getTime(),
        timezone: timezone(r),
      });
    });
    // The next hours for the weather card; the full series stays on the server.
    const hours = weather
      .filter((h) => h.t >= now.getTime() - 3600_000 && h.t <= now.getTime() + 24 * 3600_000)
      .map(({ t, airTemp, rain, cloud }) => ({ t, airTemp, rain, cloud }));
    return { generatedAt: now.getTime(), weather: { available: weather.length > 0, error: weatherError, place: farm?.locationName ?? null, hours }, ponds };
  }

  // ---------- evening briefing ----------

  const MAX_BRIEFINGS_PER_DAY = 4;

  /** Compact daily history of one pond for the agent's get_pond_history tool. */
  function pondHistory(r: FarmRepo, pondId: number, days: number) {
    const tz = timezone(r);
    const byDay = new Map<string, { temp: number[]; ph?: number; tds?: number; dead: number; leftover?: string; behavior: Set<string>; aeration?: string }>();
    for (const l of r.logsSince(pondId, new Date(clock().getTime() - days * DAY_MS).toISOString()).reverse()) {
      const day = localDate(new Date(l.loggedAt), tz);
      const d = byDay.get(day) ?? { temp: [], dead: 0, behavior: new Set() };
      const rd = l.data.readings ?? {};
      if (rd.temperature !== undefined) d.temp.push(rd.temperature);
      if (rd.ph !== undefined) d.ph = rd.ph;
      if (rd.tds !== undefined) d.tds = rd.tds;
      d.dead += l.data.mortality ?? 0;
      if (l.data.feeding?.leftover) d.leftover = l.data.feeding.leftover;
      for (const b of l.data.behavior ?? []) d.behavior.add(b);
      if (l.data.aeration) d.aeration = l.data.aeration;
      byDay.set(day, d);
    }
    return [...byDay.entries()].map(([date, d]) => ({
      date,
      water_temp: d.temp.length ? { min: Math.min(...d.temp), max: Math.max(...d.temp) } : null,
      ph: d.ph ?? null,
      tds: d.tds ?? null,
      dead: d.dead,
      feed_left: d.leftover ?? null,
      behavior: [...d.behavior],
      aerator: d.aeration ?? null,
    }));
  }

  async function makeBriefing(r: FarmRepo): Promise<Briefing> {
    const now = clock();
    const nc = await nowcastAll(r);
    const farm = r.getFarm()!;
    const input: BriefingInput = {
      farmName: farm.name,
      now: now.getTime(),
      timezone: farm.timezone,
      ponds: r.listPonds().map((p) => {
        const s = pondSummary(r, p);
        return {
          id: p.id,
          name: p.name,
          phase: s.batch?.phase ?? null,
          week: s.program?.week ?? null,
          level: s.level,
          findings: s.findings.map((f) => ({ title: f.title, level: f.level })),
          latest: s.latest as BriefingInput['ponds'][number]['latest'],
          lastLogAt: s.lastLogAt,
        };
      }),
      nowcasts: nc.ponds,
      weather: nc.weather.hours,
      history: (pondId, days) => pondHistory(r, pondId, days),
    };
    const briefing = await runBriefing(input, ai?.mode === 'meta' ? agentProviders : []);
    r.saveBriefing(localDate(now, timezone(r)), briefing);
    return briefing;
  }

  // ---------- sessions ----------

  const clientIp = (c: Context) => c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0].trim() ?? 'local';

  function startSession(c: Context, userId: number, farmId: number | null) {
    const token = newToken();
    store.createSession(hashToken(token), userId, farmId, SESSION_DAYS);
    setCookie(c, cookieName, token, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: c.req.header('x-forwarded-proto') === 'https',
      path: '/',
      maxAge: SESSION_DAYS * 86400,
    });
  }

  function me(userId: number, farmId: number | null) {
    const farms = store.farmsOf(userId);
    return { user: store.user(userId), farm: farms.find((f) => f.id === farmId) ?? null, farms, demo: store.user(userId)?.phone === demoPhone };
  }

  // ---------- public routes: everything registered before the session check below ----------

  api.get('/auth/options', (c) => c.json({ demo: Boolean(demoPhone && store.userByPhone(demoPhone)) }));

  api.post('/auth/register', async (c) => {
    const body = await c.req.json();
    const phone = normalizePhone(body.phone);
    const pin = checkPin(body.pin);
    const name = text(body.name, 'nama', true)!;
    if (store.userByPhone(phone)) throw new AuthError('Nomor ini sudah terdaftar. Silakan masuk.', 409);
    const user = store.createUser({ phone, name, pinHash: hashPin(pin) });
    startSession(c, user.id, null);
    return c.json(me(user.id, null), 201);
  });

  api.post('/auth/login', async (c) => {
    const body = await c.req.json();
    const phone = normalizePhone(body.phone);
    const keys = [`phone:${phone}`, `ip:${clientIp(c)}`];
    limiter.check(...keys);
    const user = store.userByPhone(phone);
    if (!user || !verifyPin(String(body.pin ?? ''), user.pinHash)) {
      limiter.fail(...keys);
      throw new AuthError('Nomor HP atau PIN salah');
    }
    limiter.clear(`phone:${phone}`);
    const farmId = store.farmsOf(user.id)[0]?.id ?? null;
    startSession(c, user.id, farmId);
    return c.json(me(user.id, farmId));
  });

  // The shared demo farm for judges and visitors: no sign-up, reset every night.
  api.post('/auth/demo', (c) => {
    const user = demoPhone ? store.userByPhone(demoPhone) : null;
    if (!user) throw new AuthError('Demo tidak tersedia', 403);
    const farmId = store.farmsOf(user.id)[0]?.id ?? null;
    startSession(c, user.id, farmId);
    return c.json(me(user.id, farmId));
  });

  api.get('/auth/invite/:code', (c) => {
    const invite = store.invite(c.req.param('code').toUpperCase());
    if (!invite) throw new AuthError('Kode undangan tidak berlaku', 400);
    return c.json({ farmName: invite.farmName, role: invite.role });
  });

  // Join a farm with an owner's code: a new person signs up, someone with an account adds the farm.
  api.post('/auth/join', async (c) => {
    const body = await c.req.json();
    const code = String(body.code ?? '').trim().toUpperCase();
    const invite = store.invite(code);
    if (!invite) throw new AuthError('Kode undangan tidak berlaku', 400);
    const phone = normalizePhone(body.phone);
    let user = store.userByPhone(phone);
    if (user) {
      const keys = [`phone:${phone}`, `ip:${clientIp(c)}`];
      limiter.check(...keys);
      if (!verifyPin(String(body.pin ?? ''), user.pinHash)) {
        limiter.fail(...keys);
        throw new AuthError('Nomor ini sudah terdaftar. Masukkan PIN yang benar.');
      }
    } else {
      user = { ...store.createUser({ phone, name: text(body.name, 'nama', true)!, pinHash: hashPin(checkPin(body.pin)) }), pinHash: '' };
    }
    // Joining never demotes an owner.
    if (store.role(user.id, invite.farmId) !== 'owner') store.addMember(user.id, invite.farmId, invite.role);
    store.useInvite(code, user.id);
    startSession(c, user.id, invite.farmId);
    return c.json(me(user.id, invite.farmId));
  });

  api.get('/ai', (c) => c.json({ mode: ai?.mode ?? 'off' }));

  // ---------- everything below needs a session ----------

  api.use('*', async (c, next) => {
    const token = getCookie(c, cookieName);
    const session = token ? store.session(hashToken(token)) : null;
    if (!token || !session) throw new AuthError('Silakan masuk dulu');
    const role = session.farmId === null ? null : store.role(session.userId, session.farmId);
    const farmId = role ? session.farmId : null;
    c.set('userId', session.userId);
    c.set('tokenHash', hashToken(token));
    c.set('farmId', farmId);
    c.set('role', role);
    if (farmId !== null) c.set('r', store.farm(farmId));
    await next();
  });

  const needFarm = (c: Context<Env>) => {
    if (c.get('farmId') === null) throw new AuthError('Tambak belum dibuat', 409);
    return c.get('r');
  };
  const needOwner = (c: Context<Env>) => {
    const r = needFarm(c);
    if (c.get('role') !== 'owner') throw new AuthError('Hanya pemilik tambak yang bisa mengubah ini', 403);
    return r;
  };

  api.get('/auth/me', (c) => c.json(me(c.get('userId'), c.get('farmId'))));

  api.post('/auth/logout', (c) => {
    store.deleteSession(c.get('tokenHash'));
    deleteCookie(c, cookieName, { path: '/' });
    return c.body(null, 204);
  });

  api.post('/auth/switch', async (c) => {
    const farmId = Number((await c.req.json()).farmId);
    if (!store.role(c.get('userId'), farmId)) throw new AuthError('Bukan anggota tambak ini', 403);
    store.setSessionFarm(c.get('tokenHash'), farmId);
    return c.json(me(c.get('userId'), farmId));
  });

  api.put('/auth/pin', async (c) => {
    const body = await c.req.json();
    const user = store.userByPhone(store.user(c.get('userId'))!.phone)!;
    if (user.phone === demoPhone) throw new AuthError('PIN akun demo tidak bisa diubah', 403);
    const keys = [`phone:${user.phone}`];
    limiter.check(...keys);
    if (!verifyPin(String(body.pin ?? ''), user.pinHash)) {
      limiter.fail(...keys);
      throw new AuthError('PIN lama salah', 403);
    }
    store.setPin(user.id, hashPin(checkPin(body.newPin)));
    // setPin ended every session, including this one: start a fresh one here.
    startSession(c, user.id, c.get('farmId'));
    return c.body(null, 204);
  });

  api.get('/farm', (c) => {
    const farmId = c.get('farmId');
    if (farmId === null) return c.json({ farm: null, ponds: [], today: localDate(clock(), 'Asia/Jakarta'), streak: 0, role: null });
    const r = c.get('r');
    return c.json({ farm: r.getFarm(), ponds: r.listPonds().map((p) => pondSummary(r, p)), today: localDate(clock(), timezone(r)), streak: streakDays(r), role: c.get('role') });
  });

  // Creates the person's first farm, or (owner only) updates the current one.
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
    const farm = {
      name: text(body.name, 'nama tambak', true)!,
      locationName,
      lat,
      lon,
      timezone: text(body.timezone, 'zona waktu') ?? 'Asia/Jakarta',
    };
    if (c.get('farmId') === null) {
      const id = store.createFarm(farm, c.get('userId'));
      store.setSessionFarm(c.get('tokenHash'), id);
      return c.json({ farm: store.farm(id).getFarm() }, 201);
    }
    const r = needOwner(c);
    r.saveFarm(farm);
    return c.json({ farm: r.getFarm() });
  });

  api.get('/briefing', (c) => {
    const r = needFarm(c);
    return c.json({ briefing: r.briefing<Briefing>(localDate(clock(), timezone(r))) });
  });

  // Ask for a fresh briefing now (the server also makes one by itself every evening).
  api.post('/briefing', async (c) => {
    const r = needFarm(c);
    if (r.listPonds().length === 0) throw new BadRequest('Belum ada kolam');
    if (r.briefingsOn(localDate(clock(), timezone(r))) >= MAX_BRIEFINGS_PER_DAY) throw new BadRequest('Briefing hari ini sudah disusun beberapa kali. Coba lagi besok.');
    return c.json({ briefing: await makeBriefing(r) }, 201);
  });

  // ---------- members ----------

  api.get('/farm/members', (c) => {
    needFarm(c);
    // Workers see names only; owners also see phone numbers, to reach them.
    const owner = c.get('role') === 'owner';
    return c.json({ members: store.members(c.get('farmId')!).map((m) => ({ ...m, phone: owner ? m.phone : undefined, me: m.id === c.get('userId') })) });
  });

  api.post('/farm/invites', async (c) => {
    needOwner(c);
    const role = oneOf<Role>((await c.req.json().catch(() => ({}))).role, ['owner', 'worker'], 'peran') ?? 'worker';
    const code = inviteCode();
    store.createInvite({ code, farmId: c.get('farmId')!, role, createdBy: c.get('userId'), days: INVITE_DAYS });
    return c.json({ code, role, expiresInDays: INVITE_DAYS }, 201);
  });

  api.delete('/farm/members/:userId', (c) => {
    needOwner(c);
    const userId = Number(c.req.param('userId'));
    if (userId === c.get('userId')) throw new BadRequest('Tidak bisa mengeluarkan diri sendiri');
    store.removeMember(userId, c.get('farmId')!);
    return c.body(null, 204);
  });

  // A worker forgot their PIN: the owner gets a temporary one to pass on.
  api.post('/farm/members/:userId/pin', (c) => {
    needOwner(c);
    const userId = Number(c.req.param('userId'));
    if (!store.role(userId, c.get('farmId')!)) throw new AuthError('Bukan anggota tambak ini', 403);
    const pin = tempPin();
    store.setPin(userId, hashPin(pin));
    return c.json({ pin });
  });

  // ---------- ponds ----------

  api.post('/ponds', async (c) => {
    const r = needOwner(c);
    const body = await c.req.json();
    const pond = r.addPond({
      name: text(body.name, 'nama kolam', true)!,
      kind: text(body.kind, 'jenis kolam'),
      volumeL: num(body.volumeL, 'volume', { min: 0 }) ?? null,
      ...pondProfile(body),
    });
    return c.json({ pond: pondSummary(r, pond) }, 201);
  });

  api.put('/ponds/:id', async (c) => {
    const r = needOwner(c);
    const pond = r.getPond(Number(c.req.param('id')));
    if (!pond) return c.json({ error: 'Kolam tidak ditemukan' }, 404);
    const body = await c.req.json();
    // Only fields present in the body change.
    const profile = pondProfile(body);
    const kept = Object.fromEntries(Object.entries(profile).map(([k, v]) => [k, k in body ? v : pond[k as keyof typeof profile]]));
    r.updatePond({
      ...pond,
      ...(kept as typeof profile),
      name: text(body.name, 'nama kolam') ?? pond.name,
      kind: 'kind' in body ? text(body.kind, 'jenis kolam') : pond.kind,
      volumeL: 'volumeL' in body ? (num(body.volumeL, 'volume', { min: 0 }) ?? null) : pond.volumeL,
    });
    return c.json({ pond: pondSummary(r, r.getPond(pond.id)!) });
  });

  api.get('/nowcast', async (c) => c.json(await nowcastAll(needFarm(c))));

  api.delete('/ponds/:id', (c) => {
    needOwner(c).archivePond(Number(c.req.param('id')));
    return c.body(null, 204);
  });

  api.get('/ponds/:id', (c) => {
    const r = needFarm(c);
    const pond = r.getPond(Number(c.req.param('id')));
    if (!pond) return c.json({ error: 'Kolam tidak ditemukan' }, 404);
    const since = new Date(clock().getTime() - 14 * DAY_MS).toISOString();
    return c.json({ pond: pondSummary(r, pond), logs: r.logsSince(pond.id, since) });
  });

  api.post('/ponds/:id/batches', async (c) => {
    const r = needOwner(c);
    const pond = r.getPond(Number(c.req.param('id')));
    if (!pond) return c.json({ error: 'Kolam tidak ditemukan' }, 404);
    const body = await c.req.json();
    const stockedAt = text(body.stockedAt, 'tanggal tebar', true)!;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(stockedAt)) throw new BadRequest('tanggal tebar tidak valid');
    r.startBatch(
      {
        pondId: pond.id,
        phase: oneOf(body.phase, ['glass_eel', 'elver'] as const, 'fase') ?? 'glass_eel',
        stockedAt,
        initialCount: num(body.initialCount, 'jumlah tebar', { min: 0 }) ?? null,
      },
      localDate(clock(), timezone(r)),
    );
    return c.json({ pond: pondSummary(r, pond) }, 201);
  });

  // Photo, voice note or daily video → a draft log. Nothing is saved to the pond here:
  // the farmer reviews the draft in the Record form and saves it as a normal log.
  api.post('/ponds/:id/capture', async (c) => {
    const r = needFarm(c);
    const pond = r.getPond(Number(c.req.param('id')));
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

    useAi(r.farmId);
    const batch = r.activeBatch(pond.id);
    const started = Date.now();
    const draft = await ai.draft({ kind, field, images, audio, pondName: pond.name, phase: batch?.phase });
    await saveCapture?.(
      { farmId: r.farmId, pondId: pond.id, kind, field, at: clock().toISOString(), ms: Date.now() - started, draft },
      [...images.map((blob, i) => ({ name: `image-${i}.jpg`, blob })), ...(audio ? [{ name: `audio.${audio.type.includes('wav') ? 'wav' : 'webm'}`, blob: audio }] : [])],
    ).catch((err) => console.error('capture not stored:', err));
    return c.json({ draft });
  });

  // Dead eels laid in a white basin → a count with one outline per eel (Meta SAM 3.1).
  // Like a capture, nothing is saved: the farmer confirms or corrects the count first.
  api.post('/ponds/:id/count', async (c) => {
    const r = needFarm(c);
    const pond = r.getPond(Number(c.req.param('id')));
    if (!pond) return c.json({ error: 'Kolam tidak ditemukan' }, 404);
    const form = await c.req.parseBody();
    const image = form.image instanceof File ? form.image : null;
    if (!image) throw new BadRequest('Foto belum ada');
    if (image.size > MAX_IMAGE_BYTES) throw new BadRequest('Foto terlalu besar');
    if (ai?.mode === 'mock') return c.json({ result: { count: 0, eels: [], review: true, model: 'mock', ms: 0 }, mock: true });
    if (ai?.mode !== 'meta' || !sam?.apiKey) throw new AiUnavailable('Hitung otomatis belum aktif. Hitung manual dulu.');
    // Part of an emergency report: it does not use the farm's daily AI quota (the app promises that).
    const result = await countDeadEels(image, sam);
    await saveCapture?.({ farmId: r.farmId, pondId: pond.id, kind: 'count', at: clock().toISOString(), ms: result.ms, count: result.count, review: result.review }, [{ name: 'image-0.jpg', blob: image }]).catch((err) =>
      console.error('capture not stored:', err),
    );
    return c.json({ result });
  });

  api.post('/ponds/:id/logs', async (c) => {
    const r = needFarm(c);
    const pond = r.getPond(Number(c.req.param('id')));
    if (!pond) return c.json({ error: 'Kolam tidak ditemukan' }, 404);
    const body = await c.req.json();
    const loggedAt = body.loggedAt ? new Date(body.loggedAt) : clock();
    if (Number.isNaN(loggedAt.getTime())) throw new BadRequest('waktu catat tidak valid');
    const log = r.addLog({
      pondId: pond.id,
      batchId: r.activeBatch(pond.id)?.id ?? null,
      loggedAt: loggedAt.toISOString(),
      source: oneOf(body.source, LOG_SOURCES, 'sumber') ?? 'manual',
      data: parseLogData(body),
    });
    return c.json({ log, pond: pondSummary(r, pond) }, 201);
  });

  // For the server's own background monitor, which has no session.
  return Object.assign(api, {
    nowcastFarm: (farmId: number) => nowcastAll(store.farm(farmId)),
    /** The evening run: a briefing for every farm with ponds that has none yet today, from `hour` local time. */
    async briefFarms(hour = 17) {
      for (const id of store.farmIds()) {
        const r = store.farm(id);
        const farm = r.getFarm();
        if (!farm || r.listPonds().length === 0) continue;
        const localHour = Number(clock().toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: farm.timezone }));
        if (localHour < hour || r.briefing(localDate(clock(), farm.timezone))) continue;
        await makeBriefing(r).catch((err) => console.error(`briefing farm ${id}:`, err));
      }
    },
  });
}
