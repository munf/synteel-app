import '@fontsource-variable/plus-jakarta-sans/wght.css';
import { render } from 'preact';
import { App } from './app.tsx';
import { applyTextSize } from './prefs.ts';
import { isEn } from './i18n.ts';
import './style.css';

applyTextSize();
// index.html and the manifest are written in Indonesian (the default); English swaps them here.
if (isEn) {
  document.querySelector('meta[name="description"]')?.setAttribute('content', 'Helps eel farmers watch their ponds and act sooner');
  document.querySelector('link[rel="manifest"]')?.setAttribute('href', './manifest.en.webmanifest');
}
render(<App />, document.getElementById('app')!);

// Offline app shell (public/sw.js). Relative URL: the scope is whatever sub-path serves the app.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Service worker gagal didaftarkan', err));
  });
}
