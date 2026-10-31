// ════════════════════════════════════════════════════════════════════════════
//  Lapisan data. Dasbor asli: fetch ke server (server/src/admin.ts) di ../api/admin,
//  relatif terhadap halaman, jadi /app/admin/ memakai /app/api/admin dan /preview/admin/
//  memakai /preview/api/admin. Build artifact (vite build --mode contoh): data contoh
//  dari mock.ts, tanpa jaringan.
//
//  Aksi akun (kunci, hapus, reset PIN) dan balasan email belum ada di server: di dasbor
//  asli tombolnya dinonaktifkan (AKSI_AKUN, BALAS_EMAIL). Setiap aksi baru WAJIB
//  divalidasi dan dicatat (audit) di server; konfirmasi di halaman hanya pengaman tampilan.
// ════════════════════════════════════════════════════════════════════════════
import { CONTOH, type Akun, type Bantuan, type Kasus, type Kesehatan, type PemakaianAi, type Ringkasan, type Tambak, type Wilayah } from './tipe'

/** Server menjawab 401: sesi admin habis atau belum masuk. */
export class BelumMasuk extends Error {}

const DASAR = new URL('../api/admin', location.href).pathname

async function ambil<T>(jalur: string, init?: RequestInit): Promise<T> {
  const res = await fetch(DASAR + jalur, { credentials: 'same-origin', ...init, headers: { 'content-type': 'application/json', ...init?.headers } })
  const isi = await res.json().catch(() => ({}))
  if (res.status === 401 && jalur !== '/login') {
    window.dispatchEvent(new Event('admin-keluar'))
    throw new BelumMasuk(isi.error ?? 'Silakan masuk dulu')
  }
  if (!res.ok) throw new Error(isi.error ?? `${res.status} ${res.statusText}`)
  return isi as T
}
const kirim = <T,>(jalur: string, isi: unknown) => ambil<T>(jalur, { method: 'POST', body: JSON.stringify(isi) })

// Data contoh dimuat hanya di build artifact, jadi tidak ikut ke dasbor asli.
const mock = () => import('./mock')
const jeda = <T,>(isi: T, ms = 120): Promise<T> => new Promise((ok) => setTimeout(() => ok(structuredClone(isi)), ms))
const contoh = <T,>(pilih: (m: Awaited<ReturnType<typeof mock>>) => T, ms?: number) => mock().then((m) => jeda(pilih(m), ms))

/** Tombol kunci/hapus akun dan kirim kode reset PIN: baru ada di data contoh. */
export const AKSI_AKUN = CONTOH
/** Balas pesan Bantuan dari dasbor: baru ada di data contoh; di dasbor asli balas dari Gmail. */
export const BALAS_EMAIL = CONTOH

// ── masuk ──
export const cekMasuk = (): Promise<{ user: string }> => (CONTOH ? jeda({ user: 'contoh' }) : ambil('/me'))
export const masuk = (user: string, password: string): Promise<{ user: string }> => (CONTOH ? jeda({ user }) : kirim('/login', { user, password }))
export const keluar = (): Promise<unknown> => (CONTOH ? jeda({ ok: true }) : kirim('/logout', {}))

// ── halaman ──
export const ambilRingkasan = (): Promise<Ringkasan> => (CONTOH ? contoh((m) => m.RINGKASAN) : ambil('/ringkasan'))
export const ambilKasus = (): Promise<Kasus[]> => (CONTOH ? contoh((m) => m.KASUS) : ambil('/kasus'))
/** Server mengirim telepon/email SUDAH disamarkan. */
export const ambilAkun = (): Promise<Akun[]> => (CONTOH ? contoh((m) => m.AKUN) : ambil('/akun'))
export const ambilTambak = (): Promise<Tambak[]> => (CONTOH ? contoh((m) => m.TAMBAK) : ambil('/tambak'))
export const ambilBantuan = (): Promise<Bantuan[]> => (CONTOH ? contoh((m) => m.BANTUAN) : ambil('/bantuan'))
export const ambilPemakaianAi = (): Promise<PemakaianAi> => (CONTOH ? contoh((m) => m.PEMAKAIAN_AI) : ambil('/ai'))
export const ambilKesehatan = (): Promise<Kesehatan> => (CONTOH ? contoh((m) => m.KESEHATAN) : ambil('/kesehatan'))
/** Agregat tanpa nama; kabupaten < 3 tambak tidak dikirim; tamu demo tidak dihitung. */
export const ambilWilayah = (): Promise<Wilayah> => (CONTOH ? contoh((m) => m.WILAYAH) : ambil('/wilayah'))

// ── aksi ──
export const ubahStatusBantuan = (id: string, status: Bantuan['status']) => (CONTOH ? jeda({ ok: true }, 200) : kirim<{ ok: boolean }>(`/bantuan/${id}/status`, { status }))
// Belum ada di server (lihat AKSI_AKUN / BALAS_EMAIL): hanya pura-pura berhasil di data contoh.
export const kunciAkun = (_id: string, _kunci: boolean) => jeda({ ok: true }, 250)
export const hapusAkun = (_id: string, _alasan: string) => jeda({ ok: true }, 250)
export const kirimResetPin = (_id: string) => jeda({ ok: true }, 250)
export const balasBantuan = (_id: string, _isi: string) => jeda({ ok: true, waktu: new Date().toISOString() }, 300)
