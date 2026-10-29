import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createAi, withDailyCap } from './ai.ts';
import { createApi } from './api.ts';
import { captureStore } from './captures.ts';
import { openDb, repo } from './db.ts';
import { env } from './env.ts';
import { emergenciesEn, knowledge } from './knowledge.ts';
import { parseLang } from './i18n.ts';
import { mailer } from './mail.ts';
import { MONITOR_INTERVAL_MS, startMonitor } from './monitor.ts';
import type { Nowcast } from './nowcast.ts';

const app = new Hono().basePath('/api');

app.get('/health', (c) => c.json({ ok: true, modelApiKeyConfigured: env.aiChat.some((p) => p.apiKey !== '') }));

// The emergency steps follow the app's language (x-lang); the rest is reference data.
app.get('/knowledge', (c) =>
  c.json(parseLang(c.req.header('x-lang')) === 'en' ? { ...knowledge, emergencies: { ...knowledge.emergencies, ...emergenciesEn } } : knowledge),
);

const ai = withDailyCap(createAi({ chat: env.aiChat, transcriber: env.aiTranscriber, mock: env.aiMock }), env.aiDailyCap);
const chain = env.aiChat.filter((p) => p.apiKey).map((p) => p.name).join(' → ');
console.log(`AI mode: ${ai.mode}${ai.mode === 'meta' ? ` (${chain}${env.aiTranscriber.apiKey ? ', voice: meta' : ', no voice'}${env.aiDailyCap ? `, cap ${env.aiDailyCap}/day` : ''})` : ''}`);
const store = repo(openDb());
const api = createApi(store, { ai, saveCapture: captureStore(), cookieName: env.cookieName, demoPhone: env.demoPhone, farmAiCap: env.farmAiCap, agentProviders: env.aiChat.filter((p) => p.apiKey), sam: env.aiTranscriber.apiKey ? { apiKey: env.aiTranscriber.apiKey, base: env.aiTranscriber.base } : null, mail: mailer(env.smtp) });
console.log(`Support mail: ${env.smtp ? `${env.smtp.host}:${env.smtp.port}` : 'not configured (tickets only stored)'}`);
app.route('/', api);

// Routes must all be registered before the first request, which the monitor makes.
app.get('/monitor', (c) => c.json({ intervalMs: MONITOR_INTERVAL_MS, ...monitor.status }));

const monitor = startMonitor(
  // Every farm, not just the ones somebody has open. Pond ids are unique across farms.
  async () => ({ ponds: (await Promise.all(store.farmIds().map((id) => api.nowcastFarm(id)))).flatMap((n) => n.ponds as Nowcast[]) }),
  (change) => console.log(`risk up: pond ${change.pondId} ${change.from} → ${change.to}: ${change.reasons.join('; ')}`),
);

// Evening briefing: check every 10 minutes; each farm gets one from 17.00 local time.
setInterval(() => api.briefFarms().catch((err) => console.error('briefings:', err)), 10 * 60_000);

serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info) => {
  console.log(`synteel server listening on http://${env.host ?? 'localhost'}:${info.port}`);
});
