// Language of the person asking: the app sends `x-lang: en` when English is chosen in Profil.
// Each request runs inside withLang(), so any text built while answering it (risk reasons, steps,
// errors, AI instructions) can call tx() without passing the language around. Work outside a request
// (the monitor, evening briefings) gets Indonesian, the default.
import { AsyncLocalStorage } from 'node:async_hooks';

export type Lang = 'id' | 'en';

const store = new AsyncLocalStorage<Lang>();

export const withLang = <T>(lang: Lang, fn: () => T): T => store.run(lang, fn);
export const currentLang = (): Lang => store.getStore() ?? 'id';
export const parseLang = (header: string | undefined): Lang => (header?.trim().toLowerCase().startsWith('en') ? 'en' : 'id');

/** The Indonesian text, or its English version when the request asked for English. */
export const tx = (id: string, en: string): string => (currentLang() === 'en' ? en : id);

/** 28.9 → "28,9" (id) or "28.9" (en), at most `digits` decimals. */
export const dec = (n: number, digits = 1): string => n.toLocaleString(currentLang() === 'en' ? 'en-GB' : 'id-ID', { maximumFractionDigits: digits });
