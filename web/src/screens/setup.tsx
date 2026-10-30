import { useState } from 'preact/hooks';
import { api, type Aeration, type Farm, type Me, type Phase, type PondSummary, type PowerBackup, type Setting } from '../api.ts';
import { BackupChoice } from './power.tsx';
import { aerationLabel, phaseLabel, settingLabel } from '../labels.ts';
import { Chips, Field, Icon, initialOf, Soon, tankPath, Tick, Wordmark } from '../ui.tsx';
import { JoinByCode } from '../join.tsx';
import { LOCALE, t } from '../i18n.ts';

/** The phone's GPS position, rounded to about 10 m; enough for the hourly weather. */
export function useLocate() {
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState('');
  const locate = () => {
    setError('');
    if (!navigator.geolocation) return setError(t('HP ini tidak mendukung GPS di browser. Isi nama lokasi saja.', 'This phone does not support GPS in the browser. Just type the location name.'));
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({ lat: Number(pos.coords.latitude.toFixed(4)), lon: Number(pos.coords.longitude.toFixed(4)) });
        setLocating(false);
      },
      () => {
        setError(t('Lokasi tidak bisa diambil. Isi nama lokasi saja.', 'Could not get the location. Just type the location name.'));
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
        {coords ? t('Lokasi HP tersimpan', 'Phone location saved') : locating ? t('Mengambil lokasi…', 'Getting location…') : t('Pakai lokasi HP', 'Use phone location')}
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
  const [powerBackup, setPowerBackup] = useState<PowerBackup | null>(null);
  const gps = useLocate();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.saveFarm({ name, locationName, ...gps.coords, ...(powerBackup && { powerBackup }) });
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
        <h1>{t('Siapkan tambak', 'Set up your farm')}</h1>
        <p class="ink2">{t('Cukup sekali. Setelah ini, tambahkan kolam.', 'Only once. After this, add your ponds.')}</p>
      </section>
      {newPin && (
        <div class="note ok" role="status" style={{ alignItems: 'center' }}>
          <Icon name="lock" />
          <span class="stack-xs" style={{ gap: 0 }}>
            <b class="note-title">
              {t('Akun dibuat. PIN baru:', 'Account created. New PIN:')}{' '}
              <span class="num" style={{ letterSpacing: '0.15em', whiteSpace: 'nowrap' }}>
                {newPin.split('').join(' ')}
              </span>
            </b>
            <span>{t('Catat di tempat aman. PIN ini dipakai setiap kali masuk.', 'Write it down somewhere safe. You need this PIN every time you sign in.')}</span>
          </span>
        </div>
      )}
      <section class="card">
        <Field label={t('Nama tambak', 'Farm name')}>
          <input value={name} onInput={(e) => setName(e.currentTarget.value)} placeholder={t('contoh: Tambak Sidat Mitra', 'example: Mitra Eel Farm')} required />
        </Field>
        <Field label={t('Lokasi', 'Location')} hint={t('Dipakai untuk cuaca per jam, supaya suhu air bisa diperkirakan.', 'Used for hourly weather, so the water temperature can be estimated.')}>
          <input value={locationName} onInput={(e) => setLocationName(e.currentTarget.value)} placeholder={t('contoh: Sleman, Yogyakarta', 'example: Sleman, Yogyakarta')} />
        </Field>
        <LocateButton gps={gps} />
      </section>
      <section class="card">
        <div class="field">
          <span class="field-label">{t('Cadangan listrik', 'Power backup')}</span>
          <BackupChoice value={powerBackup} onChange={setPowerBackup} />
          <span class="field-hint">{t('Yang menjalankan aerator saat listrik padam. Bisa diubah nanti di Profil.', 'What runs the aerators when the power goes out. Can be changed later in Profile.')}</span>
        </div>
      </section>
      {(error || gps.error) && <p class="error">{error || gps.error}</p>}
      <button class="btn primary" disabled={busy}>
        {t('Simpan', 'Save')}
      </button>
      {onJoined && (
        <div class="stack-sm">
          <p class="meta center" style={{ textWrap: 'balance' }}>
            {t('Diundang ke tambak orang lain? Masukkan kodenya, tidak perlu membuat tambak sendiri.', "Invited to someone else's farm? Enter the code; no need to set up your own farm.")}
          </p>
          <JoinByCode onJoined={onJoined} />
        </div>
      )}
      {onLogout && (
        <button type="button" class="link-row label" style={{ justifyContent: 'center' }} onClick={onLogout}>
          <Icon name="logout" size={20} /> {t('Keluar', 'Sign out')}
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
        <button class="avatar" style={{ border: 0 }} aria-label={t('Profil', 'Profile')} onClick={onProfile}>
          {initialOf(userName)}
        </button>
        <span class="meta grow">{farm.name}</span>
      </header>
      <section class="stack center" style={{ alignItems: 'center', flex: 1, justifyContent: 'center' }}>
        <svg width="200" height="150" viewBox="0 0 200 150" aria-hidden="true">
          <ellipse class="art-shadow" cx="100" cy="132" rx="80" ry="10" fill="#DCE3EC" />
          <circle cx="100" cy="72" r="60" class="art-ring" style={{ fill: 'var(--surface)' }} stroke="#B7C4D9" stroke-width="3" stroke-dasharray="8 8" />
          <path d="M62 78c10-7 18-7 28 0s18 7 28 0 18-7 28 0" class="art-wave" fill="none" stroke="#BFD8EC" stroke-width="5" stroke-linecap="round" />
          <path d="M70 96c10-7 18-7 28 0s18 7 28 0" class="art-wave" fill="none" stroke="#BFD8EC" stroke-width="5" stroke-linecap="round" />
          <circle class="art-plus" cx="148" cy="30" r="20" fill="#13264A" />
          <path class="art-plus-line" d="M148 21v18M139 30h18" stroke="#FFFFFF" stroke-width="3.5" stroke-linecap="round" />
        </svg>
        <h1>{t('Belum ada kolam', 'No ponds yet')}</h1>
        <p class="ink2" style={{ textWrap: 'balance' }}>
          {onAdd
            ? t('Tambahkan kolam pertama, lalu Synteel ikut memantau cuaca dan risiko oksigen.', 'Add your first pond, then Synteel helps watch the weather and oxygen risk.')
            : t('Pemilik tambak belum menambahkan kolam. Setelah kolam ditambahkan, kolam muncul di sini.', 'The farm owner has not added any ponds yet. Once they do, the ponds show up here.')}
        </p>
      </section>
      {onAdd && (
        <button class="btn primary" onClick={onAdd}>
          <Icon name="plus" size={20} /> {t('Tambah kolam', 'Add a pond')}
        </button>
      )}
    </div>
  );
}

const TYPES = [
  { id: 'bulat', label: t('Tangki bulat', 'Round tank') },
  { id: 'terpal', label: t('Terpal / beton', 'Tarp or concrete') },
  { id: 'fiber', label: t('Bak fiber', 'Fiber tub') },
] as const;

/** "Kolam D" after A, B and C. */
function nextName(names: string[]) {
  // Either language's word counts as taken ("Kolam A" and "Pond A" are the same pond to the farmer).
  const taken = (l: string) => names.some((n) => [`kolam ${l}`, `pond ${l}`].includes(n.toLowerCase()));
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') if (!taken(letter.toLowerCase())) return `${t('Kolam', 'Pond')} ${letter}`;
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

const typeLabel = (kind: string) => TYPES.find((ty) => ty.id === kind)?.label ?? t('Kolam', 'Pond');
const longDate = (ymd: string) => new Date(`${ymd}T00:00:00`).toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

interface Saved {
  id: number;
  name: string;
  summary: string;
}

/** Nicknames the farmer says out loud ("kolam pojok"); the voice reader matches them to this pond. */
function Nicknames({ nicks, onChange, draft, onDraft }: { nicks: string[]; onChange: (v: string[]) => void; draft: string; onDraft: (v: string) => void }) {
  const add = () => {
    const nick = draft.trim();
    if (nick && !nicks.some((n) => n.toLowerCase() === nick.toLowerCase())) onChange([...nicks, nick]);
    onDraft('');
  };
  return (
    <div class="field">
      <label class="field-label" for="nick-add">
        {t('Nama panggilan', 'Nicknames')}{' '}
        <span class="label muted" style={{ fontWeight: 400 }}>
          {t('(boleh kosong)', '(optional)')}
        </span>
      </label>
      {nicks.length > 0 && (
        <div role="list" aria-label={t('Nama panggilan', 'Nicknames')} class="chips">
          {nicks.map((n) => (
            <span key={n} role="listitem" class="chip" style={{ paddingRight: 0, background: 'var(--tint)', borderColor: 'var(--tint)', color: 'var(--navy-ink)' }}>
              {n}
              <button
                type="button"
                aria-label={t(`Hapus ${n}`, `Delete ${n}`)}
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
          placeholder={t('contoh: pojok', 'example: corner')}
        />
        <button type="button" class="btn secondary" style={{ color: 'var(--navy-ink)', fontWeight: 800, padding: '0 16px' }} onClick={add}>
          <Icon name="plus" size={20} /> {t('Tambah', 'Add')}
        </button>
      </div>
      <span class="field-hint">
        {t('Sebutan sehari-hari, contoh: kolam dekat pintu. AI memakai ini saat mendengar suara.', 'Your everyday name for it, for example: pond by the door. The AI listens for it.')}
      </span>
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
      const summary = [typeLabel(kind), phaseLabel[phase[0] ?? 'elver'], t(`tebar ${longDate(stockedAt)}`, `stocked ${longDate(stockedAt)}`).replace(/ /g, '\u00a0'), initialCount ? t(`${initialCount} ekor`, `${initialCount} eels`) : null]
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
        <button type="button" class="icon-btn" aria-label={t('Kembali', 'Back')} onClick={back}>
          <Icon name="back" />
        </button>
      )}
      <div class="stack-xs">
        <h1 style={{ lineHeight: 1 }}>{t('Tambah kolam', 'Add a pond')}</h1>
        <span class="meta">{t('Isi yang diketahui saja. Bisa diubah nanti.', 'Fill in only what you know. You can change it later.')}</span>
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
              <span class="h2">{t(`${saved.name} tersimpan`, `${saved.name} saved`)}</span>
              <span class="meta">{saved.summary}</span>
            </div>
          </div>
          <button type="button" class="btn primary" style={{ flexDirection: 'column', gap: 4, padding: '12px 20px' }} onClick={() => copyNext(saved)}>
            <span>{t(`Tambah ${following(saved.name, names)}, isian sama`, `Add ${following(saved.name, names)}, same details`)}</span>
            <span class="label" style={{ fontWeight: 400, color: 'var(--on-navy)' }}>
              {t('Tinggal ganti nama dan jumlah benih', 'Just change the name and number stocked')}
            </span>
          </button>
          <button type="button" class="btn secondary" onClick={fresh}>
            {t('Tambah kolam lain, isian kosong', 'Add another pond, empty form')}
          </button>
          <div class="grid2" style={{ gap: 8 }}>
            <button type="button" class="link-row label strong" style={{ justifyContent: 'center', textAlign: 'center' }} onClick={() => onDone(saved.id)}>
              {t(`Lihat ${saved.name}`, `View ${saved.name}`)}
            </button>
            <button type="button" class="link-row label strong" style={{ justifyContent: 'center', textAlign: 'center' }} onClick={leave}>
              {t('Selesai, ke Beranda', 'Done, go to Home')}
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
              {t(`Isian disalin dari ${copied}`, `Details copied from ${copied}`)}
            </span>
            <span>{t('Ganti nama dan jumlah benih. Jenis kolam, fase dan tanggal tebar sudah sama.', 'Change the name and the number stocked. Pond type, stage and stocking date stay the same.')}</span>
          </span>
        </div>
      )}

      <div class="card dashed" style={{ alignItems: 'center', textAlign: 'center' }}>
        <span class="icon-box" style={{ width: 56, height: 56, borderRadius: 28 }}>
          <Icon name="camera" size={26} />
        </span>
        <span class="strong">{t('Foto kolam', 'Pond photo')}</span>
        <span class="meta">{t('Supaya mudah dikenali.', 'So it is easy to recognize.')}</span>
        <Soon />
      </div>

      <section class="card">
        <Field label={t('Nama kolam', 'Pond name')}>
          <input value={name} onInput={(e) => setName(e.currentTarget.value)} placeholder={t('contoh: Kolam A', 'example: Pond A')} required />
        </Field>

        <Nicknames nicks={nicks} onChange={setNicks} draft={nickDraft} onDraft={setNickDraft} />

        <div class="field">
          <span class="field-label">{t('Jenis kolam', 'Pond type')}</span>
          <div class="grid3">
            {TYPES.map((ty) => (
              <button type="button" key={ty.id} class={`type-tile${kind === ty.id ? ' on' : ''}`} aria-pressed={kind === ty.id} onClick={() => setKind(ty.id)}>
                <span class="thumb sm" style={{ width: 48, height: 48, background: 'var(--bg)', color: 'var(--ink-2)' }}>
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d={tankPath(ty.id)} />
                  </svg>
                </span>
                {ty.label}
                {kind === ty.id && (
                  <span class="corner-tick">
                    <Icon name="check" size={14} stroke={3} />
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        <div class="field">
          <span class="field-label">{t('Fase sidat', 'Eel stage')}</span>
          <Chips options={phaseLabel} value={phase} onChange={(v) => v.length && setPhase(v)} />
        </div>

        <div class="field">
          <span class="field-label">{t('Tanggal tebar', 'Stocking date')}</span>
          <div class="chips">
            {(
              [
                ['today', t('Hari ini', 'Today')],
                ['yesterday', t('Kemarin', 'Yesterday')],
                ['pick', t('Pilih tanggal', 'Pick a date')],
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
              {t(`Sekarang minggu ke-${week}`, `Now in week ${week}`)}
              {phase[0] === 'glass_eel' && t(' dari 12', ' of 12')}
            </span>
            {phase[0] === 'glass_eel' && (
              <span class="progress" style={{ background: 'var(--surface)' }}>
                <span style={{ width: `${Math.min(100, (week / 12) * 100)}%` }} />
              </span>
            )}
          </div>
        </div>

        <Field label={t('Kira-kira jumlah benih', 'About how many eels stocked')} hint={t('Boleh kosong kalau tidak tahu.', 'Leave it empty if you do not know.')}>
          <input inputMode="numeric" value={initialCount} onInput={(e) => setInitialCount(e.currentTarget.value)} placeholder={t('contoh: 500', 'example: 500')} />
        </Field>
      </section>

      <details class="card more">
        <summary>
          <span class="stack-xs">
            <span class="strong">{t('Detail lain', 'More details')}</span>
            <span class="meta">{t('Membuat perkiraan suhu air lebih tepat', 'Makes the water temperature forecast more accurate')}</span>
          </span>
          <Icon name="down" />
        </summary>
        <div class="stack" style={{ marginTop: 16 }}>
          <Field label={t('Luas dasar kolam (m²)', 'Pond floor area (m²)')} hint={t('Panjang × lebar, untuk menghitung kepadatan.', 'Length × width, to work out stocking density.')}>
            <input inputMode="decimal" value={areaM2} onInput={(e) => setAreaM2(e.currentTarget.value)} placeholder={t('contoh: 12', 'example: 12')} />
          </Field>
          <div class="field">
            <span class="field-label">{t('Tempat', 'Location')}</span>
            <Chips options={settingLabel} value={setting} onChange={setSetting} />
          </div>
          {setting[0] === 'outdoor' && (
            <div class="field">
              <span class="field-label">{t('Ada peneduh (paranet atau atap)?', 'Any shade (shade net or roof)?')}</span>
              <Chips options={{ yes: t('Ya', 'Yes'), no: t('Tidak', 'No') }} value={shaded} onChange={setShaded} />
            </div>
          )}
          <div class="field">
            <span class="field-label">{t('Aerasi', 'Aeration')}</span>
            <Chips options={aerationLabel} value={aeration} onChange={setAeration} />
          </div>
          <Field label={t('Kedalaman air (cm)', 'Water depth (cm)')}>
            <input inputMode="decimal" value={depthCm} onInput={(e) => setDepthCm(e.currentTarget.value)} placeholder="30" />
          </Field>
          <Field label={t('Volume air (liter)', 'Water volume (liters)')}>
            <input inputMode="numeric" value={volumeL} onInput={(e) => setVolumeL(e.currentTarget.value)} placeholder={t('contoh: 870', 'example: 870')} />
          </Field>
        </div>
      </details>

      {error && <p class="error">{error}</p>}
      <button class="btn primary" disabled={busy}>
        {t('Simpan kolam', 'Save pond')}
      </button>
    </form>
  );
}
