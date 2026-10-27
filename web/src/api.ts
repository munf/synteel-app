import type { Aeration, Batch, Behavior, Farm, Finding, Level, Log, LogData, Phase, Pond, Setting } from '../../server/src/domain.ts';
import type { Nowcast, NowcastPoint, RiskFactor, RiskLevel, SuggestedCheck } from '../../server/src/nowcast.ts';
import type { Draft, DraftField } from '../../server/src/ai.ts';
import type { LogSource } from '../../server/src/domain.ts';

export type { Aeration, Batch, Behavior, Farm, Finding, Level, Log, LogData, Phase, Pond, Setting };
export type { Nowcast, NowcastPoint, RiskFactor, RiskLevel, SuggestedCheck };
export type { Draft, DraftField, LogSource };

export type ReadingKey = keyof NonNullable<LogData['readings']>;

export interface Stage {
  weeks: [number, number];
  name: string;
  feed: string;
  mesh_mm: string;
  water: string;
}

export interface PondSummary extends Pond {
  batch: Batch | null;
  program: {
    week: number;
    stage: Stage | null;
    beyondProgram: boolean;
    estimatedAlive: number | null;
    totalDead: number;
    density: number | null;
  } | null;
  latest: Partial<Record<ReadingKey, { value: number; at: string }>>;
  lastLogAt: string | null;
  findings: Finding[];
  level: Level;
}

export interface NowcastState {
  generatedAt: number;
  weather: { available: boolean; error: string | null };
  ponds: Nowcast[];
}

export type PondProfile = Partial<Pick<Pond, 'name' | 'kind' | 'volumeL' | 'areaM2' | 'setting' | 'shaded' | 'aeration' | 'depthCm'>>;

export interface FarmState {
  farm: Farm | null;
  ponds: PondSummary[];
  today: string;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `Gagal (${res.status})`);
  return json as T;
}

export const api = {
  farm: () => call<FarmState>('GET', '/farm'),
  saveFarm: (farm: Partial<Farm>) => call<{ farm: Farm }>('PUT', '/farm', farm),
  addPond: (pond: PondProfile & { name: string }) => call<{ pond: PondSummary }>('POST', '/ponds', pond),
  updatePond: (id: number, pond: PondProfile) => call<{ pond: PondSummary }>('PUT', `/ponds/${id}`, pond),
  nowcast: () => call<NowcastState>('GET', '/nowcast'),
  pond: (id: number) => call<{ pond: PondSummary; logs: Log[] }>('GET', `/ponds/${id}`),
  startBatch: (pondId: number, batch: { phase: Phase; stockedAt: string; initialCount?: number }) =>
    call<{ pond: PondSummary }>('POST', `/ponds/${pondId}/batches`, batch),
  addLog: (pondId: number, data: LogData, source: LogSource = 'manual') =>
    call<{ log: Log; pond: PondSummary }>('POST', `/ponds/${pondId}/logs`, { ...data, source }),
  aiMode: () => call<{ mode: 'meta' | 'mock' | 'off' }>('GET', '/ai'),
};
