// Team dashboard (admin.ts): the login, masked contacts, demo visitors left out, hidden small regions.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAdmin, eventLog, maskPhone, MIN_FARMS_SHOWN } from '../src/admin.ts';
import { createApi } from '../src/api.ts';
import { openDb, repo } from '../src/db.ts';
import { searchDesa } from '../src/desa.ts';
import { client } from './helpers.ts';

const creds = { user: 'tim', password: 'kata-sandi-panjang-sekali' };

function setup(withCreds = true) {
  const db = openDb(':memory:');
  const store = repo(db);
  const now = { t: new Date('2026-10-31T03:00:00Z') };
  const events = eventLog(db, () => now.t);
  const api = createApi(store, { clock: () => now.t, getWeather: async () => ({ hours: [], fetchedAt: 0 }), geocode: async () => null, getBmkg: async () => { throw new Error('offline'); }, getStorm: async () => [], events });
  const admin = createAdmin(db, { creds: withCreds ? creds : null, now: () => now.t, events, checks: [], fetcher: (async () => new Response('ok')) as typeof fetch });
  return { db, store, now, app: client(api), admin: (headers?: Record<string, string>) => client(admin as unknown as Parameters<typeof client>[0], headers), newApp: () => client(api) };
}

async function signedIn(s: ReturnType<typeof setup>) {
  const a = s.admin();
  assert.equal((await a('POST', '/login', creds)).status, 200);
  return a;
}

test('the dashboard is off without a login in the env file', async () => {
  const s = setup(false);
  assert.equal((await s.admin()('POST', '/login', creds)).status, 404);
  assert.equal((await s.admin()('GET', '/ringkasan')).status, 404);
});

test('admin login: wrong password refused and counted, five tries lock the address, the right one signs in', async () => {
  const s = setup();
  const a = s.admin();
  assert.equal((await a('GET', '/ringkasan')).status, 401);
  for (let i = 0; i < 5; i++) assert.equal((await a('POST', '/login', { user: 'tim', password: 'salah' })).status, 401);
  assert.equal((await a('POST', '/login', creds)).status, 429, 'locked after five wrong tries, even with the right password');
  assert.equal((s.db.prepare("select count(*) as n from events where kind = 'admin_login_failed'").get() as { n: number }).n, 5);
  s.now.t = new Date(s.now.t.getTime() + 16 * 60_000);
  assert.equal((await a('POST', '/login', creds)).status, 200);
  assert.equal((await a('GET', '/me')).json.user, 'tim');
});

test('admin session: a changed cookie is refused, and it ends after 12 hours', async () => {
  const s = setup();
  const a = await signedIn(s);
  assert.equal((await a('GET', '/ringkasan')).status, 200);
  assert.equal((await s.admin({ cookie: 'synteel_session_admin=99999999999999.' + 'a'.repeat(64) })('GET', '/ringkasan')).status, 401);
  s.now.t = new Date(s.now.t.getTime() + 12 * 3600_000 + 1);
  assert.equal((await a('GET', '/ringkasan')).status, 401);
});

test('accounts and farms: contacts masked, demo visitors not counted', async () => {
  const s = setup();
  const owner = s.app;
  await owner('POST', '/auth/register', { name: 'Bu Sumarni', phone: '081234564471', pin: '246810' });
  await owner('PUT', '/farm', { name: 'Tambak Sidat Mitra' });
  await owner('POST', '/ponds', { name: 'Kolam A' });
  s.db.prepare("update users set email = 'sumarni@gmail.com'").run();
  // A "Coba demo" visitor (phone demo-…) is never a user.
  s.db.prepare("insert into users (phone, name, pin_hash, created_at) values ('demo-abc', 'Petani Demo', 'x', ?)").run(s.now.t.toISOString());

  const a = await signedIn(s);
  const akun = (await a('GET', '/akun')).json;
  assert.equal(akun.length, 1);
  assert.equal(akun[0].telepon, '0812-••••-4471');
  assert.equal(akun[0].peran, 'pemilik');
  assert.ok(!JSON.stringify(akun).includes('081234564471') && !JSON.stringify(akun).includes('sumarni@'), 'no full number or address leaves the server');
  const tambak = (await a('GET', '/tambak')).json;
  assert.deepEqual([tambak[0].nama, tambak[0].kolam, tambak[0].pemilikId], ['Tambak Sidat Mitra', 1, akun[0].id]);
  const r = (await a('GET', '/ringkasan')).json;
  assert.deepEqual([r.totalAkun, r.tambak, r.kolam, r.daftarHariIni], [1, 1, 1, 1]);
});

test('failed sign-ins, code mails and the support inbox show on the dashboard', async () => {
  const s = setup();
  await s.app('POST', '/auth/register', { name: 'Bu Sumarni', phone: '081234564471', pin: '246810' });
  await s.newApp()('POST', '/auth/login', { phone: '081234564471', pin: '000000' });
  await s.app('POST', '/support', { topic: 'pin', message: 'Lupa PIN pekerja', replyEmail: 'sumarni@gmail.com' });

  const a = await signedIn(s);
  const k = (await a('GET', '/kesehatan')).json;
  assert.equal(k.login.gagal.at(-1), 1);
  assert.ok(k.vps.ramTotalGb >= 0);

  const b = (await a('GET', '/bantuan')).json;
  assert.equal(b.length, 1);
  assert.deepEqual([b[0].topik, b[0].status, b[0].kontak], ['Masuk dan PIN', 'baru', 'su•••@gmail.com']);
  assert.equal((await a('GET', '/ringkasan')).json.bantuanBelumDibalas, 1);
  assert.equal((await a('POST', `/bantuan/${b[0].id}/status`, { status: 'dibalas' })).status, 200);
  assert.equal((await a('GET', '/ringkasan')).json.bantuanBelumDibalas, 0);
  assert.equal((await a('POST', `/bantuan/${b[0].id}/status`, { status: 'hapus' })).status, 400);
});

test(`region figures skip a kabupaten with fewer than ${MIN_FARMS_SHOWN} farms`, async () => {
  const s = setup();
  const [sleman] = searchDesa('Sleman');
  const [bantul] = searchDesa('Bantul');
  for (let i = 0; i < 4; i++) {
    const c = s.newApp();
    await c('POST', '/auth/register', { name: `Pemilik ${i}`, phone: `08123456700${i}`, pin: '246810' });
    await c('PUT', '/farm', { name: `Tambak ${i}` });
  }
  const ids = (s.db.prepare('select id from farms order by id').all() as { id: number }[]).map((f) => f.id);
  for (const [i, id] of ids.entries()) s.db.prepare('update farms set adm4 = ? where id = ?').run(i < 3 ? sleman.code : bantul.code, id);

  const w = (await (await signedIn(s))('GET', '/wilayah')).json;
  assert.deepEqual(w.sebaran.map((x: { kabupaten: string; tambak: number }) => [x.kabupaten, x.tambak]), [[sleman.kabupaten, 3]]);
  assert.equal(w.tersembunyi, 1);
  assert.ok(!JSON.stringify(w).includes('Tambak 0'), 'no farm names');
});

test('maskPhone keeps the first four and last four digits', () => {
  assert.equal(maskPhone('6285712345678'), '0857-••••-5678');
});
