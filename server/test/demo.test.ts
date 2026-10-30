// "Coba demo" copies of the template farm, their expiry and abuse limits, and AI results per language.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { DEMO_MAX_LIVE, DEMO_PER_IP_PER_DAY } from '../src/demo.ts';
import { MAX_LANG_BRIEFINGS_PER_DAY } from '../src/api.ts';
import { MAX_LANG_RUNS_PER_DAY } from '../src/cases.ts';
import { farmWithWorker, server, type Deps } from './helpers.ts';

const H = 3600_000;
const call = (id: string, name: string, args: unknown) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

/**
 * A model that submits at once: the briefing or the case update, in the language the prompt asks for.
 * `runs` counts agent runs by kind and language.
 */
async function fakeAgent() {
  const runs: string[] = [];
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = JSON.parse(raw);
      const system = body.messages[0].content as string;
      const en = /in clear, (natural|plain) English/.test(system);
      const briefing = body.tools.some((t: any) => t.function.name === 'submit_briefing');
      runs.push(`${briefing ? 'briefing' : 'case'} ${en ? 'en' : 'id'}`);
      const message = briefing
        ? { tool_calls: [call('b', 'submit_briefing', { summary: en ? 'Kolam B needs a look before bed: warm water and leftover feed.' : 'Kolam B perlu dilihat sebelum tidur: air hangat dan sisa pakan banyak.', checks: [] })] }
        : { tool_calls: [call('c', 'submit_case_update', { summary: en ? 'Deaths in Kolam B are rising. Take out the dead eels and check the aerator.' : 'Kematian di Kolam B naik. Angkat sidat mati dan cek aerator.', watch: [en ? 'Eels at the surface' : 'Sidat di permukaan'] })] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '', ...message } }] }));
    });
  });
  const base = await new Promise<string>((resolve) => srv.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(srv.address() as { port: number }).port}`)));
  return { runs, deps: { ai: { mode: 'meta' } as Deps['ai'], agentProviders: [{ name: 'baseten', apiKey: 'k', base, model: 'open' }] } as Deps, close: () => srv.close() };
}

// 17:30 WIB: the template is built after the evening records and the 17:00 briefing.
const BUILT = '2026-10-28T10:30:00Z';

test('the template carries AI results in both languages; each "Coba demo" gets its own copy, moved to today', async () => {
  const agent = await fakeAgent();
  try {
    const s = server(BUILT, { demoPhone: '620000000000', ...agent.deps });
    await s.api.buildDemoTemplate();
    assert.deepEqual([...agent.runs].sort(), ['briefing en', 'briefing id', 'case en', 'case id']);

    // A judge two days later, at 20:30 WIB.
    s.now.t = new Date(Date.parse(BUILT) + 2 * 24 * H + 3 * H);
    const a = s.client({ 'x-lang': 'en', 'cf-connecting-ip': '1.1.1.1' });
    const b = s.client({ 'cf-connecting-ip': '1.1.1.1' });
    const meA = (await a('POST', '/auth/demo')).json;
    const meB = (await b('POST', '/auth/demo')).json;
    assert.equal(meA.demo, true);
    assert.notEqual(meA.farm.id, meB.farm.id);
    assert.notEqual(meA.user.id, meB.user.id);
    assert.equal(meA.user.name, 'Demo Farmer');
    assert.equal(meB.user.name, 'Petani Demo');

    // English at once, from the copy: no model call.
    const caseEn = (await a('GET', '/cases')).json.cases;
    assert.equal(caseEn.length, 1);
    assert.equal(caseEn[0].pondName, 'Kolam B');
    assert.equal(caseEn[0].running, false);
    assert.equal(caseEn[0].run.source, 'agent');
    assert.match(caseEn[0].run.summary, /^Deaths in Kolam B are rising/);
    assert.equal(caseEn[0].trend, 'up');
    assert.deepEqual(caseEn[0].days.slice(-2).map((d: any) => [d.label, d.dead]), [['Yesterday', 3], ['Today', 6]]);
    assert.equal(caseEn[0].days.at(-1).date, '2026-10-30');
    const briefEn = (await a('GET', '/briefing')).json;
    assert.equal(briefEn.running, false);
    assert.equal(briefEn.briefing.source, 'agent');
    assert.match(briefEn.briefing.summary, /^Kolam B needs a look/);
    const caseId = (await b('GET', '/cases')).json.cases[0];
    assert.match(caseId.run.summary, /^Kematian di Kolam B naik/);
    assert.match((await b('GET', '/briefing')).json.briefing.summary, /^Kolam B perlu dilihat/);
    await s.api.settleCases();
    assert.equal(agent.runs.length, 4);

    // Records end today, nothing lies in the future; the copies are separate farms.
    const farmA = (await a('GET', '/farm')).json;
    assert.equal(farmA.ponds.length, 3);
    assert.ok(farmA.ponds.every((p: any) => p.lastLogAt.startsWith('2026-10-30') && Date.parse(p.lastLogAt) <= s.now.t.getTime()));
    const pondA = farmA.ponds[0].id;
    assert.equal((await a('POST', `/ponds/${pondA}/logs`, { readings: { temperature: 28.4 } })).status, 201);
    assert.equal((await a('POST', '/ponds', { name: 'Kolam D' })).status, 201);
    assert.equal((await b('GET', '/farm')).json.ponds.length, 3);
    assert.equal((await b('GET', `/ponds/${pondA}`)).status, 404);
    // Neither copy is the template, and the template is nobody's to open.
    const template = s.store.demo.template()!;
    assert.ok(![meA.farm.id, meB.farm.id].includes(template.farmId));
    assert.equal((await a('POST', '/auth/switch', { farmId: template.farmId })).status, 403);
    // The precomputed runs do not use the copy's own agent runs: answering still gets the agent.
    const q = caseId.openQuestions[0] ?? { q: 'Aerator semalam nyala terus?' };
    await b('POST', `/cases/${caseId.id}/answers`, { answers: [{ q: q.q, a: 'Ya' }] });
    await s.api.settleCases();
    assert.equal(agent.runs.at(-1), 'case id');
    assert.equal((await b('GET', '/cases')).json.cases[0].run.source, 'agent');
  } finally {
    agent.close();
  }
});

test('a copy made early in the morning keeps today\'s records before now and the case still rising', async () => {
  const s = server(BUILT, { demoPhone: '620000000000' });
  await s.api.buildDemoTemplate();
  // 06:00 WIB the next day: the 07:15 and 17:15 records would lie ahead.
  s.now.t = new Date('2026-10-28T23:00:00Z');
  const a = s.client();
  await a('POST', '/auth/demo');
  const farm = (await a('GET', '/farm')).json;
  for (const p of farm.ponds) {
    const logs = (await a('GET', `/ponds/${p.id}`)).json.logs as { loggedAt: string }[];
    assert.ok(logs.length >= 28, `${p.name}: ${logs.length} logs`);
    assert.ok(logs.every((l) => Date.parse(l.loggedAt) <= s.now.t.getTime()), p.name);
  }
  await s.api.settleCases();
  const c = (await a('GET', '/cases')).json.cases[0];
  assert.equal(c.trend, 'up');
  assert.deepEqual(c.days.slice(-2).map((d: any) => d.dead), [3, 6]);
  assert.equal(c.days.at(-1).date, '2026-10-29');
  // The rules wrote the template's case here (no model), in the viewer's language.
  assert.equal(c.run.source, 'rules');
});

test('demo copies are deleted after 48 hours with their people, sessions and files; nothing else is', async () => {
  const removed: number[] = [];
  const f = await farmWithWorker(BUILT, { demoPhone: '620000000000', removeFarmFiles: (id) => removed.push(id) });
  await f.api.buildDemoTemplate();
  const a = f.client();
  const me = (await a('POST', '/auth/demo')).json;
  f.now.t = new Date(Date.parse(BUILT) + 24 * H);
  const b = f.client();
  const meB = (await b('POST', '/auth/demo')).json;

  f.now.t = new Date(Date.parse(BUILT) + 47 * H);
  assert.equal(f.api.expireDemos(), 0);
  assert.equal((await a('GET', '/farm')).status, 200);

  f.now.t = new Date(Date.parse(BUILT) + 48 * H + 60_000);
  assert.equal(f.api.expireDemos(), 1);
  assert.deepEqual(removed, [me.farm.id]);
  assert.equal((await a('GET', '/farm')).status, 401);
  assert.equal(f.store.user(me.user.id), null);
  assert.equal(f.store.farm(me.farm.id).getFarm(), null);
  assert.equal(f.store.farm(me.farm.id).listPonds().length, 0);
  // The later copy, the template and a real farm stay.
  assert.equal((await b('GET', '/auth/me')).json.farm.id, meB.farm.id);
  assert.ok(f.store.demo.template());
  assert.equal((await f.owner('GET', '/farm')).json.ponds.length, 3);

  f.now.t = new Date(Date.parse(BUILT) + 73 * H);
  assert.equal(f.api.expireDemos(), 1);
  assert.equal(f.store.demo.counts('x', f.now.t).live, 0);
});

test('rebuilding the template keeps existing copies working', async () => {
  const s = server(BUILT, { demoPhone: '620000000000' });
  const first = await s.api.buildDemoTemplate();
  const a = s.client();
  const me = (await a('POST', '/auth/demo')).json;
  s.now.t = new Date(Date.parse(BUILT) + 24 * H);
  const second = await s.api.buildDemoTemplate();
  assert.notEqual(first, second);
  assert.equal(s.store.demo.template()!.farmId, second);
  assert.equal(s.store.farm(first).getFarm(), null);
  assert.equal((await a('GET', '/auth/me')).json.farm.id, me.farm.id);
  assert.equal(s.store.farmsOf(s.store.demo.template()!.userId).length, 1);
});

test('abuse limits: copies per address per day and copies alive at once, with a plain message', async () => {
  assert.ok(DEMO_PER_IP_PER_DAY >= 10 && DEMO_MAX_LIVE >= 100);
  const s = server(BUILT, { demoPhone: '620000000000', demoLimits: { perIp: 2, maxLive: 3 } });
  await s.api.buildDemoTemplate();
  const from = (ip: string, lang = 'id') => s.client({ 'cf-connecting-ip': ip, 'x-lang': lang })('POST', '/auth/demo');
  assert.equal((await from('1.1.1.1')).status, 200);
  assert.equal((await from('1.1.1.1')).status, 200);
  const third = await from('1.1.1.1', 'en');
  assert.equal(third.status, 429);
  assert.equal(third.json.code, 'demo_limit');
  assert.equal(third.json.error, 'The demo was opened many times from this network today. Try again tomorrow.');
  assert.equal((await from('2.2.2.2')).status, 200);
  const full = await from('3.3.3.3');
  assert.equal(full.status, 429);
  assert.equal(full.json.code, 'demo_full');
  assert.match(full.json.error, /Sedang banyak yang mencoba demo/);
  // A day later the address may again, but the server is still full until copies expire.
  s.now.t = new Date(Date.parse(BUILT) + 25 * H);
  assert.equal((await from('1.1.1.1')).json.code, 'demo_full');
  s.now.t = new Date(Date.parse(BUILT) + 49 * H);
  s.api.expireDemos();
  assert.equal((await from('1.1.1.1')).status, 200);
});

test('a case update the agent wrote in Indonesian is written once in English for an English viewer, within its own allowance', async () => {
  const agent = await fakeAgent();
  try {
    const f = await farmWithWorker(undefined, agent.deps);
    const pond = f.ponds[1].id;
    const en = f.client({ 'x-lang': 'en' });
    await en('POST', '/auth/login', { phone: '082222222222', pin: '135790' });
    await f.worker('POST', `/ponds/${pond}/logs`, { mortality: 4, behavior: ['surfacing'], report: 'dead' });
    await f.api.settleCases();
    assert.deepEqual(agent.runs, ['case id']);

    // English viewer: the rules version while the agent writes it in English.
    let c = (await en('GET', '/cases')).json.cases[0];
    assert.equal(c.running, true);
    assert.equal(c.run.source, 'rules');
    assert.match(c.run.summary, /dead today/);
    await f.api.settleCases();
    c = (await en('GET', '/cases')).json.cases[0];
    assert.equal(c.running, false);
    assert.match(c.run.summary, /^Deaths in Kolam B/);
    // Both languages kept; looking again in either asks for nothing more.
    assert.match((await f.worker('GET', '/cases')).json.cases[0].run.summary, /^Kematian di Kolam B/);
    await en('GET', '/cases');
    await f.api.settleCases();
    assert.deepEqual(agent.runs, ['case id', 'case en']);

    // Each new Indonesian update gets its English one, up to the allowance; then English shows the rules.
    for (let i = 0; i < MAX_LANG_RUNS_PER_DAY; i++) {
      await f.worker('POST', `/cases/${c.id}/answers`, { answers: [{ q: `Pertanyaan ${i}`, a: 'Ya' }] });
      await f.api.settleCases();
      await en('GET', '/cases');
      await f.api.settleCases();
    }
    const enRuns = agent.runs.filter((r) => r === 'case en').length;
    assert.equal(enRuns, MAX_LANG_RUNS_PER_DAY);
    c = (await en('GET', '/cases')).json.cases[0];
    assert.equal(c.running, false);
    assert.equal(c.run.source, 'rules');
    assert.equal(c.run.lang, 'en');
    // The farmer's own agent runs were not used up by the English ones: 1 + 3 answers so far, 6 a day.
    await f.worker('POST', `/cases/${c.id}/answers`, { answers: [{ q: 'Lagi', a: 'Ya' }] });
    await f.api.settleCases();
    assert.equal((await f.worker('GET', '/cases')).json.cases[0].run.source, 'agent');
    assert.equal(agent.runs.filter((r) => r === 'case id').length, 5);
  } finally {
    agent.close();
  }
});

test('an evening briefing in Indonesian is written once in English, without using the 4 a day', async () => {
  const agent = await fakeAgent();
  try {
    const f = await farmWithWorker('2026-10-28T11:00:00Z', agent.deps);
    const en = f.client({ 'x-lang': 'en' });
    await en('POST', '/auth/login', { phone: '082222222222', pin: '135790' });
    await f.api.briefFarms();
    assert.deepEqual(agent.runs, ['briefing id']);
    let got = (await en('GET', '/briefing')).json;
    assert.equal(got.running, true);
    assert.equal(got.briefing.source, 'rules');
    assert.equal(got.briefing.lang, 'en');
    await f.api.settleCases();
    got = (await en('GET', '/briefing')).json;
    assert.equal(got.running, false);
    assert.equal(got.briefing.source, 'agent');
    assert.match(got.briefing.summary, /^Kolam B needs a look/);
    assert.match((await f.worker('GET', '/briefing')).json.briefing.summary, /^Kolam B perlu dilihat/);
    await en('GET', '/briefing');
    await f.api.settleCases();
    assert.deepEqual(agent.runs, ['briefing id', 'briefing en']);

    // The allowance for English re-runs runs out; asked-for briefings still count only themselves.
    for (let i = 1; i < MAX_LANG_BRIEFINGS_PER_DAY + 1; i++) {
      assert.equal((await f.worker('POST', '/briefing')).status, 201);
      await en('GET', '/briefing');
      await f.api.settleCases();
    }
    assert.equal(agent.runs.filter((r) => r === 'briefing en').length, MAX_LANG_BRIEFINGS_PER_DAY);
    got = (await en('GET', '/briefing')).json;
    assert.equal(got.running, false);
    assert.equal(got.briefing.source, 'rules');
    // 1 evening + 2 asked for so far: 2 more allowed, then refused.
    assert.equal((await f.worker('POST', '/briefing')).status, 201);
    assert.equal((await f.worker('POST', '/briefing')).status, 400);
  } finally {
    agent.close();
  }
});

test('an existing database gains the new columns and tables; its old briefings read as Indonesian originals', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { openDb, repo } = await import('../src/db.ts');
  const path = join(mkdtempSync(join(tmpdir(), 'synteel-')), 'old.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`create table farms (id integer primary key, name text not null, location_name text, lat real, lon real, timezone text not null default 'Asia/Jakarta', created_at text);
    create table briefings (id integer primary key, farm_id integer not null references farms(id), local_date text not null, created_at text not null, body text not null);
    insert into farms (id, name) values (1, 'Lama');
    insert into briefings (farm_id, local_date, created_at, body) values (1, '2026-10-28', '2026-10-28T10:00:00Z', '{"summary":"Lama","source":"agent"}');`);
  old.close();
  const store = repo(openDb(path));
  const rows = store.farm(1).briefingRows<{ summary: string }>('2026-10-28');
  assert.deepEqual(rows.map((r) => [r.lang, r.kind, r.body.summary]), [['id', null, 'Lama']]);
  assert.equal(store.farm(1).briefingsOn('2026-10-28'), 1);
  assert.equal(store.demo.template(), null);
});

test('captures of a deleted demo farm are removed from disk, others stay', async () => {
  const { mkdtempSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { captureStore, removeFarmCaptures } = await import('../src/captures.ts');
  const dir = mkdtempSync(join(tmpdir(), 'synteel-cap-'));
  const save = captureStore(dir);
  await save({ farmId: 7, pondId: 3, kind: 'photo' }, [{ name: 'image-0.jpg', blob: new Blob(['x']) }]);
  await save({ farmId: 17, pondId: 4, kind: 'photo' }, []);
  removeFarmCaptures(7, dir);
  assert.deepEqual(readdirSync(dir).map((n) => n.replace(/^.*?-farm/, 'farm')), ['farm17-pond4-photo']);
});
