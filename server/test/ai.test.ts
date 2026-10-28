import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AiUnavailable, createAi, toDraft, withDailyCap, type Ai } from '../src/ai.ts';

test('drafts keep plausible values and drop impossible ones', () => {
  const draft = toDraft(
    { temperature: 28.5, ph: 72, tds: 160, mortality: 2, behavior: ['surfacing', 'dancing'], feeding_leftover: 'lots', water_color: 'green', aeration: 'on', low_confidence: ['tds'], problems: ['layar silau'] },
    'meta',
  );
  assert.deepEqual(draft.data.readings, { temperature: 28.5, tds: 160 });
  assert.equal(draft.data.mortality, 2);
  assert.deepEqual(draft.data.behavior, ['surfacing']);
  assert.equal(draft.data.feeding, undefined);
  assert.deepEqual(draft.data.water, { color: 'green' });
  assert.equal(draft.data.aeration, 'on');
  assert.deepEqual(draft.lowConfidence, ['tds']);
  assert.equal(draft.problems[0], 'layar silau');
  assert.match(draft.problems[1], /ph 72/);
});

test('nulls from the model leave the draft empty', () => {
  const draft = toDraft({ temperature: null, ph: null, tds: null, mortality: null, behavior: [], note: null }, 'meta');
  assert.deepEqual(draft.data, {});
});

test('mock mode labels its drafts as examples', async () => {
  const ai = createAi({ chat: [], mock: true });
  const draft = await ai.draft({ kind: 'photo', field: 'ph', images: [new Blob(['x'])], pondName: 'Kolam C' });
  assert.equal(draft.mode, 'mock');
  assert.equal(draft.data.readings?.ph, 7.2);
  assert.match(draft.problems[0], /Mode contoh/);
});

test('without key or mock, AI is off and says so', async () => {
  const ai = createAi({ chat: [], mock: false });
  assert.equal(ai.mode, 'off');
  await assert.rejects(ai.draft({ kind: 'voice', images: [], pondName: 'Kolam C' }), /AI belum aktif/);
});

test('without speech-to-text, voice notes stay queued instead of failing', async () => {
  const ai = createAi({ chat: [{ name: 'x', apiKey: 'k', base: 'http://127.0.0.1:9', model: 'm' }], mock: false });
  await assert.rejects(ai.draft({ kind: 'voice', images: [], audio: new Blob(['x']), pondName: 'Kolam C' }), AiUnavailable);
});

test('falls back to the next provider when the first is down', async () => {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/down')) return res.writeHead(503).end('{}');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ temperature: 27.4, ph: 7.2, tds: 412 }) } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const ai = createAi({
      chat: [
        { name: 'meta', apiKey: 'k', base: `${base}/down`, model: 'a' },
        { name: 'fireworks', apiKey: 'k', base: `${base}/up`, model: 'b' },
      ],
      mock: false,
    });
    const draft = await ai.draft({ kind: 'photo', images: [new Blob(['x'], { type: 'image/jpeg' })], pondName: 'Kolam C' });
    assert.deepEqual(draft.data.readings, { temperature: 27.4, ph: 7.2, tds: 412 });
    assert.equal(draft.model, 'fireworks/b');
  } finally {
    server.close();
  }
});

test('daily cap stops real AI reads until the next day', async () => {
  let clock = new Date('2026-10-28T10:00:00Z');
  const inner: Ai = {
    mode: 'meta',
    draft: async () => toDraft({}, 'meta'),
    round: async () => ({ transcript: '', drafts: [], loose: null, empty: true, model: 'test', mode: 'meta' }),
    transcribe: async () => '',
  };
  const ai = withDailyCap(inner, 2, () => clock);
  const input = { kind: 'photo' as const, images: [], pondName: 'Kolam C' };
  await ai.draft(input);
  await ai.draft(input);
  await assert.rejects(ai.draft(input), /Kuota AI demo/);
  clock = new Date('2026-10-29T00:01:00Z');
  await ai.draft(input);
});
