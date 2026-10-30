// BMKG public weather forecast per village (desa/kelurahan), from BMKG open data:
//   GET https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=<Kemendagri village code>
// Three days in 3-hour steps, refreshed by BMKG twice a day. BMKG asks for at most 60 requests per
// minute per IP and for "Sumber: BMKG" wherever its data is shown. Server-side only: the phone never
// calls BMKG, and each village is fetched at most once per CACHE_MS.
import { findDesa, nearestDesa, type Desa } from './desa.ts';

export interface BmkgStep {
  /** Epoch ms of the forecast time (BMKG's utc_datetime). Each step stands for about 3 hours around it. */
  t: number;
  /** BMKG weather code, e.g. 95 or 97 for thunderstorms. */
  code: number;
  desc: string;
  descEn: string;
  /** Rain over the 3-hour step, mm (BMKG `tp`). */
  rain: number;
  /** Wind speed, km/h (BMKG `ws`). */
  wind: number;
  humidity: number;
  temp: number;
  cloud: number;
}

export interface BmkgForecast {
  adm4: string;
  place: { desa: string; kecamatan: string; kotkab: string; provinsi: string };
  steps: BmkgStep[];
  fetchedAt: number;
}

const FORECAST_URL = 'https://api.bmkg.go.id/publik/prakiraan-cuaca';
/** BMKG refreshes twice a day; 2 hours keeps the newest run close while staying far below the rate limit. */
const CACHE_MS = 2 * 3600_000;
/** A village BMKG did not answer for is not asked again for this long. */
const FAIL_MS = 15 * 60_000;
/** BMKG's limit is 60 requests per minute per IP; this server stays below it with room to spare. */
const MAX_PER_MINUTE = 40;
const USER_AGENT = 'Synteel/1.0 (eel farm decision support; https://eel.synt.fun)';

const cache = new Map<string, BmkgForecast>();
const failed = new Map<string, number>();
const inflight = new Map<string, Promise<BmkgForecast>>();
const recent: number[] = [];

/** Thunderstorm in a BMKG step: codes 95/97 ("Hujan Petir"), or the words, whatever the code. */
export const BMKG_THUNDER_CODES = [95, 97];
export const isBmkgThunder = (s: Pick<BmkgStep, 'code' | 'desc' | 'descEn'>) => BMKG_THUNDER_CODES.includes(s.code) || /petir|thunder/i.test(`${s.desc} ${s.descEn}`);
export const isBmkgHeavyRain = (s: Pick<BmkgStep, 'desc' | 'descEn'>) => /lebat|heavy/i.test(`${s.desc} ${s.descEn}`);

/** Turns BMKG's JSON into steps. Exported for tests. */
export function parseBmkg(json: any, now: number): BmkgForecast {
  const loc = json?.lokasi ?? json?.data?.[0]?.lokasi;
  const raw = (json?.data?.[0]?.cuaca ?? []).flat() as any[];
  const steps: BmkgStep[] = raw
    .map((s) => ({
      t: Date.parse(`${String(s.utc_datetime ?? '').replace(' ', 'T')}Z`),
      code: Number(s.weather),
      desc: String(s.weather_desc ?? ''),
      descEn: String(s.weather_desc_en ?? ''),
      rain: Number(s.tp) || 0,
      wind: Number(s.ws) || 0,
      humidity: Number(s.hu) || 0,
      temp: Number(s.t),
      cloud: Number(s.tcc) || 0,
    }))
    .filter((s) => Number.isFinite(s.t) && Number.isFinite(s.temp))
    .sort((a, b) => a.t - b.t);
  if (!loc?.adm4 || !steps.length) throw new Error('BMKG: no forecast in the answer');
  return {
    adm4: String(loc.adm4),
    place: { desa: String(loc.desa ?? ''), kecamatan: String(loc.kecamatan ?? ''), kotkab: String(loc.kotkab ?? ''), provinsi: String(loc.provinsi ?? '') },
    steps,
    fetchedAt: now,
  };
}

/** One village's forecast, cached per village. Throws when BMKG has none (or is out of reach). */
export async function getBmkgForecast(adm4: string, now = Date.now()): Promise<BmkgForecast> {
  const hit = cache.get(adm4);
  if (hit && now - hit.fetchedAt < CACHE_MS) return hit;
  if ((failed.get(adm4) ?? 0) > now - FAIL_MS) throw new Error('BMKG: no answer for this village a moment ago');
  const running = inflight.get(adm4);
  if (running) return running;
  while (recent.length && recent[0] < Date.now() - 60_000) recent.shift();
  if (recent.length >= MAX_PER_MINUTE) {
    if (hit) return hit;
    throw new Error('BMKG: request limit reached, try again in a minute');
  }
  recent.push(Date.now());
  const job = (async () => {
    try {
      const url = `${FORECAST_URL}?adm4=${encodeURIComponent(adm4)}`;
      const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`BMKG ${res.status}`);
      const forecast = parseBmkg(await res.json(), now);
      cache.set(adm4, forecast);
      failed.delete(adm4);
      return forecast;
    } catch (err) {
      failed.set(adm4, now);
      // An older forecast is still better than none.
      if (hit) return hit;
      throw err;
    } finally {
      inflight.delete(adm4);
    }
  })();
  inflight.set(adm4, job);
  return job;
}

export type GetBmkg = (adm4: string, now?: number) => Promise<BmkgForecast>;

/** The farm's BMKG region: the owner's choice, or else the village nearest to the farm's coordinates. */
export interface Region {
  desa: Desa;
  /** Chosen from the coordinates (true) or picked by the owner (false). */
  auto: boolean;
  /** Distance from the farm's coordinates to the village centre, km (auto only). */
  km: number | null;
}

export function regionCandidates(farm: { lat: number | null; lon: number | null; adm4?: string | null }): Region[] {
  if (farm.adm4) {
    const desa = findDesa(farm.adm4);
    if (desa) return [{ desa, auto: false, km: null }];
  }
  if (farm.lat == null || farm.lon == null) return [];
  // The nearest three: BMKG may not have a forecast for a village created very recently.
  return nearestDesa(farm.lat, farm.lon, 3).map(({ km, ...desa }) => ({ desa, auto: true, km }));
}

/** Region and forecast for a farm; null when the farm has no place yet or BMKG did not answer. */
export async function farmForecast(farm: { lat: number | null; lon: number | null; adm4?: string | null }, get: GetBmkg, now: number): Promise<{ region: Region; forecast: BmkgForecast | null; error: string | null } | null> {
  const candidates = regionCandidates(farm);
  if (!candidates.length) return null;
  let error: string | null = null;
  for (const region of candidates) {
    try {
      return { region, forecast: await get(region.desa.code, now), error: null };
    } catch (err) {
      error = (err as Error).message;
    }
  }
  return { region: candidates[0], forecast: null, error };
}
