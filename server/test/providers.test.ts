// Model freedom (providers.ts): one table says which provider and model does each AI task, in which
// order; a provider without its key is off; an outage hands the task to the next one, and the AI call
// ledger records the provider and model that actually answered.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { createAi } from '../src/ai.ts';
import { openDb } from '../src/db.ts';
import { aiLedger } from '../src/ledger.ts';
import { describeRoute, parseRoute, resolveRoutes } from '../src/providers.ts';
import { countDeadEels } from '../src/sam.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const ALL_KEYS = { META_API_KEY: 'm', FIREWORKS_API_KEY: 'f', BASETEN_API_KEY: 'b' };
const names = (r: { name: string; model: string }[]) => r.map((e) => `${e.name}/${e.model}`);

/** A pretend set of model APIs: each URL prefix answers with a status and a body; request bodies are kept. */
function fakeApis(answers: [prefix: string, status: number, body: unknown][]) {
  const asked: { url: string; body: string }[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    asked.push({ url: String(url), body: typeof init?.body === 'string' ? init.body : '' });
    const hit = answers.find(([prefix]) => String(url).startsWith(prefix));
    return new Response(JSON.stringify(hit?.[2] ?? {}), { status: hit?.[1] ?? 404, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return asked;
}

test('default routes keep the hackathon order, every model named', () => {
  const { routes, skipped } = resolveRoutes(ALL_KEYS);
  assert.deepEqual(names(routes.speech), ['meta/muse-voice-transcribe-1.0']);
  assert.deepEqual(names(routes.extract), ['meta/muse-spark-1.3', 'fireworks/accounts/fireworks/models/muse-spark-open']);
  assert.deepEqual(names(routes.agent), ['baseten/meta-models/muse-spark-open-1026', 'meta/muse-spark-1.3', 'fireworks/accounts/fireworks/models/muse-spark-open']);
  assert.deepEqual(names(routes.segment), ['meta/sam-3.1']);
  assert.deepEqual(skipped, []);
  // The older switch still puts Fireworks first for drafts.
  assert.deepEqual(resolveRoutes({ ...ALL_KEYS, SYNTEEL_AI_PROVIDER: 'fireworks' }).routes.extract.map((e) => e.name), ['fireworks', 'meta']);
});

test('a provider without its key is off; no key at all leaves every task empty', () => {
  const { routes, skipped } = resolveRoutes({ META_API_KEY: 'm' });
  assert.deepEqual(routes.agent.map((e) => e.name), ['meta']);
  assert.deepEqual(skipped.filter((s) => s.task === 'agent').map((s) => [s.entry, s.why]), [['baseten', 'no key'], ['fireworks', 'no key']]);
  const none = resolveRoutes({});
  for (const task of ['speech', 'extract', 'agent', 'segment'] as const) assert.deepEqual(none.routes[task], []);
  assert.equal(describeRoute(none.routes.agent), 'none');
  // MODEL_API_KEY is the older name of the Meta key; MODEL_API_BASE points it elsewhere.
  const old = resolveRoutes({ MODEL_API_KEY: 'k', MODEL_API_BASE: 'http://127.0.0.1:9/v1' }).routes.segment[0];
  assert.deepEqual([old.apiKey, old.base], ['k', 'http://127.0.0.1:9/v1']);
});

test('NVIDIA NIM: off without NVIDIA_API_KEY, in no default route, opt-in per task', () => {
  const route = 'nvidia:meta/llama-3.3-70b-instruct,meta';
  const off = resolveRoutes({ ...ALL_KEYS, SYNTEEL_ROUTE_AGENT: route });
  assert.deepEqual(off.routes.agent.map((e) => e.name), ['meta']);
  assert.deepEqual(off.skipped, [{ task: 'agent', entry: 'nvidia:meta/llama-3.3-70b-instruct', why: 'no key' }]);
  // With the key it still only runs where a route names it.
  const on = resolveRoutes({ ...ALL_KEYS, NVIDIA_API_KEY: 'n' });
  assert.ok(Object.values(on.routes).flat().every((e) => e.name !== 'nvidia'));
  const [nim] = resolveRoutes({ ...ALL_KEYS, NVIDIA_API_KEY: 'n', SYNTEEL_ROUTE_AGENT: route }).routes.agent;
  assert.deepEqual([nim.name, nim.base, nim.model, nim.reasoning], ['nvidia', 'https://integrate.api.nvidia.com/v1', 'meta/llama-3.3-70b-instruct', false]);
});

test('route overrides: provider:model pairs, bare names, and entries a task cannot use', () => {
  assert.deepEqual(parseRoute(' fireworks , meta:muse-spark-1.2,nvidia:meta/llama:tag '), [
    { provider: 'fireworks', model: '' },
    { provider: 'meta', model: 'muse-spark-1.2' },
    { provider: 'nvidia', model: 'meta/llama:tag' },
  ]);
  const { routes, skipped } = resolveRoutes({ ...ALL_KEYS, SYNTEEL_ROUTE_EXTRACT: 'fireworks,meta:muse-spark-1.2,fireworks,acme', SYNTEEL_ROUTE_SPEECH: 'fireworks,meta' });
  assert.deepEqual(names(routes.extract), ['fireworks/accounts/fireworks/models/muse-spark-open', 'meta/muse-spark-1.2']);
  // Speech-to-text and SAM are Meta Model API endpoints: an OpenAI-compatible provider cannot do them.
  assert.deepEqual(names(routes.speech), ['meta/muse-voice-transcribe-1.0']);
  assert.deepEqual(skipped.map((s) => [s.task, s.entry, s.why]), [
    ['speech', 'fireworks', 'task not supported'],
    ['extract', 'acme', 'unknown provider'],
  ]);
});

test('a provider that takes no reasoning_effort is not sent one', async () => {
  const asked = fakeApis([['http://nim', 200, { choices: [{ message: { content: JSON.stringify({ temperature: 27 }) } }] }]]);
  const ai = createAi({ chat: [{ name: 'nvidia', apiKey: 'k', base: 'http://nim', model: 'meta/llama', reasoning: false }], mock: false });
  const draft = await ai.draft({ kind: 'photo', images: [new Blob(['x'], { type: 'image/jpeg' })], pondName: 'Kolam A' });
  assert.equal(draft.model, 'nvidia/meta/llama');
  assert.equal('reasoning_effort' in JSON.parse(asked[0].body), false);
  const asked2 = fakeApis([['http://meta', 200, { choices: [{ message: { content: '{}' } }] }]]);
  await createAi({ chat: [{ name: 'meta', apiKey: 'k', base: 'http://meta', model: 'muse-spark-1.3' }], mock: false }).draft({ kind: 'photo', images: [], pondName: 'Kolam A' });
  assert.equal(JSON.parse(asked2[0].body).reasoning_effort, 'low');
});

test('fallback: speech and reading both move on after an outage, and the ledger names who answered', async () => {
  const ledger = aiLedger(openDb(':memory:'));
  fakeApis([
    ['http://asr-down', 503, {}],
    ['http://asr-up/asr/transcribe', 200, { transcript: 'Kolam A suhu dua tujuh koma empat' }],
    ['http://meta-down', 429, { error: { code: 'rate_limited' } }],
    ['http://fw', 200, { choices: [{ message: { content: JSON.stringify({ temperature: 27.4 }) } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }],
  ]);
  const ai = createAi({
    chat: [
      { name: 'meta', apiKey: 'k', base: 'http://meta-down', model: 'muse-spark-1.3' },
      { name: 'fireworks', apiKey: 'k', base: 'http://fw', model: 'accounts/fireworks/models/muse-spark-open' },
    ],
    transcriber: [
      { name: 'meta', apiKey: 'k', base: 'http://asr-down', model: 'muse-voice-transcribe-1.0' },
      { name: 'backup', apiKey: 'k', base: 'http://asr-up', model: 'asr-2' },
    ],
    mock: false,
  });
  const quiet = console.error;
  console.error = () => {};
  const draft = await ledger.track('voice', () => ai.draft({ kind: 'voice', images: [], audio: new Blob(['x']), pondName: 'Kolam A' }), { farmId: 1 }).finally(() => (console.error = quiet));
  assert.equal(draft.model, 'fireworks/accounts/fireworks/models/muse-spark-open');
  assert.deepEqual(draft.data.readings, { temperature: 27.4 });
  const rows = ledger.recent().reverse().map((r) => [r.step, r.provider, r.model, r.outcome]);
  assert.deepEqual(rows, [
    ['speech', 'meta', 'muse-voice-transcribe-1.0', 'error'],
    ['speech', 'backup', 'asr-2', 'fallback'],
    ['read', 'meta', 'muse-spark-1.3', 'error'],
    ['read', 'fireworks', 'accounts/fireworks/models/muse-spark-open', 'fallback'],
  ]);
  // The fallback's cost is priced as the model that answered.
  assert.ok(Math.abs((ledger.recent()[0].cost_usd_estimate as number) - (100 * 1.25 + 50 * 4.25) / 1e6) < 1e-12);
});

test('a refusal (not an outage) does not fall back: the farmer sees the error, no second bill', async () => {
  const asked = fakeApis([
    ['http://a', 400, { error: { message: 'bad request' } }],
    ['http://b', 200, { choices: [{ message: { content: '{}' } }] }],
  ]);
  const ai = createAi({ chat: [{ name: 'meta', apiKey: 'k', base: 'http://a', model: 'x' }, { name: 'fireworks', apiKey: 'k', base: 'http://b', model: 'y' }], mock: false });
  await assert.rejects(ai.draft({ kind: 'photo', images: [], pondName: 'Kolam A' }), /AI API 400/);
  assert.equal(asked.length, 1);
});

test('SAM: the segment route falls back as a whole when every prompt hits an outage', async () => {
  const ledger = aiLedger(openDb(':memory:'));
  const synth8 = readFileSync(new URL('./fixtures/sam-synth8.txt', import.meta.url), 'utf8');
  fakeApis([
    ['http://sam-down', 503, {}],
    ['http://sam-up', 200, { output: [{ content: [{ text: synth8 }] }] }],
  ]);
  const quiet = console.error;
  console.error = () => {};
  const r = await ledger
    .track('count', () => countDeadEels(new Blob(['x'], { type: 'image/jpeg' }), [{ apiKey: 'k', base: 'http://sam-down' }, { name: 'meta-eu', apiKey: 'k', base: 'http://sam-up', model: 'sam-3.1' }], 'elver'))
    .finally(() => (console.error = quiet));
  assert.equal(r.model, 'meta-eu/sam-3.1');
  const rows = ledger.recent();
  assert.equal(rows.filter((x) => x.provider === 'meta' && x.outcome === 'error').length, 5);
  assert.equal(rows.filter((x) => x.provider === 'meta-eu' && x.outcome === 'fallback').length, 5);
  // A single provider, as before, still works.
  fakeApis([['http://sam-up', 200, { output: [{ content: [{ text: '' }] }] }]]);
  assert.equal((await countDeadEels(new Blob(['x']), { apiKey: 'k', base: 'http://sam-up' })).model, 'meta/sam-3.1');
});

test('no model on the alarm path: the rules, nowcast and monitor cannot reach a model module', () => {
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    // Type-only imports are erased at run time and cannot call anything.
    for (const m of src.matchAll(/^import\s+(type\s+)?[^'"]*from\s+'\.\/([\w-]+\.ts)';/gm)) if (!m[1]) walk(m[2]);
  };
  for (const f of ['rules.ts', 'nowcast.ts', 'monitor.ts', 'thermal.ts']) walk(f);
  for (const model of ['ai.ts', 'providers.ts', 'agentloop.ts', 'sam.ts', 'agent.ts', 'spoken.ts']) assert.equal(seen.has(model), false, `${model} reachable from the alarm path`);
  assert.ok(seen.has('rules.ts') && seen.has('nowcast.ts'));
});
