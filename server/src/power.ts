// "Malam rawan listrik padam": how likely the power is to go out tonight, from two forecasts.
// Aerators that stop when the power goes out at night are a major cause of mass eel deaths, so a
// stormy night gets its own label, its own preparation checks and, when the pond's oxygen risk is
// already raised, a higher danger for that pond. Deterministic: no language model involved.
//
// Sources, cross-checked:
//   - Open-Meteo hourly: weather_code (WMO 95/96/99 thunderstorm), cape, wind_gusts_10m, precipitation;
//   - BMKG village forecast (bmkg.ts): 3-hour steps, thunder as "Hujan Petir".
// Kept apart from the oxygen score in nowcast.ts: applyPower() adds its factor afterwards.
import { tx } from './i18n.ts';
import { clock, HEAVY_RAIN_MM } from './agentloop.ts';
import { isBmkgHeavyRain, isBmkgThunder, type BmkgStep } from './bmkg.ts';
import { riskLevel, suggestChecks, type Nowcast, type NowcastPoint, type RiskFactor, type SuggestedCheck } from './nowcast.ts';
import type { Pond } from './domain.ts';

const HOUR = 3600_000;

// ---------- thresholds ----------

/** WMO weather interpretation codes (table 4677, as Open-Meteo returns them): 95 thunderstorm, 96/99 with hail. */
export const OPEN_METEO_THUNDER_CODES = [95, 96, 99];
/**
 * Gusts that bring down branches and power lines. BMKG's extreme-weather criterion for strong wind is
 * 25 knots (about 45 km/h); Beaufort 7 (50–61 km/h) is "whole trees in motion".
 */
export const STRONG_GUST_KMH = 45;
/** Heavy rain per hour, the same band the agents' rain words follow (agentloop.ts): above 7.6 mm/hour. */
export const HEAVY_RAIN_MM_PER_HOUR = HEAVY_RAIN_MM;
/**
 * Convective available potential energy, J/kg. Forecasters read 1000–2500 as moderate and above 2500 as strong
 * instability (thunderstorms form easily). Tropical nights often sit at 1000–2000, so only the strong band counts,
 * and only as a supporting sign.
 */
export const UNSTABLE_CAPE = 2500;

/** Points per sign. A thunderstorm forecast is the main sign; each source counts on its own. */
export const POINTS = { thunder: 2, gust: 2, heavyRain: 1, unstable: 1 } as const;
/** Two independent strong signs (both sources forecast thunder, or thunder and strong gusts) make a risky night. */
export const HIGH_AT = 4;
/** One strong sign (one source's thunder, or strong gusts) or two supporting ones: worth preparing for. */
export const MEDIUM_AT = 2;
/** Tonight, in farm time. */
export const NIGHT_FROM_HOUR = 17;
export const NIGHT_TO_HOUR = 6;
/** Extra oxygen-risk points when the night is risky and the pond is already at Perhatian or worse. */
export const COMBINED_POINTS = { none: 2, backup: 1 } as const;
/** While the power is out: points for ponds with aerators (as "aerator off" in nowcast.ts), less with a backup. */
export const OUTAGE_POINTS = { none: 5, backup: 3 } as const;
/** An outage nobody closed is not counted after this long. */
export const OUTAGE_STALE_MS = 24 * HOUR;

export type PowerLevel = 'low' | 'medium' | 'high';
export type PowerBackup = 'genset' | 'battery' | 'none';
export const POWER_BACKUPS: PowerBackup[] = ['genset', 'battery', 'none'];

/** The power backup in words, as the farmer chose it in Profil ("Cadangan listrik"). */
export function powerBackupLabel(backup: PowerBackup | null): string {
  if (backup === 'genset') return tx('Genset', 'Generator');
  if (backup === 'battery') return tx('Aki atau baterai cadangan', 'Battery backup');
  if (backup === 'none') return tx('Tidak ada', 'None');
  return tx('Belum diisi', 'Not set');
}

export interface StormHour {
  t: number;
  code: number | null;
  cape: number | null;
  gusts: number | null; // km/h
  rain: number; // mm in this hour
}

export interface PowerReason {
  id: 'thunder' | 'gust' | 'heavy_rain' | 'unstable';
  source: 'bmkg' | 'open-meteo';
  from: number;
  to: number;
  points: number;
  text: string;
}

export interface Outage {
  id: number;
  startedAt: string;
  endedAt: string | null;
  startedBy: number | null;
  endedBy: number | null;
}

export interface PowerCheck extends SuggestedCheck {
  why?: string;
}

export interface PowerNight {
  level: PowerLevel;
  points: number;
  /** Tonight's window in farm time (17.00–06.00, or from now when the night has begun). */
  from: number;
  to: number;
  reasons: PowerReason[];
  /** Which forecasts were there to compare. */
  sources: { openMeteo: boolean; bmkg: boolean };
  /** Thunder tonight in each source, and whether they disagree (only when both are there). */
  thunder: { openMeteo: boolean; bmkg: boolean; disagree: boolean };
  /** One plain sentence when the two sources disagree, or when BMKG is missing. */
  note: string | null;
  backup: PowerBackup | null;
  /** The power cut being recorded right now, if any. */
  outage: Outage | null;
  /** Preparation checks for tonight (added to every pond with aerators). */
  checks: PowerCheck[];
}

// ---------- fetching (Open-Meteo storm signs) ----------

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const TTL_MS = 30 * 60 * 1000;
const cache = new Map<string, { hours: StormHour[]; fetchedAt: number }>();

/** Storm signs per hour for yesterday to tomorrow. Cached for 30 minutes per location. */
export async function getStormHours(lat: number, lon: number, now = Date.now()): Promise<StormHour[]> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit && now - hit.fetchedAt < TTL_MS) return hit.hours;
  const url = new URL(FORECAST_URL);
  url.search = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: 'weather_code,cape,wind_gusts_10m,precipitation',
    past_days: '1',
    forecast_days: '2',
    timezone: 'UTC',
  }).toString();
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const h = (await res.json()).hourly;
  const hours: StormHour[] = h.time.map((time: string, i: number) => ({
    t: Date.parse(`${time}:00Z`),
    code: h.weather_code?.[i] ?? null,
    cape: h.cape?.[i] ?? null,
    gusts: h.wind_gusts_10m?.[i] ?? null,
    rain: h.precipitation?.[i] ?? 0,
  }));
  cache.set(key, { hours, fetchedAt: now });
  return hours;
}

export type GetStorm = typeof getStormHours;

// ---------- farm time ----------

function localParts(t: number, timezone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(t))
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}

/** Epoch ms of a farm-local wall-clock hour on a date. */
function localTime(date: string, hour: number, timezone: string): number {
  const guess = Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00Z`);
  const p = localParts(guess, timezone);
  const shown = Date.parse(`${p.date}T${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:00Z`);
  return guess - (shown - guess);
}

/** Tonight: 17.00 to 06.00 farm time; once the night has begun, from now until 06.00. */
export function tonight(now: number, timezone: string): { from: number; to: number; evening: number } {
  const { date, hour } = localParts(now, timezone);
  if (hour < NIGHT_TO_HOUR) {
    const to = localTime(date, NIGHT_TO_HOUR, timezone);
    return { from: now, to, evening: to - (24 - NIGHT_FROM_HOUR + NIGHT_TO_HOUR) * HOUR };
  }
  const evening = localTime(date, NIGHT_FROM_HOUR, timezone);
  const to = evening + (24 - NIGHT_FROM_HOUR + NIGHT_TO_HOUR) * HOUR;
  return { from: Math.max(evening, now), to, evening };
}

const isSleeping = (t: number, tz: string) => {
  const h = localParts(t, tz).hour;
  return h >= 22 || h < 5;
};

// ---------- tonight's assessment ----------

const span = (from: number, to: number, tz: string) => (from === to ? clock(from, tz) : `${clock(from, tz)}–${clock(to, tz)}`);
const dec1 = (n: number) => tx(String(Math.round(n * 10) / 10).replace('.', ','), String(Math.round(n * 10) / 10));

export interface PowerInput {
  storm: StormHour[];
  /** BMKG steps for the farm's village; null when BMKG was not available. */
  bmkg: BmkgStep[] | null;
  now: number;
  timezone: string;
  backup: PowerBackup | null;
  outage?: Outage | null;
}

export function assessPowerNight({ storm, bmkg, now, timezone: tz, backup, outage = null }: PowerInput): PowerNight {
  const { from, to, evening } = tonight(now, tz);
  // Hours that overlap the window; a BMKG step stands for about 1.5 hours either side of its time.
  const hours = storm.filter((h) => h.t + HOUR > from && h.t < to);
  const steps = (bmkg ?? []).filter((s) => s.t + 1.5 * HOUR > from && s.t - 1.5 * HOUR < to);
  const reasons: PowerReason[] = [];

  const omThunder = hours.filter((h) => h.code !== null && OPEN_METEO_THUNDER_CODES.includes(h.code));
  if (omThunder.length) {
    const a = omThunder[0].t;
    const b = omThunder.at(-1)!.t;
    reasons.push({ id: 'thunder', source: 'open-meteo', from: a, to: b, points: POINTS.thunder, text: tx(`Open-Meteo: badai petir jam ${span(a, b, tz)}`, `Open-Meteo: thunderstorm ${span(a, b, tz)}`) });
  }
  const bmkgThunder = steps.filter(isBmkgThunder);
  if (bmkgThunder.length) {
    const times = bmkgThunder.map((s) => clock(s.t, tz)).join(', ');
    reasons.push({ id: 'thunder', source: 'bmkg', from: bmkgThunder[0].t, to: bmkgThunder.at(-1)!.t, points: POINTS.thunder, text: tx(`BMKG: hujan petir sekitar jam ${times}`, `BMKG: thunderstorm around ${times}`) });
  }

  // Strong gusts: either source, counted once (Open-Meteo gusts first; BMKG gives mean wind only).
  const gust = hours.filter((h) => (h.gusts ?? 0) >= STRONG_GUST_KMH).sort((a, b) => (b.gusts ?? 0) - (a.gusts ?? 0))[0];
  const bmkgWind = steps.filter((s) => s.wind >= STRONG_GUST_KMH).sort((a, b) => b.wind - a.wind)[0];
  if (gust) reasons.push({ id: 'gust', source: 'open-meteo', from: gust.t, to: gust.t, points: POINTS.gust, text: tx(`Open-Meteo: angin kencang sampai ${Math.round(gust.gusts!)} km/jam jam ${clock(gust.t, tz)}`, `Open-Meteo: strong gusts up to ${Math.round(gust.gusts!)} km/h at ${clock(gust.t, tz)}`) });
  else if (bmkgWind) reasons.push({ id: 'gust', source: 'bmkg', from: bmkgWind.t, to: bmkgWind.t, points: POINTS.gust, text: tx(`BMKG: angin kencang ${Math.round(bmkgWind.wind)} km/jam sekitar jam ${clock(bmkgWind.t, tz)}`, `BMKG: strong wind ${Math.round(bmkgWind.wind)} km/h around ${clock(bmkgWind.t, tz)}`) });

  // Heavy rain: counted once.
  const heavy = hours.filter((h) => h.rain > HEAVY_RAIN_MM_PER_HOUR).sort((a, b) => b.rain - a.rain)[0];
  const bmkgHeavy = steps.find((s) => isBmkgHeavyRain(s) || s.rain / 3 > HEAVY_RAIN_MM_PER_HOUR);
  if (heavy) reasons.push({ id: 'heavy_rain', source: 'open-meteo', from: heavy.t, to: heavy.t, points: POINTS.heavyRain, text: tx(`Open-Meteo: hujan deras ${dec1(heavy.rain)} mm/jam jam ${clock(heavy.t, tz)}`, `Open-Meteo: heavy rain ${dec1(heavy.rain)} mm/hour at ${clock(heavy.t, tz)}`) });
  else if (bmkgHeavy) reasons.push({ id: 'heavy_rain', source: 'bmkg', from: bmkgHeavy.t, to: bmkgHeavy.t, points: POINTS.heavyRain, text: tx(`BMKG: hujan lebat sekitar jam ${clock(bmkgHeavy.t, tz)}`, `BMKG: heavy rain around ${clock(bmkgHeavy.t, tz)}`) });

  const unstable = hours.filter((h) => (h.cape ?? 0) >= UNSTABLE_CAPE).sort((a, b) => (b.cape ?? 0) - (a.cape ?? 0))[0];
  if (unstable) reasons.push({ id: 'unstable', source: 'open-meteo', from: unstable.t, to: unstable.t, points: POINTS.unstable, text: tx('Open-Meteo: udara sangat labil, awan badai mudah terbentuk', 'Open-Meteo: very unstable air, storm clouds form easily') });

  const points = reasons.reduce((s, r) => s + r.points, 0);
  const level: PowerLevel = points >= HIGH_AT ? 'high' : points >= MEDIUM_AT ? 'medium' : 'low';
  const sources = { openMeteo: hours.length > 0, bmkg: steps.length > 0 };
  const thunder = { openMeteo: omThunder.length > 0, bmkg: bmkgThunder.length > 0, disagree: sources.openMeteo && sources.bmkg && omThunder.length > 0 !== bmkgThunder.length > 0 };
  const note = thunder.disagree
    ? thunder.bmkg
      ? tx('BMKG memperkirakan petir, Open-Meteo tidak. Lebih aman bersiap.', 'BMKG forecasts thunder, Open-Meteo does not. Safer to prepare.')
      : tx('Open-Meteo memperkirakan petir, BMKG tidak. Lebih aman bersiap.', 'Open-Meteo forecasts thunder, BMKG does not. Safer to prepare.')
    : !sources.bmkg
      ? tx('Prakiraan BMKG belum termuat; hanya dari Open-Meteo.', 'The BMKG forecast has not loaded; from Open-Meteo only.')
      : null;

  const active = outage && !outage.endedAt && now - Date.parse(outage.startedAt) < OUTAGE_STALE_MS ? outage : null;
  return { level, points, from, to, reasons, sources, thunder, note, backup, outage: active, checks: level === 'low' ? [] : prepChecks(level, backup, reasons, { from, to, evening }, now, tz) };
}

/** Rule-made preparation: 17.00 genset or battery, or with no backup less feed and someone to watch the aerator. */
function prepChecks(level: PowerLevel, backup: PowerBackup | null, reasons: PowerReason[], night: { from: number; to: number; evening: number }, now: number, tz: string): PowerCheck[] {
  if (now >= night.to) return [];
  const prepAt = night.evening >= now ? night.evening : now + 5 * 60_000;
  const why = level === 'high' ? tx('Malam rawan listrik padam', 'Night at risk of a power cut') : tx('Listrik mungkin padam malam ini', 'The power may go out tonight');
  const because = `${why}: ${reasons.map((r) => r.text).join('; ')}`;
  const check = (t: number, reason: string, alarm = false): PowerCheck => ({ t, kind: 'look', reason, alarm, why: because });
  const checks: PowerCheck[] = [];
  if (backup === 'genset') checks.push(check(prepAt, tx('Siapkan genset dan bahan bakar', 'Get the generator and fuel ready')));
  else if (backup === 'battery') checks.push(check(prepAt, tx('Pastikan aki atau baterai cadangan terisi penuh', 'Make sure the battery backup is fully charged')));
  else {
    if (level === 'high') checks.push(check(prepAt, tx('Kurangi pakan malam ini supaya sisa pakan tidak memakai oksigen', 'Feed less tonight so leftover feed does not use up oxygen')));
    checks.push(check(prepAt, tx('Tentukan siapa yang bangun cek aerator kalau listrik padam', 'Decide who gets up to check the aerator if the power goes out')));
  }
  // The stormiest hour in sleeping time: someone looks at the aerator then.
  if (level === 'high') {
    const storm = reasons.filter((r) => r.id === 'thunder' || r.id === 'gust').map((r) => r.from).filter((t) => t > now && t < night.to);
    const at = storm.find((t) => isSleeping(t, tz)) ?? storm[0];
    if (at !== undefined && at - 30 * 60_000 > prepAt + HOUR) checks.push(check(at - 30 * 60_000, tx('Cek aerator masih nyala', 'Check the aerator is still running'), isSleeping(at, tz)));
  }
  return checks;
}

// ---------- the pond's danger ----------

const ON_POWER = (pond: Pond) => pond.aeration !== 'none';

/**
 * Adds the power factor to a pond's nowcast: while the power is out (recorded), and on a risky night for
 * hours that already carry an oxygen risk of Perhatian or more. Also adds tonight's preparation checks.
 * nowcast.ts stays as it is; levels, peak and checks are worked out again only when something changed.
 */
export function applyPower(nc: Nowcast, pond: Pond, power: PowerNight, now: number, timezone: string): Nowcast {
  if (!ON_POWER(pond)) return nc;
  const covered = power.backup === 'genset' || power.backup === 'battery';
  const outageStart = power.outage ? Date.parse(power.outage.startedAt) : null;
  let changed = false;

  const withPower = (p: NowcastPoint): NowcastPoint => {
    const extra: RiskFactor[] = [];
    if (outageStart !== null && p.t >= outageStart - HOUR && p.t <= now + 6 * HOUR) {
      extra.push({ id: 'power_out', label: tx(`Listrik padam sejak ${clock(outageStart, timezone)}: aerator bisa mati`, `Power out since ${clock(outageStart, timezone)}: the aerator may be off`), points: covered ? OUTAGE_POINTS.backup : OUTAGE_POINTS.none });
    } else if (power.level === 'high' && p.t >= power.from - HOUR && p.t < power.to && riskLevel(p.score) !== 'ok') {
      extra.push({ id: 'power_night', label: tx('Malam rawan listrik padam: aerator bisa mati', 'Night at risk of a power cut: the aerator could stop'), points: covered ? COMBINED_POINTS.backup : COMBINED_POINTS.none });
    }
    if (!extra.length) return p;
    changed = true;
    const factors = [...p.factors, ...extra].sort((a, b) => b.points - a.points);
    const score = factors.reduce((s, f) => s + f.points, 0);
    return { ...p, factors, score, level: riskLevel(score) };
  };

  const hours = nc.hours.map(withPower);
  const nowPoint = withPower(nc.now);
  let { peak, checks } = nc;
  if (changed) {
    const ahead = hours.filter((h) => h.t > now);
    peak = ahead.reduce((best, h) => (h.score > best.score ? h : best), nowPoint);
    checks = suggestChecks(ahead, now, timezone);
  }
  const prep = power.checks.filter((c) => !checks.some((x) => x.t === c.t && x.reason === c.reason));
  return { ...nc, hours, now: nowPoint, peak, checks: [...checks, ...prep].sort((a, b) => a.t - b.t) };
}
