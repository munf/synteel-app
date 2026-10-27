// Hourly weather from Open-Meteo (free, no API key). Used by the water temperature
// model; the app keeps working without it, only with less certain estimates.

export interface WeatherHour {
  t: number; // epoch ms, start of the hour (UTC)
  airTemp: number; // °C
  radiation: number; // shortwave, W/m²
  cloud: number; // %
  wind: number; // km/h
  rain: number; // mm in this hour
}

export interface Weather {
  hours: WeatherHour[];
  fetchedAt: number;
}

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const TTL_MS = 30 * 60 * 1000;

const cache = new Map<string, Weather>();

/** Last 7 days and next 2 days, hourly. Cached for 30 minutes per location. */
export async function getWeather(lat: number, lon: number, now = Date.now()): Promise<Weather> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit && now - hit.fetchedAt < TTL_MS) return hit;

  const url = new URL(FORECAST_URL);
  url.search = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: 'temperature_2m,shortwave_radiation,cloud_cover,wind_speed_10m,precipitation',
    past_days: '7',
    forecast_days: '2',
    timezone: 'UTC',
  }).toString();
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const h = (await res.json()).hourly;

  const hours: WeatherHour[] = [];
  for (let i = 0; i < h.time.length; i++) {
    if (h.temperature_2m[i] === null) continue;
    hours.push({
      t: Date.parse(`${h.time[i]}:00Z`),
      airTemp: h.temperature_2m[i],
      radiation: h.shortwave_radiation[i] ?? 0,
      cloud: h.cloud_cover[i] ?? 0,
      wind: h.wind_speed_10m[i] ?? 0,
      rain: h.precipitation[i] ?? 0,
    });
  }
  const weather = { hours, fetchedAt: now };
  cache.set(key, weather);
  return weather;
}

/** Place name to coordinates, for farms set up without GPS. Indonesia only. */
export async function geocode(name: string): Promise<{ lat: number; lon: number; label: string } | null> {
  const url = new URL(GEOCODE_URL);
  // Open-Meteo matches a single place name, so "Sleman, Yogyakarta" is searched as "Sleman".
  url.search = new URLSearchParams({ name: name.split(',')[0].trim(), count: '1', language: 'id', countryCode: 'ID' }).toString();
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;
  const top = (await res.json()).results?.[0];
  if (!top) return null;
  return { lat: top.latitude, lon: top.longitude, label: [top.name, top.admin2, top.admin1].filter(Boolean).join(', ') };
}
