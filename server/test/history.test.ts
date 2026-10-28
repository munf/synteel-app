import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeChanges } from '../src/api.ts';
import { farmWithWorker } from './helpers.ts';

test('ponds get other names: trimmed, no duplicates, at most 5, not another pond’s name', async () => {
  const { owner, worker, ponds } = await farmWithWorker();
  const [, b, c] = ponds;
  const created = (await owner('POST', '/ponds', { name: 'Kolam D', nicknames: ['kolam pojok'] })).json.pond;
  assert.deepEqual(created.nicknames, ['kolam pojok']);
  assert.deepEqual((await owner('GET', '/farm')).json.ponds.find((p: { id: number }) => p.id === b.id).nicknames, []);

  // Any member may add one.
  const added = await worker('POST', `/ponds/${b.id}/nicknames`, { nickname: '  kolam   dekat pintu ' });
  assert.equal(added.status, 200);
  assert.deepEqual(added.json.pond.nicknames, ['kolam dekat pintu']);
  assert.deepEqual((await worker('POST', `/ponds/${b.id}/nicknames`, { nickname: 'Kolam Dekat Pintu' })).json.pond.nicknames, ['kolam dekat pintu']);
  assert.deepEqual((await worker('POST', `/ponds/${b.id}/nicknames`, { nickname: 'kolam b' })).json.pond.nicknames, ['kolam dekat pintu']);

  assert.equal((await worker('POST', `/ponds/${b.id}/nicknames`, { nickname: 'x'.repeat(31) })).status, 400);
  assert.equal((await worker('POST', `/ponds/${b.id}/nicknames`, { nickname: '  ' })).status, 400);
  const clash = await worker('POST', `/ponds/${b.id}/nicknames`, { nickname: 'KOLAM POJOK' });
  assert.equal(clash.status, 400);
  assert.match(clash.json.error, /Kolam D/);
  for (const n of ['satu', 'dua', 'tiga', 'empat']) assert.equal((await worker('POST', `/ponds/${b.id}/nicknames`, { nickname: n })).status, 200);
  assert.equal((await worker('POST', `/ponds/${b.id}/nicknames`, { nickname: 'lima' })).status, 400);

  // The owner's list replaces the old one; other fields stay.
  const put = (await owner('PUT', `/ponds/${c.id}`, { nicknames: ['kolam belakang', 'Kolam Belakang'] })).json.pond;
  assert.deepEqual(put.nicknames, ['kolam belakang']);
  assert.deepEqual((await owner('PUT', `/ponds/${c.id}`, { aeration: 'full' })).json.pond.nicknames, ['kolam belakang']);
  assert.equal((await owner('PUT', `/ponds/${c.id}`, { nicknames: 'kolam' })).status, 400);
  assert.equal((await worker('PUT', `/ponds/${c.id}`, { nicknames: [] })).status, 403);
});

test('history: maker and owner may correct, move, delete and restore; every change is traced', async () => {
  const { owner, worker, ponds, now, workerId } = await farmWithWorker('2026-10-28T10:00:00Z');
  const [a, b, c] = ponds;
  await owner('POST', `/ponds/${c.id}/batches`, { phase: 'elver', stockedAt: '2026-09-01' });
  const ownerLog = (await owner('POST', `/ponds/${b.id}/logs`, { readings: { temperature: 28.4 } })).json.log;
  const mine = (await worker('POST', `/ponds/${b.id}/logs`, { readings: { temperature: 28.9, ph: 7.4 }, source: 'photo', mortality: 2 })).json.log;

  const history = (await worker('GET', `/ponds/${b.id}/history`)).json.logs;
  assert.deepEqual(history.map((l: { id: number }) => l.id), [mine.id, ownerLog.id]);
  const [h, other] = history;
  assert.deepEqual(h.by, { id: workerId, name: 'Pak Joko', role: 'worker' });
  assert.equal(h.canEdit, true);
  assert.equal(h.editableUntil, '2026-10-29T10:00:00.000Z');
  assert.equal(h.level, 'warning'); // 2 dead
  assert.equal(h.source, 'photo');
  assert.equal(other.canEdit, false);
  assert.match(other.lockReason, /^Terkunci: dicatat Petani Demo/);
  assert.equal((await owner('GET', `/ponds/${b.id}/history`)).json.logs[0].editableUntil, null);

  // A worker cannot touch someone else's log.
  const refused = await worker('PUT', `/logs/${ownerLog.id}`, { readings: { temperature: 30 } });
  assert.equal(refused.status, 403);
  assert.match(refused.json.error, /Terkunci/);

  // Correct a number: the trail says what changed, in plain words.
  const fixed = (await worker('PUT', `/logs/${mine.id}`, { readings: { temperature: 29.8, ph: 7.4 }, mortality: 2 })).json.log;
  assert.equal(fixed.data.readings.temperature, 29.8);
  assert.deepEqual(fixed.edits.map((e: { byName: string; text: string }) => [e.byName, e.text]), [['Pak Joko', 'suhu 28,9 → 29,8']]);
  assert.equal((await worker('GET', `/ponds/${b.id}`)).json.pond.latest.temperature.value, 29.8);

  // Taken at the wrong pond: move it to Kolam C, where it joins the active batch.
  assert.equal((await worker('POST', `/logs/${mine.id}/move`, { pondId: b.id })).status, 400);
  const moved = (await worker('POST', `/logs/${mine.id}/move`, { pondId: c.id })).json.log;
  assert.equal(moved.pondId, c.id);
  assert.equal(moved.edits[1].text, 'dipindahkan dari Kolam B');
  assert.equal((await worker('GET', `/ponds/${b.id}/history`)).json.logs.length, 1);
  const pondC = (await worker('GET', `/ponds/${c.id}`)).json;
  assert.equal(pondC.logs[0].batchId, pondC.pond.batch.id);
  assert.equal(pondC.pond.program.totalDead, 2);

  // Delete: gone from history, latest readings, mortality and findings; restore brings it back.
  assert.equal((await worker('DELETE', `/logs/${mine.id}`)).status, 204);
  const afterDelete = (await worker('GET', `/ponds/${c.id}`)).json;
  assert.equal(afterDelete.logs.length, 0);
  assert.equal(afterDelete.pond.latest.temperature, undefined);
  assert.equal(afterDelete.pond.program.totalDead, 0);
  assert.equal((await worker('GET', `/ponds/${c.id}/history`)).json.logs.length, 0);
  assert.equal((await worker('PUT', `/logs/${mine.id}`, { mortality: 1 })).status, 404);
  const restored = (await worker('POST', `/logs/${mine.id}/restore`)).json.log;
  assert.deepEqual(restored.edits.map((e: { text: string }) => e.text).slice(2), ['dihapus', 'dikembalikan']);
  assert.equal((await worker('GET', `/ponds/${c.id}`)).json.pond.latest.temperature.value, 29.8);

  // After 24 hours the maker is locked out; the owner is not.
  now.t = new Date('2026-10-29T10:00:01Z');
  const late = (await worker('GET', `/ponds/${c.id}/history`)).json.logs[0];
  assert.equal(late.canEdit, false);
  assert.match(late.lockReason, /lewat 24 jam/);
  assert.equal((await worker('DELETE', `/logs/${mine.id}`)).status, 403);
  const byOwner = (await owner('PUT', `/logs/${mine.id}`, { readings: { temperature: 29.8, ph: 7.2 }, mortality: 2, feeding: { leftover: 'much' } })).json.log;
  assert.equal(byOwner.edits.at(-1).text, 'pH 7,4 → 7,2, sisa pakan – → banyak');
  assert.equal(byOwner.edits.at(-1).byName, 'Petani Demo');
  assert.equal((await owner('POST', `/logs/${mine.id}/move`, { pondId: a.id })).status, 200);
});

test('logs of another farm are not found', async () => {
  const { worker, ponds, client } = await farmWithWorker();
  const log = (await worker('POST', `/ponds/${ponds[0].id}/logs`, { mortality: 1 })).json.log;
  const stranger = client();
  await stranger('POST', '/auth/register', { name: 'Lain', phone: '084444444444', pin: '975310' });
  await stranger('PUT', '/farm', { name: 'Tambak Lain' });
  const own = (await stranger('POST', '/ponds', { name: 'Kolam X' })).json.pond;
  assert.equal((await stranger('PUT', `/logs/${log.id}`, { mortality: 3 })).status, 404);
  assert.equal((await stranger('DELETE', `/logs/${log.id}`)).status, 404);
  assert.equal((await stranger('POST', `/logs/${log.id}/restore`)).status, 404);
  assert.equal((await stranger('GET', `/ponds/${ponds[0].id}/history`)).status, 404);
  // Nor can a log be moved into another farm's pond.
  assert.equal((await worker('POST', `/logs/${log.id}/move`, { pondId: own.id })).status, 404);
});

test('a deleted log no longer counts for the streak', async () => {
  const { owner, ponds } = await farmWithWorker('2026-10-28T03:00:00Z');
  const log = (await owner('POST', `/ponds/${ponds[0].id}/logs`, { readings: { ph: 7.2 } })).json.log;
  assert.equal((await owner('GET', '/farm')).json.streak, 1);
  await owner('DELETE', `/logs/${log.id}`);
  assert.equal((await owner('GET', '/farm')).json.streak, 0);
});

test('changes are described in plain Indonesian', () => {
  assert.deepEqual(describeChanges({ readings: { tds: 140 }, behavior: ['normal'], note: 'a' }, { readings: { tds: 145 }, behavior: ['surfacing', 'not_eating'], aeration: 'off' }), [
    'TDS 140 → 145',
    'perilaku normal → naik ke permukaan, tidak mau makan',
    'aerator – → mati',
    'catatan dihapus',
  ]);
  assert.deepEqual(describeChanges({ mortality: 2 }, { mortality: 2 }), []);
});
