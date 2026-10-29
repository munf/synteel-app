import { useEffect, useRef, useState } from 'preact/hooks';
import { api, ApiError, type Behavior, type CountResult, type Emergency, type LogData, type PondSummary } from '../api.ts';
import { prepareImage } from '../capture/media.ts';
import type { Go } from '../app.tsx';
import { fmtClock, fmtNum, levelLabel, phaseLabel, readingLabel } from '../labels.ts';
import { setForcedNight } from '../prefs.ts';
import { StepList, useSteps } from '../steps.tsx';
import { Icon, PondThumb, Shape, Stepper, Tick, TickBox, toneOf, type IconName } from '../ui.tsx';
import './problem.css';

type Sign = 'dead' | 'surface' | 'inlet' | 'feed' | 'skin' | 'water' | 'power' | 'other';

// The four most common signs first; the rest sit behind "Gejala lain".
const SIGNS: { id: Sign; label: string; icon: IconName }[] = [
  { id: 'dead', label: 'Sidat mati', icon: 'dead' },
  { id: 'surface', label: 'Naik ke permukaan', icon: 'up' },
  { id: 'feed', label: 'Tidak mau makan', icon: 'bowl' },
  { id: 'power', label: 'Aerator atau listrik mati', icon: 'bolt' },
  { id: 'inlet', label: 'Kumpul di air masuk', icon: 'inlet' },
  { id: 'skin', label: 'Luka, bercak, jamur', icon: 'spots' },
  { id: 'water', label: 'Air berubah warna atau bau', icon: 'drop' },
  { id: 'other', label: 'Lainnya', icon: 'dots' },
];
const COMMON = 4;

/** "Rabu 18.40": full day name, never "Rab". */
const dayClock = (t: number) => `${new Date(t).toLocaleDateString('id-ID', { weekday: 'long', timeZone: 'Asia/Jakarta' })} ${fmtClock(t)}`;

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
};
const plain = (a: string) => {
  const t = a.trim().replace(/\.$/, '');
  return PLAIN[t] ?? t;
};

// ---------- working without signal ----------
// The emergency steps must show at the pond even with no signal, so the last copy is kept on the phone.
// A report made without signal waits on the phone and is sent (with its own time) once there is signal.

const EMERGENCIES_KEY = 'synteel.emergencies';
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
  if (!p.batch || !p.program) return ['Belum ada batch', null];
  const count = p.program.estimatedAlive !== null ? `sekitar ${p.program.estimatedAlive.toLocaleString('id-ID')} ekor` : null;
  return [`${phaseLabel[p.batch.phase]} · minggu ${p.program.week}`, count];
}

function Meta({ p }: { p: PondSummary | undefined }) {
  const [a, b] = p ? metaLines(p) : ['Belum dipilih', null];
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
          <span class="h2">{cur ? cur.name : 'Pilih kolam'}</span>
          <Meta p={cur} />
        </span>
        <Icon name="down" />
      </button>
      {open && (
        <div class="picker-menu">
          {ponds.length > 5 && (
            <label class="picker-search">
              <Icon name="search" size={20} />
              <input aria-label="Cari kolam" placeholder="Cari nama kolam" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
            </label>
          )}
          <div role="listbox" aria-label="Daftar kolam" class="stack-xs">
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
                Tidak ada kolam dengan nama itu.
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
      <img src={c.url} alt="Foto sidat mati di baskom" style={{ display: 'block', width: '100%' }} />
      <svg viewBox={`0 0 ${c.w} ${c.h}`} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} role="img" aria-label={`${c.result.count} sidat ditandai`}>
        {c.result.eels.map((e, i) => (
          <path key={`p${i}`} d={e.path} transform={`translate(${e.left} ${e.top})`} fill={COLORS[i % COLORS.length]} fill-opacity="0.25" stroke={COLORS[i % COLORS.length]} stroke-width={stroke} />
        ))}
        {c.result.eels.map((e, i) => (
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
  if (signs.includes('skin')) steps.push('Pisahkan sidat yang luka atau berjamur ke kolam karantina');
  const count = steps.filter((s) => done[s]).length;
  const causes = pond.findings.filter((f) => f.level === 'critical' || f.level === 'warning').slice(0, 3);
  const signText = SIGNS.filter((s) => signs.includes(s.id))
    .map((s) => s.label.toLowerCase())
    .join(', ');

  const summary = [
    `Laporan ${pond.name}, ${dayClock(report.at)}`,
    `Terlihat: ${signText}${report.dead ? ` (${report.dead} ekor mati)` : ''}`,
    ...(['temperature', 'ph', 'tds'] as const)
      .filter((k) => pond.latest[k])
      .map((k) => `${readingLabel[k].name} terakhir: ${fmtNum(pond.latest[k]!.value)}${readingLabel[k].unit ? ' ' + readingLabel[k].unit : ''}`),
    count ? `Sudah dilakukan: ${steps.filter((s) => done[s]).map((s) => `${s} (${fmtClock(done[s].at)})`).join('; ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <div class="screen problem-flow">
      <header class="row">
        <button class="icon-btn" aria-label="Kembali" onClick={onBack}>
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
            <span class="strong">Belum ada sinyal</span>
            <span>Laporan disimpan di HP, terkirim otomatis saat ada sinyal.</span>
          </span>
        </div>
      ) : (
        <div class="note ok" role="status">
          <Icon name="check" />
          <span class="grow">Laporan tersimpan di catatan kolam.</span>
        </div>
      )}

      {steps.length > 0 && (
        <section class="hero">
          <div class="row between">
            <h2>Lakukan sekarang</h2>
            <span class="label semi" style={{ color: 'var(--on-navy-2)' }}>
              {count} dari {steps.length} selesai
            </span>
          </div>
          <span class="progress">
            <span style={{ width: `${(count / steps.length) * 100}%` }} />
          </span>
          <StepList steps={steps} done={done} toggle={toggle} onAllDone={{ label: 'Catat kondisi sekarang', run: () => go({ name: 'record-pond', pondId: pond.id }) }} />
          <span class="label" style={{ color: '#9FB0CF' }}>
            {report.offline ? 'Langkah ini tersimpan di HP, tetap muncul tanpa sinyal.' : 'Langkah ini tetap muncul walau tanpa internet.'}
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
            <span class="strong help-head">Minta bantuan pemilik tambak atau penyuluh kalau</span>
            <span class="label help-body">sidat mati bertambah dalam 6 jam, atau muncul bercak, luka atau jamur. Aplikasi ini tidak memberi dosis obat.</span>
          </div>
        </div>
        <p class="row top semi help-head">
          <Icon name="chat" size={20} />
          <span class="grow">Pemilik belum dikabari. Kirim ringkasan lewat WhatsApp.</span>
        </p>
        <a class="btn danger" href={`https://wa.me/?text=${encodeURIComponent(summary)}`} target="_blank" rel="noopener">
          <Icon name="chat" size={20} /> Kirim ringkasan ke WhatsApp
        </a>
        {queued && <span class="label help-body">Tetap bisa tanpa sinyal: WhatsApp mengirim pesan begitu ada sinyal.</span>}
        <div class="summary-box stack-xs">
          <span class="label strong help-head">Isi ringkasan</span>
          <span class="label ink2" style={{ whiteSpace: 'pre-line' }}>
            {summary}
          </span>
        </div>
      </section>

      {report.counted && (
        <section class="card">
          <h2>Dari foto</h2>
          <CountedPhoto c={report.counted} />
          <p>
            <strong>{report.counted.result.count} sidat mati terhitung</strong>
            {report.dead !== report.counted.result.count && `, dicatat ${report.dead} setelah dicek`}.
          </p>
          <span class="label ink2">Dihitung AI. Sidat yang bertumpuk bisa terlewat.</span>
        </section>
      )}

      <section class="card">
        <h2>Kemungkinan penyebab</h2>
        {causes.length === 0 && <p class="ink2">Catatan terakhir belum menunjukkan penyebab yang jelas. Ukur suhu, pH dan TDS sekarang.</p>}
        {causes.map((f, i) => (
          <div class="row top" key={f.id}>
            <span class={`cause-num${i === 0 ? ' first' : ''}`}>{i + 1}</span>
            <div class="stack-xs">
              <span class="strong">{f.title}</span>
              <span class="label ink2">{f.detail}</span>
            </div>
          </div>
        ))}
        <span class="label ink2">Dari catatan kolam dan aturan ambang batas. Ini saran, bukan diagnosis.</span>
      </section>

      <section class="card">
        <div class="row">
          <span class="icon-box">
            <Icon name="clock" />
          </span>
          <div class="stack-xs grow">
            <span class="strong">Cek ulang jam {fmtClock(report.at + 3600_000)}</span>
            <span class="label ink2">Pengingat muncul di Beranda: sidat sudah turun dan berenang normal?</span>
          </div>
        </div>
        <button class="btn primary" onClick={() => go({ name: 'today' })}>
          Selesai, kembali ke Beranda
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
          <img src={failed.url} alt="Foto baskom" style={{ width: 88, height: 66, flex: 'none', borderRadius: 12, objectFit: 'cover', background: '#20252c' }} />
        ) : (
          <span style={{ width: 88, height: 66, flex: 'none', borderRadius: 12, background: '#20252c' }} />
        )}
        <span class="grow stack-xs">
          <span class="h2">AI belum melihat sidat di foto ini</span>
          <span class="label ink2">
            {failed.offline ? 'Foto belum terkirim karena belum ada sinyal. Isi jumlah sendiri, atau foto ulang saat ada sinyal.' : 'Foto terlalu gelap, atau sidat tertutup bayangan.'}
          </span>
        </span>
      </div>
      <ul class="count-tips">
        {TIPS.map((t) => (
          <li key={t.text}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d={t.d} />
            </svg>
            {t.text}
          </li>
        ))}
      </ul>
      <button type="button" class="btn primary" onClick={onRetake}>
        <Icon name="camera" size={20} /> Foto ulang
      </button>
      <button type="button" class="btn secondary" onClick={onManual}>
        Isi jumlah sendiri
      </button>
    </section>
  );
}

const TIPS = [
  { d: 'M3 9h18l-2 9H5zM6 9V7h12v2', text: 'Taruh sidat di baskom putih' },
  { d: 'M12 4v10M8 10l4 4 4-4M5 20h14', text: 'Foto lurus dari atas' },
  { d: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4', text: 'Cari tempat cukup terang, atau nyalakan senter HP' },
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

  // The basin photo → SAM 3.1 count with outlines; the stepper below starts from it.
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
        'Laporan masalah: ' +
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
        <h1>Ada masalah?</h1>
        <p class="ink2">Pilih kolamnya dulu, lalu pilih yang terlihat.</p>
      </section>

      <div class="field">
        <span class="field-label">Kolam mana?</span>
        <PondChooser ponds={ponds} value={pondId} onChange={setPondId} />
      </div>

      <section class="stack-sm">
        <span class="field-label">Pilih yang terlihat</span>
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
            <span>{more ? 'Sembunyikan gejala lain' : `Gejala lain (${hidden})`}</span>
            <Icon name="down" size={20} />
          </button>
        )}
      </section>

      {signs.includes('dead') && (
        <div class={`field${manual ? ' count-manual' : ''}`}>
          <span class="field-label">Berapa ekor mati?</span>
          <Stepper value={dead} onChange={setDead} min={1} quick={[5, 10, 50]} />
          {manual && (
            <span role="status" class="label semi" style={{ color: 'var(--accent-ink)' }}>
              Isi dengan − dan +. Jumlah ini yang dipakai di laporan.
            </span>
          )}
          <input ref={photo} type="file" accept="image/*" capture="environment" hidden onChange={(e) => (onBasinPhoto(e.currentTarget.files?.[0]), (e.currentTarget.value = ''))} />
          {!failed && (
            <>
              <span class="field-hint">Taruh sidat mati di baskom putih, lalu foto dari atas supaya AI bisa menghitung.</span>
              <button type="button" class="btn secondary" disabled={pondId === null || counting} onClick={() => photo.current?.click()}>
                <Icon name="camera" size={20} /> {counting ? 'AI sedang menghitung…' : counted ? 'Foto ulang' : 'Foto baskom untuk dihitung AI'}
              </button>
              {pondId === null && <span class="field-hint">Pilih kolam dulu.</span>}
            </>
          )}
          {counted && (
            <div class="stack-sm">
              <CountedPhoto c={counted} />
              {counted.mock ? (
                <p class="note info">
                  <Icon name="info" size={20} />
                  <span>Mode contoh: hitung otomatis tidak aktif di server ini. Hitung manual.</span>
                </p>
              ) : (
                <>
                  <p>
                    <strong>{counted.result.count} sidat mati terhitung.</strong> Jumlah di atas sudah diisi. Ubah kalau berbeda.
                  </p>
                  {counted.result.review && (
                    <p class="note info">
                      <Icon name="info" size={20} />
                      <span>Sidat bertumpuk atau kurang jelas bisa terlewat. Cek lagi hitungannya.</span>
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

      <span class="label ink2 center">Laporan darurat tidak memakai jatah baca AI.</span>
      {error && <p class="error">{error}</p>}

      {/* Main action: pinned above the tab bar while the page scrolls. */}
      <div class="problem-bar">
        <button class="btn primary" disabled={pondId === null || signs.length === 0 || busy} onClick={submit}>
          {pondId === null ? 'Pilih kolam dulu' : signs.length === 0 ? 'Pilih yang terlihat' : 'Lihat yang harus dilakukan'}
          {pondId !== null && signs.length > 0 && <Icon name="arrow" size={20} />}
        </button>
      </div>
    </div>
  );
}
