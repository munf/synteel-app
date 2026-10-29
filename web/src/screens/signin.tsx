import { useEffect, useState } from 'preact/hooks';
import { api, API, ApiError, type Me, type Role } from '../api.ts';
import { fmtClock } from '../labels.ts';
import { Eel, Field, fmtPhone, Glyph, GLYPH, Icon, Notice, PinBoxes, roleLabel } from '../ui.tsx';
import type { SignInMode } from './welcome.tsx';

type Mode = SignInMode;

const SUBS: Record<'login' | 'register', string> = {
  login: 'Nomor HP dan PIN 6 angka.',
  register: 'Buat akun pemilik tambak, lalu siapkan tambak.',
};
const BUTTONS: Record<Mode, string> = { login: 'Masuk', register: 'Daftar dan siapkan tambak', join: 'Gabung ke tambak' };

/** How long the server locks the PIN when it gives no time (matches its limiter). */
const LOCK_FALLBACK_MS = 15 * 60_000;

/** Login, keeping the lockout time the server sends with a 429 (api.ts drops extra fields). */
async function login(phone: string, pin: string): Promise<Me> {
  const res = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, pin }) });
  const json = await res.json().catch(() => ({}));
  if (res.ok) return json as Me;
  if (res.status === 429 || json.code === 'locked') throw new Locked(json.retryAt ? Date.parse(json.retryAt) : Date.now() + LOCK_FALLBACK_MS);
  throw new ApiError(json.error ?? `Gagal (${res.status})`, res.status, json.code);
}

class Locked extends Error {
  until: number;
  constructor(until: number) {
    super('Terlalu banyak percobaan');
    this.until = until;
  }
}

const isPhoneTaken = (e: unknown) => e instanceof ApiError && (e.code === 'phone_taken' || e.status === 409);
const isInviteInvalid = (e: unknown) => e instanceof ApiError && (e.code === 'invite_invalid' || [400, 404, 410].includes(e.status));
const isWrongPin = (e: unknown) => e instanceof ApiError && (e.status === 401 || e.status === 403);

/** Compact navy header: logo, wordmark, the eel strip and the promise. */
function Header() {
  return (
    <header
      style={{
        background: '#13264a',
        color: '#fff',
        padding: 'calc(20px + env(safe-area-inset-top, 0px)) 20px 44px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div class="row" style={{ gap: 8 }}>
        <span class="icon-box" style={{ width: 36, height: 36, borderRadius: 12, background: '#fbd38d', color: '#13264a' }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
            <path d="M3 13c3-4 5-4 8 0s5 4 10-2" />
          </svg>
        </span>
        <span class="title">synteel</span>
        <svg width="150" height="36" viewBox="0 0 150 36" aria-hidden="true" style={{ marginLeft: 'auto', flex: 'none' }}>
          <path d="M0 30c12-5 22-5 34 0s22 5 34 0 22-5 34 0 22 5 34 0" fill="none" stroke="#2C4471" stroke-width="2.5" stroke-linecap="round" />
          <Eel x={2} y={-3} scale={0.62} />
          <circle cx="134" cy="9" r="2.5" fill="none" stroke="#5E7BB0" stroke-width="1.8" />
          <circle cx="141" cy="3" r="1.6" fill="none" stroke="#5E7BB0" stroke-width="1.6" />
        </svg>
      </div>
      <p style={{ fontSize: '1.125rem', fontWeight: 800, lineHeight: 1.3 }}>Jaga kolam sidat, siang dan malam</p>
    </header>
  );
}

/** "contoh: 0812 3456 7890" with a phone drawn inside the field. */
function PhoneInput({ value, onChange, border }: { value: string; onChange: (v: string) => void; border?: string }) {
  return (
    <span style={{ position: 'relative', display: 'block' }}>
      <span style={{ position: 'absolute', left: 16, top: 18, color: 'var(--ink-2)', display: 'flex' }}>
        <Glyph d={GLYPH.mobile} size={20} />
      </span>
      <input
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        value={value}
        onInput={(e) => onChange(e.currentTarget.value)}
        placeholder="contoh: 0812 3456 7890"
        required
        style={{ paddingLeft: 48, fontVariantNumeric: 'tabular-nums', ...(border ? { borderColor: border } : {}) }}
      />
    </span>
  );
}

export function SignIn({
  onSignedIn,
  onHelp,
  sessionEnded,
  lastPhone,
  initialMode = 'login',
}: {
  /** `newPin` only right after Daftar, so Siapkan tambak can show it once (never stored). */
  onSignedIn: (me: Me, newPin?: string) => void;
  /** Opens Bantuan (an owner who forgot the PIN has nobody else to ask). */
  onHelp: () => void;
  /** The app came back here because the session was lost, not because of a manual sign-out. */
  sessionEnded?: boolean;
  /** The phone number of the session that ended, so only the PIN is needed. */
  lastPhone?: string;
  /** The mode picked on Sambutan. */
  initialMode?: Mode;
}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [demo, setDemo] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState(lastPhone ? fmtPhone(lastPhone) : '');
  const [pin, setPin] = useState('');
  const [code, setCode] = useState('');
  const [invite, setInvite] = useState<{ farmName: string; role: Role } | null>(null);
  const [inviteBad, setInviteBad] = useState(false);
  const [checking, setChecking] = useState(false);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [taken, setTaken] = useState(false);
  const [wrong, setWrong] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** Remounts the PIN boxes so "Lihat PIN" starts right for the mode. */
  const [pinKey, setPinKey] = useState(0);

  useEffect(() => {
    api.authOptions().then((o) => setDemo(o.demo), () => {});
  }, []);

  // Unlock the form by itself when the lockout ends.
  useEffect(() => {
    if (lockedUntil === null) return;
    const timer = setTimeout(() => setLockedUntil(null), Math.max(0, lockedUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [lockedUntil]);

  // Look the code up as soon as it is complete, so the person sees which farm they join.
  useEffect(() => {
    setInvite(null);
    setInviteBad(false);
    if (mode !== 'join') return;
    setError('');
    if (code.length !== 6) return;
    let live = true;
    setChecking(true);
    api.invite(code).then(
      (i) => live && setInvite(i),
      (e) => live && (isInviteInvalid(e) ? setInviteBad(true) : setError(e.message)),
    ).finally(() => live && setChecking(false));
    return () => {
      live = false;
    };
  }, [code, mode]);

  const choose = (m: Mode) => {
    setMode(m);
    setError('');
    setTaken(false);
    setWrong(false);
    setPin('');
    setPinKey((k) => k + 1);
  };

  const run = async (fn: () => Promise<Me>, newPin?: string) => {
    setBusy(true);
    setError('');
    setWrong(false);
    try {
      onSignedIn(await fn(), newPin);
    } catch (err) {
      if (err instanceof Locked) setLockedUntil(err.until);
      else if (mode === 'register' && isPhoneTaken(err)) setTaken(true);
      else if (mode === 'join' && isInviteInvalid(err)) setInviteBad(true);
      else if (mode === 'login' && isWrongPin(err)) {
        setWrong(true);
        setPin('');
      } else setError((err as Error).message);
      setBusy(false);
    }
  };

  const submit = (e: Event) => {
    e.preventDefault();
    if (locked || busy) return;
    if (taken) return choose('login');
    if (pin.length !== 6) return setError('PIN harus 6 angka');
    if (mode === 'login') return run(() => login(phone, pin));
    if (mode === 'register') return run(() => api.register(name, phone, pin), pin);
    if (!invite) return setError('Masukkan kode undangan yang berlaku');
    return run(() => api.join(code, name, phone, pin));
  };

  const locked = mode === 'login' && lockedUntil !== null;
  const join = mode === 'join';
  const showForm = !join || invite !== null;
  const askOwner = `Halo, kode undangan Synteel ${code} sudah tidak berlaku. Boleh minta kode baru?`;
  const pinHint =
    mode === 'register'
      ? 'PIN terlihat supaya tidak salah ketik. Mudah diingat, tapi jangan 123456 atau 111111.'
      : join
        ? 'PIN terlihat supaya tidak salah ketik.'
        : sessionEnded
          ? 'PIN baru dari pemilik tambak, kalau baru diatur ulang.'
          : undefined;
  const phoneBorder = taken ? 'var(--ink)' : wrong ? 'var(--bad-dot)' : undefined;

  return (
    <div style={{ minHeight: '100dvh', background: 'var(--surface)', display: 'flex', flexDirection: 'column' }}>
      <Header />
      <form
        onSubmit={submit}
        style={{
          marginTop: -24,
          flex: 1,
          background: 'var(--surface)',
          borderRadius: '24px 24px 0 0',
          padding: '24px 20px calc(32px + env(safe-area-inset-bottom, 0px))',
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
          width: '100%',
          maxWidth: 560,
          alignSelf: 'center',
        }}
      >
        {join ? (
          <div class="stack-xs">
            <button type="button" class="link-btn row" style={{ alignSelf: 'flex-start', gap: 8, fontWeight: 600 }} onClick={() => choose('login')}>
              <Icon name="back" size={20} /> Kembali ke Masuk
            </button>
            <h1>Gabung dengan kode</h1>
            <p class="ink2">Kode undangan didapat dari pemilik tambak.</p>
          </div>
        ) : (
          <div class="stack-sm">
            <div role="tablist" aria-label="Masuk atau daftar" style={{ background: 'var(--bg)', borderRadius: 16, padding: 4, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 4 }}>
              {(['login', 'register'] as const).map((m) => {
                const on = mode === m;
                return (
                  <button
                    type="button"
                    key={m}
                    role="tab"
                    aria-selected={on}
                    onClick={() => choose(m)}
                    style={{
                      minHeight: 48,
                      border: 0,
                      borderRadius: 12,
                      fontWeight: on ? 800 : 600,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 8,
                      background: on ? 'var(--surface)' : 'transparent',
                      color: on ? 'var(--ink)' : 'var(--ink-2)',
                      boxShadow: on ? '0 1px 3px rgba(19, 38, 74, 0.18)' : 'none',
                    }}
                  >
                    {on && <Icon name="check" size={16} stroke={3} />}
                    {m === 'login' ? 'Masuk' : 'Daftar'}
                  </button>
                );
              })}
            </div>
            <h1 style={{ fontSize: '1rem', fontWeight: 400, color: 'var(--ink-2)' }}>{SUBS[mode]}</h1>
          </div>
        )}

        {sessionEnded && mode === 'login' && (
          <Notice tone="info" icon="login" title="Akun ini sudah keluar" role="status">
            Karena PIN diatur ulang oleh pemilik tambak, atau akun ini masuk di HP lain. Masuk lagi untuk lanjut.
          </Notice>
        )}

        {join && (
          <Field label="Kode undangan" hint="6 huruf dan angka, dari pesan pemilik tambak">
            <input
              class="code-input"
              value={code}
              maxLength={6}
              autoCapitalize="characters"
              autoComplete="off"
              spellcheck={false}
              style={inviteBad ? { borderColor: 'var(--ink)' } : undefined}
              onInput={(e) => {
                const v = e.currentTarget.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
                e.currentTarget.value = v;
                setCode(v);
              }}
              placeholder="contoh: K7QM2P"
              required
            />
          </Field>
        )}
        {join && checking && (
          <p role="status" class="row ink2" style={{ gap: 8 }}>
            <Glyph d={GLYPH.spinner} size={20} stroke={2.5} /> Memeriksa kode…
          </p>
        )}
        {join && inviteBad && (
          <Notice tone="info" icon="info" title="Kode ini sudah tidak berlaku" role="alert">
            Kode undangan berlaku 7 hari dan hanya bisa dipakai sekali. Kode ini sudah lewat 7 hari atau sudah dipakai.
          </Notice>
        )}
        {join && invite && (
          <div class="note ok" style={{ fontSize: '1rem', alignItems: 'center' }}>
            <Icon name="check" stroke={3} />
            <span style={{ display: 'flex', flexDirection: 'column' }}>
              <b>{invite.farmName}</b>
              <span class="label">Bergabung sebagai {roleLabel[invite.role].toLowerCase()}</span>
            </span>
          </div>
        )}

        {showForm && mode !== 'login' && !taken && (
          <Field label="Nama" hint={join ? 'Sudah punya akun? Isi nomor HP dan PIN yang biasa dipakai.' : undefined}>
            <input autoComplete="name" value={name} onInput={(e) => setName(e.currentTarget.value)} placeholder="contoh: Pak Joko" required={mode === 'register'} />
          </Field>
        )}
        {showForm && (
          <Field label="Nomor HP">
            <PhoneInput
              value={phone}
              border={phoneBorder}
              onChange={(v) => {
                setPhone(v);
                setTaken(false);
                setWrong(false);
              }}
            />
          </Field>
        )}
        {taken && (
          <Notice tone="info" icon="userCheck" title="Nomor ini sudah punya akun" role="status">
            Tidak perlu daftar lagi. Masuk dengan PIN yang biasa dipakai.
          </Notice>
        )}
        {showForm && !taken && (
          <div class="stack-sm">
            <PinBoxes
              key={`${mode}:${pinKey}`}
              value={pin}
              onChange={(v) => {
                setPin(v);
                setWrong(false);
                if (error === 'PIN harus 6 angka') setError('');
              }}
              defaultShow={mode !== 'login'}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              locked={locked}
              error={wrong}
              hint={locked ? undefined : pinHint}
            />
            {wrong && (
              <p role="alert" class="row label" style={{ gap: 8, fontWeight: 600, color: 'var(--bad)' }}>
                <Glyph d={GLYPH.errorCircle} size={18} /> Nomor HP atau PIN salah. Cek nomornya, lalu ketik PIN lagi.
              </p>
            )}
          </div>
        )}
        {locked && (
          <Notice tone="info" icon="lock" title="Terlalu banyak percobaan" role="alert">
            Coba lagi {Math.max(1, Math.ceil((lockedUntil! - Date.now()) / 60_000))} menit lagi (jam {fmtClock(lockedUntil!)}). PIN dikunci sebentar supaya akun aman.
          </Notice>
        )}

        {error && (
          <p class="error" role="alert">
            {error}
          </p>
        )}

        {taken ? (
          <div class="stack-sm">
            <button class="btn primary">
              Masuk dengan nomor ini <Icon name="arrow" size={20} stroke={2.2} />
            </button>
            <button
              type="button"
              class="link-btn"
              style={{ fontWeight: 800 }}
              onClick={() => {
                setPhone('');
                setTaken(false);
              }}
            >
              Pakai nomor lain
            </button>
          </div>
        ) : locked ? (
          <button class="btn primary" disabled>
            Masuk lagi jam {fmtClock(lockedUntil!)}
          </button>
        ) : (
          showForm && (
            <button class="btn primary" disabled={busy}>
              {busy ? (
                'Tunggu…'
              ) : (
                <>
                  {BUTTONS[mode]} <Icon name="arrow" size={20} stroke={2.2} />
                </>
              )}
            </button>
          )
        )}

        {join && inviteBad && (
          <div class="stack-sm">
            <a class="btn primary" href={`https://wa.me/?text=${encodeURIComponent(askOwner)}`} target="_blank" rel="noopener">
              <Icon name="chat" size={20} /> Minta kode baru ke pemilik tambak
            </a>
            <p class="label ink2 center">Membuka WhatsApp dengan pesan yang siap dikirim.</p>
          </div>
        )}

        {mode === 'login' && (
          <div class="label ink2 center" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <span>Pekerja lupa PIN: minta pemilik tambak mengatur ulang.</span>
            <button
              type="button"
              class="inline-link"
              style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center', textDecoration: 'underline', textUnderlineOffset: 3 }}
              onClick={onHelp}
            >
              Pemilik lupa PIN? Hubungi bantuan
            </button>
          </div>
        )}

        {!join && !taken && (
          <div class="stack-sm" style={{ gap: 12 }}>
            <div class="row label ink2" style={{ gap: 12 }}>
              <span class="grow" style={{ height: 1, background: 'var(--line)' }} />
              atau
              <span class="grow" style={{ height: 1, background: 'var(--line)' }} />
            </div>
            <div class={demo ? 'grid2' : 'stack-sm'}>
              <button type="button" style={TILE} onClick={() => choose('join')}>
                <Icon name="users" />
                <span class="strong" style={{ lineHeight: 1.25 }}>
                  Punya kode undangan
                </span>
                <span class="label ink2" style={{ lineHeight: 1.25 }}>
                  Untuk pekerja
                </span>
              </button>
              {demo && (
                <button type="button" style={TILE} disabled={busy} onClick={() => run(api.demo)}>
                  <Glyph d={GLYPH.play} />
                  <span class="strong" style={{ lineHeight: 1.25 }}>
                    Coba demo
                  </span>
                  <span class="label ink2" style={{ lineHeight: 1.25 }}>
                    Tambak contoh, direset tiap malam
                  </span>
                </button>
              )}
            </div>
          </div>
        )}
      </form>
    </div>
  );
}

const TILE = {
  minHeight: 88,
  borderRadius: 16,
  border: '2px solid var(--line-2)',
  background: 'var(--surface)',
  padding: 12,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  justifyContent: 'center',
  gap: 4,
  textAlign: 'left',
  color: 'var(--ink)',
} as const;
