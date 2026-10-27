// Re-estimates every pond every 30 minutes, also while nobody has the app open, and
// remembers when a pond's estimated risk goes up. The evening agent and night alarms
// (roadmap days 4 and 6) start from these changes.
import type { Nowcast, RiskLevel } from './nowcast.ts';

export interface RiskChange {
  pondId: number;
  at: number;
  from: RiskLevel;
  to: RiskLevel;
  reasons: string[];
}

export const MONITOR_INTERVAL_MS = 30 * 60 * 1000;
const rank: Record<RiskLevel, number> = { ok: 0, warning: 1, critical: 2 };

export function startMonitor(run: () => Promise<{ ponds: Nowcast[] }>, onRise: (change: RiskChange) => void) {
  const last = new Map<number, RiskLevel>();
  const status = { lastRunAt: null as number | null, lastError: null as string | null, changes: [] as RiskChange[] };

  async function tick() {
    try {
      const { ponds } = await run();
      for (const p of ponds) {
        // Look ahead: a risk peak at 04:00 should be known in the evening.
        const level = rank[p.peak.level] > rank[p.now.level] ? p.peak.level : p.now.level;
        const before = last.get(p.pondId) ?? 'ok';
        last.set(p.pondId, level);
        if (rank[level] > rank[before]) {
          const change = { pondId: p.pondId, at: p.generatedAt, from: before, to: level, reasons: (level === p.now.level ? p.now : p.peak).factors.map((f) => f.label) };
          status.changes = [change, ...status.changes].slice(0, 50);
          onRise(change);
        }
      }
      status.lastRunAt = Date.now();
      status.lastError = null;
    } catch (err) {
      status.lastError = (err as Error).message;
    }
  }

  void tick();
  const timer = setInterval(tick, MONITOR_INTERVAL_MS);
  return { status, stop: () => clearInterval(timer) };
}
