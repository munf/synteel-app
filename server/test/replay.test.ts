// Replay runs (replay.ts): the anonymiser, runs from an app database's AI call ledger, runs from a saved
// benchmark, and the bundle the public page ships with.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { anonymise, anonymiseText, runsFromBench, runsFromLedger, type RunBundle } from '../src/replay.ts';
import { createAi } from '../src/ai.ts';
import { server } from './helpers.ts';

const ROOT = new URL('../../', import.meta.url).pathname;

test('anonymiser: phone numbers, e-mail addresses, coordinates and places finer than the village go', () => {
  const o = { names: ['Sutrisno'], farms: ['Tambak Sidat Sutris'], places: ['Karanglo'] };
  assert.equal(anonymiseText('WA 0812-3456-7890, +62 812 3456 7890 atau 6281234567890', o), 'WA [nomor], [nomor] atau [nomor]');
  assert.equal(anonymiseText('surel sutris.eel@gmail.com', o), 'surel [email]');
  assert.equal(anonymiseText('titik -7.7651234, 110.4876543', o), 'titik [lokasi]');
  assert.equal(anonymiseText('Jl. Kaliurang Km 5, RT 03/RW 05, Kalasan', o), '[lokasi], [lokasi], Kalasan');
  assert.equal(anonymiseText('Dusun Karanglo dekat sungai', o), '[lokasi] dekat sungai');
  assert.equal(anonymiseText('rumah di Karanglo', o), 'rumah di [lokasi]');
});

test('anonymiser: people become the pseudonym (with their "Pak"), farms "Tambak mitra"; readings and times stay', () => {
  const o = { names: ['Sutrisno', 'Budi Sutrisno'], farms: ['Tambak Sidat Sutris'] };
  assert.equal(anonymiseText('Pak Budi Sutrisno bilang Kolam B aman; sutrisno juga', o), 'Pak Budi bilang Kolam B aman; Pak Budi juga');
  assert.equal(anonymiseText('Tambak Sidat Sutris, 6 kolam', o), 'Tambak mitra, 6 kolam');
  // Ordinary words and numbers are left alone: "aerator jalan normal", decimals, ISO times.
  const plain = 'Aerator jalan normal. pH 7,4, suhu 25.8, TDS 160 pada 2026-11-09T19:16:06.297Z, 3000 ekor';
  assert.equal(anonymiseText(plain, o), plain);
});

test('anonymise: deep copy, identifying keys dropped, numbers untouched', () => {
  const v = { name: 'Sutrisno', phone: '081234567890', lat: -7.76, nested: [{ note: 'hubungi 081234567890', ms: 1234 }] };
  assert.deepEqual(anonymise(v, { names: ['Sutrisno'] }), { name: 'Pak Budi', nested: [{ note: 'hubungi [nomor]', ms: 1234 }] });
  assert.equal(v.phone, '081234567890', 'the input is not changed');
});

test('runs from an app database: one run per request with its calls, checks and the record it became', async () => {
  const t = server('2026-11-05T05:00:00Z', { ai: createAi({ chat: [], mock: true }) });
  const call = t.client();
  await call('POST', '/auth/register', { name: 'Sutrisno', phone: '0812 3456 7890', pin: '246810' });
  await call('PUT', '/farm', { name: 'Tambak Sidat Sutris', locationName: 'Karanglo' });
  const a = (await call('POST', '/ponds', { name: 'Kolam A' })).json.pond;
  await call('POST', '/ponds', { name: 'Kolam B' });
  const { round } = (await call('POST', '/round/text', { transcript: 'Kolam A suhune pitulikur, pH pitu koma papat.' })).json;
  const draft = round.drafts.find((d: { pondId: number }) => d.pondId === a.id);
  await call('POST', `/ponds/${a.id}/logs`, { ...draft.data, source: 'voice', trace: round.trace });

  const runs = runsFromLedger(t.db, { origin: 'demo', source: { en: 'test' } });
  assert.equal(runs.length, 1);
  const [run] = runs;
  assert.equal(run.kind, 'round');
  assert.equal(run.origin, 'demo');
  assert.equal(run.calls[0].outcome, 'mock');
  assert.ok(run.checks && run.checks.items.length > 0);
  assert.equal(run.input.type, 'none', 'the app keeps no recording or words');
  assert.deepEqual(run.result, { type: 'round', ponds: [{ pond: 'Kolam A', values: { temperature: 27, ph: 7.4 }, held: [] }] });
});

test('runs from a saved benchmark: the 19-call file (outcome only) and a run with every check', () => {
  const labelled = { rounds: JSON.parse(readFileSync(`${ROOT}eval/labelled/rounds.json`, 'utf8')), counts: JSON.parse(readFileSync(`${ROOT}eval/labelled/counts.json`, 'utf8')) };
  const old = runsFromBench(JSON.parse(readFileSync(`${ROOT}docs/eval-results/2026-11-10-meta.json`, 'utf8')), labelled, '2026-11-10-meta.json');
  assert.equal(old.length, 7);
  assert.ok(old.every((r) => r.origin === 'real' && r.checks?.partial));
  assert.match(old[0].source.en!, /19 model calls/);
  assert.match(old[0].source.id!, /19 panggilan model/);
  // jv-2: 29.5 °C was held back; it shows as "Cek manual" on Kolam C1, the only pond with a temperature label.
  const jv2 = old.find((r) => r.id.endsWith('jv-2'))!;
  assert.deepEqual(jv2.result.type === 'round' && jv2.result.ponds.map((p) => p.held), [['temperature'], []]);
  const g17 = old.find((r) => r.id.endsWith('g17'))!;
  assert.equal(g17.input.type, 'photo', 'internet test photos are described, never shipped');
  assert.equal(g17.result.type === 'count' && g17.result.filled, false);

  const full = runsFromBench(JSON.parse(readFileSync(`${ROOT}docs/eval-results/2026-11-10-meta-replay.json`, 'utf8')), labelled, '2026-11-10-meta-replay.json');
  assert.ok(full.every((r) => r.origin === 'real' && !r.checks?.partial && r.calls.every((c) => c.at && c.ms !== null)));
  const sam = full.find((r) => r.kind === 'count')!;
  assert.equal(sam.calls.length, 4, 'four SAM prompts, each with its own time');
  assert.ok(sam.checks!.items.some((c) => c.lang === 'en') && sam.checks!.items.some((c) => c.lang === 'id'));
});

test('the bundle the page ships with: anonymised, every run labelled real or demo', () => {
  const bundle = JSON.parse(readFileSync(`${ROOT}web/src/replay/runs.json`, 'utf8')) as RunBundle;
  assert.ok(bundle.runs.length > 0);
  assert.ok(bundle.runs.every((r) => r.origin === 'real' || r.origin === 'demo'));
  assert.ok(bundle.runs.every((r) => (r.origin === 'demo') === r.calls.every((c) => c.provider === 'mock' || c.provider === 'rules')));
  const text = JSON.stringify(bundle);
  assert.doesNotMatch(text, /(?:\+?62|\b0)8\d{8,}|@[a-z0-9-]+\.[a-z]{2,}|-?\d{1,3}\.\d{4,}/i);
  assert.doesNotMatch(text, /"(phone|email|lat|lon|image|photo|audio)"\s*:/);
});
