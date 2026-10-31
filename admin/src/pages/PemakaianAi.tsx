// Pemakaian AI — panggilan per hari per fitur (warna kategori TETAP: foto, suara, video,
// ringkasan malam), log panggilan gagal/lambat, dan tambak yang mendekati/menyentuh kuota.
import { ambilPemakaianAi } from '../api'
import { Batang, Legenda } from '../komponen/grafik'
import { angka, Bar, hariBulan, Kpi, lalu, Muat, Panel, Pill, persen, tanggal, useData, wibTgl } from '../komponen/ui'
import { FITUR_AI, type FiturAi } from '../tipe'

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

        <Panel judul="Jatah AI tambak hari ini" aksi={<span className="redup-teks kecil">terbanyak di atas</span>}>
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
          <p className="kecil redup-teks">Jatah dihitung per tambak per hari (waktu setempat) dan mulai dari nol lagi tengah malam.</p>
        </Panel>
      </div>
    </>
  )
}
