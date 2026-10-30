// Every desa/kelurahan in Indonesia with its Kemendagri code (BMKG's `adm4`) and the centre of its area,
// for choosing the farm's BMKG forecast region from its coordinates and for "Ganti wilayah" by name.
// Data: server/geo/desa.tsv.gz, built by scripts/build-desa.ts from cahyadsn/wilayah and
// cahyadsn/wilayah_boundaries (MIT licence). Loaded on first use, about 84,000 villages.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

export interface Desa {
  code: string;
  name: string;
  kecamatan: string;
  /** "Sleman" for Kabupaten Sleman, "Kota Yogyakarta" for a city. */
  kabupaten: string;
  provinsi: string;
  lat: number | null;
  lon: number | null;
}

interface Table {
  villages: Desa[];
  located: Desa[];
  byCode: Map<string, Desa>;
  /** Normalised "village kecamatan kabupaten" per village, same order, for the name search. */
  text: string[] | null;
}

let table: Table | null = null;

function load(): Table {
  if (table) return table;
  const text = gunzipSync(readFileSync(new URL('../geo/desa.tsv.gz', import.meta.url))).toString('utf8');
  const names = new Map<string, string>();
  const villages: Desa[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const [code, name, lat, lon] = line.split('\t');
    if (code.length < 13) {
      names.set(code, code.length === 5 ? name.replace(/^Kabupaten\s+/i, '') : name);
      continue;
    }
    villages.push({
      code,
      name,
      kecamatan: names.get(code.slice(0, 8)) ?? '',
      kabupaten: names.get(code.slice(0, 5)) ?? '',
      provinsi: names.get(code.slice(0, 2)) ?? '',
      lat: lat ? Number(lat) : null,
      lon: lon ? Number(lon) : null,
    });
  }
  table = { villages, located: villages.filter((v) => v.lat !== null), byCode: new Map(villages.map((v) => [v.code, v])), text: null };
  return table;
}

export const findDesa = (code: string): Desa | null => load().byCode.get(code) ?? null;

/** The `n` villages whose centres are closest to a point, nearest first, with the distance in km. */
export function nearestDesa(lat: number, lon: number, n = 1): (Desa & { km: number })[] {
  const cos = Math.cos((lat * Math.PI) / 180);
  const best: { d: number; v: Desa }[] = [];
  for (const v of load().located) {
    const dy = v.lat! - lat;
    const dx = (v.lon! - lon) * cos;
    const d = dx * dx + dy * dy;
    if (best.length === n && d >= best[n - 1].d) continue;
    best.push({ d, v });
    best.sort((a, b) => a.d - b.d);
    if (best.length > n) best.pop();
  }
  return best.map(({ d, v }) => ({ ...v, km: Math.round(Math.sqrt(d) * 111.2 * 10) / 10 }));
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
// Words people add that the names do not carry.
const FILLER = new Set(['desa', 'kelurahan', 'kel', 'kecamatan', 'kec', 'kabupaten', 'kab', 'kota', 'provinsi', 'prov']);

/**
 * Villages matching a typed name: every word must start a word of the village, kecamatan or kabupaten
 * name ("caturtunggal", "depok sleman", "condong"). Village-name matches come first.
 */
export function searchDesa(query: string, limit = 8): Desa[] {
  const words = norm(query).split(' ').filter((w) => w && !FILLER.has(w));
  if (!words.length || words.join('').length < 3) return [];
  const starts = (text: string, w: string) => text.startsWith(w) || text.includes(` ${w}`);
  const t = load();
  t.text ??= t.villages.map((v) => `${norm(v.name)} ${norm(v.kecamatan)} ${norm(v.kabupaten)}`);
  const hits: { rank: number; v: Desa }[] = [];
  for (let i = 0; i < t.villages.length; i++) {
    if (!words.every((w) => starts(t.text![i], w))) continue;
    const v = t.villages[i];
    const name = norm(v.name);
    const rank = name === words.join(' ') ? 0 : starts(name, words[0]) ? 1 : starts(norm(v.kecamatan), words[0]) ? 2 : 3;
    hits.push({ rank, v });
  }
  return hits
    .sort((a, b) => a.rank - b.rank || a.v.name.localeCompare(b.v.name) || a.v.code.localeCompare(b.v.code))
    .slice(0, limit)
    .map((h) => h.v);
}
