// Synthetic ponds for the water temperature model's tests and `npm run eval`. The "true" pond is
// stepped hour by hour with its own physics, which is NOT exactly the app's model: sun can reach
// the water only at some hours (a gap in the roof), the room or ground adds heat, and readings are
// noisy, rounded to 0.1 °C and taken at slightly different times each day. Labelled synthetic.
import type { WeatherHour } from '../../src/weather.ts';

const HOUR = 3600_000;

/** Deterministic pseudo-random numbers. */
export function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

/** Tropical weather around Yogyakarta: daily cycle, cloudy and rainy spells, humidity. UTC hours, WIB = UTC+7. */
export function synthWeather(start: number, days: number, seed = 7): WeatherHour[] {
  const rand = rng(seed);
  const hours: WeatherHour[] = [];
  let cloudDay = 0.3;
  for (let d = 0; d < days; d++) {
    cloudDay = Math.min(0.95, Math.max(0.05, cloudDay + (rand() - 0.5) * 0.5));
    const warm = (rand() - 0.5) * 2;
    for (let h = 0; h < 24; h++) {
      const t = start + (d * 24 + h) * HOUR;
      const local = (h + 7) % 24;
      const cloud = Math.min(1, Math.max(0, cloudDay + (rand() - 0.5) * 0.3));
      const sun = local >= 6 && local <= 18 ? Math.sin(((local - 6) / 12) * Math.PI) : 0;
      const radiation = 950 * sun * (1 - 0.75 * cloud);
      const airTemp = 27 + warm - 3.5 * Math.cos(((local - 3) / 24) * 2 * Math.PI) * (1 - 0.4 * cloud);
      const humidity = Math.min(98, 70 + 20 * cloud + 8 * Math.cos(((local - 3) / 24) * 2 * Math.PI));
      const rain = cloud > 0.8 && local >= 13 && local <= 17 ? 3 * rand() : 0;
      hours.push({ t, airTemp, radiation, cloud: Math.round(cloud * 100), wind: 4 + 6 * rand(), rain, humidity, et0: Math.max(0, (radiation / 1000) * 0.5 * (1 - humidity / 130)) });
    }
  }
  return hours;
}

export interface TruePond {
  name: string;
  /** What the farmer would enter (the model's prior). */
  profile: { kind: string; setting: 'indoor' | 'outdoor'; shaded: boolean | null; depthCm: number; light?: 'bright' | 'dim' | 'dark' };
  k: number;
  /** Sun gain, °C at 1000 W/m², at the hours it reaches the water. */
  sun: number;
  sunHours?: [number, number];
  offset: number;
  evap: number;
}

export const POND_TYPES: TruePond[] = [
  { name: 'Indoor fiber tank', profile: { kind: 'fiber', setting: 'indoor', shaded: null, depthCm: 40 }, k: 0.025, sun: 0.1, offset: 1.2, evap: 0.05 },
  { name: 'Aquarium indoors', profile: { kind: 'akuarium', setting: 'indoor', shaded: null, depthCm: 25 }, k: 0.07, sun: 0, offset: 0.6, evap: 0.05 },
  { name: 'Concrete pond under shade net', profile: { kind: 'beton', setting: 'outdoor', shaded: true, depthCm: 30 }, k: 0.04, sun: 1.0, offset: 0.4, evap: 0.15 },
  { name: 'Open tarp tank in the sun', profile: { kind: 'terpal', setting: 'outdoor', shaded: false, depthCm: 50 }, k: 0.08, sun: 5, offset: -0.6, evap: 0.35 },
  { name: 'Roofed tank, midday sun through a gap', profile: { kind: 'terpal', setting: 'outdoor', shaded: true, depthCm: 30 }, k: 0.06, sun: 4, sunHours: [11, 14], offset: 0.2, evap: 0.15 },
];

/** Hourly true water temperature and the farmer's readings (07:00 and 17:00 WIB, ±40 min, some days missed). */
export function synthPond(p: TruePond, weather: WeatherHour[], seed = 11) {
  const rand = rng(seed);
  const water = new Map<number, number>();
  let temp = weather[0].airTemp + p.offset;
  for (const w of weather) {
    water.set(w.t, temp);
    const local = (new Date(w.t).getUTCHours() + 7) % 24;
    const sunOn = !p.sunHours || (local >= p.sunHours[0] && local < p.sunHours[1]);
    // A rougher evaporation rule than the app's (no wet-bulb formula), on purpose.
    const depression = 14 * (1 - (w.humidity ?? 80) / 100);
    const eq = w.airTemp + p.offset + (sunOn ? (p.sun * w.radiation) / 1000 : 0) - p.evap * (0.5 * depression + 10 * (w.et0 ?? 0));
    temp += (eq - temp) * p.k * (1 + w.wind / 80);
  }
  const readings: { t: number; value: number }[] = [];
  const first = weather[0].t;
  const days = Math.floor(weather.length / 24);
  for (let d = 1; d < days; d++) {
    for (const hour of [7, 17]) {
      if (rand() < 0.1) continue;
      const t = first + (d * 24 + hour - 7) * HOUR + Math.round((rand() - 0.5) * 80) * 60_000;
      const h = Math.floor(t / HOUR) * HOUR;
      const a = water.get(h);
      const b = water.get(h + HOUR) ?? a;
      if (a === undefined || b === undefined) continue;
      const v = a + (b - a) * ((t - h) / HOUR) + (rand() - 0.5) * 0.3;
      readings.push({ t, value: Math.round(v * 10) / 10 });
    }
  }
  return { water, readings };
}
