import { useEffect, useState } from 'preact/hooks';
import { api, API, ApiError, type Me, type Role } from '../api.ts';
import { fmtClock } from '../labels.ts';
import { Field, fmtPhone, Icon, Notice, PinInput, roleLabel, Wordmark } from '../ui.tsx';

type Mode = 'login' | 'register' | 'join';

const TITLES: Record<Mode, { title: string; sub: string; button: string }> = {
  login: { title: 'Masuk', sub: 'Pakai nomor HP dan PIN 6 angka.', button: 'Masuk' },
  register: { title: 'Daftar', sub: 'Buat akun baru, lalu siapkan tambak.', button: 'Daftar' },
  join: { title: 'Gabung dengan kode', sub: 'Kode undangan didapat dari pemilik tambak.', button: 'Gabung' },
};

/** How long the server locks the PIN when it gives no time (matches its limiter). */
const LOCK_FALLBACK_MS = 15 * 60_000;

function PhoneInput({ value, onChange, class: cls }: { value: string; onChange: (v: string) => void; class?: string }) {
  return <input type="tel" inputMode="tel" autoComplete="tel" class={cls} value={value} onInput={(e) => onChange(e.currentTarget.value)} placeholder="mis. 0812 3456 7890" required />;
}

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

export function SignIn({
  onSignedIn,
  onHelp,
  sessionEnded,
  lastPhone,
}: {
  onSignedIn: (me: Me) => void;
  /** Opens Bantuan (an owner who forgot the PIN has nobody else to ask). */
  onHelp: () => void;
  /** The app came back here because the session was lost, not because of a manual sign-out. */
  sessionEnded?: boolean;
  /** The phone number of the session that ended, so only the PIN is needed. */
  lastPhone?: string;
}) {
  const [mode, setMode] = useState<Mode>('login');
  const [demo, setDemo] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState(lastPhone ? fmtPhone(lastPhone) : '');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [code, setCode] = useState('');
  const [invite, setInvite] = useState<{ farmName: string; role: Role } | null>(null);
  const [inviteBad, setInviteBad] = useState(false);
  const [checking, setChecking] = useState(false);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [taken, setTaken] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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
    setPin('');
    setPin2('');
  };

  const run = async (fn: () => Promise<Me>) => {
    setBusy(true);
    setError('');
    try {
      onSignedIn(await fn());
    } catch (err) {
      if (err instanceof Locked) setLockedUntil(err.until);
      else if (mode === 'register' && isPhoneTaken(err)) setTaken(true);
      else if (mode === 'join' && isInviteInvalid(err)) setInviteBad(true);
      else setError((err as Error).message);
      setBusy(false);
    }
  };

  const submit = (e: Event) => {
    e.preventDefault();
    if (locked) return;
    if (taken) return choose('login');
    if (pin.length !== 6) return setError('PIN harus 6 angka');
    if (mode === 'login') return run(() => login(phone, pin));
    if (mode === 'register') {
      if (pin !== pin2) return setError('PIN ulang tidak sama. Ketik lagi.');
      return run(() => api.register(name, phone, pin));
    }
    if (!invite) return setError('Masukkan kode undangan yang berlaku');
    return run(() => api.join(code, name, phone, pin));
  };

  const t = TITLES[mode];
  const locked = mode === 'login' && lockedUntil !== null;
  const showForm = mode !== 'join' || invite !== null;
  const askOwner = `Halo, kode undangan Synteel ${code} sudah tidak berlaku. Boleh minta kode baru?`;

  return (
    <form class="screen" onSubmit={submit} style={{ paddingBottom: 48 }}>
      <Wordmark />

      {mode === 'join' ? (
        <button type="button" class="link-row" style={{ justifyContent: 'flex-start' }} onClick={() => choose('login')}>
          <Icon name="back" size={20} /> Kembali ke Masuk
        </button>
      ) : (
        <div class="segmented" role="tablist" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
          {(['login', 'register'] as const).map((m) => (
            <button type="button" key={m} role="tab" aria-selected={mode === m} class={mode === m ? 'on' : ''} onClick={() => choose(m)}>
              {mode === m && <Icon name="check" size={16} stroke={3} />}
              {TITLES[m].title}
            </button>
          ))}
        </div>
      )}

      {sessionEnded && mode === 'login' && (
        <Notice tone="info" icon="login" title="Akun ini sudah keluar" role="status">
          Karena PIN diatur ulang oleh pemilik tambak, atau akun ini masuk di HP lain. Masuk lagi untuk lanjut.
        </Notice>
      )}

      <section class="stack-sm">
        <h1>{t.title}</h1>
        <p class="ink2">{t.sub}</p>
      </section>

      <section class="card">
        {mode === 'join' && (
          <Field label="Kode undangan" hint="6 huruf dan angka">
            <input
              class={`code-input${inviteBad ? ' warn-border' : ''}`}
              value={code}
              maxLength={6}
              autoCapitalize="characters"
              autoComplete="off"
              spellcheck={false}
              onInput={(e) => {
                const v = e.currentTarget.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
                e.currentTarget.value = v;
                setCode(v);
              }}
              placeholder="mis. K7QM2P"
              required
            />
          </Field>
        )}
        {mode === 'join' && checking && <p class="working">Memeriksa kode…</p>}
        {mode === 'join' && inviteBad && (
          <Notice tone="warn" icon="alert" title="Kode ini sudah tidak berlaku" role="alert">
            Kode undangan berlaku 7 hari dan hanya bisa dipakai sekali. Kode ini sudah lewat 7 hari atau sudah dipakai.
          </Notice>
        )}
        {mode === 'join' && invite && (
          <div class="note ok" style={{ fontSize: '1rem' }}>
            <Icon name="check" stroke={3} />
            <span style={{ display: 'flex', flexDirection: 'column' }}>
              <b>{invite.farmName}</b>
              <span>Bergabung sebagai {roleLabel[invite.role].toLowerCase()}</span>
            </span>
          </div>
        )}

        {showForm && (mode === 'register' || mode === 'join') && (
          <Field label="Nama" hint={mode === 'join' ? 'Sudah punya akun? Isi nomor HP dan PIN yang biasa dipakai.' : undefined}>
            <input autoComplete="name" value={name} onInput={(e) => setName(e.currentTarget.value)} placeholder="mis. Pak Joko" required={mode === 'register'} />
          </Field>
        )}
        {showForm && (
          <Field label="Nomor HP">
            <PhoneInput
              value={phone}
              class={taken ? 'accent-border' : undefined}
              onChange={(v) => {
                setPhone(v);
                setTaken(false);
              }}
            />
          </Field>
        )}
        {taken ? (
          <Notice tone="info" icon="userCheck" title="Nomor ini sudah punya akun" role="status">
            Tidak perlu daftar lagi. Masuk dengan PIN yang biasa dipakai.
          </Notice>
        ) : (
          showForm && (
            <Field
              label={<span class={locked ? 'muted' : undefined}>PIN</span>}
              hint={mode === 'register' ? '6 angka yang mudah diingat, tapi jangan 123456 atau 111111.' : sessionEnded && mode === 'login' ? 'PIN baru dari pemilik tambak, kalau baru diatur ulang.' : undefined}
            >
              {locked ? (
                <input class="pin-input" type="password" disabled placeholder="••••••" aria-label="PIN dikunci" />
              ) : (
                <PinInput value={pin} onChange={setPin} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
              )}
            </Field>
          )
        )}
        {showForm && mode === 'register' && !taken && (
          <Field label="Ulangi PIN">
            <PinInput value={pin2} onChange={setPin2} autoComplete="new-password" />
          </Field>
        )}
        {locked && (
          <Notice tone="warn" icon="lock" title="Terlalu banyak percobaan" role="alert">
            Coba lagi {Math.max(1, Math.ceil((lockedUntil! - Date.now()) / 60_000))} menit lagi (jam {fmtClock(lockedUntil!)}). PIN dikunci sebentar supaya akun aman.
          </Notice>
        )}
      </section>

      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}

      {taken ? (
        <div class="stack-sm">
          <button class="btn primary">Masuk dengan nomor ini</button>
          <button
            type="button"
            class="link-btn"
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
            {busy ? 'Tunggu…' : t.button}
          </button>
        )
      )}

      {mode === 'join' && inviteBad && (
        <div class="stack-sm">
          <a class="btn primary" href={`https://wa.me/?text=${encodeURIComponent(askOwner)}`} target="_blank" rel="noopener">
            <Icon name="chat" size={20} /> Minta kode baru ke pemilik tambak
          </a>
          <p class="meta center">Membuka WhatsApp dengan pesan yang siap dikirim.</p>
        </div>
      )}

      {mode === 'login' && (
        <p class="meta center">
          Lupa PIN? Minta pemilik tambak mengatur ulang PIN. Pemilik lupa PIN?{' '}
          <button type="button" class="inline-link" onClick={onHelp}>
            Hubungi bantuan
          </button>
        </p>
      )}

      {mode !== 'join' && !taken && (
        <button type="button" class="btn dashed" onClick={() => choose('join')}>
          <Icon name="users" size={20} /> Punya kode undangan?
        </button>
      )}

      {demo && mode !== 'join' && !taken && (
        <div class="stack-sm">
          <button type="button" class="btn secondary" disabled={busy} onClick={() => run(api.demo)}>
            Coba demo
          </button>
          <p class="meta center">Tambak contoh, direset tiap malam</p>
        </div>
      )}
    </form>
  );
}
