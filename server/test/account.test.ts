import assert from 'node:assert/strict';
import { test } from 'node:test';
import { farmWithWorker, server } from './helpers.ts';

test('Hapus akun: a worker leaves without a trace of their name; the farm and its records stay', async () => {
  const f = await farmWithWorker();
  const pond = f.ponds[0];
  const log = (await f.worker('POST', `/ponds/${pond.id}/logs`, { readings: { temperature: 28 } })).json.log;
  await f.worker('POST', '/support', { topic: 'catat', message: 'Suara di Kolam B tidak terbaca', replyPhone: '082222222222' });

  assert.equal((await f.worker('POST', '/auth/delete', { pin: '000000' })).status, 403);
  assert.equal((await f.worker('POST', '/auth/delete', { pin: '135790' })).status, 204);

  assert.equal((await f.worker('GET', '/farm')).status, 401);
  assert.equal(f.store.user(f.workerId), null);
  assert.equal((await f.worker('POST', '/auth/login', { phone: '082222222222', pin: '135790' })).status, 401);
  const members = (await f.owner('GET', '/farm/members')).json.members;
  assert.deepEqual(members.map((m: { name: string }) => m.name), ['Petani Demo']);
  const kept = f.store.farm(f.store.farmIds()[0]).getLog(log.id)!;
  assert.equal(kept.createdBy, null);
  assert.equal(kept.data.readings?.temperature, 28);
  assert.equal((await f.owner('GET', '/farm')).json.ponds.length, 3);
});

test('Hapus akun: the only owner takes the farm, its records and its files; the worker keeps an account without it', async () => {
  const removed: number[] = [];
  const f = await farmWithWorker(undefined, { removeFarmFiles: (id) => removed.push(id) });
  const farmId = (await f.owner('GET', '/auth/me')).json.farm.id;

  assert.equal((await f.owner('POST', '/auth/delete', { pin: '246810' })).status, 204);

  assert.deepEqual(removed, [farmId]);
  assert.equal(f.store.farm(farmId).getFarm(), null);
  assert.equal(f.store.farm(farmId).listPonds().length, 0);
  assert.equal(f.store.userByPhone('6281111111111'), null);
  assert.ok(f.store.user(f.workerId));
  // The worker's session went with the farm; signing in again finds no farm.
  assert.equal((await f.worker('GET', '/farm')).status, 401);
  const me = (await f.worker('POST', '/auth/login', { phone: '082222222222', pin: '135790' })).json;
  assert.deepEqual(me.farms, []);
});

test('Hapus akun: with a second owner the farm stays', async () => {
  const removed: number[] = [];
  const f = await farmWithWorker(undefined, { removeFarmFiles: (id) => removed.push(id) });
  const { code } = (await f.owner('POST', '/farm/invites', { role: 'owner' })).json;
  const second = f.client();
  assert.equal((await second('POST', '/auth/join', { code, name: 'Bu Sari', phone: '083333333333', pin: '112233' })).status, 200);

  assert.equal((await f.owner('POST', '/auth/delete', { pin: '246810' })).status, 204);

  assert.deepEqual(removed, []);
  assert.equal((await second('GET', '/farm')).json.ponds.length, 3);
  assert.equal((await f.worker('GET', '/farm')).json.ponds.length, 3);
});

test('sign-ups are capped per network: 20 an hour, other networks still sign up', async () => {
  const { client } = server();
  const from = (ip: string) => client({ 'cf-connecting-ip': ip });
  for (let i = 0; i < 20; i++) {
    assert.equal((await from('203.0.113.7')('POST', '/auth/register', { name: `Petani ${i}`, phone: `08130000${String(i).padStart(4, '0')}`, pin: '246810' })).status, 201);
  }
  const refused = await from('203.0.113.7')('POST', '/auth/register', { name: 'Petani 21', phone: '081300009999', pin: '246810' });
  assert.equal(refused.status, 429);
  assert.match(refused.json.error, /pendaftaran/);
  assert.equal((await from('198.51.100.4')('POST', '/auth/register', { name: 'Bu Sari', phone: '081300008888', pin: '246810' })).status, 201);
});
