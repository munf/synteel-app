import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths: the same build serves at / or under a sub-path (eel.synt.fun/preview/).
  base: './',
  plugins: [preact()],
  server: {
    host: true,
    proxy: { '/api': 'http://localhost:8787' },
  },
});
