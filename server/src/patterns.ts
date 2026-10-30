// Weekly pattern agent: once a week per farm (and when the farmer asks on a pond's page), Muse Spark
// reads how far the water temperature estimate missed each pond's readings, by time of day and
// pond profile, and writes one or two plain sentences per pond about the pattern, for example
// "Kolam B selalu sekitar 1,5 °C lebih panas dari perkiraan di siang hari, kemungkinan kena
// matahari langsung", with a suggested time to measure that would most reduce the doubt.
//
// Every number comes from code (thermal.ts): the backtest misses per time of day and the ranked
// measuring hours. The agent only reads them through tools and puts them in words. The guard
// refuses a sentence with a number that is not in the pond's data, a time that is not one of the
// ranked hours, medicine, diagnosis, or oxygen; that pond then gets the sentence the rules write.
import { currentLang, dec, tx, type Lang } from './i18n.ts';
import type { ChatProvider } from './ai.ts';
import { fn, toolLoop, unsafeText, type Step } from './agentloop.ts';
import type { Exposure, MeasureHour, Part, ThermalModel } from './thermal.ts';

/** A pond needs this many scored readings before a pattern is worth writing. */
export const MIN_READINGS_FOR_PATTERN = 6;
/** Agent runs from pond pages per farm per day; after that the rules write the note. */
export const MAX_PATTERN_RUNS_PER_DAY = 3;
export const PATTERN_EVERY_MS = 7 * 86400_000;

export interface PatternPond {
  id: number;
  name: string;
  exposure: Exposure;
  kind: string | null;
  light: string | null;
  waterColor: string | null;
  model: ThermalModel;
  hours: MeasureHour[];
}

export interface PatternInput {
  farmName: string;
  now: number;
  timezone: string;
  ponds: PatternPond[];
}

export interface PondPattern {
  pondId: number;
  text: string;
  /** Farm-local "HH:00" worth an extra reading, from the ranked hours; null when none is needed. */
  checkTime: string | null;
  /** How far the estimate at that hour can be off now, °C. */
  checkSpread: number | null;
  source: 'agent' | 'rules' | 'mock';
  model: string | null;
  steps: Step[];
  generatedAt: number;
  lang: Lang;
  /** Scored readings the note is based on. */
  readings: number;
}

const PART_WORD: Record<Part, [string, string]> = {
  morning: ['pagi hari', 'in the morning'],
  midday: ['siang hari', 'at midday'],
  afternoon: ['sore hari', 'in the afternoon'],
  night: ['malam hari', 'at night'],
};
const PART_HOURS: Record<Part, string> = { morning: '04-10', midday: '10-15', afternoon: '15-19', night: '19-04' };
const word = (p: Part) => (currentLang() === 'en' ? PART_WORD[p][1] : PART_WORD[p][0]);
const hhmm = (time: string) => (currentLang() === 'en' ? time : time.replace(':', '.'));
const deg = (n: number) => `${dec(n, 1)} °C`;

/** The part of the day where the pond is missed the same way most clearly, if any. */
function strongestPart(m: ThermalModel) {
  return m.byPart.filter((p) => p.n >= 3 && Math.abs(p.bias) >= 0.5).sort((a, b) => Math.abs(b.bias) - Math.abs(a.bias))[0] ?? null;
}

/** The pattern note written from the numbers alone: used without a model, as the mock, and when the agent's text fails the guard. */
export function rulesPattern(p: PatternPond, now: number, source: 'rules' | 'mock' = 'rules', steps: Step[] = []): PondPattern {
  const m = p.model;
  const best = p.hours[0] ?? null;
  const base = { pondId: p.id, source, model: null, steps, generatedAt: now, lang: currentLang(), readings: m.backtest.n };
  if (m.backtest.n < MIN_READINGS_FOR_PATTERN) {
    return {
      ...base,
      text: tx(
        `Belum cukup ukuran untuk melihat pola ${p.name}. Ukur suhu air pagi dan sore beberapa hari lagi.`,
        `Not enough readings yet to see a pattern for ${p.name}. Measure the water temperature morning and afternoon for a few more days.`,
      ),
      checkTime: null,
      checkSpread: null,
    };
  }
  const part = strongestPart(m);
  let first: string;
  if (part) {
    const warmer = part.bias > 0;
    const why =
      warmer && (part.part === 'midday' || part.part === 'afternoon') && p.exposure !== 'indoor'
        ? tx(', kemungkinan kena matahari langsung', ', probably from direct sun')
        : !warmer && part.part === 'night' && p.exposure === 'open'
          ? tx(', kemungkinan cepat dingin karena terbuka', ', probably because it is open and cools fast')
          : '';
    first = tx(
      `${p.name} biasanya sekitar ${deg(Math.abs(part.bias))} lebih ${warmer ? 'panas' : 'dingin'} dari perkiraan di ${word(part.part)}${why}.`,
      `${p.name} is usually about ${deg(Math.abs(part.bias))} ${warmer ? 'warmer' : 'cooler'} than the estimate ${word(part.part)}${why}.`,
    );
  } else {
    first = tx(
      `Perkiraan suhu ${p.name} biasanya meleset ±${deg(m.typicalError)}, tanpa pola jam tertentu.`,
      `The temperature estimate for ${p.name} is usually off by ±${deg(m.typicalError)}, with no pattern by time of day.`,
    );
  }
  const second = best ? tx(` Ukur sekali sekitar jam ${hhmm(best.time)} supaya perkiraan lebih tepat.`, ` Measure once around ${hhmm(best.time)} to make the estimate more accurate.`) : '';
  return { ...base, text: first + second, checkTime: best?.time ?? null, checkSpread: best?.spread ?? null };
}

// ---------- tools ----------

const TOOLS = [
  fn('get_ponds', 'Semua kolam: profil (wadah, tempat, cahaya, warna air), berapa ukuran suhu yang sudah dipelajari, dan biasanya meleset berapa °C.'),
  fn(
    'get_pond_errors',
    'Selisih ukuran suhu dikurangi perkiraan untuk satu kolam, per bagian hari (positif = kolam lebih panas dari perkiraan), angka yang dipelajari model, dan jam ukur yang paling mengurangi ketidakpastian (sudah dihitung, urut terbaik dulu).',
    { pond_id: { type: 'integer' } },
    ['pond_id'],
  ),
  fn(
    'submit_patterns',
    'Kirim catatan pola. Wajib dipanggil sekali di akhir, satu catatan per kolam yang diminta.',
    {
      ponds: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            pond_id: { type: 'integer' },
            text: { type: 'string', description: 'Satu atau dua kalimat sederhana: pola selisihnya dan kemungkinan sebabnya dari profil, lalu jam ukur yang disarankan. Hanya angka dari alat.' },
            check_time: { type: ['string', 'null'], description: 'Satu jam dari suggested_times (HH:MM), atau null' },
          },
          required: ['pond_id', 'text', 'check_time'],
          additionalProperties: false,
        },
      },
    },
    ['ponds'],
  ),
];

const profileWords = (p: PatternPond) => ({ container: p.kind, place: p.exposure, light: p.light, water_color: p.waterColor });

/** What the tools show the agent about one pond: every number the text may use. */
function pondErrors(p: PatternPond) {
  const m = p.model;
  return {
    pond_id: p.id,
    name: p.name,
    profile: profileWords(p),
    scored_readings: m.backtest.n,
    usually_off_c: m.typicalError,
    mean_miss_c: m.backtest.bias,
    still_learning: m.learning,
    // Fewer than 3 readings at a time of day say nothing about it: no number is given for it.
    by_time_of_day: m.byPart.map((b) => ({ part: word(b.part), hours: PART_HOURS[b.part], readings: b.n, mean_miss_c: b.n >= 3 ? b.bias : null, usually_off_c: b.n >= 3 ? b.typical : null })),
    learned: { sun_warming_c: Math.round(m.params.sun * 10) / 10, sun_warming_start_c: Math.round(m.prior.sun * 10) / 10, follows_weather_within_hours: m.responseHours, offset_c: Math.round(m.params.offset * 10) / 10 },
    suggested_times: p.hours.map((h) => ({ time: h.time, spread_c: h.spread, reason: h.reason, measured_share_of_days: h.covered })),
  };
}

/** Numbers a pond's note may contain: everything the tools showed for it, the hours, and digits in its name. */
function allowedNumbers(p: PatternPond): number[] {
  const out: number[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'number') out.push(Math.abs(v));
    else if (typeof v === 'string') for (const m of v.matchAll(/\d+(?:[.,:]\d+)?/g)) out.push(...m[0].split(/[:]/).map(Number), Number(m[0].replace(',', '.')));
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(pondErrors(p));
  return out;
}

/** A sentence may only carry numbers from the pond's data (°C values, hours, counts). */
export function numbersOk(text: string, allowed: number[]): boolean {
  for (const m of text.matchAll(/\d+(?:[.,]\d+)?/g)) {
    const n = Number(m[0].replace(',', '.'));
    if (!allowed.some((a) => Math.abs(a - n) < 0.051)) return false;
  }
  return true;
}

const normTime = (s: unknown) => {
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(String(s ?? '').trim());
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
};

/** Checks one pond's note from the agent; null when it must be replaced by the rules note. */
export function guardPattern(p: PatternPond, proposal: { text?: unknown; check_time?: unknown }): { text: string; checkTime: string | null; checkSpread: number | null } | null {
  const text = String(proposal.text ?? '').trim().replace(/\s+/g, ' ');
  if (text.length < 15 || text.length > 300) return null;
  const sentences = text.split(/(?<=[.!?])\s+/).filter((x) => x.trim());
  if (sentences.length > 2) return null;
  // Decision support about temperature only: no medicine, no diagnosis, never an oxygen figure.
  if (unsafeText(text) || /oksigen|oxygen|\bDO\b|mg\/l/i.test(text)) return null;
  if (!numbersOk(text, allowedNumbers(p))) return null;
  const time = normTime(proposal.check_time);
  const hour = time ? p.hours.find((h) => h.time === time) : null;
  if (time && !hour) return null;
  return { text, checkTime: hour?.time ?? null, checkSpread: hour?.spread ?? null };
}

const SYSTEM = (input: PatternInput) =>
  [
    `Kamu agen pola suhu mingguan Synteel untuk tambak sidat "${input.farmName}".`,
    'Perkiraan suhu air tiap kolam dihitung dari cuaca. Tugasmu: baca selisih antara ukuran petani dan perkiraan, lalu jelaskan polanya untuk petani.',
    'Langkah: get_ponds, lalu get_pond_errors untuk tiap kolam yang diminta, lalu submit_patterns.',
    'Aturan:',
    '- Satu atau dua kalimat per kolam. Kalimat pertama: pola selisih menurut bagian hari (mean_miss_c positif = kolam lebih panas dari perkiraan) dan kemungkinan sebabnya dari profil kolam (matahari langsung, atap, tempat terbuka, kedalaman). Pakai "kemungkinan", bukan kepastian.',
    '- Bagian hari dengan mean_miss_c null belum punya cukup ukuran: jangan menyimpulkan apa pun tentang bagian itu.',
    '- Kalimat kedua: jam ukur yang disarankan, pilih dari suggested_times (yang pertama paling berguna). Isi check_time dengan jam itu.',
    '- Jangan mengarang angka: pakai hanya angka dari alat, dibulatkan seperti di alat. Bila selisih kecil di semua bagian hari, katakan tidak ada pola jam tertentu.',
    '- Ini soal suhu air saja: jangan menyebut oksigen, penyakit, obat atau dosis.',
    currentLang() === 'en'
      ? '- Write in plain, short English for a farmer. Pond names stay exactly as they are. Times as 13:00.'
      : '- Bahasa Indonesia sederhana untuk petani, tanpa singkatan. Jam ditulis 13.00. Desimal pakai koma (1,5 °C).',
  ].join('\n');

/**
 * Writes the notes for the ponds in `input` (agent when providers are given, rules otherwise).
 * Ponds with too few readings always get the rules note; the agent only sees the others.
 */
export async function runPatterns(input: PatternInput, providers: ChatProvider[], mock = false): Promise<PondPattern[]> {
  const ready = input.ponds.filter((p) => p.model.backtest.n >= MIN_READINGS_FOR_PATTERN);
  const rest = input.ponds.filter((p) => !ready.includes(p)).map((p) => rulesPattern(p, input.now));
  if (mock) return [...input.ponds.map((p) => rulesPattern(p, input.now, 'mock'))];
  if (!ready.length || !providers.length) return [...ready.map((p) => rulesPattern(p, input.now)), ...rest];

  const run = (name: string, args: Record<string, any>): unknown => {
    switch (name) {
      case 'get_ponds':
        return ready.map((p) => ({ pond_id: p.id, name: p.name, profile: profileWords(p), scored_readings: p.model.backtest.n, old_readings: p.model.oldReadings, usually_off_c: p.model.typicalError }));
      case 'get_pond_errors': {
        const p = ready.find((x) => x.id === Number(args.pond_id));
        return p ? pondErrors(p) : { error: 'kolam tidak ada' };
      }
      default:
        return { error: 'alat tidak dikenal' };
    }
  };
  const { result, steps } = await toolLoop(providers, {
    label: 'pattern agent',
    system: SYSTEM(input),
    user:
      currentLang() === 'en'
        ? `Write the weekly pattern note for: ${ready.map((p) => `${p.name} (id ${p.id})`).join(', ')}. In English.`
        : `Tulis catatan pola minggu ini untuk: ${ready.map((p) => `${p.name} (id ${p.id})`).join(', ')}.`,
    tools: TOOLS,
    submit: 'submit_patterns',
    maxRounds: 4 + ready.length * 2,
    session: () => ({
      run,
      finish: (args, steps, model) =>
        ready.map((p) => {
          const proposal = (Array.isArray(args.ponds) ? args.ponds : []).find((x: any) => Number(x?.pond_id) === p.id);
          const ok = proposal ? guardPattern(p, proposal) : null;
          if (!ok) return rulesPattern(p, input.now, 'rules', steps);
          return { pondId: p.id, ...ok, source: 'agent' as const, model, steps, generatedAt: input.now, lang: currentLang(), readings: p.model.backtest.n };
        }),
    }),
  });
  return [...(result ?? ready.map((p) => rulesPattern(p, input.now, 'rules', steps))), ...rest];
}
