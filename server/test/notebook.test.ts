import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAi, type Ai } from '../src/ai.ts';
import { guardCell, guardDate, guardNotebook, localIso, parseDate, parseTime, parseWritten } from '../src/notebook.ts';
import type { RoundPond } from '../src/round.ts';
import { farmWithWorker } from './helpers.ts';

const PONDS: RoundPond[] = [
  { id: 1, name: 'Kolam A', nicknames: [] },
  { id: 2, name: 'Kolam B', nicknames: ['kolam dekat pintu'] },
  { id: 3, name: 'Kolam C1', nicknames: [] },
];
const TODAY = '2026-10-29';
const cell = (written: string | null, value: number | null = written === null ? null : (parseWritten(written) ?? null)) => ({ written, value });
const row = (over: Record<string, unknown> = {}) => ({
  date: { written: '12/10', day: 12, month: 10, year: null },
  time: null,
  pond: 'Kolam A',
  temperature: cell('27,5'),
  ph: cell('7,4'),
  tds: cell('140'),
  dead: cell(null),
  feed: null,
  note: null,
  unsure: [],
  ...over,
});
const page = (rows: unknown[], extra: Record<string, unknown> = {}) => ({ page_pond: null, page_year: null, rows, problems: [], ...extra });
const one = (r: Record<string, unknown>, extra: Record<string, unknown> = {}, defaultPondId?: number) => guardNotebook(page([row(r)], extra), PONDS, { today: TODAY, page: 1, defaultPondId }).rows[0];

test('numbers come from what is written: "7,4", "28°C", "160 ppm"', () => {
  assert.equal(parseWritten('7,4'), 7.4);
  assert.equal(parseWritten('28°C'), 28);
  assert.equal(parseWritten('160 ppm'), 160);
  assert.equal(parseWritten('7,?'), undefined);
  assert.equal(parseWritten('"'), undefined);
  assert.equal(parseWritten('27/28'), undefined);
  const r = one({});
  assert.deepEqual(r.values, { temperature: 27.5, ph: 7.4, tds: 140 });
  assert.deepEqual(r.checks, []);
  assert.equal(r.pondId, 1);
  assert.equal(r.date, '2026-10-12');
});

test('a number for a blank cell is invented: dropped and flagged', () => {
  const c = guardCell('ph', { written: null, value: 7.2 }, false);
  assert.equal(c.value, undefined);
  assert.equal(c.check?.kind, 'unsure');
  assert.equal(c.check?.suggestion, null);
  const r = one({ tds: { written: '', value: 150 } });
  assert.equal(r.values.tds, undefined);
  assert.deepEqual(r.checks.map((x) => [x.field, x.kind]), [['tds', 'unsure']]);
});

test('the model correcting what is written is not trusted: the written number is checked', () => {
  // Written "74", the model says 7.4: offered as a suggestion, never filled in.
  const r = one({ ph: { written: '74', value: 7.4 } });
  assert.equal(r.values.ph, undefined);
  assert.deepEqual(r.checks.map((x) => [x.field, x.kind, x.suggestion]), [['ph', 'odd', 7.4]]);
});

test('unsure and unreadable cells come back empty, marked, with what was seen', () => {
  const r = one({ ph: cell('7,?'), temperature: cell('28,5'), unsure: ['temperature'] });
  assert.deepEqual(r.values, { tds: 140 });
  const ph = r.checks.find((x) => x.field === 'ph')!;
  assert.deepEqual([ph.kind, ph.written, ph.suggestion], ['unsure', '7,?', null]);
  const temp = r.checks.find((x) => x.field === 'temperature')!;
  assert.deepEqual([temp.kind, temp.written, temp.suggestion], ['unsure', '28,5', 28.5]);
  // A dash means none: empty, nothing to check.
  const dash = one({ dead: { written: '-', value: null } });
  assert.deepEqual([dash.values.dead, dash.checks.length], [undefined, 0]);
  // Ditto marks are not copied from the row above.
  const ditto = one({ tds: { written: '"', value: 140 } });
  assert.equal(ditto.values.tds, undefined);
  assert.equal(ditto.checks[0].kind, 'unsure');
});

test('plausibility as for voice logs, but only ever suggested: pH 74 → 7,4, temperature 9 → 29', () => {
  const r = one({ ph: cell('74'), temperature: cell('9'), tds: cell('5000'), dead: cell('2,5') });
  assert.deepEqual(r.values, {});
  const by = Object.fromEntries(r.checks.map((x) => [x.field, x]));
  assert.deepEqual([by.ph.kind, by.ph.suggestion], ['odd', 7.4]);
  assert.deepEqual([by.temperature.kind, by.temperature.suggestion], ['odd', 29]);
  assert.match(by.temperature.note, /angka depannya/);
  assert.deepEqual([by.tds.kind, by.tds.suggestion], ['odd', null]);
  assert.deepEqual([by.dead.kind, by.dead.suggestion], ['odd', null]);
});

test('dates: no year → most recent past one; never in the future', () => {
  assert.deepEqual(parseDate('12/10'), { day: 12, month: 10, year: null });
  assert.deepEqual(parseDate('3 Okt 25'), { day: 3, month: 10, year: 25 });
  assert.deepEqual(parseDate('3-X-2025'), { day: 3, month: 10, year: 2025 });
  // 12 October: this year. 30 December: not yet this year → last year.
  assert.deepEqual(guardDate({ written: '12/10', day: 12, month: 10, year: null }, null, TODAY, false), { date: '2026-10-12', yearGuessed: true, written: '12/10' });
  assert.equal(guardDate({ written: '30/12', day: 30, month: 12, year: null }, null, TODAY, false).date, '2025-12-30');
  // Today is fine; tomorrow with a year written is asked, with the last past one suggested.
  assert.equal(guardDate({ written: '29/10', day: 29, month: 10, year: null }, null, TODAY, false).date, '2026-10-29');
  const future = guardDate({ written: '30/10/2026', day: 30, month: 10, year: 2026 }, null, TODAY, false);
  assert.deepEqual([future.date, future.check?.kind, future.check?.suggestion], [null, 'future', '2025-10-30']);
  // Year from the page title.
  assert.equal(guardDate({ written: '12/10', day: 12, month: 10, year: null }, 2025, TODAY, false).date, '2025-10-12');
  // The model's day disagreeing with the text, or a date it was unsure of: asked, with a suggestion.
  const off = guardDate({ written: '12/10', day: 13, month: 10, year: null }, null, TODAY, false);
  assert.deepEqual([off.date, off.check?.kind, off.check?.suggestion], [null, 'unsure', '2026-10-12']);
  // A date with nothing written is not made up.
  assert.equal(guardDate({ written: null, day: 12, month: 10, year: null }, null, TODAY, false).date, null);
  assert.equal(guardDate({ written: '31/2', day: 31, month: 2, year: null }, null, TODAY, false).date, null);
});

test('times: clock or part of day', () => {
  assert.equal(parseTime('07.30'), '07:30');
  assert.equal(parseTime('sore'), '17:00');
  assert.equal(parseTime('Pagi'), '07:00');
  assert.equal(parseTime(''), null);
  assert.equal(localIso('2026-10-12', '07:00', 'Asia/Jakarta'), '2026-10-12T00:00:00.000Z');
});

test('pond names map to the farm ponds; unknown names are flagged for the farmer', () => {
  assert.equal(one({ pond: 'kolam be' }).pondId, 2);
  assert.equal(one({ pond: 'dekat pintu' }).pondId, 2);
  assert.equal(one({ pond: 'C 1' }).pondId, 3);
  const unknown = one({ pond: 'kolam pojok' });
  assert.equal(unknown.pondId, null);
  assert.deepEqual([unknown.checks[0].field, unknown.checks[0].kind, unknown.checks[0].written], ['pond', 'unknown', 'kolam pojok']);
  assert.equal(unknown.suggestions.length, 3);
  // The page title names the pond; a page without any pond name uses the pond the import started from.
  assert.equal(one({ pond: null }, { page_pond: 'Kolam B' }).pondId, 2);
  assert.equal(one({ pond: null }, {}, 3).pondId, 3);
  assert.equal(one({ pond: null }).checks[0].kind, 'unknown');
});

test('empty rows are dropped; feed and notes are kept as a note', () => {
  const blank = row({ temperature: cell(null), ph: cell(null), tds: cell(null) });
  const fed = row({ feed: 'cacing, habis', note: 'air keruh' });
  const res = guardNotebook(page([blank, fed]), PONDS, { today: TODAY, page: 2 });
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].key, 'p2r1');
  assert.equal(res.rows[0].note, 'Pakan: cacing, habis; air keruh');
});

// ---------- API: read saves nothing; save only what the farmer confirmed ----------

const photo = () => {
  const form = new FormData();
  form.append('image', new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }), 'page.jpg');
  return form;
};

test('reading a notebook page saves nothing; the sample is labelled', async () => {
  const s = await farmWithWorker('2026-10-29T03:00:00Z', { ai: createAi({ chat: [], mock: true }) });
  const before = s.store.farm(1).farmLogsSince('2000-01-01').length;
  const res = await s.owner('POST', '/notebook/read', photo());
  assert.equal(res.status, 200);
  const page = res.json.page;
  assert.equal(page.mode, 'mock');
  assert.match(page.problems[0], /Mode contoh, bukan hasil AI/);
  assert.equal(s.store.farm(1).farmLogsSince('2000-01-01').length, before);
  const checks = page.rows.flatMap((r: { checks: { field: string; kind: string }[] }) => r.checks.map((c) => `${c.field}:${c.kind}`));
  assert.ok(checks.includes('ph:odd') && checks.includes('temperature:odd') && checks.includes('ph:unsure') && checks.includes('pond:unknown'));
  // No photo, or no AI at all.
  assert.equal((await s.owner('POST', '/notebook/read', new FormData())).status, 400);
  const off = await farmWithWorker(undefined, { ai: createAi({ chat: [], mock: false }) });
  assert.equal((await off.owner('POST', '/notebook/read', photo())).status, 503);
});

test('the read uses the farm AI quota like a meter photo', async () => {
  let reads = 0;
  const ai = { mode: 'meta', notebook: async () => (reads++, { raw: page([row()]), model: 'test/m', mode: 'meta' }) } as unknown as Ai;
  const s = await farmWithWorker('2026-10-29T03:00:00Z', { ai, farmAiCap: 1 });
  assert.equal((await s.worker('POST', '/notebook/read', photo())).status, 200);
  const second = await s.worker('POST', '/notebook/read', photo());
  assert.equal(second.status, 429);
  assert.equal(second.json.code, 'ai_quota');
  assert.equal(reads, 1);
});

test('confirmed rows are saved as notebook records; a pond+date already recorded is skipped unless asked', async () => {
  const s = await farmWithWorker('2026-10-29T03:00:00Z');
  const [a, b] = s.ponds;
  // Kolam A already has a record on 20 October.
  await s.owner('POST', `/ponds/${a.id}/logs`, { readings: { temperature: 28 }, loggedAt: '2026-10-20T02:00:00Z' });
  const rows = [
    { key: 'p1r1', pondId: a.id, date: '2026-10-20', time: '07:00', data: { readings: { temperature: 27.5, ph: 7.4 } } },
    { key: 'p1r2', pondId: b.id, date: '2026-10-20', time: '07:00', data: { readings: { temperature: 27.8 }, mortality: 2, note: 'Pakan: cacing, habis' } },
    { key: 'p2r1', pondId: b.id, date: '2026-10-20', time: '07:00', data: { readings: { temperature: 27.8 }, mortality: 2, note: 'Pakan: cacing, habis' } },
    { key: 'p1r3', pondId: a.id, date: '2026-10-20', time: '17:00', data: { readings: { temperature: 28.4 } }, alsoIfRecorded: true },
    { key: 'p1r4', pondId: a.id, date: '2026-09-02', time: null, data: { readings: { tds: 150 } } },
  ];
  const res = await s.worker('POST', '/notebook/save', { rows });
  assert.equal(res.status, 201);
  assert.deepEqual(res.json.saved.map((x: { key: string }) => x.key), ['p1r2', 'p1r3', 'p1r4']);
  assert.deepEqual(res.json.skipped, [
    { key: 'p1r1', reason: 'recorded' },
    { key: 'p2r1', reason: 'repeat' },
  ]);
  // Saved with the source, the farm-local time, and older than the usual 14-day history.
  const hist = (await s.owner('GET', `/ponds/${a.id}/history?days=90`)).json;
  const old = hist.logs.find((l: { data: { readings?: { tds?: number } } }) => l.data.readings?.tds === 150);
  assert.equal(old.source, 'notebook');
  assert.equal(old.loggedAt, '2026-09-02T05:00:00.000Z'); // no time written: 12.00 WIB
  assert.equal((await s.owner('GET', `/ponds/${a.id}/history`)).json.logs.some((l: { id: number }) => l.id === old.id), false);
  const bLogs = (await s.owner('GET', `/ponds/${b.id}/history`)).json.logs;
  assert.equal(bLogs[0].loggedAt, '2026-10-20T00:00:00.000Z');
  assert.equal(bLogs[0].data.mortality, 2);
  // Old dead eels do not open a dead-eel case.
  assert.equal((await s.owner('GET', '/cases')).json.cases.length, 0);
});

test('saving checks every row first: a future date or a bad value saves nothing', async () => {
  const s = await farmWithWorker('2026-10-29T03:00:00Z');
  const [a] = s.ponds;
  const good = { key: 'r1', pondId: a.id, date: '2026-10-20', time: null, data: { readings: { ph: 7.2 } } };
  const future = await s.owner('POST', '/notebook/save', { rows: [good, { ...good, key: 'r2', date: '2026-10-30' }] });
  assert.equal(future.status, 400);
  const bad = await s.owner('POST', '/notebook/save', { rows: [good, { ...good, key: 'r2', data: { readings: { ph: 74 } } }] });
  assert.equal(bad.status, 400);
  const otherFarm = await s.owner('POST', '/notebook/save', { rows: [{ ...good, pondId: 999 }] });
  assert.equal(otherFarm.status, 400);
  assert.equal((await s.owner('GET', `/ponds/${a.id}/history?days=30`)).json.logs.length, 0);
  // Today's row with a later time is kept at "now", never in the future.
  const now = await s.owner('POST', '/notebook/save', { rows: [{ ...good, date: '2026-10-29', time: '17:00' }] });
  assert.equal(now.status, 201);
  assert.equal((await s.owner('GET', `/ponds/${a.id}/history`)).json.logs[0].loggedAt, '2026-10-29T03:00:00.000Z');
});
