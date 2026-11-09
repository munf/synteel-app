// Data lapangan — satu ringkasan siklus (glass eel → elver) per batch, dari catatan yang sudah ada di aplikasi.
// Bertahan hidup hanya dihitung kalau petani mengisi jumlah tebar DAN jumlah hitung saat sortir/panen.
// Patokan 20–40% = menurut petani mitra (dari ingatan, tanpa catatan), bukan hasil ukur.
// File unduhan menyebut tambak dengan id saja (t12): tanpa nama pemilik, nomor, atau lokasi.
import { ambilSiklus, tautanUnduhSiklus } from '../api'
import { angka, hariBulan, Kosong, Muat, Panel, persen, useData } from '../komponen/ui'
import type { RingkasanSiklus } from '../tipe'

const fase = { glass_eel: 'Glass eel', elver: 'Elver' } as const
const banding = { below: 'di bawah', within: 'di dalam', above: 'di atas' } as const
const sebab = { stocked: 'jumlah tebar belum diisi', count: 'belum ada hitungan sortir/panen', count_above_stocked: 'hitungan lebih besar dari jumlah tebar' } as const

function Bertahan({ s }: { s: RingkasanSiklus }) {
  if (s.survival === null) return <span className="redup-teks">{sebab[s.survivalMissing ?? 'count']}</span>
  return (
    <span>
      <b className="mono">{persen(s.survival, 1)}</b>{' '}
      <span className="redup-teks">{banding[s.baseline.vs!]} patokan menurut petani</span>
    </span>
  )
}

export function SiklusHalaman() {
  const { data, galat } = useData(ambilSiklus)
  if (!data) return <Panel><Muat galat={galat} /></Panel>
  const semuaCsv = tautanUnduhSiklus('csv')
  const semuaJson = tautanUnduhSiklus('json')

  return (
    <Panel
      judul="Siklus per batch"
      aksi={semuaCsv && semuaJson ? <span className="redup-teks kecil"><a className="tombol" href={semuaCsv} download>Unduh semua (CSV)</a> <a className="tombol" href={semuaJson} download>JSON</a></span> : <span className="redup-teks kecil">unduh hanya di dasbor asli</span>}
    >
      <p className="kecil redup-teks">
        Patokan bertahan hidup 20–40% adalah angka menurut petani mitra, bukan hasil ukur. Persentase bertahan hidup hanya muncul kalau jumlah tebar dan hitungan sortir atau panen diisi. File unduhan menyebut tambak dengan id saja.
      </p>
      {data.length === 0 ? (
        <Kosong judul="Belum ada batch" teks="Batch muncul di sini setelah pemilik tambak mengisi tanggal tebar di aplikasi." />
      ) : (
        <div className="gulir-x" tabIndex={0} aria-label="Siklus per batch">
          <table className="tabel rapat">
            <thead>
              <tr>
                <th scope="col">Tambak · kolam</th><th scope="col">Tebar</th><th scope="col">Hari</th><th scope="col">Catatan/hari</th><th scope="col">Malam dicek</th>
                <th scope="col">Ukuran di luar batas</th><th scope="col">Alarm bahaya dijawab</th><th scope="col">Mati tercatat</th><th scope="col">Bertahan hidup</th><th scope="col">Unduh</th>
              </tr>
            </thead>
            <tbody>
              {data.map((x) => {
                const s = x.ringkasan
                const csv = tautanUnduhSiklus('csv', x.id)
                const json = tautanUnduhSiklus('json', x.id)
                return (
                  <tr key={x.id}>
                    <td><b>{x.tambak}</b> <span className="redup-teks mono">{x.tambakId}</span><br /><span className="redup-teks">{x.kolam} · {fase[s.phase]}</span></td>
                    <td className="mono">{hariBulan(s.stockedAt)}<br /><span className="redup-teks">{s.stockedCount === null ? '—' : `${angka(s.stockedCount)} ekor`}</span></td>
                    <td className="mono">{angka(s.days)}{s.endedOn && <><br /><span className="redup-teks">selesai {hariBulan(s.endedOn)}</span></>}</td>
                    <td className="mono">{String(s.logsPerDay).replace('.', ',')}</td>
                    <td className="mono">{angka(s.nights.covered)} / {angka(s.nights.total)}</td>
                    <td className="mono">{angka(s.readings.outOfRange)} / {angka(s.readings.inRange + s.readings.outOfRange)}{s.readings.danger > 0 && <><br /><span className="redup-teks">{angka(s.readings.danger)} bahaya</span></>}</td>
                    <td className="mono">{angka(s.alarms.answered)} / {angka(s.alarms.raised)}</td>
                    <td className="mono">{angka(s.deaths.total)}<br /><span className="redup-teks">{angka(s.deaths.reports)} laporan</span></td>
                    <td><Bertahan s={s} />{s.count && <><br /><span className="redup-teks kecil">{s.count.kind === 'harvest' ? 'panen' : 'sortir'} {hariBulan(s.count.on)}: {angka(s.count.count)} ekor</span></>}</td>
                    <td>{csv && json ? <><a href={csv} download>CSV</a> · <a href={json} download>JSON</a></> : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}
