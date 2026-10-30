import { useEffect, useState } from 'preact/hooks';
import { api, API, ApiError, type Me, type Role } from '../api.ts';
import { fmtClock } from '../labels.ts';
import { Field, fmtPhone, Glyph, GLYPH, Icon, LangSwitch, Notice, PinBoxes, roleLabel } from '../ui.tsx';
import type { SignInMode } from './welcome.tsx';
import { lang, siteInAppLanguage, t } from '../i18n.ts';

/** 'reset': Lupa PIN, a code to the account's e-mail and a new PIN. */
type Mode = SignInMode | 'reset';

const BUTTONS: Record<Mode, string> = {
  login: t('Masuk', 'Sign in'),
  register: t('Daftar dan siapkan tambak', 'Create account and set up farm'),
  join: t('Gabung ke tambak', 'Join the farm'),
  reset: t('Simpan PIN baru dan masuk', 'Save the new PIN and sign in'),
};
const SEND_CODE = t('Kirim kode ke email', 'Send a code to my e-mail');
const PIN_SHORT = t('PIN harus 6 angka', 'The PIN must be 6 digits');

/** How long the server locks the PIN when it gives no time (matches its limiter). */
const LOCK_FALLBACK_MS = 15 * 60_000;

/** Login, keeping the lockout time the server sends with a 429 (api.ts drops extra fields). */
async function login(phone: string, pin: string): Promise<Me> {
  const res = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'x-lang': lang, 'content-type': 'application/json' }, body: JSON.stringify({ phone, pin }) });
  const json = await res.json().catch(() => ({}));
  if (res.ok) return json as Me;
  if (res.status === 429 || json.code === 'locked') throw new Locked(json.retryAt ? Date.parse(json.retryAt) : Date.now() + LOCK_FALLBACK_MS);
  throw new ApiError(json.error ?? t(`Gagal (${res.status})`, `Failed (${res.status})`), res.status, json.code);
}

class Locked extends Error {
  until: number;
  constructor(until: number) {
    super(t('Terlalu banyak percobaan', 'Too many tries'));
    this.until = until;
  }
}

const isPhoneTaken = (e: unknown) => e instanceof ApiError && (e.code === 'phone_taken' || e.status === 409);
const isInviteInvalid = (e: unknown) => e instanceof ApiError && (e.code === 'invite_invalid' || [400, 404, 410].includes(e.status));
const isWrongPin = (e: unknown) => e instanceof ApiError && (e.status === 401 || e.status === 403);
const hasNoEmail = (e: unknown) => e instanceof ApiError && (e.code === 'no_email' || e.code === 'no_mail');

/** Compact navy header: logo, wordmark, the eel strip and the promise. */
function Header() {
  return (
    <header
      style={{
        background: 'var(--hero-bg)',
        color: '#fff',
        padding: 'calc(20px + env(safe-area-inset-top, 0px)) 20px 44px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div class="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <span class="icon-box" style={{ width: 36, height: 36, borderRadius: 12, background: '#fbd38d', color: 'var(--hero-bg)' }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
            <path d="M3 13c3-4 5-4 8 0s5 4 10-2" />
          </svg>
        </span>
        <span class="title">synteel</span>
        <LangSwitch onHero />
      </div>
      <p style={{ fontSize: '1.125rem', fontWeight: 800, lineHeight: 1.3 }}>{t('Jaga kolam sidat, siang dan malam', 'Look after your eel ponds, day and night')}</p>
    </header>
  );
}

/** "contoh: nama@gmail.com" with an envelope drawn inside the field. */
function EmailInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <span style={{ position: 'relative', display: 'block' }}>
      <span style={{ position: 'absolute', left: 16, top: 18, color: 'var(--ink-2)', display: 'flex' }}>
        <Glyph d={GLYPH.mail} size={20} />
      </span>
      <input
        type="email"
        inputMode="email"
        autoComplete="email"
        autoCapitalize="off"
        spellcheck={false}
        value={value}
        onInput={(e) => onChange(e.currentTarget.value)}
        placeholder={t('contoh: nama@gmail.com', 'example: name@gmail.com')}
        required
        style={{ paddingLeft: 48 }}
      />
    </span>
  );
}

/** The 6 digits from the e-mail, with where it went and a way to send it again. */
function EmailCode({ sentTo, value, onChange, onResend, busy }: { sentTo: string; value: string; onChange: (v: string) => void; onResend: () => void; busy: boolean }) {
  return (
    <div class="stack-sm">
      <div class="note ok" style={{ alignItems: 'center' }}>
        <Glyph d={GLYPH.mail} size={20} />
        <span style={{ display: 'flex', flexDirection: 'column' }}>
          <b>{t(`Kode dikirim ke ${sentTo}`, `Code sent to ${sentTo}`)}</b>
          <span class="label">{t('Belum ada? Cek folder Spam atau Promosi.', 'Not there? Check the Spam or Promotions folder.')}</span>
        </span>
      </div>
      <Field label={t('Kode dari email', 'Code from the e-mail')}>
        <input
          class="code-input"
          value={value}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          onInput={(e) => {
            const v = e.currentTarget.value.replace(/\D/g, '').slice(0, 6);
            e.currentTarget.value = v;
            onChange(v);
          }}
          placeholder={t('6 angka', '6 digits')}
          style={{ textTransform: 'none' }}
          required
        />
      </Field>
      <button type="button" class="link-btn" style={{ alignSelf: 'flex-start', fontWeight: 800, minHeight: 44 }} disabled={busy} onClick={onResend}>
        {t('Kirim ulang kode', 'Send the code again')}
      </button>
    </div>
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
        placeholder={t('contoh: 0812 3456 7890', 'example: 0812 3456 7890')}
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
  /** The server can send mail: Daftar asks for an e-mail code, Lupa PIN works by e-mail. */
  const [emailOn, setEmailOn] = useState(false);
  const [email, setEmail] = useState('');
  /** Where the code went ("sa•••@gmail.com"), once it was sent. */
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [emailCode, setEmailCode] = useState('');
  const [noEmail, setNoEmail] = useState(false);
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
    api.authOptions().then(
      (o) => {
        setDemo(o.demo);
        setEmailOn(Boolean(o.email));
      },
      () => {},
    );
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
    setSentTo(null);
    setEmailCode('');
    setNoEmail(false);
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

  /** Asks the server to e-mail a code; a number already taken or without an e-mail shows its own note. */
  const sendCode = async () => {
    setBusy(true);
    setError('');
    setNoEmail(false);
    try {
      const { sentTo } = await (mode === 'reset' ? api.sendCode('reset', phone) : api.sendCode('register', phone, email));
      setSentTo(sentTo);
      setEmailCode('');
    } catch (err) {
      if (mode === 'register' && isPhoneTaken(err)) setTaken(true);
      else if (mode === 'reset' && hasNoEmail(err)) setNoEmail(true);
      else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: Event) => {
    e.preventDefault();
    if (locked || busy) return;
    if (taken) return choose('login');
    if (mode === 'reset' && !sentTo) return sendCode();
    if (pin.length !== 6) return setError(PIN_SHORT);
    if (mode === 'login') return run(() => login(phone, pin));
    if (mode === 'register' && emailOn && !sentTo) return sendCode();
    if ((mode === 'register' && emailOn) || mode === 'reset') {
      if (emailCode.length !== 6) return setError(t('Masukkan 6 angka dari email', 'Enter the 6 digits from the e-mail'));
    }
    if (mode === 'reset') return run(() => api.forgotPin(phone, emailCode, pin));
    if (mode === 'register') return run(() => (emailOn ? api.register(name, phone, pin, email, emailCode) : api.register(name, phone, pin)), pin);
    if (!invite) return setError(t('Masukkan kode undangan yang berlaku', 'Enter a valid invite code'));
    return run(() => api.join(code, name, phone, pin));
  };

  const locked = mode === 'login' && lockedUntil !== null;
  const join = mode === 'join';
  const reset = mode === 'reset';
  const showForm = !join || invite !== null;
  const askOwner = t(
    `Halo, kode undangan Synteel ${code} sudah tidak berlaku. Boleh minta kode baru?`,
    `Hello, the Synteel invite code ${code} no longer works. Could I have a new code?`,
  );
  const pinHint =
    mode === 'register' || reset
      ? t('Hindari PIN yang mudah ditebak 123456 atau 111111.', 'Avoid PINs that are easy to guess, like 123456 or 111111.')
      : join
        ? t('PIN terlihat supaya tidak salah ketik.', 'The PIN is shown so you do not mistype it.')
        : sessionEnded
          ? t('PIN baru dari pemilik tambak, kalau baru diatur ulang.', 'Use the new PIN from the farm owner if it was just reset.')
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
        {join || reset ? (
          <div class="stack-xs">
            <button type="button" class="link-btn row" style={{ alignSelf: 'flex-start', gap: 8, fontWeight: 600 }} onClick={() => choose('login')}>
              <Icon name="back" size={20} /> {t('Kembali ke Masuk', 'Back to Sign in')}
            </button>
            <h1>{join ? t('Gabung dengan kode', 'Join with a code') : t('Buat PIN baru', 'Set a new PIN')}</h1>
            <p class="ink2">
              {join
                ? t('Kode undangan didapat dari pemilik tambak.', 'You get the invite code from the farm owner.')
                : t('Kode dikirim ke email yang dipakai saat daftar.', 'A code goes to the e-mail used when the account was made.')}
            </p>
          </div>
        ) : (
          <div class="stack-sm">
            <div role="tablist" aria-label={t('Masuk atau daftar', 'Sign in or create account')} style={{ background: 'var(--bg)', borderRadius: 16, padding: 4, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 4 }}>
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
                    {m === 'login' ? t('Masuk', 'Sign in') : t('Daftar', 'Create account')}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {sessionEnded && mode === 'login' && (
          <Notice tone="info" icon="login" title={t('Akun ini sudah keluar', 'This account was signed out')} role="status">
            {t(
              'Karena PIN diatur ulang oleh pemilik tambak, atau akun ini masuk di HP lain. Masuk lagi untuk lanjut.',
              'The farm owner reset the PIN, or this account signed in on another phone. Sign in again to continue.',
            )}
          </Notice>
        )}

        {join && (
          <Field label={t('Kode undangan', 'Invite code')} hint={t('6 huruf dan angka, dari pesan pemilik tambak', "6 letters and numbers, from the farm owner's message")}>
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
              placeholder={t('contoh: K7QM2P', 'example: K7QM2P')}
              required
            />
          </Field>
        )}
        {join && checking && (
          <p role="status" class="row ink2" style={{ gap: 8 }}>
            <Glyph d={GLYPH.spinner} size={20} stroke={2.5} /> {t('Memeriksa kode…', 'Checking the code…')}
          </p>
        )}
        {join && inviteBad && (
          <Notice tone="info" icon="info" title={t('Kode ini sudah tidak berlaku', 'This code no longer works')} role="alert">
            {t(
              'Kode undangan berlaku 7 hari dan hanya bisa dipakai sekali. Kode ini sudah lewat 7 hari atau sudah dipakai.',
              'An invite code works for 7 days and only once. This code is older than 7 days or was already used.',
            )}
          </Notice>
        )}
        {join && invite && (
          <div class="note ok" style={{ fontSize: '1rem', alignItems: 'center' }}>
            <Icon name="check" stroke={3} />
            <span style={{ display: 'flex', flexDirection: 'column' }}>
              <b>{invite.farmName}</b>
              <span class="label">{t('Bergabung sebagai', 'Joining as a')} {roleLabel[invite.role].toLowerCase()}</span>
            </span>
          </div>
        )}

        {showForm && mode !== 'login' && !reset && !taken && (
          <Field label={t('Nama', 'Name')} hint={join ? t('Sudah punya akun? Isi nomor HP dan PIN yang biasa dipakai.', 'Already have an account? Enter your usual phone number and PIN.') : undefined}>
            <input autoComplete="name" value={name} onInput={(e) => setName(e.currentTarget.value)} placeholder={t('contoh: Pak Joko', 'example: Pak Joko')} required={mode === 'register'} />
          </Field>
        )}
        {showForm && (
          <Field label={t('Nomor HP', 'Phone number')}>
            <PhoneInput
              value={phone}
              border={phoneBorder}
              onChange={(v) => {
                setPhone(v);
                setTaken(false);
                setWrong(false);
                setNoEmail(false);
                if (sentTo) setSentTo(null);
              }}
            />
          </Field>
        )}
        {mode === 'register' && emailOn && !taken && (
          <Field label={t('Email', 'E-mail')}>
            <EmailInput
              value={email}
              onChange={(v) => {
                setEmail(v);
                if (sentTo) setSentTo(null);
              }}
            />
          </Field>
        )}
        {reset && noEmail && (
          <Notice tone="info" icon="info" title={t('Nomor ini belum punya email', 'This number has no e-mail')} role="status">
            {t(
              'Pekerja: minta pemilik tambak mengatur ulang PIN. Pemilik tambak: hubungi bantuan.',
              'Workers: ask the farm owner to reset the PIN. Farm owners: contact support.',
            )}
          </Notice>
        )}
        {taken && (
          <Notice tone="info" icon="userCheck" title={t('Nomor ini sudah punya akun', 'This number already has an account')} role="status">
            {t('Tidak perlu daftar lagi. Masuk dengan PIN yang biasa dipakai.', 'No need to sign up again. Sign in with your usual PIN.')}
          </Notice>
        )}
        {reset && sentTo && <EmailCode sentTo={sentTo} value={emailCode} onChange={setEmailCode} onResend={sendCode} busy={busy} />}
        {showForm && !taken && (!reset || sentTo) && (
          <div class="stack-sm">
            <PinBoxes
              key={`${mode}:${pinKey}`}
              value={pin}
              onChange={(v) => {
                setPin(v);
                setWrong(false);
                if (error === PIN_SHORT) setError('');
              }}
              defaultShow={mode !== 'login'}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              locked={locked}
              error={wrong}
              hint={locked ? undefined : pinHint}
            />
            {wrong && (
              <p role="alert" class="row label" style={{ gap: 8, fontWeight: 600, color: 'var(--bad)' }}>
                <Glyph d={GLYPH.errorCircle} size={18} /> {t('Nomor HP atau PIN salah. Cek nomornya, lalu ketik PIN lagi.', 'Wrong phone number or PIN. Check the number, then type the PIN again.')}
              </p>
            )}
          </div>
        )}
        {mode === 'register' && emailOn && sentTo && !taken && <EmailCode sentTo={sentTo} value={emailCode} onChange={setEmailCode} onResend={sendCode} busy={busy} />}
        {locked && (
          <Notice tone="info" icon="lock" title={t('Terlalu banyak percobaan', 'Too many tries')} role="alert">
            {lockText(Math.max(1, Math.ceil((lockedUntil! - Date.now()) / 60_000)), fmtClock(lockedUntil!))}
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
              {t('Masuk dengan nomor ini', 'Sign in with this number')} <Icon name="arrow" size={20} stroke={2.2} />
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
              {t('Pakai nomor lain', 'Use another number')}
            </button>
          </div>
        ) : locked ? (
          <button class="btn primary" disabled>
            {t(`Masuk lagi jam ${fmtClock(lockedUntil!)}`, `Sign in again at ${fmtClock(lockedUntil!)}`)}
          </button>
        ) : (
          showForm && (
            <button class="btn primary" disabled={busy}>
              {busy ? (
                t('Tunggu…', 'Wait…')
              ) : (
                <>
                  {(reset || (mode === 'register' && emailOn)) && !sentTo ? SEND_CODE : BUTTONS[mode]} <Icon name="arrow" size={20} stroke={2.2} />
                </>
              )}
            </button>
          )
        )}
        {showForm && mode !== 'login' && !reset && !taken && (
          <div class="label ink2 center" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <span>{t('Data dikelola PT Synt Tekno Multikarya.', 'Data is handled by PT Synt Tekno Multikarya.')}</span>
            <a
              class="inline-link"
              href="https://eel.synt.fun/privasi/"
              target="_blank"
              rel="noopener"
              onClick={siteInAppLanguage}
              style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center', textDecoration: 'underline', textUnderlineOffset: 3 }}
            >
              {t('Baca kebijakan privasi', 'Read the privacy policy')}
            </a>
          </div>
        )}

        {join && inviteBad && (
          <div class="stack-sm">
            <a class="btn primary" href={`https://wa.me/?text=${encodeURIComponent(askOwner)}`} target="_blank" rel="noopener">
              <Icon name="chat" size={20} /> {t('Minta kode baru ke pemilik tambak', 'Ask the farm owner for a new code')}
            </a>
            <p class="label ink2 center">{t('Membuka WhatsApp dengan pesan yang siap dikirim.', 'Opens WhatsApp with a message ready to send.')}</p>
          </div>
        )}

        {mode === 'login' && (
          <div class="label ink2 center" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <button
              type="button"
              class="inline-link"
              style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center', textDecoration: 'underline', textUnderlineOffset: 3 }}
              onClick={emailOn ? () => choose('reset') : onHelp}
            >
              {t('Lupa PIN?', 'Forgot the PIN?')}
            </button>
          </div>
        )}

        {reset && noEmail && (
          <button type="button" class="btn" onClick={onHelp}>
            <Icon name="headset" size={20} /> {t('Hubungi bantuan', 'Contact support')}
          </button>
        )}

        {!join && !reset && !taken && (
          <div class="stack-sm" style={{ gap: 12 }}>
            <div class="row label ink2" style={{ gap: 12 }}>
              <span class="grow" style={{ height: 1, background: 'var(--line)' }} />
              {t('atau', 'or')}
              <span class="grow" style={{ height: 1, background: 'var(--line)' }} />
            </div>
            <div class={demo ? 'grid2' : 'stack-sm'}>
              <button type="button" style={TILE} onClick={() => choose('join')}>
                <Icon name="users" />
                <span class="strong" style={{ lineHeight: 1.25 }}>
                  {t('Punya kode undangan', 'Have an invite code')}
                </span>
              </button>
              {demo && (
                <button type="button" style={TILE} disabled={busy} onClick={() => run(api.demo)}>
                  <Glyph d={GLYPH.play} />
                  <span class="strong" style={{ lineHeight: 1.25 }}>
                    {t('Coba demo', 'Try the demo')}
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

const lockText = (min: number, at: string) =>
  t(
    `Coba lagi ${min} menit lagi (jam ${at}). PIN dikunci sebentar supaya akun aman.`,
    `Try again in ${min} ${min === 1 ? 'minute' : 'minutes'} (at ${at}). The PIN is locked for a while to keep the account safe.`,
  );

const TILE = {
  minHeight: 88,
  borderRadius: 16,
  border: 0,
  background: 'var(--bg)',
  padding: 12,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 4,
  textAlign: 'center',
  color: 'var(--ink)',
} as const;
