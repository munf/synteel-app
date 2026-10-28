import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createAi, withDailyCap } from './ai.ts';
import { createApi } from './api.ts';
import { captureStore } from './captures.ts';
import { openDb, repo } from './db.ts';
import { env } from './env.ts';
import { knowledge } from './knowledge.ts';
import { MONITOR_INTERVAL_MS, startMonitor } from './monitor.ts';
import type { Nowcast } from './nowcast.ts';

const app = new Hono().basePath('/api');

app.get('/health', (c) => c.json({ ok: true, modelApiKeyConfigured: env.aiChat.some((p) => p.apiKey !== '') }));

app.get('/knowledge', (c) => c.json(knowledge));

const ai = withDailyCap(createAi({ chat: env.aiChat, transcriber: env.aiTranscriber, mock: env.aiMock }), env.aiDailyCap);
const chain = env.aiChat.filter((p) => p.apiKey).map((p) => p.name).join(' → ');
console.log(`AI mode: ${ai.mode}${ai.mode === 'meta' ? ` (${chain}${env.aiTranscriber.apiKey ? ', voice: meta' : ', no voice'}${env.aiDailyCap ? `, cap ${env.aiDailyCap}/day` : ''})` : ''}`);
app.route('/', createApi(repo(openDb()), { ai, saveCapture: captureStore() }));

// Routes must all be registered before the first request, which the monitor makes.
app.get('/monitor', (c) => c.json({ intervalMs: MONITOR_INTERVAL_MS, ...monitor.status }));

const monitor = startMonitor(
  async () => (await (await app.request('/api/nowcast')).json()) as { ponds: Nowcast[] },
  (change) => console.log(`risk up: pond ${change.pondId} ${change.from} → ${change.to}: ${change.reasons.join('; ')}`),
);

serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info) => {
  console.log(`synteel server listening on http://${env.host ?? 'localhost'}:${info.port}`);
});
