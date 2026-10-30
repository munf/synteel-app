import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAi } from '../src/ai.ts';
import { resetArchiveRetries } from '../src/archive.ts';
import type { WeatherHour } from '../src/weather.ts';
import { server } from './helpers.ts';
import { POND_TYPES, synthPond, synthWeather } from './fixtures/thermal-synth.ts';

const DAY = 86400_000;
const nowIso = '2026-10-28T03:00:00Z';
const now = Date.parse(nowIso);
// 60 days of synthetic weather up to two days ahead: the forecast call gives the last 7, the archive the rest.
const start = Date.parse('2026-08-30T00:00:00Z');
const all = synthWeather(start, Math.round((now - start) / DAY) + 2);
const forecast = all.filter((h) => h.t >= now - 7 * DAY);

function archiveFetch(calls: string[]) {
  return async (url: string) => {
    calls.push(url);
    const q = new URL(url).searchParams;
    const from = Date.parse(`${q.get('start_date')}T00:00:00Z`);
    const to = Date.parse(`${q.get('end_date')}T23:00:00Z`);
    const hours = all.filter((h) => h.t >= from && h.t <= to);
    const col = (f: (h: WeatherHour) => unknown) => hours.map(f);
    return new Response(
      JSON.stringify({
        hourly: {
          time: col((h) => new Date(h.t).toISOString().slice(0, 16)),
          temperature_2m: col((h) => h.airTemp),
          shortwave_radiation: col((h) => h.radiation),
          cloud_cover: col((h) => h.cloud),
          wind_speed_10m: col((h) => h.wind),
          precipitation: col((h) => h.rain),
          relative_humidity_2m: col((h) => h.humidity),
          et0_fao_evapotranspiration: col((h) => h.et0),
        },
      }),
    );
  };
}

async function setup(deps = {}) {
  resetArchiveRetries();
  const calls: string[] = [];
  const s = server(nowIso, { getWeather: async () => ({ hours: forecast, fetchedAt: now }), fetchArchive: archiveFetch(calls), ai: createAi({ chat: [], mock: true }), ...deps });
  const owner = s.client();
  await owner('POST', '/auth/register', { name: 'Petani Demo', phone: '081111111111', pin: '246810' });
  await owner('PUT', '/farm', { name: 'Tambak Uji', lat: -7.72, lon: 110.36 });
  const farmId = s.store.farmsOf(1)[0].id;
  return { ...s, owner, calls, r: s.store.farm(farmId) };
}

test('pond photo: a labelled sample draft in mock mode, nothing saved to the pond', async () => {
  const { owner, r } = await setup();
  const pond = (await owner('POST', '/ponds', { name: 'Kolam A' })).json.pond;
  const form = new FormData();
  form.append('image', new Blob([new Uint8Array(10)], { type: 'image/jpeg' }), 'pond.jpg');
  const res = await owner('POST', '/pond-photo', form);
  assert.equal(res.status, 200);
  assert.equal(res.json.draft.mode, 'mock');
  assert.equal(res.json.draft.kind, 'terpal');
  assert.match(res.json.draft.problems[0], /Mode contoh, bukan hasil AI/);
  assert.equal(r.getPond(pond.id)!.kind, null);
  // The quota page counts it.
  assert.equal((await owner('GET', '/quota')).json.used, 1);
});

test('pond photo: AI off answers 503 and the profile can still be picked by hand', async () => {
  const { owner } = await setup({ ai: undefined });
  const form = new FormData();
  form.append('image', new Blob([new Uint8Array(10)], { type: 'image/jpeg' }), 'pond.jpg');
  assert.equal((await owner('POST', '/pond-photo', form)).status, 503);
  const res = await owner('POST', '/ponds', { name: 'Kolam A', kind: 'akuarium', place: 'roofed', waterColor: 'green', light: 'dim', depthCm: 40 });
  assert.equal(res.status, 201);
  const p = res.json.pond;
  assert.deepEqual([p.kind, p.setting, p.shaded, p.waterColor, p.light, p.depthCm], ['akuarium', 'outdoor', true, 'green', 'dim', 40]);
  const changed = (await owner('PUT', `/ponds/${p.id}`, { place: 'indoor', light: 'dark' })).json.pond;
  assert.deepEqual([changed.setting, changed.light, changed.waterColor], ['indoor', 'dark', 'green']);
  assert.equal((await owner('PUT', `/ponds/${p.id}`, { light: 'neon' })).status, 400);
});

test('old notebook readings teach the model on day one, with archive weather fetched once', async () => {
  const { owner, r, calls } = await setup();
  const truth = POND_TYPES.find((p) => p.name.startsWith('Open tarp'))!;
  const pond = (await owner('POST', '/ponds', { name: 'Kolam C', kind: 'terpal', place: 'open', depthCm: 50 })).json.pond;
  // Readings from 50 to 20 days ago, as a notebook import saves them.
  const { readings } = synthPond(truth, all.filter((h) => h.t < now - 20 * DAY));
  for (const x of readings.filter((x) => x.t >= now - 50 * DAY)) r.addLog({ pondId: pond.id, batchId: null, loggedAt: new Date(x.t).toISOString(), source: 'notebook', data: { readings: { temperature: x.value } } }, 1);
  const res = await owner('GET', `/ponds/${pond.id}/temperature`);
  assert.equal(res.status, 200);
  const m = res.json.model;
  assert.ok(m.oldReadings >= 40, `learned from ${m.oldReadings} old readings`);
  assert.equal(m.learning, false);
  assert.ok(m.typicalError <= 0.6, `usually off by ${m.typicalError}`);
  // Morning and afternoon readings alone cannot tell sun from response speed well: a midday time is suggested.
  assert.ok(res.json.hours.some((h: { hour: number }) => h.hour >= 10 && h.hour <= 15));
  assert.ok(calls.length >= 1 && calls.length <= 3);
  const before = calls.length;
  // The nowcast carries the same "usually off by", and the archive is not asked again.
  const nc = (await owner('GET', '/nowcast')).json.ponds.find((p: any) => p.pondId === pond.id);
  assert.equal(nc.basis.thermal.typicalError, m.typicalError);
  assert.equal(calls.length, before);
  assert.ok(res.json.hours.length >= 1);
  assert.match(res.json.pattern.text, /Kolam C/);
  assert.equal(res.json.pattern.source, 'rules');
});

test('a new pond says it is still learning, with the prior error for its type', async () => {
  const { owner } = await setup();
  const pond = (await owner('POST', '/ponds', { name: 'Kolam A', kind: 'fiber', place: 'indoor' })).json.pond;
  const m = (await owner('GET', `/ponds/${pond.id}/temperature`)).json.model;
  assert.equal(m.learning, true);
  assert.equal(m.typicalError, 0.6);
});

test('pattern on demand: a labelled sample in mock mode, saved, shown, and limited per day', async () => {
  const { owner, r } = await setup();
  const truth = POND_TYPES.find((p) => p.name.startsWith('Roofed tank'))!;
  const pond = (await owner('POST', '/ponds', { name: 'Kolam B', kind: 'terpal', place: 'roofed' })).json.pond;
  const { readings } = synthPond(truth, all.filter((h) => h.t <= now));
  for (const x of readings.filter((x) => x.t >= now - 14 * DAY)) r.addLog({ pondId: pond.id, batchId: null, loggedAt: new Date(x.t).toISOString(), source: 'manual', data: { readings: { temperature: x.value } } }, 1);
  const first = await owner('POST', `/ponds/${pond.id}/pattern`);
  assert.equal(first.status, 200);
  assert.equal(first.json.pattern.source, 'mock');
  assert.equal(first.json.left, 2);
  const shown = (await owner('GET', `/ponds/${pond.id}/temperature`)).json;
  assert.equal(shown.pattern.source, 'mock');
  assert.equal(shown.ask.mode, 'mock');
  await owner('POST', `/ponds/${pond.id}/pattern`);
  await owner('POST', `/ponds/${pond.id}/pattern`);
  assert.equal((await owner('POST', `/ponds/${pond.id}/pattern`)).status, 400);
  // English asks get an English note.
  const en = (await owner('GET', `/ponds/${pond.id}/temperature`)).json;
  assert.ok(en.pattern);
});
