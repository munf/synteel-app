// The follow-up to an emergency report: an hour later Beranda asks whether things improved.
// If not, the farmer records the new deaths and is offered help at once. Deterministic: no AI.
import { useEffect, useState } from 'preact/hooks';
import { api } from '../api.ts';
import type { Go } from '../app.tsx';
import { fmtClock } from '../labels.ts';
import { Icon, Stepper } from '../ui.tsx';
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
      await api.addLog(r.pondId, { behavior: ['normal'], note: 'Cek ulang: membaik' });
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
      await api.addLog(r.pondId, { mortality: more || undefined, behavior: ['surfacing'], note: 'Cek ulang: belum membaik' });
      setSent(
        [`Cek ulang ${r.pondName}, ${fmtClock(Date.now())}: belum membaik.`, `Lapor masalah ${fmtClock(r.at)}: ${r.dead} ekor mati.`, more ? `Sejak itu mati lagi ${more} ekor.` : ''].filter(Boolean).join('\n'),
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
          <h2 style={{ color: '#7A1A10' }}>Cek ulang {r.pondName}</h2>
          <span class="label" style={{ color: '#5C1A12' }}>
            Lapor masalah jam {fmtClock(r.at)}
            {r.dead ? ` · ${r.dead} ekor mati` : ''}
          </span>
        </div>
      </div>
      {sent ? (
        <>
          <p>Tercatat. Kirim kabar sekarang, lalu cek lagi 1 jam lagi.</p>
          <a class="btn danger" href={`https://wa.me/?text=${encodeURIComponent(sent)}`} target="_blank" rel="noopener">
            <Icon name="chat" size={20} /> Kirim kabar lewat WhatsApp
          </a>
          <button class="btn secondary" onClick={() => onDone({ ...r, dueAt: Date.now() + 3600_000, dead: r.dead + more })}>
            Ingatkan 1 jam lagi
          </button>
        </>
      ) : !worse ? (
        <>
          <p class="strong">Sidat sudah turun dan berenang normal?</p>
          <div class="grid2">
            <button class="btn primary" disabled={busy} onClick={better}>
              Ya, membaik
            </button>
            <button class="btn secondary" disabled={busy} onClick={() => setWorse(true)}>
              Belum
            </button>
          </div>
        </>
      ) : (
        <>
          <div class="field">
            <span class="field-label">Ada yang mati lagi sejak tadi?</span>
            <Stepper value={more} onChange={setMore} />
          </div>
          <button class="btn danger" disabled={busy} onClick={notBetter}>
            Catat dan minta bantuan
          </button>
          <button class="btn secondary" onClick={() => go({ name: 'problem', pondId: r.pondId })}>
            Lihat langkah darurat lagi
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
