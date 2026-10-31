import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type PointerEvent as PtrEvent } from 'react'
import { BelumMasuk, cekMasuk, keluar as keluarAkun, masuk as masukAkun } from './api'
import { HALAMAN, HALAMAN_AWAL, KATEGORI, type Halaman } from './halaman'
import { bersihkan, keluar, masuk } from './komponen/gerak'
import { PenyediaToast, wibDetik } from './komponen/ui'
import { Ringkasan } from './pages/Ringkasan'
import { Pengguna } from './pages/Pengguna'
import { BantuanHalaman } from './pages/Bantuan'
import { PemakaianAiHalaman } from './pages/PemakaianAi'
import { KesehatanHalaman } from './pages/Kesehatan'
import { WilayahHalaman } from './pages/Wilayah'
import { CONTOH } from './tipe'

type Tema = 'dark' | 'light'
const KUNCI_TEMA = 'synteel-admin-tema'

function temaAwal(): Tema {
  try {
    const t = localStorage.getItem(KUNCI_TEMA)
    if (t === 'dark' || t === 'light') return t
  } catch {
    /* penyimpanan bisa diblokir — ikut preferensi sistem */
  }
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function halamanAwal(): Halaman {
  // hash bisa memuat sub-bagian (#pengguna/a004) — halaman = segmen pertama
  const h = location.hash.slice(1).split('/')[0] as Halaman
  return HALAMAN.some((x) => x.id === h) ? h : HALAMAN_AWAL
}

/**
 * Navigasi atas per kategori (dari dasbor ops): tombol berjajar dgn penanda yang meluncur;
 * sorot (mouse) / ketuk (sentuh) → sub-halaman turun. Kategori ber-1 halaman langsung pindah.
 */
function NavKategori({ hal, ke }: { hal: Halaman; ke: (h: Halaman) => void }) {
  const [buka, setBuka] = useState<string | null>(null)
  const akar = useRef<HTMLElement>(null)
  const tutupT = useRef<number>()
  const dibukaSorot = useRef(0)
  const sorot = (g: string, banyak: boolean) => (e: PtrEvent) => {
    if (e.pointerType !== 'mouse' || !banyak) return
    clearTimeout(tutupT.current)
    if (buka !== g) dibukaSorot.current = performance.now()
    setBuka(g)
  }
  const tinggal = (e: PtrEvent) => {
    if (e.pointerType !== 'mouse') return
    clearTimeout(tutupT.current)
    tutupT.current = window.setTimeout(() => setBuka(null), 160)
  }
  useEffect(() => () => clearTimeout(tutupT.current), [])
  useEffect(() => {
    if (!buka) return
    const luar = (e: globalThis.MouseEvent) => { if (!akar.current?.contains(e.target as Node)) setBuka(null) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setBuka(null) }
    document.addEventListener('mousedown', luar)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', luar); document.removeEventListener('keydown', esc) }
  }, [buka])
  const kini = HALAMAN.find((x) => x.id === hal)!
  // penanda kategori aktif yang meluncur
  const [ibu, setIbu] = useState<{ x: number; w: number } | null>(null)
  useLayoutEffect(() => {
    const ukur = () => {
      const b = akar.current?.querySelector<HTMLElement>('.kat.aktif')
      if (b) setIbu({ x: (b.parentElement as HTMLElement).offsetLeft, w: b.offsetWidth })
    }
    ukur()
    const ro = new ResizeObserver(ukur); if (akar.current) ro.observe(akar.current)
    return () => ro.disconnect()
  }, [hal])
  return (
    <nav className="nav-kat" ref={akar} aria-label="Bagian">
      {ibu && <span className="kat-ibu" style={{ width: Math.max(12, ibu.w - 28), transform: `translateX(${ibu.x + 14}px)` }} aria-hidden />}
      {KATEGORI.map((g) => {
        const aktif = kini.grup === g
        const sub = HALAMAN.filter((x) => x.grup === g)
        const banyak = sub.length > 1
        return (
          <div key={g} className="kat-bungkus" onPointerEnter={sorot(g, banyak)} onPointerLeave={tinggal}>
            <button
              className={`kat ${aktif ? 'aktif' : ''} ${buka === g ? 'dibuka' : ''}`}
              aria-expanded={banyak ? buka === g : undefined}
              aria-haspopup={banyak ? 'menu' : undefined}
              aria-current={!banyak && aktif ? 'page' : undefined}
              onClick={() => {
                if (!banyak) { ke(sub[0].id); return }
                // klik sesudah sorot membuka menu → biarkan terbuka
                if (performance.now() - dibukaSorot.current < 700) return
                setBuka(buka === g ? null : g)
              }}
            >
              <span className="kat-teks">
                <small>{g}</small>
                <b>{aktif ? kini.label : banyak ? `${sub.length} halaman` : sub[0].label}</b>
              </span>
              {banyak && <span className={`kat-panah ${buka === g ? 'terbuka' : ''}`} aria-hidden>▾</span>}
            </button>
            {buka === g && (
              <div className="menu panel kat-menu" role="menu" aria-label={g}>
                {sub.map((x) => (
                  <button key={x.id} role="menuitem" className={x.id === hal ? 'aktif' : ''} aria-current={x.id === hal ? 'page' : undefined} onClick={() => { ke(x.id); setBuka(null) }}>
                    <span className="ikon-hal" aria-hidden>{x.ikon}</span>
                    <span className="kat-sub"><b>{x.label}</b><small>{x.fokus}</small></span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </nav>
  )
}

/** Masuk dengan nama pengguna dan kata sandi dari berkas env server (SYNTEEL_ADMIN_USER / _PASSWORD). */
function Masuk({ selesai }: { selesai: () => void }) {
  const [user, setUser] = useState('')
  const [sandi, setSandi] = useState('')
  const [galat, setGalat] = useState('')
  const [proses, setProses] = useState(false)
  const kirim = async (e: FormEvent) => {
    e.preventDefault()
    setProses(true)
    setGalat('')
    try {
      await masukAkun(user.trim(), sandi)
      selesai()
    } catch (err) {
      setGalat((err as Error).message)
      setProses(false)
    }
  }
  return (
    <main className="layar-masuk">
      <form className="panel kartu-masuk" onSubmit={kirim}>
        <div className="merek merek-masuk">
          <svg viewBox="0 0 24 24" className="logo" aria-hidden>
            <rect x="2" y="2" width="20" height="20" rx="6" fill="currentColor" />
            <path d="M5 13.5c2.3 0 2.3-2 4.7-2s2.3 2 4.6 2 2.4-2 4.7-2M5 17.5c2.3 0 2.3-2 4.7-2s2.3 2 4.6 2 2.4-2 4.7-2" fill="none" stroke="var(--panel)" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <b className="kata-merek">synteel</b>
          <span className="kata-ops">admin</span>
        </div>
        <label className="isian-masuk">
          <span>Nama pengguna</span>
          <input autoComplete="username" value={user} onChange={(e) => setUser(e.target.value)} required autoFocus />
        </label>
        <label className="isian-masuk">
          <span>Kata sandi</span>
          <input type="password" autoComplete="current-password" value={sandi} onChange={(e) => setSandi(e.target.value)} required />
        </label>
        {galat && <p className="galat-masuk" role="alert">{galat}</p>}
        <button type="submit" className="tombol utama" disabled={proses || !user.trim() || !sandi}>{proses ? 'Memeriksa…' : 'Masuk'}</button>
      </form>
    </main>
  )
}

export default function App() {
  // null = sedang memeriksa sesi
  const [admin, setAdmin] = useState<boolean | null>(CONTOH ? true : null)
  useEffect(() => {
    if (CONTOH) return
    cekMasuk().then(() => setAdmin(true)).catch((e) => setAdmin(e instanceof BelumMasuk ? false : true))
    const habis = () => setAdmin(false)
    window.addEventListener('admin-keluar', habis)
    return () => window.removeEventListener('admin-keluar', habis)
  }, [])
  if (admin === null) return <main className="layar-masuk"><p className="redup-teks">Memuat…</p></main>
  if (!admin) return <Masuk selesai={() => setAdmin(true)} />
  return <Dasbor keluar={() => keluarAkun().finally(() => setAdmin(false))} />
}

function Dasbor({ keluar: keluarDasbor }: { keluar: () => void }) {
  const [hal, setHal] = useState<Halaman>(halamanAwal)
  const [jam, setJam] = useState(() => new Date())
  const [tema, setTema] = useState<Tema>(temaAwal)

  useEffect(() => {
    document.documentElement.dataset.theme = tema
    try {
      localStorage.setItem(KUNCI_TEMA, tema)
    } catch {
      /* abaikan */
    }
  }, [tema])

  useEffect(() => {
    const t = setInterval(() => setJam(new Date()), 1000)
    const h = () => setHal(halamanAwal())
    window.addEventListener('hashchange', h)
    return () => {
      clearInterval(t)
      window.removeEventListener('hashchange', h)
    }
  }, [])

  // Transisi antarhalaman: keluar bertahap → tukar isi → masuk bertahap (komponen/gerak.ts)
  const layar = useRef<HTMLDivElement>(null)
  const sedang = useRef(false)
  const ke = (h: Halaman) => {
    if (h === hal || sedang.current) return
    sedang.current = true
    const akar = layar.current
    ;(akar ? keluar(akar) : Promise.resolve()).then(() => {
      location.hash = h
      setHal(h)
      sedang.current = false
    })
  }
  useLayoutEffect(() => {
    const akar = layar.current
    if (!akar) return
    bersihkan(akar)
    masuk(akar)
    akar.querySelector<HTMLElement>('.tengah')?.scrollTo?.({ top: 0 })
    document.title = `${HALAMAN.find((x) => x.id === hal)!.label} · synteel admin`
  }, [hal])

  const info = HALAMAN.find((x) => x.id === hal)!

  return (
    <PenyediaToast>
      <a href="#isi" className="lompat">Lompat ke isi</a>
      <div className="layar" ref={layar}>
        <header className="atas">
          <button className="merek" onClick={() => ke(HALAMAN_AWAL)} aria-label="synteel admin — ke Ringkasan" title="Ringkasan">
            {/* tanda synteel (sementara): gelombang tambak di dalam kotak — ganti dgn logo resmi */}
            <svg viewBox="0 0 24 24" className="logo" aria-hidden>
              <rect x="2" y="2" width="20" height="20" rx="6" fill="currentColor" />
              <path d="M5 13.5c2.3 0 2.3-2 4.7-2s2.3 2 4.6 2 2.4-2 4.7-2M5 17.5c2.3 0 2.3-2 4.7-2s2.3 2 4.6 2 2.4-2 4.7-2" fill="none" stroke="var(--panel)" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            <b className="kata-merek">synteel</b>
            <span className="kata-ops">admin</span>
          </button>
          <NavKategori hal={hal} ke={ke} />
          <div className="sela" />
          {CONTOH && <span className="lencana-contoh" title="Semua angka di halaman ini adalah data contoh dari src/mock.ts">DATA CONTOH</span>}
          <div className="chip jam" aria-label={`Waktu sekarang ${wibDetik(jam)} WIB`}>
            <span><small>WAKTU</small><b>{wibDetik(jam)} WIB</b></span>
          </div>
          <button className="ikon-kotak tema" onClick={() => setTema(tema === 'dark' ? 'light' : 'dark')} aria-label={tema === 'dark' ? 'Ganti ke tema terang' : 'Ganti ke tema gelap'} title={tema === 'dark' ? 'Tema terang' : 'Tema gelap'}>
            <span aria-hidden>{tema === 'dark' ? '☀' : '☾'}</span>
          </button>
          <button className="tombol keluar" onClick={keluarDasbor} title="Keluar dari dasbor admin">Keluar</button>
        </header>

        <main className="tengah mode-isi" id="isi" tabIndex={-1}>
          <header className="judul-hal">
            <h1>{info.label}</h1>
            <p>{info.fokus}</p>
          </header>
          {hal === 'ringkasan' ? <Ringkasan ke={ke} />
            : hal === 'pengguna' ? <Pengguna />
            : hal === 'bantuan' ? <BantuanHalaman />
            : hal === 'ai' ? <PemakaianAiHalaman />
            : hal === 'kesehatan' ? <KesehatanHalaman />
            : <WilayahHalaman />}
        </main>
      </div>
    </PenyediaToast>
  )
}
