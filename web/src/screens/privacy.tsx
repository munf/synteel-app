import { useState } from 'preact/hooks';
import type { Go } from '../app.tsx';
import { api, type Me } from '../api.ts';
import { isEn, siteInAppLanguage, t } from '../i18n.ts';
import { Icon, Tick } from '../ui.tsx';
import policy from '../privacy.json';
import terms from '../terms.json';

// The privacy policy and the Syarat dan Ketentuan inside the app (from Profil). The texts come from the site's
// generators (cap/site/privasi/build.py writes privacy.json, cap/site/syarat/build.py writes terms.json), so the
// app and eel.synt.fun/privasi/ and /syarat/ always match. Our own fixed text, bundled: readable offline, never fetched.
type Text = { id: string; en: string };
type Block = ({ kind: 'h2' | 'h3' | 'p' } & Text) | { kind: 'list'; items: Text[]; alpha?: boolean };
type Doc = { effective: Text; blocks: Block[] };

/** The chosen language's version, with links opening outside the app (site-relative ones on eel.synt.fun). */
const html = (x: Text) => ({
  __html: (isEn ? x.en : x.id).replace(/<a href="\//g, '<a href="https://eel.synt.fun/').replace(/<a href=/g, '<a target="_blank" rel="noopener" href='),
});

function LegalDoc({ go, title, doc }: { go: Go; title: string; doc: Doc }) {
  return (
    <div class="screen privacy">
      <header class="row">
        <button class="icon-btn" aria-label={t('Kembali ke Profil', 'Back to Profile')} onClick={() => go({ name: 'profile' })}>
          <Icon name="back" />
        </button>
        <div class="stack-xs">
          <h1 style={{ lineHeight: 1.1 }}>{title}</h1>
          <span class="meta">PT Synt Tekno Multikarya · {isEn ? doc.effective.en : doc.effective.id}</span>
        </div>
      </header>
      <article class="card stack">
        {doc.blocks.map((b, i) =>
          b.kind === 'list' ? (
            <ul key={i} class="stack-sm" style={{ margin: 0, paddingLeft: 20, listStyle: b.alpha ? 'none' : undefined }}>
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

export const Privacy = ({ go }: { go: Go }) => <LegalDoc go={go} title={t('Kebijakan privasi', 'Privacy policy')} doc={policy as Doc} />;

export const Terms = ({ go }: { go: Go }) => <LegalDoc go={go} title={t('Syarat dan ketentuan', 'Terms and conditions')} doc={terms as Doc} />;

const LINK = { textDecoration: 'underline', textUnderlineOffset: 3 };

/**
 * The consent tick for Daftar, Gabung and the one-time consent screen. `minor`: workers may be under 18 with a
 * parent's or guardian's permission (Syarat Pasal 6); farm owners may not. Unticked until the person ticks it.
 */
export function TermsConsent({ on, onChange, minor }: { on: boolean; onChange: (on: boolean) => void; minor?: boolean }) {
  const link = (path: string, label: string) => (
    <a class="inline-link" href={`https://eel.synt.fun/${path}/`} target="_blank" rel="noopener" onClick={siteInAppLanguage} style={LINK}>
      {label}
    </a>
  );
  return (
    <div class="row top" style={{ gap: 12, alignItems: 'flex-start' }}>
      <button type="button" role="checkbox" aria-checked={on} aria-labelledby="terms-consent" class="check-row" style={{ flex: 'none' }} onClick={() => onChange(!on)}>
        <span class={`check-box${on ? ' on' : ''}`}>{on && <Tick />}</span>
      </button>
      <span id="terms-consent" class="label ink2" style={{ paddingTop: 10 }} onClick={(e) => (e.target as HTMLElement).tagName !== 'A' && onChange(!on)}>
        {minor
          ? t('Berumur 18 tahun ke atas, atau di bawah 18 tahun dengan izin orang tua atau wali, dan setuju dengan ', 'Aged 18 or older, or under 18 with a parent’s or guardian’s permission, and agree to the ')
          : t('Berumur 18 tahun ke atas dan setuju dengan ', 'Aged 18 or older and agree to the ')}
        {link('syarat', t('Syarat dan Ketentuan', 'Terms and Conditions'))}
        {t(' serta ', ' and the ')}
        {link('privasi', t('Kebijakan Privasi', 'Privacy Policy'))}.
      </span>
    </div>
  );
}

/** Once, for accounts made before the Syarat dan Ketentuan (or before a newer version): tick to go on, or sign out. */
export function TermsGate({ me, onAgreed, onLogout }: { me: Me; onAgreed: (m: Me) => void; onLogout: () => void }) {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const owner = me.farms.some((f) => f.role === 'owner');
  const agree = async () => {
    setBusy(true);
    setError('');
    try {
      onAgreed(await api.acceptTerms());
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <div class="screen stack">
      <div class="stack-xs">
        <h1>{t('Syarat dan ketentuan', 'Terms and conditions')}</h1>
        <p class="ink2">
          {t(
            'Synteel sekarang punya Syarat dan Ketentuan. Isinya: Synteel membantu menilai risiko, keputusan tetap di tangan petani, dan AI bisa salah sehingga hasil bacaan AI perlu dicek.',
            'Synteel now has Terms and Conditions. In short: Synteel helps judge the risk, the decisions stay with the farmer, and the AI can make mistakes, so its readings need checking.',
          )}
        </p>
      </div>
      <section class="card stack">
        <TermsConsent on={on} onChange={setOn} minor={!owner} />
        {error && (
          <p class="error" role="alert">
            {error}
          </p>
        )}
        <button class="btn primary" disabled={!on || busy} onClick={agree}>
          {busy ? t('Tunggu…', 'Wait…') : t('Setuju dan lanjut', 'Agree and continue')}
        </button>
      </section>
      <button type="button" class="btn secondary" onClick={onLogout}>
        <Icon name="logout" size={20} /> {t('Keluar', 'Sign out')}
      </button>
    </div>
  );
}
