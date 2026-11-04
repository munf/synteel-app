import assert from 'node:assert/strict';
import { test } from 'node:test';
import { server } from './helpers.ts';
import { deviceLabel } from '../src/useragent.ts';

const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const LAPTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';

test('Perangkat yang masuk: list the signed-in phones, sign one out, then all others', async () => {
  const s = server();
  const phone = s.client({ 'user-agent': PHONE_UA });
  await phone('POST', '/auth/register', { name: 'Bu Sumarni', phone: '081234564471', pin: '246810' });
  const laptop = s.client({ 'user-agent': LAPTOP_UA });
  await laptop('POST', '/auth/login', { phone: '081234564471', pin: '246810' });
  const third = s.client();
  await third('POST', '/auth/login', { phone: '081234564471', pin: '246810' });

  const list = (await phone('GET', '/auth/sessions')).json.sessions as { id: string; device: string | null; current: boolean }[];
  assert.equal(list.length, 3);
  assert.deepEqual(list.filter((x) => x.current).map((x) => x.device), ['Chrome · Android 14']);
  assert.ok(list.some((x) => x.device === 'Edge · Windows'));
  assert.ok(list.every((x) => x.id.length === 16), 'only a short id leaves the server, never the token or its full hash');

  // The phone in use cannot end itself here (that is Keluar); another one can be ended once.
  const me = list.find((x) => x.current)!;
  assert.equal((await phone('DELETE', `/auth/sessions/${me.id}`)).status, 400);
  const lap = list.find((x) => x.device === 'Edge · Windows')!;
  assert.equal((await phone('DELETE', `/auth/sessions/${lap.id}`)).status, 204);
  assert.equal((await laptop('GET', '/auth/me')).status, 401);
  assert.equal((await phone('DELETE', `/auth/sessions/${lap.id}`)).status, 404);

  // "Keluar dari perangkat lain" ends the rest and keeps this phone signed in.
  assert.deepEqual((await phone('POST', '/auth/sessions/others')).json, { ended: 1 });
  assert.equal((await third('GET', '/auth/me')).status, 401);
  assert.equal((await phone('GET', '/auth/me')).status, 200);
  assert.equal((await phone('GET', '/auth/sessions')).json.sessions.length, 1);
});

test("Perangkat yang masuk: someone else's session id does nothing", async () => {
  const s = server();
  const a = s.client();
  await a('POST', '/auth/register', { name: 'Bu Sumarni', phone: '081234564471', pin: '246810' });
  const b = s.client();
  await b('POST', '/auth/register', { name: 'Pak Joko', phone: '082222222222', pin: '135790' });
  const bId = (await b('GET', '/auth/sessions')).json.sessions[0].id;
  assert.equal((await a('DELETE', `/auth/sessions/${bId}`)).status, 404);
  assert.equal((await b('GET', '/auth/me')).status, 200);
});

test('device label: browser and system only', () => {
  assert.equal(deviceLabel(PHONE_UA), 'Chrome · Android 14');
  assert.equal(deviceLabel('Mozilla/5.0 (Linux; Android 12; SM-A525F) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36'), 'Samsung Internet · Android 12');
  assert.equal(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'), 'Safari · iPhone iOS 17');
  assert.equal(deviceLabel(undefined), null);
});
