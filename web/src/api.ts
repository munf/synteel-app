import type { Briefing, BriefingCheck } from '../../server/src/agent.ts';
import type { Aeration, Batch, Behavior, Farm, Finding, Level, Log, LogData, Phase, Pond, Setting } from '../../server/src/domain.ts';
import type { Nowcast, NowcastPoint, RiskFactor, RiskLevel, SuggestedCheck } from '../../server/src/nowcast.ts';
import type { Limits } from '../../server/src/rules.ts';
import type { Draft, DraftField } from '../../server/src/ai.ts';
import type { LogSource } from '../../server/src/domain.ts';

export type { Aeration, Batch, Behavior, Farm, Finding, Level, Log, LogData, Phase, Pond, Setting };
export type { Limits, Nowcast, NowcastPoint, RiskFactor, RiskLevel, SuggestedCheck };
export type { Draft, DraftField, LogSource };
export type { Briefing, BriefingCheck };

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
  limits: Partial<Record<'temperature' | 'ph' | 'tds', Limits>>;
  status: Partial<Record<'temperature' | 'ph' | 'tds', Level>>;
  lastLogAt: string | null;
  findings: Finding[];
  level: Level;
}

export interface NowcastState {
  generatedAt: number;
  weather: {
    available: boolean;
    error: string | null;
    place: string | null;
    hours: { t: number; airTemp: number; rain: number; cloud: number }[];
  };
  ponds: Nowcast[];
}

export type PondProfile = Partial<Pick<Pond, 'name' | 'kind' | 'volumeL' | 'areaM2' | 'setting' | 'shaded' | 'aeration' | 'depthCm'>>;

export interface Emergency {
  id: string;
  trigger: string;
  operator_actions: string[];
}

export type Role = 'owner' | 'worker';

export interface FarmState {
  farm: Farm | null;
  ponds: PondSummary[];
  today: string;
  /** Days in a row with at least one measured reading. */
  streak: number;
  /** The signed-in person's role on this farm; null before a farm exists. */
  role: Role | null;
}

export interface FarmRef {
  id: number;
  name: string;
  role: Role;
}

export interface Me {
  user: { id: number; phone: string; name: string };
  farm: FarmRef | null;
  farms: FarmRef[];
  demo: boolean;
}

export interface Member {
  id: number;
  name: string;
  role: Role;
  /** Only sent to owners. */
  phone?: string;
  me: boolean;
}

// Relative to the page, so the app also works under a sub-path such as eel.synt.fun/preview/.
export const API = `${import.meta.env.BASE_URL}api`;

/** An error from the server, with its Indonesian message and the HTTP status. */
export class ApiError extends Error {
  status: number;
  code: string | undefined;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export const isAuthError = (e: unknown) => e instanceof ApiError && e.status === 401;

// Sign-in routes answer 401 for a wrong PIN; that is not a lost session.
const PUBLIC = /^\/auth\/(options|register|login|demo|invite|join)\b/;
let sessionLost: (() => void) | null = null;
/** Called when any request finds the session gone (signed out elsewhere, PIN reset by the owner). */
export const onSessionLost = (fn: (() => void) | null) => {
  sessionLost = fn;
};

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !PUBLIC.test(path)) sessionLost?.();
    throw new ApiError(json.error ?? `Gagal (${res.status})`, res.status, json.code);
  }
  return json as T;
}

export const api = {
  authOptions: () => call<{ demo: boolean }>('GET', '/auth/options'),
  me: () => call<Me>('GET', '/auth/me'),
  login: (phone: string, pin: string) => call<Me>('POST', '/auth/login', { phone, pin }),
  register: (name: string, phone: string, pin: string) => call<Me>('POST', '/auth/register', { name, phone, pin }),
  demo: () => call<Me>('POST', '/auth/demo'),
  invite: (code: string) => call<{ farmName: string; role: Role }>('GET', `/auth/invite/${encodeURIComponent(code)}`),
  join: (code: string, name: string, phone: string, pin: string) => call<Me>('POST', '/auth/join', { code, name, phone, pin }),
  logout: () => call<void>('POST', '/auth/logout'),
  switchFarm: (farmId: number) => call<Me>('POST', '/auth/switch', { farmId }),
  changePin: (pin: string, newPin: string) => call<void>('PUT', '/auth/pin', { pin, newPin }),
  members: () => call<{ members: Member[] }>('GET', '/farm/members'),
  createInvite: (role: Role) => call<{ code: string; role: Role; expiresInDays: number }>('POST', '/farm/invites', { role }),
  removeMember: (userId: number) => call<void>('DELETE', `/farm/members/${userId}`),
  resetPin: (userId: number) => call<{ pin: string }>('POST', `/farm/members/${userId}/pin`),
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
  briefing: () => call<{ briefing: Briefing | null }>('GET', '/briefing'),
  makeBriefing: () => call<{ briefing: Briefing }>('POST', '/briefing'),
  knowledge: () => call<{ emergencies: { emergencies: Emergency[] } }>('GET', '/knowledge'),
};
