import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Finding, Level, PondSummary } from './api.ts';
import { fmtClock, levelLabel, phaseLabel } from './labels.ts';
import { lang, LOCALE, setLang, t, type Lang } from './i18n.ts';

// ---------- icons (stroke, 24 grid) ----------

const PATHS = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  pencil: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  alert: 'M10.27 4a2 2 0 0 1 3.46 0l7.53 13a2 2 0 0 1-1.73 3H4.47a2 2 0 0 1-1.73-3zM12 10v4M12 17v.5',
  mic: 'M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 9.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z',
  video: 'M3 6h13v12H3zM16 10l5-3v10l-5-3',
  check: 'm5 12 5 5 9-10',
  back: 'm15 5-7 7 7 7',
  next: 'm9 5 7 7-7 7',
  down: 'm5 9 7 7 7-7',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z',
  chat: 'M4 20l1.5-4A8 8 0 1 1 8 18.5z',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  drop: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z',
  cloud: 'M7 18h10a4 4 0 0 0 0-8 6 6 0 0 0-11.5 1.5A3.3 3.3 0 0 0 7 18z',
  sun: 'M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  rain: 'M7 15h10a4 4 0 0 0 0-8 6 6 0 0 0-11.5 1.5A3.3 3.3 0 0 0 7 15zM8 19l-1 2M12 19l-1 2M16 19l-1 2',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
  flame: 'M12 3c1 3 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5.5 1.5 1.5 2.5 2.5 2.5 0-3-1-5.5.5-8z',
  gift: 'M4 11h16v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM3 7h18v4H3zM12 7v14M12 7S10.5 3 8 3a2 2 0 0 0 0 4M12 7s1.5-4 4-4a2 2 0 0 1 0 4',
  sliders: 'M4 7h10M18 7h2M4 17h4M12 17h8M16 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM10 15a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  heart: 'M12 21s-7-4.5-9-9.5C1.5 7.5 4 4 7.5 4c2 0 3.5 1 4.5 2.5C13 5 14.5 4 16.5 4 20 4 22.5 7.5 21 11.5 19 16.5 12 21 12 21z',
  chart: 'M5 20V10M12 20V4M19 20v-7',
  user: 'M9 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM2 21a7 7 0 0 1 14 0M19 8v6M16 11h6',
  thermo: 'M10 4a2 2 0 0 1 4 0v10a4 4 0 1 1-4 0zM12 9v6',
  wifi: 'M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01',
  nowifi: 'M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01M3 3l18 18',
  dead: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9 9l6 6M15 9l-6 6',
  up: 'M12 19V6M6 11l6-6 6 6M4 21h16',
  inlet: 'M4 6l6 6-6 6M20 6l-6 6 6 6',
  bowl: 'M3 11h18a9 9 0 0 1-18 0zM8 7c0-2 2-2 2-4M13 7c0-2 2-2 2-4',
  spots: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9 10h.01M14 14h.01M15 9h.01',
  bolt: 'M13 3 5 14h6l-1 7 8-11h-6z',
  dots: 'M5 12h.01M12 12h.01M19 12h.01',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0',
  sparkle: 'M12 3l1.8 4.6L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.9zM19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z',
  key: 'M8 10a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM11 12l9-9M17 6l3 3M14 9l2 2',
  logout: 'M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 8l-4 4 4 4M6 12h11',
  users: 'M9 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM2 21a7 7 0 0 1 14 0M16 4a4 4 0 0 1 0 8M18 14a6 6 0 0 1 4 7',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  login: 'M9 4H5v16h4M14 8l4 4-4 4M18 12H9',
  userCheck: 'M9 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM2 21a7 7 0 0 1 12.5-4.3M15 18l2 2 4-4',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  offline: 'M3 3l18 18M8.5 16a5 5 0 0 1 7 0M5 12.5a10 10 0 0 1 4.2-2.6M14.5 9.9a10 10 0 0 1 4.5 2.6M12 19.5h.01',
  siren: 'M7 18v-6a5 5 0 0 1 10 0v6M5 21h14v-3H5zM12 3v1.5M4.6 6.6l1.1 1.1M19.4 6.6l-1.1 1.1',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 7.5v.5',
  // An open notebook with lines on the right page.
  book: 'M12 6.5C10.3 5 7.8 4.5 4 4.5v14c3.8 0 6.3.5 8 2 1.7-1.5 4.2-2 8-2v-14c-3.8 0-6.3.5-8 2zM12 6.5v14M14.5 9h3M14.5 12h3M14.5 15h3',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  headset: 'M4 13a8 8 0 0 1 16 0M4 13v3a2 2 0 0 0 2 2h1v-6H6a2 2 0 0 0-2 2zM20 13v3a2 2 0 0 1-2 2h-1v-6h1a2 2 0 0 1 2 2zM17 18c0 1.5-2 3-5 3',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 22, stroke = 2, class: cls }: { name: IconName; size?: number; stroke?: number; class?: string }) {
  return (
    <svg class={cls} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

export const Tick = ({ size = 16 }: { size?: number }) => <Icon name="check" size={size} stroke={3} />;

// ---------- status: shape + word, never colour alone ----------

export type Tone = 'ok' | 'warn' | 'bad' | 'blue';

/** Pond-level findings: 'info' is a note, not a warning. */
export const toneOf = (level: Level): Tone => (level === 'critical' ? 'bad' : level === 'warning' ? 'warn' : level === 'info' ? 'blue' : 'ok');

const SHAPE: Record<Tone, { d: string; fill: string }> = {
  ok: { d: 'M6 1a5 5 0 1 0 0 10A5 5 0 0 0 6 1z', fill: 'var(--ok-dot)' },
  warn: { d: 'M1 1h10v10H1z', fill: 'var(--warn-dot)' },
  bad: { d: 'M5.13 1.5a1 1 0 0 1 1.74 0l4.5 8a1 1 0 0 1-.87 1.5H1.5a1 1 0 0 1-.87-1.5z', fill: 'var(--bad-dot)' },
  blue: { d: 'M6 1a5 5 0 1 0 0 10A5 5 0 0 0 6 1z', fill: 'var(--accent)' },
};

export function Shape({ tone, size = 12 }: { tone: Tone; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden="true">
      <path d={SHAPE[tone].d} style={{ fill: SHAPE[tone].fill }} />
    </svg>
  );
}

export function StatusPill({ level, children }: { level: Level; children?: ComponentChildren }) {
  const tone = toneOf(level);
  return (
    <span class={`pill ${tone}`}>
      <Shape tone={tone} />
      {children ?? levelLabel[level]}
    </span>
  );
}

/** Marks a part of the design that is not live yet. */
export const Soon = ({ children = t('Belum tersedia', 'Not available yet') }: { children?: ComponentChildren }) => <span class="soon">{children}</span>;

/** A pond fed by a simulated Synteel device: grey like "Belum tersedia", no shape (it is not a status). */
export const SimChip = ({ pond }: { pond: { simulated?: boolean } }) => (pond.simulated ? <span class="soon sim">{t('Simulasi', 'Simulation')}</span> : null);

// ---------- pond thumbnail: the farmer's photo later; a line drawing of the pond type for now ----------
// Line drawings, never a plain circle or square: those shapes mean Aman and Perhatian.

const TANK: Record<string, string> = {
  bulat: 'M5 7c0-1.7 3.1-3 7-3s7 1.3 7 3v10c0 1.7-3.1 3-7 3s-7-1.3-7-3zM5 7c0 1.7 3.1 3 7 3s7-1.3 7-3M5 13c2 .8 4.3 1.2 7 1.2s5-.4 7-1.2',
  terpal: 'M3 8h18l-2 11H5zM6.5 12.5c1.4-.9 2.8-.9 4.2 0s2.8.9 4.2 0 2.4-.8 3.1-.4',
  fiber: 'M4 6h16v3H4zM5 9l1 10h12l1-10M8 14c1.3-.8 2.7-.8 4 0s2.7.8 4 0',
  // A Synteel Nursery tank with its sensor probe.
  gen5: 'M4 8h16v12H4zM4 13c2.7-1 5.3-1 8 0s5.3 1 8 0M15 3v9M13 3h4',
};
export const tankPath = (kind: string | null) => TANK[kind === 'beton' ? 'terpal' : (kind ?? 'terpal')] ?? TANK.terpal;
export const kindLabel: Record<string, string> = {
  bulat: t('Tangki bulat', 'Round tank'),
  terpal: t('Terpal', 'Tarp'),
  beton: t('Beton', 'Concrete'),
  fiber: t('Bak fiber', 'Fiber tub'),
  gen5: 'Synteel Nursery Gen0',
};

export function PondThumb({ kind, size = 56 }: { kind: string | null; size?: number }) {
  return (
    <span class={`thumb${size <= 40 ? ' sm' : ''}`} style={{ width: size, height: size }}>
      <svg width={Math.round(size * 0.5)} height={Math.round(size * 0.5)} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d={tankPath(kind)} />
      </svg>
    </span>
  );
}

export function pondMeta(p: PondSummary): string {
  if (!p.batch || !p.program) return p.kind ? kindLabel[p.kind] ?? p.kind : t('Belum ada batch', 'No batch yet');
  const parts = [phaseLabel[p.batch.phase], t(`minggu ${Math.max(1, p.program.week)}`, `week ${Math.max(1, p.program.week)}`)];
  if (p.program.estimatedAlive !== null) parts.push(t(`sekitar ${p.program.estimatedAlive.toLocaleString(LOCALE)} ekor`, `about ${p.program.estimatedAlive.toLocaleString(LOCALE)} ${p.program.estimatedAlive === 1 ? 'eel' : 'eels'}`));
  return parts.join(' · ');
}

// ---------- pond picker: a dropdown with search, for farms with many ponds ----------

export function PondPicker({
  ponds,
  value,
  onChange,
  placeholder,
}: {
  ponds: PondSummary[];
  value: number | null;
  onChange: (id: number) => void;
  /** Shown when nothing is chosen yet: emergencies start empty so the wrong pond is never assumed. */
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const cur = ponds.find((p) => p.id === value);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  const q = query.trim().toLowerCase();
  const shown = q ? ponds.filter((p) => p.name.toLowerCase().includes(q)) : ponds;

  return (
    <div class="picker" ref={ref}>
      <button
        type="button"
        class={`picker-btn${open ? ' open' : cur ? '' : ' empty'}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {cur ? (
          <PondThumb kind={cur.kind} />
        ) : (
          <span class="thumb" style={{ width: 56, height: 56, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>
            <Icon name="plus" />
          </span>
        )}
        <span class="grow stack-xs">
          <span class="h2">
            {cur ? cur.name : (placeholder ?? t('Pilih kolam', 'Choose a pond'))}
            {cur && <SimChip pond={cur} />}
          </span>
          <span class="meta">{cur ? pondMeta(cur) : t('Belum dipilih', 'Not chosen yet')}</span>
        </span>
        <Icon name="down" />
      </button>
      {open && (
        <div class="picker-menu">
          {ponds.length > 5 && (
            <label class="picker-search">
              <Icon name="search" size={20} />
              <input aria-label={t('Cari kolam', 'Search ponds')} placeholder={t('Cari nama kolam', 'Search pond name')} value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
            </label>
          )}
          <div role="listbox" aria-label={t('Daftar kolam', 'Pond list')} class="stack-xs">
            {shown.map((p) => (
              <button
                type="button"
                key={p.id}
                role="option"
                aria-selected={p.id === value}
                class={`picker-option${p.id === value ? ' on' : ''}`}
                onClick={() => {
                  onChange(p.id);
                  setOpen(false);
                  setQuery('');
                }}
              >
                <PondThumb kind={p.kind} size={40} />
                <span class="grow stack-xs">
                  <span class="strong">
                    {p.name} <SimChip pond={p} />
                  </span>
                  <span class="meta">{pondMeta(p)}</span>
                </span>
                <span class={`word ${toneOf(p.level)}`}>
                  <Shape tone={toneOf(p.level)} />
                </span>
                {p.id === value && <Tick />}
              </button>
            ))}
            {shown.length === 0 && <p class="meta" style={{ padding: '16px 8px' }}>{t('Tidak ada kolam dengan nama itu.', 'No pond with that name.')}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- form parts ----------

/** The Synteel wordmark at the top of setup and sign-in. */
export function Wordmark() {
  return (
    <div class="row" style={{ gap: 8 }}>
      <span class="icon-box" style={{ width: 36, height: 36, borderRadius: 12, background: 'var(--navy)', color: '#fff' }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
          <path d="M3 13c3-4 5-4 8 0s5 4 10-2" />
        </svg>
      </span>
      <span class="title">synteel</span>
    </div>
  );
}

/** Six-digit PIN: hidden like a password, but the phone shows the number pad. */
export function PinInput({ value, onChange, autoComplete = 'current-password', label }: { value: string; onChange: (v: string) => void; autoComplete?: string; label?: string }) {
  return (
    <input
      type="password"
      inputMode="numeric"
      pattern="[0-9]*"
      maxLength={6}
      autoComplete={autoComplete}
      aria-label={label}
      class="pin-input"
      value={value}
      onInput={(e) => {
        const v = e.currentTarget.value.replace(/\D/g, '').slice(0, 6);
        e.currentTarget.value = v;
        onChange(v);
      }}
      placeholder="••••••"
      required
    />
  );
}

/** Language before signing in (Sambutan, Masuk): the same choice as in Profil. Language names are never translated. */
export function LangSwitch({ onHero = false }: { onHero?: boolean }) {
  const options: { id: Lang; label: string }[] = [
    { id: 'id', label: 'Indonesia' },
    { id: 'en', label: 'English' },
  ];
  return (
    <div role="radiogroup" aria-label={t('Bahasa', 'Language')} class="row" style={{ gap: 4, flex: 'none', marginLeft: 'auto' }}>
      {options.map((o) => {
        const on = lang === o.id;
        // On the navy header the chosen one is white; elsewhere it is navy.
        const look = onHero ? (on ? 'light' : '') : on ? 'primary' : 'secondary';
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            lang={o.id}
            class={`btn compact ${look}`}
            style={{ padding: '0 12px', ...(onHero && !on && { background: 'transparent', color: '#fff', border: '2px solid var(--hero-ring)' }) }}
            onClick={() => setLang(o.id)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** "6281234567890" → "0812 3456 7890", the way people write their number. */
export function fmtPhone(phone: string) {
  const local = phone.startsWith('62') ? '0' + phone.slice(2) : phone;
  return local.replace(/(\d{4})(?=\d)/g, '$1 ');
}

export const initialOf = (name: string | undefined) => (name ?? 'S').replace(/^tambak\s+/i, '').trim().charAt(0).toUpperCase() || 'S';

export const roleLabel: Record<'owner' | 'worker', string> = { owner: t('Pemilik', 'Owner'), worker: t('Pekerja', 'Worker') };

export function Chips<T extends string>(props: {
  options: Record<T, string>;
  value: T[];
  onChange: (v: T[]) => void;
  multiple?: boolean;
}) {
  const toggle = (key: T) => {
    if (!props.multiple) return props.onChange(props.value.includes(key) ? [] : [key]);
    props.onChange(props.value.includes(key) ? props.value.filter((v) => v !== key) : [...props.value, key]);
  };
  return (
    <div class="chips" role="group">
      {(Object.keys(props.options) as T[]).map((key) => {
        const on = props.value.includes(key);
        return (
          <button type="button" key={key} class={`chip${on ? ' on' : ''}`} aria-pressed={on} onClick={() => toggle(key)}>
            {on && <Tick />}
            {props.options[key]}
          </button>
        );
      })}
    </div>
  );
}

export function Field({ label, hint, children }: { label: ComponentChildren; hint?: string; children: ComponentChildren }) {
  return (
    <label class="field">
      <span class="field-label">{label}</span>
      {children}
      {hint && <span class="field-hint">{hint}</span>}
    </label>
  );
}

/**
 * A count: − and + for small changes, the number itself can be typed (tap it), and optional
 * quick-add buttons (+5, +10…) so 60 dead eels don't take 60 taps.
 */
export function Stepper({ value, onChange, min = 0, quick, tapHint = true }: { value: number; onChange: (n: number) => void; min?: number; quick?: number[]; tapHint?: boolean }) {
  // The typed text while the field has focus, so an empty field doesn't snap back to the minimum mid-typing.
  const [typing, setTyping] = useState<string | null>(null);
  const set = (n: number) => onChange(Math.max(min, Math.min(99_999, n)));
  return (
    <div class="stepper-wrap">
      <div class="stepper">
        <button type="button" aria-label={t('Kurangi', 'Less')} onClick={() => set(value - 1)}>
          −
        </button>
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          aria-label={t('Jumlah, ketuk untuk mengetik', 'Amount, tap to type')}
          value={typing ?? String(value)}
          onFocus={(e) => (setTyping(String(value)), e.currentTarget.select())}
          onInput={(e) => {
            const typed = e.currentTarget.value.replace(/\D/g, '').slice(0, 5);
            setTyping(typed);
            if (typed !== '') set(Number(typed));
          }}
          onBlur={() => setTyping(null)}
        />
        <button type="button" aria-label={t('Tambah', 'More')} onClick={() => set(value + 1)}>
          +
        </button>
      </div>
      {quick && (
        <div class="quick-add">
          {quick.map((q) => (
            <button key={q} type="button" onClick={() => set(value + q)}>
              +{q}
            </button>
          ))}
          {tapHint && <span class="label muted">{t('atau ketuk angkanya', 'or tap the number')}</span>}
        </div>
      )}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange?: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" class="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange?.(!checked)}>
      <span />
    </button>
  );
}

export function TickBox({ on }: { on: boolean }) {
  return <span class={`tick-box${on ? ' on' : ''}`}>{on && <Tick />}</span>;
}

// ---------- findings ----------

export function FindingCard({ finding, pondName }: { finding: Finding; pondName?: string }) {
  return (
    <article class="card">
      <div class="row top between">
        <div class="stack-xs grow">
          {pondName && <span class="meta">{pondName}</span>}
          <h2>{finding.title}</h2>
        </div>
        <StatusPill level={finding.level} />
      </div>
      <p class="ink2">{finding.detail}</p>
      {finding.actions.length > 0 && (
        <ol class="stack-xs" style={{ margin: 0, paddingLeft: '1.2em' }}>
          {finding.actions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ol>
      )}
      <p class="meta">{t('Sumber', 'Source')}: {finding.source}</p>
    </article>
  );
}

/** Empty state: a simple visual, one sentence, one action. */
export function EmptyState({ icon, text, action }: { icon: IconName; text: ComponentChildren; action?: ComponentChildren }) {
  return (
    <div class="card">
      <div class="row">
        <span class="icon-box grey">
          <Icon name={icon} />
        </span>
        <p class="grow">{text}</p>
      </div>
      {action}
    </div>
  );
}

/** A note with a bold first line: errors and states the person should read before going on. */
export function Notice({
  tone,
  icon,
  title,
  children,
  role,
}: {
  tone: 'info' | 'warn' | 'ok' | 'bad';
  icon: IconName;
  title: ComponentChildren;
  children?: ComponentChildren;
  role?: 'alert' | 'status';
}) {
  return (
    <div class={`note ${tone}`} role={role}>
      <Icon name={icon} />
      <span class="stack-xs">
        <span class="note-title">{title}</span>
        {children && <span>{children}</span>}
      </span>
    </div>
  );
}

/**
 * Shown on top of the current screen when a refresh fails but data is already on screen.
 * The app retries by itself every 30 seconds; "Coba lagi" retries at once.
 */
export function ConnectionBanner({ since, retrying, stillOff, onRetry }: { since: number | null; retrying: boolean; stillOff: boolean; onRetry: () => void }) {
  return (
    <div class="conn-banner" role="status">
      <div class="row top">
        <Icon name="offline" />
        <span class="stack-xs">
          <span class="note-title">{t('Belum tersambung ke server', 'Not connected to the server')}</span>
          <span>
            {t(
              `Data yang sudah tampil masih bisa dibaca${since ? ` (terakhir ${fmtClock(since)})` : ''}. Catatan baru disimpan di HP dan terkirim sendiri saat tersambung.`,
              `Data already shown can still be read${since ? ` (last updated ${fmtClock(since)})` : ''}. New records are saved on the phone and sent once connected.`,
            )}
          </span>
          {stillOff && <span class="semi">{t('Masih belum tersambung. Dicoba lagi otomatis tiap 30 detik.', 'Still not connected. Trying again on its own every 30 seconds.')}</span>}
        </span>
      </div>
      <button type="button" disabled={retrying} onClick={onRetry}>
        <Icon name="refresh" size={20} />
        {retrying ? t('Menyambung…', 'Connecting…') : t('Coba lagi', 'Try again')}
      </button>
    </div>
  );
}

// ---------- round 3 additions (appended; earlier exports unchanged) ----------

/** A stroke icon from a path that is not in the shared set (24 grid). */
export function Glyph({ d, size = 22, stroke = 2, style }: { d: string; size?: number; stroke?: number; style?: Record<string, string | number> }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style={{ flex: 'none', ...style }}>
      <path d={d} />
    </svg>
  );
}

export const GLYPH = {
  eyeOff: 'M3 3l18 18M10.6 6.1A10 10 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3.2 3.9M6.6 6.6C3.7 8.4 2 12 2 12s3.5 6 10 6a9.7 9.7 0 0 0 4.4-1',
  mobile: 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM11 18h2',
  play: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM10 8.5v7l6-3.5z',
  errorCircle: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8v5M12 16v.5',
  spinner: 'M12 3a9 9 0 1 0 9 9',
} as const;

/**
 * Six-digit PIN as six boxes over one hidden number field. The next box is outlined only while the
 * field has focus. A PIN being created is shown by default (no typo), a PIN being typed to sign in is masked.
 */
export function PinBoxes({
  value,
  onChange,
  defaultShow = false,
  autoComplete = 'current-password',
  locked = false,
  error = false,
  hint,
  id = 'pin',
}: {
  value: string;
  onChange: (v: string) => void;
  defaultShow?: boolean;
  autoComplete?: string;
  /** Too many tries: grey boxes, no field, "Dikunci". */
  locked?: boolean;
  /** The last try was wrong: red outlines. */
  error?: boolean;
  hint?: ComponentChildren;
  id?: string;
}) {
  const [show, setShow] = useState(defaultShow);
  const [focus, setFocus] = useState(false);
  return (
    <div class="stack-sm">
      <div class="row between" style={{ gap: 8 }}>
        <label for={id} class="field-label" style={locked ? { color: 'var(--ink-2)' } : undefined}>
          {locked ? 'PIN' : t('PIN 6 angka', '6-digit PIN')}
        </label>
        {locked ? (
          <span class="label strong row" style={{ minHeight: 44, gap: 4, color: 'var(--ink-2)' }}>
            <Icon name="lock" size={18} /> {t('Dikunci', 'Locked')}
          </span>
        ) : (
          <button type="button" class="link-btn label row" style={{ gap: 4, fontWeight: 800 }} aria-pressed={show} onClick={() => setShow(!show)}>
            {show ? <Glyph d={GLYPH.eyeOff} size={18} /> : <Icon name="eye" size={18} />}
            {show ? t('Sembunyikan', 'Hide') : t('Lihat PIN', 'Show PIN')}
          </button>
        )}
      </div>
      <div style={{ position: 'relative', display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', gap: 8 }}>
        {[0, 1, 2, 3, 4, 5].map((i) => {
          const has = !locked && Boolean(value[i]);
          const next = !locked && focus && i === Math.min(value.length, 5);
          const border = locked
            ? '2px solid var(--line)'
            : next
              ? '3px solid var(--ink)'
              : error
                ? '2px solid var(--bad-dot)'
                : has
                  ? '2px solid var(--pin-filled)'
                  : '2px solid var(--line-2)';
          return (
            <span
              key={i}
              aria-hidden="true"
              style={{
                height: 56,
                borderRadius: 16,
                border,
                background: locked ? 'var(--bg)' : has ? 'var(--soft)' : 'var(--surface)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '1.5rem',
                fontWeight: 800,
                fontVariantNumeric: 'tabular-nums',
                color: 'var(--ink)',
              }}
            >
              {has ? (show ? value[i] : '•') : ''}
            </span>
          );
        })}
        {!locked && (
          <input
            id={id}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            autoComplete={autoComplete}
            aria-label={t('PIN 6 angka', '6-digit PIN')}
            aria-invalid={error || undefined}
            value={value}
            onFocus={() => setFocus(true)}
            onBlur={() => setFocus(false)}
            onInput={(e) => {
              const v = e.currentTarget.value.replace(/\D/g, '').slice(0, 6);
              e.currentTarget.value = v;
              onChange(v);
            }}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', padding: 0, margin: 0, opacity: 0, border: 0, fontSize: 16, cursor: 'text', caretColor: 'transparent' }}
          />
        )}
      </div>
      {hint && <span class="label ink2">{hint}</span>}
    </div>
  );
}

/**
 * The main action of a long screen, kept in reach: sticky above the tab bar (72px), full-bleed white with a
 * hairline on top. Put it last inside `.screen`.
 */
export function ActionBar({ children }: { children: ComponentChildren }) {
  return (
    <div
      style={{
        position: 'sticky',
        bottom: 'calc(72px + env(safe-area-inset-bottom, 0px))',
        zIndex: 5,
        margin: '0 -20px -24px',
        padding: '12px 20px',
        background: 'var(--surface)',
        borderTop: '1px solid var(--line)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      {children}
    </div>
  );
}

/** The eel drawn as one tapering silhouette (200×70 box); used on the welcome and sign-in screens. */
export function Eel({ x = 0, y = 0, scale = 1 }: { x?: number; y?: number; scale?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      <path d="M7.6 42.3 L9.5 43.4 L11.5 44.3 L13.6 45.2 L15.6 46.0 L17.7 46.7 L19.7 47.3 L21.8 47.7 L24.0 48.1 L26.1 48.4 L28.2 48.6 L30.4 48.7 L32.5 48.7 L34.7 48.5 L36.9 48.3 L39.0 48.0 L41.2 47.7 L43.4 47.2 L45.5 46.7 L47.7 46.1 L49.8 45.5 L52.0 44.8 L54.1 44.1 L56.2 43.4 L58.3 42.6 L60.4 41.8 L62.5 41.1 L64.5 40.3 L66.6 39.5 L68.6 38.7 L70.6 38.0 L72.6 37.3 L74.6 36.6 L76.6 36.0 L78.6 35.4 L80.5 34.9 L82.4 34.4 L84.3 34.0 L86.2 33.6 L88.1 33.3 L90.0 33.1 L91.8 32.9 L93.6 32.8 L95.5 32.7 L97.3 32.7 L99.1 32.7 L100.9 32.9 L102.7 33.0 L104.5 33.2 L106.3 33.5 L108.2 33.8 L110.0 34.2 L111.8 34.6 L113.7 35.1 L115.6 35.6 L117.5 36.1 L119.4 36.6 L121.3 37.2 L123.2 37.8 L125.2 38.5 L127.2 39.1 L129.1 39.8 L131.1 40.4 L133.2 41.1 L135.2 41.6 L137.3 42.2 L139.4 42.7 L141.5 43.2 L143.7 43.7 L145.8 44.2 L148.0 44.6 L150.1 45.0 L152.3 45.3 L154.5 45.7 L156.7 45.9 L158.9 46.2 L161.0 46.4 L163.2 46.5 L165.4 46.6 L167.6 46.7 L169.8 46.7 L172.0 46.7 L174.1 46.6 L176.3 46.4 L178.4 46.0 L180.5 45.6 L182.6 45.1 L184.7 44.5 L186.7 43.8 L188.7 43.0 L190.7 42.2 C199.7 42.2 198.3 31.2 189.3 31.2 L189.3 31.2 L187.3 30.8 L185.2 30.5 L183.2 30.2 L181.2 30.0 L179.3 29.9 L177.3 29.7 L175.4 29.7 L173.5 29.6 L171.6 29.7 L169.8 29.7 L167.9 29.7 L166.0 29.6 L164.2 29.5 L162.3 29.4 L160.5 29.2 L158.6 29.0 L156.8 28.8 L154.9 28.5 L153.0 28.2 L151.1 27.9 L149.3 27.5 L147.4 27.1 L145.4 26.7 L143.5 26.2 L141.6 25.7 L139.6 25.2 L137.6 24.7 L135.6 24.2 L133.6 23.7 L131.5 23.3 L129.4 22.8 L127.4 22.3 L125.2 21.9 L123.1 21.4 L121.0 21.0 L118.8 20.6 L116.7 20.3 L114.5 20.0 L112.3 19.7 L110.1 19.5 L107.8 19.3 L105.6 19.2 L103.4 19.2 L101.2 19.2 L98.9 19.3 L96.7 19.4 L94.5 19.7 L92.2 20.0 L90.0 20.4 L87.8 20.8 L85.6 21.3 L83.5 21.9 L81.3 22.6 L79.2 23.3 L77.0 24.1 L74.9 24.9 L72.9 25.7 L70.8 26.6 L68.7 27.5 L66.7 28.5 L64.7 29.5 L62.7 30.5 L60.7 31.4 L58.7 32.4 L56.7 33.4 L54.8 34.4 L52.8 35.3 L50.9 36.2 L49.0 37.1 L47.1 38.0 L45.2 38.8 L43.3 39.5 L41.4 40.2 L39.5 40.8 L37.6 41.4 L35.7 41.9 L33.9 42.3 L32.0 42.7 L30.1 42.9 L28.2 43.1 L26.3 43.2 L24.4 43.2 L22.5 43.2 L20.5 43.0 L18.6 42.8 L16.6 42.4 L14.6 42.0 L12.5 41.5 L10.5 41.0 L8.4 40.4 Z" fill="#FBD38D" />
      <path d="M163.7 43.0 q-7 9 -12 7 q4 -6 3 -9 z" fill="#E8B866" />
      <circle cx="188.5" cy="33.5" r="1.7" fill="#13264A" />
      <path d="M193.0 38.9 l-4 .6" stroke="#13264A" stroke-width="1.1" stroke-linecap="round" />
    </g>
  );
}
