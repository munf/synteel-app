// Verify before show: every model result passes these code checks before the farmer sees it.
// No model is asked here; the checks are plain rules, so they hold when the AI is wrong:
//   - readings within plausible ranges, units as the app expects them;
//   - a drafted log only holds numbers that were actually said, and names a pond on this farm;
//   - a dead-eel count has real outlines, its ways of counting agree, and the outlines have sane sizes;
//   - advice never says "safe" where the fixed alarm rules (rules.ts, nowcast.ts) see danger,
//     and never names a medicine, a dose or a diagnosis.
// A field that fails is taken out of the draft and shown as "Cek manual" with the reason; the
// farmer fills it in by hand. Nothing here throws: a failed check is an answer, not an error.
import { currentLang, tx } from './i18n.ts';
import type { RoundDraft, RoundIssue, RoundResult } from './contract.ts';
import type { LogData } from './domain.ts';
import { unsafeText } from './agentloop.ts';
import { pondKey, type RoundPond } from './round.ts';
import type { CountResult } from './sam.ts';

export type CheckId = 'range' | 'unit' | 'heard' | 'pond' | 'masks' | 'agree' | 'area' | 'rules' | 'safe' | 'data' | 'form' | 'rows';

export interface VerifyCheck {
  id: CheckId;
  ok: boolean;
  /** What was checked, in plain words ("Angka masuk akal"). */
  label: string;
  /** Why it failed, in plain words; absent when ok. */
  reason?: string;
  /** The draft field the check is about, when it is about one. */
  field?: string;
}

export interface Verification {
  status: 'passed' | 'failed';
  checks: VerifyCheck[];
}

/** A drafted value held back by a failed check: shown as "Cek manual", never filled in by itself. */
export interface HeldField {
  field: 'temperature' | 'ph' | 'tds' | 'do' | 'mortality';
  value: number;
  reason: string;
}

export const verification = (checks: VerifyCheck[]): Verification => ({ status: checks.every((c) => c.ok) ? 'passed' : 'failed', checks });

/** The reasons of the failed checks, for a short "Cek manual" line. */
export const failedReasons = (v: Verification | null | undefined) => (v?.checks ?? []).filter((c) => !c.ok).map((c) => c.reason ?? c.label);

/** English singular or plural after a count: "1 outline", "2 outlines". Indonesian needs none. */
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const say = (v: number) => (currentLang() === 'en' ? String(Math.round(v * 100) / 100) : String(Math.round(v * 100) / 100).replace('.', ','));

// ---------- Readings ----------

type Field = HeldField['field'];
/** What pond water can plausibly read. Wider than the alarm limits: those warn, these doubt. DO in mg/L. */
export const PLAUSIBLE: Record<Exclude<Field, 'mortality'>, [number, number]> = { temperature: [15, 38], ph: [4, 10], tds: [20, 2000], do: [0, 20] };
const NAME: Record<Field, () => string> = {
  temperature: () => tx('Suhu', 'Temperature'),
  ph: () => 'pH',
  tds: () => 'TDS',
  do: () => tx('Oksigen air', 'Oxygen in the water'),
  mortality: () => tx('Sidat mati', 'Dead eels'),
};
const UNIT: Record<Field, string> = { temperature: ' °C', ph: '', tds: ' ppm', do: ' mg/L', mortality: '' };

/** One reading against its plausible range; the reason hints at a unit mix-up when that fits. */
export function rangeCheck(field: Exclude<Field, 'mortality'>, v: number): VerifyCheck {
  const [min, max] = PLAUSIBLE[field];
  const label = tx(`${NAME[field]()} masuk akal`, `${NAME[field]()} is plausible`);
  if (Number.isFinite(v) && v >= min && v <= max) return { id: 'range', ok: true, label, field };
  const hint =
    field === 'temperature' && v > 50 && v < 105
      ? tx(' Mungkin terbaca dalam °F.', ' Maybe it was read in °F.')
      : field === 'tds' && v > 0 && v < min
        ? tx(' Mungkin satuannya ppt.', ' Maybe the unit is ppt.')
        : '';
  return {
    id: 'range',
    ok: false,
    label,
    field,
    reason: tx(`${NAME[field]()} ${say(v)}${UNIT[field]} di luar ${say(min)}–${say(max)}${UNIT[field]}.${hint}`, `${NAME[field]()} ${say(v)}${UNIT[field]} is outside ${say(min)}–${say(max)}${UNIT[field]}.${hint}`),
  };
}

// The model is told to convert "x10" and ppt displays to ppm and say so in its note; a converted
// number is the AI's arithmetic, not a reading, so the farmer checks it.
const CONVERTED_TDS = /\b(x\s?10|×\s?10|ppt|kali\s+sepuluh|times\s+ten)\b/i;
const CONVERTED_TEMP = /(°\s?F\b|\bfahrenheit\b)/i;

// ---------- Numbers in what was said ----------

const UNITS: Record<string, number> = {
  nol: 0, kosong: 0, zero: 0, oh: 0,
  satu: 1, siji: 1, setunggal: 1, one: 1, dua: 2, loro: 2, kalih: 2, two: 2, tiga: 3, telu: 3, tigo: 3, three: 3,
  empat: 4, papat: 4, sekawan: 4, four: 4, lima: 5, gangsal: 5, five: 5, enam: 6, enem: 6, six: 6,
  tujuh: 7, pitu: 7, seven: 7, delapan: 8, wolu: 8, eight: 8, sembilan: 9, sanga: 9, songo: 9, nine: 9,
};
const WHOLE: Record<string, number> = {
  sepuluh: 10, sedasa: 10, ten: 10, sebelas: 11, sewelas: 11, eleven: 11, rolas: 12, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  // Javanese twenties: selikur 21 … sangalikur 29; selawe 25; seket 50; sewidak 60; satus 100.
  selikur: 21, rolikur: 22, telulikur: 23, patlikur: 24, selawe: 25, nemlikur: 26, pitulikur: 27, wolulikur: 28, sangalikur: 29,
  seket: 50, sewidak: 60, seratus: 100, satus: 100, seribu: 1000, sewu: 1000,
  rong: 2, telung: 3, patang: 4, limang: 5, nem: 6, pitung: 7, wolung: 8, sangang: 9, // "telung puluh" = 30
};
const MULT: Record<string, number> = { puluh: 10, ratus: 100, atus: 100, hundred: 100, ribu: 1000, thousand: 1000, ewu: 1000 };
const TEEN = new Set(['belas']);
const POINT = new Set(['koma', 'point', 'titik']);

const isNumberWord = (w: string) => w in UNITS || w in WHOLE || w in MULT || TEEN.has(w) || w === 'likur' || /^\d+([.,]\d+)?$/.test(w);
const digitsOf = (w: string): number | null => (/^\d+([.,]\d+)?$/.test(w) ? Number(w.replace(',', '.')) : null);

/** "seratus enam puluh dua" → 162, "twenty eight" → 28, "telung puluh" → 30, "dua belas" → 12. */
function compose(words: string[]): number | null {
  let total = 0; // thousands done
  let group = 0; // below a thousand, in progress
  let last = 0; // the last term added, which "puluh", "belas", "ratus" act on
  let seen = false;
  for (const w of words) {
    const v = digitsOf(w) ?? (w in UNITS ? UNITS[w] : w in WHOLE ? WHOLE[w] : null);
    if (v !== null) {
      group += v;
      last = v;
      seen = true;
    } else if (TEEN.has(w) || w === 'likur') {
      const add = w === 'likur' ? 20 : 10;
      group += add;
      last += add;
    } else if (w in MULT && MULT[w] < 1000) {
      const term = (last || 1) * MULT[w];
      group += term - last;
      last = term;
      seen = true;
    } else if (w in MULT) {
      total += (group || 1) * MULT[w];
      group = 0;
      last = 0;
      seen = true;
    } else return null;
  }
  return seen ? total + group : null;
}

/** "dua delapan" → 28: numbers said digit by digit. */
function concat(words: string[]): number | null {
  if (!words.length || !words.every((w) => w in UNITS || /^\d$/.test(w))) return null;
  return Number(words.map((w) => (w in UNITS ? UNITS[w] : w)).join(''));
}

/**
 * "selikur sanga" → 29: spoken Javanese also says the twenties as "selikur" (21) and then the last digit,
 * the way round.ts tells the model to read it. Only a 21–29 word followed by one digit word.
 */
function likur(words: string[]): number | null {
  if (words.length !== 2 || !(WHOLE[words[0]] > 20 && WHOLE[words[0]] < 30) || !/likur$/.test(words[0])) return null;
  const unit = UNITS[words[1]];
  return unit >= 1 && unit <= 9 ? 20 + unit : null;
}

/** Every value a run of number words can mean, digit by digit or composed, whole or in part. */
function readings(words: string[]): number[] {
  const out: number[] = [];
  const whole = (ws: string[]) => [compose(ws), concat(ws), likur(ws)].filter((v): v is number => v !== null);
  for (let i = 0; i < words.length; i++) for (let j = i + 1; j <= Math.min(words.length, i + 4); j++) out.push(...whole(words.slice(i, j)));
  return out;
}

/**
 * Every number a transcript can be heard to say: digits ("28,6"), Indonesian, Javanese and English
 * number words ("dua delapan koma enam", "pitulikur", "twenty-eight point six"). Generous on purpose:
 * a number missing from this list was surely never said.
 */
export function numbersSaid(text: string): number[] {
  const words = text.toLowerCase().match(/\d+(?:[.,]\d+)?|[a-z]+/g) ?? [];
  const out: number[] = [];
  let run: string[] = [];
  const flush = () => {
    if (!run.length) return;
    const at = run.findIndex((w) => POINT.has(w));
    if (at > 0 && at < run.length - 1) {
      const ints = readings(run.slice(0, at)).filter((v) => Number.isInteger(v));
      const fracWords = run.slice(at + 1);
      // "koma enam" = .6, "koma dua lima" = .25, "point two five" = .25; also only the first digit.
      const fracs = [concat(fracWords), concat(fracWords.slice(0, 1)), concat(fracWords.slice(0, 2)), compose(fracWords)].filter((v): v is number => v !== null);
      for (const i of ints) for (const f of fracs) out.push(Number(`${i}.${f}`));
      out.push(...readings(fracWords));
    }
    out.push(...readings(run.filter((w) => !POINT.has(w))));
    run = [];
  };
  for (const w of words) {
    if (isNumberWord(w) || (POINT.has(w) && run.length)) run.push(w);
    else flush();
  }
  flush();
  return out;
}

const heardIn = (v: number, said: number[]) => said.some((s) => Math.abs(s - v) < 0.005);

const notHeardReason = (field: Field, v: number) =>
  field === 'mortality'
    ? tx(`${v} sidat mati tidak terdengar di rekaman.`, `${v === 1 ? '1 dead eel was' : `${v} dead eels were`} not heard in the recording.`)
    : tx(`${NAME[field]()} ${say(v)} tidak terdengar di rekaman.`, `${NAME[field]()} ${say(v)} was not heard in the recording.`);

// ---------- Pond names in what was said ----------

const POND_WORD = /\b(?:kolam|kolom|bak|pond|tank)\s+([a-z0-9]+)/gi;

/** "Kolam B" said in a recording about one pond: it must be this pond, or at least a pond on the farm. */
function pondsSaid(text: string, pond: RoundPond, ponds: RoundPond[]): VerifyCheck {
  const label = tx('Kolam yang disebut ada di tambak', 'The pond named is on the farm');
  const keysOf = (p: RoundPond) => [p.name, ...p.nicknames].map(pondKey).filter(Boolean);
  for (const m of text.matchAll(POND_WORD)) {
    const key = pondKey(`kolam ${m[1]}`);
    // Only short identifiers ("B", "3", "be", "telu") are names; "kolam ini", "kolam sore" are not.
    if (!key) continue;
    const owner = ponds.filter((p) => keysOf(p).includes(key));
    if (owner.some((p) => p.id === pond.id)) continue;
    if (owner.length) return { id: 'pond', ok: false, label, reason: tx(`Rekaman menyebut ${owner[0].name}, bukan ${pond.name}.`, `The recording names ${owner[0].name}, not ${pond.name}.`) };
    if (/^([a-z]|\d+)$/.test(key)) return { id: 'pond', ok: false, label, reason: tx(`Kolam ${m[1].toUpperCase()} tidak ada di tambak ini.`, `Pond ${m[1].toUpperCase()} is not on this farm.`) };
  }
  return { id: 'pond', ok: true, label };
}

// ---------- Drafts: photo, voice note, video ----------

export interface DraftLike {
  data: LogData;
  transcript?: string;
  problems: string[];
}

/**
 * Checks a drafted log for one pond. Returns the draft with failed fields taken out (`held`, shown as
 * "Cek manual") and the verification. Photos have no transcript: only ranges and units apply.
 */
export function verifyDraft<D extends DraftLike>(draft: D, pond: RoundPond, ponds: RoundPond[]): D & { held: HeldField[]; verify: Verification } {
  const data: LogData = structuredClone(draft.data);
  const checks: VerifyCheck[] = [];
  const held: HeldField[] = [];
  const hold = (field: Field, value: number, check: VerifyCheck) => {
    checks.push(check);
    held.push({ field, value, reason: check.reason! });
    if (field === 'mortality') delete data.mortality;
    else delete data.readings![field];
  };
  const said = draft.transcript?.trim() ? numbersSaid(draft.transcript) : null;
  const words = `${draft.data.note ?? ''} ${draft.problems.join(' ')}`;

  for (const [key, v] of Object.entries(draft.data.readings ?? {}) as [Field, number][]) {
    if (!(key in PLAUSIBLE)) continue;
    const range = rangeCheck(key as Exclude<Field, 'mortality'>, v);
    if (!range.ok) {
      hold(key, v, range);
      continue;
    }
    if ((key === 'tds' && CONVERTED_TDS.test(words)) || (key === 'temperature' && CONVERTED_TEMP.test(words))) {
      hold(key, v, {
        id: 'unit',
        ok: false,
        label: tx('Satuan sesuai aplikasi', 'Unit as the app uses it'),
        field: key,
        reason: tx(`Layar alat memakai satuan lain; ${NAME[key]()} ${say(v)}${UNIT[key]} hasil hitungan AI.`, `The meter shows another unit; ${NAME[key]()} ${say(v)}${UNIT[key]} is the AI's conversion.`),
      });
      continue;
    }
    if (said && !heardIn(v, said)) {
      hold(key, v, { id: 'heard', ok: false, label: tx('Angka terdengar di rekaman', 'Numbers were heard in the recording'), field: key, reason: notHeardReason(key, v) });
    }
  }
  if (said && draft.data.mortality !== undefined && !heardIn(draft.data.mortality, said)) {
    hold('mortality', draft.data.mortality, {
      id: 'heard',
      ok: false,
      label: tx('Angka terdengar di rekaman', 'Numbers were heard in the recording'),
      field: 'mortality',
      reason: notHeardReason('mortality', draft.data.mortality),
    });
  }
  if (data.readings && !Object.keys(data.readings).length) delete data.readings;

  // One passing line per kind of check that ran, so the farmer sees what was looked at.
  const ran = (id: CheckId, label: string) => checks.some((c) => c.id === id) || checks.push({ id, ok: true, label });
  if (draft.data.readings && Object.keys(draft.data.readings).length) {
    ran('range', tx('Angka masuk akal', 'Readings are plausible'));
    ran('unit', tx('Satuan sesuai aplikasi', 'Unit as the app uses it'));
  }
  if (said) {
    ran('heard', tx('Angka terdengar di rekaman', 'Numbers were heard in the recording'));
    checks.push(pondsSaid(draft.transcript!, pond, ponds));
  }
  return { ...draft, data, held, verify: verification(checks) };
}

// ---------- Voice rounds: one recording, many ponds ----------

/** Share of a quote's words found in the transcript: the model's quote must come from what was said. */
function grounded(quote: string, transcript: string): boolean {
  const words = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const all = new Set(words(transcript));
  const q = words(quote);
  return q.length > 0 && q.filter((w) => all.has(w)).length / q.length >= 0.8;
}

/**
 * Checks each pond's draft of a round: its pond is on the farm, and each number was said in its part of
 * the recording (or the whole recording, when the model's quote is not found in it). A number not heard
 * becomes an "unverified" issue: taken out of the draft and offered for the farmer to confirm.
 */
export function verifyRound(result: RoundResult, ponds: RoundPond[]): RoundResult & { verify: Verification } {
  const transcriptSaid = numbersSaid(result.transcript);
  const drafts = result.drafts.map((d): RoundDraft => {
    const said = d.quote && grounded(d.quote, result.transcript) ? numbersSaid(d.quote) : transcriptSaid;
    const data: LogData = structuredClone(d.data);
    const issues: RoundIssue[] = [...d.issues];
    const checks: VerifyCheck[] = [];
    const pondOk = d.pondId !== null && ponds.some((p) => p.id === d.pondId);
    checks.push({
      id: 'pond',
      ok: pondOk,
      label: tx('Kolam yang disebut ada di tambak', 'The pond named is on the farm'),
      ...(!pondOk && { reason: tx(`"${d.heardName}" belum cocok dengan kolam mana pun.`, `"${d.heardName}" does not match any pond yet.`) }),
    });
    const notHeard = (field: 'temperature' | 'ph' | 'tds' | 'mortality', v: number) => {
      const reason = notHeardReason(field, v);
      checks.push({ id: 'heard', ok: false, label: tx('Angka terdengar di rekaman', 'Numbers were heard in the recording'), field, reason });
      issues.push({ kind: 'unverified', field, value: v, note: reason });
    };
    for (const [field, v] of Object.entries(d.data.readings ?? {}) as ['temperature' | 'ph' | 'tds', number][]) {
      if (!(field in PLAUSIBLE)) continue;
      const range = rangeCheck(field, v);
      if (!range.ok) {
        checks.push(range);
        delete data.readings![field];
        issues.push({ kind: 'implausible', field, heard: `${say(v)}${UNIT[field]}`, suggestion: null, note: range.reason! });
        continue;
      }
      // A number fixed without asking (pH 74 → 7,4) was heard as the original.
      const fix = d.autoFixed.find((a) => a.field === field && a.value === v);
      const heardAs = fix ? Number(fix.heard.replace(',', '.')) : v;
      if (!heardIn(heardAs, said)) {
        delete data.readings![field];
        notHeard(field, v);
      }
    }
    if (d.data.mortality !== undefined && !heardIn(d.data.mortality, said)) {
      delete data.mortality;
      notHeard('mortality', d.data.mortality);
    }
    if (data.readings && !Object.keys(data.readings).length) delete data.readings;
    if (!checks.some((c) => c.id === 'heard')) checks.push({ id: 'heard', ok: true, label: tx('Angka terdengar di rekaman', 'Numbers were heard in the recording') });
    return { ...d, data, issues, verify: verification(checks) };
  });
  const all = drafts.flatMap((d) => d.verify!.checks.filter((c) => !c.ok));
  const checks: VerifyCheck[] = all.length
    ? all
    : [
        { id: 'pond', ok: true, label: tx('Kolam yang disebut ada di tambak', 'The pond named is on the farm') },
        { id: 'heard', ok: true, label: tx('Angka terdengar di rekaman', 'Numbers were heard in the recording') },
      ];
  return { ...result, drafts, verify: verification(checks) };
}

// ---------- Dead-eel counts (SAM 3.1) ----------

/** Bodies, heads and the low–high range may differ by this much (and at least by one eel). */
export const COUNT_TOLERANCE = 0.25;
/** An outline this many times the typical one is not one eel (the whole scoop, a shadow), nor this small a fraction. */
const AREA_MAX = 5;
const AREA_MIN = 0.1;

export function verifyCount(r: Omit<CountResult, 'ms'>): Verification {
  const checks: VerifyCheck[] = [];
  const emptyMask = r.eels.filter((e) => !(e.area > 0) || !e.path || e.right <= e.left || e.bottom <= e.top || e.area > (e.right - e.left) * (e.bottom - e.top));
  const nothing = r.count > 0 && r.eels.length === 0 && r.heads.length === 0;
  checks.push({
    id: 'masks',
    ok: !emptyMask.length && !nothing,
    label: tx('Setiap sidat punya garis tepi', 'Every eel has an outline'),
    ...((emptyMask.length || nothing) && { reason: nothing ? tx('Ada angka tanpa sidat yang ditandai di foto.', 'There is a number with no eel marked in the photo.') : tx(`${emptyMask.length} garis tepi kosong atau rusak.`, `${emptyMask.length === 1 ? '1 outline is' : `${emptyMask.length} outlines are`} empty or broken.`) }),
  });

  const slack = Math.max(1, Math.round(COUNT_TOLERANCE * Math.max(r.high, 1)));
  const sure = r.eels.filter((e) => e.sure).length;
  const apart = r.high - r.low > slack || (r.heads.length > 0 && sure > 0 && Math.abs(r.heads.length - sure) > slack);
  checks.push({
    id: 'agree',
    ok: !apart,
    label: tx('Hitungan badan dan kepala cocok', 'Body and head counts agree'),
    ...(apart && {
      reason: tx(
        `Badan dan kepala tidak cocok: ${sure} badan jelas, ${r.heads.length} kepala, kisaran ${r.low}–${r.high}.`,
        `Bodies and heads do not agree: ${plural(sure, 'clear body', 'clear bodies')}, ${plural(r.heads.length, 'head', 'heads')}, range ${r.low}–${r.high}.`,
      ),
    }),
  });

  const areas = r.eels.map((e) => e.area).sort((a, b) => a - b);
  const median = areas[Math.floor(areas.length / 2)] ?? 0;
  const odd = median > 0 ? r.eels.filter((e) => e.area > AREA_MAX * median || e.area < AREA_MIN * median).length : 0;
  checks.push({
    id: 'area',
    ok: odd === 0,
    label: tx('Ukuran garis tepi wajar', 'Outline sizes are sensible'),
    ...(odd && { reason: tx(`${odd} garis tepi jauh lebih besar atau kecil dari sidat lain.`, `${odd === 1 ? '1 outline is' : `${odd} outlines are`} far larger or smaller than the other eels.`) }),
  });
  return verification(checks);
}

// ---------- Advice: briefing, case update, notes ----------

/** A pond the fixed rules see at risk now or tonight. */
export interface AtRisk {
  name: string;
  level: 'warning' | 'critical';
}

// "aman", "tenang", "baik-baik saja", "safe", "calm", "nothing to worry": a reassuring claim.
const SAFE = /\b(aman|tenang|baik[- ]baik\s+saja|tidak\s+ada\s+(masalah|risiko|bahaya)|tanpa\s+risiko|normal\s+semua|semua\s+normal|safe|calm|fine|no\s+(risk|problem|danger)|nothing\s+to\s+worry)\b/i;
// "tidak aman", "belum tenang", "not safe": the opposite claim.
// "tetap tenang" / "stay calm" is a request, not a claim.
const NEGATED = /\b(tidak|belum|kurang|bukan|not|no\s+longer|un|tetap|stay|keep)\s*(aman|tenang|safe|calm|fine)\b/gi;
const ALL = /\b(semua|seluruh|setiap|all|every)\b/i;

/**
 * Advice text against the rules: no medicine, dose or diagnosis, and no "safe" where the rules see risk.
 * The rules win: a failed check means the caller shows the rules' own text instead.
 */
export function verifyAdvice(text: string, atRisk: AtRisk[]): Verification {
  const checks: VerifyCheck[] = [];
  const unsafe = unsafeText(text);
  checks.push({
    id: 'safe',
    ok: !unsafe,
    label: tx('Tanpa obat, dosis atau diagnosis', 'No medicine, dose or diagnosis'),
    ...(unsafe && { reason: tx('Saran AI menyebut obat, dosis atau penyakit.', 'The AI advice names a medicine, a dose or a disease.') }),
  });
  let clash: string | null = null;
  if (atRisk.length) {
    const sentences = text.split(/(?<=[.!?])\s+/);
    const named = (s: string) => atRisk.filter((p) => s.toLowerCase().includes(p.name.toLowerCase()));
    const mentionsRisky = atRisk.some((p) => text.toLowerCase().includes(p.name.toLowerCase()));
    for (const s of sentences) {
      const calm = SAFE.test(s.replace(NEGATED, ''));
      if (!calm) continue;
      const risky = named(s);
      // "Kolam B aman" while the rules warn about Kolam B; "semua kolam aman"; or a calm text that never names the risky pond.
      if (risky.length || ALL.test(s) || !mentionsRisky) {
        const p = risky[0] ?? atRisk[0];
        clash = tx(
          `AI menulis aman, aturan melihat ${p.level === 'critical' ? 'bahaya' : 'perlu perhatian'} di ${p.name}.`,
          `The AI wrote safe; the rules see ${p.level === 'critical' ? 'danger' : 'a warning'} at ${p.name}.`,
        );
        break;
      }
    }
  }
  checks.push({ id: 'rules', ok: !clash, label: tx('Sesuai aturan alarm', 'Agrees with the alarm rules'), ...(clash && { reason: clash }) });
  return verification(checks);
}

/** The checks the agents' guards make besides verifyAdvice(): words that say more than the data, and length. */
export function adviceChecks(text: string, atRisk: AtRisk[], o: { overstated: boolean; fits: boolean }): Verification {
  const v = verifyAdvice(text, atRisk);
  return verification([
    ...v.checks,
    {
      id: 'data',
      ok: !o.overstated,
      label: tx('Tidak melebihi data', 'Says no more than the data'),
      ...(o.overstated && { reason: tx('AI menulis hujan deras atau oksigen seperti diukur, data tidak menunjukkan itu.', 'The AI wrote heavy rain, or oxygen as if measured; the data does not show that.') }),
    },
    { id: 'form', ok: o.fits, label: tx('Pesan pendek dan jelas', 'Short and plain'), ...(!o.fits && { reason: tx('Ringkasan AI tidak memenuhi aturan tulisan aplikasi (panjang atau kata ganti).', 'The AI summary breaks the app\'s writing rules (length or wording).') }) },
  ]);
}

// ---------- Notebook pages ----------

/** A notebook page's cells already carry their checks (notebook.ts); this sums them up. */
export function verifyRows(rows: { checks: { note: string }[] }[]): Verification {
  const bad = rows.flatMap((r) => r.checks);
  return verification([
    {
      id: 'rows',
      ok: bad.length === 0,
      label: tx('Setiap isian masuk akal', 'Every cell is plausible'),
      ...(bad.length && { reason: tx(`${bad.length} isian perlu dicek: ${bad[0].note}`, `${bad.length === 1 ? '1 cell needs' : `${bad.length} cells need`} a look: ${bad[0].note}`) }),
    },
  ]);
}
