// Captures wait on the phone (IndexedDB) until there is signal. Ponds often have none.
import { API, baseHeaders, type Draft } from '../api.ts';
import { t } from '../i18n.ts';

export type CaptureKind = 'photo' | 'voice' | 'video';

export interface Job {
  id: string;
  pondId: number;
  pondName: string;
  kind: CaptureKind;
  field?: 'temperature' | 'ph' | 'tds';
  images: Blob[];
  audio?: Blob;
  createdAt: number;
  status: 'pending' | 'ready' | 'failed';
  draft?: Draft;
  error?: string;
}

const DB = 'synteel';
const STORE = 'captures';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const queue = {
  put: (job: Job) => tx('readwrite', (s) => s.put(job)),
  remove: (id: string) => tx('readwrite', (s) => s.delete(id)),
  list: async () => ((await tx('readonly', (s) => s.getAll())) as Job[]).sort((a, b) => a.createdAt - b.createdAt),
};

export class Retryable extends Error {}

/** Send one capture to the server. Network trouble keeps it queued; a refusal does not. */
export async function process(job: Job): Promise<Job> {
  const form = new FormData();
  form.append('kind', job.kind);
  if (job.field) form.append('field', job.field);
  job.images.forEach((img, i) => form.append('image', img, `image-${i}.jpg`));
  if (job.audio) form.append('audio', job.audio, job.audio.type.includes('wav') ? 'audio.wav' : 'audio.webm');
  let res: Response;
  try {
    res = await fetch(`${API}/ponds/${job.pondId}/capture`, { method: 'POST', body: form, headers: baseHeaders() });
  } catch {
    throw new Retryable(t('Belum ada sinyal', 'No signal yet'));
  }
  const body = await res.json().catch(() => ({}));
  if (res.status >= 500 || res.status === 408) throw new Retryable(body.error ?? t(`Server sibuk (${res.status})`, `Server busy (${res.status})`));
  if (!res.ok) return { ...job, status: 'failed', error: body.error ?? `Gagal (${res.status})` };
  return { ...job, status: 'ready', draft: body.draft };
}
