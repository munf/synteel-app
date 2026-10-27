import { useState } from 'preact/hooks';
import { api, type Aeration, type Phase, type Setting } from '../api.ts';
import { aerationLabel, phaseLabel, settingLabel } from '../labels.ts';
import { Chips, Field } from '../ui.tsx';

export function FarmSetup({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [locationName, setLocationName] = useState('');
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const locate = () => {
    if (!navigator.geolocation) return setError('HP ini tidak mendukung GPS di browser. Isi nama lokasi saja.');
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({ lat: Number(pos.coords.latitude.toFixed(4)), lon: Number(pos.coords.longitude.toFixed(4)) });
        setLocating(false);
      },
      () => {
        setError('Lokasi tidak bisa diambil. Isi nama lokasi saja.');
        setLocating(false);
      },
      { enableHighAccuracy: false, timeout: 15_000 },
    );
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.saveFarm({ name, locationName, ...coords });
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
      <Field label="Lokasi" hint="Dipakai untuk cuaca per jam, agar suhu air bisa diperkirakan di antara pengukuran.">
        <input value={locationName} onInput={(e) => setLocationName(e.currentTarget.value)} placeholder="mis. Sleman, Yogyakarta" />
      </Field>
      <button type="button" class="secondary" onClick={locate} disabled={locating}>
        {coords ? `Lokasi GPS tersimpan (${coords.lat}, ${coords.lon})` : locating ? 'Mengambil lokasi…' : 'Pakai lokasi saya (GPS)'}
      </button>
      {error && <p class="error">{error}</p>}
      <button class="primary" disabled={busy}>Simpan</button>
    </form>
  );
}

export function AddPond({ today, onDone, onCancel }: { today: string; onDone: (pondId: number) => void; onCancel?: () => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<('fiber' | 'beton' | 'terpal')[]>(['fiber']);
  const [volumeL, setVolumeL] = useState('');
  const [areaM2, setAreaM2] = useState('');
  const [setting, setSetting] = useState<Setting[]>(['outdoor']);
  const [shaded, setShaded] = useState<('yes' | 'no')[]>(['yes']);
  const [aeration, setAeration] = useState<Aeration[]>(['full']);
  const [depthCm, setDepthCm] = useState('30');
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
      const { pond } = await api.addPond({
        name,
        kind: kind[0],
        volumeL: volumeL ? Number(volumeL) : undefined,
        areaM2: areaM2 ? Number(areaM2.replace(',', '.')) : undefined,
        setting: setting[0],
        shaded: setting[0] === 'outdoor' && shaded[0] ? shaded[0] === 'yes' : undefined,
        aeration: aeration[0],
        depthCm: depthCm ? Number(depthCm.replace(',', '.')) : undefined,
      });
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
      <Field label="Luas dasar kolam (m²)" hint="Panjang × lebar. Dipakai untuk menghitung kepadatan tebar.">
        <input inputMode="decimal" value={areaM2} onInput={(e) => setAreaM2(e.currentTarget.value)} placeholder="mis. 12" />
      </Field>
      <Field label="Tempat">
        <Chips options={settingLabel} value={setting} onChange={setSetting} />
      </Field>
      {setting[0] === 'outdoor' && (
        <Field label="Ada peneduh (paranet/atap)?">
          <Chips options={{ yes: 'Ya', no: 'Tidak' }} value={shaded} onChange={setShaded} />
        </Field>
      )}
      <Field label="Aerasi">
        <Chips options={aerationLabel} value={aeration} onChange={setAeration} />
      </Field>
      <Field label="Kedalaman air (cm)">
        <input inputMode="decimal" value={depthCm} onInput={(e) => setDepthCm(e.currentTarget.value)} placeholder="30" />
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
