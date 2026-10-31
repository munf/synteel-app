// Gambaran wilayah — untuk mitra & dinas. Semua angka agregat tanpa nama; kabupaten dgn
// < 3 tambak tak dikirim server (tampil sebagai petak abu); tamu demo tak dihitung.
import { useState } from 'react'
import { ambilWilayah } from '../api'
import { Batang, BatangDatar } from '../komponen/grafik'
import { angka, Kosong, Muat, Panel, useData, wibTgl } from '../komponen/ui'
import type { Wilayah } from '../tipe'

/** kelas skala berurutan (satu warna, muda → tua) — warna di --seq-1..5 */
// sesuai jumlah tambak sidat per kabupaten saat ini; naikkan batasnya bila tambak bertambah
const KELAS = [
  { min: 3, max: 4, label: '3–4' },
  { min: 5, max: 6, label: '5–6' },
  { min: 7, max: 9, label: '7–9' },
  { min: 10, max: 14, label: '10–14' },
  { min: 15, max: Infinity, label: '15+' },
]
const kelasDari = (n: number) => KELAS.findIndex((k) => n >= k.min && n <= k.max) + 1

function PetaPetak({ sebaran }: { sebaran: Wilayah['sebaran'] }) {
  const [sorot, setSorot] = useState<Wilayah['sebaran'][number] | null>(null)
  const kol = Math.max(...sebaran.map((s) => s.kol)) + 1
  const baris = Math.max(...sebaran.map((s) => s.baris)) + 1
  const ket = (s: Wilayah['sebaran'][number]) =>
    s.tambak === null ? `${s.kabupaten}, ${s.provinsi}: tidak ditampilkan (kurang dari 3 tambak)` : `${s.kabupaten}, ${s.provinsi}: ${angka(s.tambak)} tambak, ${angka(s.kolam)} kolam`
  return (
    <figure className="peta-petak">
      <div className="gulir-x" tabIndex={-1}>
        <div className="petak-grid" style={{ gridTemplateColumns: `repeat(${kol}, minmax(58px, 1fr))`, gridTemplateRows: `repeat(${baris}, auto)` }} role="list" aria-label="Sebaran tambak per kabupaten">
          {sebaran.map((s) => {
            const k = s.tambak === null ? 0 : kelasDari(s.tambak)
            return (
              <div
                key={s.kabupaten} role="listitem" tabIndex={0} aria-label={ket(s)} title={ket(s)}
                className={`petak ${k ? `seq-${k}` : 'tersembunyi'} ${sorot?.kabupaten === s.kabupaten ? 'disorot' : ''}`}
                style={{ gridColumn: s.kol + 1, gridRow: s.baris + 1 }}
                onMouseEnter={() => setSorot(s)} onFocus={() => setSorot(s)} onMouseLeave={() => setSorot(null)} onBlur={() => setSorot(null)}
              >
                <span className="petak-nama">{s.kabupaten}</span>
                <b className="mono">{s.tambak === null ? '—' : angka(s.tambak)}</b>
              </div>
            )
          })}
        </div>
      </div>
      <figcaption className="petak-bawah">
        <div className="skala-seq" aria-label="Skala jumlah tambak">
          <span className="kecil redup-teks">Tambak per kabupaten</span>
          <ul>
            {KELAS.map((k, i) => <li key={k.label}><i className={`seq-${i + 1}`} aria-hidden />{k.label}</li>)}
            <li><i className="tersembunyi" aria-hidden />disembunyikan / belum ada</li>
          </ul>
        </div>
        <p className="kecil info-petak" aria-live="polite">{sorot ? ket(sorot) : 'Arahkan atau fokus ke petak untuk detail.'}</p>
      </figcaption>
    </figure>
  )
}

export function WilayahHalaman() {
  const { data: w, galat } = useData(ambilWilayah)
  if (!w) return <Panel><Muat galat={galat} /></Panel>

  const tampil = w.sebaran.filter((s) => s.tambak !== null)
  const maksKematian = Math.max(1, ...w.kematian.flatMap((k) => k.kasus))

  return (
    <>
      <section className="catatan-privasi" aria-label="Catatan data">
        <b>Tentang angka di halaman ini</b>
        <ul>
          <li>Semua angka <strong>agregat tanpa nama</strong> — tak ada nama pemilik, tambak, atau nomor kontak.</li>
          <li>Kabupaten dengan <strong>kurang dari 3 tambak disembunyikan</strong> supaya tambak tak bisa dikenali.</li>
          <li>Data tamu <strong>“Coba demo” tidak dihitung</strong>.</li>
        </ul>
        <span className="kecil redup-teks">Diperbarui {wibTgl(w.pembaruan)} WIB{w.tersembunyi ? ` · ${angka(w.tersembunyi)} kabupaten disembunyikan` : ''}</span>
      </section>

      <Panel judul="Sebaran tambak per kabupaten" aksi={<span className="lencana-pisah">peta petak, bukan skala</span>}>
        <p className="kecil redup-teks petak-intro">
          {angka(tampil.reduce((a, s) => a + (s.tambak ?? 0), 0))} tambak di {tampil.length} kabupaten yang ditampilkan. Petak disusun kira-kira barat → timur; letak dan ukuran bukan peta sebenarnya.
        </p>
        {w.sebaran.length ? <PetaPetak sebaran={w.sebaran} /> : <Kosong judul="Belum ada kabupaten yang bisa ditampilkan" teks="Petak muncul setelah satu kabupaten punya paling sedikit 3 tambak dengan lokasi desa." />}
      </Panel>

      <Panel judul="Laporan kematian naik per kabupaten" aksi={<span className="redup-teks kecil">8 minggu · skala sama di semua petak</span>}>
        {w.kematian.length === 0 && <p className="kecil redup-teks">Belum ada laporan kematian naik dalam 8 minggu.</p>}
        <div className="kecil-banyak">
          {w.kematian.map((k) => {
            const akhir = k.kasus[k.kasus.length - 1], awal = k.kasus.slice(0, 4).reduce((a, b) => a + b, 0) / 4
            const arah = akhir > awal + 1 ? 'naik' : akhir < awal - 1 ? 'turun' : 'stabil'
            return (
              <div key={k.kabupaten} className="kb-sel">
                <div className="baris">
                  <b>{k.kabupaten}</b>
                  <span className="kecil redup-teks">{angka(k.kasus.reduce((a, b) => a + b, 0))} kasus · {arah}</span>
                </div>
                <Batang judul={`Laporan kematian naik di ${k.kabupaten}, 8 minggu`} label={w.minggu} seri={[{ nama: 'Laporan', warna: 'var(--seri-1)', nilai: k.kasus }]} ringkas maks={maksKematian} tinggi={92} satuan=" laporan" />
              </div>
            )
          })}
        </div>
      </Panel>

      <Panel judul="Laporan listrik padam" aksi={<span className="redup-teks kecil">30 hari · dilaporkan petani</span>}>
        {w.listrik.length === 0 && <p className="kecil redup-teks">Belum ada laporan listrik padam dalam 30 hari.</p>}
        <BatangDatar judul="Laporan listrik padam per kabupaten, 30 hari" baris={w.listrik.map((l) => ({ label: l.kabupaten, nilai: l.laporan }))} warna="var(--seri-netral)" satuan=" laporan" />
      </Panel>
    </>
  )
}
