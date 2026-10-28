import '@fontsource-variable/plus-jakarta-sans/wght.css';
import { render } from 'preact';
import { App } from './app.tsx';
import { applyTextSize } from './prefs.ts';
import './style.css';

applyTextSize();
render(<App />, document.getElementById('app')!);
