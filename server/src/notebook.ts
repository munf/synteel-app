// Reads a photo of a farmer's handwritten notebook page into rows (date, pond, temperature, pH, TDS,
// dead eels, feed and notes), so a farm starts with its history on day one.
// The model only copies what is written, cell by cell, and says which cells it is unsure of. Everything
// after that is decided here, without the model: numbers come from the text as written (never from the
// model's own reading of it), dates get their year, pond names are matched locally, and values that cannot
// be right are left empty with a suggestion. Nothing here is saved: the farmer checks every row first.
import { currentLang, tx } from './i18n.ts';
import type { NotebookCheck, NotebookField, NotebookRow, NotebookValueField, ReadingField } from './contract.ts';
import { DAY_MS } from './domain.ts';
import { checkReading, matchPond, pondKey, type RoundPond } from './round.ts';

// ---------- What the model returns ----------

const CELL = {
  type: 'object',
  additionalProperties: false,
  required: ['written', 'value'],
  properties: {
    written: { type: ['string', 'null'], description: 'Isi sel persis seperti tertulis, termasuk koma atau titik; null bila sel kosong' },
    value: { type: ['number', 'null'], description: 'Angka yang tertulis; null bila kosong atau tidak terbaca' },
  },
};
const FIELDS: NotebookField[] = ['date', 'pond', 'temperature', 'ph', 'tds', 'dead'];

// Strict JSON schema: every key present, null when unknown.
export const NOTEBOOK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['page_pond', 'page_year', 'rows', 'problems'],
  properties: {
    page_pond: { type: ['string', 'null'], description: 'Nama kolam di judul halaman, bila satu halaman untuk satu kolam' },
    page_year: { type: ['integer', 'null'], description: 'Tahun yang tertulis di halaman (judul atau tanggal), bila ada' },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['date', 'time', 'pond', 'temperature', 'ph', 'tds', 'dead', 'feed', 'note', 'unsure'],
        properties: {
          date: {
            type: 'object',
            additionalProperties: false,
            required: ['written', 'day', 'month', 'year'],
            properties: {
              written: { type: ['string', 'null'], description: 'Tanggal persis seperti tertulis' },
              day: { type: ['integer', 'null'] },
              month: { type: ['integer', 'null'], description: '1-12' },
              year: { type: ['integer', 'null'], description: 'Hanya bila tahun tertulis di baris ini' },
            },
          },
          time: { type: ['string', 'null'], description: 'Jam atau pagi/siang/sore/malam persis seperti tertulis' },
          pond: { type: ['string', 'null'], description: 'Nama kolam persis seperti tertulis di baris ini' },
          temperature: { ...CELL, description: 'Suhu air °C' },
          ph: CELL,
          tds: { ...CELL, description: 'TDS ppm' },
          dead: { ...CELL, description: 'Jumlah sidat mati' },
          feed: { type: ['string', 'null'], description: 'Pakan persis seperti tertulis' },
          note: { type: ['string', 'null'], description: 'Keterangan lain persis seperti tertulis' },
          unsure: { type: 'array', items: { enum: FIELDS }, description: 'Sel yang sulit dibaca' },
        },
      },
    },
    problems: { type: 'array', items: { type: 'string' }, description: 'Kendala membaca halaman, dalam bahasa yang diminta instruksi' },
  },
} as const;

export function notebookInstructions(ponds: RoundPond[]): string {
  return [
    'Kamu membantu petani sidat di Indonesia menyalin buku catatan kolam yang ditulis tangan. Foto berisi satu halaman buku.',
    'Salin setiap baris catatan menjadi satu item rows, urut dari atas ke bawah.',
    `Kolam di tambak ini: ${ponds.map((p) => [p.name, ...p.nicknames].join(' / ')).join('; ')}.`,
    'Aturan:',
    '- Salin, jangan menebak. Sel kosong: written null dan value null. Jangan pernah mengisi angka yang tidak tertulis, juga bila baris lain punya angka.',
    '- written: isi sel persis seperti tertulis, termasuk koma, titik dan satuan. value: angka yang sama. Jangan membetulkan angka yang aneh (pH 74 tetap 74, suhu 9 tetap 9).',
    '- Sel yang sulit dibaca (tulisan jelek, tercoret, pudar, terpotong): masukkan nama kolomnya ke unsure. Tetap isi written dengan yang terlihat, pakai ? untuk huruf yang tidak terbaca ("7,?").',
    '- Tanda ulang (", ,, dito, idem) di sel: written persis tandanya, value null, dan masukkan kolomnya ke unsure.',
    '- Tanda strip (-) berarti kosong atau tidak ada: written "-", value null, bukan unsure.',
    '- Tanggal: day dan month dari tulisan; year hanya bila tahun tertulis. Bulan bisa angka atau nama (Okt, Oktober, X). Bila halaman punya judul tanggal atau tahun, isi page_year.',
    '- pond: nama kolam persis seperti tertulis di baris itu. Bila halaman untuk satu kolam (judul), isi page_pond dan biarkan pond null bila baris tidak menulis kolam.',
    '- Kolom bisa berlabel Tgl, Kolam, Suhu/T/°C, pH, TDS/ppm, Mati/M, Pakan. Bila ada kolom lain, salin ke note.',
    '- Baris judul tabel dan baris kosong bukan catatan, lewati.',
    '- Ini pencatatan, bukan diagnosis. Jangan menambah saran.',
    currentLang() === 'en' ? '- Write problems in plain English.' : '- Tulis problems dalam bahasa Indonesia.',
  ].join('\n');
}

// ---------- Numbers as written ----------

/**
 * "7,4" → 7.4, "28°C" → 28, "160 ppm" → 160, "1.200" → 1.2 (the plausibility check then asks about it).
 * Anything with an unreadable mark, a ditto sign or two numbers → undefined.
 */
export function parseWritten(written: string): number | undefined {
  const s = written
    .trim()
    .toLowerCase()
    .replace(/\s*(°\s*c|°|ppm|ekor|ek|c)$/u, '')
    .trim();
  if (!/^-?\d+([.,]\d+)?$/.test(s)) return undefined;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const round2 = (v: number) => Math.round(v * 100) / 100;
/** 7.4 → "7,4" (Indonesian) or "7.4" (English). */
const say = (v: number) => (currentLang() === 'en' ? String(round2(v)) : String(round2(v)).replace('.', ','));

const RANGE_NOTE: Record<NotebookValueField, () => string> = {
  temperature: () => tx('Suhu air biasanya 15–38 °C.', 'Water temperature is usually 15–38 °C.'),
  ph: () => tx('pH air biasanya 4–10.', 'Water pH is usually 4–10.'),
  tds: () => tx('TDS air biasanya 20–2000 ppm.', 'Water TDS is usually 20–2000 ppm.'),
  dead: () => tx('Jumlah mati harus bilangan bulat.', 'The number dead must be a whole number.'),
};
const UNSURE_NOTE = () => tx('Tulisan sulit dibaca. Cek lagi di buku.', 'Hard to read. Check the notebook again.');
const EMPTY_NOTE = () => tx('Sel ini kosong di foto, tapi AI menyebut angka. Angka itu tidak dipakai.', 'This cell is blank in the photo, but the AI gave a number. It is not used.');

/** One value cell: the number written, or empty with a check. Never the model's own number. */
export function guardCell(field: NotebookValueField, raw: unknown, unsure: boolean): { value?: number; check?: NotebookCheck } {
  const cell = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const written = str(cell.written).slice(0, 40);
  const modelValue = typeof cell.value === 'number' && Number.isFinite(cell.value) ? cell.value : null;
  if (!written) {
    // A number for a blank cell is invented: dropped, and the farmer is told.
    return modelValue === null ? {} : { check: { field, kind: 'unsure', written: '', suggestion: null, note: EMPTY_NOTE() } };
  }
  // A dash or cross: written as "none" or "not measured", so the cell is simply empty.
  if (/^[-–—x×]$/i.test(written)) return {};
  const n = parseWritten(written);
  // Unreadable, ditto marks, or a cell the model itself was unsure of (or gave no number for): left empty.
  if (n === undefined || unsure || modelValue === null) {
    return { check: { field, kind: 'unsure', written, suggestion: n ?? null, note: UNSURE_NOTE() } };
  }
  if (field === 'dead') {
    if (Number.isInteger(n) && n >= 0 && n < 100_000) return { value: n };
    return { check: { field, kind: 'odd', written, suggestion: null, note: RANGE_NOTE.dead() } };
  }
  const checked = checkReading(field as ReadingField, n);
  if (checked.value !== undefined && !checked.autoFix) return { value: checked.value };
  // A voice round fixes pH 74 by itself; on paper it is only offered, the farmer taps it.
  const suggestion = checked.autoFix?.value ?? (checked.issue?.kind === 'implausible' ? checked.issue.suggestion : null);
  const hint =
    field === 'temperature' && suggestion !== null && suggestion - n === 20
      ? tx(' Mungkin angka depannya tidak tertulis.', ' Maybe the first digit was left off.')
      : field === 'ph' && suggestion !== null && n > 14
        ? tx(' Mungkin komanya tidak tertulis.', ' Maybe the decimal point was left off.')
        : '';
  return { check: { field, kind: 'odd', written, suggestion, note: `${RANGE_NOTE[field]()}${hint}` } };
}

// ---------- Dates ----------

const MONTHS: Record<string, number> = {
  jan: 1, januari: 1, january: 1, feb: 2, februari: 2, pebruari: 2, february: 2, mar: 3, maret: 3, march: 3, apr: 4, april: 4,
  mei: 5, may: 5, jun: 6, juni: 6, june: 6, jul: 7, juli: 7, july: 7, agu: 8, agt: 8, agus: 8, agustus: 8, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, okt: 10, oct: 10, oktober: 10, october: 10, nov: 11, nop: 11, november: 11, nopember: 11,
  des: 12, dec: 12, desember: 12, december: 12,
};
const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12 };

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
function realDate(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? iso(y, m, d) : null;
}

/** Day, month and maybe year from what is written: "12/10", "12-10-25", "12 Okt", "12 X 2025". */
export function parseDate(written: string): { day: number; month: number; year: number | null } | null {
  const s = written.trim().toLowerCase();
  let m = /^(\d{1,2})\s*[/.\-]\s*(\d{1,2})(?:\s*[/.\-]\s*(\d{2}|\d{4}))?$/.exec(s);
  if (m) return { day: +m[1], month: +m[2], year: m[3] ? +m[3] : null };
  m = /^(\d{1,2})\s*[-/. ]?\s*([a-z]+)\.?(?:\s*[-/. ]?\s*(\d{2}|\d{4}))?$/.exec(s);
  if (m) {
    const month = MONTHS[m[2]] ?? ROMAN[m[2]];
    if (month) return { day: +m[1], month, year: m[3] ? +m[3] : null };
  }
  return null;
}

const fullYear = (y: number) => (y < 100 ? 2000 + y : y);

/**
 * The date of one row. Day and month must agree with what is written. Without a year, the most recent
 * date with that day and month that is not after today. A date after today is never taken as it is.
 */
export function guardDate(raw: unknown, pageYear: number | null, today: string, unsure: boolean): { date: string | null; yearGuessed: boolean; written: string; check?: NotebookCheck } {
  const cell = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const written = str(cell.written).slice(0, 40);
  const local = written ? parseDate(written) : null;
  const int = (v: unknown) => (Number.isInteger(v) ? (v as number) : null);
  const day = local?.day ?? int(cell.day);
  const month = local?.month ?? int(cell.month);
  // The model's day/month must match the text when the text can be read here.
  const disagrees = local !== null && ((int(cell.day) !== null && int(cell.day) !== local.day) || (int(cell.month) !== null && int(cell.month) !== local.month));
  const yearWritten = local?.year ?? (local ? null : int(cell.year));
  const year = yearWritten !== null ? fullYear(yearWritten) : pageYear !== null ? fullYear(pageYear) : null;
  const thisYear = Number(today.slice(0, 4));
  const unsureCheck = (suggestion: string | null): NotebookCheck => ({ field: 'date', kind: 'unsure', written, suggestion, note: UNSURE_NOTE() });

  if (day === null || month === null || !written) return { date: null, yearGuessed: false, written, check: unsureCheck(null) };
  // Most recent past date with this day and month.
  let guessed: string | null = null;
  for (const y of [thisYear, thisYear - 1, thisYear - 2]) {
    const d = realDate(y, month, day);
    if (d && d <= today) {
      guessed = d;
      break;
    }
  }
  if (year !== null) {
    const d = realDate(year, month, day);
    if (!d) return { date: null, yearGuessed: false, written, check: unsureCheck(guessed) };
    if (d > today) return { date: null, yearGuessed: false, written, check: { field: 'date', kind: 'future', written, suggestion: guessed, note: tx('Tanggal ini belum lewat. Cek tahunnya.', 'This date has not come yet. Check the year.') } };
    if (unsure || disagrees) return { date: null, yearGuessed: false, written, check: unsureCheck(d) };
    return { date: d, yearGuessed: false, written };
  }
  if (!guessed) return { date: null, yearGuessed: false, written, check: unsureCheck(null) };
  if (unsure || disagrees) return { date: null, yearGuessed: true, written, check: unsureCheck(guessed) };
  return { date: guessed, yearGuessed: true, written };
}

/** "07.00" → "07:00", "pagi" → "07:00", "sore" → "17:00"; null when no time is written. */
export function parseTime(written: string): string | null {
  const s = written.trim().toLowerCase();
  const m = /(\d{1,2})[.:](\d{2})/.exec(s);
  if (m && +m[1] < 24 && +m[2] < 60) return `${m[1].padStart(2, '0')}:${m[2]}`;
  if (/\b(pagi|morning|esuk|isuk)\b/.test(s)) return '07:00';
  if (/\b(siang|noon|awan)\b/.test(s)) return '12:00';
  if (/\b(sore|afternoon|evening)\b/.test(s)) return '17:00';
  if (/\b(malam|night|bengi)\b/.test(s)) return '20:00';
  return null;
}

// ---------- Rows ----------

const VALUE_FIELDS: NotebookValueField[] = ['temperature', 'ph', 'tds', 'dead'];

/**
 * Turns the model's answer for one page into rows the farmer checks. `defaultPondId`: the pond the
 * import was started from, used for rows with no pond written anywhere on the page.
 */
export function guardNotebook(raw: unknown, ponds: RoundPond[], opts: { today: string; page: number; defaultPondId?: number | null }): { rows: NotebookRow[]; problems: string[] } {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const pagePond = str(body.page_pond).slice(0, 60);
  const thisYear = Number(opts.today.slice(0, 4));
  const pageYear = Number.isInteger(body.page_year) && fullYear(body.page_year) <= thisYear && fullYear(body.page_year) > thisYear - 20 ? body.page_year : null;
  const problems: string[] = (Array.isArray(body.problems) ? body.problems : []).filter((p: unknown) => typeof p === 'string' && p.trim()).map((p: string) => p.trim().slice(0, 200)).slice(0, 5);
  const fallbackPond = ponds.find((p) => p.id === opts.defaultPondId) ?? null;

  const rows: NotebookRow[] = [];
  for (const r of (Array.isArray(body.rows) ? body.rows : []).slice(0, 60)) {
    if (!r || typeof r !== 'object') continue;
    const unsure = new Set((Array.isArray(r.unsure) ? r.unsure : []).filter((f: unknown) => FIELDS.includes(f as NotebookField)));
    const checks: NotebookCheck[] = [];
    const values: NotebookRow['values'] = {};
    for (const f of VALUE_FIELDS) {
      const c = guardCell(f, r[f], unsure.has(f));
      if (c.value !== undefined) values[f] = c.value;
      if (c.check) checks.push(c.check);
    }
    const feed = str(r.feed).slice(0, 100);
    const other = str(r.note).slice(0, 100);
    const note = [feed && tx(`Pakan: ${feed}`, `Feed: ${feed}`), other].filter(Boolean).join('; ').slice(0, 200) || null;
    // Nothing written in the row at all: not a record.
    if (!Object.keys(values).length && !checks.length && !note) continue;

    const date = guardDate(r.date, pageYear, opts.today, unsure.has('date'));
    if (date.check) checks.unshift(date.check);

    const pondWritten = (str(r.pond) || pagePond).slice(0, 60);
    let pondId: number | null = null;
    let suggestions: number[] = [];
    if (!pondWritten) {
      if (fallbackPond) pondId = fallbackPond.id;
      else {
        suggestions = ponds.map((p) => p.id);
        checks.unshift({ field: 'pond', kind: 'unknown', written: '', suggestion: null, note: tx('Nama kolam tidak tertulis.', 'No pond name is written.') });
      }
    } else {
      const match = matchPond(pondWritten, ponds);
      if (match.pondId !== null && !unsure.has('pond')) pondId = match.pondId;
      else {
        suggestions = match.pondId !== null ? [match.pondId, ...match.suggestions.filter((id) => id !== match.pondId)] : match.suggestions;
        checks.unshift(
          unsure.has('pond')
            ? { field: 'pond', kind: 'unsure', written: pondWritten, suggestion: null, note: UNSURE_NOTE() }
            : { field: 'pond', kind: 'unknown', written: pondWritten, suggestion: null, note: tx('Nama ini belum ada di daftar kolam.', 'This name is not in the pond list yet.') },
        );
      }
    }

    rows.push({
      key: `p${opts.page}r${rows.length + 1}`,
      page: opts.page,
      date: date.date,
      dateWritten: date.written,
      yearGuessed: date.yearGuessed,
      time: parseTime(str(r.time)),
      pondId,
      pondWritten,
      suggestions,
      values,
      note,
      checks,
    });
  }
  return { rows, problems };
}

/** Wall-clock date and time in a timezone → ISO instant. */
export function localIso(date: string, time: string, timezone: string): string {
  const guess = Date.parse(`${date}T${time}:00Z`);
  const wall = Date.parse(`${new Date(guess).toLocaleString('sv-SE', { timeZone: timezone }).replace(' ', 'T')}Z`);
  return new Date(guess - (wall - guess)).toISOString();
}

// ---------- Mock ----------

/** An example page on this farm's ponds, dated just before the app's own records begin. Labelled as an example. */
export function mockNotebook(ponds: RoundPond[], today: string): Record<string, unknown> {
  const byKey = (k: string) => ponds.find((p) => pondKey(p.name) === k);
  const a = byKey('a') ?? ponds[0];
  const b = byKey('b') ?? ponds.find((p) => p !== a) ?? a;
  const day = (ago: number) => {
    const d = new Date(Date.parse(`${today}T00:00:00Z`) - ago * DAY_MS);
    return { written: `${d.getUTCDate()}/${d.getUTCMonth() + 1}`, day: d.getUTCDate(), month: d.getUTCMonth() + 1, year: null };
  };
  const cell = (written: string | null) => ({ written, value: written === null ? null : (parseWritten(written) ?? null) });
  const row = (ago: number, pond: string | undefined, t: string | null, ph: string | null, tds: string | null, dead: string | null, feed: string | null, unsure: string[] = []) => ({
    date: day(ago),
    time: 'pagi',
    pond: pond ?? null,
    temperature: cell(t),
    ph: cell(ph),
    tds: cell(tds),
    dead: cell(dead),
    feed,
    note: null,
    unsure,
  });
  return {
    page_pond: null,
    page_year: null,
    rows: [
      row(18, a?.name, '27,5', '7,4', '138', null, 'cacing, habis'),
      row(18, b?.name, '27,8', '7,3', '142', '1', 'cacing, habis'),
      row(17, a?.name, '27,6', '74', '140', null, 'cacing, habis'),
      row(17, b?.name, '9', '7,2', '145', '2', 'cacing, sisa sedikit'),
      row(16, a?.name, '27,4', '7,?', '139', null, 'cacing, habis', ['ph']),
      row(16, 'kolam pojok', '28,1', '7,1', '150', null, null),
      // Already recorded in the app: the farmer is asked whether to add it.
      row(3, b?.name, '28,0', '7,3', '141', null, 'cacing, habis'),
    ],
    problems: [tx('Mode contoh, bukan hasil AI.', 'Sample mode, not an AI result.')],
  };
}
