import { useEffect, useState } from 'preact/hooks';
import { api, ApiError, type Limits, type Log, type NowcastState, type PondProfile, type PondSummary, type Role } from '../api.ts';
import type { Go } from '../app.tsx';
import { aerationLabel, fmtAgo, fmtNum, fmtTime, phaseLabel, readingWord, settingLabel, sourceLabel, summarizeLog } from '../labels.ts';
import { usePrefs } from '../prefs.ts';
import { Icon, kindLabel, Shape, Soon, StatusPill, tankPath, TickBox, toneOf } from '../ui.tsx';
import './pond.css';

type Key = 'temperature' | 'ph' | 'tds';
const METRICS: { key: Key; label: string; unit: string; scale: [number, number] }[] = [
  { key: 'temperature', label: 'Suhu', unit: '°', scale: [22, 34] },
  { key: 'ph', label: 'pH', unit: '', scale: [6, 9] },
  { key: 'tds', label: 'TDS', unit: '', scale: [0, 300] },
];

const pct = (v: number, [lo, hi]: [number, number]) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
const targetText = (l: Limits | undefined, unit: string) => {
  const t = l?.target;
  if (!t) return '';
  if (t.min !== undefined && t.max !== undefined) return `target ${fmtNum(t.min)}–${fmtNum(t.max)}${unit}`;
  if (t.max !== undefined) return `batas ${fmtNum(t.max)}${unit}`;
  return `minimal ${fmtNum(t.min!)}${unit}`;
};

const READING_WORD: Record<string, string> = { temperature: 'suhu', ph: 'pH', tds: 'TDS', do: 'oksigen', tan: 'amonia', no2: 'nitrit', no3: 'nitrat' };

/** Source names in plain words: "(temperature)" → "(suhu)", "DO rendah" → "oksigen rendah". */
export const plainSource = (s: string) =>
  s.replace(/\(([a-z0-9_]+)\)/g, (m, id) => (READING_WORD[id] ? `(${READING_WORD[id]})` : m)).replace(/\bDO\b/g, 'oksigen');

/** Program text in plain words: NO₂ is "nitrit" on the farm. */
const plainWater = (s: string) => s.replace(/NO₂/g, 'nitrit').replace(/NO₃/g, 'nitrat').replace(/\bTAN\b/g, 'amonia');

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
      ? 'Belum cukup catatan untuk melihat arah. Ukur pagi dan sore.'
      : Math.abs(diff) < (key === 'tds' ? 5 : key === 'ph' ? 0.1 : 0.3)
        ? `${m.label} stabil dalam ${days.length} hari terakhir.`
        : `${m.label} ${diff > 0 ? 'naik' : 'turun'} ${fmtNum(Math.abs(Math.round(diff * 10) / 10))}${m.unit} dalam ${days.length} hari.`;

  return (
    <section class="card">
      <div class="segmented pills" role="tablist" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
        {METRICS.map((x) => (
          <button key={x.key} role="tab" aria-selected={x.key === key} class={x.key === key ? 'on' : ''} onClick={() => setKey(x.key)}>
            {x.key === key && <Icon name="check" size={16} stroke={3} />}
            {x.label}
          </button>
        ))}
      </div>
      <div class="stack-sm">
        <div class="row between">
          <span class="big">{latest ? `${fmtNum(latest.value)}${m.unit}` : '–'}</span>
          {word && (
            <span class={`pill ${word.tone}`} style={{ flex: 'none' }}>
              <Shape tone={word.tone} />
              {word.text}
            </span>
          )}
        </div>
        <span class="meta">
          {latest ? `diukur ${fmtAgo(Date.parse(latest.at))}` : 'belum diukur'}
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
          <span class="meta">Pita hijau = rentang target. Satu batang = ukuran terakhir tiap hari.</span>
        </div>
      )}
      <p>{sentence}</p>
    </section>
  );
}

/** "12 catatan sejak Jumat · terakhir Rab 17.15" for the row that opens the full history. */
function historyLine(logs: Log[]) {
  if (logs.length === 0) return 'Belum ada catatan 14 hari terakhir';
  const oldest = Date.parse(logs.at(-1)!.loggedAt);
  const since =
    Date.now() - oldest < 6 * 86400_000
      ? new Date(oldest).toLocaleDateString('id-ID', { weekday: 'long', timeZone: 'Asia/Jakarta' })
      : new Date(oldest).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', timeZone: 'Asia/Jakarta' });
  return `${logs.length} catatan sejak ${since} · terakhir ${fmtTime(logs[0].loggedAt)}`;
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
          <span class="meta">Nama panggilan</span>
          <span class="strong">{names.length ? names.join(', ') : 'Belum ada'}</span>
        </span>
        <button type="button" class="nick-btn" onClick={start}>
          <Icon name={owner || names.length === 0 ? 'pencil' : 'plus'} size={16} stroke={2.5} />
          {owner || names.length === 0 ? 'Ubah' : 'Tambah'}
        </button>
      </div>
    );

  return (
    <div class="stack">
      <label class="field">
        <span class="meta">{owner ? 'Nama panggilan (boleh kosong)' : 'Nama panggilan baru'}</span>
        <input value={draft} onInput={(e) => setDraft(e.currentTarget.value)} placeholder="mis. kolam pojok" />
        <span class="field-hint">{owner && names.length > 1 ? 'Pisahkan dengan koma. ' : ''}AI memakai ini saat mendengar suara.</span>
      </label>
      {error && <p class="error">{error}</p>}
      <div class="grid2" style={{ gap: 8 }}>
        <button type="button" class="btn primary" disabled={busy} onClick={save}>
          {busy ? 'Menyimpan…' : 'Simpan'}
        </button>
        <button type="button" class="btn secondary" onClick={() => setEditing(false)}>
          Batal
        </button>
      </div>
    </div>
  );
}

export function PondDetail({ id, nowcast, role, go }: { id: number; nowcast: NowcastState | null; role?: Role | null; go: Go }) {
  const prefs = usePrefs();
  const [data, setData] = useState<{ pond: PondSummary; logs: Log[] } | null>(null);
  const [error, setError] = useState('');
  const [tech, setTech] = useState(prefs.techOpen);
  const [done, setDone] = useState<Record<string, boolean>>({});

  useEffect(() => {
    api.pond(id).then(setData, (e) => setError(e.message));
  }, [id]);

  if (error)
    return (
      <div class="screen">
        <p class="error">{error}</p>
      </div>
    );
  if (!data)
    return (
      <div class="screen">
        <p class="muted">Memuat…</p>
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
      <section class="cover">
        <svg viewBox="0 0 350 200" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
          <g transform="translate(105 8) scale(2.5)">
            <path d={tankPath(pond.kind)} fill="#8DB6D9" stroke="#FFFFFF" stroke-width="2.6" />
          </g>
        </svg>
        <button class="icon-btn" aria-label="Kembali ke Beranda" onClick={() => go({ name: 'today' })}>
          <Icon name="back" />
        </button>
        <span class="cover-action stack-xs" style={{ alignItems: 'flex-end' }}>
          <span class="pill grey" style={{ background: '#fff', minHeight: 44 }}>
            <Icon name="camera" size={18} /> Foto kolam
          </span>
          <Soon />
        </span>
      </section>

      <header class="row top between">
        <div class="stack-xs">
          <h1>{pond.name}</h1>
          <span class="meta">
            {[pond.kind && (kindLabel[pond.kind] ?? pond.kind), pond.batch && phaseLabel[pond.batch.phase], pond.program && `minggu ${pond.program.week}`].filter(Boolean).join(' · ') || 'Belum ada batch'}
            {pond.program?.estimatedAlive != null && (
              <>
                <br />
                sekitar {pond.program.estimatedAlive.toLocaleString('id-ID')} ekor
              </>
            )}
          </span>
        </div>
        <StatusPill level={pond.level} />
      </header>

      <div class="segmented" role="tablist" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
        <button role="tab" aria-selected={!tech} class={!tech ? 'on' : ''} onClick={() => setTech(false)}>
          {!tech && <Icon name="check" size={16} stroke={3} />}Ringkas
        </button>
        <button role="tab" aria-selected={tech} class={tech ? 'on' : ''} onClick={() => setTech(true)}>
          {tech && <Icon name="check" size={16} stroke={3} />}Teknis
        </button>
      </div>

      {!tech &&
        (top ? (
          <section class="hero">
            <span class="label semi" style={{ color: 'var(--on-navy-2)' }}>
              Yang terjadi
            </span>
            <p class="h2" style={{ color: '#fff' }}>
              {top.title}. {top.detail}
            </p>
            {top.actions.length > 0 && (
              <>
                <span class="label" style={{ color: '#C9D4EA' }}>
                  Lakukan sekarang:
                </span>
                {top.actions.map((a) => (
                  <button
                    key={a}
                    role="checkbox"
                    aria-checked={!!done[a]}
                    onClick={() => setDone({ ...done, [a]: !done[a] })}
                    style={{ display: 'flex', gap: 12, alignItems: 'center', minHeight: 56, padding: '8px 12px', border: 0, borderRadius: 16, background: 'rgba(255,255,255,0.08)', color: '#fff', textAlign: 'left' }}
                  >
                    <TickBox on={!!done[a]} />
                    <span>{a}</span>
                  </button>
                ))}
              </>
            )}
          </section>
        ) : (
          <section class="card tint">
            <h2>Kolam tenang</h2>
            <p class="ink2">Tidak ada peringatan dari catatan terakhir.</p>
          </section>
        ))}

      {!tech && stage && (
        <section class="card" style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <span class="icon-box">
            <Icon name="bowl" />
          </span>
          <div class="stack-xs grow">
            <span class="strong">
              Minggu ke-{pond.program!.week}: {stage.name}
            </span>
            <span class="ink2">Pakan {stage.feed.toLowerCase()}. Air: {plainWater(stage.water).toLowerCase()}.</span>
          </div>
        </section>
      )}

      {tech && (
        <section class="card">
          <h2>Ukuran terakhir vs target</h2>
          {METRICS.map((m) => {
            const r = pond.latest[m.key];
            const l = pond.limits[m.key];
            const t = l?.target;
            const from = t?.min ?? m.scale[0];
            const to = t?.max ?? m.scale[1];
            return (
              <div class="stack-sm" key={m.key}>
                <div class="row between">
                  <span class="ink2">{m.label}</span>
                  <span class="strong num">{r ? `${fmtNum(r.value)}${m.unit}` : '–'}</span>
                </div>
                <span class="ruler">
                  <span class="target" style={{ left: `${pct(from, m.scale)}%`, width: `${pct(to, m.scale) - pct(from, m.scale)}%` }} />
                  {r && <span class="mark" style={{ left: `${pct(r.value, m.scale)}%` }} />}
                </span>
                <span class="meta">
                  {[
                    targetText(l, m.unit),
                    l?.warning?.below !== undefined && `perhatian di bawah ${fmtNum(l.warning.below)}`,
                    l?.critical?.below !== undefined && `bahaya di bawah ${fmtNum(l.critical.below)}`,
                    l?.warning?.above !== undefined && `perhatian di atas ${fmtNum(l.warning.above)}`,
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

      {!tech && (
        <button class="card history-row" onClick={() => go({ name: 'history', pondId: pond.id })}>
          <span class="icon-box">
            <Icon name="clock" />
          </span>
          <span class="grow stack-xs" style={{ gap: 2 }}>
            <span class="strong">Riwayat catatan</span>
            <span class="meta">{historyLine(logs)}</span>
          </span>
          <span style={{ color: 'var(--muted)', display: 'inline-flex' }}>
            <Icon name="next" size={20} />
          </span>
        </button>
      )}

      {!tech && (
        <div class="stack-sm">
          <button class="btn primary" onClick={() => go({ name: 'record', pondId: pond.id })}>
            <Icon name="mic" /> Catat kondisi sekarang
          </button>
          <button class="btn secondary" onClick={() => go({ name: 'problem', pondId: pond.id })}>
            <Icon name="alert" size={20} /> Lapor masalah di kolam ini
          </button>
        </div>
      )}

      {tech && (
        <>
          <section class="card">
            <div class="row">
              <span class="icon-box">
                <Icon name="thermo" />
              </span>
              <div class="stack-xs grow">
                <span class="strong">Perkiraan vs ukur</span>
                <span class="label ink2">
                  {fit.length >= 3
                    ? `${good} dari ${fit.length} ukuran suhu terakhir cocok (selisih 0,5° atau kurang).`
                    : 'Perkiraan sedang belajar: butuh beberapa ukuran suhu lagi.'}
                </span>
              </div>
            </div>
            {fit.length > 0 && (
              <svg viewBox="0 0 310 112" width="100%" role="img" aria-label={`Selisih perkiraan dan ukuran suhu, ${good} dari ${fit.length} di dalam zona cocok`}>
                <rect x="0" y="36" width="310" height="40" fill="#DDF1E7" />
                <line x1="0" y1="56" x2="310" y2="56" stroke="#6CC3A0" stroke-dasharray="4 4" />
                {fit.map((f, i) => {
                  const x = 20 + i * (270 / Math.max(1, fit.length - 1));
                  const y = Math.max(8, Math.min(104, 56 - f.error * 40));
                  const ok = Math.abs(f.error) <= 0.5;
                  return ok ? (
                    <circle key={f.t} cx={x} cy={y} r="7" fill="#13264A" stroke="#fff" stroke-width="2" />
                  ) : (
                    <rect key={f.t} x={x - 7} y={y - 7} width="14" height="14" fill="#E07A00" stroke="#fff" stroke-width="2" />
                  );
                })}
              </svg>
            )}
          </section>

          <section class="card" style={{ gap: 4 }}>
            <div class="row between" style={{ marginBottom: 8 }}>
              <h2>Riwayat catatan</h2>
              <span class="meta">mati 7 hari: {weekDead} ekor</span>
            </div>
            {logs.length === 0 && <p class="ink2">Belum ada catatan.</p>}
            {logs.slice(0, 12).map((l) => (
              <div key={l.id} class="stack-xs" style={{ padding: '12px 0', borderBottom: '1px solid var(--line)' }}>
                <div class="row between">
                  <span class="strong">{fmtTime(l.loggedAt)}</span>
                  <span class="label semi" style={{ color: l.source === 'manual' ? 'var(--ink-2)' : 'var(--accent-ink)' }}>
                    {sourceLabel[l.source]}
                  </span>
                </div>
                <span class="label ink2">{summarizeLog(l.data) || 'Cek: tidak ada catatan angka'}</span>
              </div>
            ))}
            <button class="link-row" style={{ marginTop: 8 }} onClick={() => go({ name: 'history', pondId: pond.id })}>
              <span>Ubah, pindahkan atau hapus catatan</span>
              <Icon name="next" size={20} />
            </button>
          </section>

          <section class="card" style={{ gap: 4 }}>
            <h2 style={{ marginBottom: 8 }}>Peringatan aktif</h2>
            {pond.findings.length === 0 && <p class="ink2">Tidak ada peringatan.</p>}
            {pond.findings.map((f) => (
              <div key={f.id} class="stack-xs" style={{ padding: '12px 0', borderBottom: '1px solid var(--line)' }}>
                <div class="row between top">
                  <span class="grow">{f.title}</span>
                  <span class={`word ${toneOf(f.level)}`}>
                    <Shape tone={toneOf(f.level)} />
                    {f.level === 'critical' ? 'Bahaya' : f.level === 'warning' ? 'Perhatian' : 'Catatan'}
                  </span>
                </div>
                <span class="meta">Sumber: {plainSource(f.source)}</span>
              </div>
            ))}
          </section>

          <section class="card">
            <h2>Profil kolam</h2>
            <Nicknames pond={pond} role={role} onSaved={(p) => setData({ ...data, pond: p })} />
            <p class="ink2">
              {[
                pond.setting && settingLabel[pond.setting] + (pond.setting === 'outdoor' && pond.shaded ? ', berpeneduh' : ''),
                pond.aeration && `aerasi ${aerationLabel[pond.aeration].toLowerCase()}`,
                pond.depthCm && `kedalaman ${fmtNum(pond.depthCm)} cm`,
                pond.areaM2 && `${fmtNum(pond.areaM2)} m²`,
                pond.program?.density != null && `kepadatan sekitar ${fmtNum(Math.round(pond.program.density))} ekor/m²`,
                pond.program && `total mati tercatat ${fmtNum(pond.program.totalDead)} ekor`,
              ]
                .filter(Boolean)
                .join(' · ') || 'Belum diisi.'}
            </p>
          </section>
        </>
      )}
    </div>
  );
}
