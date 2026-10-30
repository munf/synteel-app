import type { ComponentChild } from 'preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { api, type Farm, type FarmState, type Me, type QuotaState } from '../api.ts';
import type { Go } from '../app.tsx';
import { askNotifyPermission } from '../alarms.ts';
import { setPrefs, usePrefs, type Prefs, type Theme } from '../prefs.ts';
import { isEn, lang, LOCALE, setLang, t, type Lang, siteInAppLanguage } from '../i18n.ts';
import { Field, Icon, initialOf, roleLabel, Shape, Soon, Switch, Tick, Glyph, GLYPH } from '../ui.tsx';
import { ChangePin, Members } from './members.tsx';
import { MediaDone, QuotaBar } from './quota.tsx';
import { LocateButton, useLocate } from './setup.tsx';
import './profile.css';
import { JoinByCode } from '../join.tsx';

/** A tappable white row: icon, title and one line under it, chevron. */
function LinkCard({ icon, title, sub, onClick, children }: { icon: ComponentChildren; title: string; sub: ComponentChildren; onClick: () => void; children?: ComponentChildren }) {
  return (
    <button type="button" class="card" style={{ border: 0, textAlign: 'left', gap: 12, color: 'inherit' }} onClick={onClick}>
      <span class="row" style={{ width: '100%' }}>
        <span class="icon-box">{icon}</span>
        <span class="grow stack-xs" style={{ gap: 0 }}>
          <span class="strong">{title}</span>
          <span class="meta num">{sub}</span>
        </span>
        <Icon name="next" />
      </span>
      {children}
    </button>
  );
}

/** Remaining AI reads today, with a bar; opens the quota page. */
function QuotaRow({ go }: { go: Go }) {
  const [q, setQ] = useState<QuotaState | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api.quota().then(setQ, () => setFailed(true));
  }, []);
  const sub = q
    ? q.unlimited
      ? t('Tidak ada batas harian saat ini', 'No daily limit right now')
      : t(`${q.left} dari ${q.cap} bacaan tersisa hari ini`, `${q.left} of ${q.cap} ${q.cap === 1 ? 'read' : 'reads'} left today`)
    : failed
      ? t('Lihat sisa hari ini', 'See what is left today')
      : t('Memuat…', 'Loading…');
  return (
    <LinkCard icon={<Icon name="sparkle" />} title={t('Jatah baca AI', 'Daily AI reads')} sub={sub} onClick={() => go({ name: 'quota' })}>
      {q && !q.unlimited && <QuotaBar q={q} />}
    </LinkCard>
  );
}

/** Owner only: the place name the weather (and the water temperature estimate) is looked up for. */
function FarmLocation({ farm, onSaved }: { farm: Farm; onSaved: (f: Farm) => void }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState(farm.locationName ?? '');
  const gps = useLocate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState(false);

  const save = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      // Without GPS the server looks the place name up; lat/lon are left out so it does.
      const { farm: saved } = await api.saveFarm({ name: farm.name, timezone: farm.timezone, locationName: place.trim(), ...gps.coords });
      onSaved(saved);
      setNotFound(saved.lat === null);
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <LinkCard
        icon={<Icon name="home" />}
        title={t('Lokasi tambak', 'Farm location')}
        sub={farm.locationName ? farm.locationName : farm.lat !== null ? t('Titik lokasi HP', 'Phone location') : t('Belum diatur. Dipakai untuk cuaca per jam.', 'Not set. Used for the hourly weather.')}
        onClick={() => setOpen(true)}
      >
        {notFound && (
          <span class="note info" style={{ width: '100%' }}>
            <Icon name="info" size={20} />{' '}
            {t(
              'Tempat ini belum ditemukan di peta, jadi cuaca belum bisa dihitung. Tulis nama kecamatan dan kabupaten, atau pakai lokasi HP.',
              'This place was not found on the map, so the weather cannot be worked out yet. Write the district and regency, or use the phone location.',
            )}
          </span>
        )}
      </LinkCard>
    );
  }
  return (
    <form class="card" id="lokasi" onSubmit={save}>
      <Field label={t('Lokasi tambak', 'Farm location')} hint={t('Dipakai untuk cuaca per jam, supaya suhu air bisa diperkirakan.', 'Used for the hourly weather, so the water temperature can be estimated.')}>
        <input value={place} onInput={(e) => setPlace(e.currentTarget.value)} placeholder={t('contoh: Sleman, Yogyakarta', 'example: Sleman, Yogyakarta')} />
      </Field>
      <LocateButton gps={gps} />
      {(error || gps.error) && <p class="error">{error || gps.error}</p>}
      <div class="grid2" style={{ gap: 8 }}>
        <button type="button" class="btn secondary" onClick={() => setOpen(false)}>
          {t('Batal', 'Cancel')}
        </button>
        <button class="btn primary" disabled={busy || (!place.trim() && !gps.coords)}>
          {t('Simpan', 'Save')}
        </button>
      </div>
    </form>
  );
}

const DAY_LONG = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

/** The last seven days, oldest first, marked done when they fall inside the current streak. */
function week(streak: number, todayLogged: boolean) {
  const today = new Date();
  return Array.from({ length: 7 }, (_, i) => {
    const back = 6 - i;
    const d = new Date(today.getTime() - back * 86400_000);
    // A streak that has no reading today yet ends yesterday.
    const done = todayLogged ? back < streak : back >= 1 && back <= streak;
    const date = d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'long' });
    const day = lang === 'en' ? d.toLocaleDateString(LOCALE, { weekday: 'long' }) : DAY_LONG[d.getDay()];
    const status = done ? t('sudah mencatat', 'recorded') : back === 0 ? t('hari ini, belum mencatat', 'today, not recorded yet') : t('belum mencatat', 'not recorded');
    return { label: String(d.getDate()), aria: `${day} ${date}, ${status}`, done, today: back === 0 };
  });
}

const loggedToday = (state: FarmState) =>
  state.ponds.some((p) => Object.values(p.latest).some((r) => r && new Date(r.at).toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' }) === state.today));

/** Seven circles for the last seven days, labelled with the date (22 … 28), ticked when recorded. Used on Profil and Hadiah. */
function StreakDays({ state }: { state: FarmState }) {
  const days = week(state.streak, loggedToday(state));
  return (
    <div role="list" aria-label={t('7 hari terakhir', 'Last 7 days')} style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 4 }}>
      {days.map((d, i) => (
        <span key={i} role="img" aria-label={d.aria} class="stack-xs" style={{ alignItems: 'center' }}>
          <span
            style={{
              width: 28,
              height: 28,
              borderRadius: 14,
              boxSizing: 'border-box',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--streak-ink)',
              background: d.done ? 'var(--streak)' : 'transparent',
              border: d.done ? 'none' : d.today ? '2px dashed #6e6e73' : '2px solid var(--hero-ring)',
            }}
          >
            {d.done && <Tick size={14} />}
          </span>
          <span class="label num" aria-hidden="true" style={{ color: '#b3b3b8' }}>
            {d.label}
          </span>
        </span>
      ))}
    </div>
  );
}

/** Everything that does not exist yet, in one quiet group with one "Belum tersedia" chip. */
function LaterList({ title, items }: { title: string; items: { label: string; sub: string }[] }) {
  return (
    <section class="card later" aria-label={t('Belum tersedia', 'Not available yet')}>
      <div class="row between" style={{ paddingBottom: 8 }}>
        <h2 class="later-title">{title}</h2>
        <Soon />
      </div>
      {items.map((l) => (
        <div key={l.label} class="later-row">
          <span class="semi">{l.label}</span>
          <span class="label ink2">{l.sub}</span>
        </div>
      ))}
    </section>
  );
}

// Rows in "Alat Synteel" match the switch rows above: 72px tall, divided, ink text.
const ALAT_ROW = { color: 'var(--ink)', minHeight: 72, padding: '12px 0', gap: 12 };

export function Profile({
  state,
  me,
  go,
  invite = false,
  onSwitch,
  onLogout,
  onFarmChanged,
  onJoined,
}: {
  state: FarmState;
  me: Me;
  go: Go;
  /** Opened from "Undang anggota": start with the invite form open. */
  invite?: boolean;
  onSwitch: (farmId: number) => Promise<void>;
  onLogout: () => void;
  /** After the owner changes the farm location: refresh the weather. */
  onFarmChanged?: () => void;
  /** Joined another farm with an invite code. */
  onJoined?: (m: Me) => void;
}) {
  const prefs = usePrefs();
  const owner = state.role === 'owner';
  const [inviteOpen, setInviteOpen] = useState(invite && owner);
  const [switching, setSwitching] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [leaving, setLeaving] = useState(false);
  // The location just saved here, until the app's farm state catches up.
  const [farm, setFarm] = useState(state.farm);

  const switchTo = async (farmId: number) => {
    setSwitching(farmId);
    setError('');
    try {
      await onSwitch(farmId);
    } catch (err) {
      setError((err as Error).message);
      setSwitching(null);
    }
  };
  const logout = async () => {
    setLeaving(true);
    // Signed out on the server or not, this phone forgets the session either way.
    await api.logout().catch(() => {});
    onLogout();
  };
  const toggles: { label: string; sub: string; checked: boolean; onChange: (v: boolean) => void }[] = [
    // The alarm rings in the app whenever a night check is due; the tap also lets the phone show it and play sound.
    { label: t('Alarm cek malam', 'Night check alarm'), sub: t('Berbunyi selama aplikasi terbuka', 'Rings while the app is open'), checked: prefs.alarms, onChange: (v) => { setPrefs({ alarms: v }); if (v) void askNotifyPermission(); } },
    { label: t('Detail teknis terbuka', 'Show technical details'), sub: t('Grafik dan angka langsung tampil', 'Charts and numbers show right away'), checked: prefs.techOpen, onChange: (v) => setPrefs({ techOpen: v }) },
  ];
  // On the type scale: the "Aa" sample grows 16 → 18 → 24.
  const sizes: { label: string; px: number }[] = [
    { label: 'Normal', px: 16 },
    { label: t('Besar', 'Large'), px: 18 },
    { label: t('Sangat besar', 'Very large'), px: 24 },
  ];
  // Language names are never translated.
  const themes: { id: Theme; label: string; icon: ComponentChild }[] = [
    { id: 'light', label: t('Terang', 'Light'), icon: <Icon name="sun" size={20} /> },
    { id: 'dark', label: t('Gelap', 'Dark'), icon: <Icon name="moon" size={20} /> },
    { id: 'system', label: t('Ikuti HP', 'Like phone'), icon: <Glyph d={GLYPH.mobile} size={20} /> },
  ];
  const langs: { id: Lang; label: string }[] = [
    { id: 'id', label: 'Bahasa Indonesia' },
    { id: 'en', label: 'English' },
  ];
  const later = [
    { label: t('Telepon penyuluh', 'Call an extension officer'), sub: t('Penyuluh perikanan', 'Fisheries extension officer') },
    { label: t('Laporan mingguan', 'Weekly report'), sub: t('Ringkasan mati, suhu dan pakan seminggu', 'A week of deaths, temperature and feed') },
    { label: t('Teruskan alarm ke pemilik', 'Forward alarms to the owner'), sub: t('Kalau alarm cek malam tidak dijawab', 'If the night check alarm is not answered') },
    { label: t('Lihat atau hapus data', 'View or delete data'), sub: t('Data yang dipakai melatih AI', 'Data used to train the AI') },
  ];

  return (
    <div class="screen profile">
      <header class="row between">
        <button class="icon-btn" aria-label={t('Kembali ke Beranda', 'Back to Home')} onClick={() => go({ name: 'today' })}>
          <Icon name="back" />
        </button>
      </header>

      <section class="hero" style={{ gap: 16 }}>
        <div class="row" style={{ gap: 16 }}>
          <span class="avatar lg">{initialOf(me.user.name)}</span>
          <div class="stack-xs" style={{ minWidth: 0 }}>
            <span class="title" style={{ lineHeight: 1.1, overflowWrap: 'anywhere' }}>
              {t('Halo', 'Hello')}, {me.user.name}
            </span>
            <span class="semi" style={{ color: '#fff' }}>
              {farm?.name}
            </span>
            <span class="label" style={{ color: 'var(--on-hero-soft)' }}>
              {[state.role && roleLabel[state.role], farm?.locationName ?? t('Lokasi belum diatur', 'Location not set')].filter(Boolean).join(' · ')}
            </span>
          </div>
        </div>
        <div class="stack-sm" style={{ background: 'rgba(255,255,255,0.08)', borderRadius: 16, padding: 16 }}>
          <div class="row between" style={{ alignItems: 'baseline' }}>
            <span class="strong num">{t(`${state.streak} hari beruntun`, `${state.streak} ${state.streak === 1 ? 'day' : 'days'} in a row`)}</span>
            <span class="label" style={{ color: '#b3b3b8', whiteSpace: 'nowrap' }}>
              {t('7 hari terakhir', 'Last 7 days')}
            </span>
          </div>
          <StreakDays state={state} />
        </div>
        <button class="btn light" style={{ justifyContent: 'space-between', paddingLeft: 16, paddingRight: 8 }} onClick={() => go({ name: 'rewards' })}>
          <span class="row" style={{ gap: 12 }}>
            <span style={{ color: 'var(--streak)', display: 'flex' }}>
              <Icon name="gift" />
            </span>
            {t('Lihat hadiah', 'View rewards')}
          </span>
          <span style={{ width: 40, height: 40, borderRadius: 20, background: 'var(--hero-bg)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="arrow" size={18} />
          </span>
        </button>
      </section>

      <section class="card">
        <h2>{t('Tampilan', 'Display')}</h2>
        <span class="strong">{t('Ukuran huruf', 'Text size')}</span>
        <div role="radiogroup" aria-label={t('Ukuran huruf', 'Text size')} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.3fr)', gap: 8 }}>
          {sizes.map((s, i) => {
            const on = prefs.textSize === i;
            return (
              <button
                key={s.label}
                role="radio"
                aria-checked={on}
                class={`size-opt${on ? ' on' : ''}`}
                onClick={() => setPrefs({ textSize: i as Prefs['textSize'] })}
              >
                <span style={{ height: 32, display: 'flex', alignItems: 'flex-end', fontSize: s.px, fontWeight: 800, lineHeight: 1 }}>Aa</span>
                <span class="label semi" style={{ whiteSpace: 'nowrap', textAlign: 'center' }}>
                  {s.label}
                </span>
                {on && (
                  <span class="corner-tick">
                    <Tick size={14} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div class="box stack-sm">
          <span class="row strong" style={{ gap: 8, lineHeight: 1.25 }}>
            <Shape tone="bad" />
            {t('Kolam B · Bahaya', 'Kolam B · Danger')}
          </span>
          <span class="ink2">{t('Sidat naik ke permukaan. Cek aerator sekarang.', 'Eels are coming up to the surface. Check the aerator now.')}</span>
        </div>
        <div class="stack night-row">
          <div class="stack-xs">
            <span class="strong">{t('Terang atau gelap', 'Light or dark')}</span>
            <span class="label ink2">{t('Gelap nyaman untuk cek kolam malam hari', 'Dark is easier on the eyes for night checks')}</span>
          </div>
          <div role="radiogroup" aria-label={t('Terang atau gelap', 'Light or dark')} class="grid3" style={{ gap: 8 }}>
            {themes.map((g) => {
              const on = prefs.theme === g.id;
              return (
                <button key={g.id} role="radio" aria-checked={on} class={`size-opt lang-opt${on ? ' on' : ''}`} onClick={() => setPrefs({ theme: g.id })}>
                  {g.icon}
                  <span class="semi">{g.label}</span>
                  {on && (
                    <span class="corner-tick">
                      <Tick size={14} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
        <div class="stack lang-row">
          <div class="stack-xs">
            <span class="strong">{t('Bahasa', 'Language')}</span>
            <span class="label ink2">{t('Menu dan saran AI', 'Menus and AI advice')}</span>
          </div>
          <div role="radiogroup" aria-label={t('Bahasa', 'Language')} class="grid2" style={{ gap: 8 }}>
            {langs.map((g) => {
              const on = lang === g.id;
              return (
                <button key={g.id} role="radio" aria-checked={on} lang={g.id} class={`size-opt lang-opt${on ? ' on' : ''}`} onClick={() => setLang(g.id)}>
                  <span class="semi">{g.label}</span>
                  {on && (
                    <span class="corner-tick">
                      <Tick size={14} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {state.farm && <Members farmName={state.farm.name} owner={owner} inviteOpen={inviteOpen} onInviteOpen={setInviteOpen} />}

      {me.farms.length > 1 && (
        <section class="card list">
          <div class="stack-xs" style={{ padding: '20px 0 8px' }}>
            <h2>{t('Pilih tambak', 'Choose a farm')}</h2>
            <span class="meta">{t(`Terdaftar di ${me.farms.length} tambak`, `Member of ${me.farms.length} farms`)}</span>
          </div>
          {me.farms.map((f) => {
            const on = f.id === me.farm?.id;
            return (
              <button
                key={f.id}
                type="button"
                class="list-row"
                role="radio"
                aria-checked={on}
                disabled={switching !== null}
                style={{ width: '100%', border: 0, borderTop: '1px solid var(--line)', background: 'none', padding: 0, textAlign: 'left', color: 'inherit' }}
                onClick={() => !on && switchTo(f.id)}
              >
                <span class="grow stack-xs" style={{ gap: 0 }}>
                  <span class="strong">{f.name}</span>
                  <span class="meta">{switching === f.id ? t('Membuka…', 'Opening…') : roleLabel[f.role]}</span>
                </span>
                <span class={`tick-box${on ? ' on' : ''}`}>{on && <Tick />}</span>
              </button>
            );
          })}
          {error && (
            <p class="error" style={{ paddingBottom: 16 }}>
              {error}
            </p>
          )}
        </section>
      )}

      {onJoined && (
        <section class="card stack">
          <div class="stack-xs">
            <h2>{t('Gabung tambak lain', 'Join another farm')}</h2>
            <span class="meta">{t('Pakai kode undangan dari pemilik tambak. Tambak ini tetap ada di daftar.', 'Use an invite code from the farm owner. This farm stays in your list.')}</span>
          </div>
          <JoinByCode onJoined={onJoined} />
        </section>
      )}

      <QuotaRow go={go} />

      {owner && farm && (
        <FarmLocation
          farm={farm}
          onSaved={(f) => {
            setFarm(f);
            onFarmChanged?.();
          }}
        />
      )}

      <section class="card list">
        {toggles.map((tg) => (
          <div key={tg.label} class="list-row" style={{ minHeight: 72, padding: '12px 0' }}>
            <div class="grow stack-xs">
              <span class="semi">{tg.label}</span>
              <span class="label ink2">{tg.sub}</span>
            </div>
            <Switch checked={tg.checked} label={tg.label} onChange={tg.onChange} />
          </div>
        ))}
      </section>

      <section class="card row" style={{ flexDirection: 'row', padding: '16px 20px', gap: 12 }}>
        <span class="icon-box">
          <Icon name="heart" />
        </span>
        <div class="grow stack-xs">
          <span class="strong">{t('Bantu kembangkan Synteel', 'Help improve Synteel')}</span>
          <span class="label ink2">{t('Foto, video dan catatan untuk melatih AI. Nama dan nomor HP tidak ikut.', 'Photos, videos and records to train the AI. Name and phone number are not shared.')}</span>
        </div>
        <Switch checked={prefs.shareData} label={t('Bantu kembangkan Synteel', 'Help improve Synteel')} onChange={(v) => setPrefs({ shareData: v })} />
      </section>

      <section class="card list" aria-labelledby="alat-title">
        <h2 id="alat-title" style={{ paddingTop: 20, paddingBottom: 4 }}>
          {t('Alat Synteel', 'Synteel devices')}
        </h2>
        <button type="button" class="list-row link-row" style={ALAT_ROW} onClick={() => go({ name: 'device' })}>
          <span class="grow stack-xs" style={{ gap: 0 }}>
            <span class="semi">{t('Hubungkan alat', 'Connect a device')}</span>
            <span class="label ink2" style={{ fontWeight: 400 }}>
              {t('Ketik kode alat atau scan kode QR-nya', "Type the device code or scan its QR code")}
            </span>
          </span>
          <Icon name="next" size={20} />
        </button>
        <a class="list-row link-row" style={ALAT_ROW} href="https://eel.synt.fun/#hardware" target="_blank" rel="noopener" onClick={siteInAppLanguage}>
          <span class="grow stack-xs" style={{ gap: 0 }}>
            <span class="semi">{t('Lihat alat Synteel', 'See Synteel devices')}</span>
            <span class="label ink2" style={{ fontWeight: 400 }}>
              {t('Sensor dan filter untuk kolam · masih prototipe, belum dijual', 'Sensors and filters for ponds · still prototypes, not for sale yet')}
            </span>
          </span>
          <Icon name="next" size={20} />
        </a>
      </section>

      {!me.demo && <ChangePin />}

      {me.demo && (
        <p class="note info">
          <Icon name="info" size={20} /> {t('Akun demo: tambak contoh ini dihapus 2 hari sesudah dibuka', 'Demo account: this sample farm is deleted 2 days after it was opened')}
        </p>
      )}

      <LaterList title={t('Sedang disiapkan', 'In the works')} items={later} />

      <button type="button" class="go-row help-row" onClick={() => go({ name: 'help' })}>
        <span style={{ color: 'var(--accent)', display: 'flex' }}>
          <Icon name="headset" />
        </span>
        <span class="grow stack-xs" style={{ gap: 0 }}>
          <span class="strong" style={{ color: 'var(--ink)' }}>
            {t('Hubungi bantuan', 'Contact support')}
          </span>
          <span class="meta">{t('Ada kendala? Tim Synteel membalas lewat WhatsApp', 'Having trouble? The Synteel team replies on WhatsApp')}</span>
        </span>
        <span style={{ color: 'var(--muted)', display: 'flex' }}>
          <Icon name="next" size={20} />
        </span>
      </button>

      <section class="stack-sm">
        <button type="button" class="btn secondary" onClick={logout} disabled={leaving}>
          <Icon name="logout" size={20} /> {t('Keluar', 'Sign out')}
        </button>
        <span class="meta center">{t(`Masuk sebagai ${me.user.name}`, `Signed in as ${me.user.name}`)}</span>
      </section>
    </div>
  );
}

const WEEKS = ['Seminggu', 'Dua minggu', 'Tiga minggu', 'Empat minggu', 'Lima minggu', 'Enam minggu', 'Tujuh minggu', 'Delapan minggu'];
const WEEKS_EN = ['One full week', 'Two full weeks', 'Three full weeks', 'Four full weeks', 'Five full weeks', 'Six full weeks', 'Seven full weeks', 'Eight full weeks'];
const STREAK_BONUS = 10;

export function Rewards({ state, go }: { state: FarmState; go: Go }) {
  const [q, setQ] = useState<QuotaState | null>(null);
  useEffect(() => {
    api.quota().then(setQ, () => {});
  }, []);
  const streak = state.streak;
  // +10 bacaan on every 7th day of the streak (server: quota earn.streak).
  const bonus = q?.earn.streak.bonus ?? STREAK_BONUS;
  const nextAt = q?.earn.streak.nextAt ?? (Math.floor(streak / 7) + 1) * 7;
  const first = Math.max(7, nextAt - 14);
  const ladder = [0, 1, 2, 3].map((i) => {
    const day = first + i * 7;
    const weeks = day / 7;
    return { day, sub: t(`${WEEKS[weeks - 1] ?? `${weeks} minggu`} penuh`, WEEKS_EN[weeks - 1] ?? `${weeks} full weeks`) };
  });
  const pv = q?.earn.photoVideo;

  return (
    <div class="screen profile">
      <header class="row">
        <button class="icon-btn" aria-label={t('Kembali ke Profil', 'Back to Profile')} onClick={() => go({ name: 'profile' })}>
          <Icon name="back" />
        </button>
        <h1>{t('Hadiah rajin mencatat', 'Rewards for steady recording')}</h1>
      </header>

      <p class="note info">
        <Icon name="info" size={20} />
        <span>{t('Simulasi: hitungan beruntun asli dari catatan kolam.', 'Simulation: the real streak count comes from the pond records.')}</span>
      </p>

      <section class="hero" style={{ gap: 16 }}>
        <div class="row top between">
          <div class="stack-sm">
            <span class="label semi" style={{ color: '#b3b3b8' }}>
              {t('Mencatat beruntun', 'Recording streak')}
            </span>
            <span class="row" style={{ alignItems: 'baseline', gap: 8 }}>
              <span class="big">{streak}</span>
              <span class="h2">{t('hari beruntun', streak === 1 ? 'day in a row' : 'days in a row')}</span>
            </span>
          </div>
          <span style={{ width: 56, height: 56, flex: 'none', borderRadius: 28, background: 'var(--streak)', color: 'var(--streak-ink)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="flame" size={28} />
          </span>
        </div>
        <div class="stack-sm" style={{ background: 'rgba(255,255,255,0.08)', borderRadius: 16, padding: 16 }}>
          <span class="label" style={{ color: '#b3b3b8' }}>
            {t('7 hari terakhir', 'Last 7 days')}
          </span>
          <StreakDays state={state} />
        </div>
        <p style={{ color: 'var(--on-navy)' }}>
          {isEn ? (
            <>
              Record {nextAt - streak} more {nextAt - streak === 1 ? 'day' : 'days'} for +{bonus} reads on <span style={{ whiteSpace: 'nowrap' }}>day {nextAt}</span>.
            </>
          ) : (
            <>
              Catat {nextAt - streak} hari lagi untuk +{bonus} bacaan di <span style={{ whiteSpace: 'nowrap' }}>hari ke-{nextAt}</span>.
            </>
          )}
        </p>
      </section>

      <section class="card">
        <div class="row top between">
          <div class="stack-xs">
            <h2>{t('Hadiah hari ini', "Today's reward")}</h2>
            <span class="label ink2">{t('1 foto + 1 video kolam hari ini', '1 pond photo + 1 pond video today')}</span>
          </div>
          <span class="pill blue bonus-pill">
            {pv?.earned && <Tick />}+{pv?.bonus ?? 2} {t('bacaan', 'reads')}
          </span>
        </div>
        {pv && (
          <span class="row label" style={{ gap: 16 }}>
            <MediaDone on={pv.photo} label={t('Foto', 'Photo')} />
            <MediaDone on={pv.video} label="Video" />
          </span>
        )}
        <button class="btn primary" onClick={() => go({ name: 'record' })}>
          <Icon name="pencil" size={20} /> {t('Catat kondisi sekarang', 'Record conditions now')}
        </button>
      </section>

      <section class="card" style={{ gap: 4 }}>
        <h2>{t('Tiap 7 hari beruntun', 'Every 7 days in a row')}</h2>
        <span class="label ink2" style={{ marginBottom: 8 }}>
          +{bonus} {t('bacaan untuk hari itu', 'reads for that day')}
        </span>
        {ladder.map((s) => {
          const got = streak >= s.day;
          const isNext = s.day === nextAt;
          return (
            <div class="ladder-row" key={s.day}>
              <span class={`ladder-day${got ? ' got' : isNext ? ' next' : ''}`}>{s.day}</span>
              <span class="grow stack-xs" style={{ gap: 0 }}>
                <span class="strong">{s.sub}</span>
                <span class="label ink2">+{bonus} {t('bacaan', 'reads')}</span>
              </span>
              <span class={`pill ${got ? 'ok' : isNext ? 'blue' : 'grey'}`}>{got ? t('tercapai', 'reached') : isNext ? t('berikutnya', 'next') : t(`${s.day - streak} hari lagi`, `${s.day - streak} ${s.day - streak === 1 ? 'day' : 'days'} to go`)}</span>
            </div>
          );
        })}
      </section>

      <button type="button" class="card quota-link" onClick={() => go({ name: 'quota' })}>
        <span class="grow stack-xs">
          <span class="h2">{t('Jatah baca AI', 'Daily AI reads')}</span>
          <span class="label ink2">
            {t(
              'Satu bacaan = satu foto, suara atau video yang dibaca AI. Ketik sendiri dan laporan darurat tidak memakai jatah.',
              'One read = one photo, voice note or video the AI reads. “Type it in” and emergency reports do not use reads.',
            )}
          </span>
        </span>
        <span class="ink2" style={{ display: 'flex' }}>
          <Icon name="next" size={20} />
        </span>
      </button>

      <LaterList
        title={t('Hadiah lain', 'Other rewards')}
        items={[
          { label: t('Laporan mingguan', 'Weekly report'), sub: t('Ringkasan mati, suhu dan pakan seminggu', 'A week of deaths, temperature and feed') },
          { label: t('Hadiah mitra', 'Partner rewards'), sub: t('contoh: diskon pakan', 'for example: feed discounts') },
        ]}
      />

      <section class="card tint" style={{ gap: 12 }}>
        <h2>{t('Cara menghitung', 'How it counts')}</h2>
        <span>{t('Satu hari dihitung kalau ada minimal satu ukuran suhu, pH atau TDS.', 'A day counts if it has at least one temperature, pH or TDS reading.')}</span>
        <span>{t('Lupa sehari, hitungan mulai lagi dari 1. Belum ada hari libur untuk menjaga hitungan.', 'Miss a day and the count starts again from 1. There are no days off that keep the count yet.')}</span>
      </section>
    </div>
  );
}

