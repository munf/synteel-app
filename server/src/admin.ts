// Team dashboard (web build under admin/, served at <app>/admin/). One login from the env file
// (SYNTEEL_ADMIN_USER, SYNTEEL_ADMIN_PASSWORD); without both the routes answer 404.
// Privacy: phone numbers and e-mail addresses leave the server masked, region figures are counts
// only and skip kabupaten with fewer than 3 farms, and "Coba demo" farms and visitors are never
// counted as users or farms.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, statfsSync } from 'node:fs';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Ai } from './ai.ts';
import { SUPPORT_TOPICS } from './api.ts';
import { attemptLimiter, AuthError, maskEmail } from './auth.ts';
import { regionCandidates } from './bmkg.ts';
import type { Db } from './db.ts';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const WIB = 7 * HOUR;
const SESSION_MS = 12 * HOUR;
/** Region figures hide a kabupaten with fewer farms than this, so a single farm cannot be picked out. */
export const MIN_FARMS_SHOWN = 3;
/** An AI call slower than this shows in the dashboard's list of slow calls. */
export const SLOW_AI_S = 30;

export type AiFeature = 'foto' | 'suara' | 'video' | 'malam';
export type EventKind =
  | 'login_failed'
  | 'rate_limited'
  | 'server_error'
  | 'code_mail_sent'
  | 'code_mail_failed'
  | 'demo_started'
  | 'admin_login'
  | 'admin_login_failed'
  | 'admin_action';
export type TicketStatus = 'baru' | 'dibalas' | 'selesai';

type Row = Record<string, unknown>;

/** What the dashboard needs that the app did not keep: events, AI calls, when people last opened the app. */
export function eventLog(db: Db, now = () => new Date()) {
  db.exec(`
    create table if not exists events (
      id integer primary key,
      at text not null,
      kind text not null,
      route text,
      detail text
    );
    create index if not exists events_kind_at on events (kind, at);
    create table if not exists ai_calls (
      id integer primary key,
      at text not null,
      feature text not null,
      ms integer not null,
      ok integer not null,
      error text
    );
    create index if not exists ai_calls_at on ai_calls (at);
  `);
  const userCols = (db.prepare('pragma table_info(users)').all() as { name: string }[]).map((c) => c.name);
  if (!userCols.includes('seen_at')) db.exec('alter table users add column seen_at text');
  const ticketCols = (db.prepare('pragma table_info(support_tickets)').all() as { name: string }[]).map((c) => c.name);
  if (!ticketCols.includes('admin_status')) db.exec("alter table support_tickets add column admin_status text not null default 'baru'");
  // Kept 90 days: enough for the 14-day charts and a look back.
  const cutoff = new Date(now().getTime() - 90 * DAY).toISOString();
  db.prepare('delete from events where at < ?').run(cutoff);
  db.prepare('delete from ai_calls where at < ?').run(cutoff);

  const seen = new Map<number, number>();
  return {
    record(kind: EventKind, route: string | null = null, detail: string | null = null) {
      db.prepare('insert into events (at, kind, route, detail) values (?, ?, ?, ?)').run(now().toISOString(), kind, route, detail && detail.slice(0, 300));
    },
    ai(feature: AiFeature, ms: number, ok: boolean, error: string | null = null) {
      db.prepare('insert into ai_calls (at, feature, ms, ok, error) values (?, ?, ?, ?, ?)').run(now().toISOString(), feature, Math.round(ms), ok ? 1 : 0, error && error.slice(0, 300));
    },
    /** The app was opened by this person; written at most once an hour per person. */
    seen(userId: number) {
      const t = now().getTime();
      if (t - (seen.get(userId) ?? 0) < HOUR) return;
      seen.set(userId, t);
      db.prepare('update users set seen_at = ? where id = ?').run(new Date(t).toISOString(), userId);
    },
  };
}
export type EventLog = ReturnType<typeof eventLog>;

/** Times every real AI call and keeps whether it worked. Wrap it inside withDailyCap, so refusals by the cap are not counted. */
export function withAiLog(ai: Ai, log: EventLog | null): Ai {
  if (!log || ai.mode !== 'meta') return ai;
  const timed =
    <A, R>(feature: (a: A) => AiFeature, fn: (a: A) => Promise<R>) =>
    async (a: A): Promise<R> => {
      const start = Date.now();
      try {
        const result = await fn(a);
        log.ai(feature(a), Date.now() - start, true);
        return result;
      } catch (err) {
        log.ai(feature(a), Date.now() - start, false, (err as Error).message);
        throw err;
      }
    };
  const byKind = { photo: 'foto', voice: 'suara', video: 'video' } as const;
  return {
    mode: ai.mode,
    draft: timed((i) => byKind[i.kind], (i) => ai.draft(i)),
    round: timed(() => 'suara', (i) => ai.round(i)),
    notebook: timed(() => 'foto', (i) => ai.notebook(i)),
    pondPhoto: timed(() => 'foto', (i) => ai.pondPhoto(i)),
    transcribe: timed(() => 'suara', (a) => ai.transcribe(a)),
  };
}

/** "6281234564471" → "0812-••••-4471". */
export function maskPhone(phone: string): string {
  const local = phone.startsWith('62') ? '0' + phone.slice(2) : phone;
  return local.length < 8 ? '••••' : `${local.slice(0, 4)}-••••-${local.slice(-4)}`;
}

/** "2026-10-31T20:00:00Z" → "2026-11-01" (the date in WIB). */
const wibDate = (iso: string) => new Date(Date.parse(iso) + WIB).toISOString().slice(0, 10);
/** The last n WIB dates, oldest first. */
const lastDays = (now: Date, n: number) => Array.from({ length: n }, (_, i) => wibDate(new Date(now.getTime() - (n - 1 - i) * DAY).toISOString()));
/** Counts per day for `days`, from a list of instants. */
const perDay = (days: string[], ats: string[]) => {
  const n = new Map(days.map((d) => [d, 0]));
  for (const at of ats) {
    const d = wibDate(at);
    if (n.has(d)) n.set(d, n.get(d)! + 1);
  }
  return days.map((d) => n.get(d)!);
};
const latest = (...ats: (string | null | undefined)[]) => ats.filter((a): a is string => Boolean(a)).sort().at(-1) ?? null;

export interface ServiceCheck {
  id: string;
  nama: string;
  ket: string;
  url: string;
}
export interface BackupStatus {
  at: string;
  bytes: number;
}

export interface AdminDeps {
  /** From the env file; null turns the dashboard off. */
  creds: { user: string; password: string } | null;
  cookieName?: string;
  now?: () => Date;
  /** Phone of the demo template's owner, never counted as a user. */
  demoPhone?: string | null;
  /** Real AI reads per farm per day (0 = no cap), for the quota list. */
  farmAiCap?: number;
  events?: EventLog | null;
  /** Health checks on the Kesehatan page (the app itself, the preview, the site). */
  checks?: ServiceCheck[];
  /** Time and size of the last database backup (written by synteel-backup); null when unknown. */
  backupStatus?: () => BackupStatus | null;
  fetcher?: typeof fetch;
}

/** The backup script's status file: {"at": "...", "bytes": n}. */
export function backupStatusFile(path: string) {
  return (): BackupStatus | null => {
    try {
      const s = JSON.parse(readFileSync(path, 'utf8'));
      return typeof s.at === 'string' && typeof s.bytes === 'number' ? s : null;
    } catch {
      return null;
    }
  };
}

function vps() {
  let total = 0;
  let available = 0;
  try {
    const info = readFileSync('/proc/meminfo', 'utf8');
    total = Number(info.match(/MemTotal:\s+(\d+)/)?.[1] ?? 0) * 1024;
    available = Number(info.match(/MemAvailable:\s+(\d+)/)?.[1] ?? 0) * 1024;
  } catch {
    // Not Linux: leave the gauges empty.
  }
  let diskTotal = 0;
  let diskFree = 0;
  try {
    const fs = statfsSync('/');
    diskTotal = fs.blocks * fs.bsize;
    diskFree = fs.bavail * fs.bsize;
  } catch {
    // No statfs: leave it empty.
  }
  const gb = (b: number) => Math.round((b / 2 ** 30) * 10) / 10;
  return { ramTotalGb: gb(total), ramPakaiGb: gb(total - available), diskTotalGb: gb(diskTotal), diskPakaiGb: gb(diskTotal - diskFree) };
}

export function createAdmin(db: Db, { creds, cookieName = 'synteel_session', now = () => new Date(), demoPhone = null, farmAiCap = 0, events = null, checks = [], backupStatus = () => null, fetcher = fetch }: AdminDeps) {
  const admin = new Hono();
  const cookie = `${cookieName}_admin`;
  const limiter = attemptLimiter(5, 15 * 60_000, () => now().getTime(), () => 'Terlalu banyak percobaan. Coba lagi 15 menit lagi.');
  const sha = (s: string) => createHash('sha256').update(s).digest();
  const same = (a: string, b: string) => timingSafeEqual(sha(a), sha(b));
  // The key changes with the password, so a new password ends every admin session.
  const key = creds && sha(`synteel-admin\0${creds.user}\0${creds.password}`);
  const sign = (exp: number) => createHmac('sha256', key!).update(String(exp)).digest('hex');
  const clientIp = (c: Context) => c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0].trim() ?? 'local';

  admin.onError((err, c) => {
    if (err instanceof AuthError) return c.json({ error: err.message, code: err.code ?? 'auth', retryAt: err.retryAt }, err.status);
    console.error('admin:', err);
    events?.record('server_error', `${c.req.method} ${c.req.path}`, (err as Error).message);
    return c.json({ error: 'Terjadi kesalahan di server' }, 500);
  });

  admin.use(async (c, next) => {
    if (!creds) return c.json({ error: 'Tidak ditemukan' }, 404);
    c.header('Cache-Control', 'no-store');
    if (c.req.path.endsWith('/login')) return next();
    const [exp, mac] = (getCookie(c, cookie) ?? '').split('.');
    const valid = Number(exp) > now().getTime() && /^[0-9a-f]{64}$/.test(mac ?? '') && timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(sign(Number(exp)), 'hex'));
    if (!valid) return c.json({ error: 'Silakan masuk dulu', code: 'auth' }, 401);
    return next();
  });

  admin.post('/login', async (c) => {
    const ip = `ip:${clientIp(c)}`;
    limiter.check(ip);
    const body = await c.req.json().catch(() => ({}));
    const ok = same(String(body.user ?? ''), creds!.user) && same(String(body.password ?? ''), creds!.password);
    if (!ok) {
      limiter.fail(ip);
      events?.record('admin_login_failed', null, clientIp(c));
      throw new AuthError('Nama pengguna atau kata sandi salah', 401);
    }
    limiter.clear(ip);
    events?.record('admin_login', null, clientIp(c));
    const exp = now().getTime() + SESSION_MS;
    setCookie(c, cookie, `${exp}.${sign(exp)}`, { httpOnly: true, sameSite: 'Strict', secure: c.req.header('x-forwarded-proto') === 'https', path: '/', maxAge: SESSION_MS / 1000 });
    return c.json({ user: creds!.user });
  });

  admin.post('/logout', (c) => {
    deleteCookie(c, cookie, { path: '/' });
    return c.json({ ok: true });
  });

  admin.get('/me', (c) => c.json({ user: creds!.user }));

  // ---------- who counts ----------
  // Demo visitors, the demo template's owner and demo farms are left out of every figure.
  const realUsers = () =>
    db
      .prepare(
        `select u.id, u.name, u.phone, u.email, u.created_at, u.seen_at,
           (select max(created_at) from sessions s where s.user_id = u.id) as session_at,
           (select max(logged_at) from logs l where l.created_by = u.id) as log_at
         from users u
         where u.phone not like 'demo%' and u.phone != ? and u.id not in (select user_id from demo_farms)
         order by u.created_at desc`,
      )
      .all(demoPhone ?? '') as Row[];
  const realFarms = () =>
    db
      .prepare(
        `select f.*,
           (select count(*) from ponds p where p.farm_id = f.id and p.archived = 0) as ponds,
           (select count(*) from memberships m where m.farm_id = f.id and m.role = 'worker') as workers,
           (select m.user_id from memberships m where m.farm_id = f.id and m.role = 'owner' order by m.created_at limit 1) as owner_id
         from farms f
         where f.id not in (select farm_id from demo_farms)
         order by f.id`,
      )
      .all() as Row[];
  const lastActive = (u: Row) => latest(u.seen_at as string, u.session_at as string, u.log_at as string, u.created_at as string);
  const region = (f: Row) => regionCandidates({ lat: f.lat as number | null, lon: f.lon as number | null, adm4: f.adm4 as string | null })[0]?.desa ?? null;

  // ---------- pages ----------
  admin.get('/ringkasan', (c) => {
    const t = now();
    const days = lastDays(t, 14);
    const since = new Date(t.getTime() - 15 * DAY).toISOString();
    const week = new Date(t.getTime() - 7 * DAY).toISOString();
    const users = realUsers();
    const farms = realFarms();
    const farmIds = new Set(farms.map((f) => f.id as number));
    const logs = (db.prepare('select l.logged_at, p.farm_id from logs l join ponds p on p.id = l.pond_id where l.logged_at >= ? and l.deleted_at is null').all(since) as Row[]).filter((l) => farmIds.has(l.farm_id as number));
    const openCases = (db.prepare("select farm_id from cases where status = 'open'").all() as Row[]).filter((r) => farmIds.has(r.farm_id as number)).length;
    const unanswered = (db.prepare("select count(*) as n from support_tickets where admin_status = 'baru'").get() as Row).n as number;
    const daftarPerHari = perDay(days, users.map((u) => u.created_at as string));
    // Demo visits: the events from now on, and before them the demo copies still alive (deleted after 48 hours).
    const demoEvents = perDay(days, (db.prepare("select at from events where kind = 'demo_started' and at >= ?").all(since) as Row[]).map((r) => r.at as string));
    const demoCopies = perDay(days, (db.prepare("select created_at from demo_farms where kind = 'copy' and created_at >= ?").all(since) as Row[]).map((r) => r.created_at as string));
    const demoPerHari = days.map((_, i) => Math.max(demoEvents[i], demoCopies[i]));
    return c.json({
      hari: days,
      daftarPerHari,
      daftarHariIni: daftarPerHari.at(-1),
      daftar7Hari: daftarPerHari.slice(-7).reduce((a, b) => a + b, 0),
      aktif7Hari: users.filter((u) => (lastActive(u) ?? '') >= week).length,
      totalAkun: users.length,
      tambak: farms.length,
      kolam: farms.reduce((a, f) => a + (f.ponds as number), 0),
      catatanPerHari: perDay(days, logs.map((l) => l.logged_at as string)),
      kasusTerbuka: openCases,
      bantuanBelumDibalas: unanswered,
      demo: { sesiHariIni: demoPerHari.at(-1), sesi7Hari: demoPerHari.slice(-7).reduce((a, b) => a + b, 0), menitRata: null, lanjutDaftar7Hari: null, perHari: demoPerHari },
    });
  });

  admin.get('/kasus', (c) => {
    const farms = new Map(realFarms().map((f) => [f.id as number, f]));
    const cases = (db.prepare("select c.id, c.farm_id, c.opened_at, p.name as pond from cases c join ponds p on p.id = c.pond_id where c.status = 'open' order by c.opened_at desc").all() as Row[])
      .filter((r) => farms.has(r.farm_id as number))
      .map((r) => {
        const f = farms.get(r.farm_id as number)!;
        return { id: `k${r.id}`, jenis: 'Kematian naik', tambak: f.name, kabupaten: region(f)?.kabupaten ?? '', sejak: r.opened_at, catatan: `${r.pond}: kasus sidat mati masih terbuka.` };
      });
    const outages = (db.prepare('select id, farm_id, started_at from outages where ended_at is null and started_at >= ? order by started_at desc').all(new Date(now().getTime() - DAY).toISOString()) as Row[])
      .filter((r) => farms.has(r.farm_id as number))
      .map((r) => {
        const f = farms.get(r.farm_id as number)!;
        return { id: `o${r.id}`, jenis: 'Listrik padam', tambak: f.name, kabupaten: region(f)?.kabupaten ?? '', sejak: r.started_at, catatan: 'Listrik padam, belum ditandai menyala lagi.' };
      });
    return c.json([...cases, ...outages].sort((a, b) => String(b.sejak).localeCompare(String(a.sejak))));
  });

  admin.get('/akun', (c) => {
    const farms = new Map(realFarms().map((f) => [f.id as number, f]));
    const roles = db.prepare("select farm_id, role from memberships where user_id = ? order by role = 'owner' desc, created_at");
    return c.json(
      realUsers().map((u) => {
        const m = (roles.all(u.id as number) as Row[]).find((r) => farms.has(r.farm_id as number));
        const f = m && farms.get(m.farm_id as number);
        return {
          id: `a${u.id}`,
          nama: u.name,
          telepon: maskPhone(u.phone as string),
          email: u.email ? maskEmail(u.email as string) : null,
          peran: m?.role === 'worker' ? 'pekerja' : 'pemilik',
          status: 'aktif',
          daftar: u.created_at,
          terakhirAktif: lastActive(u),
          kabupaten: (f && region(f)?.kabupaten) ?? '',
          tambakId: f ? `t${f.id}` : null,
        };
      }),
    );
  });

  admin.get('/tambak', (c) => {
    const week = new Date(now().getTime() - 7 * DAY).toISOString();
    const last = db.prepare('select max(l.logged_at) as at, sum(l.logged_at >= ?) as week from logs l join ponds p on p.id = l.pond_id where p.farm_id = ? and l.deleted_at is null');
    return c.json(
      realFarms().map((f) => {
        const l = last.get(week, f.id as number) as Row;
        return {
          id: `t${f.id}`,
          nama: f.name,
          kabupaten: region(f)?.kabupaten ?? '',
          pemilikId: f.owner_id ? `a${f.owner_id}` : null,
          kolam: f.ponds,
          pekerja: f.workers,
          catatanTerakhir: l.at ?? null,
          catatan7Hari: Number(l.week ?? 0),
        };
      }),
    );
  });

  admin.get('/bantuan', (c) => {
    const rows = db.prepare('select t.*, u.name as user_name from support_tickets t left join users u on u.id = t.user_id order by t.created_at desc limit 200').all() as Row[];
    return c.json(
      rows.map((t) => {
        const nama = (t.user_name as string | null) ?? 'Tanpa akun';
        return {
          id: `b${t.id}`,
          nama,
          kontak: t.reply_email ? maskEmail(t.reply_email as string) : t.reply_phone ? maskPhone(t.reply_phone as string) : '—',
          akunId: t.user_id ? `a${t.user_id}` : null,
          topik: SUPPORT_TOPICS[t.topic as keyof typeof SUPPORT_TOPICS] ?? String(t.topic),
          status: t.admin_status,
          masuk: t.created_at,
          terkirimEmail: Boolean(t.mailed_at),
          utas: [{ dari: 'pengguna', nama, isi: t.message, waktu: t.created_at }],
        };
      }),
    );
  });

  admin.post('/bantuan/:id/status', async (c) => {
    const id = Number(c.req.param('id').replace(/^b/, ''));
    const status = (await c.req.json().catch(() => ({}))).status as TicketStatus;
    if (!['baru', 'dibalas', 'selesai'].includes(status)) return c.json({ error: 'Status tidak dikenal' }, 400);
    const changed = db.prepare('update support_tickets set admin_status = ? where id = ?').run(status, id).changes;
    if (!changed) return c.json({ error: 'Pesan tidak ditemukan' }, 404);
    events?.record('admin_action', `bantuan ${id}`, `status → ${status}`);
    return c.json({ ok: true });
  });

  admin.get('/ai', (c) => {
    const t = now();
    const days = lastDays(t, 14);
    const since = new Date(t.getTime() - 15 * DAY).toISOString();
    const calls = db.prepare('select * from ai_calls where at >= ? order by at desc').all(since) as Row[];
    const perFitur = Object.fromEntries((['foto', 'suara', 'video', 'malam'] as AiFeature[]).map((f) => [f, perDay(days, calls.filter((r) => r.feature === f).map((r) => r.at as string))]));
    const log = calls
      .filter((r) => !r.ok || (r.ms as number) >= SLOW_AI_S * 1000)
      .slice(0, 50)
      .map((r) => ({ id: `l${r.id}`, waktu: r.at, fitur: r.feature, tambak: null, durasiDtk: Math.round((r.ms as number) / 1000), hasil: r.ok ? 'lambat' : 'gagal', pesan: (r.error as string | null) ?? 'Selesai, tetapi lambat' }));
    // Today's reads per farm against the farm cap, fullest first.
    const farms = new Map(realFarms().map((f) => [f.id as number, f]));
    const used = (db.prepare('select farm_id, sum(used) as used from ai_usage where local_date = ? group by farm_id').all(wibDate(t.toISOString())) as Row[])
      .filter((r) => farms.has(r.farm_id as number))
      .map((r) => {
        const f = farms.get(r.farm_id as number)!;
        return { tambak: f.name, kabupaten: region(f)?.kabupaten ?? '', pakai: Number(r.used), batas: farmAiCap || null };
      })
      .sort((a, b) => b.pakai - a.pakai)
      .slice(0, 10);
    return c.json({ hari: days, perFitur, log, kuota: used, ambangLambatDtk: SLOW_AI_S });
  });

  let lastChecks: { at: number; layanan: unknown[] } = { at: 0, layanan: [] };
  admin.get('/kesehatan', async (c) => {
    const t = now();
    if (t.getTime() - lastChecks.at > 60_000) {
      const layanan = await Promise.all(
        checks.map(async (s) => {
          const start = Date.now();
          try {
            const res = await fetcher(s.url, { signal: AbortSignal.timeout(5000) });
            const ms = Date.now() - start;
            return { id: s.id, nama: s.nama, ket: s.ket, status: !res.ok ? 'critical' : ms > 1000 ? 'degraded' : 'normal', waktuRespon: ms, cek: t.toISOString() };
          } catch {
            return { id: s.id, nama: s.nama, ket: s.ket, status: 'critical', waktuRespon: null, cek: t.toISOString() };
          }
        }),
      );
      lastChecks = { at: t.getTime(), layanan };
    }
    const days = lastDays(t, 14);
    const since = new Date(t.getTime() - 15 * DAY).toISOString();
    const ev = (kind: EventKind) => perDay(days, (db.prepare('select at from events where kind = ? and at >= ?').all(kind, since) as Row[]).map((r) => r.at as string));
    const galat = (db.prepare("select max(at) as at, route, detail, count(*) as n from events where kind = 'server_error' and at >= ? group by route, detail order by at desc limit 20").all(new Date(t.getTime() - DAY).toISOString()) as Row[]).map((r) => ({
      waktu: r.at,
      rute: r.route ?? '',
      kode: 500,
      pesan: r.detail ?? '',
      jumlah: r.n,
    }));
    const b = backupStatus();
    return c.json({
      layanan: lastChecks.layanan,
      vps: vps(),
      backup: b ? { terakhir: b.at, ukuranMb: Math.round((b.bytes / 2 ** 20) * 10) / 10, tujuan: 'Di VPS (/var/backups/synteel), disimpan 30 hari', berhasil: t.getTime() - Date.parse(b.at) < 26 * HOUR } : null,
      hari: days,
      emailKode: { terkirim: ev('code_mail_sent'), gagal: ev('code_mail_failed') },
      login: { gagal: ev('login_failed'), kenaBatas: ev('rate_limited') },
      galat,
    });
  });

  admin.get('/wilayah', (c) => {
    const t = now();
    const groups = new Map<string, { kabupaten: string; provinsi: string; farms: Row[]; lat: number[]; lon: number[] }>();
    for (const f of realFarms()) {
      const d = region(f);
      if (!d) continue;
      const g = groups.get(d.kabupaten + '|' + d.provinsi) ?? { kabupaten: d.kabupaten, provinsi: d.provinsi, farms: [], lat: [], lon: [] };
      g.farms.push(f);
      if (d.lat !== null && d.lon !== null) {
        g.lat.push(d.lat);
        g.lon.push(d.lon);
      }
      groups.set(d.kabupaten + '|' + d.provinsi, g);
    }
    const shown = [...groups.values()].filter((g) => g.farms.length >= MIN_FARMS_SHOWN);
    // Tile map: roughly west → east and north → south, half a degree a tile; clashes move one tile east.
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const minLon = Math.min(...shown.map((g) => avg(g.lon)));
    const maxLat = Math.max(...shown.map((g) => avg(g.lat)));
    const taken = new Set<string>();
    const sebaran = shown
      .sort((a, b) => avg(a.lon) - avg(b.lon))
      .map((g) => {
        let kol = Math.round((avg(g.lon) - minLon) / 0.5);
        const baris = Math.round((maxLat - avg(g.lat)) / 0.5);
        while (taken.has(`${kol},${baris}`)) kol++;
        taken.add(`${kol},${baris}`);
        return { kabupaten: g.kabupaten, provinsi: g.provinsi, tambak: g.farms.length, kolam: g.farms.reduce((a, f) => a + (f.ponds as number), 0), kol, baris };
      });
    // Last 8 weeks (7-day blocks ending now), oldest first.
    const weekStart = (i: number) => t.getTime() - (8 - i) * 7 * DAY;
    const minggu = Array.from({ length: 8 }, (_, i) => (i === 7 ? 'mgg ini' : `M-${7 - i}`));
    const farmOf = new Map(shown.flatMap((g) => g.farms.map((f) => [f.id as number, g.kabupaten])));
    const cases = db.prepare('select farm_id, opened_at from cases where opened_at >= ?').all(new Date(weekStart(0)).toISOString()) as Row[];
    const kematian = shown
      .map((g) => ({
        kabupaten: g.kabupaten,
        kasus: minggu.map((_, i) => cases.filter((r) => farmOf.get(r.farm_id as number) === g.kabupaten && Date.parse(r.opened_at as string) >= weekStart(i) && Date.parse(r.opened_at as string) < weekStart(i + 1)).length),
      }))
      .filter((k) => k.kasus.some((n) => n > 0));
    const outages = db.prepare('select farm_id from outages where started_at >= ?').all(new Date(t.getTime() - 30 * DAY).toISOString()) as Row[];
    const listrik = shown
      .map((g) => ({ kabupaten: g.kabupaten, laporan: outages.filter((r) => farmOf.get(r.farm_id as number) === g.kabupaten).length }))
      .filter((l) => l.laporan > 0)
      .sort((a, b) => b.laporan - a.laporan);
    return c.json({ sebaran, minggu, kematian, listrik, pembaruan: t.toISOString(), tersembunyi: [...groups.values()].filter((g) => g.farms.length < MIN_FARMS_SHOWN).length });
  });

  return admin;
}
