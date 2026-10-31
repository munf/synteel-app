import type { Briefing, BriefingCheck } from '../../server/src/agent.ts';
import type { CountResult } from '../../server/src/sam.ts';
import type { CaseCheck, CaseQuestion, CaseRun, CaseView } from '../../server/src/cases.ts';
import type { Aeration, Batch, Behavior, Farm, Finding, Level, Log, LogData, Phase, Pond, Setting } from '../../server/src/domain.ts';
import type { Nowcast, NowcastPoint, RiskFactor, RiskLevel, SuggestedCheck } from '../../server/src/nowcast.ts';
import type { Limits } from '../../server/src/rules.ts';
import type { Outage, PowerBackup, PowerLevel, PowerNight, PowerReason } from '../../server/src/power.ts';
import type { Draft, DraftField } from '../../server/src/ai.ts';
import type { AutoFix, HistoryLog, LogEdit, QuotaState, ReadingField, RoundDraft, RoundIssue, RoundResult, SupportRequest, SupportTopic } from '../../server/src/contract.ts';
import type { NotebookCheck, NotebookField, NotebookPage, NotebookRow, NotebookSaveResult, NotebookSaveRow, NotebookValueField } from '../../server/src/contract.ts';
import type { LogSource } from '../../server/src/domain.ts';
import type { PondPhotoDraft, Place } from '../../server/src/pondphoto.ts';
import type { PondPattern } from '../../server/src/patterns.ts';
import type { Light, MeasureHour, ThermalModel, WaterColor } from '../../server/src/thermal.ts';
import { lang, t } from './i18n.ts';
import { getPrefs } from './prefs.ts';

export type { Aeration, Batch, Behavior, Farm, Finding, Level, Log, LogData, Phase, Pond, Setting };
export type { Limits, Nowcast, NowcastPoint, RiskFactor, RiskLevel, SuggestedCheck };
export type { Outage, PowerBackup, PowerLevel, PowerNight, PowerReason };
export type { Draft, DraftField, LogSource };
export type { Light, MeasureHour, Place, PondPattern, PondPhotoDraft, ThermalModel, WaterColor };

/** The pond page's water temperature card (GET /ponds/:id/temperature). */
export interface PondTemperature {
  model: ThermalModel;
  hours: MeasureHour[];
  pattern: PondPattern;
  /** The agent is writing the note in this language (it had one only in the other); poll until done. */
  running?: boolean;
  /** Who writes a new note on request, and how many requests the farm has left today. */
  ask: { mode: 'agent' | 'mock' | 'rules'; left: number };
}
export type { Briefing, BriefingCheck, CountResult };
export type { CaseCheck, CaseQuestion, CaseRun, CaseView };
export type { NotebookCheck, NotebookField, NotebookPage, NotebookRow, NotebookSaveResult, NotebookSaveRow, NotebookValueField };
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
    /** BMKG village forecast ("Sumber: BMKG"); null when the farm has no place yet. */
    bmkg?: BmkgView | null;
  };
  ponds: Nowcast[];
  /** Tonight's power-cut risk (power.ts). */
  power?: PowerNight | null;
}

/** A village (desa/kelurahan) BMKG forecasts for. */
export interface Region {
  code: string;
  desa: string;
  kecamatan: string;
  kabupaten: string;
  provinsi: string;
}

export interface BmkgView {
  source: 'BMKG';
  region: Region & { auto: boolean; km: number | null };
  steps: { t: number; code: number; desc: string; rain: number; wind: number; temp: number }[];
  error: string | null;
}

export type PondProfile = Partial<Pick<Pond, 'name' | 'kind' | 'volumeL' | 'areaM2' | 'setting' | 'shaded' | 'aeration' | 'depthCm' | 'nicknames' | 'waterColor' | 'light'>> & {
  /** Indoor / under a roof or shade net / open: sets the setting and the shade question together. */
  place?: Place | null;
};

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
  user: { id: number; phone: string; name: string; email?: string | null };
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

/** The pond's cover picture, or null for the pond icon. The key in the address makes a new picture a new address. */
export const coverUrl = (p: { id: number; cover?: string | null }) => (p.cover ? `${API}/ponds/${p.id}/cover?v=${encodeURIComponent(p.cover)}` : null);

export const isAuthError = (e: unknown) => e instanceof ApiError && e.status === 401;

// Sign-in routes answer 401 for a wrong PIN; that is not a lost session.
const PUBLIC = /^\/(auth\/(options|register|login|demo|invite|join)|support)\b/;
let sessionLost: (() => void) | null = null;
/** Called when any request finds the session gone (signed out elsewhere, PIN reset by the owner). */
export const onSessionLost = (fn: (() => void) | null) => {
  sessionLost = fn;
};

/** Sent with every request: the language the server answers in, and whether this phone agreed (Profil) to keep its photos and recordings on the server. */
export const baseHeaders = (): Record<string, string> => ({ 'x-lang': lang, ...(getPrefs().shareData ? { 'x-keep-media': '1' } : {}) });

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body === undefined ? baseHeaders() : { 'content-type': 'application/json', ...baseHeaders() },
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
  const res = await fetch(`${API}${path}`, { method: 'POST', body: form, headers: baseHeaders() });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) sessionLost?.();
    throw new ApiError(json.error ?? `${t('Gagal', 'Failed')} (${res.status})`, res.status, json.code);
  }
  return json as T;
}

export const api = {
  /** `email`: Daftar asks for an e-mail code and Lupa PIN works by e-mail. */
  authOptions: () => call<{ demo: boolean; email?: boolean }>('GET', '/auth/options'),
  sendCode: (purpose: 'register' | 'reset', phone: string, email?: string) => call<{ sentTo: string }>('POST', '/auth/code', { purpose, phone, email }),
  forgotPin: (phone: string, code: string, pin: string) => call<Me>('POST', '/auth/reset', { phone, code, pin }),
  me: () => call<Me>('GET', '/auth/me'),
  login: (phone: string, pin: string) => call<Me>('POST', '/auth/login', { phone, pin }),
  register: (name: string, phone: string, pin: string, email?: string, emailCode?: string) => call<Me>('POST', '/auth/register', { name, phone, pin, email, emailCode }),
  demo: () => call<Me>('POST', '/auth/demo'),
  invite: (code: string) => call<{ farmName: string; role: Role }>('GET', `/auth/invite/${encodeURIComponent(code)}`),
  join: (code: string, name: string, phone: string, pin: string) => call<Me>('POST', '/auth/join', { code, name, phone, pin }),
  logout: () => call<void>('POST', '/auth/logout'),
  switchFarm: (farmId: number) => call<Me>('POST', '/auth/switch', { farmId }),
  /** Signed in: join the farm of an invite code (after the person saw its name) and switch to it. */
  joinFarm: (code: string) => call<Me>('POST', '/farm/join', { code }),
  changePin: (pin: string, newPin: string) => call<void>('PUT', '/auth/pin', { pin, newPin }),
  /** Profil → Hapus akun: the account, and every farm it is the only owner of. */
  deleteAccount: (pin: string) => call<void>('POST', '/auth/delete', { pin }),
  members: () => call<{ members: Member[] }>('GET', '/farm/members'),
  createInvite: (role: Role) => call<{ code: string; role: Role; expiresInDays: number }>('POST', '/farm/invites', { role }),
  removeMember: (userId: number) => call<void>('DELETE', `/farm/members/${userId}`),
  resetPin: (userId: number) => call<{ pin: string }>('POST', `/farm/members/${userId}/pin`),
  farm: () => call<FarmState>('GET', '/farm'),
  saveFarm: (farm: Partial<Farm>) => call<{ farm: Farm }>('PUT', '/farm', farm),
  addPond: (pond: PondProfile & { name: string }) => call<{ pond: PondSummary }>('POST', '/ponds', pond),
  updatePond: (id: number, pond: PondProfile) => call<{ pond: PondSummary }>('PUT', `/ponds/${id}`, pond),
  nowcast: () => call<NowcastState>('GET', '/nowcast'),
  /** A pond photo → a draft profile the farmer checks. Nothing is saved. Uses the farm's AI quota. */
  pondPhoto: (image: Blob, pondId?: number) => {
    const form = new FormData();
    form.append('image', image, 'pond.jpg');
    if (pondId) form.append('pondId', String(pondId));
    return upload<{ draft: PondPhotoDraft }>('/pond-photo', form);
  },
  /** The pond photo kept as the pond's cover; only called when the farmer taps Simpan. Owners only. */
  setPondCover: (id: number, image: Blob) => {
    const form = new FormData();
    form.append('image', image, 'cover.jpg');
    return upload<{ pond: PondSummary }>(`/ponds/${id}/cover`, form);
  },
  removePondCover: (id: number) => call<{ pond: PondSummary }>('DELETE', `/ponds/${id}/cover`),
  pondTemperature: (id: number) => call<PondTemperature>('GET', `/ponds/${id}/temperature`),
  /** The pattern agent for this pond now, in the viewer's language. */
  pondPattern: (id: number) => call<{ pattern: PondPattern; left: number }>('POST', `/ponds/${id}/pattern`),
  pond: (id: number) => call<{ pond: PondSummary; logs: Log[] }>('GET', `/ponds/${id}`),
  startBatch: (pondId: number, batch: { phase: Phase; stockedAt: string; initialCount?: number }) =>
    call<{ pond: PondSummary }>('POST', `/ponds/${pondId}/batches`, batch),
  /** `link`: a dead-eel report from Masalah opens or adds to the pond's case; `recheck` answers its re-check. */
  addLog: (pondId: number, data: LogData, source: LogSource = 'manual', link: { report?: 'dead'; recheck?: 'better' | 'worse' } = {}) =>
    call<{ log: Log; pond: PondSummary }>('POST', `/ponds/${pondId}/logs`, { ...data, source, ...link }),
  aiMode: () => call<{ mode: 'meta' | 'mock' | 'off' }>('GET', '/ai'),
  /** `running`: the agent is writing it in this language (it had one only in the other); poll until done. */
  briefing: () => call<{ briefing: Briefing | null; running?: boolean }>('GET', '/briefing'),
  makeBriefing: () => call<{ briefing: Briefing }>('POST', '/briefing'),
  /** "Dengarkan": the Waspada text rewritten by Muse Spark as speech; the text as given without a model. */
  spoken: (text: string) => call<{ text: string; source: 'agent' | 'rules' }>('POST', '/briefing/spoken', { text }),
  countEels: (pondId: number, image: Blob) => {
    const form = new FormData();
    form.append('image', image, 'basin.jpg');
    return upload<{ result: CountResult; mock?: boolean }>(`/ponds/${pondId}/count`, form);
  },
  // Dead-eel cases: open ones for Beranda; with a pond also its closed ones.
  cases: (pondId?: number) => call<{ cases: CaseView[] }>('GET', `/cases${pondId ? `?pond=${pondId}` : ''}`),
  answerCase: (id: number, answers: { q: string; a: string }[]) => call<{ case: CaseView }>('POST', `/cases/${id}/answers`, { answers }),
  noDeadToday: (id: number) => call<{ case: CaseView }>('POST', `/cases/${id}/nodead`),
  closeCase: (id: number) => call<{ case: CaseView }>('POST', `/cases/${id}/close`),
  knowledge: () => call<{ emergencies: { emergencies: Emergency[] } }>('GET', '/knowledge'),

  // Power cuts and the BMKG region (power.ts, bmkg.ts).
  setPowerBackup: (powerBackup: PowerBackup) => call<{ farm: Farm }>('PUT', '/farm/power', { powerBackup }),
  searchRegion: (q: string) => call<{ results: Region[] }>('GET', `/wilayah?q=${encodeURIComponent(q)}`),
  /** null: back to the village nearest the farm. */
  setRegion: (code: string | null) => call<{ farm: Farm; region: (Region & { auto: boolean }) | null }>('PUT', '/farm/wilayah', { code }),
  openOutage: () => call<{ outage: Outage | null; backup: PowerBackup | null }>('GET', '/outages/open'),
  startOutage: (minutesAgo = 0) => call<{ outage: Outage; backup: PowerBackup | null }>('POST', '/outages', { minutesAgo }),
  moveOutageStart: (id: number, minutesAgo: number) => call<{ outage: Outage; backup: PowerBackup | null }>('PUT', `/outages/${id}`, { minutesAgo }),
  endOutage: (id: number) => call<{ outage: Outage; backup: PowerBackup | null }>('POST', `/outages/${id}/end`),

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
  /** `days`: how far back (14 by default; older notebook pages need more). */
  history: (pondId: number, days?: number) => call<{ logs: HistoryLog[]; days: number }>('GET', `/ponds/${pondId}/history${days ? `?days=${days}` : ''}`),
  /** Rows the farmer checked from notebook photos. Skips a pond+date that already has a record unless asked. */
  /** `savedBefore`: log ids an earlier save of the same import made (they do not make its other rows "already recorded"). */
  saveNotebook: (rows: NotebookSaveRow[], savedBefore: number[] = []) => call<NotebookSaveResult>('POST', '/notebook/save', { rows, savedBefore }),
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
