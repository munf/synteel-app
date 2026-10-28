// Shapes shared by the server and the web app for the features added in the second design round:
// voice rounds over many ponds, record history with corrections, the AI quota page and support.
import type { Level, LogData, LogSource } from './domain.ts';

// ---------- Voice round: one recording that names many ponds ----------

export type ReadingField = 'temperature' | 'ph' | 'tds';

/** Something in a pond's draft the farmer must look at before saving. */
export type RoundIssue =
  /** A number that cannot be right and has no single obvious fix (e.g. "suhu 9"). */
  | { kind: 'implausible'; field: ReadingField; heard: string; suggestion: number | null; note: string }
  /** The same pond and field said twice with different values; the last one is preselected. */
  | { kind: 'twice'; field: ReadingField; values: number[] }
  /** Part of what was said about this pond could not be understood. */
  | { kind: 'unclear'; text: string };

/** A number that was impossible as heard and was corrected without asking (pH 74 → 7,4). Shown, not asked. */
export interface AutoFix {
  field: ReadingField;
  heard: string;
  value: number;
}

export interface RoundDraft {
  /** null when the pond could not be matched: the farmer picks it. */
  pondId: number | null;
  /** How the pond was named in the recording ("Kolam B", "kolam pojok"). */
  heardName: string;
  /** Ponds to suggest when pondId is null, best first. */
  suggestions: number[];
  data: LogData;
  issues: RoundIssue[];
  autoFixed: AutoFix[];
  /** The words this draft came from, for the farmer to check. */
  quote: string;
}

export interface RoundResult {
  transcript: string;
  drafts: RoundDraft[];
  /** Numbers or remarks said before any pond name, or that belong to no pond. */
  loose: { quote: string; data: LogData } | null;
  /** True when nothing usable was understood at all. */
  empty: boolean;
  model: string;
  mode: 'meta' | 'mock';
}

// ---------- Record history and corrections ----------

export interface LogEdit {
  at: string; // ISO
  byName: string;
  /** Plain words: "suhu 28,9 → 29,8", "dipindahkan dari Kolam C". */
  text: string;
}

export interface HistoryLog {
  id: number;
  pondId: number;
  loggedAt: string; // ISO
  source: LogSource;
  data: LogData;
  /** null for records made before accounts existed. */
  by: { id: number; name: string; role: 'owner' | 'worker' } | null;
  edits: LogEdit[];
  /** Whether the signed-in person may change, move or delete it now. */
  canEdit: boolean;
  /** Why not, in plain words; null when canEdit. */
  lockReason: string | null;
  /** Until when the maker may still change it (ISO); null for the owner or when locked. */
  editableUntil: string | null;
  level: Level;
}

// ---------- AI quota ----------

export interface QuotaState {
  /** Reads per day for the whole farm, including today's earned bonus. */
  cap: number;
  base: number;
  bonus: number;
  used: number;
  left: number;
  /** Next reset (local midnight), ISO. */
  resetsAt: string;
  /** null when the server has no per-farm cap (unlimited). */
  unlimited: boolean;
  members: { userId: number; name: string; role: 'owner' | 'worker'; used: number }[];
  earn: {
    /** +2 today once at least one photo and one video were sent today. */
    photoVideo: { photo: boolean; video: boolean; bonus: number; earned: boolean };
    /** +10 on each 7-day streak milestone day. */
    streak: { days: number; nextAt: number; bonus: number };
  };
}

// ---------- Support ----------

export type SupportTopic = 'pin' | 'catat' | 'waspada' | 'jatah' | 'lain';

export interface SupportRequest {
  topic: SupportTopic;
  message: string;
  /** WhatsApp number for the reply. */
  replyPhone: string;
  /** When signed out (forgot PIN): the phone number of the account. */
  accountPhone?: string;
  /** Device and app version, only when the person ticked the box. */
  device?: string;
}
