// Measured evaluation: runs labelled items (eval/labelled/) through one route of provider+model per task,
// the same code path the app uses (providers.ts → ai.ts call() → guards → verify.ts), and scores them.
// Every call lands in an in-memory AI call ledger (ledger.ts), so time, tokens, estimated cost and the
// provider/model that actually answered come from the same place as in production.
//
//   speech   word error rate of the transcript against what was typed by a person
//   extract  share of labelled fields right (typed voice rounds, meter photos)
//   agent    share of the rule checks the briefing kept (must be all); advice text saved for blind rating
//   segment  share of counts within 1 eel of the true count (also exact, low end not above, mean error)
//
// Mock mode answers from a local pretend API built from the labels themselves: it checks the
// pipeline, its accuracy is 100% by construction and says nothing about a model.
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { createAi } from '../server/src/ai.ts';
import { rulesBriefing, runBriefing, type BriefingInput } from '../server/src/agent.ts';
import type { RoundResult } from '../server/src/contract.ts';
import { openDb } from '../server/src/db.ts';
import type { LogData } from '../server/src/domain.ts';
import { aiLedger, type AiKind } from '../server/src/ledger.ts';
import type { Endpoint, Task } from '../server/src/providers.ts';
import type { RoundPond } from '../server/src/round.ts';
import { countDeadEels } from '../server/src/sam.ts';
import { verifyCount, verifyDraft, verifyRound, type Verification } from '../server/src/verify.ts';

const ROOT = new URL('..', import.meta.url).pathname;

// ---------- Scoring ----------

export const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);

/** Word error rate: word edits (substitute, insert, delete) to turn `hyp` into `ref`, over the words of `ref`. */
export function wer(ref: string, hyp: string): number {
  const r = words(ref);
  const h = words(hyp);
  if (!r.length) return h.length ? 1 : 0;
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const cur = [i];
    for (let j = 1; j <= h.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[h.length] / r.length;
}

/** The scored fields of a log, flat: readings, dead eels, water colour and smell, leftover feed, aeration. */
export type FieldValues = Partial<Record<'temperature' | 'ph' | 'tds' | 'do' | 'mortality' | 'color' | 'smell' | 'leftover' | 'aeration', number | string>>;

export function flatFields(d: LogData): FieldValues {
  return {
    ...d.readings,
    ...(d.mortality !== undefined && { mortality: d.mortality }),
    ...(d.water?.color && { color: d.water.color }),
    ...(d.water?.smell && { smell: d.water.smell }),
    ...(d.feeding?.leftover && { leftover: d.feeding.leftover }),
    ...(d.aeration && { aeration: d.aeration }),
  };
}

const same = (a: unknown, b: unknown) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-6 : a === b);

export interface FieldScore {
  right: number;
  total: number;
  /** "pond 2 temperature: want 28, got 27" */
  wrong: string[];
  /** Values filled in that nobody labelled: possible inventions, counted apart. */
  extra: number;
}

/** Labelled fields per pond against what the drafts hold for that pond. A pond missing from the drafts gets every field wrong. */
export function scoreFields(expect: ({ pond: number } & FieldValues)[], got: { pondId: number | null; fields: FieldValues }[]): FieldScore {
  const s: FieldScore = { right: 0, total: 0, wrong: [], extra: 0 };
  for (const { pond, ...want } of expect) {
    const have = got.filter((g) => g.pondId === pond).reduce<FieldValues>((a, g) => ({ ...a, ...g.fields }), {});
    for (const [k, v] of Object.entries(want)) {
      s.total++;
      const h = have[k as keyof FieldValues];
      if (same(v, h)) s.right++;
      else s.wrong.push(`pond ${pond} ${k}: want ${v}, got ${h ?? 'nothing'}`);
    }
    s.extra += Object.keys(have).filter((k) => !(k in want)).length;
  }
  s.extra += got.filter((g) => !expect.some((e) => e.pond === g.pondId)).reduce((n, g) => n + Object.keys(g.fields).length, 0);
  return s;
}

/** One count against the true number. */
export function scoreCount(truth: number, r: { count: number; low: number }) {
  return { exact: r.count === truth, within1: Math.abs(r.count - truth) <= 1, lowOk: r.low <= truth, absError: Math.abs(r.count - truth) };
}

// ---------- Items, results ----------

export interface ItemResult {
  id: string;
  /** The task's main score for this item, 0..1 (WER: lower is better, the others higher): the model's answer after the guards. */
  score: number | null;
  /** Extract only: the same score on what the farmer sees filled in, after verify.ts held back what it could not confirm. */
  shown?: number | null;
  detail: Record<string, unknown>;
  /** verify.ts on the result; null where the task has no check (speech) or no model wrote it. */
  verify: 'passed' | 'failed' | null;
  ms: number;
  calls: number;
  cost: number | null;
  /** provider/model of each call that answered, in order (a fallback shows here). */
  answeredBy: string[];
  fallbacks: number;
  error?: string;
  /** Advice text (agent), for blind rating. */
  output?: string;
}

export interface TaskSummary {
  task: Task;
  metric: string;
  n: number;
  errors: number;
  /** Mean of the item scores. */
  accuracy: number | null;
  /** Extract only: mean score of what stays filled in after verification ("Cek manual" values count as not right). */
  shownAccuracy: number | null;
  verifyPassRate: number | null;
  medianMs: number | null;
  /** Mean estimated USD per item; null when a model has no price (ledger.ts PRICES). */
  costPerItem: number | null;
  calls: number;
  fallbacks: number;
  answeredBy: Record<string, number>;
}

export const METRIC: Record<Task, string> = {
  speech: 'word error rate (lower is better)',
  extract: 'labelled fields right',
  agent: 'rule checks kept',
  segment: 'counts within 1 eel',
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function summarize(task: Task, items: ItemResult[]): TaskSummary {
  const done = items.filter((i) => !i.error);
  const verified = done.filter((i) => i.verify !== null);
  const answeredBy: Record<string, number> = {};
  for (const m of items.flatMap((i) => i.answeredBy)) answeredBy[m] = (answeredBy[m] ?? 0) + 1;
  return {
    task,
    metric: METRIC[task],
    n: items.length,
    errors: items.length - done.length,
    accuracy: mean(done.filter((i) => i.score !== null).map((i) => i.score!)),
    shownAccuracy: mean(done.filter((i) => i.shown != null).map((i) => i.shown!)),
    verifyPassRate: verified.length ? verified.filter((i) => i.verify === 'passed').length / verified.length : null,
    medianMs: median(done.map((i) => i.ms)),
    costPerItem: done.length && done.every((i) => i.cost !== null) ? mean(done.map((i) => i.cost!)) : null,
    calls: items.reduce((a, i) => a + i.calls, 0),
    fallbacks: items.reduce((a, i) => a + i.fallbacks, 0),
    answeredBy,
  };
}

const pct = (x: number | null) => (x === null ? 'n/a' : `${(100 * x).toFixed(0)}%`);
const secs = (ms: number | null) => (ms === null ? 'n/a' : `${(ms / 1000).toFixed(1)} s`);
const usd = (x: number | null) => (x === null ? 'n/a' : `$${x < 0.01 ? x.toFixed(5) : x.toFixed(3)}`);

/** A Markdown table, one row per task: what docs/evaluation.md shows. */
export function table(summaries: TaskSummary[]): string {
  const rows = summaries.map((s) => {
    const acc = s.task === 'speech' && s.accuracy !== null ? `${(100 * s.accuracy).toFixed(1)}% WER` : pct(s.accuracy);
    const by = Object.entries(s.answeredBy).map(([m, n]) => `${m} ×${n}`).join(', ') || 'none';
    return `| ${s.task} | ${s.n}${s.errors ? ` (${s.errors} errors)` : ''} | ${s.metric}: ${acc} | ${s.shownAccuracy === null ? '' : pct(s.shownAccuracy)} | ${pct(s.verifyPassRate)} | ${secs(s.medianMs)} | ${usd(s.costPerItem)} | ${s.calls} | ${by} |`;
  });
  return ['| Task | Items | Accuracy | Filled in after checks | Verification passed | Median time | Est. cost per item | Model calls | Answered by |', '|---|---|---|---|---|---|---|---|---|', ...rows].join('\n');
}

// ---------- Datasets ----------

export const DATA_DIR = join(ROOT, 'eval', 'labelled');
const load = (file: string) => JSON.parse(readFileSync(join(DATA_DIR, file), 'utf8'));

export interface RoundItem {
  id: string;
  transcript: string;
  expect: ({ pond: number } & FieldValues)[];
}
export interface PhotoItem {
  id: string;
  image: string;
  field?: 'temperature' | 'ph' | 'tds';
  pond?: string;
  expect: FieldValues;
}
export interface CountItem {
  id: string;
  image?: string;
  replay?: string;
  truth: number;
  phase: 'glass_eel' | 'elver';
  label: string;
}
export interface SpeechItem {
  id: string;
  audio: string;
  transcript: string;
}
export interface BriefingItem {
  id: string;
  label: string;
  input: Omit<BriefingInput, 'history'> & { history: Record<string, unknown[]> };
}

export const datasets = () => ({
  rounds: load('rounds.json') as { ponds: RoundPond[]; items: RoundItem[] },
  photos: load('meter-photos.json') as { items: PhotoItem[] },
  counts: load('counts.json') as { items: CountItem[] },
  speech: load('speech.json') as { items: SpeechItem[] },
  briefings: load('briefings.json') as { items: BriefingItem[] },
});

const briefingInput = (b: BriefingItem['input']): BriefingInput => ({ ...b, history: (pondId: number) => b.history[String(pondId)] ?? [] });

// ---------- Running ----------

export interface RunOptions {
  /** The route to measure for this task, tried in order (one entry: that model alone, no fallback). */
  route: Endpoint[];
  /** Folders of the private files: photos and recordings stay out of the repo. */
  images?: string;
  audio?: string;
  /** Only these item ids. */
  only?: string[];
  /** Stop before an item that could take the run past this many model calls. */
  maxCalls?: number;
  mock?: boolean;
}

/** Most calls one item can make, for the budget. */
const MAX_CALLS: Record<Task, (phase?: string) => number> = { speech: () => 1, extract: () => 1, agent: () => 8, segment: (phase) => (phase === 'elver' ? 5 : 4) };

/**
 * Runs one task over its labelled items. Each runs inside its own ledger request,
 * so its calls, time, cost and the provider/model that answered are read back from the ledger.
 */
export async function runTask(task: Task, o: RunOptions): Promise<{ items: ItemResult[]; skipped: { id: string; why: string }[] }> {
  const db = openDb(':memory:');
  const ledger = aiLedger(db);
  const rowsOf = db.prepare('select provider, model, ms, cost_usd_estimate as cost, outcome, started_at from ai_ledger where request_id = ? order by id');
  const ds = datasets();
  const skipped: { id: string; why: string }[] = [];
  const keep = (id: string) => !o.only || o.only.includes(id);
  type Job = { id: string; kind: AiKind; budget: number; run: () => Promise<Pick<ItemResult, 'score' | 'shown' | 'detail' | 'verify' | 'output'>> };
  const jobs: Job[] = [];

  if (task === 'extract') {
    const ai = createAi({ chat: o.route, mock: false });
    const ponds = ds.rounds.ponds;
    for (const item of ds.rounds.items.filter((i) => keep(i.id))) {
      jobs.push({
        id: item.id,
        kind: 'round',
        budget: 1,
        run: async () => {
          const raw = await ai.round({ transcript: item.transcript, ponds });
          const s = scoreFields(item.expect, roundFields(raw));
          const r = verifyRound(raw, ponds);
          const shown = scoreFields(item.expect, roundFields(r));
          return { score: s.total ? s.right / s.total : null, shown: shown.total ? shown.right / shown.total : null, detail: { right: s.right, total: s.total, wrong: s.wrong, extra: s.extra, held: heldOf(r), failedChecks: failedChecks(r.verify) }, verify: r.verify.status };
        },
      });
    }
    for (const item of ds.photos.items.filter((i) => keep(i.id))) {
      const file = o.images && join(o.images, item.image);
      if (!file || !existsSync(file)) {
        skipped.push({ id: item.id, why: 'photo not found (--images)' });
        continue;
      }
      jobs.push({
        id: item.id,
        kind: 'photo',
        budget: 1,
        run: async () => {
          const pond = { id: 1, name: item.pond ?? 'Kolam A', nicknames: [] };
          const raw = await ai.draft({ kind: 'photo', field: item.field, images: [new Blob([readFileSync(file)], { type: 'image/jpeg' })], pondName: pond.name });
          const s = scoreFields([{ pond: 1, ...item.expect }], [{ pondId: 1, fields: flatFields(raw.data) }]);
          const d = verifyDraft(raw, pond, [pond]);
          const shown = scoreFields([{ pond: 1, ...item.expect }], [{ pondId: 1, fields: flatFields(d.data) }]);
          return { score: s.total ? s.right / s.total : null, shown: shown.total ? shown.right / shown.total : null, detail: { right: s.right, total: s.total, wrong: s.wrong, extra: s.extra, failedChecks: failedChecks(d.verify) }, verify: d.verify.status };
        },
      });
    }
  }

  if (task === 'speech') {
    const ai = createAi({ chat: [{ name: 'none', apiKey: 'none', base: 'http://127.0.0.1:9', model: 'none' }], transcriber: o.route, mock: false });
    for (const item of ds.speech.items.filter((i) => keep(i.id))) {
      const file = o.mock ? null : o.audio && join(o.audio, item.audio);
      if (!o.mock && (!file || !existsSync(file))) {
        skipped.push({ id: item.id, why: 'recording not found (--audio)' });
        continue;
      }
      jobs.push({
        id: item.id,
        kind: 'transcribe',
        budget: 1,
        run: async () => {
          const audio = file ? new Blob([readFileSync(file)], { type: 'audio/wav' }) : new Blob([item.id], { type: 'audio/wav' });
          const heard = await ai.transcribe(audio);
          return { score: wer(item.transcript, heard), detail: { heard }, verify: null };
        },
      });
    }
  }

  if (task === 'segment') {
    for (const item of ds.counts.items.filter((i) => keep(i.id))) {
      let image: Blob | null = null;
      if (o.mock) {
        if (item.replay) image = new Blob([item.id], { type: 'image/jpeg' });
      } else if (item.image && o.images && existsSync(join(o.images, item.image))) {
        image = new Blob([readFileSync(join(o.images, item.image))], { type: 'image/jpeg' });
      }
      if (!image) {
        skipped.push({ id: item.id, why: o.mock ? 'no recorded SAM output (live only)' : 'photo not found (--images)' });
        continue;
      }
      const photo = image;
      jobs.push({
        id: item.id,
        kind: 'count',
        budget: MAX_CALLS.segment(item.phase),
        run: async () => {
          const r = await countDeadEels(photo, o.route, item.phase);
          const s = scoreCount(item.truth, r);
          const v = verifyCount(r);
          return { score: s.within1 ? 1 : 0, detail: { truth: item.truth, count: r.count, low: r.low, high: r.high, atLeast: r.atLeast, ...s, failedChecks: failedChecks(v) }, verify: v.status };
        },
      });
    }
  }

  if (task === 'agent') {
    for (const item of ds.briefings.items.filter((i) => keep(i.id))) {
      jobs.push({
        id: item.id,
        kind: 'briefing',
        budget: MAX_CALLS.agent(),
        run: async () => {
          const input = briefingInput(item.input);
          const b = await runBriefing(input, o.route);
          const rules = rulesBriefing(input).checks;
          const kept = rules.filter((r) => b.checks.some((c) => c.source === 'rules' && c.pondId === r.pondId && c.t === r.t)).length;
          const agentChecks = b.checks.filter((c) => c.source === 'agent').map((c) => c.action);
          return {
            score: rules.length ? kept / rules.length : 1,
            detail: { source: b.source, ruleChecks: rules.length, kept, agentChecks: agentChecks.length, steps: b.steps.length, failedChecks: failedChecks(b.verify) },
            verify: b.verify?.status ?? null,
            output: [b.summary, ...agentChecks.map((a) => `- ${a}`)].join('\n'),
          };
        },
      });
    }
  }

  const items: ItemResult[] = [];
  let calls = 0;
  for (const job of jobs) {
    if (o.maxCalls !== undefined && calls + job.budget > o.maxCalls) {
      skipped.push({ id: job.id, why: `call budget (${o.maxCalls}) reached` });
      continue;
    }
    const started = performance.now();
    let id = '';
    let out: Pick<ItemResult, 'score' | 'shown' | 'detail' | 'verify' | 'output'> | null = null;
    let error: string | undefined;
    try {
      out = await ledger.track(job.kind, (rid) => ((id = rid), job.run()));
    } catch (err) {
      error = (err as Error).message.slice(0, 200);
    }
    const ms = performance.now() - started;
    const rows = (id ? rowsOf.all(id) : []) as { provider: string; model: string; cost: number | null; outcome: string }[];
    calls += rows.length;
    const answered = rows.filter((r) => r.outcome === 'ok' || r.outcome === 'fallback');
    items.push({
      id: job.id,
      score: out?.score ?? null,
      ...(out?.shown !== undefined && { shown: out.shown }),
      detail: out?.detail ?? {},
      verify: out?.verify ?? null,
      ms: Math.round(ms),
      calls: rows.length,
      // Unknown when any call has no price; failed calls are not billed.
      cost: answered.length && answered.every((r) => r.cost !== null) ? answered.reduce((a, r) => a + r.cost!, 0) : answered.length ? null : 0,
      answeredBy: [...new Set(answered.map((r) => `${r.provider}/${r.model}`))],
      fallbacks: rows.filter((r) => r.outcome === 'fallback').length,
      ...(error && { error }),
      ...(out?.output && { output: out.output }),
    });
  }
  return { items, skipped };
}

/** Each pond's draft of a round as flat fields, the pond as matched by code (null: the farmer picks). */
export const roundFields = (r: RoundResult) => r.drafts.map((d) => ({ pondId: d.pondId, fields: flatFields(d.data) }));
/** "agree: …" per failed code check, so a failed verification can be looked into. */
const failedChecks = (v: Verification | null | undefined) => (v?.checks ?? []).filter((c) => !c.ok).map((c) => `${c.id}: ${c.reason ?? c.label}`);
const heldOf = (r: RoundResult) => r.drafts.flatMap((d) => d.issues.filter((i) => i.kind === 'unverified').map((i) => `${d.heardName} ${i.field}`));

// ---------- Mock: a pretend API answering from the labels ----------

/**
 * A local OpenAI-compatible + Meta-style API that answers every request from the labels: rounds with
 * the labelled values, SAM with the recorded output, speech with the typed transcript, the agent with
 * a fixed summary. Returns the route to pass to runTask and a close function.
 */
export async function mockApi(): Promise<{ route: Endpoint[]; close: () => Promise<void> }> {
  const ds = datasets();
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('latin1');
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (body: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      const usage = { prompt_tokens: 1000, completion_tokens: 200 };
      if (req.url!.endsWith('/asr/transcribe')) {
        const item = ds.speech.items.find((i) => raw.includes(i.id));
        return send({ transcript: item?.transcript ?? '' });
      }
      const body = JSON.parse(raw || '{}');
      if (req.url!.endsWith('/responses')) {
        const content = body.input?.[0]?.content ?? [];
        const prompt = content.find((c: any) => c.type === 'input_text')?.text;
        const id = Buffer.from(String(content.find((c: any) => c.type === 'input_image')?.image_url ?? '').split(',')[1] ?? '', 'base64').toString();
        const item = ds.counts.items.find((i) => i.id === id);
        const text = item?.replay && prompt !== 'black eye' ? readFileSync(join(ROOT, item.replay), 'utf8') : '';
        return send({ output: [{ content: [{ text }] }] });
      }
      if (body.tools) {
        const args = { summary: 'Kolam B perlu dijaga malam ini: sidat naik ke permukaan dan risiko oksigen naik menjelang jam 01.00. Pastikan aerator nyala.', checks: [{ pond_id: 2, time: '21:00', action: 'Pastikan aerator Kolam B nyala', why: 'risiko oksigen naik' }] };
        return send({ choices: [{ message: { content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'submit_briefing', arguments: JSON.stringify(args) } }] } }], usage });
      }
      if (body.response_format?.json_schema?.name === 'pond_round') {
        const text = String(body.messages?.[1]?.content ?? '');
        const item = ds.rounds.items.find((i) => text.includes(i.transcript));
        const ponds = ds.rounds.ponds;
        const EMPTY = { temperature: null, ph: null, tds: null, mortality: null, behavior: [], feeding_leftover: null, water_color: null, water_smell: null, aeration: null, note: null, unclear_text: null };
        const mentions = (item?.expect ?? []).map((e) => {
          const name = ponds.find((p) => p.id === e.pond)!.name;
          return { ...EMPTY, pond_as_heard: name, pond_id: e.pond, quote: item!.transcript, temperature: e.temperature ?? null, ph: e.ph ?? null, tds: e.tds ?? null, mortality: e.mortality ?? null, water_color: e.color ?? null, feeding_leftover: e.leftover ?? null };
        });
        return send({ choices: [{ message: { content: JSON.stringify({ loose: { ...EMPTY, quote: '' }, mentions }) } }], usage });
      }
      return send({ choices: [{ message: { content: '{}' } }], usage });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { route: [{ name: 'mock', apiKey: 'mock', base, model: 'labels' }], close: () => new Promise((resolve) => server.close(() => resolve())) };
}

// ---------- Blind rating of advice ----------

const csvCell = (s: string) => `"${s.replace(/"/g, '""')}"`;

/**
 * Pairs the advice two runs wrote for the same items, in random order per pair, for a person to rate
 * without knowing which model wrote which. The key (which side is which) goes in a separate file.
 */
export function blindPairs(a: { label: string; items: ItemResult[] }, b: { label: string; items: ItemResult[] }, random = Math.random) {
  const rows: string[] = ['pair,item,advice_A,advice_B,better (A/B/same),notes'];
  const key: Record<string, { item: string; A: string; B: string }> = {};
  // Model and provider names are taken out of the text, so the advice cannot give its writer away.
  const names = [a.label, b.label].flatMap((l) => l.split(/[/\s]+/)).filter((w) => w.length > 2);
  const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const scrub = (t: string) => names.reduce((s, n) => s.replace(new RegExp(`(?<![\\w-])${esc(n)}(?![\\w-])`, 'gi'), '[model]'), t);
  let n = 0;
  for (const x of a.items) {
    const y = b.items.find((i) => i.id === x.id);
    if (!x.output || !y?.output) continue;
    const pair = `p${++n}`;
    const flip = random() < 0.5;
    const [A, B] = flip ? [y, x] : [x, y];
    key[pair] = { item: x.id, A: flip ? b.label : a.label, B: flip ? a.label : b.label };
    rows.push([pair, x.id, csvCell(scrub(A.output!)), csvCell(scrub(B.output!)), '', ''].join(','));
  }
  return { csv: rows.join('\n') + '\n', key };
}

/** Parses a rated CSV (RFC 4180 quoting) and tallies wins per model with the key. Unrated rows are counted apart. */
export function tallyRatings(csv: string, key: Record<string, { A: string; B: string }>) {
  const records: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (quoted) {
      if (ch === '"' && csv[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') row.push(cell), (cell = '');
    else if (ch === '\n') row.push(cell), records.push(row), (row = []), (cell = '');
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) row.push(cell), records.push(row);
  const wins: Record<string, number> = {};
  let same = 0;
  let unrated = 0;
  for (const [pair, , , , rating] of records.slice(1)) {
    const k = key[pair];
    const r = (rating ?? '').trim().toUpperCase();
    if (!k) continue;
    if (r === 'A' || r === 'B') wins[k[r]] = (wins[k[r]] ?? 0) + 1;
    else if (r === 'SAME') same++;
    else unrated++;
  }
  return { wins, same, unrated };
}
