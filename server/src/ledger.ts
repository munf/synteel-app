// AI call ledger: every model call the server makes, one row each, in one table.
//
// ai.ts call() is the one door to every model API (Meta Model API, Fireworks, Baseten, SAM 3.1);
// it reports each call here with its provider, model, time taken and the token counts the API
// returned. Which farmer result the call belongs to comes from track(): the API wraps each AI
// feature in it, and the calls made inside land under one request id with the farm, pond and
// result they serve, plus the verification of that result (verify.ts).
//
// Privacy: no audio, no images and no farmer text are stored, only counts, times, names of
// models and the plain-words checks. Error texts are the API's status line ("AI API 503: …").
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Db } from './db.ts';
import type { Verification } from './verify.ts';

const DAY = 24 * 3600_000;
const WIB = 7 * 3600_000;

/** What the farmer asked the AI for. */
export type AiKind = 'photo' | 'voice' | 'video' | 'round' | 'count' | 'notebook' | 'pond_photo' | 'transcribe' | 'briefing' | 'case' | 'spoken' | 'pattern';
/** What one model call did inside a request. */
export type AiStep = 'speech' | 'read' | 'segment' | 'agent' | 'rewrite' | 'rules' | 'mock';
/** ok; fallback: answered by the next provider (or by the rules) after one failed; error; mock: sample mode, no model. */
export type Outcome = 'ok' | 'fallback' | 'error' | 'mock';

export interface CallTag {
  provider: string;
  model: string;
  step: AiStep;
  /** Billed by audio length (speech) or per image (SAM), not by tokens. */
  audioSeconds?: number;
  images?: number;
}

// ---------- Prices: estimates only ----------
// Read on 9 Nov 2026 (USD):
//   Meta Model API, https://dev.meta.ai/docs/pricing-rate-limits/: Muse Spark (Standard) $1.25 per 1M input
//     tokens, $4.25 per 1M output tokens; Muse Voice Transcribe $0.18 per hour of audio; SAM 3.1 image
//     segmentation $2.50 per 1,000 images.
//   Fireworks, https://fireworks.ai/models/fireworks/muse-spark-open: Muse Spark Open $1.25 / $4.25 per 1M.
//   Baseten: no public price for Muse Spark Open could be read; assumed equal to Fireworks.
// Fireworks and Baseten run on partner credits today: the figure is what the calls would cost, not a bill.
// NVIDIA NIM (providers.ts, opt-in): no entry, so its rows carry no estimate until a price is read.
interface Price {
  inPerM?: number;
  outPerM?: number;
  perAudioHour?: number;
  perImage?: number;
}
export const PRICES: Record<string, Price> = {
  'meta/muse-spark-1.3': { inPerM: 1.25, outPerM: 4.25 },
  'fireworks/accounts/fireworks/models/muse-spark-open': { inPerM: 1.25, outPerM: 4.25 },
  'baseten/meta-models/muse-spark-open-1026': { inPerM: 1.25, outPerM: 4.25 },
  'meta/muse-voice-transcribe-1.0': { perAudioHour: 0.18 },
  'meta/sam-3.1': { perImage: 2.5 / 1000 },
};

/** Estimated USD for one call, or null when the model has no price in the table. */
export function estimateCost(tag: Pick<CallTag, 'provider' | 'model' | 'audioSeconds' | 'images'>, tokens: { input: number | null; output: number | null }): number | null {
  const p = PRICES[`${tag.provider}/${tag.model}`];
  if (!p || (p.perAudioHour !== undefined && tag.audioSeconds === undefined)) return null;
  let usd = 0;
  if (p.inPerM !== undefined) usd += ((tokens.input ?? 0) * p.inPerM) / 1e6;
  if (p.outPerM !== undefined) usd += ((tokens.output ?? 0) * p.outPerM) / 1e6;
  if (p.perAudioHour !== undefined) usd += ((tag.audioSeconds ?? 0) / 3600) * p.perAudioHour;
  if (p.perImage !== undefined) usd += (tag.images ?? 1) * p.perImage;
  return usd;
}

/** Token counts as the APIs return them: chat completions (prompt/completion) or the Responses API (input/output). */
export function tokensOf(body: any): { input: number | null; output: number | null } {
  const u = body?.usage;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
  return { input: n(u?.prompt_tokens ?? u?.input_tokens), output: n(u?.completion_tokens ?? u?.output_tokens) };
}

// ---------- The request a call belongs to ----------

interface Run {
  id: string;
  kind: AiKind;
  farmId: number | null;
  pondId: number | null;
  calls: number;
  /** Steps that failed on a provider: an answer to the same step after that is a fallback. */
  failed: Set<AiStep>;
  write(row: Row): void;
}

interface Row {
  step: AiStep;
  provider: string;
  model: string;
  startedAt: number;
  ms: number;
  input: number | null;
  output: number | null;
  cost: number | null;
  outcome: Outcome;
  error: string | null;
}

const runs = new AsyncLocalStorage<Run>();

/** Called by ai.ts call() after every model API call, whether it answered or failed. Outside track() it is a no-op. */
export function noteCall(tag: CallTag, startedAt: number, result: { body: unknown } | { error: Error }) {
  const run = runs.getStore();
  if (!run) return;
  run.calls++;
  const ms = Date.now() - startedAt;
  if ('error' in result) {
    run.failed.add(tag.step);
    run.write({ step: tag.step, provider: tag.provider, model: tag.model, startedAt, ms, input: null, output: null, cost: null, outcome: 'error', error: result.error.message.slice(0, 200) });
    return;
  }
  const tokens = tokensOf(result.body);
  run.write({
    step: tag.step,
    provider: tag.provider,
    model: tag.model,
    startedAt,
    ms,
    ...tokens,
    cost: estimateCost(tag, tokens),
    outcome: run.failed.has(tag.step) ? 'fallback' : 'ok',
    error: null,
  });
}

/** The request id of the tracked request this code runs in, if any. */
export const currentRequest = () => runs.getStore()?.id ?? null;

export interface TrackOptions<T> {
  farmId?: number | null;
  pondId?: number | null;
  /** Sample mode: no model is called; one row with outcome "mock" is written. */
  mock?: boolean;
  /** The result's verification, stored with every row of the request. */
  verify?: (result: T) => Verification | null | undefined;
  /** What the result became, e.g. "briefing:12", "case:3". */
  ref?: (result: T) => string | null;
  /** True when the rules answered because every model failed or was refused: a "rules" row marks the fallback. */
  rules?: (result: T) => boolean;
}

/** One step of "Cara AI memproses ini": calls of the same step and model taken together. */
export interface TraceStep {
  step: AiStep;
  provider: string;
  model: string;
  calls: number;
  ms: number;
  outcome: Outcome;
}

export interface Trace {
  id: string;
  kind: AiKind;
  at: string;
  /** From the first call's start to the last call's end. */
  ms: number;
  steps: TraceStep[];
  verify: Verification | null;
}

type DbRow = Record<string, unknown>;

export function aiLedger(db: Db, now = () => new Date()) {
  db.exec(`
    create table if not exists ai_ledger (
      id integer primary key,
      request_id text not null,
      kind text not null,
      step text not null,
      provider text not null,
      model text not null,
      started_at text not null,
      ms integer not null,
      input_tokens integer,
      output_tokens integer,
      -- USD from the price table in ledger.ts: an estimate, never a bill.
      cost_usd_estimate real,
      outcome text not null check (outcome in ('ok', 'fallback', 'error', 'mock')),
      error text,
      -- The result's verification (verify.ts) as JSON: status and plain-words checks.
      verify text,
      farm_id integer,
      pond_id integer,
      result_ref text
    );
    create index if not exists ai_ledger_request on ai_ledger (request_id);
    create index if not exists ai_ledger_started on ai_ledger (started_at);
  `);
  // Kept 90 days, like the dashboard's other logs.
  db.prepare('delete from ai_ledger where started_at < ?').run(new Date(now().getTime() - 90 * DAY).toISOString());

  const insert = db.prepare(
    `insert into ai_ledger (request_id, kind, step, provider, model, started_at, ms, input_tokens, output_tokens, cost_usd_estimate, outcome, error, farm_id, pond_id)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const write = (run: Pick<Run, 'id' | 'kind' | 'farmId' | 'pondId'>, r: Row) =>
    insert.run(run.id, run.kind, r.step, r.provider, r.model, new Date(r.startedAt).toISOString(), Math.round(r.ms), r.input, r.output, r.cost, r.outcome, r.error, run.farmId, run.pondId);

  const ledger = {
    /**
     * Runs one AI feature for a farmer: every model call inside is written under one request id.
     * `fn` gets that id, to hand to the phone with the result ("Cara AI memproses ini").
     */
    async track<T>(kind: AiKind, fn: (id: string) => Promise<T>, o: TrackOptions<T> = {}): Promise<T> {
      const run: Run = { id: randomUUID(), kind, farmId: o.farmId ?? null, pondId: o.pondId ?? null, calls: 0, failed: new Set(), write: (r) => write(run, r) };
      const started = Date.now();
      const result = await runs.run(run, () => fn(run.id));
      if (o.mock && run.calls === 0) write(run, { step: 'mock', provider: 'mock', model: 'mock', startedAt: started, ms: Date.now() - started, input: null, output: null, cost: null, outcome: 'mock', error: null });
      else if (o.rules?.(result)) write(run, { step: 'rules', provider: 'rules', model: 'rules', startedAt: Date.now(), ms: 0, input: null, output: null, cost: null, outcome: 'fallback', error: null });
      ledger.settle(run.id, o.verify?.(result) ?? null, o.ref?.(result) ?? null);
      return result;
    },

    /** Stores the verification and what the result became on every row of the request. */
    settle(id: string, verify: Verification | null, ref: string | null = null) {
      db.prepare('update ai_ledger set verify = coalesce(?, verify), result_ref = coalesce(?, result_ref) where request_id = ?').run(verify ? JSON.stringify(verify) : null, ref, id);
    },

    /** What the farmer made of the result (e.g. "log:41"), only for a request of this farm. */
    link(id: string, farmId: number, ref: string) {
      db.prepare('update ai_ledger set result_ref = ? where request_id = ? and farm_id = ?').run(ref, id, farmId);
    },

    /** The farmer's view of one request; null when it is not this farm's. Costs are left out on purpose. */
    trace(id: string, farmId: number): Trace | null {
      const rows = db.prepare('select * from ai_ledger where request_id = ? and farm_id = ? order by started_at, id').all(id, farmId) as DbRow[];
      if (!rows.length) return null;
      const steps: TraceStep[] = [];
      const rank: Record<Outcome, number> = { mock: 0, ok: 1, fallback: 2, error: 3 };
      for (const r of rows) {
        const last = steps.at(-1);
        const outcome = r.outcome as Outcome;
        if (last && last.step === r.step && last.provider === r.provider && last.model === r.model) {
          last.calls++;
          last.ms += r.ms as number;
          // The worst of the calls: one failed turn means this provider's attempt failed.
          if (rank[outcome] > rank[last.outcome]) last.outcome = outcome;
        } else steps.push({ step: r.step as AiStep, provider: r.provider as string, model: r.model as string, calls: 1, ms: r.ms as number, outcome });
      }
      const start = Math.min(...rows.map((r) => Date.parse(r.started_at as string)));
      const end = Math.max(...rows.map((r) => Date.parse(r.started_at as string) + (r.ms as number)));
      const verify = rows.find((r) => r.verify)?.verify as string | undefined;
      return { id, kind: rows[0].kind as AiKind, at: new Date(start).toISOString(), ms: end - start, steps, verify: verify ? JSON.parse(verify) : null };
    },

    /** The newest rows, for the team dashboard. */
    recent(limit = 50) {
      return db.prepare('select * from ai_ledger order by started_at desc, id desc limit ?').all(limit) as DbRow[];
    },

    /** Totals per provider and model since `since` (ISO). */
    perModel(since: string) {
      return db
        .prepare(
          `select provider, model, count(*) as calls, sum(outcome = 'error') as errors, sum(outcome = 'fallback') as fallbacks,
             sum(coalesce(input_tokens, 0)) as input_tokens, sum(coalesce(output_tokens, 0)) as output_tokens,
             sum(coalesce(cost_usd_estimate, 0)) as cost, avg(ms) as avg_ms
           from ai_ledger where started_at >= ? and provider not in ('mock', 'rules')
           group by provider, model order by cost desc, calls desc`,
        )
        .all(since) as DbRow[];
    },

    /**
     * Estimated cost per farm per night since `since`. A night runs from 12.00 to 12.00 WIB and is named by
     * its first day, so the evening briefing, night checks and the morning's records fall in one night.
     */
    perFarmNight(since: string) {
      const rows = db.prepare('select farm_id, started_at, cost_usd_estimate from ai_ledger where started_at >= ? and farm_id is not null').all(since) as DbRow[];
      const out = new Map<string, { farmId: number; night: string; cost: number; calls: number }>();
      for (const r of rows) {
        const night = nightOf(r.started_at as string);
        const key = `${r.farm_id}|${night}`;
        const n = out.get(key) ?? { farmId: r.farm_id as number, night, cost: 0, calls: 0 };
        n.cost += (r.cost_usd_estimate as number | null) ?? 0;
        n.calls++;
        out.set(key, n);
      }
      return [...out.values()];
    },
  };
  return ledger;
}
export type Ledger = ReturnType<typeof aiLedger>;

/** "2026-11-09T03:00:00Z" (10.00 WIB) → "2026-11-08": the night that started the day before at 12.00 WIB. */
export const nightOf = (iso: string) => new Date(Date.parse(iso) + WIB - 12 * 3600_000).toISOString().slice(0, 10);

/** Without a database (scripts, some tests): runs the feature, records nothing. */
export const noLedger: Pick<Ledger, 'track' | 'settle'> = {
  track: (_kind, fn) => fn(''),
  settle: () => {},
};
