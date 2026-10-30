// Pond nowcast: between the farmer's measurements, estimate water temperature hour by
// hour from the weather, and turn it, together with what the farmer logged, into an
// oxygen risk score with the reasons behind it. Plain arithmetic, no language model:
// it runs every 30 minutes for every pond and has to keep working offline from the AI.
//
// All values are estimates, not measurements. The model re-anchors on every new
// temperature reading and learns a per-pond offset from how wrong it was before.
import { dec, tx } from './i18n.ts';
import { DAY_MS, type Log, type Phase, type Pond } from './domain.ts';
import { limitsFor, type Threshold } from './rules.ts';
import type { WeatherHour } from './weather.ts';
import { learn, prior, sigmaAt, simulate as thermalSimulate, weatherAt, type ThermalModel, type ThermalParams, type Reading } from './thermal.ts';

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
    /** What the pond taught the water temperature model, and how far off it usually is (thermal.ts). */
    thermal?: ThermalModel;
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
  /** The pond's model learned from its longer history (api.ts); learned here from `logs` when absent. */
  thermal?: ThermalModel;
  thresholds: Threshold[];
  now: number;
  timezone: string;
}

// ---------- water temperature ----------
// The model itself lives in thermal.ts: profile priors, learning per pond, the rolling backtest.

/** Starting values for a pond (kept for the demo seed and older callers). */
export function thermalParams(pond: Pond): ThermalParams {
  return prior(pond).params;
}

/** Step the water temperature from (t0, temp0) to t1 through the hourly weather, with an extra offset. */
export function simulate(weather: Map<number, WeatherHour>, p: ThermalParams, offset: number, t0: number, temp0: number, t1: number): number | null {
  return thermalSimulate(weather, { ...p, offset: p.offset + offset }, t0, temp0, t1);
}

/**
 * Temperature readings of a pond for the model. Notebook rows without a written time were saved
 * at 12:00 farm time: their time of day is not known, so they teach the model only a little and
 * are never scored.
 */
export function thermalReadings(logs: Log[], timezone: string, now = Infinity): Reading[] {
  return logs
    .filter((l) => l.data.readings?.temperature !== undefined)
    .map((l) => {
      const t = Date.parse(l.loggedAt);
      const old = l.source === 'notebook';
      const p = old ? localParts(t, timezone) : null;
      return { t, value: l.data.readings!.temperature!, ...(old && { old: true }), ...(p && p.hour === 12 && p.minute === 0 && { timeUnsure: true }) };
    })
    .filter((r) => r.t <= now)
    .sort((a, b) => a.t - b.t);
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

const fmt = (n: number) => dec(n, 1);

export function riskLevel(score: number): RiskLevel {
  return score >= 5 ? 'critical' : score >= 3 ? 'warning' : 'ok';
}

export function computeNowcast(input: NowcastInput): Nowcast {
  const { pond, phase, density, logs, thresholds, now, timezone } = input;
  const weather = new Map(input.weather.map((w) => [w.t, w]));
  const outdoor = pond.setting !== 'indoor';

  const readings = thermalReadings(logs, timezone, now);
  const model = input.thermal ?? learn(weather, pond, readings, timezone);
  const params = model.params;

  function estimate(t: number): { temp: number | null; sigma: number | null } {
    const anchor = [...readings].reverse().find((r) => r.t <= t && t - r.t <= 2 * DAY_MS);
    if (anchor) {
      const hours = (t - anchor.t) / HOUR_MS;
      const temp = weather.size ? thermalSimulate(weather, params, anchor.t, anchor.value, t) : null;
      // The spread comes from how far this pond's own readings were missed before.
      if (temp !== null) return { temp, sigma: sigmaAt(model, hours) };
      // No forecast: assume the water stayed where it was, with fast-growing doubt.
      return { temp: anchor.value, sigma: 0.5 + 0.5 * Math.sqrt(hours) };
    }
    // No recent reading: spin the model up from the weather alone.
    const start = t - 2 * DAY_MS;
    const w = weatherAt(weather, start);
    if (!w) return { temp: null, sigma: null };
    const temp = thermalSimulate(weather, params, start, w.airTemp + params.offset, t);
    return { temp, sigma: temp === null ? null : Math.max(1.5, (2 * model.typicalError) / 1.28) };
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
      if (crit !== undefined && temp > crit) factors.push({ id: 'temp', label: tx(`Air diperkirakan ${fmt(temp)} °C, oksigen terlarut turun`, `Water estimated at ${fmt(temp)} °C, dissolved oxygen drops`), points: 3 });
      else if (warn !== undefined && temp > warn) factors.push({ id: 'temp', label: tx(`Air diperkirakan agak panas (${fmt(temp)} °C)`, `Water estimated a bit hot (${fmt(temp)} °C)`), points: 2 });
    }

    const recent = within(DAY_MS, known);
    const signs = new Set(recent.flatMap((l) => l.data.behavior ?? []));
    if (signs.has('surfacing') || signs.has('gathering_inlet')) {
      factors.push({ id: 'signs', label: tx('Sidat terlihat naik ke permukaan atau berkumpul di air masuk', 'Eels seen rising to the surface or crowding at the water inlet'), points: 3 });
    }

    const lastAeration = recent.find((l) => l.data.aeration)?.data.aeration;
    if (lastAeration === 'off') factors.push({ id: 'aeration_off', label: tx('Aerator dilaporkan mati', 'Aerator reported off'), points: 5 });
    else if (lastAeration === 'weak') factors.push({ id: 'aeration_weak', label: tx('Aerasi dilaporkan lemah', 'Aeration reported weak'), points: 2 });
    if (pond.aeration === 'none') factors.push({ id: 'no_aeration', label: tx('Kolam tanpa aerasi', 'Pond without aeration'), points: 2 });
    else if (pond.aeration === 'partial' && isNight(hour)) factors.push({ id: 'partial_aeration', label: tx('Aerasi tidak 24 jam', 'Aeration not on 24 hours'), points: 1 });

    const green = within(3 * DAY_MS, known).find((l) => l.data.water?.color)?.data.water?.color === 'green';
    if (outdoor && green && isNight(hour)) factors.push({ id: 'algae_night', label: tx('Malam hari: alga di air hijau ikut memakai oksigen', 'Night: algae in green water also use oxygen'), points: 1 });
    if (outdoor && green && (daylightCloud(t) ?? 0) > 80) factors.push({ id: 'cloudy', label: tx('Hari mendung: alga menghasilkan sedikit oksigen', 'Cloudy day: algae make little oxygen'), points: 1 });

    if (phase === 'elver' && density !== undefined) {
      if (density > 100) factors.push({ id: 'density', label: tx(`Kolam padat (±${Math.round(density)} ekor/m²)`, `Crowded pond (about ${Math.round(density)} eels/m²)`), points: 2 });
      else if (density > 60) factors.push({ id: 'density', label: tx(`Kepadatan di atas ideal (±${Math.round(density)} ekor/m²)`, `More crowded than ideal (about ${Math.round(density)} eels/m²)`), points: 1 });
    }

    if (within(2 * DAY_MS, known).some((l) => l.data.feeding?.leftover === 'much')) {
      factors.push({ id: 'leftover', label: tx('Sisa pakan banyak membusuk dan memakai oksigen', 'Lots of leftover feed rotting and using oxygen'), points: 1 });
    }

    const rain = [0, 1, 2].reduce((sum, back) => sum + (weatherAt(weather, t - back * HOUR_MS)?.rain ?? 0), 0);
    if (outdoor && rain >= 10) factors.push({ id: 'rain', label: tx(`Hujan deras (${fmt(rain)} mm/3 jam): pH dan TDS bisa berubah`, `Heavy rain (${fmt(rain)} mm in 3 hours): pH and TDS can change`), points: 1 });

    // Nobody has looked for a long time: problems go unnoticed. This is what kills batches.
    if (lastCheckAt !== null && t >= lastCheckAt) {
      const gapH = (t - lastCheckAt) / HOUR_MS;
      if (gapH >= 12) factors.push({ id: 'unwatched', label: tx(`Belum dicek ${Math.floor(gapH)} jam`, `Not checked for ${Math.floor(gapH)} hours`), points: 1 });
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
      calibrationPairs: model.readings,
      offset: round1(params.offset),
      fit: model.recent,
      thermal: model,
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
const ROUTINE: { at: string; kind: SuggestedCheck['kind']; reason: () => string }[] = [
  { at: '06:30', kind: 'measure', reason: () => tx('Ukur suhu, pH, TDS dan amati sidat', 'Measure temperature, pH, TDS and watch the eels') },
  { at: '12:00', kind: 'look', reason: () => tx('Lihat perilaku sidat dan aerator', 'Look at how the eels behave and at the aerator') },
  { at: '17:00', kind: 'measure', reason: () => tx('Ukur suhu, pH, TDS dan buang sisa pakan', 'Measure temperature, pH, TDS and remove leftover feed') },
  { at: '21:00', kind: 'look', reason: () => tx('Pastikan aerator nyala sebelum tidur', 'Make sure the aerator is on before bed') },
];

export function suggestChecks(ahead: NowcastPoint[], now: number, timezone: string): SuggestedCheck[] {
  const checks: SuggestedCheck[] = [];
  const end = now + 24 * HOUR_MS;

  const riskCheck = (h: NowcastPoint, t: number): SuggestedCheck => ({
    t,
    kind: 'look',
    reason: tx(
      `Risiko ${h.level === 'critical' ? 'tinggi' : 'naik'}: ${h.factors[0] ? h.factors[0].label[0].toLowerCase() + h.factors[0].label.slice(1) : 'beberapa faktor'}`,
      `Risk ${h.level === 'critical' ? 'high' : 'rising'}: ${h.factors[0] ? h.factors[0].label[0].toLowerCase() + h.factors[0].label.slice(1) : 'several factors'}`,
    ),
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
      checks.push({ t, kind: r.kind, reason: r.reason(), alarm: false });
    }
  }
  return checks.sort((a, b) => a.t - b.t);
}
