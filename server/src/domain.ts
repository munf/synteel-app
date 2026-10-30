export type Phase = 'glass_eel' | 'elver';
export type Level = 'ok' | 'info' | 'warning' | 'critical';
export type Behavior = 'normal' | 'surfacing' | 'gathering_inlet' | 'not_eating' | 'lethargic';

export interface Farm {
  name: string;
  locationName: string | null;
  lat: number | null;
  lon: number | null;
  timezone: string;
  /** "Cadangan listrik" (power.ts): what keeps the aerators running in a power cut; null = not answered. */
  powerBackup?: 'genset' | 'battery' | 'none' | null;
  /** BMKG forecast village (Kemendagri code) picked by the owner; null = nearest to the coordinates. */
  adm4?: string | null;
}

export type Setting = 'outdoor' | 'indoor';
export type Aeration = 'full' | 'partial' | 'none';

export interface Pond {
  id: number;
  name: string;
  kind: string | null;
  volumeL: number | null;
  areaM2: number | null; // pond floor area, for stocking density
  // Profile used by the water temperature model and the oxygen risk estimate.
  setting: Setting | null;
  shaded: boolean | null; // paranet or roof over an outdoor pond
  aeration: Aeration | null; // 'full' = 24 hours a day
  depthCm: number | null;
  /** From a pond photo or picked by hand: water colour and light at the pond (thermal.ts priors, husbandry notes). */
  waterColor?: 'clear' | 'green' | 'brown' | 'cloudy' | null;
  light?: 'bright' | 'dim' | 'dark' | null;
  /** The cover picture kept from the pond photo (captures.ts coverStore key); null shows the pond icon. */
  cover?: string | null;
  /** Other names farmers use for the pond ("kolam dekat pintu"), for the voice round. */
  nicknames: string[];
}

export interface Batch {
  id: number;
  pondId: number;
  phase: Phase;
  stockedAt: string; // YYYY-MM-DD, farm-local
  initialCount: number | null;
}

// One farmer log. Every field is optional so the same shape fits a quick manual
// reading, a voice note or a photo after the AI has structured it.
export interface LogData {
  readings?: Partial<Record<'temperature' | 'ph' | 'tds' | 'do' | 'tan' | 'no2', number>>;
  feeding?: { leftover?: 'none' | 'little' | 'much' };
  mortality?: number;
  behavior?: Behavior[];
  water?: { color?: 'clear' | 'green' | 'brown' | 'cloudy'; smell?: 'normal' | 'foul' };
  waterChangePct?: number;
  /** What the farmer saw at the aerator / air stones during this check. */
  aeration?: 'on' | 'weak' | 'off';
  note?: string;
}

/**
 * 'sensor': written by a linked Synteel device (devices.ts), never sent by the app.
 * 'notebook': copied from a photo of the farmer's handwritten notebook (notebook.ts), checked row by row.
 */
export type LogSource = 'manual' | 'voice' | 'photo' | 'video' | 'sensor' | 'notebook';
/** What the app may send as a log's source. */
export const LOG_SOURCES: LogSource[] = ['manual', 'voice', 'photo', 'video'];

export type ReadingKey = keyof NonNullable<LogData['readings']>;
/** Plausible ranges: anything outside is a typo or a misread display, never a real reading. */
export const READING_LIMITS: Record<ReadingKey, [number, number]> = {
  temperature: [0, 45], ph: [0, 14], tds: [0, 50000], do: [0, 30], tan: [0, 50], no2: [0, 50],
};

export interface Log {
  id: number;
  pondId: number;
  batchId: number | null;
  loggedAt: string; // ISO timestamp
  source: LogSource;
  data: LogData;
}

export interface Finding {
  id: string;
  level: Exclude<Level, 'ok'>;
  title: string;
  detail: string;
  actions: string[];
  source: string;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

// Calendar date (YYYY-MM-DD) of an instant in the farm's timezone.
export function localDate(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(at);
}

export function batchWeek(batch: Batch, now: Date, timezone: string): number {
  const days = (Date.parse(localDate(now, timezone)) - Date.parse(batch.stockedAt)) / DAY_MS;
  return Math.max(0, Math.floor(days / 7));
}
