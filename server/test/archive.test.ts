// "Ubah kolam" and "Hapus kolam": the owner edits a pond, takes it off the list (records kept) and brings it back.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { farmWithWorker } from './helpers.ts';

test('the owner renames a pond and changes its size and aeration', async () => {
  const { owner, ponds } = await farmWithWorker();
  const res = await owner('PUT', `/ponds/${ponds[0].id}`, { name: 'Kolam Depan', areaM2: 12.5, aeration: 'partial', volumeL: 900 });
  assert.equal(res.status, 200);
  assert.deepEqual([res.json.pond.name, res.json.pond.areaM2, res.json.pond.aeration, res.json.pond.volumeL], ['Kolam Depan', 12.5, 'partial', 900]);
});

test('Hapus kolam archives: off the list, records kept, back with Kembalikan; workers cannot', async () => {
  const { owner, worker, ponds } = await farmWithWorker();
  const pond = ponds[1];
  await owner('POST', `/ponds/${pond.id}/logs`, { mortality: 2 });

  assert.equal((await worker('DELETE', `/ponds/${pond.id}`)).status, 403);
  assert.equal((await owner('DELETE', `/ponds/${pond.id}`)).status, 204);
  const farm = (await owner('GET', '/farm')).json;
  assert.ok(!farm.ponds.some((p: { id: number }) => p.id === pond.id), 'gone from the farm list');
  assert.equal((await owner('GET', `/ponds/${pond.id}`)).status, 404);
  assert.deepEqual((await owner('GET', '/ponds/archived')).json.ponds, [{ id: pond.id, name: pond.name }]);
  assert.equal((await owner('DELETE', `/ponds/${pond.id}`)).status, 404, 'already archived');

  assert.equal((await worker('POST', `/ponds/${pond.id}/restore`)).status, 403);
  const back = await owner('POST', `/ponds/${pond.id}/restore`);
  assert.equal(back.status, 200);
  assert.equal(back.json.pond.name, pond.name);
  assert.equal((await owner('GET', `/ponds/${pond.id}`)).json.logs.length, 1, 'records came back with it');
  assert.deepEqual((await owner('GET', '/ponds/archived')).json.ponds, []);
});
