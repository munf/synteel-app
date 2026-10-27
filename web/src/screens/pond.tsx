import { useEffect, useState } from 'preact/hooks';
import { api, type Log, type PondSummary } from '../api.ts';
import { fmtNum, fmtTime, phaseLabel, summarizeLog } from '../labels.ts';
import { Empty, FindingCard, LevelBadge } from '../ui.tsx';

export function PondDetail({ id, onBack, onRecord }: { id: number; onBack: () => void; onRecord: (id: number) => void }) {
  const [data, setData] = useState<{ pond: PondSummary; logs: Log[] } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.pond(id).then(setData, (e) => setError(e.message));
  }, [id]);

  if (error) return <div class="screen"><p class="error">{error}</p></div>;
  if (!data) return <div class="screen"><p class="muted">Memuat…</p></div>;

  const { pond, logs } = data;
  const stage = pond.program?.stage;

  return (
    <div class="screen stack">
      <button class="link" onClick={onBack}>
        ← Hari Ini
      </button>
      <div class="pond-head">
        <h1>{pond.name}</h1>
        <LevelBadge level={pond.level} />
      </div>

      {pond.batch && pond.program && (
        <section class="panel">
          <p class="eyebrow">
            {phaseLabel[pond.batch.phase]} · minggu ke-{pond.program.week}
          </p>
          {stage ? (
            <>
              <h2>{stage.name}</h2>
              <dl class="facts">
                <dt>Pakan</dt>
                <dd>{stage.feed}</dd>
                <dt>Saringan</dt>
                <dd>{stage.mesh_mm} mm</dd>
                <dt>Air</dt>
                <dd>{stage.water}</dd>
              </dl>
              <p class="source">Sumber: Program glass eel 0–12 minggu, Blueprint Synt Nursery v5</p>
            </>
          ) : (
            <p class="muted small">
              {pond.program.beyondProgram ? 'Batch sudah melewati program 12 minggu.' : 'Belum ada program acuan untuk fase ini.'}
            </p>
          )}
          <p class="small">
            {pond.program.estimatedAlive !== null && <>Perkiraan hidup ±{fmtNum(pond.program.estimatedAlive)} ekor · </>}
            Total mati tercatat {fmtNum(pond.program.totalDead)} ekor
          </p>
        </section>
      )}

      <section class="stack">
        <h2>Peringatan</h2>
        {pond.findings.length === 0 ? <Empty>Tidak ada peringatan.</Empty> : pond.findings.map((f) => <FindingCard key={f.id} finding={f} />)}
      </section>

      <button class="primary" onClick={() => onRecord(pond.id)}>
        Catat kolam ini
      </button>

      <section class="stack">
        <h2>Riwayat 14 hari</h2>
        {logs.length === 0 ? (
          <Empty>Belum ada catatan.</Empty>
        ) : (
          <ul class="log-list">
            {logs.map((l) => (
              <li key={l.id}>
                <span class="log-time">{fmtTime(l.loggedAt)}</span>
                <span>{summarizeLog(l.data)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
