import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type Behavior, type Draft, type DraftField, type LogData, type LogSource, type PondSummary } from '../api.ts';
import { canRecordAudio, prepareImage, prepareVideo, startRecording, voiceToWav, type PreparedImage } from '../capture/media.ts';
import { process, queue, Retryable, type CaptureKind, type Job } from '../capture/queue.ts';
import { aerationCheckLabel, behaviorLabel, colorLabel, fmtClock, leftoverLabel, smellLabel } from '../labels.ts';

type EditKey = ReadingField | 'mortality' | 'behavior' | 'aeration' | 'leftover' | 'color' | 'smell';
import { Chips, Field, FindingCard, Icon, PondPicker, Shape, StatusPill, Stepper } from '../ui.tsx';

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
  const [editing, setEditing] = useState<EditKey | null>(null);
  const [manual, setManual] = useState(false);

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
    setEditing(null);
    setManual(false);
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
        if (audio.size > 0) voiceToWav(audio).then((wav) => send({ ...job, audio: wav }));
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

  /** The control for one value: the same in the AI review and in the full form. */
  const editor = (key: EditKey) => {
    switch (key) {
      case 'temperature':
      case 'ph':
      case 'tds': {
        const r = READINGS.find((x) => x.key === key)!;
        return (
          <div class="row">
            <input
              class="input grow"
              aria-label={r.label}
              inputMode={r.mode}
              value={readings[key]}
              onInput={(e) => setReadings({ ...readings, [key]: e.currentTarget.value })}
              placeholder={r.placeholder}
            />
            <button type="button" class="icon-btn" style={{ border: '2px solid var(--line-2)', borderRadius: 16, width: 56, height: 56 }} aria-label={`Foto alat ukur ${r.label}`} onClick={() => takePhoto(key)} disabled={!!working || !!recording}>
              <Icon name="camera" />
            </button>
          </div>
        );
      }
      case 'mortality':
        return <Stepper value={mortality} onChange={setMortality} />;
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

  if (ponds.length === 0)
    return (
      <div class="screen">
        <p class="muted">Tambahkan kolam dulu di Beranda.</p>
      </div>
    );

  const ready = jobs.filter((j) => j.status === 'ready');
  const waiting = jobs.filter((j) => j.status === 'pending');
  const reviewing = source !== 'manual';
  const draftKeys = (Object.keys(LABELS) as EditKey[]).filter((k) => k === 'temperature' || k === 'ph' || k === 'tds' || filled[k]);

  return (
    <form class="screen" onSubmit={submit}>
      <section class="stack-sm">
        <h1>Catat kondisi kolam</h1>
        <p class="ink2">Tangan basah? Cukup bicara. Isian terisi otomatis, lalu cek sebelum disimpan.</p>
      </section>

      <div class="field">
        <span class="label semi ink2">Kolam</span>
        <PondPicker ponds={ponds} value={pond?.id ?? null} onChange={(id) => setPondId([String(id)])} />
      </div>

      {aiMode === 'mock' && <p class="note warn">Mode contoh: hasil foto dan suara adalah contoh, bukan bacaan sungguhan.</p>}
      {aiMode === 'off' && <p class="note warn">AI belum aktif. Rekaman disimpan di HP dan dibaca setelah AI aktif. Ketik sendiri tetap bisa.</p>}

      <button type="button" class={`talk${recording ? ' rec' : ''}`} onClick={toggleVoice} disabled={!!working && !recording}>
        <span class="mic">
          <Icon name="mic" size={32} />
        </span>
        <span class="stack-xs">
          <span class="title">{recording ? `Selesai · ${elapsed} dtk` : 'Bicara'}</span>
          <span class="label" style={{ color: '#E4EAF5' }}>
            {recording ? `Merekam ${pond?.name ?? ''}. Ketuk untuk selesai, paling lama 60 detik.` : 'Sebutkan suhu, pH, TDS, sidat mati, sisa pakan dan aerator.'}
          </span>
        </span>
      </button>

      <div class="grid2">
        <button type="button" class="capture-tile" onClick={() => takePhoto()} disabled={!!working || !!recording}>
          <span class="icon-box">
            <Icon name="camera" />
          </span>
          <span class="stack-xs">
            <span class="strong">Foto alat ukur</span>
            <span class="meta">pH, TDS, termometer</span>
          </span>
        </button>
        <button type="button" class="capture-tile" onClick={() => videoInput.current?.click()} disabled={!!working || !!recording}>
          <span class="icon-box">
            <Icon name="video" />
          </span>
          <span class="stack-xs">
            <span class="strong">Video harian</span>
            <span class="meta">Keliling kolam sambil cerita</span>
          </span>
        </button>
      </div>

      <div class="note info">
        <Icon name="wifi" />
        <span>Tidak ada sinyal? Rekaman disimpan di HP dan dibaca otomatis saat ada sinyal.</span>
      </div>

      {working && (
        <p class="working" role="status">
          {working}
        </p>
      )}
      {notice && <p class="note warn">{notice}</p>}

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
          if (f && pond) voiceToWav(f).then((wav) => send({ ...base(), kind: 'voice', audio: wav }));
        }}
      />

      {photoCheck && (
        <section class="card" style={{ background: 'var(--warn-bg)' }}>
          <p>
            <strong>{photoCheck.image.issues.join(' dan ')}.</strong> Angka bisa salah terbaca. Bayangi layar alat dengan tangan atau badan, lalu foto dari samping.
          </p>
          <div class="grid2">
            <button type="button" class="btn secondary" onClick={() => (setPhotoCheck(null), takePhoto(photoCheck.field))}>
              Foto ulang
            </button>
            <button
              type="button"
              class="btn primary"
              onClick={() => {
                const { image, field } = photoCheck;
                setPhotoCheck(null);
                send({ ...base(), kind: 'photo', field, images: [image.blob] });
              }}
            >
              Kirim saja
            </button>
          </div>
        </section>
      )}

      {(ready.length > 0 || waiting.length > 0) && (
        <section class="card" style={{ gap: 8 }}>
          <h2>Rekaman di HP</h2>
          {ready.map((j) => (
            <div class="row between" key={j.id}>
              <span>
                {j.pondName} · {kindLabel[j.kind]} · {fmtClock(j.createdAt, true)}
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
              <h2>Cek dulu sebelum disimpan</h2>
              <span class="meta">{pond?.name}</span>
            </div>
            <span class="pill blue">dari {kindLabel[source as CaptureKind]}</span>
          </div>
          {transcript && <p class="quote">“{transcript}”</p>}
          {problems.map((p) => (
            <p key={p} class="note warn">
              {p}
            </p>
          ))}
          <span class="meta">Ada yang salah? Ketuk barisnya untuk mengubah.</span>
          <div>
            {draftKeys.map((k) =>
              editing === k ? (
                <div class="draft-edit" key={k}>
                  <span class="strong">{LABELS[k]}</span>
                  {editor(k)}
                  <button type="button" class="btn blue" onClick={() => setEditing(null)}>
                    Selesai
                  </button>
                </div>
              ) : (
                <button type="button" class="draft-row" key={k} onClick={() => setEditing(k)}>
                  <span class="ink2">{LABELS[k]}</span>
                  <span class="row" style={{ gap: 8 }}>
                    {doubtful.includes(k) && (
                      <span class="pill warn">
                        <Shape tone="warn" size={10} />
                        cek lagi
                      </span>
                    )}
                    <span class="strong">{showValue(k) ?? '–'}</span>
                    <span class="muted">
                      <Icon name="pencil" size={18} />
                    </span>
                  </span>
                </button>
              ),
            )}
          </div>
          {error && <p class="error">{error}</p>}
          <button class="btn primary" disabled={busy || !pondId.length || !!working}>
            <Icon name="check" size={20} stroke={2.4} /> Simpan catatan
          </button>
          <div class="grid2">
            <button type="button" class="btn secondary" onClick={toggleVoice} disabled={!!working}>
              <Icon name="mic" size={20} /> Ulangi bicara
            </button>
            <button type="button" class="btn secondary" onClick={() => setManual(true)}>
              <Icon name="pencil" size={20} /> Ketik semua
            </button>
          </div>
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
              <textarea rows={2} value={note} onInput={(e) => setNote(e.currentTarget.value)} placeholder="mis. habis hujan deras" />
            </Field>
            {error && <p class="error">{error}</p>}
            <button class="btn primary" disabled={busy || !pondId.length || !!working}>
              <Icon name="check" size={20} stroke={2.4} /> Simpan catatan
            </button>
          </div>
        </details>
      )}
    </form>
  );
}
