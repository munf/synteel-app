// Offline evaluation summary: runs the deterministic parts around each Meta model use on fixed inputs
// and prints expected vs got. No API keys, no network, no photos. Usage: npm run eval
// Live numbers (SAM on photos, the briefing agent, typed Javanese rounds) are in docs/evaluation.md.
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { guard, runBriefing, type BriefingInput } from '../server/src/agent.ts';
import { toDraft } from '../server/src/ai.ts';
import { DAY_MS, type Log } from '../server/src/domain.ts';
import { knowledge } from '../server/src/knowledge.ts';
import { checkReading, guardRound, matchPond, type RoundPond } from '../server/src/round.ts';
import { guardDate, guardNotebook } from '../server/src/notebook.ts';
import { assessPond, type Threshold } from '../server/src/rules.ts';
import { combine, pairEyes, parseCount, type CountedEel } from '../server/src/sam.ts';
import { learn, simulate } from '../server/src/thermal.ts';
import { POND_TYPES, synthPond, synthWeather } from '../server/test/fixtures/thermal-synth.ts';

const rows: { area: string; name: string; want: string; got: string; ok: boolean }[] = [];
const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
const check = (area: string, name: string, want: unknown, got: unknown) => rows.push({ area, name, want: show(want), got: show(got), ok: show(want) === show(got) });

// ---------- SAM 3.1 count ----------
const sam = 'SAM count';
const t0 = performance.now();
const synth8 = await parseCount(readFileSync(new URL('../server/test/fixtures/sam-synth8.txt', import.meta.url), 'utf8'));
const parseMs = performance.now() - t0;
check(sam, 'recorded SAM output, 8 elvers in a basin', 8, synth8.count);
const eel = (left: number, top: number, score: number, area = 400): CountedEel => ({ left, top, right: left + 40, bottom: top + 10, path: 'M0 0', score, area, label: { x: left, y: top } });
const eye = (x: number, y: number) => ({ ...eel(x, y, 0.6, 9), right: x + 3, bottom: y + 3 });
const range = (r: ReturnType<typeof combine>) => `${r.low}-${r.high}${r.atLeast ? ' at least' : ''}`;
check(sam, 'same eel from two prompts counted once', '3-3', range(combine([[eel(0, 0, 0.9), eel(100, 0, 0.88)], [eel(1, 1, 0.6), eel(200, 0, 0.92)]], [])));
check(sam, 'eye pairs: 2 pairs + 1 lone eye = 3 heads', 3, pairEyes([eye(10, 10), eye(16, 10), eye(100, 50), eye(106, 51), eye(300, 300)]).length);
check(sam, '3 sure bodies agree with 3 heads', '3-3', range(combine([[eel(0, 0, 0.9), eel(0, 100, 0.91), eel(0, 200, 0.86), eel(300, 300, 0.6)]], [0, 100, 200].flatMap((y) => [eye(0, y), eye(5, y)]))));
check(sam, '2 sure + 2 doubtful bodies give a range', '2-4', range(combine([[eel(0, 0, 0.9), eel(0, 50, 0.9), eel(0, 100, 0.6), eel(0, 150, 0.6)]], [])));
check(sam, 'heads only (15 pairs, no sure body)', '15-15 at least', range(combine([Array.from({ length: 10 }, (_, i) => eel(i * 60, 100, 0.55))], Array.from({ length: 15 }, (_, i) => [eye(i * 50, 0), eye(i * 50 + 5, 0)]).flat())));
check(sam, 'one outline 3x the median may be two eels', '4-5', range(combine([[eel(0, 0, 0.9), eel(0, 50, 0.9), eel(0, 100, 0.9), eel(0, 150, 0.9, 1200)]], [])));
check(sam, 'nothing found: 0, the app asks for a new photo', '0-0', range(combine([[], [], []], [])));

// ---------- Voice round guards (after Meta ASR + Muse Spark) ----------
const voice = 'Voice guards';
const ponds: RoundPond[] = [
  { id: 1, name: 'Kolam A', nicknames: [] },
  { id: 2, name: 'Kolam B', nicknames: [] },
  { id: 3, name: 'Kolam C1', nicknames: [] },
  { id: 4, name: 'Kolam T', nicknames: ['kolam pojok'] },
];
for (const [heard, want] of [['kolam be', 2], ['kolam ce siji', 3], ['Kolam C satu', 3], ['Kolam B maneh', 2], ['pojok', 4], ['kolam mburi', null]] as const)
  check(voice, `pond "${heard}"`, want, matchPond(heard, ponds, 1).pondId);
check(voice, 'pH heard as 74 is fixed to 7.4', 7.4, checkReading('ph', 74).value);
check(voice, 'temperature 9 (tens lost) is asked, suggests 29', 29, checkReading('temperature', 9).issue?.suggestion);
check(voice, 'TDS 5000 is asked', 'implausible', checkReading('tds', 5000).issue?.kind);
const EMPTY = { temperature: null, ph: null, tds: null, mortality: null, behavior: [], feeding_leftover: null, water_color: null, water_smell: null, aeration: null, note: null, unclear_text: null };
const twice = guardRound({ loose: { ...EMPTY, quote: '' }, mentions: [{ ...EMPTY, pond_as_heard: 'Kolam B', pond_id: 2, quote: 'Kolam B', temperature: 29 }, { ...EMPTY, pond_as_heard: 'kolam be', pond_id: 2, quote: 'kolam be', temperature: 28 }] }, ponds, 't', { model: 'm', mode: 'meta' });
check(voice, 'same pond said twice with 29 then 28: asked', 'twice', twice.drafts[0]?.issues[0]?.kind);
check(voice, 'model says pond 1 for "kolam mburi": not followed', null, guardRound({ loose: { ...EMPTY, quote: '' }, mentions: [{ ...EMPTY, pond_as_heard: 'kolam mburi', pond_id: 1, quote: 'x', water_color: 'green' }] }, ponds, 't', { model: 'm', mode: 'meta' }).drafts[0]?.pondId);

// ---------- Meter photo / voice note draft guard (after Muse Spark vision) ----------
const meter = 'Meter draft';
const draft = toDraft({ temperature: 28.5, ph: 72, tds: 160, behavior: ['surfacing', 'dancing'], feeding_leftover: 'lots', low_confidence: ['tds'] }, 'meta');
check(meter, 'plausible readings kept, pH 72 dropped', { temperature: 28.5, tds: 160 }, draft.data.readings);
check(meter, 'unknown behaviour and leftover words dropped', [['surfacing'], undefined], [draft.data.behavior, draft.data.feeding]);
check(meter, 'unsure field flagged for the farmer', ['tds'], draft.lowConfidence);

// ---------- Notebook page guard (after Muse Spark vision) ----------
const book = 'Notebook';
const cellOf = (written: string | null, value: number | null) => ({ written, value });
const nbRow = (over: Record<string, unknown>) => ({ date: { written: '12/10', day: 12, month: 10, year: null }, time: null, pond: 'Kolam A', temperature: cellOf('27,5', 27.5), ph: cellOf('7,4', 7.4), tds: cellOf('140', 140), dead: cellOf(null, null), feed: null, note: null, unsure: [], ...over });
const nb = (over: Record<string, unknown>) => guardNotebook({ page_pond: null, page_year: null, rows: [nbRow(over)], problems: [] }, ponds, { today: '2026-10-29', page: 1 }).rows[0];
check(book, 'blank TDS cell, model says 150: not used, asked', [undefined, 'unsure'], [nb({ tds: cellOf(null, 150) }).values.tds, nb({ tds: cellOf(null, 150) }).checks[0]?.kind]);
check(book, 'pH written 74 (model says 7.4): empty, 7.4 offered', [undefined, 7.4], [nb({ ph: cellOf('74', 7.4) }).values.ph, nb({ ph: cellOf('74', 7.4) }).checks[0]?.suggestion]);
check(book, '"30/12" without a year on 29 Oct 2026', '2025-12-30', guardDate({ written: '30/12', day: 30, month: 12, year: null }, null, '2026-10-29', false).date);
check(book, 'pond written "kolam mburi": farmer picks', null, nb({ pond: 'kolam mburi' }).pondId);

// ---------- Evening briefing agent guard and fallback ----------
const agent = 'Briefing agent';
const NOW = Date.parse('2026-10-28T10:00:00Z');
const H = 3600_000;
const point = (t: number, level: 'warning' | 'critical') => ({ t, temp: 27, sigma: 0.3, score: 0, level, factors: [{ id: 'signs', label: 'Sidat terlihat naik ke permukaan', points: 3 }] });
const input = {
  farmName: 'Tambak Uji',
  now: NOW,
  timezone: 'Asia/Jakarta',
  ponds: [{ id: 2, name: 'Kolam B', phase: 'glass_eel', week: 3, level: 'critical', findings: [], latest: {}, lastLogAt: null }],
  nowcasts: [{ pondId: 2, generatedAt: NOW, basis: { weather: true, anchor: null, calibrationPairs: 0, offset: 0, fit: [] }, now: point(NOW, 'warning'), hours: [point(NOW + 8 * H, 'critical')], measurements: [], peak: point(NOW + 8 * H, 'critical'), checks: [{ t: NOW + 5 * H, kind: 'look', reason: 'Cek sidat di permukaan', alarm: false }], lastCheckAt: NOW - H }],
  weather: [],
  history: () => [],
} as unknown as BriefingInput;
const proposal = {
  summary: 'Kolam B rawan malam ini karena hujan dan sidat naik ke permukaan. Pastikan aerator nyala.',
  checks: [
    { pond_id: 2, time: '20:00', action: 'Tutup aliran air hujan ke Kolam B', why: 'hujan' }, // kept
    { pond_id: 99, time: '20:00', action: 'Cek kolam yang tidak ada' }, // no such pond
    { pond_id: 2, time: '21:00', action: 'Beri obat antibiotik' }, // medicine
    { pond_id: 2, time: '22:10', action: 'Lihat sidat lagi' }, // same as a rule check
    { pond_id: 2, time: '16:00', action: 'Terlalu jauh' }, // beyond 18 h
  ],
};
const guarded = guard(input, proposal, [], 'test');
check(agent, '5 agent checks proposed: 1 kept, 4 dropped', 1, guarded.checks.filter((c) => c.source === 'agent').length);
check(agent, 'the rule check is always kept', 1, guarded.checks.filter((c) => c.source === 'rules').length);
check(agent, 'summary about medicine doses: rules summary instead', 'rules', guard(input, { summary: 'Berikan obat jamur dengan dosis tinggi malam ini ke semua kolam.', checks: [] }, [], 'test').source);
check(agent, 'no model at all: briefing from the rules', 'rules', (await runBriefing(input, [])).source);

const listen = (s: Server) => new Promise<string>((resolve) => s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(s.address() as { port: number }).port}`)));
const submit = { tool_calls: [{ id: 'a', type: 'function', function: { name: 'submit_briefing', arguments: JSON.stringify({ summary: 'Kolam B paling rawan sekitar jam 01.00 karena sidat naik ke permukaan.', checks: [] }) } }] };
const spent = createServer((_q, res) => res.writeHead(402, { 'content-type': 'application/json' }).end('{"error":{"message":"credits"}}'));
const working = createServer((req, res) => (req.resume(), req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: '', ...submit } }] })))));
const [spentBase, workingBase] = [await listen(spent), await listen(working)];
const quiet = console.error;
console.error = () => {};
const fell = await runBriefing(input, [
  { name: 'baseten', apiKey: 'k', base: spentBase, model: 'muse-spark-open' },
  { name: 'meta', apiKey: 'k', base: workingBase, model: 'muse-spark-1.3' },
]);
const allDown = await runBriefing(input, [{ name: 'baseten', apiKey: 'k', base: spentBase, model: 'muse-spark-open' }]);
console.error = quiet;
spent.close();
working.close();
check(agent, 'Baseten answers 402: Meta writes the briefing', 'meta/muse-spark-1.3', fell.model);
check(agent, 'every provider out: rules briefing, rule check kept', ['rules', 1], [allDown.source, allDown.checks.length]);

// ---------- Deterministic alarms (no model involved) ----------
const rules = 'Rules';
const thresholds = knowledge.thresholds.parameters as Threshold[];
const at = new Date(NOW);
const log = (data: Log['data']): Log => ({ id: 1, pondId: 1, batchId: 1, loggedAt: new Date(NOW - H).toISOString(), source: 'manual', data });
const level = (data: Log['data']) => assessPond([log(data)], thresholds, at)[0]?.level ?? 'ok';
check(rules, 'water 31 °C', 'critical', level({ readings: { temperature: 31 } }));
check(rules, 'water 29.5 °C', 'warning', level({ readings: { temperature: 29.5 } }));
check(rules, 'eels surfacing', 'critical', level({ behavior: ['surfacing'] }));
check(rules, 'normal readings', 'ok', level({ readings: { temperature: 27.5, ph: 7.4, tds: 150 } }));
check(rules, 'reading older than 24 h raises no threshold', 'ok', assessPond([{ ...log({ readings: { temperature: 31 } }), loggedAt: new Date(NOW - DAY_MS - H).toISOString() }], thresholds, at).find((f) => f.id === 'threshold:temperature')?.level ?? 'ok');

// ---------- Water temperature model: old vs new on held-out readings (synthetic ponds) ----------
// Five synthetic pond types (server/test/fixtures/thermal-synth.ts), 35 days of synthetic weather.
// Days 1-28 teach the model; each reading in days 29-35 is then predicted from the reading before
// it (10 or 14 hours earlier). "Midday" adds a 13:00 spot reading on the held-out days, predicted
// from that morning's reading: the time the sun matters most and the farmer rarely measures.
const water = 'Water temp';
const HOUR = 3600_000;
const tStart = Date.parse('2026-09-01T00:00:00Z');
const synthW = synthWeather(tStart, 35);
const wMap = new Map(synthW.map((h) => [h.t, h]));
const split = tStart + 28 * DAY_MS;

/** The model before 30 October 2026: fixed starting values, only a median offset learned. */
function oldModel(profile: { setting: string; shaded: boolean | null; depthCm: number }, readings: { t: number; value: number }[]) {
  const p = profile.setting === 'indoor' ? { k: 0.04, sun: 0.3 } : { k: Math.min(0.2, Math.max(0.02, (0.06 * 30) / profile.depthCm)), sun: profile.shaded ? 1.5 : 3.5 };
  const sim = (offset: number, t0: number, v0: number, t1: number) => {
    let t = t0;
    let v = v0;
    while (t < t1) {
      const w = wMap.get(Math.floor(t / HOUR) * HOUR);
      if (!w) return null;
      const dt = Math.min(HOUR, t1 - t) / HOUR;
      const k = p.k * (1 + w.wind / 80);
      v += (w.airTemp + (p.sun * w.radiation) / 1000 + offset - v) * (1 - Math.pow(1 - Math.min(k, 0.9), dt));
      t += dt * HOUR;
    }
    return v;
  };
  const est: number[] = [];
  for (let i = 1; i < readings.length; i++) {
    const [a, b] = [readings[i - 1], readings[i]];
    const gapH = (b.t - a.t) / HOUR;
    const pred = gapH >= 2 && gapH <= 36 ? sim(0, a.t, a.value, b.t) : null;
    const reach = 1 - Math.pow(1 - p.k, gapH);
    if (pred !== null && reach >= 0.2) est.push((b.value - pred) / reach);
  }
  const sorted = est.sort((x, y) => x - y);
  const offset = sorted.length ? Math.max(-4, Math.min(4, sorted[Math.floor(sorted.length / 2)])) : 0;
  return (t0: number, v0: number, t1: number) => sim(offset, t0, v0, t1);
}

const mae = (xs: number[]) => xs.reduce((a, x) => a + Math.abs(x), 0) / Math.max(1, xs.length);
const p80 = (xs: number[]) => [...xs.map(Math.abs)].sort((a, b) => a - b)[Math.floor(0.8 * (xs.length - 1))] ?? 0;
const f2 = (n: number) => n.toFixed(2);
const tempRows: string[] = [];
let oldAll: number[] = [];
let newAll: number[] = [];
for (const [i, truth] of POND_TYPES.entries()) {
  const { water: trueWater, readings } = synthPond(truth, synthW, 11 + i);
  const train = readings.filter((r) => r.t < split);
  const held = readings.map((r, j) => ({ r, prev: readings[j - 1] })).filter((x) => x.r.t >= split && x.prev);
  const old = oldModel(truth.profile, train);
  const learned = learn(wMap, truth.profile, train, 'Asia/Jakarta');
  const priorOnly = learn(wMap, truth.profile, [], 'Asia/Jakarta');
  const errs = (f: (t0: number, v0: number, t1: number) => number | null, pairs: { t0: number; v0: number; t1: number; y: number }[]) => pairs.map((p) => p.y - (f(p.t0, p.v0, p.t1) ?? p.v0));
  const pairs = held.map((x) => ({ t0: x.prev!.t, v0: x.prev!.value, t1: x.r.t, y: x.r.value }));
  // Midday spot readings: the true water at 13:00 WIB on held-out days, from that day's morning reading.
  const midday = held
    .filter((x) => (new Date(x.r.t).getUTCHours() + 7) % 24 < 10)
    .map((x) => {
      const t1 = Math.floor(x.r.t / DAY_MS) * DAY_MS + 6 * HOUR; // 13:00 WIB
      return { t0: x.r.t, v0: x.r.value, t1, y: trueWater.get(t1)! };
    })
    .filter((p) => p.y !== undefined);
  const oE = errs(old, pairs);
  const pE = errs((t0, v0, t1) => simulate(wMap, priorOnly.params, t0, v0, t1), pairs);
  const nE = errs((t0, v0, t1) => simulate(wMap, learned.params, t0, v0, t1), pairs);
  const oM = errs(old, midday);
  const nM = errs((t0, v0, t1) => simulate(wMap, learned.params, t0, v0, t1), midday);
  oldAll = [...oldAll, ...oE];
  newAll = [...newAll, ...nE];
  tempRows.push(`${truth.name.padEnd(40)} ${String(pairs.length).padStart(3)}  ${f2(mae(oE))} / ${f2(p80(oE))}   ${f2(mae(pE))}   ${f2(mae(nE))} / ${f2(p80(nE))}   ${f2(mae(oM))} -> ${f2(mae(nM))}   ±${learned.typicalError}`);
  check(water, `${truth.name}: new error not above old (held-out)`, true, mae(nE) <= mae(oE) + 0.02);
}
check(water, 'all synthetic ponds: new mean error below old', true, mae(newAll) < mae(oldAll));

// ---------- Print ----------
const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
console.log(`${pad('area', 15)} ${pad('case', 52)} ${pad('expected', 24)} ${pad('got', 24)} ok`);
for (const r of rows) console.log(`${pad(r.area, 15)} ${pad(r.name, 52)} ${pad(r.want, 24)} ${pad(r.got, 24)} ${r.ok ? 'yes' : 'NO'}`);
console.log('');
for (const area of [...new Set(rows.map((r) => r.area))]) {
  const of = rows.filter((r) => r.area === area);
  console.log(`${pad(area, 15)} ${of.filter((r) => r.ok).length}/${of.length} pass`);
}
const failed = rows.filter((r) => !r.ok).length;
console.log(`\n${rows.length - failed}/${rows.length} cases pass. SAM fixture parsed in ${parseMs.toFixed(0)} ms.`);
console.log('\nWater temperature, SYNTHETIC ponds: mean / 80% error in °C on held-out readings (days 29-35)');
console.log(`${'pond type'.padEnd(40)}   n  old model     prior  new model     midday old -> new   shown`);
for (const row of tempRows) console.log(row);
console.log(`${'all'.padEnd(40)} ${String(oldAll.length).padStart(3)}  ${f2(mae(oldAll))} / ${f2(p80(oldAll))}           ${f2(mae(newAll))} / ${f2(p80(newAll))}`);
console.log('Live results (SAM on 14 photos, 6 agent runs, typed Javanese rounds): docs/evaluation.md');
process.exitCode = failed ? 1 : 0;
