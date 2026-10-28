// Fills the database with a realistic demo farm: two weeks of logs on three ponds.
// Usage: node scripts/seed-demo.ts --reset   (deletes the existing database first;
// stop the server before resetting, or it keeps writing to the deleted file)
import { existsSync, rmSync } from 'node:fs';
import { DAY_MS, localDate, type LogData } from '../server/src/domain.ts';
import { hashPin, newToken } from '../server/src/auth.ts';
import { openDb, repo } from '../server/src/db.ts';
import { simulate, thermalParams } from '../server/src/nowcast.ts';
import { getWeather } from '../server/src/weather.ts';

const dbPath = process.env.SYNTEEL_DB ?? new URL('../data/synteel.sqlite', import.meta.url).pathname;
if (process.argv.includes('--reset')) {
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
} else if (existsSync(dbPath)) {
  console.error(`Database already exists at ${dbPath}. Run with --reset to replace it.`);
  process.exit(1);
}

const store = repo(openDb(dbPath));
const tz = 'Asia/Jakarta';
const now = new Date();
const daysAgo = (d: number) => localDate(new Date(now.getTime() - d * DAY_MS), tz);
// Deterministic pseudo-random so every reset gives the same demo.
let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const around = (base: number, spread: number, digits = 1) => Number((base + (rand() - 0.5) * 2 * spread).toFixed(digits));

const farm = { name: 'Tambak Sidat Mitra', locationName: 'Sleman, Yogyakarta', lat: -7.72, lon: 110.36, timezone: tz };
// The shared demo account behind "Coba demo" (SYNTEEL_DEMO_PHONE). Its PIN is random and never
// shown: the demo is entered through the button only.
const demoPhone = process.env.SYNTEEL_DEMO_PHONE || '620000000000';
const demo = store.createUser({ phone: demoPhone, name: 'Petani Demo', pinHash: hashPin(newToken()) });
const r = store.farm(store.createFarm(farm, demo.id));

// Real weather for the last week, so outdoor readings follow the actual days and nights
// and the nowcast has something sensible to calibrate against. Offline: synthetic values.
const weather = await getWeather(farm.lat, farm.lon).then(
  (w) => new Map(w.hours.map((h) => [h.t, h])),
  () => null,
);
if (!weather) console.warn('Weather unavailable: outdoor temperatures are synthetic.');

const ponds = [
  // Glass eels in indoor fiber tanks.
  { pond: r.addPond({ name: 'Kolam A', kind: 'fiber', volumeL: 870, areaM2: 2.9, setting: 'indoor', shaded: null, aeration: 'full', depthCm: 30 }), phase: 'glass_eel' as const, stocked: 23, count: 500 },
  // Farmers call it by where it is; the voice round knows both names.
  { pond: r.addPond({ name: 'Kolam B', kind: 'fiber', volumeL: 870, areaM2: 2.9, setting: 'indoor', shaded: null, aeration: 'full', depthCm: 30, nicknames: ['kolam dekat pintu'] }), phase: 'glass_eel' as const, stocked: 23, count: 500 },
  // Elver pond as the partner farm runs it: outdoor, paranet, 24-hour aeration, 30 cm deep, about 50 eels per m².
  { pond: r.addPond({ name: 'Kolam C', kind: 'beton', volumeL: 3600, areaM2: 12, setting: 'outdoor', shaded: true, aeration: 'full', depthCm: 30 }), phase: 'elver' as const, stocked: 60, count: 650 },
];

for (const { pond, phase, stocked, count } of ponds) {
  // Outdoor water temperature: the nowcast model run through the real weather, with the
  // concrete pond about 3 °C warmer than air plus sun alone would make it.
  let water = 29;
  let waterAt = weather ? Math.min(...weather.keys()) : 0;
  const waterTemp = (at: Date) => {
    if (!weather || pond.setting !== 'outdoor' || at.getTime() < waterAt) return null;
    const next = simulate(weather, thermalParams(pond), 3, waterAt, water, at.getTime());
    if (next === null) return null;
    water = next;
    waterAt = at.getTime();
    return around(next, 0.2);
  };
  const batch = r.startBatch({ pondId: pond.id, phase, stockedAt: daysAgo(stocked), initialCount: count }, daysAgo(stocked));
  for (let d = 14; d >= 0; d--) {
    for (const hour of [7, 17]) {
      const at = new Date(now.getTime() - d * DAY_MS);
      at.setUTCHours(hour - 7, 15, 0, 0); // farm-local hour in WIB
      // Today's evening log may still be in the future: record it as "just now" instead.
      if (at > now) at.setTime(now.getTime() - 20 * 60 * 1000);
      const data: LogData = {
        readings: {
          // Glass eels follow the Blueprint range (27–28 °C); elvers the partner farm's (28–31 °C, pH 6.8–7.6).
          temperature: phase === 'elver' ? (waterTemp(at) ?? around(29.2, 0.6)) : around(27.6, 0.4),
          ph: phase === 'elver' ? around(7.2, 0.15, 2) : around(7.4, 0.15, 2),
          tds: Math.round(around(phase === 'elver' ? 160 : 140, 12, 0)),
        },
        feeding: { leftover: rand() < 0.8 ? 'none' : 'little' },
        behavior: ['normal'],
        ...(hour === 17 && { aeration: 'on' as const }),
      };
      if (rand() < 0.25) data.mortality = 1 + Math.floor(rand() * 3);
      // Kolam B drifts into trouble over the last two days: warmer water, uneaten feed, eels surfacing.
      if (pond.name === 'Kolam B' && d <= 1) {
        data.readings!.temperature = around(29.4 + (1 - d) * 0.6, 0.2);
        data.feeding = { leftover: 'much' };
        if (d === 0 && hour === 17) data.behavior = ['surfacing'];
      }
      r.addLog({ pondId: pond.id, batchId: batch.id, loggedAt: at.toISOString(), source: 'manual', data }, demo.id);
    }
  }
}

console.log(`Seeded ${ponds.length} ponds with two weeks of logs into ${dbPath}`);
