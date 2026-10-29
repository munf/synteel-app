import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApi } from '../src/api.ts';
import { openDb, repo } from '../src/db.ts';
import { normalizeCode, simulate } from '../src/devices.ts';

test('a stopped blower: oxygen falls into Danger, the backup valve opens, oxygen recovers', () => {
  const at = Date.parse('2026-10-29T10:00:00Z');
  const d = (min: number) => simulate({ scenario: 'blower_fail', scenarioAt: at }, at + min * 60_000);
  assert.ok(d(0).units.tank1.do > 6.9);
  assert.equal(d(3).oxygenValve, false);
  const low = Math.min(...Array.from({ length: 20 }, (_, m) => d(m).units.tank1.do));
  assert.ok(low < 4, `lowest ${low} should be below 4 mg/L (Danger)`);
  assert.equal(d(10).oxygenValve, true);
  assert.ok(d(30).units.tank1.do >= 6, 'recovered by minute 30');
  assert.equal(d(5).blower, false);
});

test('codes are typed by hand: spaces, case and dashes do not matter', () => {
  assert.equal(normalizeCode('g5 7kq2m4'), 'G5-7KQ2-M4');
  assert.equal(normalizeCode('G5-7KQ2-M4'), 'G5-7KQ2-M4');
});

test('simulator device: create, link in the app as new simulation ponds, readings arrive as sensor logs', async () => {
  let now = Date.parse('2026-10-29T03:00:00Z');
  const store = repo(openDb(':memory:'));
  const api = createApi(store, { clock: () => new Date(now), getWeather: async () => ({ hours: [], fetchedAt: 0 }), geocode: async () => null });
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await api.request(path, {
      method,
      headers: { ...(body !== undefined && { 'content-type': 'application/json' }), ...(cookie && { cookie }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, json: res.status === 204 ? null : await res.json() };
  };

  // The simulator page needs no account.
  const made = await call('POST', '/sim/devices', { kind: 'gen5' });
  assert.equal(made.status, 201);
  const code: string = made.json.device.code;
  assert.match(code, /^G5-[A-Z2-9]{4}-[A-Z2-9]{2}$/);
  assert.equal(made.json.device.units.length, 2);

  await call('POST', '/auth/register', { name: 'Pak Joko', phone: '0812 3456 7890', pin: '246810' });
  await call('PUT', '/farm', { name: 'T' });
  const real = (await call('POST', '/ponds', { name: 'Kolam A' })).json.pond;

  const seen = await call('GET', `/devices/${code.toLowerCase().replace(/-/g, ' ')}`);
  assert.equal(seen.json.device.name, 'Synteel Nursery Gen5');
  assert.equal(seen.json.device.linkedHere, false);

  const linked = await call('POST', `/devices/${code}/link`);
  assert.equal(linked.status, 201);
  assert.deepEqual(linked.json.ponds.map((p: { name: string }) => p.name), ['Gen5 Tangki 1', 'Gen5 Tangki 2']);
  assert.ok(linked.json.ponds.every((p: { simulated: boolean; device: { code: string } }) => p.simulated && p.device.code === code));
  // The first readings are there at once, and the real pond is untouched.
  const farm = (await call('GET', '/farm')).json;
  const sim = farm.ponds.find((p: { name: string }) => p.name === 'Gen5 Tangki 1');
  assert.equal(sim.latest.do.value > 6, true);
  assert.equal(farm.ponds.find((p: { id: number }) => p.id === real.id).simulated, false);

  // Power cut on the simulator page: a few minutes later the pond is in Danger from low oxygen.
  await call('POST', `/sim/devices/${code}/scenario`, { scenario: 'power_cut' });
  for (let m = 1; m <= 8; m++) {
    now += 60_000;
    api.sendDeviceLogs();
  }
  const after = (await call('GET', `/ponds/${sim.id}`)).json.pond;
  assert.equal(after.level, 'critical');
  assert.ok(after.latest.do.value < 4);
  assert.ok(after.findings.some((f: { id: string }) => f.id === 'threshold:do'));

  // Another farm cannot take it; unlinking removes the simulation ponds.
  assert.equal((await call('POST', `/devices/${code}/unlink`)).status, 204);
  assert.equal((await call('GET', '/farm')).json.ponds.length, 1);
});
