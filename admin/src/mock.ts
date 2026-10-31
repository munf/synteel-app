// ════════════════════════════════════════════════════════════════════════════
//  DATA CONTOH — satu-satunya sumber angka di template ini.
//
//  Semua halaman membaca data lewat src/api.ts, yang SEKARANG mengembalikan isi
//  berkas ini. Saat API asli siap: biarkan TIPE di sini (atau pindahkan ke
//  src/tipe.ts), ganti isi fungsi di api.ts dengan fetch ke endpoint, lalu
//  hapus berkas ini. Tak ada halaman yang mengimpor mock.ts secara langsung.
//
//  Aturan privasi yang sudah diikuti data contoh (pertahankan di API asli):
//   - nomor HP & email DIKIRIM SUDAH DISAMARKAN dari server — browser admin
//     tak pernah menerima nomor/email utuh.
//   - data wilayah = agregat tanpa nama; kabupaten < 3 tambak tak dikirim;
//     tamu "Coba demo" tidak dihitung di angka pengguna.
// ════════════════════════════════════════════════════════════════════════════

import type { Akun, Bantuan, Kasus, Kesehatan, PemakaianAi, Ringkasan, Tambak, Wilayah } from './tipe'

const KABUPATEN = [
  'Sleman', 'Bantul', 'Kulon Progo', 'Cilacap', 'Banyumas', 'Kebumen', 'Purworejo', 'Magelang', 'Klaten',
  'Sukabumi', 'Cianjur', 'Garut', 'Tasikmalaya', 'Banyuwangi', 'Jember', 'Malang', 'Poso', 'Tabanan',
] as const
type Kabupaten = (typeof KABUPATEN)[number]

/** "Sekarang" yang tetap untuk data contoh (WIB) — tangkapan layar selalu sama. */
export const KINI = new Date('2026-10-31T09:30:00+07:00')

// PRNG berbenih → angka contoh stabil di tiap muat
function acak(benih: number) {
  let s = benih >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}
const r = acak(20261031)
const antara = (a: number, b: number) => Math.round(a + r() * (b - a))
const jamLalu = (j: number) => new Date(KINI.getTime() - j * 3600e3).toISOString()
const hariLalu = (h: number) => jamLalu(h * 24)
/** n hari terakhir, lama → baru, format ISO tanggal (YYYY-MM-DD, WIB) */
export const hariTerakhir = (n: number) =>
  Array.from({ length: n }, (_, i) => new Date(KINI.getTime() + 7 * 3600e3 - (n - 1 - i) * 864e5).toISOString().slice(0, 10))

// ════════════════════════════ DATA ════════════════════════════

const HARI14 = hariTerakhir(14)

const daftarPerHari = HARI14.map((_, i) => antara(0, 4) + Math.round(i * 0.15))
const demoPerHari = HARI14.map(() => antara(4, 22))

export const RINGKASAN: Ringkasan = {
  hari: HARI14,
  daftarPerHari,
  daftarHariIni: 3, // hari ini baru sampai 09:30 WIB
  daftar7Hari: daftarPerHari.slice(-7).reduce((a, b) => a + b, 0),
  aktif7Hari: 38,
  totalAkun: 57,
  tambak: 20,
  kolam: 96,
  catatanPerHari: HARI14.map((_, i) => antara(140, 190) + i * 3),
  kasusTerbuka: 3,
  bantuanBelumDibalas: 4,
  demo: { sesiHariIni: 12, sesi7Hari: demoPerHari.slice(-7).reduce((a, b) => a + b, 0), menitRata: 6.4, lanjutDaftar7Hari: 4, perHari: demoPerHari },
}

export const KASUS: Kasus[] = [
  { id: 'k1', jenis: 'Kematian naik', tambak: 'Tambak Sidat Mitra', kabupaten: 'Sleman', sejak: hariLalu(1.2), catatan: 'Kolam B: kasus sidat mati masih terbuka.' },
  { id: 'k2', jenis: 'Listrik padam', tambak: 'Tambak Sidat Kali Progo', kabupaten: 'Kulon Progo', sejak: jamLalu(7), catatan: 'Listrik padam, belum ditandai menyala lagi.' },
  { id: 'k3', jenis: 'Kematian naik', tambak: 'Tambak Bu Lastri', kabupaten: 'Cilacap', sejak: hariLalu(2.5), catatan: 'Kolam 2: kasus sidat mati masih terbuka.' },
]

// ── akun & tambak ──
const NAMA_PEMILIK = [
  'Sumarni', 'Darto Wiyono', 'Lastri Handayani', 'Agus Salim', 'Nur Aini', 'Bambang Riyadi', 'Siti Khotimah', 'Joko Prasetyo',
  'Wahyuni', 'Rudi Hartono', 'Eko Susanto', 'Sri Mulyani', 'Hendra Gunawan', 'Yuliani', 'Slamet Raharjo', 'Ani Rahmawati',
  'Teguh Santoso', 'Rina Marlina', 'Supardi', 'Dewi Kurnia',
]
const NAMA_PEKERJA = [
  'Andi', 'Bayu', 'Cahyo', 'Dimas', 'Fajar', 'Gilang', 'Heru', 'Imam', 'Jamal', 'Kurniawan', 'Lukman', 'Mamat', 'Nanang', 'Oki',
  'Purwanto', 'Rizal', 'Samsul', 'Tono', 'Udin', 'Wawan', 'Yusuf', 'Zainal',
]
const NAMA_TAMBAK = [
  'Sidat Mitra', 'Sidat Kali Progo', 'Bu Lastri', 'Sidat Serayu', 'Sumber Rejeki', 'Elver Makmur', 'Tirta Sejahtera', 'Sidat Mas',
  'Karya Tani', 'Segara Anakan', 'Muara Indah', 'Lestari', 'Sidat Jaya', 'Barokah', 'Glass Eel Bantul', 'Tunas Baru', 'Kali Opak',
  'Pak Darto', 'Mekar Sari', 'Rejo Mulyo',
]
const DOMAIN = ['gmail.com', 'gmail.com', 'yahoo.co.id', 'gmail.com']
const PREFIX = ['0812', '0813', '0852', '0857', '0878', '0896', '0821']

const samarHp = () => `${PREFIX[antara(0, PREFIX.length - 1)]}-••••-${String(antara(1000, 9999))}`
const samarEmail = (nama: string) => `${nama.toLowerCase().replace(/[^a-z]/g, '').slice(0, 2)}••@${DOMAIN[antara(0, DOMAIN.length - 1)]}`

export const TAMBAK: Tambak[] = []
export const AKUN: Akun[] = []
NAMA_TAMBAK.forEach((t, i) => {
  const kab = KABUPATEN[(i * 7 + 3) % KABUPATEN.length]
  const pemilikId = `a${String(i * 3 + 1).padStart(3, '0')}`
  const pekerja = antara(0, 3)
  const tambak: Tambak = {
    id: `t${String(i + 1).padStart(3, '0')}`,
    nama: `Tambak ${t}`,
    kabupaten: kab,
    pemilikId,
    kolam: antara(2, 8),
    pekerja,
    catatanTerakhir: jamLalu(i === 4 ? 80 : antara(1, 30)),
    catatan7Hari: i === 4 ? 0 : antara(14, 90),
  }
  TAMBAK.push(tambak)
  const nama = NAMA_PEMILIK[i]
  AKUN.push({
    id: pemilikId, nama, telepon: samarHp(), email: i % 3 === 2 ? null : samarEmail(nama), peran: 'pemilik',
    status: i === 13 ? 'terkunci' : 'aktif', daftar: hariLalu(antara(3, 160)), terakhirAktif: jamLalu(antara(1, 60)), kabupaten: kab, tambakId: tambak.id,
  })
  for (let p = 0; p < Math.min(2, pekerja); p++) {
    const np = NAMA_PEKERJA[(i * 2 + p) % NAMA_PEKERJA.length]
    AKUN.push({
      id: `a${String(i * 3 + 2 + p).padStart(3, '0')}`, nama: np, telepon: samarHp(), email: null, peran: 'pekerja',
      status: 'aktif', daftar: hariLalu(antara(1, 120)), terakhirAktif: jamLalu(antara(1, 200)), kabupaten: kab, tambakId: tambak.id,
    })
  }
})
// satu akun spam yang jelas, untuk mencoba aksi "kunci"
AKUN.push({
  id: 'a099', nama: 'PROMO PAKAN MURAH WA', telepon: '0896-••••-0001', email: 'pr••@yahoo.co.id', peran: 'pemilik', status: 'aktif',
  daftar: hariLalu(0.3), terakhirAktif: jamLalu(0.5), kabupaten: 'Sleman', tambakId: 't001',
})

// ── bantuan ──
export const BANTUAN: Bantuan[] = [
  {
    id: 'b1', nama: 'Sumarni', kontak: 'su••@gmail.com', akunId: 'a001', topik: 'Catat dan suara', status: 'baru', masuk: jamLalu(1.5),
    utas: [{ dari: 'pengguna', nama: 'Sumarni', waktu: jamLalu(1.5), isi: 'Selamat pagi. Sejak kemarin foto kolam 2 tidak bisa diunggah, muncul tulisan "gagal mengirim". Sinyal di tambak memang lemah. Apakah fotonya hilang?' }],
  },
  {
    id: 'b2', nama: 'Darto Wiyono', kontak: 'da••@gmail.com', akunId: 'a004', topik: 'Masuk dan PIN', status: 'baru', masuk: jamLalu(4),
    utas: [{ dari: 'pengguna', nama: 'Darto Wiyono', waktu: jamLalu(4), isi: 'Pekerja saya (Bayu) sudah saya undang tapi kodenya tidak sampai ke HP-nya. Nomornya benar.' }],
  },
  {
    id: 'b3', nama: 'Tamu situs', kontak: 'ko••@yahoo.co.id', akunId: null, topik: 'Lainnya', status: 'baru', masuk: jamLalu(9),
    utas: [{ dari: 'pengguna', nama: 'Tamu situs', waktu: jamLalu(9), isi: 'Sudah coba demo. Apakah synteel juga bisa dipakai untuk pembesaran sidat, bukan hanya pendederan glass eel?' }],
  },
  {
    id: 'b4', nama: 'Lastri Handayani', kontak: 'la••@gmail.com', akunId: 'a007', topik: 'Waspada dan alarm', status: 'baru', masuk: jamLalu(20),
    utas: [{ dari: 'pengguna', nama: 'Lastri Handayani', waktu: jamLalu(20), isi: 'Dua hari ini ringkasan malam tidak muncul. Biasanya selalu ada sebelum jam 8 malam.' }],
  },
  {
    id: 'b5', nama: 'Agus Salim', kontak: 'ag••@gmail.com', akunId: 'a010', topik: 'Lainnya', status: 'dibalas', masuk: hariLalu(1.5),
    utas: [
      { dari: 'pengguna', nama: 'Agus Salim', waktu: hariLalu(1.5), isi: 'Kolam 5 sudah tidak dipakai. Bagaimana cara menghapusnya tanpa kehilangan catatan lama?' },
      { dari: 'tim', nama: 'Tim synteel', waktu: hariLalu(1.3), isi: 'Halo Pak Agus, buka Kolam 5 lalu Ubah kolam, pilih Arsipkan. Catatan lama tetap tersimpan.' },
    ],
  },
  {
    id: 'b6', nama: 'Nur Aini', kontak: 'nu••@gmail.com', akunId: 'a013', topik: 'Masuk dan PIN', status: 'selesai', masuk: hariLalu(3),
    utas: [
      { dari: 'pengguna', nama: 'Nur Aini', waktu: hariLalu(3), isi: 'Saya lupa PIN dan sudah salah 3 kali.' },
      { dari: 'tim', nama: 'Tim synteel', waktu: hariLalu(2.9), isi: 'Kode reset PIN sudah kami kirim ke email Ibu. Berlaku 15 menit.' },
      { dari: 'pengguna', nama: 'Nur Aini', waktu: hariLalu(2.8), isi: 'Sudah bisa masuk lagi, terima kasih.' },
    ],
  },
  {
    id: 'b7', nama: 'Bambang Riyadi', kontak: 'ba••@gmail.com', akunId: 'a016', topik: 'Lainnya', status: 'dibalas', masuk: hariLalu(2),
    utas: [
      { dari: 'pengguna', nama: 'Bambang Riyadi', waktu: hariLalu(2), isi: 'Tambak saya sudah dijual. Mohon akun dan data saya dihapus.' },
      { dari: 'tim', nama: 'Tim synteel', waktu: hariLalu(1.8), isi: 'Baik Pak, mohon konfirmasi sekali lagi dengan membalas email ini. Setelah itu akun dan seluruh catatan dihapus permanen.' },
    ],
  },
  {
    id: 'b8', nama: 'Siti Khotimah', kontak: 'si••@yahoo.co.id', akunId: 'a019', topik: 'Catat dan suara', status: 'selesai', masuk: hariLalu(5),
    utas: [
      { dari: 'pengguna', nama: 'Siti Khotimah', waktu: hariLalu(5), isi: 'Video kolam saya diproses lebih dari 5 menit.' },
      { dari: 'tim', nama: 'Tim synteel', waktu: hariLalu(4.9), isi: 'Video di atas 60 detik memang lebih lama. Coba rekam 20–30 detik saja, hasilnya keluar < 1 menit.' },
    ],
  },
]

// ── AI ──
const naikTurun = (dasar: number, sebar: number) => HARI14.map((_, i) => Math.max(0, Math.round(dasar + (r() - 0.5) * sebar + i * dasar * 0.012)))
const NAMA_TAMBAK_PENUH = NAMA_TAMBAK.map((n) => `Tambak ${n}`)

export const PEMAKAIAN_AI: PemakaianAi = {
  hari: HARI14,
  perFitur: { foto: naikTurun(42, 14), suara: naikTurun(26, 10), video: naikTurun(7, 5), malam: naikTurun(18, 3) },
  ambangLambatDtk: 30,
  log: [
    { id: 'l1', waktu: jamLalu(0.8), fitur: 'video', tambak: NAMA_TAMBAK_PENUH[2], durasiDtk: 94, hasil: 'lambat', pesan: 'Video 2 mnt 10 dtk, diproses penuh' },
    { id: 'l2', waktu: jamLalu(2.1), fitur: 'foto', tambak: NAMA_TAMBAK_PENUH[0], durasiDtk: 12, hasil: 'gagal', pesan: 'Unggahan terputus (koneksi)' },
    { id: 'l3', waktu: jamLalu(3.4), fitur: 'suara', tambak: NAMA_TAMBAK_PENUH[7], durasiDtk: 41, hasil: 'lambat', pesan: 'Rekaman 3 mnt, bising aerator' },
    { id: 'l4', waktu: jamLalu(5), fitur: 'malam', tambak: NAMA_TAMBAK_PENUH[2], durasiDtk: 48, hasil: 'gagal', pesan: 'Model tidak menjawab, ringkasan dari aturan' },
    { id: 'l5', waktu: jamLalu(6.2), fitur: 'foto', tambak: NAMA_TAMBAK_PENUH[11], durasiDtk: 8, hasil: 'gagal', pesan: 'Gambar terlalu gelap untuk dibaca' },
    { id: 'l6', waktu: jamLalu(9), fitur: 'video', tambak: NAMA_TAMBAK_PENUH[5], durasiDtk: 0, hasil: 'gagal', pesan: 'Kuota AI tambak habis' },
    { id: 'l7', waktu: jamLalu(13), fitur: 'suara', tambak: NAMA_TAMBAK_PENUH[3], durasiDtk: 35, hasil: 'lambat', pesan: 'Antrean penyedia AI padat' },
    { id: 'l8', waktu: jamLalu(20), fitur: 'foto', tambak: NAMA_TAMBAK_PENUH[9], durasiDtk: 31, hasil: 'lambat', pesan: 'Foto 12 MB, dikompres di server' },
    { id: 'l9', waktu: jamLalu(26), fitur: 'malam', tambak: NAMA_TAMBAK_PENUH[14], durasiDtk: 60, hasil: 'gagal', pesan: 'Batas waktu penyedia AI (timeout)' },
  ],
  kuota: [
    { tambak: NAMA_TAMBAK_PENUH[5], kabupaten: 'Purworejo', pakai: 60, batas: 60 },
    { tambak: NAMA_TAMBAK_PENUH[2], kabupaten: 'Cilacap', pakai: 54, batas: 60 },
    { tambak: NAMA_TAMBAK_PENUH[9], kabupaten: 'Cilacap', pakai: 41, batas: 60 },
    { tambak: NAMA_TAMBAK_PENUH[0], kabupaten: 'Sleman', pakai: 33, batas: 60 },
    { tambak: NAMA_TAMBAK_PENUH[12], kabupaten: 'Banyuwangi', pakai: 12, batas: 60 },
  ],
}

// ── kesehatan ──
export const KESEHATAN: Kesehatan = {
  layanan: [
    { id: 'app', nama: 'Aplikasi', ket: 'Aplikasi petani dan API (eel.synt.fun/app)', status: 'normal', waktuRespon: 182, cek: jamLalu(0.02) },
    { id: 'preview', nama: 'Preview', ket: 'Versi uji dengan tambak demo (eel.synt.fun/preview)', status: 'degraded', waktuRespon: 1240, cek: jamLalu(0.02) },
    { id: 'situs', nama: 'Situs', ket: 'Halaman depan dan kebijakan privasi (eel.synt.fun)', status: 'normal', waktuRespon: 96, cek: jamLalu(0.02) },
  ],
  vps: { ramTotalGb: 1.9, ramPakaiGb: 1.2, diskTotalGb: 38.7, diskPakaiGb: 17.4 },
  backup: { terakhir: jamLalu(7.5), ukuranMb: 0.2, tujuan: 'Di VPS (/var/backups/synteel), disimpan 30 hari', berhasil: true },
  hari: HARI14,
  emailKode: { terkirim: HARI14.map(() => antara(2, 9)), gagal: HARI14.map((_, i) => (i === 9 ? 3 : antara(0, 1))) },
  login: { gagal: HARI14.map(() => antara(1, 8)), kenaBatas: HARI14.map((_, i) => (i === 11 ? 3 : antara(0, 1))) },
  galat: [
    { waktu: jamLalu(0.4), rute: 'POST /ponds/:id/capture', kode: 500, pesan: 'fetch failed', jumlah: 3 },
    { waktu: jamLalu(2.6), rute: 'POST /auth/code', kode: 500, pesan: 'SMTP 421: rate limit sementara', jumlah: 1 },
    { waktu: jamLalu(19), rute: 'POST /briefing', kode: 500, pesan: 'Cannot read properties of null (reading \'lat\')', jumlah: 2 },
  ],
}

// ── wilayah ──
// posisi petak: kolom = barat→timur, baris = utara→selatan (perkiraan, BUKAN skala), seperti hitungan server.
// Kabupaten dengan kurang dari 3 tambak tidak dikirim server, jadi juga tidak ada di sini.
const PETAK: [Kabupaten, string, number, number][] = [
  ['Sukabumi', 'Jawa Barat', 0, 0], ['Cianjur', 'Jawa Barat', 1, 0], ['Garut', 'Jawa Barat', 2, 0], ['Tasikmalaya', 'Jawa Barat', 3, 0],
  ['Cilacap', 'Jawa Tengah', 4, 1], ['Banyumas', 'Jawa Tengah', 5, 0], ['Kebumen', 'Jawa Tengah', 6, 1], ['Purworejo', 'Jawa Tengah', 7, 1],
  ['Magelang', 'Jawa Tengah', 8, 0], ['Klaten', 'Jawa Tengah', 9, 0], ['Kulon Progo', 'DI Yogyakarta', 8, 1], ['Sleman', 'DI Yogyakarta', 9, 1],
  ['Bantul', 'DI Yogyakarta', 10, 1], ['Malang', 'Jawa Timur', 13, 1], ['Jember', 'Jawa Timur', 14, 1], ['Banyuwangi', 'Jawa Timur', 15, 1],
]
const JUMLAH_TAMBAK: Partial<Record<Kabupaten, number>> = {
  Sukabumi: 4, Cianjur: 3, Garut: 3, Tasikmalaya: 5, Cilacap: 9, Banyumas: 3, Kebumen: 6, Purworejo: 7, Magelang: 3, Klaten: 4,
  'Kulon Progo': 8, Sleman: 11, Bantul: 6, Malang: 3, Jember: 4, Banyuwangi: 5,
}
const MINGGU = Array.from({ length: 8 }, (_, i) => `M-${7 - i}`).map((m) => (m === 'M-0' ? 'mgg ini' : m))

export const WILAYAH: Wilayah = {
  sebaran: PETAK.map(([kabupaten, provinsi, kol, baris]) => {
    const t = JUMLAH_TAMBAK[kabupaten] ?? 3
    return { kabupaten, provinsi, tambak: t, kolam: Math.round(t * (3 + r() * 1.6)), kol, baris }
  }),
  minggu: MINGGU,
  kematian: (['Sleman', 'Cilacap', 'Kulon Progo', 'Purworejo', 'Kebumen'] as Kabupaten[]).map((kabupaten, k) => ({
    kabupaten,
    kasus: MINGGU.map((_, i) => Math.max(0, Math.round((k < 2 ? i * 0.3 : 0.6) + (r() - 0.5) * 1.6))),
  })),
  listrik: (['Cilacap', 'Kebumen', 'Sleman', 'Purworejo', 'Banyuwangi'] as Kabupaten[])
    .map((kabupaten) => ({ kabupaten, laporan: antara(1, 8) }))
    .sort((a, b) => b.laporan - a.laporan),
  pembaruan: jamLalu(3),
  tersembunyi: 4,
}

// kabupaten kasus & kuota mengikuti tambaknya (supaya data contoh saling cocok)
for (const x of [...KASUS, ...PEMAKAIAN_AI.kuota]) {
  const t = TAMBAK.find((y) => y.nama === x.tambak)
  if (t) x.kabupaten = t.kabupaten
}
