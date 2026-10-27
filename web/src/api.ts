import type { Batch, Behavior, Farm, Finding, Level, Log, LogData, Phase, Pond } from '../../server/src/domain.ts';

export type { Batch, Behavior, Farm, Finding, Level, Log, LogData, Phase, Pond };

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
  findings: Finding[];
  level: Level;
}

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
  addPond: (pond: { name: string; kind?: string; volumeL?: number; areaM2?: number }) => call<{ pond: PondSummary }>('POST', '/ponds', pond),
  pond: (id: number) => call<{ pond: PondSummary; logs: Log[] }>('GET', `/ponds/${id}`),
  startBatch: (pondId: number, batch: { phase: Phase; stockedAt: string; initialCount?: number }) =>
    call<{ pond: PondSummary }>('POST', `/ponds/${pondId}/batches`, batch),
  addLog: (pondId: number, data: LogData) => call<{ log: Log; pond: PondSummary }>('POST', `/ponds/${pondId}/logs`, data),
};
