import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseCount } from '../src/sam.ts';

// Real SAM 3.1 output (prompt "worm") for a rendered white basin with 8 elvers, some touching.
const synth8 = readFileSync(new URL('./fixtures/sam-synth8.txt', import.meta.url), 'utf8');

test('SAM output becomes one numbered outline per eel', async () => {
  const r = await parseCount(synth8);
  assert.equal(r.count, 8);
  assert.equal(r.review, true); // two eels touch: the farmer is asked to check
  for (const e of r.eels) {
    assert.match(e.path, /^M/);
    assert.ok(e.label.x >= e.left && e.label.x < e.right && e.label.y >= e.top && e.label.y < e.bottom);
  }
  // Numbered top to bottom.
  assert.ok(r.eels.every((e, i) => i === 0 || r.eels[i - 1].top <= e.top));
});

test('no eels found is an empty count, not an error', async () => {
  const r = await parseCount('');
  assert.equal(r.count, 0);
  assert.equal(r.review, false);
});
