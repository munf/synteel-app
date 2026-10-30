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

test('Daftar with mail set up: the code from the e-mail creates the account and keeps the address', async () => {
  const sent: { to?: string[]; subject: string; text: string }[] = [];
  const { client, store } = server(undefined, { mail: async (m) => void sent.push(m) });
  const call = client();
  assert.equal((await call('GET', '/auth/options')).json.email, true);

  assert.equal((await call('POST', '/auth/code', { phone: '0813 1111 2222', email: 'bukan-email' })).status, 400);
  const asked = await call('POST', '/auth/code', { phone: '0813 1111 2222', email: ' Sari.Tambak@Gmail.com ' });
  assert.equal(asked.status, 200);
  assert.equal(asked.json.sentTo, 'sa•••@gmail.com');
  assert.deepEqual(sent[0].to, ['sari.tambak@gmail.com']);
  const code = sent[0].subject.match(/\d{6}/)![0];
  assert.ok(sent[0].text.includes(code));

  const form = { name: 'Bu Sari', phone: '081311112222', pin: '246810', email: 'sari.tambak@gmail.com' };
  assert.equal((await call('POST', '/auth/register', form)).json.code, 'code_wrong');
  // The code belongs to the address it went to.
  assert.equal((await call('POST', '/auth/register', { ...form, email: 'lain@gmail.com', emailCode: code })).json.code, 'code_expired');
  await call('POST', '/auth/code', { phone: '0813 1111 2222', email: 'sari.tambak@gmail.com' });
  const fresh = sent[1].subject.match(/\d{6}/)![0];
  const made = await call('POST', '/auth/register', { ...form, emailCode: fresh });
  assert.equal(made.status, 201);
  assert.equal(made.json.user.name, 'Bu Sari');
  assert.equal(store.userByPhone('6281311112222')!.email, 'sari.tambak@gmail.com');
  assert.equal((await call('POST', '/auth/register', { ...form, emailCode: fresh })).status, 409);
  assert.equal((await call('POST', '/auth/code', { phone: '081311112222', email: 'x@y.co' })).json.code, 'phone_taken');
});

test('Lupa PIN: a code to the account e-mail sets a new PIN, signs in and ends other sessions', async () => {
  const sent: { to?: string[]; subject: string; text: string }[] = [];
  const { client } = server(undefined, { mail: async (m) => void sent.push(m) });
  const owner = client();
  await owner('POST', '/auth/code', { phone: '081311112222', email: 'sari@gmail.com' });
  await owner('POST', '/auth/register', { name: 'Bu Sari', phone: '081311112222', pin: '246810', email: 'sari@gmail.com', emailCode: sent[0].subject.match(/\d{6}/)![0] });
  assert.equal((await owner('GET', '/auth/me')).status, 200);

  const phone = client();
  const asked = await phone('POST', '/auth/code', { purpose: 'reset', phone: '0813-1111-2222' });
  assert.equal(asked.json.sentTo, 'sa•••@gmail.com');
  assert.deepEqual(sent[1].to, ['sari@gmail.com']);
  assert.match(sent[1].text, /PIN lama tetap berlaku/);
  const code = sent[1].subject.match(/\d{6}/)![0];
  assert.equal((await phone('POST', '/auth/reset', { phone: '081311112222', code, pin: '123456' })).status, 400);
  const done = await phone('POST', '/auth/reset', { phone: '081311112222', code, pin: '975310' });
  assert.equal(done.status, 200);
  assert.equal(done.json.user.name, 'Bu Sari');
  assert.equal((await phone('POST', '/auth/reset', { phone: '081311112222', code, pin: '975310' })).json.code, 'code_expired');
  assert.equal((await owner('GET', '/auth/me')).status, 401);
  assert.equal((await client()('POST', '/auth/login', { phone: '081311112222', pin: '975310' })).status, 200);

  // A number without an e-mail (a worker who joined with a code) is sent to the owner or support.
  assert.equal((await client()('POST', '/auth/code', { purpose: 'reset', phone: '089999999999' })).json.code, 'no_email');
});

test('codes by e-mail are capped: 5 an hour per number, and five wrong tries end a code', async () => {
  const sent: { subject: string }[] = [];
  const { client } = server(undefined, { mail: async (m) => void sent.push(m) });
  const call = client();
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/auth/code', { phone: '081311112222', email: 'sari@gmail.com' })).status, 200);
  assert.equal((await call('POST', '/auth/code', { phone: '081311112222', email: 'sari@gmail.com' })).status, 429);

  const form = { name: 'Bu Sari', phone: '081311112222', pin: '246810', email: 'sari@gmail.com' };
  const right = sent[4].subject.match(/\d{6}/)![0];
  const wrong = right === '111111' ? '222222' : '111111';
  for (let i = 0; i < 4; i++) assert.equal((await call('POST', '/auth/register', { ...form, emailCode: wrong })).json.code, 'code_wrong');
  assert.equal((await call('POST', '/auth/register', { ...form, emailCode: wrong })).json.code, 'code_expired');
  assert.equal((await call('POST', '/auth/register', { ...form, emailCode: right })).status, 410);
});

test('without mail Daftar works as before and Lupa PIN by e-mail says it is not available', async () => {
  const { client } = server();
  const call = client();
  assert.equal((await call('GET', '/auth/options')).json.email, false);
  assert.equal((await call('POST', '/auth/register', { name: 'Pak Joko', phone: '081234567890', pin: '246810' })).status, 201);
  assert.equal((await client()('POST', '/auth/code', { purpose: 'reset', phone: '081234567890' })).json.code, 'no_mail');
});

test('a failed e-mail says so and creates nothing', async () => {
  const { client, store } = server(undefined, { mail: async () => { throw new Error('535 auth failed'); } });
  const res = await client()('POST', '/auth/code', { phone: '081311112222', email: 'sari@gmail.com' });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /Email gagal dikirim/);
  assert.equal(store.userByPhone('6281311112222'), null);
});
