import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveRoutes } from './providers.ts';

// Secrets live outside the public repo: SYNTEEL_ENV_FILE, or ~/.synteel.env by default.
const envFile = process.env.SYNTEEL_ENV_FILE ?? join(homedir(), '.synteel.env');

if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

// Which provider and model does each AI task, in which order: providers.ts. Providers without a key are left out.
const { routes, skipped } = resolveRoutes(process.env);

export const env = {
  /** Provider+model per AI task, tried in order (speech, extract, agent, segment). */
  routes,
  /** Route entries left out (no key, unknown provider, task not supported), for the start-up log. */
  routesSkipped: skipped,
  /** Evening briefing, case agent, pattern notes and the "Dengarkan" rewrite, tried in order. */
  agentChat: routes.agent,
  /** Reading drafts: photos, voice transcripts, rounds, notebook pages, pond photos. */
  aiChat: routes.extract,
  // Real AI reads per farm per day; unset means no cap.
  farmAiCap: Number(process.env.SYNTEEL_AI_FARM_CAP ?? 0),
  // Real AI reads allowed per day for the whole server; unset means no cap. Set on the public preview.
  aiDailyCap: Number(process.env.SYNTEEL_AI_DAILY_CAP ?? 0),
  // Per deployment, so two instances on one domain (preview, production) keep separate logins.
  cookieName: process.env.SYNTEEL_COOKIE ?? 'synteel_session',
  // Phone number of the demo template's owner ("Coba demo" copies its farm); unset disables demo login.
  demoPhone: process.env.SYNTEEL_DEMO_PHONE || null,
  // "Coba demo" limits (demo.ts defaults when unset): new demo farms per address per day, demo farms alive at once.
  demoPerIp: Number(process.env.SYNTEEL_DEMO_PER_IP || 0) || undefined,
  demoMaxLive: Number(process.env.SYNTEEL_DEMO_MAX_LIVE || 0) || undefined,
  port: Number(process.env.PORT ?? 8787),
  // e.g. 127.0.0.1 behind a reverse proxy; unset listens on all interfaces.
  host: process.env.HOST,
  // Example drafts instead of real AI, until Meta API access works.
  aiMock: process.env.SYNTEEL_AI_MOCK === '1',
  // Team dashboard login (admin.ts); unset turns the dashboard off.
  admin: process.env.SYNTEEL_ADMIN_USER && process.env.SYNTEEL_ADMIN_PASSWORD ? { user: process.env.SYNTEEL_ADMIN_USER, password: process.env.SYNTEEL_ADMIN_PASSWORD } : null,
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
