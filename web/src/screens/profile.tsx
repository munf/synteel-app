import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { api, type Farm, type FarmState, type Me, type QuotaState } from '../api.ts';
import type { Go } from '../app.tsx';
import { askNotifyPermission } from '../alarms.ts';
import { setPrefs, usePrefs, type Prefs } from '../prefs.ts';
import { Field, Icon, initialOf, roleLabel, Shape, Soon, Switch, Tick } from '../ui.tsx';
import { ChangePin, Members } from './members.tsx';
import { MediaDone, QuotaBar } from './quota.tsx';
import { LocateButton, useLocate } from './setup.tsx';
import './profile.css';

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
  const sub = q ? (q.unlimited ? 'Tidak ada batas harian saat ini' : `${q.left} dari ${q.cap} bacaan tersisa hari ini`) : failed ? 'Lihat sisa hari ini' : 'Memuat…';
  return (
    <LinkCard icon={<Icon name="sparkle" />} title="Jatah baca AI" sub={sub} onClick={() => go({ name: 'quota' })}>
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
        title="Lokasi tambak"
        sub={farm.locationName ? farm.locationName : farm.lat !== null ? 'Titik lokasi HP' : 'Belum diatur. Dipakai untuk cuaca per jam.'}
        onClick={() => setOpen(true)}
      >
        {notFound && (
          <span class="note info" style={{ width: '100%' }}>
            <Icon name="info" size={20} /> Tempat ini belum ditemukan di peta, jadi cuaca belum bisa dihitung. Tulis nama kecamatan dan kabupaten, atau pakai lokasi HP.
          </span>
        )}
      </LinkCard>
    );
  }
  return (
    <form class="card" id="lokasi" onSubmit={save}>
      <Field label="Lokasi tambak" hint="Dipakai untuk cuaca per jam, supaya suhu air bisa diperkirakan.">
        <input value={place} onInput={(e) => setPlace(e.currentTarget.value)} placeholder="contoh: Sleman, Yogyakarta" />
      </Field>
      <LocateButton gps={gps} />
      {(error || gps.error) && <p class="error">{error || gps.error}</p>}
      <div class="grid2" style={{ gap: 8 }}>
        <button type="button" class="btn secondary" onClick={() => setOpen(false)}>
          Batal
        </button>
        <button class="btn primary" disabled={busy || (!place.trim() && !gps.coords)}>
          Simpan
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
    const date = d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long' });
    return { label: String(d.getDate()), aria: `${DAY_LONG[d.getDay()]} ${date}, ${done ? 'sudah mencatat' : back === 0 ? 'hari ini, belum mencatat' : 'belum mencatat'}`, done, today: back === 0 };
  });
}

const loggedToday = (state: FarmState) =>
  state.ponds.some((p) => Object.values(p.latest).some((r) => r && new Date(r.at).toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' }) === state.today));

/** Seven circles for the last seven days, labelled with the date (22 … 28), ticked when recorded. Used on Profil and Hadiah. */
function StreakDays({ state }: { state: FarmState }) {
  const days = week(state.streak, loggedToday(state));
  return (
    <div role="list" aria-label="7 hari terakhir" style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 4 }}>
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
              color: '#fff',
              background: d.done ? '#2F6FE4' : 'transparent',
              border: d.done ? 'none' : d.today ? '2px dashed #8FA3C8' : '2px solid #3A4F78',
            }}
          >
            {d.done && <Tick size={14} />}
          </span>
          <span class="label num" aria-hidden="true" style={{ color: '#B9C6E0' }}>
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
    <section class="card later" aria-label="Belum tersedia">
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

export function Profile({
  state,
  me,
  go,
  invite = false,
  onSwitch,
  onLogout,
  onFarmChanged,
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
    { label: 'Alarm cek malam', sub: 'Berbunyi selama aplikasi terbuka', checked: prefs.alarms, onChange: (v) => { setPrefs({ alarms: v }); if (v) void askNotifyPermission(); } },
    { label: 'Detail teknis terbuka', sub: 'Grafik dan angka langsung tampil', checked: prefs.techOpen, onChange: (v) => setPrefs({ techOpen: v }) },
  ];
  // On the type scale: the "Aa" sample grows 16 → 18 → 24.
  const sizes: { label: string; px: number }[] = [
    { label: 'Normal', px: 16 },
    { label: 'Besar', px: 18 },
    { label: 'Sangat besar', px: 24 },
  ];
  const later = [
    { label: 'Telepon penyuluh', sub: 'Penyuluh perikanan' },
    { label: 'Laporan mingguan', sub: 'Ringkasan mati, suhu dan pakan seminggu' },
    { label: 'Teruskan alarm ke pemilik', sub: 'Kalau alarm cek malam tidak dijawab' },
    { label: 'Bahasa Inggris', sub: 'Menu dan saran AI' },
    { label: 'Lihat atau hapus data', sub: 'Data yang dipakai melatih AI' },
  ];

  return (
    <div class="screen profile">
      <header class="row between">
        <button class="icon-btn" aria-label="Kembali ke Beranda" onClick={() => go({ name: 'today' })}>
          <Icon name="back" />
        </button>
      </header>

      <section class="hero" style={{ gap: 16 }}>
        <div class="row" style={{ gap: 16 }}>
          <span class="avatar lg">{initialOf(me.user.name)}</span>
          <div class="stack-xs" style={{ minWidth: 0 }}>
            <span class="title" style={{ lineHeight: 1.1, overflowWrap: 'anywhere' }}>
              Halo, {me.user.name}
            </span>
            <span class="semi" style={{ color: '#fff' }}>
              {farm?.name}
            </span>
            <span class="label" style={{ color: '#C9D4EA' }}>
              {[state.role && roleLabel[state.role], farm?.locationName ?? 'Lokasi belum diatur'].filter(Boolean).join(' · ')}
            </span>
          </div>
        </div>
        <div class="stack-sm" style={{ background: 'rgba(255,255,255,0.08)', borderRadius: 16, padding: 16 }}>
          <div class="row between" style={{ alignItems: 'baseline' }}>
            <span class="strong num">{state.streak} hari beruntun</span>
            <span class="label" style={{ color: '#B9C6E0', whiteSpace: 'nowrap' }}>
              7 hari terakhir
            </span>
          </div>
          <StreakDays state={state} />
        </div>
        <button class="btn light" style={{ justifyContent: 'space-between', paddingLeft: 16, paddingRight: 8 }} onClick={() => go({ name: 'rewards' })}>
          <span class="row" style={{ gap: 12 }}>
            <span style={{ color: '#2F6FE4', display: 'flex' }}>
              <Icon name="gift" />
            </span>
            Lihat hadiah
          </span>
          <span style={{ width: 40, height: 40, borderRadius: 20, background: '#13264A', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="arrow" size={18} />
          </span>
        </button>
      </section>

      <section class="card">
        <h2>Tampilan</h2>
        <span class="strong">Ukuran huruf</span>
        <div role="radiogroup" aria-label="Ukuran huruf" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.3fr)', gap: 8 }}>
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
            Kolam B · Bahaya
          </span>
          <span class="ink2">Sidat naik ke permukaan. Cek aerator sekarang.</span>
        </div>
        <div class="row night-row">
          <div class="grow stack-xs">
            <span class="strong">Tampilan malam</span>
            <span class="label ink2">Layar gelap untuk cek kolam malam hari</span>
          </div>
          <Switch checked={prefs.night} label="Tampilan malam" onChange={(v) => setPrefs({ night: v })} />
        </div>
      </section>

      {state.farm && <Members farmName={state.farm.name} owner={owner} inviteOpen={inviteOpen} onInviteOpen={setInviteOpen} />}

      {me.farms.length > 1 && (
        <section class="card list">
          <div class="stack-xs" style={{ padding: '20px 0 8px' }}>
            <h2>Pilih tambak</h2>
            <span class="meta">Terdaftar di {me.farms.length} tambak</span>
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
                  <span class="meta">{switching === f.id ? 'Membuka…' : roleLabel[f.role]}</span>
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
        {toggles.map((t) => (
          <div key={t.label} class="list-row" style={{ minHeight: 72, padding: '12px 0' }}>
            <div class="grow stack-xs">
              <span class="semi">{t.label}</span>
              <span class="label ink2">{t.sub}</span>
            </div>
            <Switch checked={t.checked} label={t.label} onChange={t.onChange} />
          </div>
        ))}
      </section>

      <section class="card row" style={{ flexDirection: 'row', padding: '16px 20px', gap: 12 }}>
        <span class="icon-box">
          <Icon name="heart" />
        </span>
        <div class="grow stack-xs">
          <span class="strong">Bantu kembangkan Synteel</span>
          <span class="label ink2">Foto, video dan catatan untuk melatih AI. Nama dan nomor HP tidak ikut.</span>
        </div>
        <Switch checked={prefs.shareData} label="Bantu kembangkan Synteel" onChange={(v) => setPrefs({ shareData: v })} />
      </section>

      {!me.demo && <ChangePin />}

      {me.demo && (
        <p class="note info">
          <Icon name="info" size={20} /> Akun demo: data direset tiap malam
        </p>
      )}

      <LaterList title="Sedang disiapkan" items={later} />

      <button type="button" class="go-row help-row" onClick={() => go({ name: 'help' })}>
        <span style={{ color: 'var(--accent)', display: 'flex' }}>
          <Icon name="headset" />
        </span>
        <span class="grow stack-xs" style={{ gap: 0 }}>
          <span class="strong" style={{ color: 'var(--ink)' }}>
            Hubungi bantuan
          </span>
          <span class="meta">Ada kendala? Tim Synteel membalas lewat WhatsApp</span>
        </span>
        <span style={{ color: 'var(--muted)', display: 'flex' }}>
          <Icon name="next" size={20} />
        </span>
      </button>

      <section class="stack-sm">
        <button type="button" class="btn secondary" onClick={logout} disabled={leaving}>
          <Icon name="logout" size={20} /> Keluar
        </button>
        <span class="meta center">Masuk sebagai {me.user.name}</span>
      </section>
    </div>
  );
}

const WEEKS = ['Seminggu', 'Dua minggu', 'Tiga minggu', 'Empat minggu', 'Lima minggu', 'Enam minggu', 'Tujuh minggu', 'Delapan minggu'];
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
    return { day, sub: `${WEEKS[weeks - 1] ?? `${weeks} minggu`} penuh` };
  });
  const pv = q?.earn.photoVideo;

  return (
    <div class="screen profile">
      <header class="row">
        <button class="icon-btn" aria-label="Kembali ke Profil" onClick={() => go({ name: 'profile' })}>
          <Icon name="back" />
        </button>
        <h1>Hadiah rajin mencatat</h1>
      </header>

      <p class="note info">
        <Icon name="info" size={20} />
        <span>Simulasi: hitungan beruntun asli dari catatan kolam.</span>
      </p>

      <section class="hero" style={{ gap: 16 }}>
        <div class="row top between">
          <div class="stack-sm">
            <span class="label semi" style={{ color: '#B9C6E0' }}>
              Mencatat beruntun
            </span>
            <span class="row" style={{ alignItems: 'baseline', gap: 8 }}>
              <span class="big">{streak}</span>
              <span class="h2">hari beruntun</span>
            </span>
          </div>
          <span style={{ width: 56, height: 56, flex: 'none', borderRadius: 28, background: '#2F6FE4', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="flame" size={28} />
          </span>
        </div>
        <div class="stack-sm" style={{ background: 'rgba(255,255,255,0.08)', borderRadius: 16, padding: 16 }}>
          <span class="label" style={{ color: '#B9C6E0' }}>
            7 hari terakhir
          </span>
          <StreakDays state={state} />
        </div>
        <p style={{ color: '#DCE4F2' }}>
          Catat {nextAt - streak} hari lagi untuk +{bonus} bacaan di <span style={{ whiteSpace: 'nowrap' }}>hari ke-{nextAt}</span>.
        </p>
      </section>

      <section class="card">
        <div class="row top between">
          <div class="stack-xs">
            <h2>Hadiah hari ini</h2>
            <span class="label ink2">1 foto + 1 video kolam hari ini</span>
          </div>
          <span class="pill blue bonus-pill">
            {pv?.earned && <Tick />}+{pv?.bonus ?? 2} bacaan
          </span>
        </div>
        {pv && (
          <span class="row label" style={{ gap: 16 }}>
            <MediaDone on={pv.photo} label="Foto" />
            <MediaDone on={pv.video} label="Video" />
          </span>
        )}
        <button class="btn primary" onClick={() => go({ name: 'record' })}>
          <Icon name="pencil" size={20} /> Catat kondisi sekarang
        </button>
      </section>

      <section class="card" style={{ gap: 4 }}>
        <h2>Tiap 7 hari beruntun</h2>
        <span class="label ink2" style={{ marginBottom: 8 }}>
          +{bonus} bacaan untuk hari itu
        </span>
        {ladder.map((s) => {
          const got = streak >= s.day;
          const isNext = s.day === nextAt;
          return (
            <div class="ladder-row" key={s.day}>
              <span class={`ladder-day${got ? ' got' : isNext ? ' next' : ''}`}>{s.day}</span>
              <span class="grow stack-xs" style={{ gap: 0 }}>
                <span class="strong">{s.sub}</span>
                <span class="label ink2">+{bonus} bacaan</span>
              </span>
              <span class={`pill ${got ? 'ok' : isNext ? 'blue' : 'grey'}`}>{got ? 'tercapai' : isNext ? 'berikutnya' : `${s.day - streak} hari lagi`}</span>
            </div>
          );
        })}
      </section>

      <button type="button" class="card quota-link" onClick={() => go({ name: 'quota' })}>
        <span class="grow stack-xs">
          <span class="h2">Jatah baca AI</span>
          <span class="label ink2">Satu bacaan = satu foto, suara atau video yang dibaca AI. Ketik sendiri dan laporan darurat tidak memakai jatah.</span>
        </span>
        <span class="ink2" style={{ display: 'flex' }}>
          <Icon name="next" size={20} />
        </span>
      </button>

      <LaterList
        title="Hadiah lain"
        items={[
          { label: 'Laporan mingguan', sub: 'Ringkasan mati, suhu dan pakan seminggu' },
          { label: 'Hadiah mitra', sub: 'contoh: diskon pakan' },
        ]}
      />

      <section class="card tint" style={{ gap: 12 }}>
        <h2>Cara menghitung</h2>
        <span>Satu hari dihitung kalau ada minimal satu ukuran suhu, pH atau TDS.</span>
        <span>Lupa sehari, hitungan mulai lagi dari 1. Belum ada hari libur untuk menjaga hitungan.</span>
      </section>
    </div>
  );
}

