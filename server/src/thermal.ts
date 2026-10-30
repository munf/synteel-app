// Water temperature model per pond: plain arithmetic, no language model, so it keeps working
// without AI. The pond's profile (container, indoor / roofed / open, depth, light, water color)
// gives the starting values; the farmer's own readings then teach each pond three numbers:
//
//   offset  how much warmer or cooler the pond runs than the weather alone says (°C)
//   k       how fast it follows the weather (fraction of the gap closed per hour)
//   sun     how much the sun warms it (°C above air at 1000 W/m² of sunshine)
//
// The water moves towards an equilibrium each hour:
//   equilibrium = air + offset + sun × radiation/1000 − evap × evaporation
//   evaporation = ½ × (air − wet-bulb temperature from humidity) + 10 × reference evaporation (mm/h)
// Evaporation cools open ponds most; its weight is a fixed prior per pond type, not learned
// (the readings cannot tell it apart from the offset).
//
// Learning: for each step of a small grid of k values, offset and sun enter the prediction
// linearly, so they come from a two-number ridge regression pulled towards the prior values.
// The k with the lowest penalised error wins. Few readings: the prior dominates; many: the data.
// The honest error comes from a rolling backtest: every reading is predicted from the one before
// it with only what was learned from earlier readings.
import type { Setting } from './domain.ts';
import type { WeatherHour } from './weather.ts';

const HOUR_MS = 3600_000;

export type WaterColor = 'clear' | 'green' | 'brown' | 'cloudy';
export type Light = 'bright' | 'dim' | 'dark';
/** indoor; roofed = outdoors under a roof or shade net; open = outdoors in the sun. */
export type Exposure = 'indoor' | 'roofed' | 'open' | 'unknown';

export interface ThermalProfile {
  kind: string | null;
  setting: Setting | null;
  shaded: boolean | null;
  depthCm: number | null;
  waterColor?: WaterColor | null;
  light?: Light | null;
}

export interface ThermalParams {
  k: number;
  sun: number;
  offset: number;
  evap: number;
  /** Wind stirs open water: k × (1 + windK × km/h). */
  windK: number;
}

export interface Prior {
  exposure: Exposure;
  params: ThermalParams;
  sd: { offset: number; sun: number; logK: number };
  /** "Usually off by" (80% of misses smaller) before the pond has taught the model anything, °C. */
  typicalError: number;
}

export function exposureOf(p: Pick<ThermalProfile, 'setting' | 'shaded'>): Exposure {
  if (p.setting === 'indoor') return 'indoor';
  if (p.setting === 'outdoor') return p.shaded === false ? 'open' : p.shaded === true ? 'roofed' : 'unknown';
  return 'unknown';
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Starting values from the profile. Indoor tanks barely feel the sun and follow the room slowly;
 * an open tarp tank in the sun swings most. Deeper water holds heat longer; an aquarium is small
 * and quick, an earth pond and concrete walls slow. Bright places and coloured water take in more sun.
 */
export function prior(p: ThermalProfile): Prior {
  const exposure = exposureOf(p);
  const base = {
    indoor: { k: 0.035, sun: 0.3, evap: 0.05, windK: 0, err: 0.6 },
    roofed: { k: 0.05, sun: 1.5, evap: 0.15, windK: 1 / 80, err: 1.0 },
    open: { k: 0.06, sun: 3.5, evap: 0.3, windK: 1 / 80, err: 1.5 },
    unknown: { k: 0.05, sun: 2, evap: 0.2, windK: 1 / 80, err: 1.3 },
  }[exposure];
  const depth = p.depthCm && p.depthCm > 0 ? p.depthCm : 30;
  let k = base.k * clamp(30 / depth, 0.4, 2.5);
  k *= { akuarium: 1.4, tanah: 0.75, beton: 0.85, bulat: 1, terpal: 1, fiber: 1 }[p.kind ?? ''] ?? 1;
  let sun = base.sun;
  if (p.light === 'bright') sun *= exposure === 'indoor' ? 2 : 1.2;
  else if (p.light === 'dim') sun *= 0.7;
  else if (p.light === 'dark') sun *= 0.3;
  if (p.waterColor && p.waterColor !== 'clear') sun *= 1.15;
  return {
    exposure,
    params: { k: clamp(k, 0.01, 0.35), sun, offset: 0, evap: base.evap, windK: base.windK },
    sd: { offset: 1.5, sun: Math.max(0.4, 0.45 * sun), logK: 0.5 },
    typicalError: base.err,
  };
}

// ---------- weather drivers ----------

/** Stull (2011) wet-bulb temperature, °C; humidity in %. */
export function wetBulb(t: number, rh: number): number {
  const h = clamp(rh, 5, 99);
  return t * Math.atan(0.151977 * Math.sqrt(h + 8.313659)) + Math.atan(t + h) - Math.atan(h - 1.676331) + 0.00391838 * Math.pow(h, 1.5) * Math.atan(0.023101 * h) - 4.686035;
}

/** Evaporation drive in °C-like units: dry air and strong evaporation weather cool the water. */
export function evaporation(w: WeatherHour): number {
  // Without humidity there is nothing to go on: the learned offset carries the average cooling.
  const depression = w.humidity === undefined || w.humidity === null ? 0 : Math.max(0, w.airTemp - wetBulb(w.airTemp, w.humidity));
  return 0.5 * depression + 10 * Math.max(0, w.et0 ?? 0);
}

export type WeatherMap = Map<number, WeatherHour>;
const hourOf = (t: number) => Math.floor(t / HOUR_MS) * HOUR_MS;
export const weatherAt = (weather: WeatherMap, t: number) => weather.get(hourOf(t));

/**
 * Steps the water from (t0, temp0) to t1 through the hourly weather. Alongside the temperature it
 * tracks how the end value responds to one more °C of offset (ub) and one more unit of sun (ug):
 * the model is linear in both, which is what makes learning them cheap.
 */
export function track(weather: WeatherMap, p: ThermalParams, t0: number, temp0: number, t1: number): { temp: number; ub: number; ug: number } | null {
  let t = t0;
  let temp = temp0;
  let ub = 0;
  let ug = 0;
  while (t < t1) {
    const w = weatherAt(weather, t);
    if (!w) return null;
    const dt = Math.min(HOUR_MS, t1 - t) / HOUR_MS;
    const sunUnit = Math.max(0, w.radiation) / 1000;
    const equilibrium = w.airTemp + p.offset + p.sun * sunUnit - p.evap * evaporation(w);
    const k = Math.min(0.9, p.k * (1 + p.windK * Math.max(0, w.wind)));
    const a = 1 - Math.pow(1 - k, dt);
    temp += (equilibrium - temp) * a;
    ub += (1 - ub) * a;
    ug += (sunUnit - ug) * a;
    t += dt * HOUR_MS;
  }
  return { temp, ub, ug };
}

export function simulate(weather: WeatherMap, p: ThermalParams, t0: number, temp0: number, t1: number): number | null {
  return track(weather, p, t0, temp0, t1)?.temp ?? null;
}

// ---------- learning ----------

export interface Reading {
  t: number;
  value: number;
  /** Copied from the farmer's old notebook (counted as an old record). */
  old?: boolean;
  /** Time of day not known (a notebook row without a time): used with a small weight, never scored. */
  timeUnsure?: boolean;
}

export type Part = 'morning' | 'midday' | 'afternoon' | 'night';
/** pagi 04–10, siang 10–15, sore 15–19, malam 19–04 (farm-local). */
export const partOf = (hour: number): Part => (hour >= 4 && hour < 10 ? 'morning' : hour >= 10 && hour < 15 ? 'midday' : hour >= 15 && hour < 19 ? 'afternoon' : 'night');
export const PARTS: Part[] = ['morning', 'midday', 'afternoon', 'night'];

export interface BacktestPoint {
  t: number;
  /** Measured minus estimated, °C: positive = the pond was warmer than the estimate. */
  error: number;
  gapH: number;
  hour: number;
}

export interface ThermalModel {
  exposure: Exposure;
  params: ThermalParams;
  prior: ThermalParams;
  /** Hours for the pond to close about two thirds of a gap to the weather (1/k). */
  responseHours: number;
  /** Readings that taught the model (pairs of readings within 2 days of each other). */
  readings: number;
  /** Of those, how many came from the old notebook. */
  oldReadings: number;
  backtest: { n: number; typical: number | null; bias: number | null; rmse: number | null };
  /** Too few scored readings: the error shown is the prior's. */
  learning: boolean;
  /** "Usually off by ±X °C": 80% of the backtest misses were smaller (or the prior, while learning). */
  typicalError: number;
  /** ±1 standard deviation of the learned sun number. */
  sunSd: number;
  /** Median hours between consecutive readings. */
  gapH: number;
  byPart: { part: Part; n: number; bias: number; typical: number }[];
  /** The last scored misses, oldest first (for the "estimate compared with readings" chart). */
  recent: { t: number; error: number }[];
}

const OBS_SD = 0.35; // °C: thermometer, reading time and model error together
const MIN_SCORED = 6;
const MIN_GAP_H = 1.5;
const MAX_GAP_H = 48;

interface Stats {
  a11: number;
  a12: number;
  a22: number;
  b1: number;
  b2: number;
  c: number;
}
const zero = (): Stats => ({ a11: 0, a12: 0, a22: 0, b1: 0, b2: 0, c: 0 });

interface Solved {
  offset: number;
  sun: number;
  cost: number;
  sunVar: number;
}

/** Ridge solve of offset and sun for one k, with the prior as the pull. */
function solve(s: Stats, pr: Prior, logK: number): Solved {
  const v = OBS_SD * OBS_SD;
  const pb = 1 / (pr.sd.offset * pr.sd.offset);
  const pg = 1 / (pr.sd.sun * pr.sd.sun);
  const h11 = s.a11 / v + pb;
  const h12 = s.a12 / v;
  const h22 = s.a22 / v + pg;
  const r1 = s.b1 / v + pb * pr.params.offset;
  const r2 = s.b2 / v + pg * pr.params.sun;
  const det = h11 * h22 - h12 * h12;
  let offset = (h22 * r1 - h12 * r2) / det;
  let sun = (h11 * r2 - h12 * r1) / det;
  offset = clamp(offset, -5, 5);
  sun = clamp(sun, 0, 8);
  const sse = s.c - 2 * (offset * s.b1 + sun * s.b2) + offset * offset * s.a11 + 2 * offset * sun * s.a12 + sun * sun * s.a22;
  const dk = logK - Math.log(pr.params.k);
  const cost = sse / v + pb * (offset - pr.params.offset) ** 2 + pg * (sun - pr.params.sun) ** 2 + (dk * dk) / (pr.sd.logK * pr.sd.logK);
  return { offset, sun, cost, sunVar: h11 / det };
}

const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.min(s.length - 1, lo + 1)] - s[lo]) * (i - lo);
};
const round1 = (n: number) => Math.round(n * 10) / 10;
const roundUp1 = (n: number) => Math.ceil(n * 10 - 1e-9) / 10;

/** Hour of day in a time zone, cached per zone offset hour (Indonesian zones have no daylight saving). */
const offsets = new Map<string, number>();
export function localHour(t: number, timezone: string): number {
  let off = offsets.get(timezone);
  if (off === undefined) {
    const probe = Date.UTC(2026, 0, 1, 12);
    const wall = Number(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(probe)));
    off = (((wall - 12) % 24) + 24) % 24;
    offsets.set(timezone, off);
  }
  return Math.floor((((t / HOUR_MS + off) % 24) + 24) % 24);
}

/**
 * Learns one pond's numbers from its readings and the weather, and scores the model on its own
 * readings (rolling: each reading is predicted with only what was learned before it).
 */
export function learn(weather: WeatherMap, profile: ThermalProfile, input: Reading[], timezone: string): ThermalModel {
  const pr = prior(profile);
  // Same-instant duplicates averaged; oldest first.
  const byT = new Map<number, Reading & { n: number }>();
  for (const r of input) {
    const cur = byT.get(r.t);
    if (cur) cur.value = (cur.value * cur.n + r.value) / ++cur.n;
    else byT.set(r.t, { ...r, n: 1 });
  }
  const readings = [...byT.values()].sort((a, b) => a.t - b.t);

  const kGrid = Array.from({ length: 13 }, (_, i) => clamp(pr.params.k * Math.exp(-1.2 + 0.2 * i), 0.008, 0.4));
  // Each usable pair: what every k predicts with offset 0 and sun 0, and the responses.
  const pairs: { a: Reading; b: Reading; w: number; f: { base: number; ub: number; ug: number }[] }[] = [];
  for (let i = 1; i < readings.length; i++) {
    const a = readings[i - 1];
    const b = readings[i];
    const gapH = (b.t - a.t) / HOUR_MS;
    if (gapH < MIN_GAP_H || gapH > MAX_GAP_H) continue;
    // 6 °C in under a day without a cause the weather shows is a typo or another pond, not water.
    if (Math.abs(b.value - a.value) > 6) continue;
    const f: { base: number; ub: number; ug: number }[] = [];
    for (const k of kGrid) {
      const tr = track(weather, { ...pr.params, k, offset: 0, sun: 0 }, a.t, a.value, b.t);
      if (!tr) break;
      f.push({ base: tr.temp, ub: tr.ub, ug: tr.ug });
    }
    if (f.length !== kGrid.length) continue;
    pairs.push({ a, b, w: a.timeUnsure || b.timeUnsure ? 0.3 : 1, f });
  }

  const stats = kGrid.map(zero);
  const best = () => {
    let pick = { j: 0, s: solve(stats[0], pr, Math.log(kGrid[0])) };
    for (let j = 1; j < kGrid.length; j++) {
      const s = solve(stats[j], pr, Math.log(kGrid[j]));
      if (s.cost < pick.s.cost) pick = { j, s };
    }
    return pick;
  };

  const scored: BacktestPoint[] = [];
  for (const p of pairs) {
    // Predict this reading with what was learned so far, then learn from it.
    if (!p.a.timeUnsure && !p.b.timeUnsure) {
      const { j, s } = best();
      const f = p.f[j];
      scored.push({ t: p.b.t, error: p.b.value - (f.base + s.offset * f.ub + s.sun * f.ug), gapH: (p.b.t - p.a.t) / HOUR_MS, hour: localHour(p.b.t, timezone) });
    }
    p.f.forEach((f, j) => {
      const r = p.b.value - f.base;
      const st = stats[j];
      st.a11 += p.w * f.ub * f.ub;
      st.a12 += p.w * f.ub * f.ug;
      st.a22 += p.w * f.ug * f.ug;
      st.b1 += p.w * r * f.ub;
      st.b2 += p.w * r * f.ug;
      st.c += p.w * r * r;
    });
  }

  const { j, s } = best();
  const params: ThermalParams = { ...pr.params, k: kGrid[j], offset: s.offset, sun: s.sun };
  const last = scored.slice(-40);
  const abs = last.map((e) => Math.abs(e.error));
  const learning = last.length < MIN_SCORED;
  const typical = last.length ? Math.max(0.1, roundUp1(quantile(abs, 0.8))) : null;
  const used = new Set<number>();
  for (const p of pairs) used.add(p.a.t).add(p.b.t);
  const gaps = pairs.map((p) => (p.b.t - p.a.t) / HOUR_MS);

  return {
    exposure: pr.exposure,
    params,
    prior: pr.params,
    responseHours: Math.round(1 / params.k),
    readings: used.size,
    oldReadings: readings.filter((r) => r.old && used.has(r.t)).length,
    backtest: {
      n: last.length,
      typical,
      bias: last.length ? round1(last.reduce((a, e) => a + e.error, 0) / last.length) : null,
      rmse: last.length ? round1(Math.sqrt(last.reduce((a, e) => a + e.error * e.error, 0) / last.length)) : null,
    },
    learning,
    typicalError: learning || typical === null ? pr.typicalError : typical,
    sunSd: round1(Math.sqrt(s.sunVar)),
    gapH: gaps.length ? quantile(gaps, 0.5) : 12,
    byPart: PARTS.map((part) => {
      const of = last.filter((e) => partOf(e.hour) === part);
      return {
        part,
        n: of.length,
        bias: of.length ? round1(of.reduce((a, e) => a + e.error, 0) / of.length) : 0,
        typical: of.length ? roundUp1(quantile(of.map((e) => Math.abs(e.error)), 0.8)) : 0,
      };
    }),
    recent: scored.slice(-7).map((e) => ({ t: e.t, error: round1(e.error) })),
  };
}

/** ±1 standard deviation of an estimate `hours` after the last reading, from the pond's own misses. */
export function sigmaAt(model: ThermalModel, hours: number): number {
  const sd = model.typicalError / 1.28;
  return clamp(sd * Math.sqrt(clamp(hours / Math.max(2, model.gapH), 0.15, 3)), 0.1, 4);
}

// ---------- when to measure ----------

export interface MeasureHour {
  /** Farm-local "HH:00". */
  time: string;
  hour: number;
  /** How far the estimate at this hour can be off when nobody measures then, °C (about 80% of the time). */
  spread: number;
  /** sun: the sun effect is not learned well yet; unmeasured: this time of day is rarely measured; misses: readings at this time often miss. */
  reason: 'sun' | 'unmeasured' | 'misses';
  /** Share of days with a reading within 1.5 hours of this time. */
  covered: number;
}

/**
 * Awake hours (06–21) ranked by how much a reading then would teach the model: hours the farmer
 * rarely measures, where the sun's share is uncertain or the misses are large. Deterministic; the
 * pattern agent only puts it in words.
 */
export function measuringHours(model: ThermalModel, weather: WeatherHour[], readings: Reading[], now: number, timezone: string): MeasureHour[] {
  const recentDays = Math.max(1, Math.min(14, Math.round((now - Math.min(now, ...readings.map((r) => r.t))) / (24 * HOUR_MS))));
  const since = now - recentDays * 24 * HOUR_MS;
  const recent = readings.filter((r) => r.t >= since && !r.timeUnsure);
  const sunBy = new Array(24).fill(0);
  const sunN = new Array(24).fill(0);
  for (const w of weather) {
    if (w.t < now - 7 * 24 * HOUR_MS || w.t > now) continue;
    const h = localHour(w.t, timezone);
    sunBy[h] += Math.max(0, w.radiation) / 1000;
    sunN[h]++;
  }
  const base = model.typicalError / 1.28;
  const raw: { value: number; h: MeasureHour }[] = [];
  for (let hour = 6; hour <= 21; hour++) {
    const near = (r: Reading) => {
      const d = (((localHour(r.t, timezone) - hour) % 24) + 24) % 24;
      return Math.min(d, 24 - d) <= 1;
    };
    const days = new Set(recent.filter(near).map((r) => Math.floor((r.t - since) / (24 * HOUR_MS))));
    const covered = Math.min(1, days.size / recentDays);
    const part = model.byPart.find((p) => p.part === partOf(hour))!;
    const partSd = part.n >= 3 ? part.typical / 1.28 : base * 1.25;
    const sunSd = model.sunSd * (sunN[hour] ? sunBy[hour] / sunN[hour] : 0) * Math.min(1, model.params.k * 6);
    const sd = Math.sqrt(partSd * partSd + sunSd * sunSd);
    const reason: MeasureHour['reason'] = sunSd > partSd ? 'sun' : part.n >= 3 && part.typical > model.typicalError ? 'misses' : 'unmeasured';
    raw.push({ value: sd * 1.28 * (1 - 0.7 * covered), h: { time: `${String(hour).padStart(2, '0')}:00`, hour, spread: 0, reason, covered: round1(covered) } });
  }
  // Best first (unrounded, so near-ties go to the hour the sun matters most); suggestions at least 3 hours apart.
  raw.sort((a, b) => b.value - a.value || a.h.hour - b.h.hour);
  const picked: MeasureHour[] = [];
  for (const { value, h } of raw) if (picked.every((p) => Math.abs(p.hour - h.hour) >= 3)) picked.push({ ...h, spread: round1(value) });
  return picked.slice(0, 3);
}
