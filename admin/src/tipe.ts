// Tipe data dasbor — sama dengan jawaban server (server/src/admin.ts, GET /api/admin/...).
// Data contoh untuk artifact ada di mock.ts dan hanya dipakai saat build --mode contoh.

/** true di build artifact (data contoh), false di dasbor asli. */
export const CONTOH = import.meta.env.MODE === 'contoh'
/** "Sekarang": waktu tetap di data contoh supaya tangkapan layar selalu sama. */
export const kini = () => (CONTOH ? new Date('2026-10-31T09:30:00+07:00') : new Date())

export type Peran = 'pemilik' | 'pekerja'
export type StatusAkun = 'aktif' | 'terkunci' | 'dihapus'
export type FiturAi = 'foto' | 'suara' | 'video' | 'malam'
/** status layanan — sama dgn dasbor ops: normal / degraded / critical / off */
export type Status = 'normal' | 'degraded' | 'critical' | 'off'

export const FITUR_AI: { id: FiturAi; label: string }[] = [
  // urutan TETAP — warna kategori mengikuti urutan ini (lihat --seri-* di styles.css)
  { id: 'foto', label: 'Foto' },
  { id: 'suara', label: 'Suara' },
  { id: 'video', label: 'Video' },
  { id: 'malam', label: 'Ringkasan malam' },
]

/** Nama kabupaten/kota dari kode desa BMKG yang dipilih pemilik tambak. */
export type Kabupaten = string

// ─────────────────────────── 1. Ringkasan ───────────────────────────
export interface Ringkasan {
  hari: string[] // 14 hari terakhir
  daftarPerHari: number[] // akun baru per hari (tanpa tamu demo)
  daftarHariIni: number
  daftar7Hari: number
  aktif7Hari: number // akun yang membuka aplikasi ≥1× dlm 7 hari
  totalAkun: number
  tambak: number
  kolam: number
  catatanPerHari: number[] // catatan kolam per hari
  kasusTerbuka: number
  bantuanBelumDibalas: number
  /** Tamu "Coba demo" — TIDAK dihitung di angka pengguna di atas. */
  demo: { sesiHariIni: number; sesi7Hari: number; menitRata: number | null; lanjutDaftar7Hari: number | null; perHari: number[] }
}

export interface Kasus {
  id: string
  jenis: 'Kematian naik' | 'Listrik padam'
  tambak: string
  kabupaten: Kabupaten
  sejak: string
  catatan: string
}

// ─────────────────────────── 2. Pengguna & tambak ───────────────────────────
export interface Akun {
  id: string
  nama: string
  telepon: string // SUDAH disamarkan, mis. 0812-••••-4471
  email: string | null // SUDAH disamarkan, mis. bu••@gmail.com
  peran: Peran
  status: StatusAkun
  daftar: string
  terakhirAktif: string | null
  kabupaten: Kabupaten
  tambakId: string | null
}

export interface Tambak {
  id: string
  nama: string
  kabupaten: Kabupaten
  pemilikId: string | null
  kolam: number
  pekerja: number
  catatanTerakhir: string | null
  catatan7Hari: number
}

// ─────────────────────────── 3. Bantuan ───────────────────────────
export type StatusBantuan = 'baru' | 'dibalas' | 'selesai'
export interface PesanUtas { dari: 'pengguna' | 'tim'; nama: string; isi: string; waktu: string }
export interface Bantuan {
  id: string
  nama: string
  kontak: string // email/HP tersamar
  akunId: string | null // null = bukan pengguna terdaftar (mis. dari situs)
  topik: string
  status: StatusBantuan
  masuk: string
  /** sudah diteruskan ke email tim (fajarnugraha@synt.fun) */
  terkirimEmail?: boolean
  utas: PesanUtas[]
}

// ─────────────────────────── 4. Pemakaian AI ───────────────────────────
export interface PemakaianAi {
  hari: string[]
  perFitur: Record<FiturAi, number[]> // panggilan per hari
  log: { id: string; waktu: string; fitur: FiturAi; tambak: string | null; durasiDtk: number; hasil: 'gagal' | 'lambat'; pesan: string }[]
  kuota: { tambak: string; kabupaten: Kabupaten; pakai: number; batas: number | null }[]
  ambangLambatDtk: number
}

// ─────────────────────────── 5. Kesehatan sistem ───────────────────────────
export interface Kesehatan {
  layanan: { id: string; nama: string; ket: string; status: Status; waktuRespon: number | null; cek: string }[]
  vps: { ramTotalGb: number; ramPakaiGb: number; diskTotalGb: number; diskPakaiGb: number }
  backup: { terakhir: string; ukuranMb: number; tujuan: string; berhasil: boolean } | null
  hari: string[]
  emailKode: { terkirim: number[]; gagal: number[] }
  login: { gagal: number[]; kenaBatas: number[] }
  galat: { waktu: string; rute: string; kode: number; pesan: string; jumlah: number }[]
}

// ─────────────────────────── 6. Gambaran wilayah ───────────────────────────
export interface Wilayah {
  /** kabupaten dengan kurang dari 3 tambak tidak dikirim server; null hanya di data contoh lama */
  sebaran: { kabupaten: Kabupaten; provinsi: string; tambak: number | null; kolam: number | null; kol: number; baris: number }[]
  minggu: string[] // label 8 minggu terakhir
  kematian: { kabupaten: Kabupaten; kasus: number[] }[] // laporan kematian naik per minggu
  listrik: { kabupaten: Kabupaten; laporan: number }[] // laporan listrik padam, 30 hari
  pembaruan: string
  /** jumlah kabupaten yang disembunyikan (kurang dari 3 tambak) */
  tersembunyi?: number
}
