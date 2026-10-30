// Keeps what farmers sent alongside the AI draft, so field accuracy can be measured
// later against what the farmer actually saved. Local only: data/ is gitignored.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultDir = fileURLToPath(new URL('../../data/captures/', import.meta.url));
const captureDir = () => process.env.SYNTEEL_CAPTURES ?? defaultDir;

export function captureStore(dir = captureDir()) {
  return async (meta: Record<string, unknown>, files: { name: string; blob: Blob }[]) => {
    // The farm in the name, so a deleted demo farm's captures can be found again.
    const farm = meta.farmId === undefined ? '' : `-farm${meta.farmId}`;
    const folder = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}${farm}-pond${meta.pondId}-${meta.kind}`);
    mkdirSync(folder, { recursive: true });
    for (const f of files) writeFileSync(join(folder, f.name), Buffer.from(await f.blob.arrayBuffer()));
    writeFileSync(join(folder, 'capture.json'), JSON.stringify(meta, null, 2));
  };
}

/** Deletes every capture of one farm (a demo farm that expired). */
export function removeFarmCaptures(farmId: number, dir = captureDir()) {
  if (!existsSync(dir)) return;
  const mark = `-farm${farmId}-`;
  for (const name of readdirSync(dir)) if (name.includes(mark)) rmSync(join(dir, name), { recursive: true, force: true });
}

export type SaveCapture = ReturnType<typeof captureStore>;
