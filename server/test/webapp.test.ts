// Self-hosting (webapp.ts): the API and the built app from one process, as in the Docker image.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Hono } from 'hono';
import { withWebApp } from '../src/webapp.ts';

function built() {
  const dir = mkdtempSync(join(tmpdir(), 'synteel-web-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Synteel</title>');
  mkdirSync(join(dir, 'replay'));
  writeFileSync(join(dir, 'replay', 'index.html'), '<!doctype html><title>Replay</title>');
  writeFileSync(join(dir, 'sw.js'), 'self.addEventListener("install", () => {});');
  return dir;
}

const api = new Hono().basePath('/api');
api.get('/health', (c) => c.json({ ok: true }));

test('/api goes to the server, the rest are files from the build', async () => {
  const site = withWebApp(api, built());
  const health = await site.request('/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  const index = await site.request('/');
  assert.equal(index.status, 200);
  assert.match(await index.text(), /<title>Synteel</);
  assert.match(await (await site.request('/replay/')).text(), /<title>Replay</);
  assert.match((await site.request('/sw.js')).headers.get('content-type') ?? '', /javascript/);
});

test('a missing file or API route is a 404, never the app page', async () => {
  const site = withWebApp(api, built());
  assert.equal((await site.request('/assets/missing.js')).status, 404);
  assert.equal((await site.request('/api/nothing')).status, 404);
  assert.equal((await site.request('/../package.json')).status, 404);
});
