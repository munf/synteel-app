// Motion bersama — disalin dari dasbor ops (synt-metrics komponen/gerak.ts), diringkas:
//  - Pindah halaman = keluar bertahap (cepat) → tukar isi → masuk bertahap.
//  - Angka [data-angka] dihitung naik, batang [data-tumbuh] tumbuh.
//  - prefers-reduced-motion → semua dilewati.
//  - Angka berformat Indonesia (titik = pemisah ribuan, koma = desimal).

export const EASE = 'cubic-bezier(.22,1,.36,1)'
export const kurangGerak = () => matchMedia('(prefers-reduced-motion: reduce)').matches

/** Elemen yang ikut transisi halaman, urut dokumen. */
const PILIH_BAGIAN = '[data-masuk], .tengah > .judul-hal, .tengah > .panel, .tengah > section, .tengah > div'

function bagian(root: ParentNode): HTMLElement[] {
  const semua = Array.from(root.querySelectorAll<HTMLElement>(PILIH_BAGIAN))
  // buang yang bersarang di dalam bagian lain — cukup animasi di tingkat luar
  return semua.filter((el) => !semua.some((lain) => lain !== el && lain.contains(el)))
}

/** Keluar bertahap. Selesai → Promise resolve (tak pernah menolak). */
export function keluar(root: ParentNode): Promise<void> {
  if (kurangGerak()) return Promise.resolve()
  const el = bagian(root).slice(0, 14)
  if (el.length === 0) return Promise.resolve()
  const anim = el.map((x, i) =>
    x.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-10px) scale(.99)' }],
      { duration: 190, delay: i * 22, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' }))
  return Promise.all(anim.map((a) => a.finished.catch(() => undefined))).then(() => undefined)
}

/** Batalkan sisa animasi keluar (dipanggil sesudah isi baru dipasang). */
export function bersihkan(root: ParentNode) {
  root.querySelectorAll<HTMLElement>('*').forEach((x) => x.getAnimations?.().forEach((a) => {
    if ((a.effect as KeyframeEffect | null)?.getComputedTiming?.().fill === 'forwards') a.cancel()
  }))
}

/** Masuk bertahap + angka naik + batang tumbuh. */
export function masuk(root: ParentNode) {
  if (kurangGerak()) return
  const daftar = bagian(root)
  daftar.forEach((x, i) =>
    x.animate([{ opacity: 0, transform: 'translateY(14px) scale(.985)' }, { opacity: 1, transform: 'none' }],
      { duration: 520, delay: i * 55, easing: EASE, fill: 'backwards' }))
  const jeda = (el: Element) => {
    const i = daftar.findIndex((b) => b.contains(el))
    return (i < 0 ? 0 : i * 55) + 140
  }
  hitungNaik(root, jeda)
  tumbuh(root, 200)
}

const POLA = /^(\D*?)(-?\d[\d.]*(?:,\d+)?)(.*)$/s

function hitungSatu(el: HTMLElement, jeda: number) {
  const node = Array.from(el.childNodes).find((n) => n.nodeType === Node.TEXT_NODE && /\d/.test(n.nodeValue ?? '')) as Text | undefined
  if (!node) return
  const asli = node.nodeValue ?? ''
  const m = asli.match(POLA)
  if (!m) return
  const [, depan, teks, belakang] = m
  const des = (teks.split(',')[1] ?? '').length
  const akhir = Number(teks.replace(/\./g, '').replace(',', '.'))
  if (!Number.isFinite(akhir) || akhir === 0) return
  const fmt = (v: number) => v.toLocaleString('id-ID', { minimumFractionDigits: des, maximumFractionDigits: des })
  let ditulis = depan + fmt(0) + belakang
  node.nodeValue = ditulis
  const t0 = performance.now() + jeda
  const langkah = (t: number) => {
    if (node.nodeValue !== ditulis) return // React mengubah teks → hormati nilai React
    const p = Math.min(1, Math.max(0, (t - t0) / 1100))
    const e = 1 - Math.pow(1 - p, 4)
    ditulis = p >= 1 ? asli : depan + fmt(akhir * e) + belakang
    node.nodeValue = ditulis
    if (p < 1) requestAnimationFrame(langkah)
  }
  requestAnimationFrame(langkah)
}

export function hitungNaik(root: ParentNode, jeda: number | ((el: Element) => number) = 0) {
  if (kurangGerak()) return
  root.querySelectorAll<HTMLElement>('[data-angka]').forEach((el) => hitungSatu(el, typeof jeda === 'number' ? jeda : jeda(el)))
}

/** [data-tumbuh="x"] melebar dari kiri, "y" meninggi dari bawah (juga elemen SVG). */
export function tumbuh(root: ParentNode, jeda = 0) {
  if (kurangGerak()) return
  const n = { x: 0, y: 0 }
  root.querySelectorAll<HTMLElement | SVGElement>('[data-tumbuh], .bar > i').forEach((el) => {
    const y = el.dataset.tumbuh === 'y'
    const i = n[y ? 'y' : 'x']++
    el.animate([{ transform: y ? 'scaleY(0)' : 'scaleX(0)' }, { transform: 'none' }],
      { duration: y ? 650 : 900, delay: jeda + (y ? Math.min(i, 60) * 8 : Math.min(i, 12) * 70), easing: EASE, fill: 'backwards' })
  })
}

/** Isi baru di ruang tetap (detail, tab): masuk lembut. */
export function silang(el: HTMLElement | null) {
  if (!el || kurangGerak()) return
  el.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: EASE })
}
