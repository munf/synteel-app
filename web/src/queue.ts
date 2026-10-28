// Voice-round recordings kept on the phone (IndexedDB) until they are read and every pond in them
// is checked. Ponds often have no signal, and the farm's AI quota can run out mid-morning: the
// recording is never lost, it is read when it can be. Photo/video captures of one pond wait in
// capture/queue.ts; retryAll() sends both.
import { ApiError, api, type AutoFix, type LogData, type RoundIssue, type RoundResult } from './api.ts';
import { queue as captures, Retryable } from './capture/queue.ts';
import { Offline, sendCapture, sendRound, type Progress } from './upload.ts';

/**
 * new: just recorded, being read now · waiting: no signal / no quota / AI off · ready: read, to check ·
 * failed: the server refused it · cut: recording interrupted (call, app closed), the farmer decides.
 */
export type ClipStatus = 'new' | 'waiting' | 'ready' | 'failed' | 'cut';
export type WaitReason = 'offline' | 'quota' | 'ai';

/** One pond's draft as the farmer checks it on the review screen. */
export interface RoundItem {
  key: string;
  pondId: number | null;
  heardName: string;
  suggestions: number[];
  quote: string;
  /** The values, with the farmer's answers applied. */
  data: LogData;
  autoFixed: AutoFix[];
  issues: RoundIssue[];
  /** One flag per issue: answered. */
  fixed: boolean[];
  /** Had something to check (an issue or no pond): shown under "Perlu dicek", else folded. */
  review: boolean;
  /** Pond picked by the farmer (offer to remember the name). */
  picked: boolean;
  remember: 'ask' | 'yes' | 'no';
  saved: boolean;
}

export interface Clip {
  id: string;
  createdAt: number;
  seconds: number;
  audio: Blob;
  status: ClipStatus;
  reason?: WaitReason;
  /** A transcript kept from earlier: read with roundText, nothing to upload. */
  transcript?: string;
  result?: RoundResult;
  /** Review progress, so a half-checked round reopens where it was. */
  items?: RoundItem[];
  error?: string;
}

// ---------- storage: IndexedDB, or memory when the browser refuses it (private mode) ----------

const DB = 'synteel-rounds';
const STORE = 'clips';
let memory: Map<string, Clip> | null = null;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest, mem: (m: Map<string, Clip>) => T): Promise<T> {
  if (!memory) {
    try {
      const db = await open();
      return await new Promise<T>((resolve, reject) => {
        const req = fn(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      });
    } catch {
      memory = new Map(); // this session only
    }
  }
  return mem(memory);
}

const listeners = new Set<() => void>();
/** Re-render when recordings are added, read or removed. Returns the unsubscribe. */
export function onClips(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
export const notify = () => listeners.forEach((l) => l());

export const clips = {
  list: async () => (await run<Clip[]>('readonly', (s) => s.getAll(), (m) => [...m.values()])).sort((a, b) => a.createdAt - b.createdAt),
  get: (id: string) => run<Clip | undefined>('readonly', (s) => s.get(id), (m) => m.get(id)),
  put: async (c: Clip) => {
    await run('readwrite', (s) => s.put(c), (m) => m.set(c.id, c));
    notify();
  },
  remove: async (id: string) => {
    await run('readwrite', (s) => s.delete(id), (m) => m.delete(id));
    notify();
  },
};

export const newId = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

// ---------- reading ----------

/** Why a recording has to wait, or null when the error is a real refusal. */
export function waitReason(err: unknown): WaitReason | null {
  if (err instanceof Offline) return 'offline';
  if (err instanceof ApiError && err.code === 'ai_quota') return 'quota';
  if (err instanceof ApiError && (err.code === 'ai_unavailable' || err.status >= 500 || err.status === 408)) return 'ai';
  return null;
}

/** Clips being read right now (by the review screen), so retryAll does not send them twice. */
export const reading = new Set<string>();

/** Send one recording. Waiting reasons keep it on the phone; a refusal marks it failed. */
export async function readClip(c: Clip, onProgress?: (p: Progress) => void): Promise<Clip> {
  reading.add(c.id);
  let next: Clip;
  try {
    const { round } = c.transcript ? await api.roundText(c.transcript) : await sendRound(c.audio, onProgress);
    next = { ...c, status: 'ready', reason: undefined, error: undefined, result: round, items: undefined };
  } catch (err) {
    const reason = waitReason(err);
    // Without signal a typed transcript also fails as a plain fetch error.
    const offline = !reason && err instanceof TypeError;
    next = reason || offline ? { ...c, status: 'waiting', reason: reason ?? 'offline' } : { ...c, status: 'failed', error: (err as Error).message };
  } finally {
    reading.delete(c.id);
  }
  await clips.put(next).catch(() => {});
  return next;
}

let retrying = false;

/** Read what waits on this phone: on app open (Catat) and whenever signal returns. */
export async function retryAll() {
  if (retrying || !navigator.onLine) return;
  retrying = true;
  try {
    const stale = Date.now() - 5 * 60_000; // a "new" clip whose reading was cut off by closing the app
    for (const c of await clips.list().catch(() => [])) {
      if (reading.has(c.id) || !(c.status === 'waiting' || (c.status === 'new' && c.createdAt < stale))) continue;
      const done = await readClip(c);
      if (done.status === 'waiting' && done.reason !== 'quota') break; // still no signal, or AI off
    }
    for (const job of (await captures.list().catch(() => [])).filter((j) => j.status === 'pending')) {
      try {
        await captures.put(await sendCapture(job));
      } catch (err) {
        if (err instanceof Retryable) break;
      }
    }
  } finally {
    retrying = false;
    notify();
  }
}

if (typeof window !== 'undefined') window.addEventListener('online', () => void retryAll());

// ---------- audio ----------

/** "1:42" */
export const fmtLen = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * Join two 16-bit mono WAV recordings (from voiceToWav) so a recording continued after a call is
 * read as one. Returns null when either is not such a WAV (the browser could not convert it).
 */
export async function joinWav(a: Blob, b: Blob): Promise<Blob | null> {
  const [x, y] = await Promise.all([a.arrayBuffer(), b.arrayBuffer()]);
  const head = (buf: ArrayBuffer) => {
    const v = new DataView(buf);
    const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
    return buf.byteLength >= 44 && tag(0) === 'RIFF' && tag(36) === 'data' ? v.getUint32(24, true) : null;
  };
  const rate = head(x);
  if (rate === null || rate !== head(y)) return null;
  const data = x.byteLength - 44 + (y.byteLength - 44);
  const out = new Uint8Array(44 + data);
  out.set(new Uint8Array(x, 0, 44));
  out.set(new Uint8Array(x, 44), 44);
  out.set(new Uint8Array(y, 44), x.byteLength);
  const v = new DataView(out.buffer);
  v.setUint32(4, 36 + data, true);
  v.setUint32(40, data, true);
  return new Blob([out], { type: 'audio/wav' });
}
