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

export const env = {
  modelApiKey: process.env.MODEL_API_KEY ?? '',
  modelApiBase: process.env.MODEL_API_BASE ?? 'https://api.meta.ai/v1',
  port: Number(process.env.PORT ?? 8787),
  // e.g. 127.0.0.1 behind a reverse proxy; unset listens on all interfaces.
  host: process.env.HOST,
  // Example drafts instead of real AI, until Meta API access works.
  aiMock: process.env.SYNTEEL_AI_MOCK === '1',
};
