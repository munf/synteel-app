// Ringkasan — halaman awal. Angka pengguna TIDAK memuat tamu "Coba demo";
// tamu demo punya panel sendiri yang diberi label jelas.
import { ambilKasus, ambilRingkasan } from '../api'
import type { Halaman } from '../halaman'
import { Batang } from '../komponen/grafik'
import { angka, hariBulan, Kpi, lalu, Muat, Panel, persen, Spark, tanggal, useData } from '../komponen/ui'

export function Ringkasan({ ke }: { ke: (h: Halaman) => void }) {
  const { data: r, galat } = useData(ambilRingkasan)
  const { data: kasus } = useData(ambilKasus)
  if (!r) return <Panel><Muat galat={galat} /></Panel>

  const catatan7 = Math.round(r.catatanPerHari.slice(-7).reduce((a, b) => a + b, 0) / 7)
  const label = r.hari.map(hariBulan)
  const panjang = r.hari.map((h) => tanggal(h + 'T05:00:00Z'))

  return (
    <>
      <div className="kpi-grid" aria-label="Angka utama (tanpa tamu demo)">
        <Kpi label="Daftar baru hari ini" nilai={angka(r.daftarHariIni)} ket={<>{angka(r.daftar7Hari)} dalam 7 hari</>} aksen />
        <Kpi label="Aktif 7 hari" nilai={angka(r.aktif7Hari)} ket={<>{persen(r.aktif7Hari / r.totalAkun)} dari {angka(r.totalAkun)} akun</>} />
        <Kpi label="Tambak" nilai={angka(r.tambak)} ket="terdaftar oleh pemilik" />
        <Kpi label="Kolam" nilai={angka(r.kolam)} ket={r.tambak ? <>rata-rata {(r.kolam / r.tambak).toFixed(1).replace('.', ',')} per tambak</> : 'belum ada tambak'} />
        <Kpi label="Catatan per hari" nilai={angka(catatan7)} ket="rata-rata 7 hari">
          <Spark v={r.catatanPerHari} w={120} h={22} color="var(--seri-1)" />
        </Kpi>
      </div>

      <div className="grid-2">
        <Panel judul="Perlu ditangani" id="perlu">
          <div className="perlu-baris">
            <button className="perlu" onClick={() => ke('pengguna')}>
              <b data-angka>{r.kasusTerbuka}</b>
              <span>kasus terbuka</span>
            </button>
            <button className="perlu" onClick={() => ke('bantuan')}>
              <b data-angka>{r.bantuanBelumDibalas}</b>
              <span>pesan Bantuan belum dibalas</span>
            </button>
          </div>
          {kasus ? kasus.length === 0 ? <p className="kecil redup-teks">Tidak ada kasus sidat mati atau listrik padam yang terbuka.</p> : (
            <ul className="daftar-kasus">
              {kasus.map((k) => (
                <li key={k.id}>
                  <span className="jenis-kasus">{k.jenis}</span>
                  <div>
                    <b>{k.tambak}</b>{k.kabupaten && <span className="redup-teks"> · {k.kabupaten}</span>}
                    <p className="redup-teks">{k.catatan}</p>
                  </div>
                  <small className="redup-teks mono">{lalu(k.sejak)}</small>
                </li>
              ))}
            </ul>
          ) : <Muat />}
        </Panel>

        <Panel
          judul="Tamu “Coba demo”" id="demo" className="panel-demo"
          aksi={<span className="lencana-pisah">tidak dihitung sebagai pengguna</span>}
        >
          <p className="kecil redup-teks catatan-demo">
            Sesi tamu memakai data tambak contoh dan tidak membuat akun. Angka ini terpisah dari semua angka pengguna di atas dan di halaman lain.
          </p>
          <div className="statistik">
            <div><small>Sesi hari ini</small><b data-angka>{angka(r.demo.sesiHariIni)}</b></div>
            <div><small>Sesi 7 hari</small><b data-angka>{angka(r.demo.sesi7Hari)}</b></div>
            {r.demo.lanjutDaftar7Hari !== null && <div><small>Lanjut daftar (7 hari)</small><b data-angka>{angka(r.demo.lanjutDaftar7Hari)}</b></div>}
          </div>
          {r.demo.menitRata !== null && <p className="kecil redup-teks">Rata-rata {String(r.demo.menitRata).replace('.', ',')} menit per sesi.</p>}
          <Batang judul="Sesi tamu demo per hari, 14 hari" label={label} labelPanjang={panjang} seri={[{ nama: 'Sesi tamu', warna: 'var(--seri-netral)', nilai: r.demo.perHari }]} tinggi={130} satuan=" sesi" />
        </Panel>
      </div>

      <div className="grid-2">
        <Panel judul="Pendaftar baru per hari" aksi={<span className="redup-teks kecil">14 hari · tanpa tamu demo</span>}>
          <Batang judul="Pendaftar baru per hari, 14 hari" label={label} labelPanjang={panjang} seri={[{ nama: 'Akun baru', warna: 'var(--accent)', nilai: r.daftarPerHari }]} satuan=" akun" />
        </Panel>
        <Panel judul="Catatan kolam per hari" aksi={<span className="redup-teks kecil">14 hari</span>}>
          <Batang judul="Catatan kolam per hari, 14 hari" label={label} labelPanjang={panjang} seri={[{ nama: 'Catatan', warna: 'var(--seri-1)', nilai: r.catatanPerHari }]} satuan=" catatan" />
        </Panel>
      </div>
    </>
  )
}
