import type { FarmState } from '../api.ts';
import type { Go } from '../app.tsx';
import { setPrefs, usePrefs, type Prefs } from '../prefs.ts';
import { Icon, Soon, Switch, Tick, type IconName } from '../ui.tsx';

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

const initialOf = (name: string | undefined) => (name ?? 'S').replace(/^tambak\s+/i, '').trim().charAt(0).toUpperCase() || 'S';

export function Profile({ state, go }: { state: FarmState; go: Go }) {
  const prefs = usePrefs();
  const todayLogged = state.ponds.some((p) =>
    Object.values(p.latest).some((r) => r && new Date(r.at).toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' }) === state.today),
  );
  const days = week(state.streak, todayLogged);
  const actions: { label: string; sub: string; icon: IconName; onClick?: () => void }[] = [
    { label: 'Catat sekarang', sub: 'Suara, foto atau ketik', icon: 'mic', onClick: () => go({ name: 'record' }) },
    { label: 'Telepon ahli', sub: 'Penyuluh perikanan', icon: 'phone' },
    { label: 'Laporan mingguan', sub: 'Mati, suhu, pakan', icon: 'chart' },
    { label: 'Undang anggota', sub: 'Pemilik atau pekerja', icon: 'user' },
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
          <span class="avatar lg">{initialOf(state.farm?.name)}</span>
          <div class="stack-xs">
            <span class="label" style={{ color: 'var(--on-navy-2)' }}>
              Halo,
            </span>
            <span class="title" style={{ lineHeight: 1.1 }}>
              {state.farm?.name}
            </span>
            <span class="label" style={{ color: '#C9D4EA' }}>
              {state.farm?.locationName ?? 'Lokasi belum diatur'}
            </span>
          </div>
        </div>
        <div class="stack-sm" style={{ background: 'rgba(255,255,255,0.08)', borderRadius: 16, padding: 16 }}>
          <div class="row between">
            <span class="strong">{state.streak} hari mencatat beruntun</span>
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

      <section class="grid2">
        {actions.map((a) => (
          <button key={a.label} class="card" style={{ border: 0, textAlign: 'left', gap: 12, justifyContent: 'flex-start' }} onClick={a.onClick} disabled={!a.onClick}>
            <span class="row between" style={{ width: '100%' }}>
              <span class="icon-box">
                <Icon name={a.icon} />
              </span>
              {!a.onClick && <Soon />}
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
        <div class="grid3" role="radiogroup" aria-label="Ukuran huruf">
          {sizes.map((s, i) => {
            const on = prefs.textSize === i;
            return (
              <button
                key={s.label}
                role="radio"
                aria-checked={on}
                onClick={() => setPrefs({ textSize: i as Prefs['textSize'] })}
                style={{ position: 'relative', minHeight: 96, borderRadius: 16, background: '#fff', border: on ? '3px solid var(--navy)' : '2px solid var(--line-2)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '0 4px' }}
              >
                <span style={{ fontSize: s.px, fontWeight: 800, lineHeight: 1 }}>Aa</span>
                <span class="label semi">{s.label}</span>
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
        <div class="list-row" style={{ minHeight: 80 }}>
          <div class="grow stack-xs">
            <span class="semi">Alarm cek malam</span>
            <span class="meta">Bunyi keras walau HP senyap</span>
          </div>
          <Soon />
          <Switch checked={false} label="Alarm cek malam" disabled />
        </div>
        <div class="list-row" style={{ minHeight: 80 }}>
          <div class="grow stack-xs">
            <span class="semi">Teruskan ke pemilik</span>
            <span class="meta">Kalau alarm tak dijawab 10 menit</span>
          </div>
          <Soon />
          <Switch checked={false} label="Teruskan ke pemilik" disabled />
        </div>
        <div class="list-row" style={{ minHeight: 80 }}>
          <div class="grow stack-xs">
            <span class="semi">Detail teknis terbuka</span>
            <span class="meta">Grafik dan angka langsung tampil</span>
          </div>
          <Switch checked={prefs.techOpen} label="Detail teknis terbuka" onChange={(v) => setPrefs({ techOpen: v })} />
        </div>
      </section>

      <section class="card">
        <div class="row top">
          <span class="icon-box">
            <Icon name="heart" />
          </span>
          <div class="grow stack-xs">
            <h2>Bantu kembangkan Synteel</h2>
            <span class="label ink2">Izinkan foto, video dan catatan dipakai untuk membuat AI lebih tepat membaca kolam.</span>
          </div>
          <Switch checked={prefs.shareData} label="Izinkan data dipakai untuk melatih AI" onChange={(v) => setPrefs({ shareData: v })} />
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
            Lihat atau hapus data saya
          </span>
          <Soon />
        </div>
      </section>

      <section class="card">
        <div class="row between">
          <h2>Anggota tambak</h2>
          <Soon />
        </div>
        <p class="ink2">Pemilik dan pekerja bisa memakai tambak yang sama, masing-masing dari HP sendiri.</p>
      </section>
    </div>
  );
}

export function Rewards({ state, go }: { state: FarmState; go: Go }) {
  const streak = state.streak;
  const nextAt = streak < 7 ? 7 : streak < 14 ? 14 : streak < 30 ? 30 : 60;
  const ladder = [
    { day: 7, reward: '+10 jatah baca AI', sub: 'Seminggu penuh' },
    { day: 14, reward: '+20 jatah baca AI', sub: 'Dua minggu penuh' },
    { day: 30, reward: 'Laporan bulanan', sub: 'Ringkasan kolam untuk pembeli atau bank' },
    { day: 60, reward: 'Hadiah mitra', sub: 'mis. potongan harga pakan' },
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
          {Array.from({ length: nextAt > 14 ? 14 : nextAt }, (_, i) => {
            const offset = nextAt > 14 ? nextAt - 14 : 0;
            const day = offset + i + 1;
            return <span key={i} style={{ height: 12, borderRadius: 4, background: day <= streak ? 'var(--accent)' : 'rgba(255,255,255,0.15)' }} />;
          })}
        </div>
        <p>
          {streak >= 60 ? 'Semua tangga hadiah sudah tercapai.' : `Catat ${nextAt - streak} hari lagi untuk hadiah hari ke-${nextAt}.`}
        </p>
      </section>

      <section class="card">
        <div class="row top between">
          <div class="stack-xs">
            <h2>Hadiah hari ini</h2>
            <span class="meta">Laporan lengkap: video + foto kolam</span>
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
