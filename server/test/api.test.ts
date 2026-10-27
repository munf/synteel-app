import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApi } from '../src/api.ts';
import { openDb, repo } from '../src/db.ts';

function setup(nowIso = '2026-10-28T03:00:00Z') {
  const api = createApi(repo(openDb(':memory:')), () => new Date(nowIso));
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
