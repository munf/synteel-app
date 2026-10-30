// Evening briefing agent. Muse Spark looks at the farm through read-only tools (ponds, recent
// logs, the night's oxygen-risk forecast, weather, the knowledge base) and proposes a short
// briefing plus extra checks. Deterministic code then guards the proposal:
//   - every check the rules made is kept: the agent can add checks, never remove or move one;
//   - checks must name a real pond and fall within the next 18 hours;
//   - nothing about medicines, doses or a diagnosis gets through (decision support, not treatment).
// When the model is unavailable the briefing is written from the rules alone.
import { currentLang, tx, type Lang } from './i18n.ts';
import type { ChatProvider } from './ai.ts';
import { clock, degrees, fn, overstated, searchGuidance, toolLoop, unsafeText, wordingRules } from './agentloop.ts';
import type { Nowcast } from './nowcast.ts';
import { powerBackupLabel, type PowerNight } from './power.ts';

const HOUR = 3600_000;
const WINDOW_H = 18;
const MAX_ROUNDS = 8;
const MAX_AGENT_CHECKS = 5;

export interface BriefingPond {
  id: number;
  name: string;
  phase: string | null;
  week: number | null;
  level: string;
  findings: { title: string; level: string }[];
  latest: Record<string, { value: number; at: string }>;
  lastLogAt: string | null;
}

export interface BriefingInput {
  farmName: string;
  now: number;
  timezone: string;
  ponds: BriefingPond[];
  nowcasts: Nowcast[];
  weather: { t: number; airTemp: number; rain: number; cloud: number }[];
  /** Compact daily history per pond, newest last. */
  history: (pondId: number, days: number) => unknown[];
  /** BMKG village forecast, 3-hour steps (bmkg.ts via the API); null without a farm place or when BMKG is out of reach. */
  bmkg?: { region: { desa: string; kecamatan: string; kabupaten: string }; steps: { t: number; code: number; desc: string; rain: number; wind: number; temp: number }[]; error: string | null } | null;
  /** Tonight's power-cut risk (power.ts). */
  power?: PowerNight | null;
}

export interface BriefingCheck {
  pondId: number;
  t: number;
  action: string;
  alarm: boolean;
  source: 'rules' | 'agent';
  why?: string;
}

export interface Briefing {
  summary: string;
  checks: BriefingCheck[];
  source: 'agent' | 'rules';
  model: string | null;
  /** What the agent looked at, in order: shown in the app so the reasoning is visible. */
  steps: { tool: string; args: Record<string, unknown> }[];
  generatedAt: number;
  /** Language the summary and checks were written in (missing on older ones: Indonesian). */
  lang?: Lang;
}

/** "21:30" or "21.30" → the next such moment after `now` (in the farm's time zone, UTC+7 for WIB). */
export function nextTime(hhmm: string, now: number, tzOffsetH = 7): number | null {
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  const local = new Date(now + tzOffsetH * HOUR);
  let t = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), h, min) - tzOffsetH * HOUR;
  if (t < now - 15 * 60_000) t += 24 * HOUR;
  return t;
}

function ruleChecks(input: BriefingInput): BriefingCheck[] {
  const end = input.now + WINDOW_H * HOUR;
  return input.nowcasts.flatMap((nc) =>
    nc.checks
      .filter((c) => c.t >= input.now - HOUR && c.t <= end)
      .map((c) => ({ pondId: nc.pondId, t: c.t, action: c.reason, alarm: c.alarm, source: 'rules' as const, ...((c as { why?: string }).why && { why: (c as { why?: string }).why }) })),
  );
}

/** The briefing written from the rules alone: used when the model is off, fails or misbehaves. */
export function rulesBriefing(input: BriefingInput, steps: Briefing['steps'] = []): Briefing {
  const rank: Record<string, number> = { ok: 0, warning: 1, critical: 2 };
  const worst = [...input.nowcasts].sort((a, b) => rank[b.peak.level] - rank[a.peak.level] || a.peak.t - b.peak.t)[0];
  const pond = worst && input.ponds.find((p) => p.id === worst.pondId);
  const summary =
    !worst || worst.peak.level === 'ok'
      ? tx('Malam ini semua kolam diperkirakan tenang. Tetap ukur suhu pagi dan sore.', 'All ponds are expected to be calm tonight. Still measure the temperature morning and afternoon.')
      : tx(
          `${pond?.name ?? 'Satu kolam'} paling rawan sekitar ${clock(worst.peak.t, input.timezone)}: ${worst.peak.factors[0]?.label.toLowerCase() ?? 'risiko oksigen naik'}. Pastikan aerator nyala dan lihat sidat sebelum tidur.`,
          `${pond?.name ?? 'One pond'} is most at risk around ${clock(worst.peak.t, input.timezone)}: ${worst.peak.factors[0]?.label.toLowerCase() ?? 'oxygen risk rising'}. Make sure the aerator is on and look at the eels before bed.`,
        );
  const p = input.power;
  const power =
    p && p.level === 'high'
      ? p.backup === 'genset'
        ? tx(' Malam ini rawan listrik padam: siapkan genset dan bahan bakar.', ' Tonight is at risk of a power cut: get the generator and fuel ready.')
        : p.backup === 'battery'
          ? tx(' Malam ini rawan listrik padam: pastikan aki atau baterai cadangan terisi penuh.', ' Tonight is at risk of a power cut: make sure the battery backup is fully charged.')
          : tx(' Malam ini rawan listrik padam: kurangi pakan dan tentukan siapa yang cek aerator.', ' Tonight is at risk of a power cut: feed less and decide who checks the aerator.')
      : '';
  return { summary: summary + power, checks: ruleChecks(input), source: 'rules', model: null, steps, generatedAt: input.now, lang: currentLang() };
}

// ---------- tools ----------

const TOOLS = [
  fn('get_ponds', 'Semua kolam: fase, minggu ke-, status, peringatan aktif, ukuran terakhir dan kapan terakhir dicatat.'),
  fn('get_pond_history', 'Ringkasan harian satu kolam beberapa hari terakhir (suhu, pH, TDS, sidat mati, sisa pakan, perilaku).', { pond_id: { type: 'integer' }, days: { type: 'integer', minimum: 1, maximum: 7 } }, ['pond_id']),
  fn('get_night_forecast', 'Perkiraan suhu air dan risiko oksigen per jam untuk satu kolam sampai 18 jam ke depan, beserta cek yang sudah dijadwalkan aturan.', { pond_id: { type: 'integer' } }, ['pond_id']),
  fn('get_weather', 'Cuaca per jam di lokasi tambak untuk 18 jam ke depan: suhu udara, hujan (mm), awan (%).'),
  fn(
    'get_bmkg_forecast',
    'Prakiraan resmi BMKG untuk desa tambak (langkah 3 jam, hujan dalam mm per 3 jam, angin km/jam), dan penilaian aturan "malam rawan listrik padam" dari BMKG dan Open-Meteo: tingkat, alasan, dan apakah kedua sumber berbeda soal petir.',
  ),
  fn('search_guidance', 'Cari panduan resmi: SOP darurat, ambang batas, program pembesaran, SOP harian.', { query: { type: 'string' } }, ['query']),
  fn(
    'submit_briefing',
    'Kirim briefing akhir. Wajib dipanggil sekali di akhir.',
    {
      summary: { type: 'string', description: 'Maksimal 3 kalimat sederhana untuk petani (paling banyak 450 karakter), dalam bahasa yang diminta di aturan: apa yang perlu diwaspadai malam ini dan kenapa.' },
      checks: {
        type: 'array',
        description: 'Cek TAMBAHAN selain cek dari aturan (boleh kosong). Maksimal 5.',
        items: {
          type: 'object',
          properties: {
            pond_id: { type: 'integer' },
            time: { type: 'string', description: 'Jam lokal HH:MM' },
            action: { type: 'string', description: 'Tindakan singkat yang bisa dilakukan petani, maks 80 karakter' },
            alarm: { type: 'boolean', description: 'true bila jatuh di jam tidur dan penting' },
            why: { type: 'string', description: 'Alasan singkat dari data' },
          },
          required: ['pond_id', 'time', 'action', 'alarm', 'why'],
          additionalProperties: false,
        },
      },
    },
    ['summary', 'checks'],
  ),
];

const SYSTEM = (input: BriefingInput) =>
  [
    `Kamu agen briefing sore Synteel untuk tambak sidat "${input.farmName}". Sekarang ${clock(input.now, input.timezone)} waktu tambak.`,
    'Tugasmu: lihat data dengan alat, lalu kirim briefing malam ini lewat submit_briefing.',
    'Langkah: get_ponds dulu, lalu get_night_forecast untuk kolam yang berstatus perhatian/bahaya atau berisiko, get_weather, get_bmkg_forecast, dan bila perlu get_pond_history serta search_guidance.',
    '- Listrik padam di malam hari mematikan aerator. Bila get_bmkg_forecast menilai malam ini rawan listrik padam, sebut itu dan persiapannya (genset, aki atau baterai cadangan, atau tanpa cadangan: kurangi pakan dan tentukan siapa yang cek aerator). Bila BMKG dan Open-Meteo berbeda soal petir malam ini, katakan terus terang bahwa kedua prakiraan berbeda, lalu sarankan persiapan yang lebih aman. Sebut BMKG sebagai sumber bila memakai datanya.',
    'Aturan:',
    '- Ini pendukung keputusan, bukan diagnosis. Jangan sebut obat, dosis, atau pengobatan.',
    '- Cek dari aturan sudah otomatis ada; jangan mengulanginya. Tambahkan cek hanya bila data memberi alasan jelas (mis. hujan deras, suhu turun, sisa pakan, kolam lama tidak diukur).',
    '- Jam cek harus dalam 18 jam ke depan. Tindakan harus bisa dilakukan petani tanpa alat khusus selain alat ukur pH, TDS, termometer.',
    ...wordingRules(input.now, input.timezone),
    currentLang() === 'en'
      ? '- Write the summary, every action and every why in clear, natural English: short sentences, everyday farm words (aerator, water temperature, oxygen in the water, leftover feed, eels), no technical abbreviations such as DO. Pond names stay exactly as they are.'
      : '- Bahasa Indonesia sederhana untuk petani lansia, tanpa singkatan teknis (pakai "oksigen air", bukan DO).',
  ].join('\n');

/** Runs the agent; falls back to the rules-only briefing on any failure. */
export async function runBriefing(input: BriefingInput, providers: ChatProvider[]): Promise<Briefing> {
  const run = (name: string, args: Record<string, any>): unknown => {
    const ncOf = (id: number) => input.nowcasts.find((n) => n.pondId === id);
    const end = input.now + WINDOW_H * HOUR;
    switch (name) {
      case 'get_ponds':
        return input.ponds.map((p) => ({
          id: p.id,
          name: p.name,
          phase: p.phase,
          week: p.week,
          status: p.level,
          warnings: p.findings,
          latest: Object.fromEntries(Object.entries(p.latest).map(([k, v]) => [k, { value: v.value, hours_ago: Math.round((input.now - Date.parse(v.at)) / HOUR) }])),
          last_logged_hours_ago: p.lastLogAt ? Math.round((input.now - Date.parse(p.lastLogAt)) / HOUR) : null,
        }));
      case 'get_pond_history':
        return input.ponds.some((p) => p.id === args.pond_id) ? input.history(args.pond_id, Math.min(7, Math.max(1, args.days ?? 3))) : { error: 'kolam tidak ada' };
      case 'get_night_forecast': {
        const nc = ncOf(args.pond_id);
        if (!nc) return { error: 'kolam tidak ada' };
        return {
          peak: { time: clock(nc.peak.t, input.timezone), level: nc.peak.level, reasons: nc.peak.factors.map((f) => f.label) },
          hours: nc.hours.filter((h) => h.t >= input.now && h.t <= end && (h.t / HOUR) % 2 === 0).map((h) => ({ time: clock(h.t, input.timezone), water_temp: h.temp, risk: h.level })),
          rule_checks: nc.checks.filter((c) => c.t <= end).map((c) => ({ time: clock(c.t, input.timezone), action: c.reason, alarm: c.alarm })),
        };
      }
      case 'get_weather':
        return input.weather.filter((h) => h.t >= input.now && h.t <= end).map((h) => ({ time: clock(h.t, input.timezone), air_temp: h.airTemp, rain_mm: h.rain, cloud: h.cloud }));
      case 'get_bmkg_forecast': {
        const p = input.power;
        return {
          source: 'BMKG',
          village: input.bmkg ? `${input.bmkg.region.desa}, ${input.bmkg.region.kecamatan}, ${input.bmkg.region.kabupaten}` : null,
          steps: (input.bmkg?.steps ?? []).filter((s) => s.t >= input.now - 90 * 60_000 && s.t <= end).map((s) => ({ time: clock(s.t, input.timezone), weather: s.desc, rain_mm_3h: s.rain, wind_kmh: s.wind })),
          error: input.bmkg ? input.bmkg.error : 'BMKG tidak tersedia',
          power_cut_tonight: p
            ? {
                level: p.level,
                reasons: p.reasons.map((r) => r.text),
                thunder_bmkg: p.thunder.bmkg,
                thunder_open_meteo: p.thunder.openMeteo,
                sources_disagree: p.thunder.disagree,
                note: p.note,
                power_backup: powerBackupLabel(p.backup),
                power_out_now: p.outage ? { since: clock(Date.parse(p.outage.startedAt), input.timezone) } : null,
                rule_checks: p.checks.map((c) => ({ time: clock(c.t, input.timezone), action: c.reason })),
              }
            : null,
        };
      }
      case 'search_guidance':
        return searchGuidance(String(args.query ?? ''));
      default:
        return { error: 'alat tidak dikenal' };
    }
  };

  // One provider after the other: the open-weight model first, then the Meta API, then Fireworks.
  const { result, steps } = await toolLoop(providers, {
    label: 'briefing agent',
    system: SYSTEM(input),
    user: currentLang() === 'en' ? 'Susun briefing malam ini. Write the summary and every check in English.' : 'Susun briefing malam ini.',
    tools: TOOLS,
    submit: 'submit_briefing',
    maxRounds: MAX_ROUNDS,
    session: () => ({ run, finish: (args, steps, model) => guard(input, args, steps, model) }),
  });
  return result ?? rulesBriefing(input, steps);
}

/** Rain per hour from both forecasts, for the rain-word guard: BMKG gives mm per 3-hour step. */
const rainSeen = (input: BriefingInput) => [...input.weather, ...(input.bmkg?.steps ?? []).map((s) => ({ rain: s.rain / 3 }))];

/** Applies the guardrails to what the model submitted. */
export function guard(input: BriefingInput, proposal: Record<string, any>, steps: Briefing['steps'], model: string): Briefing {
  const base = rulesBriefing(input, steps);
  const summary = degrees(String(proposal.summary ?? '').trim());
  const end = input.now + WINDOW_H * HOUR;
  const agentChecks: BriefingCheck[] = [];
  for (const c of Array.isArray(proposal.checks) ? proposal.checks.slice(0, MAX_AGENT_CHECKS) : []) {
    const pond = input.ponds.find((p) => p.id === Number(c?.pond_id));
    const t = typeof c?.time === 'string' ? nextTime(c.time, input.now) : null;
    const action = degrees(String(c?.action ?? '').trim()).slice(0, 80);
    if (!pond || t === null || t > end || !action || unsafeText(action) || unsafeText(String(c?.why ?? '')) || overstated(`${action} ${c?.why ?? ''}`, rainSeen(input))) continue;
    // A rule check at nearly the same time on the same pond already covers it.
    if (base.checks.some((r) => r.pondId === pond.id && Math.abs(r.t - t) < 30 * 60_000)) continue;
    agentChecks.push({ pondId: pond.id, t, action, alarm: Boolean(c.alarm), source: 'agent', why: degrees(String(c.why ?? '')).slice(0, 140) || undefined });
  }
  const usable = summary.length >= 20 && summary.length <= 500 && !unsafeText(summary) && !overstated(summary, rainSeen(input));
  // In the server log, so a summary the guard turned down can be looked into.
  if (!usable) console.warn(`briefing agent: summary refused (${summary.length < 20 || summary.length > 500 ? `${summary.length} characters` : unsafeText(summary) ? 'unsafe words' : 'says more than the data'})`);
  return {
    summary: usable ? summary : base.summary,
    checks: [...base.checks, ...agentChecks].sort((a, b) => a.t - b.t),
    source: usable ? 'agent' : 'rules',
    model: usable ? model : null,
    steps,
    generatedAt: input.now,
    lang: currentLang(),
  };
}
