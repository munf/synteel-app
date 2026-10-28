import '@fontsource-variable/plus-jakarta-sans/wght.css';
import { render } from 'preact';
import { App } from './app.tsx';
import { applyTextSize } from './prefs.ts';
import './style.css';

applyTextSize();
render(<App />, document.getElementById('app')!);

// Offline app shell (public/sw.js). Relative URL: the scope is whatever sub-path serves the app.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Service worker gagal didaftarkan', err));
  });
}
