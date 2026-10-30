// Past weather from the Open-Meteo archive (free, no key), for teaching the water temperature
// model from old readings: a notebook copied on day one has dates weeks or months back, long
// before the 7 past days the forecast call brings. Days are cached in the database for good
// (past weather does not change); a day the archive cannot give yet is asked again later.
import type { WeatherHour } from './weather.ts';

const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';
const DAY_MS = 86400_000;
/** The archive trails real time by a few days; the forecast call covers the last 7 days anyway. */
const ARCHIVE_LAG_DAYS = 2;
/** Do not ask again for days that came back empty for this long. */
const RETRY_MS = 6 * 3600_000;
/** Ranges asked per call, so a scattered notebook cannot trigger dozens of requests. */
const MAX_REQUESTS = 3;

export interface ArchiveStore {
  /** Cached days for a location key, by UTC date. */
  days(key: string, dates: string[]): Map<string, WeatherHour[]>;
  save(key: string, date: string, hours: WeatherHour[]): void;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const tried = new Map<string, number>();

export const locationKey = (lat: number, lon: number) => `${lat.toFixed(2)},${lon.toFixed(2)}`;
const utcDate = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Parses an Open-Meteo hourly block (forecast or archive) into weather hours. */
export function parseHourly(h: Record<string, any>): WeatherHour[] {
  const hours: WeatherHour[] = [];
  for (let i = 0; i < (h?.time?.length ?? 0); i++) {
    if (h.temperature_2m?.[i] == null) continue;
    hours.push({
      t: Date.parse(`${h.time[i]}:00Z`),
      airTemp: h.temperature_2m[i],
      radiation: h.shortwave_radiation?.[i] ?? 0,
      cloud: h.cloud_cover?.[i] ?? 0,
      wind: h.wind_speed_10m?.[i] ?? 0,
      rain: h.precipitation?.[i] ?? 0,
      ...(h.relative_humidity_2m?.[i] != null && { humidity: h.relative_humidity_2m[i] }),
      ...(h.et0_fao_evapotranspiration?.[i] != null && { et0: h.et0_fao_evapotranspiration[i] }),
    });
  }
  return hours;
}

/** Consecutive dates grouped into [first, last] ranges. */
function ranges(dates: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (const d of [...dates].sort()) {
    const last = out.at(-1);
    if (last && Date.parse(d) - Date.parse(last[1]) <= DAY_MS) last[1] = d;
    else out.push([d, d]);
  }
  return out;
}

/**
 * Hourly past weather covering the instants `times` (each reading and the day before it, so the
 * model can step from one reading to the next). Cached days come from the store; missing ones are
 * fetched. Never throws: whatever could not be had is simply left out.
 */
export async function archiveWeather(
  lat: number,
  lon: number,
  times: number[],
  { store, fetcher = fetch, now = Date.now() }: { store: ArchiveStore; /** null: cached days only (tests, offline). */ fetcher?: Fetcher | null; now?: number },
): Promise<WeatherHour[]> {
  const key = locationKey(lat, lon);
  const newest = utcDate(now - ARCHIVE_LAG_DAYS * DAY_MS);
  const wanted = new Set<string>();
  for (const t of times) for (const d of [utcDate(t - DAY_MS), utcDate(t), utcDate(t + DAY_MS)]) if (d <= newest) wanted.add(d);
  const dates = [...wanted];
  if (!dates.length) return [];
  const have = store.days(key, dates);
  const missing = fetcher ? dates.filter((d) => !have.has(d) && now - (tried.get(`${key}|${d}`) ?? -Infinity) > RETRY_MS) : [];
  for (const [from, to] of ranges(missing).slice(-MAX_REQUESTS)) {
    const url = new URL(ARCHIVE_URL);
    url.search = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      start_date: from,
      end_date: to,
      hourly: 'temperature_2m,shortwave_radiation,cloud_cover,wind_speed_10m,precipitation,relative_humidity_2m,et0_fao_evapotranspiration',
      timezone: 'UTC',
    }).toString();
    try {
      const res = await fetcher!(url.toString(), { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`Open-Meteo archive ${res.status}`);
      const hours = parseHourly((await res.json()).hourly);
      const byDay = new Map<string, WeatherHour[]>();
      for (const h of hours) byDay.set(utcDate(h.t), [...(byDay.get(utcDate(h.t)) ?? []), h]);
      for (const [d, list] of byDay) {
        // Only whole days are kept for good; a partial day is asked again later.
        if (list.length >= 24) {
          store.save(key, d, list);
          have.set(d, list);
        }
      }
    } catch (err) {
      console.error('weather archive:', (err as Error).message);
    }
    for (let t = Date.parse(from); t <= Date.parse(to); t += DAY_MS) {
      const d = utcDate(t);
      if (!have.has(d)) tried.set(`${key}|${d}`, now);
    }
  }
  return [...have.values()].flat().sort((a, b) => a.t - b.t);
}

/** Forgets the "asked recently" marks (tests). */
export const resetArchiveRetries = () => tried.clear();
