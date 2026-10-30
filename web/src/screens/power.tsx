// Power cuts at night: tonight's "Malam rawan listrik padam" label (Beranda, Waspada), the power cut
// being recorded right now, "Cadangan listrik" (setup, Profil), and the BMKG forecast with
// "Ganti wilayah" on the Beranda weather card. The label itself is worked out on the server (power.ts).
import { useEffect, useState } from 'preact/hooks';
import { api, type BmkgView, type PowerBackup, type PowerLevel, type PowerNight, type Region } from '../api.ts';
import type { Go } from '../app.tsx';
import { fmtClock } from '../labels.ts';
import { t } from '../i18n.ts';
import { Chips, Icon, Shape, type IconName, type Tone } from '../ui.tsx';
import './power.css';

export const BACKUP_LABEL: Record<PowerBackup, string> = {
  genset: t('Genset', 'Generator'),
  battery: t('Aki atau baterai cadangan', 'Battery backup'),
  none: t('Tidak ada', 'None'),
};

const LEVEL: Record<PowerLevel, { tone: Tone; word: string; title: string }> = {
  high: { tone: 'bad', word: t('Rawan', 'At risk'), title: t('Malam rawan listrik padam', 'Night at risk of a power cut') },
  medium: { tone: 'warn', word: t('Mungkin', 'Possible'), title: t('Listrik mungkin padam malam ini', 'The power may go out tonight') },
  low: { tone: 'ok', word: t('Kecil', 'Unlikely'), title: t('Kecil kemungkinan listrik padam malam ini', 'A power cut is unlikely tonight') },
};

/** "Sumber: BMKG dan Open-Meteo": BMKG asks to be named wherever its data shows. */
function sources(p: PowerNight) {
  const names = [p.sources.bmkg && 'BMKG', p.sources.openMeteo && 'Open-Meteo'].filter(Boolean) as string[];
  return names.length ? `${t('Sumber', 'Source')}: ${names.join(t(' dan ', ' and '))}` : '';
}

const minutes = (from: number, to: number) => Math.max(0, Math.round((to - from) / 60_000));
/** "35 menit", "1 jam 20 menit". */
export function duration(min: number) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return t(`${m} menit`, `${m} ${m === 1 ? 'minute' : 'minutes'}`);
  return t(`${h} jam${m ? ` ${m} menit` : ''}`, `${h} ${h === 1 ? 'hour' : 'hours'}${m ? ` ${m} ${m === 1 ? 'minute' : 'minutes'}` : ''}`);
}

/** Re-renders every 30 seconds, for times counting up. */
export function useTicker() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The power cut being recorded: at the top of Beranda and Masalah until "Listrik sudah menyala". */
export function OutageBanner({ startedAt, go }: { startedAt: string; go: Go }) {
  const now = useTicker();
  const since = Date.parse(startedAt);
  return (
    <button type="button" class="note bad power-banner" role="alert" onClick={() => go({ name: 'outage' })}>
      <Icon name="bolt" />
      <span class="grow stack-xs" style={{ gap: 0 }}>
        <span class="note-title">{t(`Listrik padam sejak ${fmtClock(since)}`, `Power out since ${fmtClock(since)}`)}</span>
        <span>{t(`Sudah ${duration(minutes(since, now))}. Buka langkah darurat.`, `${duration(minutes(since, now))} so far. Open the emergency steps.`)}</span>
      </span>
      <Icon name="next" size={20} />
    </button>
  );
}

/**
 * Tonight's label as shape + word, with the reasons from both forecasts and the preparation. `compact` on
 * Beranda (only when the night is not calm); in full on Waspada. "Listrik padam" is one tap away.
 */
export function PowerNightCard({ power, go, compact = false }: { power: PowerNight; go: Go; compact?: boolean }) {
  const [open, setOpen] = useState(!compact);
  const lv = LEVEL[power.level];
  const prep = power.checks[0];
  return (
    <section class="card power-card" aria-label={lv.title}>
      <div class="row between" style={{ gap: 12 }}>
        <span class={`pill ${lv.tone}`}>
          <Shape tone={lv.tone} />
          {lv.word}
        </span>
        <span class="label ink2 num">
          {t('Malam ini', 'Tonight')} {fmtClock(power.from)}–{fmtClock(power.to)}
        </span>
      </div>
      <div class="row top" style={{ gap: 12 }}>
        <span class={`icon-box ${power.level === 'high' ? 'bad' : power.level === 'low' ? 'ok' : ''}`}>
          <Icon name="bolt" />
        </span>
        <span class="stack-xs grow" style={{ gap: 2 }}>
          <span class="h2">{lv.title}</span>
          <span class="label ink2">{power.backup ? `${t('Cadangan listrik', 'Power backup')}: ${BACKUP_LABEL[power.backup]}` : t('Cadangan listrik belum diisi', 'Power backup not set')}</span>
        </span>
      </div>

      {prep && (
        <p class="power-prep">
          <Icon name="clock" size={20} />
          <span>
            <strong>{fmtClock(prep.t)}</strong> · {prep.reason}
          </span>
        </p>
      )}

      {(power.reasons.length > 0 || power.note) && (
        <button type="button" class="link-btn row" style={{ alignSelf: 'flex-start', gap: 8 }} aria-expanded={open} onClick={() => setOpen(!open)}>
          {t('Kenapa?', 'Why?')}
          <span style={{ display: 'flex', transform: open ? 'rotate(180deg)' : 'none' }}>
            <Icon name="down" size={20} />
          </span>
        </button>
      )}
      {open && (
        <div class="stack-sm">
          {power.reasons.length > 0 && (
            <ul class="power-reasons">
              {power.reasons.map((r) => (
                <li key={`${r.source}-${r.id}`}>{r.text}</li>
              ))}
            </ul>
          )}
          {power.reasons.length === 0 && <p class="label ink2">{t('Tidak ada tanda badai petir, angin kencang atau hujan deras malam ini.', 'No sign of thunderstorms, strong wind or heavy rain tonight.')}</p>}
          {power.note && (
            <p class="note info">
              <Icon name="info" size={20} />
              <span>{power.note}</span>
            </p>
          )}
          <span class="label ink2">{sources(power)}</span>
        </div>
      )}

      {power.level !== 'low' && (
        <button type="button" class="btn secondary" onClick={() => go({ name: 'outage' })}>
          <Icon name="bolt" size={20} /> {t('Listrik padam sekarang', 'Power is out now')}
        </button>
      )}
    </section>
  );
}

/** "Cadangan listrik": generator, battery backup, or none. */
export function BackupChoice({ value, onChange }: { value: PowerBackup | null; onChange: (v: PowerBackup) => void }) {
  return <Chips<PowerBackup> options={BACKUP_LABEL} value={value ? [value] : []} onChange={(v) => v[0] && onChange(v[0])} />;
}

/** Profil: what keeps the aerators running in a power cut. The owner changes it; workers see it. */
export function BackupCard({ value, owner, onSaved }: { value: PowerBackup | null; owner: boolean; onSaved: () => void }) {
  const [current, setCurrent] = useState(value);
  const [error, setError] = useState('');
  const save = async (v: PowerBackup) => {
    const before = current;
    setCurrent(v);
    setError('');
    try {
      await api.setPowerBackup(v);
      onSaved();
    } catch (err) {
      setCurrent(before);
      setError((err as Error).message);
    }
  };
  return (
    <section class="card" aria-labelledby="cadangan-title">
      <div class="row">
        <span class="icon-box">
          <Icon name="bolt" />
        </span>
        <span class="grow stack-xs" style={{ gap: 0 }}>
          <span class="strong" id="cadangan-title">
            {t('Cadangan listrik', 'Power backup')}
          </span>
          <span class="meta">{t('Untuk aerator saat listrik padam', 'For the aerators when the power goes out')}</span>
        </span>
      </div>
      {owner ? <BackupChoice value={current} onChange={save} /> : <span class="strong">{current ? BACKUP_LABEL[current] : t('Belum diisi pemilik tambak', 'Not set by the farm owner yet')}</span>}
      {error && <p class="error">{error}</p>}
    </section>
  );
}

// ---------- BMKG on the weather card ----------

function stepIcon(s: BmkgView['steps'][number]): IconName {
  if (/petir|thunder/i.test(s.desc) || s.code === 95 || s.code === 97) return 'bolt';
  if (/hujan|rain/i.test(s.desc)) return 'rain';
  const hour = new Date(s.t + 7 * 3600_000).getUTCHours();
  if (/cerah|clear|sunny/i.test(s.desc) && !/berawan|cloud/i.test(s.desc)) return hour >= 18 || hour < 6 ? 'moon' : 'sun';
  return 'cloud';
}

/** The farm's BMKG village forecast, next four 3-hour steps; owners can change the village. */
export function BmkgPanel({ bmkg, owner, onChanged }: { bmkg: BmkgView; owner: boolean; onChanged: () => void }) {
  const [picking, setPicking] = useState(false);
  const steps = bmkg.steps.filter((s) => s.t >= Date.now() - 90 * 60_000).slice(0, 4);
  const r = bmkg.region;
  return (
    <div class="bmkg stack-sm">
      <div class="row top between" style={{ gap: 8 }}>
        <span class="stack-xs" style={{ gap: 0 }}>
          <span class="label semi">{t('Prakiraan BMKG', 'BMKG forecast')}</span>
          <span class="label ink2">
            {r.desa}, {r.kecamatan}, {r.kabupaten}
            {r.auto ? t(' · terdekat dari lokasi tambak', ' · nearest to the farm') : t(' · dipilih pemilik', ' · picked by the owner')}
          </span>
        </span>
        {owner && !picking && (
          <button type="button" class="link-btn" style={{ flex: 'none' }} onClick={() => setPicking(true)}>
            {t('Ganti wilayah', 'Change area')}
          </button>
        )}
      </div>
      {picking && (
        <RegionPicker
          auto={r.auto}
          onCancel={() => setPicking(false)}
          onPicked={() => {
            setPicking(false);
            onChanged();
          }}
        />
      )}
      {steps.length > 0 ? (
        <div class="hours bmkg-steps" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
          {steps.map((s) => (
            <div key={s.t} class={stepIcon(s) === 'bolt' || stepIcon(s) === 'rain' ? 'rain' : ''}>
              <span class="label ink2 num">{fmtClock(s.t)}</span>
              <span style={{ color: stepIcon(s) === 'bolt' || stepIcon(s) === 'rain' ? 'var(--accent)' : 'var(--muted)', display: 'flex' }}>
                <Icon name={stepIcon(s)} />
              </span>
              <span class="label center bmkg-desc">{s.desc}</span>
            </div>
          ))}
        </div>
      ) : (
        <p class="label ink2">{t('Prakiraan BMKG belum termuat. Dicoba lagi otomatis.', 'The BMKG forecast has not loaded. It is tried again on its own.')}</p>
      )}
      <span class="label ink2">{t('Sumber: BMKG', 'Source: BMKG')}</span>
    </div>
  );
}

/** Search a desa or kecamatan by name and pick it; or go back to the village nearest the farm. */
function RegionPicker({ auto, onPicked, onCancel }: { auto: boolean; onPicked: () => void; onCancel: () => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Region[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const query = q.trim();
    if (query.length < 3) return setResults(null);
    let live = true;
    const timer = setTimeout(
      () =>
        api.searchRegion(query).then(
          (r) => live && setResults(r.results),
          (err) => live && setError((err as Error).message),
        ),
      300,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q]);
  const pick = async (code: string | null) => {
    setBusy(true);
    setError('');
    try {
      await api.setRegion(code);
      onPicked();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="stack-sm region-picker">
      <label class="picker-search">
        <Icon name="search" size={20} />
        <input autoFocus aria-label={t('Cari desa atau kecamatan', 'Search a village or district')} placeholder={t('Nama desa atau kecamatan', 'Village or district name')} value={q} onInput={(e) => setQ(e.currentTarget.value)} />
      </label>
      {results && results.length === 0 && <p class="label ink2">{t('Tidak ada desa dengan nama itu.', 'No village with that name.')}</p>}
      {results && results.length > 0 && (
        <div class="stack-xs" role="listbox" aria-label={t('Hasil pencarian', 'Search results')}>
          {results.map((r) => (
            <button key={r.code} type="button" role="option" aria-selected={false} class="region-option" disabled={busy} onClick={() => pick(r.code)}>
              <span class="strong">{r.desa}</span>
              <span class="label ink2">
                {r.kecamatan}, {r.kabupaten}, {r.provinsi}
              </span>
            </button>
          ))}
        </div>
      )}
      {error && <p class="error">{error}</p>}
      <div class="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button type="button" class="btn compact secondary" onClick={onCancel}>
          {t('Batal', 'Cancel')}
        </button>
        {!auto && (
          <button type="button" class="btn compact tint" disabled={busy} onClick={() => pick(null)}>
            {t('Pakai desa terdekat', 'Use the nearest village')}
          </button>
        )}
      </div>
    </div>
  );
}

/** "Listrik padam" fast from anywhere: the latest open power cut, read with the farm. */
export function useOpenOutage(deps: unknown[] = []) {
  const [outage, setOutage] = useState<{ startedAt: string } | null>(null);
  useEffect(() => {
    let live = true;
    api.openOutage().then(
      (r) => live && setOutage(r.outage),
      () => {},
    );
    return () => {
      live = false;
    };
  }, deps);
  return outage;
}

