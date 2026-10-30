import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { demoStore } from './demo.ts';
import { deviceStore } from './devices.ts';
import { tx } from './i18n.ts';
import type { Aeration, Batch, Farm, Log, LogData, Phase, Pond, Setting } from './domain.ts';
import type { Outage } from './power.ts';
import type { WeatherHour } from './weather.ts';

const defaultPath = fileURLToPath(new URL('../../data/synteel.sqlite', import.meta.url));

export function openDb(path = process.env.SYNTEEL_DB ?? defaultPath) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    pragma journal_mode = wal;
    pragma foreign_keys = on;

    create table if not exists farms (
      id integer primary key,
      name text not null,
      location_name text,
      lat real,
      lon real,
      timezone text not null default 'Asia/Jakarta',
      created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    create table if not exists users (
      id integer primary key,
      phone text not null unique,
      name text not null,
      pin_hash text not null,
      created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    create table if not exists memberships (
      user_id integer not null references users(id),
      farm_id integer not null references farms(id),
      role text not null check (role in ('owner', 'worker')),
      created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      primary key (user_id, farm_id)
    );

    -- Only a hash of the session token is stored, so a leaked database cannot log anyone in.
    create table if not exists sessions (
      token_hash text primary key,
      user_id integer not null references users(id),
      farm_id integer references farms(id),
      created_at text not null,
      expires_at text not null
    );

    create table if not exists briefings (
      id integer primary key,
      farm_id integer not null references farms(id),
      local_date text not null,
      created_at text not null,
      body text not null
    );
    create index if not exists briefings_farm on briefings (farm_id, local_date);

    create table if not exists invites (
      code text primary key,
      farm_id integer not null references farms(id),
      role text not null check (role in ('owner', 'worker')),
      created_by integer not null references users(id),
      created_at text not null,
      expires_at text not null,
      used_by integer references users(id),
      used_at text
    );

    create table if not exists ponds (
      id integer primary key,
      name text not null,
      kind text,
      volume_l real,
      area_m2 real,
      setting text,
      shaded integer,
      aeration text,
      depth_cm real,
      archived integer not null default 0
    );

    create table if not exists batches (
      id integer primary key,
      pond_id integer not null references ponds(id),
      phase text not null check (phase in ('glass_eel', 'elver')),
      stocked_at text not null,
      initial_count integer,
      ended_at text
    );

    create table if not exists logs (
      id integer primary key,
      pond_id integer not null references ponds(id),
      batch_id integer references batches(id),
      logged_at text not null,
      source text not null default 'manual',
      data text not null
    );
    create index if not exists logs_pond_time on logs (pond_id, logged_at);

    -- Real AI reads per person per farm-local day; the farm's cap counts them all together.
    create table if not exists ai_usage (
      farm_id integer not null references farms(id),
      user_id integer not null references users(id),
      local_date text not null,
      used integer not null default 0,
      primary key (farm_id, user_id, local_date)
    );

    -- Dead-eel cases (cases.ts): at most one open case per pond; closed ones stay as history.
    create table if not exists cases (
      id integer primary key,
      farm_id integer not null references farms(id),
      pond_id integer not null references ponds(id),
      status text not null check (status in ('open', 'closed')),
      opened_at text not null,
      closed_at text,
      closed_by integer references users(id)
    );
    create unique index if not exists cases_one_open on cases (pond_id) where status = 'open';
    create index if not exists cases_farm on cases (farm_id, status);

    -- What happened in a case: reports, answers, re-checks, agent runs, closing.
    create table if not exists case_events (
      id integer primary key,
      case_id integer not null references cases(id),
      at text not null,
      kind text not null,
      user_id integer references users(id),
      data text not null
    );
    create index if not exists case_events_case on case_events (case_id, id);

    -- "Hubungi bantuan": kept even when the e-mail to the team fails.
    create table if not exists support_tickets (
      id integer primary key,
      created_at text not null,
      topic text not null,
      message text not null,
      reply_phone text not null,
      account_phone text,
      user_id integer references users(id),
      farm_id integer references farms(id),
      device text,
      mailed_at text
    );
  `);
  // Databases created before these pond columns existed.
  const pondCols = (db.prepare('pragma table_info(ponds)').all() as { name: string }[]).map((c) => c.name);
  for (const [col, type] of [['area_m2', 'real'], ['setting', 'text'], ['shaded', 'integer'], ['aeration', 'text'], ['depth_cm', 'real'], ['farm_id', 'integer references farms(id)'], ['nicknames', 'text']]) {
    if (!pondCols.includes(col)) db.exec(`alter table ponds add column ${col} ${type}`);
  }
  // Logs from before accounts and corrections: no maker, never deleted, no edits.
  const logCols = (db.prepare('pragma table_info(logs)').all() as { name: string }[]).map((c) => c.name);
  for (const [col, type] of [['created_by', 'integer references users(id)'], ['deleted_at', 'text'], ['edits', 'text']]) {
    if (!logCols.includes(col)) db.exec(`alter table logs add column ${col} ${type}`);
  }
  // Tickets from the website's contact form can ask for a reply by e-mail.
  const ticketCols = (db.prepare('pragma table_info(support_tickets)').all() as { name: string }[]).map((c) => c.name);
  if (!ticketCols.includes('reply_email')) db.exec('alter table support_tickets add column reply_email text');
  // Briefings in more than one language: the language, 'lang' for a re-run in another language of the
  // briefing `basis`, 'copy' for one copied into a demo farm. Older rows: Indonesian originals.
  const briefingCols = (db.prepare('pragma table_info(briefings)').all() as { name: string }[]).map((c) => c.name);
  for (const [col, type] of [['lang', 'text'], ['kind', 'text'], ['basis', 'integer']]) {
    if (!briefingCols.includes(col)) db.exec(`alter table briefings add column ${col} ${type}`);
  }
  // ---------- Pond profile from a photo, learned water temperature, weekly patterns (thermal.ts) ----------
  // Additive only. Water colour and light at the pond (from a pond photo or picked by hand); past
  // weather days from the Open-Meteo archive (archive.ts), kept for good; and the weekly pattern
  // notes per pond (patterns.ts), newest per pond and language shown.
  for (const [col, type] of [['water_color', 'text'], ['light', 'text']]) {
    if (!pondCols.includes(col)) db.exec(`alter table ponds add column ${col} ${type}`);
  }
  db.exec(`
    create table if not exists weather_archive (
      location text not null,
      day text not null,
      hours text not null,
      primary key (location, day)
    );
    create table if not exists pond_patterns (
      id integer primary key,
      farm_id integer not null references farms(id),
      pond_id integer not null references ponds(id),
      created_at text not null,
      lang text not null,
      source text not null,
      body text not null
    );
    create index if not exists pond_patterns_pond on pond_patterns (pond_id, id);
    create index if not exists pond_patterns_farm on pond_patterns (farm_id, created_at);
  `);
  // ---------- end of the pond profile block ----------
  // ---------- Farms: power backup, BMKG region, power cuts (power.ts, bmkg.ts) ----------
  // Additive only. power_backup: 'genset' | 'battery' | 'none' (null = not answered yet).
  // adm4: the BMKG village the owner picked (null = nearest to the farm's coordinates).
  // outages: "Listrik padam" taps, farm-wide; ended_at null while the power is still out.
  const farmCols = (db.prepare('pragma table_info(farms)').all() as { name: string }[]).map((c) => c.name);
  for (const [col, type] of [['power_backup', 'text'], ['adm4', 'text']]) {
    if (!farmCols.includes(col)) db.exec(`alter table farms add column ${col} ${type}`);
  }
  db.exec(`
    create table if not exists outages (
      id integer primary key,
      farm_id integer not null,
      started_at text not null,
      ended_at text,
      started_by integer,
      ended_by integer
    );
    create index if not exists outages_farm on outages (farm_id, started_at);
  `);
  // ---------- end of the farms power block ----------
  // ---------- Pond cover photo (captures.ts coverStore) ----------
  // Additive only. cover_photo: the folder of the pond's cover picture under the captures folder
  // (named with the farm id, so a deleted demo farm's covers go with its captures); null = the pond icon.
  if (!pondCols.includes('cover_photo')) db.exec('alter table ponds add column cover_photo text');
  // ---------- end of the pond cover block ----------
  db.exec('create index if not exists ponds_farm on ponds (farm_id)');
  // Single-farm databases (before accounts): the old farm becomes farm 1 and owns every pond.
  const legacy = db.prepare("select name from sqlite_master where type = 'table' and name = 'farm'").get();
  if (legacy) {
    db.exec(`
      insert or ignore into farms (id, name, location_name, lat, lon, timezone)
        select id, name, location_name, lat, lon, timezone from farm;
      update ponds set farm_id = 1 where farm_id is null and exists (select 1 from farms where id = 1);
      drop table farm;
    `);
  }
  return db;
}

export type Db = ReturnType<typeof openDb>;

type Row = Record<string, unknown>;

const toPond = (r: Row): Pond => ({
  id: r.id as number,
  name: r.name as string,
  kind: r.kind as string | null,
  volumeL: r.volume_l as number | null,
  areaM2: r.area_m2 as number | null,
  setting: r.setting as Setting | null,
  shaded: r.shaded === null || r.shaded === undefined ? null : Boolean(r.shaded),
  aeration: r.aeration as Aeration | null,
  depthCm: r.depth_cm as number | null,
  waterColor: (r.water_color as Pond['waterColor']) ?? null,
  light: (r.light as Pond['light']) ?? null,
  cover: (r.cover_photo as string | null) ?? null,
  nicknames: r.nicknames ? (JSON.parse(r.nicknames as string) as string[]) : [],
});

const toBatch = (r: Row): Batch => ({
  id: r.id as number,
  pondId: r.pond_id as number,
  phase: r.phase as Phase,
  stockedAt: r.stocked_at as string,
  initialCount: r.initial_count as number | null,
});

const toLog = (r: Row): Log => ({
  id: r.id as number,
  pondId: r.pond_id as number,
  batchId: r.batch_id as number | null,
  loggedAt: r.logged_at as string,
  source: r.source as Log['source'],
  data: JSON.parse(r.data as string) as LogData,
});

/** A change to a log, for its history: who, when, and in plain words what. */
export interface StoredEdit {
  at: string;
  byUserId: number;
  text: string;
}

/** A log with who made it and what happened to it since. */
export interface LogRecord extends Log {
  createdBy: number | null;
  deletedAt: string | null;
  edits: StoredEdit[];
}

const toLogRecord = (r: Row): LogRecord => ({
  ...toLog(r),
  createdBy: r.created_by as number | null,
  deletedAt: r.deleted_at as string | null,
  edits: r.edits ? (JSON.parse(r.edits as string) as StoredEdit[]) : [],
});

const toFarm = (r: Row): Farm => ({
  name: r.name as string,
  locationName: r.location_name as string | null,
  lat: r.lat as number | null,
  lon: r.lon as number | null,
  timezone: r.timezone as string,
  powerBackup: (r.power_backup as Farm['powerBackup']) ?? null,
  adm4: (r.adm4 as string | null) ?? null,
});

const toOutage = (r: Row): Outage => ({
  id: r.id as number,
  startedAt: r.started_at as string,
  endedAt: r.ended_at as string | null,
  startedBy: r.started_by as number | null,
  endedBy: r.ended_by as number | null,
});

export interface CaseRow {
  id: number;
  pondId: number;
  status: 'open' | 'closed';
  openedAt: string;
  closedAt: string | null;
  closedBy: number | null;
}

const toCase = (r: Row): CaseRow => ({
  id: r.id as number,
  pondId: r.pond_id as number,
  status: r.status as CaseRow['status'],
  openedAt: r.opened_at as string,
  closedAt: r.closed_at as string | null,
  closedBy: r.closed_by as number | null,
});

/** Everything one farm sees. Every query is scoped to the farm, so one farm can never read another's ponds. */
export function farmRepo(db: Db, farmId: number) {
  const ownPond = (id: number) => db.prepare('select * from ponds where id = ? and farm_id = ? and archived = 0').get(id, farmId) as Row | undefined;
  return {
    farmId,

    getFarm(): Farm | null {
      const r = db.prepare('select * from farms where id = ?').get(farmId) as Row | undefined;
      return r ? toFarm(r) : null;
    },

    saveFarm(f: Farm) {
      db.prepare('update farms set name = ?, location_name = ?, lat = ?, lon = ?, timezone = ? where id = ?').run(f.name, f.locationName, f.lat, f.lon, f.timezone, farmId);
    },

    // ---------- power backup, BMKG region, power cuts (power.ts) ----------
    setPowerBackup(backup: Farm['powerBackup']) {
      db.prepare('update farms set power_backup = ? where id = ?').run(backup ?? null, farmId);
    },
    setAdm4(code: string | null) {
      db.prepare('update farms set adm4 = ? where id = ?').run(code, farmId);
    },
    /** The newest power cut that has not been closed, if any. */
    openOutage(): Outage | null {
      const r = db.prepare('select * from outages where farm_id = ? and ended_at is null order by started_at desc limit 1').get(farmId) as Row | undefined;
      return r ? toOutage(r) : null;
    },
    getOutage(id: number): Outage | null {
      const r = db.prepare('select * from outages where id = ? and farm_id = ?').get(id, farmId) as Row | undefined;
      return r ? toOutage(r) : null;
    },
    startOutage(at: string, userId: number | null): Outage {
      const id = Number(db.prepare('insert into outages (farm_id, started_at, started_by) values (?, ?, ?)').run(farmId, at, userId).lastInsertRowid);
      return this.getOutage(id)!;
    },
    moveOutageStart(id: number, at: string) {
      db.prepare('update outages set started_at = ? where id = ? and farm_id = ?').run(at, id, farmId);
    },
    endOutage(id: number, at: string, userId: number | null) {
      db.prepare('update outages set ended_at = ?, ended_by = ? where id = ? and farm_id = ? and ended_at is null').run(at, userId, id, farmId);
    },

    listPonds(): Pond[] {
      return (db.prepare('select * from ponds where farm_id = ? and archived = 0 order by id').all(farmId) as Row[]).map(toPond);
    },

    getPond(id: number): Pond | null {
      const r = ownPond(id);
      return r ? toPond(r) : null;
    },

    addPond(p: Omit<Pond, 'id' | 'nicknames'> & { nicknames?: string[] }): Pond {
      const nicknames = p.nicknames ?? [];
      const { lastInsertRowid } = db
        .prepare('insert into ponds (farm_id, name, kind, volume_l, area_m2, setting, shaded, aeration, depth_cm, nicknames, water_color, light) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(farmId, p.name, p.kind, p.volumeL, p.areaM2, p.setting, p.shaded === null ? null : Number(p.shaded), p.aeration, p.depthCm, JSON.stringify(nicknames), p.waterColor ?? null, p.light ?? null);
      return { id: Number(lastInsertRowid), ...p, waterColor: p.waterColor ?? null, light: p.light ?? null, nicknames };
    },

    updatePond(p: Pond) {
      db.prepare(
        'update ponds set name = ?, kind = ?, volume_l = ?, area_m2 = ?, setting = ?, shaded = ?, aeration = ?, depth_cm = ?, nicknames = ?, water_color = ?, light = ? where id = ? and farm_id = ?',
      ).run(p.name, p.kind, p.volumeL, p.areaM2, p.setting, p.shaded === null ? null : Number(p.shaded), p.aeration, p.depthCm, JSON.stringify(p.nicknames), p.waterColor ?? null, p.light ?? null, p.id, farmId);
    },

    // ---------- weekly pattern notes (patterns.ts) ----------
    savePattern(pondId: number, at: string, lang: string, source: string, body: unknown): number {
      return Number(db.prepare('insert into pond_patterns (farm_id, pond_id, created_at, lang, source, body) values (?, ?, ?, ?, ?, ?)').run(farmId, pondId, at, lang, source, JSON.stringify(body)).lastInsertRowid);
    },

    /** A pond's recent pattern notes, newest first. */
    patterns<T>(pondId: number): { lang: string; createdAt: string; source: string; body: T }[] {
      const rows = db.prepare('select * from pond_patterns where pond_id = ? and farm_id = ? order by id desc limit 20').all(pondId, farmId) as Row[];
      return rows.map((r) => ({ lang: r.lang as string, createdAt: r.created_at as string, source: r.source as string, body: JSON.parse(r.body as string) as T }));
    },

    /** When the farm last got pattern notes (any pond), and notes written since an instant (the daily allowance). */
    lastPatternAt(): string | null {
      return ((db.prepare('select max(created_at) as at from pond_patterns where farm_id = ?').get(farmId) as Row).at as string | null) ?? null;
    },
    patternRunsSince(sinceIso: string): number {
      return (db.prepare("select count(*) as n from pond_patterns where farm_id = ? and created_at >= ? and json_extract(body, '$.precomputed') is null").get(farmId, sinceIso) as Row).n as number;
    },

    /** The pond's cover picture (a coverStore key), or null for the pond icon. Profile saves leave it as it is. */
    setPondCover(id: number, key: string | null) {
      db.prepare('update ponds set cover_photo = ? where id = ? and farm_id = ?').run(key, id, farmId);
    },

    archivePond(id: number) {
      db.prepare('update ponds set archived = 1 where id = ? and farm_id = ?').run(id, farmId);
    },

    // The pond-level calls below take a pond id the caller already checked with getPond.
    activeBatch(pondId: number): Batch | null {
      const r = db
        .prepare('select * from batches where pond_id = ? and ended_at is null order by id desc limit 1')
        .get(pondId) as Row | undefined;
      return r ? toBatch(r) : null;
    },

    startBatch(b: Omit<Batch, 'id'>, today: string): Batch {
      db.prepare('update batches set ended_at = ? where pond_id = ? and ended_at is null').run(today, b.pondId);
      const { lastInsertRowid } = db
        .prepare('insert into batches (pond_id, phase, stocked_at, initial_count) values (?, ?, ?, ?)')
        .run(b.pondId, b.phase, b.stockedAt, b.initialCount);
      return { id: Number(lastInsertRowid), ...b };
    },

    /** `createdBy`: the person who recorded it; null only for logs from scripts. */
    addLog(l: Omit<Log, 'id'>, createdBy: number | null = null): Log {
      const { lastInsertRowid } = db
        .prepare('insert into logs (pond_id, batch_id, logged_at, source, data, created_by) values (?, ?, ?, ?, ?, ?)')
        .run(l.pondId, l.batchId, l.loggedAt, l.source, JSON.stringify(l.data), createdBy);
      return { id: Number(lastInsertRowid), ...l };
    },

    // Deleted logs stay in the table (they can be restored) but every reader below skips them.

    /** Logs for a pond since `sinceIso`, newest first. */
    logsSince(pondId: number, sinceIso: string): Log[] {
      return (
        db.prepare('select * from logs where pond_id = ? and logged_at >= ? and deleted_at is null order by logged_at desc').all(pondId, sinceIso) as Row[]
      ).map(toLog);
    },

    /** Same, with maker and edits, for the history screen. */
    historySince(pondId: number, sinceIso: string): LogRecord[] {
      return (
        db.prepare('select * from logs where pond_id = ? and logged_at >= ? and deleted_at is null order by logged_at desc, id desc').all(pondId, sinceIso) as Row[]
      ).map(toLogRecord);
    },

    /** Logs on any pond of this farm since `sinceIso`, newest first. */
    farmLogsSince(sinceIso: string): Log[] {
      return (
        db
          .prepare('select l.* from logs l join ponds p on p.id = l.pond_id where p.farm_id = ? and l.logged_at >= ? and l.deleted_at is null order by l.logged_at desc')
          .all(farmId, sinceIso) as Row[]
      ).map(toLog);
    },

    /** One log of this farm, deleted or not; null for another farm's log. */
    getLog(id: number): LogRecord | null {
      const r = db.prepare('select l.* from logs l join ponds p on p.id = l.pond_id where l.id = ? and p.farm_id = ?').get(id, farmId) as Row | undefined;
      return r ? toLogRecord(r) : null;
    },

    /** Saves a changed log (data, pond, batch, deleted) together with its edit trail. */
    saveLog(l: LogRecord) {
      db.prepare('update logs set pond_id = ?, batch_id = ?, data = ?, deleted_at = ?, edits = ? where id = ?').run(
        l.pondId,
        l.batchId,
        JSON.stringify(l.data),
        l.deletedAt,
        JSON.stringify(l.edits),
        l.id,
      );
    },

    // ---------- AI reads ----------
    aiUsage(localDate: string): { userId: number; used: number }[] {
      return (db.prepare('select user_id, used from ai_usage where farm_id = ? and local_date = ?').all(farmId, localDate) as Row[]).map((r) => ({
        userId: r.user_id as number,
        used: r.used as number,
      }));
    },

    countAiUse(userId: number, localDate: string) {
      db.prepare('insert into ai_usage (farm_id, user_id, local_date, used) values (?, ?, ?, 1) on conflict do update set used = used + 1').run(farmId, userId, localDate);
    },

    /** `kind` 'lang': the same evening in another language, made from briefing `basis`. Returns the row id. */
    saveBriefing(localDate: string, briefing: { lang?: string }, kind: 'lang' | null = null, basis: number | null = null): number {
      return Number(
        db
          .prepare('insert into briefings (farm_id, local_date, created_at, body, lang, kind, basis) values (?, ?, ?, ?, ?, ?, ?)')
          .run(farmId, localDate, new Date().toISOString(), JSON.stringify(briefing), briefing.lang ?? 'id', kind, basis).lastInsertRowid,
      );
    },

    /** Every briefing made on `localDate`, oldest first. */
    briefingRows<T>(localDate: string): { id: number; lang: string; kind: string | null; basis: number | null; body: T }[] {
      return (db.prepare('select * from briefings where farm_id = ? and local_date = ? order by id').all(farmId, localDate) as Row[]).map((r) => {
        const body = JSON.parse(r.body as string) as T & { lang?: string };
        return { id: r.id as number, lang: (r.lang as string | null) ?? body.lang ?? 'id', kind: r.kind as string | null, basis: r.basis as number | null, body };
      });
    },

    /** Newest briefing made on `localDate`, or null. */
    briefing<T>(localDate: string): T | null {
      const r = db.prepare('select body from briefings where farm_id = ? and local_date = ? order by id desc limit 1').get(farmId, localDate) as Row | undefined;
      return r ? (JSON.parse(r.body as string) as T) : null;
    },

    /** Briefings asked for on `localDate` (not counting other-language re-runs or demo copies), or of one kind. */
    briefingsOn(localDate: string, kind: 'lang' | null = null): number {
      return (db.prepare('select count(*) as n from briefings where farm_id = ? and local_date = ? and kind is ?').get(farmId, localDate, kind) as Row).n as number;
    },

    // ---------- dead-eel cases ----------
    /** The open case of a pond (of this farm), or null. */
    openCase(pondId: number): CaseRow | null {
      const r = db.prepare("select * from cases where pond_id = ? and farm_id = ? and status = 'open'").get(pondId, farmId) as Row | undefined;
      return r ? toCase(r) : null;
    },

    getCase(id: number): CaseRow | null {
      const r = db.prepare('select * from cases where id = ? and farm_id = ?').get(id, farmId) as Row | undefined;
      return r ? toCase(r) : null;
    },

    /** Open cases on live ponds, and (with a pond) that pond's closed ones too, newest first. */
    listCases(pondId?: number, closedLimit = 5): CaseRow[] {
      const open = (
        db.prepare("select c.* from cases c join ponds p on p.id = c.pond_id where c.farm_id = ? and c.status = 'open' and p.archived = 0 and (? is null or c.pond_id = ?) order by c.opened_at desc").all(farmId, pondId ?? null, pondId ?? null) as Row[]
      ).map(toCase);
      if (pondId === undefined) return open;
      const closed = (db.prepare("select * from cases where farm_id = ? and pond_id = ? and status = 'closed' order by closed_at desc limit ?").all(farmId, pondId, closedLimit) as Row[]).map(toCase);
      return [...open, ...closed];
    },

    openCaseFor(pondId: number, openedAt: string): CaseRow {
      const { lastInsertRowid } = db.prepare("insert into cases (farm_id, pond_id, status, opened_at) values (?, ?, 'open', ?)").run(farmId, pondId, openedAt);
      return { id: Number(lastInsertRowid), pondId, status: 'open', openedAt, closedAt: null, closedBy: null };
    },

    closeCase(id: number, at: string, userId: number) {
      db.prepare("update cases set status = 'closed', closed_at = ?, closed_by = ? where id = ? and farm_id = ?").run(at, userId, id, farmId);
    },

    // The case calls below take a case id the caller already checked with getCase / openCase.
    addCaseEvent(caseId: number, kind: string, at: string, userId: number | null, data: unknown) {
      db.prepare('insert into case_events (case_id, at, kind, user_id, data) values (?, ?, ?, ?, ?)').run(caseId, at, kind, userId, JSON.stringify(data));
    },

    caseEvents(caseId: number): { id: number; at: string; kind: string; userId: number | null; data: any }[] {
      return (db.prepare('select * from case_events where case_id = ? order by id').all(caseId) as Row[]).map((r) => ({
        id: r.id as number,
        at: r.at as string,
        kind: r.kind as string,
        userId: r.user_id as number | null,
        data: JSON.parse(r.data as string),
      }));
    },

    totalMortality(batchId: number): number {
      const rows = db.prepare('select data from logs where batch_id = ? and deleted_at is null').all(batchId) as Row[];
      return rows.reduce((sum, r) => sum + ((JSON.parse(r.data as string) as LogData).mortality ?? 0), 0);
    },
  };
}

export type FarmRepo = ReturnType<typeof farmRepo>;
export type Role = 'owner' | 'worker';
export interface User {
  id: number;
  phone: string;
  name: string;
}
export interface Member extends User {
  role: Role;
}

/** Farms, people and sessions. */
const DEMO_NAMES = new Set(['Petani Demo', 'Demo Farmer']);
/** A demo person (phone "demo…") with the default name shows it in the current language. */
const shownName = (r: Row) => (String(r.phone).startsWith('demo') && DEMO_NAMES.has(r.name as string) ? tx('Petani Demo', 'Demo Farmer') : (r.name as string));

export function repo(db: Db) {
  const now = () => new Date().toISOString();
  return {
    farm: (farmId: number) => farmRepo(db, farmId),
    /** Past weather days from the Open-Meteo archive (archive.ts). */
    weatherArchive: {
      days(location: string, dates: string[]) {
        const out = new Map<string, WeatherHour[]>();
        const get = db.prepare('select hours from weather_archive where location = ? and day = ?');
        for (const d of dates) {
          const r = get.get(location, d) as Row | undefined;
          if (r) out.set(d, JSON.parse(r.hours as string));
        }
        return out;
      },
      save(location: string, day: string, hours: WeatherHour[]) {
        db.prepare('insert or replace into weather_archive (location, day, hours) values (?, ?, ?)').run(location, day, JSON.stringify(hours));
      },
    },
    devices: deviceStore(db),
    demo: demoStore(db),

    createFarm(f: Farm, ownerId: number): number {
      const { lastInsertRowid } = db
        .prepare('insert into farms (name, location_name, lat, lon, timezone) values (?, ?, ?, ?, ?)')
        .run(f.name, f.locationName, f.lat, f.lon, f.timezone);
      const id = Number(lastInsertRowid);
      db.prepare('insert into memberships (user_id, farm_id, role) values (?, ?, ?)').run(ownerId, id, 'owner');
      return id;
    },

    farmIds(): number[] {
      return (db.prepare('select id from farms order by id').all() as Row[]).map((r) => r.id as number);
    },

    // ---------- users ----------
    createUser(u: { phone: string; name: string; pinHash: string }): User {
      const { lastInsertRowid } = db.prepare('insert into users (phone, name, pin_hash) values (?, ?, ?)').run(u.phone, u.name, u.pinHash);
      return { id: Number(lastInsertRowid), phone: u.phone, name: u.name };
    },

    // A "Coba demo" person keeps the default name in the language being shown, not the one at sign-in.
    userByPhone(phone: string): (User & { pinHash: string }) | null {
      const r = db.prepare('select * from users where phone = ?').get(phone) as Row | undefined;
      return r ? { id: r.id as number, phone: r.phone as string, name: shownName(r), pinHash: r.pin_hash as string } : null;
    },

    user(id: number): User | null {
      const r = db.prepare('select id, phone, name from users where id = ?').get(id) as Row | undefined;
      return r ? { id: r.id as number, phone: r.phone as string, name: shownName(r) } : null;
    },

    setPin(userId: number, pinHash: string) {
      db.prepare('update users set pin_hash = ? where id = ?').run(pinHash, userId);
      // A new PIN signs the person out everywhere else.
      db.prepare('delete from sessions where user_id = ?').run(userId);
    },

    // ---------- memberships ----------
    addMember(userId: number, farmId: number, role: Role) {
      db.prepare('insert into memberships (user_id, farm_id, role) values (?, ?, ?) on conflict do update set role = excluded.role').run(userId, farmId, role);
    },

    removeMember(userId: number, farmId: number) {
      db.prepare('delete from memberships where user_id = ? and farm_id = ?').run(userId, farmId);
      db.prepare('update sessions set farm_id = null where user_id = ? and farm_id = ?').run(userId, farmId);
    },

    role(userId: number, farmId: number): Role | null {
      const r = db.prepare('select role from memberships where user_id = ? and farm_id = ?').get(userId, farmId) as Row | undefined;
      return (r?.role as Role) ?? null;
    },

    farmsOf(userId: number): { id: number; name: string; role: Role }[] {
      return (
        db.prepare('select f.id, f.name, m.role from memberships m join farms f on f.id = m.farm_id where m.user_id = ? order by f.id').all(userId) as Row[]
      ).map((r) => ({ id: r.id as number, name: r.name as string, role: r.role as Role }));
    },

    members(farmId: number): Member[] {
      return (
        db.prepare('select u.id, u.phone, u.name, m.role from memberships m join users u on u.id = m.user_id where m.farm_id = ? order by m.role, u.name').all(farmId) as Row[]
      ).map((r) => ({ id: r.id as number, phone: r.phone as string, name: shownName(r), role: r.role as Role }));
    },

    // ---------- sessions ----------
    createSession(tokenHash: string, userId: number, farmId: number | null, days: number) {
      const created = new Date();
      db.prepare('insert into sessions (token_hash, user_id, farm_id, created_at, expires_at) values (?, ?, ?, ?, ?)').run(
        tokenHash,
        userId,
        farmId,
        created.toISOString(),
        new Date(created.getTime() + days * 86400_000).toISOString(),
      );
    },

    session(tokenHash: string): { userId: number; farmId: number | null } | null {
      const r = db.prepare('select user_id, farm_id from sessions where token_hash = ? and expires_at > ?').get(tokenHash, now()) as Row | undefined;
      return r ? { userId: r.user_id as number, farmId: r.farm_id as number | null } : null;
    },

    setSessionFarm(tokenHash: string, farmId: number) {
      db.prepare('update sessions set farm_id = ? where token_hash = ?').run(farmId, tokenHash);
    },

    deleteSession(tokenHash: string) {
      db.prepare('delete from sessions where token_hash = ?').run(tokenHash);
    },

    // ---------- invites ----------
    createInvite(i: { code: string; farmId: number; role: Role; createdBy: number; days: number }) {
      const created = new Date();
      db.prepare('insert into invites (code, farm_id, role, created_by, created_at, expires_at) values (?, ?, ?, ?, ?, ?)').run(
        i.code,
        i.farmId,
        i.role,
        i.createdBy,
        created.toISOString(),
        new Date(created.getTime() + i.days * 86400_000).toISOString(),
      );
    },

    /** An unused, unexpired invite. */
    invite(code: string): { farmId: number; role: Role; farmName: string } | null {
      const r = db
        .prepare('select i.farm_id, i.role, f.name from invites i join farms f on f.id = i.farm_id where i.code = ? and i.used_by is null and i.expires_at > ?')
        .get(code, now()) as Row | undefined;
      return r ? { farmId: r.farm_id as number, role: r.role as Role, farmName: r.name as string } : null;
    },

    /** Why a code does not work, for the right message: unknown, or already used / expired. */
    inviteProblem(code: string): 'missing' | 'spent' {
      return db.prepare('select 1 from invites where code = ?').get(code) ? 'spent' : 'missing';
    },

    useInvite(code: string, userId: number) {
      db.prepare('update invites set used_by = ?, used_at = ? where code = ?').run(userId, now(), code);
    },

    // ---------- support ----------
    /** `replyPhone` is '' when the reply goes to `replyEmail` instead. */
    addSupportTicket(t: { topic: string; message: string; replyPhone: string; replyEmail?: string | null; accountPhone: string | null; userId: number | null; farmId: number | null; device: string | null }): number {
      const { lastInsertRowid } = db
        .prepare('insert into support_tickets (created_at, topic, message, reply_phone, reply_email, account_phone, user_id, farm_id, device) values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(now(), t.topic, t.message, t.replyPhone, t.replyEmail ?? null, t.accountPhone, t.userId, t.farmId, t.device);
      return Number(lastInsertRowid);
    },

    supportTicket(id: number): { topic: string; message: string; replyPhone: string; userId: number | null; mailedAt: string | null } | null {
      const r = db.prepare('select * from support_tickets where id = ?').get(id) as Row | undefined;
      return r
        ? { topic: r.topic as string, message: r.message as string, replyPhone: r.reply_phone as string, userId: r.user_id as number | null, mailedAt: r.mailed_at as string | null }
        : null;
    },

    supportMailed(id: number) {
      db.prepare('update support_tickets set mailed_at = ? where id = ?').run(now(), id);
    },
  };
}

export type Repo = ReturnType<typeof repo>;
