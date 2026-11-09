// Replayable runs for the public demo page (web/replay/): what went in, which model calls were made
// (model, time), the code checks with ✓ / ✗, and what the farmer was shown.
//
// Runs come from two places, and every run says which:
//   - 'real': a real model API answered. The benchmark files in docs/eval-results/ (bench.ts) and the
//     AI call ledger of an app database (ai_ledger, ledger.ts).
//   - 'demo': the demo farm with sample answers (SYNTEEL_AI_MOCK): no model was called.
//
// Nothing identifying leaves through here. anonymise() runs over every bundle before it is written:
// people's and farms' names become the pseudonym, phone numbers, e-mail addresses and coordinates are
// removed, and so is any place finer than the village. The app itself never stores audio, photos or the
// farmer's words in the ledger, so a run from an app database has no recording to show.
import type { Db } from './db.ts';
import type { LogData } from './domain.ts';
import type { AiKind, AiStep, Outcome } from './ledger.ts';
import type { Verification } from './verify.ts';

export type Origin = 'real' | 'demo';
type Lang = 'id' | 'en';
/** Words for the page in both languages (one is enough when only one exists). */
export type Words = Partial<Record<Lang, string>>;

export interface ReplayCall {
  step: AiStep;
  provider: string;
  model: string;
  /** Start time, ISO; null when the run kept only totals. */
  at: string | null;
  ms: number | null;
  /** Calls taken together in this line (SAM asks several prompts at once). */
  calls: number;
  outcome: Outcome;
}

export interface ReplayCheck {
  lang: Lang;
  ok: boolean;
  label: string;
  reason?: string;
}

/** Values as the farmer saw them per pond: filled in, or held back as "Cek manual". */
export interface ReplayPond {
  pond: string;
  values: Record<string, number | string>;
  held: string[];
}

export type ReplayResult =
  | { type: 'round'; ponds: ReplayPond[] }
  | { type: 'count'; count: number; low: number; high: number; atLeast: boolean; filled: boolean; truth?: number }
  | { type: 'text'; text: Partial<Record<Lang, string>>; extra?: string[] }
  | { type: 'none'; why: Partial<Record<Lang, string>> };

export interface ReplayRun {
  id: string;
  origin: Origin;
  /** Where the run comes from, in plain words. */
  source: Words;
  kind: AiKind;
  at: string | null;
  input:
    | { type: 'transcript'; text: string; note?: Words }
    | { type: 'photo'; note: Words }
    | { type: 'farm'; note: Words }
    | { type: 'none'; note: Words };
  calls: ReplayCall[];
  /** null: the run did not keep its checks. `partial`: only the outcome and the held fields were kept. */
  checks: { status: 'passed' | 'failed' | null; items: ReplayCheck[]; partial?: boolean } | null;
  result: ReplayResult;
}

export interface RunBundle {
  about: string;
  exportedAt: string;
  runs: ReplayRun[];
}

// ---------- Anonymiser ----------

export interface AnonymiseOptions {
  /** People's names (from the database's users): they become the pseudonym. */
  names?: string[];
  /** Farm names: they become "Tambak mitra" (a business name is never published). */
  farms?: string[];
  /** Place names finer than the village (hamlets, the farm's own address line): removed. */
  places?: string[];
  /** What a person's name becomes. */
  pseudonym?: string;
}

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
// Indonesian numbers: +62 / 62 / 08…, 9 to 13 digits with spaces, dots or dashes in between.
const PHONE = /(?<![\p{N}.,])(?:\+?62[\s.-]?|0)8[\d\s.-]{7,15}\d(?![\p{N}])/gu;
// Coordinates with 3 or more decimals (about 100 m and finer), alone or as a pair.
const COORD = /-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}|-?\d{1,3}\.\d{4,}/g;
// Places finer than the village: a street, alley or hamlet word with the capitalised words and numbers
// that name it ("Jl. Kaliurang Km 5", "Dusun Karanglo"; "aerator jalan normal" stays), and RT/RW numbers.
const FINE_PLACE = /(?<![\p{L}])(?:Jl\.|JL\.|Jalan|Gang|Gg\.|Dusun|Dsn\.|Dukuh|Padukuhan)(?:\s*(?:\p{Lu}[\p{L}\p{N}'-]*\.?|\d+\p{L}?|Km\.?|No\.?))+|(?<![\p{L}])(?:RT|RW)\s*\.?\s*\d+(?:\s*\/\s*(?:RW\s*\.?\s*)?\d+)?/gu;
// Keys whose values identify someone or somewhere: dropped whole.
const DROP_KEYS = new Set(['phone', 'email', 'lat', 'lon', 'latitude', 'longitude', 'address', 'alamat', 'image', 'images', 'photo', 'audio', 'face', 'owner', 'userId', 'user_id', 'createdBy', 'accountPhone', 'replyPhone']);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const replaceAll = (s: string, list: string[] | undefined, by: string, honorific = false) => {
  // Longest first, so "Pak Budi Santoso" goes before "Budi"; a "Pak"/"Bu" in front goes with the name.
  const title = honorific ? '(?:(?:Pak|Bapak|Bu|Ibu|Mas|Mbak)\\s+)?' : '';
  for (const name of [...new Set(list ?? [])].map((n) => n.trim()).filter((n) => n.length >= 3 && n !== by).sort((a, b) => b.length - a.length)) {
    s = s.replace(new RegExp(`(?<![\\p{L}\\p{N}])${title}${escape(name)}(?![\\p{L}\\p{N}])`, 'giu'), by);
  }
  return s;
};

/** Removes phone numbers, e-mail addresses, coordinates and fine places, and puts the pseudonym for known names. */
export function anonymiseText(text: string, o: AnonymiseOptions = {}): string {
  let s = text.replace(EMAIL, '[email]').replace(PHONE, '[nomor]').replace(COORD, '[lokasi]').replace(FINE_PLACE, '[lokasi]');
  s = replaceAll(s, o.places, '[lokasi]');
  s = replaceAll(s, o.farms, 'Tambak mitra');
  return replaceAll(s, o.names, o.pseudonym ?? 'Pak Budi', true);
}

/** A deep copy with every string cleaned and identifying keys dropped. */
export function anonymise<T>(value: T, o: AnonymiseOptions = {}): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return anonymiseText(v, o);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !DROP_KEYS.has(k)).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

// ---------- From an app database (ai_ledger) ----------

type Row = Record<string, unknown>;
const NOT_KEPT: Partial<Record<AiKind, ReplayRun['input']>> = {
  round: { type: 'none', note: { id: 'Keliling suara: rekaman dan kata-katanya tidak disimpan aplikasi.', en: 'Voice round: the recording and its words are not kept by the app.' } },
  voice: { type: 'none', note: { id: 'Catatan suara: rekamannya tidak disimpan aplikasi.', en: 'Voice note: the recording is not kept by the app.' } },
  transcribe: { type: 'none', note: { id: 'Suara: rekamannya tidak disimpan aplikasi.', en: 'Voice: the recording is not kept by the app.' } },
  video: { type: 'none', note: { id: 'Video harian: tidak disimpan aplikasi.', en: 'Daily video: not kept by the app.' } },
  photo: { type: 'photo', note: { id: 'Foto alat ukur: tidak disimpan aplikasi.', en: 'Meter photo: not kept by the app.' } },
  count: { type: 'photo', note: { id: 'Foto sidat mati: tidak disimpan aplikasi.', en: 'Photo of dead eels: not kept by the app.' } },
  notebook: { type: 'photo', note: { id: 'Foto halaman buku catatan: tidak disimpan aplikasi.', en: 'Notebook page photo: not kept by the app.' } },
  pond_photo: { type: 'photo', note: { id: 'Foto kolam: tidak disimpan aplikasi.', en: 'Pond photo: not kept by the app.' } },
  briefing: { type: 'farm', note: { id: 'Catatan tambak, perkiraan dan cuaca sore itu.', en: "The farm's records, forecast and weather of that evening." } },
  case: { type: 'farm', note: { id: 'Kasus sidat mati: jumlah mati per hari, jawaban petani dan catatan kolam.', en: "The dead-eel case: deaths per day, answers and the pond's records." } },
  spoken: { type: 'farm', note: { id: 'Teks di layar Waspada.', en: 'The text on the Waspada screen.' } },
  pattern: { type: 'farm', note: { id: 'Model suhu air kolam dan ukuran minggu itu.', en: "The pond's water temperature model and readings of the week." } },
};

const checksOf = (json: unknown, lang: Lang): ReplayRun['checks'] => {
  if (typeof json !== 'string') return null;
  const v = JSON.parse(json) as Verification;
  return { status: v.status, items: v.checks.map((c) => ({ lang, ok: c.ok, label: c.label, ...(c.reason && { reason: c.reason }) })) };
};

const VALUE_KEYS = ['temperature', 'ph', 'tds', 'do', 'tan', 'no2'] as const;
/** A saved log as the values the farmer kept. */
export function logValues(d: LogData): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const k of VALUE_KEYS) if (d.readings?.[k] !== undefined) out[k] = d.readings[k]!;
  if (d.mortality !== undefined) out.mortality = d.mortality;
  if (d.water?.color) out.color = d.water.color;
  if (d.water?.smell) out.smell = d.water.smell;
  if (d.feeding?.leftover) out.leftover = d.feeding.leftover;
  if (d.aeration) out.aeration = d.aeration;
  if (d.behavior?.length) out.behavior = d.behavior.join(', ');
  return out;
}

/**
 * Runs from an app database's AI call ledger, newest first. `origin` says what the database holds:
 * 'real' for a server with real model keys, 'demo' for a mock-AI demo database.
 */
export function runsFromLedger(db: Db, o: { origin: Origin; source: Words; since?: string; farmIds?: number[]; kinds?: AiKind[]; limit?: number; lang?: Lang }): ReplayRun[] {
  const lang = o.lang ?? 'id';
  const rows = db.prepare('select * from ai_ledger where started_at >= ? order by started_at, id').all(o.since ?? '0000') as Row[];
  const byRequest = new Map<string, Row[]>();
  for (const r of rows) {
    if (o.farmIds && !o.farmIds.includes(r.farm_id as number)) continue;
    if (o.kinds && !o.kinds.includes(r.kind as AiKind)) continue;
    byRequest.set(r.request_id as string, [...(byRequest.get(r.request_id as string) ?? []), r]);
  }
  const pondName = (id: unknown) => (id ? ((db.prepare('select name from ponds where id = ?').get(id as number) as Row | undefined)?.name as string | undefined) : undefined);
  const runs: ReplayRun[] = [];
  for (const [id, list] of [...byRequest].reverse().slice(0, o.limit ?? 50)) {
    const first = list[0];
    const kind = first.kind as AiKind;
    const ref = (list.find((r) => r.result_ref)?.result_ref as string | undefined) ?? null;
    runs.push({
      id: `${o.origin}-${id.slice(0, 8)}`,
      origin: o.origin,
      source: o.source,
      kind,
      at: first.started_at as string,
      input: NOT_KEPT[kind] ?? { type: 'none', note: { id: 'Tidak disimpan aplikasi.', en: 'Not kept by the app.' } },
      calls: list.map((r) => ({ step: r.step as AiStep, provider: r.provider as string, model: r.model as string, at: r.started_at as string, ms: r.ms as number, calls: 1, outcome: r.outcome as Outcome })),
      checks: checksOf(list.find((r) => r.verify)?.verify, lang),
      result: resultOf(db, ref, id, pondName(first.pond_id)),
    });
  }
  return runs;
}

/** What the request became: a saved log, a case update, a briefing; otherwise only a draft that was shown. */
function resultOf(db: Db, ref: string | null, requestId: string, pond: string | undefined): ReplayResult {
  const [what, num] = (ref ?? '').split(':');
  if (what === 'log' && num) {
    const r = db.prepare('select l.data, p.name from logs l join ponds p on p.id = l.pond_id where l.id = ?').get(Number(num)) as Row | undefined;
    if (r) return { type: 'round', ponds: [{ pond: r.name as string, values: logValues(JSON.parse(r.data as string) as LogData), held: [] }] };
  }
  if (what === 'case' && num) {
    const events = db.prepare("select data from case_events where case_id = ? and kind = 'run' order by id").all(Number(num)) as Row[];
    const run = events.map((e) => JSON.parse(e.data as string)).find((d) => d.trace === requestId) ?? null;
    if (run) return { type: 'text', text: { [run.lang ?? 'id']: run.summary }, extra: [...(run.watch ?? []), ...(run.checks ?? []).map((c: { action: string }) => c.action)] };
  }
  if (what === 'briefing' && num) {
    const r = db.prepare('select body, lang from briefings where id = ?').get(Number(num)) as Row | undefined;
    if (r) {
      const b = JSON.parse(r.body as string);
      return { type: 'text', text: { [(r.lang as string) ?? 'id']: b.summary }, extra: (b.checks ?? []).filter((c: { source: string }) => c.source === 'agent').map((c: { action: string }) => c.action) };
    }
  }
  return {
    type: 'none',
    why: {
      id: `Draf ditampilkan${pond ? ` untuk ${pond}` : ''}; isinya tidak disimpan aplikasi kecuali petani menyimpannya.`,
      en: `A draft was shown${pond ? ` for ${pond}` : ''}; the app keeps its content only when the farmer saves it.`,
    },
  };
}

// ---------- From a benchmark result file (docs/eval-results/*.json, bench.ts) ----------

interface BenchItem {
  id: string;
  verify: 'passed' | 'failed' | null;
  ms: number;
  calls: number;
  answeredBy: string[];
  fallbacks: number;
  detail: Record<string, any>;
  error?: string;
  /** Present in runs made with the replay capture: every check, each call, what was shown. */
  replay?: { calls: ReplayCall[]; checks: ReplayCheck[]; result: ReplayResult };
}
interface BenchFile {
  date: string;
  label: string;
  mode: 'live' | 'mock';
  calls: number;
  tasks: Record<string, { route: string[]; items: BenchItem[] }>;
}
interface Labelled {
  rounds: { ponds: { id: number; name: string }[]; items: { id: string; transcript: string; expect: ({ pond: number } & Record<string, number | string>)[] }[] };
  counts: { items: { id: string; truth: number; label: string; countedBy: string }[] };
}

const FIELD_OF_HELD: Record<string, Record<Lang, string>> = {
  temperature: { id: 'suhu', en: 'temperature' },
  ph: { id: 'pH', en: 'pH' },
  tds: { id: 'TDS', en: 'TDS' },
  do: { id: 'oksigen', en: 'oxygen' },
  mortality: { id: 'jumlah mati', en: 'number dead' },
};
/** "Kolam ce siji temperature" (as the benchmark kept it) → 'suhu di "Kolam ce siji"'. */
const heldWords = (h: string, lang: Lang) => {
  const field = h.split(' ').at(-1)!;
  const said = h.slice(0, -field.length - 1);
  const name = FIELD_OF_HELD[field]?.[lang] ?? field;
  return lang === 'id' ? `${name} di "${said}"` : `${name} for "${said}"`;
};

/**
 * Runs from a saved benchmark. A live run is 'real' (the model API answered), a --mock run is 'demo'.
 * Older files kept only each item's outcome, held fields and totals: those runs say so (`partial`).
 */
export function runsFromBench(file: BenchFile, labelled: Labelled, fileName: string): ReplayRun[] {
  const origin: Origin = file.mode === 'live' ? 'real' : 'demo';
  const where = `docs/eval-results/${fileName}`;
  const source: Words =
    file.mode === 'live'
      ? { id: `Uji dengan API model nyata, ${file.date}, ${file.calls} panggilan model (${where})`, en: `Real API run, ${file.date}, ${file.calls} model ${file.calls === 1 ? 'call' : 'calls'} (${where})` }
      : { id: `Uji tiruan, jawaban dari label tanpa model, ${file.date} (${where})`, en: `Mock run, answers from the labels, no model, ${file.date} (${where})` };
  const runs: ReplayRun[] = [];
  for (const [task, t] of Object.entries(file.tasks)) {
    for (const item of t.items) {
      if (item.error) continue;
      const round = task === 'extract' ? labelled.rounds.items.find((i) => i.id === item.id) : undefined;
      const photo = task === 'segment' ? labelled.counts.items.find((i) => i.id === item.id) : undefined;
      if (!round && !photo) continue;
      const kind: AiKind = round ? 'round' : 'count';
      const input: ReplayRun['input'] = round
        ? {
            type: 'transcript',
            text: round.transcript,
            note: { id: 'Kalimat uji yang diketik (bahasa Jawa dan Indonesia) dari eval/labelled/rounds.json, bukan rekaman petani.', en: 'Typed test sentence (Javanese and Indonesian) from eval/labelled/rounds.json, not a farmer recording.' },
          }
        : {
            type: 'photo',
            note: {
              id: `Foto uji dari internet ("${photo!.label}"): tidak ditampilkan karena bukan milik kami. Jumlah sebenarnya ${photo!.truth}, ${photo!.countedBy === 'user' ? 'dicek orang' : 'dihitung tangan'}.`,
              en: `Test photo from the internet ("${photo!.label}"): not shown, it is not ours to publish. True count ${photo!.truth}, ${photo!.countedBy === 'user' ? 'checked by a person' : 'counted by hand'}.`,
            },
          };
      if (item.replay) {
        runs.push({ id: `${file.date}-${file.label}-${item.id}`, origin, source, kind, at: item.replay.calls[0]?.at ?? null, input, calls: item.replay.calls, checks: { status: item.verify, items: item.replay.checks }, result: item.replay.result });
        continue;
      }
      // Older file: totals per item. The calls are one line per model that answered.
      const calls: ReplayCall[] = item.answeredBy.map((m) => {
        const [provider, ...rest] = m.split('/');
        return { step: round ? 'read' : 'segment', provider, model: rest.join('/'), at: null, ms: item.ms, calls: item.calls, outcome: item.fallbacks ? 'fallback' : 'ok' };
      });
      // Held fields were kept as "<name as heard> <field>"; the name as heard is not the pond's name,
      // so a held field goes to the one labelled pond that has that field (none when two have it).
      const held: string[] = item.detail.held ?? [];
      const items: ReplayCheck[] = round
        ? [
            { lang: 'id', ok: held.length === 0, label: 'Setiap angka terdengar di rekaman', ...(held.length && { reason: `Ditahan: ${held.map((h) => heldWords(h, 'id')).join(', ')}` }) },
            { lang: 'en', ok: held.length === 0, label: 'Every number was heard in the recording', ...(held.length && { reason: `Held back: ${held.map((h) => heldWords(h, 'en')).join(', ')}` }) },
          ]
        : [];
      let result: ReplayResult;
      if (round) {
        // right === total and nothing wrong: the model's values equal the labels for every labelled field.
        const exact = item.detail.right === item.detail.total && !(item.detail.wrong ?? []).length;
        const heldFields = held.map((h) => h.split(' ').at(-1)!);
        result = {
          type: 'round',
          ponds: round.expect.map((e) => {
            const values = Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'pond'));
            return {
              pond: labelled.rounds.ponds.find((p) => p.id === e.pond)?.name ?? `#${e.pond}`,
              values: exact ? values : {},
              held: heldFields.filter((f) => FIELD_OF_HELD[f] && values[f] !== undefined && round.expect.filter((x) => x[f] !== undefined).length === 1),
            };
          }),
        };
      } else {
        const d = item.detail;
        result = { type: 'count', count: d.count, low: d.low, high: d.high, atLeast: d.atLeast, filled: item.verify === 'passed', truth: d.truth };
      }
      runs.push({ id: `${file.date}-${file.label}-${item.id}`, origin, source, kind, at: null, input, calls, checks: { status: item.verify, items, partial: true }, result });
    }
  }
  return runs;
}
