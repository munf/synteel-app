import type { Aeration, Behavior, Level, Limits, LogData, LogSource, Phase, ReadingKey, RiskLevel, Setting } from './api.ts';

export const levelLabel: Record<Level, string> = {
  ok: 'Aman',
  info: 'Perlu dicatat',
  warning: 'Perhatian',
  critical: 'Bahaya',
};

export const phaseLabel: Record<Phase, string> = { glass_eel: 'Glass eel', elver: 'Elver' };

export const readingLabel: Record<ReadingKey, { name: string; unit: string }> = {
  temperature: { name: 'Suhu', unit: '°C' },
  ph: { name: 'pH', unit: '' },
  tds: { name: 'TDS', unit: 'ppm' },
  do: { name: 'DO', unit: 'mg/L' },
  tan: { name: 'Amonia', unit: 'mg/L' },
  no2: { name: 'Nitrit', unit: 'mg/L' },
};

export const behaviorLabel: Record<Behavior, string> = {
  normal: 'Normal',
  surfacing: 'Naik ke permukaan',
  gathering_inlet: 'Kumpul di air masuk',
  not_eating: 'Tidak mau makan',
  lethargic: 'Lemas / diam',
};

export const riskLabel: Record<RiskLevel, string> = { ok: 'Aman', warning: 'Perhatian', critical: 'Bahaya' };
export const sourceLabel: Record<LogSource, string> = { manual: 'Ketik manual', voice: 'Suara · AI, dicek', photo: 'Foto alat · AI, dicek', video: 'Video · AI, dicek' };

const WORDS = {
  temperature: { low: ['Agak dingin', 'Terlalu dingin'], high: ['Agak panas', 'Terlalu panas'] },
  ph: { low: ['Agak rendah', 'Terlalu rendah'], high: ['Agak tinggi', 'Terlalu tinggi'] },
  tds: { low: ['Agak rendah', 'Terlalu rendah'], high: ['Agak tinggi', 'Terlalu tinggi'] },
} as const;

/** A plain word for a reading ("Terlalu dingin") and its tone, from the server's status and limits. */
export function readingWord(key: 'temperature' | 'ph' | 'tds', value: number, status: Level | undefined, limits: Limits | undefined) {
  if (!status || status === 'ok' || !limits) return { text: 'Baik', tone: 'ok' as const };
  const below = limits.target?.min ?? limits.warning?.below ?? -Infinity;
  const side = value < below ? 'low' : 'high';
  // Perhatian → "Agak …", Bahaya → "Terlalu …" (FAKTA words).
  const strong = status === 'critical';
  return { text: WORDS[key][side][strong ? 1 : 0], tone: status === 'critical' ? ('bad' as const) : ('warn' as const) };
}

export function greeting(now = new Date()): string {
  const h = Number(now.toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Asia/Jakarta' }));
  return h < 11 ? 'Selamat pagi' : h < 15 ? 'Selamat siang' : h < 18 ? 'Selamat sore' : 'Selamat malam';
}
export const settingLabel: Record<Setting, string> = { outdoor: 'Luar ruangan', indoor: 'Dalam ruangan' };
export const aerationLabel: Record<Aeration, string> = { full: '24 jam', partial: 'Sebagian waktu', none: 'Tidak ada' };
export const aerationCheckLabel = { on: 'Nyala normal', weak: 'Lemah', off: 'Mati' } as const;

export const leftoverLabel = { none: 'Habis', little: 'Sisa sedikit', much: 'Sisa banyak' } as const;
export const colorLabel = { clear: 'Jernih', green: 'Hijau', brown: 'Cokelat', cloudy: 'Keruh' } as const;
export const smellLabel = { normal: 'Normal', foul: 'Busuk' } as const;

export const fmtNum = (n: number) => n.toLocaleString('id-ID', { maximumFractionDigits: 2 });

export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString('id-ID', { weekday: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });
}

/** "04.00" in farm time; adds the weekday when it is not today. */
export function fmtClock(t: number, withDay = false): string {
  const opts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' };
  return new Date(t).toLocaleString('id-ID', withDay ? { ...opts, weekday: 'long' } : opts);
}

export function fmtAgo(t: number, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - t) / 60_000));
  if (min < 60) return `${min} menit lalu`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} jam lalu` : `${Math.floor(h / 24)} hari lalu`;
}

export function fmtDate(ymd: string): string {
  return new Date(`${ymd}T00:00:00`).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long' });
}

/** One-line human summary of a log, for history lists. */
export function summarizeLog(data: LogData): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data.readings ?? {})) {
    const l = readingLabel[k as ReadingKey];
    parts.push(`${l.name} ${fmtNum(v)}${l.unit ? ' ' + l.unit : ''}`);
  }
  if (data.mortality) parts.push(`${data.mortality} mati`);
  if (data.feeding?.leftover) parts.push(`pakan ${leftoverLabel[data.feeding.leftover].toLowerCase()}`);
  const odd = (data.behavior ?? []).filter((b) => b !== 'normal');
  if (odd.length) parts.push(odd.map((b) => behaviorLabel[b].toLowerCase()).join(', '));
  if (data.water?.color) parts.push(`air ${colorLabel[data.water.color].toLowerCase()}`);
  if (data.water?.smell === 'foul') parts.push('bau busuk');
  if (data.aeration) parts.push(`aerator ${aerationCheckLabel[data.aeration].toLowerCase()}`);
  if (data.waterChangePct) parts.push(`ganti air ${data.waterChangePct}%`);
  if (data.note) parts.push(`“${data.note}”`);
  return parts.join(' · ');
}

/** "29,8 °C": comma decimal, a space, °C. */
export const fmtTemp = (n: number) => `${(Math.round(n * 10) / 10).toLocaleString('id-ID', { maximumFractionDigits: 1 })} °C`;
