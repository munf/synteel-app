import { useState } from 'preact/hooks';
import { api, type FarmState, type Nowcast, type NowcastState } from '../api.ts';
import type { Go } from '../app.tsx';
import { NowcastChart } from '../chart.tsx';
import { fmtClock, fmtNum } from '../labels.ts';
import { usePrefs } from '../prefs.ts';
import { Icon, PondThumb, Soon, StatusPill, TickBox } from '../ui.tsx';

const rank = { ok: 0, warning: 1, critical: 2 } as const;
const worst = (nc: Nowcast) => Math.max(rank[nc.now.level], rank[nc.peak.level]);
const BAR = { ok: '#3FB984', warning: '#F0B323', critical: '#F04438' } as const;
// Mirrors the nowcast's own cut-offs (score ≥ 3 perhatian, ≥ 5 bahaya).
const DANGER_SCORE = 5;

const DONE_KEY = 'synteel.checksDone';
const loadDone = (): Record<string, boolean> => {
  try {
    return JSON.parse(localStorage.getItem(DONE_KEY) ?? '{}');
  } catch {
    return {};
  }
};

export function Watch({ state, nowcast, onChanged, go }: { state: FarmState; nowcast: NowcastState | null; onChanged: () => void; go: Go }) {
  const prefs = usePrefs();
  const [open, setOpen] = useState(prefs.techOpen);
  const [done, setDone] = useState(loadDone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!nowcast)
    return (
      <div class="screen">
        <h1>Malam ini</h1>
        <p class="muted">Memuat perkiraan…</p>
      </div>
    );

  const now = Date.now();
  const casts = [...nowcast.ponds].sort((a, b) => worst(b) - worst(a) || a.peak.t - b.peak.t);
  const focus = casts[0];
  const focusPond = focus && state.ponds.find((p) => p.id === focus.pondId);
  const ahead = focus ? focus.hours.filter((h) => h.t >= now - 3600_000).slice(0, 24) : [];
  const pondName = (id: number) => state.ponds.find((p) => p.id === id)?.name ?? 'Kolam';

  const tasks = casts
    .flatMap((nc) => nc.checks.map((c) => ({ ...c, pondId: nc.pondId, key: `${nc.pondId}-${c.t}` })))
    .filter((c) => c.t >= now - 2 * 3600_000 && c.t <= now + 24 * 3600_000)
    .sort((a, b) => a.t - b.t)
    .slice(0, 6);

  const toggle = (key: string) => {
    const next = { ...done, [key]: !done[key] };
    setDone(next);
    try {
      localStorage.setItem(DONE_KEY, JSON.stringify(next));
    } catch {
      // keep it for this session
    }
  };

  // One tap for "I looked, all normal": logs eels normal and aerator on for the riskiest pond.
  const quickCheck = async () => {
    if (!focus) return;
    setBusy(true);
    setError('');
    try {
      await api.addLog(focus.pondId, { behavior: ['normal'], aeration: 'on' });
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const focusPoint = focus && (rank[focus.peak.level] > rank[focus.now.level] ? focus.peak : focus.now);

  return (
    <div class="screen">
      <section class="stack-sm">
        <h1>Malam ini</h1>
        <p class="ink2">Perkiraan dari cuaca dan catatan, bukan hasil ukur. Diperbarui tiap 30 menit.</p>
        {!nowcast.weather.available && <p class="label stale">Cuaca belum tersedia, jadi perkiraan suhu kurang pasti.</p>}
      </section>

      {focus && (
        <section class="hero" style={{ gap: 16 }}>
          <div class="row top between">
            <div class="stack-sm">
              <span class="label semi" style={{ color: 'var(--on-navy-2)' }}>
                {focus.peak.level === 'ok' ? 'Tenang' : 'Paling rawan'}
              </span>
              <span class="big">{fmtClock(focus.peak.t)}</span>
            </div>
            <StatusPill level={focus.peak.level}>{focusPond?.name}</StatusPill>
          </div>
          <p>
            {focus.peak.level === 'ok'
              ? 'Tidak ada jam rawan dalam 24 jam ke depan. Tetap cek pagi dan sore.'
              : [...focus.peak.factors.slice(0, 2).map((f) => f.label), 'Oksigen bisa turun.'].join('. ').replace(/\.\./g, '.')}
          </p>
          <div class="stack-sm">
            <div class="bars" style={{ height: 52 }}>
              {ahead.map((h) => (
                <span key={h.t} style={{ height: `${16 + rank[h.level] * 18}px`, background: BAR[h.level] }} />
              ))}
            </div>
            <div class="row between label" style={{ color: 'var(--on-navy-2)' }}>
              <span>{ahead[0] && fmtClock(ahead[0].t)}</span>
              <span>{ahead[12] && fmtClock(ahead[12].t)}</span>
              <span>{ahead.at(-1) && fmtClock(ahead.at(-1)!.t)}</span>
            </div>
            <span class="label" style={{ color: 'var(--on-navy-2)' }}>
              Makin tinggi batang, makin rawan.
            </span>
          </div>
        </section>
      )}

      <section class="card" style={{ gap: 4 }}>
        <div class="row between" style={{ marginBottom: 8 }}>
          <h2>Jadwal cek</h2>
          <span class="meta">
            {tasks.filter((t) => done[t.key]).length} dari {tasks.length} selesai
          </span>
        </div>
        {tasks.length === 0 && <p class="ink2">Tidak ada cek khusus. Ukur pagi dan sore seperti biasa.</p>}
        {tasks.map((t) => (
          <div class="list-row" key={t.key} style={{ gap: 8, minHeight: 72 }}>
            <button
              role="checkbox"
              aria-checked={!!done[t.key]}
              aria-label={t.reason}
              onClick={() => toggle(t.key)}
              style={{ width: 48, height: 48, flex: 'none', marginLeft: -8, border: 0, background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <TickBox on={!!done[t.key]} />
            </button>
            <div class="grow stack-xs">
              <span class="semi" style={{ color: done[t.key] ? 'var(--muted)' : undefined }}>
                {t.reason}
              </span>
              <span class="meta">
                {fmtClock(t.t)} · {pondName(t.pondId)}
              </span>
            </div>
            {t.alarm && (
              <span class="stack-xs" style={{ alignItems: 'flex-end' }}>
                <span class="pill grey">
                  <Icon name="bell" size={16} /> Alarm
                </span>
                <Soon />
              </span>
            )}
          </div>
        ))}
        {focus && (
          <button class="btn secondary" style={{ marginTop: 12 }} disabled={busy} onClick={quickCheck}>
            <Icon name="check" size={20} /> {focusPond?.name}: sidat normal, aerator nyala
          </button>
        )}
        {error && <p class="error">{error}</p>}
      </section>

      {casts.length > 1 && (
        <section class="card list">
          {casts.slice(1).map((nc) => {
            const pond = state.ponds.find((p) => p.id === nc.pondId);
            if (!pond) return null;
            return (
              <button key={nc.pondId} class="list-row" style={{ minHeight: 76, border: 0, borderBottom: '1px solid var(--line)', background: 'none', width: '100%', textAlign: 'left' }} onClick={() => go({ name: 'pond', id: pond.id })}>
                <PondThumb kind={pond.kind} size={48} />
                <span class="grow stack-xs">
                  <span class="strong">{pond.name}</span>
                  <span class="meta">{nc.peak.level === 'ok' ? 'Tenang 24 jam ke depan' : `Rawan sekitar ${fmtClock(nc.peak.t, true)}`}</span>
                </span>
                <StatusPill level={nc.peak.level} />
              </button>
            );
          })}
        </section>
      )}

      {focus && focusPoint && (
        <section class="card" style={{ padding: 0, gap: 0, overflow: 'hidden' }}>
          <button
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            style={{ minHeight: 64, border: 0, background: '#fff', padding: '0 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontWeight: 800 }}
          >
            <span class="row" style={{ color: 'var(--ink)' }}>
              <span style={{ color: 'var(--accent)' }}>
                <Icon name="sliders" />
              </span>
              Lihat detail teknis
            </span>
            <span style={{ transform: open ? 'rotate(180deg)' : 'none', color: 'var(--muted)' }}>
              <Icon name="down" />
            </span>
          </button>
          {open && (
            <div class="stack" style={{ padding: '0 20px 20px' }}>
              <span class="meta">{focusPond?.name} · perkiraan suhu air per jam. Area biru = rentang perkiraan.</span>
              <NowcastChart nc={focus} />
              <div class="stack-sm">
                <div class="row between">
                  <span class="strong">Alasan risiko {fmtClock(focusPoint.t)}</span>
                  <span class="meta">
                    skor {focusPoint.score} · Bahaya mulai {DANGER_SCORE}
                  </span>
                </div>
                {focusPoint.factors.map((f) => (
                  <div class="factor" key={f.id}>
                    <span class="grow ink2">{f.label}</span>
                    <span class="track">
                      <span style={{ width: `${Math.min(100, (f.points / 3) * 100)}%` }} />
                    </span>
                    <span class="strong" style={{ width: 24, textAlign: 'right' }}>
                      +{f.points}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
