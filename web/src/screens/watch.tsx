import type { FarmState } from '../api.ts';
import { Empty, FindingCard } from '../ui.tsx';

export function Watch({ state }: { state: FarmState }) {
  const order = { critical: 0, warning: 1, info: 2 };
  const all = state.ponds
    .flatMap((p) => p.findings.map((f) => ({ finding: f, pondName: p.name })))
    .sort((a, b) => order[a.finding.level] - order[b.finding.level]);

  return (
    <div class="screen stack">
      <div>
        <p class="eyebrow">Waspada</p>
        <h1>Peringatan kolam</h1>
        <p class="muted small">Dari aturan ambang batas. Selalu jalan walau AI tidak tersedia.</p>
      </div>
      {all.length === 0 ? (
        <Empty>Tidak ada peringatan saat ini.</Empty>
      ) : (
        all.map(({ finding, pondName }) => <FindingCard key={`${pondName}-${finding.id}`} finding={finding} pondName={pondName} />)
      )}
    </div>
  );
}
