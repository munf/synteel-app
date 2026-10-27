import { useState } from 'preact/hooks';
import { api, type FarmState, type Nowcast, type NowcastState, type PondSummary } from '../api.ts';
import { NowcastChart } from '../chart.tsx';
import { fmtAgo, fmtClock, fmtNum, riskLabel } from '../labels.ts';
import { Empty, FindingCard } from '../ui.tsx';

const rank = { ok: 0, warning: 1, critical: 2 } as const;
const worst = (nc: Nowcast) => Math.max(rank[nc.now.level], rank[nc.peak.level]);

function PondWatch({ pond, nc, onChanged, onRecord }: { pond: PondSummary; nc: Nowcast; onChanged: () => void; onRecord: (id: number) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Explain what drives the risk now, or the coming peak if that is worse.
  const focus = rank[nc.peak.level] > rank[nc.now.level] ? nc.peak : nc.now;
  const unwatchedH = nc.lastCheckAt === null ? null : (nc.generatedAt - nc.lastCheckAt) / 3600_000;

  const quickCheck = async () => {
    setBusy(true);
    setError('');
    try {
      await api.addLog(pond.id, { behavior: ['normal'], aeration: 'on' });
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article class={`panel watch lv-${nc.now.level}`}>
      <div class="pond-head">
        <h2>{pond.name}</h2>
        <span class={`badge lv-${nc.now.level}`}>{riskLabel[nc.now.level]}</span>
      </div>
      <p>
        {nc.now.temp !== null ? (
          <>
            Air diperkirakan <strong>±{fmtNum(nc.now.temp)} °C</strong> <span class="muted">(±{fmtNum(nc.now.sigma!)})</span>
          </>
        ) : (
          <span class="muted">Suhu air belum bisa diperkirakan. Catat suhu sekali dulu.</span>
        )}
        <br />
        <span class={unwatchedH !== null && unwatchedH >= 12 ? 'unwatched' : 'muted small'}>
          {nc.lastCheckAt === null ? 'Belum pernah dicek' : `Terakhir dicek ${fmtAgo(nc.lastCheckAt, nc.generatedAt)}`}
        </span>
      </p>

      <NowcastChart nc={nc} />

      {focus.factors.length > 0 && (
        <div class="stack-sm">
          <h3>{focus === nc.now ? 'Kenapa' : `Risiko naik sekitar ${fmtClock(focus.t, true)}, karena`}</h3>
          <ul class="factors">
            {focus.factors.map((f) => (
              <li key={f.id}>{f.label}</li>
            ))}
          </ul>
        </div>
      )}

      <div class="stack-sm">
        <h3>Jadwal cek</h3>
        <ul class="checks">
          {nc.checks.slice(0, 4).map((c) => (
            <li key={c.t} class={c.alarm ? 'alarm' : ''}>
              <span class="check-time">{fmtClock(c.t, true)}</span>
              <span>
                {c.reason}
                {c.alarm && <span class="alarm-tag">alarm malam</span>}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {error && <p class="error">{error}</p>}
      <div class="row">
        <button class="secondary" onClick={() => onRecord(pond.id)}>
          Catat lengkap
        </button>
        <button class="primary" disabled={busy} onClick={quickCheck}>
          Cek cepat: aman
        </button>
      </div>
      <p class="source">Cek cepat mencatat: sidat normal, aerator nyala.</p>
    </article>
  );
}

export function Watch({
  state,
  nowcast,
  onChanged,
  onRecord,
}: {
  state: FarmState;
  nowcast: NowcastState | null;
  onChanged: () => void;
  onRecord: (id: number) => void;
}) {
  const order = { critical: 0, warning: 1, info: 2 };
  const findings = state.ponds
    .flatMap((p) => p.findings.map((f) => ({ finding: f, pondName: p.name })))
    .sort((a, b) => order[a.finding.level] - order[b.finding.level]);
  const casts = [...(nowcast?.ponds ?? [])].sort((a, b) => worst(b) - worst(a));

  return (
    <div class="screen stack">
      <div>
        <p class="eyebrow">Waspada</p>
        <h1>Pantau kolam</h1>
        <p class="muted small">
          Diperkirakan ulang tiap 30 menit dari catatan terakhir dan cuaca. Ini <strong>perkiraan</strong>, bukan hasil ukur: pastikan
          dengan mengukur.
        </p>
        {nowcast && !nowcast.weather.available && (
          <p class="small warning-text">Cuaca belum tersedia ({nowcast.weather.error}). Perkiraan suhu kurang pasti.</p>
        )}
      </div>

      {!nowcast ? (
        <p class="muted">Memuat perkiraan…</p>
      ) : (
        casts.map((nc) => {
          const pond = state.ponds.find((p) => p.id === nc.pondId);
          return pond && <PondWatch key={nc.pondId} pond={pond} nc={nc} onChanged={onChanged} onRecord={onRecord} />;
        })
      )}

      <section class="stack">
        <div>
          <h2>Peringatan dari catatan</h2>
          <p class="muted small">Dari aturan ambang batas. Selalu jalan walau AI tidak tersedia.</p>
        </div>
        {findings.length === 0 ? (
          <Empty>Tidak ada peringatan saat ini.</Empty>
        ) : (
          findings.map(({ finding, pondName }) => <FindingCard key={`${pondName}-${finding.id}`} finding={finding} pondName={pondName} />)
        )}
      </section>
    </div>
  );
}
