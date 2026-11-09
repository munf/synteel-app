import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withLang } from '../src/i18n.ts';
import { combine } from '../src/sam.ts';
import { guardRound } from '../src/round.ts';
import { adviceChecks, numbersSaid, rangeCheck, verifyAdvice, verifyCount, verifyDraft, verifyRound, verifyRows } from '../src/verify.ts';

const ponds = [
  { id: 1, name: 'Kolam A', nicknames: [] },
  { id: 2, name: 'Kolam B', nicknames: ['kolam dekat pintu'] },
];
const has = (said: number[], v: number) => said.some((s) => Math.abs(s - v) < 0.005);

test('numbers said: digits, Indonesian, Javanese and English number words', () => {
  const id = numbersSaid('Kolam A, suhu dua delapan koma enam, pH tujuh koma dua, TDS seratus enam puluh dua. Mati satu.');
  for (const v of [28.6, 7.2, 162, 1]) assert.ok(has(id, v), `${v} in Indonesian`);
  const jv = numbersSaid('Kolam A suhune pitulikur, pH pitu koma papat. Kolam B ana sing mati loro, telung puluh');
  for (const v of [27, 7.4, 2, 30]) assert.ok(has(jv, v), `${v} in Javanese`);
  // "satus sewidak" = 160, from the typed Javanese rounds of the benchmark (eval/labelled/rounds.json).
  assert.ok(has(numbersSaid('tds satus sewidak'), 160), '160 in Javanese');
  const en = numbersSaid('Temperature twenty-eight point six, pH seven point two, TDS one hundred sixty-two. One dead.');
  for (const v of [28.6, 7.2, 162, 1]) assert.ok(has(en, v), `${v} in English`);
  const digits = numbersSaid('suhu 28,5 pH 7.1 TDS 240');
  for (const v of [28.5, 7.1, 240]) assert.ok(has(digits, v), `${v} in digits`);
  // Never said: not found.
  assert.ok(!has(id, 7.8));
  assert.ok(!has(en, 31));
});

test('ranges: plausible readings pass; a °F temperature and a ppt TDS fail with a hint', () => {
  assert.equal(rangeCheck('ph', 7.2).ok, true);
  assert.equal(rangeCheck('do', 6.5).ok, true);
  const f = rangeCheck('temperature', 82);
  assert.equal(f.ok, false);
  assert.match(f.reason!, /°F/);
  assert.match(rangeCheck('tds', 0.16).reason!, /ppt/);
  assert.equal(rangeCheck('ph', 74).ok, false);
  assert.equal(rangeCheck('do', 35).ok, false);
});

test('a voice draft keeps numbers that were said and holds back the ones that were not', () => {
  const out = verifyDraft(
    { data: { readings: { temperature: 28.6, ph: 7.8 }, mortality: 3 }, transcript: 'Kolam A suhu dua delapan koma enam, pH tujuh koma dua, mati satu.', problems: [] },
    ponds[0],
    ponds,
  );
  assert.equal(out.verify.status, 'failed');
  assert.deepEqual(out.data.readings, { temperature: 28.6 });
  assert.equal(out.data.mortality, undefined);
  assert.deepEqual(out.held.map((h) => h.field).sort(), ['mortality', 'ph']);
  assert.match(out.held.find((h) => h.field === 'ph')!.reason, /tidak terdengar/);
});

test('a draft that passes keeps everything and lists what was checked', () => {
  const out = verifyDraft({ data: { readings: { temperature: 28.6, ph: 7.2, tds: 162 }, mortality: 1 }, transcript: 'Kolam A, suhu dua delapan koma enam, pH tujuh koma dua, TDS seratus enam puluh dua. Mati satu.', problems: [] }, ponds[0], ponds);
  assert.equal(out.verify.status, 'passed');
  assert.equal(out.held.length, 0);
  assert.deepEqual(out.data, { readings: { temperature: 28.6, ph: 7.2, tds: 162 }, mortality: 1 });
  assert.deepEqual(out.verify.checks.map((c) => c.id), ['range', 'unit', 'heard', 'pond']);
});

test('a photo draft: no transcript check; an implausible or converted value is held', () => {
  const ok = verifyDraft({ data: { readings: { ph: 7.2 } }, problems: [] }, ponds[0], ponds);
  assert.equal(ok.verify.status, 'passed');
  assert.ok(!ok.verify.checks.some((c) => c.id === 'heard'));
  const odd = verifyDraft({ data: { readings: { ph: 12.5, temperature: 28 } }, problems: [] }, ponds[0], ponds);
  assert.deepEqual(odd.held.map((h) => h.field), ['ph']);
  assert.deepEqual(odd.data.readings, { temperature: 28 });
  const ppt = verifyDraft({ data: { readings: { tds: 160 }, note: 'Layar menunjukkan 0,16 ppt, diubah ke ppm' }, problems: [] }, ponds[0], ponds);
  assert.equal(ppt.held[0]?.field, 'tds');
  assert.equal(ppt.verify.checks.find((c) => c.id === 'unit')?.ok, false);
});

test('a recording that names another pond, or a pond not on the farm, fails the pond check', () => {
  const other = verifyDraft({ data: { readings: { temperature: 28 } }, transcript: 'Kolam B suhu 28', problems: [] }, ponds[0], ponds);
  assert.equal(other.verify.checks.find((c) => c.id === 'pond')?.ok, false);
  assert.match(other.verify.checks.find((c) => c.id === 'pond')!.reason!, /Kolam B/);
  const missing = verifyDraft({ data: {}, transcript: 'kolam Z airnya hijau', problems: [] }, ponds[0], ponds);
  assert.equal(missing.verify.status, 'failed');
  // "kolam ini", "kolam sore" are not pond names.
  assert.equal(verifyDraft({ data: { readings: { temperature: 28 } }, transcript: 'kolam ini suhu 28', problems: [] }, ponds[0], ponds).verify.status, 'passed');
});

test('a round: a number not heard in its pond quote becomes an unverified issue, never filled in', () => {
  const raw = {
    loose: { quote: '', temperature: null, ph: null, tds: null, mortality: null, behavior: [], feeding_leftover: null, water_color: null, water_smell: null, aeration: null, note: null },
    mentions: [
      { pond_as_heard: 'Kolam A', pond_id: 1, quote: 'Kolam A suhune pitulikur, pH pitu koma papat.', unclear_text: null, temperature: 27, ph: 7.4, tds: null, mortality: 5, behavior: [], feeding_leftover: null, water_color: null, water_smell: null, aeration: null, note: null },
      { pond_as_heard: 'kolam pojok', pond_id: null, quote: 'Kolam pojok banyune rada ijo.', unclear_text: null, temperature: null, ph: null, tds: null, mortality: null, behavior: [], feeding_leftover: null, water_color: 'green', water_smell: null, aeration: null, note: null },
    ],
  };
  const r = verifyRound(guardRound(raw, ponds, 'Kolam A suhune pitulikur, pH pitu koma papat. Kolam pojok banyune rada ijo.', { model: 'test', mode: 'meta' }), ponds);
  const a = r.drafts.find((d) => d.pondId === 1)!;
  assert.deepEqual(a.data.readings, { temperature: 27, ph: 7.4 });
  assert.equal(a.data.mortality, undefined);
  assert.deepEqual(a.issues, [{ kind: 'unverified', field: 'mortality', value: 5, note: '5 sidat mati tidak terdengar di rekaman.' }]);
  const pojok = r.drafts.find((d) => d.pondId === null)!;
  assert.equal(pojok.verify?.checks.find((c) => c.id === 'pond')?.ok, false);
  assert.equal(r.verify.status, 'failed');
});

test('a round: an auto-fixed pH (74 → 7,4) is checked as it was heard', () => {
  const raw = { loose: {}, mentions: [{ pond_as_heard: 'Kolam B', pond_id: 2, quote: 'Kolam B pH pitu papat', unclear_text: null, ph: 74 }] };
  const r = verifyRound(guardRound(raw, ponds, 'Kolam B pH pitu papat', { model: 'test', mode: 'meta' }), ponds);
  assert.equal(r.drafts[0].data.readings?.ph, 7.4);
  assert.equal(r.verify.status, 'passed');
});

// Synthetic outlines: a box, a score and a mask size.
const eel = (left: number, top: number, score: number, area = 400, w = 40, h = 10, path = 'M0 0') => ({ left, top, right: left + w, bottom: top + h, path, score, area, label: { x: left, y: top } });
const eye = (x: number, y: number) => eel(x, y, 0.6, 9, 3, 3);

test('a count passes when bodies and heads agree and outlines are sane', () => {
  const r = combine([[eel(0, 0, 0.9), eel(100, 0, 0.9), eel(200, 0, 0.9)]], [eye(0, 0), eye(5, 0), eye(100, 0), eye(105, 0), eye(200, 0), eye(205, 0)]);
  assert.equal(verifyCount(r).status, 'passed');
});

test('a count fails on an empty mask, bodies and heads far apart, or an outline the size of the scoop', () => {
  const empty = verifyCount(combine([[eel(0, 0, 0.9), eel(100, 0, 0.9, 0)]], []));
  assert.equal(empty.checks.find((c) => c.id === 'masks')?.ok, false);
  const noPath = verifyCount(combine([[eel(0, 0, 0.9, 400, 40, 10, '')]], []));
  assert.equal(noPath.status, 'failed');
  // 2 clear bodies, 9 heads: a pile the bodies missed.
  const heads = Array.from({ length: 9 }, (_, i) => eye(i * 50, 100));
  const apart = verifyCount(combine([[eel(0, 0, 0.9), eel(100, 0, 0.9)]], heads));
  assert.equal(apart.checks.find((c) => c.id === 'agree')?.ok, false);
  const huge = verifyCount(combine([[eel(0, 0, 0.9), eel(100, 0, 0.9), eel(200, 0, 0.9), eel(0, 50, 0.9, 40000, 400, 400)]], []));
  assert.equal(huge.checks.find((c) => c.id === 'area')?.ok, false);
  // A number with nothing marked.
  assert.equal(verifyCount({ count: 3, low: 3, high: 3, atLeast: false, eels: [], heads: [], review: false, model: 'x' }).status, 'failed');
});

test('advice may not call a pond safe while the rules see danger: the rules win', () => {
  const risk = [{ name: 'Kolam B', level: 'critical' as const }];
  assert.equal(verifyAdvice('Malam ini semua kolam aman, tidak perlu bangun.', risk).status, 'failed');
  assert.equal(verifyAdvice('Kolam B aman malam ini.', risk).status, 'failed');
  // Calm words that never name the pond the rules worry about.
  assert.equal(verifyAdvice('Malam ini tenang, tidur saja.', risk).status, 'failed');
  // Names the danger: fine, even with "tetap tenang" or "tidak aman".
  assert.equal(verifyAdvice('Kolam B tidak aman sekitar 03.00: risiko oksigen naik. Tetap tenang, pastikan aerator nyala.', risk).status, 'passed');
  assert.equal(verifyAdvice('Kolam A aman. Kolam B perlu dicek jam 03.00, risiko oksigen naik.', risk).status, 'passed');
  // Nothing at risk: calm words are fine.
  assert.equal(verifyAdvice('Malam ini semua kolam aman.', []).status, 'passed');
  withLang('en', () => assert.equal(verifyAdvice('All ponds are safe tonight.', risk).checks.find((c) => c.id === 'rules')?.ok, false));
});

test('advice never carries a medicine, a dose or a diagnosis', () => {
  const v = verifyAdvice('Beri garam 5 gram per liter, sidat terkena infeksi bakteri.', []);
  assert.equal(v.checks.find((c) => c.id === 'safe')?.ok, false);
  const full = adviceChecks('Kolam aman.', [], { overstated: true, fits: false });
  assert.deepEqual(full.checks.filter((c) => !c.ok).map((c) => c.id), ['data', 'form']);
});

test('notebook rows: any cell marked for a look fails the page check with its note', () => {
  assert.equal(verifyRows([{ checks: [] }]).status, 'passed');
  const v = verifyRows([{ checks: [{ note: 'pH 74 tidak masuk akal' }] }]);
  assert.equal(v.status, 'failed');
  assert.match(v.checks[0].reason!, /pH 74/);
});

test('Javanese: "selikur sanga koma lima" is 29.5, as the round prompt reads it, and is not held back', () => {
  assert.ok(has(numbersSaid('suhune selikur sanga koma lima'), 29.5));
  assert.ok(has(numbersSaid('suhune selikur sanga'), 29));
  assert.ok(has(numbersSaid('sangalikur koma lima'), 29.5));
  // Only a twenties word and one digit: "selikur" alone stays 21, "selikur sanga wolu" is not 298.
  assert.ok(!has(numbersSaid('selikur'), 29));
  assert.ok(!has(numbersSaid('selikur sanga wolu'), 298));
  // The benchmark's jv-2 round (eval/labelled/rounds.json): C1 29.5 °C and TDS 160 both pass.
  const out = verifyDraft(
    { data: { readings: { temperature: 29.5, tds: 160 } }, transcript: 'Kolam A suhune selikur sanga koma lima, tds satus sewidak.', problems: [] },
    ponds[0],
    ponds,
  );
  assert.equal(out.verify.status, 'passed');
  assert.equal(out.held.length, 0);
});

test('English check reasons count right: one outline, one cell, one dead eel', () =>
  withLang('en', () => {
    const one = verifyCount(combine([[eel(0, 0, 0.9), eel(100, 0, 0.9, 0)]], []));
    assert.match(one.checks.find((c) => c.id === 'masks')!.reason!, /^1 outline is empty/);
    const huge = verifyCount(combine([[eel(0, 0, 0.9), eel(100, 0, 0.9), eel(200, 0, 0.9), eel(0, 50, 0.9, 40000, 400, 400)]], []));
    assert.match(huge.checks.find((c) => c.id === 'area')!.reason!, /^1 outline is far/);
    const apart = verifyCount(combine([[eel(0, 0, 0.9)]], Array.from({ length: 9 }, (_, i) => eye(i * 50, 100))));
    assert.match(apart.checks.find((c) => c.id === 'agree')!.reason!, /1 clear body, 9 heads/);
    assert.match(verifyRows([{ checks: [{ note: 'pH 74' }] }]).checks[0].reason!, /^1 cell needs a look/);
    const dead = verifyDraft({ data: { mortality: 1 }, transcript: 'Kolam A normal.', problems: [] }, ponds[0], ponds);
    assert.match(dead.held[0].reason, /^1 dead eel was not heard/);
  }));
