import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { api, type QuotaState, type Role } from '../api.ts';
import type { Go } from '../app.tsx';
import { t } from '../i18n.ts';
import { fmtClock } from '../labels.ts';
import { Icon, initialOf, roleLabel, Soon, Tick, type IconName } from '../ui.tsx';
import './quota.css';

/** The remaining-reads bar. Running out is not a Perhatian status, so it is never amber. */
export function QuotaBar({ q, tall }: { q: QuotaState; tall?: boolean }) {
  const pct = q.cap > 0 ? Math.round((q.left / q.cap) * 100) : 0;
  return (
    <span role="img" aria-label={t(`${q.left} dari ${q.cap} bacaan tersisa`, `${q.left} of ${q.cap} ${q.cap === 1 ? 'read' : 'reads'} left`)} class={`progress quota-bar${tall ? ' tall' : ''}`}>
      <span style={{ width: `${pct}%` }} />
    </span>
  );
}

const USES: { label: string; icon: IconName }[] = [
  { label: t('Bicara', 'Speak'), icon: 'mic' },
  { label: t('Foto alat ukur', 'Meter photo'), icon: 'camera' },
  { label: t('Video harian', 'Daily video'), icon: 'video' },
];

// Prices are not decided yet: the packs are shown without them and cannot be bought.
const PACKS = [
  { name: t('+50 bacaan', '+50 reads'), sub: t('Untuk hari sibuk', 'For busy days') },
  { name: t('+200 bacaan', '+200 reads'), sub: t('Untuk beberapa minggu', 'For a few weeks') },
  { name: t('Langganan bulanan', 'Monthly plan'), sub: t('150 bacaan per hari', '150 reads a day') },
];

function Hero({ q }: { q: QuotaState }) {
  if (q.unlimited) {
    return (
      <section class="card">
        <span class="label semi ink2">{t('Sisa hari ini', 'Left today')}</span>
        <h2>{t('Tidak ada batas harian', 'No daily limit')}</h2>
        <span class="ink2">
          {t(
            `Saat ini tambak ini belum punya batas bacaan AI per hari. Dipakai hari ini: ${q.used} bacaan.`,
            `This farm has no daily limit on AI reads right now. Used today: ${q.used} ${q.used === 1 ? 'read' : 'reads'}.`,
          )}
        </span>
      </section>
    );
  }
  const out = q.left === 0;
  const reset = fmtClock(Date.parse(q.resetsAt));
  return (
    <section class={`card quota-hero${out ? ' out' : ''}`} style={{ gap: 12 }}>
      <span class="label semi sub">{t('Sisa hari ini', 'Left today')}</span>
      <span class="row" style={{ alignItems: 'baseline', gap: 8 }}>
        <span class="big">{q.left}</span>
        <span class="sub">{t(`dari ${q.cap} bacaan`, `of ${q.cap} ${q.cap === 1 ? 'read' : 'reads'}`)}</span>
      </span>
      <QuotaBar q={q} tall />
      <span class="label sub">
        {out
          ? t(
              `Habis. Terisi lagi besok jam ${reset}. Rekaman yang dibuat sekarang tetap disimpan dan dibaca setelah jatah ada.`,
              `Used up. Refills tomorrow at ${reset}. Recordings made now are still saved, and read once reads are back.`,
            )
          : t(`Terisi penuh lagi tiap jam ${reset}.`, `Refills in full every day at ${reset}.`)}
      </span>
    </section>
  );
}

/** "✓ Foto sudah" when sent today, "Video belum" when not: a word, not colour alone. */
export function MediaDone({ on, label, short }: { on: boolean; label: string; short?: boolean }) {
  return on ? (
    <span class="word ok">
      <Tick /> {short ? label : t(`${label} sudah`, `${label} done`)}
    </span>
  ) : (
    <span class="word" style={{ color: 'var(--ink-2)' }}>
      {t(`${label} belum`, `${label} not yet`)}
    </span>
  );
}

function EarnRow({ title, children, bonus, earned, onClick }: { title: string; children: ComponentChildren; bonus: number; earned?: boolean; onClick: () => void }) {
  return (
    <button type="button" class="list-row earn-row" onClick={onClick}>
      <span class="grow stack-xs">
        <span class="strong">{title}</span>
        {children}
      </span>
      <span class={`pill ${earned ? 'ok' : 'blue'}`} style={{ fontWeight: 800, gap: 4 }}>
        {earned && <Tick />}+{bonus} {t('bacaan', 'reads')}
      </span>
    </button>
  );
}

export function Quota({ role, go }: { role: Role | null; go: Go }) {
  const [q, setQ] = useState<QuotaState | null>(null);
  const [error, setError] = useState('');
  const owner = role === 'owner';

  const load = () => {
    setError('');
    api.quota().then(setQ, (e) => setError(e.message));
  };
  useEffect(load, []);

  const pv = q?.earn.photoVideo;
  const streak = q?.earn.streak;
  const ask =
    q &&
    t(
      `Jatah baca AI di Synteel hari ini ${q.left === 0 ? 'habis' : `tinggal ${q.left}`}. Mohon ditambah di Synteel › Profil › Jatah baca AI.`,
      `Today's AI reads in Synteel are ${q.left === 0 ? 'used up' : `down to ${q.left}`}. Please add more in Synteel › Profile › Daily AI reads.`,
    );

  return (
    <div class="screen">
      <header class="row">
        <button class="icon-btn" aria-label={t('Kembali ke Profil', 'Back to Profile')} onClick={() => go({ name: 'profile' })}>
          <Icon name="back" />
        </button>
        <div class="stack-xs">
          <h1 style={{ lineHeight: 1.1 }}>{t('Jatah baca AI', 'Daily AI reads')}</h1>
          <span class="meta">{t('Satu jatah untuk semua anggota tambak', 'One allowance for all farm members')}</span>
        </div>
      </header>

      {!q && !error && <p class="muted">{t('Memuat…', 'Loading…')}</p>}
      {error && (
        <div class="stack-sm">
          <p class="error">
            {t('Jatah belum bisa dimuat', 'Reads could not be loaded')}: {error}
          </p>
          <button class="btn secondary" onClick={load}>
            {t('Coba lagi', 'Try again')}
          </button>
        </div>
      )}

      {q && pv && streak && (
        <>
          <Hero q={q} />

          <section class="stack">
            <h2>{t('Satu rekaman = satu bacaan', 'One recording = one read')}</h2>
            <div class="grid3">
              {USES.map((u) => (
                <div key={u.label} class="card" style={{ padding: '12px 8px', borderRadius: 16, gap: 4, alignItems: 'center', textAlign: 'center' }}>
                  <span style={{ color: 'var(--accent)', display: 'flex' }}>
                    <Icon name={u.icon} />
                  </span>
                  <span class="label semi" style={{ lineHeight: 1.25 }}>
                    {u.label}
                  </span>
                </div>
              ))}
            </div>
            <div class="note ok">
              <Icon name="check" size={20} stroke={2.5} />
              <span>
                <b style={{ fontWeight: 800 }}>{t('Tidak memakai jatah:', 'Does not use reads:')}</b>{' '}
                {t(
                  'laporan darurat dan hitung sidat mati, ketik sendiri, ringkasan malam, Waspada, dan bicara di Hubungi bantuan.',
                  'emergency reports and dead-eel counts, Type it in, Night summary, Watch, and speaking in Contact support.',
                )}
              </span>
            </div>
          </section>

          <section class="stack">
            <h2>{t('Tambah gratis', 'Get more for free')}</h2>
            <div class="card list">
              <EarnRow title={t('1 foto + 1 video kolam hari ini', '1 pond photo + 1 pond video today')} bonus={pv.bonus} earned={pv.earned} onClick={() => go({ name: 'record' })}>
                <span class="row label" style={{ gap: 12 }}>
                  <MediaDone on={pv.photo} label={t('Foto', 'Photo')} short />
                  <MediaDone on={pv.video} label="Video" short />
                </span>
              </EarnRow>
              <EarnRow title={t('Mencatat 7 hari beruntun', 'Record 7 days in a row')} bonus={streak.bonus} onClick={() => go({ name: 'rewards' })}>
                <span class="label ink2 num">
                  {t(`Sekarang ${streak.days} hari beruntun`, `Now ${streak.days} ${streak.days === 1 ? 'day' : 'days'} in a row`)}
                  <br />
                  {t(`Berikutnya di hari ke-${streak.nextAt}`, `Next at day ${streak.nextAt}`)}
                </span>
              </EarnRow>
            </div>
          </section>

          {owner && (
            <section class="card" style={{ gap: 12 }}>
              <div class="row between">
                <h2>{t('Beli jatah tambahan', 'Buy extra reads')}</h2>
                <Soon />
              </div>
              <span class="label ink2">{t('Harga paket diumumkan nanti.', 'Pack prices will be announced later.')}</span>
              <ul class="packs" aria-label={t('Paket yang disiapkan', 'Packs in the works')}>
                {PACKS.map((p) => (
                  <li key={p.name}>
                    <span class="semi">{p.name}</span>
                    <span class="label ink2">{p.sub}</span>
                  </li>
                ))}
              </ul>
              <span class="label ink2">{t('Jatah tambahan dipakai setelah jatah harian habis dan berlaku 30 hari.', 'Extra reads are used after the daily reads run out, and last 30 days.')}</span>
            </section>
          )}

          {owner && q.members.length > 0 && (
            <section class="stack">
              <h2>{t('Dipakai hari ini', 'Used today')}</h2>
              <div class="card list">
                {q.members.map((m) => (
                  <div key={m.userId} class="list-row" style={{ minHeight: 64, padding: '12px 0' }}>
                    <span class="avatar sm-avatar" aria-hidden="true">
                      {initialOf(m.name)}
                    </span>
                    <span class="grow stack-xs" style={{ gap: 0 }}>
                      <span class="semi">{m.name}</span>
                      <span class="meta">{roleLabel[m.role]}</span>
                    </span>
                    <span class="strong num">{t(`${m.used} bacaan`, `${m.used} ${m.used === 1 ? 'read' : 'reads'}`)}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {!owner && (
            <section class="card">
              <h2>{t('Butuh jatah lebih?', 'Need more reads?')}</h2>
              <p class="ink2">{t('Hanya pemilik tambak yang bisa membeli jatah tambahan.', 'Only the farm owner can buy extra reads.')}</p>
              <a class="btn primary" href={`https://wa.me/?text=${encodeURIComponent(ask ?? '')}`} target="_blank" rel="noopener">
                <Icon name="chat" size={20} /> {t('Minta pemilik lewat WhatsApp', 'Ask the owner on WhatsApp')}
              </a>
            </section>
          )}
        </>
      )}
    </div>
  );
}
