// "Coba demo": every tap gets its own copy of a template demo farm, so visitors (the hackathon judges)
// never share caps or see each other's changes.
//
// The template is built from the seed below (three ponds, two weeks of records, the open Kolam B
// dead-eel case) and carries precomputed AI results: the case update and the evening briefing, in
// Indonesian and English. A copy shifts every date by whole days so the template's day becomes the
// visitor's today (WIB), keeps anything that would land in the future at "just now", and keeps the
// AI results, so the first screens show AI output at once without a model call per visitor.
// Copies are deleted after DEMO_TTL_MS by a cleanup job; a cap per address and on live copies stops abuse.
import { createHash } from 'node:crypto';
import { DAY_MS, localDate, type LogData } from './domain.ts';
import type { Db, Repo } from './db.ts';
import { simulate, thermalParams } from './nowcast.ts';
import type { WeatherHour } from './weather.ts';

/** Demo copies are deleted this long after they were made. */
export const DEMO_TTL_MS = 48 * 3600_000;
/** New demo copies one address may make per 24 hours. */
export const DEMO_PER_IP_PER_DAY = 20;
/** Demo copies alive at once on one server. */
export const DEMO_MAX_LIVE = 150;

type Row = Record<string, unknown>;
export type DemoKind = 'template' | 'copy' | 'building';

export const ipKey = (ip: string) => createHash('sha256').update(`synteel-demo:${ip}`).digest('hex').slice(0, 32);

const shiftDate = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** Midnight of `date` in `tz`, as an instant. */
function dayStart(date: string, tz: string): number {
  const guess = Date.parse(`${date}T00:00:00Z`);
  const wall = Date.parse(`${new Date(guess).toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T')}Z`);
  return guess - (wall - guess);
}

export function demoStore(db: Db) {
  db.exec(`
    -- Demo farms: the template "Coba demo" copies, and the copies themselves (deleted after expires_at).
    create table if not exists demo_farms (
      farm_id integer primary key references farms(id),
      user_id integer not null references users(id),
      kind text not null check (kind in ('template', 'copy', 'building')),
      created_at text not null,
      expires_at text,
      ip_key text,
      built_on text
    );
    create index if not exists demo_farms_kind on demo_farms (kind, created_at);
  `);

  const tx = <T>(fn: () => T): T => {
    db.exec('begin');
    try {
      const out = fn();
      db.exec('commit');
      return out;
    } catch (err) {
      db.exec('rollback');
      throw err;
    }
  };

  /** Removes a farm and everything in it. People stay, minus their membership. */
  function deleteFarm(farmId: number) {
    const ponds = `(select id from ponds where farm_id = ${Number(farmId)})`;
    db.prepare(`delete from case_events where case_id in (select id from cases where farm_id = ?)`).run(farmId);
    db.prepare('delete from cases where farm_id = ?').run(farmId);
    db.prepare('delete from device_links where farm_id = ?').run(farmId);
    db.exec(`delete from logs where pond_id in ${ponds}`);
    db.exec(`delete from batches where pond_id in ${ponds}`);
    db.prepare('delete from ponds where farm_id = ?').run(farmId);
    db.prepare('delete from briefings where farm_id = ?').run(farmId);
    db.prepare('delete from outages where farm_id = ?').run(farmId);
    db.prepare('delete from ai_usage where farm_id = ?').run(farmId);
    db.prepare('delete from invites where farm_id = ?').run(farmId);
    db.prepare('delete from sessions where farm_id = ?').run(farmId);
    db.prepare('delete from memberships where farm_id = ?').run(farmId);
    db.prepare('update support_tickets set farm_id = null where farm_id = ?').run(farmId);
    db.prepare('delete from demo_farms where farm_id = ?').run(farmId);
    db.prepare('delete from farms where id = ?').run(farmId);
  }

  /** Removes a demo person; anything of theirs left on other farms loses its maker. */
  function deleteUser(userId: number) {
    db.prepare('update logs set created_by = null where created_by = ?').run(userId);
    db.prepare('update case_events set user_id = null where user_id = ?').run(userId);
    db.prepare('update cases set closed_by = null where closed_by = ?').run(userId);
    db.prepare('update invites set used_by = null where used_by = ?').run(userId);
    db.prepare('delete from invites where created_by = ?').run(userId);
    db.prepare('update support_tickets set user_id = null where user_id = ?').run(userId);
    db.prepare('delete from ai_usage where user_id = ?').run(userId);
    db.prepare('delete from memberships where user_id = ?').run(userId);
    db.prepare('delete from sessions where user_id = ?').run(userId);
    db.prepare('delete from users where id = ?').run(userId);
  }

  return {
    /** The ready template: its farm, owner and the farm day its data is anchored to. */
    template(): { farmId: number; userId: number; builtOn: string } | null {
      const r = db.prepare("select * from demo_farms where kind = 'template' order by farm_id desc limit 1").get() as Row | undefined;
      return r ? { farmId: r.farm_id as number, userId: r.user_id as number, builtOn: r.built_on as string } : null;
    },

    kindOf(farmId: number): DemoKind | null {
      const r = db.prepare('select kind from demo_farms where farm_id = ?').get(farmId) as Row | undefined;
      return (r?.kind as DemoKind) ?? null;
    },

    /** A person made by "Coba demo" (not the template's owner). */
    isDemoUser(userId: number): boolean {
      return Boolean(db.prepare("select 1 from demo_farms where user_id = ? and kind = 'copy'").get(userId));
    },

    /** A template still being built: not used for copies until markTemplate. */
    markBuilding(farmId: number, userId: number, builtOn: string, now: Date) {
      db.prepare("insert into demo_farms (farm_id, user_id, kind, created_at, built_on) values (?, ?, 'building', ?, ?)").run(farmId, userId, now.toISOString(), builtOn);
    },

    /** Makes a built farm the template and deletes the previous template (and unfinished builds). */
    markTemplate(farmId: number) {
      tx(() => {
        const old = db.prepare("select farm_id from demo_farms where kind in ('template', 'building') and farm_id != ?").all(farmId) as Row[];
        for (const o of old) deleteFarm(o.farm_id as number);
        db.prepare("update demo_farms set kind = 'template' where farm_id = ?").run(farmId);
      });
    },

    /** Copies made from one address in the 24 hours before `now`, and copies alive now. */
    counts(ip: string, now: Date): { fromIp: number; live: number } {
      const since = new Date(now.getTime() - DAY_MS).toISOString();
      const fromIp = (db.prepare("select count(*) as n from demo_farms where kind = 'copy' and ip_key = ? and created_at >= ?").get(ipKey(ip), since) as Row).n as number;
      const live = (db.prepare("select count(*) as n from demo_farms where kind = 'copy' and expires_at > ?").get(now.toISOString()) as Row).n as number;
      return { fromIp, live };
    },

    /**
     * A fresh person and farm copied from the template. Every instant moves by whole days so the
     * template's farm day becomes today's; instants that then lie ahead of `now` are put just before
     * it (never before today began). AI results keep their pond, log and event references.
     */
    copyTemplate(t: { farmId: number; builtOn: string }, user: { phone: string; name: string; pinHash: string }, now: Date, ip: string): { userId: number; farmId: number } {
      return tx(() => {
        const farm = db.prepare('select * from farms where id = ?').get(t.farmId) as Row;
        const tz = farm.timezone as string;
        const today = localDate(now, tz);
        const days = daysBetween(t.builtOn, today);
        const shift = days * DAY_MS;
        const latest = Math.max(now.getTime() - 20 * 60_000, dayStart(today, tz));
        const at = (iso: string) => {
          const ms = Date.parse(iso) + shift;
          return new Date(ms > now.getTime() ? Math.min(latest, ms) : ms).toISOString();
        };

        const userId = Number(db.prepare('insert into users (phone, name, pin_hash) values (?, ?, ?)').run(user.phone, user.name, user.pinHash).lastInsertRowid);
        const farmId = Number(
          db.prepare('insert into farms (name, location_name, lat, lon, timezone, created_at) values (?, ?, ?, ?, ?, ?)').run(farm.name as string, farm.location_name as string | null, farm.lat as number | null, farm.lon as number | null, tz, now.toISOString()).lastInsertRowid,
        );
        db.prepare("insert into memberships (user_id, farm_id, role) values (?, ?, 'owner')").run(userId, farmId);
        db.prepare("insert into demo_farms (farm_id, user_id, kind, created_at, expires_at, ip_key) values (?, ?, 'copy', ?, ?, ?)").run(
          farmId,
          userId,
          now.toISOString(),
          new Date(now.getTime() + DEMO_TTL_MS).toISOString(),
          ipKey(ip),
        );

        const pondMap = new Map<number, number>();
        const batchMap = new Map<number, number>();
        const logMap = new Map<number, number>();
        const eventMap = new Map<number, number>();
        const briefingMap = new Map<number, number>();
        // AI results reference ponds, logs and events by id and carry times: rebase all of them.
        const rebase = (v: any, key = ''): any => {
          if (Array.isArray(v)) return v.map((x) => rebase(x));
          if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rebase(x, k)]));
          if (typeof v !== 'number') return v;
          if (key === 'pondId' || key === 'pond_id') return pondMap.get(v) ?? v;
          if (key === 'logId') return logMap.get(v) ?? v;
          if (key === 'basis') return eventMap.get(v) ?? briefingMap.get(v) ?? v;
          if (key === 'generatedAt') return Math.min(v + shift, now.getTime());
          if (key === 't' || key === 'dueAt') return v + shift;
          return v;
        };

        for (const p of db.prepare('select * from ponds where farm_id = ? and archived = 0 order by id').all(t.farmId) as Row[]) {
          const id = db
            .prepare('insert into ponds (farm_id, name, kind, volume_l, area_m2, setting, shaded, aeration, depth_cm, nicknames) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(farmId, p.name as string, p.kind as string | null, p.volume_l as number | null, p.area_m2 as number | null, p.setting as string | null, p.shaded as number | null, p.aeration as string | null, p.depth_cm as number | null, p.nicknames as string | null).lastInsertRowid;
          pondMap.set(p.id as number, Number(id));
        }
        const pondIds = [...pondMap.keys()].join(',') || '0';
        for (const b of db.prepare(`select * from batches where pond_id in (${pondIds}) order by id`).all() as Row[]) {
          const id = db
            .prepare('insert into batches (pond_id, phase, stocked_at, initial_count, ended_at) values (?, ?, ?, ?, ?)')
            .run(pondMap.get(b.pond_id as number)!, b.phase as string, shiftDate(b.stocked_at as string, days), b.initial_count as number | null, b.ended_at ? shiftDate(b.ended_at as string, days) : null).lastInsertRowid;
          batchMap.set(b.id as number, Number(id));
        }
        for (const l of db.prepare(`select * from logs where pond_id in (${pondIds}) and deleted_at is null order by logged_at, id`).all() as Row[]) {
          const id = db
            .prepare('insert into logs (pond_id, batch_id, logged_at, source, data, created_by) values (?, ?, ?, ?, ?, ?)')
            .run(pondMap.get(l.pond_id as number)!, l.batch_id === null ? null : (batchMap.get(l.batch_id as number) ?? null), at(l.logged_at as string), l.source as string, l.data as string, l.created_by === null ? null : userId).lastInsertRowid;
          logMap.set(l.id as number, Number(id));
        }
        for (const c of db.prepare("select * from cases where farm_id = ? and status = 'open' order by id").all(t.farmId) as Row[]) {
          const caseId = Number(db.prepare("insert into cases (farm_id, pond_id, status, opened_at) values (?, ?, 'open', ?)").run(farmId, pondMap.get(c.pond_id as number)!, at(c.opened_at as string)).lastInsertRowid);
          for (const e of db.prepare('select * from case_events where case_id = ? order by id').all(c.id as number) as Row[]) {
            const data = rebase(JSON.parse(e.data as string));
            // Precomputed results do not count towards the visitor's own agent runs.
            if (e.kind === 'run') data.precomputed = true;
            const id = db.prepare('insert into case_events (case_id, at, kind, user_id, data) values (?, ?, ?, ?, ?)').run(caseId, at(e.at as string), e.kind as string, e.user_id === null ? null : userId, JSON.stringify(data)).lastInsertRowid;
            eventMap.set(e.id as number, Number(id));
          }
        }
        for (const b of db.prepare('select * from briefings where farm_id = ? and local_date = ? order by id').all(t.farmId, t.builtOn) as Row[]) {
          const id = db
            .prepare('insert into briefings (farm_id, local_date, created_at, body, lang, kind, basis) values (?, ?, ?, ?, ?, ?, ?)')
            .run(farmId, today, at(b.created_at as string), JSON.stringify(rebase(JSON.parse(b.body as string))), b.lang as string | null, b.kind === 'lang' ? 'lang' : 'copy', b.basis === null ? null : (briefingMap.get(b.basis as number) ?? null)).lastInsertRowid;
          briefingMap.set(b.id as number, Number(id));
        }
        return { userId, farmId };
      });
    },

    /** Demo copies past their time. */
    expired(now: Date): { farmId: number; userId: number }[] {
      return (db.prepare("select farm_id, user_id from demo_farms where kind = 'copy' and expires_at <= ?").all(now.toISOString()) as Row[]).map((r) => ({ farmId: r.farm_id as number, userId: r.user_id as number }));
    },

    /** Deletes a demo copy with its person (and that person's other demo copies' links). */
    deleteCopy(farmId: number, userId: number) {
      tx(() => {
        deleteFarm(farmId);
        if (!db.prepare('select 1 from demo_farms where user_id = ?').get(userId)) deleteUser(userId);
      });
    },

    deleteFarm: (farmId: number) => tx(() => deleteFarm(farmId)),
  };
}

export type DemoStore = ReturnType<typeof demoStore>;

// ---------- the template's data ----------

/**
 * Seeds the demo farm "Tambak Sidat Mitra" owned by `ownerId`: three ponds with two weeks of
 * records up to `now`, and Kolam B's dead-eel case (rising today, re-check answered "not better"
 * yesterday). `weather`: real hourly weather so the outdoor pond follows actual days and nights;
 * null gives synthetic values. Returns the farm id.
 */
export function seedDemoFarm(store: Repo, ownerId: number, now: Date, weather: Map<number, WeatherHour> | null): number {
  const tz = 'Asia/Jakarta';
  const daysAgo = (d: number) => localDate(new Date(now.getTime() - d * DAY_MS), tz);
  // Deterministic pseudo-random so every build gives the same demo.
  let seed = 42;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const around = (base: number, spread: number, digits = 1) => Number((base + (rand() - 0.5) * 2 * spread).toFixed(digits));

  const farm = { name: 'Tambak Sidat Mitra', locationName: 'Sleman, Yogyakarta', lat: -7.72, lon: 110.36, timezone: tz };
  const farmId = store.createFarm(farm, ownerId);
  const r = store.farm(farmId);

  const ponds = [
    // Glass eels in indoor fiber tanks.
    { pond: r.addPond({ name: 'Kolam A', kind: 'fiber', volumeL: 870, areaM2: 2.9, setting: 'indoor', shaded: null, aeration: 'full', depthCm: 30 }), phase: 'glass_eel' as const, stocked: 23, count: 500 },
    // Farmers call it by where it is; the voice round knows both names.
    { pond: r.addPond({ name: 'Kolam B', kind: 'fiber', volumeL: 870, areaM2: 2.9, setting: 'indoor', shaded: null, aeration: 'full', depthCm: 30, nicknames: ['kolam dekat pintu'] }), phase: 'glass_eel' as const, stocked: 23, count: 500 },
    // Elver pond as the partner farm runs it: outdoor, paranet, 24-hour aeration, 30 cm deep, about 50 eels per m².
    { pond: r.addPond({ name: 'Kolam C', kind: 'beton', volumeL: 3600, areaM2: 12, setting: 'outdoor', shaded: true, aeration: 'full', depthCm: 30 }), phase: 'elver' as const, stocked: 60, count: 650 },
  ];

  const caseLogs: { id: number; pondId: number; loggedAt: string; data: LogData }[] = [];
  for (const { pond, phase, stocked, count } of ponds) {
    // Outdoor water temperature: the nowcast model run through the real weather, with the
    // concrete pond about 3 °C warmer than air plus sun alone would make it.
    let water = 29;
    let waterAt = weather ? Math.min(...weather.keys()) : 0;
    const waterTemp = (at: Date) => {
      if (!weather || pond.setting !== 'outdoor' || at.getTime() < waterAt) return null;
      const next = simulate(weather, thermalParams(pond), 3, waterAt, water, at.getTime());
      if (next === null) return null;
      water = next;
      waterAt = at.getTime();
      return around(next, 0.2);
    };
    const batch = r.startBatch({ pondId: pond.id, phase, stockedAt: daysAgo(stocked), initialCount: count }, daysAgo(stocked));
    for (let d = 14; d >= 0; d--) {
      for (const hour of [7, 17]) {
        // The farm's own (WIB) day, not the UTC one: seeded between 00:00 and 07:00 WIB the UTC date is
        // still yesterday, which put "today's" dead eels on yesterday and turned the demo case to "Turun".
        const at = new Date(`${daysAgo(d)}T${String(hour).padStart(2, '0')}:15:00+07:00`);
        // Today's logs may still be in the future: record them as "just now", but never before today began.
        if (at > now) at.setTime(Math.max(now.getTime() - 20 * 60 * 1000, Date.parse(`${daysAgo(0)}T00:00:00+07:00`)));
        const data: LogData = {
          readings: {
            // Glass eels follow the Blueprint range (27–28 °C); elvers the partner farm's (28–31 °C, pH 6.8–7.6).
            temperature: phase === 'elver' ? (waterTemp(at) ?? around(29.2, 0.6)) : around(27.6, 0.4),
            ph: phase === 'elver' ? around(7.2, 0.15, 2) : around(7.4, 0.15, 2),
            tds: Math.round(around(phase === 'elver' ? 160 : 140, 12, 0)),
          },
          feeding: { leftover: rand() < 0.8 ? 'none' : 'little' },
          behavior: ['normal'],
          ...(hour === 17 && { aeration: 'on' as const }),
        };
        if (rand() < 0.25) data.mortality = 1 + Math.floor(rand() * 3);
        // Kolam B drifts into trouble over the last two days: warmer water, uneaten feed, eels surfacing.
        if (pond.name === 'Kolam B' && d <= 1) {
          data.readings!.temperature = around(29.4 + (1 - d) * 0.6, 0.2);
          data.feeding = { leftover: 'much' };
          if (d === 0 && hour === 17) data.behavior = ['surfacing'];
        }
        // ...and eels start dying: 3 found yesterday evening (a report from Masalah), 6 this morning.
        if (pond.name === 'Kolam B' && d <= 1 && hour === 17) data.mortality = d === 1 ? 3 : undefined;
        if (pond.name === 'Kolam B' && d === 0 && hour === 7) data.mortality = 6;
        const log = r.addLog({ pondId: pond.id, batchId: batch.id, loggedAt: at.toISOString(), source: 'manual', data }, ownerId);
        if (pond.name === 'Kolam B' && ((d === 1 && hour === 17) || (d === 0 && hour === 7))) caseLogs.push(log);
      }
    }
  }

  // The dead-eel case those reports opened: rising today, re-check answered "not better" yesterday.
  const [opening, morning] = caseLogs;
  if (opening && morning) {
    const c = r.openCaseFor(opening.pondId, opening.loggedAt);
    r.addCaseEvent(c.id, 'open', opening.loggedAt, ownerId, { dead: opening.data.mortality, logId: opening.id, recheck: true });
    const recheckAt = new Date(Date.parse(opening.loggedAt) + 65 * 60_000).toISOString();
    r.addCaseEvent(c.id, 'recheck', recheckAt, ownerId, { better: false, more: 0 });
    r.addCaseEvent(c.id, 'report', morning.loggedAt, ownerId, { dead: morning.data.mortality, logId: morning.id, recheck: false });
  }
  return farmId;
}
