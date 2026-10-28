import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApi } from '../src/api.ts';
import { openDb, repo } from '../src/db.ts';

function setup(nowIso = '2026-10-28T03:00:00Z') {
  const api = createApi(repo(openDb(':memory:')), { clock: () => new Date(nowIso), getWeather: async () => ({ hours: [], fetchedAt: 0 }), geocode: async () => null });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await api.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: res.status === 204 ? null : await res.json() };
  };
  return call;
}

test('setup flow: farm, pond, batch, log, assessment', async () => {
  const call = setup();
  assert.equal((await call('GET', '/farm')).json.farm, null);

  await call('PUT', '/farm', { name: 'Tambak Mitra Jogja', locationName: 'Sleman' });
  const pond = (await call('POST', '/ponds', { name: 'Kolam A', kind: 'fiber', volumeL: 870 })).json.pond;
  assert.equal(pond.level, 'info'); // no readings yet

  const batched = (await call('POST', `/ponds/${pond.id}/batches`, { phase: 'glass_eel', stockedAt: '2026-10-07', initialCount: 500 })).json.pond;
  assert.equal(batched.program.week, 3);
  assert.equal(batched.program.stage.name, 'Transisi pasta');

  const logged = await call('POST', `/ponds/${pond.id}/logs`, {
    readings: { temperature: 30.5, ph: 7.4, tds: 150 },
    mortality: 4,
    behavior: ['surfacing'],
    feeding: { leftover: 'little' },
  });
  assert.equal(logged.status, 201);
  assert.equal(logged.json.pond.level, 'critical');
  assert.equal(logged.json.pond.program.estimatedAlive, 496);
  assert.equal(logged.json.pond.latest.temperature.value, 30.5);
  assert.deepEqual(
    logged.json.pond.findings.map((f: { id: string }) => f.id).sort(),
    ['mortality', 'sign:low_do', 'threshold:temperature'],
  );

  const farm = (await call('GET', '/farm')).json;
  assert.equal(farm.today, '2026-10-28');
  assert.equal(farm.ponds.length, 1);
});

test('elver batches have no glass eel program stage', async () => {
  const call = setup();
  await call('PUT', '/farm', { name: 'T' });
  const pond = (await call('POST', '/ponds', { name: 'B' })).json.pond;
  const res = (await call('POST', `/ponds/${pond.id}/batches`, { phase: 'elver', stockedAt: '2026-09-01' })).json.pond;
  assert.equal(res.program.stage, null);
  assert.equal(res.program.estimatedAlive, null);
});

test('validation errors return 400 with an Indonesian message', async () => {
  const call = setup();
  await call('PUT', '/farm', { name: 'T' });
  const pond = (await call('POST', '/ponds', { name: 'A' })).json.pond;
  assert.deepEqual(await call('POST', `/ponds/${pond.id}/logs`, { readings: { ph: 20 } }), { status: 400, json: { error: 'ph tidak valid' } });
  assert.deepEqual(await call('POST', `/ponds/${pond.id}/logs`, {}), { status: 400, json: { error: 'Catatan kosong' } });
  assert.equal((await call('POST', '/ponds', {})).status, 400);
  assert.equal((await call('POST', '/ponds/999/logs', { mortality: 1 })).status, 404);
});

test('archived ponds disappear from the farm', async () => {
  const call = setup();
  await call('PUT', '/farm', { name: 'T' });
  const pond = (await call('POST', '/ponds', { name: 'A' })).json.pond;
  assert.equal((await call('DELETE', `/ponds/${pond.id}`)).status, 204);
  assert.equal((await call('GET', '/farm')).json.ponds.length, 0);
});

test('pond profile: partial update keeps the other fields', async () => {
  const call = setup();
  await call('PUT', '/farm', { name: 'Tambak', locationName: 'Sleman' });
  const pond = (await call('POST', '/ponds', { name: 'Kolam C', setting: 'outdoor', shaded: true, aeration: 'full', depthCm: 30, areaM2: 12 })).json.pond;
  assert.equal(pond.setting, 'outdoor');
  assert.equal(pond.shaded, true);
  const updated = (await call('PUT', `/ponds/${pond.id}`, { aeration: 'partial' })).json.pond;
  assert.equal(updated.aeration, 'partial');
  assert.equal(updated.depthCm, 30);
  assert.equal(updated.shaded, true);
  assert.equal((await call('PUT', `/ponds/${pond.id}`, { setting: 'cave' })).status, 400);
});

test('a quick check with the aerator off is critical, and the nowcast works without weather', async () => {
  const call = setup();
  await call('PUT', '/farm', { name: 'Tambak', locationName: 'Sleman' });
  const pond = (await call('POST', '/ponds', { name: 'Kolam C', setting: 'outdoor', aeration: 'full' })).json.pond;
  const logged = await call('POST', `/ponds/${pond.id}/logs`, { behavior: ['normal'], aeration: 'off' });
  assert.equal(logged.json.pond.findings[0].id, 'aeration');
  assert.equal(logged.json.pond.level, 'critical');

  const nc = (await call('GET', '/nowcast')).json;
  assert.equal(nc.weather.available, false);
  assert.match(nc.weather.error, /Lokasi tambak belum diatur/);
  assert.equal(nc.ponds[0].now.level, 'critical');
  assert.equal(nc.ponds[0].now.factors[0].id, 'aeration_off');
});

test('capture returns a draft without saving a log; logs keep their source', async () => {
  const { createAi } = await import('../src/ai.ts');
  const api = createApi(repo(openDb(':memory:')), { clock: () => new Date('2026-10-28T03:00:00Z'), ai: createAi({ chat: [], mock: true }) });
  await api.request('/farm', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Tambak' }) });
  const pond = (await (await api.request('/ponds', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Kolam C' }) })).json()).pond;

  const form = new FormData();
  form.append('kind', 'voice');
  form.append('audio', new Blob(['fake'], { type: 'audio/webm' }), 'a.webm');
  const res = await api.request(`/ponds/${pond.id}/capture`, { method: 'POST', body: form });
  assert.equal(res.status, 200);
  const { draft } = await res.json();
  assert.equal(draft.data.readings.temperature, 28.6);
  assert.match(draft.transcript, /Kolam C/);
  const detail = await (await api.request(`/ponds/${pond.id}`)).json();
  assert.equal(detail.logs.length, 0);

  const noPhoto = new FormData();
  noPhoto.append('kind', 'photo');
  assert.equal((await api.request(`/ponds/${pond.id}/capture`, { method: 'POST', body: noPhoto })).status, 400);

  const saved = await api.request(`/ponds/${pond.id}/logs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...draft.data, source: 'voice' }),
  });
  assert.equal((await saved.json()).log.source, 'voice');
});

test('capture without AI answers 503 with a friendly message', async () => {
  const call = setup();
  await call('PUT', '/farm', { name: 'Tambak' });
  const pond = (await call('POST', '/ponds', { name: 'Kolam C' })).json.pond;
  const res = await call('POST', `/ponds/${pond.id}/capture`, {});
  assert.equal(res.status, 503);
  assert.match(res.json.error, /AI belum aktif/);
});
