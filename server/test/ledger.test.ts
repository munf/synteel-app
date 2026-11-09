// AI call ledger (ledger.ts): every model call written once, with its request, tokens, estimated
// cost and outcome; the farmer's "Cara AI memproses ini" view; the team dashboard's totals.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createAdmin, eventLog } from '../src/admin.ts';
import { call, createAi } from '../src/ai.ts';
import { openDb } from '../src/db.ts';
import { aiLedger, estimateCost, nightOf, tokensOf } from '../src/ledger.ts';
import { client, server } from './helpers.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A pretend model API: each URL prefix answers with a status and a body. */
function fakeApis(answers: Record<string, { status: number; body: unknown }>) {
  const asked: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    asked.push(String(url));
    const hit = Object.entries(answers).find(([prefix]) => String(url).startsWith(prefix));
    return new Response(JSON.stringify(hit?.[1].body ?? {}), { status: hit?.[1].status ?? 404, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return asked;
}

const chatAnswer = (content: unknown, usage = { prompt_tokens: 1000, completion_tokens: 2000 }) => ({ choices: [{ message: { content: JSON.stringify(content) } }], usage });

test('prices: tokens, audio hours and images become an estimate; an unknown model has none', () => {
  assert.equal(estimateCost({ provider: 'meta', model: 'muse-spark-1.3' }, { input: 1000, output: 2000 }), 0.00125 + 0.0085);
  assert.equal(estimateCost({ provider: 'meta', model: 'sam-3.1', images: 1 }, { input: null, output: null }), 0.0025);
  assert.ok(Math.abs(estimateCost({ provider: 'meta', model: 'muse-voice-transcribe-1.0', audioSeconds: 60 }, { input: null, output: null })! - 0.003) < 1e-12);
  // No audio length known: no guess.
  assert.equal(estimateCost({ provider: 'meta', model: 'muse-voice-transcribe-1.0' }, { input: null, output: null }), null);
  assert.equal(estimateCost({ provider: 'other', model: 'x' }, { input: 5, output: 5 }), null);
  assert.deepEqual(tokensOf({ usage: { prompt_tokens: 12, completion_tokens: 34 } }), { input: 12, output: 34 });
  assert.deepEqual(tokensOf({ usage: { input_tokens: 5, output_tokens: 6 } }), { input: 5, output: 6 });
  assert.deepEqual(tokensOf({}), { input: null, output: null });
});

test('a failed provider is an error row; the next one answering is a fallback row with tokens and cost', async () => {
  const db = openDb(':memory:');
  const ledger = aiLedger(db);
  fakeApis({
    'https://meta.test': { status: 503, body: { error: { code: 'overloaded' } } },
    'https://fw.test': { status: 200, body: chatAnswer({ temperature: 28.5, ph: null, tds: null, mortality: null, behavior: [], feeding_leftover: null, water_color: null, water_smell: null, aeration: null, note: null, low_confidence: [], problems: [] }) },
  });
  const ai = createAi({
    chat: [
      { name: 'meta', apiKey: 'k', base: 'https://meta.test', model: 'muse-spark-1.3' },
      { name: 'fireworks', apiKey: 'k', base: 'https://fw.test', model: 'accounts/fireworks/models/muse-spark-open' },
    ],
    mock: false,
  });
  let id = '';
  const draft = await ledger.track('photo', async (rid) => ((id = rid), ai.draft({ kind: 'photo', images: [new Blob(['x'], { type: 'image/jpeg' })], pondName: 'Kolam A' })), {
    farmId: 7,
    pondId: 3,
    verify: () => ({ status: 'passed', checks: [{ id: 'range', ok: true, label: 'Angka masuk akal' }] }),
  });
  assert.equal(draft.data.readings?.temperature, 28.5);
  const rows = db.prepare('select * from ai_ledger where request_id = ? order by id').all(id) as Record<string, unknown>[];
  assert.deepEqual(rows.map((r) => [r.provider, r.outcome, r.step]), [['meta', 'error', 'read'], ['fireworks', 'fallback', 'read']]);
  assert.match(String(rows[0].error), /503/);
  assert.equal(rows[1].input_tokens, 1000);
  assert.equal(rows[1].output_tokens, 2000);
  assert.ok(Math.abs((rows[1].cost_usd_estimate as number) - 0.00975) < 1e-12);
  assert.ok(rows.every((r) => r.kind === 'photo' && r.farm_id === 7 && r.pond_id === 3 && JSON.parse(String(r.verify)).status === 'passed'));
  // The farmer's view: steps without costs; only for the farm it belongs to.
  const trace = ledger.trace(id, 7)!;
  assert.deepEqual(trace.steps.map((s) => [s.provider, s.outcome]), [['meta', 'error'], ['fireworks', 'fallback']]);
  assert.ok(!JSON.stringify(trace).includes('cost'));
  assert.equal(ledger.trace(id, 8), null);
});

test('outside a tracked request a model call still works and writes nothing', async () => {
  const db = openDb(':memory:');
  aiLedger(db);
  fakeApis({ 'https://meta.test': { status: 200, body: { ok: true } } });
  await call('https://meta.test/x', 'k', { method: 'POST' }, { provider: 'meta', model: 'muse-spark-1.3', step: 'read' });
  assert.equal((db.prepare('select count(*) as n from ai_ledger').get() as { n: number }).n, 0);
});

test('a rules answer after the models failed is marked as a fallback row', async () => {
  const db = openDb(':memory:');
  const ledger = aiLedger(db);
  fakeApis({ 'https://meta.test': { status: 500, body: {} } });
  await ledger.track('briefing', () => call('https://meta.test/chat', 'k', { method: 'POST' }, { provider: 'meta', model: 'muse-spark-1.3', step: 'agent' }).catch(() => ({ source: 'rules' })), {
    farmId: 1,
    rules: (r) => (r as { source: string }).source === 'rules',
  });
  assert.deepEqual((db.prepare('select provider, outcome from ai_ledger order by id').all() as Record<string, unknown>[]).map((r) => [r.provider, r.outcome]), [['meta', 'error'], ['rules', 'fallback']]);
});

test('mock mode: a voice draft is ledgered as "mock", carries its checks, and keeps no farmer words', async () => {
  const s = server(undefined, { ai: createAi({ chat: [], mock: true }) });
  const call = s.client();
  await call('POST', '/auth/register', { name: 'Petani', phone: '081111111111', pin: '246810' });
  await call('PUT', '/farm', { name: 'Tambak' });
  const pond = (await call('POST', '/ponds', { name: 'Kolam A' })).json.pond;
  const form = new FormData();
  form.append('kind', 'voice');
  form.append('audio', new Blob(['fake'], { type: 'audio/wav' }), 'a.wav');
  const { draft } = (await call('POST', `/ponds/${pond.id}/capture`, form)).json;
  assert.equal(draft.verify.status, 'passed');
  assert.deepEqual(draft.held, []);
  assert.ok(draft.trace);

  const { trace } = (await call('GET', `/ai/trace/${draft.trace}`)).json;
  assert.equal(trace.kind, 'voice');
  assert.deepEqual(trace.steps.map((st: { step: string; outcome: string }) => [st.step, st.outcome]), [['mock', 'mock']]);
  assert.equal(trace.verify.status, 'passed');

  const rows = s.db.prepare('select * from ai_ledger').all() as Record<string, unknown>[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'mock');
  assert.ok(!JSON.stringify(rows).match(/dua delapan|pitu|aerator/i), 'no transcript words in the ledger');

  // Saving the draft as a log tells the ledger what it became.
  const saved = await call('POST', `/ponds/${pond.id}/logs`, { ...draft.data, source: 'voice', trace: draft.trace });
  assert.equal((s.db.prepare('select result_ref from ai_ledger').get() as { result_ref: string }).result_ref, `log:${saved.json.log.id}`);

  // Another farm cannot read it.
  const other = s.client();
  await other('POST', '/auth/register', { name: 'Lain', phone: '082222222222', pin: '135790' });
  await other('PUT', '/farm', { name: 'Tambak Lain' });
  assert.equal((await other('GET', `/ai/trace/${draft.trace}`)).status, 404);
});

test('mock mode: a dead-eel count and a voice round carry a verification and a trace', async () => {
  const s = server(undefined, { ai: createAi({ chat: [], mock: true }) });
  const call = s.client();
  await call('POST', '/auth/register', { name: 'Petani', phone: '081111111111', pin: '246810' });
  await call('PUT', '/farm', { name: 'Tambak' });
  const pond = (await call('POST', '/ponds', { name: 'Kolam A' })).json.pond;
  await call('POST', '/ponds', { name: 'Kolam B' });
  const form = new FormData();
  form.append('image', new Blob(['x'], { type: 'image/jpeg' }), 'a.jpg');
  const { result } = (await call('POST', `/ponds/${pond.id}/count`, form)).json;
  assert.equal(result.verify.status, 'passed');
  assert.equal((await call('GET', `/ai/trace/${result.trace}`)).json.trace.kind, 'count');

  const { round } = (await call('POST', '/round/text', { transcript: 'Kolam A suhu 27' })).json;
  assert.ok(round.trace);
  // The sample round names "kolam pojok", which is not on the farm: that pond check fails, the farmer picks.
  assert.equal(round.verify.status, 'failed');
  assert.ok(round.drafts.every((d: { verify?: unknown }) => d.verify));
});

test('team dashboard: recent calls, totals per model and the estimated cost per pond per night', async () => {
  const db = openDb(':memory:');
  const now = { t: new Date() };
  const events = eventLog(db, () => now.t);
  const ledger = aiLedger(db, () => now.t);
  // The farm lives in this database: one owner, two ponds.
  const { createApi } = await import('../src/api.ts');
  const { repo } = await import('../src/db.ts');
  const app = client(createApi(repo(db), { clock: () => now.t, getWeather: async () => ({ hours: [], fetchedAt: 0 }), geocode: async () => null, getBmkg: async () => { throw new Error('offline'); }, getStorm: async () => [], events, ledger }));
  await app('POST', '/auth/register', { name: 'Petani', phone: '081111111111', pin: '246810' });
  await app('PUT', '/farm', { name: 'Tambak Uji' });
  await app('POST', '/ponds', { name: 'Kolam A' });
  await app('POST', '/ponds', { name: 'Kolam B' });
  const farmId = (db.prepare('select id from farms').get() as { id: number }).id;

  fakeApis({ 'https://meta.test': { status: 200, body: { usage: { prompt_tokens: 2000, completion_tokens: 1000 } } } });
  const tag = { provider: 'meta', model: 'muse-spark-1.3', step: 'agent' as const };
  await ledger.track('briefing', async () => {
    await call('https://meta.test/chat', 'k', { method: 'POST' }, tag);
    await call('https://meta.test/chat', 'k', { method: 'POST' }, tag);
  }, { farmId });

  const creds = { user: 'tim', password: 'kata-sandi-panjang-sekali' };
  const admin = client(createAdmin(db, { creds, now: () => now.t, events, ledger, checks: [] }) as unknown as Parameters<typeof client>[0]);
  await admin('POST', '/login', creds);
  const { buku } = (await admin('GET', '/ai')).json;
  assert.equal(buku.panggilan.length, 2);
  assert.equal(buku.panggilan[0].tambak, 'Tambak Uji');
  assert.equal(buku.perModel[0].panggilan, 2);
  assert.equal(buku.perModel[0].tokenMasuk, 4000);
  const each = (2000 * 1.25 + 1000 * 4.25) / 1e6;
  assert.ok(Math.abs(buku.perModel[0].biayaUsd - 2 * each) < 1e-6);
  const night = buku.perKolamMalam[0];
  assert.equal(night.malam, nightOf(new Date().toISOString()));
  assert.equal(night.kolam, 2);
  assert.ok(Math.abs(night.perKolamUsd - each) < 1e-6, 'two calls over two ponds');
  assert.match(buku.catatanHarga, /Perkiraan/);
});

test('nights run from 12.00 to 12.00 WIB', () => {
  assert.equal(nightOf('2026-11-09T10:00:00Z'), '2026-11-09'); // 17.00 WIB
  assert.equal(nightOf('2026-11-09T20:00:00Z'), '2026-11-09'); // 03.00 WIB the next day
  assert.equal(nightOf('2026-11-10T04:59:00Z'), '2026-11-09'); // 11.59 WIB
  assert.equal(nightOf('2026-11-10T05:00:00Z'), '2026-11-10'); // 12.00 WIB
});
