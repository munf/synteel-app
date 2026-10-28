import { useState } from 'preact/hooks';
import { api, type Aeration, type Farm, type Phase, type PondSummary, type Setting } from '../api.ts';
import { aerationLabel, phaseLabel, settingLabel } from '../labels.ts';
import { Chips, Field, Icon, Soon, tankPath } from '../ui.tsx';

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
    <form class="screen" onSubmit={submit}>
      <div class="row" style={{ gap: 8 }}>
        <span class="icon-box" style={{ width: 36, height: 36, borderRadius: 12, background: 'var(--navy)', color: '#fff' }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
            <path d="M3 13c3-4 5-4 8 0s5 4 10-2" />
          </svg>
        </span>
        <span class="title">synteel</span>
      </div>
      <section class="stack-sm">
        <h1>Siapkan tambak</h1>
        <p class="ink2">Cukup sekali. Setelah ini, tambahkan kolam.</p>
      </section>
      <section class="card">
        <Field label="Nama tambak">
          <input value={name} onInput={(e) => setName(e.currentTarget.value)} placeholder="mis. Tambak Sidat Pak Joko" required />
        </Field>
        <Field label="Lokasi" hint="Dipakai untuk cuaca per jam, supaya suhu air bisa diperkirakan.">
          <input value={locationName} onInput={(e) => setLocationName(e.currentTarget.value)} placeholder="mis. Sleman, Yogyakarta" />
        </Field>
        <button type="button" class="btn secondary" onClick={locate} disabled={locating}>
          {coords ? `Lokasi GPS tersimpan (${coords.lat}, ${coords.lon})` : locating ? 'Mengambil lokasi…' : 'Pakai lokasi HP (GPS)'}
        </button>
      </section>
      {error && <p class="error">{error}</p>}
      <button class="btn primary" disabled={busy}>
        Simpan
      </button>
    </form>
  );
}

/** Empty state for a new farm: one picture, one sentence, one action. */
export function NoPonds({ farm, onAdd }: { farm: Farm; onAdd: () => void }) {
  return (
    <div class="screen" style={{ minHeight: '100dvh' }}>
      <span class="meta">{farm.name}</span>
      <section class="stack center" style={{ alignItems: 'center', flex: 1, justifyContent: 'center' }}>
        <svg width="200" height="150" viewBox="0 0 200 150" aria-hidden="true">
          <ellipse cx="100" cy="132" rx="80" ry="10" fill="#DCE3EC" />
          <circle cx="100" cy="72" r="60" fill="#FFFFFF" stroke="#B7C4D9" stroke-width="3" stroke-dasharray="8 8" />
          <path d="M62 78c10-7 18-7 28 0s18 7 28 0 18-7 28 0" fill="none" stroke="#BFD8EC" stroke-width="5" stroke-linecap="round" />
          <path d="M70 96c10-7 18-7 28 0s18 7 28 0" fill="none" stroke="#BFD8EC" stroke-width="5" stroke-linecap="round" />
          <circle cx="148" cy="30" r="20" fill="#13264A" />
          <path d="M148 21v18M139 30h18" stroke="#FFFFFF" stroke-width="3.5" stroke-linecap="round" />
        </svg>
        <h1>Belum ada kolam</h1>
        <p class="ink2">Tambahkan kolam pertama, lalu Synteel ikut memantau cuaca dan risiko oksigen.</p>
      </section>
      <button class="btn primary" onClick={onAdd}>
        <Icon name="plus" size={20} /> Tambah kolam
      </button>
    </div>
  );
}

const TYPES = [
  { id: 'bulat', label: 'Tangki bulat' },
  { id: 'terpal', label: 'Terpal / beton' },
  { id: 'fiber', label: 'Bak fiber' },
] as const;

/** "Kolam D" after A, B and C. */
function nextName(ponds: PondSummary[]) {
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') if (!ponds.some((p) => p.name.toLowerCase() === `kolam ${letter.toLowerCase()}`)) return `Kolam ${letter}`;
  return '';
}

function shiftDay(ymd: string, days: number) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function AddPond({ today, ponds, onDone, onCancel }: { today: string; ponds: PondSummary[]; onDone: (pondId: number) => void; onCancel?: () => void }) {
  const [name, setName] = useState(nextName(ponds));
  const [kind, setKind] = useState<string>('terpal');
  const [phase, setPhase] = useState<Phase[]>(['elver']);
  const [stockedAt, setStockedAt] = useState(today);
  const [dateMode, setDateMode] = useState<'today' | 'yesterday' | 'pick'>('today');
  const [initialCount, setInitialCount] = useState('');
  const [volumeL, setVolumeL] = useState('');
  const [areaM2, setAreaM2] = useState('');
  const [setting, setSetting] = useState<Setting[]>(['outdoor']);
  const [shaded, setShaded] = useState<('yes' | 'no')[]>(['yes']);
  const [aeration, setAeration] = useState<Aeration[]>(['full']);
  const [depthCm, setDepthCm] = useState('30');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const days = Math.max(0, Math.round((Date.parse(today) - Date.parse(stockedAt)) / 86400_000));
  const week = Math.floor(days / 7) + 1;

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { pond } = await api.addPond({
        name,
        kind,
        volumeL: volumeL ? Number(volumeL) : undefined,
        areaM2: areaM2 ? Number(areaM2.replace(',', '.')) : undefined,
        setting: setting[0],
        shaded: setting[0] === 'outdoor' && shaded[0] ? shaded[0] === 'yes' : undefined,
        aeration: aeration[0],
        depthCm: depthCm ? Number(depthCm.replace(',', '.')) : undefined,
      });
      await api.startBatch(pond.id, { phase: phase[0] ?? 'elver', stockedAt, initialCount: initialCount ? Number(initialCount) : undefined });
      onDone(pond.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const chooseDate = (mode: typeof dateMode) => {
    setDateMode(mode);
    if (mode === 'today') setStockedAt(today);
    if (mode === 'yesterday') setStockedAt(shiftDay(today, -1));
  };

  return (
    <form class="screen" onSubmit={submit}>
      <header class="row">
        {onCancel && ponds.length > 0 && (
          <button type="button" class="icon-btn" aria-label="Kembali" onClick={onCancel}>
            <Icon name="back" />
          </button>
        )}
        <div class="stack-xs">
          <h1 style={{ lineHeight: 1 }}>Tambah kolam</h1>
          <span class="meta">Isi yang diketahui saja. Bisa diubah nanti.</span>
        </div>
      </header>

      <div class="card dashed" style={{ alignItems: 'center', textAlign: 'center' }}>
        <span class="icon-box" style={{ width: 56, height: 56, borderRadius: 28 }}>
          <Icon name="camera" size={26} />
        </span>
        <span class="strong">Foto kolam</span>
        <span class="meta">Supaya mudah dikenali.</span>
        <Soon />
      </div>

      <section class="card">
        <Field label="Nama kolam">
          <input value={name} onInput={(e) => setName(e.currentTarget.value)} placeholder="mis. Kolam A" required />
        </Field>

        <div class="field">
          <span class="field-label">Jenis kolam</span>
          <div class="grid3">
            {TYPES.map((t) => (
              <button type="button" key={t.id} class={`type-tile${kind === t.id ? ' on' : ''}`} aria-pressed={kind === t.id} onClick={() => setKind(t.id)}>
                <svg width="48" height="48" viewBox="0 0 56 56" aria-hidden="true">
                  <rect width="56" height="56" rx="12" fill="#DCE6F1" />
                  <path d={tankPath(t.id)} fill="#8DB6D9" stroke="#FFFFFF" stroke-width="3" />
                </svg>
                {t.label}
                {kind === t.id && (
                  <span class="corner-tick">
                    <Icon name="check" size={14} stroke={3} />
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        <div class="field">
          <span class="field-label">Fase sidat</span>
          <Chips options={phaseLabel} value={phase} onChange={(v) => v.length && setPhase(v)} />
        </div>

        <div class="field">
          <span class="field-label">Tanggal tebar</span>
          <div class="chips">
            {(
              [
                ['today', 'Hari ini'],
                ['yesterday', 'Kemarin'],
                ['pick', 'Pilih tanggal'],
              ] as const
            ).map(([mode, label]) => (
              <button type="button" key={mode} class={`chip${dateMode === mode ? ' on' : ''}`} aria-pressed={dateMode === mode} onClick={() => chooseDate(mode)}>
                {dateMode === mode && <Icon name="check" size={16} stroke={3} />}
                {label}
              </button>
            ))}
          </div>
          {dateMode === 'pick' && <input type="date" class="input" value={stockedAt} max={today} onInput={(e) => setStockedAt(e.currentTarget.value)} required />}
          <div class="box stack-sm" style={{ background: 'var(--tint)' }}>
            <span class="strong">{new Date(`${stockedAt}T00:00:00`).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
            <span class="label" style={{ color: 'var(--accent-ink)' }}>
              Sekarang minggu ke-{week}
              {phase[0] === 'glass_eel' && ' dari 12'}
            </span>
            {phase[0] === 'glass_eel' && (
              <span class="progress" style={{ background: '#fff' }}>
                <span style={{ width: `${Math.min(100, (week / 12) * 100)}%` }} />
              </span>
            )}
          </div>
        </div>

        <Field label="Kira-kira jumlah benih" hint="Boleh kosong kalau tidak tahu.">
          <input inputMode="numeric" value={initialCount} onInput={(e) => setInitialCount(e.currentTarget.value)} placeholder="mis. 500" />
        </Field>
      </section>

      <details class="card more">
        <summary>
          <span class="stack-xs">
            <span class="strong">Detail lain</span>
            <span class="meta">Membuat perkiraan suhu air lebih tepat</span>
          </span>
          <Icon name="down" />
        </summary>
        <div class="stack" style={{ marginTop: 16 }}>
          <Field label="Luas dasar kolam (m²)" hint="Panjang × lebar, untuk menghitung kepadatan.">
            <input inputMode="decimal" value={areaM2} onInput={(e) => setAreaM2(e.currentTarget.value)} placeholder="mis. 12" />
          </Field>
          <div class="field">
            <span class="field-label">Tempat</span>
            <Chips options={settingLabel} value={setting} onChange={setSetting} />
          </div>
          {setting[0] === 'outdoor' && (
            <div class="field">
              <span class="field-label">Ada peneduh (paranet atau atap)?</span>
              <Chips options={{ yes: 'Ya', no: 'Tidak' }} value={shaded} onChange={setShaded} />
            </div>
          )}
          <div class="field">
            <span class="field-label">Aerasi</span>
            <Chips options={aerationLabel} value={aeration} onChange={setAeration} />
          </div>
          <Field label="Kedalaman air (cm)">
            <input inputMode="decimal" value={depthCm} onInput={(e) => setDepthCm(e.currentTarget.value)} placeholder="30" />
          </Field>
          <Field label="Volume air (liter)">
            <input inputMode="numeric" value={volumeL} onInput={(e) => setVolumeL(e.currentTarget.value)} placeholder="mis. 870" />
          </Field>
        </div>
      </details>

      {error && <p class="error">{error}</p>}
      <button class="btn primary" disabled={busy}>
        Simpan kolam
      </button>
    </form>
  );
}
