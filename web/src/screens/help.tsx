// Contact the Synteel team. Works signed in and signed out (an owner who forgot the PIN has no one
// else to ask). The reply goes out by WhatsApp; the app only sends the request and shows the ticket.
import { useState } from 'preact/hooks';
import { api, type Me, type SupportTopic } from '../api.ts';
import type { Go } from '../app.tsx';
import { Field, fmtPhone, Icon, roleLabel, Soon, Tick } from '../ui.tsx';

const TOPICS: { key: SupportTopic; label: string; hint: string }[] = [
  { key: 'pin', label: 'Masuk dan PIN', hint: 'mis. pemilik lupa PIN dan tidak bisa masuk' },
  { key: 'catat', label: 'Catat dan suara', hint: 'mis. suara di Kolam B tidak terbaca sejak kemarin' },
  { key: 'waspada', label: 'Waspada dan alarm', hint: 'mis. alarm jam 23.30 tidak bunyi' },
  { key: 'jatah', label: 'Jatah AI', hint: 'mis. jatah habis padahal baru dipakai sedikit' },
  { key: 'lain', label: 'Lainnya', hint: 'Ceritakan singkat saja' },
];

/** Set VITE_APP_VERSION at build time to name the release; otherwise the build mode. */
const APP_VERSION: string = import.meta.env.VITE_APP_VERSION ?? import.meta.env.MODE;

/** "Android 14; SM-A145F · Chrome 141 · Synteel production": enough for the team, no full user agent. */
export function deviceInfo(ua = navigator.userAgent): string {
  const os =
    ua.match(/Android [\d.]+(?:; [^;)]+)?/)?.[0] ??
    ua.match(/(?:iPhone|CPU) OS [\d_]+/)?.[0].replace(/_/g, '.').replace('CPU OS', 'iPadOS') ??
    ua.match(/Windows NT [\d.]+|Mac OS X [\d_.]+|Linux/)?.[0].replace(/_/g, '.') ??
    'Perangkat lain';
  const browser = ua.match(/(EdgA?|SamsungBrowser|Firefox|FxiOS|CriOS|Chrome)\/(\d+)/) ?? ua.match(/Version\/(\d+).*(Safari)/);
  const name = browser ? (browser[0].startsWith('Version') ? `Safari ${browser[1]}` : `${browser[1]} ${browser[2]}`) : '';
  return [os, name, `Synteel ${APP_VERSION}`].filter(Boolean).join(' · ');
}

/** "SE-000123": what the team asks for on WhatsApp. */
export const userCode = (id: number) => `SE-${String(id).padStart(6, '0')}`;

export function Help({ me, go }: { me: Me | null; go: Go }) {
  const signedIn = me !== null;
  const [topic, setTopic] = useState<SupportTopic>(signedIn ? 'catat' : 'pin');
  const [message, setMessage] = useState('');
  const [replyPhone, setReplyPhone] = useState(me && !me.demo ? fmtPhone(me.user.phone) : '');
  const [accountPhone, setAccountPhone] = useState('');
  const [withDevice, setWithDevice] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ticket, setTicket] = useState<string | null>(null);

  // Signed in: back to Profil (where Bantuan lives). Signed out: 'today' shows Masuk again.
  const back = () => go({ name: signedIn ? 'profile' : 'today' });
  const backLabel = signedIn ? 'Kembali ke Profil' : 'Kembali ke Masuk';

  const send = async (e: Event) => {
    e.preventDefault();
    if (!message.trim()) return setError('Ceritakan dulu masalahnya.');
    if (replyPhone.replace(/\D/g, '').length < 9) return setError('Isi nomor WhatsApp untuk balasan.');
    if (!signedIn && accountPhone.replace(/\D/g, '').length < 9) return setError('Isi nomor HP akun Synteel.');
    setBusy(true);
    setError('');
    try {
      const res = await api.support({
        topic,
        message: message.trim(),
        replyPhone,
        accountPhone: signedIn ? undefined : accountPhone,
        device: withDevice ? deviceInfo() : undefined,
      });
      setTicket(res.ticket);
      window.scrollTo(0, 0);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const hint = TOPICS.find((t) => t.key === topic)!.hint;

  return (
    <form class="screen" onSubmit={send} style={signedIn ? undefined : { paddingBottom: 48 }}>
      <header class="row">
        <button type="button" class="icon-btn" aria-label="Kembali" onClick={back}>
          <Icon name="back" />
        </button>
        <div class="grow" style={{ display: 'flex', flexDirection: 'column' }}>
          <h1>Hubungi bantuan</h1>
          <span class="meta">Tim Synteel membalas lewat WhatsApp</span>
        </div>
      </header>

      {ticket !== null ? (
        <section class="card">
          <div class="row">
            <span class="icon-box ok">
              <Icon name="check" stroke={2.5} />
            </span>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span class="h2">Pesan terkirim</span>
              <span class="meta num">Nomor tiket #{ticket.replace(/^#/, '')}</span>
            </div>
          </div>
          <p class="ink2">
            Balasan dikirim lewat WhatsApp ke <b class="num" style={{ whiteSpace: 'nowrap' }}>{fmtPhone(replyPhone.replace(/\D/g, ''))}</b>, biasanya dalam{' '}
            <span style={{ whiteSpace: 'nowrap' }}>1×24 jam</span>. Sebut nomor tiket kalau membalas.
          </p>
          <button type="button" class="btn primary" onClick={back}>
            {backLabel}
          </button>
        </section>
      ) : (
        <>
          {signedIn ? (
            <button type="button" class="note bad" style={{ alignItems: 'center' }} onClick={() => go({ name: 'problem' })}>
              <Icon name="alert" />
              <span class="grow">
                Sidat sekarat atau mati sekarang? Jangan tunggu balasan, pakai <b>Ada Masalah</b>.
              </span>
              <Icon name="next" size={20} />
            </button>
          ) : (
            <div class="note bad" style={{ alignItems: 'center' }}>
              <Icon name="alert" />
              <span class="grow">
                Sidat sekarat atau mati sekarang? Jangan tunggu balasan, pakai <b>Ada Masalah</b>.
              </span>
            </div>
          )}

          <section class="stack-sm">
            <span class="strong">Soal apa?</span>
            <div class="chips" role="radiogroup" aria-label="Topik">
              {TOPICS.map((t) => (
                <button type="button" key={t.key} role="radio" aria-checked={topic === t.key} class={`chip${topic === t.key ? ' on' : ''}`} onClick={() => setTopic(t.key)}>
                  {topic === t.key && <Tick />}
                  {t.label}
                </button>
              ))}
            </div>
          </section>

          <section class="card">
            <Field label="Ceritakan masalahnya">
              <textarea rows={4} placeholder={hint} value={message} onInput={(e) => setMessage(e.currentTarget.value)} style={{ resize: 'none' }} />
            </Field>
            {/* No audio upload to support yet: shown so the design stays honest about what is coming. */}
            <button type="button" class="btn secondary" disabled style={{ fontSize: '0.875rem', fontWeight: 800 }}>
              <Icon name="mic" size={20} /> Atau kirim pesan suara <Soon />
            </button>
            <Field label="Nomor WhatsApp untuk balasan">
              <input type="tel" inputMode="tel" autoComplete="tel" placeholder="mis. 0812 3456 7890" value={replyPhone} onInput={(e) => setReplyPhone(e.currentTarget.value)} />
            </Field>
            {me ? (
              <div class="field">
                <span class="field-label">ID pengguna</span>
                <div class="readonly-box">
                  <span class="strong num">{userCode(me.user.id)}</span>
                  <span class="meta">{[me.user.name, me.farm && roleLabel[me.farm.role], me.farm?.name].filter(Boolean).join(' · ')}</span>
                </div>
                <span class="field-hint">Terkirim otomatis supaya tim bisa langsung memeriksa akun.</span>
              </div>
            ) : (
              <Field label="Nomor HP akun Synteel" hint="Untuk lupa PIN pemilik: tim akan memastikan pemilik akun lewat WhatsApp sebelum mengatur ulang PIN.">
                <input type="tel" inputMode="tel" placeholder="Nomor yang dipakai untuk masuk" value={accountPhone} onInput={(e) => setAccountPhone(e.currentTarget.value)} />
              </Field>
            )}
            <button type="button" role="checkbox" aria-checked={withDevice} class="check-row" onClick={() => setWithDevice(!withDevice)}>
              <span class={`check-box${withDevice ? ' on' : ''}`}>{withDevice && <Tick />}</span>
              Sertakan jenis HP dan versi app
            </button>
          </section>

          {error && (
            <p class="error" role="alert">
              {error}
            </p>
          )}
          <button class="btn primary" disabled={busy}>
            {busy ? 'Mengirim…' : 'Kirim'}
          </button>
        </>
      )}
    </form>
  );
}
