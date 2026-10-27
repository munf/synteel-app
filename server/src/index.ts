import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { env } from './env.ts';
import { knowledge } from './knowledge.ts';

const app = new Hono().basePath('/api');

app.get('/health', (c) => c.json({ ok: true, modelApiKeyConfigured: env.modelApiKey !== '' }));

app.get('/knowledge', (c) => c.json(knowledge));

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`synteel server listening on http://localhost:${info.port}`);
});
