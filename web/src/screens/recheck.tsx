// The follow-up to an emergency report: an hour later Beranda asks whether things improved.
// If not, the farmer records the new deaths and is offered help at once. Deterministic: no AI.
import { useEffect, useState } from 'preact/hooks';
import { api } from '../api.ts';
import type { Go } from '../app.tsx';
import { fmtClock } from '../labels.ts';
import { Icon, Stepper } from '../ui.tsx';
import { t } from '../i18n.ts';
import { loadRechecks, saveRechecks, type Recheck } from './problem.tsx';

function Due({ r, go, onDone }: { r: Recheck; go: Go; onDone: (next?: Recheck) => void }) {
  const [worse, setWorse] = useState(false);
  const [more, setMore] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState<string | null>(null);

  const better = async () => {
    setBusy(true);
    try {
      await api.addLog(r.pondId, { behavior: ['normal'], note: t('Cek ulang: membaik', 'Re-check: better') }, 'manual', { recheck: 'better' });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const notBetter = async () => {
    setBusy(true);
    try {
      await api.addLog(r.pondId, { mortality: more || undefined, behavior: ['surfacing'], note: t('Cek ulang: belum membaik', 'Re-check: not better yet') }, 'manual', { recheck: 'worse' });
      setSent(
        [
          t(`Cek ulang ${r.pondName}, ${fmtClock(Date.now())}: belum membaik.`, `Re-check ${r.pondName}, ${fmtClock(Date.now())}: not better yet.`),
          t(`Lapor masalah ${fmtClock(r.at)}: ${r.dead} ekor mati.`, `Problem reported ${fmtClock(r.at)}: ${r.dead} ${r.dead === 1 ? 'eel' : 'eels'} dead.`),
          more ? t(`Sejak itu mati lagi ${more} ekor.`, `Since then ${more} more dead.`) : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="card soft-bad">
      <div class="row top">
        <span class="icon-box bad">
          <Icon name="clock" />
        </span>
        <div class="stack-xs grow">
          <h2 style={{ color: 'var(--bad)' }}>{t(`Cek ulang ${r.pondName}`, `Re-check ${r.pondName}`)}</h2>
          <span class="label" style={{ color: 'var(--ink-2)' }}>
            {t(`Lapor masalah jam ${fmtClock(r.at)}`, `Problem reported at ${fmtClock(r.at)}`)}
            {r.dead ? t(` · ${r.dead} ekor mati`, ` · ${r.dead} ${r.dead === 1 ? 'eel' : 'eels'} dead`) : ''}
          </span>
        </div>
      </div>
      {sent ? (
        <>
          <p>{t('Tercatat. Kirim kabar sekarang, lalu cek lagi 1 jam lagi.', 'Recorded. Send an update now, then check again in 1 hour.')}</p>
          <a class="btn danger" href={`https://wa.me/?text=${encodeURIComponent(sent)}`} target="_blank" rel="noopener">
            <Icon name="chat" size={20} /> {t('Kirim kabar lewat WhatsApp', 'Send an update on WhatsApp')}
          </a>
          <button class="btn secondary" onClick={() => onDone({ ...r, dueAt: Date.now() + 3600_000, dead: r.dead + more })}>
            {t('Ingatkan 1 jam lagi', 'Remind me in 1 hour')}
          </button>
        </>
      ) : !worse ? (
        <>
          <p class="strong">{t('Sidat sudah turun dan berenang normal?', 'Are the eels back down and swimming normally?')}</p>
          <div class="grid2">
            <button class="btn primary" disabled={busy} onClick={better}>
              {t('Ya, membaik', 'Yes, better')}
            </button>
            <button class="btn secondary" disabled={busy} onClick={() => setWorse(true)}>
              {t('Belum', 'Not yet')}
            </button>
          </div>
        </>
      ) : (
        <>
          <div class="field">
            <span class="field-label">{t('Ada yang mati lagi sejak tadi?', 'Any more dead since then?')}</span>
            <Stepper value={more} onChange={setMore} quick={[5, 10]} />
          </div>
          <button class="btn danger" disabled={busy} onClick={notBetter}>
            {t('Catat dan minta bantuan', 'Record and ask for help')}
          </button>
          <button class="btn secondary" onClick={() => go({ name: 'problem', pondId: r.pondId })}>
            {t('Lihat langkah darurat lagi', 'See the emergency steps again')}
          </button>
        </>
      )}
      {error && <p class="error">{error}</p>}
    </section>
  );
}

/**
 * Re-check reminders kept on this phone. `due` ones are shown as cards on top of Beranda;
 * the next upcoming one is a line in the hero card. Re-evaluated every minute so a reminder
 * turns into a card while the app stays open.
 */
export function useRechecks() {
  const [list, setList] = useState(loadRechecks);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  // Forget reminders older than a day.
  const live = list.filter((r) => now - r.at < 24 * 3600_000);
  const update = (r: Recheck, next?: Recheck) => {
    const rest = live.filter((x) => x.pondId !== r.pondId);
    const updated = next ? [...rest, next] : rest;
    saveRechecks(updated);
    setList(updated);
  };
  return {
    due: live.filter((r) => r.dueAt <= now),
    soon: live.filter((r) => r.dueAt > now).sort((a, b) => a.dueAt - b.dueAt),
    update,
  };
}

/** Due re-checks as cards. */
export function DueRechecks({ due, update, go }: { due: Recheck[]; update: (r: Recheck, next?: Recheck) => void; go: Go }) {
  return (
    <>
      {due.map((r) => (
        <Due key={r.pondId} r={r} go={go} onDone={(next) => update(r, next)} />
      ))}
    </>
  );
}
