import type { Go } from '../app.tsx';
import { isEn, t } from '../i18n.ts';
import { Icon } from '../ui.tsx';
import policy from '../privacy.json';

// The privacy policy inside the app (from Profil). The text comes from the site's generator
// (cap/site/privasi/build.py writes privacy.json), so the app and eel.synt.fun/privasi/ always match.
// It is our own fixed text, bundled with the app: readable offline, never fetched.
type Text = { id: string; en: string };
type Block = ({ kind: 'h2' | 'h3' | 'p' } & Text) | { kind: 'list'; items: Text[] };

/** The chosen language's version, with links opening outside the app. */
const html = (x: Text) => ({ __html: (isEn ? x.en : x.id).replace(/<a href=/g, '<a target="_blank" rel="noopener" href=') });

export function Privacy({ go }: { go: Go }) {
  return (
    <div class="screen privacy">
      <header class="row">
        <button class="icon-btn" aria-label={t('Kembali ke Profil', 'Back to Profile')} onClick={() => go({ name: 'profile' })}>
          <Icon name="back" />
        </button>
        <div class="stack-xs">
          <h1 style={{ lineHeight: 1.1 }}>{t('Kebijakan privasi', 'Privacy policy')}</h1>
          <span class="meta">PT Synt Tekno Multikarya · {isEn ? policy.effective.en : policy.effective.id}</span>
        </div>
      </header>
      <article class="card stack">
        {(policy.blocks as Block[]).map((b, i) =>
          b.kind === 'list' ? (
            <ul key={i} class="stack-sm" style={{ margin: 0, paddingLeft: 20 }}>
              {b.items.map((x, j) => (
                <li key={j} dangerouslySetInnerHTML={html(x)} />
              ))}
            </ul>
          ) : b.kind === 'h2' ? (
            <h2 key={i} style={{ marginTop: i ? 8 : 0 }} dangerouslySetInnerHTML={html(b)} />
          ) : b.kind === 'h3' ? (
            <h3 key={i} class="strong" style={{ margin: 0, fontSize: '1rem' }} dangerouslySetInnerHTML={html(b)} />
          ) : (
            <p key={i} style={{ margin: 0 }} dangerouslySetInnerHTML={html(b)} />
          ),
        )}
      </article>
    </div>
  );
}
