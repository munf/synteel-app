// Pemakaian AI — panggilan per hari per fitur (warna kategori TETAP: foto, suara, video,
// ringkasan malam), log panggilan gagal/lambat, tambak yang mendekati/menyentuh kuota, dan buku
// panggilan AI (server/src/ledger.ts): panggilan terbaru, total per model, perkiraan biaya per kolam per malam.
import { ambilPemakaianAi } from '../api'
import { Batang, Legenda } from '../komponen/grafik'
import { angka, Bar, hariBulan, Kpi, lalu, Muat, Panel, Pill, persen, tanggal, useData, wibTgl } from '../komponen/ui'
import { FITUR_AI, type BukuAi, type FiturAi, type HasilPanggilan } from '../tipe'

/** warna seri kategori — urutan tetap, lihat --seri-1..4 di styles.css */
export const WARNA_FITUR: Record<FiturAi, string> = { foto: 'var(--seri-1)', suara: 'var(--seri-2)', video: 'var(--seri-3)', malam: 'var(--seri-4)' }
const LABEL_FITUR = Object.fromEntries(FITUR_AI.map((f) => [f.id, f.label])) as Record<FiturAi, string>

export function PemakaianAiHalaman() {
  const { data: d, galat } = useData(ambilPemakaianAi)
  if (!d) return <Panel><Muat galat={galat} /></Panel>

  const seri = FITUR_AI.map((f) => ({ nama: f.label, warna: WARNA_FITUR[f.id], nilai: d.perFitur[f.id] }))
  const total = (a: number[]) => a.reduce((x, y) => x + y, 0)
  const total14 = total(seri.flatMap((s) => s.nilai))
  const hariIni = seri.reduce((a, s) => a + s.nilai[s.nilai.length - 1], 0)
  const gagal = d.log.filter((l) => l.hasil === 'gagal').length
  const lambat = d.log.length - gagal

  return (
    <>
      <div className="kpi-grid empat">
        <Kpi label="Panggilan AI hari ini" nilai={angka(hariIni)} ket="semua fitur" aksen />
        <Kpi label="Panggilan 14 hari" nilai={angka(total14)} ket={<>rata-rata {angka(Math.round(total14 / 14))} per hari</>} />
        <Kpi label="Gagal (24 jam)" nilai={angka(gagal)} ket={<>{persen(gagal / Math.max(1, hariIni), 1)} dari panggilan hari ini</>} />
        <Kpi label="Lambat (24 jam)" nilai={angka(lambat)} ket={<>lebih dari {d.ambangLambatDtk} detik</>} />
      </div>

      <Panel judul="Panggilan AI per hari, per fitur" aksi={<span className="redup-teks kecil">14 hari · bertumpuk</span>}>
        <div className="ringkas-fitur">
          <Legenda seri={seri} total />
          <span className="redup-teks kecil">angka = jumlah 14 hari</span>
        </div>
        <Batang
          judul="Panggilan AI per hari per fitur, 14 hari" label={d.hari.map(hariBulan)} labelPanjang={d.hari.map((h) => tanggal(h + 'T05:00:00Z'))}
          seri={seri} tinggi={250} satuan="" legenda={false} tabel
        />
      </Panel>

      <div className="grid-2 lebar-kiri">
        <Panel judul="Panggilan gagal atau lambat" aksi={<span className="redup-teks kecil">terbaru di atas</span>}>
          {d.log.length === 0 && <p className="kecil redup-teks">Tidak ada panggilan AI yang gagal atau lambat dalam 14 hari.</p>}
          <div className="gulir-x" tabIndex={0} aria-label="Log panggilan gagal atau lambat">
            <table className="tabel rapat tabel-log">
              <thead><tr><th scope="col">Waktu</th><th scope="col">Fitur</th><th scope="col">Tambak</th><th scope="col">Durasi</th><th scope="col">Hasil</th><th scope="col">Keterangan</th></tr></thead>
              <tbody>
                {d.log.map((l) => (
                  <tr key={l.id}>
                    <td className="mono" title={wibTgl(l.waktu)}>{lalu(l.waktu)}</td>
                    <td><span className="fitur"><i style={{ background: WARNA_FITUR[l.fitur] }} aria-hidden />{LABEL_FITUR[l.fitur]}</span></td>
                    <td>{l.tambak ?? <span className="redup-teks">—</span>}</td>
                    <td className="mono">{l.durasiDtk ? `${l.durasiDtk} dtk` : '—'}</td>
                    <td>{l.hasil === 'gagal' ? <Pill s="critical">Gagal</Pill> : <Pill s="degraded">Lambat</Pill>}</td>
                    <td className="redup-teks">{l.pesan}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel judul="Kredit AI tambak hari ini" aksi={<span className="redup-teks kecil">terbanyak di atas</span>}>
          {d.kuota.length === 0 && <p className="kecil redup-teks">Belum ada tambak yang memakai AI hari ini.</p>}
          <ul className="daftar-kuota">
            {d.kuota.map((k) => {
              const p = k.batas ? k.pakai / k.batas : 0
              const habis = p >= 1
              return (
                <li key={k.tambak}>
                  <div className="baris">
                    <span><b>{k.tambak}</b>{k.kabupaten && <span className="redup-teks kecil"> · {k.kabupaten}</span>}</span>
                    <span className="mono kecil">{angka(k.pakai)}{k.batas ? ` / ${angka(k.batas)}` : ''}</span>
                  </div>
                  <Bar v={p} warna={habis ? 'var(--bad)' : p >= 0.9 ? 'var(--warn)' : 'var(--seri-netral)'} label={`${k.tambak}: ${angka(k.pakai)} dari ${angka(k.batas)} panggilan`} />
                  <span className="kecil">{habis ? <Pill s="critical">Kuota habis</Pill> : p >= 0.9 ? <Pill s="degraded">Hampir habis · {persen(p)}</Pill> : <span className="redup-teks">{persen(p)} terpakai</span>}</span>
                </li>
              )
            })}
          </ul>
          <p className="kecil redup-teks">Kredit dihitung per tambak per hari (waktu setempat) dan mulai dari nol lagi tengah malam.</p>
        </Panel>
      </div>

      {d.buku && <Buku b={d.buku} />}
    </>
  )
}

/** Perkiraan biaya dalam dolar AS: angka kecil tetap terbaca ($0,0042). */
const usd = (n: number | null) => (n === null ? '—' : `$${n < 0.01 ? n.toFixed(4) : n.toFixed(3)}`.replace('.', ','))
const HASIL: Record<HasilPanggilan, { s: 'normal' | 'degraded' | 'critical' | 'off'; label: string }> = {
  ok: { s: 'normal', label: 'Berhasil' },
  fallback: { s: 'degraded', label: 'Cadangan' },
  error: { s: 'critical', label: 'Gagal' },
  mock: { s: 'off', label: 'Contoh' },
}
const JENIS: Record<string, string> = {
  photo: 'Foto', voice: 'Suara', video: 'Video', round: 'Keliling', count: 'Hitung sidat', notebook: 'Buku catatan',
  pond_photo: 'Foto kolam', transcribe: 'Suara ke teks', briefing: 'Ringkasan malam', case: 'Kasus', spoken: 'Dengarkan', pattern: 'Pola suhu',
}
const modelPendek = (m: string) => m.split('/').at(-1)!

function Buku({ b }: { b: BukuAi }) {
  return (
    <>
      <div className="grid-2 lebar-kiri">
        <Panel judul="Perkiraan biaya per kolam per malam" aksi={<span className="redup-teks kecil">12.00–12.00 WIB · perkiraan</span>}>
          <div className="kpi-grid">
            <Kpi label="Rata-rata 7 malam" nilai={usd(b.rata7Malam)} ket="per kolam, malam yang memakai AI" aksen />
          </div>
          {b.perKolamMalam.length === 0 && <p className="kecil redup-teks">Belum ada panggilan AI yang tercatat untuk tambak.</p>}
          <div className="gulir-x" tabIndex={0} aria-label="Perkiraan biaya per kolam per malam">
            <table className="tabel rapat">
              <thead><tr><th scope="col">Malam</th><th scope="col">Tambak</th><th scope="col">Kolam</th><th scope="col">Panggilan</th><th scope="col">Biaya</th><th scope="col">Per kolam</th></tr></thead>
              <tbody>
                {b.perKolamMalam.slice(0, 20).map((n) => (
                  <tr key={n.malam + n.tambak}>
                    <td>{hariBulan(n.malam)}</td>
                    <td>{n.tambak}</td>
                    <td className="mono">{angka(n.kolam)}</td>
                    <td className="mono">{angka(n.panggilan)}</td>
                    <td className="mono">{usd(n.biayaUsd)}</td>
                    <td className="mono"><b>{usd(n.perKolamUsd)}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="kecil redup-teks">{b.catatanHarga}</p>
        </Panel>

        <Panel judul="Total per model" aksi={<span className="redup-teks kecil">14 hari</span>}>
          {b.perModel.length === 0 && <p className="kecil redup-teks">Belum ada panggilan model.</p>}
          <div className="gulir-x" tabIndex={0} aria-label="Total per model">
            <table className="tabel rapat">
              <thead><tr><th scope="col">Model</th><th scope="col">Panggilan</th><th scope="col">Gagal</th><th scope="col">Token masuk / keluar</th><th scope="col">Rata-rata</th><th scope="col">Biaya</th></tr></thead>
              <tbody>
                {b.perModel.map((m) => (
                  <tr key={m.penyedia + m.model}>
                    <td>{modelPendek(m.model)} <span className="redup-teks kecil">· {m.penyedia}</span></td>
                    <td className="mono">{angka(m.panggilan)}</td>
                    <td className="mono">{angka(m.gagal)}{m.cadangan ? <span className="redup-teks"> · {angka(m.cadangan)} cadangan</span> : null}</td>
                    <td className="mono">{angka(m.tokenMasuk)} / {angka(m.tokenKeluar)}</td>
                    <td className="mono">{(m.rataMs / 1000).toFixed(1).replace('.', ',')} dtk</td>
                    <td className="mono">{usd(m.biayaUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      <Panel judul="Panggilan AI terbaru" aksi={<span className="redup-teks kecil">50 terbaru · tanpa suara, foto atau teks petani</span>}>
        {b.panggilan.length === 0 && <p className="kecil redup-teks">Belum ada panggilan AI.</p>}
        <div className="gulir-x" tabIndex={0} aria-label="Panggilan AI terbaru">
          <table className="tabel rapat tabel-log">
            <thead><tr><th scope="col">Waktu</th><th scope="col">Jenis</th><th scope="col">Model</th><th scope="col">Durasi</th><th scope="col">Token</th><th scope="col">Biaya</th><th scope="col">Hasil</th><th scope="col">Cek</th><th scope="col">Tambak</th></tr></thead>
            <tbody>
              {b.panggilan.map((p) => (
                <tr key={p.id}>
                  <td className="mono" title={wibTgl(p.waktu)}>{lalu(p.waktu)}</td>
                  <td>{JENIS[p.jenis] ?? p.jenis} <span className="redup-teks kecil">· {p.langkah}</span></td>
                  <td>{modelPendek(p.model)} <span className="redup-teks kecil">· {p.penyedia}</span></td>
                  <td className="mono">{(p.durasiMs / 1000).toFixed(1).replace('.', ',')} dtk</td>
                  <td className="mono">{p.tokenMasuk === null ? '—' : `${angka(p.tokenMasuk)} / ${angka(p.tokenKeluar)}`}</td>
                  <td className="mono">{usd(p.biayaUsd)}</td>
                  <td title={p.pesan ?? undefined}><Pill s={HASIL[p.hasil].s}>{HASIL[p.hasil].label}</Pill></td>
                  <td>{p.cek === 'passed' ? <Pill s="normal">Lolos</Pill> : p.cek === 'failed' ? <Pill s="degraded">Cek manual</Pill> : <span className="redup-teks">—</span>}</td>
                  <td>{p.tambak ?? <span className="redup-teks">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  )
}
