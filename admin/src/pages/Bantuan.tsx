// Bantuan — kotak masuk formulir Bantuan: saring status (baru / dibalas / selesai), utas,
// dan penyusun balasan. Kirim = email lewat Brevo di server; di template hanya menambah
// balasan ke utas & mengubah status jadi "dibalas".
import { useEffect, useId, useRef, useState } from 'react'
import { ambilBantuan, BALAS_EMAIL, balasBantuan, ubahStatusBantuan } from '../api'
import { silang } from '../komponen/gerak'
import { lalu, Muat, Panel, Pill, useData, useToast, wibTgl } from '../komponen/ui'
import type { Bantuan, StatusBantuan } from '../tipe'

const PILL: Record<StatusBantuan, { s: 'critical' | 'degraded' | 'normal'; label: string }> = {
  baru: { s: 'critical', label: 'Baru' },
  dibalas: { s: 'degraded', label: 'Dibalas' },
  selesai: { s: 'normal', label: 'Selesai' },
}
const TAB: { v: StatusBantuan | 'semua'; label: string }[] = [
  { v: 'baru', label: 'Baru' }, { v: 'dibalas', label: 'Dibalas' }, { v: 'selesai', label: 'Selesai' }, { v: 'semua', label: 'Semua' },
]

export function BantuanHalaman() {
  const { data: pesan, setData: setPesan, galat } = useData(ambilBantuan)
  const toast = useToast()
  const [tab, setTab] = useState<StatusBantuan | 'semua'>('baru')
  const [pilih, setPilih] = useState<string | null>(null)
  const [draf, setDraf] = useState('')
  const [kirim, setKirim] = useState(false)
  const utasRef = useRef<HTMLDivElement>(null)
  const idDraf = useId()

  const tampak = (pesan ?? []).filter((p) => tab === 'semua' || p.status === tab).sort((a, b) => b.masuk.localeCompare(a.masuk))
  useEffect(() => {
    if (pesan && !tampak.some((p) => p.id === pilih)) setPilih(tampak[0]?.id ?? null)
  }, [pesan, tab])
  useEffect(() => { setDraf(''); silang(utasRef.current) }, [pilih])

  if (!pesan) return <Panel><Muat galat={galat} /></Panel>
  const hitung = (v: StatusBantuan | 'semua') => (v === 'semua' ? pesan.length : pesan.filter((p) => p.status === v).length)
  const p = pesan.find((x) => x.id === pilih)

  const ubah = (id: string, f: (x: Bantuan) => Bantuan) => setPesan(pesan.map((x) => (x.id === id ? f(x) : x)))
  const balas = async () => {
    if (!p || !draf.trim()) return
    setKirim(true)
    const r = await balasBantuan(p.id, draf.trim())
    ubah(p.id, (x) => ({ ...x, status: 'dibalas', utas: [...x.utas, { dari: 'tim', nama: 'Tim synteel', isi: draf.trim(), waktu: r.waktu }] }))
    setDraf('')
    setKirim(false)
    toast(`Balasan ke ${p.nama} masuk antrean email (Brevo). Status → dibalas. (data contoh — tak ada email terkirim)`)
  }
  const selesai = async (status: StatusBantuan) => {
    if (!p) return
    await ubahStatusBantuan(p.id, status)
    ubah(p.id, (x) => ({ ...x, status }))
    toast(status === 'selesai' ? `Pesan “${p.topik}” ditandai selesai.` : status === 'dibalas' ? `Pesan “${p.topik}” ditandai sudah dibalas.` : `Pesan “${p.topik}” dibuka lagi.`, 'info')
  }

  return (
    <>
      <div className="tab-status" role="group" aria-label="Saring status pesan">
        {TAB.map((x) => (
          <button key={x.v} aria-pressed={tab === x.v} className={tab === x.v ? 'aktif' : ''} onClick={() => setTab(x.v)}>
            {x.label}<span className="hm-ct">{hitung(x.v)}</span>
          </button>
        ))}
      </div>

      <div className="kotak-bantuan">
        <section className="panel antrian-bantuan" aria-label="Daftar pesan">
          {tampak.length === 0 && <p className="redup-teks kecil">Tidak ada pesan berstatus ini.</p>}
          <ul>
            {tampak.map((x) => (
              <li key={x.id}>
                <button className={`pesan ${x.id === pilih ? 'aktif' : ''}`} onClick={() => setPilih(x.id)} aria-current={x.id === pilih ? 'true' : undefined}>
                  <span className="baris"><b>{x.nama}</b><small className="redup-teks mono">{lalu(x.masuk)}</small></span>
                  <span className="topik">{x.topik}</span>
                  <span className="baris"><span className="redup-teks kecil potong">{x.utas[x.utas.length - 1].isi}</span><Pill s={PILL[x.status].s}>{PILL[x.status].label}</Pill></span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel utas-panel" aria-labelledby="judul-utas">
          {p ? (
            <div ref={utasRef} className="utas-isi">
              <div className="utas-kepala">
                <div>
                  <h2 id="judul-utas">{p.topik}</h2>
                  <p className="redup-teks kecil">
                    {p.nama} · <span className="mono">{p.kontak}</span> · {p.akunId ? 'pengguna terdaftar' : 'bukan pengguna terdaftar'} · masuk {wibTgl(p.masuk)} WIB
                  </p>
                </div>
                <div className="baris aksi">
                  <Pill s={PILL[p.status].s}>{PILL[p.status].label}</Pill>
                  {p.status === 'baru' && !BALAS_EMAIL && <button className="tombol" onClick={() => selesai('dibalas')}>Tandai sudah dibalas</button>}
                  {p.status !== 'selesai'
                    ? <button className="tombol" onClick={() => selesai('selesai')}>Tandai selesai</button>
                    : <button className="tombol" onClick={() => selesai('dibalas')}>Buka lagi</button>}
                </div>
              </div>

              <ol className="utas" aria-label="Isi percakapan">
                {p.utas.map((m, i) => (
                  <li key={i} className={`gelembung-utas ${m.dari}`}>
                    <span className="kecil"><b>{m.nama}</b> <span className="redup-teks">· {wibTgl(m.waktu)} WIB</span></span>
                    <p>{m.isi}</p>
                  </li>
                ))}
              </ol>

              {!BALAS_EMAIL && (
                <p className="kecil redup-teks">
                  {p.terkirimEmail ? 'Pesan ini sudah diteruskan ke fajarnugraha@synt.fun. ' : 'Pesan ini belum terkirim ke email tim. '}
                  Balas dari Gmail ke alamat pengirim, lalu tandai sudah dibalas. Balas langsung dari dasbor menyusul.
                </p>
              )}
              {BALAS_EMAIL && <form className="penyusun" onSubmit={(e) => { e.preventDefault(); balas() }}>
                <label htmlFor={idDraf}>Balasan untuk {p.nama}</label>
                <textarea id={idDraf} rows={4} value={draf} onChange={(e) => setDraf(e.target.value)} placeholder="Tulis balasan dengan bahasa sederhana…" />
                <div className="baris">
                  <span className="redup-teks kecil">Terkirim sebagai email ke <span className="mono">{p.kontak}</span> dari alamat Bantuan synteel.</span>
                  <button type="submit" className="tombol utama" disabled={!draf.trim() || kirim}>{kirim ? 'Mengirim…' : 'Kirim lewat email (Brevo)'}</button>
                </div>
              </form>}
            </div>
          ) : <p className="redup-teks">Pilih pesan di sebelah kiri.</p>}
        </section>
      </div>
    </>
  )
}
