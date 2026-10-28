// Reads a voice round: the farmer walks the farm and talks about many ponds in one recording
// ("Kolam A suhune pitulikur, pH pitu koma papat. Kolam B suhu 29, ana sing mati loro ...").
// The model only splits the transcript into mentions. Everything after that is checked here,
// without the model: pond names are matched again locally, repeated mentions are merged, and
// numbers that cannot be right are fixed (only when the fix is certain) or flagged.
// Nothing here is saved: each pond's draft is checked by the farmer first.
import type { AutoFix, ReadingField, RoundDraft, RoundIssue, RoundResult } from './contract.ts';
import type { Behavior, LogData } from './domain.ts';

export interface RoundPond {
  id: number;
  name: string;
  nicknames: string[];
}

// ---------- What the model returns ----------

const BEHAVIORS: Behavior[] = ['normal', 'surfacing', 'gathering_inlet', 'not_eating', 'lethargic'];

const FIELD_SCHEMA = {
  temperature: { type: ['number', 'null'], description: 'Suhu air °C, persis seperti terdengar' },
  ph: { type: ['number', 'null'], description: 'Persis seperti terdengar' },
  tds: { type: ['number', 'null'], description: 'ppm' },
  mortality: { type: ['integer', 'null'], description: 'Jumlah sidat mati yang disebut' },
  behavior: { type: 'array', items: { enum: BEHAVIORS } },
  feeding_leftover: { enum: ['none', 'little', 'much', null] },
  water_color: { enum: ['clear', 'green', 'brown', 'cloudy', null] },
  water_smell: { enum: ['normal', 'foul', null] },
  aeration: { enum: ['on', 'weak', 'off', null] },
  note: { type: ['string', 'null'], description: 'Hal penting lain, singkat, bahasa Indonesia' },
};
const FIELD_KEYS = Object.keys(FIELD_SCHEMA);

// Strict JSON schema: every key present, null when unknown.
export const ROUND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['loose', 'mentions'],
  properties: {
    loose: {
      type: 'object',
      additionalProperties: false,
      required: ['quote', ...FIELD_KEYS],
      properties: { quote: { type: 'string', description: 'Kata-kata yang bukan milik kolam mana pun; "" bila tidak ada' }, ...FIELD_SCHEMA },
    },
    mentions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['pond_as_heard', 'pond_id', 'quote', 'unclear_text', ...FIELD_KEYS],
        properties: {
          pond_as_heard: { type: 'string', description: 'Nama kolam persis seperti diucapkan' },
          pond_id: { type: ['integer', 'null'] },
          quote: { type: 'string', description: 'Kata-kata transkrip tentang kolam ini' },
          unclear_text: { type: ['string', 'null'], description: 'Bagian tentang kolam ini yang tidak bisa dipahami' },
          ...FIELD_SCHEMA,
        },
      },
    },
  },
} as const;

export function roundInstructions(ponds: RoundPond[]): string {
  const list = ponds.map((p) => `${p.id}: ${p.name}${p.nicknames.length ? `; dipanggil juga ${p.nicknames.map((n) => `"${n}"`).join(', ')}` : ''}`);
  return [
    'Kamu membantu petani sidat di Indonesia mencatat keliling kolam. Petani berjalan dan bicara (bahasa Indonesia atau Jawa) tentang banyak kolam dalam satu rekaman. Pecah transkrip per kolam, urut sesuai ucapan.',
    'Daftar kolam (id: nama):',
    ...list,
    'Aturan:',
    '- Satu item mentions setiap kali sebuah kolam disebut. Kolam yang disebut lagi nanti jadi item baru, jangan digabung.',
    '- pond_as_heard: nama kolam persis seperti diucapkan, tanpa kata lain ("Kolam B maneh" → "Kolam B"). pond_id: id dari daftar bila jelas cocok, selain itu null. Jangan menebak.',
    '- Angka atau keterangan sebelum nama kolam pertama, atau yang bukan milik kolam mana pun, masuk loose, dengan kata-katanya di loose.quote.',
    '- Isi null bila tidak disebut. Tulis angka seperti terdengar, jangan dibetulkan.',
    '- unclear_text: kata-kata tentang kolam itu yang tidak bisa dipahami, selain itu null.',
    '- Angka Jawa: siji 1, loro 2, telu 3, papat 4, lima 5, enem 6, pitu 7, wolu 8, sanga 9, sepuluh 10, selikur 21, rolikur 22, telulikur 23, patlikur 24, selawe 25, nemlikur 26, pitulikur 27, wolulikur 28, sangalikur atau "selikur sanga" 29, telung puluh 30.',
    '- "koma" adalah desimal: "pitu koma papat" = 7.4, "dua delapan koma lima" = 28.5. Angka disebut per digit tanpa koma ditulis gabung: "pitu papat" = 74.',
    '- suhune = suhu; banyune rada ijo = air agak hijau (green); ana sing mati loro = mortality 2; pakane isih akeh = sisa pakan banyak (much); pakane entek = habis (none).',
    '- Ini pencatatan, bukan diagnosis. Jangan menambah saran.',
  ].join('\n');
}

// ---------- Pond names ----------

// Words around a pond's name that carry no identity: "kolam", "bak", "nomor" ...
const FILLER = new Set([
  'kolam', 'kolame', 'bak', 'bake', 'tambak', 'empang', 'blumbang', 'nomor', 'nomer', 'no', 'sing', 'yang',
  'lagi', 'maneh', 'meneh', 'ini', 'itu', 'iki', 'kuwi', // "Kolam B maneh" = Kolam B again
]);
// Letters as they are spoken ("kolam be" = Kolam B).
const LETTERS: Record<string, string> = {
  be: 'b', ce: 'c', se: 'c', de: 'd', ef: 'f', ge: 'g', ha: 'h', je: 'j', ka: 'k', el: 'l', em: 'm', en: 'n',
  pe: 'p', ki: 'q', er: 'r', es: 's', te: 't', ve: 'v', fe: 'v', we: 'w', ye: 'y', zet: 'z',
};
// Small numbers in Indonesian and Javanese ("kolam telu" = Kolam 3).
const NUMBERS: Record<string, string> = {
  satu: '1', siji: '1', setunggal: '1', dua: '2', loro: '2', kalih: '2', tiga: '3', telu: '3', empat: '4', papat: '4', sekawan: '4',
  lima: '5', gangsal: '5', enam: '6', enem: '6', tujuh: '7', pitu: '7', delapan: '8', wolu: '8', sembilan: '9', sanga: '9',
  sepuluh: '10', sedasa: '10', sebelas: '11', sewelas: '11', rolas: '12',
};

function tokens(name: string): string[] {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !FILLER.has(t))
    .map((t) => LETTERS[t] ?? NUMBERS[t] ?? t);
}

/** "Kolam B" → "b", "kolam be" → "b", "kolam a siji" → "a1", "kolam pojok" → "pojok". */
export function pondKey(name: string): string {
  return tokens(name).join('');
}

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

/** Matches a spoken pond name to one pond, locally. The model's guess only ever becomes a suggestion. */
export function matchPond(heard: string, ponds: RoundPond[], modelGuess: number | null = null): { pondId: number | null; suggestions: number[] } {
  const key = pondKey(heard);
  const heardTokens = new Set(tokens(heard));
  const keysOf = (p: RoundPond) => [p.name, ...p.nicknames].map(pondKey).filter(Boolean);
  const exact = key ? ponds.filter((p) => keysOf(p).includes(key)) : [];
  if (exact.length === 1) return { pondId: exact[0].id, suggestions: [] };
  const near = key
    ? ponds.filter((p) =>
        [p.name, ...p.nicknames].some((n) => {
          const k = pondKey(n);
          if (!k) return false;
          if (tokens(n).some((t) => t.length > 1 && heardTokens.has(t))) return true;
          if (k.startsWith(key) || (k.length > 1 && key.length > 1 && (k.includes(key) || key.includes(k)))) return true;
          return k.length > 2 && distance(k, key) <= 1;
        }),
      )
    : [];
  const guess = ponds.filter((p) => p.id === modelGuess);
  const order = [...exact, ...guess, ...near, ...ponds].map((p) => p.id);
  return { pondId: null, suggestions: [...new Set(order)] };
}

// ---------- Numbers ----------

type Readings = Partial<Record<ReadingField, number>>;
const READING_FIELDS: ReadingField[] = ['temperature', 'ph', 'tds'];
const PLAUSIBLE: Record<ReadingField, [number, number]> = { temperature: [15, 38], ph: [4, 10], tds: [20, 2000] };
const UNIT: Record<ReadingField, string> = { temperature: ' °C', ph: '', tds: ' ppm' };
const NORM: Record<ReadingField, string> = { temperature: 'Suhu air biasanya 15–38 °C', ph: 'pH air biasanya 6–9', tds: 'TDS air biasanya 20–2000 ppm' };

const round2 = (v: number) => Math.round(v * 100) / 100;
const within = (v: number, [min, max]: [number, number]) => v >= min && v <= max;
/** Indonesian number: 7.4 → "7,4". */
const say = (v: number) => String(round2(v)).replace('.', ',');

interface Checked {
  value?: number;
  autoFix?: AutoFix;
  issue?: RoundIssue;
}

/** One spoken reading: plausible, fixed without asking (pH 74 → 7,4), or flagged for the farmer. */
export function checkReading(field: ReadingField, v: number): Checked {
  const range = PLAUSIBLE[field];
  if (within(v, range)) return { value: v };
  if (field === 'ph' && v > 14 && within(v / 10, range)) {
    const value = round2(v / 10);
    return { value, autoFix: { field, heard: say(v), value } };
  }
  let suggestion: number | null = null;
  let note = NORM[field];
  if (field === 'temperature') {
    // "selikur sanga" heard only as "sanga": the tens got lost.
    if (within(v + 20, [25, 35])) [suggestion, note] = [v + 20, `${note}. Mungkin awal angkanya tidak terdengar.`];
    else if (within(v / 10, [20, 35])) suggestion = round2(v / 10);
  } else if (field === 'ph') {
    if (v > 14 && within(v / 100, range)) suggestion = round2(v / 100);
    else if (v < range[0] && v > 0 && within(v * 10, range)) suggestion = round2(v * 10);
  } else if (v > 0 && v < range[0] && within(v * 1000, range)) {
    [suggestion, note] = [round2(v * 1000), `${note}. Mungkin satuannya beda.`];
  }
  return { issue: { kind: 'implausible', field, heard: `${say(v)}${UNIT[field]}`, suggestion, note } };
}

// ---------- Mentions ----------

interface Mention {
  heard: string;
  modelGuess: number | null;
  quote: string;
  readings: Partial<Record<ReadingField, number>>; // as heard, not yet checked
  data: LogData; // everything but readings
  issues: RoundIssue[]; // unclear parts
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

function readMention(raw: Record<string, any>): Mention {
  const readings: Mention['readings'] = {};
  for (const f of READING_FIELDS) if (typeof raw[f] === 'number' && Number.isFinite(raw[f])) readings[f] = raw[f];
  const data: LogData = {};
  const issues: RoundIssue[] = [];
  if (typeof raw.mortality === 'number' && Number.isFinite(raw.mortality)) {
    if (Number.isInteger(raw.mortality) && raw.mortality >= 0 && raw.mortality < 100_000) data.mortality = raw.mortality;
    else issues.push({ kind: 'unclear', text: `mati ${say(raw.mortality)}` });
  }
  const behavior = (Array.isArray(raw.behavior) ? raw.behavior : []).filter((b: Behavior) => BEHAVIORS.includes(b));
  if (behavior.length) data.behavior = [...new Set(behavior)] as Behavior[];
  if (['none', 'little', 'much'].includes(raw.feeding_leftover)) data.feeding = { leftover: raw.feeding_leftover };
  const color = ['clear', 'green', 'brown', 'cloudy'].includes(raw.water_color) ? raw.water_color : undefined;
  const smell = ['normal', 'foul'].includes(raw.water_smell) ? raw.water_smell : undefined;
  if (color || smell) data.water = { ...(color && { color }), ...(smell && { smell }) };
  if (['on', 'weak', 'off'].includes(raw.aeration)) data.aeration = raw.aeration;
  if (str(raw.note)) data.note = str(raw.note).slice(0, 200);
  if (str(raw.unclear_text)) issues.push({ kind: 'unclear', text: str(raw.unclear_text).slice(0, 200) });
  return {
    heard: str(raw.pond_as_heard).slice(0, 60),
    modelGuess: Number.isInteger(raw.pond_id) ? raw.pond_id : null,
    quote: str(raw.quote).slice(0, 500),
    readings,
    data,
    issues,
  };
}

const isEmptyData = (d: LogData) => Object.keys(d).length === 0;

/** Several mentions of one pond become one draft; later words win, a changed reading is asked. */
function merge(mentions: Mention[]): { data: LogData; issues: RoundIssue[]; autoFixed: AutoFix[]; quote: string } {
  const data: LogData = {};
  const issues: RoundIssue[] = [];
  const autoFixed: AutoFix[] = [];
  const readings: Readings = {};
  for (const field of READING_FIELDS) {
    const checked = mentions.flatMap((m) => (m.readings[field] === undefined ? [] : [checkReading(field, m.readings[field]!)]));
    const good = checked.filter((c) => c.value !== undefined);
    if (!good.length) {
      const bad = checked.at(-1)?.issue;
      if (bad) issues.push(bad);
      continue;
    }
    const value = good.at(-1)!.value!;
    readings[field] = value;
    // Distinct values in the order they were last said, so the preselected last one is last.
    const values = good.map((c) => c.value!).filter((v, i, all) => all.lastIndexOf(v) === i);
    if (values.length > 1) issues.push({ kind: 'twice', field, values });
    const fix = [...good].reverse().find((c) => c.autoFix && c.value === value)?.autoFix;
    if (fix) autoFixed.push(fix);
  }
  if (Object.keys(readings).length) data.readings = readings;
  const notes: string[] = [];
  for (const m of mentions) {
    const d = m.data;
    if (d.mortality !== undefined) data.mortality = d.mortality;
    if (d.behavior) data.behavior = [...new Set([...(data.behavior ?? []), ...d.behavior])];
    if (d.feeding) data.feeding = d.feeding;
    if (d.water) data.water = { ...data.water, ...d.water };
    if (d.aeration) data.aeration = d.aeration;
    if (d.note && !notes.includes(d.note)) notes.push(d.note);
    for (const issue of m.issues) if (!issues.some((i) => i.kind === 'unclear' && issue.kind === 'unclear' && i.text === issue.text)) issues.push(issue);
  }
  if (notes.length) data.note = notes.join('; ').slice(0, 200);
  return { data, issues, autoFixed, quote: mentions.map((m) => m.quote).filter(Boolean).join(' … ') };
}

/** Turns the model's answer into checked drafts. Never trusts the model's pond ids or numbers as they are. */
export function guardRound(raw: unknown, ponds: RoundPond[], transcript: string, meta: { model: string; mode: RoundResult['mode'] }): RoundResult {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const mentions = (Array.isArray(body.mentions) ? body.mentions : []).filter((m: unknown) => m && typeof m === 'object').map(readMention);
  const looseRaw = body.loose && typeof body.loose === 'object' ? [readMention(body.loose)] : [];
  // A mention without a pond name is loose talk, whatever the model called it.
  const named = mentions.filter((m: Mention) => m.heard || (m.modelGuess !== null && ponds.some((p) => p.id === m.modelGuess)));
  const unnamed = mentions.filter((m: Mention) => !named.includes(m));

  const groups = new Map<string, { pondId: number | null; heardName: string; suggestions: number[]; mentions: Mention[] }>();
  for (const m of named) {
    const heard = m.heard || ponds.find((p) => p.id === m.modelGuess)!.name;
    const match = matchPond(heard, ponds, m.modelGuess);
    const key = match.pondId !== null ? `id:${match.pondId}` : `heard:${pondKey(heard) || heard.toLowerCase()}`;
    const group = groups.get(key) ?? { ...match, heardName: heard, mentions: [] };
    group.mentions.push(m);
    groups.set(key, group);
  }
  const drafts: RoundDraft[] = [];
  for (const g of groups.values()) {
    const merged = merge(g.mentions);
    if (isEmptyData(merged.data) && !merged.issues.length) continue;
    drafts.push({ pondId: g.pondId, heardName: g.heardName, suggestions: g.suggestions, data: merged.data, issues: merged.issues, autoFixed: merged.autoFixed, quote: merged.quote });
  }

  // Loose numbers keep only what is plausible: there is no pond card to ask on.
  const looseParts = [...looseRaw, ...unnamed];
  const looseMerged = merge(looseParts);
  const loose = isEmptyData(looseMerged.data) ? null : { quote: looseMerged.quote, data: looseMerged.data };
  return { transcript, drafts, loose, empty: !drafts.length && !loose, model: meta.model, mode: meta.mode };
}

// ---------- Mock ----------

/** The design's example round, on this farm's ponds: two clear-ish ponds and one unknown "kolam pojok". */
export function mockRound(ponds: RoundPond[]): RoundResult {
  const byKey = (k: string) => ponds.find((p) => pondKey(p.name) === k);
  const a = byKey('a') ?? ponds[0];
  const b = byKey('b') ?? ponds.find((p) => p !== a);
  const nameA = a?.name ?? 'Kolam A';
  const nameB = b?.name ?? 'Kolam B';
  const quoteA = `${nameA} suhune pitulikur, pH pitu koma papat.`;
  const quoteB = `${nameB} suhu 29, ana sing mati loro, pakane isih akeh.`;
  const quoteC = 'Kolam pojok banyune rada ijo.';
  const empty = { temperature: null, ph: null, tds: null, mortality: null, behavior: [], feeding_leftover: null, water_color: null, water_smell: null, aeration: null, note: null, unclear_text: null };
  const raw = {
    loose: { ...empty, quote: '' },
    mentions: [
      { ...empty, pond_as_heard: nameA, pond_id: a?.id ?? null, quote: quoteA, temperature: 27, ph: 7.4 },
      { ...empty, pond_as_heard: nameB, pond_id: b?.id ?? null, quote: quoteB, temperature: 29, mortality: 2, feeding_leftover: 'much' },
      { ...empty, pond_as_heard: 'kolam pojok', pond_id: null, quote: quoteC, water_color: 'green' },
    ],
  };
  return guardRound(raw, ponds, `Mode contoh: ${quoteA} ${quoteB} ${quoteC}`, { model: 'mock', mode: 'mock' });
}
