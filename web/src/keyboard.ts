// Keeps the field being typed in visible above the phone keyboard.
// While a text field has focus and the keyboard takes part of the screen, <html data-kb> hides the bottom tab bar
// (CSS), and the field is scrolled so it sits above the keyboard and above any bar pinned to the bottom (Simpan, Kirim).
// Works whether the browser shrinks the page for the keyboard (older Chrome) or only the visible area (Chrome 108+).

const TEXT_TYPES = new Set(['text', 'search', 'tel', 'number', 'email', 'password', 'url', 'date', 'time', 'datetime-local']);
const isField = (el: Element | null): el is HTMLElement =>
  el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && TEXT_TYPES.has(el.type)) || (el instanceof HTMLElement && el.isContentEditable);

/** Bars pinned to the bottom edge that can cover a field: the main action bars (the tab bar is hidden while typing). */
const BARS = '.action-bar, .problem-bar';

export function watchKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  // The visible height with the keyboard closed; learned again whenever no field has focus (rotation, browser bars).
  let full = Math.max(vv.height, window.innerHeight);

  const reveal = (el: HTMLElement) => {
    const top = vv.offsetTop + 12;
    let bottom = vv.offsetTop + vv.height - 16;
    for (const bar of document.querySelectorAll<HTMLElement>(BARS)) {
      const r = bar.getBoundingClientRect();
      // a bar showing in the lower half of the visible area, unless the field is inside it
      if (r.height && r.top < bottom && r.top > (top + bottom) / 2 && !bar.contains(el)) bottom = Math.min(bottom, r.top - 12);
    }
    const r = el.getBoundingClientRect();
    if (r.bottom > bottom) window.scrollBy({ top: Math.min(r.bottom - bottom, r.top - top), behavior: 'smooth' });
    else if (r.top < top) window.scrollBy({ top: r.top - top, behavior: 'smooth' });
  };

  const update = () => {
    const el = document.activeElement;
    if (!isField(el)) {
      full = Math.max(vv.height, window.innerHeight);
      delete root.dataset.kb;
      return;
    }
    // a keyboard takes at least a fifth of the screen; smaller changes are the address bar moving
    const open = vv.height < full * 0.8;
    if (open) root.dataset.kb = '';
    else delete root.dataset.kb;
    if (open) reveal(el);
  };

  vv.addEventListener('resize', update);
  // The keyboard opens a moment after focus; check again once it has.
  document.addEventListener('focusin', () => setTimeout(update, 350));
  document.addEventListener('focusout', () => setTimeout(update, 50));
}
