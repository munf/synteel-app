import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type Member, type Role } from '../api.ts';
import { Field, fmtPhone, Icon, initialOf, PinInput, roleLabel, Tick } from '../ui.tsx';

type Pending = { kind: 'pin' | 'remove'; member: Member } | null;

/** Who uses this farm. Owners can invite, reset a forgotten PIN and remove people. */
export function Members({ farmName, owner, inviteOpen, onInviteOpen }: { farmName: string; owner: boolean; inviteOpen: boolean; onInviteOpen: (open: boolean) => void }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [tempPin, setTempPin] = useState<{ name: string; pin: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api.members().then(
      (r) => setMembers(r.members),
      (e) => setError(e.message),
    );
  useEffect(() => {
    load();
  }, []);

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    setError('');
    try {
      if (pending.kind === 'pin') {
        const { pin } = await api.resetPin(pending.member.id);
        setTempPin({ name: pending.member.name, pin });
      } else {
        await api.removeMember(pending.member.id);
        setOpenId(null);
        await load();
      }
      setPending(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="card" id="anggota">
      <div class="row between">
        <h2>Anggota tambak</h2>
        {members && <span class="meta">{members.length} orang</span>}
      </div>

      {!members && !error && <p class="muted">Memuat…</p>}

      {members && (
        <div class="stack-xs">
          {members.map((m, i) => {
            const canManage = owner && !m.me;
            const open = canManage && openId === m.id;
            const head = (
              <>
                <span class="avatar" aria-hidden="true">
                  {initialOf(m.name)}
                </span>
                <span class="grow stack-xs" style={{ gap: 0 }}>
                  <span class="strong">
                    {m.name}
                    {m.me && <span class="semi muted"> (saya)</span>}
                  </span>
                  <span class="meta">
                    {roleLabel[m.role]}
                    {m.phone && ` · ${fmtPhone(m.phone)}`}
                  </span>
                </span>
              </>
            );
            return (
              <div key={m.id} style={{ borderBottom: i < members.length - 1 ? '1px solid var(--line)' : 0 }}>
                {canManage ? (
                  <button
                    type="button"
                    class="list-row"
                    aria-expanded={open}
                    style={{ width: '100%', border: 0, background: 'none', padding: 0, textAlign: 'left', color: 'inherit' }}
                    onClick={() => {
                      setOpenId(open ? null : m.id);
                      setPending(null);
                      setTempPin(null);
                      setError('');
                    }}
                  >
                    {head}
                    <span style={{ color: 'var(--muted)', transform: open ? 'rotate(180deg)' : undefined, display: 'flex' }}>
                      <Icon name="down" />
                    </span>
                  </button>
                ) : (
                  <div class="list-row" style={{ borderBottom: 0 }}>{head}</div>
                )}

                {open && (
                  <div class="stack-sm" style={{ paddingBottom: 16 }}>
                    {tempPin && tempPin.name === m.name ? (
                      <div class="box stack-sm" style={{ background: 'var(--tint)' }}>
                        <span class="label semi">PIN sementara untuk {m.name}</span>
                        <span class="big" style={{ letterSpacing: '0.12em' }}>
                          {tempPin.pin}
                        </span>
                        <span class="label ink2">Berikan PIN ini ke {m.name}. PIN hanya tampil sekali. Setelah masuk, ganti PIN di Profil.</span>
                        <button type="button" class="btn secondary" onClick={() => setTempPin(null)}>
                          Sudah dicatat
                        </button>
                      </div>
                    ) : pending ? (
                      <div class="box stack-sm" style={{ background: 'var(--bad-soft)' }}>
                        <span class="strong">{pending.kind === 'pin' ? `Atur ulang PIN ${m.name}?` : `Keluarkan ${m.name} dari tambak?`}</span>
                        <span class="label ink2">
                          {pending.kind === 'pin'
                            ? 'PIN lama tidak berlaku lagi dan akun ini keluar dari semua HP. Sesudah itu muncul PIN sementara.'
                            : `${m.name} tidak bisa membuka ${farmName} lagi. Catatan yang sudah dibuat tetap tersimpan.`}
                        </span>
                        <div class="grid2" style={{ gap: 8 }}>
                          <button type="button" class="btn secondary" onClick={() => setPending(null)} disabled={busy}>
                            Batal
                          </button>
                          <button type="button" class="btn danger" onClick={confirm} disabled={busy}>
                            {pending.kind === 'pin' ? 'Ya, atur ulang' : 'Ya, keluarkan'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div class="grid2" style={{ gap: 8 }}>
                        <button type="button" class="btn secondary" onClick={() => setPending({ kind: 'pin', member: m })}>
                          <Icon name="key" size={20} /> Atur ulang PIN
                        </button>
                        <button type="button" class="btn secondary" style={{ color: 'var(--bad)' }} onClick={() => setPending({ kind: 'remove', member: m })}>
                          Keluarkan
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}

      {owner ? (
        inviteOpen ? (
          <Invite farmName={farmName} onClose={() => onInviteOpen(false)} />
        ) : (
          <button type="button" class="btn primary" onClick={() => onInviteOpen(true)}>
            <Icon name="plus" size={20} /> Undang anggota
          </button>
        )
      ) : (
        <p class="meta">Hanya pemilik tambak yang bisa mengundang atau mengeluarkan anggota.</p>
      )}
    </section>
  );
}

const ROLE_HINT: Record<Role, string> = {
  worker: 'bisa mencatat dan melihat kolam.',
  owner: 'juga bisa mengubah tambak, kolam dan anggota.',
};

function Invite({ farmName, onClose }: { farmName: string; onClose: () => void }) {
  const [role, setRole] = useState<Role>('worker');
  const [invite, setInvite] = useState<{ code: string; role: Role; expiresInDays: number } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [invite]);

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      setInvite(await api.createInvite(role));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (invite) {
    const url = window.location.origin + window.location.pathname;
    const text = `Bergabung ke ${farmName} di Synteel sebagai ${roleLabel[invite.role].toLowerCase()}. Buka ${url}, pilih "Punya kode undangan?", lalu masukkan kode ${invite.code}. Kode berlaku ${invite.expiresInDays} hari.`;
    return (
      <div ref={ref} class="box stack" style={{ background: 'var(--tint)', padding: 16 }}>
        <div class="stack-xs center">
          <span class="label semi">Kode undangan {roleLabel[invite.role].toLowerCase()}</span>
          <span class="big" style={{ letterSpacing: '0.12em' }} aria-label={invite.code.split('').join(' ')}>
            {invite.code}
          </span>
          <span class="label ink2">Berlaku {invite.expiresInDays} hari · sekali pakai</span>
        </div>
        <span class="label ink2">Di HP anggota: buka Synteel, pilih "Punya kode undangan?", lalu masukkan kode ini.</span>
        <a class="btn primary" href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noopener noreferrer">
          <Icon name="chat" size={20} /> Bagikan lewat WhatsApp
        </a>
        <button type="button" class="btn secondary" onClick={onClose}>
          Selesai
        </button>
      </div>
    );
  }

  return (
    <div ref={ref} class="box stack" style={{ background: 'var(--soft)', padding: 16 }}>
      <span class="strong">Undang sebagai</span>
      <div class="segmented" role="radiogroup" aria-label="Peran" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', background: 'var(--bg)' }}>
        {(['worker', 'owner'] as const).map((r) => (
          <button type="button" key={r} role="radio" aria-checked={role === r} class={role === r ? 'on' : ''} onClick={() => setRole(r)}>
            {role === r && <Tick />}
            {roleLabel[r]}
          </button>
        ))}
      </div>
      <span class="label ink2">
        {roleLabel[role]} {ROLE_HINT[role]}
      </span>
      {error && <p class="error">{error}</p>}
      <div class="grid2" style={{ gap: 8 }}>
        <button type="button" class="btn secondary" onClick={onClose}>
          Batal
        </button>
        <button type="button" class="btn primary" onClick={create} disabled={busy}>
          Buat kode
        </button>
      </div>
    </div>
  );
}

/** Change one's own PIN: old, new, new again. */
export function ChangePin() {
  const [pin, setPin] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    setDone(false);
    if (pin.length !== 6 || next.length !== 6) return setError('PIN harus 6 angka');
    if (next !== again) return setError('PIN baru dan ulangan tidak sama. Ketik lagi.');
    setBusy(true);
    setError('');
    try {
      await api.changePin(pin, next);
      setPin('');
      setNext('');
      setAgain('');
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <details class="card more">
      <summary>
        <span class="row">
          <span class="icon-box">
            <Icon name="key" />
          </span>
          <span class="stack-xs">
            <span class="strong">Ganti PIN</span>
            <span class="meta">PIN 6 angka untuk masuk</span>
          </span>
        </span>
        <Icon name="down" />
      </summary>
      <form class="stack" style={{ marginTop: 16 }} onSubmit={submit}>
        <Field label="PIN lama">
          <PinInput value={pin} onChange={setPin} />
        </Field>
        <Field label="PIN baru">
          <PinInput value={next} onChange={setNext} autoComplete="new-password" />
        </Field>
        <Field label="Ulangi PIN baru">
          <PinInput value={again} onChange={setAgain} autoComplete="new-password" />
        </Field>
        {error && (
          <p class="error" role="alert">
            {error}
          </p>
        )}
        {done && (
          <p class="note ok" role="status">
            <Icon name="check" size={20} stroke={3} /> PIN sudah diganti. HP lain perlu masuk lagi dengan PIN baru.
          </p>
        )}
        <button class="btn primary" disabled={busy}>
          Simpan PIN baru
        </button>
      </form>
    </details>
  );
}
