import { useEffect, useState } from 'preact/hooks';
import { api, type PondSummary, type Role } from '../api.ts';
import type { Go } from '../app.tsx';
import { actionIcon, alarmClosed, armedChecks, findArmed, GLYPH, loadDone, markDone, snoozeAlarm, startTone, stopTone, unsnoozeAlarm } from '../alarms.ts';
import { fmtClock, levelLabel } from '../labels.ts';
import { setForcedNight } from '../prefs.ts';
import { Icon } from '../ui.tsx';
import { Glyph } from './watch.tsx';
import './watch.css';
import './alarm.css';

type Step = 'ring' | 'snoozed' | 'ask' | 'done';

const SHAPE = {
  warning: { d: 'M1 1h10v10H1z', fill: '#F0B323' },
  critical: { d: 'M5.13 1.5a1 1 0 0 1 1.74 0l4.5 8a1 1 0 0 1-.87 1.5H1.5a1 1 0 0 1-.87-1.5z', fill: '#F04438' },
} as const;

const longDate = (t: number) => new Date(t).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Jakarta' });

/**
 * The night-check alarm, full screen over everything (the menu included): rings until it is
 * answered or snoozed, then asks whether the eels look normal and logs the answer.
 */
export function Alarm({ ponds, at, pondId, onSaved, go }: { ponds: PondSummary[]; at: number; pondId: number; role: Role | null; onSaved: () => void; go: Go }) {
  const key = `${pondId}-${at}`;
  const check = findArmed(at, pondId);
  const pond = ponds.find((p) => p.id === pondId);
  const pondName = pond?.name ?? check?.pondName ?? 'Kolam';
  const action = check?.action ?? 'Lihat sidat dan aerator';
  // A check that is about looking at the eels asks the question the farmer answers next.
  const actionText = actionIcon(action) === GLYPH.eye ? 'Cek: sidat naik ke permukaan?' : action;

  const [step, setStep] = useState<Step>('ring');
  // Where "Kembali" returns to from the question: the ringing or the snoozed screen.
  const [from, setFrom] = useState<'ring' | 'snoozed'>('ring');
  const [snoozeUntil, setSnoozeUntil] = useState(0);
  const [doneAt, setDoneAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // The tone plays only while ringing; leaving the screen always silences it.
  useEffect(() => {
    if (step === 'ring') startTone();
    else stopTone();
  }, [step]);
  useEffect(
    () => () => {
      stopTone();
      alarmClosed(key);
    },
    [key],
  );

  // Snoozed: ring again after 10 minutes.
  useEffect(() => {
    if (step !== 'snoozed') return;
    const timer = setTimeout(() => setStep('ring'), Math.max(0, snoozeUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [step, snoozeUntil]);

  const snooze = () => {
    setSnoozeUntil(snoozeAlarm(key));
    setFrom('snoozed');
    setStep('snoozed');
  };
  const unsnooze = () => {
    unsnoozeAlarm(key);
    setFrom('ring');
    setStep('ring');
  };
  const answer = () => {
    setError('');
    setStep('ask');
  };

  const normal = async () => {
    setBusy(true);
    setError('');
    try {
      await api.addLog(pondId, { behavior: ['normal'], note: `Cek malam ${fmtClock(at)}: normal` });
      markDone([key]);
      onSaved();
      setDoneAt(Date.now());
      setStep('done');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // The emergency flow opened from this night alarm stays dark (canvas: Masalah tema Malam), even when the
  // Profil switch is off; problem.tsx ends it when that flow is left.
  const problem = () => {
    markDone([key]);
    setForcedNight(true);
    go({ name: 'problem', pondId });
  };

  const done = loadDone();
  const next = armedChecks().find((c) => c.t > at && !done[c.key]);
  const level = check?.peak?.level;
  const peak = check?.peak && (level === 'warning' || level === 'critical') ? { t: check.peak.t, level } : null;

  const pondCard = (
    <section class="card2">
      <div class="row" style={{ gap: 16 }}>
        <span class="badge">
          <Glyph d={actionIcon(action)} size={28} />
        </span>
        <div class="grow stack-xs" style={{ gap: 2 }}>
          <span class="pond">{pondName}</span>
          <span style={{ color: 'var(--on-navy)' }}>{actionText}</span>
        </div>
      </div>
      {peak && (
        <div class="risk">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" style={{ flex: 'none' }}>
            <path d={SHAPE[peak.level].d} fill={SHAPE[peak.level].fill} />
          </svg>
          <span>
            {levelLabel[peak.level]} · puncak rawan jam {fmtClock(peak.t)}
          </span>
        </div>
      )}
    </section>
  );

  return (
    <div class="alarm" role="alertdialog" aria-modal="true" aria-label={`Alarm cek ${fmtClock(at)}, ${pondName}`}>
      <div class="alarm-in">
        <div class="top">
          <Glyph d={GLYPH.bell} size={20} />
          {step === 'done' ? 'CEK MALAM' : 'ALARM CEK MALAM'}
        </div>

        {step === 'ring' && (
          <>
            <div class="mid">
              <div class="clock">
                <span class="huge">{fmtClock(at)}</span>
                <span class="sub">{longDate(at)}</span>
              </div>
              {pondCard}
            </div>
            <div class="buttons">
              <button type="button" class="b-main" onClick={answer}>
                <Icon name="check" size={22} stroke={3} />
                Sudah dicek
              </button>
              <button type="button" class="b-line" onClick={snooze}>
                <Glyph d={GLYPH.clock} />
                Tunda 10 menit
              </button>
              <p class="foot">Alarm terus berbunyi sampai dijawab.</p>
            </div>
          </>
        )}

        {step === 'snoozed' && (
          <>
            <div class="mid">
              <div class="clock">
                <span class="strong" style={{ color: '#FBD38D' }}>
                  Ditunda, berbunyi lagi
                </span>
                <span class="huge">{fmtClock(snoozeUntil)}</span>
                <span class="sub">{longDate(snoozeUntil)}</span>
              </div>
              {pondCard}
            </div>
            <div class="buttons">
              <button type="button" class="b-main" onClick={answer}>
                <Icon name="check" size={22} stroke={3} />
                Sudah dicek sekarang
              </button>
              <button type="button" class="b-line" onClick={unsnooze}>
                Batalkan tunda
              </button>
            </div>
          </>
        )}

        {step === 'ask' && (
          <>
            <div class="mid">
              <div class="clock" style={{ gap: 16 }}>
                <span class="circle" style={{ background: '#17284A', color: '#FBD38D' }}>
                  <Glyph d={GLYPH.eye} size={36} />
                </span>
                <span class="title">Sidat {pondName} normal?</span>
                <span class="sub">Normal: berenang di dasar, tidak naik ke permukaan.</span>
              </div>
            </div>
            <div class="buttons">
              {error && <p class="error center">{error}</p>}
              <button type="button" class="b-main" disabled={busy} onClick={normal}>
                <Icon name="check" size={22} stroke={3} />
                {busy ? 'Menyimpan…' : 'Ya, normal'}
              </button>
              <button type="button" class="b-bad" onClick={problem}>
                <Icon name="siren" size={22} />
                Ada masalah
              </button>
              <button type="button" class="b-text" onClick={() => setStep(from)}>
                Kembali
              </button>
            </div>
          </>
        )}

        {step === 'done' && (
          <>
            <div class="mid">
              <div class="clock" style={{ gap: 16 }}>
                <span class="circle" style={{ background: '#1E8A5F', color: '#fff' }}>
                  <Icon name="check" size={36} stroke={3} />
                </span>
                <span class="title">Tercatat</span>
                <span class="sub num">
                  Sidat {pondName} normal · {fmtClock(doneAt)}
                </span>
              </div>
              {next && (
                <section class="card2" style={{ gap: 12 }}>
                  <span class="label strong" style={{ color: '#FBD38D', letterSpacing: '0.06em' }}>
                    BERIKUTNYA
                  </span>
                  <div class="row" style={{ gap: 16 }}>
                    <span class="title num" style={{ flex: 'none' }}>
                      {fmtClock(next.t)}
                    </span>
                    <span class="grow stack-xs" style={{ gap: 0 }}>
                      <span class="strong">{next.action}</span>
                      <span class="label" style={{ color: 'var(--on-navy-2)' }}>
                        {next.pondName}
                        {next.peak && next.peak.level !== 'ok' && Math.abs(next.peak.t - next.t) <= 3600_000 ? ' · puncak rawan' : ''}
                      </span>
                    </span>
                    {next.alarm && (
                      <span style={{ color: '#FBD38D', display: 'inline-flex' }} aria-label="Alarm">
                        <Glyph d={GLYPH.bell} size={24} />
                      </span>
                    )}
                  </div>
                </section>
              )}
            </div>
            <div class="buttons">
              <button type="button" class="b-main" onClick={() => go({ name: 'watch' })}>
                Tutup
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
