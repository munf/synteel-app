import type { ComponentChildren } from 'preact';
import type { Finding, Level } from './api.ts';
import { levelLabel } from './labels.ts';

export function LevelBadge({ level }: { level: Level }) {
  return <span class={`badge lv-${level}`}>{levelLabel[level]}</span>;
}

export function FindingCard({ finding, pondName }: { finding: Finding; pondName?: string }) {
  return (
    <article class={`finding lv-${finding.level}`}>
      <header>
        {pondName && <span class="eyebrow">{pondName}</span>}
        <h3>{finding.title}</h3>
      </header>
      <p>{finding.detail}</p>
      {finding.actions.length > 0 && (
        <ol class="actions">
          {finding.actions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ol>
      )}
      <p class="source">Sumber: {finding.source}</p>
    </article>
  );
}

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
      {(Object.keys(props.options) as T[]).map((key) => (
        <button type="button" key={key} class={props.value.includes(key) ? 'on' : ''} aria-pressed={props.value.includes(key)} onClick={() => toggle(key)}>
          {props.options[key]}
        </button>
      ))}
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

const icon = (d: string) => () => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
export const IconCamera = icon('M3 8a2 2 0 0 1 2-2h2l2-2h6l2 2h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z');
export const IconMic = icon('M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3');
export const IconVideo = icon('M3 7a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM16 10l5-3v10l-5-3');

export function Empty({ children }: { children: ComponentChildren }) {
  return <p class="empty">{children}</p>;
}
