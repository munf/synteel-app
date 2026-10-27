import type { FarmState, Nowcast, NowcastState, PondSummary, ReadingKey } from '../api.ts';
import { fmtAgo, fmtDate, fmtNum, phaseLabel, readingLabel, riskLabel } from '../labels.ts';
import { Empty, LevelBadge } from '../ui.tsx';

const SHOWN: ReadingKey[] = ['temperature', 'ph', 'tds'];

function PondCard({ pond, nc, onOpen }: { pond: PondSummary; nc?: Nowcast; onOpen: () => void }) {
  const top = pond.findings[0];
  return (
    <button class={`pond-card lv-${pond.level}`} onClick={onOpen}>
      <div class="pond-head">
        <h3>{pond.name}</h3>
        <LevelBadge level={pond.level} />
      </div>
      {pond.batch && pond.program && (
        <p class="muted small">
          {phaseLabel[pond.batch.phase]} · minggu ke-{pond.program.week}
          {pond.program.stage && ` · ${pond.program.stage.name}`}
          {pond.program.estimatedAlive !== null && ` · ±${fmtNum(pond.program.estimatedAlive)} ekor`}
        </p>
      )}
      <dl class="readings">
        {SHOWN.map((k) => (
          <div key={k}>
            <dt>{readingLabel[k].name}</dt>
            <dd>{pond.latest[k] ? `${fmtNum(pond.latest[k]!.value)}${readingLabel[k].unit ? ' ' + readingLabel[k].unit : ''}` : '–'}</dd>
          </div>
        ))}
      </dl>
      {top && <p class={`pond-top lv-${top.level}`}>{top.title}</p>}
      {nc && (
        <p class="small">
          {nc.now.temp !== null && <>Air sekarang ±{fmtNum(nc.now.temp)} °C · </>}
          <span class={`risk-text lv-${nc.now.level}`}>{riskLabel[nc.now.level]}</span>
          {nc.lastCheckAt !== null && <span class="muted"> · dicek {fmtAgo(nc.lastCheckAt, nc.generatedAt)}</span>}
        </p>
      )}
    </button>
  );
}

export function Today({
  state,
  nowcast,
  onOpenPond,
  onAddPond,
}: {
  state: FarmState;
  nowcast: NowcastState | null;
  onOpenPond: (id: number) => void;
  onAddPond: () => void;
}) {
  const counts = { critical: 0, warning: 0 };
  for (const p of state.ponds) if (p.level === 'critical' || p.level === 'warning') counts[p.level]++;

  return (
    <div class="screen stack">
      <div>
        <p class="eyebrow">{fmtDate(state.today)}</p>
        <h1>{state.farm?.name}</h1>
        <p class="muted">
          {counts.critical + counts.warning === 0
            ? 'Semua kolam aman berdasarkan catatan terakhir.'
            : [counts.critical && `${counts.critical} kolam bahaya`, counts.warning && `${counts.warning} kolam perlu diwaspadai`]
                .filter(Boolean)
                .join(', ') + '.'}
        </p>
      </div>
      {state.ponds.length === 0 && <Empty>Belum ada kolam.</Empty>}
      <div class="stack">
        {state.ponds.map((p) => (
          <PondCard key={p.id} pond={p} nc={nowcast?.ponds.find((n) => n.pondId === p.id)} onOpen={() => onOpenPond(p.id)} />
        ))}
      </div>
      <button class="secondary" onClick={onAddPond}>
        + Tambah kolam
      </button>
    </div>
  );
}
