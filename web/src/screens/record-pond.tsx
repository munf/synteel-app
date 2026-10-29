import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type Behavior, type Draft, type DraftField, type LogData, type LogSource, type PondSummary } from '../api.ts';
import type { Go } from '../app.tsx';
import { canRecordAudio, prepareImage, prepareVideo, startRecording, voiceToWav, type PreparedImage } from '../capture/media.ts';
import { queue, Retryable, type CaptureKind, type Job } from '../capture/queue.ts';
import { aerationCheckLabel, behaviorLabel, colorLabel, fmtClock, leftoverLabel, phaseLabel, smellLabel } from '../labels.ts';
import { newId, onClips, retryAll } from '../queue.ts';
import { ActionBar, Chips, Field, FindingCard, Icon, PondThumb, StatusPill, Stepper, type IconName } from '../ui.tsx';
import { secondsLeft, sendCapture, type Progress } from '../upload.ts';
import './record.css';

type Leftover = keyof typeof leftoverLabel;
type Color = keyof typeof colorLabel;
type Smell = keyof typeof smellLabel;
type AerationCheck = keyof typeof aerationCheckLabel;
type ReadingField = 'temperature' | 'ph' | 'tds';
type EditKey = ReadingField | 'mortality' | 'behavior' | 'aeration' | 'leftover' | 'color' | 'smell';

// Accept both "27,5" and "27.5": farmers' phones often default to a comma keypad.
export const parseNum = (s: string) => (s.trim() === '' ? undefined : Number(s.replace(',', '.')));
const showNum = (n: number) => String(n).replace('.', ',');

/** Durations in words: "48 detik", "2 menit", "2 menit 10 detik" (never "2:10"). */
export function fmtDur(sec: number) {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} detik`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} menit ${r} detik` : `${m} menit`;
}

const kindWord: Record<CaptureKind, string> = { photo: 'foto', voice: 'suara', video: 'video' };
const READINGS: { key: ReadingField; label: string; placeholder: string; mode: 'decimal' | 'numeric' }[] = [
  { key: 'temperature', label: 'Suhu °C', placeholder: 'contoh: 28,5', mode: 'decimal' },
  { key: 'ph', label: 'pH', placeholder: 'contoh: 7,2', mode: 'decimal' },
  { key: 'tds', label: 'TDS ppm', placeholder: 'contoh: 150', mode: 'numeric' },
];
const METER: Record<ReadingField, string> = { temperature: 'Termometer', ph: 'pH meter', tds: 'TDS meter' };

// ---------- shared by Catat, Catat satu kolam and Cek hasil suara ----------

const MORE = {
  wave: 'M3 12h2M7 8v8M11 5v14M15 8v8M19 11v2',
  copy: 'M8 8h11v11H8zM5 16V5h11',
  question: 'M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01',
  play: 'M7 4.5v15l12-7.5z',
  pause: 'M7 4h3v16H7zM14 4h3v16h-3z',
  retry: 'M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  tap: 'M9 11V5a2 2 0 0 1 4 0v6M13 10a2 2 0 0 1 4 0v1M17 11a2 2 0 0 1 4 0v4a6 6 0 0 1-6 6h-2a6 6 0 0 1-5-3l-3-5a2 2 0 0 1 3-2l2 2',
  fan: 'M12 12c0-3 1-7 4-7s3 4 0 5.5M12 12c3 0 7 1 7 4s-4 3-5.5 0M12 12c0 3-1 7-4 7s-3-4 0-5.5M12 12c-3 0-7-1-7-4s4-3 5.5 0',
  device: 'M8 3h8v18H8zM11 18h2',
  torch: 'M8 3h8v5l-2 3v10h-4V11L8 8zM8 6h8',
} as const;
export type GlyphName = keyof typeof MORE | IconName;

/** Icon, plus a few drawn only on these screens. */
export function Glyph({ name, size = 22, stroke = 2 }: { name: GlyphName; size?: number; stroke?: number }) {
  if (!(name in MORE)) return <Icon name={name as IconName} size={size} stroke={stroke} />;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={MORE[name as keyof typeof MORE]} />
    </svg>
  );
}

/** "2026-10-28" for an instant, on the farm's clock. */
export const localDay = (iso: string, timeZone: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone });
export const recordedToday = (p: PondSummary, today: string, timeZone: string) => !!p.lastLogAt && localDay(p.lastLogAt, timeZone) === today;

const URGENCY: Record<PondSummary['level'], number> = { critical: 0, warning: 1, info: 2, ok: 3 };
/** Not yet recorded today first (longest ago first), then the rest by urgency. */
export function sortForRecording(ponds: PondSummary[], today: string, timeZone: string) {
  const t = (p: PondSummary) => (p.lastLogAt ? Date.parse(p.lastLogAt) : 0);
  return [...ponds].sort((a, b) => {
    const da = recordedToday(a, today, timeZone);
    const db = recordedToday(b, today, timeZone);
    if (da !== db) return da ? 1 : -1;
    return da ? URGENCY[a.level] - URGENCY[b.level] : t(a) - t(b);
  });
}

/** Handed from Catat to Catat satu kolam: a photo or video taken before the pond was chosen, or "type it". */
let handed: { kind: 'photo' | 'video'; file: File } | 'manual' | null = null;
export const handToPond = (h: typeof handed) => {
  handed = h;
};

/** Object URL for a blob, revoked when it changes or the screen closes. */
export function useBlobUrl(blob: Blob | null | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return setUrl(null);
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

// ---------- microphone permission ----------

const ASKED = 'synteel.micAsked';
const wasAsked = () => {
  try {
    return localStorage.getItem(ASKED) === '1';
  } catch {
    return false;
  }
};
const markAsked = () => {
  try {
    localStorage.setItem(ASKED, '1');
  } catch {
    // private mode: the explainer shows again next time, no harm
  }
};

async function micPermission(): Promise<PermissionState | 'unknown'> {
  try {
    return (await navigator.permissions.query({ name: 'microphone' as PermissionName })).state;
  } catch {
    return 'unknown'; // Firefox and older Safari cannot tell before asking
  }
}

export const isDenied = (e: unknown) => e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError');

/** Explain before the phone asks; show the settings steps after a refusal. */
export function useMic() {
  const [panel, setPanel] = useState<null | 'ask' | 'denied'>(null);
  const [granted, setGranted] = useState(false);
  const [error, setError] = useState('');
  return {
    panel,
    granted,
    error,
    /** True when recording may start now; otherwise opens the explainer or the steps. */
    async ready() {
      setError('');
      const s = await micPermission();
      if (s === 'denied') return setPanel('denied'), false;
      if (s !== 'granted' && !wasAsked()) return setPanel('ask'), false;
      return true;
    },
    async allow() {
      markAsked();
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
        setPanel(null);
        setGranted(true);
      } catch (e) {
        setPanel(isDenied(e) ? 'denied' : null);
        if (!isDenied(e)) setError('Mikrofon tidak ditemukan di HP ini. Ketik sendiri dulu.');
      }
    },
    denied: () => setPanel('denied'),
    close: () => setPanel(null),
  };
}

export function MicAsk({ onAllow, onType }: { onAllow: () => void; onType: () => void }) {
  const why: [GlyphName, string][] = [
    ['mic', 'Untuk mendengar nama kolam dan angka yang disebut'],
    ['shield', 'Suara hanya dipakai untuk membaca kondisi kolam, tidak untuk yang lain'],
    ['tap', 'Mikrofon menyala hanya saat Bicara diketuk'],
  ];
  return (
    <section class="card">
      <div class="row" style={{ gap: 16 }}>
        <span class="rp-round-icon">
          <Icon name="mic" size={32} />
        </span>
        <h2>Mencatat dengan suara butuh mikrofon</h2>
      </div>
      <ul class="rp-why">
        {why.map(([icon, text]) => (
          <li key={text}>
            <span class="rp-why-icon">
              <Glyph name={icon} size={20} />
            </span>
            <span style={{ paddingTop: 6 }}>{text}</span>
          </li>
        ))}
      </ul>
      <p class="note info" style={{ color: 'var(--navy)' }}>
        <span>
          Sesudah ini HP akan bertanya. Pilih <strong style={{ whiteSpace: 'nowrap' }}>Saat aplikasi digunakan</strong>.
        </span>
      </p>
      <button type="button" class="btn primary" onClick={onAllow}>
        <Icon name="mic" /> Izinkan mikrofon
      </button>
      <button type="button" class="btn secondary" onClick={onType}>
        <Icon name="pencil" /> Ketik sendiri
      </button>
    </section>
  );
}

/** Mini settings rows: how the phone's own screens look, with the one to tap marked. */
function SettingsRow({ label, on, value, bad, app, radio }: { label: string; on?: boolean; value?: string; bad?: boolean; app?: string; radio?: boolean }) {
  return (
    <div class={`rp-set-row${on ? ' on' : ''}`}>
      {app && <span class={`rp-set-app${on ? '' : ' grey'}`}>{app}</span>}
      {radio && <span class={`rp-set-radio${on ? ' on' : ''}`}>{on && <Icon name="check" size={12} stroke={3} />}</span>}
      <span class="grow stack-xs" style={{ gap: 0, lineHeight: 1.3 }}>
        <span class="label" style={{ fontWeight: on ? 800 : 600 }}>
          {label}
        </span>
        {value && (
          <span class="label" style={{ color: bad ? 'var(--bad)' : 'var(--muted)' }}>
            {value}
          </span>
        )}
      </span>
      {on && <span class="rp-set-tap">ketuk</span>}
    </div>
  );
}

export function MicDenied({ onRetry, onType }: { onRetry: () => void; onType: () => void }) {
  const steps = [
    { title: 'Buka Setelan › Aplikasi › Synteel', rows: [<SettingsRow key="k" label="Kalkulator" app="K" />, <SettingsRow key="s" label="Synteel" app="S" on />] },
    {
      title: 'Pilih Izin › Mikrofon',
      rows: [<SettingsRow key="c" label="Kamera" value="Diizinkan" />, <SettingsRow key="m" label="Mikrofon" value="Tidak diizinkan" bad on />],
    },
    {
      title: 'Pilih Izinkan',
      rows: [
        <SettingsRow key="a" label="Izinkan hanya saat aplikasi digunakan" radio on />,
        <SettingsRow key="t" label="Tanyakan setiap saat" radio />,
        <SettingsRow key="n" label="Jangan izinkan" radio />,
      ],
    },
  ];
  return (
    <section class="card rp-warn-card">
      <div class="stack-sm">
        <div class="row">
          <span class="icon-box rp-warn-box">
            <Icon name="mic" />
          </span>
          <h2 class="grow">HP belum mengizinkan Synteel memakai mikrofon</h2>
        </div>
        <span class="label ink2">Tanpa mikrofon, catatan suara tidak bisa didengar. Sekitar 1 menit di setelan HP.</span>
      </div>
      <ol class="rp-steps">
        {steps.map((s, i) => (
          <li key={s.title}>
            <span class="rp-step-n">{i + 1}</span>
            <div class="grow stack-sm">
              <span class="strong" style={{ paddingTop: 3 }}>
                {s.title}
              </span>
              <div class="rp-set" aria-hidden="true">
                {s.rows}
              </div>
            </div>
          </li>
        ))}
      </ol>
      <p class="meta">Nama menu bisa sedikit beda di tiap merek HP.</p>
      <button type="button" class="btn primary" onClick={onRetry}>
        <Glyph name="retry" /> Sudah diizinkan, coba lagi
      </button>
      <button type="button" class="btn secondary" onClick={onType}>
        <Icon name="pencil" /> Ketik sendiri
      </button>
    </section>
  );
}

export const MicGranted = () => (
  <div class="note ok" role="status" style={{ alignItems: 'center' }}>
    <Icon name="check" />
    <span style={{ fontSize: '1rem' }}>Mikrofon diizinkan. Ketuk Bicara untuk mulai.</span>
  </div>
);

// ---------- slow upload ----------

/** Re-render every half second while something runs (upload progress, recording clock). */
export function useTick(on: boolean) {
  const [, setT] = useState(0);
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setT((t) => t + 1), 500);
    return () => clearInterval(timer);
  }, [on]);
}

/** Shown only when sending takes longer than a few seconds: weak signal. */
export const isSlow = (p: Progress | null) => !!p && p.sent < p.total && Date.now() - p.started > 2500;

export function UploadCard({ what, p, thumb, onOther }: { what: string; p: Progress; thumb?: Blob; onOther?: () => void }) {
  const pct = Math.min(99, Math.round((p.sent / Math.max(1, p.total)) * 100));
  const left = secondsLeft(p);
  const url = useBlobUrl(thumb);
  return (
    <section class="card">
      <div class="row">
        <span class="rp-shot">
          {url ? (
            <img src={url} alt="" />
          ) : (
            <span class="rp-shot-icon">
              <Glyph name={what === 'video' ? 'video' : 'wave'} />
            </span>
          )}
        </span>
        <span class="grow stack-xs">
          <span class="strong num">
            Mengirim {what} · {pct}%
          </span>
          <span class="label ink2">Sinyal lemah, jadi lebih lama dari biasa.</span>
        </span>
      </div>
      <div class="rp-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${what} terkirim`}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <div class="row between label muted num">
        <span>Sinyal lemah, agak lama</span>
        {left !== null && <span style={{ whiteSpace: 'nowrap' }}>{left < 60 ? 'kurang dari 1 menit lagi' : `perkiraan ${Math.round(left / 60)} menit lagi`}</span>}
      </div>
      <p class="note ok">
        <Icon name="check" size={20} />
        <span>Boleh tutup aplikasi, {what} tetap terkirim. Hasilnya muncul untuk dicek setelah terbaca.</span>
      </p>
      {onOther && (
        <button type="button" class="btn primary" onClick={onOther}>
          Catat kolam lain
        </button>
      )}
    </section>
  );
}

// ---------- video brightness ----------

/** Mean brightness (0–255) of a few frames on a tiny copy: a night video shows no eels. */
async function brightness(frames: Blob[]): Promise<number | null> {
  const pick = frames.filter((_, i) => i % Math.max(1, Math.floor(frames.length / 4)) === 0).slice(0, 4);
  let sum = 0;
  let n = 0;
  for (const f of pick) {
    try {
      const bmp = await createImageBitmap(f);
      const c = document.createElement('canvas');
      c.width = 32;
      c.height = 32;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(bmp, 0, 0, 32, 32);
      const d = ctx.getImageData(0, 0, 32, 32).data;
      for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      n += d.length / 4;
    } catch {
      // a frame the browser cannot decode: skip it
    }
  }
  return n ? sum / n : null;
}
const DARK = 45;

// ---------- the screen ----------

export function RecordPond({ ponds, pondId, onSaved, go }: { ponds: PondSummary[]; pondId: number; onSaved: () => void; go: Go }) {
  const pond = ponds.find((p) => p.id === pondId);
  const [readings, setReadings] = useState<Record<ReadingField, string>>({ temperature: '', ph: '', tds: '' });
  const [mortality, setMortality] = useState(0);
  const [leftover, setLeftover] = useState<Leftover[]>([]);
  const [behavior, setBehavior] = useState<Behavior[]>([]);
  const [color, setColor] = useState<Color[]>([]);
  const [smell, setSmell] = useState<Smell[]>([]);
  const [aeration, setAeration] = useState<AerationCheck[]>([]);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PondSummary | null>(null);

  // What the AI filled in, so the farmer can see it and check it before saving.
  const [aiMode, setAiMode] = useState<'meta' | 'mock' | 'off' | null>(null);
  const [filled, setFilled] = useState<Partial<Record<DraftField, CaptureKind>>>({});
  const [doubtful, setDoubtful] = useState<DraftField[]>([]);
  const [transcript, setTranscript] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [source, setSource] = useState<LogSource>('manual');
  const [working, setWorking] = useState('');
  const [notice, setNotice] = useState('');
  const [photoCheck, setPhotoCheck] = useState<{ image: PreparedImage; field?: ReadingField; typing: boolean } | null>(null);
  const [darkVideo, setDarkVideo] = useState<{ seconds: number; at: number; frame?: Blob } | null>(null);
  const [upload, setUpload] = useState<{ what: string; p: Progress; thumb?: Blob } | null>(null);
  const [recording, setRecording] = useState<{ stop: () => Promise<Blob>; started: number } | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [editing, setEditing] = useState<EditKey | null>(null);
  const [manual, setManual] = useState(false);
  /** In the review state the capture buttons fold behind "Rekam ulang". */
  const [redo, setRedo] = useState(false);
  const mic = useMic();

  const photoInput = useRef<HTMLInputElement>(null);
  const photoField = useRef<ReadingField | undefined>(undefined);
  const videoInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);

  useTick(!!recording || !!upload);
  const elapsed = recording ? Math.round((Date.now() - recording.started) / 1000) : 0;

  const refreshJobs = () => queue.list().then((all) => mounted.current && setJobs(all.filter((j) => j.pondId === pondId)), () => setJobs([]));

  useEffect(() => {
    mounted.current = true;
    api.aiMode().then((r) => setAiMode(r.mode), () => setAiMode(null));
    refreshJobs();
    retryAll();
    // From Catat: a photo or video taken before the pond was chosen, or "type it".
    const h = handed;
    handed = null;
    if (h === 'manual') setManual(true);
    else if (h?.kind === 'photo') onPhoto(h.file);
    else if (h?.kind === 'video') onVideo(h.file);
    const off = onClips(refreshJobs);
    return () => {
      mounted.current = false;
      off();
    };
  }, []);

  const reset = () => {
    setReadings({ temperature: '', ph: '', tds: '' });
    setMortality(0);
    setLeftover([]);
    setBehavior([]);
    setColor([]);
    setSmell([]);
    setAeration([]);
    setNote('');
    setFilled({});
    setDoubtful([]);
    setTranscript('');
    setProblems([]);
    setSource('manual');
    setNotice('');
    setEditing(null);
    setManual(false);
    setRedo(false);
    setPhotoCheck(null);
    setDarkVideo(null);
  };

  function applyDraft(draft: Draft, kind: CaptureKind) {
    const d = draft.data;
    const got: Partial<Record<DraftField, CaptureKind>> = {};
    const next = { ...readings };
    for (const key of ['temperature', 'ph', 'tds'] as ReadingField[]) {
      const v = d.readings?.[key];
      if (v !== undefined) {
        next[key] = showNum(v);
        got[key] = kind;
      }
    }
    setReadings(next);
    if (d.mortality) (setMortality(d.mortality), (got.mortality = kind));
    if (d.feeding?.leftover) (setLeftover([d.feeding.leftover]), (got.leftover = kind));
    if (d.behavior?.length) (setBehavior(d.behavior), (got.behavior = kind));
    if (d.water?.color) (setColor([d.water.color]), (got.color = kind));
    if (d.water?.smell) (setSmell([d.water.smell]), (got.smell = kind));
    if (d.aeration) (setAeration([d.aeration]), (got.aeration = kind));
    if (d.note) setNote((n) => (n ? `${n}; ${d.note}` : d.note!));
    setFilled((f) => ({ ...f, ...got }));
    setDoubtful(draft.lowConfidence);
    setTranscript(draft.transcript ?? '');
    setProblems(draft.problems);
    setSource(kind);
    setRedo(false);
    if (Object.keys(got).length === 0) setNotice('AI tidak menemukan angka atau keterangan. Coba lagi, atau ketik sendiri.');
  }

  /** Kept on the phone first, so closing the app mid-upload loses nothing. */
  async function send(job: Omit<Job, 'id' | 'createdAt' | 'status' | 'pondId' | 'pondName'>, thumb?: Blob) {
    const full: Job = { ...job, pondId, pondName: pond?.name ?? '', id: newId(), createdAt: Date.now(), status: 'pending' };
    setError('');
    setNotice('');
    setWorking(`AI membaca ${kindWord[job.kind]}…`);
    await queue.put(full).catch(() => {});
    try {
      const done = await sendCapture(full, (p) => mounted.current && setUpload({ what: job.kind === 'video' ? 'video' : job.kind === 'photo' ? 'foto' : 'rekaman', p, thumb }));
      if (!mounted.current) {
        // The farmer moved on: the result waits in "Rekaman di HP".
        await queue.put(done).catch(() => {});
        return;
      }
      await queue.remove(full.id).catch(() => {});
      if (done.status === 'ready') applyDraft(done.draft!, done.kind);
      else setError(done.error ?? 'Gagal membaca');
    } catch (err) {
      if (!(err instanceof Retryable)) {
        setError((err as Error).message);
        await queue.remove(full.id).catch(() => {});
        return;
      }
      setNotice(`${err.message}. Rekaman disimpan di HP dan dibaca otomatis nanti.`);
    } finally {
      if (mounted.current) {
        setWorking('');
        setUpload(null);
        refreshJobs();
      }
    }
  }

  async function onPhoto(file: File | undefined) {
    if (!file || !pond) return;
    setWorking('Memeriksa foto…');
    setPhotoCheck(null);
    try {
      const image = await prepareImage(file);
      if (image.issues.length) setPhotoCheck({ image, field: photoField.current, typing: false });
      else await send({ kind: 'photo', field: photoField.current, images: [image.blob] }, image.blob);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWorking((w) => (w === 'Memeriksa foto…' ? '' : w));
    }
  }

  async function onVideo(file: File | undefined) {
    if (!file || !pond) return;
    setWorking('Mengambil gambar dan suara dari video…');
    setDarkVideo(null);
    try {
      const { frames, audio, seconds } = await prepareVideo(file);
      const light = await brightness(frames);
      const dark = light !== null && light < DARK;
      // A dark video shows no eels: send only the narration, a fraction of the data.
      if (dark) setDarkVideo({ seconds, at: Date.now(), frame: frames[0] });
      await send({ kind: 'video', images: dark && audio ? [] : frames, audio }, frames[0]);
    } catch (err) {
      setError((err as Error).message);
      setWorking('');
    }
  }

  async function toggleVoice() {
    if (!pond) return;
    if (recording) {
      recording.stop();
      return;
    }
    if (!canRecordAudio()) return audioInput.current?.click();
    if (!(await mic.ready())) return;
    try {
      const rec = await startRecording(60);
      setRecording({ stop: rec.stop, started: Date.now() });
      // One place sends the note, whether the farmer tapped stop or 60 s ran out.
      rec.finished.then((audio) => {
        setRecording(null);
        if (audio.size > 0) voiceToWav(audio).then((wav) => send({ kind: 'voice', images: [], audio: wav }));
      });
    } catch (e) {
      if (isDenied(e)) mic.denied();
      else setError('Mikrofon tidak bisa dipakai di HP ini. Ketik sendiri dulu.');
    }
  }

  const takePhoto = (field?: ReadingField) => {
    photoField.current = field;
    photoInput.current?.click();
  };

  async function useJob(job: Job) {
    applyDraft(job.draft!, job.kind);
    await queue.remove(job.id);
    refreshJobs();
  }

  const submit = async (e: Event) => {
    e.preventDefault();
    setError('');
    const values = Object.fromEntries(READINGS.map((r) => [r.key, parseNum(readings[r.key])]));
    if (Object.values(values).some((v) => v !== undefined && Number.isNaN(v))) {
      setError('Angka pengukuran tidak valid');
      return;
    }
    const data: LogData = {
      readings: Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)),
      mortality: mortality || undefined,
      feeding: leftover[0] ? { leftover: leftover[0] } : undefined,
      behavior: behavior.length ? behavior : undefined,
      water: color[0] || smell[0] ? { color: color[0], smell: smell[0] } : undefined,
      aeration: aeration[0],
      note: note || undefined,
    };
    setBusy(true);
    try {
      const { pond } = await api.addLog(pondId, data, source);
      setResult(pond);
      reset();
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const showValue = (key: EditKey): string | null => {
    switch (key) {
      case 'temperature':
        return readings.temperature ? `${readings.temperature} °C` : null;
      case 'ph':
        return readings.ph || null;
      case 'tds':
        return readings.tds ? `${readings.tds} ppm` : null;
      case 'mortality':
        return mortality ? `${mortality} ekor` : null;
      case 'behavior':
        return behavior.length ? behavior.map((b) => behaviorLabel[b]).join(', ') : null;
      case 'aeration':
        return aeration[0] ? aerationCheckLabel[aeration[0]] : null;
      case 'leftover':
        return leftover[0] ? leftoverLabel[leftover[0]] : null;
      case 'color':
        return color[0] ? colorLabel[color[0]] : null;
      case 'smell':
        return smell[0] ? smellLabel[smell[0]] : null;
    }
  };

  const LABELS: Record<EditKey, string> = {
    temperature: 'Suhu air',
    ph: 'pH',
    tds: 'TDS',
    mortality: 'Sidat mati',
    behavior: 'Perilaku sidat',
    aeration: 'Aerator',
    leftover: 'Sisa pakan',
    color: 'Warna air',
    smell: 'Bau air',
  };

  const readingInput = (key: ReadingField, extra?: { autoFocus?: boolean }) => {
    const r = READINGS.find((x) => x.key === key)!;
    return (
      <input
        class="input grow"
        aria-label={r.label}
        inputMode={r.mode}
        value={readings[key]}
        autoFocus={extra?.autoFocus}
        onInput={(e) => setReadings({ ...readings, [key]: e.currentTarget.value })}
        placeholder={r.placeholder}
      />
    );
  };

  /** The control for one value: the same in the AI review and in the full form. */
  const editor = (key: EditKey) => {
    switch (key) {
      case 'temperature':
      case 'ph':
      case 'tds': {
        const r = READINGS.find((x) => x.key === key)!;
        return (
          <div class="row">
            {readingInput(key)}
            <button type="button" class="rp-cam" aria-label={`Foto alat ukur ${r.label}`} onClick={() => takePhoto(key)} disabled={!!working || !!recording}>
              <Icon name="camera" />
            </button>
          </div>
        );
      }
      case 'mortality':
        return <Stepper value={mortality} onChange={setMortality} quick={[5, 10, 50]} />;
      case 'behavior':
        return <Chips options={behaviorLabel} value={behavior} onChange={setBehavior} multiple />;
      case 'aeration':
        return <Chips options={aerationCheckLabel} value={aeration} onChange={setAeration} />;
      case 'leftover':
        return <Chips options={leftoverLabel} value={leftover} onChange={setLeftover} />;
      case 'color':
        return <Chips options={colorLabel} value={color} onChange={setColor} />;
      case 'smell':
        return <Chips options={smellLabel} value={smell} onChange={setSmell} />;
    }
  };

  if (!pond)
    return (
      <div class="screen">
        <p class="muted">Kolam tidak ditemukan.</p>
        <button class="btn secondary" onClick={() => go({ name: 'record' })}>
          Kembali ke daftar kolam
        </button>
      </div>
    );

  if (result) {
    return (
      <div class="screen">
        <div class="note ok">
          <Icon name="check" />
          <span style={{ fontSize: '1rem' }}>Catatan {result.name} tersimpan.</span>
        </div>
        <div class="row between">
          <h1>{result.name}</h1>
          <StatusPill level={result.level} />
        </div>
        {result.findings.length === 0 ? (
          <p class="ink2">Tidak ada peringatan. Kolam aman berdasarkan catatan ini.</p>
        ) : (
          result.findings.map((f) => <FindingCard key={f.id} finding={f} />)
        )}
        <button class="btn primary" onClick={() => setResult(null)}>
          Catat lagi
        </button>
      </div>
    );
  }

  const ready = jobs.filter((j) => j.status === 'ready');
  const waiting = jobs.filter((j) => j.status === 'pending');
  const reviewing = source !== 'manual';
  const draftKeys = (Object.keys(LABELS) as EditKey[]).filter((k) => k === 'temperature' || k === 'ph' || k === 'tds' || filled[k]);
  const blocked = !!working || !!recording;
  const typeInstead = () => (mic.close(), setManual(true));
  const folded = reviewing && !manual && !redo && !recording;
  const glare = photoCheck?.image.issues.some((i) => i.includes('silau'));
  const target = photoCheck?.field ? pond.limits[photoCheck.field]?.target : null;

  return (
    <form class="screen" onSubmit={submit}>
      <header class="row">
        <button type="button" class="icon-btn" aria-label="Kembali ke daftar kolam" onClick={() => go({ name: 'record' })}>
          <Icon name="back" />
        </button>
        <PondThumb kind={pond.kind} size={48} />
        <div class="grow" style={{ display: 'flex', flexDirection: 'column' }}>
          <h1>Catat {pond.name}</h1>
          <span class="label ink2">
            {pond.batch && pond.program
              ? [
                  `${phaseLabel[pond.batch.phase]} · minggu ${pond.program.week}`,
                  pond.program.estimatedAlive !== null ? `sekitar ${pond.program.estimatedAlive.toLocaleString('id-ID')} ekor` : '',
                ]
                  .filter(Boolean)
                  .join(' · ')
              : 'Belum ada batch'}
          </span>
          <button type="button" class="link-btn label row" style={{ alignSelf: 'flex-start', gap: 4, fontWeight: 800 }} onClick={() => go({ name: 'pond', id: pond.id })}>
            Detail kolam <Icon name="next" size={16} stroke={2.5} />
          </button>
        </div>
      </header>

      {aiMode === 'mock' && (
        <p class="note info">
          <Icon name="info" />
          <span>Mode contoh: hasil foto dan suara adalah contoh, bukan bacaan AI sungguhan.</span>
        </p>
      )}
      {aiMode === 'off' && (
        <p class="note info">
          <Icon name="info" />
          <span>AI belum aktif. Rekaman disimpan di HP dan dibaca setelah AI aktif. Ketik sendiri tetap bisa.</span>
        </p>
      )}
      {mic.granted && !recording && <MicGranted />}
      {mic.error && <p class="error">{mic.error}</p>}

      {folded && (
        <button type="button" class="go-row" style={{ color: 'var(--ink)', paddingLeft: 16 }} onClick={() => setRedo(true)}>
          <Icon name="mic" />
          <span class="grow" style={{ display: 'flex', flexDirection: 'column' }}>
            <span class="strong">Rekam ulang</span>
            <span class="label ink2" style={{ fontWeight: 400 }}>
              Bicara, foto alat ukur atau video
            </span>
          </span>
          <Icon name="down" size={20} />
        </button>
      )}

      {folded ? null : mic.panel === 'ask' ? (
        <MicAsk onAllow={mic.allow} onType={typeInstead} />
      ) : mic.panel === 'denied' ? (
        <MicDenied onRetry={mic.allow} onType={typeInstead} />
      ) : (
        <button type="button" class={`talk${recording ? ' rec' : ''}`} onClick={toggleVoice} disabled={!!working && !recording}>
          <span class="mic">
            <Icon name="mic" size={32} />
          </span>
          <span class="stack-xs">
            <span class="title">{recording ? `Selesai · ${fmtDur(elapsed)}` : 'Bicara'}</span>
            <span class="label" style={{ color: '#E4EAF5' }}>
              {recording ? `Merekam ${pond.name}. Ketuk untuk selesai, paling lama 60 detik.` : 'Sebutkan suhu, pH, TDS, sidat mati, sisa pakan dan aerator.'}
            </span>
          </span>
        </button>
      )}

      {!folded && (
      <div class="grid2">
        <button type="button" class="capture-tile" onClick={() => takePhoto()} disabled={blocked}>
          <span class="icon-box">
            <Icon name="camera" />
          </span>
          <span class="stack-xs">
            <span class="strong">Foto alat ukur</span>
            <span class="meta">pH, TDS, termometer</span>
          </span>
        </button>
        <button type="button" class="capture-tile" onClick={() => videoInput.current?.click()} disabled={blocked}>
          <span class="icon-box">
            <Icon name="video" />
          </span>
          <span class="stack-xs">
            <span class="strong">Video harian</span>
            <span class="meta">Keliling kolam sambil cerita</span>
          </span>
        </button>
      </div>

      )}

      {!folded && (
        <div class="note info">
          <Icon name="wifi" />
          <span>Tidak ada sinyal? Rekaman disimpan di HP dan dibaca otomatis saat ada sinyal.</span>
        </div>
      )}

      {upload && isSlow(upload.p) ? (
        <UploadCard what={upload.what} p={upload.p} thumb={upload.thumb} onOther={() => go({ name: 'record' })} />
      ) : (
        working && (
          <p class="working" role="status">
            {working}
          </p>
        )
      )}
      {notice && (
        <p class="note info">
          <Icon name="info" />
          <span>{notice}</span>
        </p>
      )}

      <input ref={photoInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => (onPhoto(e.currentTarget.files?.[0]), (e.currentTarget.value = ''))} />
      <input ref={videoInput} type="file" accept="video/*" capture="environment" hidden onChange={(e) => (onVideo(e.currentTarget.files?.[0]), (e.currentTarget.value = ''))} />
      <input
        ref={audioInput}
        type="file"
        accept="audio/*"
        capture="user"
        hidden
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (f) voiceToWav(f).then((wav) => send({ kind: 'voice', images: [], audio: wav }));
        }}
      />

      {photoCheck && (
        <PhotoTrouble
          image={photoCheck.image.blob}
          field={photoCheck.field}
          glare={!!glare}
          typing={photoCheck.typing}
          onRetake={() => {
            const f = photoCheck.field;
            setPhotoCheck(null);
            takePhoto(f);
          }}
          onType={() => (photoCheck.field ? setPhotoCheck({ ...photoCheck, typing: true }) : (setPhotoCheck(null), setManual(true)))}
          onSendAnyway={() => {
            const { image, field } = photoCheck;
            setPhotoCheck(null);
            send({ kind: 'photo', field, images: [image.blob] }, image.blob);
          }}
        >
          {photoCheck.field && (
            <>
              <label class="field">
                <span class="field-label">{READINGS.find((r) => r.key === photoCheck.field)!.label.replace(/ (°C|ppm)$/, '')}</span>
                {readingInput(photoCheck.field, { autoFocus: true })}
                <span class="field-hint">
                  {target && target.min !== undefined && target.max !== undefined ? `Target ${showNum(target.min)}–${showNum(target.max)}. ` : ''}
                  {photoCheck.field === 'tds' ? 'contoh: 150.' : `Pakai koma, contoh: ${photoCheck.field === 'ph' ? '7,4' : '28,5'}.`}
                </span>
              </label>
              <button class="btn primary" disabled={busy || !readings[photoCheck.field]}>
                <Icon name="check" size={20} stroke={2.4} /> Simpan catatan
              </button>
            </>
          )}
        </PhotoTrouble>
      )}

      {darkVideo && (
        <DarkVideo
          {...darkVideo}
          heard={!working && (!!transcript || source === 'video')}
          busy={!!working}
          onCheck={() => setDarkVideo(null)}
          onRetake={() => {
            setDarkVideo(null);
            videoInput.current?.click();
          }}
        />
      )}

      {(ready.length > 0 || waiting.length > 0) && (
        <section class="card" style={{ gap: 8 }}>
          <h2>Rekaman di HP</h2>
          {ready.map((j) => (
            <div class="row between" key={j.id}>
              <span>
                {kindWord[j.kind][0].toUpperCase() + kindWord[j.kind].slice(1)} · {fmtClock(j.createdAt, true)}
              </span>
              <button type="button" class="btn secondary" style={{ minHeight: 44 }} onClick={() => useJob(j)}>
                Pakai
              </button>
            </div>
          ))}
          {waiting.length > 0 && <p class="meta">{waiting.length} rekaman menunggu sinyal atau AI aktif.</p>}
        </section>
      )}

      {reviewing && !manual && (
        <section class="card">
          <div class="row top between">
            <div class="stack-xs">
              <h2>Cek sebelum simpan</h2>
              <span class="meta">{pond.name}</span>
            </div>
            <span class="pill blue">dari {kindWord[source as CaptureKind]}</span>
          </div>
          {transcript && <p class="quote">“{transcript}”</p>}
          {problems.map((p) => (
            <p key={p} class="note info">
              <Icon name="info" />
              <span>{p}</span>
            </p>
          ))}
          <span class="label ink2">Ada yang salah? Ketuk barisnya.</span>
          <div class="stack-sm">
            {draftKeys.map((k) =>
              editing === k ? (
                <div class="draft-edit" key={k} style={{ border: '2px solid var(--ink)', borderRadius: 16, padding: '12px 16px' }}>
                  <span class="strong">{LABELS[k]}</span>
                  {editor(k)}
                  <button type="button" class="btn blue" onClick={() => setEditing(null)}>
                    Selesai
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  class="draft-row"
                  key={k}
                  aria-label={`Ubah ${LABELS[k]}`}
                  onClick={() => setEditing(k)}
                  style={{ border: '2px solid var(--line-2)', borderRadius: 16, background: 'var(--surface)', padding: '0 16px', color: 'var(--ink)' }}
                >
                  <span class="ink2">{LABELS[k]}</span>
                  <span class="row" style={{ gap: 8 }}>
                    {doubtful.includes(k) && (
                      <span class="pill blue" style={{ gap: 6, color: 'var(--ink)' }}>
                        <Icon name="info" size={16} />
                        cek lagi
                      </span>
                    )}
                    <span class="strong num">{showValue(k) ?? '–'}</span>
                    <span style={{ display: 'inline-flex', color: 'var(--ink)' }}>
                      <Icon name="pencil" size={18} />
                    </span>
                  </span>
                </button>
              ),
            )}
          </div>
          <button type="button" class="btn secondary" onClick={() => (setManual(true), setEditing(null))}>
            <Icon name="pencil" size={20} /> Ketik sendiri
          </button>
        </section>
      )}

      {(!reviewing || manual) && (
        <details class="card more" open={manual} onToggle={(e) => setManual(e.currentTarget.open)}>
          <summary>
            <span class="row">
              <span class="icon-box">
                <Icon name="pencil" />
              </span>
              <span class="stack-xs">
                <span class="strong">Ketik sendiri</span>
                <span class="meta">Isi angka dan keadaan kolam satu per satu</span>
              </span>
            </span>
            <Icon name="down" />
          </summary>
          <div class="stack" style={{ marginTop: 16 }}>
            {(Object.keys(LABELS) as EditKey[]).map((k) => (
              <div class="field" key={k}>
                <span class="field-label">
                  {LABELS[k]}
                  {k === 'tds' ? ' (ppm)' : k === 'temperature' ? ' (°C)' : k === 'mortality' ? ' (ekor)' : ''}
                </span>
                {editor(k)}
              </div>
            ))}
            <Field label="Catatan">
              <textarea rows={2} value={note} onInput={(e) => setNote(e.currentTarget.value)} placeholder="contoh: habis hujan deras" />
            </Field>
          </div>
        </details>
      )}

      {(reviewing || manual) && (
        <ActionBar>
          {error && <p class="error">{error}</p>}
          <button class="btn primary" disabled={busy || !!working}>
            <Icon name="check" size={20} stroke={2.4} /> Simpan catatan
          </button>
        </ActionBar>
      )}
    </form>
  );
}

/** A meter photo the AI would likely misread: glare or blur (Gangguan 10). */
function PhotoTrouble(props: {
  image: Blob;
  field?: ReadingField;
  glare: boolean;
  typing: boolean;
  onRetake: () => void;
  onType: () => void;
  onSendAnyway: () => void;
  children?: ComponentChildren;
}) {
  const url = useBlobUrl(props.image);
  return (
    <section class="card">
      <div class="row between">
        <h2>Foto alat ukur</h2>
        {props.field && <span class="pill blue">{METER[props.field]}</span>}
      </div>
      <div class="row top">
        <span class="rp-shot">{url && <img src={url} alt="Foto alat ukur" />}</span>
        <span class="grow stack-xs">
          <span class="strong">Angka di layar alat belum terbaca ({props.glare ? 'silau' : 'buram'})</span>
          <span class="label ink2">{props.glare ? 'Ada pantulan cahaya di layar alat.' : 'Foto tampak buram, angka tidak tajam.'}</span>
        </span>
      </div>
      <p class="note info">
        <Glyph name="device" size={20} />
        <span>{props.glare ? 'Miringkan HP sedikit dan jauhi lampu, sampai pantulan putih hilang dari layar alat.' : 'Pegang HP diam sebentar dan dekatkan sampai angka di layar alat tajam.'}</span>
      </p>
      <button type="button" class="btn primary" onClick={props.onRetake}>
        <Icon name="camera" /> Foto ulang
      </button>
      {props.typing ? (
        props.children
      ) : (
        <button type="button" class="btn secondary" onClick={props.onType}>
          <Icon name="pencil" /> Ketik angkanya
        </button>
      )}
      {!props.typing && (
        <button type="button" class="rp-text-btn" onClick={props.onSendAnyway}>
          Tetap kirim foto ini
        </button>
      )}
    </section>
  );
}

/** A video too dark to see the eels: the narration is still read (Gangguan 11). */
function DarkVideo(props: { seconds: number; at: number; frame?: Blob; heard: boolean; busy: boolean; onCheck: () => void; onRetake: () => void }) {
  const url = useBlobUrl(props.frame);
  const len = `rekaman ${fmtDur(props.seconds)}`;
  return (
    <section class="card">
      <div class="row between">
        <h2>Video harian</h2>
        <span class="pill blue num">
          {len} · {fmtClock(props.at)}
        </span>
      </div>
      <div class="row top">
        <span class="rp-shot dark">{url && <img src={url} alt="" />}</span>
        <span class="grow stack-xs">
          <span class="strong">Video terlalu gelap untuk melihat sidat</span>
          <span class="label ink2">{props.busy ? 'Suara tetap dibaca…' : props.heard ? 'Suara tetap dibaca.' : 'Suara juga belum terbaca.'}</span>
        </span>
      </div>
      <p class="note info">
        <Glyph name="torch" size={20} />
        <span>Malam hari, nyalakan senter HP saat merekam supaya sidat terlihat.</span>
      </p>
      {!props.busy && props.heard && (
        <button type="button" class="btn primary" onClick={props.onCheck}>
          Cek hasil dari suara <Icon name="arrow" />
        </button>
      )}
      <button type="button" class="btn secondary" onClick={props.onRetake}>
        <Icon name="video" /> Rekam ulang dengan senter
      </button>
    </section>
  );
}
