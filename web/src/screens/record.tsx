import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type Behavior, type Draft, type DraftField, type LogData, type LogSource, type PondSummary } from '../api.ts';
import { canRecordAudio, prepareImage, prepareVideo, startRecording, type PreparedImage } from '../capture/media.ts';
import { process, queue, Retryable, type CaptureKind, type Job } from '../capture/queue.ts';
import { aerationCheckLabel, behaviorLabel, colorLabel, fmtClock, leftoverLabel, smellLabel } from '../labels.ts';
import { Chips, Field, FindingCard, IconCamera, IconMic, IconVideo, LevelBadge } from '../ui.tsx';

type Leftover = keyof typeof leftoverLabel;
type Color = keyof typeof colorLabel;
type Smell = keyof typeof smellLabel;
type AerationCheck = keyof typeof aerationCheckLabel;
type ReadingField = 'temperature' | 'ph' | 'tds';

// Accept both "27,5" and "27.5": farmers' phones often default to a comma keypad.
const parseNum = (s: string) => (s.trim() === '' ? undefined : Number(s.replace(',', '.')));
const showNum = (n: number) => String(n).replace('.', ',');

let retrying = false;

const kindLabel: Record<CaptureKind, string> = { photo: 'foto', voice: 'suara', video: 'video' };
const READINGS: { key: ReadingField; label: string; placeholder: string; mode: 'decimal' | 'numeric' }[] = [
  { key: 'temperature', label: 'Suhu °C', placeholder: '28,5', mode: 'decimal' },
  { key: 'ph', label: 'pH', placeholder: '7,2', mode: 'decimal' },
  { key: 'tds', label: 'TDS ppm', placeholder: '150', mode: 'numeric' },
];

export function Record({ ponds, initialPondId, onSaved }: { ponds: PondSummary[]; initialPondId?: number; onSaved: () => void }) {
  const [pondId, setPondId] = useState<string[]>(initialPondId ? [String(initialPondId)] : ponds[0] ? [String(ponds[0].id)] : []);
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
  const [photoCheck, setPhotoCheck] = useState<{ image: PreparedImage; field?: ReadingField } | null>(null);
  const [recording, setRecording] = useState<{ stop: () => Promise<Blob>; started: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [jobs, setJobs] = useState<Job[]>([]);

  const photoInput = useRef<HTMLInputElement>(null);
  const photoField = useRef<ReadingField | undefined>(undefined);
  const videoInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);

  const pond = ponds.find((p) => String(p.id) === pondId[0]);

  const refreshJobs = () => queue.list().then(setJobs, () => setJobs([]));

  // Retry what is waiting on this phone whenever the app opens or signal returns.
  useEffect(() => {
    api.aiMode().then((r) => setAiMode(r.mode), () => setAiMode(null));
    const retry = async () => {
      if (retrying) return; // the browser and the app can both signal "online"
      retrying = true;
      try {
        for (const job of (await queue.list().catch(() => [])).filter((j) => j.status === 'pending')) {
          try {
            await queue.put(await process(job));
          } catch (err) {
            if (!(err instanceof Retryable)) throw err;
            break; // still offline: try again later
          }
        }
      } finally {
        retrying = false;
        refreshJobs();
      }
    };
    retry();
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, []);

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - recording.started) / 1000)), 500);
    return () => clearInterval(timer);
  }, [recording]);

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
    if (Object.keys(got).length === 0) setNotice('AI tidak menemukan angka atau keterangan. Coba lagi, atau isi manual.');
  }

  async function send(job: Omit<Job, 'id' | 'createdAt' | 'status'>) {
    const full: Job = { ...job, id: crypto.randomUUID?.() ?? String(Date.now()), createdAt: Date.now(), status: 'pending' };
    setError('');
    setNotice('');
    setWorking(`AI membaca ${kindLabel[job.kind]}…`);
    try {
      const done = await process(full);
      if (done.status === 'ready') applyDraft(done.draft!, done.kind);
      else setError(done.error ?? 'Gagal membaca');
    } catch (err) {
      if (!(err instanceof Retryable)) {
        setError((err as Error).message);
        return;
      }
      await queue.put(full).catch(() => setError('Tidak bisa menyimpan rekaman di HP'));
      setNotice(`${err.message}. Rekaman disimpan di HP dan dibaca otomatis nanti.`);
      refreshJobs();
    } finally {
      setWorking('');
    }
  }

  const base = () => ({ pondId: pond!.id, pondName: pond!.name, images: [] as Blob[] });

  async function onPhoto(file: File | undefined) {
    if (!file || !pond) return;
    setWorking('Memeriksa foto…');
    try {
      const image = await prepareImage(file);
      if (image.issues.length) setPhotoCheck({ image, field: photoField.current });
      else await send({ ...base(), kind: 'photo', field: photoField.current, images: [image.blob] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWorking((w) => (w === 'Memeriksa foto…' ? '' : w));
    }
  }

  async function onVideo(file: File | undefined) {
    if (!file || !pond) return;
    setWorking('Mengambil gambar dan suara dari video…');
    try {
      const { frames, audio } = await prepareVideo(file);
      await send({ ...base(), kind: 'video', images: frames, audio });
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
    try {
      const rec = await startRecording(60);
      const job = { ...base(), kind: 'voice' as const };
      setElapsed(0);
      setRecording({ stop: rec.stop, started: Date.now() });
      // One place sends the note, whether the farmer tapped stop or 60 s ran out.
      rec.finished.then((audio) => {
        setRecording(null);
        if (audio.size > 0) send({ ...job, audio });
      });
    } catch {
      setError('Mikrofon tidak bisa dipakai. Izinkan mikrofon di pengaturan browser.');
    }
  }

  const takePhoto = (field?: ReadingField) => {
    photoField.current = field;
    photoInput.current?.click();
  };

  async function useJob(job: Job) {
    setPondId([String(job.pondId)]);
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
      const { pond } = await api.addLog(Number(pondId[0]), data, source);
      setResult(pond);
      reset();
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** "dari foto" / "cek lagi" next to a field the AI filled. */
  const Tag = ({ field }: { field: DraftField }) =>
    filled[field] ? (
      <span class={`ai-tag${doubtful.includes(field) ? ' doubt' : ''}`}>{doubtful.includes(field) ? 'ragu, cek lagi' : `dari ${kindLabel[filled[field]!]}`}</span>
    ) : null;

  if (result) {
    return (
      <div class="screen stack">
        <div>
          <p class="eyebrow">Tersimpan</p>
          <div class="pond-head">
            <h1>{result.name}</h1>
            <LevelBadge level={result.level} />
          </div>
        </div>
        {result.findings.length === 0 ? (
          <p class="muted">Tidak ada peringatan. Kolam aman berdasarkan catatan ini.</p>
        ) : (
          result.findings.map((f) => <FindingCard key={f.id} finding={f} />)
        )}
        <button class="primary" onClick={() => setResult(null)}>
          Catat lagi
        </button>
      </div>
    );
  }

  if (ponds.length === 0) return <div class="screen"><p class="muted">Tambahkan kolam dulu di Hari Ini.</p></div>;

  const ready = jobs.filter((j) => j.status === 'ready');
  const waiting = jobs.filter((j) => j.status === 'pending');

  return (
    <form class="screen stack" onSubmit={submit}>
      <div>
        <p class="eyebrow">Catat</p>
        <h1>Kondisi kolam</h1>
        <p class="muted small">Tangan basah? Bicara, foto alat ukur, atau rekam video. AI mengisi form, kamu yang memeriksa dan menyimpan.</p>
      </div>

      <Field label="Kolam">
        <Chips options={Object.fromEntries(ponds.map((p) => [String(p.id), p.name]))} value={pondId} onChange={(v) => v.length && setPondId(v)} />
      </Field>

      {aiMode === 'mock' && <p class="ai-banner">Mode contoh: AI Meta belum aktif. Hasil foto dan suara adalah contoh, bukan bacaan sungguhan.</p>}
      {aiMode === 'off' && <p class="ai-banner">AI belum aktif. Rekaman disimpan di HP dan dibaca setelah AI aktif. Isi manual tetap bisa.</p>}

      <div class="capture-bar">
        <button type="button" class={`capture${recording ? ' rec' : ''}`} onClick={toggleVoice} disabled={!!working && !recording}>
          <IconMic />
          <span>{recording ? `Selesai (${elapsed} dtk)` : 'Bicara'}</span>
        </button>
        <button type="button" class="capture" onClick={() => takePhoto()} disabled={!!working || !!recording}>
          <IconCamera />
          <span>Foto alat ukur</span>
        </button>
        <button type="button" class="capture" onClick={() => videoInput.current?.click()} disabled={!!working || !!recording}>
          <IconVideo />
          <span>Video harian</span>
        </button>
      </div>
      {recording && <p class="small muted">Sebutkan suhu, pH, TDS, jumlah mati, sisa pakan dan aerator. Maksimal 60 detik.</p>}
      {working && <p class="working" role="status">{working}</p>}
      {notice && <p class="small warning-text">{notice}</p>}

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
          if (f && pond) send({ ...base(), kind: 'voice', audio: f });
        }}
      />

      {photoCheck && (
        <div class="panel photo-check">
          <p>
            <strong>{photoCheck.image.issues.join(' dan ')}.</strong> Angka bisa salah terbaca. Bayangi layar alat dengan tangan atau badan, lalu foto
            dari samping.
          </p>
          <div class="row">
            <button type="button" class="secondary" onClick={() => (setPhotoCheck(null), takePhoto(photoCheck.field))}>
              Foto ulang
            </button>
            <button
              type="button"
              class="primary"
              onClick={() => {
                const { image, field } = photoCheck;
                setPhotoCheck(null);
                send({ ...base(), kind: 'photo', field, images: [image.blob] });
              }}
            >
              Kirim saja
            </button>
          </div>
        </div>
      )}

      {(ready.length > 0 || waiting.length > 0) && (
        <div class="panel">
          <h3>Rekaman di HP</h3>
          {ready.map((j) => (
            <div class="job" key={j.id}>
              <span>
                {j.pondName} · {kindLabel[j.kind]} · {fmtClock(j.createdAt, true)}
              </span>
              <button type="button" class="link" onClick={() => useJob(j)}>
                Pakai
              </button>
            </div>
          ))}
          {waiting.length > 0 && <p class="small muted">{waiting.length} rekaman menunggu sinyal atau AI aktif.</p>}
        </div>
      )}

      {(transcript || problems.length > 0) && (
        <div class="panel ai-result">
          {transcript && (
            <p>
              <span class="eyebrow">Terdengar</span>
              <br />“{transcript}”
            </p>
          )}
          {problems.map((p) => (
            <p key={p} class="small warning-text">
              {p}
            </p>
          ))}
          <p class="small muted">Periksa isian bertanda di bawah sebelum menyimpan.</p>
        </div>
      )}

      <div class="stack-sm">
        {READINGS.map((r) => (
          <div class="reading-row" key={r.key}>
            <Field
              label={
                <>
                  {r.label} <Tag field={r.key} />
                </>
              }
            >
              <input
                class={filled[r.key] ? (doubtful.includes(r.key) ? 'ai doubt' : 'ai') : ''}
                inputMode={r.mode}
                value={readings[r.key]}
                onInput={(e) => setReadings({ ...readings, [r.key]: e.currentTarget.value })}
                placeholder={r.placeholder}
              />
            </Field>
            <button type="button" class="icon-btn" aria-label={`Foto alat ukur ${r.label}`} onClick={() => takePhoto(r.key)} disabled={!!working || !!recording}>
              <IconCamera />
            </button>
          </div>
        ))}
      </div>

      <Field
        label={
          <>
            Sidat mati (ekor) <Tag field="mortality" />
          </>
        }
      >
        <div class="stepper">
          <button type="button" onClick={() => setMortality(Math.max(0, mortality - 1))} aria-label="Kurangi">
            −
          </button>
          <output>{mortality}</output>
          <button type="button" onClick={() => setMortality(mortality + 1)} aria-label="Tambah">
            +
          </button>
        </div>
      </Field>

      <Field label={<>Perilaku sidat <Tag field="behavior" /></>}>
        <Chips options={behaviorLabel} value={behavior} onChange={setBehavior} multiple />
      </Field>
      <Field label={<>Aerator <Tag field="aeration" /></>}>
        <Chips options={aerationCheckLabel} value={aeration} onChange={setAeration} />
      </Field>
      <Field label={<>Sisa pakan <Tag field="leftover" /></>}>
        <Chips options={leftoverLabel} value={leftover} onChange={setLeftover} />
      </Field>
      <Field label={<>Warna air <Tag field="color" /></>}>
        <Chips options={colorLabel} value={color} onChange={setColor} />
      </Field>
      <Field label={<>Bau air <Tag field="smell" /></>}>
        <Chips options={smellLabel} value={smell} onChange={setSmell} />
      </Field>
      <Field label="Catatan">
        <textarea rows={2} value={note} onInput={(e) => setNote(e.currentTarget.value)} placeholder="mis. habis hujan deras" />
      </Field>

      {error && <p class="error">{error}</p>}
      <button class="primary" disabled={busy || !pondId.length || !!working}>
        {source === 'manual' ? 'Simpan catatan' : 'Sudah benar, simpan'}
      </button>
    </form>
  );
}
