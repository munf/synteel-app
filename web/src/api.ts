import type { Briefing, BriefingCheck } from '../../server/src/agent.ts';
import type { CountResult } from '../../server/src/sam.ts';
import type { Aeration, Batch, Behavior, Farm, Finding, Level, Log, LogData, Phase, Pond, Setting } from '../../server/src/domain.ts';
import type { Nowcast, NowcastPoint, RiskFactor, RiskLevel, SuggestedCheck } from '../../server/src/nowcast.ts';
import type { Limits } from '../../server/src/rules.ts';
import type { Draft, DraftField } from '../../server/src/ai.ts';
import type { AutoFix, HistoryLog, LogEdit, QuotaState, ReadingField, RoundDraft, RoundIssue, RoundResult, SupportRequest, SupportTopic } from '../../server/src/contract.ts';
import type { LogSource } from '../../server/src/domain.ts';
import { lang, t } from './i18n.ts';

export type { Aeration, Batch, Behavior, Farm, Finding, Level, Log, LogData, Phase, Pond, Setting };
export type { Limits, Nowcast, NowcastPoint, RiskFactor, RiskLevel, SuggestedCheck };
export type { Draft, DraftField, LogSource };
export type { Briefing, BriefingCheck, CountResult };
export type { AutoFix, HistoryLog, LogEdit, QuotaState, ReadingField, RoundDraft, RoundIssue, RoundResult, SupportRequest, SupportTopic };

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
  /** The Synteel device that sends this pond's readings, if one is linked. */
  device: PondDevice | null;
  /** Made for a simulated device: holds simulated data only. */
  simulated: boolean;
}

export interface PondDevice {
  code: string;
  kind: string;
  name: string;
  /** Which part of the device feeds this pond ("tank1"), and its name ("Tangki 1"). */
  unit: string;
  unitName: string;
  simulated: boolean;
}

/** A device looked up by its code, before or after linking. */
export interface DeviceInfo {
  code: string;
  kind: string;
  name: string;
  /** Start of the pond names it creates: "Gen0", "RDF Gen0". */
  short: string;
  simulated: boolean;
  scenario: string;
  units: { id: string; name: string }[];
  /** What it measures, in words. */
  sensors: string[];
  state: unknown;
  linked: boolean;
  linkedHere: boolean;
  linkedElsewhere: boolean;
  ponds: Pond[];
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

export type PondProfile = Partial<Pick<Pond, 'name' | 'kind' | 'volumeL' | 'areaM2' | 'setting' | 'shaded' | 'aeration' | 'depthCm' | 'nicknames'>>;

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
const PUBLIC = /^\/(auth\/(options|register|login|demo|invite|join)|support)\b/;
let sessionLost: (() => void) | null = null;
/** Called when any request finds the session gone (signed out elsewhere, PIN reset by the owner). */
export const onSessionLost = (fn: (() => void) | null) => {
  sessionLost = fn;
};

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body === undefined ? { 'x-lang': lang } : { 'content-type': 'application/json', 'x-lang': lang },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !PUBLIC.test(path)) sessionLost?.();
    throw new ApiError(json.error ?? `${t('Gagal', 'Failed')} (${res.status})`, res.status, json.code);
  }
  return json as T;
}

async function upload<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(`${API}${path}`, { method: 'POST', body: form, headers: { 'x-lang': lang } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) sessionLost?.();
    throw new ApiError(json.error ?? `${t('Gagal', 'Failed')} (${res.status})`, res.status, json.code);
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
  /** Signed in: join the farm of an invite code (after the person saw its name) and switch to it. */
  joinFarm: (code: string) => call<Me>('POST', '/farm/join', { code }),
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
  countEels: (pondId: number, image: Blob) => {
    const form = new FormData();
    form.append('image', image, 'basin.jpg');
    return upload<{ result: CountResult; mock?: boolean }>(`/ponds/${pondId}/count`, form);
  },
  knowledge: () => call<{ emergencies: { emergencies: Emergency[] } }>('GET', '/knowledge'),

  // Voice round: one recording that names many ponds → one draft per pond. Nothing is saved here.
  round: (audio: Blob) => {
    const form = new FormData();
    form.append('audio', audio, audio.type.includes('wav') ? 'round.wav' : 'round.webm');
    return upload<{ round: RoundResult }>('/round', form);
  },
  /** Same, from text (typed, or a transcript kept from an offline recording). */
  roundText: (transcript: string) => call<{ round: RoundResult }>('POST', '/round/text', { transcript }),
  /** Teach the voice reader another name for a pond ("kolam pojok"). */
  addNickname: (pondId: number, nickname: string) => call<{ pond: PondSummary }>('POST', `/ponds/${pondId}/nicknames`, { nickname }),

  // Record history and corrections (within 24 hours by whoever made it; the owner always).
  history: (pondId: number) => call<{ logs: HistoryLog[] }>('GET', `/ponds/${pondId}/history`),
  editLog: (logId: number, data: LogData) => call<{ log: HistoryLog }>('PUT', `/logs/${logId}`, data),
  moveLog: (logId: number, pondId: number) => call<{ log: HistoryLog }>('POST', `/logs/${logId}/move`, { pondId }),
  deleteLog: (logId: number) => call<void>('DELETE', `/logs/${logId}`),
  restoreLog: (logId: number) => call<{ log: HistoryLog }>('POST', `/logs/${logId}/restore`),

  quota: () => call<QuotaState>('GET', '/quota'),
  /** Speech → text for a help message (signed in; free, not counted against the quota). */
  transcribe: (audio: Blob) => {
    const form = new FormData();
    form.append('audio', audio, audio.type.includes('wav') ? 'pesan.wav' : 'pesan.webm');
    return upload<{ text: string }>('/transcribe', form);
  },
  // Synteel devices ("Hubungkan alat"): look up a code, link it (owner), unlink it (owner).
  device: (code: string) => call<{ device: DeviceInfo }>('GET', `/devices/${encodeURIComponent(code)}`),
  linkDevice: (code: string) => call<{ ponds: PondSummary[] }>('POST', `/devices/${encodeURIComponent(code)}/link`),
  unlinkDevice: (code: string) => call<void>('POST', `/devices/${encodeURIComponent(code)}/unlink`),

  /** Works signed in or out (an owner who forgot the PIN). */
  support: (req: SupportRequest) => call<{ ticket: string }>('POST', '/support', req),
};
