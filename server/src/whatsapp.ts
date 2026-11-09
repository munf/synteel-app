// WhatsApp delivery of what the farmer should do: tonight's check plan, a danger alarm summary and the
// steps from the Problem flow, sent to the farmer's own WhatsApp number.
//
// Three providers behind one interface:
//   cloud  Meta WhatsApp Cloud API (Graph API POST /{phone-number-id}/messages). Messages the server
//          starts need a template Meta approved; free text only goes inside the 24-hour window after the
//          farmer wrote to the business number. On only when WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID
//          are set (docs/whatsapp-plan.md lists what that takes).
//   link   No account at all: a wa.me link with the text filled in, opened by the farmer's own tap.
//          It cannot send by itself, so the night plan and alarm summary are not sent with it.
//   mock   Keeps messages in memory, for tests and QA (SYNTEEL_WHATSAPP_MOCK=1).
//
// WhatsApp is an extra channel only. The night alarm on the phone stays the one that counts and works
// with no internet and no AI; nothing here sits on that path or calls a model (a test checks that).
// Messages carry only checked content: the rules' schedule and reasons, the SOP steps, readings the
// farmer saved. A value held back as "Cek manual" (verify.ts) never goes into a message.
// Every send is recorded (kind, channel, template, status), never the text or the number it went to.
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.ts';
import { currentLang, dec, tx, type Lang } from './i18n.ts';

/** What a farmer can choose to receive. */
export type WaKind = 'night' | 'alarm' | 'steps';
export const WA_KINDS: WaKind[] = ['night', 'alarm', 'steps'];
/** What the server sends: the farmer's kinds plus the verification code. */
export type WaSendKind = WaKind | 'code';
export type WaChannel = 'cloud' | 'link' | 'mock';

/**
 * The WhatsApp consent in Profil, separate from the Syarat dan Ketentuan (terms.ts). Raise it when the
 * consent text in the app changes; an older consent turns sending off until the farmer agrees again.
 */
export const WA_CONSENT_VERSION = '2026-11-10';

/** One message in the farmer's language: free text for the link and the 24-hour window, template parameters for the rest. */
export interface WaMessage {
  kind: WaSendKind;
  lang: Lang;
  text: string;
  /** Body parameters of the approved template, in order ({{1}}, {{2}}, …): one line each. */
  params: string[];
}

export interface WaResult {
  status: 'sent' | 'link' | 'failed';
  /** The template used, null for free text or a link. */
  template: string | null;
  /** WhatsApp's message id (cloud) or the mock's. */
  id?: string;
  /** wa.me link to open on the phone (link provider). */
  url?: string;
  /** Status line only, never the message. */
  error?: string;
}

export interface WaProvider {
  channel: WaChannel;
  /** Sends without the farmer's tap (night plan, alarm summary, codes). The link cannot. */
  push: boolean;
  send(to: string | null, msg: WaMessage): Promise<WaResult>;
}

// ---------- Providers ----------

export interface WaConfig {
  token: string;
  phoneNumberId: string;
  /** Graph API version, e.g. "v23.0". */
  version: string;
  /** Approved template names per message; a kind without one goes as free text (24-hour window only). */
  templates: Partial<Record<WaSendKind, string>>;
  /** Template language codes as registered with Meta. */
  langs: Record<Lang, string>;
}

/** The Cloud API settings, or null when the token or the phone number id is missing: then it stays off. */
export function whatsappConfig(e: Record<string, string | undefined> = process.env): WaConfig | null {
  if (!e.WHATSAPP_TOKEN || !e.WHATSAPP_PHONE_NUMBER_ID) return null;
  const templates: WaConfig['templates'] = {};
  for (const [kind, key] of [['night', 'NIGHT'], ['alarm', 'ALARM'], ['steps', 'STEPS'], ['code', 'CODE']] as const) {
    const name = e[`WHATSAPP_TEMPLATE_${key}`]?.trim();
    if (name) templates[kind] = name;
  }
  return {
    token: e.WHATSAPP_TOKEN,
    phoneNumberId: e.WHATSAPP_PHONE_NUMBER_ID,
    version: e.WHATSAPP_API_VERSION || 'v23.0',
    templates,
    langs: { id: e.WHATSAPP_TEMPLATE_LANG_ID || 'id', en: e.WHATSAPP_TEMPLATE_LANG_EN || 'en' },
  };
}

/** Template parameters may hold no line breaks, tabs or long runs of spaces, and must stay short. */
const param = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 300);

/** Meta WhatsApp Cloud API. `fetchFn` is replaceable so tests never reach the network. */
export function cloudProvider(cfg: WaConfig, fetchFn: typeof fetch = fetch): WaProvider {
  return {
    channel: 'cloud',
    push: true,
    async send(to, msg) {
      const template = cfg.templates[msg.kind] ?? null;
      if (!to) return { status: 'failed', template, error: 'no number' };
      if (msg.kind === 'code' && !template) return { status: 'failed', template, error: 'no code template' };
      const parameters = msg.params.map((text) => ({ type: 'text', text: param(text) }));
      const body = template
        ? {
            messaging_product: 'whatsapp',
            to,
            type: 'template',
            template: {
              name: template,
              language: { code: cfg.langs[msg.lang] },
              components: [
                { type: 'body', parameters },
                // Authentication templates carry the code a second time on their copy-code button.
                ...(msg.kind === 'code' ? [{ type: 'button', sub_type: 'url', index: '0', parameters: [parameters[0]] }] : []),
              ],
            },
          }
        : { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: msg.text, preview_url: false } };
      try {
        const res = await fetchFn(`https://graph.facebook.com/${cfg.version}/${cfg.phoneNumberId}/messages`, {
          method: 'POST',
          headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        const json = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { code?: number } };
        if (!res.ok) return { status: 'failed', template, error: `WhatsApp API ${res.status}${json.error?.code ? ` (${json.error.code})` : ''}` };
        return { status: 'sent', template, id: json.messages?.[0]?.id };
      } catch (err) {
        return { status: 'failed', template, error: (err as Error).name === 'TimeoutError' ? 'timeout' : 'network' };
      }
    },
  };
}

/** "https://wa.me/62812…?text=…": WhatsApp opens on the phone with the text filled in; no number lets the farmer pick a chat. */
export const waLink = (to: string | null, text: string) => `https://wa.me/${to ?? ''}?text=${encodeURIComponent(text)}`;

/** No account: a link the farmer opens and sends. */
export function linkProvider(): WaProvider {
  return { channel: 'link', push: false, send: async (to, msg) => ({ status: 'link', template: null, url: waLink(to, msg.text) }) };
}

/** Pretend delivery for tests and QA: keeps every message it was given. */
export function mockProvider() {
  const outbox: { to: string | null; msg: WaMessage }[] = [];
  const provider: WaProvider & { outbox: typeof outbox } = {
    channel: 'mock',
    push: true,
    outbox,
    async send(to, msg) {
      outbox.push({ to, msg });
      return { status: 'sent', template: `mock_${msg.kind}`, id: `mock-${outbox.length}` };
    },
  };
  return provider;
}

/** Cloud when its env vars are set, the mock when SYNTEEL_WHATSAPP_MOCK=1, otherwise the link. */
export function pickProvider(e: Record<string, string | undefined> = process.env, fetchFn: typeof fetch = fetch): WaProvider {
  const cfg = whatsappConfig(e);
  if (cfg) return cloudProvider(cfg, fetchFn);
  if (e.SYNTEEL_WHATSAPP_MOCK === '1') return mockProvider();
  return linkProvider();
}

// ---------- Messages ----------

/** "21.30" (id) or "21:30" (en) in the farm's time zone. */
const hm = (t: number, tz: string) => {
  const s = new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz });
  return currentLang() === 'en' ? s : s.replace(':', '.');
};

const HEAD = 'Synteel';

/** One check in tonight's plan: rule checks and the agent checks its guard kept. */
export interface PlanCheck {
  pondName: string;
  t: number;
  alarm: boolean;
}

/** Tonight's check plan: the times, which ponds, which ones ring as an alarm. */
export function nightPlanMessage(p: { farmName: string; checks: PlanCheck[]; timezone: string }): WaMessage {
  const byTime = new Map<string, { names: Set<string>; alarm: boolean; t: number }>();
  for (const c of [...p.checks].sort((a, b) => a.t - b.t)) {
    const key = hm(c.t, p.timezone);
    const slot = byTime.get(key) ?? { names: new Set(), alarm: false, t: c.t };
    slot.names.add(c.pondName);
    slot.alarm ||= c.alarm;
    byTime.set(key, slot);
  }
  const MAX = 6;
  const lines = [...byTime.entries()].slice(0, MAX).map(([time, s]) => `${time} ${[...s.names].join(', ')}${s.alarm ? ` (${tx('alarm', 'alarm')})` : ''}`);
  if (byTime.size > MAX) lines.push(tx(`dan ${byTime.size - MAX} jam cek lain`, `and ${byTime.size - MAX} more ${byTime.size - MAX === 1 ? 'check time' : 'check times'}`));
  const none = tx('Tidak ada cek terjadwal malam ini.', 'No checks are scheduled tonight.');
  const text = [
    `${HEAD} · ${tx(`Rencana cek malam ini, ${p.farmName}`, `Tonight's check plan, ${p.farmName}`)}`,
    ...(lines.length ? lines : [none]),
    tx('Alarm di HP tetap berbunyi seperti biasa.', 'The alarm on the phone still rings as usual.'),
  ].join('\n');
  return { kind: 'night', lang: currentLang(), text, params: [p.farmName, lines.length ? lines.join('; ') : none] };
}

/** A danger the fixed rules found, as a short summary. The phone alarm stays the main signal. */
export function alarmMessage(p: { pondName: string; at: number; timezone: string; reasons: string[] }): WaMessage {
  const time = hm(p.at, p.timezone);
  const reasons = p.reasons.slice(0, 3).join('; ');
  const text = [
    `${HEAD} · ${tx(`Tanda bahaya di ${p.pondName}, ${time}`, `Danger sign at ${p.pondName}, ${time}`)}`,
    ...(reasons ? [reasons.charAt(0).toUpperCase() + reasons.slice(1) + '.'] : []),
    tx('Cek kolam sekarang. Alarm di HP tetap yang utama.', 'Check the pond now. The alarm on the phone comes first.'),
  ].join('\n');
  return { kind: 'alarm', lang: currentLang(), text, params: [p.pondName, time, reasons || tx('risiko oksigen naik', 'oxygen risk rising')] };
}

/** A value for the message, with whether a check held it back ("Cek manual"): held ones are left out. */
export interface Fact {
  field: 'temperature' | 'ph' | 'tds' | 'do' | 'mortality';
  value: number;
  held?: boolean;
}

const factText = (f: Fact) => {
  switch (f.field) {
    case 'temperature':
      return tx(`suhu ${dec(f.value)} °C`, `temperature ${dec(f.value)} °C`);
    case 'ph':
      return `pH ${dec(f.value)}`;
    case 'tds':
      return `TDS ${dec(f.value, 0)} ppm`;
    case 'do':
      return tx(`oksigen ${dec(f.value)} mg/L`, `oxygen ${dec(f.value)} mg/L`);
    case 'mortality':
      return tx(`${f.value} ekor mati`, `${f.value} dead`);
  }
};

/** The Problem flow's steps for one pond, with what was seen and the last saved readings. */
export function stepsMessage(p: { pondName: string; at: number; timezone: string; seen: string[]; facts: Fact[]; steps: string[] }): WaMessage {
  const time = hm(p.at, p.timezone);
  // Only checked values: anything held back by a failed check stays out, whatever the caller passed.
  const facts = p.facts.filter((f) => !f.held && Number.isFinite(f.value));
  const dead = facts.find((f) => f.field === 'mortality');
  const readings = facts.filter((f) => f.field !== 'mortality').map(factText);
  const seen = p.seen.join(', ');
  const steps = p.steps.slice(0, 6);
  const text = [
    `${HEAD} · ${tx(`Langkah untuk ${p.pondName}, ${time}`, `Steps for ${p.pondName}, ${time}`)}`,
    ...(seen ? [`${tx('Terlihat', 'Seen')}: ${seen}${dead ? ` (${factText(dead)})` : ''}`] : []),
    ...(readings.length ? [`${tx('Catatan terakhir', 'Last records')}: ${readings.join(' · ')}`] : []),
    ...steps.map((s, i) => `${i + 1}. ${s}`),
  ].join('\n');
  return { kind: 'steps', lang: currentLang(), text, params: [p.pondName, time, steps.map((s, i) => `${i + 1}) ${s}`).join('; ')] };
}

/** The verification code, through the authentication template. */
export const codeMessage = (code: string): WaMessage => ({
  kind: 'code',
  lang: currentLang(),
  text: tx(`Kode Synteel ${code}. Jangan berikan kode ini ke orang lain.`, `Synteel code ${code}. Do not share this code.`),
  params: [code],
});

// ---------- Farmer settings, gating and the send log ----------

export interface WaSettings {
  phone: string | null;
  verifiedAt: string | null;
  optIn: boolean;
  kinds: WaKind[];
  consentVersion: string | null;
  consentAt: string | null;
  /** The language the farmer last used in the app: messages the server starts go out in it. */
  lang: Lang;
}

export type Blocked = 'no_push' | 'opt_out' | 'no_consent' | 'no_phone' | 'unverified' | 'kind_off';

/** Why this kind may not be sent to this farmer by the server, or null when it may. */
export function blockedReason(s: WaSettings | null, kind: WaKind, provider: Pick<WaProvider, 'push'>): Blocked | null {
  if (!provider.push) return 'no_push';
  if (!s?.optIn) return 'opt_out';
  if (s.consentVersion !== WA_CONSENT_VERSION) return 'no_consent';
  if (!s.phone) return 'no_phone';
  if (!s.verifiedAt) return 'unverified';
  if (!s.kinds.includes(kind)) return 'kind_off';
  return null;
}

export interface WaSendRow {
  at: string;
  kind: WaSendKind;
  channel: WaChannel;
  template: string | null;
  status: WaResult['status'];
  error: string | null;
}

type Row = Record<string, unknown>;

export function whatsappStore(db: Db) {
  db.exec(`
    -- Profil → WhatsApp: the farmer's own number, its verification, the opt-in and which messages.
    create table if not exists wa_settings (
      user_id integer primary key,
      phone text,
      verified_at text,
      opt_in integer not null default 0,
      kinds text not null default '["night","alarm","steps"]',
      consent_version text,
      consent_at text,
      lang text not null default 'id',
      updated_at text not null
    );
    -- Every send: what kind, which channel and template, and how it went. No message text, no number.
    create table if not exists wa_sends (
      id integer primary key,
      at text not null,
      user_id integer,
      farm_id integer,
      pond_id integer,
      kind text not null,
      channel text not null,
      template text,
      status text not null,
      error text,
      message_id text
    );
    create index if not exists wa_sends_user on wa_sends (user_id, at);
    create index if not exists wa_sends_pond on wa_sends (pond_id, kind, at);
  `);
  const toSettings = (r: Row): WaSettings => ({
    phone: (r.phone as string | null) ?? null,
    verifiedAt: (r.verified_at as string | null) ?? null,
    optIn: Boolean(r.opt_in),
    kinds: (JSON.parse(r.kinds as string) as WaKind[]).filter((k) => WA_KINDS.includes(k)),
    consentVersion: (r.consent_version as string | null) ?? null,
    consentAt: (r.consent_at as string | null) ?? null,
    lang: r.lang === 'en' ? 'en' : 'id',
  });
  return {
    settings(userId: number): WaSettings | null {
      const r = db.prepare('select * from wa_settings where user_id = ?').get(userId) as Row | undefined;
      return r ? toSettings(r) : null;
    },
    /** Changes some settings; a new number is unverified until its code comes back. */
    save(userId: number, patch: Partial<WaSettings>, now = new Date()): WaSettings {
      const before = this.settings(userId) ?? { phone: null, verifiedAt: null, optIn: false, kinds: [...WA_KINDS], consentVersion: null, consentAt: null, lang: 'id' as Lang };
      const next = { ...before, ...patch };
      if (patch.phone !== undefined && patch.phone !== before.phone && patch.verifiedAt === undefined) next.verifiedAt = null;
      db.prepare(
        `insert into wa_settings (user_id, phone, verified_at, opt_in, kinds, consent_version, consent_at, lang, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (user_id) do update set phone = excluded.phone, verified_at = excluded.verified_at, opt_in = excluded.opt_in, kinds = excluded.kinds,
           consent_version = excluded.consent_version, consent_at = excluded.consent_at, lang = excluded.lang, updated_at = excluded.updated_at`,
      ).run(userId, next.phone, next.verifiedAt, Number(next.optIn), JSON.stringify(next.kinds), next.consentVersion, next.consentAt, next.lang, now.toISOString());
      return next;
    },
    /** Farm members who may get this kind from the server, with their settings. */
    receivers(farmId: number, kind: WaKind, provider: Pick<WaProvider, 'push'>): { userId: number; settings: WaSettings }[] {
      const rows = db.prepare('select w.* from wa_settings w join memberships m on m.user_id = w.user_id where m.farm_id = ? and w.opt_in = 1').all(farmId) as Row[];
      return rows.map((r) => ({ userId: r.user_id as number, settings: toSettings(r) })).filter((x) => blockedReason(x.settings, kind, provider) === null);
    },
    record(s: { userId: number | null; farmId: number | null; pondId?: number | null; kind: WaSendKind; channel: WaChannel; result: WaResult }, now = new Date()) {
      db.prepare('insert into wa_sends (at, user_id, farm_id, pond_id, kind, channel, template, status, error, message_id) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        now.toISOString(),
        s.userId,
        s.farmId,
        s.pondId ?? null,
        s.kind,
        s.channel,
        s.result.template,
        s.result.status,
        s.result.error ?? null,
        s.result.id ?? null,
      );
    },
    recent(userId: number, limit = 5): WaSendRow[] {
      return (db.prepare('select at, kind, channel, template, status, error from wa_sends where user_id = ? order by id desc limit ?').all(userId, limit) as Row[]).map((r) => ({
        at: r.at as string,
        kind: r.kind as WaSendKind,
        channel: r.channel as WaChannel,
        template: (r.template as string | null) ?? null,
        status: r.status as WaResult['status'],
        error: (r.error as string | null) ?? null,
      }));
    },
    /** A sent message of this kind about this pond since `since`: one alarm summary per pond per few hours is enough. */
    sentSince(kind: WaSendKind, pondId: number, userId: number, since: Date): boolean {
      return Boolean(db.prepare("select 1 from wa_sends where kind = ? and pond_id = ? and user_id = ? and status = 'sent' and at >= ?").get(kind, pondId, userId, since.toISOString()));
    },
    /** The farm a pond belongs to (pond ids are unique across farms). */
    farmOfPond(pondId: number): number | null {
      const r = db.prepare('select farm_id from ponds where id = ?').get(pondId) as Row | undefined;
      return (r?.farm_id as number | null) ?? null;
    },
  };
}

export type WhatsAppStore = ReturnType<typeof whatsappStore>;

// ---------- Verification codes ----------

const hash = (code: string) => createHash('sha256').update(code).digest('hex');

/**
 * Six-digit codes sent to the WhatsApp number being added: one live code per person, valid 10 minutes,
 * gone after 5 wrong tries. In memory like the e-mail codes (auth.ts): a restart only means asking again.
 */
export function phoneCodes(now = () => Date.now(), validMs = 10 * 60_000, maxTries = 5) {
  const live = new Map<number, { phone: string; hash: string; expires: number; tries: number }>();
  return {
    issue(userId: number, phone: string): string {
      const code = String(randomInt(1_000_000)).padStart(6, '0');
      live.set(userId, { phone, hash: hash(code), expires: now() + validMs, tries: 0 });
      return code;
    },
    /** 'ok' uses the code up; 'expired' when there is none (or it ran out); 'wrong' counts a try. */
    use(userId: number, phone: string, input: unknown): 'ok' | 'wrong' | 'expired' {
      const entry = live.get(userId);
      if (!entry || entry.phone !== phone || entry.expires <= now()) {
        live.delete(userId);
        return 'expired';
      }
      const code = String(input ?? '').replace(/\D/g, '');
      if (code.length !== 6 || !timingSafeEqual(Buffer.from(hash(code)), Buffer.from(entry.hash))) {
        entry.tries += 1;
        if (entry.tries >= maxTries) live.delete(userId);
        return entry.tries >= maxTries ? 'expired' : 'wrong';
      }
      live.delete(userId);
      return 'ok';
    },
  };
}
