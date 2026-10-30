import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { batchWeek, DAY_MS, LOG_SOURCES, localDate, READING_LIMITS, type Aeration, type Behavior, type Level, type Log, type LogData, type Phase, type Pond, type Setting } from './domain.ts';
import type { CaseRow, FarmRepo, LogRecord, Repo, Role } from './db.ts';
import type { HistoryLog, NotebookPage, NotebookSaveResult, QuotaState, SupportTopic } from './contract.ts';
import { guardNotebook, localIso } from './notebook.ts';
import type { SendMail } from './mail.ts';
import { attemptLimiter, AuthError, checkPin, emailCodes, hashPin, hashToken, inviteCode, maskEmail, newToken, normalizeEmail, normalizePhone, tempPin, verifyPin, type CodePurpose } from './auth.ts';
import { knowledge } from './knowledge.ts';
import { KINDS, SCENARIOS, sendEveryMs, simulate, toLogData, type Device, type DeviceKind, type Scenario } from './devices.ts';
import { currentLang, parseLang, tx, withLang, type Lang } from './i18n.ts';
import { DEMO_MAX_LIVE, DEMO_PER_IP_PER_DAY, seedDemoFarm } from './demo.ts';
import { AiFailed, AiUnavailable, type Ai, type CaptureKind, type ChatProvider } from './ai.ts';
import { rulesBriefing, runBriefing, type Briefing, type BriefingInput } from './agent.ts';
import { countDeadEels, type SamProvider } from './sam.ts';
import { caseView, MAX_AGENT_RUNS_PER_DAY, MAX_LANG_RUNS_PER_DAY, RECHECK_AFTER, RECHECK_GRACE, mockCaseRun, rulesCaseRun, runCaseAgent, type CaseEvent, type CaseInput, type CaseRun, type CaseTrigger, type CaseView } from './cases.ts';
import type { CoverStore, SaveCapture } from './captures.ts';
import { computeNowcast } from './nowcast.ts';
import { assessPond, classifyReading, limitsFor, overallLevel, type Limits, type Threshold } from './rules.ts';
import { geocode as defaultGeocode, getWeather as defaultGetWeather } from './weather.ts';
// Pond profile from a photo, the learned water temperature model and the weekly pattern note.
import type { Fetcher } from './archive.ts';
import { guardPondPhoto, placeToSetting, PLACES, type Place } from './pondphoto.ts';
import { MAX_PATTERN_RUNS_PER_DAY, PATTERN_EVERY_MS, runPatterns, type PondPattern } from './patterns.ts';
import { patternInOtherLang, patternPond, patternView, thermalService, type PondThermal } from './pondtemp.ts';
import type { Light, WaterColor } from './thermal.ts';
import { farmForecast, getBmkgForecast, regionCandidates, type BmkgForecast, type GetBmkg, type Region } from './bmkg.ts';
import { findDesa, searchDesa, type Desa } from './desa.ts';
import { applyPower, assessPowerNight, getStormHours, POWER_BACKUPS, type GetStorm, type PowerBackup, type PowerNight } from './power.ts';

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
  'Nomor HP akun': 'Account phone number', aerasi: 'Aeration', aerator: 'Aerator', fase: 'Phase', cahaya: 'Light',
  'cadangan listrik': 'Power backup', wilayah: 'Region', 'lama padam': 'How long the power has been out',
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
  // A pond photo's "place" (indoor / roofed / open) is the setting plus the shade question.
  const place = oneOf<Place>(body.place, PLACES, 'tempat kolam');
  if (place) Object.assign(body, placeToSetting(place));
  // Place cleared on purpose: the setting and the shade answer go back to unknown too.
  else if ('place' in body) Object.assign(body, { setting: null, shaded: null });
  return {
    waterColor: oneOf<WaterColor>(body.waterColor, ['clear', 'green', 'brown', 'cloudy'], 'warna air') ?? null,
    light: oneOf<Light>(body.light, ['bright', 'dim', 'dark'], 'cahaya') ?? null,
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
  /** Phone of the demo template's owner; "Coba demo" copies its farm for each visitor (demo.ts). Unset turns the button off. */
  demoPhone?: string | null;
  /** Real AI reads per farm per day, so one farm cannot use up everyone's credits; 0 = no cap. */
  farmAiCap?: number;
  /** Models for the evening briefing agent, tried in order; empty = rules-only briefings. */
  agentProviders?: ChatProvider[];
  /** Meta Model API access for SAM 3.1 (counting dead eels in a photo). */
  sam?: SamProvider | null;
  /** BMKG village forecast (bmkg.ts) and Open-Meteo storm signs (power.ts); tests pass fakes, no network. */
  getBmkg?: GetBmkg;
  getStorm?: GetStorm;
  /** Past weather for old readings (archive.ts). Default: the network, unless getWeather is a test fake; null = cached days only. */
  fetchArchive?: Fetcher | null;
  /** Sends support tickets to the team; null = only stored. */
  mail?: SendMail | null;
  /** Abuse limits for "Coba demo": new copies per address per day, and copies alive at once. */
  demoLimits?: { perIp: number; maxLive: number };
  /** Deletes what a farm left on disk (captures and pond cover pictures): an expired demo farm, or a deleted account's farm. */
  removeFarmFiles?: (farmId: number) => void;
  /** Where pond cover pictures are kept (captures.ts coverStore); null = covers cannot be saved. */
  covers?: CoverStore | null;
}

/** Briefings made in another language for the same evening (the viewer's language had none yet), per farm per day. */
export const MAX_LANG_BRIEFINGS_PER_DAY = 2;

const MAX_IMAGES = 24;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** A pond cover picture, already made smaller on the phone (about 1000 px on the long side). */
const MAX_COVER_BYTES = 2 * 1024 * 1024;
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const SESSION_DAYS = 90;
const INVITE_DAYS = 7;
const HISTORY_DAYS = 14;
/** History can be opened further back (notebook pages from before the app), up to about a year. */
const HISTORY_MAX_DAYS = 400;
/** Rows saved from notebook pages in one go. */
const MAX_NOTEBOOK_ROWS = 300;
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
  { clock = () => new Date(), getWeather = defaultGetWeather, geocode = defaultGeocode, ai, saveCapture, cookieName = 'synteel_session', demoPhone = null, farmAiCap = 0, agentProviders = [], sam = null, getBmkg = getBmkgForecast, getStorm = getStormHours, mail = null, demoLimits = { perIp: DEMO_PER_IP_PER_DAY, maxLive: DEMO_MAX_LIVE }, removeFarmFiles, fetchArchive, covers = null }: ApiDeps = {},
) {
  const api = new Hono<Env>();
  // Every handler below answers in the language the app asked for (i18n.ts).
  api.use((c, next) => withLang(parseLang(c.req.header('x-lang')), next));
  const limiter = attemptLimiter();
  const supportLimiter = attemptLimiter(5, 60 * 60_000, undefined, () => tx('Terlalu banyak pesan. Coba lagi 1 jam lagi.', 'Too many messages. Try again in 1 hour.'));
  // New accounts per network: room for a farmer group signing up together on one Wi-Fi, not for a bot.
  const signupLimiter = attemptLimiter(20, 60 * 60_000, undefined, () => tx('Terlalu banyak pendaftaran dari jaringan ini. Coba lagi 1 jam lagi.', 'Too many sign-ups from this network. Try again in 1 hour.'));
  // E-mail codes (Daftar, Lupa PIN): 5 an hour per number or address, 30 per network.
  const codes = emailCodes();
  const codeMessage = () => tx('Terlalu banyak kode diminta. Coba lagi 1 jam lagi.', 'Too many codes asked for. Try again in 1 hour.');
  const codeLimiter = attemptLimiter(5, 60 * 60_000, undefined, codeMessage);
  const codeIpLimiter = attemptLimiter(30, 60 * 60_000, undefined, codeMessage);
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
  // The water temperature model per pond (pondtemp.ts). Tests that fake the weather get no archive calls.
  const thermal = thermalService({ archive: store.weatherArchive, fetchArchive: fetchArchive !== undefined ? fetchArchive : getWeather === defaultGetWeather ? fetch : null });

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
    return { ...pond, cover: pond.cover ?? null, batch, program, latest, limits, status, lastLogAt, findings, level: overallLevel(findings), device, simulated: device?.simulated ?? false };
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
    const ponds = await Promise.all(
      r.listPonds().map(async (pond) => {
        const { batch, logs, program } = pondState(r, pond, now);
        // The water temperature model learned from the pond's longer history; on failure, from the last week alone.
        const learned = await thermal.forPond(r, pond, weather, now.getTime(), timezone(r)).catch((err) => (console.error(`thermal pond ${pond.id}:`, err), null));
        return computeNowcast({
          pond,
          phase: batch?.phase,
          density: program?.density ?? undefined,
          logs,
          weather,
          thermal: learned?.model,
          thresholds,
          now: now.getTime(),
          timezone: timezone(r),
        });
      }),
    );
    // The next hours for the weather card; the full series stays on the server.
    const hours = weather
      .filter((h) => h.t >= now.getTime() - 3600_000 && h.t <= now.getTime() + 24 * 3600_000)
      .map(({ t, airTemp, rain, cloud }) => ({ t, airTemp, rain, cloud }));
    return { generatedAt: now.getTime(), weather: { available: weather.length > 0, error: weatherError, place: farm?.locationName ?? null, hours }, ponds };
  }

  // ---------- power cuts and BMKG (power.ts, bmkg.ts) ----------

  /** A village as the app shows it. */
  const desaView = (d: Desa) => ({ code: d.code, desa: d.name, kecamatan: d.kecamatan, kabupaten: d.kabupaten, provinsi: d.provinsi });

  /** BMKG for the weather card and the agent: the region, and the next 24 hours of 3-hour steps in the viewer's language. */
  function bmkgView(region: Region | null, forecast: BmkgForecast | null, error: string | null, now: number) {
    if (!region) return null;
    const en = currentLang() === 'en';
    return {
      source: 'BMKG',
      region: { ...desaView(region.desa), auto: region.auto, km: region.km },
      steps: (forecast?.steps ?? [])
        .filter((s) => s.t >= now - 90 * 60_000 && s.t <= now + 24 * 3600_000)
        .map((s) => ({ t: s.t, code: s.code, desc: en ? s.descEn || s.desc : s.desc, rain: s.rain, wind: s.wind, temp: s.temp })),
      error: forecast ? null : error,
    };
  }

  /** Tonight's power-cut risk for a farm, from Open-Meteo storm signs and the BMKG village forecast. */
  async function powerState(r: FarmRepo, now: number) {
    const farm = r.getFarm();
    if (!farm) return { power: null, bmkg: null };
    const [storm, bmkg] = await Promise.all([
      farm.lat != null && farm.lon != null ? getStorm(farm.lat, farm.lon, now).catch(() => []) : Promise.resolve([]),
      farmForecast(farm, getBmkg, now).catch(() => null),
    ]);
    const power: PowerNight = assessPowerNight({ storm, bmkg: bmkg?.forecast?.steps ?? null, now, timezone: farm.timezone, backup: farm.powerBackup ?? null, outage: r.openOutage() });
    return { power, bmkg: bmkgView(bmkg?.region ?? regionCandidates(farm)[0] ?? null, bmkg?.forecast ?? null, bmkg?.error ?? null, now) };
  }

  /** nowcastAll plus tonight's power-cut risk: its own label, and a higher danger for ponds already at risk. */
  async function nowcastFull(r: FarmRepo) {
    const at = clock().getTime();
    const job = powerState(r, at);
    const nc = await nowcastAll(r);
    const { power, bmkg } = await job;
    const ponds = power
      ? nc.ponds.map((p) => {
          const pond = r.getPond(p.pondId);
          return pond ? applyPower(p, pond, power, nc.generatedAt, timezone(r)) : p;
        })
      : nc.ponds;
    return { ...nc, weather: { ...nc.weather, bmkg }, ponds, power };
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
    const nc = await nowcastFull(r);
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
      bmkg: nc.weather.bmkg,
      power: nc.power,
      history: (pondId, days) => pondHistory(r, pondId, days),
    };
  }

  /** Runs the briefing agent (or the rules) in the current language and saves it. `basis`: re-run of that briefing in this language. */
  async function makeBriefing(r: FarmRepo, basis: number | null = null): Promise<Briefing & { id: number }> {
    const input = await briefingInput(r);
    const briefing = await runBriefing(input, ai?.mode === 'meta' ? agentProviders : []);
    const id = r.saveBriefing(localDate(new Date(input.now), timezone(r)), briefing, basis === null ? null : 'lang', basis);
    return { ...briefing, id };
  }

  // A briefing in another language runs in the background; the phone polls while `running`.
  const briefJobs = new Map<number, Promise<unknown>>();

  /**
   * Today's briefing in the viewer's language. The newest briefing someone asked for (or the evening run made)
   * is the one that counts; when it was written in another language by the agent, the agent writes it once more
   * in this language in the background, within its own small daily allowance, and the rules version shows meanwhile.
   */
  async function briefingFor(r: FarmRepo): Promise<{ briefing: Briefing | null; running: boolean }> {
    const today = localDate(clock(), timezone(r));
    const rows = r.briefingRows<Briefing>(today);
    const original = rows.filter((b) => b.kind !== 'lang').at(-1);
    const lang = currentLang();
    if (!original) return { briefing: null, running: false };
    if (original.lang === lang) return { briefing: original.body, running: false };
    const translated = rows.find((b) => b.kind === 'lang' && b.basis === original.id && b.lang === lang);
    if (translated) return { briefing: translated.body, running: false };
    let running = briefJobs.has(r.farmId);
    if (!running && original.body.source === 'agent' && ai?.mode === 'meta' && r.briefingsOn(today, 'lang') < MAX_LANG_BRIEFINGS_PER_DAY) {
      running = true;
      const job = withLang(lang, () => makeBriefing(r, original.id))
        .catch((err) => console.error(`briefing farm ${r.farmId} (${lang}):`, err))
        .finally(() => briefJobs.delete(r.farmId));
      briefJobs.set(r.farmId, job);
    }
    return { briefing: { ...rulesBriefing(await briefingInput(r)), generatedAt: original.body.generatedAt }, running };
  }

  // ---------- dead-eel cases (cases.ts) ----------

  /** What the rules and the case agent look at, read fresh from the pond records. */
  async function caseInput(r: FarmRepo, c: CaseRow, trigger: CaseTrigger): Promise<CaseInput> {
    const now = clock();
    const pond = r.getPond(c.pondId);
    if (!pond) throw new NotFound(tx('Kolam tidak ditemukan', 'Pond not found'));
    const s = pondSummary(r, pond);
    // Only the case's own pond: the forecast for the others is not needed.
    let weather: Awaited<ReturnType<typeof getWeather>>['hours'] = [];
    const farm = r.getFarm();
    if (farm?.lat != null && farm.lon != null) weather = (await getWeather(farm.lat, farm.lon, now.getTime()).catch(() => ({ hours: [] }))).hours;
    const { batch, logs, program } = pondState(r, pond, now);
    const nowcast = computeNowcast({ pond, phase: batch?.phase, density: program?.density ?? undefined, logs, weather, thresholds, now: now.getTime(), timezone: timezone(r) });
    const openedAt = Date.parse(c.openedAt);
    return {
      caseId: c.id,
      pondId: pond.id,
      pondName: pond.name,
      phase: s.batch?.phase ?? null,
      week: s.program?.week ?? null,
      openedAt,
      now: now.getTime(),
      timezone: timezone(r),
      logs: r.logsSince(pond.id, new Date(Math.min(openedAt, now.getTime()) - DAY_MS).toISOString()),
      events: r.caseEvents(c.id) as CaseEvent[],
      findings: s.findings.map((f) => ({ title: f.title, level: f.level })),
      latest: s.latest as CaseInput['latest'],
      nowcast,
      weather: weather.filter((h) => h.t >= now.getTime() - 3600_000 && h.t <= now.getTime() + 24 * 3600_000).map(({ t, airTemp, rain, cloud }) => ({ t, airTemp, rain, cloud })),
      history: (days) => pondHistory(r, pond.id, days),
      trigger,
    };
  }

  // Agent runs happen in the background so a report is saved at once; the phone polls while `running`.
  // One run per case at a time; anything that arrives meanwhile asks for one more run afterwards.
  const caseJobs = new Map<number, Promise<void>>();
  const caseAgain = new Map<number, { trigger: CaseTrigger; lang: Lang }>();

  /** Agent runs of a case today: the farmer's own, and re-runs in another language (each has its own allowance). */
  function caseRunsToday(r: FarmRepo, events: CaseEvent[]) {
    const today = localDate(clock(), timezone(r));
    const todays = events.filter((e) => e.kind === 'run' && !e.data?.precomputed && localDate(new Date(e.at), timezone(r)) === today);
    return { agent: todays.filter((e) => e.data?.source === 'agent' && !e.data?.langRun).length, lang: todays.filter((e) => e.data?.langRun).length };
  }

  /** One case update in the current language. `basis`: the run (event id) this one repeats in another language. */
  async function runCaseOnce(r: FarmRepo, caseId: number, trigger: CaseTrigger, basis?: number) {
    const c = r.getCase(caseId);
    if (!c || c.status !== 'open') return;
    const input = await caseInput(r, c, trigger);
    const used = caseRunsToday(r, input.events);
    let run: CaseRun;
    if (ai?.mode === 'mock') run = mockCaseRun(input);
    else if (ai?.mode === 'meta' && (basis === undefined ? used.agent < MAX_AGENT_RUNS_PER_DAY : used.lang < MAX_LANG_RUNS_PER_DAY)) run = await runCaseAgent(input, agentProviders);
    else run = rulesCaseRun(input);
    // The case may have been closed while the model was thinking.
    if (r.getCase(caseId)?.status === 'open') r.addCaseEvent(caseId, 'run', clock().toISOString(), null, basis === undefined ? run : { ...run, langRun: true, basis });
  }

  /**
   * The case update to show in the viewer's language: the newest run (not counting other-language re-runs), or
   * its re-run in this language. A run the agent wrote in another language is written once more in this
   * one in the background (`needs`); until then the view shows the rules version.
   */
  function caseRunFor(events: CaseEvent[]): { saved: CaseRun | null; needs: { basis: number; trigger: CaseTrigger } | null } {
    const runs = events.filter((e) => e.kind === 'run');
    const original = runs.filter((e) => !e.data?.langRun).at(-1);
    if (!original) return { saved: null, needs: null };
    const lang: Lang = currentLang();
    if (original.data.lang === lang) return { saved: original.data, needs: null };
    const translated = runs.find((e) => e.data?.langRun && e.data.basis === original.id && e.data.lang === lang);
    if (translated) return { saved: translated.data, needs: null };
    return { saved: original.data, needs: original.data.source === 'agent' ? { basis: original.id, trigger: original.data.trigger ?? 'open' } : null };
  }

  /** Runs the case update in the background, in the language of whoever caused it. */
  function kickCase(r: FarmRepo, caseId: number, trigger: CaseTrigger) {
    const lang = currentLang();
    if (caseJobs.has(caseId)) {
      caseAgain.set(caseId, { trigger, lang });
      return;
    }
    caseAgain.set(caseId, { trigger, lang });
    caseJobs.set(caseId, drainCase(r, caseId));
  }

  /** Works through the runs asked for while the previous one was busy, then frees the case. */
  function drainCase(r: FarmRepo, caseId: number, first?: Promise<unknown>): Promise<void> {
    return (async () => {
      await first;
      for (let next = caseAgain.get(caseId); next; next = caseAgain.get(caseId)) {
        caseAgain.delete(caseId);
        const { trigger, lang } = next;
        await withLang(lang, () => runCaseOnce(r, caseId, trigger)).catch((err) => console.error(`case ${caseId}:`, err));
      }
    })().finally(() => caseJobs.delete(caseId));
  }

  /** The farm owner to send the case to: an owner other than the person looking, with the number for wa.me. */
  function caseOwner(farmId: number, userId: number) {
    const owners = store.members(farmId).filter((m) => m.role === 'owner');
    const other = owners.find((m) => m.id !== userId);
    return other ? { name: other.name, phone: other.phone } : owners[0] ? { name: owners[0].name, phone: null } : null;
  }

  async function viewCase(r: FarmRepo, c: CaseRow, userId: number): Promise<CaseView> {
    const input = await caseInput(r, c, 'open');
    const { saved, needs } = caseRunFor(input.events);
    // Another language's agent run: write it once in this language too, within its own allowance.
    if (needs && c.status === 'open' && ai?.mode === 'meta' && !caseJobs.has(c.id) && caseRunsToday(r, input.events).lang < MAX_LANG_RUNS_PER_DAY) {
      const lang = currentLang();
      const translate = withLang(lang, () => runCaseOnce(r, c.id, needs.trigger, needs.basis)).catch((err) => console.error(`case ${c.id} (${lang}):`, err));
      // Anything the farmer does meanwhile runs right after it.
      caseJobs.set(c.id, drainCase(r, c.id, translate));
    }
    return caseView(input, c, saved, caseOwner(r.farmId, userId), caseJobs.has(c.id) || caseAgain.has(c.id));
  }

  /** After a log is saved: a dead-eel report opens or adds to the pond's case; the re-check answers it. */
  function caseAfterLog(r: FarmRepo, log: Log, userId: number, flags: { report: boolean; recheck?: 'better' | 'worse' }) {
    const dead = log.data.mortality ?? 0;
    let c = r.openCase(log.pondId);
    if (!c) {
      if (!flags.report || dead <= 0) return;
      try {
        c = r.openCaseFor(log.pondId, log.loggedAt);
      } catch {
        // Two reports at the same moment: the other one opened it.
        c = r.openCase(log.pondId);
        if (!c) return;
        r.addCaseEvent(c.id, 'report', log.loggedAt, userId, { dead, logId: log.id, recheck: true });
        return kickCase(r, c.id, 'report');
      }
      r.addCaseEvent(c.id, 'open', log.loggedAt, userId, { dead, logId: log.id, recheck: true });
      return kickCase(r, c.id, 'open');
    }
    if (flags.recheck) {
      r.addCaseEvent(c.id, 'recheck', log.loggedAt, userId, { better: flags.recheck === 'better', more: dead, logId: log.id });
      return kickCase(r, c.id, 'recheck');
    }
    if (dead > 0) {
      r.addCaseEvent(c.id, 'report', log.loggedAt, userId, { dead, logId: log.id, recheck: flags.report });
      return kickCase(r, c.id, 'report');
    }
  }

  // ---------- sessions ----------

  const clientIp = (c: Context) => c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0].trim() ?? 'local';

  function startSession(c: Context, userId: number, farmId: number | null, days = SESSION_DAYS) {
    const token = newToken();
    store.createSession(hashToken(token), userId, farmId, days);
    setCookie(c, cookieName, token, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: c.req.header('x-forwarded-proto') === 'https',
      path: '/',
      maxAge: days * 86400,
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
    return { user: store.user(userId), farm: farms.find((f) => f.id === farmId) ?? null, farms, demo: isDemoUser(userId) };
  }

  const isDemoUser = (userId: number) => store.user(userId)?.phone === demoPhone || store.demo.isDemoUser(userId);

  // ---------- public routes: everything registered before the session check below ----------

  // `email`: Daftar asks for an e-mail code and Lupa PIN works by e-mail (the server can send mail).
  api.get('/auth/options', (c) => c.json({ demo: Boolean(demoPhone && store.demo.template()), email: Boolean(mail) }));

  const noEmail = () => new AuthError(tx('Nomor ini belum punya email untuk mengatur ulang PIN. Hubungi bantuan.', 'This number has no e-mail for resetting the PIN. Contact support.'), 404, 'no_email');

  function codeMail(purpose: CodePurpose, code: string, email: string) {
    const what = purpose === 'register' ? tx('mendaftar di Synteel', 'create a Synteel account') : tx('membuat PIN baru di Synteel', 'set a new Synteel PIN');
    const ignore =
      purpose === 'register'
        ? tx('Kalau tidak sedang mendaftar di Synteel, abaikan email ini.', 'If you are not creating a Synteel account, ignore this e-mail.')
        : tx('Kalau tidak sedang meminta PIN baru, abaikan email ini. PIN lama tetap berlaku.', 'If you did not ask for a new PIN, ignore this e-mail. The old PIN still works.');
    return {
      to: [email],
      subject: tx(`Kode Synteel: ${code}`, `Synteel code: ${code}`),
      text: [tx(`Kode untuk ${what}:`, `Code to ${what}:`), '', code, '', tx('Berlaku 15 menit.', 'Valid for 15 minutes.'), ignore, '', 'PT Synt Tekno Multikarya · eel.synt.fun'].join('\n'),
    };
  }

  // Daftar and Lupa PIN: a 6-digit code to the e-mail address (Daftar: the one typed; Lupa PIN: the account's).
  api.post('/auth/code', async (c) => {
    if (!mail) throw new AuthError(tx('Kode lewat email belum tersedia. Hubungi bantuan.', 'Codes by e-mail are not available yet. Contact support.'), 404, 'no_mail');
    const body = await c.req.json();
    const purpose: CodePurpose = body.purpose === 'reset' ? 'reset' : 'register';
    const phone = normalizePhone(body.phone);
    const user = store.userByPhone(phone);
    let email: string | null;
    if (purpose === 'register') {
      if (user) throw new AuthError(tx('Nomor ini sudah terdaftar. Silakan masuk.', 'This number is already registered. Please sign in.'), 409, 'phone_taken');
      email = normalizeEmail(body.email);
      if (!email) throw new BadRequest(tx('Alamat email tidak valid', 'The e-mail address is not valid'));
    } else {
      email = user?.email ?? null;
      if (!email) throw noEmail();
    }
    const keys = [`phone:${phone}`, `email:${email}`];
    const ip = `ip:${clientIp(c)}`;
    codeLimiter.check(...keys);
    codeIpLimiter.check(ip);
    codeLimiter.fail(...keys);
    codeIpLimiter.fail(ip);
    const code = codes.issue(purpose, phone, email);
    try {
      await mail(codeMail(purpose, code, email));
    } catch (err) {
      console.error(`${purpose} code mail failed: ${(err as Error).message}`);
      throw new BadRequest(tx('Email gagal dikirim. Periksa alamatnya, lalu coba lagi.', 'The e-mail could not be sent. Check the address, then try again.'));
    }
    return c.json({ sentTo: maskEmail(email) });
  });

  // Lupa PIN: the code from the account's e-mail sets a new PIN and signs in (other sessions end).
  api.post('/auth/reset', async (c) => {
    const body = await c.req.json();
    const phone = normalizePhone(body.phone);
    const user = store.userByPhone(phone);
    if (!user?.email) throw noEmail();
    const pin = checkPin(body.pin);
    codes.use('reset', phone, user.email, body.code);
    store.setPin(user.id, hashPin(pin));
    limiter.clear(`phone:${phone}`);
    const farmId = store.farmsOf(user.id)[0]?.id ?? null;
    startSession(c, user.id, farmId);
    return c.json(me(user.id, farmId));
  });

  api.post('/auth/register', async (c) => {
    const body = await c.req.json();
    const phone = normalizePhone(body.phone);
    const pin = checkPin(body.pin);
    const name = text(body.name, 'nama', true)!;
    if (store.userByPhone(phone)) throw new AuthError(tx('Nomor ini sudah terdaftar. Silakan masuk.', 'This number is already registered. Please sign in.'), 409, 'phone_taken');
    // With mail set up, the e-mail code proves the address; it is kept for Lupa PIN.
    const email = mail ? normalizeEmail(body.email) : null;
    if (mail && !email) throw new BadRequest(tx('Alamat email tidak valid', 'The e-mail address is not valid'));
    const key = `ip:${clientIp(c)}`;
    signupLimiter.check(key);
    if (email) codes.use('register', phone, email, body.emailCode);
    signupLimiter.fail(key);
    const user = store.createUser({ phone, name, pinHash: hashPin(pin), email });
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

  // "Coba demo": a fresh copy of the template demo farm for each tap, deleted after 48 hours (demo.ts).
  api.post('/auth/demo', (c) => {
    const template = demoPhone ? store.demo.template() : null;
    if (!template) throw new AuthError(tx('Demo tidak tersedia saat ini. Coba lagi nanti.', 'The demo is not available right now. Try again later.'), 403);
    const now = clock();
    const ip = clientIp(c);
    const counts = store.demo.counts(ip, now);
    if (counts.fromIp >= demoLimits.perIp) {
      throw new AuthError(tx('Demo sudah dibuka berkali-kali dari jaringan ini hari ini. Coba lagi besok.', 'The demo was opened many times from this network today. Try again tomorrow.'), 429, 'demo_limit');
    }
    if (counts.live >= demoLimits.maxLive) {
      throw new AuthError(tx('Sedang banyak yang mencoba demo. Coba lagi beberapa jam lagi.', 'Many people are trying the demo right now. Try again in a few hours.'), 429, 'demo_full');
    }
    const copy = store.demo.copyTemplate(template, { phone: `demo-${newToken().slice(0, 16)}`, name: tx('Petani Demo', 'Demo Farmer'), pinHash: hashPin(newToken()) }, now, ip);
    startSession(c, copy.userId, copy.farmId, 2);
    return c.json(me(copy.userId, copy.farmId));
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
      const key = `ip:${clientIp(c)}`;
      signupLimiter.check(key);
      signupLimiter.fail(key);
      user = { ...store.createUser({ phone, name: text(body.name, 'nama', true)!, pinHash: hashPin(checkPin(body.pin)) }), pinHash: '', email: null };
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
    // The app asks for WhatsApp; the website's contact form asks for e-mail.
    const replyEmail = body.replyEmail && !body.replyPhone ? String(body.replyEmail).trim().toLowerCase() : null;
    if (replyEmail !== null && (replyEmail.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(replyEmail))) {
      throw new BadRequest(tx('Alamat email tidak valid', 'The e-mail address is not valid'));
    }
    const replyPhone = replyEmail !== null ? '' : phone(body.replyPhone, 'Nomor WhatsApp');
    const accountPhone = body.accountPhone ? phone(body.accountPhone, 'Nomor HP akun') : null;
    const device = body.device ? String(body.device).trim().slice(0, 300) || null : null;
    const keys = [`ip:${clientIp(c)}`, replyEmail !== null ? `email:${replyEmail}` : `phone:${replyPhone}`];
    supportLimiter.check(...keys);
    supportLimiter.fail(...keys);
    const ticket = { topic, message, replyPhone, replyEmail, accountPhone, device, userId: session?.userId ?? null, farmId: session?.farmId ?? null };
    const id = store.addSupportTicket(ticket);
    const number = String(id).padStart(4, '0');
    // Not awaited: the farmer gets the ticket number right away.
    void Promise.resolve()
      .then(() => mailTicket(id, number, ticket, session?.role ?? null))
      .catch((err) => console.error(`support ticket #${number}:`, err));
    return c.json({ ticket: number }, 201);
  });

  async function mailTicket(id: number, number: string, t: { topic: SupportTopic; message: string; replyPhone: string; replyEmail: string | null; accountPhone: string | null; device: string | null; userId: number | null; farmId: number | null }, role: Role | null) {
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
      t.replyEmail ? `Email untuk balasan: ${t.replyEmail}` : `WhatsApp untuk balasan: +${t.replyPhone}`,
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
  // Photos and recordings stay on the server after the AI read them only when the phone opted in (Profil → Simpan foto dan rekaman).
  const keptBy = (c: Context<Env>) => (c.req.header('x-keep-media') === '1' ? saveCapture : undefined);
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
    if (isDemoUser(user.id)) throw new AuthError(tx('PIN akun demo tidak bisa diubah', 'The demo account PIN cannot be changed'), 403);
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

  // Profil → Hapus akun, confirmed with the PIN. Farms where this person is the only owner are deleted with their photos.
  api.post('/auth/delete', async (c) => {
    const body = await c.req.json();
    const user = store.userByPhone(store.user(c.get('userId'))!.phone)!;
    const keys = [`phone:${user.phone}`];
    limiter.check(...keys);
    if (!verifyPin(String(body.pin ?? ''), user.pinHash)) {
      limiter.fail(...keys);
      throw new AuthError(tx('PIN salah', 'Wrong PIN'), 403);
    }
    for (const farmId of store.deleteAccount(user.id)) {
      try {
        removeFarmFiles?.(farmId);
      } catch (err) {
        console.error(`deleted farm ${farmId} files:`, err);
      }
    }
    deleteCookie(c, cookieName, { path: '/' });
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
    // "Cadangan listrik" can be answered in the same form (Siapkan tambak); left out, it stays as it was.
    const backup = oneOf<PowerBackup>(body.powerBackup, POWER_BACKUPS, 'cadangan listrik');
    if (c.get('farmId') === null) {
      const id = store.createFarm(farm, c.get('userId'));
      store.setSessionFarm(c.get('tokenHash'), id);
      if (backup) store.farm(id).setPowerBackup(backup);
      return c.json({ farm: store.farm(id).getFarm() }, 201);
    }
    const r = needOwner(c);
    const before = r.getFarm();
    r.saveFarm(farm);
    if (backup) r.setPowerBackup(backup);
    // The farm moved: a BMKG village picked for the old place no longer fits; go back to the nearest one.
    if (before?.adm4 && (before.lat !== farm.lat || before.lon !== farm.lon)) r.setAdm4(null);
    return c.json({ farm: r.getFarm() });
  });

  // ---------- power cuts and the BMKG region ----------

  // "Cadangan listrik" in Profil (owner).
  api.put('/farm/power', async (c) => {
    const r = needOwner(c);
    const backup = oneOf<PowerBackup>((await c.req.json()).powerBackup, POWER_BACKUPS, 'cadangan listrik');
    if (!backup) throw invalid('cadangan listrik');
    r.setPowerBackup(backup);
    return c.json({ farm: r.getFarm() });
  });

  // "Ganti wilayah": villages by name, for the owner to pick the BMKG forecast region.
  api.get('/wilayah', (c) => {
    needFarm(c);
    return c.json({ results: searchDesa(String(c.req.query('q') ?? '').slice(0, 80)).map(desaView) });
  });

  // The owner's pick (a Kemendagri village code), or null to go back to the village nearest the farm.
  api.put('/farm/wilayah', async (c) => {
    const r = needOwner(c);
    const code = (await c.req.json()).code;
    if (code !== null && (typeof code !== 'string' || !findDesa(code))) throw invalid('wilayah');
    r.setAdm4(code);
    const region = regionCandidates(r.getFarm()!)[0] ?? null;
    return c.json({ farm: r.getFarm(), region: region && { ...desaView(region.desa), auto: region.auto, km: region.km } });
  });

  /** "Sudah berapa lama padam?": minutes before now, 0 to 24 hours. */
  const startFrom = (minutesAgo: unknown) => new Date(clock().getTime() - (num(minutesAgo, 'lama padam', { min: 0, max: 24 * 60 }) ?? 0) * 60_000).toISOString();
  const outageView = (r: FarmRepo, id: number) => ({ outage: r.getOutage(id), backup: r.getFarm()?.powerBackup ?? null });

  // The power cut being recorded now, if any (Beranda, Masalah).
  api.get('/outages/open', (c) => {
    const r = needFarm(c);
    const open = r.openOutage();
    return c.json({ outage: open && clock().getTime() - Date.parse(open.startedAt) < 24 * 3600_000 ? open : null, backup: r.getFarm()?.powerBackup ?? null });
  });

  // "Listrik padam": one tap records when it started; a second tap while it is still out returns the same one.
  api.post('/outages', async (c) => {
    const r = needFarm(c);
    const body = await c.req.json().catch(() => ({}));
    const open = r.openOutage();
    if (open && clock().getTime() - Date.parse(open.startedAt) < 24 * 3600_000) return c.json(outageView(r, open.id));
    if (open) r.endOutage(open.id, open.startedAt, null);
    const outage = r.startOutage(startFrom(body.minutesAgo), c.get('userId'));
    return c.json(outageView(r, outage.id), 201);
  });

  const needOutage = (c: Context<Env>) => {
    const r = needFarm(c);
    const outage = r.getOutage(Number(c.req.param('id')));
    if (!outage) throw new NotFound(tx('Catatan listrik padam tidak ditemukan', 'Power cut record not found'));
    return { r, outage };
  };

  // "Sudah berapa lama padam?": moves the start back.
  api.put('/outages/:id', async (c) => {
    const { r, outage } = needOutage(c);
    if (outage.endedAt) throw new BadRequest(tx('Listrik sudah dicatat menyala', 'The power is already recorded as back on'));
    r.moveOutageStart(outage.id, startFrom((await c.req.json()).minutesAgo));
    return c.json(outageView(r, outage.id));
  });

  // "Listrik sudah menyala".
  api.post('/outages/:id/end', (c) => {
    const { r, outage } = needOutage(c);
    if (!outage.endedAt) r.endOutage(outage.id, clock().toISOString(), c.get('userId'));
    return c.json(outageView(r, outage.id));
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

  api.get('/briefing', async (c) => c.json(await briefingFor(needFarm(c))));

  // Ask for a fresh briefing now (the server also makes one by itself every evening).
  api.post('/briefing', async (c) => {
    const r = needFarm(c);
    if (r.listPonds().length === 0) throw new BadRequest(tx('Belum ada kolam', 'No ponds yet'));
    if (r.briefingsOn(localDate(clock(), timezone(r))) >= MAX_BRIEFINGS_PER_DAY) throw new BadRequest(tx('Ringkasan malam hari ini sudah disusun beberapa kali. Coba lagi besok.', "Tonight's summary has been made several times today. Try again tomorrow."));
    const { id: _id, ...briefing } = await makeBriefing(r);
    return c.json({ briefing }, 201);
  });

  // ---------- dead-eel cases ----------

  // Open cases of the farm (Beranda); with ?pond= also that pond's closed ones (pond page).
  api.get('/cases', async (c) => {
    const r = needFarm(c);
    const pondId = c.req.query('pond') ? Number(c.req.query('pond')) : undefined;
    const rows = r.listCases(pondId);
    return c.json({ cases: await Promise.all(rows.map((row) => viewCase(r, row, c.get('userId')))) });
  });

  const needCase = (c: Context<Env>) => {
    const r = needFarm(c);
    const row = r.getCase(Number(c.req.param('id')));
    if (!row) throw new NotFound(tx('Kasus tidak ditemukan', 'Case not found'));
    return { r, row };
  };

  // The farmer's answers to the agent's questions (tapped, typed, or said and turned into text).
  api.post('/cases/:id/answers', async (c) => {
    const { r, row } = needCase(c);
    if (row.status !== 'open') throw new BadRequest(tx('Kasus sudah ditutup', 'The case is closed'));
    const body = await c.req.json();
    const answers = (Array.isArray(body.answers) ? body.answers : [])
      .map((x: any) => ({ q: String(x?.q ?? '').trim().slice(0, 120), a: String(x?.a ?? '').trim().slice(0, 300) }))
      .filter((x: { q: string; a: string }) => x.q && x.a)
      .slice(0, 2);
    if (!answers.length) throw new BadRequest(tx('Jawaban masih kosong', 'No answer yet'));
    r.addCaseEvent(row.id, 'answer', clock().toISOString(), c.get('userId'), { answers });
    kickCase(r, row.id, 'answer');
    return c.json({ case: await viewCase(r, row, c.get('userId')) });
  });

  // "Hari ini tidak ada yang mati": a record for today, so the day counts towards closing.
  api.post('/cases/:id/nodead', async (c) => {
    const { r, row } = needCase(c);
    if (row.status !== 'open') throw new BadRequest(tx('Kasus sudah ditutup', 'The case is closed'));
    const at = clock().toISOString();
    const log = r.addLog({ pondId: row.pondId, batchId: r.activeBatch(row.pondId)?.id ?? null, loggedAt: at, source: 'manual', data: { note: tx('Kasus sidat mati: hari ini tidak ada yang mati', 'Dead eel case: none dead today') } }, c.get('userId'));
    r.addCaseEvent(row.id, 'nodead', at, c.get('userId'), { logId: log.id });
    kickCase(r, row.id, 'nodead');
    return c.json({ case: await viewCase(r, row, c.get('userId')) });
  });

  // Closing is the farmer's choice, offered after 2 recorded days without deaths; the owner may close any time.
  api.post('/cases/:id/close', async (c) => {
    const { r, row } = needCase(c);
    if (row.status !== 'open') return c.json({ case: await viewCase(r, row, c.get('userId')) });
    const view = await viewCase(r, row, c.get('userId'));
    if (!view.closeSuggested && c.get('role') !== 'owner') throw new BadRequest(tx('Kasus bisa ditutup sesudah 2 hari tanpa sidat mati.', 'The case can be closed after 2 days without dead eels.'));
    const at = clock().toISOString();
    r.closeCase(row.id, at, c.get('userId'));
    r.addCaseEvent(row.id, 'close', at, c.get('userId'), {});
    return c.json({ case: await viewCase(r, r.getCase(row.id)!, c.get('userId')) });
  });

  // ---------- members ----------

  api.get('/farm/members', (c) => {
    needFarm(c);
    // Workers see names only; owners also see phone numbers, to reach them.
    const owner = c.get('role') === 'owner';
    // Demo people have no real number to show.
    return c.json({ members: store.members(c.get('farmId')!).map((m) => ({ ...m, phone: owner && !m.phone.startsWith('demo-') ? m.phone : undefined, me: m.id === c.get('userId') })) });
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

  api.get('/nowcast', async (c) => c.json(await nowcastFull(needFarm(c))));

  api.delete('/ponds/:id', (c) => {
    needOwner(c).archivePond(Number(c.req.param('id')));
    return c.body(null, 204);
  });

  // ---------- pond photo → profile draft; water temperature model; weekly pattern note ----------

  // A photo of the pond → a draft profile (container, place, water colour, light). Nothing is saved
  // here: the farmer checks the choices and saves them with the pond. Uses the farm's AI quota.
  api.post('/pond-photo', async (c) => {
    const r = needFarm(c);
    const form = await c.req.parseBody();
    const image = form.image instanceof File ? form.image : null;
    if (!image) throw new BadRequest(tx('Foto belum ada', 'No photo yet'));
    if (image.size > MAX_IMAGE_BYTES) throw new BadRequest(tx('Foto terlalu besar', 'The photo is too large'));
    if (!ai || ai.mode === 'off' || typeof ai.pondPhoto !== 'function') throw new AiUnavailable(tx('AI belum aktif. Pilih sendiri dulu.', 'The AI is not on yet. Pick them yourself for now.'));
    useAi(r, c.get('userId'));
    const started = Date.now();
    const read = await ai.pondPhoto({ image });
    const draft = guardPondPhoto(read.raw, { model: read.model, mode: read.mode });
    await keptBy(c)?.({ farmId: r.farmId, pondId: Number(form.pondId) || 0, userId: c.get('userId'), kind: 'pondphoto', at: clock().toISOString(), ms: Date.now() - started, raw: read.raw, draft }, [{ name: 'image-0.jpg', blob: image }]).catch((err) =>
      console.error('capture not stored:', err),
    );
    return c.json({ draft });
  });

  // ---------- the pond's cover picture ----------

  // The pond photo becomes the pond's cover when the farmer taps Simpan (add pond, or the pond profile).
  // Owners only, like the rest of the profile; a new picture replaces the old one.
  api.post('/ponds/:id/cover', async (c) => {
    const r = needOwner(c);
    const pond = r.getPond(Number(c.req.param('id')));
    if (!pond) return c.json({ error: tx('Kolam tidak ditemukan', 'Pond not found') }, 404);
    if (!covers) throw new BadRequest(tx('Foto sampul belum bisa disimpan di server ini', 'Cover photos cannot be saved on this server yet'));
    const form = await c.req.parseBody();
    const image = form.image instanceof File ? form.image : null;
    if (!image) throw new BadRequest(tx('Foto belum ada', 'No photo yet'));
    if (image.size > MAX_COVER_BYTES) throw new BadRequest(tx('Foto terlalu besar', 'The photo is too large'));
    const bytes = new Uint8Array(await image.arrayBuffer());
    // The phone sends a JPEG (prepareImage); anything else is not kept.
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new BadRequest(tx('Foto tidak bisa dibaca', 'The photo cannot be read'));
    const key = covers.save(r.farmId, pond.id, bytes, clock());
    r.setPondCover(pond.id, key);
    if (pond.cover) covers.remove(pond.cover);
    return c.json({ pond: pondSummary(r, r.getPond(pond.id)!) });
  });

  api.delete('/ponds/:id/cover', (c) => {
    const r = needOwner(c);
    const pond = r.getPond(Number(c.req.param('id')));
    if (!pond) return c.json({ error: tx('Kolam tidak ditemukan', 'Pond not found') }, 404);
    r.setPondCover(pond.id, null);
    if (pond.cover) covers?.remove(pond.cover);
    return c.json({ pond: pondSummary(r, r.getPond(pond.id)!) });
  });

  // Served only to members of the pond's farm (the pond lookup is scoped to the session's farm).
  // The page asks with ?v=<key>, so a new picture is a new address and the old one can be cached.
  api.get('/ponds/:id/cover', (c) => {
    const r = needFarm(c);
    const pond = r.getPond(Number(c.req.param('id')));
    const image = pond?.cover ? covers?.read(pond.cover) : null;
    if (!image) return c.json({ error: tx('Foto sampul tidak ada', 'No cover photo') }, 404);
    return c.body(new Uint8Array(image), 200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=604800', 'x-content-type-options': 'nosniff' });
  });

  /** One pond's learned model, its best measuring hours and its pattern facts. */
  async function pondTemperature(r: FarmRepo, pond: Pond) {
    const now = clock().getTime();
    const farm = r.getFarm();
    const tz = timezone(r);
    const forecast = farm?.lat != null && farm.lon != null ? (await getWeather(farm.lat, farm.lon, now).catch(() => ({ hours: [] }))).hours : [];
    const learned: PondThermal = await thermal.forPond(r, pond, forecast, now, tz);
    return { now, learned, facts: patternPond(pond, learned, forecast, now, tz) };
  }

  /** Farm-local midnight of today, as an instant (the pattern agent's daily allowance). */
  const dayStartIso = (r: FarmRepo) => new Date(Date.parse(nextMidnight(clock(), timezone(r))) - DAY_MS).toISOString();
  const patternRunsLeft = (r: FarmRepo) => Math.max(0, MAX_PATTERN_RUNS_PER_DAY - r.patternRunsSince(dayStartIso(r)));

  const patternJobs = new Map<number, Promise<unknown>>();

  // The pond page's water temperature card: "usually off by ±X °C", what it learned from, the pattern note.
  // Like the briefing: when the agent's newest note is in the other language, it writes the note again in this
  // one in the background (within the farm's daily allowance) and the card shows `running` meanwhile.
  api.get('/ponds/:id/temperature', async (c) => {
    const r = needFarm(c);
    const pond = r.getPond(Number(c.req.param('id')));
    if (!pond) return c.json({ error: tx('Kolam tidak ditemukan', 'Pond not found') }, 404);
    const { now, learned, facts } = await pondTemperature(r, pond);
    let running = patternJobs.has(pond.id);
    const original = running || ai?.mode !== 'meta' || !agentProviders.length || patternRunsLeft(r) <= 0 ? null : patternInOtherLang(r, pond.id, now);
    if (original) {
      running = true;
      const lang = currentLang();
      const job = withLang(lang, async () => {
        const [note] = await runPatterns({ farmName: r.getFarm()?.name ?? '', now, timezone: timezone(r), ponds: [facts] }, agentProviders, false);
        r.savePattern(pond.id, new Date(now).toISOString(), lang, note.source, { ...note, translatedFrom: original });
      })
        .catch((err) => console.error(`pattern pond ${pond.id} (${lang}):`, err))
        .finally(() => patternJobs.delete(pond.id));
      patternJobs.set(pond.id, job);
    }
    return c.json({
      model: learned.model,
      hours: facts.hours,
      pattern: patternView(r, facts, now),
      running,
      ask: { mode: ai?.mode === 'meta' && agentProviders.length ? 'agent' : ai?.mode === 'mock' ? 'mock' : 'rules', left: patternRunsLeft(r) },
    });
  });

  // "Baca pola sekarang": the pattern agent for this pond now, in the viewer's language (a few runs per farm a day).
  api.post('/ponds/:id/pattern', async (c) => {
    const r = needFarm(c);
    const pond = r.getPond(Number(c.req.param('id')));
    if (!pond) return c.json({ error: tx('Kolam tidak ditemukan', 'Pond not found') }, 404);
    const { now, facts } = await pondTemperature(r, pond);
    const left = patternRunsLeft(r);
    if (left <= 0) throw new BadRequest(tx('Pola sudah dibaca beberapa kali hari ini. Coba lagi besok.', 'The pattern has been read several times today. Try again tomorrow.'));
    const [note] = await runPatterns({ farmName: r.getFarm()?.name ?? '', now, timezone: timezone(r), ponds: [facts] }, ai?.mode === 'meta' ? agentProviders : [], ai?.mode === 'mock');
    // Too few readings: nothing was asked, nothing is counted.
    if (facts.model.backtest.n >= 6) r.savePattern(pond.id, new Date(now).toISOString(), currentLang(), note.source, note);
    return c.json({ pattern: note, left: patternRunsLeft(r) });
  });

  /** Pattern notes for every pond of a farm (the weekly run and the demo template), in the current language. */
  async function makePatterns(r: FarmRepo): Promise<PondPattern[]> {
    const facts = await Promise.all(r.listPonds().map((p) => pondTemperature(r, p)));
    const ready = facts.filter((f) => f.facts.model.backtest.n >= 6);
    if (!ready.length) return [];
    const now = clock().getTime();
    const notes = await runPatterns({ farmName: r.getFarm()?.name ?? '', now, timezone: timezone(r), ponds: ready.map((f) => f.facts) }, ai?.mode === 'meta' ? agentProviders : [], ai?.mode === 'mock');
    for (const n of notes) r.savePattern(n.pondId, new Date(now).toISOString(), currentLang(), n.source, n);
    return notes;
  }

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
    await keptBy(c)?.(
      { farmId: r.farmId, pondId: pond.id, kind, field, at: clock().toISOString(), ms: Date.now() - started, draft },
      [...images.map((blob, i) => ({ name: `image-${i}.jpg`, blob })), ...(audio ? [{ name: `audio.${audio.type.includes('wav') ? 'wav' : 'webm'}`, blob: audio }] : [])],
    ).catch((err) => console.error('capture not stored:', err));
    return c.json({ draft });
  });

  // A photo of the dead eels (scoop, net or basin, from above) → a count or a range, with outlines and heads (Meta SAM 3.1).
  // Like a capture, nothing is saved: the farmer confirms or corrects the count first.
  api.post('/ponds/:id/count', async (c) => {
    const r = needFarm(c);
    const pond = r.getPond(Number(c.req.param('id')));
    if (!pond) return c.json({ error: tx('Kolam tidak ditemukan', 'Pond not found') }, 404);
    const form = await c.req.parseBody();
    const image = form.image instanceof File ? form.image : null;
    if (!image) throw new BadRequest(tx('Foto belum ada', 'No photo yet'));
    if (image.size > MAX_IMAGE_BYTES) throw new BadRequest(tx('Foto terlalu besar', 'The photo is too large'));
    if (ai?.mode === 'mock') return c.json({ result: { count: 0, low: 0, high: 0, atLeast: false, eels: [], heads: [], review: true, model: 'mock', ms: 0 }, mock: true });
    if (ai?.mode !== 'meta' || !sam?.apiKey) throw new AiUnavailable(tx('Hitung otomatis belum aktif. Hitung manual dulu.', 'Automatic counting is not on yet. Count by hand for now.'));
    // Part of an emergency report: it does not use the farm's daily AI quota (the app promises that).
    const result = await countDeadEels(image, sam, r.activeBatch(pond.id)?.phase ?? 'glass_eel');
    await keptBy(c)?.({ farmId: r.farmId, pondId: pond.id, kind: 'count', at: clock().toISOString(), ms: result.ms, count: result.count, low: result.low, high: result.high, review: result.review }, [{ name: 'image-0.jpg', blob: image }]).catch((err) =>
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
    // A dead-eel report from Masalah (`report: 'dead'`) or the re-check answer (`recheck`) feeds the pond's case.
    caseAfterLog(r, log, c.get('userId'), { report: body.report === 'dead', recheck: oneOf(body.recheck, ['better', 'worse'] as const, 'cek ulang') });
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
    const days = Math.min(HISTORY_MAX_DAYS, Math.max(1, Math.round(Number(c.req.query('days')) || HISTORY_DAYS)));
    const since = new Date(clock().getTime() - days * DAY_MS).toISOString();
    return c.json({ logs: r.historySince(pond.id, since).map((l) => historyLog(c, l)), days });
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

  // ---------- notebook import: photos of a handwritten notebook → rows the farmer checks ----------

  /** Ponds that already have a record (sensor readings aside) on each of these farm-local dates. */
  /** Ponds with a record (not from a sensor) per farm day. `ignore`: logs saved earlier from the same import. */
  function recordedOn(r: FarmRepo, dates: string[], ignore: Set<number> = new Set()): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    const wanted = new Set(dates);
    if (!wanted.size) return out;
    const tz = timezone(r);
    const first = [...wanted].sort()[0];
    const since = new Date(Date.parse(`${first}T00:00:00Z`) - DAY_MS).toISOString();
    for (const l of r.farmLogsSince(since)) {
      if (l.source === 'sensor' || ignore.has(l.id)) continue;
      const day = localDate(new Date(l.loggedAt), tz);
      if (!wanted.has(day)) continue;
      const list = (out[day] ??= []);
      if (!list.includes(l.pondId)) list.push(l.pondId);
    }
    return out;
  }

  // One page photo → rows to check. Nothing is saved here: the farmer checks the rows, then /notebook/save.
  api.post('/notebook/read', async (c) => {
    const r = needFarm(c);
    const ponds = r.listPonds().map(({ id, name, nicknames }) => ({ id, name, nicknames }));
    if (!ponds.length) throw new BadRequest(tx('Belum ada kolam', 'No ponds yet'));
    const form = await c.req.parseBody();
    const image = form.image instanceof File ? form.image : null;
    if (!image) throw new BadRequest(tx('Foto belum ada', 'No photo yet'));
    if (image.size > MAX_IMAGE_BYTES) throw new BadRequest(tx('Foto terlalu besar', 'The photo is too large'));
    const page = Math.min(99, Math.max(1, Math.round(Number(form.page)) || 1));
    const defaultPondId = ponds.find((p) => p.id === Number(form.pondId))?.id ?? null;
    if (!ai || ai.mode === 'off' || typeof ai.notebook !== 'function') throw new AiUnavailable(tx('AI belum aktif. Isi manual dulu, atau coba lagi nanti.', 'The AI is not on yet. Type it in for now, or try again later.'));
    useAi(r, c.get('userId'));
    const today = localDate(clock(), timezone(r));
    const started = Date.now();
    const read = await ai.notebook({ image, ponds, today });
    const { rows, problems } = guardNotebook(read.raw, ponds, { today, page, defaultPondId });
    const dates = rows.flatMap((row) => [row.date, ...row.checks.map((ch) => (ch.field === 'date' && typeof ch.suggestion === 'string' ? ch.suggestion : null))]).filter((d): d is string => !!d);
    const result: NotebookPage = { rows, problems, recorded: recordedOn(r, dates), model: read.model, mode: read.mode };
    await keptBy(c)?.({ farmId: r.farmId, pondId: defaultPondId ?? 0, userId: c.get('userId'), kind: 'notebook', at: clock().toISOString(), ms: Date.now() - started, raw: read.raw, rows }, [{ name: 'image-0.jpg', blob: image }]).catch((err) =>
      console.error('capture not stored:', err),
    );
    return c.json({ page: result });
  });

  // The rows the farmer checked and confirmed: all of them, or the clear ones first while rows marked
  // "Cek lagi" wait. A pond that already has a record that day is skipped unless the farmer chose to
  // save the row too; the same row twice in one import is saved once. `savedBefore` lists the logs an
  // earlier save of the same import made: those do not count as "already recorded" (a page's morning
  // row saved first does not skip its afternoon row), but an identical row is still a repeat.
  api.post('/notebook/save', async (c) => {
    const r = needFarm(c);
    const body = await c.req.json();
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) throw new BadRequest(tx('Belum ada baris untuk disimpan', 'No rows to save yet'));
    if (rows.length > MAX_NOTEBOOK_ROWS) throw new BadRequest(tx('Baris terlalu banyak. Simpan sebagian dulu.', 'Too many rows. Save part of them first.'));
    const tz = timezone(r);
    const now = clock();
    const today = localDate(now, tz);
    // Check every row before saving any, so a bad row does not leave half an import behind.
    const checked = rows.map((row: Record<string, any>, i: number) => {
      const pond = r.getPond(Number(row.pondId));
      if (!pond) throw new BadRequest(tx(`Baris ${i + 1}: kolam tidak ditemukan`, `Row ${i + 1}: pond not found`));
      const date = String(row.date ?? '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw new BadRequest(tx(`Baris ${i + 1}: tanggal tidak valid`, `Row ${i + 1}: the date is not valid`));
      if (date > today) throw new BadRequest(tx(`Baris ${i + 1}: tanggal belum lewat`, `Row ${i + 1}: the date has not come yet`));
      const time = typeof row.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(row.time) ? row.time : '12:00';
      let at = localIso(date, time, tz);
      if (Date.parse(at) > now.getTime()) at = now.toISOString();
      const data = parseLogData(row.data ?? {});
      return { key: String(row.key ?? i).slice(0, 40), pond, date, at, data, also: row.alsoIfRecorded === true };
    });
    const before = (Array.isArray(body.savedBefore) ? body.savedBefore.slice(0, MAX_NOTEBOOK_ROWS) : [])
      .map((id: unknown) => r.getLog(Number(id)))
      .filter((l: LogRecord | null): l is LogRecord => !!l && l.source === 'notebook' && !l.deletedAt);
    const recorded = recordedOn(r, checked.map((x: { date: string }) => x.date), new Set(before.map((l: LogRecord) => l.id)));
    const result: NotebookSaveResult = { saved: [], skipped: [] };
    const seen = new Set<string>(before.map((l: LogRecord) => `${l.pondId}|${l.loggedAt}|${JSON.stringify(l.data)}`));
    for (const x of checked) {
      const same = `${x.pond.id}|${x.at}|${JSON.stringify(x.data)}`;
      if (seen.has(same)) {
        result.skipped.push({ key: x.key, reason: 'repeat' });
        continue;
      }
      seen.add(same);
      if (!x.also && recorded[x.date]?.includes(x.pond.id)) {
        result.skipped.push({ key: x.key, reason: 'recorded' });
        continue;
      }
      const batch = r.activeBatch(x.pond.id);
      const log = r.addLog({ pondId: x.pond.id, batchId: batch && batch.stockedAt <= x.date ? batch.id : null, loggedAt: x.at, source: 'notebook', data: x.data }, c.get('userId'));
      result.saved.push({ key: x.key, logId: log.id });
    }
    // Old pages do not open dead-eel cases or alarms: those follow what happens now.
    return c.json(result, 201);
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
    await keptBy(c)?.(
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
    nowcastFarm: (farmId: number) => nowcastFull(store.farm(farmId)),
    /** Linked Synteel devices: write the logs that are due. Called every minute. */
    sendDeviceLogs,
    /**
     * Every few minutes: a case whose re-check went unanswered gets one agent run for it, and a case
     * with no update yet (opened by a script) gets its first.
     */
    caseRechecks() {
      for (const id of store.farmIds()) {
        // The demo template gets its runs when it is built, never by itself.
        const demo = store.demo.kindOf(id);
        if (demo === 'template' || demo === 'building') continue;
        const r = store.farm(id);
        for (const row of r.listCases()) {
          if (caseJobs.has(row.id)) continue;
          const events = r.caseEvents(row.id);
          const runs = events.filter((e) => e.kind === 'run');
          if (!runs.length) {
            kickCase(r, row.id, 'open');
            continue;
          }
          const report = events.filter((e) => (e.kind === 'open' || e.kind === 'report') && e.data?.recheck).at(-1);
          if (!report || events.some((e) => e.kind === 'recheck' && e.at >= report.at)) continue;
          const missedAt = Date.parse(report.at) + RECHECK_AFTER + RECHECK_GRACE;
          const now = clock().getTime();
          if (now > missedAt && now - Date.parse(report.at) < DAY_MS && !runs.some((e) => e.data?.trigger === 'recheck_missed' && Date.parse(e.at) >= missedAt)) kickCase(r, row.id, 'recheck_missed');
        }
      }
    },
    /** Waits for the case agent runs in flight (tests). */
    async settleCases() {
      while (caseJobs.size || briefJobs.size) await Promise.all([...caseJobs.values(), ...briefJobs.values()]);
    },
    /**
     * (Re)builds the demo template: the seeded farm, then the case update and the evening briefing in
     * Indonesian and English (agent when available, rules otherwise), then it replaces the old template.
     * Copies made before keep working. Returns the new template's farm id.
     */
    async buildDemoTemplate(): Promise<number> {
      if (!demoPhone) throw new Error('SYNTEEL_DEMO_PHONE is not set');
      const owner = store.userByPhone(demoPhone) ?? store.createUser({ phone: demoPhone, name: 'Petani Demo', pinHash: hashPin(newToken()) });
      const now = clock();
      // The forecast call's 7 past days, and the archive before that, so all two weeks of the outdoor pond follow real weather.
      const past = await thermal.pastWeather(-7.72, 110.36, Array.from({ length: 10 }, (_, i) => now.getTime() - (16 - i) * DAY_MS), now.getTime());
      const weather = await getWeather(-7.72, 110.36, now.getTime()).then(
        (w) => (w.hours.length ? new Map([...past, ...w.hours].map((h) => [h.t, h])) : null),
        () => null,
      );
      if (!weather) console.warn('Weather unavailable: outdoor temperatures are synthetic.');
      const farmId = seedDemoFarm(store, owner.id, now, weather);
      const r = store.farm(farmId);
      store.demo.markBuilding(farmId, owner.id, localDate(now, timezone(r)), now);
      const briefings = (async () => {
        const id = await withLang('id', () => makeBriefing(r));
        if (id.source === 'agent') await withLang('en', () => makeBriefing(r, id.id));
      })();
      const cases = Promise.all(
        r.listCases().map(async (c) => {
          await withLang('id', () => runCaseOnce(r, c.id, 'open'));
          const first = r.caseEvents(c.id).filter((e) => e.kind === 'run').at(-1);
          if (first?.data?.source === 'agent') await withLang('en', () => runCaseOnce(r, c.id, 'open', first.id));
        }),
      );
      // The weekly pattern notes, so the pond pages show one at once (agent when available, else a labelled sample or nothing).
      const patterns = ai && ai.mode !== 'off' ? (async () => {
        const id = await withLang('id', () => makePatterns(r));
        if (id.some((n) => n.source !== 'rules')) await withLang('en', () => makePatterns(r));
      })().catch((err) => console.error('demo patterns:', err)) : Promise.resolve();
      await Promise.all([briefings, cases, patterns]);
      store.demo.markTemplate(farmId);
      return farmId;
    },
    /** Deletes demo copies older than 48 hours, with their people and files. Returns how many. */
    expireDemos(): number {
      const gone = store.demo.expired(clock());
      for (const d of gone) {
        store.demo.deleteCopy(d.farmId, d.userId);
        try {
          removeFarmFiles?.(d.farmId);
        } catch (err) {
          console.error(`demo farm ${d.farmId} files:`, err);
        }
      }
      return gone.length;
    },
    /**
     * The weekly pattern agent: every farm with real AI and a pond with enough readings gets new notes once
     * a week (in Indonesian; an English viewer's pond page has the agent write it again in English). Demo farms get theirs from the template.
     */
    async patternFarms() {
      if (ai?.mode !== 'meta' || !agentProviders.length) return;
      for (const id of store.farmIds()) {
        if (store.demo.kindOf(id)) continue;
        const r = store.farm(id);
        const last = r.lastPatternAt();
        if (r.listPonds().length === 0 || (last && clock().getTime() - Date.parse(last) < PATTERN_EVERY_MS)) continue;
        await withLang('id', () => makePatterns(r)).catch((err) => console.error(`patterns farm ${id}:`, err));
      }
    },
    /** The evening run: a briefing for every farm with ponds that has none yet today, from `hour` local time. */
    async briefFarms(hour = 17) {
      for (const id of store.farmIds()) {
        const r = store.farm(id);
        const farm = r.getFarm();
        // Demo farms bring their evening briefing from the template; a visitor can ask for a new one.
        if (!farm || r.listPonds().length === 0 || store.demo.kindOf(id)) continue;
        const localHour = Number(clock().toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: farm.timezone }));
        if (localHour < hour || r.briefing(localDate(clock(), farm.timezone))) continue;
        await makeBriefing(r).catch((err) => console.error(`briefing farm ${id}:`, err));
      }
    },
  });
}
