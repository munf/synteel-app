// Exports a run bundle (JSON) for the public replay page (web/replay/, server/src/replay.ts).
//
//   node scripts/replay-export.ts [sources…] [--out <file>]
//
// Sources, any number, in the order given:
//   --bench <docs/eval-results/….json>    a saved benchmark: 'real' when it ran live, 'demo' for a --mock run
//   --db <file.sqlite> --origin real|demo --source "<words>" [--since 2026-11-10] [--farm 12]
//                                         an app database's AI call ledger (a copy of the server's, or a QA one)
//   --demo                                the demo farm with sample answers (mock AI, no model, no network):
//                                         the template's dead-eel case update and a voice round saved as a record,
//                                         both through the app's own API and ledger
//
// Every bundle goes through anonymise() before it is written: names of people in the database become the
// pseudonym "Pak Budi", farm names "Tambak mitra"; phone numbers, e-mail addresses, coordinates and places
// finer than the village are removed. Default output: web/src/replay/runs.json (bundled into the page).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createAi } from '../server/src/ai.ts';
import { createApi } from '../server/src/api.ts';
import { openDb, repo, type Db } from '../server/src/db.ts';
import { aiLedger } from '../server/src/ledger.ts';
import { anonymise, runsFromBench, runsFromLedger, type AnonymiseOptions, type Origin, type ReplayRun, type RunBundle } from '../server/src/replay.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const args = process.argv.slice(2);
const values = (name: string) => args.flatMap((a, i) => (args[i - 1] === `--${name}` ? [a] : []));
const opt = (name: string) => values(name)[0];

const runs: ReplayRun[] = [];
const names: Required<Pick<AnonymiseOptions, 'names' | 'farms' | 'places'>> = { names: [], farms: [], places: [] };

/** People, farms and farm locations in a database: replaced by the anonymiser wherever they show up. */
function namesIn(db: Db) {
  const col = (sql: string) => (db.prepare(sql).all() as Record<string, unknown>[]).map((r) => Object.values(r)[0]).filter((v): v is string => typeof v === 'string');
  names.names.push(...col('select name from users'));
  names.farms.push(...col('select name from farms'));
  names.places.push(...col('select location_name from farms where location_name is not null'));
}

const labelled = {
  rounds: JSON.parse(readFileSync(join(ROOT, 'eval/labelled/rounds.json'), 'utf8')),
  counts: JSON.parse(readFileSync(join(ROOT, 'eval/labelled/counts.json'), 'utf8')),
};
for (const file of values('bench')) runs.push(...runsFromBench(JSON.parse(readFileSync(file, 'utf8')), labelled, basename(file)));

if (opt('db')) {
  const origin = opt('origin') as Origin;
  if (origin !== 'real' && origin !== 'demo') throw new Error('--db needs --origin real or --origin demo');
  const db = openDb(opt('db'));
  namesIn(db);
  const source = opt('source') ?? `${origin === 'real' ? 'App database' : 'Demo database'} ${basename(opt('db')!)}`;
  runs.push(...runsFromLedger(db, { origin, source: { id: source, en: source }, since: opt('since'), farmIds: values('farm').map(Number) }));
}

if (args.includes('--demo')) runs.push(...(await demoRuns()));

/** The demo farm through the app's own path with sample answers: what a visitor of "Coba demo" gets without a model. */
async function demoRuns(): Promise<ReplayRun[]> {
  const db = openDb(':memory:');
  const store = repo(db);
  const ledger = aiLedger(db);
  const offline = async () => {
    throw new Error('offline');
  };
  const api = createApi(store, { ai: createAi({ chat: [], mock: true }), demoPhone: '620000000000', ledger, getWeather: offline, geocode: async () => null, getBmkg: offline, getStorm: async () => [], fetchArchive: null });
  await api.buildDemoTemplate();
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const form = body instanceof FormData;
    const res = await api.request(path, { method, headers: { ...(cookie && { cookie }), ...(body && !form && { 'content-type': 'application/json' }) }, body: form ? (body as FormData) : body === undefined ? undefined : JSON.stringify(body) });
    cookie = res.headers.get('set-cookie')?.split(';')[0] ?? cookie;
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    return res.json() as Promise<any>;
  };
  await call('POST', '/auth/demo');
  const ponds = (await call('GET', '/farm')).ponds as { id: number; name: string }[];
  // A voice round with the sample answer; the farmer keeps the first pond's draft as a record.
  const { round } = await call('POST', '/round/text', { transcript: 'Kolam A suhune pitulikur, pH pitu koma papat.' });
  const first = round.drafts.find((d: { pondId: number | null }) => d.pondId !== null);
  if (first) await call('POST', `/ponds/${first.pondId}/logs`, { ...first.data, source: 'voice', trace: round.trace });
  namesIn(db);
  const seen = new Set<string>();
  return runsFromLedger(db, {
    origin: 'demo',
    source: { id: 'Tambak demo "Coba demo" dengan jawaban contoh, tanpa model (scripts/replay-export.ts --demo)', en: 'Demo farm "Coba demo" with sample answers, no model (scripts/replay-export.ts --demo)' },
  })
    .filter((r) => !seen.has(r.kind) && seen.add(r.kind))
    .map((r) => ({
      ...r,
      input:
        r.kind === 'round'
          ? { type: 'transcript', text: round.transcript, note: { id: 'Mode contoh: jawabannya contoh tetap di tambak demo, tidak dibaca dari rekaman.', en: 'Sample mode: the answer is a fixed example on the demo farm, not read from a recording.' } }
          : { ...r.input, note: { id: `${r.input.note.id} Tambak demo: catatan buatan, bukan tambak nyata.`, en: `${r.input.note.en} Demo farm: generated records, not a real farm.` } },
    }));
}

const bundle: RunBundle = anonymise(
  {
    about: 'Synteel replayable runs. origin "real": a real model API answered (Meta Model API). origin "demo": demo farm or sample answers, no model. Partner farm data is pseudonymous; no faces, phone numbers, e-mail addresses or places finer than the village.',
    exportedAt: new Date().toISOString(),
    runs,
  },
  { ...names, names: names.names.filter((n) => !/^(Petani Demo|Demo Farmer)$/.test(n)) },
);
const out = opt('out') ?? join(ROOT, 'web/src/replay/runs.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(bundle, null, 2) + '\n');
console.log(`${bundle.runs.length} runs (${bundle.runs.filter((r) => r.origin === 'real').length} real, ${bundle.runs.filter((r) => r.origin === 'demo').length} demo) → ${out}`);
