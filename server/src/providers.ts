// Which provider and model does each AI task, in which order. One table, read once at start.
//
// Every model call still goes through ai.ts call() (and so into the AI call ledger, ledger.ts);
// this file only decides where those calls go. Each task has an ordered list of provider+model:
// the first enabled one is tried first, and on an outage, overload or spent credits the next
// one answers (the ledger marks that row "fallback" with the provider and model that answered).
//
//   speech   speech to text (voice notes, rounds, help messages said aloud)
//   extract  reading a photo, voice transcript, notebook page or pond photo into a draft log
//   agent    evening briefing, dead-eel case agent, weekly pattern notes, "Dengarkan" rewrite
//   segment  SAM dead-eel count
// Text to speech has no entry: "Dengarkan" uses the phone's own voice (watch.tsx), no model call.
//
// The night alarms are not a task here and never will be: rules.ts and nowcast.ts take no model
// input (server/test/providers.test.ts checks that they cannot reach this file or ai.ts).
//
// A provider without its key is disabled and silently left out. Override a task's order with
// SYNTEEL_ROUTE_<TASK>="provider:model,provider:model" (e.g. SYNTEEL_ROUTE_EXTRACT), or with a
// bare provider name for its default model on that task. scripts/eval.ts runs the same routes.

export type Task = 'speech' | 'extract' | 'agent' | 'segment';
export const TASKS: Task[] = ['speech', 'extract', 'agent', 'segment'];

/** One provider+model a task can call; the shape ai.ts, agentloop.ts and sam.ts take. */
export interface Endpoint {
  /** Provider name, stored with every call in the ledger: "meta", "fireworks", "baseten", "nvidia". */
  name: string;
  apiKey: string;
  base: string;
  model: string;
  /** False when the API does not take `reasoning_effort` (sent to Muse Spark only). */
  reasoning?: boolean;
}

interface ProviderSpec {
  base: string;
  /** Env vars holding the key, first one set wins. */
  keys: string[];
  /** Tasks its API can do: speech and SAM are Meta Model API endpoints, not OpenAI-compatible. */
  tasks: Task[];
  /** The model used when a route names only the provider. */
  models: Partial<Record<Task, string>>;
  reasoning: boolean;
  /** Shown by `npm run eval -- routes`. */
  note: string;
}

export const PROVIDERS: Record<string, ProviderSpec> = {
  meta: {
    base: 'https://api.meta.ai/v1',
    keys: ['META_API_KEY', 'MODEL_API_KEY'],
    tasks: ['speech', 'extract', 'agent', 'segment'],
    models: { speech: 'muse-voice-transcribe-1.0', extract: 'muse-spark-1.3', agent: 'muse-spark-1.3', segment: 'sam-3.1' },
    reasoning: true,
    note: 'Meta Model API: Muse Spark 1.3, Muse Voice Transcribe, SAM 3.1',
  },
  // Open-weight Muse Spark Open on Fireworks (partner credits).
  fireworks: {
    base: 'https://api.fireworks.ai/inference/v1',
    keys: ['FIREWORKS_API_KEY'],
    tasks: ['extract', 'agent'],
    models: { extract: 'accounts/fireworks/models/muse-spark-open', agent: 'accounts/fireworks/models/muse-spark-open' },
    reasoning: true,
    note: 'Fireworks: Muse Spark Open (open weights)',
  },
  // The same open-weight Muse Spark Open on Baseten (partner credits).
  baseten: {
    base: 'https://inference.baseten.co/v1',
    keys: ['BASETEN_API_KEY'],
    tasks: ['extract', 'agent'],
    models: { extract: 'meta-models/muse-spark-open-1026', agent: 'meta-models/muse-spark-open-1026' },
    reasoning: true,
    note: 'Baseten: Muse Spark Open (open weights)',
  },
  // NVIDIA NIM on build.nvidia.com, OpenAI-compatible. In no default route: opt in with
  // SYNTEEL_ROUTE_<TASK>. Not called yet (no key on the server); the model id below is from the
  // public catalog and unverified, and whether it takes strict json_schema output must be checked
  // with `npm run eval -- bench` before it goes into a route.
  nvidia: {
    base: 'https://integrate.api.nvidia.com/v1',
    keys: ['NVIDIA_API_KEY'],
    tasks: ['extract', 'agent'],
    models: { extract: 'meta/llama-4-maverick-17b-128e-instruct', agent: 'meta/llama-4-maverick-17b-128e-instruct' },
    reasoning: false,
    note: 'NVIDIA NIM (build.nvidia.com), OpenAI-compatible; opt-in, unverified',
  },
};

/** Hackathon-era order, kept until an eval shows a better one (docs/evaluation.md). */
export const DEFAULT_ROUTES: Record<Task, string[]> = {
  speech: ['meta'],
  extract: ['meta', 'fireworks'],
  // The open-weight model first for the agents, with the Meta API and Fireworks behind it.
  agent: ['baseten', 'meta', 'fireworks'],
  segment: ['meta'],
};

/** "fireworks", "nvidia:meta/llama-3.3-70b-instruct" → provider and model (model empty: the provider's default). */
export function parseRoute(text: string): { provider: string; model: string }[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf(':');
      return i < 0 ? { provider: s, model: '' } : { provider: s.slice(0, i).trim(), model: s.slice(i + 1).trim() };
    });
}

type Vars = Record<string, string | undefined>;

export interface Routes {
  routes: Record<Task, Endpoint[]>;
  /** Entries left out, and why: no key, unknown provider, a task its API cannot do. */
  skipped: { task: Task; entry: string; why: 'no key' | 'unknown provider' | 'task not supported' | 'no model' }[];
}

const keyOf = (spec: ProviderSpec, vars: Vars) => spec.keys.map((k) => vars[k]).find((v) => v) ?? '';

/** One provider+model as an endpoint, or why it cannot be one. */
export function endpoint(task: Task, provider: string, model = '', vars: Vars = process.env): Endpoint | Routes['skipped'][number]['why'] {
  const spec = PROVIDERS[provider];
  if (!spec) return 'unknown provider';
  if (!spec.tasks.includes(task)) return 'task not supported';
  const m = model || spec.models[task];
  if (!m) return 'no model';
  const apiKey = keyOf(spec, vars);
  if (!apiKey) return 'no key';
  // MODEL_API_BASE points the Meta provider elsewhere (a test server, a proxy).
  const base = provider === 'meta' ? (vars.MODEL_API_BASE ?? spec.base) : spec.base;
  return { name: provider, apiKey, base, model: m, ...(!spec.reasoning && { reasoning: false }) };
}

/** Every task's enabled endpoints in order, from the defaults and the SYNTEEL_ROUTE_* overrides. */
export function resolveRoutes(vars: Vars = process.env): Routes {
  const routes = {} as Record<Task, Endpoint[]>;
  const skipped: Routes['skipped'] = [];
  for (const task of TASKS) {
    let entries = DEFAULT_ROUTES[task].map((provider) => ({ provider, model: '' }));
    // Older switch, kept: fireworks first for reading drafts.
    if (task === 'extract' && vars.SYNTEEL_AI_PROVIDER === 'fireworks') entries = [{ provider: 'fireworks', model: '' }, { provider: 'meta', model: '' }];
    const override = vars[`SYNTEEL_ROUTE_${task.toUpperCase()}`];
    if (override?.trim()) entries = parseRoute(override);
    routes[task] = [];
    for (const { provider, model } of entries) {
      const e = endpoint(task, provider, model, vars);
      if (typeof e === 'string') skipped.push({ task, entry: model ? `${provider}:${model}` : provider, why: e });
      else if (!routes[task].some((r) => r.name === e.name && r.model === e.model)) routes[task].push(e);
    }
  }
  return { routes, skipped };
}

/** "meta/muse-spark-1.3 → fireworks/…" for the start-up log; never the keys. */
export const describeRoute = (r: Endpoint[]) => (r.length ? r.map((e) => `${e.name}/${e.model}`).join(' → ') : 'none');
