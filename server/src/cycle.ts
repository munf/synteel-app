// Cycle summary: one glass eel → elver batch from stocking to sorting or harvest, built only from what
// the app already records (logs, dead-eel reports, re-checks) plus two counts the farmer enters: how
// many were stocked and how many were counted at sorting or harvest.
//
// Survival is worked out only when both counts were entered. It is compared with the 20–40% the partner
// farmer reported from memory (no records were ever kept), so that baseline is always called
// "farmer-reported", never a measured figure. Plain arithmetic, no model.
import { assessPond, classifyReading, limitsFor, type Threshold } from './rules.ts';
import { DAY_MS, localDate, type Batch, type Log, type ReadingKey } from './domain.ts';
import type { FarmRepo } from './db.ts';

/** Survival from glass eel to elver as the partner farmer reported it (2 Nov 2026 visit): not measured. */
export const FARMER_REPORTED_SURVIVAL = { low: 0.2, high: 0.4, source: 'farmer-reported' } as const;
/** A new check on the pond within this long after a danger reading answers the alarm. */
export const ALARM_ANSWER_MS = 2 * 3600_000;
/** Danger readings closer together than this are one alarm, not several (a sensor sends every few minutes). */
const ALARM_EPISODE_MS = 2 * 3600_000;
/** Night checks: 18.00 to 06.00 farm time. A night is named by the date it starts on. */
const NIGHT_FROM = 18;
const NIGHT_TO = 6;

export type CountKind = 'sorting' | 'harvest';
export interface BatchCount {
  id: number;
  batchId: number;
  /** YYYY-MM-DD, farm-local. */
  countedOn: string;
  count: number;
  kind: CountKind;
}

export interface CycleInput {
  batch: Batch & { endedAt?: string | null };
  /** The batch's logs (any order); deleted ones already left out. */
  logs: Log[];
  counts: BatchCount[];
  /** Dead-eel re-checks asked in this batch's time on the pond (cases.ts), and whether each was answered. */
  rechecks?: { at: string; answered: boolean }[];
  thresholds: Threshold[];
  timezone: string;
  now: Date;
}

export interface CycleSummary {
  batchId: number;
  pondId: number;
  phase: Batch['phase'];
  stockedAt: string;
  /** The day the cycle ended (harvest count, or the batch closed), or null while it runs. */
  endedOn: string | null;
  stockedCount: number | null;
  /** Calendar days from the stocking day (day 1) to today or the end. */
  days: number;
  /** Checks by people: sensor readings are not counted. */
  logs: number;
  logsPerDay: number;
  daysLogged: number;
  /** Nights (18.00–06.00) with at least one check by a person, of the nights that have passed. */
  nights: { covered: number; total: number };
  /** Every reading the rules have limits for: inside the warning limits or past them; danger = past the danger limit. */
  readings: { inRange: number; outOfRange: number; danger: number };
  /** Danger readings or signs, and dead-eel re-checks; answered = a check followed in time. */
  alarms: { raised: number; answered: number };
  deaths: { total: number; reports: number };
  /** The newest sorting or harvest count. */
  count: { on: string; count: number; kind: CountKind } | null;
  /** counted ÷ stocked, 0–1; null without both counts. */
  survival: number | null;
  /** Why there is no survival figure. */
  survivalMissing: 'stocked' | 'count' | 'count_above_stocked' | null;
  baseline: { low: number; high: number; source: 'farmer-reported'; vs: 'below' | 'within' | 'above' | null };
}

const READING_KEYS: ReadingKey[] = ['temperature', 'ph', 'tds', 'do', 'tan', 'no2'];
const hourAt = (iso: string, tz: string) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date(iso)));
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const dayDiff = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** The night a check falls in (named by its first date), or null for a daytime check. */
export function nightOf(iso: string, tz: string): string | null {
  const h = hourAt(iso, tz);
  const day = localDate(new Date(iso), tz);
  if (h >= NIGHT_FROM) return day;
  if (h < NIGHT_TO) return shift(day, -1);
  return null;
}

export function cycleSummary(input: CycleInput): CycleSummary {
  const { batch, thresholds, timezone: tz, now } = input;
  const latest = [...input.counts].sort((a, b) => a.countedOn.localeCompare(b.countedOn) || a.id - b.id).at(-1) ?? null;
  const harvest = input.counts.filter((c) => c.kind === 'harvest').sort((a, b) => a.countedOn.localeCompare(b.countedOn)).at(-1);
  const endedOn = harvest?.countedOn ?? input.batch.endedAt ?? null;
  const today = localDate(now, tz);
  const lastDay = endedOn && endedOn < today ? endedOn : today;
  const days = Math.max(1, dayDiff(batch.stockedAt, lastDay) + 1);

  // Checks by people inside the cycle, oldest first.
  const end = Date.parse(`${shift(lastDay, 1)}T00:00:00Z`) + DAY_MS; // generous: the farm zone is ahead of UTC
  const logs = [...input.logs].sort((a, b) => a.loggedAt.localeCompare(b.loggedAt));
  const checks = logs.filter((l) => l.source !== 'sensor' && localDate(new Date(l.loggedAt), tz) >= batch.stockedAt && Date.parse(l.loggedAt) < end);
  const daysLogged = new Set(checks.map((l) => localDate(new Date(l.loggedAt), tz))).size;

  // Nights that have fully passed: from the stocking night to the night before the last day
  // (an ended cycle) or before today (tonight is still running, or has not started).
  const lastNight = shift(lastDay, -1);
  const totalNights = Math.max(0, dayDiff(batch.stockedAt, lastNight) + 1);
  const coveredNights = new Set(
    checks.map((l) => nightOf(l.loggedAt, tz)).filter((n): n is string => n !== null && n >= batch.stockedAt && n <= lastNight),
  ).size;

  // Every reading against the phase's limits.
  let inRange = 0;
  let outOfRange = 0;
  let danger = 0;
  for (const l of logs) {
    for (const key of READING_KEYS) {
      const v = l.data.readings?.[key];
      const t = thresholds.find((x) => x.id === key);
      if (v === undefined || !t) continue;
      const lim = limitsFor(t, batch.phase);
      if (!lim.warning && !lim.critical && !lim.target) continue;
      const level = classifyReading(v, lim);
      if (level === 'critical') (danger++, outOfRange++);
      else if (level === 'warning') outOfRange++;
      else inRange++;
    }
  }

  // Alarms: a log the rules rate as danger (a reading past the danger limit, eels at the surface, aerator off).
  // Danger logs close together are one alarm; it is answered when a person checks the pond again in time.
  let raised = 0;
  let answered = 0;
  let episodeEnd = -Infinity;
  for (const l of logs) {
    const at = Date.parse(l.loggedAt);
    const level = assessPond([l], thresholds, new Date(at), { phase: batch.phase }).filter((f) => f.id !== 'stale').some((f) => f.level === 'critical');
    if (!level) continue;
    if (at <= episodeEnd) {
      episodeEnd = at + ALARM_EPISODE_MS;
      continue;
    }
    episodeEnd = at + ALARM_EPISODE_MS;
    raised++;
    if (checks.some((c) => c.id !== l.id && Date.parse(c.loggedAt) > at && Date.parse(c.loggedAt) <= at + ALARM_ANSWER_MS)) answered++;
  }
  for (const r of input.rechecks ?? []) {
    raised++;
    if (r.answered) answered++;
  }

  const total = logs.reduce((s, l) => s + (l.data.mortality ?? 0), 0);
  const reports = logs.filter((l) => (l.data.mortality ?? 0) > 0).length;

  const stocked = batch.initialCount && batch.initialCount > 0 ? batch.initialCount : null;
  let survival: number | null = null;
  let survivalMissing: CycleSummary['survivalMissing'] = null;
  if (stocked === null) survivalMissing = 'stocked';
  else if (!latest) survivalMissing = 'count';
  else if (latest.count > stocked) survivalMissing = 'count_above_stocked';
  else survival = latest.count / stocked;
  const { low, high, source } = FARMER_REPORTED_SURVIVAL;

  return {
    batchId: batch.id,
    pondId: batch.pondId,
    phase: batch.phase,
    stockedAt: batch.stockedAt,
    endedOn,
    stockedCount: stocked,
    days,
    logs: checks.length,
    logsPerDay: Math.round((checks.length / days) * 10) / 10,
    daysLogged,
    nights: { covered: coveredNights, total: totalNights },
    readings: { inRange, outOfRange, danger },
    alarms: { raised, answered },
    deaths: { total, reports },
    count: latest ? { on: latest.countedOn, count: latest.count, kind: latest.kind } : null,
    survival,
    survivalMissing,
    baseline: { low, high, source, vs: survival === null ? null : survival < low ? 'below' : survival > high ? 'above' : 'within' },
  };
}

/**
 * One batch of a farm, from the database: its logs, counts, and the dead-eel re-checks of the pond's
 * cases opened while the batch ran.
 */
export function summarizeBatch(r: FarmRepo, batch: Batch & { endedAt: string | null }, thresholds: Threshold[], now: Date): CycleSummary {
  const tz = r.getFarm()?.timezone ?? 'Asia/Jakarta';
  const rechecks: { at: string; answered: boolean }[] = [];
  for (const k of r.listCases(batch.pondId, 100)) {
    const day = localDate(new Date(k.openedAt), tz);
    if (day < batch.stockedAt || (batch.endedAt && day > batch.endedAt)) continue;
    const events = r.caseEvents(k.id);
    for (const e of events.filter((e) => (e.kind === 'open' || e.kind === 'report') && e.data?.recheck)) {
      rechecks.push({ at: e.at, answered: events.some((x) => x.kind === 'recheck' && x.at >= e.at) });
    }
  }
  return cycleSummary({ batch, logs: r.batchLogs(batch.id), counts: r.batchCounts(batch.id), rechecks, thresholds, timezone: tz, now });
}

// ---------- export for the team (admin dashboard) ----------

/** One row per batch: the fields of the summary, flat, with the baseline's label in the column name. */
export const CYCLE_CSV_COLUMNS = [
  'farm', 'pond', 'batch', 'phase', 'stocked_at', 'ended_on', 'stocked_count', 'days', 'logs', 'logs_per_day', 'days_logged',
  'nights_covered', 'nights_total', 'readings_in_range', 'readings_out_of_range', 'readings_danger', 'alarms_raised', 'alarms_answered',
  'deaths_recorded', 'death_reports', 'count_on', 'count', 'count_kind', 'survival_pct', 'baseline_farmer_reported_pct', 'survival_vs_farmer_reported',
] as const;

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV of cycle summaries; `farm` and `pond` are the labels the caller chose (no owner names, no places). */
export function cycleCsv(rows: { farm: string; pond: string; s: CycleSummary }[]): string {
  const lines = rows.map(({ farm, pond, s }) =>
    [
      farm, pond, s.batchId, s.phase, s.stockedAt, s.endedOn, s.stockedCount, s.days, s.logs, s.logsPerDay, s.daysLogged,
      s.nights.covered, s.nights.total, s.readings.inRange, s.readings.outOfRange, s.readings.danger, s.alarms.raised, s.alarms.answered,
      s.deaths.total, s.deaths.reports, s.count?.on, s.count?.count, s.count?.kind, s.survival === null ? null : Math.round(s.survival * 1000) / 10,
      `${s.baseline.low * 100}-${s.baseline.high * 100}`, s.baseline.vs,
    ]
      .map(csvCell)
      .join(','),
  );
  return [CYCLE_CSV_COLUMNS.join(','), ...lines].join('\n') + '\n';
}
