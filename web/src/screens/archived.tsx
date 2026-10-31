import { useEffect, useState } from 'preact/hooks';
import { api } from '../api.ts';
import type { Go } from '../app.tsx';
import { t } from '../i18n.ts';
import { Icon } from '../ui.tsx';

/** Kolam yang dihapus (owner, from Profil): ponds taken off the list with "Hapus kolam"; Kembalikan brings one back with its records. */
export function ArchivedPonds({ go, onRestored }: { go: Go; onRestored: () => void }) {
  const [ponds, setPonds] = useState<{ id: number; name: string }[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.archivedPonds().then((r) => setPonds(r.ponds), (e) => setError(e.message));
  }, []);
  const restore = async (id: number) => {
    setBusy(id);
    setError('');
    try {
      await api.restorePond(id);
      setPonds((ponds ?? []).filter((p) => p.id !== id));
      onRestored();
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(null);
  };
  return (
    <div class="screen">
      <header class="row">
        <button class="icon-btn" aria-label={t('Kembali ke Profil', 'Back to Profile')} onClick={() => go({ name: 'profile' })}>
          <Icon name="back" />
        </button>
        <div class="stack-xs">
          <h1 style={{ lineHeight: 1.1 }}>{t('Kolam yang dihapus', 'Deleted ponds')}</h1>
          <span class="meta">{t('Catatan lamanya masih tersimpan.', 'Their records are still kept.')}</span>
        </div>
      </header>
      {ponds && ponds.length === 0 && <p class="ink2">{t('Tidak ada kolam yang dihapus.', 'No deleted ponds.')}</p>}
      {ponds && ponds.length > 0 && (
        <section class="card list">
          {ponds.map((p) => (
            <div key={p.id} class="list-row" style={{ minHeight: 64, padding: '8px 0', gap: 12 }}>
              <span class="grow semi">{p.name}</span>
              <button type="button" class="btn secondary" style={{ minHeight: 44, width: 'auto', padding: '0 16px' }} disabled={busy !== null} onClick={() => restore(p.id)}>
                {busy === p.id ? t('Mengembalikan…', 'Restoring…') : t('Kembalikan', 'Restore')}
              </button>
            </div>
          ))}
        </section>
      )}
      {error && <p class="error">{error}</p>}
    </div>
  );
}
