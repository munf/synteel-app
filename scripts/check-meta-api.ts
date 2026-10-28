// Checks which Muse models the configured keys can reach, without printing the keys.
import { env } from '../server/src/env.ts';

const metaModels = ['muse-spark-1.3', 'muse-spark-1.2', 'muse-wonder-1.0', 'muse-image-1.0', 'muse-voice-transcribe-1.0', 'sam-3.1'];

for (const p of env.aiChat) {
  if (!p.apiKey) {
    console.log(`${p.name}: no API key (expected in ~/.synteel.env or SYNTEEL_ENV_FILE)`);
    continue;
  }
  const headers = { Authorization: `Bearer ${p.apiKey}`, 'User-Agent': 'synteel-app' };
  const res = await fetch(`${p.base}/models`, { headers });
  const ids: string[] = ((await res.json().catch(() => ({}))).data ?? []).map((m: { id: string }) => m.id);
  console.log(`${p.name}: GET /models ${res.status}`);
  for (const id of p.name === 'meta' ? metaModels : [p.model]) console.log(`  ${id.padEnd(44)} ${ids.includes(id) ? 'available' : 'missing'}`);
}
