import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DAY_MS, type Log, type LogData } from '../src/domain.ts';
import { knowledge } from '../src/knowledge.ts';
import { assessPond, overallLevel, type Threshold } from '../src/rules.ts';

const thresholds = knowledge.thresholds.parameters as Threshold[];
const now = new Date('2026-10-28T10:00:00Z');

let nextId = 1;
function log(hoursAgo: number, data: LogData): Log {
  return { id: nextId++, pondId: 1, batchId: 1, loggedAt: new Date(now.getTime() - hoursAgo * 3600_000).toISOString(), source: 'manual', data };
}
const ids = (logs: Log[]) => assessPond(logs, thresholds, now).map((f) => f.id);

test('normal readings give no findings', () => {
  const findings = assessPond([log(1, { readings: { temperature: 27.5, ph: 7.4, tds: 150 } })], thresholds, now);
  assert.deepEqual(findings, []);
  assert.equal(overallLevel(findings), 'ok');
});

test('temperature above 30 °C is critical, 29.5 °C is a warning', () => {
  const hot = assessPond([log(1, { readings: { temperature: 31 } })], thresholds, now);
  assert.equal(hot[0].id, 'threshold:temperature');
  assert.equal(hot[0].level, 'critical');
  const warm = assessPond([log(1, { readings: { temperature: 29.5 } })], thresholds, now);
  assert.equal(warm[0].level, 'warning');
});

test('pH uses both lower and upper bounds', () => {
  assert.equal(assessPond([log(1, { readings: { ph: 6.5 } })], thresholds, now)[0].level, 'critical');
  assert.equal(assessPond([log(1, { readings: { ph: 8.0 } })], thresholds, now)[0].level, 'warning');
});

test('only the latest reading counts', () => {
  // newest first: the fresh normal reading overrides an older hot one
  assert.ok(!ids([log(1, { readings: { temperature: 27.5 } }), log(5, { readings: { temperature: 31 } })]).includes('threshold:temperature'));
});

test('readings older than 24 h do not trigger thresholds and count as stale', () => {
  const result = ids([log(30, { readings: { temperature: 31 } })]);
  assert.ok(!result.includes('threshold:temperature'));
  assert.ok(result.includes('stale'));
});

test('surfacing eels flag likely low DO as critical, mentioning high temperature', () => {
  const findings = assessPond([log(1, { behavior: ['surfacing'], readings: { temperature: 29.5 } })], thresholds, now);
  const lowDo = findings.find((f) => f.id === 'sign:low_do')!;
  assert.equal(lowDo.level, 'critical');
  assert.match(lowDo.detail, /29,5 °C/);
  assert.equal(findings[0].level, 'critical');
});

test('leftover feed must be "much" on two separate days', () => {
  assert.ok(!ids([log(2, { feeding: { leftover: 'much' } }), log(5, { feeding: { leftover: 'much' } })]).includes('feed:leftover'));
  assert.ok(ids([log(2, { feeding: { leftover: 'much' } }), log(26, { feeding: { leftover: 'much' } })]).includes('feed:leftover'));
});

test('mortality in the last 24 h is summed', () => {
  const findings = assessPond([log(1, { mortality: 3 }), log(10, { mortality: 4 }), log(30, { mortality: 50 })], thresholds, now);
  assert.equal(findings.find((f) => f.id === 'mortality')!.title, '7 ekor mati dalam 24 jam');
});

test('TDS shift is measured against the 1–7 day median baseline', () => {
  // A sudden drop (e.g. rainwater) stays under the 200 ppm limit but is still a shift.
  const baseline = [30, 50, 70].map((h) => log(h, { readings: { tds: 160 } }));
  assert.ok(ids([log(1, { readings: { tds: 110 } }), ...baseline]).includes('tds:shift'));
  assert.ok(!ids([log(1, { readings: { tds: 145 } }), ...baseline]).includes('tds:shift'));
  // not enough history: no baseline, no finding
  assert.ok(!ids([log(1, { readings: { tds: 110 } }), log(30, { readings: { tds: 160 } })]).includes('tds:shift'));
});

test('findings are ordered critical, warning, info', () => {
  const findings = assessPond([log(1, { mortality: 1, behavior: ['surfacing'] }), log(30, {})], thresholds, now);
  const levels = findings.map((f) => f.level);
  assert.deepEqual(levels, [...levels].sort((a, b) => ['critical', 'warning', 'info'].indexOf(a) - ['critical', 'warning', 'info'].indexOf(b)));
});

test('elver ponds use the partner farm range instead of the Blueprint one', () => {
  const warm = [log(1, { readings: { temperature: 30.5, ph: 6.85 } })];
  // Blueprint (glass eel): 30,5 °C is critical
  assert.equal(assessPond(warm, thresholds, now, { phase: 'glass_eel' })[0].level, 'critical');
  // Partner practice (elver): 28–31 °C and pH 6,8–7,6 are ideal
  assert.deepEqual(assessPond(warm, thresholds, now, { phase: 'elver' }), []);
  const cold = assessPond([log(1, { readings: { temperature: 27 } })], thresholds, now, { phase: 'elver' });
  assert.equal(cold[0].level, 'warning');
  assert.match(cold[0].source, /petani mitra/);
});

test('TDS above 200 ppm is a warning', () => {
  const findings = assessPond([log(1, { readings: { tds: 260 } })], thresholds, now);
  assert.equal(findings[0].id, 'threshold:tds');
  assert.equal(findings[0].level, 'warning');
});

test('elver density above 100 per m² is a warning', () => {
  const fresh = [log(1, { readings: { temperature: 29, ph: 7.2, tds: 150 } })];
  assert.ok(ids(fresh).length === 0);
  const crowded = assessPond(fresh, thresholds, now, { phase: 'elver', density: 130 });
  assert.equal(crowded[0].id, 'stocking:density');
  assert.deepEqual(assessPond(fresh, thresholds, now, { phase: 'elver', density: 55 }), []);
});

test('DAY_MS sanity', () => assert.equal(DAY_MS, 86_400_000));
