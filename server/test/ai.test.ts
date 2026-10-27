import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAi, toDraft } from '../src/ai.ts';

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
  const ai = createAi({ apiKey: '', base: '', mock: true });
  const draft = await ai.draft({ kind: 'photo', field: 'ph', images: [new Blob(['x'])], pondName: 'Kolam C' });
  assert.equal(draft.mode, 'mock');
  assert.equal(draft.data.readings?.ph, 7.2);
  assert.match(draft.problems[0], /Mode contoh/);
});

test('without key or mock, AI is off and says so', async () => {
  const ai = createAi({ apiKey: '', base: '', mock: false });
  assert.equal(ai.mode, 'off');
  await assert.rejects(ai.draft({ kind: 'voice', images: [], pondName: 'Kolam C' }), /AI belum aktif/);
});
