// Builds the demo template farm that "Coba demo" copies for each visitor (server/src/demo.ts):
// three ponds with two weeks of records and the open Kolam B dead-eel case, plus the case update
// and evening briefing in Indonesian and English.
//
// Usage:
//   node scripts/seed-demo.ts --reset        delete the database, then build the template
//                                            (stop the server first, or it keeps writing to the deleted file)
//   node scripts/seed-demo.ts --template     rebuild the template in the existing database; demo copies stay
//   add --if-missing                         only build when there is no template yet
//   add --rebuild-if <file>                  ...or when <file> exists (the nightly rebuild sets it)
//   add --ai                                 write the case update and briefing with the real agents
//                                            (keys from SYNTEEL_ENV_FILE or ~/.synteel.env); without it the
//                                            rules write them, or labelled samples with SYNTEEL_AI_MOCK=1
import { existsSync, rmSync } from 'node:fs';
import { createAi } from '../server/src/ai.ts';
import { createApi } from '../server/src/api.ts';
import { openDb, repo } from '../server/src/db.ts';
import { env } from '../server/src/env.ts';

const args = process.argv.slice(2);
const dbPath = process.env.SYNTEEL_DB ?? new URL('../data/synteel.sqlite', import.meta.url).pathname;
const flag = (name: string) => args.includes(name);
const rebuildFile = args[args.indexOf('--rebuild-if') + 1];

if (flag('--reset')) {
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
} else if (!flag('--template')) {
  console.error('Use --reset (new database) or --template (rebuild the template in the existing one).');
  process.exit(1);
}

const store = repo(openDb(dbPath));
const forced = flag('--rebuild-if') && rebuildFile && existsSync(rebuildFile);
if (flag('--if-missing') && store.demo.template() && !forced) {
  console.log(`Demo template already there (farm ${store.demo.template()!.farmId}); nothing to do.`);
  process.exit(0);
}

const useAi = flag('--ai') || env.aiMock;
const ai = useAi ? createAi({ chat: env.aiChat, transcriber: env.aiTranscriber, mock: env.aiMock }) : undefined;
const api = createApi(store, { demoPhone: env.demoPhone ?? '620000000000', ai, agentProviders: useAi ? env.agentChat.filter((p) => p.apiKey) : [] });
const started = Date.now();
const farmId = await api.buildDemoTemplate();
const r = store.farm(farmId);
const runs = r.listCases().flatMap((c) => r.caseEvents(c.id).filter((e) => e.kind === 'run').map((e) => `case ${e.data.lang} ${e.data.source}`));
const today = store.demo.template()!.builtOn;
const briefings = r.briefingRows<{ source: string }>(today).map((b) => `briefing ${b.lang} ${b.body.source}`);
console.log(`Demo template: farm ${farmId}, ${r.listPonds().length} ponds, ${[...runs, ...briefings].join(', ')} (${((Date.now() - started) / 1000).toFixed(1)} s) in ${dbPath}`);
