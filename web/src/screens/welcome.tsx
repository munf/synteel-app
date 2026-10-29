import { useEffect, useState } from 'preact/hooks';
import { api, type Me } from '../api.ts';
import { Eel, Glyph, GLYPH, Icon, type IconName } from '../ui.tsx';

export type SignInMode = 'login' | 'register' | 'join';

const WELCOMED = 'synteel.welcomed';

/** Sambutan is shown only on the first open of the app on this phone; after that the app opens on Masuk. */
export function needsWelcome(): boolean {
  try {
    return localStorage.getItem(WELCOMED) !== '1';
  } catch {
    return false;
  }
}

function markWelcomed() {
  try {
    localStorage.setItem(WELCOMED, '1');
  } catch {
    // private mode: show it again next time, no harm
  }
}

/** The eel over the pond at day and night, the picture at the top of Sambutan. */
function PondArt() {
  return (
    <svg viewBox="0 0 310 120" aria-hidden="true" style={{ display: 'block', width: '100%', height: 'auto' }}>
      <ellipse cx="155" cy="68" rx="150" ry="48" fill="#1C3461" />
      <path d="M24 56c20-8 36-8 56 0s36 8 56 0 36-8 56 0 36 8 56 0" fill="none" stroke="#2C4A80" stroke-width="3" stroke-linecap="round" />
      <path d="M40 98c20-8 36-8 56 0s36 8 56 0 36-8 56 0 36 8 56 0" fill="none" stroke="#2C4A80" stroke-width="3" stroke-linecap="round" />
      <Eel x={45} y={38} scale={1.2} />
      <circle cx="246" cy="22" r="8" fill="#FBD38D" />
      <path d="M246 6v4M246 34v4M230 22h4M258 22h4M235 11l3 3M254 30l3 3M235 33l3-3M254 14l3-3" stroke="#FBD38D" stroke-width="2.2" stroke-linecap="round" />
      <path d="M284 12a11 11 0 1 0 12 14 9 9 0 0 1-12-14z" fill="#C9D4EA" />
    </svg>
  );
}

const POINTS: { icon: IconName; title: string; text: string }[] = [
  { icon: 'mic', title: 'Catat dengan suara', text: 'Sebut banyak kolam sekaligus, periksa hasilnya sebelum disimpan.' },
  { icon: 'moon', title: 'Waspada malam', text: 'Jadwal cek dan alarm di malam yang rawan oksigen.' },
  { icon: 'alert', title: 'Saat sidat sekarat', text: 'Langkah yang bisa langsung dikerjakan, plus ringkasan untuk pemilik.' },
];

export function Welcome({ onPick, onSignedIn }: { onPick: (mode: SignInMode) => void; onSignedIn: (me: Me) => void }) {
  const [demo, setDemo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.authOptions().then((o) => setDemo(o.demo), () => {});
  }, []);

  const pick = (mode: SignInMode) => {
    markWelcomed();
    onPick(mode);
  };
  const tryDemo = async () => {
    setBusy(true);
    setError('');
    try {
      const me = await api.demo();
      markWelcomed();
      onSignedIn(me);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div class="screen" style={{ minHeight: '100dvh', paddingBottom: 'calc(32px + env(safe-area-inset-bottom, 0px))' }}>
      <div class="row" style={{ gap: 8 }}>
        <span class="icon-box" style={{ width: 36, height: 36, borderRadius: 12, background: '#13264a', color: '#fbd38d' }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
            <path d="M3 13c3-4 5-4 8 0s5 4 10-2" />
          </svg>
        </span>
        <span class="title">synteel</span>
      </div>

      <section class="hero" style={{ background: '#13264a', gap: 16 }}>
        <PondArt />
        <h1 style={{ color: '#fff' }}>Jaga kolam sidat, siang dan malam</h1>
      </section>

      <ul class="stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {POINTS.map((p) => (
          <li key={p.title} class="row top">
            <span class="icon-box" style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--surface)', color: 'var(--ink)' }}>
              <Icon name={p.icon} />
            </span>
            <span class="stack-xs" style={{ gap: 0 }}>
              <b class="strong">{p.title}</b>
              <span class="label ink2">{p.text}</span>
            </span>
          </li>
        ))}
      </ul>

      <div class="stack-sm" style={{ marginTop: 'auto', gap: 12 }}>
        <button type="button" class="btn primary" onClick={() => pick('login')}>
          Masuk
        </button>
        <button type="button" class="btn" style={{ background: 'var(--surface)', color: 'var(--ink)', border: '2px solid var(--ink)' }} onClick={() => pick('register')}>
          Daftar akun baru
        </button>
        <div class="row" style={{ justifyContent: 'center', gap: 24, flexWrap: 'wrap' }}>
          <button type="button" class="link-btn label row" style={{ minHeight: 48, gap: 6, fontWeight: 800 }} onClick={() => pick('join')}>
            <Icon name="users" size={18} /> Punya kode undangan
          </button>
          {demo && (
            <button type="button" class="link-btn label row" style={{ minHeight: 48, gap: 6, fontWeight: 800 }} disabled={busy} onClick={tryDemo}>
              <Glyph d={GLYPH.play} size={18} /> {busy ? 'Tunggu…' : 'Coba demo'}
            </button>
          )}
        </div>
        {error && (
          <p class="error center" role="alert">
            {error}
          </p>
        )}
        {demo && <p class="label ink2 center">Demo: tambak contoh, direset tiap malam.</p>}
      </div>
    </div>
  );
}
