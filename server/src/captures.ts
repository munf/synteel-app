// Keeps what farmers sent alongside the AI draft, so field accuracy can be measured
// later against what the farmer actually saved. Local only: data/ is gitignored.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// ---------- pond cover pictures ----------

/** A cover key: one folder under the captures folder, named like a capture so removeFarmCaptures finds it. */
const COVER_KEY = /^[0-9TZ-]+-farm\d+-pond\d+-cover-[0-9a-f]{8}$/;

/**
 * The pond's cover picture: the pond photo the farmer saved with the pond profile. Kept next to the
 * captures (folder named with the farm id, so a deleted demo farm's covers are removed with them).
 * The key is what the pond row keeps; the picture is only served to members of that farm (api.ts).
 */
export function coverStore(dir = captureDir()) {
  const file = (key: string) => (COVER_KEY.test(key) ? join(dir, key, 'cover.jpg') : null);
  return {
    save(farmId: number, pondId: number, image: Uint8Array, at: Date): string {
      const key = `${at.toISOString().replace(/[:.]/g, '-')}-farm${farmId}-pond${pondId}-cover-${randomBytes(4).toString('hex')}`;
      mkdirSync(join(dir, key), { recursive: true });
      writeFileSync(join(dir, key, 'cover.jpg'), image);
      return key;
    },
    read(key: string): Buffer | null {
      const path = file(key);
      return path && existsSync(path) ? readFileSync(path) : null;
    },
    remove(key: string) {
      if (COVER_KEY.test(key)) rmSync(join(dir, key), { recursive: true, force: true });
    },
  };
}

export type CoverStore = ReturnType<typeof coverStore>;
