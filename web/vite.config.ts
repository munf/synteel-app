import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [preact()],
  server: {
    host: true,
    proxy: { '/api': 'http://localhost:8787' },
  },
});
