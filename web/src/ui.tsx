import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Finding, Level, PondSummary } from './api.ts';
import { levelLabel, phaseLabel } from './labels.ts';

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
  ok: { d: 'M6 1a5 5 0 1 0 0 10A5 5 0 0 0 6 1z', fill: '#1F9D6B' },
  warn: { d: 'M1 1h10v10H1z', fill: '#E0A100' },
  bad: { d: 'M5.13 1.5a1 1 0 0 1 1.74 0l4.5 8a1 1 0 0 1-.87 1.5H1.5a1 1 0 0 1-.87-1.5z', fill: '#D92D20' },
  blue: { d: 'M6 1a5 5 0 1 0 0 10A5 5 0 0 0 6 1z', fill: '#2F6FE4' },
};

export function Shape({ tone, size = 12 }: { tone: Tone; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden="true">
      <path d={SHAPE[tone].d} fill={SHAPE[tone].fill} />
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
export const Soon = ({ children = 'Segera' }: { children?: ComponentChildren }) => <span class="soon">{children}</span>;

// ---------- pond thumbnail: the farmer's photo later; the pond type's shape for now ----------

const TANK: Record<string, string> = {
  bulat: 'M28 8a20 20 0 1 0 0 40 20 20 0 0 0 0-40z',
  terpal: 'M12 12h32a4 4 0 0 1 4 4v24a4 4 0 0 1-4 4H12a4 4 0 0 1-4-4V16a4 4 0 0 1 4-4z',
  fiber: 'M14 16h28l-3 24H17z',
};
export const tankPath = (kind: string | null) => TANK[kind === 'beton' ? 'terpal' : (kind ?? 'terpal')] ?? TANK.terpal;
export const kindLabel: Record<string, string> = { bulat: 'Tangki bulat', terpal: 'Terpal', beton: 'Beton', fiber: 'Bak fiber' };

export function PondThumb({ kind, size = 56 }: { kind: string | null; size?: number }) {
  return (
    <span class={`thumb${size <= 40 ? ' sm' : ''}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 56 56" aria-hidden="true">
        <path d={tankPath(kind)} fill="#8DB6D9" stroke="#FFFFFF" stroke-width="3" />
      </svg>
    </span>
  );
}

export function pondMeta(p: PondSummary): string {
  if (!p.batch || !p.program) return p.kind ? kindLabel[p.kind] ?? p.kind : 'Belum ada batch';
  const parts = [phaseLabel[p.batch.phase], `minggu ${p.program.week}`];
  if (p.program.estimatedAlive !== null) parts.push(`sekitar ${p.program.estimatedAlive.toLocaleString('id-ID')} ekor`);
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
          <span class="h2">{cur ? cur.name : (placeholder ?? 'Pilih kolam')}</span>
          <span class="meta">{cur ? pondMeta(cur) : 'Belum dipilih'}</span>
        </span>
        <Icon name="down" />
      </button>
      {open && (
        <div class="picker-menu">
          {ponds.length > 5 && (
            <label class="picker-search">
              <Icon name="search" size={20} />
              <input aria-label="Cari kolam" placeholder="Cari nama kolam" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
            </label>
          )}
          <div role="listbox" aria-label="Daftar kolam" class="stack-xs">
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
                  <span class="strong">{p.name}</span>
                  <span class="meta">{pondMeta(p)}</span>
                </span>
                <span class={`word ${toneOf(p.level)}`}>
                  <Shape tone={toneOf(p.level)} />
                </span>
                {p.id === value && <Tick />}
              </button>
            ))}
            {shown.length === 0 && <p class="meta" style={{ padding: '16px 8px' }}>Tidak ada kolam dengan nama itu.</p>}
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

/** "6281234567890" → "0812 3456 7890", the way people write their number. */
export function fmtPhone(phone: string) {
  const local = phone.startsWith('62') ? '0' + phone.slice(2) : phone;
  return local.replace(/(\d{4})(?=\d)/g, '$1 ');
}

export const initialOf = (name: string | undefined) => (name ?? 'S').replace(/^tambak\s+/i, '').trim().charAt(0).toUpperCase() || 'S';

export const roleLabel: Record<'owner' | 'worker', string> = { owner: 'Pemilik', worker: 'Pekerja' };

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

export function Stepper({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div class="stepper">
      <button type="button" aria-label="Kurangi" onClick={() => onChange(Math.max(0, value - 1))}>
        −
      </button>
      <output>{value}</output>
      <button type="button" aria-label="Tambah" onClick={() => onChange(value + 1)}>
        +
      </button>
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
      <p class="meta">Sumber: {finding.source}</p>
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
