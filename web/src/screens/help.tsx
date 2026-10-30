// Contact the Synteel team. Works signed in and signed out (an owner who forgot the PIN has no one
// else to ask). The reply goes out by WhatsApp; the app only sends the request and shows the ticket.
import { useState } from 'preact/hooks';
import { api, type Me, type SupportTopic } from '../api.ts';
import type { Go } from '../app.tsx';
import { isEn, t } from '../i18n.ts';
import { Field, fmtPhone, Icon, roleLabel, Tick } from '../ui.tsx';
import { canRecordAudio, startRecording, voiceToWav } from '../capture/media.ts';
import './help.css';

const TOPICS: { key: SupportTopic; label: string; hint: string }[] = [
  { key: 'pin', label: t('Masuk dan PIN', 'Sign in and PIN'), hint: t('contoh: pemilik lupa PIN dan tidak bisa masuk', 'example: the owner forgot the PIN and cannot sign in') },
  { key: 'catat', label: t('Catat dan suara', 'Recording and voice'), hint: t('contoh: suara di Kolam B tidak terbaca sejak kemarin', 'example: voice for Kolam B not understood since yesterday') },
  { key: 'waspada', label: t('Waspada dan alarm', 'Watch and alarm'), hint: t('contoh: alarm jam 23.30 tidak bunyi', 'example: the 23:30 alarm did not ring') },
  { key: 'jatah', label: t('Jatah AI', 'AI reads'), hint: t('contoh: jatah habis padahal baru dipakai sedikit', 'example: reads ran out after only a little use') },
  { key: 'lain', label: t('Lainnya', 'Other'), hint: t('Ceritakan singkat saja', 'Keep it short') },
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

/**
 * Say the message instead of typing it (also used for answers in a dead-eel case): the recording is turned into text in the box, which the
 * farmer can read and fix before sending. Only text is sent to the team, never the audio.
 */
export function SpeakToText({ onText, hint }: { onText: (text: string) => void; hint?: string }) {
  const [rec, setRec] = useState<{ stop: () => Promise<Blob> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [heard, setHeard] = useState(false);
  if (!canRecordAudio()) return null;

  const start = async () => {
    setNote('');
    setHeard(false);
    try {
      setRec(await startRecording(60));
    } catch {
      setNote(t('Mikrofon belum diizinkan. Ketik saja dulu.', 'The microphone is not allowed yet. Type it in for now.'));
    }
  };
  const stop = async () => {
    if (!rec) return;
    const audio = await rec.stop();
    setRec(null);
    setBusy(true);
    try {
      const { text } = await api.transcribe(await voiceToWav(audio, 60));
      if (text) onText(text);
      setHeard(!!text);
      setNote(text ? '' : t('Suara belum terbaca. Coba lagi lebih dekat, atau ketik saja.', 'The voice was not understood. Try again closer, or type it in.'));
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="stack-xs" style={{ gap: 8 }}>
      <button type="button" class={`btn speak${rec ? ' rec' : ''}`} aria-pressed={!!rec} disabled={busy} onClick={rec ? stop : start}>
        {rec ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M7 7h10v10H7z" />
          </svg>
        ) : (
          <Icon name="mic" size={20} />
        )}
        {busy ? t('Mengubah suara jadi teks…', 'Turning voice into text…') : rec ? t('Merekam… ketuk untuk selesai', 'Recording… tap to finish') : t('Bicara, nanti jadi teks', 'Speak, it becomes text')}
      </button>
      {heard && !rec ? (
        <p role="status" class="note info">
          <Icon name="check" size={18} stroke={2.5} />
          {t('Sudah jadi teks di atas. Periksa dulu sebelum kirim.', 'It is now text above. Check it before sending.')}
        </p>
      ) : (
        <span class="label ink2">{note || hint || t('Yang terkirim hanya teksnya. Tidak memakai jatah baca AI.', 'Only the text is sent. It does not use your daily AI reads.')}</span>
      )}
    </div>
  );
}

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
  const backLabel = signedIn ? t('Kembali ke Profil', 'Back to Profile') : t('Kembali ke Masuk', 'Back to Sign in');

  const send = async (e: Event) => {
    e.preventDefault();
    if (!message.trim()) return setError(t('Ceritakan dulu masalahnya.', 'Describe the problem first.'));
    if (replyPhone.replace(/\D/g, '').length < 9) return setError(t('Isi nomor WhatsApp untuk balasan.', 'Enter a WhatsApp number for the reply.'));
    if (!signedIn && accountPhone.replace(/\D/g, '').length < 9) return setError(t('Isi nomor HP akun Synteel.', 'Enter the phone number of the Synteel account.'));
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

  const hint = TOPICS.find((tp) => tp.key === topic)!.hint;

  return (
    <form class="screen" onSubmit={send} style={signedIn ? undefined : { paddingBottom: 48 }}>
      <header class="row">
        <button type="button" class="icon-btn" aria-label={t('Kembali', 'Back')} onClick={back}>
          <Icon name="back" />
        </button>
        <div class="grow" style={{ display: 'flex', flexDirection: 'column' }}>
          <h1>{t('Hubungi bantuan', 'Contact support')}</h1>
          <span class="meta">{t('Tim Synteel membalas lewat WhatsApp', 'The Synteel team replies on WhatsApp')}</span>
        </div>
      </header>

      {ticket !== null ? (
        <section class="card">
          <div class="row">
            <span class="icon-box ok">
              <Icon name="check" stroke={2.5} />
            </span>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span class="h2">{t('Pesan terkirim', 'Message sent')}</span>
              <span class="meta num">
                {t('Nomor tiket', 'Ticket number')} #{ticket.replace(/^#/, '')}
              </span>
            </div>
          </div>
          {isEn ? (
            <p class="ink2">
              The reply comes on WhatsApp to <b class="num" style={{ whiteSpace: 'nowrap' }}>{fmtPhone(replyPhone.replace(/\D/g, ''))}</b>, usually within{' '}
              <span style={{ whiteSpace: 'nowrap' }}>24 hours</span>. Mention the ticket number when you reply.
            </p>
          ) : (
            <p class="ink2">
              Balasan dikirim lewat WhatsApp ke <b class="num" style={{ whiteSpace: 'nowrap' }}>{fmtPhone(replyPhone.replace(/\D/g, ''))}</b>, biasanya dalam{' '}
              <span style={{ whiteSpace: 'nowrap' }}>1×24 jam</span>. Sebut nomor tiket kalau membalas.
            </p>
          )}
          <button type="button" class="btn primary" onClick={back}>
            {backLabel}
          </button>
        </section>
      ) : (
        <>
          <div class="note bad emergency-line">
            <Icon name="siren" size={20} />
            <span class="grow">
              {t('Sidat sekarat atau mati sekarang? Jangan tunggu balasan, pakai', 'Eels dying or dead right now? Do not wait for a reply, use')}{' '}
              {signedIn ? (
                <button type="button" class="tab-link" onClick={() => go({ name: 'problem' })}>
                  {t('tab Masalah', 'the Problem tab')}
                </button>
              ) : (
                <b>{t('tab Masalah', 'the Problem tab')}</b>
              )}
              .
            </span>
          </div>

          <section class="stack-sm">
            <span class="strong">{t('Soal apa?', 'What is it about?')}</span>
            <div class="chips" role="radiogroup" aria-label={t('Topik', 'Topic')}>
              {TOPICS.map((tp) => (
                <button type="button" key={tp.key} role="radio" aria-checked={topic === tp.key} class={`chip${topic === tp.key ? ' on' : ''}`} onClick={() => setTopic(tp.key)}>
                  {topic === tp.key && <Tick />}
                  {tp.label}
                </button>
              ))}
            </div>
          </section>

          <section class="card">
            <Field label={t('Ceritakan masalahnya', 'Describe the problem')}>
              <textarea rows={4} placeholder={hint} value={message} onInput={(e) => setMessage(e.currentTarget.value)} style={{ resize: 'none' }} />
            </Field>
            {signedIn && <SpeakToText onText={(text) => setMessage((m) => (m.trim() ? `${m.trim()} ${text}` : text))} />}
            <Field label={t('Nomor WhatsApp untuk balasan', 'WhatsApp number for the reply')}>
              <input type="tel" inputMode="tel" autoComplete="tel" placeholder={t('contoh: 0812 3456 7890', 'example: 0812 3456 7890')} value={replyPhone} onInput={(e) => setReplyPhone(e.currentTarget.value)} />
            </Field>
            {me ? (
              <div class="field">
                <span class="field-label">{t('ID pengguna', 'User ID')}</span>
                <div class="readonly-box">
                  <span class="strong num">{userCode(me.user.id)}</span>
                  <span class="meta">{[me.user.name, me.farm && roleLabel[me.farm.role], me.farm?.name].filter(Boolean).join(' · ')}</span>
                </div>
                <span class="field-hint">{t('Terkirim otomatis supaya tim bisa langsung memeriksa akun.', 'Sent automatically so the team can check the account right away.')}</span>
              </div>
            ) : (
              <Field
                label={t('Nomor HP akun Synteel', 'Phone number of the Synteel account')}
                hint={t(
                  'Untuk lupa PIN pemilik: tim akan memastikan pemilik akun lewat WhatsApp sebelum mengatur ulang PIN.',
                  'For a forgotten owner PIN: the team confirms the account owner on WhatsApp before resetting the PIN.',
                )}
              >
                <input type="tel" inputMode="tel" placeholder={t('Nomor yang dipakai untuk masuk', 'The number you sign in with')} value={accountPhone} onInput={(e) => setAccountPhone(e.currentTarget.value)} />
              </Field>
            )}
            <button type="button" role="checkbox" aria-checked={withDevice} class="check-row" onClick={() => setWithDevice(!withDevice)}>
              <span class={`check-box${withDevice ? ' on' : ''}`}>{withDevice && <Tick />}</span>
              {t('Sertakan jenis HP dan versi aplikasi', 'Include phone model and app version')}
            </button>
          </section>

          {error && (
            <p class="error" role="alert">
              {error}
            </p>
          )}
          <button class="btn primary" disabled={busy}>
            {busy ? t('Mengirim…', 'Sending…') : t('Kirim', 'Send')}
          </button>
        </>
      )}
    </form>
  );
}
