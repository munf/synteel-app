// Pond photo → a draft pond profile. Muse Spark vision looks at one photo of the pond (when it is
// added, or later from its page) and names what it sees: the container, whether it is indoors,
// under a roof or open to the sun, the water color and how bright the place is. The farmer checks
// the draft and saves it; nothing is saved by itself, and anything the model is unsure about stays
// empty. The profile feeds the water temperature model's starting values (thermal.ts).
//
// The model only picks from fixed choices. The short husbandry notes come from those choices here,
// in code: plain words about light and water, never a diagnosis or a dose.
import { tx, currentLang } from './i18n.ts';
import type { Light, WaterColor } from './thermal.ts';

export const CONTAINERS = ['akuarium', 'terpal', 'fiber', 'beton', 'tanah', 'lain'] as const;
export type Container = (typeof CONTAINERS)[number];
export const PLACES = ['indoor', 'roofed', 'open'] as const;
export type Place = (typeof PLACES)[number];
const COLORS: WaterColor[] = ['clear', 'green', 'brown', 'cloudy'];
const LIGHTS: Light[] = ['bright', 'dim', 'dark'];
type Field = 'kind' | 'place' | 'waterColor' | 'light';

export interface PondPhotoDraft {
  kind: Container | null;
  place: Place | null;
  waterColor: WaterColor | null;
  light: Light | null;
  /** Fields left empty because the model was unsure: the farmer picks them. */
  unsure: Field[];
  /** Plain husbandry notes from the light and the water color. */
  notes: string[];
  /** Reading problems ("foto gelap"), or the sample-mode label. */
  problems: string[];
  /** The photo does not show a pond or tank. */
  notPond: boolean;
  model: string;
  mode: 'meta' | 'mock';
}

// Strict JSON schema: every key present, null when not visible.
export const POND_PHOTO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_pond', 'container', 'place', 'water_color', 'light', 'unsure', 'problems'],
  properties: {
    is_pond: { type: 'boolean', description: 'Foto memperlihatkan kolam, bak atau akuarium berisi air' },
    container: { enum: [...CONTAINERS, null], description: 'akuarium = kaca; terpal = kolam/bak terpal (termasuk tangki bulat terpal); fiber = bak fiberglass; beton = bak semen/beton; tanah = kolam tanah; lain = wadah lain' },
    place: { enum: [...PLACES, null], description: 'indoor = di dalam bangunan; roofed = di luar tapi di bawah atap atau paranet; open = terbuka kena matahari langsung' },
    water_color: { enum: [...COLORS, null], description: 'clear = jernih; green = hijau; brown = cokelat; cloudy = keruh' },
    light: { enum: [...LIGHTS, null], description: 'Cahaya di permukaan air: bright = terang/kena matahari; dim = redup/teduh; dark = gelap' },
    unsure: { type: 'array', items: { enum: ['container', 'place', 'water_color', 'light'] }, description: 'Kolom yang tidak yakin' },
    problems: { type: 'array', items: { type: 'string' }, description: 'Kendala foto, contoh "foto gelap", dalam bahasa yang diminta' },
  },
} as const;

export function pondPhotoInstructions(): string {
  return [
    'Kamu membantu petani sidat di Indonesia mengisi profil kolam dari satu foto kolam.',
    'Sidat (glass eel, elver) biasanya dipelihara di akuarium, kolam terpal, bak fiber atau bak semen, kebanyakan di dalam ruangan atau di bawah atap.',
    'Isi pilihan yang terlihat jelas di foto. Ini untuk memperkirakan suhu air, bukan untuk menilai kesehatan sidat.',
    'Aturan:',
    '- Jangan menebak. Bila tidak terlihat jelas, isi null dan masukkan nama kolomnya ke unsure.',
    '- place: lihat atap, dinding, langit, bayangan. Bayangan paranet atau atap di atas air = roofed.',
    '- light: seberapa terang permukaan air saat foto diambil.',
    '- water_color: warna airnya sendiri, bukan warna dasar atau dinding wadah.',
    '- Bila foto bukan kolam/bak/akuarium berisi air, is_pond = false dan semua pilihan null.',
    '- Jangan menilai penyakit atau memberi saran obat.',
    currentLang() === 'en' ? '- Write problems in plain English.' : '- Tulis problems dalam bahasa Indonesia.',
  ].join('\n');
}

/** Plain notes from what was seen: light first (eels are night animals), then the water color. */
export function husbandryNotes(d: { light: Light | null; waterColor: WaterColor | null; place: Place | null }): string[] {
  const notes: string[] = [];
  if (d.light === 'bright')
    notes.push(tx('Tempat terang. Sidat lebih tenang di tempat redup, pertimbangkan peneduh.', 'Bright place. Eels are calmer in dim light; consider some shade.'));
  if (d.place === 'open')
    notes.push(tx('Kolam terbuka kena matahari: suhu air bisa naik cepat di siang hari. Ukur suhu juga di siang hari.', 'Open pond in the sun: the water can warm quickly at midday. Measure the temperature at midday too.'));
  if (d.waterColor === 'green')
    notes.push(tx('Air hijau: alga ikut memakai oksigen di malam hari. Pastikan aerasi nyala sepanjang malam.', 'Green water: algae also use oxygen at night. Keep the aeration on all night.'));
  else if (d.waterColor === 'brown' || d.waterColor === 'cloudy')
    notes.push(tx('Air keruh atau cokelat: perhatikan sisa pakan dan jadwal ganti air.', 'Cloudy or brown water: watch for leftover feed and keep to the water change schedule.'));
  return notes;
}

const pick = <T>(v: unknown, allowed: readonly T[]): T | null => (allowed.includes(v as T) ? (v as T) : null);

/** Keeps only the fixed choices; a field the model marked unsure is left empty. */
export function guardPondPhoto(raw: Record<string, any>, meta: { model: string; mode: 'meta' | 'mock' }): PondPhotoDraft {
  const unsureRaw: string[] = Array.isArray(raw.unsure) ? raw.unsure.filter((u: unknown) => typeof u === 'string') : [];
  const notPond = raw.is_pond === false;
  const field = <T>(name: string, allowed: readonly T[]) => (notPond || unsureRaw.includes(name) ? null : pick(raw[name], allowed));
  const kind = field('container', CONTAINERS);
  const place = field('place', PLACES);
  const waterColor = field('water_color', COLORS);
  const light = field('light', LIGHTS);
  const unsure: Field[] = [];
  if (!kind) unsure.push('kind');
  if (!place) unsure.push('place');
  if (!waterColor) unsure.push('waterColor');
  if (!light) unsure.push('light');
  const problems = (Array.isArray(raw.problems) ? raw.problems : []).filter((p: unknown) => typeof p === 'string' && p.trim()).map((p: string) => p.trim().slice(0, 120)).slice(0, 3);
  if (notPond) problems.unshift(tx('Foto ini tidak terlihat seperti kolam. Coba foto kolamnya dari atas.', 'This photo does not look like a pond. Try a photo of the pond from above.'));
  return { kind, place, waterColor, light, unsure, notes: husbandryNotes({ light, waterColor, place }), problems, notPond, ...meta };
}

/** A labelled example for mock mode: a tarp tank under a roof, green water, bright place. */
export function mockPondPhoto(): Record<string, unknown> {
  return {
    is_pond: true,
    container: 'terpal',
    place: 'roofed',
    water_color: 'green',
    light: 'bright',
    unsure: [],
    problems: [tx('Mode contoh, bukan hasil AI.', 'Sample mode, not an AI result.')],
  };
}

/** The setting and shade columns the model and the old pond profile use. */
export const placeToSetting = (place: Place | null) =>
  place === 'indoor' ? { setting: 'indoor' as const, shaded: null } : place === 'roofed' ? { setting: 'outdoor' as const, shaded: true } : place === 'open' ? { setting: 'outdoor' as const, shaded: false } : { setting: null, shaded: null };
