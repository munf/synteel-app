import { useEffect, useState } from 'preact/hooks';
import { api, type HistoryLog, type Limits, type LogData, type LogSource, type PondSummary, type ReadingKey, type Role } from '../api.ts';
import type { Go } from '../app.tsx';
import { aerationCheckLabel, behaviorLabel, colorLabel, fmtNum, leftoverLabel, phaseLabel, readingLabel, smellLabel, summarizeLog } from '../labels.ts';
import { Icon, roleLabel, Shape, type IconName, type Tone } from '../ui.tsx';
import { isEn, LOCALE, t } from '../i18n.ts';
import './history.css';

const TZ = 'Asia/Jakarta';
const DAY = 86400_000;
const clock = (t: number) => new Date(t).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', timeZone: TZ });
const dayKey = (t: number) => new Date(t).toLocaleDateString('en-CA', { timeZone: TZ });
/** "Rabu 28 Oktober": full day and month names, no abbreviations. */
const shortDate = (t: number, _weekday: 'long' | 'short' = 'long') =>
  isEn
    ? new Date(t).toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ })
    : new Date(t).toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ }).replace(',', '');

const SRC: Record<LogSource, { short: string; long: string; icon: IconName; ai: boolean }> = {
  voice: { short: t('Suara', 'Voice'), long: t('Suara, dibaca AI lalu dicek', 'Voice, read by the AI then checked'), icon: 'mic', ai: true },
  photo: { short: t('Foto', 'Photo'), long: t('Foto alat ukur, dibaca AI lalu dicek', 'Photo of a meter, read by the AI then checked'), icon: 'camera', ai: true },
  video: { short: 'Video', long: t('Video harian, dibaca AI lalu dicek', 'Daily video, read by the AI then checked'), icon: 'video', ai: true },
  manual: { short: t('Ketik', 'Typed'), long: t('Diketik manual', 'Typed in'), icon: 'pencil', ai: false },
};

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const unitOf = (k: ReadingKey) => (k === 'temperature' ? '°C' : readingLabel[k].unit);

/** "Suhu 29,8 °C · pH 7,33 · TDS 145": the line under each record. */
function valuesLine(d: LogData) {
  const r = Object.entries(d.readings ?? {}) as [ReadingKey, number][];
  if (r.length === 0) return summarizeLog(d) || t('Cek tanpa angka', 'Check without numbers');
  return r.map(([k, v]) => `${readingLabel[k].name} ${fmtNum(v)}${k === 'temperature' ? ' °C' : ''}`).join(' · ');
}

/** Status of a reading against the pond's limits: what the rules would say about this record. */
function readingTone(v: number, l: Limits | undefined): Tone | null {
  if (!l) return null;
  if ((l.critical?.below !== undefined && v < l.critical.below) || (l.critical?.above !== undefined && v > l.critical.above)) return 'bad';
  if ((l.warning?.below !== undefined && v < l.warning.below) || (l.warning?.above !== undefined && v > l.warning.above)) return 'warn';
  return null;
}

// Perhatian → "agak …", Bahaya → "terlalu …" (FAKTA words).
const WORD = isEn
  ? {
      temperature: { warn: ['Temperature a bit cold', 'Temperature a bit hot'], bad: ['Temperature too cold', 'Temperature too hot'] },
      ph: { warn: ['pH a bit low', 'pH a bit high'], bad: ['pH too low', 'pH too high'] },
      tds: { warn: ['TDS a bit low', 'TDS a bit high'], bad: ['TDS too low', 'TDS too high'] },
    }
  : {
      temperature: { warn: ['Suhu agak dingin', 'Suhu agak panas'], bad: ['Suhu terlalu dingin', 'Suhu terlalu panas'] },
      ph: { warn: ['pH agak rendah', 'pH agak tinggi'], bad: ['pH terlalu rendah', 'pH terlalu tinggi'] },
      tds: { warn: ['TDS agak rendah', 'TDS agak tinggi'], bad: ['TDS terlalu rendah', 'TDS terlalu tinggi'] },
    };

/** Shape + word flags for one record, worst first. */
function flags(d: LogData, pond: PondSummary | undefined): { tone: Tone; word: string }[] {
  const out: { tone: Tone; word: string }[] = [];
  const b = d.behavior ?? [];
  if (b.includes('surfacing')) out.push({ tone: 'bad', word: t('Sidat naik ke permukaan', 'Eels rising to the surface') });
  if (b.includes('gathering_inlet')) out.push({ tone: 'bad', word: t('Sidat kumpul di air masuk', 'Eels gathering at the inlet') });
  if (d.aeration === 'off') out.push({ tone: 'bad', word: t('Aerator mati', 'Aerator off') });
  for (const k of ['temperature', 'ph', 'tds'] as const) {
    const v = d.readings?.[k];
    if (v === undefined) continue;
    const l = pond?.limits[k];
    const tone = readingTone(v, l);
    if (!tone) continue;
    const low = v < (l?.target?.min ?? l?.warning?.below ?? -Infinity);
    out.push({ tone, word: WORD[k][tone === 'bad' ? 'bad' : 'warn'][low ? 0 : 1] });
  }
  if (d.mortality) out.push({ tone: 'warn', word: t(`${d.mortality} ekor mati`, `${d.mortality} dead`) });
  return out.sort((a, b) => (a.tone === 'bad' ? 0 : 1) - (b.tone === 'bad' ? 0 : 1));
}

/**
 * A data-quality hint, not a status: a temperature far from the pond's other readings that day
 * was probably measured in another pond.
 */
function suspectNote(l: HistoryLog, all: HistoryLog[], pondName: string) {
  const v = l.data.readings?.temperature;
  if (v === undefined) return null;
  const day = dayKey(Date.parse(l.loggedAt));
  const rest = all.filter((o) => o.id !== l.id && o.data.readings?.temperature !== undefined && dayKey(Date.parse(o.loggedAt)) === day).map((o) => o.data.readings!.temperature!);
  if (rest.length === 0) return null;
  const sorted = [...rest].sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)];
  const diff = v - mid;
  if (Math.abs(diff) < 2) return null;
  const gap = fmtNum(Math.round(Math.abs(diff) * 10) / 10);
  return t(
    `Suhu ${gap} °C lebih ${diff < 0 ? 'rendah' : 'tinggi'} dari catatan ${pondName} lain hari ini. Mungkin alat ukur dicelup di kolam lain.`,
    `Temperature ${gap} °C ${diff < 0 ? 'lower' : 'higher'} than the other ${pondName} records today. The meter may have been dipped in another pond.`,
  );
}

/** Label/value pairs for the open record. */
function fields(log: HistoryLog) {
  const d = log.data;
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(d.readings ?? {}) as [ReadingKey, number][]) out.push([readingLabel[k].name, `${fmtNum(v)}${unitOf(k) ? ` ${unitOf(k)}` : ''}`]);
  if (d.mortality !== undefined) out.push([t('Sidat mati', 'Dead eels'), t(`${d.mortality} ekor`, `${d.mortality} ${d.mortality === 1 ? 'eel' : 'eels'}`)]);
  if (d.feeding?.leftover) out.push([t('Sisa pakan', 'Leftover feed'), leftoverLabel[d.feeding.leftover]]);
  if (d.behavior?.length) out.push([t('Perilaku sidat', 'Eel behavior'), d.behavior.map((b, i) => (i ? lower(behaviorLabel[b]) : behaviorLabel[b])).join(', ')]);
  if (d.aeration) out.push(['Aerator', aerationCheckLabel[d.aeration]]);
  if (d.water?.color) out.push([t('Warna air', 'Water color'), colorLabel[d.water.color]]);
  if (d.water?.smell) out.push([t('Bau air', 'Water smell'), smellLabel[d.water.smell]]);
  if (d.waterChangePct) out.push([t('Ganti air', 'Water changed'), `${d.waterChangePct}%`]);
  if (d.note) out.push([t('Catatan', 'Note'), d.note]);
  out.push([t('Sumber', 'Source'), SRC[log.source].long]);
  return out;
}

/** "Diubah 17.40 oleh Petani Demo: suhu 28,9 → 29,8". */
function trace(e: HistoryLog['edits'][number], now: number) {
  const at = Date.parse(e.at);
  const when = dayKey(at) === dayKey(now) ? clock(at) : `${shortDate(at, 'short')} ${clock(at)}`;
  const moved = /^(dipindahkan|moved) /.exec(e.text);
  if (moved) {
    const rest = e.text.slice(moved[0].length);
    return t(`Dipindahkan ${when} oleh ${e.byName} ${rest}`, `Moved ${when} by ${e.byName} ${rest}`);
  }
  return t(`Diubah ${when} oleh ${e.byName}: ${e.text}`, `Changed ${when} by ${e.byName}: ${e.text}`);
}

// Numbers "Ubah angka" can change. Text fields stay as recorded.
type NumKey = ReadingKey | 'mortality';
const NUM_LABEL = (k: NumKey) => (k === 'mortality' ? t('Sidat mati', 'Dead eels') : readingLabel[k].name);
const NUM_UNIT = (k: NumKey) => (k === 'mortality' ? t('ekor', 'eels') : unitOf(k));
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
        if (!Number.isFinite(v) || v < 0) throw new Error(`${NUM_LABEL(k)}: ${t('angka tidak terbaca', 'not a readable number')}`);
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
    const at = Date.parse(l.loggedAt);
    const k = dayKey(at);
    let g = groups.find((x) => x.key === k);
    if (!g) {
      g = { key: k, label: k === today ? t('Hari ini', 'Today') : k === yesterday ? t('Kemarin', 'Yesterday') : shortDate(at), date: k === today || k === yesterday ? shortDate(at) : '', logs: [] };
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
    const parts = [p.latest.temperature && `${t('suhu', 'temperature')} ${fmtNum(p.latest.temperature.value)} °C`, p.latest.ph && `pH ${fmtNum(p.latest.ph.value)}`].filter(Boolean);
    return parts.length ? t(`Terakhir ${parts.join(' · ')}`, `Last: ${parts.join(' · ')}`) : pondSub(p);
  };
  const pondSub = (p: PondSummary) => (p.batch && p.program ? `${phaseLabel[p.batch.phase]} · ${t('minggu', 'week')} ${p.program.week}` : t('Belum ada batch', 'No batch yet'));

  /** The line about who may change this record, and until when. */
  const permLine = (l: HistoryLog) => {
    if (!l.canEdit) return l.lockReason ?? t('Terkunci.', 'Locked.');
    if (l.editableUntil) {
      const until = Date.parse(l.editableUntil);
      return t(
        `Bisa diubah atau dihapus sampai ${dayKey(until) === today ? 'hari ini' : 'besok'} ${clock(until)}.`,
        `Can be edited or deleted until ${dayKey(until) === today ? 'today' : 'tomorrow'} ${clock(until)}.`,
      );
    }
    const fresh = now - Date.parse(l.loggedAt) < DAY;
    if (!fresh) return t('Lewat 24 jam. Pemilik tambak tetap bisa mengubah.', 'Older than 24 hours. The farm owner can still edit it.');
    if (l.by && me && l.by.id !== me.id) return t(`Dicatat ${l.by.name}. Pemilik tambak bisa mengubah kapan saja.`, `Recorded by ${l.by.name}. The farm owner can edit it at any time.`);
    return t('Pemilik tambak bisa mengubah kapan saja.', 'The farm owner can edit it at any time.');
  };

  return (
    <div class="screen">
      <header class="row">
        <button class="icon-btn" aria-label={t(`Kembali ke ${pond?.name ?? 'kolam'}`, `Back to ${pond?.name ?? 'the pond'}`)} onClick={() => go({ name: 'pond', id: pondId })}>
          <Icon name="back" />
        </button>
        <div class="grow stack-xs" style={{ gap: 0 }}>
          <h1>{t('Riwayat catatan', 'Record history')}</h1>
          <span class="meta">{pond ? [pond.name, pond.batch && phaseLabel[pond.batch.phase], pond.program && `${t('minggu', 'week')} ${pond.program.week}`].filter(Boolean).join(' · ') : ''}</span>
        </div>
      </header>

      <div class="note info">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8h.01" />
        </svg>
        <span class="stack-xs">
          {me && role && (
            <span class="strong">
              {t(`Masuk sebagai ${me.name}, ${roleLabel[role].toLowerCase()}.`, `Signed in as ${me.name}, ${roleLabel[role].toLowerCase()}.`)}
            </span>
          )}
          <span>
            {t(
              'Catatan bisa diubah atau dihapus oleh yang mencatat sampai 24 jam. Pemilik tambak bisa kapan saja. Setiap perubahan tetap tercatat.',
              'Whoever made a record can edit or delete it for 24 hours. The farm owner can at any time. Every change stays on record.',
            )}
          </span>
        </span>
      </div>

      {error && <p class="error">{error}</p>}
      {!logs && !error && <p class="muted">{t('Memuat…', 'Loading…')}</p>}
      {logs && shown.length === 0 && (
        <div class="card">
          <p>{t('Belum ada catatan 14 hari terakhir.', 'No records in the last 14 days.')}</p>
          <button class="btn primary" onClick={() => go({ name: 'record-pond', pondId })}>
            <Icon name="pencil" size={20} /> {t('Catat sekarang', 'Record now')}
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
              const time = clock(Date.parse(l.loggedAt));
              const notice = notices[l.id];
              if (notice)
                return (
                  <div key={l.id} class="h-row">
                    <div class="h-notice" role="status">
                      <span class={`h-notice-icon${notice.kind === 'moved' ? ' ok' : ''}`}>
                        {notice.kind === 'moved' ? <Icon name="check" size={20} stroke={3} /> : <TrashIcon />}
                      </span>
                      <span class="grow stack-xs" style={{ gap: 0 }}>
                        <span class="strong">{notice.kind === 'moved' ? t(`Dipindahkan ke ${notice.to}`, `Moved to ${notice.to}`) : t('Catatan dihapus', 'Record deleted')}</span>
                        <span class="meta">
                          {t(`Catatan ${time}`, `Record ${time}`)}
                          {l.by ? t(` dari ${l.by.name}`, ` from ${l.by.name}`) : ''}
                        </span>
                      </span>
                      <button type="button" class="h-undo" disabled={busy} onClick={() => undo(notice)}>
                        {t('Batalkan', 'Undo')}
                      </button>
                    </div>
                  </div>
                );

              const isOpen = open === l.id;
              const src = SRC[l.source];
              const fl = flags(l.data, pond);
              const suspect = suspectNote(l, logs ?? [], pond?.name ?? t('kolam ini', 'this pond'));
              const numKeys: NumKey[] = [...(Object.keys(l.data.readings ?? {}) as ReadingKey[]), ...(l.data.mortality !== undefined ? (['mortality'] as const) : [])];
              const editKeys: NumKey[] = numKeys.length ? numKeys : ['temperature', 'ph', 'tds'];
              const q = query.trim().toLowerCase();
              const found = q ? others.filter((p) => p.name.toLowerCase().includes(q) || (p.nicknames ?? []).some((n) => n.toLowerCase().includes(q))) : likely(l);
              const picks = found.length || q ? found : others.slice(0, 2);
              return (
                <div key={l.id} class="h-row">
                  <button type="button" class="h-head" aria-expanded={isOpen} onClick={() => (isOpen ? close() : (close(), setOpen(l.id)))}>
                    <span class="row" style={{ gap: 8, width: '100%' }}>
                      <span class="strong num">{time}</span>
                      <span class={`h-src${src.ai ? ' ai' : ''}`}>
                        <Icon name={src.icon} size={16} />
                        {src.short}
                      </span>
                      <span class="h-who">· {l.by ? `${l.by.name}, ${roleLabel[l.by.role].toLowerCase()}` : t('sebelum ada akun', 'before accounts')}</span>
                      {!l.canEdit && (
                        <span class="h-ico" aria-label={t('terkunci', 'locked')}>
                          <LockIcon />
                        </span>
                      )}
                      <span class="h-ico" style={{ transform: isOpen ? 'rotate(180deg)' : 'none' }}>
                        <Icon name="down" size={20} />
                      </span>
                    </span>
                    <span class="num">{valuesLine(l.data)}</span>
                    {(fl.length > 0 || suspect) && (
                      <span class="h-flags">
                        {suspect && (
                          <span class="h-info">
                            <Icon name="info" size={16} />
                            {t('Mungkin salah kolam', 'Maybe the wrong pond')}
                          </span>
                        )}
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
                          {suspect && (
                            <p class="note info" style={{ padding: 12, borderRadius: 12 }}>
                              <Icon name="info" size={18} />
                              <span>{suspect}</span>
                            </p>
                          )}
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
                                {t('Ubah angka', 'Edit numbers')}
                              </button>
                              {others.length > 0 && (
                                <button type="button" class="h-act" onClick={() => setMode('pindah')}>
                                  <Icon name="arrow" size={20} />
                                  {t('Pindahkan ke kolam lain', 'Move to another pond')}
                                </button>
                              )}
                              <button type="button" class="h-act bad" onClick={() => setMode('hapus')}>
                                <TrashIcon />
                                {t('Hapus', 'Delete')}
                              </button>
                            </div>
                          )}
                        </>
                      )}

                      {mode === 'ubah' && (
                        <>
                          <span class="strong">{t(`Ubah angka catatan ${time}`, `Edit the numbers of the ${time} record`)}</span>
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
                          <span class="meta">{t('Angka lama tetap terlihat di riwayat perubahan.', 'The old numbers stay visible in the change history.')}</span>
                          {actionError && <p class="error">{actionError}</p>}
                          <button type="button" class="btn primary" disabled={busy} onClick={() => saveEdit(l, editKeys)}>
                            {busy ? t('Menyimpan…', 'Saving…') : t('Simpan perubahan', 'Save changes')}
                          </button>
                          <button type="button" class="btn secondary" style={{ minHeight: 48 }} onClick={() => (setMode('lihat'), setDraft({}), setActionError(''))}>
                            {t('Batal', 'Cancel')}
                          </button>
                        </>
                      )}

                      {mode === 'pindah' && (
                        <>
                          <span class="strong">{t('Pindahkan ke kolam mana?', 'Move to which pond?')}</span>
                          <label class="h-search">
                            <Icon name="search" size={20} />
                            <input aria-label={t('Cari kolam', 'Search ponds')} placeholder={t('Cari nama kolam', 'Search pond name')} value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
                          </label>
                          <span class="meta">{q
                              ? t(`${found.length} kolam cocok`, `${found.length} matching ${found.length === 1 ? 'pond' : 'ponds'}`)
                              : found.length
                                ? t('Angkanya mirip catatan terakhir kolam ini:', 'Numbers close to the last record of these ponds:')
                                : t('Kolam lain:', 'Other ponds:')}</span>
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
                            {q && found.length === 0 && <span class="label ink2 center" style={{ padding: '8px 0' }}>{t('Tidak ada kolam dengan nama itu.', 'No pond with that name.')}</span>}
                          </div>
                          {!q && others.length > picks.length && (
                            <span class="meta">
                              {t(
                                `Bukan ini? Ketik nama kolam, ada ${others.length - picks.length} kolam lain.`,
                                `Not these? Type a pond name; there are ${others.length - picks.length} other ponds.`,
                              )}
                            </span>
                          )}
                          {actionError && <p class="error">{actionError}</p>}
                          <button type="button" class="btn secondary" style={{ minHeight: 48 }} onClick={() => (setMode('lihat'), setQuery(''), setActionError(''))}>
                            {t('Batal', 'Cancel')}
                          </button>
                        </>
                      )}

                      {mode === 'hapus' && (
                        <>
                          <span class="strong">{t(`Hapus catatan ${time}?`, `Delete the ${time} record?`)}</span>
                          <span class="label ink2">
                            {t(
                              `Angkanya tidak dipakai lagi untuk grafik dan peringatan ${pond?.name ?? 'kolam ini'}. Masih bisa dibatalkan sesudahnya.`,
                              `Its numbers are no longer used for ${pond ? `${pond.name}'s` : 'this pond’s'} charts and warnings. You can still undo it afterwards.`,
                            )}
                          </span>
                          {actionError && <p class="error">{actionError}</p>}
                          <div class="grid2" style={{ gap: 8 }}>
                            <button type="button" class="btn secondary" style={{ minHeight: 48 }} onClick={() => (setMode('lihat'), setActionError(''))}>
                              {t('Batal', 'Cancel')}
                            </button>
                            <button type="button" class="btn danger" style={{ minHeight: 48 }} disabled={busy} onClick={() => remove(l)}>
                              {t('Ya, hapus', 'Yes, delete')}
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
