import { useState } from 'preact/hooks';
import { api, type Aeration, type Farm, type Me, type Phase, type PondSummary, type Setting } from '../api.ts';
import { aerationLabel, phaseLabel, settingLabel } from '../labels.ts';
import { Chips, Field, Icon, initialOf, Soon, tankPath, Tick, Wordmark } from '../ui.tsx';
import { JoinByCode } from '../join.tsx';

/** The phone's GPS position, rounded to about 10 m; enough for the hourly weather. */
export function useLocate() {
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState('');
  const locate = () => {
    setError('');
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
  return { coords, locating, error, locate };
}

const fmtCoord = (n: number) => String(n).replace('-', '\u2212');

/** "Pakai lokasi HP", then the saved point with a tick. */
export function LocateButton({ gps }: { gps: ReturnType<typeof useLocate> }) {
  const { coords, locating, locate } = gps;
  return (
    <button type="button" class="btn secondary" onClick={locate} disabled={locating} style={coords ? { borderColor: '#9fd6bc' } : undefined}>
      {coords && (
        <span style={{ color: 'var(--ok)', display: 'flex' }}>
          <Tick size={20} />
        </span>
      )}
      <span class="stack-xs" style={{ gap: 0, alignItems: 'flex-start', textAlign: 'left' }}>
        {coords ? 'Lokasi HP tersimpan' : locating ? 'Mengambil lokasi…' : 'Pakai lokasi HP'}
        {coords && (
          <span class="meta num" style={{ fontWeight: 400 }}>
            {fmtCoord(coords.lat)}, {fmtCoord(coords.lon)}
          </span>
        )}
      </span>
    </button>
  );
}

export function FarmSetup({ onDone, onLogout, onJoined, newPin }: { onDone: () => void; onLogout?: () => void; /** Joined another farm with an invite code instead. */ onJoined?: (m: Me) => void; /** Right after Daftar: the PIN just made, shown once. */ newPin?: string }) {
  const [name, setName] = useState('');
  const [locationName, setLocationName] = useState('');
  const gps = useLocate();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.saveFarm({ name, locationName, ...gps.coords });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="screen" onSubmit={submit}>
      <Wordmark />
      <section class="stack-sm">
        <h1>Siapkan tambak</h1>
        <p class="ink2">Cukup sekali. Setelah ini, tambahkan kolam.</p>
      </section>
      {newPin && (
        <div class="note ok" role="status" style={{ alignItems: 'center' }}>
          <Icon name="lock" />
          <span class="stack-xs" style={{ gap: 0 }}>
            <b class="note-title">
              Akun dibuat. PIN baru:{' '}
              <span class="num" style={{ letterSpacing: '0.15em', whiteSpace: 'nowrap' }}>
                {newPin.split('').join(' ')}
              </span>
            </b>
            <span>Catat di tempat aman. PIN ini dipakai setiap kali masuk.</span>
          </span>
        </div>
      )}
      <section class="card">
        <Field label="Nama tambak">
          <input value={name} onInput={(e) => setName(e.currentTarget.value)} placeholder="contoh: Tambak Sidat Mitra" required />
        </Field>
        <Field label="Lokasi" hint="Dipakai untuk cuaca per jam, supaya suhu air bisa diperkirakan.">
          <input value={locationName} onInput={(e) => setLocationName(e.currentTarget.value)} placeholder="contoh: Sleman, Yogyakarta" />
        </Field>
        <LocateButton gps={gps} />
      </section>
      {(error || gps.error) && <p class="error">{error || gps.error}</p>}
      <button class="btn primary" disabled={busy}>
        Simpan
      </button>
      {onJoined && (
        <div class="stack-sm">
          <p class="meta center" style={{ textWrap: 'balance' }}>
            Diundang ke tambak orang lain? Masukkan kodenya, tidak perlu membuat tambak sendiri.
          </p>
          <JoinByCode onJoined={onJoined} />
        </div>
      )}
      {onLogout && (
        <button type="button" class="link-row label" style={{ justifyContent: 'center' }} onClick={onLogout}>
          <Icon name="logout" size={20} /> Keluar
        </button>
      )}
    </form>
  );
}

/** Empty state for a new farm: one picture, one sentence, one action. */
export function NoPonds({
  farm,
  userName,
  onAdd,
  onProfile,
}: {
  farm: Farm;
  userName: string;
  /** Missing for workers: only an owner adds ponds. */
  onAdd?: () => void;
  onProfile: () => void;
}) {
  return (
    <div class="screen" style={{ minHeight: '100dvh' }}>
      <header class="row">
        <button class="avatar" style={{ border: 0 }} aria-label="Profil" onClick={onProfile}>
          {initialOf(userName)}
        </button>
        <span class="meta grow">{farm.name}</span>
      </header>
      <section class="stack center" style={{ alignItems: 'center', flex: 1, justifyContent: 'center' }}>
        <svg width="200" height="150" viewBox="0 0 200 150" aria-hidden="true">
          <ellipse cx="100" cy="132" rx="80" ry="10" fill="#DCE3EC" />
          <circle cx="100" cy="72" r="60" style={{ fill: 'var(--surface)' }} stroke="#B7C4D9" stroke-width="3" stroke-dasharray="8 8" />
          <path d="M62 78c10-7 18-7 28 0s18 7 28 0 18-7 28 0" fill="none" stroke="#BFD8EC" stroke-width="5" stroke-linecap="round" />
          <path d="M70 96c10-7 18-7 28 0s18 7 28 0" fill="none" stroke="#BFD8EC" stroke-width="5" stroke-linecap="round" />
          <circle cx="148" cy="30" r="20" fill="#13264A" />
          <path d="M148 21v18M139 30h18" stroke="#FFFFFF" stroke-width="3.5" stroke-linecap="round" />
        </svg>
        <h1>Belum ada kolam</h1>
        <p class="ink2" style={{ textWrap: 'balance' }}>
          {onAdd ? 'Tambahkan kolam pertama, lalu Synteel ikut memantau cuaca dan risiko oksigen.' : 'Pemilik tambak belum menambahkan kolam. Setelah kolam ditambahkan, kolam muncul di sini.'}
        </p>
      </section>
      {onAdd && (
        <button class="btn primary" onClick={onAdd}>
          <Icon name="plus" size={20} /> Tambah kolam
        </button>
      )}
    </div>
  );
}

const TYPES = [
  { id: 'bulat', label: 'Tangki bulat' },
  { id: 'terpal', label: 'Terpal / beton' },
  { id: 'fiber', label: 'Bak fiber' },
] as const;

/** "Kolam D" after A, B and C. */
function nextName(names: string[]) {
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') if (!names.some((n) => n.toLowerCase() === `kolam ${letter.toLowerCase()}`)) return `Kolam ${letter}`;
  return '';
}

/** The name after this one: "Kolam D" → "Kolam E", "Bak 3" → "Bak 4", skipping names already taken. */
function following(name: string, names: string[]) {
  const step = (n: string) => {
    const m = n.match(/^(.*?)(\d+)$/);
    if (m) return m[1] + (Number(m[2]) + 1);
    return /[A-Ya-y]$/.test(n) ? n.slice(0, -1) + String.fromCharCode(n.charCodeAt(n.length - 1) + 1) : `${n} 2`;
  };
  const taken = new Set(names.map((n) => n.toLowerCase()));
  let next = step(name);
  for (let i = 0; i < 50 && taken.has(next.toLowerCase()); i++) next = step(next);
  return next;
}

const typeLabel = (kind: string) => TYPES.find((t) => t.id === kind)?.label ?? 'Kolam';
const longDate = (ymd: string) => new Date(`${ymd}T00:00:00`).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

interface Saved {
  id: number;
  name: string;
  summary: string;
}

/** Nicknames the farmer says out loud ("kolam pojok"); the voice reader matches them to this pond. */
function Nicknames({ nicks, onChange, draft, onDraft }: { nicks: string[]; onChange: (v: string[]) => void; draft: string; onDraft: (v: string) => void }) {
  const add = () => {
    const t = draft.trim();
    if (t && !nicks.some((n) => n.toLowerCase() === t.toLowerCase())) onChange([...nicks, t]);
    onDraft('');
  };
  return (
    <div class="field">
      <label class="field-label" for="nick-add">
        Nama panggilan{' '}
        <span class="label muted" style={{ fontWeight: 400 }}>
          (boleh kosong)
        </span>
      </label>
      {nicks.length > 0 && (
        <div role="list" aria-label="Nama panggilan" class="chips">
          {nicks.map((n) => (
            <span key={n} role="listitem" class="chip" style={{ paddingRight: 0, background: 'var(--tint)', borderColor: 'var(--tint)', color: 'var(--navy)' }}>
              {n}
              <button
                type="button"
                aria-label={`Hapus ${n}`}
                onClick={() => onChange(nicks.filter((x) => x !== n))}
                style={{ width: 44, height: 40, border: 0, borderRadius: 20, background: 'transparent', color: 'inherit', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </span>
          ))}
        </div>
      )}
      <div class="row" style={{ gap: 8 }}>
        <input
          id="nick-add"
          class="grow"
          value={draft}
          onInput={(e) => onDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder="contoh: pojok"
        />
        <button type="button" class="btn secondary" style={{ color: 'var(--navy)', fontWeight: 800, padding: '0 16px' }} onClick={add}>
          <Icon name="plus" size={20} /> Tambah
        </button>
      </div>
      <span class="field-hint">Sebutan sehari-hari, contoh: kolam dekat pintu. AI memakai ini saat mendengar suara.</span>
    </div>
  );
}

function shiftDay(ymd: string, days: number) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function AddPond({
  today,
  ponds,
  onDone,
  onHome,
  onCancel,
}: {
  today: string;
  ponds: PondSummary[];
  /** Leave to the page of a pond just saved ("Lihat Kolam D"). Called only when leaving: after a save, more ponds can follow. */
  onDone: (pondId: number) => void;
  /** Leave to Beranda after saving one or more ponds. Without it, "Selesai" opens the last pond saved. */
  onHome?: () => void;
  onCancel?: () => void;
}) {
  // Ponds saved on this screen: the farm list from the app is only refreshed when leaving.
  const [added, setAdded] = useState<string[]>([]);
  const names = [...ponds.map((p) => p.name), ...added];
  const [saved, setSaved] = useState<Saved | null>(null);
  const [lastId, setLastId] = useState<number | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [name, setName] = useState(nextName(names));
  const [nicks, setNicks] = useState<string[]>([]);
  const [nickDraft, setNickDraft] = useState('');
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
      const draft = nickDraft.trim();
      const nicknames = draft && !nicks.some((n) => n.toLowerCase() === draft.toLowerCase()) ? [...nicks, draft] : nicks;
      const body = {
        name,
        nicknames,
        kind,
        volumeL: volumeL ? Number(volumeL) : undefined,
        areaM2: areaM2 ? Number(areaM2.replace(',', '.')) : undefined,
        setting: setting[0],
        shaded: setting[0] === 'outdoor' && shaded[0] ? shaded[0] === 'yes' : undefined,
        aeration: aeration[0],
        depthCm: depthCm ? Number(depthCm.replace(',', '.')) : undefined,
      };
      const { pond } = await api.addPond(body);
      await api.startBatch(pond.id, { phase: phase[0] ?? 'elver', stockedAt, initialCount: initialCount ? Number(initialCount) : undefined });
      const summary = [typeLabel(kind), phaseLabel[phase[0] ?? 'elver'], `tebar ${longDate(stockedAt)}`.replace(/ /g, '\u00a0'), initialCount ? `${initialCount} ekor` : null]
        .filter(Boolean)
        .join(' · ');
      setAdded([...added, pond.name]);
      setLastId(pond.id);
      setSaved({ id: pond.id, name: pond.name, summary });
      window.scrollTo(0, 0);
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

  /** After one or more saves, leaving goes home with a fresh farm list. */
  const leave = () => (onHome ? onHome() : lastId !== null && onDone(lastId));
  const back = lastId !== null ? leave : ponds.length > 0 ? onCancel : undefined;

  /** Next pond, same type, phase, stocking date and details; only the name, seed count and nicknames start over. */
  const copyNext = (s: Saved) => {
    setCopied(s.name);
    setName(following(s.name, names));
    setInitialCount('');
    setNicks([]);
    setNickDraft('');
    setSaved(null);
    window.scrollTo(0, 0);
  };
  const fresh = () => {
    setCopied(null);
    setName(nextName(names));
    setInitialCount('');
    setNicks([]);
    setNickDraft('');
    setKind('terpal');
    setPhase(['elver']);
    chooseDate('today');
    setVolumeL('');
    setAreaM2('');
    setSetting(['outdoor']);
    setShaded(['yes']);
    setAeration(['full']);
    setDepthCm('30');
    setFormKey(formKey + 1);
    setSaved(null);
    window.scrollTo(0, 0);
  };

  const header = (
    <header class="row">
      {back && (
        <button type="button" class="icon-btn" aria-label="Kembali" onClick={back}>
          <Icon name="back" />
        </button>
      )}
      <div class="stack-xs">
        <h1 style={{ lineHeight: 1 }}>Tambah kolam</h1>
        <span class="meta">Isi yang diketahui saja. Bisa diubah nanti.</span>
      </div>
    </header>
  );

  if (saved) {
    return (
      <div class="screen">
        {header}
        <section class="card">
          <div class="row">
            <span class="icon-box ok">
              <Icon name="check" size={24} stroke={2.5} />
            </span>
            <div class="grow stack-xs" style={{ gap: 0 }}>
              <span class="h2">{saved.name} tersimpan</span>
              <span class="meta">{saved.summary}</span>
            </div>
          </div>
          <button type="button" class="btn primary" style={{ flexDirection: 'column', gap: 4, padding: '12px 20px' }} onClick={() => copyNext(saved)}>
            <span>Tambah {following(saved.name, names)}, isian sama</span>
            <span class="label" style={{ fontWeight: 400, color: 'var(--on-navy)' }}>
              Tinggal ganti nama dan jumlah benih
            </span>
          </button>
          <button type="button" class="btn secondary" onClick={fresh}>
            Tambah kolam lain, isian kosong
          </button>
          <div class="grid2" style={{ gap: 8 }}>
            <button type="button" class="link-row label strong" style={{ justifyContent: 'center', textAlign: 'center' }} onClick={() => onDone(saved.id)}>
              Lihat {saved.name}
            </button>
            <button type="button" class="link-row label strong" style={{ justifyContent: 'center', textAlign: 'center' }} onClick={leave}>
              Selesai, ke Beranda
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <form class="screen" key={formKey} onSubmit={submit}>
      {header}

      {copied && (
        <div class="note info">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M9 9h10v10H9zM5 15V5h10" />
          </svg>
          <span class="grow stack-xs" style={{ gap: 2 }}>
            <span class="strong" style={{ fontSize: '1rem' }}>
              Isian disalin dari {copied}
            </span>
            <span>Ganti nama dan jumlah benih. Jenis kolam, fase dan tanggal tebar sudah sama.</span>
          </span>
        </div>
      )}

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
          <input value={name} onInput={(e) => setName(e.currentTarget.value)} placeholder="contoh: Kolam A" required />
        </Field>

        <Nicknames nicks={nicks} onChange={setNicks} draft={nickDraft} onDraft={setNickDraft} />

        <div class="field">
          <span class="field-label">Jenis kolam</span>
          <div class="grid3">
            {TYPES.map((t) => (
              <button type="button" key={t.id} class={`type-tile${kind === t.id ? ' on' : ''}`} aria-pressed={kind === t.id} onClick={() => setKind(t.id)}>
                <span class="thumb sm" style={{ width: 48, height: 48, background: 'var(--bg)', color: 'var(--ink-2)' }}>
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d={tankPath(t.id)} />
                  </svg>
                </span>
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
            <span class="strong">{longDate(stockedAt)}</span>
            <span class="label" style={{ color: 'var(--accent-ink)' }}>
              Sekarang minggu ke-{week}
              {phase[0] === 'glass_eel' && ' dari 12'}
            </span>
            {phase[0] === 'glass_eel' && (
              <span class="progress" style={{ background: 'var(--surface)' }}>
                <span style={{ width: `${Math.min(100, (week / 12) * 100)}%` }} />
              </span>
            )}
          </div>
        </div>

        <Field label="Kira-kira jumlah benih" hint="Boleh kosong kalau tidak tahu.">
          <input inputMode="numeric" value={initialCount} onInput={(e) => setInitialCount(e.currentTarget.value)} placeholder="contoh: 500" />
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
            <input inputMode="decimal" value={areaM2} onInput={(e) => setAreaM2(e.currentTarget.value)} placeholder="contoh: 12" />
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
            <input inputMode="numeric" value={volumeL} onInput={(e) => setVolumeL(e.currentTarget.value)} placeholder="contoh: 870" />
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
