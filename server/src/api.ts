import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { batchWeek, DAY_MS, LOG_SOURCES, localDate, READING_LIMITS, type Aeration, type Behavior, type Level, type Log, type LogData, type Phase, type Pond, type Setting } from './domain.ts';
import type { FarmRepo, LogRecord, Repo, Role } from './db.ts';
import type { HistoryLog, QuotaState, SupportTopic } from './contract.ts';
import type { SendMail } from './mail.ts';
import { attemptLimiter, AuthError, checkPin, hashPin, hashToken, inviteCode, newToken, normalizePhone, tempPin, verifyPin } from './auth.ts';
import { knowledge } from './knowledge.ts';
import { KINDS, SCENARIOS, sendEveryMs, simulate, toLogData, type Device, type DeviceKind, type Scenario } from './devices.ts';
import { currentLang, parseLang, tx, withLang } from './i18n.ts';
import { AiFailed, AiUnavailable, type Ai, type CaptureKind, type ChatProvider } from './ai.ts';
import { rulesBriefing, runBriefing, type Briefing, type BriefingInput } from './agent.ts';
import { countDeadEels, type SamProvider } from './sam.ts';
import type { SaveCapture } from './captures.ts';
import { computeNowcast } from './nowcast.ts';
import { assessPond, classifyReading, limitsFor, overallLevel, type Limits, type Threshold } from './rules.ts';
import { geocode as defaultGeocode, getWeather as defaultGetWeather } from './weather.ts';

const thresholds = knowledge.thresholds.parameters as Threshold[];
const stages = knowledge.nurseryProgram.stages as { weeks: [number, number]; name: string; feed: string; mesh_mm: string; water: string }[];

// English for knowledge/nursery-program.json stages, in the same order.
const STAGE_EN: { name: string; feed: string; mesh_mm: string; water: string }[] = [
  {
    name: 'Arrival and acclimation',
    feed: 'No feed for 24–48 hours, then a little chopped bloodworm',
    mesh_mm: '0.5',
    water: 'Start at the salinity the seed came from, lower it to fresh water over 5–7 days; raise the temperature about 1 °C every 12 hours to 27–28 °C',
  },
  { name: 'Feed adaptation', feed: 'Chopped frozen bloodworm or tubifex, 8–10% of wet body weight a day, 6–8 feeds', mesh_mm: '0.5', water: 'DO ≥ 6 mg/L, TAN < 0.5 mg/L' },
  { name: 'Paste transition', feed: 'Worms mixed with formulated feed, the formulated share rising step by step, 6–8%', mesh_mm: '1', water: 'Watch NO₂ and turbidity as the feed load rises' },
  { name: 'Growth', feed: 'Full paste 5–6%, 4–6 feeds', mesh_mm: '1–1.5', water: 'Biofilter close to full load; keep pH 7.0–7.8' },
  { name: 'Harvest preparation', feed: 'Paste or crumble 3–5%', mesh_mm: '2', water: 'Biofilter (TAN) limit at the target stocking density; harvest per batch or pond' },
];

const BEHAVIORS: Behavior[] = ['normal', 'surfacing', 'gathering_inlet', 'not_eating', 'lethargic'];
const READINGS = ['temperature', 'ph', 'tds', 'do', 'tan', 'no2'] as const;

class BadRequest extends Error {}

// English for the field names in validation errors (the Indonesian name is the key).
const FIELD_EN: Record<string, string> = {
  'sisa pakan': 'Leftover feed', 'jumlah mati': 'Number dead', 'warna air': 'Water color', 'bau air': 'Water smell',
  'ganti air': 'Water change', 'luas kolam': 'Pond area', 'tempat kolam': 'Pond setting', 'kedalaman air': 'Water depth',
  'nama kolam': 'Pond name', 'jenis kolam': 'Pond type', 'jenis rekaman': 'Recording type', 'Nomor WhatsApp': 'WhatsApp number',
  'Nomor HP akun': 'Account phone number', aerasi: 'Aeration', aerator: 'Aerator', fase: 'Phase',
};
const fieldName = (f: string) => tx(f, FIELD_EN[f] ?? f);
const invalid = (field: string) => new BadRequest(tx(`${field} tidak valid`, `${fieldName(field)} is not valid`));
class NotFound extends Error {}
/** The farm's AI reads for today are used up (429, code 'ai_quota'). */
class AiQuota extends Error {}

function num(v: unknown, field: string, { min = -Infinity, max = Infinity } = {}): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw invalid(field);
  return n;
}

function text(v: unknown, field: string, required = false): string | null {
  if (v === undefined || v === null || String(v).trim() === '') {
    if (required) throw new BadRequest(tx(`${field} wajib diisi`, `${fieldName(field)} is required`));
    return null;
  }
  return String(v).trim().slice(0, 200);
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], field: string): T | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (!allowed.includes(v as T)) throw invalid(field);
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

  if (Object.keys(data).length === 0) throw new BadRequest(tx('Catatan kosong', 'The record is empty'));
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
  /** Sends support tickets to the team; null = only stored. */
  mail?: SendMail | null;
}

const MAX_IMAGES = 24;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const SESSION_DAYS = 90;
const INVITE_DAYS = 7;
const HISTORY_DAYS = 14;
const MAX_NICKNAMES = 5;
const MAX_NICKNAME_LENGTH = 30;
const MAX_TRANSCRIPT = 5000;
// Free extra AI reads (see the quota page): a photo and a video on the same day, and every 7th day in a row.
const PHOTO_VIDEO_BONUS = 2;
const STREAK_BONUS = 10;
const STREAK_EVERY = 7;

const SUPPORT_TOPICS: Record<SupportTopic, string> = { pin: 'Masuk dan PIN', catat: 'Catat dan suara', waspada: 'Waspada dan alarm', jatah: 'Jatah AI', lain: 'Lainnya' };

/** Ponds can have other names ("kolam dekat pintu"): trimmed, single spaces, at most 30 characters. */
function nickname(v: unknown): string {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (!s) throw new BadRequest(tx('Nama lain kolam wajib diisi', 'The pond nickname is required'));
  if (s.length > MAX_NICKNAME_LENGTH) throw new BadRequest(tx(`Nama lain kolam terlalu panjang (maksimal ${MAX_NICKNAME_LENGTH} huruf)`, `The pond nickname is too long (${MAX_NICKNAME_LENGTH} letters at most)`));
  return s;
}

function nicknameList(v: unknown): string[] {
  if (!Array.isArray(v)) throw new BadRequest(tx('nama lain kolam tidak valid', 'Pond nicknames are not valid'));
  return v.map(nickname);
}

// ---------- plain words for the history of a log ----------

// Word sets for the change log, in each language. The log line is written in the language of whoever edits.
const WORDS = {
  id: {
    reading: { temperature: 'suhu', ph: 'pH', tds: 'TDS', do: 'oksigen terlarut', tan: 'amonia', no2: 'nitrit' } as Record<(typeof READINGS)[number], string>,
    leftover: { none: 'habis', little: 'sedikit', much: 'banyak' },
    behavior: { normal: 'normal', surfacing: 'naik ke permukaan', gathering_inlet: 'berkumpul di air masuk', not_eating: 'tidak mau makan', lethargic: 'lemas' } as Record<Behavior, string>,
    color: { clear: 'jernih', green: 'hijau', brown: 'cokelat', cloudy: 'keruh' },
    smell: { normal: 'normal', foul: 'busuk' },
    aeration: { on: 'nyala normal', weak: 'lemah', off: 'mati' },
    labels: { dead: 'sidat mati', leftover: 'sisa pakan', behavior: 'perilaku', color: 'warna air', smell: 'bau air', change: 'ganti air', aerator: 'aerator' },
    note: { removed: 'catatan dihapus', changed: 'catatan diubah', added: 'catatan ditambah' },
  },
  en: {
    reading: { temperature: 'temperature', ph: 'pH', tds: 'TDS', do: 'dissolved oxygen', tan: 'ammonia', no2: 'nitrite' } as Record<(typeof READINGS)[number], string>,
    leftover: { none: 'all eaten', little: 'a little', much: 'a lot' },
    behavior: { normal: 'normal', surfacing: 'rising to the surface', gathering_inlet: 'crowding at the water inlet', not_eating: 'not eating', lethargic: 'sluggish' } as Record<Behavior, string>,
    color: { clear: 'clear', green: 'green', brown: 'brown', cloudy: 'cloudy' },
    smell: { normal: 'normal', foul: 'foul' },
    aeration: { on: 'on, normal', weak: 'weak', off: 'off' },
    labels: { dead: 'dead eels', leftover: 'leftover feed', behavior: 'behavior', color: 'water color', smell: 'water smell', change: 'water change', aerator: 'aerator' },
    note: { removed: 'note removed', changed: 'note changed', added: 'note added' },
  },
};

/** 28.9 → "28,9" (Indonesian) or "28.9" (English). */
const decimal = (v: number | undefined) => (v === undefined ? undefined : currentLang() === 'en' ? String(v) : String(v).replace('.', ','));

/** What changed between two versions of a log: ["suhu 28,9 → 29,8", "sisa pakan habis → banyak"]. */
export function describeChanges(before: LogData, after: LogData): string[] {
  const parts: string[] = [];
  const show = (label: string, a: string | undefined, b: string | undefined) => {
    if ((a ?? '') !== (b ?? '')) parts.push(`${label} ${a || '–'} → ${b || '–'}`);
  };
  const w = WORDS[currentLang()];
  for (const key of READINGS) show(w.reading[key], decimal(before.readings?.[key]), decimal(after.readings?.[key]));
  show(w.labels.dead, decimal(before.mortality), decimal(after.mortality));
  show(w.labels.leftover, before.feeding?.leftover && w.leftover[before.feeding.leftover], after.feeding?.leftover && w.leftover[after.feeding.leftover]);
  show(w.labels.behavior, before.behavior?.map((b) => w.behavior[b]).join(', '), after.behavior?.map((b) => w.behavior[b]).join(', '));
  show(w.labels.color, before.water?.color && w.color[before.water.color], after.water?.color && w.color[after.water.color]);
  show(w.labels.smell, before.water?.smell && w.smell[before.water.smell], after.water?.smell && w.smell[after.water.smell]);
  show(w.labels.change, before.waterChangePct === undefined ? undefined : `${decimal(before.waterChangePct)}%`, after.waterChangePct === undefined ? undefined : `${decimal(after.waterChangePct)}%`);
  show(w.labels.aerator, before.aeration && w.aeration[before.aeration], after.aeration && w.aeration[after.aeration]);
  // Notes can be long: say what happened, not the whole text twice.
  if ((before.note ?? '') !== (after.note ?? '')) parts.push(!after.note ? w.note.removed : before.note ? w.note.changed : w.note.added);
  return parts;
}

/** The status of a single log on its own, for the history list. */
function logLevel(log: Log, phase?: Phase): Level {
  return overallLevel(assessPond([log], thresholds, new Date(log.loggedAt), { phase }).filter((f) => f.id !== 'stale'));
}

/** The next local midnight in `timezone`, as an instant. */
function nextMidnight(now: Date, timezone: string): string {
  const guess = Date.parse(`${localDate(new Date(now.getTime() + DAY_MS), timezone)}T00:00:00Z`);
  // The zone's offset: its wall clock at `guess` read as if it were UTC, minus `guess`.
  const wall = Date.parse(`${new Date(guess).toLocaleString('sv-SE', { timeZone: timezone }).replace(' ', 'T')}Z`);
  return new Date(guess - (wall - guess)).toISOString();
}

type Env = { Variables: { userId: number; farmId: number | null; tokenHash: string; role: Role | null; r: FarmRepo } };

export function createApi(
  store: Repo,
  { clock = () => new Date(), getWeather = defaultGetWeather, geocode = defaultGeocode, ai, saveCapture, cookieName = 'synteel_session', demoPhone = null, farmAiCap = 0, agentProviders = [], sam = null, mail = null }: ApiDeps = {},
) {
  const api = new Hono<Env>();
  // Every handler below answers in the language the app asked for (i18n.ts).
  api.use((c, next) => withLang(parseLang(c.req.header('x-lang')), next));
  const limiter = attemptLimiter();
  const supportLimiter = attemptLimiter(5, 60 * 60_000, undefined, () => tx('Terlalu banyak pesan. Coba lagi 1 jam lagi.', 'Too many messages. Try again in 1 hour.'));
  const speechLimiter = attemptLimiter(20, 60 * 60_000, undefined, () => tx('Terlalu sering. Ketik saja dulu, atau coba lagi 1 jam lagi.', 'Too often. Type it in for now, or try again in 1 hour.'));

  api.onError((err, c) => {
    if (err instanceof BadRequest) return c.json({ error: err.message }, 400);
    if (err instanceof NotFound) return c.json({ error: err.message }, 404);
    if (err instanceof AuthError) return c.json({ error: err.message, code: err.code ?? (err.status === 401 ? 'auth' : undefined), retryAt: err.retryAt }, err.status);
    if (err instanceof AiQuota) return c.json({ error: err.message, code: 'ai_quota' }, 429);
    // The server-wide demo cap (withDailyCap) is a quota too, though ai.ts throws it as AiUnavailable.
    if (err instanceof AiUnavailable) return c.json({ error: err.message, code: /^(Kuota AI|AI demo quota)/.test(err.message) ? 'ai_quota' : 'ai_unavailable' }, /^(Kuota AI|AI demo quota)/.test(err.message) ? 429 : 503);
    if (err instanceof AiFailed) {
      console.error(err.message);
      return c.json({ error: tx('AI gagal membaca. Coba lagi, atau isi manual.', 'The AI could not read it. Try again, or type it in.'), code: 'ai_unavailable' }, 503);
    }
    console.error(err);
    return c.json({ error: tx('Terjadi kesalahan di server', 'Something went wrong on the server') }, 500);
  });

  const timezone = (r: FarmRepo) => r.getFarm()?.timezone ?? 'Asia/Jakarta';

  function pondState(r: FarmRepo, pond: Pond, now: Date) {
    const tz = timezone(r);
    const batch = r.activeBatch(pond.id);
    const logs = r.logsSince(pond.id, new Date(now.getTime() - 7 * DAY_MS).toISOString());

    let program = null;
    if (batch) {
      const week = batchWeek(batch, now, tz);
      const found = batch.phase === 'glass_eel' ? (stages.find((s) => week >= s.weeks[0] && week <= s.weeks[1]) ?? null) : null;
      const stage = found && currentLang() === 'en' ? { ...found, ...STAGE_EN[stages.indexOf(found)] } : found;
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
    const link = store.devices.forPond(pond.id);
    // Someone is looking at the pond: keep its simulated device sending.
    if (link) store.devices.seen(link.code, now.getTime());
    const device = link
      ? { code: link.code, kind: link.device.kind, name: KINDS[link.device.kind].name(), unit: link.unit, unitName: KINDS[link.device.kind].units.find((u) => u.id === link.unit)?.name() ?? link.unit, simulated: link.device.simulated }
      : null;
    // A pond fed by a simulated device holds simulated data only (it was made for the device).
    return { ...pond, batch, program, latest, limits, status, lastLogAt, findings, level: overallLevel(findings), device, simulated: device?.simulated ?? false };
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

  // ---------- AI quota ----------

  /** Today's AI reads of the farm: one cap shared by all members, plus what the farm earned today. */
  function quotaState(r: FarmRepo): QuotaState {
    const now = clock();
    const tz = timezone(r);
    const today = localDate(now, tz);
    const todays = r.farmLogsSince(new Date(now.getTime() - DAY_MS).toISOString()).filter((l) => localDate(new Date(l.loggedAt), tz) === today);
    const photo = todays.some((l) => l.source === 'photo');
    const video = todays.some((l) => l.source === 'video');
    const days = streakDays(r);
    const measuredToday = todays.some((l) => Object.keys(l.data.readings ?? {}).length > 0);
    // The milestone counts on the day it is reached: today has a reading and completes the 7th, 14th… day.
    const milestone = measuredToday && days > 0 && days % STREAK_EVERY === 0;
    const bonus = (photo && video ? PHOTO_VIDEO_BONUS : 0) + (milestone ? STREAK_BONUS : 0);
    const usage = r.aiUsage(today);
    const used = usage.reduce((sum, u) => sum + u.used, 0);
    const cap = farmAiCap ? farmAiCap + bonus : 0;
    return {
      cap,
      base: farmAiCap,
      bonus,
      used,
      left: farmAiCap ? Math.max(0, cap - used) : 0,
      resetsAt: nextMidnight(now, tz),
      unlimited: !farmAiCap,
      members: store.members(r.farmId).map((m) => ({ userId: m.id, name: m.name, role: m.role, used: usage.find((u) => u.userId === m.id)?.used ?? 0 })),
      earn: {
        photoVideo: { photo, video, bonus: PHOTO_VIDEO_BONUS, earned: photo && video },
        streak: { days, nextAt: (Math.floor(days / STREAK_EVERY) + 1) * STREAK_EVERY, bonus: STREAK_BONUS },
      },
    };
  }

  /**
   * Counts one AI read for this person. Refuses when AI is off, or (with real AI) once the
   * farm's reads for today are used up. Mock reads are counted, so the quota page shows use, but never refused.
   */
  function useAi(r: FarmRepo, userId: number) {
    if (!ai || ai.mode === 'off') throw new AiUnavailable(tx('AI belum aktif. Isi manual dulu, atau coba lagi nanti.', 'The AI is not on yet. Type it in for now, or try again later.'));
    if (farmAiCap && ai.mode === 'meta' && quotaState(r).left <= 0) {
      throw new AiQuota(tx('Jatah baca AI tambak ini untuk hari ini sudah habis. Rekaman disimpan di HP; ketik sendiri tetap bisa.', "This farm's AI reads for today are used up. The recording is kept on the phone; typing it in still works."));
    }
    r.countAiUse(userId, localDate(clock(), timezone(r)));
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
      weatherError = tx('Lokasi tambak belum diatur', 'Farm location not set');
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

  async function briefingInput(r: FarmRepo): Promise<BriefingInput> {
    const now = clock();
    const nc = await nowcastAll(r);
    const farm = r.getFarm()!;
    return {
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
  }

  async function makeBriefing(r: FarmRepo): Promise<Briefing> {
    const input = await briefingInput(r);
    const briefing = await runBriefing(input, ai?.mode === 'meta' ? agentProviders : []);
    r.saveBriefing(localDate(new Date(input.now), timezone(r)), briefing);
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

  /** The signed-in person, or null. */
  function readSession(c: Context) {
    const token = getCookie(c, cookieName);
    const session = token ? store.session(hashToken(token)) : null;
    if (!token || !session) return null;
    const role = session.farmId === null ? null : store.role(session.userId, session.farmId);
    return { tokenHash: hashToken(token), userId: session.userId, farmId: role ? session.farmId : null, role };
  }

  /** A valid invite; otherwise 404 (unknown code) or 410 (used or expired), both with code 'invite_invalid'. */
  function validInvite(code: string) {
    const invite = store.invite(code);
    if (invite) return invite;
    const spent = store.inviteProblem(code) === 'spent';
    throw new AuthError(
      spent
        ? tx('Kode undangan sudah dipakai atau kedaluwarsa. Minta kode baru ke pemilik tambak.', 'This invite code was already used or has expired. Ask the farm owner for a new code.')
        : tx('Kode undangan tidak berlaku', 'Invite code not valid'),
      spent ? 410 : 404,
      'invite_invalid',
    );
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
    if (store.userByPhone(phone)) throw new AuthError(tx('Nomor ini sudah terdaftar. Silakan masuk.', 'This number is already registered. Please sign in.'), 409, 'phone_taken');
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
      throw new AuthError(tx('Nomor HP atau PIN salah', 'Wrong phone number or PIN'));
    }
    limiter.clear(`phone:${phone}`);
    const farmId = store.farmsOf(user.id)[0]?.id ?? null;
    startSession(c, user.id, farmId);
    return c.json(me(user.id, farmId));
  });

  // The shared demo farm for judges and visitors: no sign-up, reset every night.
  api.post('/auth/demo', (c) => {
    const user = demoPhone ? store.userByPhone(demoPhone) : null;
    if (!user) throw new AuthError(tx('Demo tidak tersedia', 'The demo is not available'), 403);
    const farmId = store.farmsOf(user.id)[0]?.id ?? null;
    startSession(c, user.id, farmId);
    return c.json(me(user.id, farmId));
  });

  api.get('/auth/invite/:code', (c) => {
    const invite = validInvite(c.req.param('code').toUpperCase());
    return c.json({ farmName: invite.farmName, role: invite.role });
  });

  // Join a farm with an owner's code: a new person signs up, someone with an account adds the farm.
  api.post('/auth/join', async (c) => {
    const body = await c.req.json();
    const code = String(body.code ?? '').trim().toUpperCase();
    const invite = validInvite(code);
    const phone = normalizePhone(body.phone);
    let user = store.userByPhone(phone);
    if (user) {
      const keys = [`phone:${phone}`, `ip:${clientIp(c)}`];
      limiter.check(...keys);
      if (!verifyPin(String(body.pin ?? ''), user.pinHash)) {
        limiter.fail(...keys);
        throw new AuthError(tx('Nomor ini sudah terdaftar. Masukkan PIN yang benar.', 'This number is already registered. Enter the right PIN.'));
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

  // "Hubungi bantuan": signed in, or signed out (an owner who forgot the PIN). The ticket is
  // stored first; the e-mail to the team goes out after the answer and may fail without harm.
  api.post('/support', async (c) => {
    const body = await c.req.json();
    const session = readSession(c);
    const topic = oneOf(body.topic, Object.keys(SUPPORT_TOPICS) as SupportTopic[], 'topik') ?? 'lain';
    const message = String(body.message ?? '').trim();
    if (message.length < 5) throw new BadRequest(tx('Ceritakan masalahnya dulu', 'Describe the problem first'));
    if (message.length > 2000) throw new BadRequest(tx('Pesan terlalu panjang (maksimal 2000 huruf)', 'The message is too long (2000 letters at most)'));
    const phone = (v: unknown, field: string) => {
      try {
        return normalizePhone(v);
      } catch {
        throw invalid(field);
      }
    };
    const replyPhone = phone(body.replyPhone, 'Nomor WhatsApp');
    const accountPhone = body.accountPhone ? phone(body.accountPhone, 'Nomor HP akun') : null;
    const device = body.device ? String(body.device).trim().slice(0, 300) || null : null;
    const keys = [`ip:${clientIp(c)}`, `phone:${replyPhone}`];
    supportLimiter.check(...keys);
    supportLimiter.fail(...keys);
    const ticket = { topic, message, replyPhone, accountPhone, device, userId: session?.userId ?? null, farmId: session?.farmId ?? null };
    const id = store.addSupportTicket(ticket);
    const number = String(id).padStart(4, '0');
    // Not awaited: the farmer gets the ticket number right away.
    void Promise.resolve()
      .then(() => mailTicket(id, number, ticket, session?.role ?? null))
      .catch((err) => console.error(`support ticket #${number}:`, err));
    return c.json({ ticket: number }, 201);
  });

  async function mailTicket(id: number, number: string, t: { topic: SupportTopic; message: string; replyPhone: string; accountPhone: string | null; device: string | null; userId: number | null; farmId: number | null }, role: Role | null) {
    if (!mail) {
      console.log(`support ticket #${number} stored (mail not configured)`);
      return;
    }
    const user = t.userId === null ? null : store.user(t.userId);
    const farm = t.farmId === null ? null : store.farm(t.farmId).getFarm();
    const text = [
      `Tiket: #${number}`,
      `Topik: ${SUPPORT_TOPICS[t.topic]}`,
      '',
      t.message,
      '',
      `WhatsApp untuk balasan: +${t.replyPhone}`,
      `Nomor HP akun: ${t.accountPhone ? `+${t.accountPhone}` : user ? `+${user.phone}` : '-'}`,
      `Pengguna: ${user ? `${user.name} (SE-${String(user.id).padStart(6, '0')})${role ? `, ${role === 'owner' ? 'pemilik' : 'pekerja'}` : ''}` : 'belum masuk'}`,
      `Tambak: ${farm?.name ?? '-'}`,
      `Perangkat: ${t.device ?? 'tidak disertakan'}`,
    ].join('\n');
    try {
      await mail({ subject: `[Synteel] Tiket #${number}: ${SUPPORT_TOPICS[t.topic]}`, text });
      store.supportMailed(id);
    } catch (err) {
      console.error(`support ticket #${number} stored, mail failed: ${(err as Error).message}`);
    }
  }

  // ---------- device simulator (eel.synt.fun/sim): no account needed, the code is the key ----------

  const simLimiter = attemptLimiter(20, 60 * 60_000, undefined, () => tx('Terlalu banyak alat simulasi. Coba lagi 1 jam lagi.', 'Too many simulated devices. Try again in 1 hour.'));

  function deviceView(d: Device, now: number) {
    const spec = KINDS[d.kind];
    return {
      code: d.code,
      kind: d.kind,
      name: spec.name(),
      short: spec.short,
      scenarios: spec.scenarios,
      simulated: d.simulated,
      scenario: d.scenario,
      scenarioAt: d.scenarioAt,
      units: spec.units.map((u) => ({ id: u.id, name: u.name() })),
      sensors: spec.sensors(),
      readings: spec.readings,
      state: simulate(d, now),
      linked: store.devices.links(d.code).length > 0,
    };
  }
  const findDevice = (code: string) => {
    const d = store.devices.get(code);
    if (!d) throw new NotFound(tx('Kode alat tidak dikenal. Periksa lagi hurufnya.', 'Unknown device code. Check the letters again.'));
    return d;
  };

  api.post('/sim/devices', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const kind = (oneOf<DeviceKind>(body.kind, Object.keys(KINDS) as DeviceKind[], 'jenis alat') ?? 'gen5') as DeviceKind;
    const key = `ip:${clientIp(c)}`;
    simLimiter.check(key);
    simLimiter.fail(key);
    const d = store.devices.create(kind, clock().getTime());
    return c.json({ device: deviceView(d, clock().getTime()) }, 201);
  });

  api.get('/sim/devices/:code', (c) => {
    const d = findDevice(c.req.param('code'));
    const now = clock().getTime();
    store.devices.seen(d.code, now);
    return c.json({ device: deviceView(d, now) });
  });

  api.post('/sim/devices/:code/scenario', async (c) => {
    const d = findDevice(c.req.param('code'));
    const scenario = oneOf<Scenario>((await c.req.json()).scenario, SCENARIOS, 'skenario');
    if (!scenario) throw new BadRequest(tx('Skenario wajib dipilih', 'Choose a scenario'));
    if (!KINDS[d.kind].scenarios.includes(scenario)) throw new BadRequest(tx('Skenario ini tidak ada untuk alat ini', 'This scenario does not exist for this device'));
    const now = clock().getTime();
    store.devices.setScenario(d.code, scenario, now);
    store.devices.resend(d.code);
    sendDeviceLogs();
    return c.json({ device: deviceView(store.devices.get(d.code)!, now) });
  });

  /** Writes a log for every linked device that is due (called every minute by the server, and after a scenario change). */
  function sendDeviceLogs() {
    const now = clock().getTime();
    let sent = 0;
    for (const l of store.devices.active(now)) {
      if (l.lastSentAt !== null && now - l.lastSentAt < sendEveryMs(l.device, now) - 5_000) continue;
      const r = store.farm(l.farmId);
      const pond = r.getPond(l.pondId);
      if (!pond) continue;
      r.addLog({ pondId: pond.id, batchId: r.activeBatch(pond.id)?.id ?? null, loggedAt: new Date(now).toISOString(), source: 'sensor', data: toLogData(simulate(l.device, now), l.unit, l.device.kind) });
      store.devices.sent(l.code, l.unit, now);
      sent++;
    }
    return sent;
  }

  // ---------- everything below needs a session ----------

  api.use('*', async (c, next) => {
    const session = readSession(c);
    if (!session) throw new AuthError(tx('Silakan masuk dulu', 'Please sign in first'));
    c.set('userId', session.userId);
    c.set('tokenHash', session.tokenHash);
    c.set('farmId', session.farmId);
    c.set('role', session.role);
    if (session.farmId !== null) c.set('r', store.farm(session.farmId));
    await next();
  });

  const needFarm = (c: Context<Env>) => {
    if (c.get('farmId') === null) throw new AuthError(tx('Tambak belum dibuat', 'No farm set up yet'), 409);
    return c.get('r');
  };
  const needOwner = (c: Context<Env>) => {
    const r = needFarm(c);
    if (c.get('role') !== 'owner') throw new AuthError(tx('Hanya pemilik tambak yang bisa mengubah ini', 'Only the farm owner can change this'), 403);
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
    if (!store.role(c.get('userId'), farmId)) throw new AuthError(tx('Bukan anggota tambak ini', 'Not a member of this farm'), 403);
    store.setSessionFarm(c.get('tokenHash'), farmId);
    return c.json(me(c.get('userId'), farmId));
  });

  // Signed in already (e.g. a new account still on "Siapkan tambak", or a worker of another farm): add the farm of an
  // owner's invite code to this account and switch to it. The person confirms the farm name before calling this.
  api.post('/farm/join', async (c) => {
    const code = String((await c.req.json()).code ?? '').trim().toUpperCase();
    const invite = validInvite(code);
    const userId = c.get('userId');
    if (store.role(userId, invite.farmId) !== 'owner') store.addMember(userId, invite.farmId, invite.role);
    store.useInvite(code, userId);
    store.setSessionFarm(c.get('tokenHash'), invite.farmId);
    return c.json(me(userId, invite.farmId));
  });

  api.put('/auth/pin', async (c) => {
    const body = await c.req.json();
    const user = store.userByPhone(store.user(c.get('userId'))!.phone)!;
    if (user.phone === demoPhone) throw new AuthError(tx('PIN akun demo tidak bisa diubah', 'The demo account PIN cannot be changed'), 403);
    const keys = [`phone:${user.phone}`];
    limiter.check(...keys);
    if (!verifyPin(String(body.pin ?? ''), user.pinHash)) {
      limiter.fail(...keys);
      throw new AuthError(tx('PIN lama salah', 'The old PIN is wrong'), 403);
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

  // ---------- Synteel devices: "Hubungkan alat" in the app ----------

  api.get('/devices/:code', (c) => {
    const r = needFarm(c);
    const d = findDevice(c.req.param('code'));
    const now = clock().getTime();
    store.devices.seen(d.code, now);
    const links = store.devices.links(d.code);
    return c.json({
      device: {
        ...deviceView(d, now),
        linkedHere: links.some((l) => l.farmId === r.farmId),
        linkedElsewhere: links.some((l) => l.farmId !== r.farmId),
        ponds: links.filter((l) => l.farmId === r.farmId).map((l) => r.getPond(l.pondId)).filter(Boolean),
      },
    });
  });

  // Links every unit of the device. A simulated device gets new ponds of its own, marked as simulation.
  api.post('/devices/:code/link', (c) => {
    const r = needOwner(c);
    const d = findDevice(c.req.param('code'));
    const now = clock();
    store.devices.seen(d.code, now.getTime());
    const links = store.devices.links(d.code);
    if (links.some((l) => l.farmId !== r.farmId)) throw new BadRequest(tx('Alat ini sudah terhubung ke tambak lain.', 'This device is already connected to another farm.'));
    if (!links.length) {
      if (!d.simulated) throw new BadRequest(tx('Alat asli belum bisa dihubungkan.', 'Real devices cannot be connected yet.'));
      const spec = KINDS[d.kind];
      const today = localDate(now, timezone(r));
      for (const u of spec.units) {
        const pond = r.addPond({ name: `${spec.short} ${u.name()}`, kind: 'gen5', volumeL: null, areaM2: null, setting: 'indoor', shaded: null, aeration: 'full', depthCm: null });
        // A glass eel batch in week 3, so the program, the rules and the forecast have something to work with.
        r.startBatch({ pondId: pond.id, phase: 'glass_eel', stockedAt: localDate(new Date(now.getTime() - 17 * DAY_MS), timezone(r)), initialCount: 3000 }, today);
        store.devices.link({ code: d.code, farmId: r.farmId, unit: u.id, pondId: pond.id }, now.getTime());
      }
      sendDeviceLogs();
    }
    const ponds = store.devices.links(d.code).map((l) => r.getPond(l.pondId)).filter((p): p is Pond => p !== null);
    return c.json({ ponds: ponds.map((p) => pondSummary(r, p)) }, 201);
  });

  // Unlinking a simulated device also removes its simulated ponds.
  api.post('/devices/:code/unlink', (c) => {
    const r = needOwner(c);
    const d = findDevice(c.req.param('code'));
    const links = store.devices.links(d.code).filter((l) => l.farmId === r.farmId);
    if (!links.length) throw new BadRequest(tx('Alat ini tidak terhubung ke tambak ini.', 'This device is not connected to this farm.'));
    if (d.simulated) for (const l of links) r.archivePond(l.pondId);
    store.devices.unlink(d.code);
    return c.body(null, 204);
  });

  api.get('/briefing', async (c) => {
    const r = needFarm(c);
    const saved = r.briefing<Briefing>(localDate(clock(), timezone(r)));
    // Written in the other language: show the rules-only briefing in this one ("Susun ulang" asks the agent again).
    if (saved && (saved.lang ?? 'id') !== currentLang()) return c.json({ briefing: { ...rulesBriefing(await briefingInput(r)), generatedAt: saved.generatedAt } });
    return c.json({ briefing: saved });
  });

  // Ask for a fresh briefing now (the server also makes one by itself every evening).
  api.post('/briefing', async (c) => {
    const r = needFarm(c);
    if (r.listPonds().length === 0) throw new BadRequest(tx('Belum ada kolam', 'No ponds yet'));
    if (r.briefingsOn(localDate(clock(), timezone(r))) >= MAX_BRIEFINGS_PER_DAY) throw new BadRequest(tx('Ringkasan malam hari ini sudah disusun beberapa kali. Coba lagi besok.', "Tonight's summary has been made several times today. Try again tomorrow."));
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
    if (userId === c.get('userId')) throw new BadRequest(tx('Tidak bisa mengeluarkan diri sendiri', 'You cannot remove yourself'));
    store.removeMember(userId, c.get('farmId')!);
    return c.body(null, 204);
  });

  // A worker forgot their PIN: the owner gets a temporary one to pass on.
  api.post('/farm/members/:userId/pin', (c) => {
    needOwner(c);
    const userId = Number(c.req.param('userId'));
    if (!store.role(userId, c.get('farmId')!)) throw new AuthError(tx('Bukan anggota tambak ini', 'Not a member of this farm'), 403);
    const pin = tempPin();
    store.setPin(userId, hashPin(pin));
    return c.json({ pin });
  });

  // ---------- ponds ----------

  /**
   * Adds names to a pond's nicknames: duplicates (any case) and the pond's own name are skipped,
   * a name another pond already goes by is refused (the voice round could not tell them apart).
   */
  function addNicknames(r: FarmRepo, pond: { id: number | null; name: string; nicknames: string[] }, names: string[]): string[] {
    const list = [...pond.nicknames];
    const others = r.listPonds().filter((p) => p.id !== pond.id);
    for (const name of names) {
      const key = name.toLowerCase();
      if (key === pond.name.toLowerCase() || list.some((n) => n.toLowerCase() === key)) continue;
      const other = others.find((p) => [p.name, ...p.nicknames].some((n) => n.toLowerCase() === key));
      if (other) throw new BadRequest(tx(`"${name}" sudah dipakai untuk ${other.name}`, `"${name}" is already used for ${other.name}`));
      if (list.length >= MAX_NICKNAMES) throw new BadRequest(tx(`Sudah ada ${MAX_NICKNAMES} nama lain untuk kolam ini`, `This pond already has ${MAX_NICKNAMES} nicknames`));
      list.push(name);
    }
    return list;
  }

  api.post('/ponds', async (c) => {
    const r = needOwner(c);
    const body = await c.req.json();
    const name = text(body.name, 'nama kolam', true)!;
    const pond = r.addPond({
      name,
      kind: text(body.kind, 'jenis kolam'),
      volumeL: num(body.volumeL, 'volume', { min: 0 }) ?? null,
      ...pondProfile(body),
      nicknames: 'nicknames' in body ? addNicknames(r, { id: null, name, nicknames: [] }, nicknameList(body.nicknames)) : [],
    });
    return c.json({ pond: pondSummary(r, pond) }, 201);
  });

  // Any member may teach the voice round another name for a pond.
  api.post('/ponds/:id/nicknames', async (c) => {
    const r = needFarm(c);
    const pond = r.getPond(Number(c.req.param('id')));
    if (!pond) return c.json({ error: tx('Kolam tidak ditemukan', 'Pond not found') }, 404);
    const name = nickname((await c.req.json()).nickname);
    r.updatePond({ ...pond, nicknames: addNicknames(r, pond, [name]) });
    return c.json({ pond: pondSummary(r, r.getPond(pond.id)!) });
  });

  api.put('/ponds/:id', async (c) => {
    const r = needOwner(c);
    const pond = r.getPond(Number(c.req.param('id')));
    if (!pond) return c.json({ error: tx('Kolam tidak ditemukan', 'Pond not found') }, 404);
    const body = await c.req.json();
    // Only fields present in the body change.
    const profile = pondProfile(body);
    const kept = Object.fromEntries(Object.entries(profile).map(([k, v]) => [k, k in body ? v : pond[k as keyof typeof profile]]));
    const name = text(body.name, 'nama kolam') ?? pond.name;
    r.updatePond({
      ...pond,
      ...(kept as typeof profile),
      name,
      // The list given replaces the old one.
      nicknames: 'nicknames' in body ? addNicknames(r, { id: pond.id, name, nicknames: [] }, nicknameList(body.nicknames)) : pond.nicknames,
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
    if (!pond) return c.json({ error: tx('Kolam tidak ditemukan', 'Pond not found') }, 404);
    const since = new Date(clock().getTime() - 14 * DAY_MS).toISOString();
    return c.json({ pond: pondSummary(r, pond), logs: r.logsSince(pond.id, since) });
  });

  api.post('/ponds/:id/batches', async (c) => {
    const r = needOwner(c);
    const pond = r.getPond(Number(c.req.param('id')));
    if (!pond) return c.json({ error: tx('Kolam tidak ditemukan', 'Pond not found') }, 404);
    const body = await c.req.json();
    const stockedAt = text(body.stockedAt, 'tanggal tebar', true)!;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(stockedAt)) throw new BadRequest(tx('tanggal tebar tidak valid', 'Stocking date is not valid'));
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
    if (!pond) return c.json({ error: tx('Kolam tidak ditemukan', 'Pond not found') }, 404);
    if (!ai || ai.mode === 'off') throw new AiUnavailable(tx('AI belum aktif. Isi manual dulu, atau coba lagi nanti.', 'The AI is not on yet. Type it in for now, or try again later.'));
    const form = await c.req.parseBody({ all: true });
    const kind = oneOf<CaptureKind>(form.kind, ['photo', 'voice', 'video'], 'jenis rekaman');
    if (!kind) throw new BadRequest(tx('jenis rekaman wajib diisi', 'Recording type is required'));
    const field = oneOf(form.field, ['temperature', 'ph', 'tds'] as const, 'kolom');
    const images = ([] as unknown[]).concat(form.image ?? []).filter((f): f is File => f instanceof File);
    const audio = form.audio instanceof File ? form.audio : undefined;
    if (images.length > MAX_IMAGES || images.some((f) => f.size > MAX_IMAGE_BYTES)) throw new BadRequest(tx('Gambar terlalu banyak atau terlalu besar', 'Too many pictures, or too large'));
    if (audio && audio.size > MAX_AUDIO_BYTES) throw new BadRequest(tx('Rekaman suara terlalu panjang', 'The voice recording is too long'));
    if (kind === 'photo' && !images.length) throw new BadRequest(tx('Foto belum ada', 'No photo yet'));
    if (kind === 'voice' && !audio) throw new BadRequest(tx('Rekaman suara belum ada', 'No voice recording yet'));
    if (kind === 'video' && !images.length && !audio) throw new BadRequest(tx('Video belum ada', 'No video yet'));

    useAi(r, c.get('userId'));
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
    if (!pond) return c.json({ error: tx('Kolam tidak ditemukan', 'Pond not found') }, 404);
    const form = await c.req.parseBody();
    const image = form.image instanceof File ? form.image : null;
    if (!image) throw new BadRequest(tx('Foto belum ada', 'No photo yet'));
    if (image.size > MAX_IMAGE_BYTES) throw new BadRequest(tx('Foto terlalu besar', 'The photo is too large'));
    if (ai?.mode === 'mock') return c.json({ result: { count: 0, eels: [], review: true, model: 'mock', ms: 0 }, mock: true });
    if (ai?.mode !== 'meta' || !sam?.apiKey) throw new AiUnavailable(tx('Hitung otomatis belum aktif. Hitung manual dulu.', 'Automatic counting is not on yet. Count by hand for now.'));
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
    if (!pond) return c.json({ error: tx('Kolam tidak ditemukan', 'Pond not found') }, 404);
    const body = await c.req.json();
    const loggedAt = body.loggedAt ? new Date(body.loggedAt) : clock();
    if (Number.isNaN(loggedAt.getTime())) throw new BadRequest(tx('waktu catat tidak valid', 'Record time is not valid'));
    const log = r.addLog(
      {
        pondId: pond.id,
        batchId: r.activeBatch(pond.id)?.id ?? null,
        loggedAt: loggedAt.toISOString(),
        source: oneOf(body.source, LOG_SOURCES, 'sumber') ?? 'manual',
        data: parseLogData(body),
      },
      c.get('userId'),
    );
    return c.json({ log, pond: pondSummary(r, pond) }, 201);
  });

  // ---------- record history and corrections ----------

  /**
   * Who may change a log: the person who recorded it, within 24 hours of its time; the owner
   * always. Logs from before accounts (no maker) only the owner.
   */
  function access(log: LogRecord, userId: number, role: Role | null) {
    if (role === 'owner') return { canEdit: true, lockReason: null, editableUntil: null };
    const until = Date.parse(log.loggedAt) + DAY_MS;
    if (log.createdBy === userId) {
      return clock().getTime() < until
        ? { canEdit: true, lockReason: null, editableUntil: new Date(until).toISOString() }
        : {
            canEdit: false,
            lockReason: tx('Terkunci: sudah lewat 24 jam. Kalau ada yang salah, minta pemilik tambak mengubahnya.', 'Locked: more than 24 hours ago. If something is wrong, ask the farm owner to change it.'),
            editableUntil: null,
          };
    }
    const maker = log.createdBy === null ? null : store.user(log.createdBy)?.name;
    return {
      canEdit: false,
      lockReason: maker
        ? tx(`Terkunci: dicatat ${maker}. Hanya yang mencatat (dalam 24 jam) atau pemilik tambak yang bisa mengubah.`, `Locked: recorded by ${maker}. Only the person who recorded it (within 24 hours) or the farm owner can change it.`)
        : tx('Terkunci: catatan lama. Hanya pemilik tambak yang bisa mengubah.', 'Locked: old record. Only the farm owner can change it.'),
      editableUntil: null,
    };
  }

  function historyLog(c: Context<Env>, log: LogRecord): HistoryLog {
    const r = c.get('r');
    const name = (id: number) => store.user(id)?.name ?? tx('Anggota lama', 'Former member');
    const maker = log.createdBy === null ? null : store.user(log.createdBy);
    return {
      id: log.id,
      pondId: log.pondId,
      loggedAt: log.loggedAt,
      source: log.source,
      data: log.data,
      by: maker ? { id: maker.id, name: maker.name, role: store.role(maker.id, r.farmId) ?? 'worker' } : null,
      edits: log.edits.map((e) => ({ at: e.at, byName: name(e.byUserId), text: e.text })),
      ...access(log, c.get('userId'), c.get('role')),
      level: logLevel(log, r.activeBatch(log.pondId)?.phase),
    };
  }

  /** The log in the URL if this person may change it now: 404 for unknown or another farm's, 403 when locked. */
  function editableLog(c: Context<Env>, { deleted = false } = {}) {
    const r = needFarm(c);
    const log = r.getLog(Number(c.req.param('id')));
    if (!log || (log.deletedAt !== null && !deleted)) throw new NotFound(tx('Catatan tidak ditemukan', 'Record not found'));
    const a = access(log, c.get('userId'), c.get('role'));
    if (!a.canEdit) throw new AuthError(a.lockReason!, 403);
    return { r, log };
  }

  const edited = (c: Context<Env>, log: LogRecord, text: string): LogRecord => ({ ...log, edits: [...log.edits, { at: clock().toISOString(), byUserId: c.get('userId'), text }] });

  api.get('/ponds/:id/history', (c) => {
    const r = needFarm(c);
    const pond = r.getPond(Number(c.req.param('id')));
    if (!pond) return c.json({ error: tx('Kolam tidak ditemukan', 'Pond not found') }, 404);
    const since = new Date(clock().getTime() - HISTORY_DAYS * DAY_MS).toISOString();
    return c.json({ logs: r.historySince(pond.id, since).map((l) => historyLog(c, l)) });
  });

  // New values replace the old; the old ones stay readable in the edit trail.
  api.put('/logs/:id', async (c) => {
    const { r, log } = editableLog(c);
    const data = parseLogData(await c.req.json());
    const changes = describeChanges(log.data, data);
    if (!changes.length) return c.json({ log: historyLog(c, log) });
    r.saveLog(edited(c, { ...log, data }, changes.join(', ')));
    return c.json({ log: historyLog(c, r.getLog(log.id)!) });
  });

  // A reading taken at the wrong pond: it moves, with its time, to another pond of the same farm.
  api.post('/logs/:id/move', async (c) => {
    const { r, log } = editableLog(c);
    const target = r.getPond(Number((await c.req.json()).pondId));
    if (!target) throw new NotFound(tx('Kolam tidak ditemukan', 'Pond not found'));
    if (target.id === log.pondId) throw new BadRequest(tx('Catatan sudah ada di kolam ini', 'The record is already in this pond'));
    const from = r.getPond(log.pondId)?.name ?? tx('kolam lain', 'another pond');
    r.saveLog(edited(c, { ...log, pondId: target.id, batchId: r.activeBatch(target.id)?.id ?? null }, tx(`dipindahkan dari ${from}`, `moved from ${from}`)));
    return c.json({ log: historyLog(c, r.getLog(log.id)!) });
  });

  // Soft delete: the log leaves charts, alerts and history but can be restored.
  api.delete('/logs/:id', (c) => {
    const { r, log } = editableLog(c, { deleted: true });
    if (log.deletedAt === null) r.saveLog(edited(c, { ...log, deletedAt: clock().toISOString() }, tx('dihapus', 'deleted')));
    return c.body(null, 204);
  });

  api.post('/logs/:id/restore', (c) => {
    const { r, log } = editableLog(c, { deleted: true });
    if (log.deletedAt !== null) r.saveLog(edited(c, { ...log, deletedAt: null }, tx('dikembalikan', 'restored')));
    return c.json({ log: historyLog(c, r.getLog(log.id)!) });
  });

  // ---------- AI quota ----------

  api.get('/quota', (c) => c.json(quotaState(needFarm(c))));

  // ---------- voice round: one recording that names many ponds ----------

  /** Drafts for every pond named, from a recording or its transcript. Nothing is saved to the ponds here. */
  async function round(c: Context<Env>, input: { audio?: File; transcript?: string }) {
    const r = needFarm(c);
    const ponds = r.listPonds().map(({ id, name, nicknames }) => ({ id, name, nicknames }));
    if (!ponds.length) throw new BadRequest(tx('Belum ada kolam', 'No ponds yet'));
    if (!ai || ai.mode === 'off' || typeof ai.round !== 'function') throw new AiUnavailable(tx('AI belum aktif. Isi manual dulu, atau coba lagi nanti.', 'The AI is not on yet. Type it in for now, or try again later.'));
    useAi(r, c.get('userId'));
    const started = Date.now();
    const result = await ai.round({ ...input, ponds });
    const audio = input.audio;
    await saveCapture?.(
      { farmId: r.farmId, pondId: 0, userId: c.get('userId'), kind: 'round', at: clock().toISOString(), ms: Date.now() - started, transcript: input.transcript, round: result },
      audio ? [{ name: `audio.${audio.type.includes('wav') ? 'wav' : 'webm'}`, blob: audio }] : [],
    ).catch((err) => console.error('capture not stored:', err));
    return c.json({ round: result });
  }

  api.post('/round', async (c) => {
    const form = await c.req.parseBody();
    const audio = form.audio instanceof File ? form.audio : undefined;
    if (!audio) throw new BadRequest(tx('Rekaman suara belum ada', 'No voice recording yet'));
    if (audio.size > MAX_AUDIO_BYTES) throw new BadRequest(tx('Rekaman suara terlalu panjang', 'The voice recording is too long'));
    return round(c, { audio });
  });

  api.post('/round/text', async (c) => {
    const transcript = String((await c.req.json()).transcript ?? '').trim();
    if (!transcript) throw new BadRequest(tx('Teks keliling masih kosong', 'The round text is still empty'));
    if (transcript.length > MAX_TRANSCRIPT) throw new BadRequest(tx('Teks keliling terlalu panjang', 'The round text is too long'));
    return round(c, { transcript });
  });

  // A help message said instead of typed: speech → text only, nothing is read or saved.
  // Free (no quota), but limited per person so it can't be used as a general transcriber.
  api.post('/transcribe', async (c) => {
    const form = await c.req.parseBody();
    const audio = form.audio instanceof File ? form.audio : undefined;
    if (!audio) throw new BadRequest(tx('Rekaman suara belum ada', 'No voice recording yet'));
    if (audio.size > 3 * 1024 * 1024) throw new BadRequest(tx('Rekaman terlalu panjang. Cukup satu menit.', 'The recording is too long. One minute is enough.'));
    if (!ai || ai.mode === 'off') throw new AiUnavailable(tx('Suara belum bisa diubah jadi teks. Ketik saja dulu.', 'Speech cannot be turned into text yet. Type it in for now.'));
    const key = `user:${c.get('userId')}`;
    speechLimiter.check(key);
    speechLimiter.fail(key);
    return c.json({ text: (await ai.transcribe(audio)).trim() });
  });

  // For the server's own background monitor, which has no session.
  return Object.assign(api, {
    nowcastFarm: (farmId: number) => nowcastAll(store.farm(farmId)),
    /** Linked Synteel devices: write the logs that are due. Called every minute. */
    sendDeviceLogs,
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
