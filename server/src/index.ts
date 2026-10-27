import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createApi } from './api.ts';
import { openDb, repo } from './db.ts';
import { env } from './env.ts';
import { knowledge } from './knowledge.ts';

const app = new Hono().basePath('/api');

app.get('/health', (c) => c.json({ ok: true, modelApiKeyConfigured: env.modelApiKey !== '' }));

app.get('/knowledge', (c) => c.json(knowledge));

app.route('/', createApi(repo(openDb())));

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`synteel server listening on http://localhost:${info.port}`);
});
