import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { api, type Farm, type FarmState, type Me, type QuotaState } from '../api.ts';
import type { Go } from '../app.tsx';
import { setPrefs, usePrefs, type Prefs } from '../prefs.ts';
import { Field, Icon, initialOf, roleLabel, Soon, Switch, Tick, type IconName } from '../ui.tsx';
import { ChangePin, Members } from './members.tsx';
import { QuotaBar } from './quota.tsx';
import { LocateButton, useLocate } from './setup.tsx';

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
  const sub = q ? (q.unlimited ? 'Tidak ada batas harian saat ini' : `${q.left} dari ${q.cap} tersisa hari ini`) : failed ? 'Lihat sisa hari ini' : 'Memuat…';
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
          <span class="note warn" style={{ width: '100%' }}>
            <Icon name="alert" size={20} /> Tempat ini belum ditemukan di peta, jadi cuaca belum bisa dihitung. Tulis nama kecamatan dan kabupaten, atau pakai lokasi HP.
          </span>
        )}
      </LinkCard>
    );
  }
  return (
    <form class="card" id="lokasi" onSubmit={save}>
      <Field label="Lokasi tambak" hint="Dipakai untuk cuaca per jam, supaya suhu air bisa diperkirakan.">
        <input value={place} onInput={(e) => setPlace(e.currentTarget.value)} placeholder="mis. Sleman, Yogyakarta" />
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

const DAY_NAMES = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];

/** The last seven days, oldest first, marked done when they fall inside the current streak. */
function week(streak: number, todayLogged: boolean) {
  const today = new Date();
  return Array.from({ length: 7 }, (_, i) => {
    const back = 6 - i;
    const d = new Date(today.getTime() - back * 86400_000);
    // A streak that has no reading today yet ends yesterday.
    const done = todayLogged ? back < streak : back >= 1 && back <= streak;
    return { label: DAY_NAMES[d.getDay()], done, today: back === 0 };
  });
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

  const openInvite = () => {
    setInviteOpen(true);
    document.getElementById('anggota')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
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
  const todayLogged = state.ponds.some((p) =>
    Object.values(p.latest).some((r) => r && new Date(r.at).toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' }) === state.today),
  );
  const days = week(state.streak, todayLogged);
  const actions: { label: string; sub: string; icon: IconName; onClick?: () => void; soon?: boolean }[] = [
    { label: 'Catat sekarang', sub: 'Suara, foto atau ketik', icon: 'mic', onClick: () => go({ name: 'record' }) },
    { label: 'Telepon ahli', sub: 'Penyuluh perikanan', icon: 'phone', soon: true },
    { label: 'Laporan mingguan', sub: 'Mati, suhu, pakan', icon: 'chart', soon: true },
    owner
      ? { label: 'Undang anggota', sub: 'Pemilik atau pekerja', icon: 'user', onClick: openInvite }
      : { label: 'Undang anggota', sub: 'Hanya pemilik tambak', icon: 'user' },
  ];
  const toggles: { label: string; sub: string; checked: boolean; onChange?: (v: boolean) => void }[] = [
    { label: 'Alarm cek malam', sub: 'Bunyi keras walau HP senyap', checked: false },
    { label: 'Teruskan ke pemilik', sub: 'Kalau alarm tak dijawab 10 menit', checked: false },
    { label: 'Detail teknis terbuka', sub: 'Grafik dan angka langsung tampil', checked: prefs.techOpen, onChange: (v) => setPrefs({ techOpen: v }) },
  ];
  const sizes: { label: string; px: number }[] = [
    { label: 'Normal', px: 18 },
    { label: 'Besar', px: 24 },
    { label: 'Sangat besar', px: 32 },
  ];

  return (
    <div class="screen">
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
          <div class="row between">
            <span class="strong">{state.streak} hari beruntun</span>
            <span class="label" style={{ color: 'var(--on-navy-2)' }}>
              7 hari terakhir
            </span>
          </div>
          <div class="grid3" style={{ gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 4 }}>
            {days.map((d, i) => (
              <span key={i} class="stack-xs" style={{ alignItems: 'center' }}>
                <span
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 14,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: d.done ? 'var(--accent)' : 'transparent',
                    border: d.done ? 'none' : d.today ? '2px dashed #8FA3C8' : '2px solid #3A4F78',
                  }}
                >
                  {d.done && <Tick size={14} />}
                </span>
                <span class="label" style={{ color: 'var(--on-navy-2)' }}>
                  {d.label}
                </span>
              </span>
            ))}
          </div>
        </div>
        <button class="btn light" style={{ justifyContent: 'space-between', paddingLeft: 16, paddingRight: 8 }} onClick={() => go({ name: 'rewards' })}>
          <span class="row" style={{ gap: 12 }}>
            <span style={{ color: 'var(--accent)' }}>
              <Icon name="gift" />
            </span>
            Lihat hadiah
          </span>
          <span style={{ width: 40, height: 40, borderRadius: 20, background: 'var(--navy)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="arrow" size={18} />
          </span>
        </button>
      </section>

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

      {me.demo && (
        <p class="note warn">
          <Icon name="alert" size={20} /> Akun demo: data direset tiap malam
        </p>
      )}

      <section class="grid2">
        {actions.map((a) => (
          <button key={a.label} class="card" style={{ border: 0, textAlign: 'left', gap: 12, justifyContent: 'flex-start' }} onClick={a.onClick} disabled={!a.onClick}>
            <span class="row between" style={{ width: '100%' }}>
              <span class="icon-box">
                <Icon name={a.icon} />
              </span>
              {a.soon && <Soon />}
            </span>
            <span class="stack-xs">
              <span class="strong">{a.label}</span>
              <span class="meta">{a.sub}</span>
            </span>
          </button>
        ))}
      </section>

      <section class="card">
        <div class="row between">
          <div class="stack-xs">
            <h2>Bahasa aplikasi</h2>
            <span class="meta">Menu dan saran AI</span>
          </div>
        </div>
        <div class="grid2" style={{ gap: 8 }}>
          <button class="btn primary" aria-pressed="true">
            <Tick /> Indonesia
          </button>
          <span class="btn secondary" aria-disabled="true" style={{ flexDirection: 'column', gap: 0, opacity: 0.8 }}>
            English <Soon />
          </span>
        </div>
      </section>

      <section class="card">
        <h2>Ukuran huruf</h2>
        <div role="radiogroup" aria-label="Ukuran huruf" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.3fr)', gap: 8 }}>
          {sizes.map((s, i) => {
            const on = prefs.textSize === i;
            return (
              <button
                key={s.label}
                role="radio"
                aria-checked={on}
                onClick={() => setPrefs({ textSize: i as Prefs['textSize'] })}
                style={{ position: 'relative', minHeight: 96, borderRadius: 16, background: '#fff', border: on ? '3px solid var(--navy)' : '2px solid var(--line-2)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 0 }}
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
          <span class="strong">Kolam B · Bahaya</span>
          <span class="ink2">Sidat naik ke permukaan. Cek aerator sekarang.</span>
        </div>
      </section>

      <section class="card list">
        {toggles.map((t) => (
          <div key={t.label} class="list-row" style={{ minHeight: 80, padding: '12px 0' }}>
            <div class="grow stack-xs">
              <span class="row" style={{ flexWrap: 'wrap', gap: '4px 8px' }}>
                <span class="semi">{t.label}</span>
                {!t.onChange && <Soon />}
              </span>
              <span class="meta">{t.sub}</span>
            </div>
            <span style={{ opacity: t.onChange ? 1 : 0.5 }}>
              <Switch checked={t.checked} label={t.label} onChange={t.onChange} disabled={!t.onChange} />
            </span>
          </div>
        ))}
      </section>

      <section class="card">
        <div class="row between">
          <span class="icon-box">
            <Icon name="heart" />
          </span>
          <Switch checked={prefs.shareData} label="Izinkan data dipakai untuk melatih AI" onChange={(v) => setPrefs({ shareData: v })} />
        </div>
        <div class="stack-xs">
          <h2>Bantu kembangkan Synteel</h2>
          <span class="label ink2">Izinkan foto, video dan catatan dipakai untuk membuat AI lebih tepat membaca kolam.</span>
        </div>
        <div class="grid2" style={{ gap: 8 }}>
          <div class="box stack-sm">
            <span class="label strong">Yang dipakai</span>
            <span class="label ink2">Foto alat ukur, foto dan video kolam, angka yang disimpan</span>
          </div>
          <div class="box stack-sm">
            <span class="label strong">Tidak pernah</span>
            <span class="label ink2">Nama, nomor HP, lokasi persis tambak</span>
          </div>
        </div>
        <span class="meta">Pilihan ini tidak memengaruhi hadiah. Bisa dimatikan kapan saja. Saat ini pilihan baru disimpan di HP ini.</span>
        <div class="row between">
          <span class="semi" style={{ color: 'var(--accent-ink)' }}>
            Lihat atau hapus data
          </span>
          <Soon />
        </div>
      </section>

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

      {state.farm && <Members farmName={state.farm.name} owner={owner} inviteOpen={inviteOpen} onInviteOpen={setInviteOpen} />}

      {!me.demo && <ChangePin />}

      <button type="button" class="btn secondary" style={{ justifyContent: 'flex-start', gap: 12, padding: '12px 16px', textAlign: 'left', fontWeight: 400 }} onClick={() => go({ name: 'help' })}>
        <span style={{ color: 'var(--accent)', display: 'flex' }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M4 13a8 8 0 0 1 16 0M4 13v3a2 2 0 0 0 2 2h1v-6H6a2 2 0 0 0-2 2zM20 13v3a2 2 0 0 1-2 2h-1v-6h1a2 2 0 0 1 2 2zM17 18c0 1.5-2 3-5 3" />
          </svg>
        </span>
        <span class="grow stack-xs" style={{ gap: 0 }}>
          <span class="strong">Hubungi bantuan</span>
          <span class="meta">Ada kendala? Tim Synteel membalas lewat WhatsApp</span>
        </span>
        <Icon name="next" />
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

export function Rewards({ state, go }: { state: FarmState; go: Go }) {
  const streak = state.streak;
  const nextAt = streak < 7 ? 7 : streak < 14 ? 14 : streak < 30 ? 30 : 60;
  // One bar per day from the last reward reached to the next, so progress shows right after a reward.
  const prevAt = nextAt === 7 ? 0 : nextAt === 14 ? 7 : nextAt === 30 ? 14 : 30;
  const ladder = [
    { day: 7, reward: '+10 jatah baca AI', sub: 'Seminggu penuh' },
    { day: 14, reward: '+20 jatah baca AI', sub: 'Dua minggu penuh' },
    { day: 30, reward: 'Laporan bulanan', sub: 'Ringkasan untuk pembeli atau bank' },
    { day: 60, reward: 'Hadiah mitra', sub: 'mis. diskon pakan' },
  ];

  return (
    <div class="screen">
      <header class="row">
        <button class="icon-btn" aria-label="Kembali" onClick={() => go({ name: 'today' })}>
          <Icon name="back" />
        </button>
        <h1>Hadiah</h1>
      </header>

      <p class="note warn">
        Simulasi: hitungan beruntun sudah asli dari catatan, tapi hadiah dan jatah belum aktif.
      </p>

      <section class="hero" style={{ gap: 16 }}>
        <div class="row top between">
          <div class="stack-sm">
            <span class="label semi" style={{ color: 'var(--on-navy-2)' }}>
              Mencatat beruntun
            </span>
            <span class="row" style={{ alignItems: 'baseline', gap: 8 }}>
              <span class="big">{streak}</span>
              <span class="h2">hari</span>
            </span>
          </div>
          <span style={{ width: 56, height: 56, borderRadius: 28, background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="flame" size={28} />
          </span>
        </div>
        <div class="bars" style={{ height: 12 }}>
          {Array.from({ length: nextAt - prevAt }, (_, i) => (
            <span key={i} style={{ height: 12, borderRadius: 4, background: prevAt + i + 1 <= streak ? 'var(--accent)' : 'rgba(255,255,255,0.15)' }} />
          ))}
        </div>
        <p>
          {streak >= 60 ? 'Semua tangga hadiah sudah tercapai.' : `Catat ${nextAt - streak} hari lagi untuk hadiah hari ke-${nextAt}.`}
        </p>
      </section>

      <section class="card">
        <div class="row top between">
          <div class="stack-xs">
            <h2>Hadiah hari ini</h2>
            <span class="meta">Laporan video + foto kolam</span>
          </div>
          <span class="pill blue">+2 jatah</span>
        </div>
        <span class="label ink2">1 video dan 1 foto kolam kapan saja hari ini. Jatah yang terpakai untuk keduanya dikembalikan.</span>
        <button class="btn primary" onClick={() => go({ name: 'record' })}>
          <Icon name="camera" size={20} /> Lapor sekarang
        </button>
      </section>

      <section class="card">
        <div class="row between">
          <h2>Jatah baca AI bulan ini</h2>
          <Soon>Simulasi</Soon>
        </div>
        <span class="label ink2">1 jatah = 1 foto, suara atau video yang dibaca AI. Ketik sendiri dan laporan darurat (Masalah) tidak memakai jatah.</span>
      </section>

      <section class="card" style={{ gap: 4 }}>
        <h2 style={{ marginBottom: 8 }}>Tangga hadiah</h2>
        {ladder.map((s) => {
          const got = streak >= s.day;
          const isNext = s.day === nextAt;
          return (
            <div class="list-row" key={s.day} style={{ minHeight: 72 }}>
              <span
                style={{
                  width: 48,
                  height: 48,
                  flex: 'none',
                  borderRadius: 16,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 800,
                  background: got ? 'var(--ok-bg)' : isNext ? 'var(--navy)' : 'var(--bg)',
                  color: got ? 'var(--ok)' : isNext ? '#fff' : 'var(--muted)',
                }}
              >
                {s.day}
              </span>
              <span class="grow stack-xs">
                <span class="strong">{s.reward}</span>
                <span class="meta">{s.sub}</span>
              </span>
              <span class={`pill ${got ? 'ok' : isNext ? 'blue' : 'grey'}`}>{got ? 'tercapai' : isNext ? 'berikutnya' : `${s.day - streak} hari`}</span>
            </div>
          );
        })}
      </section>

      <section class="card tint">
        <h2>Cara menghitung</h2>
        <span>Satu hari dihitung kalau ada minimal satu ukuran suhu, pH atau TDS.</span>
        <span>
          Lupa sehari? Ada 1 hari libur tiap bulan, jadi hitungan tidak putus. <Soon />
        </span>
      </section>
    </div>
  );
}
