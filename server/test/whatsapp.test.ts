import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withLang } from '../src/i18n.ts';
import {
  alarmMessage,
  blockedReason,
  cloudProvider,
  linkProvider,
  mockProvider,
  nightPlanMessage,
  pickProvider,
  stepsMessage,
  whatsappConfig,
  WA_CONSENT_VERSION,
  type WaSettings,
} from '../src/whatsapp.ts';
import { farmWithWorker } from './helpers.ts';

const TZ = 'Asia/Jakarta';
// 28 Oct 2026, 21.00 and 01.00 WIB.
const at21 = Date.parse('2026-10-28T14:00:00Z');
const at01 = Date.parse('2026-10-28T18:00:00Z');

// ---------- Message builders ----------

test('night plan: checks grouped by time, alarms marked, short, in the farmer language', () => {
  const checks = [
    { pondName: 'Kolam A', t: at21, alarm: false },
    { pondName: 'Kolam B', t: at21, alarm: false },
    { pondName: 'Kolam B', t: at01, alarm: true },
  ];
  const id = withLang('id', () => nightPlanMessage({ farmName: 'Tambak Mitra', checks, timezone: TZ }));
  assert.equal(id.kind, 'night');
  assert.equal(id.text, ['Synteel · Rencana cek malam ini, Tambak Mitra', '21.00 Kolam A, Kolam B', '01.00 Kolam B (alarm)', 'Alarm di HP tetap berbunyi seperti biasa.'].join('\n'));
  assert.deepEqual(id.params, ['Tambak Mitra', '21.00 Kolam A, Kolam B; 01.00 Kolam B (alarm)']);
  const en = withLang('en', () => nightPlanMessage({ farmName: 'Tambak Mitra', checks, timezone: TZ }));
  assert.match(en.text, /^Synteel · Tonight's check plan, Tambak Mitra\n21:00 Kolam A, Kolam B\n01:00 Kolam B \(alarm\)/);
  assert.equal(en.lang, 'en');
  // Template parameters are one line each, as Meta requires.
  for (const p of [...id.params, ...en.params]) assert.doesNotMatch(p, /\n/);
  // Nothing scheduled: said so, not an empty message.
  assert.match(withLang('id', () => nightPlanMessage({ farmName: 'X', checks: [], timezone: TZ })).text, /Tidak ada cek terjadwal/);
});

test('alarm summary: the rules reasons, and the phone alarm named as the main signal', () => {
  const m = withLang('id', () => alarmMessage({ pondName: 'Kolam B', at: at01, timezone: TZ, reasons: ['air hangat', 'sidat di permukaan'] }));
  assert.equal(m.text, 'Synteel · Tanda bahaya di Kolam B, 01.00\nAir hangat; sidat di permukaan.\nCek kolam sekarang. Alarm di HP tetap yang utama.');
  assert.deepEqual(m.params, ['Kolam B', '01.00', 'air hangat; sidat di permukaan']);
  assert.match(withLang('en', () => alarmMessage({ pondName: 'Kolam B', at: at01, timezone: TZ, reasons: [] })).text, /The alarm on the phone comes first/);
});

test('steps: numbered, with what was seen; a value held back as "Cek manual" never goes out', () => {
  const m = withLang('id', () =>
    stepsMessage({
      pondName: 'Kolam B',
      at: at21,
      timezone: TZ,
      seen: ['sidat mati'],
      facts: [
        { field: 'temperature', value: 29.5 },
        { field: 'ph', value: 9.9, held: true },
        { field: 'mortality', value: 37, held: true },
      ],
      steps: ['Cek aerator, batu aerasi dan selang udara', 'Jangan beri pakan dulu sampai sidat berenang normal'],
    }),
  );
  assert.equal(
    m.text,
    ['Synteel · Langkah untuk Kolam B, 21.00', 'Terlihat: sidat mati', 'Catatan terakhir: suhu 29,5 °C', '1. Cek aerator, batu aerasi dan selang udara', '2. Jangan beri pakan dulu sampai sidat berenang normal'].join('\n'),
  );
  for (const out of [m.text, ...m.params]) {
    assert.doesNotMatch(out, /9,9|9\.9|37/);
  }
  assert.equal(m.params[2], '1) Cek aerator, batu aerasi dan selang udara; 2) Jangan beri pakan dulu sampai sidat berenang normal');
  // A count the farmer entered goes in.
  const counted = withLang('en', () => stepsMessage({ pondName: 'Kolam B', at: at21, timezone: TZ, seen: ['dead eels'], facts: [{ field: 'mortality', value: 6 }], steps: ['Check the aerator'] }));
  assert.match(counted.text, /Seen: dead eels \(6\)/);
});

// ---------- Providers ----------

test('provider choice: Cloud API only with token and phone number id, the mock on request, else the link', () => {
  assert.equal(pickProvider({}).channel, 'link');
  assert.equal(pickProvider({}).push, false);
  assert.equal(pickProvider({ WHATSAPP_TOKEN: 't' }).channel, 'link');
  assert.equal(pickProvider({ SYNTEEL_WHATSAPP_MOCK: '1' }).channel, 'mock');
  const cloud = pickProvider({ WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '123', SYNTEEL_WHATSAPP_MOCK: '1' });
  assert.equal(cloud.channel, 'cloud');
  assert.equal(cloud.push, true);
  const cfg = whatsappConfig({ WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '123', WHATSAPP_TEMPLATE_STEPS: 'synteel_langkah', WHATSAPP_TEMPLATE_NIGHT: ' ' })!;
  assert.deepEqual(cfg.templates, { steps: 'synteel_langkah' });
  assert.equal(cfg.version, 'v23.0');
  assert.equal(whatsappConfig({ WHATSAPP_PHONE_NUMBER_ID: '123' }), null);
});

test('cloud provider: an approved template outside the 24-hour window, free text without one; errors keep no message', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  let answer: Response = Response.json({ messages: [{ id: 'wamid.1' }] });
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return answer;
  }) as unknown as typeof fetch;
  const cfg = whatsappConfig({ WHATSAPP_TOKEN: 'secret', WHATSAPP_PHONE_NUMBER_ID: '555', WHATSAPP_TEMPLATE_STEPS: 'synteel_langkah', WHATSAPP_TEMPLATE_CODE: 'synteel_kode' })!;
  const p = cloudProvider(cfg, fakeFetch);
  const msg = withLang('id', () => stepsMessage({ pondName: 'Kolam B', at: at21, timezone: TZ, seen: [], facts: [], steps: ['Cek aerator'] }));
  const sent = await p.send('6281234567890', msg);
  assert.deepEqual(sent, { status: 'sent', template: 'synteel_langkah', id: 'wamid.1' });
  assert.equal(calls[0].url, 'https://graph.facebook.com/v23.0/555/messages');
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer secret');
  const body = JSON.parse(calls[0].init.body as string);
  assert.equal(body.type, 'template');
  assert.deepEqual(body.template.language, { code: 'id' });
  assert.deepEqual(body.template.components[0].parameters.map((x: { text: string }) => x.text), ['Kolam B', '21.00', '1) Cek aerator']);
  // No template for the night plan: free text, which WhatsApp only takes inside the 24-hour window.
  await p.send('6281234567890', withLang('id', () => nightPlanMessage({ farmName: 'X', checks: [], timezone: TZ })));
  assert.equal(JSON.parse(calls[1].init.body as string).type, 'text');
  // The code goes with the authentication template's copy-code button.
  await p.send('6281234567890', { kind: 'code', lang: 'id', text: 'Kode 123456', params: ['123456'] });
  assert.deepEqual(JSON.parse(calls[2].init.body as string).template.components[1], { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '123456' }] });
  // An API error is a status line only.
  answer = Response.json({ error: { code: 131047, message: 'Re-engagement message for 6281234567890' } }, { status: 400 });
  assert.deepEqual(await p.send('6281234567890', msg), { status: 'failed', template: 'synteel_langkah', error: 'WhatsApp API 400 (131047)' });
});

test('link provider: a wa.me link with the text, to the farmer own number or to a chat they pick', async () => {
  const msg = { kind: 'steps' as const, lang: 'id' as const, text: 'Synteel · Langkah\n1. Cek aerator', params: [] };
  assert.equal((await linkProvider().send('6281234567890', msg)).url, 'https://wa.me/6281234567890?text=Synteel%20%C2%B7%20Langkah%0A1.%20Cek%20aerator');
  assert.match((await linkProvider().send(null, msg)).url!, /^https:\/\/wa\.me\/\?text=/);
});

test('gating: the server sends only with a push channel, opt-in, current consent, a verified number and the kind chosen', () => {
  const ok: WaSettings = { phone: '6281234567890', verifiedAt: '2026-11-10T00:00:00Z', optIn: true, kinds: ['night', 'alarm', 'steps'], consentVersion: WA_CONSENT_VERSION, consentAt: 'x', lang: 'id' };
  const push = { push: true };
  assert.equal(blockedReason(ok, 'alarm', push), null);
  assert.equal(blockedReason(ok, 'alarm', { push: false }), 'no_push');
  assert.equal(blockedReason(null, 'alarm', push), 'opt_out');
  assert.equal(blockedReason({ ...ok, optIn: false }, 'alarm', push), 'opt_out');
  assert.equal(blockedReason({ ...ok, consentVersion: '2020-01-01' }, 'alarm', push), 'no_consent');
  assert.equal(blockedReason({ ...ok, phone: null }, 'alarm', push), 'no_phone');
  assert.equal(blockedReason({ ...ok, verifiedAt: null }, 'alarm', push), 'unverified');
  assert.equal(blockedReason({ ...ok, kinds: ['steps'] }, 'alarm', push), 'kind_off');
});

// ---------- Through the API ----------

const STEPS = { seen: ['sidat mati'], steps: ['Cek aerator, batu aerasi dan selang udara', 'Beri obat 5 mg per liter'], dead: 6 };

test('without the Cloud API: settings save, verification is not offered, steps open as a wa.me link and the send is recorded', async () => {
  const f = await farmWithWorker();
  const v = (await f.owner('GET', '/whatsapp')).json;
  assert.deepEqual([v.channel, v.push, v.phone, v.optIn, v.consented], ['link', false, null, false, false]);
  // Turning it on needs a number and the consent.
  assert.equal((await f.owner('PUT', '/whatsapp', { optIn: true })).status, 400);
  assert.equal((await f.owner('PUT', '/whatsapp', { phone: '0812 3456 7890', optIn: true })).status, 400);
  const on = (await f.owner('PUT', '/whatsapp', { phone: '0812 3456 7890', optIn: true, consent: true, kinds: ['steps', 'night'] })).json;
  assert.deepEqual([on.phone, on.optIn, on.consented, on.verified, on.kinds], ['6281234567890', true, true, false, ['night', 'steps']]);
  assert.equal((await f.owner('POST', '/whatsapp/code', {})).json.code, 'wa_off');
  assert.equal((await f.owner('PUT', '/whatsapp', { kinds: ['sms'] })).status, 400);

  const res = await f.owner('POST', '/whatsapp/steps', { pondId: f.ponds[1].id, ...STEPS });
  assert.equal(res.json.status, 'link');
  assert.equal(res.json.blocked, 'no_push');
  const text = decodeURIComponent(res.json.url.split('?text=')[1]);
  assert.match(res.json.url, /^https:\/\/wa\.me\/6281234567890\?text=/);
  assert.match(text, /Langkah untuk Kolam B/);
  assert.match(text, /Terlihat: sidat mati \(6 ekor\)/);
  // A step that reads like medicine is dropped.
  assert.doesNotMatch(text, /obat/);
  // Recorded: kind, channel, status. Not the text, not the number.
  const rows = f.db.prepare('select * from wa_sends').all() as Record<string, unknown>[];
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].kind, rows[0].channel, rows[0].status, rows[0].pond_id], ['steps', 'link', 'link', f.ponds[1].id]);
  assert.doesNotMatch(JSON.stringify(rows), /aerator|6281234567890/);
});

test('with a push channel: code to the number, verified, then steps are sent by the server; opting out falls back to the link', async () => {
  const wa = mockProvider();
  const f = await farmWithWorker(undefined, { whatsapp: wa });
  await f.owner('PUT', '/whatsapp', { phone: '081234567890', optIn: true, consent: true });
  // Not verified yet: the link, not a send.
  assert.equal((await f.owner('POST', '/whatsapp/steps', { pondId: f.ponds[0].id, ...STEPS })).json.blocked, 'unverified');
  assert.equal((await f.owner('POST', '/whatsapp/code', {})).status, 200);
  const code = wa.outbox.at(-1)!.msg.params[0];
  assert.equal(wa.outbox.at(-1)!.to, '6281234567890');
  assert.equal((await f.owner('POST', '/whatsapp/verify', { code: code === '000000' ? '111111' : '000000' })).json.code, 'code_wrong');
  assert.equal((await f.owner('POST', '/whatsapp/verify', { code })).json.verified, true);
  const sent = await f.owner('POST', '/whatsapp/steps', { pondId: f.ponds[0].id, ...STEPS });
  assert.deepEqual(sent.json, { status: 'sent' });
  assert.equal(wa.outbox.at(-1)!.msg.kind, 'steps');
  // A new number is unverified again.
  assert.equal((await f.owner('PUT', '/whatsapp', { phone: '081299999999' })).json.verified, false);
  await f.owner('PUT', '/whatsapp', { phone: '081234567890' });
  await f.owner('POST', '/whatsapp/code', {});
  await f.owner('POST', '/whatsapp/verify', { code: wa.outbox.at(-1)!.msg.params[0] });
  // Opted out: nothing more goes out by itself.
  const before = wa.outbox.length;
  await f.owner('PUT', '/whatsapp', { optIn: false });
  assert.equal((await f.owner('POST', '/whatsapp/steps', { pondId: f.ponds[0].id, ...STEPS })).json.status, 'link');
  assert.equal(wa.outbox.length, before);
  // Profil lists the last sends.
  const kinds = (await f.owner('GET', '/whatsapp')).json.sends.map((s: { kind: string; status: string }) => `${s.kind}:${s.status}`);
  assert.deepEqual(kinds.slice(0, 2), ['steps:link', 'code:sent']);
});

test('danger summary and night plan go only to farmers who chose them, once per pond per 6 hours; deleting the account removes the settings', async () => {
  const wa = mockProvider();
  // 18.00 WIB: the evening run makes the briefing.
  const f = await farmWithWorker('2026-10-28T11:00:00Z', { whatsapp: wa });
  await f.owner('PUT', '/whatsapp', { phone: '081234567890', optIn: true, consent: true, kinds: ['alarm', 'night'] });
  await f.owner('POST', '/whatsapp/code', {});
  await f.owner('POST', '/whatsapp/verify', { code: wa.outbox.at(-1)!.msg.params[0] });
  // The worker turned it on but chose only steps.
  await f.worker('PUT', '/whatsapp', { phone: '082222222222', optIn: true, consent: true, kinds: ['steps'] });
  const change = { pondId: f.ponds[1].id, at: f.now.t.getTime(), to: 'critical', reasons: ['air hangat', 'sidat di permukaan'] };
  assert.equal(await f.api.whatsappAlarm({ ...change, to: 'warning' }), 0);
  assert.equal(await f.api.whatsappAlarm(change), 1);
  assert.match(wa.outbox.at(-1)!.msg.text, /Tanda bahaya di Kolam B, 18\.00\nAir hangat; sidat di permukaan\./);
  assert.equal(await f.api.whatsappAlarm(change), 0);
  f.now.t = new Date(f.now.t.getTime() + 7 * 3600_000);
  assert.equal(await f.api.whatsappAlarm(change), 1);

  f.now.t = new Date('2026-10-28T11:00:00Z');
  const n = wa.outbox.length;
  await f.api.briefFarms();
  assert.equal(wa.outbox.length, n + 1);
  assert.equal(wa.outbox.at(-1)!.msg.kind, 'night');
  assert.match(wa.outbox.at(-1)!.msg.text, /^Synteel · Rencana cek malam ini, Tambak Sidat Mitra/);

  assert.equal((await f.owner('POST', '/auth/delete', { pin: '246810' })).status, 204);
  assert.equal(f.db.prepare('select count(*) n from wa_settings where phone = ?').get('6281234567890')!.n, 0);
  assert.equal((f.db.prepare('select count(*) n from wa_sends where kind = ?').get('alarm') as { n: number }).n, 0);
});
