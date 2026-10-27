// Keeps what farmers sent alongside the AI draft, so field accuracy can be measured
// later against what the farmer actually saved. Local only: data/ is gitignored.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultDir = fileURLToPath(new URL('../../data/captures/', import.meta.url));

export function captureStore(dir = process.env.SYNTEEL_CAPTURES ?? defaultDir) {
  return async (meta: Record<string, unknown>, files: { name: string; blob: Blob }[]) => {
    const folder = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-pond${meta.pondId}-${meta.kind}`);
    mkdirSync(folder, { recursive: true });
    for (const f of files) writeFileSync(join(folder, f.name), Buffer.from(await f.blob.arrayBuffer()));
    writeFileSync(join(folder, 'capture.json'), JSON.stringify(meta, null, 2));
  };
}

export type SaveCapture = ReturnType<typeof captureStore>;
