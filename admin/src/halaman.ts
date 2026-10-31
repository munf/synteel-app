// Daftar halaman & kategori navigasi atas (pola sama dgn data2.ts dasbor ops).
// Tambah halaman: tambahkan baris di HALAMAN + cabang di App.tsx (Isi).

export type Halaman = 'ringkasan' | 'pengguna' | 'bantuan' | 'ai' | 'kesehatan' | 'wilayah'

export const HALAMAN: { id: Halaman; label: string; grup: Kategori; ikon: string; fokus: string }[] = [
  { id: 'ringkasan', label: 'Ringkasan', grup: 'Ikhtisar', ikon: '◈', fokus: 'Pendaftar, keaktifan, dan apa yang perlu ditangani hari ini' },
  { id: 'pengguna', label: 'Pengguna & tambak', grup: 'Pengguna', ikon: '◉', fokus: 'Cari akun dan lihat tambaknya' },
  { id: 'bantuan', label: 'Bantuan', grup: 'Pengguna', ikon: '✉', fokus: 'Pesan dari formulir Bantuan — balas lewat email' },
  { id: 'ai', label: 'Pemakaian AI', grup: 'Operasional', ikon: '✦', fokus: 'Panggilan foto, suara, video & ringkasan malam' },
  { id: 'kesehatan', label: 'Kesehatan sistem', grup: 'Operasional', ikon: '▤', fokus: 'Layanan, VPS, backup, email kode & login' },
  { id: 'wilayah', label: 'Gambaran wilayah', grup: 'Wilayah', ikon: '▦', fokus: 'Agregat per kabupaten untuk mitra & dinas' },
]

/** Kategori navigasi atas, urut tampil. Tiap kategori = satu tombol dgn sub-menu. */
export const KATEGORI = ['Ikhtisar', 'Pengguna', 'Operasional', 'Wilayah'] as const
export type Kategori = (typeof KATEGORI)[number]

export const HALAMAN_AWAL: Halaman = 'ringkasan'
