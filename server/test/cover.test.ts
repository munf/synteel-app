// The pond photo kept as the pond's cover picture: saved only with Simpan, owners only, served only to
// members of the pond's farm, replaced and removed, and deleted with an expired demo farm.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { coverStore, removeFarmCaptures } from '../src/captures.ts';
import { farmWithWorker, server } from './helpers.ts';

const H = 3600_000;
const jpeg = (fill: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array(60).fill(fill), 0xff, 0xd9]);
const form = (bytes: Uint8Array, type = 'image/jpeg') => {
  const f = new FormData();
  f.append('image', new Blob([bytes], { type }), 'cover.jpg');
  return f;
};
const tempDir = () => mkdtempSync(join(tmpdir(), 'synteel-cover-'));

test('owner saves the pond photo as cover; members see it, others and workers cannot change or see it', async () => {
  const dir = tempDir();
  const f = await farmWithWorker(undefined, { covers: coverStore(dir) });
  const pond = f.ponds[0];
  // Nothing is kept until the farmer saves: a new pond has no cover.
  assert.equal((await f.owner('GET', `/ponds/${pond.id}`)).json.pond.cover, null);
  assert.equal((await f.owner('GET', `/ponds/${pond.id}/cover`)).status, 404);

  assert.equal((await f.worker('POST', `/ponds/${pond.id}/cover`, form(jpeg(1)))).status, 403);
  assert.equal((await f.owner('POST', `/ponds/${pond.id}/cover`, form(new TextEncoder().encode('<svg/>'), 'image/svg+xml'))).status, 400);
  assert.equal((await f.owner('POST', `/ponds/${pond.id}/cover`, new FormData())).status, 400);

  const saved = await f.owner('POST', `/ponds/${pond.id}/cover`, form(jpeg(1)));
  assert.equal(saved.status, 200);
  const key = saved.json.pond.cover as string;
  assert.match(key, new RegExp(`-farm\\d+-pond${pond.id}-cover-`));
  assert.equal((await f.worker('GET', '/farm')).json.ponds.find((p: { id: number }) => p.id === pond.id).cover, key);

  // A worker of the farm sees the picture; it is a JPEG and kept private.
  const res = await f.worker.raw(`/ponds/${pond.id}/cover?v=${key}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.match(res.headers.get('cache-control') ?? '', /private/);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), jpeg(1));

  // Someone from another farm, and nobody signed in, get nothing.
  const stranger = f.client();
  await stranger('POST', '/auth/register', { name: 'Orang Lain', phone: '083333333333', pin: '864213' });
  await stranger('PUT', '/farm', { name: 'Tambak Lain' });
  assert.equal((await stranger('GET', `/ponds/${pond.id}/cover`)).status, 404);
  assert.equal((await f.api.request(`/ponds/${pond.id}/cover`)).status, 401);

  // Saving the profile again keeps the cover.
  await f.owner('PUT', `/ponds/${pond.id}`, { place: 'indoor', waterColor: 'clear' });
  assert.equal((await f.owner('GET', `/ponds/${pond.id}`)).json.pond.cover, key);
});

test('a new pond photo replaces the cover; removing it brings back the pond icon', async () => {
  const dir = tempDir();
  const f = await farmWithWorker(undefined, { covers: coverStore(dir) });
  const pond = f.ponds[1];
  const first = (await f.owner('POST', `/ponds/${pond.id}/cover`, form(jpeg(1)))).json.pond.cover as string;
  const second = (await f.owner('POST', `/ponds/${pond.id}/cover`, form(jpeg(2)))).json.pond.cover as string;
  assert.notEqual(first, second);
  assert.deepEqual(readdirSync(dir), [second], 'the old picture is deleted');
  const shown = await f.owner.raw(`/ponds/${pond.id}/cover`);
  assert.deepEqual(new Uint8Array(await shown.arrayBuffer()), jpeg(2));

  assert.equal((await f.worker('DELETE', `/ponds/${pond.id}/cover`)).status, 403);
  const removed = await f.owner('DELETE', `/ponds/${pond.id}/cover`);
  assert.equal(removed.json.pond.cover, null);
  assert.deepEqual(readdirSync(dir), []);
  assert.equal((await f.owner('GET', `/ponds/${pond.id}/cover`)).status, 404);
});

test('without a cover store the server says so instead of losing the photo', async () => {
  const f = await farmWithWorker();
  const res = await f.owner('POST', `/ponds/${f.ponds[0].id}/cover`, form(jpeg(1)));
  assert.equal(res.status, 400);
  assert.equal((await f.owner('GET', `/ponds/${f.ponds[0].id}`)).json.pond.cover, null);
});

test('cover keys cannot point outside the captures folder', () => {
  const dir = tempDir();
  const covers = coverStore(dir);
  assert.equal(covers.read('../../etc/passwd'), null);
  assert.equal(covers.read('2026-10-28T03-00-00-000Z-farm1-pond1-cover-zzzzzzzz'), null);
  covers.remove('..');
  assert.ok(existsSync(dir));
});

test('an expired demo farm takes its pond covers with it; other farms keep theirs', async () => {
  const dir = tempDir();
  const BUILT = '2026-10-28T10:30:00Z';
  const s = server(BUILT, { demoPhone: '620000000000', covers: coverStore(dir), removeFarmFiles: (id) => removeFarmCaptures(id, dir) });
  await s.api.buildDemoTemplate();
  const visitor = s.client();
  const me = (await visitor('POST', '/auth/demo')).json;
  const pond = (await visitor('GET', '/farm')).json.ponds[0];
  assert.equal(pond.cover, null, 'the copy starts with the pond icons');
  assert.equal((await visitor('POST', `/ponds/${pond.id}/cover`, form(jpeg(3)))).status, 200);

  const owner = s.client();
  await owner('POST', '/auth/register', { name: 'Petani', phone: '081111111111', pin: '246810' });
  await owner('PUT', '/farm', { name: 'Tambak Asli' });
  const own = (await owner('POST', '/ponds', { name: 'Kolam A' })).json.pond;
  await owner('POST', `/ponds/${own.id}/cover`, form(jpeg(4)));
  assert.equal(readdirSync(dir).length, 2);

  s.now.t = new Date(Date.parse(BUILT) + 48 * H + 60_000);
  assert.equal(s.api.expireDemos(), 1);
  const left = readdirSync(dir);
  assert.equal(left.length, 1);
  assert.doesNotMatch(left[0], new RegExp(`-farm${me.farm.id}-`));
  assert.equal((await owner.raw(`/ponds/${own.id}/cover`)).status, 200);
});

test('an existing database gains the cover column; old ponds keep the icon', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { openDb } = await import('../src/db.ts');
  const path = join(tempDir(), 'old.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`create table ponds (id integer primary key, name text not null, kind text, volume_l real, area_m2 real, setting text, shaded integer, aeration text, depth_cm real, archived integer not null default 0);
    insert into ponds (id, name) values (1, 'Kolam Lama');`);
  old.close();
  const db = openDb(path);
  const cols = (db.prepare('pragma table_info(ponds)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes('cover_photo'));
  assert.deepEqual({ ...(db.prepare('select name, cover_photo from ponds where id = 1').get() as object) }, { name: 'Kolam Lama', cover_photo: null });
});
