// Cycle summary (cycle.ts): days, logs per day, nights covered, readings in and out of range, alarms
// raised and answered, deaths, and survival only from two entered counts, against the farmer-reported 20–40%.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cycleCsv, cycleSummary, FARMER_REPORTED_SURVIVAL, nightOf, type BatchCount, type CycleInput } from '../src/cycle.ts';
import type { Log, LogData } from '../src/domain.ts';
import { knowledge } from '../src/knowledge.ts';
import type { Threshold } from '../src/rules.ts';
import { server } from './helpers.ts';

const thresholds = knowledge.thresholds.parameters as Threshold[];
const TZ = 'Asia/Jakarta';
let nextId = 1;
/** A log at a WIB wall-clock time ("2026-11-01 07:00"). */
const log = (wib: string, data: LogData, source: Log['source'] = 'manual'): Log => ({
  id: nextId++,
  pondId: 1,
  batchId: 1,
  loggedAt: new Date(Date.parse(wib.replace(' ', 'T') + ':00+07:00')).toISOString(),
  source,
  data,
});
const count = (countedOn: string, n: number, kind: BatchCount['kind'] = 'sorting'): BatchCount => ({ id: nextId++, batchId: 1, countedOn, count: n, kind });
const input = (o: Partial<CycleInput> = {}): CycleInput => ({
  batch: { id: 1, pondId: 1, phase: 'glass_eel', stockedAt: '2026-11-01', initialCount: 1000 },
  logs: [],
  counts: [],
  thresholds,
  timezone: TZ,
  now: new Date('2026-11-05T05:00:00Z'), // 12.00 WIB on day 5
  ...o,
});

test('days count the stocking day as day 1; logs per day leave sensor readings out', () => {
  const s = cycleSummary(
    input({
      logs: [
        log('2026-11-01 07:00', { readings: { temperature: 27.5 } }),
        log('2026-11-01 17:00', { readings: { ph: 7.4 } }),
        log('2026-11-03 07:00', { note: 'ok' }),
        log('2026-11-03 07:05', { readings: { temperature: 27.6 } }, 'sensor'),
      ],
    }),
  );
  assert.equal(s.days, 5);
  assert.equal(s.logs, 3);
  assert.equal(s.logsPerDay, 0.6);
  assert.equal(s.daysLogged, 2);
});

test('nights: 18.00 to 06.00 farm time, only nights that have passed', () => {
  assert.equal(nightOf(new Date('2026-11-01T12:00:00Z').toISOString(), TZ), '2026-11-01'); // 19.00 WIB
  assert.equal(nightOf(new Date('2026-11-01T20:00:00Z').toISOString(), TZ), '2026-11-01'); // 03.00 WIB on the 2nd
  assert.equal(nightOf(new Date('2026-11-02T03:00:00Z').toISOString(), TZ), null); // 10.00 WIB
  const s = cycleSummary(
    input({
      logs: [
        log('2026-11-01 21:00', { readings: { temperature: 27.5 } }),
        log('2026-11-02 23:00', { readings: { temperature: 27.5 } }),
        log('2026-11-03 02:00', { readings: { temperature: 27.5 } }), // same night as 23.00 on the 2nd
        log('2026-11-04 22:00', { readings: { temperature: 27.5 } }, 'sensor'), // a sensor is not a check
      ],
    }),
  );
  // Nights of the 1st to the 4th have passed at noon on the 5th.
  assert.deepEqual(s.nights, { covered: 2, total: 4 });
});

test('readings: inside the warning limits, out of range, and danger', () => {
  const s = cycleSummary(
    input({
      logs: [
        log('2026-11-01 07:00', { readings: { temperature: 27.5, ph: 7.4 } }), // both in target
        log('2026-11-02 07:00', { readings: { temperature: 26.5 } }), // off target, still inside the warning limits
        log('2026-11-03 07:00', { readings: { temperature: 25.5 } }), // past the warning limit (26)
        log('2026-11-04 07:00', { readings: { ph: 6.5 } }), // past the danger limit (6.7)
      ],
    }),
  );
  assert.deepEqual(s.readings, { inRange: 3, outOfRange: 2, danger: 1 });
});

test('alarms: a danger log answered by a check within 2 hours; danger logs close together are one alarm; re-checks count', () => {
  const s = cycleSummary(
    input({
      logs: [
        log('2026-11-02 01:00', { readings: { temperature: 24 } }, 'sensor'), // danger (below 25)
        log('2026-11-02 01:10', { readings: { temperature: 24 } }, 'sensor'), // same alarm
        log('2026-11-02 02:00', { aeration: 'on', readings: { temperature: 26.5 } }), // answered by a person
        log('2026-11-03 20:00', { behavior: ['surfacing'] }), // danger sign, nobody checked after
        log('2026-11-04 01:00', { readings: { temperature: 27.5 } }), // 5 hours later: too late
      ],
      rechecks: [
        { at: '2026-11-04T00:00:00Z', answered: true },
        { at: '2026-11-04T10:00:00Z', answered: false },
      ],
    }),
  );
  assert.deepEqual(s.alarms, { raised: 4, answered: 2 });
});

test('deaths: every recorded dead eel and the number of reports', () => {
  const s = cycleSummary(input({ logs: [log('2026-11-02 07:00', { mortality: 3 }), log('2026-11-03 07:00', { mortality: 6 }), log('2026-11-03 17:00', { note: 'x' })] }));
  assert.deepEqual(s.deaths, { total: 9, reports: 2 });
});

test('survival only from both counts, compared with the farmer-reported 20–40%', () => {
  assert.equal(FARMER_REPORTED_SURVIVAL.source, 'farmer-reported');
  const none = cycleSummary(input({ batch: { id: 1, pondId: 1, phase: 'glass_eel', stockedAt: '2026-11-01', initialCount: null }, counts: [count('2026-11-04', 300)] }));
  assert.equal(none.survival, null);
  assert.equal(none.survivalMissing, 'stocked');
  assert.equal(none.baseline.vs, null);

  // Dead eels recorded are never turned into a survival figure: without a count there is none.
  const noCount = cycleSummary(input({ logs: [log('2026-11-02 07:00', { mortality: 100 })] }));
  assert.equal(noCount.survival, null);
  assert.equal(noCount.survivalMissing, 'count');

  const within = cycleSummary(input({ counts: [count('2026-11-04', 350)] }));
  assert.equal(within.survival, 0.35);
  assert.deepEqual(within.baseline, { low: 0.2, high: 0.4, source: 'farmer-reported', vs: 'within' });

  // The newest count wins: a second sorting after the first.
  const later = cycleSummary(input({ counts: [count('2026-11-02', 900), count('2026-11-04', 620)] }));
  assert.equal(later.survival, 0.62);
  assert.equal(later.baseline.vs, 'above');
  assert.equal(cycleSummary(input({ counts: [count('2026-11-04', 150)] })).baseline.vs, 'below');

  // More counted than stocked is a typo somewhere, not 120% survival.
  const typo = cycleSummary(input({ counts: [count('2026-11-04', 1200)] }));
  assert.equal(typo.survival, null);
  assert.equal(typo.survivalMissing, 'count_above_stocked');
});

test('a harvest count ends the cycle: days stop at the harvest day', () => {
  const s = cycleSummary(input({ counts: [count('2026-11-03', 400, 'harvest')], now: new Date('2026-11-20T05:00:00Z') }));
  assert.equal(s.endedOn, '2026-11-03');
  assert.equal(s.days, 3);
  assert.deepEqual(s.nights, { covered: 0, total: 2 });
});

test('CSV: one row per batch, the baseline column says farmer-reported, cells with commas are quoted', () => {
  const s = cycleSummary(input({ counts: [count('2026-11-04', 350)] }));
  const csv = cycleCsv([{ farm: 't1', pond: 'Kolam A, dekat pintu', s }]);
  const [head, row] = csv.trim().split('\n');
  assert.match(head, /baseline_farmer_reported_pct/);
  assert.match(row, /^t1,"Kolam A, dekat pintu",1,glass_eel,2026-11-01,/);
  assert.match(row, /,35,20-40,within$/);
});

test('API: the pond carries its cycle; stocked count (owner) and a sorting count give survival', async () => {
  const t = server('2026-11-05T05:00:00Z');
  const owner = t.client();
  await owner('POST', '/auth/register', { name: 'Pak Uji', phone: '0812 3456 7890', pin: '246810' });
  await owner('PUT', '/farm', { name: 'Tambak Uji', locationName: 'Sleman' });
  const pond = (await owner('POST', '/ponds', { name: 'Kolam A' })).json.pond;
  await owner('POST', `/ponds/${pond.id}/batches`, { phase: 'glass_eel', stockedAt: '2026-11-01' });
  let r = await owner('GET', `/ponds/${pond.id}`);
  assert.equal(r.json.cycle.days, 5);
  assert.equal(r.json.cycle.survivalMissing, 'stocked');

  assert.equal((await owner('PUT', `/ponds/${pond.id}/cycle/stocked`, { count: 2.5 })).status, 400);
  r = await owner('PUT', `/ponds/${pond.id}/cycle/stocked`, { count: 2000 });
  assert.equal(r.json.cycle.stockedCount, 2000);
  assert.equal((await owner('POST', `/ponds/${pond.id}/cycle/counts`, { count: 500, countedOn: '2026-10-30' })).status, 400); // before stocking
  r = await owner('POST', `/ponds/${pond.id}/cycle/counts`, { count: 500, kind: 'sorting' });
  assert.equal(r.status, 201);
  assert.equal(r.json.cycle.survival, 0.25);
  assert.equal(r.json.cycle.baseline.vs, 'within');
});
