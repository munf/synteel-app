// "Listrik padam": one tap records when the power went out (farm-wide, power.ts on the server), shows the
// emergency steps for ponds whose aerators stop, asks how long it has been out, and ends with
// "Listrik sudah menyala". The owner is told by the farmer through a prepared WhatsApp message.
// Dead-eel cases stay for deaths (cases.ts); a power cut is its own timed record.
import { useEffect, useState } from 'preact/hooks';
import { api, ApiError, type Emergency, type FarmState, type Outage, type PowerBackup } from '../api.ts';
import type { Go } from '../app.tsx';
import { fmtClock } from '../labels.ts';
import { isEn, t } from '../i18n.ts';
import { Icon, TickBox } from '../ui.tsx';
import { BACKUP_LABEL, duration, useTicker } from './power.tsx';
import './power.css';
import './problem.css';

// Same phone copy of the emergency steps as Masalah, so the steps show without signal.
const EMERGENCIES_KEY = isEn ? 'synteel.emergencies.en' : 'synteel.emergencies';
/** A power cut tapped without signal: its start, sent once there is signal. */
const PENDING_KEY = 'synteel.outage.pending';

// Shown when the knowledge base never reached this phone (first use without signal).
const FALLBACK = [
  t('Catat jam listrik mulai padam dan kabari pemilik tambak', 'Note the time the power went out and tell the farm owner'),
  t('Nyalakan genset, atau sambungkan aerator ke aki atau baterai cadangan, kalau ada', 'Start the generator, or connect the aerator to a battery backup, if there is one'),
  t('Jangan beri pakan sampai aerator nyala lagi', 'Do not feed until the aerator is running again'),
  t('Lihat sidat tiap 30 menit: naik ke permukaan atau berkumpul di air masuk tanda oksigen kurang', 'Look at the eels every 30 minutes: rising to the surface or crowding at the water inlet means oxygen is short'),
  t('Kalau padam lebih dari 1 jam tanpa cadangan listrik, alirkan pelan-pelan air bersih yang sudah diendapkan', 'If the power is out for more than 1 hour with no backup, slowly let in clean water that has been settled'),
  t('Setelah listrik menyala: nyalakan aerator dulu, lalu alat lain satu per satu, dan lihat sidat', 'When the power is back: turn the aerator on first, then the other equipment one by one, and look at the eels'),
];

function readJson<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private mode: kept for this screen only
  }
}

/** Steps for now and for after, with the step for the farm's own backup first. */
function stepsFor(actions: string[], backup: PowerBackup | null) {
  const isBackupStep = (s: string) => /genset|generator/i.test(s);
  const isAfter = (s: string) => /^(setelah listrik|when the power is back)/i.test(s);
  const own =
    backup === 'genset'
      ? t('Nyalakan genset untuk aerator', 'Start the generator for the aerators')
      : backup === 'battery'
        ? t('Sambungkan aerator ke aki atau baterai cadangan', 'Connect the aerators to the battery backup')
        : null;
  // The app has noted the time already, and the message card below tells the owner.
  const recorded = (s: string) => /^(catat jam|note the time)/i.test(s);
  const now = actions.filter((s) => !isAfter(s) && !isBackupStep(s) && !recorded(s));
  // With no backup the generic "start the genset" step does not apply.
  if (own) now.unshift(own);
  else if (backup === null) now.unshift(...actions.filter(isBackupStep));
  // "Setelah listrik menyala: …" without the lead-in: the screen title already says so.
  const after = actions
    .filter(isAfter)
    .map((s) => s.replace(/^[^:]*:\s*/, ''))
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1));
  return { now, after };
}

const HOW_LONG: { min: number; label: string }[] = [
  { min: 0, label: t('Baru saja', 'Just now') },
  { min: 15, label: t('15 menit', '15 minutes') },
  { min: 30, label: t('30 menit', '30 minutes') },
  { min: 60, label: t('1 jam', '1 hour') },
  { min: 120, label: t('2 jam atau lebih', '2 hours or more') },
];

export function OutageScreen({ state, go, onChanged }: { state: FarmState; go: Go; onChanged: () => void }) {
  const [outage, setOutage] = useState<Outage | null>(null);
  const [backup, setBackup] = useState<PowerBackup | null>(state.farm?.powerBackup ?? null);
  /** Tapped without signal: the start kept on this phone. */
  const [pending, setPending] = useState<number | null>(() => readJson<number | null>(PENDING_KEY, null));
  const [actions, setActions] = useState<string[]>(() => readJson<Emergency[]>(EMERGENCIES_KEY, []).find((e) => e.id === 'aerator_off')?.operator_actions ?? FALLBACK);
  const [done, setDone] = useState<Record<string, number>>({});
  const [howLong, setHowLong] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const now = useTicker();

  // One tap: the power cut starts now (or the open one comes back). Without signal it waits on the phone.
  const start = (minutesAgo = 0) =>
    api.startOutage(minutesAgo).then(
      (r) => {
        setOutage(r.outage);
        setBackup(r.backup);
        setPending(null);
        writeJson(PENDING_KEY, null);
        onChanged();
      },
      (err) => {
        if (err instanceof TypeError) {
          const at = readJson<number | null>(PENDING_KEY, null) ?? Date.now() - minutesAgo * 60_000;
          writeJson(PENDING_KEY, at);
          setPending(at);
        } else setError((err as Error).message);
      },
    );

  useEffect(() => {
    const queued = readJson<number | null>(PENDING_KEY, null);
    start(queued ? Math.round((Date.now() - queued) / 60_000) : 0);
    api.knowledge().then(
      (k) => {
        const list = Array.isArray(k.emergencies?.emergencies) ? k.emergencies.emergencies : [];
        if (list.length) writeJson(EMERGENCIES_KEY, list);
        const sop = list.find((e) => e.id === 'aerator_off');
        if (sop) setActions(sop.operator_actions);
      },
      () => {},
    );
    const retry = () => readJson<number | null>(PENDING_KEY, null) && start(Math.round((Date.now() - readJson<number>(PENDING_KEY, Date.now())) / 60_000));
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, []);

  useEffect(() => setDone(readJson<Record<string, number>>(`synteel.outage.${outage?.id ?? 'pending'}`, {})), [outage?.id]);
  const toggle = (s: string) => {
    const next = { ...done };
    if (next[s]) delete next[s];
    else next[s] = Date.now();
    setDone(next);
    writeJson(`synteel.outage.${outage?.id ?? 'pending'}`, next);
  };

  const setStart = async (min: number) => {
    setHowLong(min);
    if (!outage) {
      writeJson(PENDING_KEY, Date.now() - min * 60_000);
      setPending(Date.now() - min * 60_000);
      return;
    }
    try {
      setOutage((await api.moveOutageStart(outage.id, min)).outage);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const end = async () => {
    if (!outage) return;
    setBusy(true);
    setError('');
    try {
      setOutage((await api.endOutage(outage.id)).outage);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError || !(err instanceof TypeError) ? (err as Error).message : t('Belum ada sinyal. Coba lagi sebentar.', 'No signal yet. Try again in a moment.'));
    } finally {
      setBusy(false);
    }
  };

  const since = outage ? Date.parse(outage.startedAt) : pending;
  const endedAt = outage?.endedAt ? Date.parse(outage.endedAt) : null;
  const out = since === null ? 0 : Math.max(0, Math.round(((endedAt ?? now) - since) / 60_000));
  const { now: nowSteps, after } = stepsFor(actions, backup);
  const steps = endedAt ? after : nowSteps;
  const count = steps.filter((s) => done[s]).length;
  const owner = state.role === 'owner';

  const summary = [
    endedAt
      ? t(`Listrik di ${state.farm?.name ?? 'tambak'} padam ${fmtClock(since!)}–${fmtClock(endedAt)} (${duration(out)}). Sudah menyala lagi.`, `Power at ${state.farm?.name ?? 'the farm'} was out ${fmtClock(since!)}–${fmtClock(endedAt)} (${duration(out)}). It is back on.`)
      : since !== null
        ? t(`Listrik di ${state.farm?.name ?? 'tambak'} padam sejak ${fmtClock(since)} (${duration(out)}). Aerator mati.`, `Power at ${state.farm?.name ?? 'the farm'} has been out since ${fmtClock(since)} (${duration(out)}). Aerators are off.`)
        : '',
    `${t('Cadangan listrik', 'Power backup')}: ${backup ? BACKUP_LABEL[backup] : t('belum diisi', 'not set')}`,
    Object.keys(done).length ? `${t('Sudah dilakukan', 'Done')}: ${Object.entries(done).map(([s, at]) => `${s} (${fmtClock(at)})`).join('; ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <div class="screen problem-flow">
      <header class="row">
        <button class="icon-btn" aria-label={t('Kembali', 'Back')} onClick={() => go({ name: 'today' })}>
          <Icon name="back" />
        </button>
        <span class="icon-box bad">
          <Icon name="bolt" />
        </span>
        <div class="stack-xs grow">
          <h1 style={{ lineHeight: 1 }}>{endedAt ? t('Listrik sudah menyala', 'Power is back on') : t('Listrik padam', 'Power cut')}</h1>
          <span class="meta">{state.farm?.name}</span>
        </div>
      </header>

      {since !== null && (
        <section class="card" aria-live="polite">
          <span class="label semi ink2">
            {endedAt ? t(`Padam ${fmtClock(since)}–${fmtClock(endedAt)}`, `Out ${fmtClock(since)}–${fmtClock(endedAt)}`) : t(`Padam sejak ${fmtClock(since)}`, `Out since ${fmtClock(since)}`)}
          </span>
          <span class="outage-clock num">{duration(out)}</span>
          {pending !== null && !outage && (
            <span class="note info">
              <Icon name="nowifi" size={20} />
              <span>{t('Belum ada sinyal. Jam padam disimpan di HP dan terkirim saat ada sinyal.', 'No signal yet. The time is kept on the phone and sent when there is signal.')}</span>
            </span>
          )}
          {endedAt ? (
            <p class="note ok">
              <Icon name="check" size={20} />
              <span>{t(`Listrik menyala lagi jam ${fmtClock(endedAt)}.`, `Power came back at ${fmtClock(endedAt)}.`)}</span>
            </p>
          ) : (
            <div class="field">
              <span class="field-label">{t('Sudah berapa lama padam?', 'How long has the power been out?')}</span>
              <div class="chips" role="group">
                {HOW_LONG.map((h) => (
                  <button key={h.min} type="button" class={`chip${howLong === h.min ? ' on' : ''}`} aria-pressed={howLong === h.min} onClick={() => setStart(h.min)}>
                    {h.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {steps.length > 0 && (
        <section class="hero">
          <div class="row between">
            <h2>{t('Lakukan sekarang', 'Do this now')}</h2>
            <span class="label semi" style={{ color: 'var(--on-navy-2)' }}>
              {t(`${count} dari ${steps.length} selesai`, `${count} of ${steps.length} done`)}
            </span>
          </div>
          <div class="outage-steps">
            {steps.map((s) => (
              <button key={s} type="button" role="checkbox" aria-checked={!!done[s]} class={`outage-step${done[s] ? ' on' : ''}`} onClick={() => toggle(s)}>
                <TickBox on={!!done[s]} />
                <span class="grow">{s}</span>
              </button>
            ))}
          </div>
          {endedAt && <span class="label" style={{ color: 'var(--on-hero-soft)' }}>{t('Lihat sidat lagi sekitar 1 jam lagi.', 'Look at the eels again in about 1 hour.')}</span>}
        </section>
      )}

      {!backup && !endedAt && (
        <p class="note info">
          <Icon name="info" size={20} />
          <span>
            {owner
              ? t('Cadangan listrik belum diisi. Isi di Profil supaya langkahnya pas.', 'The power backup is not set. Set it in Profile so the steps fit.')
              : t('Cadangan listrik belum diisi pemilik tambak.', 'The farm owner has not set the power backup yet.')}
          </span>
        </p>
      )}

      <section class="card soft-bad help-card">
        <p class="row top semi help-head">
          <Icon name="chat" size={20} />
          <span class="grow">{owner ? t('Kabari pekerja lewat WhatsApp.', 'Tell the workers on WhatsApp.') : t('Pemilik belum dikabari. Kirim kabar lewat WhatsApp.', 'The owner has not been told yet. Send the news on WhatsApp.')}</span>
        </p>
        <a class="btn danger" href={`https://wa.me/?text=${encodeURIComponent(summary)}`} target="_blank" rel="noopener">
          <Icon name="chat" size={20} /> {t('Kirim kabar ke WhatsApp', 'Send the news to WhatsApp')}
        </a>
        <div class="summary-box stack-xs">
          <span class="label strong help-head">{t('Isi pesan', 'Message text')}</span>
          <span class="label ink2" style={{ whiteSpace: 'pre-line' }}>
            {summary}
          </span>
        </div>
      </section>

      {error && <p class="error">{error}</p>}

      {endedAt ? (
        <div class="stack-sm">
          <button class="btn primary" onClick={() => go({ name: 'record' })}>
            <Icon name="pencil" size={20} /> {t('Catat kondisi kolam', 'Record pond conditions')}
          </button>
          <button class="btn secondary" onClick={() => go({ name: 'today' })}>
            {t('Kembali ke Beranda', 'Back to Home')}
          </button>
        </div>
      ) : (
        <button class="btn primary" disabled={busy || !outage} onClick={end}>
          <Icon name="check" size={20} stroke={3} /> {t('Listrik sudah menyala', 'Power is back on')}
        </button>
      )}
    </div>
  );
}
