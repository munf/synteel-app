import { useEffect, useRef, useState } from 'preact/hooks';
import { api, ApiError, type Behavior, type CountResult, type Emergency, type LogData, type PondSummary } from '../api.ts';
import { prepareImage } from '../capture/media.ts';
import type { Go } from '../app.tsx';
import { fmtClock, fmtNum, levelLabel, phaseLabel, readingLabel } from '../labels.ts';
import { setForcedNight } from '../prefs.ts';
import { isEn, LOCALE, t } from '../i18n.ts';
import { StepList, useSteps } from '../steps.tsx';
import { Icon, PondThumb, Shape, Stepper, Tick, TickBox, toneOf, type IconName } from '../ui.tsx';
import './problem.css';

type Sign = 'dead' | 'surface' | 'inlet' | 'feed' | 'skin' | 'water' | 'power' | 'other';

// The four most common signs first; the rest sit behind "Gejala lain".
const SIGNS: { id: Sign; label: string; icon: IconName }[] = [
  { id: 'dead', label: t('Sidat mati', 'Dead eels'), icon: 'dead' },
  { id: 'surface', label: t('Naik ke permukaan', 'Coming up to the surface'), icon: 'up' },
  { id: 'feed', label: t('Tidak mau makan', 'Not eating'), icon: 'bowl' },
  { id: 'power', label: t('Aerator atau listrik mati', 'Aerator or power is off'), icon: 'bolt' },
  { id: 'inlet', label: t('Kumpul di air masuk', 'Crowding at the water inlet'), icon: 'inlet' },
  { id: 'skin', label: t('Luka, bercak, jamur', 'Wounds, spots, fungus'), icon: 'spots' },
  { id: 'water', label: t('Air berubah warna atau bau', 'Water color or smell changed'), icon: 'drop' },
  { id: 'other', label: t('Lainnya', 'Other'), icon: 'dots' },
];
const COMMON = 4;

/** "8 sidat mati terhitung" / "8 dead eels counted". */
const deadCounted = (n: number) => t(`${n} sidat mati terhitung`, `${n} dead ${n === 1 ? 'eel' : 'eels'} counted`);
/** One number when bodies and heads agree, else the range (reports saved before ranges have only `count`). */
const countText = (r: CountResult) => {
  const low = r.low ?? r.count;
  const high = r.high ?? r.count;
  return low === high ? deadCounted(low) : t(`Sekitar ${low}–${high} sidat mati`, `About ${low}–${high} dead eels`);
};

/** "Rabu 18.40": full day name, never "Rab". */
const dayClock = (at: number) => `${new Date(at).toLocaleDateString(LOCALE, { weekday: 'long', timeZone: 'Asia/Jakarta' })} ${fmtClock(at)}`;

// Which emergency SOP (knowledge/emergencies.json) answers which sign. Deterministic: works without the AI.
const SOP: Partial<Record<Sign, string>> = { dead: 'low_do', surface: 'low_do', inlet: 'low_do', power: 'power_outage', water: 'heavy_rain' };

// Steps in the words a farmer uses at the pond; the same step from two sources shows once.
const PLAIN: Record<string, string> = {
  'Cek aerator, diffuser dan selang udara': 'Cek aerator, batu aerasi dan selang udara',
  'Cek aerator, batu aerasi dan selang udara; jangan beri pakan dulu': 'Cek aerator, batu aerasi dan selang udara',
  'Tambah aerasi atau oksigen darurat': 'Nyalakan aerator cadangan atau oksigen darurat kalau ada',
  'Nyalakan aerator cadangan atau oksigen darurat': 'Nyalakan aerator cadangan atau oksigen darurat kalau ada',
  'Tunda pemberian pakan': 'Jangan beri pakan dulu sampai sidat berenang normal',
  'Cek kapasitas pemanas/pendingin dan kondisi ruangan': 'Cek kapasitas pemanas atau pendingin dan kondisi ruangan',
  'Cek pemanas/pendingin dan kondisi ruangan': 'Cek kapasitas pemanas atau pendingin dan kondisi ruangan',
  // English (the server answers in the chosen language).
  'Check the aerator, air stones and air hoses; do not feed yet': 'Check the aerator, air stones and air hoses',
  'Turn on a spare aerator or emergency oxygen': 'Turn on a spare aerator or emergency oxygen if you have one',
  'Hold off feeding': 'Do not feed until the eels swim normally',
};
const plain = (a: string) => {
  const step = a.trim().replace(/\.$/, '');
  return PLAIN[step] ?? step;
};

// ---------- working without signal ----------
// The emergency steps must show at the pond even with no signal, so the last copy is kept on the phone.
// A report made without signal waits on the phone and is sent (with its own time) once there is signal.

// One copy per language, so English never shows cached Indonesian steps (or the other way round).
const EMERGENCIES_KEY = isEn ? 'synteel.emergencies.en' : 'synteel.emergencies';
const QUEUE_KEY = 'synteel.pendingReports';

interface PendingReport {
  pondId: number;
  pondName: string;
  data: LogData;
  at: number;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private mode: kept for this page only
  }
}

/** No answer from the server at all (no signal), as opposed to an error it answered with. fetch() fails with a TypeError. */
const noSignal = (e: unknown) => e instanceof TypeError;

let sending: Promise<number> | null = null;
/** Send reports waiting on this phone. Resolves to how many were sent. */
export function sendPendingReports(): Promise<number> {
  if (sending) return sending;
  sending = (async () => {
    const queue = readJson<PendingReport[]>(QUEUE_KEY, []);
    if (!queue.length || !navigator.onLine) return 0;
    // A report is only sent to the farm it was made on: same pond id and name.
    const { ponds } = await api.farm();
    let sent = 0;
    for (const r of queue) {
      if (!ponds.some((p) => p.id === r.pondId && p.name === r.pondName)) continue;
      try {
        await api.addLog(r.pondId, { ...r.data, loggedAt: new Date(r.at).toISOString() } as LogData);
        sent++;
      } catch (err) {
        if (noSignal(err)) break;
        if (err instanceof ApiError && (err.status === 401 || err.status >= 500)) break;
        // Refused for good (e.g. the pond was removed): drop it rather than retry forever.
      }
      writeJson(QUEUE_KEY, readJson<PendingReport[]>(QUEUE_KEY, []).filter((x) => x.at !== r.at));
    }
    return sent;
  })()
    .catch(() => 0)
    .finally(() => {
      sending = null;
    });
  return sending;
}
const isQueued = (at: number) => readJson<PendingReport[]>(QUEUE_KEY, []).some((r) => r.at === at);
if (typeof window !== 'undefined') window.addEventListener('online', () => void sendPendingReports());

/** Sends waiting reports now and whenever signal comes back; `onSent` refreshes the farm. */
function useSendPending(onSent: () => void) {
  useEffect(() => {
    const run = () => sendPendingReports().then((n) => n > 0 && onSent());
    run();
    window.addEventListener('online', run);
    return () => window.removeEventListener('online', run);
  }, []);
}

// ---------- pond picker: name, then phase and week, then the count, each on its own line ----------

function metaLines(p: PondSummary): [string, string | null] {
  if (!p.batch || !p.program) return [t('Belum ada batch', 'No batch yet'), null];
  const alive = p.program.estimatedAlive;
  const count = alive !== null ? t(`sekitar ${alive.toLocaleString(LOCALE)} ekor`, `about ${alive.toLocaleString(LOCALE)} ${alive === 1 ? 'eel' : 'eels'}`) : null;
  return [`${phaseLabel[p.batch.phase]} · ${t('minggu', 'week')} ${p.program.week}`, count];
}

function Meta({ p }: { p: PondSummary | undefined }) {
  const [a, b] = p ? metaLines(p) : [t('Belum dipilih', 'Not chosen yet'), null];
  return (
    <span class="meta num stack-xs" style={{ gap: 0 }}>
      <span>{a}</span>
      {b && <span>{b}</span>}
    </span>
  );
}

function PondChooser({ ponds, value, onChange }: { ponds: PondSummary[]; value: number | null; onChange: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const cur = ponds.find((p) => p.id === value);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  const q = query.trim().toLowerCase();
  const shown = q ? ponds.filter((p) => p.name.toLowerCase().includes(q)) : ponds;

  return (
    <div class="picker" ref={ref}>
      <button type="button" class={`picker-btn${open ? ' open' : cur ? '' : ' empty'}`} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
        {cur ? (
          <PondThumb kind={cur.kind} />
        ) : (
          <span class="thumb" style={{ width: 56, height: 56, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>
            <Icon name="plus" />
          </span>
        )}
        <span class="grow stack-xs">
          <span class="h2">{cur ? cur.name : t('Pilih kolam', 'Choose a pond')}</span>
          <Meta p={cur} />
        </span>
        <Icon name="down" />
      </button>
      {open && (
        <div class="picker-menu">
          {ponds.length > 5 && (
            <label class="picker-search">
              <Icon name="search" size={20} />
              <input aria-label={t('Cari kolam', 'Search ponds')} placeholder={t('Cari nama kolam', 'Search pond name')} value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
            </label>
          )}
          <div role="listbox" aria-label={t('Daftar kolam', 'Pond list')} class="stack-xs">
            {shown.map((p) => (
              <button
                type="button"
                key={p.id}
                role="option"
                aria-selected={p.id === value}
                class={`picker-option${p.id === value ? ' on' : ''}`}
                style={{ padding: '8px' }}
                onClick={() => {
                  onChange(p.id);
                  setOpen(false);
                  setQuery('');
                }}
              >
                <PondThumb kind={p.kind} size={40} />
                <span class="grow stack-xs" style={{ gap: 0 }}>
                  <span class="strong">{p.name}</span>
                  <Meta p={p} />
                </span>
                <span class="word pond-word">
                  <Shape tone={toneOf(p.level)} />
                  {levelLabel[p.level]}
                </span>
                {p.id === value && <Tick />}
              </button>
            ))}
            {shown.length === 0 && (
              <p class="meta" style={{ padding: '16px 8px' }}>
                {t('Tidak ada kolam dengan nama itu.', 'No pond with that name.')}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface Counted {
  url: string;
  w: number;
  h: number;
  result: CountResult;
  mock?: boolean;
}

interface Report {
  pond: PondSummary;
  signs: Sign[];
  dead: number;
  at: number;
  counted: Counted | null;
  /** Made without signal: waiting on this phone. */
  offline: boolean;
}

/** Re-check reminders live on this phone; Beranda shows them when they are due. */
export interface Recheck {
  pondId: number;
  pondName: string;
  at: number;
  dueAt: number;
  dead: number;
}
const RECHECK_KEY = 'synteel.rechecks';
export function loadRechecks(): Recheck[] {
  try {
    return JSON.parse(localStorage.getItem(RECHECK_KEY) ?? '[]');
  } catch {
    return [];
  }
}
export function saveRechecks(list: Recheck[]) {
  try {
    localStorage.setItem(RECHECK_KEY, JSON.stringify(list));
  } catch {
    // private mode: the reminder only lives until the page closes
  }
}

const COLORS = ['#E5484D', '#2F6FE4', '#12A594', '#C27C00', '#8E4EC6', '#D6409F', '#0D74CE', '#F76B15'];

/** The basin photo with one numbered outline per eel SAM found. */
function CountedPhoto({ c }: { c: Counted }) {
  const stroke = Math.max(2, c.w / 320);
  const r = Math.max(12, c.w / 45);
  return (
    <div style={{ position: 'relative', borderRadius: 16, overflow: 'hidden', background: 'var(--bg)' }}>
      <img src={c.url} alt={t('Foto sidat mati', 'Photo of the dead eels')} style={{ display: 'block', width: '100%' }} />
      <svg viewBox={`0 0 ${c.w} ${c.h}`} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} role="img" aria-label={countText(c.result)}>
        {c.result.eels.map((e, i) => (
          <path key={`p${i}`} d={e.path} transform={`translate(${e.left} ${e.top})`} fill={COLORS[i % COLORS.length]} fill-opacity={e.sure === false ? 0.1 : 0.25} stroke={COLORS[i % COLORS.length]} stroke-width={stroke} stroke-dasharray={e.sure === false ? `${stroke * 3} ${stroke * 2}` : undefined} />
        ))}
        {(c.result.heads ?? []).map((h, i) => (
          <circle key={`h${i}`} cx={h.x} cy={h.y} r={r * 0.45} fill="#F2B544" stroke="#13203A" stroke-width={stroke * 0.8} />
        ))}
        {c.result.eels.filter((e) => e.sure !== false).map((e, i) => (
          <g key={`l${i}`}>
            <circle cx={e.label.x} cy={e.label.y} r={r} fill="#fff" stroke={COLORS[i % COLORS.length]} stroke-width={stroke} />
            <text x={e.label.x} y={e.label.y + r * 0.38} text-anchor="middle" font-size={r * 1.1} font-weight="800" fill="#13203A">
              {i + 1}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function Result({ report, emergencies, go, onBack, onSaved }: { report: Report; emergencies: Emergency[]; go: Go; onBack: () => void; onSaved: () => void }) {
  const { done, toggle } = useSteps(report.pond.id);
  const [queued, setQueued] = useState(report.offline);
  // Signal back while this screen is open: the waiting report goes out and the notice says so.
  useEffect(() => {
    if (!report.offline) return;
    const check = () =>
      sendPendingReports().then((n) => {
        if (n > 0) onSaved();
        if (!isQueued(report.at)) setQueued(false);
      });
    window.addEventListener('online', check);
    return () => window.removeEventListener('online', check);
  }, []);
  const { pond, signs } = report;
  const steps = [
    ...new Set([
      ...signs.flatMap((s) => emergencies.find((e) => e.id === SOP[s])?.operator_actions ?? []),
      ...pond.findings.filter((f) => f.level !== 'info').flatMap((f) => f.actions),
    ]),
  ]
    .map(plain)
    .filter((a, i, all) => all.indexOf(a) === i)
    .slice(0, 5);
  if (signs.includes('skin')) steps.push(t('Pisahkan sidat yang luka atau berjamur ke kolam karantina', 'Move eels with wounds or fungus to a quarantine pond'));
  const count = steps.filter((s) => done[s]).length;
  const causes = pond.findings.filter((f) => f.level === 'critical' || f.level === 'warning').slice(0, 3);
  const signText = SIGNS.filter((s) => signs.includes(s.id))
    .map((s) => s.label.toLowerCase())
    .join(', ');

  const summary = [
    t(`Laporan ${pond.name}, ${dayClock(report.at)}`, `${pond.name} report, ${dayClock(report.at)}`),
    t(`Terlihat: ${signText}${report.dead ? ` (${report.dead} ekor mati)` : ''}`, `Seen: ${signText}${report.dead ? ` (${report.dead} dead)` : ''}`),
    ...(['temperature', 'ph', 'tds'] as const)
      .filter((k) => pond.latest[k])
      .map((k) => {
        const value = `${fmtNum(pond.latest[k]!.value)}${readingLabel[k].unit ? ' ' + readingLabel[k].unit : ''}`;
        return t(`${readingLabel[k].name} terakhir: ${value}`, `Last ${k === 'temperature' ? 'temperature' : readingLabel[k].name}: ${value}`);
      }),
    count ? `${t('Sudah dilakukan', 'Done')}: ${steps.filter((s) => done[s]).map((s) => `${s} (${fmtClock(done[s].at)})`).join('; ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <div class="screen problem-flow">
      <header class="row">
        <button class="icon-btn" aria-label={t('Kembali', 'Back')} onClick={onBack}>
          <Icon name="back" />
        </button>
        <PondThumb kind={pond.kind} size={48} />
        <div class="stack-xs grow">
          <h1 style={{ lineHeight: 1 }}>
            {pond.name} · {fmtClock(report.at)}
          </h1>
          <span class="meta">{signText.charAt(0).toUpperCase() + signText.slice(1)}</span>
        </div>
      </header>

      {queued ? (
        <div class="note info" role="status" style={{ fontSize: '1rem' }}>
          <Icon name="nowifi" />
          <span class="grow stack-xs" style={{ gap: 0 }}>
            <span class="strong">{t('Belum ada sinyal', 'No signal yet')}</span>
            <span>{t('Laporan disimpan di HP, terkirim otomatis saat ada sinyal.', 'The report is kept on the phone and sent by itself when there is signal.')}</span>
          </span>
        </div>
      ) : (
        <div class="note ok" role="status">
          <Icon name="check" />
          <span class="grow">{t('Laporan tersimpan di catatan kolam.', 'Report saved in the pond records.')}</span>
        </div>
      )}

      {steps.length > 0 && (
        <section class="hero">
          <div class="row between">
            <h2>{t('Lakukan sekarang', 'Do this now')}</h2>
            <span class="label semi" style={{ color: 'var(--on-navy-2)' }}>
              {t(`${count} dari ${steps.length} selesai`, `${count} of ${steps.length} done`)}
            </span>
          </div>
          <span class="progress">
            <span style={{ width: `${(count / steps.length) * 100}%` }} />
          </span>
          <StepList steps={steps} done={done} toggle={toggle} onAllDone={{ label: t('Catat kondisi sekarang', 'Record conditions now'), run: () => go({ name: 'record-pond', pondId: pond.id }) }} />
          <span class="label" style={{ color: '#9FB0CF' }}>
            {report.offline
              ? t('Langkah ini tersimpan di HP, tetap muncul tanpa sinyal.', 'These steps are kept on the phone and still show without signal.')
              : t('Langkah ini tetap muncul walau tanpa internet.', 'These steps still show without internet.')}
          </span>
        </section>
      )}

      {/* The owner is not told by the app: the farmer sends the summary (FAKTA: automatic message is not built). */}
      <section class="card soft-bad help-card">
        <div class="row top">
          <span class="icon-box bad">
            <Icon name="info" />
          </span>
          <div class="stack-xs">
            <span class="strong help-head">{t('Minta bantuan pemilik tambak atau penyuluh kalau', 'Ask the farm owner or an extension officer for help if')}</span>
            <span class="label help-body">
              {t(
                'sidat mati bertambah dalam 6 jam, atau muncul bercak, luka atau jamur. Aplikasi ini tidak memberi dosis obat.',
                'more eels die within 6 hours, or spots, wounds or fungus appear. This app does not give medicine doses.',
              )}
            </span>
          </div>
        </div>
        <p class="row top semi help-head">
          <Icon name="chat" size={20} />
          <span class="grow">{t('Pemilik belum dikabari. Kirim ringkasan lewat WhatsApp.', 'The owner has not been told yet. Send the summary on WhatsApp.')}</span>
        </p>
        <a class="btn danger" href={`https://wa.me/?text=${encodeURIComponent(summary)}`} target="_blank" rel="noopener">
          <Icon name="chat" size={20} /> {t('Kirim ringkasan ke WhatsApp', 'Send the summary to WhatsApp')}
        </a>
        {queued && <span class="label help-body">{t('Tetap bisa tanpa sinyal: WhatsApp mengirim pesan begitu ada sinyal.', 'This works without signal too: WhatsApp sends the message as soon as there is signal.')}</span>}
        <div class="summary-box stack-xs">
          <span class="label strong help-head">{t('Isi ringkasan', 'Summary text')}</span>
          <span class="label ink2" style={{ whiteSpace: 'pre-line' }}>
            {summary}
          </span>
        </div>
      </section>

      {report.counted && (
        <section class="card">
          <h2>{t('Dari foto', 'From the photo')}</h2>
          <CountedPhoto c={report.counted} />
          <p>
            <strong>{countText(report.counted.result)}</strong>
            {report.dead !== report.counted.result.count && t(`, dicatat ${report.dead} setelah dicek`, `, ${report.dead} recorded after checking`)}.
          </p>
          <span class="label ink2">{t('Perkiraan AI dari badan dan mata sidat. Sidat yang bertumpuk bisa terlewat.', 'AI estimate from eel bodies and eyes. Eels that overlap can be missed.')}</span>
        </section>
      )}

      <section class="card">
        <h2>{t('Kemungkinan penyebab', 'Possible causes')}</h2>
        {causes.length === 0 && (
          <p class="ink2">
            {t(
              'Catatan terakhir belum menunjukkan penyebab yang jelas. Ukur suhu, pH dan TDS sekarang.',
              'The latest records do not show a clear cause yet. Measure temperature, pH and TDS now.',
            )}
          </p>
        )}
        {causes.map((f, i) => (
          <div class="row top" key={f.id}>
            <span class={`cause-num${i === 0 ? ' first' : ''}`}>{i + 1}</span>
            <div class="stack-xs">
              <span class="strong">{f.title}</span>
              <span class="label ink2">{f.detail}</span>
            </div>
          </div>
        ))}
        <span class="label ink2">{t('Dari catatan kolam dan aturan ambang batas. Ini saran, bukan diagnosis.', 'From the pond records and threshold rules. This is advice, not a diagnosis.')}</span>
      </section>

      <section class="card">
        <div class="row">
          <span class="icon-box">
            <Icon name="clock" />
          </span>
          <div class="stack-xs grow">
            <span class="strong">{t(`Cek ulang jam ${fmtClock(report.at + 3600_000)}`, `Check again at ${fmtClock(report.at + 3600_000)}`)}</span>
            <span class="label ink2">{t('Pengingat muncul di Beranda: sidat sudah turun dan berenang normal?', 'A reminder will show on Home: are the eels back down and swimming normally?')}</span>
          </div>
        </div>
        <button class="btn primary" onClick={() => go({ name: 'today' })}>
          {t('Selesai, kembali ke Beranda', 'Done, back to Home')}
        </button>
      </section>
    </div>
  );
}

/** Basin photo the AI found no eel in, or could not count: tips, try again, or count by hand. */
function CountFailed({ failed, onRetake, onManual }: { failed: Failed; onRetake: () => void; onManual: () => void }) {
  return (
    <section class="card">
      <div class="row top">
        {failed.url ? (
          <img src={failed.url} alt={t('Foto sidat mati', 'Photo of the dead eels')} style={{ width: 88, height: 66, flex: 'none', borderRadius: 12, objectFit: 'cover', background: '#20252c' }} />
        ) : (
          <span style={{ width: 88, height: 66, flex: 'none', borderRadius: 12, background: '#20252c' }} />
        )}
        <span class="grow stack-xs">
          <span class="h2">{t('AI belum melihat sidat di foto ini', 'The AI did not see eels in this photo')}</span>
          <span class="label ink2">
            {failed.offline
              ? t('Foto belum terkirim karena belum ada sinyal. Isi jumlah sendiri, atau foto ulang saat ada sinyal.', 'The photo was not sent because there is no signal yet. Enter the number yourself, or photograph again when there is signal.')
              : t('Sidat terlalu menumpuk, foto terlalu gelap, atau sidat tertutup bayangan.', 'The eels are piled up, the photo is too dark, or the eels are in shadow.')}
          </span>
        </span>
      </div>
      <ul class="count-tips">
        {TIPS.map((tip) => (
          <li key={tip.text}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d={tip.d} />
            </svg>
            {tip.text}
          </li>
        ))}
      </ul>
      <button type="button" class="btn primary" onClick={onRetake}>
        <Icon name="camera" size={20} /> {t('Foto ulang', 'Photograph again')}
      </button>
      <button type="button" class="btn secondary" onClick={onManual}>
        {t('Isi jumlah sendiri', 'Enter the number yourself')}
      </button>
    </section>
  );
}

const TIPS = [
  { d: 'M3 9h18l-2 9H5zM6 9V7h12v2', text: t('Sebar sedikit di serok, baskom atau nampan, jangan menggumpal', 'Spread them a little in the scoop, basin or tray, not in a lump') },
  { d: 'M12 4v10M8 10l4 4 4-4M5 20h14', text: t('Foto lurus dari atas', 'Photograph straight from above') },
  { d: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4', text: t('Cari tempat cukup terang, atau nyalakan senter HP', 'Find a bright enough spot, or turn on the phone torch') },
];

interface Failed {
  url: string | null;
  offline: boolean;
}

export function Problem({ ponds, initialPondId, onSaved, go }: { ponds: PondSummary[]; initialPondId?: number; onSaved: () => void; go: Go }) {
  // No pond preselected unless the farmer came from that pond's page: the wrong pond is worse than one more tap.
  const [pondId, setPondId] = useState<number | null>(initialPondId ?? null);
  const [signs, setSigns] = useState<Sign[]>([]);
  const [dead, setDead] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  // The last copy kept on this phone first, so the steps show even without signal.
  const [emergencies, setEmergencies] = useState<Emergency[]>(() => readJson<Emergency[]>(EMERGENCIES_KEY, []));
  const [counted, setCounted] = useState<Counted | null>(null);
  const [counting, setCounting] = useState(false);
  const [failed, setFailed] = useState<Failed | null>(null);
  const [manual, setManual] = useState(false);
  const [more, setMore] = useState(false);
  const photo = useRef<HTMLInputElement>(null);

  useSendPending(onSaved);
  // Opened from the night alarm, alarm.tsx forces the dark theme; it ends when this flow (form and result) is left.
  // Elsewhere the flow follows the manual Profil switch "Tampilan malam".
  useEffect(() => () => setForcedNight(false), []);

  // The photo → SAM 3.1 count or range with outlines and heads; the stepper below starts from it.
  const onBasinPhoto = async (file: File | undefined) => {
    if (!file || pondId === null) return;
    setCounting(true);
    setFailed(null);
    setManual(false);
    let url: string | null = null;
    try {
      const { blob } = await prepareImage(file, 1280);
      url = URL.createObjectURL(blob);
      const img = new Image();
      img.src = url;
      await img.decode();
      const { result, mock } = await api.countEels(pondId, blob);
      if (!mock && result.count === 0) {
        setCounted(null);
        setFailed({ url, offline: false });
      } else {
        setCounted({ url, w: img.naturalWidth, h: img.naturalHeight, result, mock });
        if (result.count > 0) setDead(result.count);
      }
    } catch (err) {
      setCounted(null);
      setFailed({ url, offline: noSignal(err) });
    } finally {
      setCounting(false);
    }
  };

  useEffect(() => {
    api.knowledge().then(
      (k) => {
        const list = Array.isArray(k.emergencies?.emergencies) ? k.emergencies.emergencies : [];
        setEmergencies(list);
        if (list.length) writeJson(EMERGENCIES_KEY, list);
      },
      () => {},
    );
  }, []);

  if (report) return <Result report={report} emergencies={emergencies} go={go} onBack={() => setReport(null)} onSaved={onSaved} />;

  const toggle = (s: Sign) => setSigns(signs.includes(s) ? signs.filter((x) => x !== s) : [...signs, s]);

  const submit = async () => {
    const chosen = ponds.find((p) => p.id === pondId);
    if (!chosen) return;
    setBusy(true);
    setError('');
    const behavior: Behavior[] = [];
    if (signs.includes('surface')) behavior.push('surfacing');
    if (signs.includes('inlet')) behavior.push('gathering_inlet');
    if (signs.includes('feed')) behavior.push('not_eating');
    const data: LogData = {
      behavior: behavior.length ? behavior : undefined,
      mortality: signs.includes('dead') ? dead : undefined,
      aeration: signs.includes('power') ? 'off' : undefined,
      note:
        t('Laporan masalah: ', 'Problem report: ') +
        SIGNS.filter((s) => signs.includes(s.id))
          .map((s) => s.label.toLowerCase())
          .join(', '),
    };
    const at = Date.now();
    const deadNow = signs.includes('dead') ? dead : 0;
    const show = (pond: PondSummary, offline: boolean) => {
      setReport({ pond, signs, dead: deadNow, at, counted: signs.includes('dead') ? counted : null, offline });
      // Remind on Beranda in an hour; one reminder per pond.
      saveRechecks([...loadRechecks().filter((r) => r.pondId !== pond.id), { pondId: pond.id, pondName: pond.name, at, dueAt: at + 3600_000, dead: deadNow }]);
    };
    try {
      const { pond } = await api.addLog(chosen.id, data);
      onSaved();
      show(pond, false);
    } catch (err) {
      if (!noSignal(err)) {
        setError((err as Error).message);
      } else {
        // No signal: keep the report on this phone and still show what to do now.
        writeJson(QUEUE_KEY, [...readJson<PendingReport[]>(QUEUE_KEY, []), { pondId: chosen.id, pondName: chosen.name, data, at }]);
        show(chosen, true);
      }
    } finally {
      setBusy(false);
    }
  };

  // A hidden sign that is ticked stays visible.
  const shown = SIGNS.filter((s, i) => more || i < COMMON || signs.includes(s.id));
  const hidden = SIGNS.length - shown.length;

  return (
    <div class="screen problem-flow has-bar">
      <section class="stack-sm">
        <h1>{t('Ada masalah?', 'Something wrong?')}</h1>
        <p class="ink2">{t('Pilih kolamnya dulu, lalu pilih yang terlihat.', 'Choose the pond first, then pick what you see.')}</p>
      </section>

      <div class="field">
        <span class="field-label">{t('Kolam mana?', 'Which pond?')}</span>
        <PondChooser ponds={ponds} value={pondId} onChange={setPondId} />
      </div>

      <section class="stack-sm">
        <span class="field-label">{t('Pilih yang terlihat', 'Pick what you see')}</span>
        <div class="grid2">
          {shown.map((s) => {
            const on = signs.includes(s.id);
            return (
              <button key={s.id} type="button" class={`tile${on ? ' on' : ''}`} aria-pressed={on} onClick={() => toggle(s.id)}>
                <span class="icon-box">
                  <Icon name={s.icon} />
                </span>
                <span class="tile-label">{s.label}</span>
                <TickBox on={on} />
              </button>
            );
          })}
        </div>
        {(more || hidden > 0) && (
          <button type="button" class="more-signs" aria-expanded={more} onClick={() => setMore(!more)}>
            <span>{more ? t('Sembunyikan gejala lain', 'Hide other signs') : t(`Gejala lain (${hidden})`, `Other signs (${hidden})`)}</span>
            <Icon name="down" size={20} />
          </button>
        )}
      </section>

      {signs.includes('dead') && (
        <div class={`field${manual ? ' count-manual' : ''}`}>
          <span class="field-label">{t('Berapa ekor mati?', 'How many died?')}</span>
          <Stepper value={dead} onChange={setDead} min={1} quick={[5, 10, 50]} tapHint={false} />
          {manual && (
            <span role="status" class="label semi" style={{ color: 'var(--accent-ink)' }}>
              {t('Isi dengan − dan +. Jumlah ini yang dipakai di laporan.', 'Set it with − and +. This number is used in the report.')}
            </span>
          )}
          <input ref={photo} type="file" accept="image/*" capture="environment" hidden onChange={(e) => (onBasinPhoto(e.currentTarget.files?.[0]), (e.currentTarget.value = ''))} />
          {!failed && (
            <>
              <span class="field-hint">{t('Usahakan foto ikan sidat yang mati dengan jelas.', 'Try to take a clear photo of the dead eels.')}</span>
              <button type="button" class="btn secondary" disabled={pondId === null || counting} onClick={() => photo.current?.click()}>
                <Icon name="camera" size={20} /> {counting ? t('AI sedang menghitung…', 'The AI is counting…') : counted ? t('Foto ulang', 'Photograph again') : t('Foto untuk dihitung AI', 'Photo for an AI count')}
              </button>
              {pondId === null && <span class="field-hint">{t('Pilih kolam dulu.', 'Choose a pond first.')}</span>}
            </>
          )}
          {counted && (
            <div class="stack-sm">
              <CountedPhoto c={counted} />
              {counted.mock ? (
                <p class="note info">
                  <Icon name="info" size={20} />
                  <span>{t('Mode contoh: hitung otomatis tidak aktif di server ini. Hitung manual.', 'Sample mode: the automatic count is off on this server. Count by hand.')}</span>
                </p>
              ) : (
                <>
                  <p>
                    <strong>{countText(counted.result)}.</strong>{' '}
                    {(counted.result.low ?? counted.result.count) === (counted.result.high ?? counted.result.count)
                      ? t('Jumlah di atas sudah diisi. Ubah kalau berbeda.', 'The number above is filled in. Change it if it is wrong.')
                      : t(`Angka tengah ${counted.result.count} sudah diisi. Cek fotonya, lalu ubah kalau berbeda.`, `The middle, ${counted.result.count}, is filled in. Check the photo, then change it if it is wrong.`)}
                  </p>
                  {counted.result.review && (
                    <p class="note info">
                      <Icon name="info" size={20} />
                      <span>{t('Garis putus-putus berarti AI ragu, titik kuning berarti kepala sidat. Sidat yang bertumpuk bisa terlewat.', 'A dashed outline means the AI is unsure; a yellow dot is an eel head. Eels that overlap can be missed.')}</span>
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {signs.includes('dead') && failed && (
        <CountFailed failed={failed} onRetake={() => photo.current?.click()} onManual={() => setManual(true)} />
      )}

      <span class="label ink2 center">{t('Laporan darurat tidak memakai jatah baca AI.', 'Emergency reports do not use your daily AI reads.')}</span>
      {error && <p class="error">{error}</p>}

      {/* Main action: pinned above the tab bar while the page scrolls. */}
      <div class="problem-bar">
        <button class="btn primary" disabled={pondId === null || signs.length === 0 || busy} onClick={submit}>
          {pondId === null ? t('Pilih kolam dulu', 'Choose a pond first') : signs.length === 0 ? t('Pilih yang terlihat', 'Pick what you see') : t('Lihat yang harus dilakukan', 'See what to do')}
          {pondId !== null && signs.length > 0 && <Icon name="arrow" size={20} />}
        </button>
      </div>
    </div>
  );
}
