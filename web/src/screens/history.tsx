import { useEffect, useState } from 'preact/hooks';
import { api, type HistoryLog, type Limits, type LogData, type LogSource, type PondSummary, type ReadingKey, type Role } from '../api.ts';
import type { Go } from '../app.tsx';
import { aerationCheckLabel, behaviorLabel, colorLabel, fmtNum, leftoverLabel, phaseLabel, readingLabel, smellLabel, summarizeLog } from '../labels.ts';
import { Icon, roleLabel, Shape, type IconName, type Tone } from '../ui.tsx';
import './history.css';

const TZ = 'Asia/Jakarta';
const DAY = 86400_000;
const clock = (t: number) => new Date(t).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
const dayKey = (t: number) => new Date(t).toLocaleDateString('en-CA', { timeZone: TZ });
const shortDate = (t: number, weekday: 'long' | 'short' = 'long') =>
  new Date(t).toLocaleDateString('id-ID', { weekday, day: 'numeric', month: 'short', timeZone: TZ }).replace(',', '').replace('.', '');

const SRC: Record<LogSource, { short: string; long: string; icon: IconName; ai: boolean }> = {
  voice: { short: 'Suara', long: 'Suara, dibaca AI lalu dicek', icon: 'mic', ai: true },
  photo: { short: 'Foto', long: 'Foto alat ukur, dibaca AI lalu dicek', icon: 'camera', ai: true },
  video: { short: 'Video', long: 'Video harian, dibaca AI lalu dicek', icon: 'video', ai: true },
  manual: { short: 'Ketik', long: 'Diketik manual', icon: 'pencil', ai: false },
};

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const unitOf = (k: ReadingKey) => (k === 'temperature' ? '°C' : readingLabel[k].unit);

/** "Suhu 29,8 °C · pH 7,33 · TDS 145": the line under each record. */
function valuesLine(d: LogData) {
  const r = Object.entries(d.readings ?? {}) as [ReadingKey, number][];
  if (r.length === 0) return summarizeLog(d) || 'Cek tanpa angka';
  return r.map(([k, v]) => `${readingLabel[k].name} ${fmtNum(v)}${k === 'temperature' ? ' °C' : ''}`).join(' · ');
}

/** Status of a reading against the pond's limits: what the rules would say about this record. */
function readingTone(v: number, l: Limits | undefined): Tone | null {
  if (!l) return null;
  if ((l.critical?.below !== undefined && v < l.critical.below) || (l.critical?.above !== undefined && v > l.critical.above)) return 'bad';
  if ((l.warning?.below !== undefined && v < l.warning.below) || (l.warning?.above !== undefined && v > l.warning.above)) return 'warn';
  return null;
}

const WORD = { temperature: ['Suhu terlalu dingin', 'Suhu terlalu panas'], ph: ['pH terlalu rendah', 'pH terlalu tinggi'], tds: ['TDS terlalu rendah', 'TDS terlalu tinggi'] } as const;

/** Shape + word flags for one record, worst first. */
function flags(d: LogData, pond: PondSummary | undefined): { tone: Tone; word: string }[] {
  const out: { tone: Tone; word: string }[] = [];
  const b = d.behavior ?? [];
  if (b.includes('surfacing')) out.push({ tone: 'bad', word: 'Sidat naik ke permukaan' });
  if (b.includes('gathering_inlet')) out.push({ tone: 'bad', word: 'Sidat kumpul di air masuk' });
  if (d.aeration === 'off') out.push({ tone: 'bad', word: 'Aerator mati' });
  for (const k of ['temperature', 'ph', 'tds'] as const) {
    const v = d.readings?.[k];
    if (v === undefined) continue;
    const l = pond?.limits[k];
    const tone = readingTone(v, l);
    if (!tone) continue;
    const low = v < (l?.target?.min ?? l?.warning?.below ?? -Infinity);
    out.push({ tone, word: WORD[k][low ? 0 : 1] });
  }
  if (d.mortality) out.push({ tone: 'warn', word: `${d.mortality} ekor mati` });
  return out.sort((a, b) => (a.tone === 'bad' ? 0 : 1) - (b.tone === 'bad' ? 0 : 1));
}

/** Label/value pairs for the open record. */
function fields(log: HistoryLog) {
  const d = log.data;
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(d.readings ?? {}) as [ReadingKey, number][]) out.push([readingLabel[k].name, `${fmtNum(v)}${unitOf(k) ? ` ${unitOf(k)}` : ''}`]);
  if (d.mortality !== undefined) out.push(['Sidat mati', `${d.mortality} ekor`]);
  if (d.feeding?.leftover) out.push(['Sisa pakan', leftoverLabel[d.feeding.leftover]]);
  if (d.behavior?.length) out.push(['Perilaku sidat', d.behavior.map((b, i) => (i ? lower(behaviorLabel[b]) : behaviorLabel[b])).join(', ')]);
  if (d.aeration) out.push(['Aerator', aerationCheckLabel[d.aeration]]);
  if (d.water?.color) out.push(['Warna air', colorLabel[d.water.color]]);
  if (d.water?.smell) out.push(['Bau air', smellLabel[d.water.smell]]);
  if (d.waterChangePct) out.push(['Ganti air', `${d.waterChangePct}%`]);
  if (d.note) out.push(['Catatan', d.note]);
  out.push(['Sumber', SRC[log.source].long]);
  return out;
}

/** "Diubah 17.40 oleh Petani Demo: suhu 28,9 → 29,8". */
function trace(e: HistoryLog['edits'][number], now: number) {
  const t = Date.parse(e.at);
  const when = dayKey(t) === dayKey(now) ? clock(t) : `${shortDate(t, 'short')} ${clock(t)}`;
  return /^dipindahkan /.test(e.text) ? `Dipindahkan ${when} oleh ${e.byName} ${e.text.slice('dipindahkan '.length)}` : `Diubah ${when} oleh ${e.byName}: ${e.text}`;
}

// Numbers "Ubah angka" can change. Text fields stay as recorded.
type NumKey = ReadingKey | 'mortality';
const NUM_LABEL = (k: NumKey) => (k === 'mortality' ? 'Sidat mati' : readingLabel[k].name);
const NUM_UNIT = (k: NumKey) => (k === 'mortality' ? 'ekor' : unitOf(k));
const parseNum = (s: string) => Number(s.trim().replace(/\s/g, '').replace(',', '.'));

type Mode = 'lihat' | 'ubah' | 'pindah' | 'hapus';
type Notice = { kind: 'moved' | 'deleted'; log: HistoryLog; to?: string };

export function History({ ponds, pondId, role, onChanged, go }: { ponds: PondSummary[]; pondId: number; role: Role | null; onChanged: () => void; go: Go }) {
  const pond = ponds.find((p) => p.id === pondId);
  const [logs, setLogs] = useState<HistoryLog[] | null>(null);
  const [me, setMe] = useState<{ id: number; name: string } | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const [mode, setMode] = useState<Mode>('lihat');
  const [draft, setDraft] = useState<Partial<Record<NumKey, string>>>({});
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  // Records just moved or deleted stay in place as a line with "Batalkan".
  const [notices, setNotices] = useState<Record<number, Notice>>({});

  const load = () => api.history(pondId).then((r) => setLogs(r.logs), (e) => setError(e.message));
  useEffect(() => {
    load();
    api.me().then((m) => setMe(m.user), () => {});
  }, [pondId]);

  const close = () => {
    setOpen(null);
    setMode('lihat');
    setDraft({});
    setQuery('');
    setActionError('');
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setActionError('');
    try {
      await fn();
      onChanged();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = (log: HistoryLog, keys: NumKey[]) =>
    run(async () => {
      const data: LogData = { ...log.data, readings: { ...log.data.readings } };
      let changed = false;
      for (const k of keys) {
        const raw = draft[k];
        if (raw === undefined) continue;
        const old = k === 'mortality' ? log.data.mortality : log.data.readings?.[k];
        if (raw.trim() === '') {
          if (old === undefined) continue;
          if (k === 'mortality') delete data.mortality;
          else delete data.readings![k];
          changed = true;
          continue;
        }
        const v = parseNum(raw);
        if (!Number.isFinite(v) || v < 0) throw new Error(`${NUM_LABEL(k)}: angka tidak terbaca`);
        if (v === old) continue;
        if (k === 'mortality') data.mortality = Math.round(v);
        else data.readings![k] = v;
        changed = true;
      }
      if (data.readings && Object.keys(data.readings).length === 0) delete data.readings;
      if (changed) {
        const { log: saved } = await api.editLog(log.id, data);
        setLogs((ls) => ls && ls.map((l) => (l.id === log.id ? saved : l)));
      }
      setMode('lihat');
      setDraft({});
    });

  const move = (log: HistoryLog, to: PondSummary) =>
    run(async () => {
      await api.moveLog(log.id, to.id);
      setNotices((n) => ({ ...n, [log.id]: { kind: 'moved', log, to: to.name } }));
      close();
    });

  const remove = (log: HistoryLog) =>
    run(async () => {
      await api.deleteLog(log.id);
      setNotices((n) => ({ ...n, [log.id]: { kind: 'deleted', log } }));
      close();
    });

  const undo = (n: Notice) =>
    run(async () => {
      if (n.kind === 'moved') await api.moveLog(n.log.id, pondId);
      else await api.restoreLog(n.log.id);
      setNotices((all) => {
        const next = { ...all };
        delete next[n.log.id];
        return next;
      });
      await load();
    });

  const now = Date.now();
  const today = dayKey(now);
  const yesterday = dayKey(now - DAY);

  // Shown records: the loaded ones plus any just moved or deleted (kept as a notice line).
  const shown = [...(logs ?? []).filter((l) => !notices[l.id]), ...Object.values(notices).map((n) => n.log)].sort((a, b) => Date.parse(b.loggedAt) - Date.parse(a.loggedAt));
  const groups: { key: string; label: string; date: string; logs: HistoryLog[] }[] = [];
  for (const l of shown) {
    const t = Date.parse(l.loggedAt);
    const k = dayKey(t);
    let g = groups.find((x) => x.key === k);
    if (!g) {
      g = { key: k, label: k === today ? 'Hari ini' : k === yesterday ? 'Kemarin' : shortDate(t), date: k === today || k === yesterday ? shortDate(t) : '', logs: [] };
      groups.push(g);
    }
    g.logs.push(l);
  }

  const others = ponds.filter((p) => p.id !== pondId);

  /** Ponds whose last readings look most like this record: the likely right pond for a mix-up. */
  const likely = (log: HistoryLog) => {
    const r = log.data.readings ?? {};
    const scored = others
      .map((p) => {
        let d = 0;
        let n = 0;
        if (r.temperature !== undefined && p.latest.temperature) (d += Math.abs(p.latest.temperature.value - r.temperature) / 1), n++;
        if (r.ph !== undefined && p.latest.ph) (d += Math.abs(p.latest.ph.value - r.ph) / 0.3), n++;
        if (r.tds !== undefined && p.latest.tds) (d += Math.abs(p.latest.tds.value - r.tds) / 20), n++;
        return { p, score: n ? d / n : Infinity };
      })
      .filter((x) => Number.isFinite(x.score))
      .sort((a, b) => a.score - b.score);
    return scored.slice(0, 2).map((x) => x.p);
  };
  const lastHint = (p: PondSummary) => {
    const parts = [p.latest.temperature && `suhu ${fmtNum(p.latest.temperature.value)} °C`, p.latest.ph && `pH ${fmtNum(p.latest.ph.value)}`].filter(Boolean);
    return parts.length ? `Terakhir ${parts.join(' · ')}` : pondSub(p);
  };
  const pondSub = (p: PondSummary) => (p.batch && p.program ? `${phaseLabel[p.batch.phase]} · minggu ${p.program.week}` : 'Belum ada batch');

  /** The line about who may change this record, and until when. */
  const permLine = (l: HistoryLog) => {
    if (!l.canEdit) return l.lockReason ?? 'Terkunci.';
    if (l.editableUntil) {
      const t = Date.parse(l.editableUntil);
      return `Bisa diubah atau dihapus sampai ${dayKey(t) === today ? 'hari ini' : 'besok'} ${clock(t)}.`;
    }
    const fresh = now - Date.parse(l.loggedAt) < DAY;
    if (!fresh) return 'Lewat 24 jam. Pemilik tambak tetap bisa mengubah.';
    if (l.by && me && l.by.id !== me.id) return `Dicatat ${l.by.name}. Pemilik tambak bisa mengubah kapan saja.`;
    return 'Pemilik tambak bisa mengubah kapan saja.';
  };

  return (
    <div class="screen">
      <header class="row">
        <button class="icon-btn" aria-label={`Kembali ke ${pond?.name ?? 'kolam'}`} onClick={() => go({ name: 'pond', id: pondId })}>
          <Icon name="back" />
        </button>
        <div class="grow stack-xs" style={{ gap: 0 }}>
          <h1>Riwayat catatan</h1>
          <span class="meta">{pond ? [pond.name, pond.batch && phaseLabel[pond.batch.phase], pond.program && `minggu ${pond.program.week}`].filter(Boolean).join(' · ') : ''}</span>
        </div>
      </header>

      <div class="note info">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8h.01" />
        </svg>
        <span class="stack-xs">
          {me && role && (
            <span class="strong">
              Masuk sebagai {me.name}, {roleLabel[role].toLowerCase()}.
            </span>
          )}
          <span>Catatan bisa diubah atau dihapus oleh yang mencatat sampai 24 jam. Pemilik tambak bisa kapan saja. Setiap perubahan tetap tercatat.</span>
        </span>
      </div>

      {error && <p class="error">{error}</p>}
      {!logs && !error && <p class="muted">Memuat…</p>}
      {logs && shown.length === 0 && (
        <div class="card">
          <p>Belum ada catatan 14 hari terakhir.</p>
          <button class="btn primary" onClick={() => go({ name: 'record-pond', pondId })}>
            <Icon name="pencil" size={20} /> Catat sekarang
          </button>
        </div>
      )}

      {groups.map((g) => (
        <section key={g.key} class="stack-xs">
          <div class="row between" style={{ alignItems: 'baseline' }}>
            <h2>{g.label}</h2>
            {g.date && <span class="meta">{g.date}</span>}
          </div>
          <div class="h-rows">
            {g.logs.map((l) => {
              const t = clock(Date.parse(l.loggedAt));
              const notice = notices[l.id];
              if (notice)
                return (
                  <div key={l.id} class="h-row">
                    <div class="h-notice" role="status">
                      <span class={`h-notice-icon${notice.kind === 'moved' ? ' ok' : ''}`}>
                        {notice.kind === 'moved' ? <Icon name="check" size={20} stroke={3} /> : <TrashIcon />}
                      </span>
                      <span class="grow stack-xs" style={{ gap: 0 }}>
                        <span class="strong">{notice.kind === 'moved' ? `Dipindahkan ke ${notice.to}` : 'Catatan dihapus'}</span>
                        <span class="meta">
                          Catatan {t}
                          {l.by ? ` dari ${l.by.name}` : ''}
                        </span>
                      </span>
                      <button type="button" class="h-undo" disabled={busy} onClick={() => undo(notice)}>
                        Batalkan
                      </button>
                    </div>
                  </div>
                );

              const isOpen = open === l.id;
              const src = SRC[l.source];
              const fl = flags(l.data, pond);
              const numKeys: NumKey[] = [...(Object.keys(l.data.readings ?? {}) as ReadingKey[]), ...(l.data.mortality !== undefined ? (['mortality'] as const) : [])];
              const editKeys: NumKey[] = numKeys.length ? numKeys : ['temperature', 'ph', 'tds'];
              const q = query.trim().toLowerCase();
              const found = q ? others.filter((p) => p.name.toLowerCase().includes(q) || (p.nicknames ?? []).some((n) => n.toLowerCase().includes(q))) : likely(l);
              const picks = found.length || q ? found : others.slice(0, 2);
              return (
                <div key={l.id} class="h-row">
                  <button type="button" class="h-head" aria-expanded={isOpen} onClick={() => (isOpen ? close() : (close(), setOpen(l.id)))}>
                    <span class="row" style={{ gap: 8, width: '100%' }}>
                      <span class="strong num">{t}</span>
                      <span class={`h-src${src.ai ? ' ai' : ''}`}>
                        <Icon name={src.icon} size={16} />
                        {src.short}
                      </span>
                      <span class="h-who">· {l.by ? `${l.by.name}, ${roleLabel[l.by.role].toLowerCase()}` : 'sebelum ada akun'}</span>
                      {!l.canEdit && (
                        <span class="h-ico" aria-label="terkunci">
                          <LockIcon />
                        </span>
                      )}
                      <span class="h-ico" style={{ transform: isOpen ? 'rotate(180deg)' : 'none' }}>
                        <Icon name="down" size={20} />
                      </span>
                    </span>
                    <span class="num">{valuesLine(l.data)}</span>
                    {fl.length > 0 && (
                      <span class="h-flags">
                        {fl.map((f) => (
                          <span key={f.word} class={`word ${f.tone}`} style={{ gap: 6 }}>
                            <Shape tone={f.tone} />
                            {f.word}
                          </span>
                        ))}
                      </span>
                    )}
                    {l.edits.map((e, i) => (
                      <span key={i} class="h-trace">
                        <span style={{ display: 'inline-flex', marginTop: 2 }}>
                          <Icon name="clock" size={14} />
                        </span>
                        <span>{trace(e, now)}</span>
                      </span>
                    ))}
                  </button>

                  {isOpen && (
                    <div class="h-panel">
                      {mode === 'lihat' && (
                        <>
                          <div class="readings">
                            {fields(l).map(([k, v]) => (
                              <div key={k} class="reading">
                                <span class="h-k">{k}</span>
                                <span class="grow strong num">{v}</span>
                              </div>
                            ))}
                          </div>
                          <span class={`h-perm${l.canEdit ? '' : ' locked'}`}>
                            <span style={{ display: 'inline-flex', flex: 'none', marginTop: 1 }}>{l.canEdit ? <Icon name="clock" size={18} /> : <LockIcon size={18} />}</span>
                            <span>{permLine(l)}</span>
                          </span>
                          {l.canEdit && (
                            <div class="stack-sm">
                              <button type="button" class="h-act" onClick={() => setMode('ubah')}>
                                <Icon name="pencil" size={20} />
                                Ubah angka
                              </button>
                              {others.length > 0 && (
                                <button type="button" class="h-act" onClick={() => setMode('pindah')}>
                                  <Icon name="arrow" size={20} />
                                  Pindahkan ke kolam lain
                                </button>
                              )}
                              <button type="button" class="h-act bad" onClick={() => setMode('hapus')}>
                                <TrashIcon />
                                Hapus
                              </button>
                            </div>
                          )}
                        </>
                      )}

                      {mode === 'ubah' && (
                        <>
                          <span class="strong">Ubah angka catatan {t}</span>
                          <div class="stack-sm">
                            {editKeys.map((k) => {
                              const old = k === 'mortality' ? l.data.mortality : l.data.readings?.[k];
                              return (
                                <label key={k} class="h-input">
                                  <span class="h-k">{NUM_LABEL(k)}</span>
                                  <input
                                    inputMode="decimal"
                                    aria-label={NUM_LABEL(k)}
                                    value={draft[k] ?? (old === undefined ? '' : fmtNum(old))}
                                    onInput={(e) => setDraft({ ...draft, [k]: e.currentTarget.value })}
                                  />
                                  <span class="h-unit">{NUM_UNIT(k)}</span>
                                </label>
                              );
                            })}
                          </div>
                          <span class="meta">Angka lama tetap terlihat di riwayat perubahan.</span>
                          {actionError && <p class="error">{actionError}</p>}
                          <button type="button" class="btn primary" disabled={busy} onClick={() => saveEdit(l, editKeys)}>
                            {busy ? 'Menyimpan…' : 'Simpan perubahan'}
                          </button>
                          <button type="button" class="btn secondary" style={{ minHeight: 48 }} onClick={() => (setMode('lihat'), setDraft({}), setActionError(''))}>
                            Batal
                          </button>
                        </>
                      )}

                      {mode === 'pindah' && (
                        <>
                          <span class="strong">Pindahkan ke kolam mana?</span>
                          <label class="h-search">
                            <Icon name="search" size={20} />
                            <input aria-label="Cari kolam" placeholder="Cari nama kolam" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
                          </label>
                          <span class="meta">{q ? `${found.length} kolam cocok` : found.length ? 'Angkanya mirip catatan terakhir kolam ini:' : 'Kolam lain:'}</span>
                          <div class="stack-sm">
                            {picks.slice(0, 6).map((p) => (
                              <button key={p.id} type="button" class="h-pick" disabled={busy} onClick={() => move(l, p)}>
                                <span class="grow stack-xs" style={{ gap: 0 }}>
                                  <span class="strong">{p.name}</span>
                                  <span class="meta">{q ? pondSub(p) : lastHint(p)}</span>
                                </span>
                                <Icon name="next" size={20} />
                              </button>
                            ))}
                            {q && found.length === 0 && <span class="label ink2 center" style={{ padding: '8px 0' }}>Tidak ada kolam dengan nama itu.</span>}
                          </div>
                          {!q && others.length > picks.length && <span class="meta">Bukan ini? Ketik nama kolam, ada {others.length - picks.length} kolam lain.</span>}
                          {actionError && <p class="error">{actionError}</p>}
                          <button type="button" class="btn secondary" style={{ minHeight: 48 }} onClick={() => (setMode('lihat'), setQuery(''), setActionError(''))}>
                            Batal
                          </button>
                        </>
                      )}

                      {mode === 'hapus' && (
                        <>
                          <span class="strong">Hapus catatan {t}?</span>
                          <span class="label ink2">Angkanya tidak dipakai lagi untuk grafik dan peringatan {pond?.name ?? 'kolam ini'}. Masih bisa dibatalkan sesudahnya.</span>
                          {actionError && <p class="error">{actionError}</p>}
                          <div class="grid2" style={{ gap: 8 }}>
                            <button type="button" class="btn secondary" style={{ minHeight: 48 }} onClick={() => (setMode('lihat'), setActionError(''))}>
                              Batal
                            </button>
                            <button type="button" class="btn danger" style={{ minHeight: 48 }} disabled={busy} onClick={() => remove(l)}>
                              Ya, hapus
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

const LockIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z" />
  </svg>
);

const TrashIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
  </svg>
);
