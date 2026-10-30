// The pond profile the water temperature estimate starts from: container, place (indoor / under a
// roof / open), water color, light and depth. A pond photo can fill it in (Muse Spark vision); the
// farmer always checks and saves it, and anything the AI was unsure of stays empty to pick by hand.
// Used when adding a pond (setup.tsx) and from the pond's page (pond.tsx). The photo also becomes the
// pond's cover picture, but only when the farmer taps Simpan (saveCover); skipped, the cover stays.
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, ApiError, type Light, type Place, type Pond, type PondPhotoDraft, type PondSummary, type WaterColor } from './api.ts';
import { prepareImage } from './capture/media.ts';
import { colorLabel, fmtNum } from './labels.ts';
import { Chips, Icon, kindLabel, tankPath } from './ui.tsx';
import { t } from './i18n.ts';

export const CONTAINERS = ['akuarium', 'terpal', 'fiber', 'beton', 'tanah', 'lain'] as const;
export const placeLabel: Record<Place, string> = {
  indoor: t('Dalam ruangan', 'Indoors'),
  roofed: t('Beratap / paranet', 'Roof or shade net'),
  open: t('Terbuka', 'Open to the sun'),
};
export const lightLabel: Record<Light, string> = { bright: t('Terang', 'Bright'), dim: t('Redup', 'Dim'), dark: t('Gelap', 'Dark') };
const waterLabel = colorLabel as Record<WaterColor, string>;

export interface ProfileValue {
  kind: string | null;
  place: Place | null;
  waterColor: WaterColor | null;
  light: Light | null;
  depthCm: string;
}

/** A saved pond's place from its setting and shade answer. */
export const placeOf = (p: Pick<Pond, 'setting' | 'shaded'>): Place | null =>
  p.setting === 'indoor' ? 'indoor' : p.setting === 'outdoor' ? (p.shaded === false ? 'open' : p.shaded === true ? 'roofed' : null) : null;

export const profileOf = (p: Pond): ProfileValue => ({ kind: p.kind, place: placeOf(p), waterColor: p.waterColor ?? null, light: p.light ?? null, depthCm: p.depthCm ? String(p.depthCm) : '' });

/** "Bak fiber · dalam ruangan · air jernih · redup · 30 cm" */
export function profileLine(p: Pond): string {
  const place = placeOf(p);
  return [
    p.kind && (kindLabel[p.kind] ?? p.kind),
    place && placeLabel[place].toLowerCase(),
    p.waterColor && t(`air ${waterLabel[p.waterColor].toLowerCase()}`, `${waterLabel[p.waterColor].toLowerCase()} water`),
    p.light && lightLabel[p.light].toLowerCase(),
    p.depthCm && `${fmtNum(p.depthCm)} cm`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** How far the water temperature estimate is usually off for a pond, from its own readings (or the prior while it learns). */
export function errorWords(m: { typicalError: number; learning: boolean }, capital = false) {
  const x = fmtNum(m.typicalError);
  const s = m.learning ? t(`baru belajar, ±${x} °C`, `still learning, ±${x} °C`) : t(`biasanya meleset ±${x} °C`, `usually off by ±${x} °C`);
  return capital ? s[0].toUpperCase() + s.slice(1) : s;
}

/** The body fields for the server. */
export const profileBody = (v: ProfileValue) => ({
  kind: v.kind,
  place: v.place,
  waterColor: v.waterColor,
  light: v.light,
  depthCm: v.depthCm ? Number(v.depthCm.replace(',', '.')) : undefined,
});

type Field = 'kind' | 'place' | 'waterColor' | 'light';

/** Marks a choice the photo filled in, or one it left for the farmer. */
function Mark({ field, draft }: { field: Field; draft: PondPhotoDraft | null }) {
  if (!draft) return null;
  if (draft.unsure.includes(field))
    return (
      <span class="label ink2" style={{ fontWeight: 400 }}>
        {t('AI belum yakin, pilih sendiri', 'The AI is not sure; pick it yourself')}
      </span>
    );
  return (
    <span class="label semi row" style={{ gap: 4, color: 'var(--accent-ink)' }}>
      <Icon name="sparkle" size={16} /> {t('dari foto, cek lagi', 'from the photo, check it')}
    </span>
  );
}

/** Container tiles, place, water color, light and depth. `draft`: the photo reading these came from, to mark them. */
export function ProfileFields({ value, onChange, draft, depth = true }: { value: ProfileValue; onChange: (v: ProfileValue) => void; draft: PondPhotoDraft | null; depth?: boolean }) {
  const set = (patch: Partial<ProfileValue>) => onChange({ ...value, ...patch });
  return (
    <div class="stack">
      <div class="field">
        <span class="field-label row between">
          {t('Jenis wadah', 'Container')}
          <Mark field="kind" draft={draft} />
        </span>
        <div class="grid3">
          {CONTAINERS.map((id) => (
            <button type="button" key={id} class={`type-tile${value.kind === id ? ' on' : ''}`} aria-pressed={value.kind === id} onClick={() => set({ kind: value.kind === id ? null : id })}>
              <span class="thumb sm" style={{ width: 48, height: 48, background: 'var(--bg)', color: 'var(--ink-2)' }}>
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d={tankPath(id)} />
                </svg>
              </span>
              {kindLabel[id]}
              {value.kind === id && (
                <span class="corner-tick">
                  <Icon name="check" size={14} stroke={3} />
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
      <div class="field">
        <span class="field-label row between">
          {t('Tempat kolam', 'Where the pond is')}
          <Mark field="place" draft={draft} />
        </span>
        <Chips options={placeLabel} value={value.place ? [value.place] : []} onChange={(v) => set({ place: v[0] ?? null })} />
      </div>
      <div class="field">
        <span class="field-label row between">
          {t('Warna air', 'Water color')}
          <Mark field="waterColor" draft={draft} />
        </span>
        <Chips options={waterLabel} value={value.waterColor ? [value.waterColor] : []} onChange={(v) => set({ waterColor: v[0] ?? null })} />
      </div>
      <div class="field">
        <span class="field-label row between">
          {t('Cahaya di kolam', 'Light at the pond')}
          <Mark field="light" draft={draft} />
        </span>
        <Chips options={lightLabel} value={value.light ? [value.light] : []} onChange={(v) => set({ light: v[0] ?? null })} />
        <span class="field-hint">{t('Sidat hewan malam: lebih tenang di tempat redup.', 'Eels are night animals: calmer in dim places.')}</span>
      </div>
      {depth && (
        <label class="field">
          <span class="field-label">{t('Kedalaman air (cm)', 'Water depth (cm)')}</span>
          <input inputMode="decimal" value={value.depthCm} onInput={(e) => set({ depthCm: e.currentTarget.value })} placeholder="30" />
        </label>
      )}
    </div>
  );
}

/** What Simpan does to the pond's cover: a new picture, remove it, or leave it (null). */
export type CoverChange = { image: Blob; url: string } | 'remove' | null;

/** The cover change a form holds until Simpan, with the preview address freed when it is replaced. */
export function useCoverChange() {
  const [change, setChange] = useState<CoverChange>(null);
  useEffect(() => () => void (change && change !== 'remove' && URL.revokeObjectURL(change.url)), [change]);
  return [change, setChange] as const;
}

/** A new photo for the cover, made small on the phone first (about 1000 px on the long side). */
export async function coverChange(file: Blob): Promise<CoverChange> {
  const { blob } = await prepareImage(file, 1024, 0.8);
  return { image: blob, url: URL.createObjectURL(blob) };
}

/** Saves the cover change after the pond itself was saved. Returns the pond as it is now, or null when nothing changed. */
export async function saveCover(pondId: number, change: CoverChange): Promise<PondSummary | null> {
  if (change === 'remove') return (await api.removePondCover(pondId)).pond;
  if (change) return (await api.setPondCover(pondId, change.image)).pond;
  return null;
}

/**
 * "Foto kolam": take or pick a photo, the AI names what it sees, and the choices below are filled
 * in as a draft. Shows the husbandry notes and, in sample mode, says so. The photo is also offered as
 * the pond's cover (`onCover`); `cover` is the picture shown: the new one, or the saved one.
 */
export function PondPhoto({
  pondId,
  draft,
  onDraft,
  onQuota,
  cover,
  pending = false,
  onCover,
  onRemove,
}: {
  pondId?: number;
  draft: PondPhotoDraft | null;
  onDraft: (d: PondPhotoDraft) => void;
  onQuota?: () => void;
  /** The picture to show: the new photo, or the pond's saved cover. */
  cover?: string | null;
  /** `cover` is a new photo that is saved with Simpan. */
  pending?: boolean;
  /** A new photo was taken (null: it was not a pond, so it is not used as the cover). */
  onCover?: (c: CoverChange) => void;
  /** "Hapus foto sampul": the cover goes when the farmer taps Simpan. */
  onRemove?: () => void;
}) {
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; quota: boolean } | null>(null);
  const [dropped, setDropped] = useState(false);

  const read = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    setBusy(true);
    setError(null);
    setDropped(false);
    try {
      const { blob } = await prepareImage(file, 1280, 0.82);
      onCover?.(await coverChange(file));
      const d = (await api.pondPhoto(blob, pondId)).draft;
      // Not a pond: the photo is not kept as the cover.
      if (d.notPond && onCover) {
        onCover(null);
        setDropped(true);
      }
      onDraft(d);
    } catch (err) {
      const quota = err instanceof ApiError && err.code === 'ai_quota';
      setError({ text: err instanceof TypeError ? t('Belum ada sinyal. Pilih sendiri dulu, atau coba lagi nanti.', 'No signal yet. Pick them yourself, or try again later.') : (err as Error).message, quota });
    } finally {
      setBusy(false);
    }
  };

  const seen = draft && [draft.kind && kindLabel[draft.kind], draft.place && placeLabel[draft.place], draft.waterColor && t(`air ${waterLabel[draft.waterColor].toLowerCase()}`, `${waterLabel[draft.waterColor].toLowerCase()} water`), draft.light && lightLabel[draft.light]].filter(Boolean);

  return (
    <div class="card dashed" style={{ gap: 12 }}>
      <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={read} />
      <input ref={gallery} type="file" accept="image/*" hidden onChange={read} />
      <div class="row">
        {cover ? (
          <img src={cover} alt={t('Foto kolam', 'Pond photo')} style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 16, flex: 'none' }} />
        ) : (
          <span class="icon-box" style={{ width: 56, height: 56, borderRadius: 28 }}>
            <Icon name="camera" size={26} />
          </span>
        )}
        <span class="grow stack-xs">
          <span class="strong">{t('Foto kolam', 'Pond photo')}</span>
          <span class="meta">{t('AI membaca jenis wadah, tempat, warna air dan cahaya. Cek dulu sebelum disimpan.', 'The AI reads the container, place, water color and light. Check before saving.')}</span>
          {onCover && cover && (
            <span class="label ink2">{pending ? t('Jadi foto sampul kolam setelah Simpan.', 'Becomes the pond cover after Save.') : t('Foto sampul kolam sekarang.', 'The pond cover now.')}</span>
          )}
          {dropped && <span class="label ink2">{t('Foto ini tidak dipakai jadi sampul kolam.', 'This photo is not used as the pond cover.')}</span>}
        </span>
      </div>
      <div class="grid2" style={{ gap: 8 }}>
        <button type="button" class="btn secondary" disabled={busy} onClick={() => camera.current?.click()}>
          <Icon name="camera" size={20} /> {draft ? t('Foto lagi', 'New photo') : t('Ambil foto', 'Take a photo')}
        </button>
        <button type="button" class="btn secondary" disabled={busy} onClick={() => gallery.current?.click()}>
          {t('Dari galeri', 'From gallery')}
        </button>
      </div>
      {cover && onRemove && (
        <button type="button" class="link-btn" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={onRemove}>
          {pending ? t('Jangan pakai foto ini', 'Do not use this photo') : t('Hapus foto sampul', 'Remove cover photo')}
        </button>
      )}
      {busy && (
        <p class="working" role="status">
          {t('AI melihat foto kolam…', 'The AI is looking at the pond photo…')}
        </p>
      )}
      {error && (
        <div class="note warn" role="alert">
          <Icon name="alert" size={20} />
          <span class="stack-xs">
            <span>{error.text}</span>
            {error.quota && onQuota && (
              <button type="button" class="rp-link warn" onClick={onQuota}>
                {t('Lihat jatah AI', 'View daily AI reads')}
              </button>
            )}
          </span>
        </div>
      )}
      {draft && !busy && (
        <div class="stack-sm" role="status">
          {draft.mode === 'mock' && <span class="soon">{t('Mode contoh, bukan hasil AI', 'Sample mode, not an AI result')}</span>}
          <span class="strong">{seen && seen.length ? t(`Terbaca: ${seen.join(' · ')}`, `Seen: ${seen.join(' · ')}`) : t('Belum ada yang terbaca jelas.', 'Nothing could be read clearly.')}</span>
          {draft.unsure.length > 0 && !draft.notPond && <span class="label ink2">{t('Yang belum yakin dibiarkan kosong: pilih sendiri di bawah.', 'What the AI was not sure of is left empty: pick it below.')}</span>}
          {draft.problems.filter((p) => !/Mode contoh|Sample mode/.test(p)).map((p) => (
            <span key={p} class="label ink2">
              {p}
            </span>
          ))}
          {draft.notes.map((n) => (
            <div key={n} class="note info">
              <Icon name="info" size={20} />
              <span>{n}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Applies a photo draft to the form: what the AI saw, and empty where it was unsure (the farmer picks). Not a pond: nothing changes. */
export const applyDraft = (v: ProfileValue, d: PondPhotoDraft): ProfileValue =>
  d.notPond ? v : { ...v, kind: d.kind, place: d.place, waterColor: d.waterColor, light: d.light };
