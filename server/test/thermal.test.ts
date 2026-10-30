import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { archiveWeather, resetArchiveRetries, type ArchiveStore } from '../src/archive.ts';
import { withLang } from '../src/i18n.ts';
import { guardPattern, numbersOk, rulesPattern, runPatterns, type PatternPond } from '../src/patterns.ts';
import { guardPondPhoto, mockPondPhoto, placeToSetting } from '../src/pondphoto.ts';
import { evaporation, learn, measuringHours, prior, simulate, type Reading, type ThermalModel } from '../src/thermal.ts';
import type { WeatherHour } from '../src/weather.ts';
import { POND_TYPES, synthPond, synthWeather } from './fixtures/thermal-synth.ts';

const DAY = 86400_000;
const tz = 'Asia/Jakarta';
const start = Date.parse('2026-09-01T00:00:00Z');
const weather = synthWeather(start, 35);
const map = new Map(weather.map((h) => [h.t, h]));
const pondType = (name: string) => POND_TYPES.find((p) => p.name.startsWith(name))!;

// ---------- priors ----------

test('priors: an indoor tank follows the weather slower and feels less sun than an open tarp tank', () => {
  const indoor = prior({ kind: 'fiber', setting: 'indoor', shaded: null, depthCm: 30 });
  const open = prior({ kind: 'terpal', setting: 'outdoor', shaded: false, depthCm: 30 });
  assert.ok(indoor.params.k < open.params.k);
  assert.ok(indoor.params.sun < open.params.sun / 5);
  assert.ok(indoor.typicalError < open.typicalError);
  // Deeper water holds heat longer; a dark place gets less sun.
  assert.ok(prior({ kind: 'terpal', setting: 'outdoor', shaded: false, depthCm: 80 }).params.k < open.params.k);
  assert.ok(prior({ kind: 'terpal', setting: 'outdoor', shaded: false, depthCm: 30, light: 'dark' }).params.sun < open.params.sun);
});

test('dry air cools more than humid air', () => {
  const hour = (humidity: number): WeatherHour => ({ t: 0, airTemp: 30, radiation: 0, cloud: 0, wind: 0, rain: 0, humidity });
  assert.ok(evaporation(hour(50)) > evaporation(hour(90)));
  // No humidity known: no evaporation term (the offset carries the average).
  assert.equal(evaporation({ t: 0, airTemp: 30, radiation: 0, cloud: 0, wind: 0, rain: 0 }), 0);
});

// ---------- learning ----------

test('learning recovers an open tarp tank: more sun and a faster response than the prior', () => {
  const p = pondType('Open tarp');
  const { readings } = synthPond(p, weather);
  const m = learn(map, p.profile, readings, tz);
  assert.ok(Math.abs(m.params.sun - p.sun) < 1, `sun ${m.params.sun}`);
  assert.ok(Math.abs(m.params.k - p.k) < 0.02, `k ${m.params.k}`);
  assert.ok(Math.abs(m.params.offset - p.offset) < 0.5, `offset ${m.params.offset}`);
  assert.equal(m.learning, false);
  assert.ok(m.typicalError <= 0.5, `typical ${m.typicalError}`);
});

test('with three readings the model stays near the prior and says it is still learning', () => {
  const p = pondType('Open tarp');
  const { readings } = synthPond(p, weather);
  const m = learn(map, p.profile, readings.slice(0, 3), tz);
  const pr = prior(p.profile);
  assert.equal(m.learning, true);
  assert.equal(m.typicalError, pr.typicalError);
  assert.ok(Math.abs(m.params.sun - pr.params.sun) / pr.params.sun < 0.4, `sun moved to ${m.params.sun}`);
  // Two wild readings (a typo-sized jump each way) cannot throw it far either.
  const wild = learn(map, p.profile, readings.slice(0, 3).map((r, i) => ({ ...r, value: r.value + (i === 1 ? 2.5 : -1) })), tz);
  assert.ok(Math.abs(wild.params.offset) < 2.5 && wild.params.sun >= 0 && wild.params.sun < 7, JSON.stringify(wild.params));
});

test('the same readings give the same model (deterministic)', () => {
  const p = pondType('Concrete');
  const { readings } = synthPond(p, weather);
  assert.deepEqual(learn(map, p.profile, readings, tz), learn(map, p.profile, readings, tz));
});

test('the backtest only uses earlier readings: a later outlier does not change earlier scores', () => {
  const p = pondType('Concrete');
  const { readings } = synthPond(p, weather);
  const clean = learn(map, p.profile, readings, tz);
  const spoiled = readings.map((r, i) => (i === readings.length - 1 ? { ...r, value: r.value + 4 } : r));
  const after = learn(map, p.profile, spoiled, tz);
  // The last 7 scores: all but the spoiled one are identical.
  assert.deepEqual(after.recent.slice(0, -1), clean.recent.slice(0, -1));
  assert.notDeepEqual(after.recent.at(-1), clean.recent.at(-1));
});

test('old notebook readings count, and a row without a time is used lightly but never scored', () => {
  const p = pondType('Indoor fiber');
  const { readings } = synthPond(p, weather);
  const old: Reading[] = readings.map((r) => ({ ...r, old: true }));
  const m = learn(map, p.profile, old, tz);
  assert.ok(m.oldReadings > 40 && m.oldReadings === m.readings);
  const unsure = learn(map, p.profile, old.map((r) => ({ ...r, timeUnsure: true })), tz);
  assert.equal(unsure.backtest.n, 0);
  assert.equal(unsure.learning, true);
});

test('a roofed tank with midday sun through a gap: a midday reading is the one worth adding', () => {
  const p = pondType('Roofed tank');
  const { readings } = synthPond(p, weather);
  const m = learn(map, p.profile, readings, tz);
  const now = start + 34 * DAY;
  const hours = measuringHours(m, weather, readings, now, tz);
  assert.ok(hours.length >= 1);
  assert.ok(hours[0].hour >= 10 && hours[0].hour <= 15, `first suggestion ${hours[0].time}`);
  // The usual measuring times are covered, so they are not suggested first.
  assert.ok(!hours.slice(0, 1).some((h) => h.hour === 7 || h.hour === 17));
});

test('simulate stops where the weather stops', () => {
  const p = prior({ kind: 'terpal', setting: 'outdoor', shaded: true, depthCm: 30 }).params;
  assert.equal(simulate(map, p, start + 34 * DAY, 28, start + 40 * DAY), null);
});

// ---------- archive weather ----------

function memoryStore(): ArchiveStore & { saved: string[] } {
  const days = new Map<string, WeatherHour[]>();
  const saved: string[] = [];
  return {
    saved,
    days: (key, dates) => new Map(dates.filter((d) => days.has(`${key}|${d}`)).map((d) => [d, days.get(`${key}|${d}`)!])),
    save: (key, date, hours) => (saved.push(date), days.set(`${key}|${date}`, hours)),
  };
}

const archiveBody = (from: string, to: string) => {
  const time: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T23:00:00Z`); t += 3600_000) time.push(new Date(t).toISOString().slice(0, 16));
  return { hourly: { time, temperature_2m: time.map(() => 27), shortwave_radiation: time.map(() => 100), cloud_cover: time.map(() => 50), wind_speed_10m: time.map(() => 5), precipitation: time.map(() => 0), relative_humidity_2m: time.map(() => 80), et0_fao_evapotranspiration: time.map(() => 0.1) } };
};

test('archive weather: fetched once per range, then served from the cache', async () => {
  resetArchiveRetries();
  const store = memoryStore();
  const urls: string[] = [];
  const fetcher = async (url: string) => {
    urls.push(url);
    const q = new URL(url).searchParams;
    return new Response(JSON.stringify(archiveBody(q.get('start_date')!, q.get('end_date')!)));
  };
  const now = Date.parse('2026-10-30T03:00:00Z');
  const times = [Date.parse('2026-09-10T00:00:00Z'), Date.parse('2026-09-11T10:00:00Z')];
  const first = await archiveWeather(-7.72, 110.36, times, { store, fetcher, now });
  assert.equal(urls.length, 1);
  assert.match(urls[0], /archive-api\.open-meteo\.com.*start_date=2026-09-09.*end_date=2026-09-12/);
  assert.match(urls[0], /relative_humidity_2m/);
  assert.equal(first.length, 4 * 24);
  assert.equal(first[0].humidity, 80);
  const again = await archiveWeather(-7.72, 110.36, times, { store, fetcher, now });
  assert.equal(urls.length, 1);
  assert.equal(again.length, first.length);
});

test('archive weather: no fetcher means cached days only, and recent days are left to the forecast', async () => {
  resetArchiveRetries();
  const store = memoryStore();
  const now = Date.parse('2026-10-30T03:00:00Z');
  assert.deepEqual(await archiveWeather(-7.72, 110.36, [Date.parse('2026-09-10T00:00:00Z')], { store, fetcher: null, now }), []);
  let calls = 0;
  await archiveWeather(-7.72, 110.36, [now - 3600_000], { store, fetcher: async () => (calls++, new Response('{}')), now });
  assert.equal(calls, 0);
});

test('archive weather: a failing archive is not asked again at once', async () => {
  resetArchiveRetries();
  const store = memoryStore();
  let calls = 0;
  const fetcher = async () => (calls++, new Response('{}', { status: 500 }));
  const quiet = console.error;
  console.error = () => {};
  const now = Date.parse('2026-10-30T03:00:00Z');
  await archiveWeather(1, 2, [Date.parse('2026-09-10T00:00:00Z')], { store, fetcher, now });
  await archiveWeather(1, 2, [Date.parse('2026-09-10T00:00:00Z')], { store, fetcher, now: now + 60_000 });
  console.error = quiet;
  assert.equal(calls, 1);
  assert.equal(store.saved.length, 0);
});

// ---------- pond photo ----------

test('pond photo guard: only fixed choices, unsure fields stay empty, notes from light and colour', () => {
  const d = guardPondPhoto({ is_pond: true, container: 'terpal', place: 'roofed', water_color: 'green', light: 'bright', unsure: ['place'], problems: [] }, { model: 'm', mode: 'meta' });
  assert.equal(d.kind, 'terpal');
  assert.equal(d.place, null);
  assert.deepEqual(d.unsure, ['place']);
  assert.ok(d.notes.some((n) => /redup/.test(n)));
  assert.ok(d.notes.some((n) => /aerasi/.test(n)));
  const odd = guardPondPhoto({ is_pond: true, container: 'kolam renang', place: 'indoor', water_color: 'ungu', light: null, unsure: [], problems: [] }, { model: 'm', mode: 'meta' });
  assert.deepEqual([odd.kind, odd.waterColor, odd.place], [null, null, 'indoor']);
  const notPond = guardPondPhoto({ is_pond: false, container: 'beton', place: 'open', water_color: 'clear', light: 'bright', unsure: [], problems: [] }, { model: 'm', mode: 'meta' });
  assert.equal(notPond.kind, null);
  assert.equal(notPond.notPond, true);
  assert.equal(notPond.notes.length, 0);
});

test('pond photo: notes carry no diagnosis or dose, the mock is labelled, places map to the profile', () => {
  const d = guardPondPhoto(mockPondPhoto(), { model: 'mock', mode: 'mock' });
  assert.ok(d.problems.some((p) => /Mode contoh, bukan hasil AI/.test(p)));
  for (const n of d.notes) assert.doesNotMatch(n, /obat|dosis|penyakit|infeksi/i);
  assert.deepEqual(placeToSetting('roofed'), { setting: 'outdoor', shaded: true });
  assert.deepEqual(placeToSetting('indoor'), { setting: 'indoor', shaded: null });
  const en = withLang('en', () => guardPondPhoto(mockPondPhoto(), { model: 'mock', mode: 'mock' }));
  assert.ok(en.notes.some((n) => /calmer in dim light/.test(n)));
});

// ---------- weekly pattern ----------

function patternPondOf(name: string, over: Partial<ThermalModel> = {}): PatternPond {
  const p = pondType(name);
  const { readings } = synthPond(p, weather);
  const model = { ...learn(map, p.profile, readings, tz), ...over };
  return { id: 2, name: 'Kolam B', exposure: 'roofed', kind: 'terpal', light: 'bright', waterColor: 'clear', model, hours: measuringHours(model, weather, readings, start + 34 * DAY, tz) };
}

test('rules pattern: names the part of the day the pond runs warmer, and a time to measure', () => {
  const p = patternPondOf('Roofed tank', { byPart: [
    { part: 'morning', n: 10, bias: 0.1, typical: 0.3 },
    { part: 'midday', n: 4, bias: 1.5, typical: 1.8 },
    { part: 'afternoon', n: 10, bias: 0.4, typical: 0.6 },
    { part: 'night', n: 0, bias: 0, typical: 0 },
  ] });
  const note = rulesPattern(p, start);
  assert.match(note.text, /^Kolam B biasanya sekitar 1,5 °C lebih panas dari perkiraan di siang hari, kemungkinan kena matahari langsung\./);
  assert.match(note.text, /Ukur sekali sekitar jam \d\d\.00/);
  assert.equal(note.checkTime, p.hours[0].time);
  const en = withLang('en', () => rulesPattern(p, start));
  assert.match(en.text, /Kolam B is usually about 1.5 °C warmer than the estimate at midday, probably from direct sun\./);
});

test('rules pattern: too few readings says so, with no time to measure', () => {
  const p = patternPondOf('Concrete', { backtest: { n: 2, typical: 0.4, bias: 0, rmse: 0.3 } });
  const note = rulesPattern(p, start);
  assert.match(note.text, /Belum cukup ukuran/);
  assert.equal(note.checkTime, null);
});

test('pattern guard: invented numbers, wrong times, oxygen and long texts are refused', () => {
  const p = patternPondOf('Roofed tank');
  const time = p.hours[0].time;
  const typical = String(p.model.typicalError).replace('.', ',');
  assert.ok(guardPattern(p, { text: `Kolam B biasanya meleset ±${typical} °C. Ukur sekitar jam ${time.replace(':', '.')}.`, check_time: time }));
  assert.equal(guardPattern(p, { text: 'Kolam B selalu 3,7 °C lebih panas dari perkiraan di siang hari.', check_time: null }), null);
  assert.equal(guardPattern(p, { text: 'Kolam B lebih panas di siang hari. Ukur sekitar jam 03.00.', check_time: '03:00' }), null);
  assert.equal(guardPattern(p, { text: 'Kolam B lebih panas di siang hari, oksigen air turun.', check_time: null }), null);
  assert.equal(guardPattern(p, { text: 'Satu kalimat. Dua kalimat. Tiga kalimat. Empat terlalu banyak.', check_time: null }), null);
  // Three sentences: the middle one (filler) is dropped, the pattern and the time to measure stay.
  const three = guardPattern(p, { text: `Kolam B biasanya meleset ±${typical} °C. Siang dan malam belum cukup ukuran. Ukur sekitar jam ${time.replace(':', '.')}.`, check_time: time });
  assert.equal(three?.text, `Kolam B biasanya meleset ±${typical} °C. Ukur sekitar jam ${time.replace(':', '.')}.`);
  assert.equal(guardPattern(p, { text: 'Beri obat antibiotik ke Kolam B setiap siang hari.', check_time: null }), null);
  assert.ok(numbersOk('jam 13.00, 1,5 °C', [13, 0, 1.5]));
  // A time of day with fewer than 3 readings gives the agent no number to use.
  const thin = patternPondOf('Roofed tank', { byPart: [{ part: 'midday', n: 1, bias: -2.3, typical: 2.7 }, { part: 'morning', n: 10, bias: 0.5, typical: 0.6 }, { part: 'afternoon', n: 10, bias: 0, typical: 0.3 }, { part: 'night', n: 0, bias: 0, typical: 0 }] });
  assert.equal(guardPattern(thin, { text: 'Kolam B 2,3 °C lebih dingin di siang hari.', check_time: null }), null);
});

test('pattern agent: a tool-calling run is guarded, and a bad note falls back to the rules', async () => {
  const p = patternPondOf('Roofed tank');
  const time = p.hours[0].time;
  let turn = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      turn++;
      const calls =
        turn === 1
          ? [{ id: 'a', type: 'function', function: { name: 'get_pond_errors', arguments: JSON.stringify({ pond_id: 2 }) } }]
          : [{ id: 'b', type: 'function', function: { name: 'submit_patterns', arguments: JSON.stringify({ ponds: [{ pond_id: 2, text: `Kolam B kemungkinan kena matahari di siang hari. Ukur sekali sekitar jam ${time.replace(':', '.')}.`, check_time: time }] }) } }];
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: '', tool_calls: calls } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const [note] = await runPatterns({ farmName: 'Uji', now: start, timezone: tz, ponds: [p] }, [{ name: 'baseten', apiKey: 'k', base, model: 'muse-spark-open' }]);
  server.close();
  assert.equal(note.source, 'agent');
  assert.equal(note.checkTime, time);
  assert.deepEqual(note.steps.map((s) => s.tool), ['get_pond_errors', 'submit_patterns']);
  // No provider: the rules; mock mode: the rules text, labelled as a sample.
  assert.equal((await runPatterns({ farmName: 'Uji', now: start, timezone: tz, ponds: [p] }, []))[0].source, 'rules');
  assert.equal((await runPatterns({ farmName: 'Uji', now: start, timezone: tz, ponds: [p] }, [], true))[0].source, 'mock');
});
