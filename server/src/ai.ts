// Turns a farmer's photo, voice note or daily video into a draft pond log.
// The draft is never saved by itself: the farmer checks it in the Record form first.
//
// Three modes:
//   meta  an API key is set: Muse Voice Transcribe (Meta) turns speech into text; Muse
//         Spark (Meta Model API) reads meter displays / pond frames and structures speech,
//         with the open-weight Muse Spark Open (Fireworks) as fallback.
//   mock  SYNTEEL_AI_MOCK=1: fixed, clearly labelled example drafts, for building and
//         testing the app before Meta API access works.
//   off   neither: capture requests fail with a friendly message, manual entry works.
//
// Chat follows the OpenAI-compatible API on both providers; request shapes verified live
// on 2026-10-28.
import { READING_LIMITS, type Behavior, type LogData, type Phase, type ReadingKey } from './domain.ts';

export type CaptureKind = 'photo' | 'voice' | 'video';
export type DraftField = 'temperature' | 'ph' | 'tds' | 'mortality' | 'behavior' | 'leftover' | 'color' | 'smell' | 'aeration';

export interface CaptureInput {
  kind: CaptureKind;
  /** The form field the farmer tapped the camera next to; absent for "everything". */
  field?: 'temperature' | 'ph' | 'tds';
  images: Blob[]; // meter photos, or frames sampled from the video
  audio?: Blob; // voice note, or the video's soundtrack
  pondName: string;
  phase?: Phase;
}

export interface Draft {
  data: LogData;
  lowConfidence: DraftField[];
  transcript?: string;
  /** Problems the model reports, e.g. "layar silau", shown to the farmer. */
  problems: string[];
  mode: 'meta' | 'mock';
  /** Which provider/model read it, e.g. "meta/muse-spark-1.3". */
  model?: string;
}

export class AiUnavailable extends Error {}
export class AiFailed extends Error {}

export interface Ai {
  mode: 'meta' | 'mock' | 'off';
  draft(input: CaptureInput): Promise<Draft>;
}

const BEHAVIORS: Behavior[] = ['normal', 'surfacing', 'gathering_inlet', 'not_eating', 'lethargic'];

// Strict JSON schema: every key present, null when unknown.
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['temperature', 'ph', 'tds', 'mortality', 'behavior', 'feeding_leftover', 'water_color', 'water_smell', 'aeration', 'note', 'low_confidence', 'problems'],
  properties: {
    temperature: { type: ['number', 'null'], description: 'Suhu air °C' },
    ph: { type: ['number', 'null'] },
    tds: { type: ['number', 'null'], description: 'ppm' },
    mortality: { type: ['integer', 'null'], description: 'Jumlah sidat mati yang disebut atau terlihat' },
    behavior: { type: 'array', items: { enum: BEHAVIORS } },
    feeding_leftover: { enum: ['none', 'little', 'much', null] },
    water_color: { enum: ['clear', 'green', 'brown', 'cloudy', null] },
    water_smell: { enum: ['normal', 'foul', null] },
    aeration: { enum: ['on', 'weak', 'off', null] },
    note: { type: ['string', 'null'], description: 'Hal penting lain, singkat, bahasa Indonesia' },
    low_confidence: { type: 'array', items: { enum: ['temperature', 'ph', 'tds', 'mortality', 'behavior', 'leftover', 'color', 'smell', 'aeration'] } },
    problems: { type: 'array', items: { type: 'string' }, description: 'Kendala membaca, mis. "layar silau", bahasa Indonesia' },
  },
} as const;

function instructions(input: CaptureInput): string {
  const what = {
    photo: input.field
      ? `Foto layar alat ukur. Petani sedang mengisi kolom "${input.field}". Bila alat juga menampilkan suhu, isi suhunya juga.`
      : 'Foto satu atau beberapa alat ukur (pH meter, TDS meter, termometer). Isi semua nilai yang terbaca.',
    voice: 'Transkrip catatan suara petani.',
    video: 'Transkrip narasi dan beberapa bingkai dari video keliling kolam. Nilai warna air, perilaku sidat dan sisa pakan dari bingkai bila jelas.',
  }[input.kind];
  return [
    'Kamu membantu petani sidat di Indonesia mencatat kondisi kolam. Ubah masukan menjadi catatan terstruktur.',
    what,
    `Kolam: ${input.pondName}${input.phase ? `, fase ${input.phase === 'glass_eel' ? 'glass eel' : 'elver'}` : ''}.`,
    'Aturan:',
    '- Jangan menebak. Isi null bila tidak terbaca atau tidak disebut.',
    '- Angka diucapkan atau ditulis dengan koma desimal ("dua delapan koma lima" = 28.5). Petani bisa mencampur bahasa Jawa.',
    '- Layar 7-segmen: perhatikan titik desimal. Bila ragu (silau, buram, angka terpotong), masukkan nama kolom ke low_confidence.',
    '- TDS dalam ppm. Bila layar menunjukkan "x10" atau satuan ppt, konversi ke ppm dan catat di note.',
    '- Ini pencatatan, bukan diagnosis. Jangan menambah saran.',
  ].join('\n');
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const base64 = Buffer.from(await blob.arrayBuffer()).toString('base64');
  return `data:${blob.type || 'image/jpeg'};base64,${base64}`;
}

/** Drop anything the model returned that is not a plausible pond log value. */
export function toDraft(raw: Record<string, any>, mode: Draft['mode'], transcript?: string): Draft {
  const data: LogData = {};
  const problems: string[] = Array.isArray(raw.problems) ? raw.problems.filter((p: unknown) => typeof p === 'string').slice(0, 5) : [];
  const readings: NonNullable<LogData['readings']> = {};
  for (const key of ['temperature', 'ph', 'tds'] as ReadingKey[]) {
    const v = raw[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const [min, max] = READING_LIMITS[key];
    if (v < min || v > max) {
      problems.push(`Nilai ${key} ${v} tidak masuk akal, diabaikan`);
      continue;
    }
    readings[key] = v;
  }
  if (Object.keys(readings).length) data.readings = readings;
  if (Number.isInteger(raw.mortality) && raw.mortality > 0 && raw.mortality < 100_000) data.mortality = raw.mortality;
  const behavior = (Array.isArray(raw.behavior) ? raw.behavior : []).filter((b: Behavior) => BEHAVIORS.includes(b));
  if (behavior.length) data.behavior = [...new Set(behavior)] as Behavior[];
  if (['none', 'little', 'much'].includes(raw.feeding_leftover)) data.feeding = { leftover: raw.feeding_leftover };
  const color = ['clear', 'green', 'brown', 'cloudy'].includes(raw.water_color) ? raw.water_color : undefined;
  const smell = ['normal', 'foul'].includes(raw.water_smell) ? raw.water_smell : undefined;
  if (color || smell) data.water = { ...(color && { color }), ...(smell && { smell }) };
  if (['on', 'weak', 'off'].includes(raw.aeration)) data.aeration = raw.aeration;
  if (typeof raw.note === 'string' && raw.note.trim()) data.note = raw.note.trim().slice(0, 200);
  const lowConfidence = (Array.isArray(raw.low_confidence) ? raw.low_confidence : []).filter((f: unknown) => typeof f === 'string') as DraftField[];
  return { data, lowConfidence, transcript, problems, mode };
}

export interface ChatProvider {
  name: string; // shown in logs and stored with each capture
  apiKey: string;
  base: string;
  model: string;
}

export interface Transcriber {
  apiKey: string;
  base: string;
  model: string;
}

export class Retry extends AiFailed {}

// Fireworks sits behind Cloudflare, which turns away requests without a User-Agent.
const authHeaders = (apiKey: string) => ({ Authorization: `Bearer ${apiKey}`, 'User-Agent': 'synteel-app' });

export async function call(url: string, apiKey: string, init: RequestInit) {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { ...authHeaders(apiKey), ...init.headers }, signal: AbortSignal.timeout(90_000) });
  } catch (err) {
    throw new Retry(`AI API unreachable: ${(err as Error).message}`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = `AI API ${res.status}: ${body.error?.code ?? body.error?.message ?? body.message ?? 'error'}`;
    // Overload, outage or spent credits: worth trying the next provider.
    throw res.status === 429 || res.status === 402 || res.status >= 500 ? new Retry(message) : new AiFailed(message);
  }
  return body;
}

/** Muse Voice Transcribe takes WAV only; the phone converts voice notes before sending. */
async function transcribe(t: Transcriber, audio: Blob): Promise<string> {
  const form = new FormData();
  form.append('request', new Blob([JSON.stringify({ model: t.model, audioEncoding: 'WAV', mode: 'PUSH_TO_TALK' })], { type: 'application/json' }));
  form.append('audio', audio, 'audio.wav');
  const body = await call(`${t.base}/asr/transcribe`, t.apiKey, { method: 'POST', body: form, headers: { Accept: 'application/json' } });
  return String(body.transcript ?? '').trim();
}

async function structure(p: ChatProvider, input: CaptureInput, transcript: string | undefined): Promise<Record<string, unknown>> {
  const content: unknown[] = [{ type: 'text', text: transcript ? `Transkrip:\n${transcript}` : 'Baca gambar berikut.' }];
  for (const image of input.images) content.push({ type: 'image_url', image_url: { url: await blobToDataUrl(image) } });
  const body = await call(`${p.base}/chat/completions`, p.apiKey, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: p.model,
      messages: [
        { role: 'system', content: instructions(input) },
        { role: 'user', content },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'pond_log', strict: true, schema: SCHEMA } },
      // Muse Spark reasons before answering; leave room for both.
      max_tokens: 4000,
      reasoning_effort: 'low',
    }),
  });
  try {
    return JSON.parse(body.choices?.[0]?.message?.content);
  } catch {
    throw new AiFailed('Jawaban AI tidak bisa dibaca');
  }
}

function liveAi(chat: ChatProvider[], transcriber?: Transcriber): Ai {
  return {
    mode: 'meta',
    async draft(input) {
      if (input.kind === 'voice' && !transcriber) {
        // 503 keeps the note queued on the phone until speech-to-text is available.
        throw new AiUnavailable('Catatan suara belum bisa dibaca AI. Rekaman disimpan di HP; pakai foto atau isi manual dulu.');
      }
      const transcript = input.audio && transcriber ? await transcribe(transcriber, input.audio) : undefined;
      if (input.kind === 'voice' && !transcript) throw new AiFailed('Transkrip kosong');
      let lastError: Error = new AiFailed('no chat provider');
      for (const provider of chat) {
        try {
          const draft = toDraft(await structure(provider, input, transcript), 'meta', transcript);
          draft.model = `${provider.name}/${provider.model}`;
          if (input.kind === 'video' && input.audio && !transcriber) draft.problems.push('Narasi video belum bisa didengar AI, hanya gambar yang dibaca.');
          return draft;
        } catch (err) {
          if (!(err instanceof Retry)) throw err;
          console.error(`${provider.name}: ${err.message}`);
          lastError = err;
        }
      }
      throw lastError;
    },
  };
}

/** Example drafts so the capture flow can be built and demoed before API access. */
function mockAi(): Ai {
  const examples = {
    temperature: { temperature: 28.6 },
    ph: { ph: 7.2, temperature: 28.4 },
    tds: { tds: 162, temperature: 28.5 },
  };
  return {
    mode: 'mock',
    async draft(input) {
      const problems = ['Mode contoh: AI Meta belum aktif, angka ini bukan hasil membaca.'];
      if (input.kind === 'photo') {
        const raw = input.field ? examples[input.field] : { temperature: 28.6, ph: 7.2, tds: 162 };
        return toDraft({ ...raw, problems }, 'mock');
      }
      const transcript =
        input.kind === 'voice'
          ? `${input.pondName}, suhu dua delapan koma enam, pH tujuh koma dua, TDS seratus enam puluh dua. Mati satu. Pakan sisa sedikit, aerator nyala.`
          : `Ini ${input.pondName} sore ini. Suhu dua delapan koma empat, pH tujuh koma satu. Airnya agak hijau, sidat normal, pakan habis.`;
      const raw =
        input.kind === 'voice'
          ? { temperature: 28.6, ph: 7.2, tds: 162, mortality: 1, feeding_leftover: 'little', aeration: 'on' }
          : { temperature: 28.4, ph: 7.1, water_color: 'green', behavior: ['normal'], feeding_leftover: 'none', low_confidence: ['color'] };
      return toDraft({ ...raw, problems }, 'mock', transcript);
    },
  };
}

/** Caps real AI reads per UTC day, so a public demo link cannot drain the API credits. */
export function withDailyCap(ai: Ai, cap: number, now = () => new Date()): Ai {
  if (ai.mode !== 'meta' || !(cap > 0)) return ai;
  let day = '';
  let used = 0;
  return {
    mode: ai.mode,
    draft(input) {
      const today = now().toISOString().slice(0, 10);
      if (today !== day) [day, used] = [today, 0];
      if (used >= cap) return Promise.reject(new AiUnavailable('Kuota AI demo hari ini habis. Rekaman disimpan di HP; isi manual tetap bisa.'));
      used++;
      return ai.draft(input);
    },
  };
}

/** `chat` is tried in order: the first provider that answers writes the draft. */
export function createAi(opts: { chat: ChatProvider[]; transcriber?: Transcriber; mock: boolean }): Ai {
  if (opts.mock) return mockAi();
  const chat = opts.chat.filter((p) => p.apiKey);
  if (chat.length) return liveAi(chat, opts.transcriber?.apiKey ? opts.transcriber : undefined);
  return {
    mode: 'off',
    draft: async () => {
      throw new AiUnavailable('AI belum aktif. Isi manual dulu, atau coba lagi nanti.');
    },
  };
}
