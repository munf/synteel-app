import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createAi, withDailyCap, type Ai } from '../src/ai.ts';
import { checkReading, guardRound, matchPond, pondKey, type RoundPond } from '../src/round.ts';

const PONDS: RoundPond[] = [
  { id: 1, name: 'Kolam A', nicknames: [] },
  { id: 2, name: 'Kolam B', nicknames: [] },
  { id: 3, name: 'Kolam C1', nicknames: [] },
  { id: 4, name: 'Kolam T', nicknames: ['kolam pojok'] },
];
const META = { model: 'test/m', mode: 'meta' as const };
const EMPTY = { temperature: null, ph: null, tds: null, mortality: null, behavior: [], feeding_leftover: null, water_color: null, water_smell: null, aeration: null, note: null };
const mention = (pond: string, fields: Record<string, unknown>, pondId: number | null = null) => ({ ...EMPTY, unclear_text: null, pond_as_heard: pond, pond_id: pondId, quote: `${pond} ...`, ...fields });
const looseOf = (fields: Record<string, unknown> = {}) => ({ ...EMPTY, quote: '', ...fields });

test('pond names match as spoken: letters, Javanese numbers, nicknames', () => {
  assert.equal(pondKey('Kolam B'), 'b');
  assert.equal(pondKey('kolam be'), 'b');
  assert.equal(pondKey('kolam ce siji'), 'c1');
  assert.equal(matchPond('kolam be', PONDS).pondId, 2);
  assert.equal(matchPond('B', PONDS).pondId, 2);
  assert.equal(matchPond('Kolam C satu', PONDS).pondId, 3);
  assert.equal(matchPond('kolam pojok', PONDS).pondId, 4);
  assert.equal(matchPond('pojok', PONDS).pondId, 4);
  assert.equal(matchPond('Kolam B maneh', PONDS).pondId, 2);
});

test('an unknown pond is left for the farmer, with the model guess and near names first', () => {
  const m = matchPond('kolam ce', PONDS, 2);
  assert.equal(m.pondId, null);
  assert.deepEqual(m.suggestions, [2, 3, 1, 4]);
  // The model saying "pond 1" does not make it pond 1.
  assert.equal(matchPond('kolam mburi', PONDS, 1).pondId, null);
});

test('pH heard as 74 is read as 7,4 without asking', () => {
  assert.deepEqual(checkReading('ph', 74), { value: 7.4, autoFix: { field: 'ph', heard: '74', value: 7.4 } });
  assert.deepEqual(checkReading('ph', 7.2), { value: 7.2 });
  const r = checkReading('ph', 2);
  assert.equal(r.issue?.kind, 'implausible');
});

test('a temperature that lost its tens is asked, with the likely value', () => {
  const r = checkReading('temperature', 9);
  assert.equal(r.value, undefined);
  assert.deepEqual(r.issue && { ...r.issue, note: undefined }, { kind: 'implausible', field: 'temperature', heard: '9 °C', suggestion: 29, note: undefined });
  assert.equal(checkReading('temperature', 50).issue?.kind, 'implausible');
  assert.equal(checkReading('tds', 5000).issue?.kind, 'implausible');
  assert.equal(checkReading('tds', 160).value, 160);
});

test('the same pond said twice is merged; a changed reading is asked, last one preselected', () => {
  const r = guardRound(
    {
      loose: looseOf(),
      mentions: [
        mention('Kolam B', { temperature: 29, mortality: 2 }),
        mention('Kolam A', { temperature: 27, ph: 74 }),
        mention('kolam be', { temperature: 28, feeding_leftover: 'much' }),
      ],
    },
    PONDS,
    't',
    META,
  );
  assert.deepEqual(
    r.drafts.map((d) => d.pondId),
    [2, 1],
  );
  const b = r.drafts[0];
  assert.deepEqual(b.data, { readings: { temperature: 28 }, mortality: 2, feeding: { leftover: 'much' } });
  assert.deepEqual(b.issues, [{ kind: 'twice', field: 'temperature', values: [29, 28] }]);
  assert.match(b.quote, /Kolam B .* … kolam be/);
  assert.deepEqual(r.drafts[1].autoFixed, [{ field: 'ph', heard: '74', value: 7.4 }]);
  assert.deepEqual(r.drafts[1].data.readings, { temperature: 27, ph: 7.4 });
});

test('unclear parts, bad counts and implausible numbers become issues; loose numbers keep only plausible values', () => {
  const r = guardRound(
    {
      loose: looseOf({ quote: 'suhu 28, pH 7,2', temperature: 28, ph: 72 }),
      mentions: [mention('Kolam C1', { temperature: 9, mortality: -1, unclear_text: '… ana sing … loro …' }), mention('', { tds: 150 })],
    },
    PONDS,
    't',
    META,
  );
  const c = r.drafts[0];
  assert.equal(c.pondId, 3);
  assert.equal(c.data.readings, undefined);
  assert.deepEqual(
    c.issues.map((i) => i.kind),
    ['implausible', 'unclear', 'unclear'],
  );
  assert.deepEqual(r.loose?.data.readings, { temperature: 28, ph: 7.2, tds: 150 });
  assert.equal(r.empty, false);
});

test('nothing understood is empty', () => {
  const r = guardRound({ loose: looseOf(), mentions: [mention('Kolam A', {})] }, PONDS, 'eh', META);
  assert.deepEqual(r.drafts, []);
  assert.equal(r.loose, null);
  assert.equal(r.empty, true);
  assert.equal(guardRound('not json', PONDS, '', META).empty, true);
});

test('mock round shows the design example on this farm, labelled', async () => {
  const ai = createAi({ chat: [], mock: true });
  const r = await ai.round({ ponds: [{ id: 7, name: 'Bak Timur', nicknames: [] }, { id: 8, name: 'Bak Barat', nicknames: [] }] });
  assert.equal(r.mode, 'mock');
  assert.match(r.transcript, /Mode contoh/);
  assert.deepEqual(
    r.drafts.map((d) => d.pondId),
    [7, 8, null],
  );
  assert.deepEqual(r.drafts[0].data.readings, { temperature: 27, ph: 7.4 });
  assert.deepEqual(r.drafts[1].data, { readings: { temperature: 29 }, mortality: 2, feeding: { leftover: 'much' } });
  assert.equal(r.drafts[2].heardName, 'kolam pojok');
  assert.deepEqual(r.drafts[2].data, { water: { color: 'green' } });
  assert.deepEqual(r.drafts[2].suggestions, [7, 8]);
});

test('without speech-to-text a recorded round stays queued; typed text still works offline of ASR', async () => {
  const ai = createAi({ chat: [{ name: 'x', apiKey: 'k', base: 'http://127.0.0.1:9', model: 'm' }], mock: false });
  await assert.rejects(ai.round({ audio: new Blob(['x']), ponds: PONDS }), /belum bisa dibaca/);
  assert.equal((await ai.round({ transcript: '  ', ponds: PONDS })).empty, true);
});

test('a round goes through transcription, the model and the guards', async () => {
  const seen: { url: string; body: string }[] = [];
  const answer = {
    loose: looseOf(),
    mentions: [
      mention('Kolam A', { temperature: 27, ph: 74 }, 1),
      mention('Kolam B', { temperature: 29, mortality: 2, feeding_leftover: 'much' }, 2),
      // The model guesses wrong; the local check does not follow it.
      mention('kolam mburi', { water_color: 'green' }, 1),
    ],
  };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      seen.push({ url: req.url!, body: raw });
      if (req.url!.startsWith('/down')) return res.writeHead(503).end('{}');
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url!.endsWith('/asr/transcribe')) return res.end(JSON.stringify({ transcript: 'Kolam A suhune pitulikur, pH pitu koma papat. Kolam B ...' }));
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const ai = createAi({
      chat: [
        { name: 'meta', apiKey: 'k', base: `${base}/down`, model: 'a' },
        { name: 'fireworks', apiKey: 'k', base: `${base}/up`, model: 'b' },
      ],
      transcriber: { apiKey: 'k', base, model: 'asr' },
      mock: false,
    });
    const r = await ai.round({ audio: new Blob(['wav'], { type: 'audio/wav' }), ponds: PONDS });
    assert.equal(r.model, 'fireworks/b');
    assert.match(r.transcript, /pitulikur/);
    assert.deepEqual(
      r.drafts.map((d) => [d.pondId, d.heardName]),
      [
        [1, 'Kolam A'],
        [2, 'Kolam B'],
        [null, 'kolam mburi'],
      ],
    );
    assert.deepEqual(r.drafts[0].autoFixed, [{ field: 'ph', heard: '74', value: 7.4 }]);
    assert.equal(r.drafts[2].suggestions[0], 1);
    const prompt = JSON.parse(seen.at(-1)!.body);
    assert.match(prompt.messages[0].content, /4: Kolam T; dipanggil juga "kolam pojok"/);
    assert.match(prompt.messages[1].content, /pitulikur/);
    assert.equal(prompt.response_format.json_schema.name, 'pond_round');
  } finally {
    server.close();
  }
});

test('daily cap counts rounds and drafts together', async () => {
  let rounds = 0;
  const inner = { mode: 'meta', draft: async () => ({}), round: async () => (rounds++, {}) } as unknown as Ai;
  const ai = withDailyCap(inner, 2, () => new Date('2026-10-28T10:00:00Z'));
  await ai.draft({ kind: 'photo', images: [], pondName: 'Kolam C' });
  await ai.round({ transcript: 'x', ponds: [] });
  await assert.rejects(ai.round({ transcript: 'x', ponds: [] }), /Kuota AI demo/);
  assert.equal(rounds, 1);
});
