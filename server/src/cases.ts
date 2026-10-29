// Dead-eel case: one open case per pond follows a die-off across days.
//
// A dead-eel report from Masalah (count > 0) opens the case; later reports, the 1-hour re-check
// and the farmer's answers add to it. The facts are deterministic and come from the pond records:
// dead per day, whether deaths rise compared with the day before, whether the re-check was
// answered, and when to suggest closing (2 recorded days in a row without deaths). Escalation
// ("Kirim ke pemilik") and closing follow these rules only, never the model.
//
// On top, the case agent (Muse Spark through agentloop.ts) reads the case, the pond records, the
// forecast and the guidance, may ask the farmer at most 2 short questions, may add checks (never
// remove or move the rule-made ones), drafts a line for the owner and submits a short summary with
// what to watch. guardCase() checks everything it proposes: no medicine, doses or diagnosis, no
// pronouns in Indonesian, short text, real times. When every provider fails the case is written
// from the rules alone; SYNTEEL_AI_MOCK gives a labelled sample run.
import { currentLang, dec, tx, type Lang } from './i18n.ts';
import type { ChatProvider } from './ai.ts';
import { clock, fn, overstated, searchGuidance, toolLoop, unsafeText, wordingRules, type Step } from './agentloop.ts';
import { nextTime } from './agent.ts';
import { DAY_MS, localDate, type Log } from './domain.ts';
import type { Nowcast } from './nowcast.ts';

const HOUR = 3600_000;
const WINDOW_H = 18;
const MAX_ROUNDS = 10;
const MAX_QUESTIONS = 2;
const MAX_AGENT_CHECKS = 3;
/** The re-check is due an hour after a report; unanswered half an hour after that, it escalates. */
export const RECHECK_AFTER = HOUR;
export const RECHECK_GRACE = 30 * 60_000;
/** Agent runs per case per farm day; after that the case is updated from the rules. */
export const MAX_AGENT_RUNS_PER_DAY = 6;

export type CaseTrigger = 'open' | 'report' | 'answer' | 'recheck' | 'recheck_missed' | 'nodead';
export type CaseEventKind = 'open' | 'report' | 'answer' | 'recheck' | 'nodead' | 'run' | 'close';

export interface CaseEvent {
  id: number;
  at: string;
  kind: CaseEventKind;
  userId: number | null;
  data: any;
}

export interface CaseQuestion {
  q: string;
  /** Quick answers to tap; the farmer can also say or type something else. */
  answers: string[];
}

export interface CaseCheck {
  t: number;
  action: string;
  source: 'rules' | 'agent';
  alarm: boolean;
  why?: string;
}

/** One update of the case: by the agent, from the rules, or a labelled sample. */
export interface CaseRun {
  summary: string;
  watch: string[];
  questions: CaseQuestion[];
  checks: CaseCheck[];
  /** The line for the owner under the facts in the WhatsApp message. */
  ownerNote: string;
  source: 'agent' | 'rules' | 'mock';
  model: string | null;
  steps: Step[];
  generatedAt: number;
  lang: Lang;
  trigger: CaseTrigger;
}

export interface CaseDay {
  date: string;
  dead: number;
  /** Something was recorded for the pond that day (sensor readings do not count). */
  recorded: boolean;
}

export interface CaseFacts {
  days: CaseDay[];
  total: number;
  trend: 'first' | 'up' | 'same' | 'down';
  rising: boolean;
  recheck: { dueAt: number; answered: boolean; better: boolean | null; missed: boolean } | null;
  closeSuggested: boolean;
}

/** Everything the rules and the agent look at. */
export interface CaseInput {
  caseId: number;
  pondId: number;
  pondName: string;
  phase: string | null;
  week: number | null;
  openedAt: number;
  now: number;
  timezone: string;
  logs: Log[];
  events: CaseEvent[];
  findings: { title: string; level: string }[];
  latest: Record<string, { value: number; at: string }>;
  nowcast: Nowcast | null;
  weather: { t: number; airTemp: number; rain: number; cloud: number }[];
  /** Compact daily history of the pond, newest last. */
  history: (days: number) => unknown[];
  trigger: CaseTrigger;
}

const shiftDate = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** Dead per farm day from the opening report on, and the rule decisions drawn from them. */
export function caseFacts(input: Pick<CaseInput, 'openedAt' | 'now' | 'timezone' | 'logs' | 'events'>, until = input.now): CaseFacts {
  const tz = input.timezone;
  const first = localDate(new Date(input.openedAt), tz);
  const last = localDate(new Date(until), tz);
  const days: CaseDay[] = [];
  for (let d = first; d <= last && days.length < 60; d = shiftDate(d, 1)) days.push({ date: d, dead: 0, recorded: false });
  if (!days.length) days.push({ date: last, dead: 0, recorded: false });
  const day = (at: string) => days.find((d) => d.date === localDate(new Date(at), tz));
  for (const l of input.logs) {
    if (l.source === 'sensor') continue;
    const d = day(l.loggedAt);
    if (!d) continue;
    d.recorded = true;
    // Deaths before the opening report that day belong to the daily record, not to the case.
    if (Date.parse(l.loggedAt) >= input.openedAt) d.dead += l.data.mortality ?? 0;
  }
  const total = days.reduce((s, d) => s + d.dead, 0);
  const today = days.at(-1)!;
  const prev = days.at(-2);
  const trend = !prev ? 'first' : today.dead > prev.dead ? 'up' : today.dead < prev.dead ? 'down' : 'same';

  // The re-check belongs to the latest report from Masalah, for a day.
  const reports = input.events.filter((e) => (e.kind === 'open' || e.kind === 'report') && e.data?.recheck);
  const lastReport = reports.at(-1);
  let recheck: CaseFacts['recheck'] = null;
  if (lastReport && until - Date.parse(lastReport.at) < DAY_MS) {
    const at = Date.parse(lastReport.at);
    const answer = input.events.find((e) => e.kind === 'recheck' && Date.parse(e.at) >= at);
    const dueAt = at + RECHECK_AFTER;
    recheck = { dueAt, answered: !!answer, better: answer ? Boolean(answer.data?.better) : null, missed: !answer && until > dueAt + RECHECK_GRACE };
  }

  // Close: two recorded days in a row after the last day with deaths.
  const lastDeath = days.map((d) => d.dead > 0).lastIndexOf(true);
  const after = days.slice(lastDeath + 1);
  const closeSuggested = after.some((d, i) => d.recorded && after[i + 1]?.recorded);

  return { days, total, trend, rising: trend === 'up', recheck, closeSuggested };
}

// ---------- words ----------

const dayName = (date: string, now: number, tz: string) => {
  const today = localDate(new Date(now), tz);
  if (date === today) return tx('Hari ini', 'Today');
  if (date === shiftDate(today, -1)) return tx('Kemarin', 'Yesterday');
  const at = new Date(`${date}T12:00:00Z`);
  const locale = currentLang() === 'en' ? 'en-GB' : 'id-ID';
  const weekday = at.toLocaleDateString(locale, { weekday: 'long', timeZone: 'UTC' });
  // Within the week the day name is enough; older days get the date too ("Wednesday, 21 October").
  if (date > shiftDate(today, -6)) return weekday;
  return `${weekday}, ${at.toLocaleDateString(locale, { day: 'numeric', month: 'long', timeZone: 'UTC' })}`;
};

const eels = (n: number) => tx(`${n} ekor`, `${n} ${n === 1 ? 'eel' : 'eels'}`);

// Indonesian copy speaks without pronouns; text from the model that uses one is not shown.
const PRONOUN = /\b(saya|aku|kamu|anda|engkau|kau|kita|kami)\b/i;
const fitsText = (s: string, min: number, max: number) => s.length >= min && s.length <= max && !unsafeText(s) && !(currentLang() === 'id' && PRONOUN.test(s));

/** Rule questions, in order; the ones already answered in this case are skipped. */
function ruleQuestions(input: CaseInput): CaseQuestion[] {
  const asked = new Set(answersOf(input.events).map((a) => a.q.toLowerCase()));
  const recentAeration = input.logs.some((l) => l.data.aeration && input.now - Date.parse(l.loggedAt) < 24 * HOUR);
  const list: CaseQuestion[] = [
    ...(recentAeration ? [] : [{ q: tx('Aerator semalam nyala terus?', 'Was the aerator on all night?'), answers: [tx('Nyala terus', 'On all night'), tx('Sempat mati', 'It went off'), tx('Belum tahu', 'Not sure')] }]),
    { q: tx('Sidat naik ke permukaan atau kumpul di air masuk?', 'Are eels coming up or crowding at the inlet?'), answers: [tx('Ya', 'Yes'), tx('Tidak', 'No'), tx('Belum dilihat', 'Not checked')] },
    { q: tx('Sisa pakan tadi banyak?', 'Was much feed left over?'), answers: [tx('Banyak', 'A lot'), tx('Sedikit', 'A little'), tx('Habis', 'All eaten')] },
    { q: tx('Air berubah warna atau bau?', 'Has the water changed color or smell?'), answers: [tx('Ya', 'Yes'), tx('Tidak', 'No')] },
    { q: tx('Sidat yang mati ada luka atau bercak?', 'Do the dead eels have wounds or spots?'), answers: [tx('Ya', 'Yes'), tx('Tidak', 'No'), tx('Belum dilihat', 'Not checked')] },
  ];
  return list.filter((q) => !asked.has(q.q.toLowerCase())).slice(0, MAX_QUESTIONS);
}

export function answersOf(events: CaseEvent[]): { at: string; q: string; a: string }[] {
  return events.filter((e) => e.kind === 'answer').flatMap((e) => (Array.isArray(e.data?.answers) ? e.data.answers : []).map((x: any) => ({ at: e.at, q: String(x.q), a: String(x.a) })));
}

function ruleChecks(input: CaseInput, facts: CaseFacts): CaseCheck[] {
  const end = input.now + WINDOW_H * HOUR;
  const checks: CaseCheck[] = [];
  if (facts.recheck && !facts.recheck.answered && facts.recheck.dueAt >= input.now - RECHECK_GRACE) {
    checks.push({ t: facts.recheck.dueAt, action: tx('Cek ulang: sidat sudah turun dan berenang normal?', 'Re-check: are the eels back down and swimming normally?'), source: 'rules', alarm: false });
  }
  for (const c of input.nowcast?.checks ?? []) if (c.t >= input.now - HOUR && c.t <= end) checks.push({ t: c.t, action: c.reason, source: 'rules', alarm: c.alarm });
  return checks.sort((a, b) => a.t - b.t);
}

function ruleSummary(input: CaseInput, facts: CaseFacts): string {
  const [today, prev] = [facts.days.at(-1)!, facts.days.at(-2)];
  const top = input.findings.find((f) => f.level === 'critical' || f.level === 'warning');
  const head =
    today.dead === 0
      ? tx(`${input.pondName}: hari ini belum ada sidat mati tercatat.`, `${input.pondName}: no dead eels recorded today yet.`)
      : facts.trend === 'up' && prev
        ? tx(`${input.pondName}: ${eels(today.dead)} mati hari ini, naik dari ${prev.dead} kemarin.`, `${input.pondName}: ${eels(today.dead)} dead today, up from ${prev.dead} yesterday.`)
        : facts.trend === 'down' && prev
          ? tx(`${input.pondName}: ${eels(today.dead)} mati hari ini, turun dari ${prev.dead} kemarin.`, `${input.pondName}: ${eels(today.dead)} dead today, down from ${prev.dead} yesterday.`)
          : tx(`${input.pondName}: ${eels(today.dead)} mati hari ini.`, `${input.pondName}: ${eels(today.dead)} dead today.`);
  const cause = top ? tx(` Catatan terakhir: ${top.title.toLowerCase()}.`, ` Latest record: ${top.title.toLowerCase()}.`) : '';
  const todo =
    today.dead === 0
      ? tx(' Tetap lihat sidat pagi dan sore.', ' Keep looking at the eels morning and afternoon.')
      : tx(' Angkat sidat mati, pastikan aerator nyala, lalu ukur suhu, pH dan TDS.', ' Take out the dead eels, make sure the aerator is on, then measure temperature, pH and TDS.');
  return head + cause + todo;
}

/** The case written from the rules alone: no model, or the model failed or misbehaved. */
export function rulesCaseRun(input: CaseInput, steps: Step[] = []): CaseRun {
  const facts = caseFacts(input);
  return {
    summary: ruleSummary(input, facts),
    watch: [
      tx('Jumlah sidat mati besok pagi', 'How many eels are dead tomorrow morning'),
      tx('Sidat naik ke permukaan atau kumpul di air masuk', 'Eels coming up or crowding at the inlet'),
      tx('Sisa pakan', 'Leftover feed'),
    ],
    questions: ruleQuestions(input),
    checks: ruleChecks(input, facts),
    ownerNote:
      facts.days.at(-1)!.dead > 0
        ? tx('Sudah dilakukan langkah darurat di aplikasi. Mohon arahan.', 'The emergency steps in the app are under way. Please advise.')
        : tx('Hari ini belum ada yang mati lagi.', 'None dead again today so far.'),
    source: 'rules',
    model: null,
    steps,
    generatedAt: input.now,
    lang: currentLang(),
    trigger: input.trigger,
  };
}

/** SYNTEEL_AI_MOCK: a labelled sample of what the agent does, built from the case's real numbers. */
export function mockCaseRun(input: CaseInput): CaseRun {
  const base = rulesCaseRun(input);
  const t = Math.ceil((input.now + 3 * HOUR) / HOUR) * HOUR;
  const temp = input.latest.temperature;
  return {
    ...base,
    // The card labels it "Mode contoh, bukan hasil AI".
    summary:
      base.summary +
      (temp ? tx(` Suhu air terakhir ${dec(temp.value)}\u00a0°C.`, ` Last water temperature ${dec(temp.value)}\u00a0°C.`) : ''),
    checks: [...base.checks, { t, action: tx('Lihat sidat di permukaan dan dengar aerator', 'Look for eels at the surface and listen to the aerator'), source: 'agent' as const, alarm: false, why: tx('Contoh cek tambahan dari AI', 'Sample extra check from the AI') }].sort((a, b) => a.t - b.t),
    source: 'mock',
    model: 'mock',
    steps: ['get_case', 'get_pond_logs', 'get_forecast', 'search_guidance', 'ask_farmer', 'add_check', 'draft_owner_message', 'submit_case_update'].map((tool) => ({ tool, args: tool === 'search_guidance' ? { query: tx('sidat mati', 'dead eels') } : {} })),
  };
}

// ---------- the agent ----------

const TOOLS = [
  fn('get_case', 'Kasus ini: kolam, fase, sejak kapan, sidat mati per hari, naik/turun, status cek ulang, jawaban petani sejauh ini, peringatan aturan dan ukuran terakhir.'),
  fn('get_pond_logs', 'Ringkasan harian catatan kolam ini 1–3 hari terakhir (suhu, pH, TDS, sidat mati, sisa pakan, perilaku, aerator).', { days: { type: 'integer', minimum: 1, maximum: 3 } }),
  fn('get_forecast', 'Perkiraan suhu air dan risiko oksigen kolam ini sampai 18 jam ke depan, cek yang sudah dijadwalkan aturan, dan cuaca per jam.'),
  fn('search_guidance', 'Cari panduan resmi: SOP darurat, ambang batas, program pembesaran, SOP harian.', { query: { type: 'string' } }, ['query']),
  fn(
    'ask_farmer',
    'Tanya petani satu hal singkat yang membantu mengikuti kasus (contoh: "Aerator semalam nyala?"). Maksimal 2 per giliran. Jawaban datang nanti; jangan menunggu.',
    {
      question: { type: 'string', description: 'Pertanyaan pendek, maks 80 karakter, tanpa kata ganti orang' },
      answers: { type: 'array', items: { type: 'string' }, description: '2–3 jawaban cepat untuk diketuk, masing-masing maks 20 karakter' },
    },
    ['question', 'answers'],
  ),
  fn(
    'add_check',
    'Tambah cek di luar cek dari aturan (cek aturan tidak bisa dihapus atau digeser). Maksimal 3.',
    {
      time: { type: 'string', description: 'Jam lokal HH:MM dalam 18 jam ke depan' },
      action: { type: 'string', description: 'Tindakan singkat yang bisa dilakukan petani, maks 80 karakter' },
      why: { type: 'string', description: 'Alasan singkat dari data' },
    },
    ['time', 'action', 'why'],
  ),
  fn('draft_owner_message', 'Satu atau dua kalimat untuk pemilik tambak, di bawah angka kematian per hari yang sudah ditulis aplikasi (jangan ulangi angkanya): apa yang sudah dilakukan dan apa yang perlu diputuskan. Tanpa obat, dosis atau diagnosis.', { text: { type: 'string' } }, ['text']),
  fn(
    'submit_case_update',
    'Kirim pembaruan kasus. Wajib dipanggil sekali di akhir.',
    {
      summary: { type: 'string', description: 'Maksimal 3 kalimat sederhana: keadaan kasus sekarang dan apa yang dilakukan berikutnya.' },
      watch: { type: 'array', items: { type: 'string' }, description: '1–3 hal yang perlu diawasi, masing-masing maks 60 karakter' },
    },
    ['summary', 'watch'],
  ),
];

const SYSTEM = (input: CaseInput) =>
  [
    `Kamu agen kasus kematian sidat Synteel untuk ${input.pondName}. Sekarang ${clock(input.now, input.timezone)} waktu tambak. Pemicu giliran ini: ${input.trigger}.`,
    'Tugasmu: ikuti kasus sidat mati di kolam ini dari hari ke hari. Lihat data dengan alat, lalu kirim pembaruan lewat submit_case_update.',
    'Langkah: get_case dulu, lalu get_pond_logs dan get_forecast, search_guidance bila perlu. Bila ada hal penting yang belum diketahui, tanya petani lewat ask_farmer (maksimal 2, jangan ulangi pertanyaan yang sudah dijawab). Tambah cek lewat add_check hanya bila data memberi alasan jelas. Tulis kalimat untuk pemilik lewat draft_owner_message.',
    'Aturan:',
    '- Ini pendukung keputusan, bukan diagnosis. Jangan menyebut nama penyakit, kuman atau parasit sebagai penyebab. Jangan sebut obat, dosis, garam atau pengobatan apa pun.',
    '- Angka kematian, naik/turun, cek ulang, kirim ke pemilik dan tutup kasus diputuskan aturan aplikasi; jangan mengubahnya. Cek dari aturan tidak boleh dihapus atau digeser.',
    '- Tindakan harus bisa dilakukan petani dengan alat yang ada: aerator, termometer, alat ukur pH dan TDS, mata dan tangan.',
    ...wordingRules(input.now, input.timezone),
    currentLang() === 'en'
      ? '- Write the summary, questions, quick answers, watch items, checks and the owner line in clear, plain English: short sentences, everyday farm words (aerator, water temperature, leftover feed, eels), no abbreviations except pH and TDS. Pond names stay exactly as they are.'
      : '- Bahasa Indonesia sederhana untuk petani lansia, tanpa singkatan selain pH dan TDS, tanpa kata ganti orang (saya, kamu, Anda, kita). Contoh pertanyaan: "Aerator semalam nyala?"',
  ].join('\n');

/** What the agent collects through the action tools before it submits. */
interface Collected {
  questions: CaseQuestion[];
  checks: { time: string; action: string; why: string }[];
  ownerNote: string | null;
}

export async function runCaseAgent(input: CaseInput, providers: ChatProvider[]): Promise<CaseRun> {
  const facts = caseFacts(input);
  const end = input.now + WINDOW_H * HOUR;
  const read = (name: string, args: Record<string, any>): unknown => {
    switch (name) {
      case 'get_case':
        return {
          pond: input.pondName,
          phase: input.phase,
          week: input.week,
          opened: clock(input.openedAt, input.timezone) + ' ' + localDate(new Date(input.openedAt), input.timezone),
          today: localDate(new Date(input.now), input.timezone),
          // "day" names the date as the farmer says it, so the summary never calls today "kemarin".
          dead_per_day: facts.days.map((d) => ({ date: d.date, day: dayName(d.date, input.now, input.timezone), dead: d.dead, recorded: d.recorded })),
          total_dead: facts.total,
          trend: facts.trend,
          recheck: facts.recheck && { due: clock(facts.recheck.dueAt, input.timezone), answered: facts.recheck.answered, better: facts.recheck.better, missed: facts.recheck.missed },
          farmer_answers: answersOf(input.events).map((a) => ({ time: clock(Date.parse(a.at), input.timezone), question: a.q, answer: a.a })),
          rule_warnings: input.findings,
          latest: Object.fromEntries(Object.entries(input.latest).map(([k, v]) => [k, { value: v.value, hours_ago: Math.round((input.now - Date.parse(v.at)) / HOUR) }])),
        };
      case 'get_pond_logs':
        return input.history(Math.min(3, Math.max(1, Number(args.days) || 3)));
      case 'get_forecast': {
        const nc = input.nowcast;
        return {
          forecast: nc
            ? {
                peak: { time: clock(nc.peak.t, input.timezone), level: nc.peak.level, reasons: nc.peak.factors.map((f) => f.label) },
                hours: nc.hours.filter((h) => h.t >= input.now && h.t <= end && (h.t / HOUR) % 2 === 0).map((h) => ({ time: clock(h.t, input.timezone), water_temp: h.temp, risk: h.level })),
                rule_checks: ruleChecks(input, facts).map((c) => ({ time: clock(c.t, input.timezone), action: c.action })),
              }
            : null,
          weather: input.weather.filter((h) => h.t >= input.now && h.t <= end && (h.t / HOUR) % 3 === 0).map((h) => ({ time: clock(h.t, input.timezone), air_temp: h.airTemp, rain_mm: h.rain, cloud: h.cloud })),
        };
      }
      case 'search_guidance':
        return searchGuidance(String(args.query ?? ''));
      default:
        return { error: 'alat tidak dikenal' };
    }
  };

  const { result, steps } = await toolLoop(providers, {
    label: 'case agent',
    system: SYSTEM(input),
    user: currentLang() === 'en' ? 'Perbarui kasus ini. Write everything for the farmer in English.' : 'Perbarui kasus ini.',
    tools: TOOLS,
    submit: 'submit_case_update',
    maxRounds: MAX_ROUNDS,
    session: () => {
      const got: Collected = { questions: [], checks: [], ownerNote: null };
      return {
        run(name, args) {
          if (name === 'ask_farmer') {
            if (got.questions.length >= MAX_QUESTIONS) return { error: 'Sudah 2 pertanyaan. Lanjutkan tanpa bertanya lagi.' };
            got.questions.push({ q: String(args.question ?? ''), answers: Array.isArray(args.answers) ? args.answers.map(String) : [] });
            return { ok: true, note: 'Pertanyaan dikirim ke petani; jawabannya datang di giliran berikutnya.' };
          }
          if (name === 'add_check') {
            if (got.checks.length >= MAX_AGENT_CHECKS) return { error: 'Sudah 3 cek tambahan.' };
            got.checks.push({ time: String(args.time ?? ''), action: String(args.action ?? ''), why: String(args.why ?? '') });
            return { ok: true };
          }
          if (name === 'draft_owner_message') {
            got.ownerNote = String(args.text ?? '');
            return { ok: true };
          }
          return read(name, args);
        },
        finish: (args, steps, model) => guardCase(input, { ...got, summary: args.summary, watch: args.watch }, steps, model),
      };
    },
  });
  return result ?? rulesCaseRun(input, steps);
}

/** Applies the guardrails to what the agent proposed. An unusable summary means the whole update comes from the rules. */
export function guardCase(input: CaseInput, p: Partial<Collected> & { summary?: unknown; watch?: unknown }, steps: Step[], model: string): CaseRun {
  const base = rulesCaseRun(input, steps);
  const fits = (s: string, min: number, max: number) => fitsText(s, min, max) && !overstated(s, input.weather);
  const summary = String(p.summary ?? '').trim();
  if (!fits(summary, 20, 500)) return base;

  const watch = (Array.isArray(p.watch) ? p.watch : [])
    .map((w) => String(w).trim())
    .filter((w) => fits(w, 3, 80))
    .slice(0, 3);

  const asked = new Set(answersOf(input.events).map((a) => a.q.toLowerCase()));
  const questions = (p.questions ?? [])
    .map((q) => ({ q: q.q.trim(), answers: q.answers.map((a) => a.trim()).filter((a) => fits(a, 1, 24)).slice(0, 3) }))
    .filter((q) => fits(q.q, 5, 90) && !asked.has(q.q.toLowerCase()))
    .map((q) => (q.answers.length >= 2 ? q : { ...q, answers: [tx('Ya', 'Yes'), tx('Tidak', 'No'), tx('Belum tahu', 'Not sure')] }))
    .slice(0, MAX_QUESTIONS);

  const end = input.now + WINDOW_H * HOUR;
  const extra: CaseCheck[] = [];
  for (const c of (p.checks ?? []).slice(0, MAX_AGENT_CHECKS)) {
    const t = nextTime(c.time, input.now);
    const action = c.action.trim().slice(0, 80);
    if (t === null || t > end || !fits(action, 3, 80) || unsafeText(c.why) || overstated(c.why, input.weather)) continue;
    // A rule check at nearly the same time already covers it; rule checks are never moved.
    if (base.checks.some((r) => Math.abs(r.t - t) < 30 * 60_000)) continue;
    extra.push({ t, action, source: 'agent', alarm: false, why: c.why.trim().slice(0, 140) || undefined });
  }

  const note = (p.ownerNote ?? '').trim();
  return {
    ...base,
    summary,
    watch: watch.length ? watch : base.watch,
    questions,
    checks: [...base.checks, ...extra].sort((a, b) => a.t - b.t),
    ownerNote: fits(note, 10, 300) ? note : base.ownerNote,
    source: 'agent',
    model,
  };
}

// ---------- what the phone gets ----------

export interface CaseView {
  id: number;
  pondId: number;
  pondName: string;
  status: 'open' | 'closed';
  openedAt: string;
  closedAt: string | null;
  days: (CaseDay & { label: string })[];
  total: number;
  trend: CaseFacts['trend'];
  recheck: CaseFacts['recheck'];
  /** Rule-made: deaths rose compared with the day before, or the re-check went unanswered. Sending is manual. */
  escalate: { reasons: ('rising' | 'recheck_missed')[]; message: string; waUrl: string; ownerName: string | null } | null;
  closeSuggested: boolean;
  run: CaseRun;
  /** Questions of the latest run not answered since. */
  openQuestions: CaseQuestion[];
  answers: { at: string; q: string; a: string }[];
  running: boolean;
  /** Today has no deaths and nothing recorded yet: "Hari ini tidak ada yang mati" makes sense. */
  canMarkNoDead: boolean;
}

export function caseView(
  input: CaseInput,
  c: { status: 'open' | 'closed'; openedAt: string; closedAt: string | null },
  saved: CaseRun | null,
  owner: { name: string; phone: string | null } | null,
  running: boolean,
): CaseView {
  const until = c.closedAt ? Math.min(input.now, Date.parse(c.closedAt)) : input.now;
  const facts = caseFacts(input, until);
  // Written in the other language: show the rules version in this one.
  const run = saved && saved.lang === currentLang() ? saved : { ...(saved?.source === 'mock' ? mockCaseRun(input) : rulesCaseRun(input)), ...(saved && { generatedAt: saved.generatedAt }) };
  const answers = answersOf(input.events);
  const answeredAfter = new Set(answers.filter((a) => Date.parse(a.at) >= run.generatedAt).map((a) => a.q.toLowerCase()));
  const open = c.status === 'open';
  const reasons: ('rising' | 'recheck_missed')[] = [];
  if (open && facts.rising) reasons.push('rising');
  if (open && facts.recheck?.missed) reasons.push('recheck_missed');
  const message = ownerMessage(input, facts, run);
  const today = facts.days.at(-1)!;
  return {
    id: input.caseId,
    pondId: input.pondId,
    pondName: input.pondName,
    status: c.status,
    openedAt: c.openedAt,
    closedAt: c.closedAt,
    days: facts.days.map((d) => ({ ...d, label: dayName(d.date, input.now, input.timezone) })),
    total: facts.total,
    trend: facts.trend,
    recheck: facts.recheck,
    escalate: reasons.length
      ? { reasons, message, waUrl: `https://wa.me/${owner?.phone ?? ''}?text=${encodeURIComponent(message)}`, ownerName: owner?.name ?? null }
      : null,
    closeSuggested: open && facts.closeSuggested,
    run,
    openQuestions: open ? run.questions.filter((q) => !answeredAfter.has(q.q.toLowerCase())) : [],
    answers,
    running,
    canMarkNoDead: open && today.dead === 0 && !today.recorded,
  };
}

/** The WhatsApp message: facts from the rules first, then the agent's (or the rules') line. */
export function ownerMessage(input: CaseInput, facts: CaseFacts, run: CaseRun): string {
  const lines = [
    tx(`Kasus sidat mati ${input.pondName}`, `Dead eel case, ${input.pondName}`),
    ...facts.days.slice(-3).map((d) => `${dayName(d.date, input.now, input.timezone)}: ${d.recorded || d.dead ? eels(d.dead) : tx('belum dicatat', 'not recorded')}`),
    facts.rising ? tx('Kematian naik dibanding kemarin.', 'Deaths are up compared with yesterday.') : '',
    facts.recheck?.missed ? tx(`Cek ulang jam ${clock(facts.recheck.dueAt, input.timezone)} belum dijawab.`, `The ${clock(facts.recheck.dueAt, input.timezone)} re-check has no answer yet.`) : '',
    run.ownerNote,
  ];
  return lines.filter(Boolean).join('\n');
}
