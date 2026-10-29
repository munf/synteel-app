// Counting dead eels in a photo with Meta SAM 3.1 (segmentation through the Responses API).
// The farmer photographs the scoop, net or basin from above as it is. Glass eels are see-through and
// pile up, so one prompt is not enough. Tested on 20 glass eel and elver photos:
// - "transparent eel": clear eels on a dark ground (10 of 10); "eel" and "glass eel" find nothing.
// - "thin worm": eels that have started to colour (4 of 4); "transparent worm": eels on a net.
// - "black eye": the two black eyes are the clearest part of a glass eel, so heads in a pile still show.
// - "worm": elvers in a white basin (8 of 8).
// The prompts run at the same time; bodies are merged, eye pairs become heads, and the answer is one
// number when bodies and heads agree, or a range the farmer settles. Nothing is saved on its own.
import { decodeMaskToRaster, decodeMaskToSVGPath, parseImageStream, recordsOfKind, type ResponsesEvent } from '@meta-sam/parser';
import { AiFailed, call } from './ai.ts';
import type { Phase } from './domain.ts';

const BODY_PROMPTS = ['transparent eel', 'thin worm', 'transparent worm'];
const ELVER_PROMPT = 'worm';
const EYE_PROMPT = 'black eye';
const MIN_SCORE = 0.5;
/** Right detections scored 0.7 to 0.95 in the tests; wrong or doubtful ones 0.5 to 0.65. */
const SURE_SCORE = 0.7;
/** An outline this much larger than the typical one probably covers two crossing eels. */
const DOUBLE_AREA = 1.7;

export interface SamProvider {
  apiKey: string;
  base: string;
}

export interface CountedEel {
  /** Box in source pixels (half-open). The outline path is relative to its top-left corner. */
  left: number;
  top: number;
  right: number;
  bottom: number;
  path: string;
  score: number | null;
  /** Mask size in pixels. */
  area: number;
  /** Where to put the number: a pixel on the eel itself, near its middle. */
  label: { x: number; y: number };
}

export interface CountResult {
  /** The number filled in for the farmer: the count, or the middle of the range. */
  count: number;
  low: number;
  high: number;
  /** One outline per eel body found (sure ones first in reading order, then doubtful ones). */
  eels: (CountedEel & { sure: boolean })[];
  /** One point per head (a pair of eyes, or a single eye). */
  heads: { x: number; y: number }[];
  /** Ask the farmer to check: a range, doubtful outlines, or eels touching. */
  review: boolean;
  model: string;
  ms: number;
}

async function* once(text: string): AsyncIterable<ResponsesEvent> {
  yield { type: 'response.output_text.done', item_id: 'sam', output_index: 0, content_index: 0, text };
  yield { type: 'response.completed' };
}

const overlap = (a: CountedEel, b: CountedEel, pad = 3) =>
  a.left - pad < b.right && b.left - pad < a.right && a.top - pad < b.bottom && b.top - pad < a.bottom;

const boxArea = (e: CountedEel) => (e.right - e.left) * (e.bottom - e.top);
function iou(a: CountedEel, b: CountedEel) {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / (boxArea(a) + boxArea(b) - w * h);
}

async function find(dataUrl: string, prompt: string, sam: SamProvider): Promise<CountedEel[]> {
  const body = await call(`${sam.base}/responses`, sam.apiKey, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'sam-3.1',
      input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: dataUrl }] }],
      metadata: { include_confidence: 'true', mask_encoding: 'one_bit' },
    }),
  });
  return parseMasks(body.output?.[0]?.content?.[0]?.text ?? '');
}

export async function countDeadEels(image: Blob, sam: SamProvider, phase: Phase = 'glass_eel'): Promise<CountResult> {
  const started = Date.now();
  const dataUrl = `data:${image.type || 'image/jpeg'};base64,${Buffer.from(await image.arrayBuffer()).toString('base64')}`;
  const prompts = phase === 'elver' ? [ELVER_PROMPT, ...BODY_PROMPTS] : BODY_PROMPTS;
  // One failed prompt does not sink the count; all of them failing does.
  const settled = await Promise.allSettled([...prompts, EYE_PROMPT].map((p) => find(dataUrl, p, sam)));
  const ok = settled.filter((s): s is PromiseFulfilledResult<CountedEel[]> => s.status === 'fulfilled').map((s) => s.value);
  if (ok.length === 0) throw (settled[0] as PromiseRejectedResult).reason;
  const eyes = settled[settled.length - 1].status === 'fulfilled' ? (settled[settled.length - 1] as PromiseFulfilledResult<CountedEel[]>).value : [];
  const bodies = settled.slice(0, -1).flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
  return { ...combine(bodies, eyes), ms: Date.now() - started };
}

/** SAM's output text → one outline per mask above the score floor; split out so it can be tested offline. */
export async function parseMasks(text: string): Promise<CountedEel[]> {
  const result = await parseImageStream(once(text)).finalResult;
  if (result.outcome.status !== 'completed') throw new AiFailed(`SAM output incomplete: ${result.outcome.status}`);
  const eels: CountedEel[] = [];
  for (const m of recordsOfKind(result.records, 'mask')) {
    const score = m.confidence ?? null;
    if (score !== null && score < MIN_SCORE) continue;
    const raster = decodeMaskToRaster(m.mask);
    const { width, height } = m.mask;
    // Centroid of the mask, then the mask pixel nearest to it, so the number sits on the eel.
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (raster[y * width + x]) (sx += x, sy += y, n++);
    if (n === 0) continue;
    const cx = sx / n;
    const cy = sy / n;
    let best = { x: cx, y: cy, d: Infinity };
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        if (!raster[y * width + x]) continue;
        const d = (x - cx) ** 2 + (y - cy) ** 2;
        if (d < best.d) best = { x, y, d };
      }
    eels.push({ ...m.bounds, path: decodeMaskToSVGPath(m.mask), score, area: n, label: { x: m.bounds.left + best.x, y: m.bounds.top + best.y } });
  }
  return eels;
}

/** Two eyes close together are one head; an eye with no partner still counts as a head. */
export function pairEyes(eyes: CountedEel[]): { x: number; y: number }[] {
  const c = eyes.map((e) => ({ x: (e.left + e.right) / 2, y: (e.top + e.bottom) / 2, size: Math.max(e.right - e.left, e.bottom - e.top) }));
  const pairs = c
    .flatMap((a, i) => c.slice(i + 1).map((b, k) => ({ i, j: i + 1 + k, d: Math.hypot(a.x - b.x, a.y - b.y) })))
    .sort((a, b) => a.d - b.d);
  const used = new Set<number>();
  const heads: { x: number; y: number }[] = [];
  for (const { i, j, d } of pairs) {
    if (used.has(i) || used.has(j) || d > 3.2 * Math.max(c[i].size, c[j].size)) continue;
    used.add(i);
    used.add(j);
    heads.push({ x: (c[i].x + c[j].x) / 2, y: (c[i].y + c[j].y) / 2 });
  }
  c.forEach((e, i) => used.has(i) || heads.push({ x: e.x, y: e.y }));
  return heads;
}

/** Bodies from every prompt + eyes → one count or a range. */
export function combine(bodyLists: CountedEel[][], eyes: CountedEel[]): Omit<CountResult, 'ms'> {
  // The same eel found by two prompts: keep the surer outline.
  const merged: CountedEel[] = [];
  for (const e of bodyLists.flat().sort((a, b) => (b.score ?? 1) - (a.score ?? 1))) if (!merged.some((m) => iou(m, e) > 0.5)) merged.push(e);
  const eels = merged.map((e) => ({ ...e, sure: (e.score ?? 1) >= SURE_SCORE }));
  const heads = pairEyes(eyes);

  const areas = eels.map((e) => e.area).sort((a, b) => a - b);
  const median = areas[Math.floor(areas.length / 2)] ?? 0;
  const doubles = eels.filter((e) => median > 0 && e.area > DOUBLE_AREA * median).length;
  const sure = eels.filter((e) => e.sure).length;

  let low = Math.max(sure, heads.length);
  let high = Math.max(eels.length + doubles, heads.length);
  // Sure bodies and heads agree: that is the count, doubtful extras aside.
  if (heads.length > 0 && heads.length === sure) high = low;
  if (low === 0 && high > 0) low = 1;
  const count = Math.round((low + high) / 2);
  const review = low !== high || eels.some((e) => !e.sure) || eels.some((a, i) => eels.some((b, j) => j > i && overlap(a, b)));

  // Reading order: sure ones top to bottom, then left to right, so the numbers are easy to follow.
  eels.sort((a, b) => Number(b.sure) - Number(a.sure) || a.top - b.top || a.left - b.left);
  return { count, low, high, eels, heads, review, model: 'meta/sam-3.1' };
}

/** One prompt's output as a count (kept for the recorded fixture and older callers). */
export async function parseCount(text: string): Promise<Omit<CountResult, 'ms'>> {
  return combine([await parseMasks(text)], []);
}
