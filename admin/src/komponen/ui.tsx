// Komponen dasar — disalin dari dasbor ops (synt-metrics) lalu dibersihkan dari hal khusus synt.
// Bahasa tampilan: Indonesia. Warna lewat token di styles.css.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { kini as sekarang, type Status } from '../tipe'

export const WARNA_STATUS: Record<Status, string> = { normal: 'var(--ok)', degraded: 'var(--warn)', critical: 'var(--bad)', off: 'var(--redup)' }
export const LABEL_STATUS: Record<Status, string> = { normal: 'Normal', degraded: 'Terganggu', critical: 'Kritis', off: 'Jeda' }

/** Pil status — warna status SELALU berpasangan dgn label teks. */
export function Pill({ s, children }: { s: Status; children?: ReactNode }) {
  return <span className={`pill p-${s}`}><span className="titik" style={{ background: WARNA_STATUS[s] }} aria-hidden />{children ?? LABEL_STATUS[s]}</span>
}

export function Titik({ s }: { s: Status }) {
  return <span className="titik" style={{ background: WARNA_STATUS[s], boxShadow: s === 'critical' ? `0 0 6px ${WARNA_STATUS[s]}` : 'none' }} aria-hidden />
}

export function Panel({ judul, aksi, children, className = '', id }: { judul?: ReactNode; aksi?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section className={`panel ${className}`} aria-labelledby={id}>
      {(judul || aksi) && (
        <div className="baris kepala">
          {judul && <h2 id={id}>{judul}</h2>}
          {aksi}
        </div>
      )}
      {children}
    </section>
  )
}

export function Bar({ v, warna, label }: { v: number; warna?: string; label?: string }) {
  return (
    <div className="bar" role={label ? 'img' : undefined} aria-label={label}>
      <i style={{ width: `${Math.max(2, Math.min(1, v) * 100)}%`, background: warna }} />
    </div>
  )
}

export const pts = (p: [number, number][]) => p.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(' ')

export function Spark({ v, w = 110, h = 26, color = 'var(--accent)' }: { v: number[]; w?: number; h?: number; color?: string }) {
  if (!v || v.length < 2) return <svg width={w} height={h} className="spark" aria-hidden />
  const min = Math.min(...v)
  const max = Math.max(...v)
  const p = v.map((y, i) => [(i / (v.length - 1)) * w, h - ((y - min) / (max - min || 1)) * (h - 4) - 2] as [number, number])
  return (
    <svg width={w} height={h} className="spark" aria-hidden>
      <polyline points={pts(p)} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" />
    </svg>
  )
}

export function Gauge({ used }: { used: number }) {
  // busur 220°, aksen → kuning → merah sesuai pemakaian
  const r = 74
  const awal = 160
  const sapu = 220
  const titik = (deg: number) => {
    const a = (deg * Math.PI) / 180
    return [90 + r * Math.cos(a), 92 + r * Math.sin(a)]
  }
  const busur = (a0: number, a1: number) => {
    const [x0, y0] = titik(a0)
    const [x1, y1] = titik(a1)
    return `M${x0},${y0} A${r},${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1},${y1}`
  }
  const akhir = awal + sapu * Math.min(1, used)
  const warna = used > 0.85 ? 'var(--bad)' : used > 0.6 ? 'var(--warn)' : 'var(--accent)'
  return (
    <svg viewBox="0 0 180 130" className="gauge" aria-hidden>
      <path d={busur(awal, awal + sapu)} stroke="var(--track)" strokeWidth={14} fill="none" strokeLinecap="round" />
      {used > 0.005 && <path d={busur(awal, akhir)} stroke={warna} strokeWidth={14} fill="none" strokeLinecap="round" />}
      {Array.from({ length: 23 }, (_, i) => {
        const [x0, y0] = titik(awal + (sapu / 22) * i)
        return <line key={i} x1={90 + (x0 - 90) * 0.8} y1={92 + (y0 - 92) * 0.8} x2={90 + (x0 - 90) * 0.86} y2={92 + (y0 - 92) * 0.86} stroke="var(--tick)" strokeWidth={1} />
      })}
    </svg>
  )
}

/** Keadaan kosong yang jujur. */
export function Kosong({ judul, teks, langkah }: { judul: string; teks: string; langkah?: string[] }) {
  return (
    <div className="kosong">
      <b>{judul}</b>
      <p>{teks}</p>
      {langkah && <ol>{langkah.map((l) => <li key={l}>{l}</li>)}</ol>}
    </div>
  )
}

export function Muat({ galat }: { galat?: string }) {
  return <div className="muat" role="status">{galat ? `Data tidak tersedia — ${galat}` : 'Memuat…'}</div>
}

/** Ubin KPI: label kecil · angka besar · keterangan. */
export function Kpi({ label, nilai, satuan, ket, aksen, children }: { label: string; nilai: ReactNode; satuan?: string; ket?: ReactNode; aksen?: boolean; children?: ReactNode }) {
  return (
    <div className={`kpi ${aksen ? 'aksen' : ''}`}>
      <small>{label}</small>
      <b><span data-angka>{nilai}</span>{satuan && <em>{satuan}</em>}</b>
      {ket && <span className="redup-teks">{ket}</span>}
      {children}
    </div>
  )
}

// ── format ──
const FA = new Intl.NumberFormat('id-ID')
export const angka = (n: number | null | undefined) => (n === null || n === undefined ? '—' : FA.format(n))
export const persen = (n: number, des = 0) => (Number.isFinite(n) ? `${(n * 100).toFixed(des).replace('.', ',')}%` : '—')

// Waktu ditampilkan dalam WIB (Asia/Jakarta, UTC+7).
const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', hour12: false, ...o })
const FJ = fmt({ hour: '2-digit', minute: '2-digit' })
const FJD = fmt({ hour: '2-digit', minute: '2-digit', second: '2-digit' })
const FT = fmt({ day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const FTGL = fmt({ day: 'numeric', month: 'short', year: 'numeric' })
const FHB = new Intl.DateTimeFormat('id-ID', { timeZone: 'UTC', day: 'numeric', month: 'short' })
export const wib = (x: string | number | Date) => FJ.format(new Date(x))
export const wibDetik = (x: string | number | Date) => FJD.format(new Date(x))
export const wibTgl = (x: string | number | Date) => FT.format(new Date(x))
export const tanggal = (x: string | number | Date | null) => (x === null ? '—' : FTGL.format(new Date(x)))
/** '2026-10-31' → '31 Okt' */
export const hariBulan = (iso: string) => FHB.format(new Date(iso + 'T00:00:00Z'))

/** "3 jam lalu" relatif ke `kini` (data contoh memakai waktu tetap); null → "—". */
export function lalu(x: string | null, kini: Date = sekarang()) {
  if (x === null) return '—'
  const d = (kini.getTime() - new Date(x).getTime()) / 1000
  if (d < 90) return 'baru saja'
  if (d < 3600) return `${Math.round(d / 60)} mnt lalu`
  if (d < 86400) return `${Math.round(d / 3600)} jam lalu`
  return `${Math.round(d / 86400)} hari lalu`
}

// ── memuat data dari api.ts ──
export function useData<T>(ambil: () => Promise<T>) {
  const [data, setData] = useState<T>()
  const [galat, setGalat] = useState<string>()
  useEffect(() => {
    let hidup = true
    ambil().then((d) => hidup && setData(d)).catch((e: Error) => hidup && setGalat(e.message))
    return () => { hidup = false }
  }, [ambil])
  return { data, setData, galat }
}

// ── toast (aria-live) ──
type Toast = { id: number; teks: string; jenis: 'ok' | 'info' }
const KonteksToast = createContext<(teks: string, jenis?: Toast['jenis']) => void>(() => undefined)
export const useToast = () => useContext(KonteksToast)

export function PenyediaToast({ children }: { children: ReactNode }) {
  const [daftar, setDaftar] = useState<Toast[]>([])
  const n = useRef(0)
  const tampil = useCallback((teks: string, jenis: Toast['jenis'] = 'ok') => {
    const id = ++n.current
    setDaftar((d) => [...d.slice(-2), { id, teks, jenis }])
    setTimeout(() => setDaftar((d) => d.filter((t) => t.id !== id)), 4200)
  }, [])
  return (
    <KonteksToast.Provider value={tampil}>
      {children}
      <div className="toast-wadah" role="status" aria-live="polite">
        {daftar.map((t) => (
          <div key={t.id} className={`toast t-${t.jenis}`}>
            <span aria-hidden>{t.jenis === 'ok' ? '✓' : 'i'}</span>
            <p>{t.teks}</p>
            <button className="ikon-tutup" aria-label="Tutup pemberitahuan" onClick={() => setDaftar((d) => d.filter((x) => x.id !== t.id))}>×</button>
          </div>
        ))}
      </div>
    </KonteksToast.Provider>
  )
}
