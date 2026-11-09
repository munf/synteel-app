// Checks which models the configured keys can reach, without printing the keys.
// Every provider in providers.ts is listed; one without its key is only named.
import '../server/src/env.ts';
import { endpoint, PROVIDERS, TASKS } from '../server/src/providers.ts';

const metaModels = ['muse-spark-1.3', 'muse-spark-1.2', 'muse-wonder-1.0', 'muse-image-1.0', 'muse-voice-transcribe-1.0', 'sam-3.1'];

for (const [name, spec] of Object.entries(PROVIDERS)) {
  const task = TASKS.find((t) => spec.tasks.includes(t))!;
  const p = endpoint(task, name);
  if (typeof p === 'string') {
    console.log(`${name}: ${p} (${spec.keys.join(' or ')} in ~/.synteel.env or SYNTEEL_ENV_FILE)`);
    continue;
  }
  const headers = { Authorization: `Bearer ${p.apiKey}`, 'User-Agent': 'synteel-app' };
  const res = await fetch(`${p.base}/models`, { headers });
  const ids: string[] = ((await res.json().catch(() => ({}))).data ?? []).map((m: { id: string }) => m.id);
  console.log(`${name}: GET /models ${res.status}`);
  const models = name === 'meta' ? metaModels : [...new Set(Object.values(spec.models))];
  for (const id of models) console.log(`  ${id.padEnd(44)} ${ids.includes(id) ? 'available' : 'missing'}`);
}
