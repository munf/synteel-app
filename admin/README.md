# synteel admin

Dasbor tim synteel: ringkasan, pengguna dan tambak, pesan Bantuan, pemakaian AI, kesehatan sistem, dan
gambaran wilayah. React + Vite, terpisah dari aplikasi petani (`web/`, Preact). Bahasa visual dan komponen
diambil dari dasbor ops synt (metrics.synt.fun), dengan dua tema (gelap/terang).

## Build

```bash
npm run build -w admin                          # → web/dist/admin, tersaji di <app>/admin/
npm run build:contoh -w admin -- --outDir <dir> # data contoh (src/mock.ts), untuk artifact desain
```

`npm run build` di akar membangun `web/` lalu `admin/`. Semua aset relatif (`base: './'`), jadi build yang
sama jalan di `/app/admin/` dan `/preview/admin/`. Service worker aplikasi petani tidak menyentuh `admin/`.

## Server

Data datang dari `server/src/admin.ts` (`/api/admin/*`). Dasbor mati (404) sampai berkas env server punya
`SYNTEEL_ADMIN_USER` dan `SYNTEEL_ADMIN_PASSWORD`. Masuk memberi cookie HttpOnly 12 jam yang ditandatangani
dengan kunci dari kata sandi; mengganti kata sandi mengakhiri semua sesi admin. Lima kata sandi salah dari
satu alamat mengunci 15 menit.

Aturan privasi (dijaga server, bukan halaman):
- nomor HP dan email dikirim sudah disamarkan (`0812-••••-4471`, `su•••@gmail.com`);
- data wilayah hanya jumlah; kabupaten dengan kurang dari 3 tambak tidak dikirim;
- tamu "Coba demo" dan tambak demo tidak pernah dihitung sebagai pengguna atau tambak.

Yang baru dicatat server sejak dasbor ini ada (tabel `events`, `ai_calls`, kolom `users.seen_at`): panggilan AI
per fitur, email kode, login gagal, batas percobaan, galat server, kunjungan demo. Grafiknya terisi mulai
dari hari pemasangan.

## Belum ada

Kunci akun, hapus akun, kirim kode reset PIN, dan balas Bantuan dari dasbor hanya ada di data contoh
(`AKSI_AKUN`, `BALAS_EMAIL` di `src/api.ts`). Saat dibuat di server: validasi dan catat setiap aksi (audit);
konfirmasi di halaman hanya pengaman tampilan.

## Struktur

```
src/
  App.tsx             masuk, header, navigasi kategori, tema, routing hash (#ringkasan, #pengguna, …)
  api.ts              fetch ke ../api/admin; data contoh hanya di --mode contoh
  tipe.ts             tipe data (sama dengan jawaban server), CONTOH, kini()
  mock.ts             data contoh untuk artifact
  halaman.ts          daftar halaman dan kategori navigasi
  komponen/           ui.tsx, grafik.tsx, gerak.ts
  pages/              Ringkasan, Pengguna, Bantuan, PemakaianAi, Kesehatan, Wilayah
```

## Aturan grafik

- Satu sumbu Y, legenda bila ada ≥ 2 seri, tooltip saat batang disorot atau difokus, dan tabel data.
- Warna fitur AI urutannya tetap: foto `--seri-1`, suara `--seri-2`, video `--seri-3`, ringkasan malam `--seri-4`.
- Warna status (ok/warn/bad) hanya untuk status dan selalu disertai label teks.
- Peta petak memakai skala berurutan satu warna (`--seq-1..5`).
- Kontras teks ≥ 4.5:1: jangan pakai `--samar` untuk teks kecil.
