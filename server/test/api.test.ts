import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApi } from '../src/api.ts';
import { openDb, repo } from '../src/db.ts';

type Api = ReturnType<typeof createApi>;

/** Calls the API like a phone does: keeps the session cookie between requests. */
function client(api: Api) {
  let cookie = '';
  return async (method: string, path: string, body?: unknown) => {
    const form = body instanceof FormData;
    const res = await api.request(path, {
      method,
      headers: { ...(body !== undefined && !form && { 'content-type': 'application/json' }), ...(cookie && { cookie }) },
      body: body === undefined ? undefined : form ? (body as FormData) : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, json: res.status === 204 ? null : await res.json() };
  };
}

function server(nowIso = '2026-10-28T03:00:00Z', deps: Parameters<typeof createApi>[1] = {}) {
  const store = repo(openDb(':memory:'));
  const api = createApi(store, { clock: () => new Date(nowIso), getWeather: async () => ({ hours: [], fetchedAt: 0 }), geocode: async () => null, ...deps });
  return { store, api, client: () => client(api) };
}

/** A signed-in farmer with no farm yet. */
async function setup(nowIso?: string, deps?: Parameters<typeof createApi>[1]) {
  const call = server(nowIso, deps).client();
  await call('POST', '/auth/register', { name: 'Pak Joko', phone: '0812 3456 7890', pin: '246810' });
  return call;
}

test('setup flow: farm, pond, batch, log, assessment', async () => {
  const call = await setup();
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
  const call = await setup();
  await call('PUT', '/farm', { name: 'T' });
  const pond = (await call('POST', '/ponds', { name: 'B' })).json.pond;
  const res = (await call('POST', `/ponds/${pond.id}/batches`, { phase: 'elver', stockedAt: '2026-09-01' })).json.pond;
  assert.equal(res.program.stage, null);
  assert.equal(res.program.estimatedAlive, null);
});

test('validation errors return 400 with an Indonesian message', async () => {
  const call = await setup();
  await call('PUT', '/farm', { name: 'T' });
  const pond = (await call('POST', '/ponds', { name: 'A' })).json.pond;
  assert.deepEqual(await call('POST', `/ponds/${pond.id}/logs`, { readings: { ph: 20 } }), { status: 400, json: { error: 'ph tidak valid' } });
  assert.deepEqual(await call('POST', `/ponds/${pond.id}/logs`, {}), { status: 400, json: { error: 'Catatan kosong' } });
  assert.equal((await call('POST', '/ponds', {})).status, 400);
  assert.equal((await call('POST', '/ponds/999/logs', { mortality: 1 })).status, 404);
});

test('archived ponds disappear from the farm', async () => {
  const call = await setup();
  await call('PUT', '/farm', { name: 'T' });
  const pond = (await call('POST', '/ponds', { name: 'A' })).json.pond;
  assert.equal((await call('DELETE', `/ponds/${pond.id}`)).status, 204);
  assert.equal((await call('GET', '/farm')).json.ponds.length, 0);
});

test('pond profile: partial update keeps the other fields', async () => {
  const call = await setup();
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
  const call = await setup();
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
  const call = await setup(undefined, { ai: createAi({ chat: [], mock: true }) });
  await call('PUT', '/farm', { name: 'Tambak' });
  const pond = (await call('POST', '/ponds', { name: 'Kolam C' })).json.pond;

  const form = new FormData();
  form.append('kind', 'voice');
  form.append('audio', new Blob(['fake'], { type: 'audio/webm' }), 'a.webm');
  const res = await call('POST', `/ponds/${pond.id}/capture`, form);
  assert.equal(res.status, 200);
  const { draft } = res.json;
  assert.equal(draft.data.readings.temperature, 28.6);
  assert.match(draft.transcript, /Kolam C/);
  assert.equal((await call('GET', `/ponds/${pond.id}`)).json.logs.length, 0);

  const noPhoto = new FormData();
  noPhoto.append('kind', 'photo');
  assert.equal((await call('POST', `/ponds/${pond.id}/capture`, noPhoto)).status, 400);

  const saved = await call('POST', `/ponds/${pond.id}/logs`, { ...draft.data, source: 'voice' });
  assert.equal(saved.json.log.source, 'voice');
});

test('capture without AI answers 503 with a friendly message', async () => {
  const call = await setup();
  await call('PUT', '/farm', { name: 'Tambak' });
  const pond = (await call('POST', '/ponds', { name: 'Kolam C' })).json.pond;
  const res = await call('POST', `/ponds/${pond.id}/capture`, {});
  assert.equal(res.status, 503);
  assert.equal(res.json.code, 'ai_unavailable');
  assert.match(res.json.error, /AI belum aktif/);
});

// ---------- accounts ----------

test('without a session everything but sign-in answers 401', async () => {
  const call = server().client();
  assert.equal((await call('GET', '/farm')).status, 401);
  assert.equal((await call('GET', '/auth/options')).json.demo, false);
  assert.equal((await call('POST', '/auth/login', { phone: '0812', pin: '246810' })).status, 400);
});

test('register, sign out, sign in again; PINs are checked and guessing is slowed down', async () => {
  const { client } = server();
  const call = client();
  assert.equal((await call('POST', '/auth/register', { name: 'A', phone: '0812-3456-7890', pin: '111111' })).status, 400);
  const reg = await call('POST', '/auth/register', { name: 'Pak Joko', phone: '0812-3456-7890', pin: '246810' });
  assert.equal(reg.status, 201);
  assert.equal(reg.json.user.phone, '6281234567890');
  const taken = await call('POST', '/auth/register', { name: 'B', phone: '+62 812 3456 7890', pin: '135790' });
  assert.equal(taken.status, 409);
  assert.equal(taken.json.code, 'phone_taken');
  assert.equal((await call('POST', '/auth/logout')).status, 204);
  assert.equal((await call('GET', '/farm')).status, 401);

  const other = client();
  for (let i = 0; i < 5; i++) assert.equal((await other('POST', '/auth/login', { phone: '081234567890', pin: '000001' })).status, 401);
  const locked = await other('POST', '/auth/login', { phone: '081234567890', pin: '246810' });
  assert.equal(locked.status, 429);
  assert.equal(locked.json.code, 'locked');
  assert.ok(Date.parse(locked.json.retryAt) > Date.now() + 14 * 60_000);
  assert.equal((await client()('POST', '/auth/login', { phone: '081234567890', pin: '246810' })).status, 429);
});

test('owner invites a worker; the worker logs but cannot change ponds; other farms stay private', async () => {
  const { client } = server();
  const owner = client();
  await owner('POST', '/auth/register', { name: 'Pemilik', phone: '081111111111', pin: '246810' });
  assert.equal((await owner('PUT', '/farm', { name: 'Tambak Mitra' })).status, 201);
  const pond = (await owner('POST', '/ponds', { name: 'Kolam A' })).json.pond;
  const { code } = (await owner('POST', '/farm/invites', { role: 'worker' })).json;
  assert.match(code, /^[A-Z2-9]{6}$/);

  const worker = client();
  assert.equal((await worker('GET', `/auth/invite/${code}`)).json.farmName, 'Tambak Mitra');
  const joined = await worker('POST', '/auth/join', { code, name: 'Pak Slamet', phone: '082222222222', pin: '135790' });
  assert.equal(joined.json.farm.role, 'worker');
  const used = await worker('POST', '/auth/join', { code, name: 'X', phone: '083333333333', pin: '135790' });
  assert.equal(used.status, 410);
  assert.equal(used.json.code, 'invite_invalid');
  const unknown = await client()('GET', '/auth/invite/ZZZZZZ');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.code, 'invite_invalid');
  assert.equal((await worker('POST', `/ponds/${pond.id}/logs`, { mortality: 1 })).status, 201);
  assert.equal((await worker('POST', '/ponds', { name: 'Kolam Z' })).status, 403);
  assert.equal((await worker('GET', '/farm/members')).json.members.find((m: { role: string }) => m.role === 'owner').phone, undefined);

  // The owner resets a forgotten PIN: old sessions end, the temporary PIN works.
  const workerId = joined.json.user.id;
  const { pin } = (await owner('POST', `/farm/members/${workerId}/pin`)).json;
  assert.equal((await worker('GET', '/farm')).status, 401);
  assert.equal((await client()('POST', '/auth/login', { phone: '082222222222', pin })).status, 200);

  const stranger = client();
  await stranger('POST', '/auth/register', { name: 'Lain', phone: '084444444444', pin: '975310' });
  await stranger('PUT', '/farm', { name: 'Tambak Lain' });
  assert.equal((await stranger('GET', `/ponds/${pond.id}`)).status, 404);
  assert.equal((await stranger('POST', `/ponds/${pond.id}/logs`, { mortality: 1 })).status, 404);
  assert.equal((await stranger('GET', '/farm')).json.ponds.length, 0);

  assert.equal((await owner('DELETE', `/farm/members/${workerId}`)).status, 204);
  const again = client();
  await again('POST', '/auth/login', { phone: '082222222222', pin });
  assert.equal((await again('GET', '/farm')).json.farm, null);
});

test('demo login enters the shared demo farm', async () => {
  const { store, client } = server(undefined, { demoPhone: '620000000000' });
  const demo = store.createUser({ phone: '620000000000', name: 'Petani Demo', pinHash: 'x' });
  store.createFarm({ name: 'Tambak Demo', locationName: null, lat: null, lon: null, timezone: 'Asia/Jakarta' }, demo.id);
  const call = client();
  assert.equal((await call('GET', '/auth/options')).json.demo, true);
  const me = (await call('POST', '/auth/demo')).json;
  assert.equal(me.demo, true);
  assert.equal((await call('GET', '/farm')).json.farm.name, 'Tambak Demo');
  assert.equal((await call('PUT', '/auth/pin', { pin: 'x', newPin: '135790' })).status, 403);
});

test('a single-farm database from before accounts becomes farm 1 with its ponds', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const path = join(mkdtempSync(join(tmpdir(), 'synteel-')), 'old.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`create table farm (id integer primary key check (id = 1), name text not null, location_name text, lat real, lon real, timezone text not null default 'Asia/Jakarta');
    create table ponds (id integer primary key, name text not null, kind text, volume_l real, archived integer not null default 0);
    insert into farm (id, name) values (1, 'Tambak Lama'); insert into ponds (name) values ('Kolam A');`);
  old.close();
  const store = repo(openDb(path));
  assert.equal(store.farm(1).getFarm()?.name, 'Tambak Lama');
  assert.equal(store.farm(1).listPonds()[0].name, 'Kolam A');
});

test('each farm has its own daily AI cap', async () => {
  const { toDraft } = await import('../src/ai.ts');
  const ai = {
    mode: 'meta' as const,
    draft: async () => toDraft({ temperature: 27 }, 'meta'),
    round: async () => ({ transcript: '', drafts: [], loose: null, empty: true, model: 'test', mode: 'meta' as const }),
    transcribe: async () => ' kolam B tidak terbaca ',
  };
  const { client } = server(undefined, { ai, farmAiCap: 1 });
  const photo = () => {
    const f = new FormData();
    f.append('kind', 'photo');
    f.append('image', new Blob(['x'], { type: 'image/jpeg' }), 'a.jpg');
    return f;
  };
  const farmer = async (phone: string) => {
    const call = client();
    await call('POST', '/auth/register', { name: 'P', phone, pin: '246810' });
    await call('PUT', '/farm', { name: `Tambak ${phone}` });
    const pond = (await call('POST', '/ponds', { name: 'A' })).json.pond;
    return () => call('POST', `/ponds/${pond.id}/capture`, photo());
  };
  const a = await farmer('081111111111');
  const b = await farmer('082222222222');
  assert.equal((await a()).status, 200);
  const refused = await a();
  assert.equal(refused.status, 429);
  assert.equal(refused.json.code, 'ai_quota');
  assert.match(refused.json.error, /Jatah baca AI/);
  assert.equal((await b()).status, 200);
});

test('a spoken help message becomes text and does not use the farm quota', async () => {
  const { toDraft } = await import('../src/ai.ts');
  const ai = {
    mode: 'meta' as const,
    draft: async () => toDraft({ temperature: 27 }, 'meta'),
    round: async () => ({ transcript: '', drafts: [], loose: null, empty: true, model: 'test', mode: 'meta' as const }),
    transcribe: async () => ' kolam B tidak terbaca ',
  };
  const { client } = server(undefined, { ai, farmAiCap: 1 });
  const call = client();
  const audio = () => {
    const f = new FormData();
    f.append('audio', new Blob(['x'], { type: 'audio/wav' }), 'a.wav');
    return f;
  };
  assert.equal((await call('POST', '/transcribe', audio())).status, 401);
  await call('POST', '/auth/register', { name: 'P', phone: '083333333333', pin: '246810' });
  await call('PUT', '/farm', { name: 'Tambak P' });
  for (let i = 0; i < 3; i++) {
    const res = await call('POST', '/transcribe', audio());
    assert.equal(res.status, 200);
    assert.equal(res.json.text, 'kolam B tidak terbaca');
  }
});

test('a signed-in account joins another farm with a code from Profil or "Siapkan tambak", after seeing its name', async () => {
  const { client } = server();
  const owner = client();
  await owner('POST', '/auth/register', { name: 'Pemilik', phone: '081111111111', pin: '246810' });
  await owner('PUT', '/farm', { name: 'Tambak Mitra' });
  const { code } = (await owner('POST', '/farm/invites', { role: 'worker' })).json;

  // A new account with no farm yet joins instead of making its own.
  const fresh = client();
  await fresh('POST', '/auth/register', { name: 'Pak Slamet', phone: '082222222222', pin: '135790' });
  assert.equal((await fresh('GET', '/auth/me')).json.farm, null);
  assert.equal((await fresh('GET', `/auth/invite/${code}`)).json.farmName, 'Tambak Mitra');
  const joined = await fresh('POST', '/farm/join', { code: code.toLowerCase() });
  assert.equal(joined.status, 200);
  assert.equal(joined.json.farm.role, 'worker');
  assert.equal((await fresh('GET', '/auth/me')).json.farm.name, 'Tambak Mitra');

  // The code is spent; signed out it is refused.
  assert.equal((await client()('POST', '/farm/join', { code })).status, 401);
  const again = await fresh('POST', '/farm/join', { code });
  assert.equal(again.status, 410);
  assert.equal(again.json.code, 'invite_invalid');

  // An owner joining another farm keeps their own farm and stays owner there.
  const second = (await owner('POST', '/farm/invites', { role: 'worker' })).json.code;
  const other = client();
  await other('POST', '/auth/register', { name: 'Pemilik Dua', phone: '083333333333', pin: '135790' });
  await other('PUT', '/farm', { name: 'Tambak Dua' });
  const both = await other('POST', '/farm/join', { code: second });
  assert.equal(both.json.farm.name, 'Tambak Mitra');
  assert.equal(both.json.farms.length, 2);
});
