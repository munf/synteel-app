import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { combine, pairEyes, parseCount } from '../src/sam.ts';

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

// Synthetic outlines for the merge rules: a box, a score and a mask size.
const eel = (left: number, top: number, score: number, area = 400, w = 40, h = 10) => ({ left, top, right: left + w, bottom: top + h, path: 'M0 0', score, area, label: { x: left, y: top } });
const eye = (x: number, y: number) => eel(x, y, 0.6, 9, 3, 3);

test('the same eel found by two prompts is counted once, the surer outline kept', async () => {
  const r = combine([[eel(0, 0, 0.9), eel(100, 0, 0.88)], [eel(1, 1, 0.6), eel(200, 0, 0.92)]], []);
  assert.equal(r.eels.length, 3);
  assert.equal(r.eels.find((e) => e.left < 10)?.score, 0.9);
  assert.equal(r.low, 3);
  assert.equal(r.high, 3);
  assert.equal(r.count, 3);
});

test('two eyes close together are one head; a lone eye is a head too', async () => {
  assert.equal(pairEyes([eye(10, 10), eye(16, 10), eye(100, 50), eye(106, 51), eye(300, 300)]).length, 3);
});

test('sure bodies and heads agree: one number, doubtful extras aside', async () => {
  const bodies = [eel(0, 0, 0.9), eel(0, 100, 0.91), eel(0, 200, 0.86), eel(300, 300, 0.6)];
  const r = combine([bodies], [eye(0, 0), eye(5, 0), eye(0, 100), eye(5, 100), eye(0, 200), eye(5, 200)]);
  assert.deepEqual([r.low, r.high, r.count], [3, 3, 3]);
  assert.equal(r.atLeast, false);
});

test('bodies and heads disagree: a range, the middle filled in, and the farmer is asked to check', async () => {
  const heads = Array.from({ length: 15 }, (_, i) => [eye(i * 50, 0), eye(i * 50 + 5, 0)]).flat();
  const r = combine([Array.from({ length: 10 }, (_, i) => eel(i * 60, 100, 0.55))], heads);
  assert.deepEqual([r.low, r.high, r.count], [15, 15, 15]);
  assert.equal(r.atLeast, true); // heads only, no sure body: a floor, not an exact count
  assert.equal(r.review, true);
  const r2 = combine([[eel(0, 0, 0.9), eel(0, 50, 0.9), eel(0, 100, 0.6), eel(0, 150, 0.6)]], []);
  assert.deepEqual([r2.low, r2.high, r2.count], [2, 4, 3]);
  assert.equal(r2.review, true);
});

test('an outline much larger than the rest may be two crossing eels: the range goes up by one', async () => {
  const r = combine([[eel(0, 0, 0.9), eel(0, 50, 0.9), eel(0, 100, 0.9), eel(0, 150, 0.9, 1200)]], []);
  assert.deepEqual([r.low, r.high], [4, 5]);
});

test('nothing found anywhere is zero, so the app asks for a new photo', async () => {
  const r = combine([[], [], []], []);
  assert.deepEqual([r.count, r.low, r.high], [0, 0, 0]);
});
