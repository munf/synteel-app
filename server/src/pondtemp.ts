// Glue between the farm's records and the water temperature model (thermal.ts): which readings
// teach a pond, which weather they need (the forecast call's 7 past days, older days from the
// Open-Meteo archive), a cache so the model is not re-learned on every request, and the pattern
// note the pond page shows (patterns.ts).
import { archiveWeather, type ArchiveStore, type Fetcher } from './archive.ts';
import { currentLang } from './i18n.ts';
import { DAY_MS, type Pond } from './domain.ts';
import type { FarmRepo } from './db.ts';
import { thermalReadings } from './nowcast.ts';
import { exposureOf, learn, measuringHours, type Reading, type ThermalModel, type WeatherMap } from './thermal.ts';
import { PATTERN_EVERY_MS, rulesPattern, type PatternPond, type PondPattern } from './patterns.ts';
import type { WeatherHour } from './weather.ts';

/** How far back readings teach the model: long enough for a notebook copied on day one. */
export const THERMAL_DAYS = 120;
const CACHE_MS = 30 * 60_000;
const CACHE_MAX = 500;

export interface PondThermal {
  model: ThermalModel;
  readings: Reading[];
}

export function thermalService({ archive, fetchArchive }: { archive: ArchiveStore; fetchArchive: Fetcher | null }) {
  const cache = new Map<string, { at: number; value: PondThermal }>();

  /** The pond's learned model. `forecast`: the hourly weather the nowcast already has (may be empty). */
  async function forPond(r: FarmRepo, pond: Pond, forecast: WeatherHour[], now: number, timezone: string): Promise<PondThermal> {
    const logs = r.logsSince(pond.id, new Date(now - THERMAL_DAYS * DAY_MS).toISOString());
    const readings = thermalReadings(logs, timezone, now);
    const profile = [pond.kind, pond.setting, pond.shaded, pond.depthCm, pond.waterColor ?? null, pond.light ?? null];
    const sum = readings.reduce((a, x) => a + x.value * ((x.t / 60_000) % 997), 0);
    const key = `${pond.id}|${JSON.stringify(profile)}|${readings.length}|${readings.at(-1)?.t ?? 0}|${sum.toFixed(3)}|${forecast.length}|${forecast[0]?.t ?? 0}`;
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_MS) return hit.value;

    const farm = r.getFarm();
    const first = forecast[0]?.t ?? now;
    // Readings older than the forecast's past days need archive weather (the day before each too).
    const older = readings.filter((x) => x.t - DAY_MS < first).map((x) => x.t);
    let past: WeatherHour[] = [];
    if (older.length && farm?.lat != null && farm.lon != null) past = await archiveWeather(farm.lat, farm.lon, older, { store: archive, fetcher: fetchArchive, now });
    const weather: WeatherMap = new Map(past.map((h) => [h.t, h]));
    for (const h of forecast) weather.set(h.t, h);
    const value = { model: learn(weather, pond, readings, timezone), readings };
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(key, { at: now, value });
    return value;
  }

  /** Archive weather around these instants (cached; offline in tests). */
  const pastWeather = (lat: number, lon: number, times: number[], now: number) => archiveWeather(lat, lon, times, { store: archive, fetcher: fetchArchive, now });

  return { forPond, pastWeather };
}

export type ThermalService = ReturnType<typeof thermalService>;

/** What the pattern agent and the rules need to know about one pond. */
export function patternPond(pond: Pond, t: PondThermal, forecast: WeatherHour[], now: number, timezone: string): PatternPond {
  return {
    id: pond.id,
    name: pond.name,
    exposure: exposureOf(pond),
    kind: pond.kind,
    light: pond.light ?? null,
    waterColor: pond.waterColor ?? null,
    model: t.model,
    hours: measuringHours(t.model, forecast, t.readings, now, timezone),
  };
}

/**
 * The note to show in the viewer's language: the agent's (or the labelled sample's) from the last
 * week when there is one in this language, otherwise the rules note from today's numbers.
 */
export function patternView(r: FarmRepo, p: PatternPond, now: number): PondPattern {
  // A saved rules note is only a marker of a run; the rules note is always written from today's numbers.
  const saved = r.patterns<PondPattern>(p.id).find((x) => x.lang === currentLang() && x.source !== 'rules');
  if (saved && now - Date.parse(saved.createdAt) < PATTERN_EVERY_MS + DAY_MS) return saved.body;
  return rulesPattern(p, now);
}
