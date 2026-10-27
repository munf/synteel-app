import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createAi } from './ai.ts';
import { createApi } from './api.ts';
import { captureStore } from './captures.ts';
import { openDb, repo } from './db.ts';
import { env } from './env.ts';
import { knowledge } from './knowledge.ts';
import { MONITOR_INTERVAL_MS, startMonitor } from './monitor.ts';
import type { Nowcast } from './nowcast.ts';

const app = new Hono().basePath('/api');

app.get('/health', (c) => c.json({ ok: true, modelApiKeyConfigured: env.modelApiKey !== '' }));

app.get('/knowledge', (c) => c.json(knowledge));

const ai = createAi({ apiKey: env.modelApiKey, base: env.modelApiBase, mock: env.aiMock });
console.log(`AI mode: ${ai.mode}`);
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
