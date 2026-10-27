// Checks which Meta Model API models the configured key can reach, without printing the key.
import { env } from '../server/src/env.ts';

const models = ['muse-spark-1.3', 'muse-spark-1.2', 'muse-wonder-1.0', 'muse-image-1.0', 'muse-voice-transcribe-1.0', 'sam-3.1'];

if (!env.modelApiKey) {
  console.error('MODEL_API_KEY is not set (expected in ~/.synteel.env or SYNTEEL_ENV_FILE).');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${env.modelApiKey}` };
const listed = await fetch(`${env.modelApiBase}/models`, { headers }).then((r) => r.json());
const ids: string[] = (listed.data ?? []).map((m: { id: string }) => m.id);
console.log(`GET /models → ${ids.length ? ids.join(', ') : '(empty)'}`);

for (const model of models) {
  const res = await fetch(`${env.modelApiBase}/models/${model}`, { headers });
  const body = await res.json().catch(() => ({}));
  console.log(`${model.padEnd(28)} ${res.status} ${body.error?.code ?? 'ok'}`);
}
