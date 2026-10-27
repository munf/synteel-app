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

export function Field({ label, hint, children }: { label: string; hint?: string; children: ComponentChildren }) {
  return (
    <label class="field">
      <span class="field-label">{label}</span>
      {children}
      {hint && <span class="field-hint">{hint}</span>}
    </label>
  );
}

export function Empty({ children }: { children: ComponentChildren }) {
  return <p class="empty">{children}</p>;
}
