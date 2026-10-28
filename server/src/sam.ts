// Counting dead eels in a photo with Meta SAM 3.1 (segmentation through the Responses API).
// The farmer lays the dead eels in a white basin and photographs it from above; SAM returns
// one mask per eel. Tested prompts: "worm" finds small elvers reliably, "eel" finds none.
// The count is a starting point the farmer confirms or corrects; it is never saved on its own.
import { decodeMaskToRaster, decodeMaskToSVGPath, parseImageStream, recordsOfKind, type ResponsesEvent } from '@meta-sam/parser';
import { AiFailed, call } from './ai.ts';

const PROMPT = 'worm';
const MIN_SCORE = 0.5;
const SURE_SCORE = 0.7;

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
  /** Where to put the number: a pixel on the eel itself, near its middle. */
  label: { x: number; y: number };
}

export interface CountResult {
  count: number;
  eels: CountedEel[];
  /** Ask the farmer to check: unsure detections, eels touching, or one outline that may be two eels. */
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

export async function countDeadEels(image: Blob, sam: SamProvider): Promise<CountResult> {
  const started = Date.now();
  const dataUrl = `data:${image.type || 'image/jpeg'};base64,${Buffer.from(await image.arrayBuffer()).toString('base64')}`;
  const body = await call(`${sam.base}/responses`, sam.apiKey, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'sam-3.1',
      input: [{ role: 'user', content: [{ type: 'input_text', text: PROMPT }, { type: 'input_image', image_url: dataUrl }] }],
      metadata: { include_confidence: 'true', mask_encoding: 'one_bit' },
    }),
  });
  return { ...(await parseCount(body.output?.[0]?.content?.[0]?.text ?? '')), ms: Date.now() - started };
}

/** Turns SAM's output text into eels with outlines; split out so it can be tested offline. */
export async function parseCount(text: string): Promise<Omit<CountResult, 'ms'>> {
  const result = await parseImageStream(once(text)).finalResult;
  if (result.outcome.status !== 'completed') throw new AiFailed(`SAM output incomplete: ${result.outcome.status}`);

  const areas: number[] = [];
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
    areas.push(n);
    eels.push({
      ...m.bounds,
      path: decodeMaskToSVGPath(m.mask),
      score,
      label: { x: m.bounds.left + best.x, y: m.bounds.top + best.y },
    });
  }

  const sorted = [...areas].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const review =
    eels.some((e) => e.score !== null && e.score < SURE_SCORE) ||
    areas.some((a) => median > 0 && a > 1.8 * median) ||
    eels.some((a, i) => eels.some((b, j) => j > i && overlap(a, b)));

  // Reading order: top to bottom, then left to right, so the numbers are easy to follow.
  eels.sort((a, b) => a.top - b.top || a.left - b.left);
  return { count: eels.length, eels, review, model: 'meta/sam-3.1' };
}
