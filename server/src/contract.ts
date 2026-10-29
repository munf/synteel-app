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
  /** WhatsApp number for the reply (the app's help screen). */
  replyPhone?: string;
  /** Or an e-mail address for the reply (the eel.synt.fun contact form). One of the two is required. */
  replyEmail?: string;
  /** When signed out (forgot PIN): the phone number of the account. */
  accountPhone?: string;
  /** Device and app version, only when the person ticked the box. */
  device?: string;
}

// ---------- Notebook import: a photo of a handwritten notebook page → rows the farmer checks ----------

/** The cells of one notebook row that can be flagged. */
export type NotebookField = 'date' | 'pond' | 'temperature' | 'ph' | 'tds' | 'dead';
export type NotebookValueField = 'temperature' | 'ph' | 'tds' | 'dead';

/** A cell the farmer must look at again ("cek lagi"). Its value is left empty until the farmer fills it. */
export interface NotebookCheck {
  field: NotebookField;
  /**
   * unsure: hard to read, or the AI gave a number for an empty cell (never used).
   * odd: readable but not a plausible value (pH 74, temperature 9).
   * unknown: the pond name is not one of the farm's ponds.
   * future: the date written is after today.
   */
  kind: 'unsure' | 'odd' | 'unknown' | 'future';
  /** The cell as written on the page ("7,?", "74", "kolam pojok"), '' when blank. */
  written: string;
  /** A value the farmer can accept with one tap: a number, or YYYY-MM-DD for a date. Never filled in by itself. */
  suggestion: number | string | null;
  /** Plain words: why this cell needs a look. */
  note: string;
}

export interface NotebookRow {
  key: string;
  /** 1-based photo number in this import. */
  page: number;
  /** YYYY-MM-DD, farm-local; null until the farmer picks it. */
  date: string | null;
  dateWritten: string;
  /** No year on the page: the most recent past date with that day and month was taken. */
  yearGuessed: boolean;
  /** HH:MM farm-local when the page has a time (or pagi/sore); null otherwise. */
  time: string | null;
  pondId: number | null;
  pondWritten: string;
  /** Ponds to offer when pondId is null, best first. */
  suggestions: number[];
  values: Partial<Record<NotebookValueField, number>>;
  /** Feed and other notes as written. */
  note: string | null;
  checks: NotebookCheck[];
}

export interface NotebookPage {
  rows: NotebookRow[];
  /** Reading problems the model reported ("tulisan pudar"), in the farmer's language. */
  problems: string[];
  /** Ponds that already have records, by date (YYYY-MM-DD → pond ids), for the dates on this page. */
  recorded: Record<string, number[]>;
  model: string;
  mode: 'meta' | 'mock';
}

/** One checked row the farmer confirmed. */
export interface NotebookSaveRow {
  key: string;
  pondId: number;
  date: string;
  time: string | null;
  data: LogData;
  /** The pond already has a record on this date and the farmer chose to save this one too. */
  alsoIfRecorded?: boolean;
}

export interface NotebookSaveResult {
  saved: { key: string; logId: number }[];
  /** recorded: the pond already has a record that day; repeat: the same row twice in this import. */
  skipped: { key: string; reason: 'recorded' | 'repeat' }[];
}
