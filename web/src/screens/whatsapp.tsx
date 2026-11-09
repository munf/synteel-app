// Profil → WhatsApp: the farmer's own number, its check by code, the opt-in "Kirim langkah lewat WhatsApp",
// which messages, and the consent. Sending happens on the server (server/src/whatsapp.ts); without the
// WhatsApp Cloud API on the server only the Problem flow's button works, by opening WhatsApp on this phone.
// The phone alarm stays the main signal: WhatsApp is an extra channel.
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { api, type WaKind, type WaView } from '../api.ts';
import { fmtClock } from '../labels.ts';
import { LOCALE, t } from '../i18n.ts';
import { Field, Icon, Switch, Tick } from '../ui.tsx';

const KINDS: { id: WaKind; label: string; sub: string; push: boolean }[] = [
  { id: 'steps', label: t('Langkah saat ada masalah', 'Steps when there is a problem'), sub: t('Dari layar Ada masalah', 'From the Problem screen'), push: false },
  { id: 'night', label: t('Rencana cek malam', "Tonight's check plan"), sub: t('Jam cek dan kolamnya, sekitar pukul 17.00', 'Check times and ponds, around 17:00'), push: true },
  { id: 'alarm', label: t('Ringkasan tanda bahaya', 'Danger sign summary'), sub: t('Saat aturan melihat bahaya di kolam', 'When the rules see danger in a pond'), push: true },
];

const KIND_NAME: Record<WaKind | 'code', string> = {
  steps: t('Langkah', 'Steps'),
  night: t('Rencana malam', 'Night plan'),
  alarm: t('Tanda bahaya', 'Danger sign'),
  code: t('Kode', 'Code'),
};
const STATUS_NAME = { sent: t('terkirim', 'sent'), link: t('dibuka di WhatsApp', 'opened in WhatsApp'), failed: t('gagal terkirim', 'not delivered') };

/** "6281234567890" → "081234567890", the way farmers write their number. */
const localNumber = (p: string | null) => (p ? (p.startsWith('62') ? `0${p.slice(2)}` : p) : '');

function Check({ on, onChange, disabled, children }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; children: ComponentChildren }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} aria-disabled={disabled} class="check-row wa-check" disabled={disabled} onClick={() => onChange(!on)}>
      <span class={`check-box${on ? ' on' : ''}`}>{on && <Tick />}</span>
      <span class="grow stack-xs" style={{ gap: 0 }}>
        {children}
      </span>
    </button>
  );
}

export function WhatsAppCard() {
  const [v, setV] = useState<WaView | null>(null);
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [kinds, setKinds] = useState<WaKind[]>([]);
  const [consent, setConsent] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const take = (w: WaView) => {
    setV(w);
    setPhone(localNumber(w.phone));
    setKinds(w.kinds);
    setConsent(w.consented);
  };
  useEffect(() => {
    api.whatsapp().then(take, () => {});
  }, []);
  if (!v) return null;

  const run = async (fn: () => Promise<WaView>, after?: () => void) => {
    setBusy(true);
    setError('');
    try {
      take(await fn());
      after?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // Without the Cloud API only the steps can go (by the farmer's tap): the other two stay off until it is there.
  const chosen = kinds.filter((k) => v.push || !KINDS.find((x) => x.id === k)!.push);
  const turnOff = () => run(() => api.saveWhatsapp({ optIn: false }), () => setOpen(false));
  const save = (e: Event) => {
    e.preventDefault();
    run(() => api.saveWhatsapp({ phone, kinds: chosen, optIn: true, ...(consent && !v.consented && { consent: true }) }), () => setOpen(false));
  };
  const sendCode = () => run(() => api.whatsappCode(phone), () => setCodeSent(true));
  const verify = () =>
    run(
      () => api.verifyWhatsapp(code),
      () => {
        setCodeSent(false);
        setCode('');
      },
    );
  const editing = open;
  const cancel = () => {
    take(v);
    setOpen(false);
    setError('');
  };
  const last = v.sends.find((s) => s.kind !== 'code');

  return (
    <section class="card wa-card" id="whatsapp" aria-labelledby="wa-title">
      <div class="row top" style={{ gap: 12 }}>
        <span class="icon-box">
          <Icon name="chat" />
        </span>
        <div class="grow stack-xs">
          <span class="strong" id="wa-title">
            {t('Kirim langkah lewat WhatsApp', 'Send steps on WhatsApp')}
          </span>
          {v.optIn ? (
            <span class="label ink2 num">
              {localNumber(v.phone)}
              {/* With the Cloud API the line below says verified or not; with the link the farmer sends it. */}
              {!v.push && <span style={{ display: 'block' }}>{t('Dikirim sendiri dari HP ini', 'Sent by hand from this phone')}</span>}
            </span>
          ) : (
            <span class="label ink2">{t('Langkah dan pengingat ke nomor WhatsApp sendiri. Alarm di HP tetap yang utama.', 'Steps and reminders to your own WhatsApp number. The phone alarm still comes first.')}</span>
          )}
        </div>
        <Switch checked={v.optIn || open} label={t('Kirim langkah lewat WhatsApp', 'Send steps on WhatsApp')} disabled={busy} onChange={(on) => (on ? setOpen(true) : v.optIn ? turnOff() : setOpen(false))} />
      </div>

      {v.optIn && !editing && (
        <div class="stack-sm">
          {v.verified && (
            <span class="row semi wa-ok" style={{ gap: 8 }}>
              <Tick /> {t('Nomor sudah dicek dengan kode', 'Number checked with a code')}
            </span>
          )}
          {v.push && !v.verified && (
            <div class="stack-sm wa-verify">
              <span class="row semi" style={{ gap: 8 }}>
                <Icon name="info" size={20} /> {t('Belum diverifikasi', 'Not verified yet')}
              </span>
              {codeSent ? (
                <>
                  <Field label={t('Kode dari WhatsApp', 'Code from WhatsApp')} hint={t('6 angka, berlaku 10 menit.', '6 digits, valid for 10 minutes.')}>
                    <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onInput={(e) => setCode(e.currentTarget.value)} />
                  </Field>
                  <button type="button" class="btn primary" disabled={busy || code.replace(/\D/g, '').length !== 6} onClick={verify}>
                    {t('Cek kode', 'Check the code')}
                  </button>
                </>
              ) : (
                <button type="button" class="btn secondary" disabled={busy} onClick={sendCode}>
                  <Icon name="chat" size={20} /> {t('Kirim kode ke WhatsApp', 'Send a code to WhatsApp')}
                </button>
              )}
            </div>
          )}
          {last && (
            <span class="label ink2 num">
              {t('Terakhir', 'Last')}: {KIND_NAME[last.kind]}, {STATUS_NAME[last.status]}, {new Date(last.at).toLocaleDateString(LOCALE, { day: 'numeric', month: 'long', timeZone: 'Asia/Jakarta' })} {fmtClock(Date.parse(last.at))}
            </span>
          )}
          <button type="button" class="btn secondary" onClick={() => setOpen(true)}>
            {t('Ubah nomor atau pesan', 'Change number or messages')}
          </button>
        </div>
      )}

      {editing && (
        <form class="stack" onSubmit={save}>
          <Field label={t('Nomor WhatsApp', 'WhatsApp number')} hint={t('Nomor yang memakai WhatsApp, boleh beda dengan nomor masuk.', 'A number that has WhatsApp; it can differ from the sign-in number.')}>
            <input type="tel" inputMode="tel" autoComplete="tel" placeholder={t('contoh: 081234567890', 'example: 081234567890')} value={phone} onInput={(e) => setPhone(e.currentTarget.value)} />
          </Field>

          {!v.push && (
            <p class="note info">
              <Icon name="info" size={20} />
              <span class="grow">
                {t(
                  'Kirim otomatis belum aktif di server ini. Tombol di layar Ada masalah membuka WhatsApp dengan langkah yang sudah terisi.',
                  'Automatic sending is not on for this server yet. The button on the Problem screen opens WhatsApp with the steps filled in.',
                )}
              </span>
            </p>
          )}

          <div class="stack-xs">
            <span class="field-label">{t('Pesan yang dikirim', 'Messages to send')}</span>
            {KINDS.map((k) => {
              const off = k.push && !v.push;
              return (
                <Check key={k.id} on={!off && kinds.includes(k.id)} disabled={off} onChange={(on) => setKinds(on ? [...kinds, k.id] : kinds.filter((x) => x !== k.id))}>
                  <span class="semi" style={{ color: 'var(--ink)' }}>
                    {k.label}
                  </span>
                  <span class="label ink2">{off ? t('Belum aktif di server ini', 'Not on for this server yet') : k.sub}</span>
                </Check>
              );
            })}
          </div>

          <Check on={consent} onChange={setConsent} disabled={v.consented}>
            <span class="label ink2">
              {t(
                'Setuju nomor WhatsApp ini dan isi pesan di atas dikirim lewat WhatsApp, layanan milik Meta. Isi pesan tidak disimpan Synteel. Bisa dimatikan kapan saja di sini.',
                'Agree that this WhatsApp number and the messages above go through WhatsApp, a Meta service. Synteel does not keep the message text. It can be turned off here at any time.',
              )}
            </span>
          </Check>

          <div class="grid2" style={{ gap: 8 }}>
            <button type="button" class="btn secondary" disabled={busy} onClick={cancel}>
              {t('Batal', 'Cancel')}
            </button>
            <button class="btn primary" disabled={busy || !phone.trim() || !consent || chosen.length === 0}>
              {t('Simpan', 'Save')}
            </button>
          </div>
        </form>
      )}
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
