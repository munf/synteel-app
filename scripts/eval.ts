// Evaluation, offline and measured. eval/README.md explains the data and how to add more.
//
//   npm run eval                        offline checks: guards, rules, fallbacks (no keys, no network)
//   npm run eval -- routes              the provider+model route of each task, as configured (no keys shown)
//   npm run eval -- bench [options]     the labelled items through one route per task, scored (scripts/bench.ts)
//       --tasks extract,segment         tasks to run (default: all four: speech, extract, agent, segment)
//       --provider meta                 that provider's default model on every task it can do, no fallback
//       --route extract=fireworks:<model>,meta   a route for one task (repeatable), as SYNTEEL_ROUTE_* takes it
//                                       (neither: the configured routes, with their fallback, as the app runs)
//       --only g17,jv-1                 only these item ids
//       --images <dir> --audio <dir>    private photos and recordings (or SYNTEEL_EVAL_IMAGES / SYNTEEL_EVAL_AUDIO)
//       --max-calls 20                  never more model calls than this in one run (default 20)
//       --mock                          a pretend API answering from the labels: checks the pipeline, costs nothing
//       --save                          writes docs/eval-results/<date>-<provider>.json
//       --out <file>                    with --save: this file instead (keeps an earlier run of the same day)
//   npm run eval -- pairs <a.json> <b.json> [--out <file.csv>]   blind A/B pairs of advice for a person to rate
//   npm run eval -- tally <rated.csv> <key.json>                  counts the ratings once they are filled in
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { blindPairs, mockApi, runTask, summarize, table, tallyRatings, type ItemResult } from './bench.ts';
import { env } from '../server/src/env.ts';
import { describeRoute, endpoint, parseRoute, PROVIDERS, TASKS, type Endpoint, type Task } from '../server/src/providers.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const [cmd, ...args] = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const opts = (name: string) => args.flatMap((a, i) => (args[i - 1] === `--${name}` ? [a] : []));
const flag = (name: string) => args.includes(`--${name}`);
/** Farm-local date (WIB) for file names. */
const today = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

if (!cmd) {
  await import('./eval-offline.ts');
} else if (cmd === 'routes') {
  for (const task of TASKS) console.log(`${task.padEnd(8)} ${describeRoute(env.routes[task])}`);
  for (const s of env.routesSkipped) console.log(`  left out of ${s.task}: ${s.entry} (${s.why})`);
  console.log('\nProviders:');
  for (const [name, p] of Object.entries(PROVIDERS)) console.log(`  ${name.padEnd(10)} ${p.keys.some((k) => process.env[k]) ? 'key set ' : 'no key  '} ${p.tasks.join(', ').padEnd(30)} ${p.note}`);
} else if (cmd === 'bench') {
  await bench();
} else if (cmd === 'pairs') {
  const [a, b] = args.filter((x) => !x.startsWith('--') && x !== opt('out'));
  if (!a || !b) throw new Error('usage: npm run eval -- pairs <a.json> <b.json> [--out file.csv]');
  const read = (f: string) => {
    const r = JSON.parse(readFileSync(f, 'utf8'));
    return { label: r.label as string, items: (r.tasks?.agent?.items ?? []) as ItemResult[] };
  };
  const { csv, key } = blindPairs(read(a), read(b));
  const out = opt('out') ?? join(ROOT, 'eval', 'ratings', `pairs-${today()}.csv`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, csv);
  writeFileSync(out.replace(/\.csv$/, '') + '.key.json', JSON.stringify(key, null, 2) + '\n');
  console.log(`${Object.keys(key).length} pairs → ${out}\nThe key is in ${out.replace(/\.csv$/, '')}.key.json: the rater must not open it.`);
} else if (cmd === 'tally') {
  const [csv, key] = args;
  if (!csv || !key) throw new Error('usage: npm run eval -- tally <rated.csv> <key.json>');
  console.log(tallyRatings(readFileSync(csv, 'utf8'), JSON.parse(readFileSync(key, 'utf8'))));
} else {
  throw new Error(`unknown command "${cmd}": see the top of scripts/eval.ts`);
}

async function bench() {
  const tasks = (opt('tasks')?.split(',') ?? TASKS) as Task[];
  const provider = opt('provider');
  const mock = flag('mock') ? await mockApi() : null;
  const routes = {} as Record<Task, Endpoint[]>;
  for (const task of tasks) {
    if (!TASKS.includes(task)) throw new Error(`unknown task "${task}"`);
    const given = opts('route').find((r) => r.startsWith(`${task}=`));
    const entries = given ? parseRoute(given.slice(task.length + 1)) : provider ? [{ provider, model: '' }] : null;
    if (mock) routes[task] = mock.route;
    else if (!entries) routes[task] = env.routes[task];
    else {
      routes[task] = [];
      for (const e of entries) {
        const p = endpoint(task, e.provider, e.model);
        if (typeof p === 'string') console.log(`${task}: ${e.provider}${e.model ? `:${e.model}` : ''} left out (${p})`);
        else routes[task].push(p);
      }
    }
  }
  const maxCalls = Number(opt('max-calls') ?? 20);
  const label = mock ? 'mock' : (provider ?? (opts('route').length ? 'route' : 'configured'));
  const result: Record<string, unknown> = {};
  let calls = 0;
  const summaries = [];
  try {
    for (const task of tasks) {
      if (!routes[task].length) {
        console.log(`${task}: no enabled provider on this route, skipped`);
        continue;
      }
      const run = await runTask(task, {
        route: routes[task],
        images: opt('images') ?? process.env.SYNTEEL_EVAL_IMAGES,
        audio: opt('audio') ?? process.env.SYNTEEL_EVAL_AUDIO,
        only: opt('only')?.split(','),
        maxCalls: maxCalls - calls,
        mock: Boolean(mock),
      });
      calls += run.items.reduce((a, i) => a + i.calls, 0);
      const summary = summarize(task, run.items);
      summaries.push(summary);
      result[task] = { route: routes[task].map((e) => `${e.name}/${e.model}`), summary, items: run.items, skipped: run.skipped };
      for (const i of run.items) console.log(`${task.padEnd(8)} ${i.id.padEnd(26)} score ${i.score === null ? 'n/a' : i.score.toFixed(2)}  verify ${i.verify ?? 'n/a'}  ${(i.ms / 1000).toFixed(1)} s  ${i.calls} calls  ${i.answeredBy.join(', ')}${i.error ? `  ERROR ${i.error}` : ''}`);
      if (run.skipped.length) console.log(`${task.padEnd(8)} skipped ${run.skipped.length}: ${[...new Set(run.skipped.map((s) => s.why))].join('; ')}`);
    }
  } finally {
    await mock?.close();
  }
  console.log(`\n${mock ? 'MOCK run (answers come from the labels: a pipeline check, not a model score)' : 'Live run'}: ${calls} model calls.\n`);
  console.log(table(summaries));
  if (flag('save')) {
    const file = opt('out') ?? join(ROOT, 'docs', 'eval-results', `${today()}-${label}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ date: today(), label, mode: mock ? 'mock' : 'live', calls, tasks: result }, null, 2) + '\n');
    console.log(`\nSaved ${file}`);
  }
}
