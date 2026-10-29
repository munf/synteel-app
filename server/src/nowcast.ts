// Pond nowcast: between the farmer's measurements, estimate water temperature hour by
// hour from the weather, and turn it, together with what the farmer logged, into an
// oxygen risk score with the reasons behind it. Plain arithmetic, no language model:
// it runs every 30 minutes for every pond and has to keep working offline from the AI.
//
// All values are estimates, not measurements. The model re-anchors on every new
// temperature reading and learns a per-pond offset from how wrong it was before.
import { DAY_MS, type Log, type Phase, type Pond } from './domain.ts';
import { limitsFor, median, type Threshold } from './rules.ts';
import type { WeatherHour } from './weather.ts';

const HOUR_MS = 3600_000;

export type RiskLevel = 'ok' | 'warning' | 'critical';

export interface RiskFactor {
  id: string;
  label: string;
  points: number;
}

export interface NowcastPoint {
  t: number;
  temp: number | null; // estimated water temperature, °C
  sigma: number | null; // ±1 standard deviation, °C
  score: number;
  level: RiskLevel;
  factors: RiskFactor[];
}

export interface SuggestedCheck {
  t: number;
  kind: 'measure' | 'look';
  reason: string;
  /** Falls in sleeping hours: worth an alarm rather than a quiet reminder. */
  alarm: boolean;
}

export interface Nowcast {
  pondId: number;
  generatedAt: number;
  basis: {
    weather: boolean;
    anchor: { value: number; at: number } | null;
    calibrationPairs: number;
    offset: number;
    /** How far the calibrated model missed each recent reading (°C), oldest first. */
    fit: { t: number; error: number }[];
  };
  now: NowcastPoint;
  hours: NowcastPoint[]; // from 12 h ago to 24 h ahead, on the hour
  measurements: { t: number; value: number }[];
  peak: NowcastPoint; // highest risk in the next 24 h
  checks: SuggestedCheck[];
  lastCheckAt: number | null;
}

export interface NowcastInput {
  pond: Pond;
  phase?: Phase;
  density?: number;
  logs: Log[]; // newest first, at least the last 7 days
  weather: WeatherHour[]; // may be empty when the forecast is unavailable
  thresholds: Threshold[];
  now: number;
  timezone: string;
}

// ---------- water temperature ----------

interface ThermalParams {
  k: number; // fraction of the gap to equilibrium closed per hour
  solarGain: number; // °C above air temperature at 1000 W/m²
}

/**
 * Starting points, not fitted constants: a 30 cm outdoor pond follows the air with a
 * time constant of about 16 hours (concrete walls and the ground hold heat) and is
 * warmed by the sun; an indoor tank barely moves. Per-pond calibration absorbs most
 * of the remaining error.
 */
export function thermalParams(pond: Pond): ThermalParams {
  if (pond.setting === 'indoor') return { k: 0.04, solarGain: 0.3 };
  const depth = pond.depthCm ?? 30;
  return {
    k: Math.min(0.2, Math.max(0.02, (0.06 * 30) / depth)),
    solarGain: pond.shaded ? 1.5 : 3.5,
  };
}

function weatherAt(weather: Map<number, WeatherHour>, t: number): WeatherHour | undefined {
  return weather.get(Math.floor(t / HOUR_MS) * HOUR_MS);
}

/** Step the water temperature from (t0, temp0) to t1 through the hourly weather. */
export function simulate(weather: Map<number, WeatherHour>, p: ThermalParams, offset: number, t0: number, temp0: number, t1: number): number | null {
  let t = t0;
  let temp = temp0;
  while (t < t1) {
    const w = weatherAt(weather, t);
    if (!w) return null;
    const dt = Math.min(HOUR_MS, t1 - t) / HOUR_MS;
    const equilibrium = w.airTemp + (p.solarGain * w.radiation) / 1000 + offset;
    const k = p.k * (1 + w.wind / 80);
    temp += (equilibrium - temp) * (1 - Math.pow(1 - Math.min(k, 0.9), dt));
    t += dt * HOUR_MS;
  }
  return temp;
}

/**
 * Learn a constant offset on the equilibrium temperature from consecutive readings:
 * simulate each gap without offset and see how far off it lands.
 */
function calibrate(weather: Map<number, WeatherHour>, p: ThermalParams, readings: { t: number; value: number }[]) {
  const estimates: number[] = [];
  const used: [{ t: number; value: number }, { t: number; value: number }][] = [];
  for (let i = 1; i < readings.length; i++) {
    const a = readings[i - 1];
    const b = readings[i];
    const gapH = (b.t - a.t) / HOUR_MS;
    if (gapH < 2 || gapH > 36) continue;
    const predicted = simulate(weather, p, 0, a.t, a.value, b.t);
    if (predicted === null) continue;
    // An offset on equilibrium moves the result by offset × (fraction of the gap closed).
    const reach = 1 - Math.pow(1 - p.k, gapH);
    if (reach < 0.2) continue;
    estimates.push((b.value - predicted) / reach);
    used.push([a, b]);
  }
  const offset = estimates.length ? Math.max(-4, Math.min(4, median(estimates))) : 0;
  const fit = used.slice(-7).map(([a, b]) => ({ t: b.t, error: Math.round((b.value - (simulate(weather, p, offset, a.t, a.value, b.t) ?? b.value)) * 10) / 10 }));
  return { offset, pairs: estimates.length, fit };
}

// ---------- local time ----------

function localParts(t: number, timezone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(t))
      .map((x) => [x.type, x.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) };
}

/** Epoch ms of a farm-local wall-clock time. */
function localTime(date: string, hhmm: string, timezone: string): number {
  const guess = Date.parse(`${date}T${hhmm}:00Z`);
  const p = localParts(guess, timezone);
  const shown = Date.parse(`${p.date}T${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:00Z`);
  return guess - (shown - guess);
}

const isNight = (hour: number) => hour >= 19 || hour < 6;
const isSleeping = (hour: number) => hour >= 22 || hour < 5;

// ---------- risk ----------

const fmt = (n: number) => n.toLocaleString('id-ID', { maximumFractionDigits: 1 });

export function riskLevel(score: number): RiskLevel {
  return score >= 5 ? 'critical' : score >= 3 ? 'warning' : 'ok';
}

export function computeNowcast(input: NowcastInput): Nowcast {
  const { pond, phase, density, logs, thresholds, now, timezone } = input;
  const weather = new Map(input.weather.map((w) => [w.t, w]));
  const params = thermalParams(pond);
  const outdoor = pond.setting !== 'indoor';

  const readings = logs
    .filter((l) => l.data.readings?.temperature !== undefined)
    .map((l) => ({ t: Date.parse(l.loggedAt), value: l.data.readings!.temperature! }))
    .filter((r) => r.t <= now)
    .sort((a, b) => a.t - b.t);
  const { offset, pairs, fit } = calibrate(weather, params, readings);
  const calibrated = pairs >= 2;

  function estimate(t: number): { temp: number | null; sigma: number | null } {
    const anchor = [...readings].reverse().find((r) => r.t <= t && t - r.t <= 2 * DAY_MS);
    if (anchor) {
      const hours = (t - anchor.t) / HOUR_MS;
      const temp = weather.size ? simulate(weather, params, offset, anchor.t, anchor.value, t) : null;
      const growth = Math.sqrt(hours);
      if (temp !== null) return { temp, sigma: (calibrated ? 0.3 : 0.6) + (calibrated ? 0.2 : 0.35) * growth };
      // No forecast: assume the water stayed where it was, with fast-growing doubt.
      return { temp: anchor.value, sigma: 0.5 + 0.5 * growth };
    }
    // No recent reading: spin the model up from the weather alone.
    const start = t - 2 * DAY_MS;
    const w = weatherAt(weather, start);
    if (!w) return { temp: null, sigma: null };
    const temp = simulate(weather, params, offset, start, w.airTemp + offset, t);
    return { temp, sigma: temp === null ? null : 2 };
  }

  // What the farmer logged that matters for oxygen.
  const within = (ms: number, at: number) => logs.filter((l) => Date.parse(l.loggedAt) <= at && at - Date.parse(l.loggedAt) <= ms);
  const tempLimits = thresholds.find((t) => t.id === 'temperature');
  const limits = tempLimits ? limitsFor(tempLimits, phase) : null;
  const logTimes = logs.map((l) => Date.parse(l.loggedAt)).filter((t) => t <= now);
  const lastCheckAt = logTimes.length ? Math.max(...logTimes) : null;

  function daylightCloud(t: number): number | null {
    const { date } = localParts(t, timezone);
    const values: number[] = [];
    for (let h = 9; h <= 15; h++) {
      const w = weatherAt(weather, localTime(date, `${String(h).padStart(2, '0')}:00`, timezone));
      if (w) values.push(w.cloud);
    }
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  }

  function point(t: number): NowcastPoint {
    const { temp, sigma } = estimate(t);
    const { hour } = localParts(t, timezone);
    const factors: RiskFactor[] = [];
    // Only what was known at time t (for past hours) or now (for future hours).
    const known = Math.min(t, now);

    if (temp !== null && limits) {
      const crit = limits.critical?.above;
      const warn = limits.warning?.above;
      if (crit !== undefined && temp > crit) factors.push({ id: 'temp', label: `Air diperkirakan ${fmt(temp)} °C, oksigen terlarut turun`, points: 3 });
      else if (warn !== undefined && temp > warn) factors.push({ id: 'temp', label: `Air diperkirakan agak panas (${fmt(temp)} °C)`, points: 2 });
    }

    const recent = within(DAY_MS, known);
    const signs = new Set(recent.flatMap((l) => l.data.behavior ?? []));
    if (signs.has('surfacing') || signs.has('gathering_inlet')) {
      factors.push({ id: 'signs', label: 'Sidat terlihat naik ke permukaan atau berkumpul di air masuk', points: 3 });
    }

    const lastAeration = recent.find((l) => l.data.aeration)?.data.aeration;
    if (lastAeration === 'off') factors.push({ id: 'aeration_off', label: 'Aerator dilaporkan mati', points: 5 });
    else if (lastAeration === 'weak') factors.push({ id: 'aeration_weak', label: 'Aerasi dilaporkan lemah', points: 2 });
    if (pond.aeration === 'none') factors.push({ id: 'no_aeration', label: 'Kolam tanpa aerasi', points: 2 });
    else if (pond.aeration === 'partial' && isNight(hour)) factors.push({ id: 'partial_aeration', label: 'Aerasi tidak 24 jam', points: 1 });

    const green = within(3 * DAY_MS, known).find((l) => l.data.water?.color)?.data.water?.color === 'green';
    if (outdoor && green && isNight(hour)) factors.push({ id: 'algae_night', label: 'Malam hari: alga di air hijau ikut memakai oksigen', points: 1 });
    if (outdoor && green && (daylightCloud(t) ?? 0) > 80) factors.push({ id: 'cloudy', label: 'Hari mendung: alga menghasilkan sedikit oksigen', points: 1 });

    if (phase === 'elver' && density !== undefined) {
      if (density > 100) factors.push({ id: 'density', label: `Kolam padat (±${Math.round(density)} ekor/m²)`, points: 2 });
      else if (density > 60) factors.push({ id: 'density', label: `Kepadatan di atas ideal (±${Math.round(density)} ekor/m²)`, points: 1 });
    }

    if (within(2 * DAY_MS, known).some((l) => l.data.feeding?.leftover === 'much')) {
      factors.push({ id: 'leftover', label: 'Sisa pakan banyak membusuk dan memakai oksigen', points: 1 });
    }

    const rain = [0, 1, 2].reduce((sum, back) => sum + (weatherAt(weather, t - back * HOUR_MS)?.rain ?? 0), 0);
    if (outdoor && rain >= 10) factors.push({ id: 'rain', label: `Hujan deras (${fmt(rain)} mm/3 jam): pH dan TDS bisa berubah`, points: 1 });

    // Nobody has looked for a long time: problems go unnoticed. This is what kills batches.
    if (lastCheckAt !== null && t >= lastCheckAt) {
      const gapH = (t - lastCheckAt) / HOUR_MS;
      if (gapH >= 12) factors.push({ id: 'unwatched', label: `Belum dicek ${Math.floor(gapH)} jam`, points: 1 });
    }

    factors.sort((a, b) => b.points - a.points);
    const score = factors.reduce((sum, f) => sum + f.points, 0);
    return { t, temp: temp === null ? null : round1(temp), sigma: sigma === null ? null : round1(sigma), score, level: riskLevel(score), factors };
  }

  const firstHour = Math.ceil((now - 12 * HOUR_MS) / HOUR_MS) * HOUR_MS;
  const hours: NowcastPoint[] = [];
  for (let t = firstHour; t <= now + 24 * HOUR_MS; t += HOUR_MS) hours.push(point(t));
  const nowPoint = point(now);
  const ahead = hours.filter((h) => h.t > now);
  const peak = ahead.reduce((best, h) => (h.score > best.score ? h : best), nowPoint);
  const anchor = readings.at(-1);

  return {
    pondId: pond.id,
    generatedAt: now,
    basis: {
      weather: weather.size > 0,
      anchor: anchor && now - anchor.t <= 2 * DAY_MS ? { value: anchor.value, at: anchor.t } : null,
      calibrationPairs: pairs,
      offset: round1(offset),
      fit,
    },
    now: nowPoint,
    hours,
    measurements: readings.filter((r) => r.t >= firstHour),
    peak,
    checks: suggestChecks(ahead, now, timezone),
    lastCheckAt,
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

// ---------- checks ----------

// A daily routine built from the Blueprint daily SOP and the partner farm's practice.
const ROUTINE: { at: string; kind: SuggestedCheck['kind']; reason: string }[] = [
  { at: '06:30', kind: 'measure', reason: 'Ukur suhu, pH, TDS dan amati sidat' },
  { at: '12:00', kind: 'look', reason: 'Lihat perilaku sidat dan aerator' },
  { at: '17:00', kind: 'measure', reason: 'Ukur suhu, pH, TDS dan buang sisa pakan' },
  { at: '21:00', kind: 'look', reason: 'Pastikan aerator nyala sebelum tidur' },
];

export function suggestChecks(ahead: NowcastPoint[], now: number, timezone: string): SuggestedCheck[] {
  const checks: SuggestedCheck[] = [];
  const end = now + 24 * HOUR_MS;

  const riskCheck = (h: NowcastPoint, t: number): SuggestedCheck => ({
    t,
    kind: 'look',
    reason: `Risiko ${h.level === 'critical' ? 'tinggi' : 'naik'}: ${h.factors[0] ? h.factors[0].label[0].toLowerCase() + h.factors[0].label.slice(1) : 'beberapa faktor'}`,
    alarm: isSleeping(localParts(t, timezone).hour),
  });

  // Each stretch of raised risk gets a check half an hour before it starts. If the
  // stretch runs into sleeping hours, it also gets a night check at its worst hour
  // there: that is when nobody would otherwise look.
  for (let i = 0; i < ahead.length; i++) {
    if (ahead[i].level === 'ok' || (i > 0 && ahead[i - 1].level !== 'ok')) continue;
    let j = i;
    while (j + 1 < ahead.length && ahead[j + 1].level !== 'ok') j++;
    const block = ahead.slice(i, j + 1);
    const start = Math.max(now + 5 * 60_000, block[0].t - 30 * 60_000);
    checks.push(riskCheck(block[0], start));
    const night = block.filter((h) => isSleeping(localParts(h.t, timezone).hour));
    if (night.length) {
      // Latest of the worst hours: risk before dawn is the classic one.
      const worst = night.reduce((a, b) => (b.score >= a.score ? b : a));
      const t = worst.t - 30 * 60_000;
      if (t - start >= 3 * HOUR_MS) checks.push(riskCheck(worst, t));
    }
  }

  const today = localParts(now, timezone).date;
  const tomorrow = localParts(now + DAY_MS, timezone).date;
  for (const date of [today, tomorrow]) {
    for (const r of ROUTINE) {
      const t = localTime(date, r.at, timezone);
      if (t <= now || t > end) continue;
      if (checks.some((c) => Math.abs(c.t - t) < 90 * 60_000)) continue;
      checks.push({ t, kind: r.kind, reason: r.reason, alarm: false });
    }
  }
  return checks.sort((a, b) => a.t - b.t);
}
