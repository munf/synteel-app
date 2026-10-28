import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { Aeration, Batch, Farm, Log, LogData, Phase, Pond, Setting } from './domain.ts';

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
  `);
  // Databases created before these pond columns existed.
  const pondCols = (db.prepare('pragma table_info(ponds)').all() as { name: string }[]).map((c) => c.name);
  for (const [col, type] of [['area_m2', 'real'], ['setting', 'text'], ['shaded', 'integer'], ['aeration', 'text'], ['depth_cm', 'real'], ['farm_id', 'integer references farms(id)']]) {
    if (!pondCols.includes(col)) db.exec(`alter table ponds add column ${col} ${type}`);
  }
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

const toFarm = (r: Row): Farm => ({
  name: r.name as string,
  locationName: r.location_name as string | null,
  lat: r.lat as number | null,
  lon: r.lon as number | null,
  timezone: r.timezone as string,
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

    listPonds(): Pond[] {
      return (db.prepare('select * from ponds where farm_id = ? and archived = 0 order by id').all(farmId) as Row[]).map(toPond);
    },

    getPond(id: number): Pond | null {
      const r = ownPond(id);
      return r ? toPond(r) : null;
    },

    addPond(p: Omit<Pond, 'id'>): Pond {
      const { lastInsertRowid } = db
        .prepare('insert into ponds (farm_id, name, kind, volume_l, area_m2, setting, shaded, aeration, depth_cm) values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(farmId, p.name, p.kind, p.volumeL, p.areaM2, p.setting, p.shaded === null ? null : Number(p.shaded), p.aeration, p.depthCm);
      return { id: Number(lastInsertRowid), ...p };
    },

    updatePond(p: Pond) {
      db.prepare(
        'update ponds set name = ?, kind = ?, volume_l = ?, area_m2 = ?, setting = ?, shaded = ?, aeration = ?, depth_cm = ? where id = ? and farm_id = ?',
      ).run(p.name, p.kind, p.volumeL, p.areaM2, p.setting, p.shaded === null ? null : Number(p.shaded), p.aeration, p.depthCm, p.id, farmId);
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

    addLog(l: Omit<Log, 'id'>): Log {
      const { lastInsertRowid } = db
        .prepare('insert into logs (pond_id, batch_id, logged_at, source, data) values (?, ?, ?, ?, ?)')
        .run(l.pondId, l.batchId, l.loggedAt, l.source, JSON.stringify(l.data));
      return { id: Number(lastInsertRowid), ...l };
    },

    /** Logs for a pond since `sinceIso`, newest first. */
    logsSince(pondId: number, sinceIso: string): Log[] {
      return (
        db.prepare('select * from logs where pond_id = ? and logged_at >= ? order by logged_at desc').all(pondId, sinceIso) as Row[]
      ).map(toLog);
    },

    totalMortality(batchId: number): number {
      const rows = db.prepare('select data from logs where batch_id = ?').all(batchId) as Row[];
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
export function repo(db: Db) {
  const now = () => new Date().toISOString();
  return {
    farm: (farmId: number) => farmRepo(db, farmId),

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

    userByPhone(phone: string): (User & { pinHash: string }) | null {
      const r = db.prepare('select * from users where phone = ?').get(phone) as Row | undefined;
      return r ? { id: r.id as number, phone: r.phone as string, name: r.name as string, pinHash: r.pin_hash as string } : null;
    },

    user(id: number): User | null {
      const r = db.prepare('select id, phone, name from users where id = ?').get(id) as Row | undefined;
      return r ? { id: r.id as number, phone: r.phone as string, name: r.name as string } : null;
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
      ).map((r) => ({ id: r.id as number, phone: r.phone as string, name: r.name as string, role: r.role as Role }));
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

    useInvite(code: string, userId: number) {
      db.prepare('update invites set used_by = ?, used_at = ? where code = ?').run(userId, now(), code);
    },
  };
}

export type Repo = ReturnType<typeof repo>;
