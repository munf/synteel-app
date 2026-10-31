import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dasbor asli: dibangun ke web/dist/admin, jadi ikut tersaji di <app>/admin/ (eel.synt.fun/app/admin/).
// --mode contoh: data contoh untuk artifact; --outDir diberikan saat build.
// base './' → semua aset relatif, sama di /app/admin/ dan /preview/admin/.
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [react()],
  build: mode === 'contoh' ? {} : { outDir: '../web/dist/admin', emptyOutDir: true },
}))
