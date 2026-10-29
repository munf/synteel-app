// Deterministic risk rules. This layer never calls a language model, so alerts keep
// working when the AI API is slow, down or out of credit.
import { DAY_MS, type Finding, type Level, type Log, type LogData, type Phase } from './domain.ts';
import { currentLang, dec, tx } from './i18n.ts';

interface Bound { below?: number; above?: number }
export interface Limits {
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

const THRESHOLD_SOURCE = () => tx('Ambang Blueprint Synt Nursery v5', 'Synt Nursery v5 blueprint thresholds');
const HEURISTIC_SOURCE = () => tx('Heuristik Synt Eel (perlu validasi)', 'Synt Eel heuristics (to be validated)');
const PARTNER_SOURCE = () => tx('Praktik petani mitra Sleman', 'Partner farmer practice, Sleman');
const LOW_DO_SOURCE = () => tx('Penanganan darurat Blueprint Synt Nursery v5 (DO rendah)', 'Synt Nursery v5 blueprint emergency handling (low DO)');

const fmt = (n: number) => dec(n, 2);

// English for the names, actions and sources that come from knowledge/thresholds.json (Indonesian there).
const NAME_EN: Record<string, string> = {
  do: 'Dissolved oxygen (DO)', temperature: 'Pond temperature', ph: 'pH', tan: 'Ammonia (TAN)', no2: 'Nitrite (NO₂)',
  no3: 'Nitrate (NO₃)', turbidity: 'Turbidity', co2: 'Dissolved CO₂', salinity: 'EC / salinity', tds: 'TDS',
};
const ACTION_EN: Record<string, string> = {
  do: 'Check the aerator, air stones and air hoses; do not feed yet.',
  temperature: 'Check the heater or cooler capacity and the room conditions.',
  ph: 'Check the buffer and the water source; measure again.',
  tan: 'Feed less, add zeolite, check the biofilter.',
  no2: 'Lower the feed load; check how the biofilter is working.',
  no3: 'Change part of the water.',
  turbidity: 'Remove leftover feed and dirt; check the filter.',
  co2: 'Add aeration.',
  salinity: 'Correct slowly with salt or fresh water; no sudden changes.',
  tds: 'Measure again; check the water source; change part of the water slowly with settled water.',
};
const SOURCE_EN: Record<string, string> = {
  'Praktik petani mitra Sleman': 'Partner farmer practice, Sleman',
  'Praktik petani mitra Sleman; batas bahaya: Blueprint v5 (bawah) dan heuristik Synt Eel (atas, perlu validasi)':
    'Partner farmer practice, Sleman; danger limits: Blueprint v5 (low) and Synt Eel heuristics (high, to be validated)',
  'Praktik petani mitra Sleman; batas bahaya: Blueprint v5': 'Partner farmer practice, Sleman; danger limits: Blueprint v5',
};
const en = () => currentLang() === 'en';
/** A threshold's name, action and source in the asked language. */
// Farmers read these titles: no abbreviations in brackets ("Oksigen terlarut (DO) kolam" → "Oksigen terlarut kolam").
const plainName = (s: string) => s.replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
export const thresholdName = (t: Threshold) => plainName(en() ? (NAME_EN[t.id] ?? t.name) : t.name);
const thresholdAction = (t: Threshold) => (en() ? (ACTION_EN[t.id] ?? t.operator_action) : t.operator_action);
export const sourceText = (s: string) => (en() ? (SOURCE_EN[s] ?? s) : s);

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

/**
 * Where one reading sits against its limits: 'info' means outside the target range
 * but not yet at a warning. Used for the word shown next to each number.
 */
export function classifyReading(value: number, l: Limits): Level {
  const out = (b: Bound | null) => !!b && ((b.below !== undefined && value < b.below) || (b.above !== undefined && value > b.above));
  if (out(l.critical)) return 'critical';
  if (out(l.warning)) return 'warning';
  const t = l.target;
  if (t && ((t.min !== undefined && value < t.min) || (t.max !== undefined && value > t.max))) return 'info';
  return 'ok';
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
      title: `${thresholdName(t)} ${level === 'critical' ? tx('kritis', 'critical') : tx('di luar batas', 'out of range')}: ${fmt(reading.value)} ${t.unit}`.trim(),
      detail: describeBounds(limits, t.unit),
      actions: t.operator_action ? [thresholdAction(t)!] : [],
      source: limits.source ? sourceText(limits.source) : `${THRESHOLD_SOURCE()} (${t.id})`,
    });
  }

  // 2. Behaviour that points to low dissolved oxygen. Most farms have no DO meter,
  //    so this is often the earliest signal available.
  const behaviors = new Set(recent.flatMap((l) => l.data.behavior ?? []));
  if (behaviors.has('surfacing') || behaviors.has('gathering_inlet')) {
    const signs = [behaviors.has('surfacing') && tx('naik ke permukaan', 'rising to the surface'), behaviors.has('gathering_inlet') && tx('berkumpul di air masuk', 'crowding at the water inlet')]
      .filter(Boolean)
      .join(tx(' dan ', ' and '));
    const temp = latestReading(logs, 'temperature', last24h);
    findings.push({
      id: 'sign:low_do',
      level: 'critical',
      title: tx('Kemungkinan oksigen air rendah', 'Possibly low oxygen in the water'),
      detail:
        tx(`Sidat terlihat ${signs}.`, `Eels seen ${signs}.`) +
        (temp && temp.value > 28 ? tx(` Suhu ${fmt(temp.value)} °C ikut menurunkan oksigen terlarut.`, ` A temperature of ${fmt(temp.value)} °C also lowers dissolved oxygen.`) : ''),
      actions: [
        tx('Cek aerator, batu aerasi dan selang udara', 'Check the aerator, air stones and air hoses'),
        tx('Nyalakan aerator cadangan atau oksigen darurat kalau ada', 'Turn on a spare aerator or emergency oxygen if you have one'),
        tx('Jangan beri pakan dulu sampai sidat berenang normal', 'Do not feed until the eels swim normally'),
      ],
      source: LOW_DO_SOURCE(),
    });
  }
  // The farmer looked at the aerator. With 24-hour aeration, a failed aerator is the
  // fastest way to lose a batch.
  const aeration = recent.find((l) => l.data.aeration)?.data.aeration;
  if (aeration === 'off' || aeration === 'weak') {
    findings.push({
      id: 'aeration',
      level: aeration === 'off' ? 'critical' : 'warning',
      title: aeration === 'off' ? tx('Aerator mati', 'Aerator off') : tx('Aerasi lemah', 'Weak aeration'),
      detail:
        aeration === 'off'
          ? tx('Tanpa aerasi, oksigen di kolam padat bisa habis dalam hitungan jam.', 'Without aeration, oxygen in a crowded pond can run out within hours.')
          : tx('Gelembung sedikit: cek selang, batu aerasi dan blower.', 'Few bubbles: check the hoses, air stones and blower.'),
      actions: [
        tx('Nyalakan aerator cadangan atau oksigen darurat', 'Turn on a spare aerator or emergency oxygen'),
        tx('Cek listrik, blower dan selang udara', 'Check the power, blower and air hoses'),
        tx('Tunda pemberian pakan', 'Hold off feeding'),
      ],
      source: LOW_DO_SOURCE(),
    });
  }
  if (behaviors.has('not_eating')) {
    findings.push({
      id: 'sign:not_eating',
      level: 'warning',
      title: tx('Nafsu makan turun', 'Eating less'),
      detail: tx('Sidat tidak mau makan dalam 24 jam terakhir.', 'The eels would not eat in the last 24 hours.'),
      actions: [tx('Kurangi porsi pakan berikutnya', 'Give a smaller next feed'), tx('Ukur suhu dan pH', 'Measure temperature and pH'), tx('Amati tanda stres lain', 'Watch for other signs of stress')],
      source: HEURISTIC_SOURCE(),
    });
  }

  // 3. Deaths reported in the last 24 hours.
  const dead = recent.reduce((sum, l) => sum + (l.data.mortality ?? 0), 0);
  if (dead > 0) {
    findings.push({
      id: 'mortality',
      level: 'warning',
      title: tx(`${dead} ekor mati dalam 24 jam`, `${dead} ${dead === 1 ? 'eel' : 'eels'} dead in 24 hours`),
      detail: tx('Angkat sidat mati segera dan perhatikan apakah jumlahnya naik.', 'Remove dead eels right away and watch whether the number goes up.'),
      actions: [tx('Angkat dan catat sidat mati', 'Remove and record the dead eels'), tx('Ukur suhu dan pH', 'Measure temperature and pH'), tx('Periksa tanda oksigen rendah', 'Look for signs of low oxygen')],
      source: HEURISTIC_SOURCE(),
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
      title: tx('Sisa pakan banyak 2 hari berturut-turut', 'Lots of leftover feed 2 days in a row'),
      detail: tx('Pakan yang tidak termakan membusuk dan menaikkan amonia serta memakan oksigen.', 'Uneaten feed rots, raises ammonia and uses up oxygen.'),
      actions: [tx('Kurangi porsi pakan', 'Feed less'), tx('Buang sisa pakan', 'Remove leftover feed'), tx('Pertimbangkan ganti air sebagian', 'Consider changing part of the water')],
      source: HEURISTIC_SOURCE(),
    });
  }

  // 5. Foul smell suggests decaying organic matter.
  if (recent.some((l) => l.data.water?.smell === 'foul')) {
    findings.push({
      id: 'water:smell',
      level: 'warning',
      title: tx('Air berbau busuk', 'Water smells foul'),
      detail: tx('Bau busuk menandakan bahan organik membusuk; amonia bisa naik.', 'A foul smell means organic matter is rotting; ammonia can rise.'),
      actions: [tx('Buang kotoran dan sisa pakan', 'Remove dirt and leftover feed'), tx('Ganti air sebagian', 'Change part of the water'), tx('Uji amonia bila ada test kit', 'Test ammonia if you have a test kit')],
      source: HEURISTIC_SOURCE(),
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
        title: tx(`TDS berubah ${change > 0 ? 'naik' : 'turun'} ${Math.round(Math.abs(change) * 100)}%`, `TDS ${change > 0 ? 'up' : 'down'} ${Math.round(Math.abs(change) * 100)}%`),
        detail: tx(
          `TDS ${fmt(tdsNow.value)} ppm dibanding biasanya ±${fmt(base)} ppm. Perubahan mendadak membuat sidat stres.`,
          `TDS ${fmt(tdsNow.value)} ppm compared with about ${fmt(base)} ppm usually. Sudden changes stress the eels.`,
        ),
        actions: [tx('Ulangi pengukuran', 'Measure again'), tx('Cek sumber air dan hujan masuk', 'Check the water source and rain coming in'), tx('Koreksi bertahap, jangan mendadak', 'Correct slowly, not all at once')],
        source: HEURISTIC_SOURCE(),
      });
    }
  }

  // 7. Overcrowded elver ponds: more competition for oxygen and feed, and more cannibalism.
  if (ctx.phase === 'elver' && ctx.density !== undefined && ctx.density > 100) {
    findings.push({
      id: 'stocking:density',
      level: 'warning',
      title: tx(`Kolam terlalu padat: ±${Math.round(ctx.density)} ekor/m²`, `Pond too crowded: about ${Math.round(ctx.density)} eels/m²`),
      detail: tx(
        'Ideal 40–60 ekor/m², maksimal 100. Kolam padat lebih cepat kekurangan oksigen dan memicu kanibalisme.',
        'Ideal is 40–60 eels/m², 100 at most. A crowded pond runs short of oxygen sooner and leads to cannibalism.',
      ),
      actions: [tx('Pindahkan sebagian sidat ke kolam lain', 'Move some eels to another pond'), tx('Sortir berdasarkan ukuran', 'Sort by size'), tx('Pastikan aerasi cukup', 'Make sure there is enough aeration')],
      source: PARTNER_SOURCE(),
    });
  }

  // 8. Nothing measured today.
  if (!recent.some((l) => l.data.readings && Object.keys(l.data.readings).length > 0)) {
    findings.push({
      id: 'stale',
      level: 'info',
      title: tx('Belum ada pengukuran hari ini', 'No measurements today'),
      detail: tx('Catat suhu, pH dan TDS agar risiko bisa dinilai.', 'Record temperature, pH and TDS so the risk can be judged.'),
      actions: [tx('Ukur dan catat suhu, pH, TDS', 'Measure and record temperature, pH, TDS')],
      source: tx('SOP harian Blueprint Synt Nursery v5', 'Synt Nursery v5 blueprint daily SOP'),
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
    [b?.below !== undefined && tx(`di bawah ${fmt(b.below)}`, `below ${fmt(b.below)}`), b?.above !== undefined && tx(`di atas ${fmt(b.above)}`, `above ${fmt(b.above)}`)]
      .filter(Boolean)
      .join(tx(' atau ', ' or '));
  const unit = unitName ? ` ${unitName}` : '';
  const parts: string[] = [];
  if (t.target?.min !== undefined && t.target?.max !== undefined) parts.push(`Target ${fmt(t.target.min)}–${fmt(t.target.max)}${unit}.`);
  else if (t.target?.min !== undefined) parts.push(tx(`Target minimal ${fmt(t.target.min)}${unit}.`, `Target at least ${fmt(t.target.min)}${unit}.`));
  else if (t.target?.max !== undefined) parts.push(tx(`Target maksimal ${fmt(t.target.max)}${unit}.`, `Target at most ${fmt(t.target.max)}${unit}.`));
  if (t.warning) parts.push(tx(`Perhatian bila ${range(t.warning)}${unit}.`, `Caution when ${range(t.warning)}${unit}.`));
  if (t.critical) parts.push(tx(`Bahaya bila ${range(t.critical)}${unit}.`, `Danger when ${range(t.critical)}${unit}.`));
  return parts.join(' ');
}
