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
  // Real AI reads per farm per day; unset means no cap.
  farmAiCap: Number(process.env.SYNTEEL_AI_FARM_CAP ?? 0),
  // Real AI reads allowed per day for the whole server; unset means no cap. Set on the public preview.
  aiDailyCap: Number(process.env.SYNTEEL_AI_DAILY_CAP ?? 0),
  // Per deployment, so two instances on one domain (preview, production) keep separate logins.
  cookieName: process.env.SYNTEEL_COOKIE ?? 'synteel_session',
  // Phone number of the shared demo account ("Coba demo"); unset disables demo login.
  demoPhone: process.env.SYNTEEL_DEMO_PHONE || null,
  port: Number(process.env.PORT ?? 8787),
  // e.g. 127.0.0.1 behind a reverse proxy; unset listens on all interfaces.
  host: process.env.HOST,
  // Example drafts instead of real AI, until Meta API access works.
  aiMock: process.env.SYNTEEL_AI_MOCK === '1',
  // Support tickets by e-mail; without host, sender and recipient they are only stored.
  smtp:
    process.env.SYNTEEL_SMTP_HOST && process.env.SYNTEEL_SUPPORT_TO && (process.env.SYNTEEL_SMTP_FROM || process.env.SYNTEEL_SMTP_USER)
      ? {
          host: process.env.SYNTEEL_SMTP_HOST,
          port: Number(process.env.SYNTEEL_SMTP_PORT || 587),
          user: process.env.SYNTEEL_SMTP_USER ?? '',
          pass: process.env.SYNTEEL_SMTP_PASS ?? '',
          from: (process.env.SYNTEEL_SMTP_FROM || process.env.SYNTEEL_SMTP_USER)!,
          to: process.env.SYNTEEL_SUPPORT_TO.split(',').map((a) => a.trim()).filter(Boolean),
        }
      : null,
};
