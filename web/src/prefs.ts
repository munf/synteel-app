// Per-phone preferences. Stored on this phone only; the app works the same without them.
import { useEffect, useState } from 'preact/hooks';

export interface Prefs {
  /** 0 Normal (default), 1 Besar, 2 Sangat besar. */
  textSize: 0 | 1 | 2;
  /** Owners who always want charts and numbers open. */
  techOpen: boolean;
  /** Opt-in: photos, videos and saved numbers may be used to improve the AI. */
  shareData: boolean;
  /** Light, dark, or follow the phone's own setting; chosen in Profil → Tampilan. */
  theme: Theme;
  /** Night-check alarms ring on this phone (on by default). */
  alarms: boolean;
  /** Interface language (i18n.ts); switching reloads the app. */
  lang: 'id' | 'en';
}

const KEY = 'synteel.prefs';
const DEFAULTS: Prefs = { textSize: 0, techOpen: false, shareData: false, theme: 'light', alarms: true, lang: 'id' };
export const TEXT_PX = [16, 18, 20] as const;

export type Theme = 'light' | 'dark' | 'system';

function load(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    // Phones that had the old "Tampilan malam" switch on keep their dark screens.
    if (saved.theme === undefined && saved.night === true) saved.theme = 'dark';
    delete saved.night;
    return { ...DEFAULTS, ...saved };
  } catch {
    return DEFAULTS;
  }
}

let current = load();
export const getPrefs = () => current;
const listeners = new Set<(p: Prefs) => void>();

/** The emergency flow opened from the night alarm stays dark even when the night switch is off. */
let forcedNight = false;

const phoneDark = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

/** Whether the screens are dark right now: chosen, following a dark phone, or forced by the night alarm. */
export const isDark = (p = current) => forcedNight || p.theme === 'dark' || (p.theme === 'system' && !!phoneDark?.matches);

export function applyTextSize(p = current) {
  document.documentElement.style.fontSize = `${TEXT_PX[p.textSize]}px`;
  const dark = isDark(p);
  if (dark) document.documentElement.dataset.theme = 'night';
  else delete document.documentElement.dataset.theme;
  // The phone's status bar follows the page.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#101010' : '#EEF2F7');
}

// "Ikuti HP": switch along with the phone, also while the app is open.
phoneDark?.addEventListener('change', () => current.theme === 'system' && applyTextSize());

/** Called with true when the alarm hands over to Ada Masalah at night, and false once that flow is left. */
export function setForcedNight(on: boolean) {
  forcedNight = on;
  applyTextSize();
}

export function setPrefs(patch: Partial<Prefs>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // private mode: keep it for this session only
  }
  applyTextSize();
  listeners.forEach((l) => l(current));
}

export function usePrefs(): Prefs {
  const [p, setP] = useState(current);
  useEffect(() => {
    listeners.add(setP);
    return () => void listeners.delete(setP);
  }, []);
  return p;
}
