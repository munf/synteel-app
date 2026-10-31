// Grafik — bahasa visual sama dgn dasbor ops. Aturan (lihat README):
//  · satu sumbu Y saja · legenda bila ≥2 seri · tooltip saat sorot/fokus batang
//  · batang tipis, ujung atas membulat 4px, celah 2px antarsegmen
//  · warna seri kategori lewat --seri-1..4 (urutan tetap); warna status hanya untuk status
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { angka, pts } from './ui'

export interface Seri { nama: string; warna: string; nilai: number[] }

/** Lebar wadah dalam px (grafik digambar pada ukuran asli → teks tak ikut mengecil di HP). */
function useLebar<T extends HTMLElement>(awal = 600) {
  const ref = useRef<T>(null)
  const [w, setW] = useState(awal)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ukur = () => setW(Math.max(160, Math.floor(el.clientWidth)))
    ukur()
    const ro = new ResizeObserver(ukur)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

/** Skala "rapi": batas atas & langkah kelipatan 1/2/5 × 10^k. */
export function skalaRapi(maks: number, n = 4) {
  if (maks <= 0) return { atas: n, langkah: 1 }
  const kasar = maks / n
  const p = 10 ** Math.floor(Math.log10(kasar))
  // jumlah (akun, catatan, panggilan) selalu bulat: langkah paling kecil 1
  const langkah = Math.max(1, [1, 2, 5, 10].map((m) => m * p).find((s) => s >= kasar) ?? 10 * p)
  return { atas: Math.ceil(maks / langkah) * langkah, langkah }
}

/** Batang dgn ujung atas membulat (r ≤ 4px), dasar rata di garis nol. */
function batangAtas(x: number, y: number, w: number, h: number, r = 4) {
  const q = Math.min(r, w / 2, h)
  return `M${x},${y + h}V${y + q}Q${x},${y} ${x + q},${y}H${x + w - q}Q${x + w},${y} ${x + w},${y + q}V${y + h}Z`
}

export function Legenda({ seri, total }: { seri: Seri[]; total?: boolean }) {
  return (
    <ul className="legenda-seri" aria-label="Legenda">
      {seri.map((s) => (
        <li key={s.nama}>
          <i style={{ background: s.warna }} aria-hidden />
          {s.nama}
          {total && <b className="mono">{angka(s.nilai.reduce((a, b) => a + b, 0))}</b>}
        </li>
      ))}
    </ul>
  )
}

/**
 * Grafik batang: satu seri, bertumpuk, atau berkelompok. Tiap kolom = target sorot/fokus
 * (lebih lebar dari batangnya) dgn tooltip & aria-label berisi semua nilai.
 */
export function Batang({
  label, labelPanjang, seri, mode = 'tumpuk', tinggi = 210, satuan = '', ringkas = false, maks, judul, legenda, tabel = false,
}: {
  label: string[]; labelPanjang?: string[]; seri: Seri[]; mode?: 'tumpuk' | 'kelompok'; tinggi?: number; satuan?: string
  ringkas?: boolean; maks?: number; judul: string; legenda?: boolean; tabel?: boolean
}) {
  const [ref, lebar] = useLebar<HTMLDivElement>()
  const [aktif, setAktif] = useState<number | null>(null)
  const n = label.length
  const totalKolom = label.map((_, i) => seri.reduce((a, s) => a + (s.nilai[i] ?? 0), 0))
  const tertinggi = mode === 'tumpuk' ? Math.max(...totalKolom) : Math.max(...seri.flatMap((s) => s.nilai))
  const { atas, langkah } = skalaRapi(maks ?? tertinggi, ringkas ? 2 : 4)
  const kiri = ringkas ? 4 : 40
  const kanan = 4
  const atasPad = ringkas ? 16 : 8
  const bawah = 22
  const plotW = lebar - kiri - kanan
  const plotH = tinggi - atasPad - bawah
  const band = plotW / n
  const Y = (v: number) => atasPad + plotH - (v / atas) * plotH
  const tampilLegenda = legenda ?? seri.length >= 2
  const loncat = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / (ringkas ? 80 : 54)))))
  const ket = (i: number) => labelPanjang?.[i] ?? label[i]
  const ariaKolom = (i: number) =>
    `${ket(i)}: ` + seri.map((s) => `${s.nama} ${angka(s.nilai[i])}${satuan}`).join(', ') + (seri.length > 1 && mode === 'tumpuk' ? `, total ${angka(totalKolom[i])}${satuan}` : '')

  const kisi: number[] = []
  for (let v = 0; v <= atas + 1e-9; v += langkah) kisi.push(v)

  return (
    <figure className={`grafik ${ringkas ? 'ringkas' : ''}`}>
      {tampilLegenda && <Legenda seri={seri} />}
      <div className="grafik-kanvas" ref={ref} onMouseLeave={() => setAktif(null)}>
        <svg width={lebar} height={tinggi} role="group" aria-label={judul}>
          {/* kisi & sumbu Y (satu sumbu saja) */}
          {kisi.map((v) => (
            <g key={v} aria-hidden>
              <line x1={kiri} x2={lebar - kanan} y1={Y(v)} y2={Y(v)} className={v === 0 ? 'nol' : 'kisi'} />
              {!ringkas && <text x={kiri - 7} y={Y(v) + 3.5} textAnchor="end" className="sumbu">{angka(v)}</text>}
            </g>
          ))}
          {ringkas && <text x={kiri} y={10} className="sumbu" aria-hidden>{angka(atas)}</text>}
          {/* sorot kolom */}
          {aktif !== null && <rect x={kiri + aktif * band + 1} y={atasPad} width={band - 2} height={plotH} rx={4} className="sorot-kolom" aria-hidden />}
          {/* batang */}
          {label.map((_, i) => {
            const x0 = kiri + i * band
            if (mode === 'tumpuk') {
              const w = Math.max(3, Math.min(ringkas ? 14 : 22, band * 0.58))
              const x = x0 + (band - w) / 2
              let dasar = 0
              const idxAtas = seri.map((s) => s.nilai[i] ?? 0).reduce((a, v, j) => (v > 0 ? j : a), -1)
              return (
                <g key={i} aria-hidden>
                  {seri.map((s, j) => {
                    const v = s.nilai[i] ?? 0
                    if (v <= 0) return null
                    const yAtas = Y(dasar + v)
                    const yBawah = Y(dasar) - (dasar > 0 ? 2 : 0) // celah 2px antarsegmen
                    dasar += v
                    const h = Math.max(0.5, yBawah - yAtas)
                    return j === idxAtas
                      ? <path key={s.nama} d={batangAtas(x, yAtas, w, h)} fill={s.warna} data-tumbuh="y" />
                      : <rect key={s.nama} x={x} y={yAtas} width={w} height={h} fill={s.warna} data-tumbuh="y" />
                  })}
                </g>
              )
            }
            const k = seri.length
            const w = Math.max(2, Math.min(10, (band * 0.7 - (k - 1) * 2) / k))
            const lebarGrup = k * w + (k - 1) * 2
            return (
              <g key={i} aria-hidden>
                {seri.map((s, j) => {
                  const v = s.nilai[i] ?? 0
                  if (v <= 0) return null
                  const h = Y(0) - Y(v)
                  return <path key={s.nama} d={batangAtas(x0 + (band - lebarGrup) / 2 + j * (w + 2), Y(v), w, h)} fill={s.warna} data-tumbuh="y" />
                })}
              </g>
            )
          })}
          {/* label X */}
          {label.map((l, i) =>
            (ringkas ? i === 0 || i === n - 1 : (n - 1 - i) % loncat === 0) ? (
              <text key={i} x={kiri + i * band + band / 2} y={tinggi - 6} textAnchor={ringkas ? (i === 0 ? 'start' : 'end') : 'middle'} className="sumbu" aria-hidden>{l}</text>
            ) : null,
          )}
          {/* target sorot/fokus — selebar kolom, setinggi plot */}
          {label.map((_, i) => (
            <rect
              key={i} x={kiri + i * band} y={atasPad} width={band} height={plotH} className="kena" tabIndex={0} role="img" aria-label={ariaKolom(i)}
              onMouseEnter={() => setAktif(i)} onFocus={() => setAktif(i)} onBlur={() => setAktif(null)}
            />
          ))}
        </svg>
        {aktif !== null && (
          <div
            className="tip" role="presentation"
            style={{ left: Math.min(Math.max(kiri + aktif * band + band / 2, 70), lebar - 70), top: Math.max(0, Y(mode === 'tumpuk' ? totalKolom[aktif] : Math.max(...seri.map((s) => s.nilai[aktif] ?? 0)))) - 8 }}
          >
            <b>{ket(aktif)}</b>
            {seri.map((s) => (
              <span key={s.nama}>{seri.length > 1 && <i style={{ background: s.warna }} />}{s.nama}<em className="mono">{angka(s.nilai[aktif])}{satuan}</em></span>
            ))}
            {seri.length > 1 && mode === 'tumpuk' && <span className="tip-total">Total<em className="mono">{angka(totalKolom[aktif])}{satuan}</em></span>}
          </div>
        )}
      </div>
      {tabel && (
        <details className="tabel-data">
          <summary>Lihat sebagai tabel</summary>
          <div className="gulir-x">
            <table className="tabel rapat">
              <thead><tr><th scope="col">Tanggal</th>{seri.map((s) => <th key={s.nama} scope="col">{s.nama}</th>)}{seri.length > 1 && <th scope="col">Total</th>}</tr></thead>
              <tbody>
                {label.map((_, i) => (
                  <tr key={i}><th scope="row">{ket(i)}</th>{seri.map((s) => <td key={s.nama} className="mono">{angka(s.nilai[i])}</td>)}{seri.length > 1 && <td className="mono">{angka(totalKolom[i])}</td>}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </figure>
  )
}

/** Batang horizontal satu seri (peringkat), nilai tertulis di ujung. */
export function BatangDatar({ baris, warna = 'var(--seri-1)', satuan = '', judul }: { baris: { label: string; nilai: number }[]; warna?: string; satuan?: string; judul: string }) {
  const maks = Math.max(1, ...baris.map((b) => b.nilai))
  return (
    <ul className="batang-datar" aria-label={judul}>
      {baris.map((b) => (
        <li key={b.label}>
          <span className="bd-label">{b.label}</span>
          <span className="bd-jalur" aria-hidden><i data-tumbuh="x" style={{ width: `${(b.nilai / maks) * 100}%`, background: warna }} /></span>
          <b className="mono">{angka(b.nilai)}{satuan}</b>
        </li>
      ))}
    </ul>
  )
}

/** Cincin progres. */
export function Cincin({ p, ukuran = 108, warna = 'var(--accent)', children, label }: { p: number; ukuran?: number; warna?: string; children?: ReactNode; label?: string }) {
  const r = ukuran / 2 - 9
  const k = 2 * Math.PI * r
  return (
    <div className="cincin" style={{ width: ukuran, height: ukuran }} role={label ? 'img' : undefined} aria-label={label}>
      <svg viewBox={`0 0 ${ukuran} ${ukuran}`} aria-hidden>
        <circle cx={ukuran / 2} cy={ukuran / 2} r={r} className="cincin-jalur" />
        <circle cx={ukuran / 2} cy={ukuran / 2} r={r} stroke={warna} className="cincin-isi" strokeDasharray={`${k * p} ${k}`} transform={`rotate(-90 ${ukuran / 2} ${ukuran / 2})`} />
      </svg>
      <div className="cincin-teks">{children}</div>
    </div>
  )
}

/** Donat komposisi (legenda selalu tampil). */
export function Donat({ bagian, ukuran = 150, tengah }: { bagian: { label: string; nilai: number; warna: string }[]; ukuran?: number; tengah: ReactNode }) {
  const total = bagian.reduce((a, b) => a + b.nilai, 0)
  const r = ukuran / 2 - 14
  const k = 2 * Math.PI * r
  let jalan = 0
  return (
    <div className="donat">
      <div className="cincin" style={{ width: ukuran, height: ukuran }}>
        <svg viewBox={`0 0 ${ukuran} ${ukuran}`} aria-hidden>
          <circle cx={ukuran / 2} cy={ukuran / 2} r={r} className="cincin-jalur" />
          {bagian.map((b) => {
            const pj = (b.nilai / total) * k
            const el = <circle key={b.label} cx={ukuran / 2} cy={ukuran / 2} r={r} stroke={b.warna} className="cincin-isi donat-isi" strokeDasharray={`${Math.max(0, pj - 3)} ${k}`} strokeDashoffset={-jalan} transform={`rotate(-90 ${ukuran / 2} ${ukuran / 2})`} />
            jalan += pj
            return el
          })}
        </svg>
        <div className="cincin-teks">{tengah}</div>
      </div>
      <div className="donat-legenda">
        {bagian.map((b) => (
          <div key={b.label} className="baris kecil">
            <span><i style={{ background: b.warna }} aria-hidden /> {b.label}</span>
            <span className="mono">{angka(b.nilai)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Grafik area sederhana dgn label tanggal (dari dasbor ops; satu seri, tanpa tooltip). */
export function Area({ v, label, lebar = 760, tinggi = 220, warna = 'var(--accent)' }: { v: number[]; label: string[]; lebar?: number; tinggi?: number; warna?: string }) {
  if (v.length < 2) return null
  const maks = Math.max(...v) * 1.15 || 1
  const X = (i: number) => 34 + (i / (v.length - 1)) * (lebar - 44)
  const Y = (y: number) => tinggi - 24 - (y / maks) * (tinggi - 40)
  const garis = v.map((y, i) => [X(i), Y(y)] as [number, number])
  const area = [...garis, [X(v.length - 1), Y(0)], [X(0), Y(0)]] as [number, number][]
  const langkah = Math.ceil(v.length / 8)
  return (
    <svg viewBox={`0 0 ${lebar} ${tinggi}`} className="area-target" aria-hidden>
      <defs>
        <linearGradient id="isi-area2" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={warna} stopOpacity="0.4" />
          <stop offset="1" stopColor={warna} stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <g key={f}>
          <line x1={34} x2={lebar - 10} y1={Y(maks * f)} y2={Y(maks * f)} className="kisi" />
          <text x={28} y={Y(maks * f) + 3} textAnchor="end" className="sumbu">{Math.round(maks * f)}</text>
        </g>
      ))}
      <polygon points={pts(area)} fill="url(#isi-area2)" />
      <polyline points={pts(garis)} className="area-garis" style={{ stroke: warna }} />
      {label.map((l, i) => (i % langkah === 0 || i === label.length - 1) && <text key={i} x={X(i)} y={tinggi - 6} textAnchor="middle" className="sumbu">{l}</text>)}
    </svg>
  )
}
