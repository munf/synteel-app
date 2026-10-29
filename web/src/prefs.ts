// Per-phone preferences. Stored on this phone only; the app works the same without them.
import { useEffect, useState } from 'preact/hooks';

export interface Prefs {
  /** 0 Normal (default), 1 Besar, 2 Sangat besar. */
  textSize: 0 | 1 | 2;
  /** Owners who always want charts and numbers open. */
  techOpen: boolean;
  /** Opt-in: photos, videos and saved numbers may be used to improve the AI. */
  shareData: boolean;
  /** Dark screens for checking ponds at night; switched by hand in Profil. */
  night: boolean;
  /** Night-check alarms ring on this phone (on by default). */
  alarms: boolean;
}

const KEY = 'synteel.prefs';
const DEFAULTS: Prefs = { textSize: 0, techOpen: false, shareData: false, night: false, alarms: true };
export const TEXT_PX = [16, 18, 20] as const;

function load(): Prefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return DEFAULTS;
  }
}

let current = load();
export const getPrefs = () => current;
const listeners = new Set<(p: Prefs) => void>();

/** The emergency flow opened from the night alarm stays dark even when the night switch is off. */
let forcedNight = false;

export function applyTextSize(p = current) {
  document.documentElement.style.fontSize = `${TEXT_PX[p.textSize]}px`;
  if (p.night || forcedNight) document.documentElement.dataset.theme = 'night';
  else delete document.documentElement.dataset.theme;
}

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
