import preact from '@preact/preset-vite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// Fills the placeholders in dist/sw.js with the built file list (relative paths) and a
// content hash, so every deploy gets a fresh cache name and the shell is precached on install.
function swPrecache(): Plugin {
  let outDir = 'dist';
  return {
    name: 'synteel-sw-precache',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const swPath = join(outDir, 'sw.js');
      const files = (readdirSync(outDir, { recursive: true, withFileTypes: true }))
        .filter((d) => d.isFile())
        .map((d) => relative(outDir, join(d.parentPath, d.name)).split(sep).join('/'))
        .filter((f) => f !== 'sw.js' && !f.endsWith('.map'))
        .sort();
      const hash = createHash('sha256');
      for (const f of files) hash.update(f).update(readFileSync(join(outDir, f)));
      const sw = readFileSync(swPath, 'utf8')
        .replace("'__SW_VERSION__'", JSON.stringify(hash.digest('hex').slice(0, 12)))
        .replace('/*__SW_PRECACHE__*/ []', JSON.stringify(files));
      writeFileSync(swPath, sw);
    },
  };
}

export default defineConfig({
  // Relative asset paths: the same build serves at / or under a sub-path (eel.synt.fun/preview/).
  base: './',
  plugins: [preact(), swPrecache()],
  server: {
    host: true,
    proxy: { '/api': 'http://localhost:8787' },
  },
});
