// Pengguna & tambak — daftar akun (kontak SUDAH disamarkan dari server), saring, detail
// tambak, dan aksi admin. Tiap aksi punya langkah konfirmasi di halaman (bukan window.confirm);
// di template aksi hanya mengubah state lokal + toast.
import { useEffect, useMemo, useRef, useState } from 'react'
import { AKSI_AKUN, ambilAkun, ambilTambak, hapusAkun, kirimResetPin, kunciAkun } from '../api'
import { angka, lalu, Muat, Panel, Pill, tanggal, useData, useToast } from '../komponen/ui'
import type { Akun, Peran, StatusAkun } from '../tipe'

const PILL_AKUN: Record<StatusAkun, { s: 'normal' | 'critical' | 'off'; label: string }> = {
  aktif: { s: 'normal', label: 'Aktif' },
  terkunci: { s: 'critical', label: 'Terkunci' },
  dihapus: { s: 'off', label: 'Dihapus' },
}

type Aksi = 'kunci' | 'hapus' | 'pin'

export function Pengguna() {
  const { data: akun, setData: setAkun, galat } = useData(ambilAkun)
  const { data: tambak } = useData(ambilTambak)
  const toast = useToast()
  const [cari, setCari] = useState('')
  const [peran, setPeran] = useState<'semua' | Peran>('semua')
  const [kab, setKab] = useState<string>('semua')
  const [pilih, setPilih] = useState<string | null>(null)
  const [aksi, setAksi] = useState<Aksi | null>(null)
  const [setuju, setSetuju] = useState(false)
  const [proses, setProses] = useState(false)
  const konfirmasiRef = useRef<HTMLDivElement>(null)

  const tampak = useMemo(() => {
    if (!akun) return []
    const q = cari.trim().toLowerCase()
    return akun.filter((a) => {
      if (peran !== 'semua' && a.peran !== peran) return false
      if (kab !== 'semua' && a.kabupaten !== kab) return false
      if (!q) return true
      const t = tambak?.find((x) => x.id === a.tambakId)
      return [a.nama, a.telepon, a.email ?? '', t?.nama ?? ''].some((s) => s.toLowerCase().includes(q))
    })
  }, [akun, tambak, cari, peran, kab])

  useEffect(() => { if (!pilih && akun?.length) setPilih(akun[0].id) }, [akun, pilih])
  useEffect(() => { setAksi(null); setSetuju(false) }, [pilih])
  useEffect(() => { if (aksi) konfirmasiRef.current?.querySelector<HTMLElement>('input, button')?.focus() }, [aksi])

  if (!akun) return <Panel><Muat galat={galat} /></Panel>
  const kabupaten = [...new Set(akun.map((x) => x.kabupaten).filter(Boolean))].sort()
  const a = akun.find((x) => x.id === pilih)
  const t = a && tambak?.find((x) => x.id === a.tambakId)
  const anggota = t ? akun.filter((x) => x.tambakId === t.id && x.id !== a?.id) : []

  // layar sempit: detail ada di bawah daftar → gulir ke sana sesudah memilih
  const lihat = (id: string) => {
    setPilih(id)
    if (matchMedia('(max-width: 1200px)').matches) requestAnimationFrame(() => document.querySelector('.kolom-detail')?.scrollIntoView({ block: 'start' }))
  }
  const ubah = (id: string, u: Partial<Akun>) => setAkun(akun.map((x) => (x.id === id ? { ...x, ...u } : x)))
  const jalankan = async () => {
    if (!a || !aksi) return
    setProses(true)
    if (aksi === 'kunci') {
      const kunci = a.status !== 'terkunci'
      await kunciAkun(a.id, kunci)
      ubah(a.id, { status: kunci ? 'terkunci' : 'aktif' })
      toast(kunci ? `Akun “${a.nama}” dikunci. Pemiliknya tak bisa masuk sampai kunci dibuka.` : `Kunci akun “${a.nama}” dibuka.`)
    } else if (aksi === 'hapus') {
      await hapusAkun(a.id, 'permintaan pemilik akun')
      ubah(a.id, { status: 'dihapus', telepon: '—', email: null })
      toast(`Akun “${a.nama}” dihapus atas permintaan pemiliknya.`)
    } else {
      await kirimResetPin(a.id)
      toast(`Kode reset PIN dikirim ke ${a.email ?? a.telepon} (data contoh — tidak ada yang terkirim).`, 'info')
    }
    setProses(false)
    setAksi(null)
    setSetuju(false)
  }

  return (
    <>
      <section className="panel saring" aria-label="Cari dan saring akun">
        <label className="kolom-cari">
          <span className="sr">Cari akun</span>
          <input type="search" placeholder="Cari nama, nomor, email, atau tambak…" value={cari} onChange={(e) => setCari(e.target.value)} />
        </label>
        <label className="pilih">
          <span>Peran</span>
          <select value={peran} onChange={(e) => setPeran(e.target.value as typeof peran)}>
            <option value="semua">Semua</option>
            <option value="pemilik">Pemilik</option>
            <option value="pekerja">Pekerja</option>
          </select>
        </label>
        <label className="pilih">
          <span>Kabupaten</span>
          <select value={kab} onChange={(e) => setKab(e.target.value)}>
            <option value="semua">Semua kabupaten</option>
            {kabupaten.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
        <p className="kecil redup-teks hitung" aria-live="polite">{angka(tampak.length)} dari {angka(akun.length)} akun</p>
      </section>

      <div className="grid-pengguna">
        <Panel judul="Akun" aksi={<span className="redup-teks kecil">kontak disamarkan</span>} className="panel-tabel">
          <div className="gulir-x" tabIndex={0} aria-label="Tabel akun, geser ke samping bila perlu">
            <table className="tabel tabel-akun">
              <thead>
                <tr>
                  <th scope="col">Nama</th><th scope="col">Telepon</th><th scope="col">Email</th><th scope="col">Daftar</th>
                  <th scope="col">Terakhir aktif</th><th scope="col">Peran</th><th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {tampak.map((x) => (
                  <tr key={x.id} className={x.id === pilih ? 'terpilih' : ''} aria-selected={x.id === pilih}>
                    <td>
                      <button className="tautan-baris" onClick={() => lihat(x.id)} aria-label={`Lihat detail ${x.nama}`}>{x.nama}</button>
                      <small className="redup-teks">{[tambak?.find((y) => y.id === x.tambakId)?.nama ?? 'Belum punya tambak', x.kabupaten].filter(Boolean).join(' · ')}</small>
                    </td>
                    <td className="mono">{x.telepon}</td>
                    <td className="mono">{x.email ?? <span className="redup-teks">—</span>}</td>
                    <td>{tanggal(x.daftar)}</td>
                    <td>{lalu(x.terakhirAktif)}</td>
                    <td><span className={`peran peran-${x.peran}`}>{x.peran}</span></td>
                    <td><Pill s={PILL_AKUN[x.status].s}>{PILL_AKUN[x.status].label}</Pill></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {tampak.length === 0 && <p className="kosong-baris redup-teks">Tidak ada akun yang cocok dengan pencarian ini.</p>}
          </div>
        </Panel>

        <div className="kolom-detail">
          {a ? (
            <Panel judul={a.nama} id="detail-akun" aksi={<Pill s={PILL_AKUN[a.status].s}>{PILL_AKUN[a.status].label}</Pill>}>
              <dl className="dl">
                <dt>Peran</dt><dd className="cap">{a.peran}</dd>
                <dt>Telepon</dt><dd className="mono">{a.telepon}</dd>
                <dt>Email</dt><dd className="mono">{a.email ?? '—'}</dd>
                <dt>Daftar</dt><dd>{tanggal(a.daftar)}</dd>
                <dt>Terakhir aktif</dt><dd>{lalu(a.terakhirAktif)}</dd>
              </dl>

              {!AKSI_AKUN && <p className="kecil redup-teks">Kunci akun, hapus akun dan kirim kode reset PIN dari dasbor menyusul. Untuk sekarang, pemilik akun memakai Lupa PIN atau Hapus akun di aplikasi.</p>}
              {AKSI_AKUN && a.status !== 'dihapus' && (
                <div className="aksi-akun" role="group" aria-label="Aksi akun">
                  <button className="tombol" aria-pressed={aksi === 'pin'} onClick={() => setAksi(aksi === 'pin' ? null : 'pin')}>Kirim kode reset PIN</button>
                  <button className="tombol" aria-pressed={aksi === 'kunci'} onClick={() => setAksi(aksi === 'kunci' ? null : 'kunci')}>{a.status === 'terkunci' ? 'Buka kunci' : 'Kunci akun spam'}</button>
                  <button className="tombol bahaya" aria-pressed={aksi === 'hapus'} onClick={() => setAksi(aksi === 'hapus' ? null : 'hapus')}>Hapus akun…</button>
                </div>
              )}

              {aksi && (
                <div className={`konfirmasi ${aksi === 'hapus' ? 'k-bahaya' : ''}`} ref={konfirmasiRef} role="group" aria-labelledby="judul-konfirmasi">
                  <b id="judul-konfirmasi">
                    {aksi === 'pin' ? 'Kirim kode reset PIN?' : aksi === 'kunci' ? (a.status === 'terkunci' ? 'Buka kunci akun ini?' : 'Kunci akun ini sebagai spam?') : 'Hapus akun secara permanen?'}
                  </b>
                  <p>
                    {aksi === 'pin' && <>Kode 6 angka dikirim ke <span className="mono">{a.email ?? a.telepon}</span>, berlaku 15 menit. PIN lama tetap berlaku sampai diganti.</>}
                    {aksi === 'kunci' && (a.status === 'terkunci'
                      ? <>Pemilik akun bisa masuk lagi seperti biasa.</>
                      : <>Akun tak bisa masuk dan tak muncul di tambak mana pun. Catatan kolam tidak dihapus. Bisa dibuka lagi kapan saja.</>)}
                    {aksi === 'hapus' && <>Akun, kontak, dan {a.peran === 'pemilik' ? 'seluruh catatan tambak miliknya' : 'catatan yang ia buat'} dihapus permanen. Lakukan hanya atas permintaan pemilik akun.</>}
                  </p>
                  {aksi === 'hapus' && (
                    <label className="centang">
                      <input type="checkbox" checked={setuju} onChange={(e) => setSetuju(e.target.checked)} />
                      Permintaan hapus dari pemilik akun sudah saya periksa (mis. lewat Bantuan).
                    </label>
                  )}
                  <div className="baris aksi">
                    <button className={`tombol ${aksi === 'hapus' ? 'bahaya-isi' : 'utama'}`} disabled={proses || (aksi === 'hapus' && !setuju)} onClick={jalankan}>
                      {proses ? 'Memproses…' : aksi === 'pin' ? 'Ya, kirim kode' : aksi === 'kunci' ? (a.status === 'terkunci' ? 'Ya, buka kunci' : 'Ya, kunci akun') : 'Ya, hapus permanen'}
                    </button>
                    <button className="tombol" onClick={() => setAksi(null)} disabled={proses}>Batal</button>
                  </div>
                </div>
              )}
            </Panel>
          ) : <Panel><p className="redup-teks">Pilih akun dari daftar.</p></Panel>}

          {t && (
            <Panel judul="Tambak">
              <p className="nama-tambak"><b>{t.nama}</b>{t.kabupaten && <span className="redup-teks"> · {t.kabupaten}</span>}</p>
              <div className="statistik">
                <div><small>Kolam</small><b>{angka(t.kolam)}</b></div>
                <div><small>Pekerja</small><b>{angka(t.pekerja)}</b></div>
                <div><small>Catatan 7 hari</small><b>{angka(t.catatan7Hari)}</b></div>
              </div>
              <dl className="dl">
                <dt>Catatan terakhir</dt><dd>{t.catatanTerakhir ? <>{lalu(t.catatanTerakhir)} <span className="redup-teks">({tanggal(t.catatanTerakhir)})</span></> : 'belum ada'}</dd>
                <dt>Pemilik</dt><dd>{akun.find((x) => x.id === t.pemilikId)?.nama ?? '—'}</dd>
              </dl>
              {anggota.length > 0 && (
                <>
                  <h3 className="sub-judul">Orang lain di tambak ini</h3>
                  <ul className="anggota">
                    {anggota.map((x) => (
                      <li key={x.id}>
                        <button className="tautan-baris" onClick={() => lihat(x.id)}>{x.nama}</button>
                        <span className={`peran peran-${x.peran}`}>{x.peran}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </Panel>
          )}
        </div>
      </div>
    </>
  )
}
