// Per-phone preferences. Stored on this phone only; the app works the same without them.
import { useEffect, useState } from 'preact/hooks';

export interface Prefs {
  /** 0 Normal, 1 Besar (default for older farmers), 2 Sangat besar. */
  textSize: 0 | 1 | 2;
  /** Owners who always want charts and numbers open. */
  techOpen: boolean;
  /** Opt-in: photos, videos and saved numbers may be used to improve the AI. */
  shareData: boolean;
}

const KEY = 'synteel.prefs';
const DEFAULTS: Prefs = { textSize: 1, techOpen: false, shareData: false };
export const TEXT_PX = [16, 18, 20] as const;

function load(): Prefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return DEFAULTS;
  }
}

let current = load();
const listeners = new Set<(p: Prefs) => void>();

export function applyTextSize(p = current) {
  document.documentElement.style.fontSize = `${TEXT_PX[p.textSize]}px`;
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
