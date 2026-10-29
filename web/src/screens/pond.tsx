import { useEffect, useState } from 'preact/hooks';
import { StepList, useSteps } from '../steps.tsx';
import { CaseCard, ClosedCases, useCases } from './case.tsx';
import { api, ApiError, type Limits, type Log, type NowcastState, type PondProfile, type PondSummary, type Role } from '../api.ts';
import type { Go } from '../app.tsx';
import { aerationLabel, fmtAgo, fmtNum, fmtTemp, fmtTime, phaseLabel, readingWord, settingLabel, sourceLabel, summarizeLog } from '../labels.ts';
import { usePrefs } from '../prefs.ts';
import { ActionBar, Icon, kindLabel, Notice, Shape, SimChip, Soon, StatusPill, tankPath, toneOf, type Tone } from '../ui.tsx';
import { isEn, LOCALE, t } from '../i18n.ts';
import './pond.css';

type Key = 'temperature' | 'ph' | 'tds';
// `tab`: the word on the narrow three-way switch ("Temp" in English, the one allowed short form).
const METRICS: { key: Key; label: string; tab: string; unit: string; scale: [number, number] }[] = [
  { key: 'temperature', label: t('Suhu', 'Temperature'), tab: t('Suhu', 'Temp'), unit: ' °C', scale: [22, 34] },
  { key: 'ph', label: 'pH', tab: 'pH', unit: '', scale: [6, 9] },
  { key: 'tds', label: 'TDS', tab: 'TDS', unit: '', scale: [0, 300] },
];

const pct = (v: number, [lo, hi]: [number, number]) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
const targetText = (l: Limits | undefined, unit: string) => {
  const tg = l?.target;
  if (!tg) return '';
  if (tg.min !== undefined && tg.max !== undefined) return `target ${fmtNum(tg.min)}–${fmtNum(tg.max)}${unit}`;
  if (tg.max !== undefined) return t(`batas ${fmtNum(tg.max)}${unit}`, `limit ${fmtNum(tg.max)}${unit}`);
  return t(`minimal ${fmtNum(tg.min!)}${unit}`, `at least ${fmtNum(tg.min!)}${unit}`);
};

const READING_WORD: Record<string, string> = isEn
  ? { temperature: 'temperature', ph: 'pH', tds: 'TDS', do: 'oxygen', tan: 'ammonia', no2: 'nitrite', no3: 'nitrate' }
  : { temperature: 'suhu', ph: 'pH', tds: 'TDS', do: 'oksigen', tan: 'amonia', no2: 'nitrit', no3: 'nitrat' };

/** Source names in plain words: "(temperature)" → "(suhu)", "DO rendah" → "oksigen rendah". */
export const plainSource = (s: string) =>
  s.replace(/\(([a-z0-9_]+)\)/g, (m, id) => (READING_WORD[id] ? `(${READING_WORD[id]})` : m)).replace(/\bDO\b/g, t('oksigen', 'oxygen'));

/** Program text in plain words: NO₂ is "nitrit" on the farm. */
const plainWater = (s: string) =>
  s
    .replace(/NO₂/g, t('nitrit', 'nitrite'))
    .replace(/NO₃/g, t('nitrat', 'nitrate'))
    .replace(/\bTAN\b/g, t('amonia', 'ammonia'))
    .replace(/\bDO\b/g, t('oksigen', 'oxygen'));

/** The kind of feed without portions: feed percentages belong in Teknis only. */
const feedKind = (feed: string) =>
  feed
    .split(',')[0]
    .replace(/\s*\d[\d–\-,.]*\s*%.*$/, '')
    .replace(/\s*\+\s*/g, t(' dan ', ' and '))
    .trim();

/** Last value per day for the past 7 days, oldest first. */
function daily(logs: Log[], key: Key) {
  const byDay = new Map<string, number>();
  for (const l of [...logs].reverse()) {
    const v = l.data.readings?.[key];
    if (v !== undefined) byDay.set(l.loggedAt.slice(0, 10), v);
  }
  return [...byDay.entries()].slice(-7);
}

function MetricCard({ pond, logs }: { pond: PondSummary; logs: Log[] }) {
  const [key, setKey] = useState<Key>('temperature');
  const m = METRICS.find((x) => x.key === key)!;
  const latest = pond.latest[key];
  const limits = pond.limits[key];
  const word = latest ? readingWord(key, latest.value, pond.status[key], limits) : null;
  const days = daily(logs, key);
  // Zoom the scale to this week's values and the target band, so a 1° drop is visible.
  const values = days.map(([, v]) => v);
  const tmin = limits?.target?.min ?? Math.min(...values, m.scale[0]);
  const tmax = limits?.target?.max ?? Math.max(...values, m.scale[1]);
  const span = Math.max(tmax - tmin, ...values.map((v) => Math.abs(v - (tmin + tmax) / 2) * 2), key === 'tds' ? 20 : key === 'ph' ? 0.4 : 1);
  const lo = Math.min(tmin, ...values) - span * 0.6;
  const hi = Math.max(tmax, ...values) + span * 0.3;
  const y = (v: number) => ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * 96;
  const first = days[0]?.[1];
  const last = days.at(-1)?.[1];
  const diff = first !== undefined && last !== undefined ? last - first : 0;
  const sentence =
    days.length < 2
      ? t('Belum cukup catatan untuk melihat arah. Ukur pagi dan sore.', 'Not enough records to see a trend yet. Measure morning and afternoon.')
      : Math.abs(diff) < (key === 'tds' ? 5 : key === 'ph' ? 0.1 : 0.3)
        ? t(`${m.label} stabil dalam ${days.length} hari terakhir.`, `${m.label} steady over the last ${days.length} days.`)
        : t(
            `${m.label} ${diff > 0 ? 'naik' : 'turun'} ${fmtNum(Math.abs(Math.round(diff * 10) / 10))}${m.unit} dalam ${days.length} hari.`,
            `${m.label} ${diff > 0 ? 'up' : 'down'} ${fmtNum(Math.abs(Math.round(diff * 10) / 10))}${m.unit} over ${days.length} days.`,
          );

  return (
    <section class="card">
      <div class="segmented pills" role="tablist" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
        {METRICS.map((x) => (
          <button key={x.key} role="tab" aria-selected={x.key === key} class={x.key === key ? 'on' : ''} onClick={() => setKey(x.key)}>
            {x.key === key && <Icon name="check" size={16} stroke={3} />}
            {x.tab}
          </button>
        ))}
      </div>
      <div class="stack-sm">
        <div class="row between">
          <span class="big">{latest ? (key === 'temperature' ? fmtTemp(latest.value) : fmtNum(latest.value)) : '–'}</span>
          {word && (
            <span class={`pill ${word.tone}`} style={{ flex: 'none' }}>
              <Shape tone={word.tone} />
              {word.text}
            </span>
          )}
        </div>
        <span class="meta">
          {latest ? t(`diukur ${fmtAgo(Date.parse(latest.at))}`, `measured ${fmtAgo(Date.parse(latest.at))}`) : t('belum diukur', 'not measured yet')}
          {limits && ` · ${targetText(limits, m.unit)}`}
        </span>
      </div>
      {days.length > 0 && (
        <div class="stack-sm">
          <div class="band-chart">
            <span class="band" style={{ bottom: `${y(tmin)}px`, height: `${Math.max(4, y(tmax) - y(tmin))}px` }} />
            <div class="bars" style={{ alignItems: 'flex-end' }}>
              {days.map(([d, v]) => (
                <span key={d} title={`${d}: ${fmtNum(v)}`} style={{ height: `${Math.max(6, y(v))}px`, opacity: v >= tmin && v <= tmax ? 1 : 0.45 }} />
              ))}
            </div>
          </div>
          <span class="meta">{t('Pita hijau = rentang target. Satu batang = ukuran terakhir tiap hari.', 'Green band = target range. One bar = last reading of each day.')}</span>
        </div>
      )}
      <p>{sentence}</p>
    </section>
  );
}

// Readings only a Synteel device sends (a farmer measures these with a test kit, rarely).
// Limits from knowledge/thresholds.json: oxygen target at least 6, Perhatian below 5, Bahaya below 4;
// ammonia Perhatian above 0.5, Bahaya above 1; nitrite Perhatian above 0.3, Bahaya above 0.5.
type SensorKey = 'do' | 'tan' | 'no2';
const SENSOR_ROWS: { key: SensorKey; label: string; low: boolean; warn: number; bad: number; limit: string }[] = [
  { key: 'do', label: t('Oksigen', 'Oxygen'), low: true, warn: 5, bad: 4, limit: t('minimal 6', 'at least 6') },
  { key: 'tan', label: t('Amonia', 'Ammonia'), low: false, warn: 0.5, bad: 1, limit: t('batas 0,5', 'limit 0.5') },
  { key: 'no2', label: t('Nitrit', 'Nitrite'), low: false, warn: 0.3, bad: 0.5, limit: t('batas 0,3', 'limit 0.3') },
];

function sensorWord(row: (typeof SENSOR_ROWS)[number], v: number): { text: string; tone: Tone } {
  const past = (limit: number) => (row.low ? v < limit : v > limit);
  if (past(row.bad)) return { text: row.low ? t('Terlalu rendah', 'Too low') : t('Terlalu tinggi', 'Too high'), tone: 'bad' };
  if (past(row.warn)) return { text: row.low ? t('Agak rendah', 'A bit low') : t('Agak tinggi', 'A bit high'), tone: 'warn' };
  return { text: t('Baik', 'Good'), tone: 'ok' };
}

/** Oxygen, ammonia and nitrite from the device sensor, in the same word + shape pattern as the other readings. */
function SensorCard({ pond }: { pond: PondSummary }) {
  const rows = SENSOR_ROWS.filter((r) => pond.latest[r.key]);
  if (rows.length === 0) return null;
  const at = Math.max(...rows.map((r) => Date.parse(pond.latest[r.key]!.at)));
  return (
    <section class="card">
      <div class="stack-xs">
        <h2>{t('Ukuran sensor', 'Sensor readings')}</h2>
        <span class="meta">{t(`Diukur oleh sensor · ${sinceText(at)}`, `Measured by the sensor · ${sinceText(at)}`)}</span>
      </div>
      <div class="readings">
        {rows.map((r) => {
          const v = pond.latest[r.key]!.value;
          const w = sensorWord(r, v);
          return (
            <div class="reading" key={r.key}>
              <span class="k sensor-k">{r.label}</span>
              <span class="v">
                {fmtNum(Math.round(v * 100) / 100)} <span class="label ink2" style={{ fontWeight: 600 }}>mg/L</span>
              </span>
              <span class={`word ${w.tone}`}>
                <Shape tone={w.tone} />
                {w.text}
              </span>
            </div>
          );
        })}
      </div>
      <span class="meta">{rows.map((r) => `${r.label} ${r.limit} mg/L`).join(' · ')}</span>
    </section>
  );
}

/** "2 menit lalu", or "baru saja" within the first minute (sensor readings are that fresh). */
const sinceText = (at: number) => (Date.now() - at < 60_000 ? t('baru saja', 'just now') : fmtAgo(at));

/** "Alat Synteel": which device feeds this pond, or a way to connect one. */
function DeviceCard({ pond, logs, ponds, role, go, onChanged }: { pond: PondSummary; logs: Log[]; ponds: PondSummary[]; role?: Role | null; go: Go; onChanged: () => unknown }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const d = pond.device;
  const owner = role === 'owner';

  if (!d)
    return (
      <section class="card">
        <div class="row">
          <span class="icon-box grey">
            <Icon name="wifi" />
          </span>
          <div class="stack-xs grow">
            <h2>{t('Alat Synteel', 'Synteel device')}</h2>
            <span class="label ink2">{t('Belum ada alat yang mengirim angka ke kolam ini.', 'No device sends readings to this pond yet.')}</span>
          </div>
        </div>
        <p class="label ink2">
          {t(
            'Alat simulasi membuat kolam simulasi baru sendiri, jadi kolam ini tidak berubah.',
            'A simulated device makes new simulation ponds of its own, so this pond does not change.',
          )}
        </p>
        <button type="button" class="btn secondary" onClick={() => go({ name: 'device' })}>
          <Icon name="wifi" /> {t('Hubungkan alat', 'Connect a device')}
        </button>
      </section>
    );

  const lastSensor = logs.find((l) => l.source === 'sensor');
  const siblings = ponds.filter((p) => p.device?.code === d.code);
  const names = (siblings.length ? siblings : [pond]).map((p) => p.name);
  const nameList = names.length > 1 ? `${names.slice(0, -1).join(', ')} ${t('dan', 'and')} ${names.at(-1)}` : names[0];

  const unlink = async () => {
    setBusy(true);
    setError('');
    try {
      await api.unlinkDevice(d.code);
      await onChanged();
      go({ name: 'record' });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <section class="card">
      <div class="row top">
        <span class="icon-box">
          <Icon name="wifi" />
        </span>
        <div class="stack-xs grow">
          <span class="meta">{t('Alat Synteel', 'Synteel device')}</span>
          <span class="strong">
            {t(`Terhubung ke ${d.name} · ${d.unitName}`, `Connected to ${d.name} · ${d.unitName}`)}
            {d.simulated && <SimChip pond={d} />}
          </span>
          <span class="label ink2 num">
            {t('Kode', 'Code')} {d.code}
          </span>
          <span class="label ink2">
            {lastSensor
              ? t(`Angka terakhir dari sensor ${sinceText(Date.parse(lastSensor.loggedAt))}`, `Last sensor reading ${sinceText(Date.parse(lastSensor.loggedAt))}`)
              : t('Belum ada angka dari sensor', 'No sensor readings yet')}
          </span>
        </div>
      </div>
      {owner && !asking && (
        <button type="button" class="btn secondary" onClick={() => setAsking(true)}>
          {t('Putuskan alat', 'Disconnect the device')}
        </button>
      )}
      {owner && asking && (
        <div class="stack">
          <Notice tone="bad" icon="alert" title={t('Putuskan alat ini?', 'Disconnect this device?')}>
            {d.simulated
              ? t(
                  `Kolam simulasi dari alat ini dihapus dari daftar: ${nameList}. Catatannya ikut hilang. Kolam lain tidak berubah.`,
                  `The simulation ponds of this device are removed from the list: ${nameList}. Their records go with them. Other ponds do not change.`,
                )
              : t('Angka dari alat berhenti masuk. Kolam dan catatannya tetap ada.', 'Readings from the device stop coming in. The pond and its records stay.')}
          </Notice>
          {error && <p class="error">{error}</p>}
          <div class="grid2" style={{ gap: 8 }}>
            <button type="button" class="btn danger" disabled={busy} onClick={unlink}>
              {busy ? t('Memutus…', 'Disconnecting…') : t('Putuskan', 'Disconnect')}
            </button>
            <button type="button" class="btn secondary" disabled={busy} onClick={() => setAsking(false)}>
              {t('Batal', 'Cancel')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** "12 catatan sejak Jumat · terakhir Rabu 17.15" for the row that opens the full history. */
function historyLine(logs: Log[]) {
  if (logs.length === 0) return t('Belum ada catatan 14 hari terakhir', 'No records in the last 14 days');
  const oldest = Date.parse(logs.at(-1)!.loggedAt);
  const since =
    Date.now() - oldest < 6 * 86400_000
      ? new Date(oldest).toLocaleDateString(LOCALE, { weekday: 'long', timeZone: 'Asia/Jakarta' })
      : new Date(oldest).toLocaleDateString(LOCALE, { day: 'numeric', month: 'long', timeZone: 'Asia/Jakarta' });
  return t(
    `${logs.length} catatan sejak ${since} · terakhir ${fmtTime(logs[0].loggedAt)}`,
    `${logs.length} ${logs.length === 1 ? 'record' : 'records'} since ${since} · last ${fmtTime(logs[0].loggedAt)}`,
  );
}

/**
 * Other names for the pond that the voice reader understands ("kolam pojok"). The owner edits
 * the whole list; others can add a name.
 */
function Nicknames({ pond, role, onSaved }: { pond: PondSummary; role?: Role | null; onSaved: (p: PondSummary) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const names = pond.nicknames ?? [];
  // Unknown role (older app shell): try the owner's way, fall back to adding one.
  const owner = role !== 'worker';

  const start = () => {
    setDraft(owner ? names.join(', ') : '');
    setError('');
    setEditing(true);
  };

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const typed = draft.split(',').map((n) => n.trim()).filter(Boolean);
      let saved: PondSummary;
      try {
        if (!owner) throw new ApiError('', 403);
        saved = (await api.updatePond(pond.id, { nicknames: typed } as PondProfile)).pond;
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 403)) throw err;
        const added = typed.filter((n) => !names.includes(n));
        if (added.length === 0) {
          setEditing(false);
          return;
        }
        saved = pond;
        for (const n of added) saved = (await api.addNickname(pond.id, n)).pond;
      }
      onSaved(saved);
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!editing)
    return (
      <div class="row" style={{ background: 'var(--bg)', borderRadius: 16, padding: '8px 8px 8px 16px' }}>
        <span class="grow stack-xs" style={{ gap: 0 }}>
          <span class="meta">{t('Nama panggilan', 'Nicknames')}</span>
          <span class="strong">{names.length ? names.join(', ') : t('Belum ada', 'None yet')}</span>
        </span>
        <button type="button" class="nick-btn" onClick={start}>
          <Icon name={owner || names.length === 0 ? 'pencil' : 'plus'} size={16} stroke={2.5} />
          {owner || names.length === 0 ? t('Ubah', 'Edit') : t('Tambah', 'Add')}
        </button>
      </div>
    );

  return (
    <div class="stack">
      <label class="field">
        <span class="meta">{owner ? t('Nama panggilan (boleh kosong)', 'Nicknames (optional)') : t('Nama panggilan baru', 'New nickname')}</span>
        <input value={draft} onInput={(e) => setDraft(e.currentTarget.value)} placeholder={t('contoh: kolam pojok', 'example: corner pond')} />
        <span class="field-hint">{owner && names.length > 1 ? t('Pisahkan dengan koma. ', 'Separate them with commas. ') : ''}
          {t('AI memakai ini saat mendengar suara.', 'The AI uses this when it listens to voice recordings.')}</span>
      </label>
      {error && <p class="error">{error}</p>}
      <div class="grid2" style={{ gap: 8 }}>
        <button type="button" class="btn primary" disabled={busy} onClick={save}>
          {busy ? t('Menyimpan…', 'Saving…') : t('Simpan', 'Save')}
        </button>
        <button type="button" class="btn secondary" onClick={() => setEditing(false)}>
          {t('Batal', 'Cancel')}
        </button>
      </div>
    </div>
  );
}

export function PondDetail({
  id,
  nowcast,
  role,
  ponds = [],
  onChanged = () => {},
  go,
}: {
  id: number;
  nowcast: NowcastState | null;
  role?: Role | null;
  /** The farm's ponds, to name a device's other ponds before disconnecting it. */
  ponds?: PondSummary[];
  /** The farm changed here (device disconnected): reload it. */
  onChanged?: () => unknown;
  go: Go;
}) {
  const prefs = usePrefs();
  const [data, setData] = useState<{ pond: PondSummary; logs: Log[] } | null>(null);
  const [error, setError] = useState('');
  const [tech, setTech] = useState(prefs.techOpen);
  const { done, toggle } = useSteps(id);
  const cases = useCases(id, data?.logs.length);

  useEffect(() => {
    api.pond(id).then(setData, (e) => setError(e.message));
  }, [id]);

  // A pond fed by a device gets new readings by itself: reload every 30 seconds while the app is in front.
  const hasDevice = Boolean(data?.pond.device);
  useEffect(() => {
    if (!hasDevice) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') api.pond(id).then(setData, () => {});
    }, 30_000);
    return () => clearInterval(timer);
  }, [id, hasDevice]);

  if (error)
    return (
      <div class="screen">
        <p class="error">{error}</p>
      </div>
    );
  if (!data)
    return (
      <div class="screen">
        <p class="muted">{t('Memuat…', 'Loading…')}</p>
      </div>
    );

  const { pond, logs } = data;
  const nc = nowcast?.ponds.find((n) => n.pondId === pond.id);
  const top = pond.findings.find((f) => f.level === 'critical' || f.level === 'warning');
  const stage = pond.program?.stage;
  const weekDead = logs.filter((l) => Date.parse(l.loggedAt) >= Date.now() - 7 * 86400_000).reduce((s, l) => s + (l.data.mortality ?? 0), 0);
  const fit = nc?.basis.fit ?? [];
  const good = fit.filter((f) => Math.abs(f.error) <= 0.5).length;

  return (
    <div class="screen">
      <section class="cover" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {/* No photo yet: the pond type as a line glyph in a neutral tile, never a filled shape. */}
        <span style={{ width: 120, height: 120, marginRight: 80, borderRadius: 24, background: 'var(--bg)', color: 'var(--ink-2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d={tankPath(pond.kind)} />
          </svg>
        </span>
        <button class="icon-btn" aria-label={t('Kembali ke Beranda', 'Back to Home')} onClick={() => go({ name: 'today' })}>
          <Icon name="back" />
        </button>
        <span class="cover-action stack-xs" style={{ alignItems: 'flex-end' }}>
          <span class="pill grey" style={{ background: 'var(--surface)', minHeight: 44 }}>
            <Icon name="camera" size={18} /> {t('Foto kolam', 'Pond photo')}
          </span>
          <Soon />
        </span>
      </section>

      <header class="row top between">
        <div class="stack-xs">
          <h1>
            {pond.name}
            <SimChip pond={pond} />
          </h1>
          <span class="meta">
            {[pond.kind && (kindLabel[pond.kind] ?? pond.kind), pond.batch && phaseLabel[pond.batch.phase], pond.program && `${t('minggu', 'week')} ${pond.program.week}`].filter(Boolean).join(' · ') ||
              t('Belum ada batch', 'No batch yet')}
            {pond.program?.estimatedAlive != null && (
              <>
                <br />
                {t(`sekitar ${pond.program.estimatedAlive.toLocaleString(LOCALE)} ekor`, `about ${pond.program.estimatedAlive.toLocaleString(LOCALE)} eels`)}
              </>
            )}
          </span>
        </div>
        <StatusPill level={pond.level} />
      </header>

      {cases.list
        .filter((c) => c.status === 'open')
        .map((c) => (
          <CaseCard key={c.id} c={c} go={go} onChanged={(next) => (cases.replace(next), api.pond(id).then(setData, () => {}))} onPond />
        ))}

      <div class="segmented" role="tablist" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
        <button role="tab" aria-selected={!tech} class={!tech ? 'on' : ''} onClick={() => setTech(false)}>
          {!tech && <Icon name="check" size={16} stroke={3} />}
          {t('Ringkas', 'Simple')}
        </button>
        <button role="tab" aria-selected={tech} class={tech ? 'on' : ''} onClick={() => setTech(true)}>
          {tech && <Icon name="check" size={16} stroke={3} />}
          {t('Teknis', 'Technical')}
        </button>
      </div>

      {!tech &&
        (top ? (
          <section class="hero">
            <span class="label semi" style={{ color: 'var(--on-navy-2)' }}>
              {t('Yang terjadi', 'What is happening')}
            </span>
            <p class="h2" style={{ color: '#fff' }}>
              {top.title}. {top.detail}
            </p>
            {top.actions.length > 0 && (
              <>
                <span class="label" style={{ color: 'var(--on-hero-soft)' }}>
                  {t('Lakukan sekarang:', 'Do now:')}
                </span>
                <StepList steps={top.actions} done={done} toggle={toggle} onAllDone={{ label: t('Catat kondisi sekarang', 'Record conditions now'), run: () => go({ name: 'record-pond', pondId: id }) }} />
              </>
            )}
          </section>
        ) : (
          <section class="card tint">
            <h2>{t('Kolam aman', 'Pond safe')}</h2>
            <p class="ink2">{t('Tidak ada peringatan dari catatan terakhir.', 'No warnings from the latest record.')}</p>
          </section>
        ))}

      {!tech && stage && (
        <section class="card" style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <span class="icon-box">
            <Icon name="bowl" />
          </span>
          <div class="stack-xs grow">
            <span class="strong">
              {t('Minggu ke-', 'Week ')}
              {pond.program!.week}: {stage.name}
            </span>
            <span class="ink2">
              {t(
                `Pakan ${feedKind(stage.feed).toLowerCase()}. Air: ${plainWater(stage.water).toLowerCase()}. Porsi pakan ada di Teknis.`,
                `Feed: ${feedKind(stage.feed).toLowerCase()}. Water: ${plainWater(stage.water).toLowerCase()}. Feed portions are in Technical.`,
              )}
            </span>
          </div>
        </section>
      )}

      {tech && (
        <section class="card">
          <h2>{t('Ukuran terakhir dibanding target', 'Latest readings compared with target')}</h2>
          {METRICS.map((m) => {
            const r = pond.latest[m.key];
            const l = pond.limits[m.key];
            const tg = l?.target;
            const from = tg?.min ?? m.scale[0];
            const to = tg?.max ?? m.scale[1];
            return (
              <div class="stack-sm" key={m.key}>
                <div class="row between">
                  <span class="ink2">{m.label}</span>
                  <span class="strong num">{r ? (m.key === 'temperature' ? fmtTemp(r.value) : fmtNum(r.value)) : '–'}</span>
                </div>
                <span class="ruler">
                  <span class="target" style={{ left: `${pct(from, m.scale)}%`, width: `${pct(to, m.scale) - pct(from, m.scale)}%` }} />
                  {r && <span class="mark" style={{ left: `${pct(r.value, m.scale)}%` }} />}
                </span>
                <span class="meta">
                  {[
                    targetText(l, m.unit),
                    l?.warning?.below !== undefined && t(`perhatian di bawah ${fmtNum(l.warning.below)}`, `caution below ${fmtNum(l.warning.below)}`),
                    l?.critical?.below !== undefined && t(`bahaya di bawah ${fmtNum(l.critical.below)}`, `danger below ${fmtNum(l.critical.below)}`),
                    l?.warning?.above !== undefined && t(`perhatian di atas ${fmtNum(l.warning.above)}`, `caution above ${fmtNum(l.warning.above)}`),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </div>
            );
          })}
        </section>
      )}

      <MetricCard pond={pond} logs={logs} />

      <SensorCard pond={pond} />

      {!tech && (
        <button class="card history-row" onClick={() => go({ name: 'history', pondId: pond.id })}>
          <span class="icon-box">
            <Icon name="clock" />
          </span>
          <span class="grow stack-xs" style={{ gap: 2 }}>
            <span class="strong">{t('Riwayat catatan', 'Record history')}</span>
            <span class="meta">{historyLine(logs)}</span>
          </span>
          <span style={{ color: 'var(--muted)', display: 'inline-flex' }}>
            <Icon name="next" size={20} />
          </span>
        </button>
      )}

      {/* A new pond: its history can come from the farmer's notebook on day one. */}
      {!tech && logs.length < 6 && (
        <button class="card history-row" onClick={() => go({ name: 'notebook', pondId: pond.id })}>
          <span class="icon-box">
            <Icon name="book" />
          </span>
          <span class="grow stack-xs" style={{ gap: 2 }}>
            <span class="strong">{t('Punya buku catatan kolam ini?', 'Have a notebook for this pond?')}</span>
            <span class="meta">{t('Foto halamannya, riwayat dan perkiraan langsung punya data.', 'Take a photo of the pages; history and estimates get data right away.')}</span>
          </span>
          <span style={{ color: 'var(--muted)', display: 'inline-flex' }}>
            <Icon name="next" size={20} />
          </span>
        </button>
      )}

      {!tech && (
        <button class="btn secondary" onClick={() => go({ name: 'problem', pondId: pond.id })}>
          <Icon name="siren" size={20} /> {t('Lapor masalah di kolam ini', 'Report a problem in this pond')}
        </button>
      )}

      {tech && (
        <>
          <section class="card">
            <div class="row">
              <span class="icon-box">
                <Icon name="thermo" />
              </span>
              <div class="stack-xs grow">
                <span class="strong">{t('Perkiraan dibanding ukuran', 'Estimate compared with readings')}</span>
                <span class="label ink2">
                  {fit.length >= 3
                    ? t(
                        `${good} dari ${fit.length} ukuran suhu terakhir cocok (selisih 0,5 °C atau kurang).`,
                        `${good} of the last ${fit.length} temperature readings matched (0.5 °C off or less).`,
                      )
                    : t('Perkiraan sedang belajar: butuh beberapa ukuran suhu lagi.', 'The estimate is still learning: it needs a few more temperature readings.')}
                </span>
              </div>
            </div>
            {fit.length > 0 && (
              <svg viewBox="0 0 310 112" width="100%" role="img" aria-label={t(
                  `Selisih perkiraan dan ukuran suhu, ${good} dari ${fit.length} di dalam zona cocok`,
                  `Gap between estimate and measured temperature, ${good} of ${fit.length} inside the match zone`,
                )}>
                <rect x="0" y="36" width="310" height="40" style={{ fill: 'var(--ok-bg)' }} />
                <line x1="0" y1="56" x2="310" y2="56" stroke="#6CC3A0" stroke-dasharray="4 4" />
                {fit.map((f, i) => {
                  const x = 20 + i * (270 / Math.max(1, fit.length - 1));
                  const y = Math.max(8, Math.min(104, 56 - f.error * 40));
                  const ok = Math.abs(f.error) <= 0.5;
                  return ok ? (
                    <circle key={f.t} cx={x} cy={y} r="7" style={{ fill: 'var(--ink)', stroke: 'var(--surface)' }} stroke-width="2" />
                  ) : (
                    <rect key={f.t} x={x - 7} y={y - 7} width="14" height="14" style={{ fill: 'var(--warn-dot)', stroke: 'var(--surface)' }} stroke-width="2" />
                  );
                })}
              </svg>
            )}
          </section>

          <section class="card" style={{ gap: 4 }}>
            <div class="row between" style={{ marginBottom: 8 }}>
              <h2>{t('Riwayat catatan', 'Record history')}</h2>
              <span class="meta">{t(`mati 7 hari: ${weekDead} ekor`, `dead in 7 days: ${weekDead} ${weekDead === 1 ? 'eel' : 'eels'}`)}</span>
            </div>
            {logs.length === 0 && <p class="ink2">{t('Belum ada catatan.', 'No records yet.')}</p>}
            {logs.slice(0, 12).map((l) => (
              <div key={l.id} class="stack-xs" style={{ padding: '12px 0', borderBottom: '1px solid var(--line)' }}>
                <div class="row between">
                  <span class="strong">{fmtTime(l.loggedAt)}</span>
                  <span class="label semi" style={{ color: l.source === 'manual' ? 'var(--ink-2)' : 'var(--accent-ink)' }}>
                    {sourceLabel[l.source]}
                  </span>
                </div>
                <span class="label ink2">{summarizeLog(l.data) || t('Cek: tidak ada catatan angka', 'Check: no numbers recorded')}</span>
              </div>
            ))}
            <button class="link-row label" style={{ marginTop: 8, minHeight: 44, justifyContent: 'flex-start', gap: 4, fontWeight: 800 }} onClick={() => go({ name: 'history', pondId: pond.id })}>
              <span>{t(`Lihat semua ${logs.length} catatan di Riwayat`, `See all ${logs.length} records in History`)}</span>
              <Icon name="next" size={16} stroke={2.5} />
            </button>
          </section>

          <section class="card" style={{ gap: 4 }}>
            <h2 style={{ marginBottom: 8 }}>{t('Peringatan aktif', 'Active warnings')}</h2>
            {pond.findings.length === 0 && <p class="ink2">{t('Tidak ada peringatan.', 'No warnings.')}</p>}
            {pond.findings.map((f) => (
              <div key={f.id} class="stack-xs" style={{ padding: '12px 0', borderBottom: '1px solid var(--line)' }}>
                <div class="row between top">
                  <span class="grow">{f.title}</span>
                  <span class={`word ${toneOf(f.level)}`}>
                    <Shape tone={toneOf(f.level)} />
                    {f.level === 'critical' ? t('Bahaya', 'Danger') : f.level === 'warning' ? t('Perhatian', 'Caution') : t('Catatan', 'Note')}
                  </span>
                </div>
                <span class="meta">
                  {t('Sumber', 'Source')}: {plainSource(f.source)}
                </span>
              </div>
            ))}
          </section>

          <section class="card">
            <h2>{t('Profil kolam', 'Pond profile')}</h2>
            <Nicknames pond={pond} role={role} onSaved={(p) => setData({ ...data, pond: p })} />
            {stage && (
              <div class="stack-xs">
                <span class="strong">
                  {t(`Pakan minggu ke-${pond.program!.week}`, `Week ${pond.program!.week} feed`)}: {stage.name}
                </span>
                <span class="ink2">
                  {stage.feed}. {t('Panduan umum fase ini, bukan resep: sesuaikan dengan nafsu makan sidat.', "General guidance for this stage, not a recipe: adjust to the eels' appetite.")}
                </span>
              </div>
            )}
            <p class="ink2">
              {[
                pond.setting && settingLabel[pond.setting] + (pond.setting === 'outdoor' && pond.shaded ? t(', berpeneduh', ', shaded') : ''),
                pond.aeration && t(`aerasi ${aerationLabel[pond.aeration].toLowerCase()}`, `aeration: ${aerationLabel[pond.aeration].toLowerCase()}`),
                pond.depthCm && t(`kedalaman ${fmtNum(pond.depthCm)} cm`, `${fmtNum(pond.depthCm)} cm deep`),
                pond.areaM2 && `${fmtNum(pond.areaM2)} m²`,
                pond.program?.density != null &&
                  t(`kepadatan sekitar ${fmtNum(Math.round(pond.program.density))} ekor/m²`, `about ${fmtNum(Math.round(pond.program.density))} eels/m²`),
                pond.program && t(`total mati tercatat ${fmtNum(pond.program.totalDead)} ekor`, `${fmtNum(pond.program.totalDead)} dead recorded in total`),
              ]
                .filter(Boolean)
                .join(' · ') || t('Belum diisi.', 'Not filled in yet.')}
            </p>
          </section>
        </>
      )}

      <ClosedCases list={cases.list.filter((c) => c.status === 'closed')} />

      <DeviceCard pond={pond} logs={logs} ponds={ponds} role={role} go={go} onChanged={onChanged} />

      <ActionBar>
        <button class="btn primary" onClick={() => go({ name: 'record-pond', pondId: pond.id })}>
          <Icon name="pencil" /> {t('Catat kondisi sekarang', 'Record conditions now')}
        </button>
      </ActionBar>
    </div>
  );
}
