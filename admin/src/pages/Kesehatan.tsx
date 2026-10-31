// Kesehatan sistem — layanan (app / preview / situs), sisa RAM & disk VPS, backup terakhir,
// email kode terkirim vs gagal, login gagal & kena batas percobaan, galat server terbaru.
import { ambilKesehatan } from '../api'
import { Batang, Cincin } from '../komponen/grafik'
import { angka, hariBulan, lalu, Muat, Panel, Pill, tanggal, useData, wibTgl } from '../komponen/ui'
import { kini, type Status } from '../tipe'

const fmtGb = (n: number) => n.toLocaleString('id-ID', { maximumFractionDigits: 1 })

/** status dari sisa: < 15% kritis, < 30% terganggu */
const statusSisa = (sisa: number): Status => (sisa < 0.15 ? 'critical' : sisa < 0.3 ? 'degraded' : 'normal')
const WARNA: Record<Status, string> = { normal: 'var(--seri-netral)', degraded: 'var(--warn)', critical: 'var(--bad)', off: 'var(--redup)' }
const LABEL_SISA: Record<Status, string> = { normal: 'Cukup', degraded: 'Menipis', critical: 'Kritis', off: '—' }

export function KesehatanHalaman() {
  const { data: k, galat } = useData(ambilKesehatan)
  if (!k) return <Panel><Muat galat={galat} /></Panel>

  const label = k.hari.map(hariBulan)
  const panjang = k.hari.map((h) => tanggal(h + 'T05:00:00Z'))
  const ram = { sisa: k.vps.ramTotalGb - k.vps.ramPakaiGb, total: k.vps.ramTotalGb }
  const disk = { sisa: k.vps.diskTotalGb - k.vps.diskPakaiGb, total: k.vps.diskTotalGb }
  const jamBackup = k.backup ? (kini().getTime() - new Date(k.backup.terakhir).getTime()) / 3600e3 : Infinity
  const stBackup: Status = !k.backup ? 'off' : !k.backup.berhasil || jamBackup > 36 ? 'critical' : jamBackup > 26 ? 'degraded' : 'normal'
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)
  const kirim7 = sum(k.emailKode.terkirim.slice(-7)), gagal7 = sum(k.emailKode.gagal.slice(-7))

  return (
    <>
      <Panel judul="Layanan" aksi={<span className="redup-teks kecil">dicek tiap menit</span>}>
        <ul className="layanan">
          {k.layanan.map((l) => (
            <li key={l.id}>
              <div>
                <b>{l.nama}</b>
                <small className="redup-teks">{l.ket}</small>
              </div>
              <span className="mono kecil">{l.waktuRespon === null ? '—' : `${angka(l.waktuRespon)} ms`}</span>
              <Pill s={l.status}>{l.status === 'normal' ? 'Normal' : l.status === 'degraded' ? 'Lambat' : l.status === 'critical' ? 'Mati' : 'Jeda'}</Pill>
            </li>
          ))}
        </ul>
      </Panel>

      <div className="grid-3">
        {[{ judul: 'RAM VPS', ...ram }, { judul: 'Disk VPS', ...disk }].map((x) => {
          const p = x.sisa / x.total
          const s = statusSisa(p)
          return (
            <Panel key={x.judul} judul={x.judul} aksi={<Pill s={s}>{LABEL_SISA[s]}</Pill>}>
              <div className="sumber-daya">
                <Cincin p={p} ukuran={112} warna={WARNA[s]} label={`${x.judul}: tersisa ${fmtGb(x.sisa)} dari ${fmtGb(x.total)} GB`}>
                  <b>{Math.round(p * 100)}%</b>
                  <small>tersisa</small>
                </Cincin>
                <div className="kecil">
                  <p><b className="mono">{fmtGb(x.sisa)} GB</b> tersisa</p>
                  <p className="redup-teks">dari {fmtGb(x.total)} GB · terpakai {fmtGb(x.total - x.sisa)} GB</p>
                </div>
              </div>
            </Panel>
          )
        })}
        <Panel judul="Backup database" aksi={<Pill s={stBackup}>{stBackup === 'normal' ? 'Tepat waktu' : stBackup === 'degraded' ? 'Terlambat' : stBackup === 'off' ? 'Belum ada data' : 'Gagal / lewat batas'}</Pill>}>
          {k.backup ? (
            <>
              <p className="angka-besar">{lalu(k.backup.terakhir)}</p>
              <p className="kecil">{wibTgl(k.backup.terakhir)} WIB</p>
              <p className="kecil redup-teks">{angka(k.backup.ukuranMb)} MB · {k.backup.tujuan} · jadwal harian 02:00 WIB</p>
            </>
          ) : <p className="kecil redup-teks">Server belum membaca status backup. Status muncul setelah backup harian berikutnya (02:00 WIB).</p>}
        </Panel>
      </div>

      <div className="grid-2">
        <Panel judul="Email kode masuk" aksi={<span className="redup-teks kecil">7 hari: {angka(kirim7)} terkirim · {angka(gagal7)} gagal</span>}>
          <Batang
            judul="Email kode terkirim dan gagal per hari, 14 hari" label={label} labelPanjang={panjang} tabel
            seri={[{ nama: 'Terkirim', warna: 'var(--seri-1)', nilai: k.emailKode.terkirim }, { nama: 'Gagal', warna: 'var(--seri-2)', nilai: k.emailKode.gagal }]}
          />
        </Panel>
        <Panel judul="Login gagal" aksi={<span className="redup-teks kecil">14 hari</span>}>
          <Batang
            judul="Login gagal dan login yang kena batas percobaan per hari, 14 hari" label={label} labelPanjang={panjang} mode="kelompok" tabel
            seri={[{ nama: 'PIN/kode salah', warna: 'var(--seri-1)', nilai: k.login.gagal }, { nama: 'Kena batas percobaan', warna: 'var(--seri-2)', nilai: k.login.kenaBatas }]}
          />
        </Panel>
      </div>

      <Panel judul="Galat server terbaru" aksi={<span className="redup-teks kecil">24 jam terakhir</span>}>
        {k.galat.length === 0 && <p className="kecil redup-teks">Tidak ada galat server dalam 24 jam terakhir.</p>}
        <div className="gulir-x" tabIndex={0} aria-label="Tabel galat server">
          <table className="tabel rapat tabel-log">
            <thead><tr><th scope="col">Waktu</th><th scope="col">Rute</th><th scope="col">Kode</th><th scope="col">Pesan</th><th scope="col">Kali</th></tr></thead>
            <tbody>
              {k.galat.map((g) => (
                <tr key={g.waktu + g.rute}>
                  <td className="mono" title={wibTgl(g.waktu)}>{lalu(g.waktu)}</td>
                  <td className="mono">{g.rute}</td>
                  <td><span className="kode-http mono">{g.kode}</span></td>
                  <td>{g.pesan}</td>
                  <td className="mono">{angka(g.jumlah)}×</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  )
}
