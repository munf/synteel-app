import type { Behavior, Level, LogData, Phase, ReadingKey } from './api.ts';

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
  gathering_inlet: 'Kumpul di inlet',
  not_eating: 'Tidak mau makan',
  lethargic: 'Lemas / diam',
};

export const leftoverLabel = { none: 'Habis', little: 'Sisa sedikit', much: 'Sisa banyak' } as const;
export const colorLabel = { clear: 'Jernih', green: 'Hijau', brown: 'Cokelat', cloudy: 'Keruh' } as const;
export const smellLabel = { normal: 'Normal', foul: 'Busuk' } as const;

export const fmtNum = (n: number) => n.toLocaleString('id-ID', { maximumFractionDigits: 2 });

export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString('id-ID', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });
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
  if (data.waterChangePct) parts.push(`ganti air ${data.waterChangePct}%`);
  if (data.note) parts.push(`“${data.note}”`);
  return parts.join(' · ');
}
