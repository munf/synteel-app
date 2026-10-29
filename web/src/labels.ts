import { LOCALE, t } from './i18n.ts';
import type { Aeration, Behavior, Level, Limits, LogData, LogSource, Phase, ReadingKey, RiskLevel, Setting } from './api.ts';

export const levelLabel: Record<Level, string> = {
  ok: t('Aman', 'Safe'),
  info: t('Perlu dicatat', 'Worth noting'),
  warning: t('Perhatian', 'Caution'),
  critical: t('Bahaya', 'Danger'),
};

export const phaseLabel: Record<Phase, string> = { glass_eel: 'Glass eel', elver: 'Elver' };

export const readingLabel: Record<ReadingKey, { name: string; unit: string }> = {
  temperature: { name: t('Suhu', 'Temperature'), unit: '°C' },
  ph: { name: 'pH', unit: '' },
  tds: { name: 'TDS', unit: 'ppm' },
  do: { name: 'DO', unit: 'mg/L' },
  tan: { name: t('Amonia', 'Ammonia'), unit: 'mg/L' },
  no2: { name: t('Nitrit', 'Nitrite'), unit: 'mg/L' },
};

export const behaviorLabel: Record<Behavior, string> = {
  normal: 'Normal',
  surfacing: t('Naik ke permukaan', 'Rising to the surface'),
  gathering_inlet: t('Kumpul di air masuk', 'Gathering at the inlet'),
  not_eating: t('Tidak mau makan', 'Not eating'),
  lethargic: t('Lemas / diam', 'Weak or still'),
};

export const riskLabel: Record<RiskLevel, string> = { ok: t('Aman', 'Safe'), warning: t('Perhatian', 'Caution'), critical: t('Bahaya', 'Danger') };
export const sourceLabel: Record<LogSource, string> = {
  manual: t('Ketik manual', 'Typed in'),
  voice: t('Suara · AI, dicek', 'Voice · AI, checked'),
  photo: t('Foto alat · AI, dicek', 'Meter photo · AI, checked'),
  video: t('Video · AI, dicek', 'Video · AI, checked'),
};

const LOW = [t('Agak rendah', 'A bit low'), t('Terlalu rendah', 'Too low')];
const HIGH = [t('Agak tinggi', 'A bit high'), t('Terlalu tinggi', 'Too high')];
const WORDS = {
  temperature: { low: [t('Agak dingin', 'A bit cold'), t('Terlalu dingin', 'Too cold')], high: [t('Agak panas', 'A bit hot'), t('Terlalu panas', 'Too hot')] },
  ph: { low: LOW, high: HIGH },
  tds: { low: LOW, high: HIGH },
};

/** A plain word for a reading ("Terlalu dingin") and its tone, from the server's status and limits. */
export function readingWord(key: 'temperature' | 'ph' | 'tds', value: number, status: Level | undefined, limits: Limits | undefined) {
  if (!status || status === 'ok' || !limits) return { text: t('Baik', 'Good'), tone: 'ok' as const };
  const below = limits.target?.min ?? limits.warning?.below ?? -Infinity;
  const side = value < below ? 'low' : 'high';
  // Perhatian → "Agak …", Bahaya → "Terlalu …" (FAKTA words).
  const strong = status === 'critical';
  return { text: WORDS[key][side][strong ? 1 : 0], tone: status === 'critical' ? ('bad' as const) : ('warn' as const) };
}

export function greeting(now = new Date()): string {
  const h = Number(now.toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Asia/Jakarta' }));
  return h < 11 ? t('Selamat pagi', 'Good morning') : h < 15 ? t('Selamat siang', 'Good afternoon') : h < 18 ? t('Selamat sore', 'Good afternoon') : t('Selamat malam', 'Good evening');
}
export const settingLabel: Record<Setting, string> = { outdoor: t('Luar ruangan', 'Outdoors'), indoor: t('Dalam ruangan', 'Indoors') };
export const aerationLabel: Record<Aeration, string> = { full: t('24 jam', '24 hours'), partial: t('Sebagian waktu', 'Part of the time'), none: t('Tidak ada', 'None') };
export const aerationCheckLabel = { on: t('Nyala normal', 'Running normally'), weak: t('Lemah', 'Weak'), off: t('Mati', 'Off') };

export const leftoverLabel = { none: t('Habis', 'All eaten'), little: t('Sisa sedikit', 'A little left'), much: t('Sisa banyak', 'A lot left') };
export const colorLabel = { clear: t('Jernih', 'Clear'), green: t('Hijau', 'Green'), brown: t('Cokelat', 'Brown'), cloudy: t('Keruh', 'Cloudy') };
export const smellLabel = { normal: 'Normal', foul: t('Busuk', 'Foul') };

export const fmtNum = (n: number) => n.toLocaleString(LOCALE, { maximumFractionDigits: 2 });

export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString(LOCALE, { weekday: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });
}

/** "04.00" in farm time; adds the weekday when it is not today. */
export function fmtClock(t: number, withDay = false): string {
  const opts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' };
  return new Date(t).toLocaleString(LOCALE, withDay ? { ...opts, weekday: 'long' } : opts);
}

export function fmtAgo(at: number, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - at) / 60_000));
  if (min < 60) return t(`${min} menit lalu`, `${min} ${min === 1 ? 'minute' : 'minutes'} ago`);
  const h = Math.floor(min / 60);
  const d = Math.floor(h / 24);
  return h < 48 ? t(`${h} jam lalu`, `${h} ${h === 1 ? 'hour' : 'hours'} ago`) : t(`${d} hari lalu`, `${d} days ago`);
}

export function fmtDate(ymd: string): string {
  return new Date(`${ymd}T00:00:00`).toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });
}

const FEED_EN = { none: 'feed all eaten', little: 'a little feed left', much: 'a lot of feed left' } as const;

/** One-line human summary of a log, for history lists. */
export function summarizeLog(data: LogData): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data.readings ?? {})) {
    const l = readingLabel[k as ReadingKey];
    parts.push(`${l.name} ${fmtNum(v)}${l.unit ? ' ' + l.unit : ''}`);
  }
  if (data.mortality) parts.push(t(`${data.mortality} mati`, `${data.mortality} dead`));
  if (data.feeding?.leftover) parts.push(t(`pakan ${leftoverLabel[data.feeding.leftover].toLowerCase()}`, FEED_EN[data.feeding.leftover]));
  const odd = (data.behavior ?? []).filter((b) => b !== 'normal');
  if (odd.length) parts.push(odd.map((b) => behaviorLabel[b].toLowerCase()).join(', '));
  if (data.water?.color) parts.push(t(`air ${colorLabel[data.water.color].toLowerCase()}`, `${colorLabel[data.water.color].toLowerCase()} water`));
  if (data.water?.smell === 'foul') parts.push(t('bau busuk', 'foul smell'));
  if (data.aeration) parts.push(`aerator ${aerationCheckLabel[data.aeration].toLowerCase()}`);
  if (data.waterChangePct) parts.push(t(`ganti air ${data.waterChangePct}%`, `${data.waterChangePct}% water changed`));
  if (data.note) parts.push(`“${data.note}”`);
  return parts.join(' · ');
}

/** "29,8 °C": comma decimal, a space, °C. */
export const fmtTemp = (n: number) => `${(Math.round(n * 10) / 10).toLocaleString(LOCALE, { maximumFractionDigits: 1 })} °C`;
