// Interface language. Indonesian is the default; English is chosen in Profil → Tampilan → Bahasa.
// The choice is fixed for the life of the page: switching reloads the app, so module-level labels
// (labels.ts) can be built once with `t()`.
import { getPrefs, setPrefs } from './prefs.ts';

export type Lang = 'id' | 'en';

export const lang: Lang = getPrefs().lang === 'en' ? 'en' : 'id';
export const isEn = lang === 'en';
/** For toLocaleString: Indonesian decimal comma and day names, or British English (day before month, 24-hour). */
export const LOCALE = isEn ? 'en-GB' : 'id-ID';

/** The Indonesian text, or its English version when English is chosen. */
export const t = (id: string, en: string): string => (isEn ? en : id);

/** Switch language: saved on this phone, then the app reloads in the new language. */
export function setLang(next: Lang) {
  if (next === lang) return;
  setPrefs({ lang: next });
  location.reload();
}

/** Decimal comma (id) or point (en), at most `digits` decimals. */
export const fmtDec = (n: number, digits = 2) => n.toLocaleString(LOCALE, { maximumFractionDigits: digits });

/** Typed numbers: accept "7,4" and "7.4" in either language. */
export const parseDec = (s: string) => Number(s.trim().replace(',', '.'));

if (typeof document !== 'undefined') document.documentElement.lang = lang;

/** eel.synt.fun shares this origin: links to it open the site in the app's language (the site reads this key). */
export function siteInAppLanguage() {
  try {
    localStorage.setItem('synteel-site-lang', lang);
  } catch {
    // private mode: the site opens in its default language
  }
}
