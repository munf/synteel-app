import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { unsafeText } from '../src/agentloop.ts';
import { caseFacts, guardCase, runCaseAgent, type CaseInput } from '../src/cases.ts';
import { farmWithWorker } from './helpers.ts';

const H = 3600_000;
const DAY = 24 * H;

/** A dead-eel report from Masalah, as the app sends it. */
const report = (dead: number) => ({ mortality: dead, behavior: ['surfacing'], note: 'Laporan masalah: sidat mati', report: 'dead' });

async function cases(f: Awaited<ReturnType<typeof farmWithWorker>>, who = f.worker, pond?: number) {
  await f.api.settleCases();
  return (await who('GET', `/cases${pond ? `?pond=${pond}` : ''}`)).json.cases as any[];
}

test('a dead-eel report opens a case; a second report adds to it; a plain record does not open one', async () => {
  const f = await farmWithWorker();
  const [a, b] = f.ponds;
  assert.equal((await f.worker('POST', `/ponds/${a.id}/logs`, report(5))).status, 201);
  assert.equal((await f.worker('POST', `/ponds/${a.id}/logs`, report(3))).status, 201);
  // Daily record with a death on another pond: no case of its own.
  await f.worker('POST', `/ponds/${b.id}/logs`, { mortality: 1, readings: { temperature: 28 } });
  const list = await cases(f);
  assert.equal(list.length, 1);
  assert.equal(list[0].pondId, a.id);
  assert.equal(list[0].total, 8);
  assert.equal(list[0].days.length, 1);
  assert.equal(list[0].trend, 'first');
  // No model: the update is written from the rules, with at most 2 questions.
  assert.equal(list[0].run.source, 'rules');
  assert.match(list[0].run.summary, /8 ekor mati hari ini/);
  assert.ok(list[0].openQuestions.length > 0 && list[0].openQuestions.length <= 2);
  // A death in a daily record on a pond with an open case adds to it.
  await f.worker('POST', `/ponds/${a.id}/logs`, { mortality: 2 });
  assert.equal((await cases(f))[0].total, 10);
});

test('deaths rising compared with yesterday put "Kirim ke pemilik" on the case, with the owner number', async () => {
  const f = await farmWithWorker();
  const pond = f.ponds[0].id;
  await f.worker('POST', `/ponds/${pond}/logs`, report(2));
  await f.worker('POST', `/ponds/${pond}/logs`, { behavior: ['normal'], recheck: 'better' });
  let c = (await cases(f))[0];
  assert.equal(c.escalate, null);
  assert.equal(c.recheck.answered, true);

  f.now.t = new Date(f.now.t.getTime() + DAY);
  await f.worker('POST', `/ponds/${pond}/logs`, report(6));
  await f.worker('POST', `/ponds/${pond}/logs`, { behavior: ['normal'], recheck: 'better' });
  c = (await cases(f))[0];
  assert.equal(c.trend, 'up');
  assert.deepEqual(c.escalate.reasons, ['rising']);
  assert.match(c.escalate.waUrl, /^https:\/\/wa\.me\/6281111111111\?text=/);
  assert.equal(c.escalate.ownerName, 'Petani Demo');
  const text = decodeURIComponent(c.escalate.waUrl.split('text=')[1]);
  assert.match(text, /Kemarin: 2 ekor/);
  assert.match(text, /Hari ini: 6 ekor/);
  assert.match(text, /naik/);
});

test('an unanswered re-check escalates; answering it clears that reason', async () => {
  const f = await farmWithWorker();
  const pond = f.ponds[0].id;
  await f.worker('POST', `/ponds/${pond}/logs`, report(4));
  f.now.t = new Date(f.now.t.getTime() + 2 * H);
  let c = (await cases(f))[0];
  assert.deepEqual(c.escalate.reasons, ['recheck_missed']);
  assert.match(decodeURIComponent(c.escalate.waUrl), /Cek ulang jam 11\.00 belum dijawab/);
  // The background pass gives the missed re-check its own run, once.
  f.api.caseRechecks();
  c = (await cases(f))[0];
  assert.equal(c.run.trigger, 'recheck_missed');
  await f.worker('POST', `/ponds/${pond}/logs`, { mortality: 1, behavior: ['surfacing'], recheck: 'worse' });
  c = (await cases(f))[0];
  assert.equal(c.escalate, null);
  assert.equal(c.recheck.better, false);
  assert.equal(c.total, 5);
});

test('after 2 recorded days without deaths closing is suggested; the farmer closes and the case stays in history', async () => {
  const f = await farmWithWorker();
  const pond = f.ponds[0].id;
  await f.worker('POST', `/ponds/${pond}/logs`, report(3));
  const id = (await cases(f))[0].id;
  // Closing is not offered yet, and a worker cannot force it.
  assert.equal((await f.worker('POST', `/cases/${id}/close`)).status, 400);

  f.now.t = new Date(f.now.t.getTime() + DAY);
  let c = (await cases(f))[0];
  assert.equal(c.canMarkNoDead, true);
  assert.equal((await f.worker('POST', `/cases/${id}/nodead`)).status, 200);
  c = (await cases(f))[0];
  assert.equal(c.closeSuggested, false);
  assert.equal(c.canMarkNoDead, false);

  f.now.t = new Date(f.now.t.getTime() + DAY);
  await f.worker('POST', `/ponds/${pond}/logs`, { readings: { temperature: 28 } });
  c = (await cases(f))[0];
  assert.equal(c.closeSuggested, true);
  assert.equal((await f.worker('POST', `/cases/${id}/close`)).json.case.status, 'closed');
  assert.equal((await cases(f)).length, 0);
  const history = await cases(f, f.worker, pond);
  assert.equal(history.length, 1);
  assert.equal(history[0].status, 'closed');
  assert.equal(history[0].escalate, null);

  // A new report after closing opens a new case.
  await f.worker('POST', `/ponds/${pond}/logs`, report(1));
  assert.equal((await cases(f, f.worker, pond)).filter((x) => x.status === 'open').length, 1);
});

test('answers are stored with the case and asked questions are not asked again', async () => {
  const f = await farmWithWorker();
  const pond = f.ponds[0].id;
  await f.worker('POST', `/ponds/${pond}/logs`, report(2));
  const c = (await cases(f))[0];
  const q = c.openQuestions[0].q;
  const res = await f.worker('POST', `/cases/${c.id}/answers`, { answers: [{ q, a: c.openQuestions[0].answers[0] }] });
  assert.equal(res.status, 200);
  const after = (await cases(f))[0];
  assert.equal(after.answers.length, 1);
  assert.ok(!after.openQuestions.some((x: any) => x.q === q));
  assert.equal((await f.worker('POST', `/cases/${c.id}/answers`, { answers: [] })).status, 400);
  // Another farm's case is not found.
  const other = await farmWithWorker();
  assert.equal((await other.worker('POST', `/cases/${c.id}/answers`, { answers: [{ q, a: 'Ya' }] })).status, 404);
});

// ---------- the agent and its guard ----------

const NOW = Date.parse('2026-10-29T03:00:00Z'); // 10.00 WIB

function input(): CaseInput {
  const log = (daysAgo: number, dead: number) => ({ id: daysAgo, pondId: 2, batchId: 1, loggedAt: new Date(NOW - daysAgo * DAY - H).toISOString(), source: 'manual' as const, data: { mortality: dead } });
  return {
    caseId: 1,
    pondId: 2,
    pondName: 'Kolam B',
    phase: 'glass_eel',
    week: 3,
    openedAt: NOW - DAY - 2 * H,
    now: NOW,
    timezone: 'Asia/Jakarta',
    logs: [log(0, 7), log(1, 3)],
    events: [{ id: 1, at: new Date(NOW - H).toISOString(), kind: 'report', userId: 1, data: { dead: 7, recheck: true } }],
    findings: [],
    latest: { temperature: { value: 29.6, at: new Date(NOW - 2 * H).toISOString() } },
    nowcast: null,
    weather: [],
    history: () => [{ date: '2026-10-29', dead: 7 }],
    trigger: 'report',
  };
}

test('case facts: dead per day and the trend', () => {
  const f = caseFacts(input());
  assert.deepEqual(f.days.map((d) => d.dead), [3, 7]);
  assert.equal(f.rising, true);
  assert.equal(f.recheck!.answered, false);
  assert.equal(f.recheck!.missed, false);
});

test('the guard blocks dosing and diagnosis, and keeps rule checks', () => {
  for (const bad of ['Beri antibiotik 5 mg per liter', 'Rendam garam 3 gram per liter selama 10 menit', 'Sidat terinfeksi Aeromonas', 'Kemungkinan penyakit bintik putih', 'The eels have a bacterial infection', 'Use a salt bath'])
    assert.ok(unsafeText(bad), bad);
  for (const ok of ['Ini bukan diagnosis. Pastikan aerator nyala.', 'TDS 160 ppm masih baik', 'Ukur pH dan suhu air jam 16.00'])
    assert.ok(!unsafeText(ok), ok);

  const dosing = guardCase(input(), { summary: 'Kolam B perlu formalin 25 ppm obat malam ini supaya kematian berhenti.', watch: [] }, [], 'm');
  assert.equal(dosing.source, 'rules');
  const diagnosis = guardCase(input(), { summary: 'Kolam B kemungkinan terserang penyakit insang, jumlah mati naik dari 3 ke 7.', watch: [] }, [], 'm');
  assert.equal(diagnosis.source, 'rules');

  const run = guardCase(
    input(),
    {
      summary: 'Kematian di Kolam B naik dari 3 ke 7. Suhu air 29,6 °C agak tinggi; pastikan aerator nyala dan angkat sidat mati.',
      watch: ['Sidat di permukaan', 'Beri obat bila naik lagi'],
      questions: [
        { q: 'Aerator semalam nyala?', answers: ['Nyala', 'Mati'] },
        { q: 'Apakah ada bercak Saprolegnia?', answers: ['Ya', 'Tidak'] },
        { q: 'Kamu sudah ganti air?', answers: ['Ya', 'Tidak'] },
      ],
      checks: [
        { time: '13:00', action: 'Ukur suhu air', why: 'Siang panas' },
        { time: '14:00', action: 'Beri antibiotik', why: '-' },
        { time: '07:00', action: 'Lewat batas', why: 'terlalu jauh' },
      ],
      ownerNote: 'Mohon kirim dosis obat yang tepat.',
    },
    [{ tool: 'get_case', args: {} }],
    'baseten/open',
  );
  assert.equal(run.source, 'agent');
  assert.deepEqual(run.watch, ['Sidat di permukaan']);
  assert.deepEqual(run.questions.map((q) => q.q), ['Aerator semalam nyala?']);
  // The rule re-check (11.00) stays; one agent check is added.
  assert.deepEqual(run.checks.map((c) => [c.source, c.action]), [
    ['rules', 'Cek ulang: sidat sudah turun dan berenang normal?'],
    ['agent', 'Ukur suhu air'],
  ]);
  assert.doesNotMatch(run.ownerNote, /dosis/);
});

const listen = (s: ReturnType<typeof createServer>) => new Promise<string>((resolve) => s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(s.address() as { port: number }).port}`)));
const call = (id: string, name: string, args: unknown) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('the first provider out of credits: the next one runs the case agent; extra questions are refused', async () => {
  const spent = createServer((_req, res) => (res.writeHead(402, { 'content-type': 'application/json' }), res.end('{"error":{"message":"credits"}}')));
  const answers = [
    { tool_calls: [call('a', 'get_case', {}), call('b', 'get_pond_logs', { days: 2 })] },
    { tool_calls: [call('c', 'ask_farmer', { question: 'Aerator semalam nyala?', answers: ['Nyala', 'Mati'] }), call('d', 'ask_farmer', { question: 'Sisa pakan banyak?', answers: ['Banyak', 'Habis'] }), call('e', 'ask_farmer', { question: 'Air bau?', answers: ['Ya', 'Tidak'] })] },
    // 10.15 is next to the rule re-check at 10.00: refused at once, so the model can move it.
    { tool_calls: [call('f0', 'add_check', { time: '10:15', action: 'Angkat sisa pakan', why: 'Sisa pakan banyak' }), call('f', 'add_check', { time: '15:00', action: 'Lihat sidat di permukaan', why: 'Kematian naik' }), call('g', 'draft_owner_message', { text: 'Kematian naik, aerator sedang dicek.' })] },
    { tool_calls: [call('h', 'submit_case_update', { summary: 'Kematian di Kolam B naik dari 3 ke 7. Aerator dan sisa pakan sedang ditanyakan.', watch: ['Sidat di permukaan'] })] },
  ];
  const toolAnswers: string[] = [];
  const working = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      for (const m of JSON.parse(raw).messages.filter((m: any) => m.role === 'tool')) toolAnswers.push(m.content);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '', ...answers.shift() } }] }));
    });
  });
  const [spentBase, workingBase] = [await listen(spent), await listen(working)];
  try {
    // An answer from yesterday morning: get_case names the day, so it is not read as today's.
    const withAnswer = { ...input(), events: [...input().events, { id: 2, at: new Date(NOW - DAY - H).toISOString(), kind: 'answer' as const, userId: 1, data: { answers: [{ q: 'Aerator semalam nyala terus?', a: 'Nyala terus' }] } }] };
    const run = await runCaseAgent(withAnswer, [
      { name: 'baseten', apiKey: 'k', base: spentBase, model: 'open' },
      { name: 'meta', apiKey: 'k', base: workingBase, model: 'm' },
    ]);
    assert.equal(run.source, 'agent');
    assert.equal(run.model, 'meta/m');
    assert.equal(run.questions.length, 2);
    assert.ok(toolAnswers.some((t) => /Sudah 2 pertanyaan/.test(t)));
    assert.ok(toolAnswers.some((t) => /dead_per_day/.test(t)));
    const got = JSON.parse(toolAnswers.find((t) => /dead_per_day/.test(t))!);
    assert.deepEqual(got.farmer_answers.map((a: any) => a.time), ['Kemarin 09.00']);
    assert.equal(got.recheck.due, 'Hari ini 10.00');
    assert.ok(toolAnswers.some((t) => /10\.00 sudah ada cek aturan/.test(t)));
    assert.deepEqual(run.steps.map((s) => s.tool), ['get_case', 'get_pond_logs', 'ask_farmer', 'ask_farmer', 'ask_farmer', 'add_check', 'add_check', 'draft_owner_message', 'submit_case_update']);
    assert.equal(run.ownerNote, 'Kematian naik, aerator sedang dicek.');
    assert.deepEqual(run.checks.filter((c) => c.source === 'agent').map((c) => c.action), ['Lihat sidat di permukaan']);
  } finally {
    spent.close();
    working.close();
  }
});

test('every provider failing: the case is written from the rules', async () => {
  const down = createServer((_req, res) => (res.writeHead(503), res.end('{}')));
  const base = await listen(down);
  try {
    const run = await runCaseAgent(input(), [{ name: 'baseten', apiKey: 'k', base, model: 'open' }]);
    assert.equal(run.source, 'rules');
    assert.match(run.summary, /7 ekor mati hari ini, naik dari 3 kemarin/);
    assert.ok(run.questions.length <= 2);
  } finally {
    down.close();
  }
});
