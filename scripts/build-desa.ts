// Builds server/geo/desa.tsv.gz: every desa/kelurahan with its Kemendagri code (the `adm4` BMKG asks for)
// and the centre of its area, plus the names of the kecamatan, kabupaten/kota and provinces above it.
//
// Sources (both MIT licence, by cahya dsn):
//   names: https://github.com/cahyadsn/wilayah            db/wilayah.sql
//   centres: https://github.com/cahyadsn/wilayah_boundaries db/kel/**.sql (centroid of each village polygon)
//
// Usage: node scripts/build-desa.ts <wilayah.sql> <wilayah_boundaries/db/kel>
// Output lines: "code<TAB>name" for provinces, kabupaten and kecamatan; "code<TAB>name<TAB>lat<TAB>lon" for villages
// (4 decimals, about 11 m). Villages without a centre keep their name, so they can still be found by name.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const [namesFile, kelDir] = process.argv.slice(2);
if (!namesFile || !kelDir) {
  console.error('usage: node scripts/build-desa.ts <wilayah.sql> <wilayah_boundaries/db/kel>');
  process.exit(1);
}

const unquote = (s: string) => s.replace(/\\'/g, "'").replace(/''/g, "'").trim();

const names = new Map<string, string>();
for (const m of readFileSync(namesFile, 'utf8').matchAll(/\('(\d{2}(?:\.\d{2}(?:\.\d{2}(?:\.\d{4})?)?)?)','((?:[^'\\]|\\.|'')*)'\)/g)) {
  names.set(m[1], unquote(m[2]));
}

const centres = new Map<string, [number, number]>();
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : f.endsWith('.sql') ? [join(dir, f)] : []));
for (const file of files(kelDir)) {
  for (const m of readFileSync(file, 'utf8').matchAll(/\('(\d{2}\.\d{2}\.\d{2}\.\d{4})','(?:[^'\\]|\\.|'')*',(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)) {
    centres.set(m[1], [Number(m[2]), Number(m[3])]);
  }
}

const lines: string[] = [];
let villages = 0;
let located = 0;
for (const [code, name] of [...names].sort(([a], [b]) => (a < b ? -1 : 1))) {
  const c = code.length === 13 ? centres.get(code) : undefined;
  if (code.length === 13) villages++;
  if (c && Math.abs(c[0]) <= 11 && c[1] >= 94 && c[1] <= 142) {
    located++;
    lines.push(`${code}\t${name}\t${c[0].toFixed(4)}\t${c[1].toFixed(4)}`);
  } else lines.push(`${code}\t${name}`);
}
const out = new URL('../server/geo/desa.tsv.gz', import.meta.url);
writeFileSync(out, gzipSync(lines.join('\n') + '\n', { level: 9 }));
console.log(`${villages} villages, ${located} with a centre, ${lines.length} lines → ${out.pathname}`);
