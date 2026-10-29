// Evening briefing agent. Muse Spark looks at the farm through read-only tools (ponds, recent
// logs, the night's oxygen-risk forecast, weather, the knowledge base) and proposes a short
// briefing plus extra checks. Deterministic code then guards the proposal:
//   - every check the rules made is kept: the agent can add checks, never remove or move one;
//   - checks must name a real pond and fall within the next 18 hours;
//   - nothing about medicines or doses gets through (decision support, not treatment).
// When the model is unavailable the briefing is written from the rules alone.
import { currentLang, tx, type Lang } from './i18n.ts';
import { AiFailed, call, Retry, type ChatProvider } from './ai.ts';
import { knowledge } from './knowledge.ts';
import type { Nowcast } from './nowcast.ts';

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

// Medicines and doses are out of scope for the app; anything that sounds like treatment is dropped.
const TREATMENT = /\b(obat|antibiotik|dosis|formalin|metilen|methylene|malachite|kalium permanganat|\bpk\b|oxytetra|garam\s+\d|mg\/l\s+(obat|garam)|ppm\s+(obat|garam))/i;

const clock = (t: number, tz: string) => {
  const hm = new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz });
  return currentLang() === 'en' ? hm : hm.replace(':', '.');
};

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
    nc.checks.filter((c) => c.t >= input.now - HOUR && c.t <= end).map((c) => ({ pondId: nc.pondId, t: c.t, action: c.reason, alarm: c.alarm, source: 'rules' as const })),
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
  return { summary, checks: ruleChecks(input), source: 'rules', model: null, steps, generatedAt: input.now, lang: currentLang() };
}

// ---------- tools ----------

function searchGuidance(query: string) {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const docs: { source: string; text: string }[] = [
    ...(knowledge.emergencies as any).emergencies.map((e: any) => ({ source: 'SOP darurat', text: `${e.trigger}: ${e.operator_actions.join('; ')}` })),
    ...(knowledge.thresholds as any).parameters.filter((p: any) => p.operator_action).map((p: any) => ({ source: 'Ambang batas', text: `${p.name}: ${p.operator_action}` })),
    ...(knowledge.nurseryProgram as any).stages.map((s: any) => ({ source: 'Program pembesaran', text: `Minggu ${s.weeks.join('–')} ${s.name}: pakan ${s.feed}; air ${s.water}` })),
    ...(knowledge.sop as any).tasks.map((t: any) => ({ source: 'SOP harian', text: `${t.task}${t.note ? ` (${t.note})` : ''}` })),
  ];
  return docs
    .map((d) => ({ ...d, score: words.filter((w) => d.text.toLowerCase().includes(w)).length }))
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map(({ source, text }) => ({ source, text }));
}

const fn = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

const TOOLS = [
  fn('get_ponds', 'Semua kolam: fase, minggu ke-, status, peringatan aktif, ukuran terakhir dan kapan terakhir dicatat.'),
  fn('get_pond_history', 'Ringkasan harian satu kolam beberapa hari terakhir (suhu, pH, TDS, sidat mati, sisa pakan, perilaku).', { pond_id: { type: 'integer' }, days: { type: 'integer', minimum: 1, maximum: 7 } }, ['pond_id']),
  fn('get_night_forecast', 'Perkiraan suhu air dan risiko oksigen per jam untuk satu kolam sampai 18 jam ke depan, beserta cek yang sudah dijadwalkan aturan.', { pond_id: { type: 'integer' } }, ['pond_id']),
  fn('get_weather', 'Cuaca per jam di lokasi tambak untuk 18 jam ke depan: suhu udara, hujan (mm), awan (%).'),
  fn('search_guidance', 'Cari panduan resmi: SOP darurat, ambang batas, program pembesaran, SOP harian.', { query: { type: 'string' } }, ['query']),
  fn(
    'submit_briefing',
    'Kirim briefing akhir. Wajib dipanggil sekali di akhir.',
    {
      summary: { type: 'string', description: 'Maksimal 3 kalimat sederhana untuk petani, dalam bahasa yang diminta di aturan: apa yang perlu diwaspadai malam ini dan kenapa.' },
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
    'Langkah: get_ponds dulu, lalu get_night_forecast untuk kolam yang berstatus perhatian/bahaya atau berisiko, get_weather, dan bila perlu get_pond_history serta search_guidance.',
    'Aturan:',
    '- Ini pendukung keputusan, bukan diagnosis. Jangan sebut obat, dosis, atau pengobatan.',
    '- Cek dari aturan sudah otomatis ada; jangan mengulanginya. Tambahkan cek hanya bila data memberi alasan jelas (mis. hujan deras, suhu turun, sisa pakan, kolam lama tidak diukur).',
    '- Jam cek harus dalam 18 jam ke depan. Tindakan harus bisa dilakukan petani tanpa alat khusus selain alat ukur pH, TDS, termometer.',
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
      case 'search_guidance':
        return searchGuidance(String(args.query ?? ''));
      default:
        return { error: 'alat tidak dikenal' };
    }
  };

  // One provider after the other: the open-weight model first, then the Meta API, then Fireworks.
  let steps: Briefing['steps'] = [];
  for (const provider of providers.filter((p) => p.apiKey)) {
    steps = [];
    const done = await attempt(provider, steps);
    if (done) return done;
  }
  return rulesBriefing(input, steps);

  async function attempt(provider: ChatProvider, steps: Briefing['steps']): Promise<Briefing | null> {
    const messages: any[] = [
      { role: 'system', content: SYSTEM(input) },
      { role: 'user', content: currentLang() === 'en' ? 'Susun briefing malam ini. Write the summary and every check in English.' : 'Susun briefing malam ini.' },
    ];
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const body = await call(`${provider.base}/chat/completions`, provider.apiKey, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: provider.model, messages, tools: TOOLS, tool_choice: 'auto', max_tokens: 3000, reasoning_effort: 'low' }),
        });
        const msg = body.choices?.[0]?.message;
        if (!msg) throw new AiFailed('empty answer');
        messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls });
        const calls: any[] = msg.tool_calls ?? [];
        if (!calls.length) {
          messages.push({ role: 'user', content: 'Kirim hasilnya lewat submit_briefing.' });
          continue;
        }
        for (const c of calls) {
          let args: Record<string, any> = {};
          try {
            args = JSON.parse(c.function?.arguments || '{}');
          } catch {
            // keep empty args; the tool answers with an error
          }
          if (c.function?.name === 'submit_briefing') {
            steps.push({ tool: 'submit_briefing', args: {} });
            return guard(input, args, steps, `${provider.name}/${provider.model}`);
          }
          steps.push({ tool: c.function?.name ?? '?', args });
          messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(run(c.function?.name, args)) });
        }
      }
      console.error(`briefing agent (${provider.name}): no submit_briefing after`, MAX_ROUNDS, 'rounds');
    } catch (err) {
      if (!(err instanceof AiFailed || err instanceof Retry)) throw err;
      console.error(`briefing agent (${provider.name}):`, (err as Error).message);
    }
    return null;
  }
}

/** Applies the guardrails to what the model submitted. */
export function guard(input: BriefingInput, proposal: Record<string, any>, steps: Briefing['steps'], model: string): Briefing {
  const base = rulesBriefing(input, steps);
  const summary = String(proposal.summary ?? '').trim();
  const end = input.now + WINDOW_H * HOUR;
  const agentChecks: BriefingCheck[] = [];
  for (const c of Array.isArray(proposal.checks) ? proposal.checks.slice(0, MAX_AGENT_CHECKS) : []) {
    const pond = input.ponds.find((p) => p.id === Number(c?.pond_id));
    const t = typeof c?.time === 'string' ? nextTime(c.time, input.now) : null;
    const action = String(c?.action ?? '').trim().slice(0, 80);
    if (!pond || t === null || t > end || !action || TREATMENT.test(action) || TREATMENT.test(String(c?.why ?? ''))) continue;
    // A rule check at nearly the same time on the same pond already covers it.
    if (base.checks.some((r) => r.pondId === pond.id && Math.abs(r.t - t) < 30 * 60_000)) continue;
    agentChecks.push({ pondId: pond.id, t, action, alarm: Boolean(c.alarm), source: 'agent', why: String(c.why ?? '').slice(0, 140) || undefined });
  }
  const usable = summary.length >= 20 && summary.length <= 500 && !TREATMENT.test(summary);
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
