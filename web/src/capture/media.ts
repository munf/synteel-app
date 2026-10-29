// On-phone media preparation: everything here runs before anything is uploaded, so
// a farmer on weak signal sends small files and gets told about a bad photo at once.

import { t } from '../i18n.ts';

export interface PreparedImage {
  blob: Blob;
  issues: string[]; // e.g. "buram", "silau": shown before sending, never blocking
}

async function loadBitmap(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
    } catch {
      // fall through to <img>
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(t('Gagal memproses gambar', 'Could not process the image')))), 'image/jpeg', quality));
}

function draw(source: CanvasImageSource, w: number, h: number, maxSide: number) {
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Sharpness (variance of the Laplacian) and glare (share of blown-out pixels) on a
 * small grey copy. Thresholds are starting points for phone photos of meter displays.
 */
export function photoIssues(source: CanvasImageSource, w: number, h: number): string[] {
  const small = draw(source, w, h, 256);
  const { data, width, height } = small.getContext('2d')!.getImageData(0, 0, small.width, small.height);
  const grey = new Float32Array(width * height);
  let blown = 0;
  for (let i = 0; i < grey.length; i++) {
    const y = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    grey[i] = y;
    if (y >= 250) blown++;
  }
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const lap = grey[i - 1] + grey[i + 1] + grey[i - width] + grey[i + width] - 4 * grey[i];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  const variance = sumSq / n - (sum / n) ** 2;
  const issues: string[] = [];
  if (variance < 40) issues.push(t('Foto tampak buram', 'The photo looks blurry'));
  if (blown / grey.length > 0.06) issues.push(t('Ada bagian yang silau', 'Part of the photo has glare'));
  return issues;
}

export async function prepareImage(file: Blob, maxSide = 1280, quality = 0.82): Promise<PreparedImage> {
  const bitmap = await loadBitmap(file);
  const w = 'naturalWidth' in bitmap ? bitmap.naturalWidth : bitmap.width;
  const h = 'naturalHeight' in bitmap ? bitmap.naturalHeight : bitmap.height;
  const canvas = draw(bitmap, w, h, maxSide);
  return { blob: await toBlob(canvas, quality), issues: photoIssues(bitmap, w, h) };
}

// ---------- video ----------

const MAX_VIDEO_S = 120;

function seek(video: HTMLVideoElement, at: number) {
  return new Promise<void>((resolve, reject) => {
    const done = () => {
      video.removeEventListener('seeked', done);
      resolve();
    };
    video.addEventListener('seeked', done);
    video.addEventListener('error', () => reject(new Error(t('Video tidak bisa dibaca', 'The video cannot be read'))), { once: true });
    video.currentTime = at;
  });
}

/** 16 kHz mono WAV: small, and accepted by every transcription service. */
function encodeWav(samples: Float32Array, rate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));
  return new Blob([buffer], { type: 'audio/wav' });
}

async function soundtrack(file: Blob, seconds: number): Promise<Blob | undefined> {
  // Decoding a very large file can exhaust memory on a cheap phone; frames alone still help.
  if (file.size > 150 * 1024 * 1024) return undefined;
  try {
    const decoded = await new AudioContext().decodeAudioData(await file.arrayBuffer());
    const rate = 16_000;
    const length = Math.ceil(Math.min(decoded.duration, seconds) * rate);
    const offline = new OfflineAudioContext(1, length, rate);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    return encodeWav((await offline.startRendering()).getChannelData(0), rate);
  } catch {
    return undefined; // no audio track, or a codec the browser cannot decode
  }
}

/**
 * Instead of uploading the whole video, send a dozen still frames and the narration.
 * That is what the model needs, at a small fraction of the data and API cost.
 */
export async function prepareVideo(file: Blob, frameCount = 12): Promise<{ frames: Blob[]; audio?: Blob; seconds: number }> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error(t('Video tidak bisa dibaca', 'The video cannot be read')));
    });
    const seconds = Math.min(video.duration || 0, MAX_VIDEO_S);
    const frames: Blob[] = [];
    for (let i = 0; i < frameCount && seconds > 0; i++) {
      await seek(video, ((i + 0.5) / frameCount) * seconds);
      frames.push(await toBlob(draw(video, video.videoWidth, video.videoHeight, 640), 0.7));
    }
    return { frames, audio: await soundtrack(file, seconds), seconds };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------- voice ----------

/** Muse Voice Transcribe takes WAV only, so voice notes are converted on the phone. */
export async function voiceToWav(file: Blob, maxSeconds = 120): Promise<Blob> {
  return (await soundtrack(file, maxSeconds)) ?? file;
}

export const canRecordAudio = () => typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

export async function startRecording(maxSeconds = 60) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t));
  const recorder = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32_000 } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const finished = new Promise<Blob>((resolve) => {
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
    };
  });
  recorder.start();
  const timer = setTimeout(() => recorder.state === 'recording' && recorder.stop(), maxSeconds * 1000);
  return {
    stop: () => {
      clearTimeout(timer);
      if (recorder.state === 'recording') recorder.stop();
      return finished;
    },
    finished,
  };
}
