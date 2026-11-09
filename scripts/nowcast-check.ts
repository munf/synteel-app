// Nowcast check: the night oxygen-risk forecast against what the farmer logged that night.
// For every pond and every evening, the forecast is made again as the app would have made it at 17.00
// (only the records before 17.00, past weather from the database's archive), then held against the
// records from 17.00 to 09.00 the next morning:
//   - water temperature readings vs the estimated water temperature at that hour;
//   - oxygen signs (eels surfacing or gathering at the inlet, dissolved oxygen under the warning limit)
//     vs the night's forecast peak (ok / warning / critical). Dead eels are counted apart: a few a day
//     are usual in a nursery and are not by themselves a sign of low oxygen.
// Plain arithmetic like the app's own nowcast: no model, no network. The database is never written:
// it is copied first, and only the copy is opened.
//
// Usage: node scripts/nowcast-check.ts --db <file.sqlite> [--farm <id>] [--days 30] [--json <out.json>]
// Only ids, pond names and counts are printed, never a farm's name or place.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { locationKey } from '../server/src/archive.ts';
import { openDb, repo } from '../server/src/db.ts';
import type { Log } from '../server/src/domain.ts';
import { knowledge } from '../server/src/knowledge.ts';
import { computeNowcast, type Nowcast, type RiskLevel } from '../server/src/nowcast.ts';
import type { Threshold } from '../server/src/rules.ts';
import type { WeatherHour } from '../server/src/weather.ts';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const thresholds = knowledge.thresholds.parameters as Threshold[];
/** Dissolved oxygen under this (mg/L) is an oxygen sign: the warning limit in knowledge/thresholds.json. */
const DO_WARNING = (thresholds.find((t) => t.id === 'do') as { warning?: { below?: number } } | undefined)?.warning?.below ?? 5;

export interface NightResult {
  pondId: number;
  /** Farm-local date of the evening. */
  night: string;
  peak: RiskLevel;
  /** Water temperature reading minus the estimate at that hour, °C; none without an estimate. */
  tempErrors: number[];
  /** Oxygen signs logged that night, e.g. "surfacing", "do 3.2". */
  signs: string[];
  /** Dead eels logged that night and the next morning. */
  dead: number;
  /** Records that night at all: a night with none says nothing either way. */
  records: number;
}

/** What one night's records say about oxygen. */
export function oxygenSigns(logs: Log[]): string[] {
  const out: string[] = [];
  for (const l of logs) {
    for (const b of l.data.behavior ?? []) if (b === 'surfacing' || b === 'gathering_inlet') out.push(b);
    const dox = l.data.readings?.do;
    if (dox !== undefined && dox < DO_WARNING) out.push(`do ${dox}`);
  }
  return out;
}

/** One forecast against the records of its night (17.00 to 09.00). */
export function scoreNight(nc: Nowcast, night: string, logs: Log[]): NightResult {
  const from = nc.generatedAt;
  const to = from + 16 * HOUR;
  const during = logs.filter((l) => Date.parse(l.loggedAt) > from && Date.parse(l.loggedAt) <= to);
  const tempErrors: number[] = [];
  for (const l of during) {
    const v = l.data.readings?.temperature;
    if (v === undefined) continue;
    const t = Date.parse(l.loggedAt);
    const near = nc.hours.filter((h) => h.temp !== null).sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0];
    if (near && Math.abs(near.t - t) <= HOUR) tempErrors.push(Math.round((v - near.temp!) * 100) / 100);
  }
  // The forecast's peak over the night itself, not the whole 24 hours ahead.
  const nightHours = nc.hours.filter((h) => h.t >= from && h.t <= to);
  const rank: Record<RiskLevel, number> = { ok: 0, warning: 1, critical: 2 };
  const peak = nightHours.reduce<RiskLevel>((p, h) => (rank[h.level] > rank[p] ? h.level : p), 'ok');
  return { pondId: nc.pondId, night, peak, tempErrors, signs: oxygenSigns(during), dead: during.reduce((a, l) => a + (l.data.mortality ?? 0), 0), records: during.length };
}

/** Nights with records, by forecast peak and whether an oxygen sign was logged; temperature error over all readings. */
export function summarizeNights(nights: NightResult[]) {
  const scored = nights.filter((n) => n.records > 0);
  const cell = (peak: RiskLevel, signs: boolean) => scored.filter((n) => n.peak === peak && n.signs.length > 0 === signs).length;
  const errors = scored.flatMap((n) => n.tempErrors);
  const abs = errors.map(Math.abs).sort((a, b) => a - b);
  return {
    nights: nights.length,
    nightsWithRecords: scored.length,
    table: (['ok', 'warning', 'critical'] as RiskLevel[]).map((peak) => {
      const of = scored.filter((n) => n.peak === peak);
      return { peak, signsLogged: cell(peak, true), noSigns: cell(peak, false), deadPerNight: of.length ? of.reduce((a, n) => a + n.dead, 0) / of.length : null };
    }),
    /** Signs logged on a night forecast "ok": the misses that matter most. */
    missed: scored.filter((n) => n.peak === 'ok' && n.signs.length).map((n) => `pond ${n.pondId} ${n.night}: ${n.signs.join(', ')}`),
    tempReadings: errors.length,
    tempMeanAbs: errors.length ? abs.reduce((a, b) => a + b, 0) / abs.length : null,
    tempP80: errors.length ? abs[Math.floor(0.8 * (abs.length - 1))] : null,
  };
}

/** Farm-local date and 17.00 of that date as an instant. */
const localDate = (t: number, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
function at17(date: string, tz: string) {
  const guess = Date.parse(`${date}T17:00:00Z`);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
  return guess - (Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`) - guess);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
  const file = opt('db');
  if (!file) throw new Error('usage: node scripts/nowcast-check.ts --db <file.sqlite> [--farm <id>] [--days 30] [--json <out.json>]');
  const days = Number(opt('days') ?? 30);
  // A copy, so the farm's database is never changed (openDb adds tables and columns).
  const dir = mkdtempSync(join(tmpdir(), 'nowcast-check-'));
  const copy = join(dir, 'copy.sqlite');
  const src = new DatabaseSync(file, { readOnly: true });
  src.exec(`vacuum into '${copy.replace(/'/g, "''")}'`);
  src.close();
  const db = openDb(copy);
  const store = repo(db);
  const now = Date.now();
  const farmIds = opt('farm') ? [Number(opt('farm'))] : (db.prepare('select id from farms order by id').all() as { id: number }[]).map((r) => r.id);
  const all: NightResult[] = [];
  for (const farmId of farmIds) {
    const r = store.farm(farmId);
    const farm = r.getFarm();
    if (!farm) continue;
    const tz = farm.timezone || 'Asia/Jakarta';
    // Past weather only from the archive cached in the database: no network here.
    const utcDates = Array.from({ length: days + 4 }, (_, i) => new Date(now - (days + 3 - i) * DAY).toISOString().slice(0, 10));
    const weather: WeatherHour[] = farm.lat != null && farm.lon != null ? [...store.weatherArchive.days(locationKey(farm.lat, farm.lon), utcDates).values()].flat().sort((a, b) => a.t - b.t) : [];
    const farmNights: NightResult[] = [];
    for (const pond of r.listPonds()) {
      const logs = r.logsSince(pond.id, new Date(now - (days + 8) * DAY).toISOString());
      if (!logs.length) continue;
      const phase = r.activeBatch(pond.id)?.phase;
      for (let d = days; d >= 1; d--) {
        const night = localDate(now - d * DAY, tz);
        const t = at17(night, tz);
        if (t + 16 * HOUR > now) continue;
        const before = logs.filter((l) => Date.parse(l.loggedAt) <= t && t - Date.parse(l.loggedAt) <= 7 * DAY);
        const nc = computeNowcast({ pond, phase, logs: before, weather, thresholds, now: t, timezone: tz });
        farmNights.push(scoreNight(nc, night, logs));
      }
    }
    const s = summarizeNights(farmNights);
    all.push(...farmNights);
    if (!s.nightsWithRecords) continue;
    console.log(`Farm ${farmId}: ${s.nightsWithRecords} of ${s.nights} pond-nights have records; weather ${weather.length ? `${weather.length} archived hours` : 'none archived'}`);
  }
  const s = summarizeNights(all);
  console.log(`\nAll: ${s.nightsWithRecords} pond-nights with records (of ${s.nights}) over the last ${days} days`);
  console.log('Forecast peak   oxygen sign logged   no sign logged   dead eels per night');
  for (const row of s.table) console.log(`${row.peak.padEnd(15)} ${String(row.signsLogged).padStart(18)}   ${String(row.noSigns).padStart(14)}   ${row.deadPerNight === null ? 'n/a' : row.deadPerNight.toFixed(1)}`);
  for (const m of s.missed.slice(0, 10)) console.log(`  sign on an "ok" night: ${m}`);
  if (s.missed.length > 10) console.log(`  … and ${s.missed.length - 10} more (--json)`);
  console.log(`Water temperature: ${s.tempReadings} night readings${s.tempMeanAbs === null ? '' : `, mean error ${s.tempMeanAbs.toFixed(2)} °C, 80% within ${s.tempP80!.toFixed(2)} °C`}`);
  if (opt('json')) writeFileSync(opt('json')!, JSON.stringify({ days, summary: s, nights: all.filter((n) => n.records > 0) }, null, 2) + '\n');
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
