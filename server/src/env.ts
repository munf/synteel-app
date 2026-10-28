import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Secrets live outside the public repo: SYNTEEL_ENV_FILE, or ~/.synteel.env by default.
const envFile = process.env.SYNTEEL_ENV_FILE ?? join(homedir(), '.synteel.env');

if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

const metaKey = process.env.META_API_KEY ?? process.env.MODEL_API_KEY ?? '';
const metaBase = process.env.MODEL_API_BASE ?? 'https://api.meta.ai/v1';
const meta = { name: 'meta', apiKey: metaKey, base: metaBase, model: 'muse-spark-1.3' };
// Open-weight Muse Spark Open on Fireworks (partner credits): fallback when the Meta API
// is down or out of credits. SYNTEEL_AI_PROVIDER=fireworks puts it first.
const fireworks = {
  name: 'fireworks',
  apiKey: process.env.FIREWORKS_API_KEY ?? '',
  base: 'https://api.fireworks.ai/inference/v1',
  model: 'accounts/fireworks/models/muse-spark-open',
};

export const env = {
  aiChat: process.env.SYNTEEL_AI_PROVIDER === 'fireworks' ? [fireworks, meta] : [meta, fireworks],
  // Speech-to-text only exists on the Meta side.
  aiTranscriber: { apiKey: metaKey, base: metaBase, model: 'muse-voice-transcribe-1.0' },
  // Real AI reads allowed per day; unset means no cap. Set on the public preview.
  aiDailyCap: Number(process.env.SYNTEEL_AI_DAILY_CAP ?? 0),
  port: Number(process.env.PORT ?? 8787),
  // e.g. 127.0.0.1 behind a reverse proxy; unset listens on all interfaces.
  host: process.env.HOST,
  // Example drafts instead of real AI, until Meta API access works.
  aiMock: process.env.SYNTEEL_AI_MOCK === '1',
};
