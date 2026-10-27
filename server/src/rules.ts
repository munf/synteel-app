// Deterministic risk rules. This layer never calls a language model, so alerts keep
// working when the AI API is slow, down or out of credit.
import { DAY_MS, type Finding, type Level, type Log, type LogData, type Phase } from './domain.ts';

interface Bound { below?: number; above?: number }
interface Limits {
  target: { min?: number; max?: number } | null;
  warning: Bound | null;
  critical: Bound | null;
  source?: string;
}
export interface Threshold extends Limits {
  id: string;
  name: string;
  unit: string;
  scope: string;
  operator_action?: string;
  /** Phase-specific limits that replace the default ones, e.g. partner-farm practice for elvers. */
  by_phase?: Partial<Record<Phase, Limits>>;
}

/** What the rules know about the pond beyond its logs. */
export interface PondContext {
  phase?: Phase;
  /** Estimated live eels per m² of pond floor. */
  density?: number;
}

type ReadingKey = keyof NonNullable<LogData['readings']>;

const THRESHOLD_SOURCE = 'Ambang Blueprint Synt Nursery v5';
const HEURISTIC_SOURCE = 'Heuristik Synt Eel (perlu validasi)';
const PARTNER_SOURCE = 'Praktik petani mitra Sleman';
const LOW_DO_SOURCE = 'Penanganan darurat Blueprint Synt Nursery v5 (DO rendah)';

const fmt = (n: number) => n.toLocaleString('id-ID', { maximumFractionDigits: 2 });

function breaches(bound: Bound | null, value: number): boolean {
  if (!bound) return false;
  return (bound.below !== undefined && value < bound.below) || (bound.above !== undefined && value > bound.above);
}

function latestReading(logs: Log[], key: ReadingKey, since: number) {
  for (const log of logs) {
    const value = log.data.readings?.[key];
    if (value !== undefined && Date.parse(log.loggedAt) >= since) return { value, at: log.loggedAt };
  }
  return null;
}

/** Limits for a parameter, preferring phase-specific ones. */
export function limitsFor(t: Threshold, phase?: Phase): Limits {
  return (phase && t.by_phase?.[phase]) || t;
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Assess one pond from its recent logs.
 * `logs` must be sorted newest first and should cover at least the last 7 days.
 */
export function assessPond(logs: Log[], thresholds: Threshold[], now: Date, ctx: PondContext = {}): Finding[] {
  const findings: Finding[] = [];
  const last24h = now.getTime() - DAY_MS;
  const recent = logs.filter((l) => Date.parse(l.loggedAt) >= last24h);

  // 1. Fixed thresholds on the latest reading of each parameter.
  //    Phase-specific limits win over the defaults.
  for (const t of thresholds) {
    if (t.scope !== 'general') continue;
    const limits = limitsFor(t, ctx.phase);
    if (!limits.warning && !limits.critical) continue;
    const reading = latestReading(logs, t.id as ReadingKey, last24h);
    if (!reading) continue;
    const level = breaches(limits.critical, reading.value) ? 'critical' : breaches(limits.warning, reading.value) ? 'warning' : null;
    if (!level) continue;
    findings.push({
      id: `threshold:${t.id}`,
      level,
      title: `${t.name} ${level === 'critical' ? 'kritis' : 'di luar batas'}: ${fmt(reading.value)} ${t.unit}`.trim(),
      detail: describeBounds(limits, t.unit),
      actions: t.operator_action ? [t.operator_action] : [],
      source: limits.source ?? `${THRESHOLD_SOURCE} (${t.id})`,
    });
  }

  // 2. Behaviour that points to low dissolved oxygen. Most farms have no DO meter,
  //    so this is often the earliest signal available.
  const behaviors = new Set(recent.flatMap((l) => l.data.behavior ?? []));
  if (behaviors.has('surfacing') || behaviors.has('gathering_inlet')) {
    const signs = [behaviors.has('surfacing') && 'naik ke permukaan', behaviors.has('gathering_inlet') && 'berkumpul di inlet']
      .filter(Boolean)
      .join(' dan ');
    const temp = latestReading(logs, 'temperature', last24h);
    findings.push({
      id: 'sign:low_do',
      level: 'critical',
      title: 'Kemungkinan oksigen (DO) rendah',
      detail:
        `Sidat terlihat ${signs}.` +
        (temp && temp.value > 28 ? ` Suhu ${fmt(temp.value)} °C ikut menurunkan oksigen terlarut.` : ''),
      actions: ['Cek aerator, diffuser dan selang udara', 'Tambah aerasi atau oksigen darurat', 'Tunda pemberian pakan'],
      source: LOW_DO_SOURCE,
    });
  }
  // The farmer looked at the aerator. With 24-hour aeration, a failed aerator is the
  // fastest way to lose a batch.
  const aeration = recent.find((l) => l.data.aeration)?.data.aeration;
  if (aeration === 'off' || aeration === 'weak') {
    findings.push({
      id: 'aeration',
      level: aeration === 'off' ? 'critical' : 'warning',
      title: aeration === 'off' ? 'Aerator mati' : 'Aerasi lemah',
      detail: aeration === 'off' ? 'Tanpa aerasi, oksigen di kolam padat bisa habis dalam hitungan jam.' : 'Gelembung sedikit: cek selang, batu aerasi dan blower.',
      actions: ['Nyalakan aerator cadangan atau oksigen darurat', 'Cek listrik, blower dan selang udara', 'Tunda pemberian pakan'],
      source: LOW_DO_SOURCE,
    });
  }
  if (behaviors.has('not_eating')) {
    findings.push({
      id: 'sign:not_eating',
      level: 'warning',
      title: 'Nafsu makan turun',
      detail: 'Sidat tidak mau makan dalam 24 jam terakhir.',
      actions: ['Kurangi porsi pakan berikutnya', 'Ukur suhu dan pH', 'Amati tanda stres lain'],
      source: HEURISTIC_SOURCE,
    });
  }

  // 3. Deaths reported in the last 24 hours.
  const dead = recent.reduce((sum, l) => sum + (l.data.mortality ?? 0), 0);
  if (dead > 0) {
    findings.push({
      id: 'mortality',
      level: 'warning',
      title: `${dead} ekor mati dalam 24 jam`,
      detail: 'Angkat sidat mati segera dan perhatikan apakah jumlahnya naik.',
      actions: ['Angkat dan catat sidat mati', 'Ukur suhu dan pH', 'Periksa tanda oksigen rendah'],
      source: HEURISTIC_SOURCE,
    });
  }

  // 4. Uneaten feed for two days running means organic load is building up.
  const muchLeftoverDays = new Set(
    logs
      .filter((l) => Date.parse(l.loggedAt) >= now.getTime() - 2 * DAY_MS && l.data.feeding?.leftover === 'much')
      .map((l) => Math.floor((now.getTime() - Date.parse(l.loggedAt)) / DAY_MS)),
  );
  if (muchLeftoverDays.size >= 2) {
    findings.push({
      id: 'feed:leftover',
      level: 'warning',
      title: 'Sisa pakan banyak 2 hari berturut-turut',
      detail: 'Pakan yang tidak termakan membusuk dan menaikkan amonia serta memakan oksigen.',
      actions: ['Kurangi porsi pakan', 'Buang sisa pakan', 'Pertimbangkan ganti air sebagian'],
      source: HEURISTIC_SOURCE,
    });
  }

  // 5. Foul smell suggests decaying organic matter.
  if (recent.some((l) => l.data.water?.smell === 'foul')) {
    findings.push({
      id: 'water:smell',
      level: 'warning',
      title: 'Air berbau busuk',
      detail: 'Bau busuk menandakan bahan organik membusuk; amonia bisa naik.',
      actions: ['Buang kotoran dan sisa pakan', 'Ganti air sebagian', 'Uji amonia bila ada test kit'],
      source: HEURISTIC_SOURCE,
    });
  }

  // 6. TDS has no absolute threshold yet, so compare against the pond's own baseline.
  const tdsNow = latestReading(logs, 'tds', last24h);
  const tdsBaseline = logs
    .filter((l) => {
      const age = now.getTime() - Date.parse(l.loggedAt);
      return age >= DAY_MS && age <= 7 * DAY_MS && l.data.readings?.tds !== undefined;
    })
    .map((l) => l.data.readings!.tds!);
  if (tdsNow && tdsBaseline.length >= 3) {
    const base = median(tdsBaseline);
    const change = (tdsNow.value - base) / base;
    if (Math.abs(change) >= 0.25) {
      findings.push({
        id: 'tds:shift',
        level: 'warning',
        title: `TDS berubah ${change > 0 ? 'naik' : 'turun'} ${Math.round(Math.abs(change) * 100)}%`,
        detail: `TDS ${fmt(tdsNow.value)} ppm dibanding biasanya ±${fmt(base)} ppm. Perubahan mendadak membuat sidat stres.`,
        actions: ['Ulangi pengukuran', 'Cek sumber air dan hujan masuk', 'Koreksi bertahap, jangan mendadak'],
        source: HEURISTIC_SOURCE,
      });
    }
  }

  // 7. Overcrowded elver ponds: more competition for oxygen and feed, and more cannibalism.
  if (ctx.phase === 'elver' && ctx.density !== undefined && ctx.density > 100) {
    findings.push({
      id: 'stocking:density',
      level: 'warning',
      title: `Kolam terlalu padat: ±${Math.round(ctx.density)} ekor/m²`,
      detail: 'Ideal 40–60 ekor/m², maksimal 100. Kolam padat lebih cepat kekurangan oksigen dan memicu kanibalisme.',
      actions: ['Pindahkan sebagian sidat ke kolam lain', 'Sortir berdasarkan ukuran', 'Pastikan aerasi cukup'],
      source: PARTNER_SOURCE,
    });
  }

  // 8. Nothing measured today.
  if (!recent.some((l) => l.data.readings && Object.keys(l.data.readings).length > 0)) {
    findings.push({
      id: 'stale',
      level: 'info',
      title: 'Belum ada pengukuran hari ini',
      detail: 'Catat suhu, pH dan TDS agar risiko bisa dinilai.',
      actions: ['Ukur dan catat suhu, pH, TDS'],
      source: 'SOP harian Blueprint Synt Nursery v5',
    });
  }

  const order: Record<Level, number> = { critical: 0, warning: 1, info: 2, ok: 3 };
  return findings.sort((a, b) => order[a.level] - order[b.level]);
}

export function overallLevel(findings: Finding[]): Level {
  if (findings.some((f) => f.level === 'critical')) return 'critical';
  if (findings.some((f) => f.level === 'warning')) return 'warning';
  if (findings.some((f) => f.level === 'info')) return 'info';
  return 'ok';
}

function describeBounds(t: Limits, unitName: string): string {
  const range = (b: Bound | null) =>
    [b?.below !== undefined && `di bawah ${fmt(b.below)}`, b?.above !== undefined && `di atas ${fmt(b.above)}`].filter(Boolean).join(' atau ');
  const unit = unitName ? ` ${unitName}` : '';
  const parts: string[] = [];
  if (t.target?.min !== undefined && t.target?.max !== undefined) parts.push(`Target ${fmt(t.target.min)}–${fmt(t.target.max)}${unit}.`);
  else if (t.target?.min !== undefined) parts.push(`Target minimal ${fmt(t.target.min)}${unit}.`);
  else if (t.target?.max !== undefined) parts.push(`Target maksimal ${fmt(t.target.max)}${unit}.`);
  if (t.warning) parts.push(`Perhatian bila ${range(t.warning)}${unit}.`);
  if (t.critical) parts.push(`Bahaya bila ${range(t.critical)}${unit}.`);
  return parts.join(' ');
}
