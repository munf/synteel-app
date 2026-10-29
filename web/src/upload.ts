
// Uploads with progress. On weak signal a video or a long round recording can take minutes:
// the farmer sees how far it got instead of a frozen screen. Same errors as api.ts (ApiError).
import { API, ApiError, api, type Draft, type NotebookPage, type RoundResult } from './api.ts';
import { lang, t } from './i18n.ts';
import { Retryable, type Job } from './capture/queue.ts';

/** No connection at all: keep the recording and try again when there is signal. */
export class Offline extends Error {}

export interface Progress {
  sent: number;
  total: number;
  /** When the upload started (ms), to estimate the time left. */
  started: number;
}

/** Seconds left at the speed so far; null until there is enough to tell. */
export function secondsLeft(p: Progress, now = Date.now()): number | null {
  const elapsed = (now - p.started) / 1000;
  if (p.sent <= 0 || elapsed < 1) return null;
  return Math.max(0, Math.round((p.total - p.sent) / (p.sent / elapsed)));
}

function post<T>(path: string, form: FormData, onProgress?: (p: Progress) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const started = Date.now();
    xhr.open('POST', `${API}${path}`);
    // The server answers (drafts, errors) in the chosen language, as for every api.ts request.
    xhr.setRequestHeader('x-lang', lang);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.({ sent: e.loaded, total: e.total, started });
    xhr.onerror = () => reject(new Offline(t('Belum ada sinyal', 'No signal yet')));
    xhr.ontimeout = () => reject(new Offline(t('Sinyal terputus', 'Signal lost')));
    xhr.onload = () => {
      let json: { error?: string; code?: string } = {};
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        // an empty or HTML body (proxy error): the status says enough
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(json as T);
      // Let api.ts notice the lost session the usual way (back to sign-in).
      if (xhr.status === 401) api.me().catch(() => {});
      reject(new ApiError(json.error ?? t(`Gagal (${xhr.status})`, `Failed (${xhr.status})`), xhr.status, json.code));
    };
    xhr.send(form);
  });
}

/** Voice round: one recording that names many ponds → one draft per pond. Nothing is saved. */
export function sendRound(audio: Blob, onProgress?: (p: Progress) => void) {
  if (!navigator.onLine) return Promise.reject(new Offline(t('Belum ada sinyal', 'No signal yet')));
  const form = new FormData();
  form.append('audio', audio, audio.type.includes('wav') ? 'round.wav' : 'round.webm');
  return post<{ round: RoundResult }>('/round', form, onProgress);
}

/** Like capture/queue.ts process(), with progress, and an empty AI quota keeps the job queued too. */
export async function sendCapture(job: Job, onProgress?: (p: Progress) => void): Promise<Job> {
  if (!navigator.onLine) throw new Retryable(t('Belum ada sinyal', 'No signal yet'));
  const form = new FormData();
  form.append('kind', job.kind);
  if (job.field) form.append('field', job.field);
  job.images.forEach((img, i) => form.append('image', img, `image-${i}.jpg`));
  if (job.audio) form.append('audio', job.audio, job.audio.type.includes('wav') ? 'audio.wav' : 'audio.webm');
  try {
    const body = await post<{ draft: Draft }>(`/ponds/${job.pondId}/capture`, form, onProgress);
    return { ...job, status: 'ready', draft: body.draft };
  } catch (err) {
    if (err instanceof Offline) throw new Retryable(err.message);
    if (err instanceof ApiError && err.code === 'ai_quota') throw new Retryable(t('Jatah baca AI hari ini habis', "Today's AI reads are used up"));
    if (err instanceof ApiError && (err.status >= 500 || err.status === 408)) throw new Retryable(err.message);
    return { ...job, status: 'failed', error: (err as Error).message };
  }
}

/** One notebook page photo → rows to check. Nothing is saved. `pondId`: the pond the import started from. */
export function sendNotebook(image: Blob, page: number, pondId: number | undefined, onProgress?: (p: Progress) => void) {
  if (!navigator.onLine) return Promise.reject(new Offline(t('Belum ada sinyal', 'No signal yet')));
  const form = new FormData();
  form.append('image', image, 'page.jpg');
  form.append('page', String(page));
  if (pondId) form.append('pondId', String(pondId));
  return post<{ page: NotebookPage }>('/notebook/read', form, onProgress);
}
