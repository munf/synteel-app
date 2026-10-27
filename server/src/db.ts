import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { Batch, Farm, Log, LogData, Phase, Pond } from './domain.ts';

const defaultPath = fileURLToPath(new URL('../../data/synteel.sqlite', import.meta.url));

export function openDb(path = process.env.SYNTEEL_DB ?? defaultPath) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    pragma journal_mode = wal;
    pragma foreign_keys = on;

    create table if not exists farm (
      id integer primary key check (id = 1),
      name text not null,
      location_name text,
      lat real,
      lon real,
      timezone text not null default 'Asia/Jakarta'
    );

    create table if not exists ponds (
      id integer primary key,
      name text not null,
      kind text,
      volume_l real,
      area_m2 real,
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
  // Databases created before area_m2 existed.
  const pondCols = (db.prepare('pragma table_info(ponds)').all() as { name: string }[]).map((c) => c.name);
  if (!pondCols.includes('area_m2')) db.exec('alter table ponds add column area_m2 real');
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

export function repo(db: Db) {
  return {
    getFarm(): Farm | null {
      const r = db.prepare('select * from farm where id = 1').get() as Row | undefined;
      if (!r) return null;
      return {
        name: r.name as string,
        locationName: r.location_name as string | null,
        lat: r.lat as number | null,
        lon: r.lon as number | null,
        timezone: r.timezone as string,
      };
    },

    saveFarm(f: Farm) {
      db.prepare(
        `insert into farm (id, name, location_name, lat, lon, timezone) values (1, ?, ?, ?, ?, ?)
         on conflict (id) do update set name = excluded.name, location_name = excluded.location_name,
           lat = excluded.lat, lon = excluded.lon, timezone = excluded.timezone`,
      ).run(f.name, f.locationName, f.lat, f.lon, f.timezone);
    },

    listPonds(): Pond[] {
      return (db.prepare('select * from ponds where archived = 0 order by id').all() as Row[]).map(toPond);
    },

    getPond(id: number): Pond | null {
      const r = db.prepare('select * from ponds where id = ? and archived = 0').get(id) as Row | undefined;
      return r ? toPond(r) : null;
    },

    addPond(p: Omit<Pond, 'id'>): Pond {
      const { lastInsertRowid } = db
        .prepare('insert into ponds (name, kind, volume_l, area_m2) values (?, ?, ?, ?)')
        .run(p.name, p.kind, p.volumeL, p.areaM2);
      return { id: Number(lastInsertRowid), ...p };
    },

    archivePond(id: number) {
      db.prepare('update ponds set archived = 1 where id = ?').run(id);
    },

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

export type Repo = ReturnType<typeof repo>;
