// "Lakukan sekarang" steps that mean something when ticked: each tick is saved as a note in the
// pond's records (with the time), so the owner sees what was done, the WhatsApp summary lists it,
// and the ticks are still there when the screen is opened again. Unticking removes the note.
import { useEffect, useState } from 'preact/hooks';
import { api } from './api.ts';
import { t } from './i18n.ts';
import { fmtClock } from './labels.ts';
import { Icon, TickBox } from './ui.tsx';

interface Done {
  at: number;
  /** null while it couldn't be saved yet (no signal); kept on the phone. */
  logId: number | null;
}

const key = (pondId: number) => `synteel.steps.${pondId}.${new Date().toLocaleDateString('en-CA')}`;

function load(pondId: number): Record<string, Done> {
  try {
    return JSON.parse(localStorage.getItem(key(pondId)) ?? '{}');
  } catch {
    return {};
  }
}

function store(pondId: number, done: Record<string, Done>) {
  try {
    localStorage.setItem(key(pondId), JSON.stringify(done));
  } catch {
    // private mode: kept for this screen only
  }
}

/** The note saved in the pond's records, in the language the farmer uses. */
const doneNote = (step: string) => t(`Sudah dilakukan: ${step}`, `Done: ${step}`);

export function useSteps(pondId: number) {
  const [done, setDone] = useState<Record<string, Done>>(() => load(pondId));
  useEffect(() => {
    setDone(load(pondId));
    // Ticks made without signal: put them in the records now.
    const pending = Object.entries(load(pondId)).filter(([, d]) => d.logId === null);
    for (const [step, d] of pending)
      api.addLog(pondId, { note: doneNote(step) }).then(
        ({ log }) => {
          const now = load(pondId);
          if (now[step]) update({ ...now, [step]: { at: d.at, logId: log.id } });
        },
        () => {},
      );
  }, [pondId]);

  const update = (next: Record<string, Done>) => {
    store(pondId, next);
    setDone(next);
  };

  const toggle = async (step: string) => {
    const was = done[step];
    if (was) {
      const { [step]: _, ...rest } = done;
      update(rest);
      if (was.logId) api.deleteLog(was.logId).catch(() => {});
      return;
    }
    const at = Date.now();
    const next = { ...done, [step]: { at, logId: null } };
    update(next);
    try {
      const { log } = await api.addLog(pondId, { note: doneNote(step) });
      update({ ...load(pondId), [step]: { at, logId: log.id } });
    } catch {
      // No signal: the tick stays on the phone; the step list says it isn't in the records yet.
    }
  };

  return { done, toggle };
}

/** The steps on a navy card, as on the pond page and the emergency result. */
export function StepList({ steps, done, toggle, onAllDone }: { steps: string[]; done: Record<string, Done>; toggle: (s: string) => void; onAllDone?: { label: string; run: () => void } }) {
  const count = steps.filter((s) => done[s]).length;
  const all = steps.length > 0 && count === steps.length;
  const last = Math.max(0, ...steps.map((s) => done[s]?.at ?? 0));
  return (
    <>
      {steps.map((s) => {
        const d = done[s];
        return (
          <button
            key={s}
            type="button"
            role="checkbox"
            aria-checked={!!d}
            onClick={() => toggle(s)}
            style={{ display: 'flex', gap: 12, alignItems: 'center', minHeight: 64, padding: '8px 12px', border: 0, borderRadius: 16, background: d ? 'rgba(63,185,132,0.18)' : 'rgba(255,255,255,0.08)', color: '#fff', textAlign: 'left' }}
          >
            <TickBox on={!!d} />
            <span class="grow stack-xs" style={{ gap: 2 }}>
              <span style={d ? { textDecoration: 'line-through', textDecorationColor: 'rgba(255,255,255,0.5)' } : undefined}>{s}</span>
              {d && (
                <span class="label" style={{ color: '#A7E3C8' }}>
                  {t('Dilakukan', 'Done at')} {fmtClock(d.at)} · {d.logId ? t('tercatat di riwayat', 'saved in History') : t('tersimpan di HP, dicatat saat ada sinyal', 'kept on the phone, saved when there is signal')}
                </span>
              )}
            </span>
          </button>
        );
      })}
      {all && (
        <div class="stack-xs" style={{ gap: 8, padding: '12px 16px', borderRadius: 16, background: 'rgba(63,185,132,0.18)', color: '#fff' }}>
          <span class="row" style={{ gap: 8 }}>
            <Icon name="check" size={20} />
            <span class="strong">{t(`Semua langkah selesai ${fmtClock(last)}`, `All steps done at ${fmtClock(last)}`)}</span>
          </span>
          <span class="label" style={{ color: 'var(--on-hero-soft)' }}>
            {t('Lihat lagi sidat sekitar 1 jam lagi. Kalau belum membaik, minta bantuan.', 'Look at the eels again in about 1 hour. If they are no better, ask for help.')}
          </span>
          {onAllDone && (
            <button type="button" class="btn" style={{ background: '#fff', color: 'var(--hero-bg)' }} onClick={onAllDone.run}>
              {onAllDone.label}
            </button>
          )}
        </div>
      )}
    </>
  );
}
