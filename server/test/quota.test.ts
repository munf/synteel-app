import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toDraft, withDailyCap, type Ai } from '../src/ai.ts';
import type { RoundResult } from '../src/contract.ts';
import { farmWithWorker } from './helpers.ts';

const roundResult = (transcript: string): RoundResult => ({ transcript, drafts: [], loose: null, empty: false, model: 'test', mode: 'meta' });

/** A pretend real AI that remembers what each round was given. */
function fakeAi(mode: Ai['mode'] = 'meta') {
  const rounds: Parameters<Ai['round']>[0][] = [];
  const ai: Ai = {
    mode,
    draft: async () => toDraft({ temperature: 27 }, 'meta'),
    round: async (input) => {
      rounds.push(input);
      return roundResult(input.transcript ?? 'audio');
    },
  };
  return { ai, rounds };
}

const photo = () => {
  const f = new FormData();
  f.append('kind', 'photo');
  f.append('image', new Blob(['x'], { type: 'image/jpeg' }), 'a.jpg');
  return f;
};

test('without a farm cap the quota is unlimited, and each member’s reads are still counted', async () => {
  const { ai } = fakeAi('mock');
  const { owner, worker, ponds } = await farmWithWorker('2026-10-28T03:00:00Z', { ai });
  await worker('POST', `/ponds/${ponds[0].id}/capture`, photo());
  await worker('POST', '/round/text', { transcript: 'Kolam A suhu 28' });
  const q = (await owner('GET', '/quota')).json;
  assert.equal(q.unlimited, true);
  assert.equal(q.used, 2);
  assert.deepEqual(
    q.members.map((m: { name: string; role: string; used: number }) => [m.name, m.role, m.used]),
    [['Petani Demo', 'owner', 0], ['Pak Joko', 'worker', 2]],
  );
  // Next local midnight in Jakarta (UTC+7).
  assert.equal(q.resetsAt, '2026-10-28T17:00:00.000Z');
});

test('the farm cap is shared; a photo and a video today earn +2; quota out is 429 ai_quota', async () => {
  const { ai } = fakeAi();
  const { owner, worker, ponds } = await farmWithWorker('2026-10-28T03:00:00Z', { ai, farmAiCap: 2 });
  const pond = ponds[0].id;
  assert.equal((await owner('POST', `/ponds/${pond}/capture`, photo())).status, 200);
  assert.equal((await worker('POST', `/ponds/${pond}/capture`, photo())).status, 200);
  const out = await worker('POST', '/round/text', { transcript: 'Kolam A suhu 28' });
  assert.equal(out.status, 429);
  assert.equal(out.json.code, 'ai_quota');
  assert.match(out.json.error, /Jatah baca AI/);

  let q = (await owner('GET', '/quota')).json;
  assert.deepEqual([q.cap, q.base, q.bonus, q.used, q.left, q.unlimited], [2, 2, 0, 2, 0, false]);
  assert.deepEqual(q.earn.photoVideo, { photo: false, video: false, bonus: 2, earned: false });

  await worker('POST', `/ponds/${pond}/logs`, { readings: { ph: 7.3 }, source: 'photo' });
  assert.equal((await owner('GET', '/quota')).json.earn.photoVideo.earned, false);
  await owner('POST', `/ponds/${pond}/logs`, { behavior: ['normal'], source: 'video' });
  q = (await owner('GET', '/quota')).json;
  assert.deepEqual([q.cap, q.bonus, q.left], [4, 2, 2]);
  assert.equal(q.earn.photoVideo.earned, true);
  assert.equal((await worker('POST', `/ponds/${pond}/capture`, photo())).status, 200);

  // A new local day starts from zero.
  const next = await farmWithWorker('2026-10-28T18:00:00Z', { ai, farmAiCap: 2 });
  assert.equal((await next.owner('GET', '/quota')).json.used, 0);
});

test('every 7th day in a row earns +10 on that day', async () => {
  const { owner, ponds } = await farmWithWorker('2026-10-28T03:00:00Z', { ai: fakeAi().ai, farmAiCap: 5 });
  for (let d = 6; d >= 1; d--) {
    await owner('POST', `/ponds/${ponds[0].id}/logs`, { readings: { temperature: 28 }, loggedAt: new Date(Date.parse('2026-10-28T02:00:00Z') - d * 86400_000).toISOString() });
  }
  let q = (await owner('GET', '/quota')).json;
  assert.deepEqual(q.earn.streak, { days: 6, nextAt: 7, bonus: 10 });
  assert.equal(q.bonus, 0);
  await owner('POST', `/ponds/${ponds[0].id}/logs`, { readings: { temperature: 28 } });
  q = (await owner('GET', '/quota')).json;
  assert.deepEqual(q.earn.streak, { days: 7, nextAt: 14, bonus: 10 });
  assert.equal(q.bonus, 10);
  assert.equal(q.cap, 15);
});

test('voice round: the farm’s ponds with their other names go to the AI; the recording is kept', async () => {
  const { ai, rounds } = fakeAi();
  const saved: Record<string, unknown>[] = [];
  const { owner, worker, ponds } = await farmWithWorker(undefined, {
    ai,
    saveCapture: async (meta, files) => {
      saved.push({ ...meta, files: files.map((f) => f.name) });
    },
  });
  await owner('POST', `/ponds/${ponds[1].id}/nicknames`, { nickname: 'kolam dekat pintu' });

  const res = await worker('POST', '/round/text', { transcript: 'Kolam dekat pintu suhu 29' });
  assert.equal(res.status, 200);
  assert.equal(res.json.round.transcript, 'Kolam dekat pintu suhu 29');
  assert.deepEqual(rounds[0].ponds, [
    { id: ponds[0].id, name: 'Kolam A', nicknames: [] },
    { id: ponds[1].id, name: 'Kolam B', nicknames: ['kolam dekat pintu'] },
    { id: ponds[2].id, name: 'Kolam C', nicknames: [] },
  ]);

  const form = new FormData();
  form.append('audio', new Blob(['fake'], { type: 'audio/webm' }), 'round.webm');
  assert.equal((await worker('POST', '/round', form)).status, 200);
  assert.ok(rounds[1].audio instanceof Blob);
  assert.equal(saved[1].kind, 'round');
  assert.deepEqual(saved[1].files, ['audio.webm']);
  assert.equal((await owner('GET', '/quota')).json.used, 2);

  assert.equal((await worker('POST', '/round', new FormData())).status, 400);
  assert.equal((await worker('POST', '/round/text', { transcript: ' ' })).status, 400);
  assert.equal((await worker('POST', '/round/text', { transcript: 'x'.repeat(5001) })).status, 400);
});

test('voice round without AI is 503 ai_unavailable; the server-wide demo cap is 429 ai_quota', async () => {
  const off = await farmWithWorker();
  const res = await off.worker('POST', '/round/text', { transcript: 'Kolam A suhu 28' });
  assert.equal(res.status, 503);
  assert.equal(res.json.code, 'ai_unavailable');

  const capped = await farmWithWorker(undefined, { ai: withDailyCap(fakeAi().ai, 1) });
  assert.equal((await capped.worker('POST', '/round/text', { transcript: 'Kolam A suhu 28' })).status, 200);
  const out = await capped.worker('POST', '/round/text', { transcript: 'Kolam A suhu 28' });
  assert.equal(out.status, 429);
  assert.equal(out.json.code, 'ai_quota');
});
