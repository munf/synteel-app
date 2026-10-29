// Foto buku catatan: photos of a handwritten notebook page → rows the farmer checks → saved as history.
// Each page is one AI read. Nothing is saved until the farmer taps Simpan; cells the AI could not read,
// or that cannot be right, stay empty and are marked "Cek lagi" until the farmer fills or clears them.
import { useRef, useState } from 'preact/hooks';
import { api, ApiError, type LogData, type NotebookCheck, type NotebookField, type NotebookPage, type NotebookRow, type NotebookSaveResult, type NotebookSaveRow, type NotebookValueField, type PondSummary } from '../api.ts';
import type { Go } from '../app.tsx';
import { prepareImage } from '../capture/media.ts';
import { fmtNum } from '../labels.ts';
import { Icon, PondPicker, ActionBar } from '../ui.tsx';
import { Offline, sendNotebook, type Progress } from '../upload.ts';
import { isEn, LOCALE, t } from '../i18n.ts';
import './notebook.css';

const TZ = 'Asia/Jakarta';
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });

const COLS: { key: NotebookValueField; label: string; unit: string }[] = [
  { key: 'temperature', label: t('Suhu', 'Temp'), unit: '°C' },
  { key: 'ph', label: 'pH', unit: '' },
  { key: 'tds', label: 'TDS', unit: 'ppm' },
  { key: 'dead', label: t('Mati', 'Dead'), unit: t('ekor', 'eels') },
];
const FIELD_NAME: Record<NotebookField, string> = {
  date: t('Tanggal', 'Date'),
  pond: t('Kolam', 'Pond'),
  temperature: t('Suhu', 'Temperature'),
  ph: 'pH',
  tds: 'TDS',
  dead: t('Jumlah mati', 'Number dead'),
};
/** Hard limits, as the server checks them: outside these a number cannot be saved. */
const LIMITS: Record<NotebookValueField, [number, number]> = { temperature: [0, 45], ph: [0, 14], tds: [0, 50000], dead: [0, 100000] };

const parse = (s: string) => (s.trim() === '' ? undefined : Number(s.trim().replace(/\s/g, '').replace(',', '.')));
const show = (n: number | undefined) => (n === undefined ? '' : fmtNum(n));
/** "Rabu 8 Oktober 2026" */
const longDate = (d: string) =>
  new Date(`${d}T12:00:00+07:00`).toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ }).replace(',', isEn ? ',' : '');
const timeWord = (time: string | null) =>
  time === null ? '' : time === '07:00' ? t('pagi', 'morning') : time === '17:00' ? t('sore', 'afternoon') : time === '12:00' ? t('siang', 'midday') : time === '20:00' ? t('malam', 'night') : time.replace(':', isEn ? ':' : '.');

// ---------- the import kept while the farmer moves around the app ----------

interface Row {
  key: string;
  page: number;
  dateWritten: string;
  yearGuessed: boolean;
  time: string | null;
  pondWritten: string;
  /** Ponds closest to the name written, best first (for the picker). */
  suggestions: number[];
  note: string;
  date: string | null;
  pondId: number | null;
  vals: Record<NotebookValueField, string>;
  checks: NotebookCheck[];
  /** Fields still marked "Cek lagi". */
  open: NotebookField[];
  /** Save even though the pond already has a record that day. */
  also: boolean;
  removed: boolean;
  /** The pond was picked or changed here: show the picker. */
  picking: boolean;
  editingDate: boolean;
}

interface Page {
  n: number;
  url: string;
  rows: number;
  problems: string[];
  mode: NotebookPage['mode'];
}

interface Session {
  pondId?: number;
  pages: Page[];
  rows: Row[];
  recorded: Record<string, number[]>;
  saved: (NotebookSaveResult & { rows: Row[] }) | null;
}

let session: Session | null = null;

function rowOf(r: NotebookRow): Row {
  const vals = Object.fromEntries(COLS.map((c) => [c.key, show(r.values[c.key])])) as Row['vals'];
  return {
    key: r.key,
    page: r.page,
    dateWritten: r.dateWritten,
    yearGuessed: r.yearGuessed,
    time: r.time,
    pondWritten: r.pondWritten,
    suggestions: r.suggestions,
    note: r.note ?? '',
    date: r.date,
    pondId: r.pondId,
    vals,
    checks: r.checks,
    open: r.checks.map((c) => c.field),
    also: false,
    removed: false,
    picking: r.pondId === null,
    editingDate: r.date === null,
  };
}

/** The numbers typed in a row: values, or the first problem. */
function readRow(row: Row): { data: LogData; error: string | null } {
  const data: LogData = {};
  const readings: NonNullable<LogData['readings']> = {};
  for (const c of COLS) {
    const n = parse(row.vals[c.key]);
    if (n === undefined) continue;
    const [min, max] = LIMITS[c.key];
    if (!Number.isFinite(n)) return { data, error: t(`${FIELD_NAME[c.key]}: angka tidak terbaca`, `${FIELD_NAME[c.key]}: not a readable number`) };
    if (n < min || n > max || (c.key === 'dead' && !Number.isInteger(n))) return { data, error: t(`${FIELD_NAME[c.key]} ${row.vals[c.key]} tidak mungkin`, `${FIELD_NAME[c.key]} ${row.vals[c.key]} is not possible`) };
    if (c.key === 'dead') {
      if (n > 0) data.mortality = n;
    } else readings[c.key] = n;
  }
  if (Object.keys(readings).length) data.readings = readings;
  if (row.note.trim()) data.note = row.note.trim().slice(0, 200);
  return { data, error: null };
}

const isRecorded = (row: Row, recorded: Session['recorded']) => !!row.date && row.pondId !== null && !!recorded[row.date]?.includes(row.pondId);

export function Notebook({ ponds, pondId, onSaved, go }: { ponds: PondSummary[]; pondId?: number; onSaved: () => void; go: Go }) {
  // The import left half-checked comes back as it was; after a save, or from another pond, a new one starts.
  const [s, setS] = useState<Session>(() => {
    if (!session || session.saved || (session.rows.length === 0 && session.pondId !== pondId)) session = { pondId, pages: [], rows: [], recorded: {}, saved: null };
    return session;
  });
  const [reading, setReading] = useState<Progress | true | null>(null);
  const [error, setError] = useState<{ text: string; quota?: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const firstOpen = useRef<HTMLDivElement>(null);

  const update = (next: Session) => {
    session = next;
    setS(next);
  };
  const patch = (key: string, p: Partial<Row>) => update({ ...s, rows: s.rows.map((r) => (r.key === key ? { ...r, ...p } : r)) });

  async function addPage(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    setError(null);
    setReading(true);
    const n = (session?.pages.at(-1)?.n ?? 0) + 1;
    try {
      // Handwriting needs more pixels than a meter display.
      const { blob } = await prepareImage(file, 1800, 0.85);
      const { page } = await sendNotebook(blob, n, s.pondId, (p) => setReading(p));
      const cur = session!;
      update({
        ...cur,
        pages: [...cur.pages, { n, url: URL.createObjectURL(blob), rows: page.rows.length, problems: page.problems, mode: page.mode }],
        rows: [...cur.rows, ...page.rows.map(rowOf)],
        recorded: mergeRecorded(cur.recorded, page.recorded),
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ai_quota')
        setError({ text: t('Jatah baca AI hari ini habis. Foto halaman ini lagi besok, atau ketik sendiri di Catat.', "Today's AI reads are used up. Take this page again tomorrow, or type it in on Record."), quota: true });
      else if (err instanceof Offline) setError({ text: t('Belum ada sinyal. Foto halaman ini lagi saat ada sinyal.', 'No signal yet. Take this page again when there is signal.') });
      else setError({ text: (err as Error).message });
    } finally {
      setReading(null);
    }
  }

  const live = s.rows.filter((r) => !r.removed);
  const openCount = live.reduce((n, r) => n + r.open.length, 0);
  const problems = live.map((r) => ({ r, ...readRow(r) }));
  const badRow = problems.find((p) => p.error);
  const empty = problems.filter((p) => !p.error && !p.data.readings && !p.data.mortality && !p.data.note);
  const toSave = problems.filter((p) => !p.error && !empty.includes(p) && !(isRecorded(p.r, s.recorded) && !p.r.also));
  const skipping = live.filter((r) => isRecorded(r, s.recorded) && !r.also);
  const ready = openCount === 0 && !badRow && toSave.length > 0;

  async function save() {
    setSaving(true);
    setSaveError('');
    try {
      const rows: NotebookSaveRow[] = toSave.map(({ r, data }) => ({ key: r.key, pondId: r.pondId!, date: r.date!, time: r.time, data, alsoIfRecorded: r.also }));
      const result = await api.saveNotebook(rows);
      s.pages.forEach((p) => URL.revokeObjectURL(p.url));
      const skippedHere = skipping.map((r) => ({ key: r.key, reason: 'recorded' as const }));
      update({ ...s, pages: [], saved: { saved: result.saved, skipped: [...skippedHere, ...result.skipped], rows: live } });
      onSaved();
      window.scrollTo(0, 0);
    } catch (err) {
      setSaveError(err instanceof TypeError ? t('Belum ada sinyal. Semua baris tetap di sini, coba simpan lagi nanti.', 'No signal yet. All rows stay here; try saving again later.') : (err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const leave = () => (s.pondId ? go({ name: 'pond', id: s.pondId }) : go({ name: 'record' }));
  const header = (
    <header class="row">
      <button type="button" class="icon-btn" aria-label={s.pondId ? t('Kembali ke kolam', 'Back to the pond') : t('Kembali ke Catat', 'Back to Record')} onClick={leave}>
        <Icon name="back" />
      </button>
      <div class="grow stack-xs" style={{ gap: 0 }}>
        <h1>{s.rows.length && !s.saved ? t('Cek buku catatan', 'Check the notebook') : t('Foto buku catatan', 'Notebook photo')}</h1>
        {s.rows.length > 0 && !s.saved && (
          <span class="meta num">
            {t(`${s.pages.length} halaman · ${live.length} baris`, `${s.pages.length} ${s.pages.length === 1 ? 'page' : 'pages'} · ${live.length} ${live.length === 1 ? 'row' : 'rows'}`)}
          </span>
        )}
      </div>
    </header>
  );
  const inputs = (
    <>
      <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={addPage} />
      <input ref={gallery} type="file" accept="image/*" hidden onChange={addPage} />
    </>
  );
  const status = reading && (
    <p class="working" role="status">
      {reading !== true && reading.sent < reading.total
        ? t(`Mengirim foto · ${Math.round((reading.sent / Math.max(1, reading.total)) * 100)}%`, `Sending the photo · ${Math.round((reading.sent / Math.max(1, reading.total)) * 100)}%`)
        : t('AI menyalin halaman… biasanya kurang dari satu menit', 'AI is copying the page… usually under a minute')}
    </p>
  );
  const errorNote = error && (
    <div class="note warn" role="alert">
      <Icon name="alert" size={20} />
      <span class="stack-xs">
        <span>{error.text}</span>
        {error.quota && (
          <button type="button" class="rp-link warn" onClick={() => go({ name: 'quota' })}>
            {t('Lihat jatah AI', 'View daily AI reads')}
          </button>
        )}
      </span>
    </div>
  );

  // ---------- saved ----------
  if (s.saved) {
    const done = s.saved;
    const byPond = new Map<number, { n: number; oldest: string }>();
    for (const sv of done.saved) {
      const r = done.rows.find((x) => x.key === sv.key);
      if (!r || r.pondId === null || !r.date) continue;
      const cur = byPond.get(r.pondId);
      byPond.set(r.pondId, { n: (cur?.n ?? 0) + 1, oldest: cur && cur.oldest < r.date ? cur.oldest : r.date });
    }
    const daysBack = (d: string) => Math.ceil((Date.parse(`${today()}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) / 86400_000) + 2;
    return (
      <div class="screen">
        {header}
        <section class="card">
          <div class="row">
            <span class="icon-box ok">
              <Icon name="check" />
            </span>
            <div class="grow stack-xs">
              <h2 class="num">{t(`${done.saved.length} catatan tersimpan dari buku`, `${done.saved.length} ${done.saved.length === 1 ? 'record' : 'records'} saved from the notebook`)}</h2>
              {done.skipped.length > 0 && (
                <span class="label ink2 num">
                  {t(
                    `${done.skipped.length} baris dilewati: kolam itu sudah punya catatan di tanggal yang sama.`,
                    `${done.skipped.length} ${done.skipped.length === 1 ? 'row' : 'rows'} skipped: that pond already has a record on the same date.`,
                  )}
                </span>
              )}
            </div>
          </div>
          <span class="label ink2">{t('Tercatat sebagai “Buku” di riwayat dan ikut di grafik kolam.', 'Marked “Notebook” in the history and shown in the pond charts.')}</span>
          <div class="stack-sm">
            {[...byPond.entries()].map(([id, v]) => (
              <button type="button" key={id} class="nb-pond-link" onClick={() => go({ name: 'history', pondId: id, days: daysBack(v.oldest) })}>
                <span class="grow stack-xs" style={{ gap: 0 }}>
                  <span class="strong">{t(`Lihat riwayat ${ponds.find((p) => p.id === id)?.name ?? 'kolam'}`, `View ${ponds.find((p) => p.id === id)?.name ?? 'pond'} history`)}</span>
                  <span class="meta num">{t(`${v.n} catatan baru dari buku`, `${v.n} new ${v.n === 1 ? 'record' : 'records'} from the notebook`)}</span>
                </span>
                <Icon name="next" size={20} />
              </button>
            ))}
          </div>
          <button
            type="button"
            class="btn secondary"
            onClick={() => {
              update({ pondId: s.pondId, pages: [], rows: [], recorded: {}, saved: null });
            }}
          >
            <Icon name="book" /> {t('Foto halaman lain', 'Take another page')}
          </button>
        </section>
      </div>
    );
  }

  // ---------- start ----------
  if (s.rows.length === 0 && s.pages.length === 0) {
    return (
      <div class="screen">
        {header}
        <section class="card">
          <span class="icon-box">
            <Icon name="book" />
          </span>
          <div class="stack-xs">
            <h2>{t('Catatan lama dari buku masuk ke aplikasi', 'Old records from the notebook go into the app')}</h2>
            <p class="ink2">
              {t(
                'Foto satu halaman buku catatan kolam. AI menyalin tanggal, kolam, suhu, pH, TDS, jumlah mati dan pakan. Semua dicek dulu, baru disimpan.',
                'Take a photo of one notebook page. The AI copies the date, pond, temperature, pH, TDS, number dead and feed. Everything is checked before it is saved.',
              )}
            </p>
          </div>
          <div class="stack-sm nb-tips">
            {[
              t('Satu halaman per foto, lurus dari atas', 'One page per photo, straight from above'),
              t('Cukup terang, tanpa bayangan tangan', 'Bright enough, no hand shadow'),
              t('Tulisan yang tidak terbaca dikosongkan, tidak ditebak', 'Writing that cannot be read is left empty, never guessed'),
            ].map((tip) => (
              <span class="row label ink2" key={tip} style={{ gap: 8 }}>
                <Icon name="check" size={18} stroke={2.6} />
                {tip}
              </span>
            ))}
          </div>
          {status}
          {errorNote}
          <button type="button" class="btn primary" disabled={!!reading} onClick={() => camera.current?.click()}>
            <Icon name="camera" /> {t('Foto halaman', 'Take a photo of the page')}
          </button>
          <button type="button" class="btn secondary" disabled={!!reading} onClick={() => gallery.current?.click()}>
            {t('Pilih foto dari galeri', 'Choose a photo from the gallery')}
          </button>
          <span class="meta">{t('Satu halaman memakai satu jatah baca AI.', 'Each page uses one daily AI read.')}</span>
        </section>
        {inputs}
      </div>
    );
  }

  // ---------- review ----------
  const firstOpenKey = live.find((r) => r.open.length)?.key;
  const mock = s.pages.some((p) => p.mode === 'mock');
  return (
    <div class="screen">
      {header}
      {mock && (
        <p class="note info">
          <Icon name="info" />
          <span>{t('Mode contoh, bukan hasil AI. Baris di bawah adalah contoh untuk mencoba.', 'Sample mode, not an AI result. The rows below are samples to try it out.')}</span>
        </p>
      )}

      <section class="card" style={{ gap: 12 }}>
        <div class="stack-xs">
          <h2 class="num">{t(`AI menyalin ${live.length} baris`, `AI copied ${live.length} ${live.length === 1 ? 'row' : 'rows'}`)}</h2>
          <span class="label ink2 num">
            {openCount
              ? t(`${openCount} sel perlu dicek lagi. Sel itu kosong sampai diisi.`, `${openCount} ${openCount === 1 ? 'cell needs' : 'cells need'} checking. ${openCount === 1 ? 'It stays' : 'They stay'} empty until filled.`)
              : t('Semua sel sudah dicek.', 'All cells are checked.')}
          </span>
        </div>
        <span class="label ink2">{t('Bandingkan dengan buku. Angka bisa diubah, baris bisa dihapus.', 'Compare with the notebook. Numbers can be changed, rows can be deleted.')}</span>
        {status}
        {errorNote}
        <button type="button" class="btn secondary" disabled={!!reading} onClick={() => camera.current?.click()}>
          <Icon name="camera" /> {t('Tambah halaman lain', 'Add another page')}
        </button>
      </section>

      {s.pages.map((p) => (
        <PageGroup key={p.n} page={p} rows={s.rows.filter((r) => r.page === p.n)}>
          {s.rows
            .filter((r) => r.page === p.n)
            .map((r) => (
              <div key={r.key} ref={r.key === firstOpenKey ? firstOpen : undefined}>
                <RowCard row={r} ponds={ponds} recorded={isRecorded(r, s.recorded)} onChange={(x) => patch(r.key, x)} />
              </div>
            ))}
        </PageGroup>
      ))}
      {inputs}

      <ActionBar>
        {openCount > 0 ? (
          <button type="button" class="rp-link nb-goto" onClick={() => firstOpen.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
            <Icon name="alert" size={18} />
            {t(`${openCount} sel perlu dicek lagi`, `${openCount} ${openCount === 1 ? 'cell needs' : 'cells need'} checking`)}
            <Icon name="next" size={16} />
          </button>
        ) : badRow ? (
          <span class="error label">{badRow.error}</span>
        ) : skipping.length ? (
          <span class="label ink2 num">{t(`${skipping.length} baris dilewati: sudah ada catatan di tanggal itu.`, `${skipping.length} ${skipping.length === 1 ? 'row' : 'rows'} skipped: already recorded that day.`)}</span>
        ) : null}
        {saveError && <span class="error label">{saveError}</span>}
        <button type="button" class="btn primary num" disabled={!ready || saving} onClick={save}>
          {saving ? t('Menyimpan…', 'Saving…') : t(`Simpan ${toSave.length} baris`, `Save ${toSave.length} ${toSave.length === 1 ? 'row' : 'rows'}`)}
        </button>
      </ActionBar>
    </div>
  );
}

function mergeRecorded(a: Record<string, number[]>, b: Record<string, number[]>) {
  const out = { ...a };
  for (const [d, ids] of Object.entries(b)) out[d] = [...new Set([...(out[d] ?? []), ...ids])];
  return out;
}

function PageGroup({ page, rows, children }: { page: Page; rows: Row[]; children: preact.ComponentChildren }) {
  const [photo, setPhoto] = useState(false);
  const years = [...new Set(rows.filter((r) => r.yearGuessed && r.date && !r.removed).map((r) => r.date!.slice(0, 4)))].sort();
  return (
    <section class="stack-sm" style={{ gap: 12 }}>
      <div class="row between">
        <h2 class="num">{t(`Halaman ${page.n}`, `Page ${page.n}`)}</h2>
        <button type="button" class="rs-small-btn" aria-expanded={photo} onClick={() => setPhoto(!photo)}>
          {photo ? t('Tutup foto', 'Hide photo') : t('Lihat foto', 'Show photo')}
        </button>
      </div>
      {photo && <img class="nb-photo" src={page.url} alt={t(`Foto halaman ${page.n}`, `Photo of page ${page.n}`)} />}
      {page.problems.filter((p) => !/^(Mode contoh|Sample mode)/.test(p)).map((p) => (
        <p class="note info" key={p}>
          <Icon name="info" size={20} />
          <span>{p}</span>
        </p>
      ))}
      {years.length > 0 && (
        <span class="meta num">
          {t(`Tahun tidak tertulis, dianggap ${years.join(' dan ')}: tanggal terakhir yang sudah lewat.`, `No year written, taken as ${years.join(' and ')}: the most recent date that has passed.`)}
        </span>
      )}
      {page.rows === 0 && <p class="ink2">{t('Tidak ada baris yang terbaca di halaman ini. Coba foto lebih dekat dan lebih terang.', 'No rows could be read on this page. Try a closer, brighter photo.')}</p>}
      {children}
    </section>
  );
}

/** "Cek lagi": a shape and a word, never colour alone. */
const CekLagi = () => (
  <span class="nb-flag-word">
    <Icon name="alert" size={16} stroke={2.4} />
    {t('Cek lagi', 'Check again')}
  </span>
);

function RowCard({ row: r, ponds, recorded, onChange }: { row: Row; ponds: PondSummary[]; recorded: boolean; onChange: (p: Partial<Row>) => void }) {
  const pond = ponds.find((p) => p.id === r.pondId);
  const isOpen = (f: NotebookField) => r.open.includes(f);
  const close = (f: NotebookField, p: Partial<Row> = {}) => onChange({ ...p, open: r.open.filter((x) => x !== f) });
  const check = (f: NotebookField) => r.checks.find((c) => c.field === f);
  const { error } = readRow(r);

  if (r.removed)
    return (
      <div class="nb-removed" role="status">
        <span class="grow label ink2">
          {t('Baris dihapus', 'Row deleted')}: {r.dateWritten || '–'} {r.pondWritten}
        </span>
        <button type="button" class="rs-small-btn" onClick={() => onChange({ removed: false })}>
          {t('Batalkan', 'Undo')}
        </button>
      </div>
    );

  const dateCheck = isOpen('date') ? check('date') : undefined;
  const pondCheck = isOpen('pond') ? check('pond') : undefined;
  const valueChecks = COLS.map((c) => (isOpen(c.key) ? check(c.key) : undefined)).filter((c): c is NotebookCheck => !!c);
  const flagged = r.open.length > 0;

  return (
    <article class={`card nb-row${flagged ? ' flagged' : ''}`}>
      <div class="row top" style={{ gap: 8 }}>
        <div class="grow stack-xs" style={{ gap: 0 }}>
          {r.date && !r.editingDate ? (
            <button type="button" class="nb-date" onClick={() => onChange({ editingDate: true })} aria-label={t(`Tanggal ${longDate(r.date)}, ubah`, `Date ${longDate(r.date)}, change`)}>
              <span class="strong">{longDate(r.date)}</span>
              {r.time && <span class="meta" style={{ whiteSpace: 'nowrap' }}> · {timeWord(r.time)}</span>}
            </button>
          ) : (
            <span class="strong">{r.dateWritten ? t(`Tertulis “${r.dateWritten}”`, `Written “${r.dateWritten}”`) : t('Tanggal belum ada', 'No date yet')}</span>
          )}
        </div>
        <button type="button" class="nb-del" aria-label={t('Hapus baris', 'Delete row')} onClick={() => onChange({ removed: true })}>
          <Icon name="trash" size={20} />
        </button>
      </div>

      {(r.editingDate || !r.date) && (
        <div class={`nb-check${dateCheck ? ' open' : ''}`}>
          {dateCheck && (
            <div class="stack-xs">
              <CekLagi />
              <span class="label">
                {FIELD_NAME.date}: {dateCheck.written ? t(`tertulis “${dateCheck.written}”. `, `written “${dateCheck.written}”. `) : ''}
                {dateCheck.note}
              </span>
            </div>
          )}
          {dateCheck && typeof dateCheck.suggestion === 'string' && (
            <button type="button" class="btn primary nb-48" onClick={() => close('date', { date: dateCheck.suggestion as string, editingDate: false })}>
              {t(`Maksudnya ${longDate(dateCheck.suggestion)}?`, `Did it mean ${longDate(dateCheck.suggestion)}?`)}
            </button>
          )}
          <label class="field">
            <span class="label semi">{dateCheck ? t('Atau pilih tanggalnya', 'Or pick the date') : FIELD_NAME.date}</span>
            <input
              class="input nb-48"
              type="date"
              max={today()}
              value={r.date ?? ''}
              onChange={(e) => {
                const v = e.currentTarget.value;
                if (v && v <= today()) close('date', { date: v, editingDate: false });
              }}
            />
          </label>
        </div>
      )}

      {r.picking || !pond ? (
        <div class={`nb-check${pondCheck ? ' open' : ''}`}>
          {pondCheck && (
            <div class="stack-xs">
              <CekLagi />
              <span class="label">
                {pondCheck.written ? t(`Kolam tertulis “${pondCheck.written}”. `, `Pond written “${pondCheck.written}”. `) : ''}
                {pondCheck.note}
              </span>
            </div>
          )}
          <PondPicker
            ponds={sortBy(ponds, r.suggestions)}
            value={r.pondId}
            placeholder={t('Pilih kolam', 'Choose a pond')}
            onChange={(id) => close('pond', { pondId: id, picking: false })}
          />
        </div>
      ) : (
        <div class="row between" style={{ gap: 8 }}>
          <span class="strong">{pond.name}</span>
          <button type="button" class="rs-small-btn" onClick={() => onChange({ picking: true })}>
            {t('Ganti kolam', 'Change pond')}
          </button>
        </div>
      )}

      <div class="nb-cells">
        {COLS.map((c) => (
          <label key={c.key} class={`nb-cell${isOpen(c.key) ? ' open' : ''}`}>
            <span class="nb-cell-label">
              {isOpen(c.key) && <Icon name="alert" size={14} stroke={2.6} />}
              {c.label}
            </span>
            <input
              inputMode={c.key === 'tds' || c.key === 'dead' ? 'numeric' : 'decimal'}
              aria-label={`${FIELD_NAME[c.key]}${c.unit ? ` (${c.unit})` : ''}${isOpen(c.key) ? `, ${t('cek lagi', 'check again')}` : ''}`}
              value={r.vals[c.key]}
              placeholder={isOpen(c.key) ? '?' : '–'}
              onInput={(e) => {
                const v = e.currentTarget.value;
                // Typing a value is the farmer's answer to "Cek lagi".
                onChange({ vals: { ...r.vals, [c.key]: v }, open: v.trim() ? r.open.filter((x) => x !== c.key) : r.open });
              }}
            />
            <span class="nb-unit">{c.unit}</span>
          </label>
        ))}
      </div>

      {valueChecks.map((ch) => (
        <div key={ch.field} class="nb-check open">
          <div class="stack-xs">
            <CekLagi />
            <span class="label">
              <span class="semi">{FIELD_NAME[ch.field]}</span>
              {ch.written ? t(` tertulis “${ch.written}”. `, ` written “${ch.written}”. `) : ': '}
              {ch.note}
            </span>
          </div>
          <div class="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {typeof ch.suggestion === 'number' && (
              <button
                type="button"
                class="btn primary nb-48 grow num"
                onClick={() => close(ch.field, { vals: { ...r.vals, [ch.field]: fmtNum(ch.suggestion as number) } })}
              >
                {ch.kind === 'odd' ? t(`Maksudnya ${fmtNum(ch.suggestion)}?`, `Did it mean ${fmtNum(ch.suggestion)}?`) : t(`Pakai ${fmtNum(ch.suggestion)}`, `Use ${fmtNum(ch.suggestion)}`)}
              </button>
            )}
            <button type="button" class="btn secondary nb-48 grow" onClick={() => close(ch.field)}>
              {t('Biarkan kosong', 'Leave empty')}
            </button>
          </div>
        </div>
      ))}

      <label class="nb-note">
        <span class="label semi ink2">{t('Pakan dan catatan', 'Feed and notes')}</span>
        <input class="input nb-48" value={r.note} placeholder="–" onInput={(e) => onChange({ note: e.currentTarget.value })} />
      </label>

      {error && <p class="error label">{error}</p>}

      {recorded && (
        <div class="nb-dup">
          <span class="row label" style={{ gap: 8, alignItems: 'flex-start' }}>
            <Icon name="info" size={18} />
            <span>
              {r.also
                ? t(`${pond?.name ?? 'Kolam ini'} sudah punya catatan di tanggal ini. Baris ini tetap disimpan.`, `${pond?.name ?? 'This pond'} already has a record on this date. This row is saved as well.`)
                : t(`${pond?.name ?? 'Kolam ini'} sudah punya catatan di tanggal ini. Baris ini dilewati.`, `${pond?.name ?? 'This pond'} already has a record on this date. This row is skipped.`)}
            </span>
          </span>
          <button type="button" class="rs-small-btn" onClick={() => onChange({ also: !r.also })}>
            {r.also ? t('Lewati saja', 'Skip it') : t('Simpan juga', 'Save it too')}
          </button>
        </div>
      )}
    </article>
  );
}

/** Ponds in the order the server suggests (closest name first), the rest after. */
function sortBy(ponds: PondSummary[], order: number[]) {
  if (!order.length) return ponds;
  return [...ponds].sort((a, b) => (order.indexOf(a.id) + 1 || 999) - (order.indexOf(b.id) + 1 || 999));
}
