import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type FarmState, type PondSummary } from '../api.ts';
import type { Go } from '../app.tsx';
import { canRecordAudio, startRecording, voiceToWav } from '../capture/media.ts';
import { queue as captures, type Job } from '../capture/queue.ts';
import { fmtAgo, fmtClock, phaseLabel } from '../labels.ts';
import { clips, joinWav, newId, onClips, retryAll, type Clip } from '../queue.ts';
import { Icon, PondPicker, PondThumb, pondMeta, Shape, SimChip, toneOf } from '../ui.tsx';
import { fmtDur, Glyph, handToPond, isDenied, MicAsk, MicDenied, MicGranted, recordedToday, RecordPond, sortForRecording, useMic, useTick } from './record-pond.tsx';
import { t } from '../i18n.ts';
import './record.css';

/** A round recording stays under the server's 15 MB audio limit as 16 kHz WAV (about 7,8 minutes). */
const ROUND_MAX_S = 420;

type Filter = 'semua' | 'belum' | 'perhatian';
const FILTERS: { key: Filter; short: string; label: string }[] = [
  { key: 'semua', short: t('Semua', 'All'), label: t('Semua', 'All') },
  { key: 'belum', short: t('Belum', 'Not yet'), label: t('Belum dicatat', 'Not recorded today') },
  { key: 'perhatian', short: t('Perhatian', 'Attention'), label: t('Perlu perhatian', 'Needs attention') },
];
const needsAttention = (p: PondSummary) => p.level === 'warning' || p.level === 'critical';
const captureWord: Record<Job['kind'], string> = { photo: t('Foto', 'Photo'), voice: t('Suara', 'Voice'), video: 'Video' };

interface Rec {
  stop: () => Promise<Blob>;
  started: number;
  /** An interrupted recording this one continues. */
  base: Clip | null;
}

export function Record({ state, initialPondId, onSaved, go }: { state: FarmState; initialPondId?: number; onSaved: () => void; go: Go }) {
  // Opened from a pond page: straight to that pond.
  if (initialPondId) return <RecordPond ponds={state.ponds} pondId={initialPondId} onSaved={onSaved} go={go} />;
  return <Hub state={state} go={go} />;
}

function Hub({ state, go }: { state: FarmState; go: Go }) {
  const tz = state.farm?.timezone ?? 'Asia/Jakarta';
  const [filter, setFilter] = useState<Filter>('semua');
  const [q, setQ] = useState('');
  const [list, setList] = useState<Clip[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [quotaOut, setQuotaOut] = useState(false);
  const [rec, setRec] = useState<Rec | null>(null);
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const [kept, setKept] = useState<number | null>(null);
  const [confirmDrop, setConfirmDrop] = useState(false);
  const [shot, setShot] = useState<{ kind: 'photo' | 'video'; file: File } | null>(null);
  const mic = useMic();
  const recRef = useRef<Rec | null>(null);
  const cutRef = useRef(false);
  const photoInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);

  useTick(!!rec);
  const elapsed = rec ? (rec.base?.seconds ?? 0) + Math.round((Date.now() - rec.started) / 1000) : 0;

  const load = () => {
    clips.list().then(setList, () => setList([]));
    captures.list().then(setJobs, () => setJobs([]));
  };

  useEffect(() => {
    load();
    retryAll();
    api.quota().then((s) => setQuotaOut(!s.unlimited && s.left <= 0), () => {});
    const off = onClips(load);
    // A call or closing the app stops the microphone: keep what was recorded.
    const hidden = () => {
      if (document.hidden && recRef.current) {
        cutRef.current = true;
        recRef.current.stop();
      }
    };
    document.addEventListener('visibilitychange', hidden);
    return () => {
      off();
      document.removeEventListener('visibilitychange', hidden);
      if (recRef.current) {
        cutRef.current = true; // leaving the tab mid-recording: keep it as interrupted
        recRef.current.stop();
      }
    };
  }, []);

  const ponds = sortForRecording(state.ponds, state.today, tz);
  const doneToday = ponds.filter((p) => recordedToday(p, state.today, tz)).length;
  const tests: Record<Filter, (p: PondSummary) => boolean> = {
    semua: () => true,
    belum: (p) => !recordedToday(p, state.today, tz),
    perhatian: needsAttention,
  };
  const needle = q.trim().toLowerCase();
  const shown = ponds.filter((p) => tests[filter](p) && (!needle || p.name.toLowerCase().includes(needle)));

  const cut = [...list].reverse().find((c) => c.status === 'cut') ?? null;
  const roundReady = list.filter((c) => c.status === 'ready' || c.status === 'failed');
  const roundWaiting = list.filter((c) => c.status === 'waiting');
  const quota = quotaOut || roundWaiting.some((c) => c.reason === 'quota');

  async function startRec(base: Clip | null) {
    setError('');
    setKept(null);
    setConfirmDrop(false);
    if (!canRecordAudio()) return setError(t('HP ini tidak bisa merekam dari aplikasi. Ketik sendiri: ketuk kolam di daftar.', 'This phone cannot record from the app. Type it in: tap a pond in the list.'));
    if (!(await mic.ready())) return;
    try {
      const r = await startRecording(ROUND_MAX_S - (base?.seconds ?? 0));
      const next: Rec = { stop: r.stop, started: Date.now(), base };
      cutRef.current = false;
      recRef.current = next;
      setRec(next);
      r.finished.then((audio) => finish(audio, next));
    } catch (e) {
      if (isDenied(e)) mic.denied();
      else setError(t('Mikrofon tidak bisa dipakai di HP ini. Ketik sendiri: ketuk kolam di daftar.', 'The microphone does not work on this phone. Type it in: tap a pond in the list.'));
    }
  }

  /** One place handles the end of a recording: stop tapped, time up, or interrupted. */
  async function finish(audio: Blob, r: Rec) {
    const wasCut = cutRef.current;
    const seconds = (r.base?.seconds ?? 0) + Math.round((Date.now() - r.started) / 1000);
    recRef.current = null;
    setRec(null);
    if (audio.size === 0 && !r.base) return;
    setWorking(t('Menyimpan rekaman…', 'Saving the recording…'));
    try {
      const wav = audio.size ? await voiceToWav(audio, ROUND_MAX_S + 10) : null;
      let joined = wav;
      if (r.base && wav) {
        joined = await joinWav(r.base.audio, wav);
        // Could not join (the phone kept its own format): read the first part on its own.
        if (!joined) {
          await clips.put({ ...r.base, status: 'waiting', reason: 'offline' });
          joined = wav;
        }
      } else if (r.base) joined = r.base.audio;
      const clip: Clip = { id: r.base && joined !== wav ? r.base.id : newId(), createdAt: r.base?.createdAt ?? Date.now(), seconds, audio: joined!, status: 'new' };
      if (wasCut) return await clips.put({ ...clip, status: 'cut' });
      if (quota) {
        await clips.put({ ...clip, status: 'waiting', reason: 'quota' });
        return setKept(seconds);
      }
      if (!navigator.onLine) return await clips.put({ ...clip, status: 'waiting', reason: 'offline' });
      await clips.put(clip);
      go({ name: 'round', queued: clip.id });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWorking('');
    }
  }

  const talk = () => (rec ? rec.stop() : startRec(null));
  const typeFirst = () => {
    mic.close();
    handToPond('manual');
    if (ponds[0]) go({ name: 'record-pond', pondId: ponds[0].id });
  };

  return (
    <div class="screen">
      <section class="stack-sm">
        <h1>{t('Catat kondisi kolam', 'Record pond conditions')}</h1>
        <p class="ink2">{t('Sebut nama kolam lalu kondisinya. Bisa beberapa kolam sekaligus.', 'Say the pond name, then its conditions. Several ponds in one go works.')}</p>
      </section>

      {cut && !rec && (
        <section class="card rp-warn-card" style={{ gap: 12 }}>
          <div class="row top">
            <span class="icon-box rp-warn-box">
              <Icon name="phone" />
            </span>
            <div class="grow stack-xs">
              <h2>{t(`Rekaman terputus setelah ${fmtDur(cut.seconds)}`, `Recording cut off after ${fmtDur(cut.seconds)}`)}</h2>
              <span class="label ink2">
                {t('Aplikasi tertutup atau ada telepon masuk. Suara sampai saat itu tetap tersimpan.', 'The app closed or a call came in. The sound up to that point is kept.')}
              </span>
            </div>
          </div>
          {!confirmDrop ? (
            <>
              <button type="button" class="btn primary" onClick={() => startRec(cut)} disabled={!!working}>
                <Icon name="mic" /> {t('Lanjutkan rekaman', 'Continue recording')}
              </button>
              <button
                type="button"
                class="btn secondary"
                onClick={async () => {
                  await clips.put({ ...cut, status: 'new' });
                  go({ name: 'round', queued: cut.id });
                }}
              >
                {t('Cek yang sudah terekam', 'Check what was recorded')}
              </button>
              <button type="button" class="rp-text-btn bad" onClick={() => setConfirmDrop(true)}>
                {t('Buang', 'Discard')}
              </button>
            </>
          ) : (
            <>
              <p class="strong">{t(`Buang rekaman ${fmtDur(cut.seconds)} ini? Tidak bisa dikembalikan.`, `Discard this recording (${fmtDur(cut.seconds)})? It cannot be undone.`)}</p>
              <div class="grid2" style={{ gap: 8 }}>
                <button type="button" class="btn danger" onClick={() => (clips.remove(cut.id), setConfirmDrop(false))}>
                  {t('Ya, buang', 'Yes, discard')}
                </button>
                <button type="button" class="btn secondary" onClick={() => setConfirmDrop(false)}>
                  {t('Batal', 'Cancel')}
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {mic.granted && !rec && <MicGranted />}
      {mic.error && <p class="error">{mic.error}</p>}

      {mic.panel === 'ask' ? (
        <MicAsk onAllow={mic.allow} onType={typeFirst} />
      ) : mic.panel === 'denied' ? (
        <MicDenied onRetry={mic.allow} onType={typeFirst} />
      ) : quota ? (
        <QuotaCard rec={rec} elapsed={elapsed} kept={kept} onTalk={talk} go={go} />
      ) : (
        <button type="button" class={`talk rp-talk${rec ? ' rec' : ''}`} onClick={talk} disabled={!!working}>
          <span class="mic">
            <Icon name="mic" size={32} />
          </span>
          <span class="stack-xs">
            <span class="title num">{rec ? `${t('Selesai', 'Done')} · ${fmtDur(elapsed)}` : t('Bicara', 'Speak')}</span>
            <span class="label" style={{ color: 'var(--on-hero-pale)' }}>
              {rec ? t('Ketuk kalau sudah selesai keliling', 'Tap when you finish your round') : t('Sambil keliling: “Kolam A suhu 27, pH 7,4…”', 'As you walk: “Pond A, 27 degrees, pH 7.4…”')}
            </span>
          </span>
        </button>
      )}

      {working && (
        <p class="working" role="status">
          {working}
        </p>
      )}
      {error && <p class="error">{error}</p>}

      {!quota &&
        (shot ? (
          <section class="card">
            <div class="stack-xs">
              <h2>{shot.kind === 'photo' ? t('Foto ini untuk kolam mana?', 'Which pond is this photo for?') : t('Video ini untuk kolam mana?', 'Which pond is this video for?')}</h2>
              <span class="meta">{t('Kolam yang belum dicatat hari ini ada di atas.', 'Ponds not recorded today are at the top.')}</span>
            </div>
            <PondPicker
              ponds={ponds}
              value={null}
              placeholder={t('Pilih kolam', 'Choose a pond')}
              onChange={(id) => {
                handToPond(shot);
                go({ name: 'record-pond', pondId: id });
              }}
            />
            <button type="button" class="btn secondary" onClick={() => setShot(null)}>
              {t('Batal', 'Cancel')}
            </button>
          </section>
        ) : (
          <div class="grid2">
            <button type="button" class="capture-tile" onClick={() => photoInput.current?.click()} disabled={!!rec}>
              <span class="icon-box">
                <Icon name="camera" />
              </span>
              <span class="stack-xs">
                <span class="strong">{t('Foto alat ukur', 'Meter photo')}</span>
                <span class="meta">{t('Lalu sebut atau pilih kolamnya', 'Then say or pick the pond')}</span>
              </span>
            </button>
            <button type="button" class="capture-tile" onClick={() => videoInput.current?.click()} disabled={!!rec}>
              <span class="icon-box">
                <Icon name="video" />
              </span>
              <span class="stack-xs">
                <span class="strong">{t('Video harian', 'Daily video')}</span>
                <span class="meta">{t('Keliling kolam sambil cerita', 'Walk the ponds and talk')}</span>
              </span>
            </button>
          </div>
        ))}
      {!quota && !shot && (
        <button type="button" class="capture-tile nb-tile" onClick={() => go({ name: 'notebook' })} disabled={!!rec}>
          <span class="icon-box">
            <Icon name="book" />
          </span>
          <span class="grow stack-xs">
            <span class="strong">{t('Foto buku catatan', 'Notebook photo')}</span>
            <span class="meta">{t('Salin catatan lama dari buku ke aplikasi', 'Copy old records from the notebook into the app')}</span>
          </span>
          <Icon name="next" size={20} />
        </button>
      )}
      <input ref={photoInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => pickFile(e, 'photo')} />
      <input ref={videoInput} type="file" accept="video/*" capture="environment" hidden onChange={(e) => pickFile(e, 'video')} />

      <Waiting clips={[...roundReady, ...(quota ? [] : roundWaiting)]} jobs={jobs} ponds={state.ponds} go={go} />

      <section class="stack-sm" style={{ gap: 12 }}>
        <div class="row between" style={{ alignItems: 'baseline' }}>
          <h2>{t('Semua kolam', 'All ponds')}</h2>
          <span class="meta num">
            {t(`${doneToday} dari ${ponds.length} dicatat hari ini`, `${doneToday} of ${ponds.length} recorded today`)}
          </span>
        </div>
        <div class="progress" role="img" aria-label={t(`${doneToday} dari ${ponds.length} kolam dicatat hari ini`, `${doneToday} of ${ponds.length} ponds recorded today`)}>
          <span style={{ width: `${Math.round((doneToday / Math.max(1, ponds.length)) * 100)}%` }} />
        </div>
        <label class="rp-search">
          <Icon name="search" size={20} />
          <input aria-label={t('Cari kolam', 'Search ponds')} placeholder={t('Cari nama kolam', 'Search pond name')} value={q} onInput={(e) => setQ(e.currentTarget.value)} />
        </label>
        <div class="rp-filters" role="group" aria-label={t('Saring kolam', 'Filter ponds')}>
          {FILTERS.map((f) => {
            const on = filter === f.key;
            const n = ponds.filter(tests[f.key]).length;
            return (
              <button type="button" key={f.key} class={on ? 'on' : ''} aria-pressed={on} aria-label={t(`${f.label}, ${n} kolam`, `${f.label}, ${n} ${n === 1 ? 'pond' : 'ponds'}`)} onClick={() => setFilter(f.key)}>
                {on && <Icon name="check" size={16} stroke={3} />}
                {f.short}
                <span class="n">{n}</span>
              </button>
            );
          })}
        </div>

        <div>
          {shown.map((p) => (
            <PondRow key={p.id} pond={p} today={recordedToday(p, state.today, tz)} go={go} />
          ))}
          {shown.length === 0 && <p class="ink2 center" style={{ padding: '24px 0' }}>{needle ? t('Tidak ada kolam dengan nama itu.', 'No pond with that name.') : t('Tidak ada kolam di sini.', 'No ponds here.')}</p>}
        </div>

        {state.role === 'owner' && (
          <div class="stack-sm" style={{ gap: 12 }}>
            <button type="button" class="btn dashed" onClick={() => go({ name: 'add-pond' })}>
              <Icon name="plus" /> {t('Tambah kolam', 'Add a pond')}
            </button>
            <button type="button" class="btn secondary" onClick={() => go({ name: 'device' })}>
              <Icon name="wifi" /> {t('Hubungkan alat Synteel', 'Connect a Synteel device')}
            </button>
          </div>
        )}
      </section>
    </div>
  );

  function pickFile(e: Event, kind: 'photo' | 'video') {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) setShot({ kind, file });
  }
}

/** One destination per row: record this pond. Recorded today: a green tick and the time instead of the button. */
function PondRow({ pond: p, today, go }: { pond: PondSummary; today: boolean; go: Go }) {
  const tone = toneOf(p.level);
  const last = p.lastLogAt ? Date.parse(p.lastLogAt) : null;
  return (
    <div class="rp-row">
      <button type="button" class="rp-row-main" aria-label={t(`Catat ${p.name}`, `Record ${p.name}`)} onClick={() => go({ name: 'record-pond', pondId: p.id })}>
        <PondThumb kind={p.kind} pond={p} size={48} />
        <span class="grow stack-xs" style={{ gap: 2 }}>
          <span class="rp-row-name">
            {p.name}
            <SimChip pond={p} />
            {needsAttention(p) && (
              <span class={`word ${tone}`} style={{ gap: 6 }}>
                <Shape tone={tone} />
                {p.level === 'critical' ? t('Bahaya', 'Danger') : t('Perhatian', 'Caution')}
              </span>
            )}
          </span>
          <span class="label ink2">{p.batch && p.program ? `${phaseLabel[p.batch.phase]} · ${t('minggu', 'week')} ${p.program.week}` : pondMeta(p)}</span>
          {!today && (
            <span class="label ink2" style={{ fontWeight: 400 }}>
              {t('Belum dicatat hari ini', 'Not recorded today')} · {last ? t(`terakhir ${fmtAgo(last)}`, `last ${fmtAgo(last)}`) : t('belum pernah', 'never')}
            </span>
          )}
        </span>
        {today && last ? (
          <span class="rp-done">
            <Icon name="check" size={18} stroke={3} />
            {t(`Dicatat ${fmtClock(last)}`, `Recorded ${fmtClock(last)}`)}
          </span>
        ) : (
          <span class="rp-act dark">{t('Catat', 'Record')}</span>
        )}
      </button>
    </div>
  );
}

/** The AI quota is used up: record anyway, read tomorrow morning (Catat, "jatah AI habis"). */
function QuotaCard({ rec, elapsed, kept, onTalk, go }: { rec: Rec | null; elapsed: number; kept: number | null; onTalk: () => void; go: Go }) {
  return (
    <section class="card">
      <div class="row" style={{ gap: 16 }}>
        <span class="rp-round-icon">
          <Icon name="mic" size={32} />
        </span>
        <span class="stack-xs">
          <span class="title">{t('Rekam suara', 'Record voice')}</span>
          <span class="meta">{t('Disimpan dulu, dibaca besok pagi', 'Kept for now, read tomorrow morning')}</span>
        </span>
      </div>
      <div class="note info" style={{ fontSize: '1rem' }}>
        <Icon name="info" />
        <span class="stack-xs">
          <span class="strong">{t('Jatah baca AI hari ini habis', "Today's AI reads are used up")}</span>
          <span class="label">
            {t('Rekaman tetap disimpan dan dibaca otomatis besok pagi, atau begitu jatah ditambah.', 'The recording is kept and read automatically tomorrow morning, or as soon as more reads are added.')}
          </span>
          <button type="button" class="rp-link warn" onClick={() => go({ name: 'quota' })}>
            {t('Lihat dan tambah jatah AI', 'View and add daily AI reads')} <Icon name="next" size={16} />
          </button>
        </span>
      </div>
      <button type="button" class={`btn ${rec ? 'danger' : 'primary'}`} onClick={onTalk}>
        <Icon name="mic" />
        {rec ? `${t('Selesai', 'Done')} · ${fmtDur(elapsed)}` : kept !== null ? t('Rekam lagi', 'Record another') : t('Mulai rekam', 'Start recording')}
      </button>
      {kept !== null && !rec && (
        <div class="note ok" role="status" style={{ alignItems: 'center' }}>
          <Icon name="check" />
          <span>
            {t(`Rekaman ${fmtDur(kept)} disimpan. Dibaca besok pagi, lalu muncul untuk dicek.`, `Recording (${fmtDur(kept)}) saved. It is read tomorrow morning, then shows up for checking.`)}
          </span>
        </div>
      )}
      <div class="stack-sm rp-quota-foot">
        <span class="row top label ink2">
          <Icon name="pencil" size={20} />
          {t('Ketik sendiri tetap bisa: ketuk kolam di daftar.', 'You can still type it in: tap a pond in the list.')}
        </span>
        <span class="row top label ink2">
          <Icon name="alert" size={20} />
          <span>
            {t('Laporan darurat tetap dibaca AI, tidak memakai jatah.', 'Emergency reports are still read by the AI and use no reads.')}{' '}
            <button type="button" class="rp-link" onClick={() => go({ name: 'problem' })}>
              {t('Lapor masalah', 'Report a problem')}
            </button>
          </span>
        </span>
      </div>
    </section>
  );
}

const READ = t('Sudah dibaca', 'Read');
const FAILED = t('Gagal dibaca', 'Could not read');

/** Recordings kept on the phone: waiting for signal, or read and ready to check. */
function Waiting({ clips: list, jobs, ponds, go }: { clips: Clip[]; jobs: Job[]; ponds: PondSummary[]; go: Go }) {
  const rows = [
    ...list.map((c) => ({
      id: c.id,
      at: c.createdAt,
      title: t(`Rekaman ${fmtDur(c.seconds)}`, `Recording, ${fmtDur(c.seconds)}`),
      state: c.status === 'ready' ? READ : c.status === 'failed' ? FAILED : c.reason === 'quota' ? t('Menunggu jatah', 'Waiting for reads') : t('Menunggu', 'Waiting'),
      ready: c.status !== 'waiting',
      open: () => go({ name: 'round', queued: c.id }),
    })),
    ...jobs.map((j) => ({
      id: j.id,
      at: j.createdAt,
      title: `${captureWord[j.kind]} ${ponds.find((p) => p.id === j.pondId)?.name ?? j.pondName}`,
      state: j.status === 'ready' ? READ : j.status === 'failed' ? FAILED : t('Menunggu', 'Waiting'),
      ready: j.status !== 'pending',
      open: () => go({ name: 'record-pond', pondId: j.pondId }),
    })),
  ].sort((a, b) => a.at - b.at);
  if (!rows.length) return null;
  const ready = rows.filter((r) => r.ready);
  const why = list.find((c) => c.status === 'waiting')?.reason;
  return (
    <section class="card" style={{ gap: 12 }}>
      <div class="row">
        <span class={`icon-box ${ready.length ? 'ok' : 'rp-warn-box'}`}>{ready.length ? <Icon name="check" /> : <Icon name="nowifi" />}</span>
        <div class="grow stack-xs" style={{ gap: 2 }}>
          <h2>
            {ready.length
              ? t(`${ready.length} rekaman siap dicek`, `${ready.length} ${ready.length === 1 ? 'recording' : 'recordings'} ready to check`)
              : t(`${rows.length} rekaman menunggu sinyal`, `${rows.length} ${rows.length === 1 ? 'recording' : 'recordings'} waiting for signal`)}
          </h2>
          <span class="meta">
            {ready.length
              ? t('Sinyal kembali, AI sudah memilah per kolam', 'Signal is back; the AI sorted them by pond')
              : why === 'ai'
                ? t('AI belum aktif saat direkam', 'The AI was not on when this was recorded')
                : why === 'quota'
                  ? t('Jatah baca AI hari ini habis', "Today's AI reads are used up")
                  : t('Tidak ada sinyal saat direkam', 'No signal while recording')}
          </span>
        </div>
      </div>
      <div class="readings">
        {rows.map((r) => (
          <button type="button" key={r.id} class="rp-clip" onClick={r.open} disabled={!r.ready}>
            <Glyph name="wave" />
            <span class="grow" style={{ display: 'flex', flexDirection: 'column' }}>
              <span class="strong num">{r.title}</span>
              <span class="meta num">{t(`direkam ${fmtClock(r.at)}`, `recorded ${fmtClock(r.at)}`)}</span>
            </span>
            <span class={r.ready ? `word ${r.state === FAILED ? 'bad' : 'ok'}` : 'word ink2'} style={{ gap: 6 }}>
              {r.state === READ && <Icon name="check" size={16} stroke={2.6} />}
              {r.state}
            </span>
          </button>
        ))}
      </div>
      {ready.length ? (
        <button type="button" class="btn primary" onClick={ready[0].open}>
          {t('Cek hasilnya', 'Check the result')}
        </button>
      ) : (
        <p class="label ink2">
          {t('Dibaca AI otomatis begitu ada sinyal. Rekaman aman tersimpan di HP, aplikasi boleh ditutup.', 'The AI reads them as soon as there is signal. The recordings are kept safe on the phone; you can close the app.')}
        </p>
      )}
    </section>
  );
}
