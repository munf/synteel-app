// "Dengarkan" (spoken.ts): the rewrite keeps the screen's facts, or the screen's text is read as given.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardSpoken, spokenWriter } from '../src/spoken.ts';
import { farmWithWorker } from './helpers.ts';

const screen = 'Waspada sedang. Alasannya: air hangat, sisa pakan banyak. Kolam B diperkirakan 29,8 °C malam ini. Cek berikutnya jam 21.00: cek sidat di permukaan, Kolam B.';

test('a spoken rewrite with the same facts is used', () => {
  const said = 'Malam ini perlu waspada sedang. Air di Kolam B diperkirakan hangat, sekitar 29,8 °C, dan sisa pakan masih banyak. Jam 21.00 nanti, cek apakah sidat naik ke permukaan di Kolam B.';
  assert.equal(guardSpoken(screen, said), said);
});

test('a rewrite that adds a number, drops the check time, names oxygen or uses a pronoun is refused', () => {
  assert.equal(guardSpoken(screen, 'Kolam B sekitar 31 °C malam ini. Jam 21.00 cek sidat di permukaan, Kolam B.'), null, 'new number');
  assert.equal(guardSpoken(screen, 'Kolam B diperkirakan 29,8 °C malam ini. Nanti cek sidat di permukaan di Kolam B.'), null, 'check time dropped');
  assert.equal(guardSpoken(screen, 'Kolam B 29,8 °C dan oksigen rendah. Jam 21.00 cek sidat di permukaan, Kolam B.'), null, 'oxygen');
  assert.equal(guardSpoken(screen, 'Kamu perlu cek Kolam B yang 29,8 °C pada jam 21.00 nanti, lihat sidat di permukaan.'), null, 'pronoun');
  assert.equal(guardSpoken(screen, 'Beri obat di Kolam B 29,8 °C jam 21.00, sidat di permukaan perlu diobati.'), null, 'treatment');
});

test('without a model the screen text comes back as given; the writer falls back on a refused answer', async () => {
  const { owner } = await farmWithWorker();
  assert.deepEqual((await owner('POST', '/briefing/spoken', { text: screen })).json, { text: screen, source: 'rules' });

  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ text: 'Kolam B 35 °C, jam 21.00 cek Kolam B ya.' }) } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const write = spokenWriter([{ name: 'meta', apiKey: 'k', base: 'http://model', model: 'muse-spark-1.3' }]);
    assert.deepEqual(await write(screen), { text: screen, source: 'rules' });
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
