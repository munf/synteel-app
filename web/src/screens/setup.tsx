import { useState } from 'preact/hooks';
import { api, type Phase } from '../api.ts';
import { phaseLabel } from '../labels.ts';
import { Chips, Field } from '../ui.tsx';

export function FarmSetup({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [locationName, setLocationName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.saveFarm({ name, locationName });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="screen stack" onSubmit={submit}>
      <div>
        <p class="eyebrow">Selamat datang</p>
        <h1>Siapkan tambakmu</h1>
        <p class="muted">Cukup sekali. Setelah ini, tambahkan kolam dan batch sidat.</p>
      </div>
      <Field label="Nama tambak">
        <input value={name} onInput={(e) => setName(e.currentTarget.value)} placeholder="mis. Tambak Sidat Pak Joko" required />
      </Field>
      <Field label="Lokasi" hint="Dipakai untuk prakiraan cuaca.">
        <input value={locationName} onInput={(e) => setLocationName(e.currentTarget.value)} placeholder="mis. Sleman, Yogyakarta" />
      </Field>
      {error && <p class="error">{error}</p>}
      <button class="primary" disabled={busy}>Simpan</button>
    </form>
  );
}

export function AddPond({ today, onDone, onCancel }: { today: string; onDone: (pondId: number) => void; onCancel?: () => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<('fiber' | 'beton' | 'terpal')[]>(['fiber']);
  const [volumeL, setVolumeL] = useState('');
  const [phase, setPhase] = useState<Phase[]>(['glass_eel']);
  const [stockedAt, setStockedAt] = useState(today);
  const [initialCount, setInitialCount] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { pond } = await api.addPond({ name, kind: kind[0], volumeL: volumeL ? Number(volumeL) : undefined });
      await api.startBatch(pond.id, {
        phase: phase[0] ?? 'glass_eel',
        stockedAt,
        initialCount: initialCount ? Number(initialCount) : undefined,
      });
      onDone(pond.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="screen stack" onSubmit={submit}>
      <div>
        <p class="eyebrow">Kolam baru</p>
        <h1>Tambah kolam</h1>
      </div>
      <Field label="Nama kolam">
        <input value={name} onInput={(e) => setName(e.currentTarget.value)} placeholder="mis. Kolam A" required />
      </Field>
      <Field label="Jenis kolam">
        <Chips options={{ fiber: 'Fiber', beton: 'Beton', terpal: 'Terpal' }} value={kind} onChange={setKind} />
      </Field>
      <Field label="Volume air (liter)">
        <input inputMode="numeric" value={volumeL} onInput={(e) => setVolumeL(e.currentTarget.value)} placeholder="mis. 870" />
      </Field>

      <h2>Batch sidat</h2>
      <Field label="Fase">
        <Chips options={phaseLabel} value={phase} onChange={setPhase} />
      </Field>
      <Field label="Tanggal tebar" hint="Dipakai untuk menghitung minggu ke berapa.">
        <input type="date" value={stockedAt} max={today} onInput={(e) => setStockedAt(e.currentTarget.value)} required />
      </Field>
      <Field label="Jumlah tebar (ekor)" hint="Boleh dikosongkan kalau tidak tahu.">
        <input inputMode="numeric" value={initialCount} onInput={(e) => setInitialCount(e.currentTarget.value)} placeholder="mis. 500" />
      </Field>

      {error && <p class="error">{error}</p>}
      <div class="row">
        {onCancel && (
          <button type="button" class="secondary" onClick={onCancel}>
            Batal
          </button>
        )}
        <button class="primary" disabled={busy}>Simpan kolam</button>
      </div>
    </form>
  );
}
