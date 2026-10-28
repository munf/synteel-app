import { useEffect, useState } from 'preact/hooks';
import { api, type Me, type Role } from '../api.ts';
import { Field, Icon, PinInput, roleLabel, Wordmark } from '../ui.tsx';

type Mode = 'login' | 'register' | 'join';

const TITLES: Record<Mode, { title: string; sub: string; button: string }> = {
  login: { title: 'Masuk', sub: 'Pakai nomor HP dan PIN 6 angka.', button: 'Masuk' },
  register: { title: 'Daftar', sub: 'Buat akun baru, lalu siapkan tambak.', button: 'Daftar' },
  join: { title: 'Gabung dengan kode', sub: 'Kode undangan didapat dari pemilik tambak.', button: 'Gabung' },
};

function PhoneInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <input type="tel" inputMode="tel" autoComplete="tel" value={value} onInput={(e) => onChange(e.currentTarget.value)} placeholder="mis. 0812 3456 7890" required />;
}

export function SignIn({ onSignedIn }: { onSignedIn: (me: Me) => void }) {
  const [mode, setMode] = useState<Mode>('login');
  const [demo, setDemo] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [code, setCode] = useState('');
  const [invite, setInvite] = useState<{ farmName: string; role: Role } | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.authOptions().then((o) => setDemo(o.demo), () => {});
  }, []);

  // Look the code up as soon as it is complete, so the person sees which farm they join.
  useEffect(() => {
    setInvite(null);
    if (mode !== 'join') return;
    setError('');
    if (code.length !== 6) return;
    let live = true;
    setChecking(true);
    api.invite(code).then(
      (i) => live && setInvite(i),
      (e) => live && setError(e.message),
    ).finally(() => live && setChecking(false));
    return () => {
      live = false;
    };
  }, [code, mode]);

  const choose = (m: Mode) => {
    setMode(m);
    setError('');
    setPin('');
    setPin2('');
  };

  const run = async (fn: () => Promise<Me>) => {
    setBusy(true);
    setError('');
    try {
      onSignedIn(await fn());
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const submit = (e: Event) => {
    e.preventDefault();
    if (pin.length !== 6) return setError('PIN harus 6 angka');
    if (mode === 'login') return run(() => api.login(phone, pin));
    if (mode === 'register') {
      if (pin !== pin2) return setError('PIN ulang tidak sama. Ketik lagi.');
      return run(() => api.register(name, phone, pin));
    }
    if (!invite) return setError('Masukkan kode undangan yang berlaku');
    return run(() => api.join(code, name, phone, pin));
  };

  const t = TITLES[mode];
  const showForm = mode !== 'join' || invite !== null;

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

      <section class="stack-sm">
        <h1>{t.title}</h1>
        <p class="ink2">{t.sub}</p>
      </section>

      <section class="card">
        {mode === 'join' && (
          <Field label="Kode undangan" hint="6 huruf dan angka">
            <input
              class="code-input"
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
        {mode === 'join' && invite && (
          <div class="note ok" style={{ fontSize: '1rem' }}>
            <Icon name="check" stroke={3} />
            <span>
              Bergabung ke <b>{invite.farmName}</b> sebagai {roleLabel[invite.role].toLowerCase()}
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
            <PhoneInput value={phone} onChange={setPhone} />
          </Field>
        )}
        {showForm && (
          <Field label="PIN" hint={mode === 'register' ? '6 angka yang mudah diingat, tapi jangan 123456 atau 111111.' : undefined}>
            <PinInput value={pin} onChange={setPin} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
          </Field>
        )}
        {showForm && mode === 'register' && (
          <Field label="Ulangi PIN">
            <PinInput value={pin2} onChange={setPin2} autoComplete="new-password" />
          </Field>
        )}
      </section>

      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}

      {showForm && (
        <button class="btn primary" disabled={busy}>
          {busy ? 'Tunggu…' : t.button}
        </button>
      )}

      {mode === 'login' && <p class="meta center">Lupa PIN? Minta pemilik tambak mengatur ulang PIN.</p>}

      {mode !== 'join' && (
        <button type="button" class="btn dashed" onClick={() => choose('join')}>
          <Icon name="users" size={20} /> Punya kode undangan?
        </button>
      )}

      {demo && mode !== 'join' && (
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
