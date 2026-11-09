// The measured evaluation (scripts/bench.ts): its scoring functions, the blind-rating export, and a
// full run in mock mode (a pretend API answering from the labels), so the benchmark keeps working.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blindPairs, median, mockApi, runTask, scoreCount, scoreFields, summarize, table, tallyRatings, wer, type ItemResult } from '../../scripts/bench.ts';

test('word error rate: edits over the words said, case and punctuation ignored', () => {
  assert.equal(wer('Kolam A suhu dua delapan', 'kolam a, suhu dua delapan.'), 0);
  assert.equal(wer('kolam a suhu dua delapan', 'kolam a suhu dua'), 1 / 5); // one word lost
  assert.equal(wer('kolam a suhu dua delapan', 'kolam be suhu dua delapan koma'), 2 / 5); // one wrong, one added
  assert.equal(wer('', ''), 0);
  assert.equal(wer('', 'noise'), 1);
});

test('median of an odd and an even list, none of nothing', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
});

test('fields: right per labelled value, a missing pond loses all its fields, unlabelled values counted apart', () => {
  const s = scoreFields(
    [
      { pond: 1, temperature: 25.8, ph: 7.4 },
      { pond: 2, temperature: 28, mortality: 2 },
      { pond: 4, color: 'green', leftover: 'much' },
    ],
    [
      { pondId: 1, fields: { temperature: 25.8, ph: 7.4, tds: 150 } }, // tds: nobody said it
      { pondId: 2, fields: { temperature: 27 } },
      { pondId: null, fields: { color: 'green' } }, // pond not matched: not credited to pond 4
    ],
  );
  assert.equal(s.total, 6);
  assert.equal(s.right, 2);
  assert.deepEqual(s.wrong, ['pond 2 temperature: want 28, got 27', 'pond 2 mortality: want 2, got nothing', 'pond 4 color: want green, got nothing', 'pond 4 leftover: want much, got nothing']);
  assert.equal(s.extra, 2);
});

test('counts: exact, within one eel, and whether the low end stayed at or under the truth', () => {
  assert.deepEqual(scoreCount(7, { count: 6, low: 6 }), { exact: false, within1: true, lowOk: true, absError: 1 });
  assert.deepEqual(scoreCount(10, { count: 12, low: 10 }), { exact: false, within1: false, lowOk: true, absError: 2 });
  assert.deepEqual(scoreCount(3, { count: 4, low: 4 }), { exact: false, within1: true, lowOk: false, absError: 1 });
});

const item = (over: Partial<ItemResult>): ItemResult => ({ id: 'x', score: 1, detail: {}, verify: 'passed', ms: 1000, calls: 1, cost: 0.001, answeredBy: ['meta/m'], fallbacks: 0, ...over });

test('summary: errors apart, verification over the items that have one, cost unknown when any item has no price', () => {
  const s = summarize('extract', [item({ score: 1, shown: 0.5, ms: 1000 }), item({ score: 0.5, shown: 0.5, verify: 'failed', ms: 3000, answeredBy: ['fireworks/f'], fallbacks: 1 }), item({ score: null, error: 'AI API 400', verify: null, cost: 0, ms: 50 })]);
  assert.deepEqual([s.n, s.errors, s.accuracy, s.shownAccuracy, s.verifyPassRate, s.medianMs, s.calls, s.fallbacks], [3, 1, 0.75, 0.5, 0.5, 2000, 3, 1]);
  assert.equal(s.costPerItem, 0.001);
  assert.deepEqual(s.answeredBy, { 'meta/m': 2, 'fireworks/f': 1 });
  assert.equal(summarize('agent', [item({}), item({ cost: null })]).costPerItem, null);
  assert.match(table([s]), /\| extract \| 3 \(1 errors\) \| labelled fields right: 75% \| 50% \| 50% \| 2\.0 s \| \$0\.00100 \| 3 \| meta\/m ×2, fireworks\/f ×1 \|/);
});

test('blind pairs: same item side by side in random order, model names scrubbed, key kept apart; ratings tallied', () => {
  const a = { label: 'meta/muse-spark-1.3', items: [item({ id: 'n1', output: 'Kolam B: aerator nyala (muse-spark-1.3)' }), item({ id: 'n2', output: 'Cek "Kolam A", jam 21.00' })] };
  const b = { label: 'nvidia/meta/llama', items: [item({ id: 'n1', output: 'Kolam B rawan, cek jam 01.00' }), item({ id: 'n2', output: 'Kolam A aman' }), item({ id: 'n3', output: 'only here' })] };
  const coin = [0.9, 0.1];
  const { csv, key } = blindPairs(a, b, () => coin.shift()!);
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 3); // header + 2 pairs: n3 has no partner
  assert.equal(lines[1], 'p1,n1,"Kolam B: aerator nyala ([model])","Kolam B rawan, cek jam 01.00",,');
  assert.equal(lines[2], 'p2,n2,"Kolam A aman","Cek ""Kolam A"", jam 21.00",,');
  assert.deepEqual(key, { p1: { item: 'n1', A: 'meta/muse-spark-1.3', B: 'nvidia/meta/llama' }, p2: { item: 'n2', A: 'nvidia/meta/llama', B: 'meta/muse-spark-1.3' } });
  // Nothing is rated until a person fills the column in.
  assert.deepEqual(tallyRatings(csv, key), { wins: {}, same: 0, unrated: 2 });
  const rated = csv.replace(/,,\n/, ',B,\n').replace(/,,\n$/, ',same,\n');
  assert.deepEqual(tallyRatings(rated, key), { wins: { 'nvidia/meta/llama': 1 }, same: 1, unrated: 0 });
});

test('mock run: every task goes through call(), the guards, the checks and the ledger', async () => {
  const api = await mockApi();
  try {
    const extract = await runTask('extract', { route: api.route, mock: true });
    assert.equal(extract.items.length, 3);
    // The pretend API answers with the labels, so the model score is full by construction.
    assert.ok(extract.items.every((i) => i.score === 1 && i.calls === 1 && i.answeredBy[0] === 'mock/labels'));
    assert.ok(extract.items.every((i) => i.shown !== undefined && i.verify !== null));
    const agent = await runTask('agent', { route: api.route, mock: true });
    assert.equal(agent.items[0].score, 1); // every rule check kept
    assert.equal(agent.items[0].verify, 'passed');
    assert.match(agent.items[0].output!, /Kolam B/);
    const segment = await runTask('segment', { route: api.route, mock: true });
    assert.deepEqual(segment.items.map((i) => [i.id, i.score, i.calls, i.detail.count]), [['synth8', 1, 5, 8]]);
    // Private photos are not in the repo: listed as skipped, never scored.
    assert.ok(segment.skipped.length > 0 && segment.skipped.every((s) => /live only/.test(s.why)));
    const speech = await runTask('speech', { route: api.route, mock: true });
    assert.deepEqual(speech.items, []); // no labelled recordings yet
  } finally {
    await api.close();
  }
});

test('the call budget stops a run before an item that could go past it', async () => {
  const api = await mockApi();
  try {
    const r = await runTask('extract', { route: api.route, mock: true, maxCalls: 2 });
    assert.equal(r.items.length, 2);
    assert.deepEqual(r.skipped, [{ id: 'id-jv-3', why: 'call budget (2) reached' }]);
    const seg = await runTask('segment', { route: api.route, mock: true, maxCalls: 4 });
    assert.equal(seg.items.length, 0); // an elver count may take 5 calls
  } finally {
    await api.close();
  }
});

test('nowcast check: night readings against the estimate at that hour, oxygen signs against the night peak', async () => {
  const { scoreNight, summarizeNights } = await import('../../scripts/nowcast-check.ts');
  const T = Date.parse('2026-11-01T10:00:00Z'); // 17.00 WIB
  const H = 3600_000;
  const hour = (h: number, temp: number | null, level: 'ok' | 'warning' | 'critical') => ({ t: T + h * H, temp, sigma: 0.3, score: 0, level, factors: [] });
  const nc = { pondId: 7, generatedAt: T, hours: [hour(0, 28, 'ok'), hour(4, 27.5, 'warning'), hour(10, 26.8, 'ok'), hour(20, 29, 'critical')] } as any;
  const log = (h: number, data: Record<string, unknown>) => ({ id: h, pondId: 7, batchId: 1, loggedAt: new Date(T + h * H).toISOString(), source: 'manual', data }) as any;
  const n = scoreNight(nc, '2026-11-01', [
    log(-2, { readings: { temperature: 30 } }), // before the forecast: not scored
    log(4.5, { readings: { temperature: 27.2 }, behavior: ['surfacing'] }),
    log(14, { readings: { do: 4.2 }, mortality: 3 }), // 07.00: no estimate within an hour
    log(30, { behavior: ['surfacing'] }), // the next evening: another night
  ]);
  assert.deepEqual(n.tempErrors, [-0.3]);
  assert.deepEqual(n.signs, ['surfacing', 'do 4.2']);
  assert.equal(n.dead, 3);
  // The peak of the night only: the critical hour 20 h ahead is the next day.
  assert.equal(n.peak, 'warning');
  const quiet = { ...n, peak: 'ok' as const, signs: ['gathering_inlet'], night: '2026-11-02' };
  const s = summarizeNights([n, quiet, { ...n, records: 0, night: '2026-11-03' }]);
  assert.equal(s.nightsWithRecords, 2);
  assert.deepEqual(s.table.map((r) => [r.peak, r.signsLogged, r.noSigns]), [['ok', 1, 0], ['warning', 1, 0], ['critical', 0, 0]]);
  assert.deepEqual(s.missed, ['pond 7 2026-11-02: gathering_inlet']);
  assert.equal(s.tempReadings, 2);
});
