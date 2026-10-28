import { useEffect, useRef, useState } from 'preact/hooks';
import { api, ApiError, type AutoFix, type LogData, type PondSummary, type ReadingField, type RoundDraft, type RoundIssue, type RoundResult } from '../api.ts';
import type { Go } from '../app.tsx';
import { startRecording, voiceToWav } from '../capture/media.ts';
import { fmtAgo, fmtClock, fmtNum, summarizeLog } from '../labels.ts';
import { clips, fmtLen, readClip, waitReason, type Clip, type RoundItem } from '../queue.ts';
import { Icon, kindLabel, StatusPill, Stepper } from '../ui.tsx';
import { sendRound, type Progress } from '../upload.ts';
import { Glyph, isDenied, isSlow, parseNum, UploadCard, useTick, type GlyphName } from './record-pond.tsx';
import './record.css';

const FIELD: Record<ReadingField, { label: string; unit: string; example: string }> = {
  temperature: { label: 'Suhu', unit: '°C', example: '28,5' },
  ph: { label: 'pH', unit: '', example: '7,4' },
  tds: { label: 'TDS', unit: 'ppm', example: '150' },
};
/** "29 °C", "pH 7,4" as spoken back to the farmer. */
const said = (f: ReadingField, v: number) => (f === 'ph' ? `pH ${fmtNum(v)}` : `${FIELD[f].label} ${fmtNum(v)} ${FIELD[f].unit}`);
const withUnit = (f: ReadingField, v: number) => `${fmtNum(v)}${FIELD[f].unit ? ` ${FIELD[f].unit}` : ''}`;
const fmt1 = (n: number) => n.toLocaleString('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 2 });

/** "27,0 °C · pH 7,4 (dari 74) · 2 mati" */
function vals(data: LogData, autoFixed: AutoFix[] = []) {
  const r = data.readings ?? {};
  const from = (f: ReadingField) => {
    const a = autoFixed.find((x) => x.field === f);
    return a ? ` (dari ${a.heard})` : '';
  };
  const parts: string[] = [];
  if (r.temperature !== undefined) parts.push(`${fmt1(r.temperature)} °C${from('temperature')}`);
  if (r.ph !== undefined) parts.push(`pH ${fmt1(r.ph)}${from('ph')}`);
  if (r.tds !== undefined) parts.push(`TDS ${fmtNum(r.tds)} ppm${from('tds')}`);
  const rest = summarizeLog({ ...data, readings: undefined });
  if (rest) parts.push(rest);
  return parts.join(' · ') || 'Tanpa angka';
}

const setReading = (data: LogData, f: ReadingField, v: number): LogData => ({ ...data, readings: { ...data.readings, [f]: v } });

function itemOf(d: RoundDraft, key: string): RoundItem {
  return {
    key,
    pondId: d.pondId,
    heardName: d.heardName,
    suggestions: d.suggestions,
    quote: d.quote,
    data: d.data,
    autoFixed: d.autoFixed,
    issues: d.issues,
    fixed: d.issues.map(() => false),
    review: d.pondId === null || d.issues.length > 0,
    picked: false,
    remember: 'ask',
    saved: false,
  };
}

function itemsOf(r: RoundResult): RoundItem[] {
  const items = r.drafts.map((d, i) => itemOf(d, `d${i}`));
  // Numbers said before any pond name: the farmer says which pond they belong to.
  if (r.loose) items.push(itemOf({ pondId: null, heardName: '', suggestions: [], data: r.loose.data, issues: [], autoFixed: [], quote: r.loose.quote }, 'loose'));
  return items;
}

const isDone = (it: RoundItem) => it.pondId !== null && it.fixed.every(Boolean);

export function Round({ ponds, queued, onSaved, go }: { ponds: PondSummary[]; queued?: string; onSaved: () => void; go: Go }) {
  const [clip, setClip] = useState<Clip | null | undefined>(undefined);
  const [items, setItems] = useState<RoundItem[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [alerts, setAlerts] = useState<PondSummary[]>([]);
  const [more, setMore] = useState(false);
  const [playing, setPlaying] = useState(false);
  const player = useRef<HTMLAudioElement | null>(null);
  useTick(reading);

  const toItems = (c: Clip) => {
    setClip(c);
    if (c.status === 'ready' && c.result) setItems(c.items ?? itemsOf(c.result));
  };

  async function read(c: Clip) {
    setReading(true);
    setProgress(null);
    try {
      toItems(await readClip(c, setProgress));
    } finally {
      setReading(false);
      setProgress(null);
    }
  }

  useEffect(() => {
    if (!queued) return setClip(null);
    clips.get(queued).then(
      (c) => {
        if (!c) return setClip(null);
        if (c.status === 'ready' && c.result) toItems(c);
        else read(c);
      },
      () => setClip(null),
    );
    return () => player.current?.pause();
  }, [queued]);

  /** Every change is kept on the phone: a half-checked round reopens where it was. */
  const update = (next: RoundItem[]) => {
    setItems(next);
    if (clip) clips.put({ ...clip, items: next }).catch(() => {});
  };
  const patch = (key: string, p: Partial<RoundItem>) => update(items.map((it) => (it.key === key ? { ...it, ...p } : it)));

  function play() {
    if (!clip) return;
    if (playing) {
      player.current?.pause();
      return setPlaying(false);
    }
    const a = new Audio(URL.createObjectURL(clip.audio));
    a.onended = a.onpause = () => {
      setPlaying(false);
      URL.revokeObjectURL(a.src);
    };
    player.current = a;
    a.play().then(() => setPlaying(true), () => setPlaying(false));
  }

  async function save() {
    setSaving(true);
    setError('');
    let next = items;
    const flagged: PondSummary[] = [];
    try {
      for (const it of items.filter((x) => isDone(x) && !x.saved)) {
        const { pond } = await api.addLog(it.pondId!, it.data, 'voice');
        next = next.map((x) => (x.key === it.key ? { ...x, saved: true } : x));
        if (pond.level === 'warning' || pond.level === 'critical') flagged.push(pond);
      }
    } catch (err) {
      setError(err instanceof TypeError ? 'Belum ada sinyal. Catatan yang belum tersimpan tetap di sini, coba simpan lagi nanti.' : (err as Error).message);
    } finally {
      setSaving(false);
      setAlerts((a) => [...a.filter((p) => !flagged.some((f) => f.id === p.id)), ...flagged]);
      update(next);
      // Everything checked and saved: the recording is no longer needed on the phone.
      if (clip && next.every((x) => x.saved)) clips.remove(clip.id).catch(() => {});
      onSaved();
    }
  }

  const back = () => go({ name: 'record' });
  const discard = async () => {
    if (clip) await clips.remove(clip.id).catch(() => {});
    back();
  };
  const header = (
    <header class="row">
      <button type="button" class="icon-btn" aria-label="Kembali ke Catat" onClick={back}>
        <Icon name="back" />
      </button>
      <div class="grow" style={{ display: 'flex', flexDirection: 'column' }}>
        <h1>Cek hasil suara</h1>
        {clip && (
          <span class="meta num">
            Rekaman {fmtLen(clip.seconds)} · direkam {fmtClock(clip.createdAt)}
          </span>
        )}
      </div>
    </header>
  );

  if (clip === undefined || reading)
    return (
      <div class="screen">
        {header}
        {progress && isSlow(progress) ? (
          <UploadCard what="rekaman" p={progress} onOther={back} />
        ) : (
          <p class="working" role="status">
            AI memilah suara per kolam…
          </p>
        )}
      </div>
    );

  if (clip === null)
    return (
      <div class="screen">
        {header}
        <p class="ink2">Rekaman ini sudah tidak ada di HP. Mungkin sudah dicek dan disimpan.</p>
        <button class="btn primary" onClick={back}>
          Kembali ke Catat
        </button>
      </div>
    );

  if (clip.status === 'waiting' || clip.status === 'new')
    return (
      <div class="screen">
        {header}
        <Kept reason={clip.reason} go={go} onRetry={() => read(clip)} />
      </div>
    );

  if (clip.status === 'failed' || !clip.result)
    return (
      <div class="screen">
        {header}
        <section class="card rp-warn-card">
          <h2>Rekaman belum bisa dibaca</h2>
          <p class="ink2">{clip.error ?? 'Ada masalah saat membaca rekaman.'}</p>
          <button class="btn primary" onClick={() => read(clip)}>
            <Glyph name="retry" /> Coba lagi
          </button>
          <button class="btn secondary" onClick={discard}>
            Buang rekaman
          </button>
        </section>
      </div>
    );

  const result = clip.result;
  const mock = result.mode === 'mock' && (
    <p class="note warn">Mode contoh: hasil suara adalah contoh, bukan bacaan sungguhan.</p>
  );

  if (result.empty || items.length === 0)
    return (
      <div class="screen">
        {header}
        {mock}
        <section class="card" style={{ padding: '24px 20px' }}>
          <span class="icon-box rp-warn-box" style={{ width: 56, height: 56 }}>
            <Glyph name="wave" />
          </span>
          <div class="stack-xs">
            <h2>Suara belum terbaca</h2>
            <p class="ink2">AI belum menangkap nama kolam atau angka dari rekaman ini. Rekaman tetap&nbsp;disimpan.</p>
          </div>
          <button type="button" class="rp-play" onClick={play} aria-pressed={playing}>
            <Glyph name={playing ? 'pause' : 'play'} size={20} />
            <span class="grow">{playing ? `Memutar rekaman ${fmtLen(clip.seconds)}…` : `Putar rekaman ${fmtLen(clip.seconds)}`}</span>
          </button>
          <div class="stack rp-tips">
            <span class="label semi muted">Supaya terbaca:</span>
            {(
              [
                ['device', 'Dekatkan HP ke mulut'],
                ['chat', 'Sebut “Kolam” dulu, lalu angkanya'],
                ['fan', 'Jauhi aerator saat bicara'],
              ] as [GlyphName, string][]
            ).map(([icon, text]) => (
              <div class="row" key={text}>
                <span class="rp-tip-icon">
                  <Glyph name={icon} size={20} />
                </span>
                <span>{text}</span>
              </div>
            ))}
          </div>
        </section>
        <div class="stack-sm" style={{ gap: 12 }}>
          <button class="btn primary" onClick={discard}>
            <Icon name="mic" /> Rekam lagi
          </button>
          <button class="btn secondary" onClick={discard}>
            <Icon name="pencil" /> Ketik sendiri
          </button>
        </div>
      </div>
    );

  const clear = items.filter((it) => !it.review);
  const checks = items.filter((it) => it.review);
  const resolved = checks.filter(isDone);
  const pending = checks.length - resolved.length;
  const ready = items.filter((it) => isDone(it) && !it.saved).length;
  const savedN = items.filter((it) => it.saved).length;
  const allDone = pending === 0 && ready === 0;
  const total = items.length;
  const SHOW = 6;
  const clearShown = more ? clear : clear.slice(0, SHOW);
  const clearSaved = clear.length > 0 && clear.every((it) => it.saved);

  return (
    <div class="screen">
      {header}
      {mock}

      <section class="card" style={{ gap: 12 }}>
        <div class="row top between">
          <div class="stack-xs">
            <h2>AI menemukan {total}&nbsp;kolam</h2>
            <span class="label ink2 num">{pending ? `${clear.length + resolved.length} jelas · ${pending} perlu dicek` : `${total} jelas · semua sudah dicek`}</span>
          </div>
          <span class="pill blue">dari suara</span>
        </div>
        {savedN > 0 && (
          <div class="note ok" role="status" style={{ alignItems: 'center' }}>
            <Icon name="check" />
            <span class="num" style={{ fontSize: '1rem' }}>
              {allDone ? `Semua ${total} catatan tersimpan.` : `${savedN} catatan tersimpan.`}
            </span>
          </div>
        )}
        {ready > 0 && (
          <button type="button" class="btn primary num" onClick={save} disabled={saving}>
            {saving ? 'Menyimpan…' : savedN ? `Simpan ${ready} lagi` : `Simpan ${ready} yang jelas`}
          </button>
        )}
        {allDone && (
          <button type="button" class="btn primary" onClick={back}>
            Kembali ke Catat
          </button>
        )}
        {error && <p class="error">{error}</p>}
        {pending > 0 && <span class="label" style={{ color: '#6B4100' }}>{pending} yang perlu dicek belum disimpan, tetap di sini sampai dicek.</span>}
      </section>

      {alerts.map((p) => (
        <article class="card" key={p.id} style={{ gap: 12 }}>
          <div class="row between">
            <h2>
              {p.name}: {p.findings[0]?.title ?? 'perlu perhatian'}
            </h2>
            <StatusPill level={p.level} />
          </div>
          {p.findings[0] && <p class="ink2">{p.findings[0].detail}</p>}
          <button type="button" class="rp-link" onClick={() => go({ name: 'pond', id: p.id })}>
            Lihat {p.name}
          </button>
        </article>
      ))}

      {checks.length > 0 && (
        <section class="stack-sm" style={{ gap: 12 }}>
          <h2>Perlu dicek</h2>
          {checks.map((it) => (
            <CheckCard
              key={it.key}
              item={it}
              ponds={ponds}
              playing={playing}
              onPlay={play}
              onChange={(p) => patch(it.key, p)}
              onUndo={() => {
                const fresh = itemsOf(result).find((x) => x.key === it.key);
                if (fresh) patch(it.key, fresh);
              }}
              go={go}
            />
          ))}
        </section>
      )}

      {clear.length > 0 && (
        <section class="stack-sm">
          <div class="row between" style={{ alignItems: 'baseline' }}>
            <h2 class="num">{clear.length} jelas</h2>
            <span class={`label semi ${clearSaved ? 'rs-ok' : 'muted'}`}>{clearSaved ? 'Tersimpan' : 'Siap disimpan'}</span>
          </div>
          <div class="rs-clear" style={{ maxHeight: more ? 432 : undefined }}>
            {clearShown.map((it) => (
              <div class="rs-clear-row" key={it.key}>
                <span class="strong rs-clear-name">{ponds.find((p) => p.id === it.pondId)?.name ?? it.heardName}</span>
                <span class="grow label ink2 num">{vals(it.data, it.autoFixed)}</span>
                <span class="rs-ok" style={{ display: 'flex' }}>
                  <Icon name="check" size={20} stroke={2.4} />
                </span>
              </div>
            ))}
          </div>
          {clear.length > SHOW && (
            <button type="button" class="rp-text-btn blue" aria-expanded={more} onClick={() => setMore(!more)}>
              {more ? 'Tutup' : `Lihat ${clear.length - SHOW} lainnya`}
              <span style={{ display: 'flex', transform: more ? 'rotate(180deg)' : undefined }}>
                <Icon name="down" size={20} />
              </span>
            </button>
          )}
        </section>
      )}
    </div>
  );
}

/** Why a recording is still on the phone, and that it will be read later. */
function Kept({ reason, go, onRetry }: { reason?: Clip['reason']; go: Go; onRetry: () => void }) {
  const text =
    reason === 'quota'
      ? { title: 'Jatah baca AI hari ini habis', body: 'Rekaman tetap disimpan dan dibaca otomatis besok pagi, atau begitu jatah ditambah.' }
      : reason === 'ai'
        ? { title: 'AI sedang tidak tersedia', body: 'Rekaman disimpan di HP dan dibaca otomatis begitu AI tersedia lagi. Ketik sendiri tetap bisa.' }
        : { title: 'Belum ada sinyal', body: 'Rekaman disimpan di HP dan dibaca otomatis saat ada sinyal. Aplikasi boleh ditutup.' };
  return (
    <section class="card rp-warn-card">
      <div class="row">
        <span class="icon-box rp-warn-box">{reason === 'quota' ? <Icon name="clock" /> : <Icon name="nowifi" />}</span>
        <h2 class="grow">{text.title}</h2>
      </div>
      <p class="ink2">{text.body}</p>
      {reason === 'quota' && (
        <button type="button" class="rp-link" onClick={() => go({ name: 'quota' })}>
          Lihat dan tambah jatah AI <Icon name="next" size={16} />
        </button>
      )}
      <button type="button" class="btn primary" onClick={() => go({ name: 'record' })}>
        Kembali ke Catat
      </button>
      <button type="button" class="btn secondary" onClick={onRetry}>
        <Glyph name="retry" /> Coba baca sekarang
      </button>
    </section>
  );
}

const ICON_OF: Record<RoundIssue['kind'] | 'nopond', GlyphName> = { unclear: 'wave', implausible: 'alert', twice: 'copy', nopond: 'question' };

function CheckCard(props: {
  item: RoundItem;
  ponds: PondSummary[];
  playing: boolean;
  onPlay: () => void;
  onChange: (p: Partial<RoundItem>) => void;
  onUndo: () => void;
  go: Go;
}) {
  const { item: it, ponds, onChange } = props;
  const pond = ponds.find((p) => p.id === it.pondId);
  const unknown = it.pondId === null;
  const open = it.issues.map((iss, i) => ({ iss, i })).filter(({ i }) => !it.fixed[i]);
  const kind = unknown ? 'nopond' : (open[0]?.iss.kind ?? 'unclear');
  const nick = it.heardName && !/^kolam\s+\w{1,3}$/i.test(it.heardName) ? it.heardName : '';
  const name = pond ? pond.name : nick ? 'Kolam belum dikenal' : 'Kolam belum jelas';
  const kindText = unknown
    ? it.heardName
      ? `Terdengar “${it.heardName}”`
      : 'Angka disebut sebelum nama kolam'
    : kind === 'unclear'
      ? 'Bagian kurang jelas'
      : kind === 'implausible'
        ? 'Angka janggal'
        : 'Disebut dua kali';
  const fix = (i: number, data: LogData) => onChange({ data, fixed: it.fixed.map((f, j) => (j === i ? true : f)) });

  if (isDone(it))
    return (
      <article class="card rs-card done">
        <div class="row">
          <span class="rs-done-icon">
            <Icon name="check" size={20} stroke={2.6} />
          </span>
          <div class="grow" style={{ display: 'flex', flexDirection: 'column' }}>
            <span class="strong">{pond?.name}</span>
            <span class="label muted num">
              {vals(it.data)}
              {it.picked && it.heardName ? ` · dari “${it.heardName}”` : ''} · {it.saved ? 'tersimpan' : 'siap disimpan'}
            </span>
          </div>
          {!it.saved && (
            <button type="button" class="rs-small-btn" onClick={props.onUndo}>
              Ubah
            </button>
          )}
        </div>
        {it.picked && nick && it.remember === 'ask' && <Remember nick={nick} pond={pond!} onAnswer={(remember) => onChange({ remember })} />}
        {it.picked && nick && it.remember === 'yes' && (
          <span class="row label semi" style={{ gap: 8, color: 'var(--accent-ink)' }} role="status">
            <Icon name="check" size={18} stroke={2.6} />
            Diingat: “{nick}” = {pond?.name}
          </span>
        )}
      </article>
    );

  return (
    <article class="card rs-card">
      <div class="row">
        <span class="icon-box rp-warn-box rs-kind-icon">
          <Glyph name={ICON_OF[kind]} />
        </span>
        <div class="grow stack-xs" style={{ gap: 2 }}>
          <span class="h2">{name}</span>
          <span class="label semi" style={{ color: 'var(--warn)' }}>
            {kindText}
          </span>
        </div>
      </div>

      {it.autoFixed.map((a) => (
        <span class="row label rs-ok num" style={{ gap: 8 }} key={a.field}>
          <Icon name="check" size={18} stroke={2.6} />
          {FIELD[a.field].label} terdengar {a.heard}, otomatis dibaca {fmtNum(a.value)}
        </span>
      ))}

      {unknown && <PickPond item={it} ponds={ponds} onPick={(pondId) => onChange({ pondId, picked: true, remember: 'ask' })} />}

      {it.issues.map((iss, i) =>
        it.fixed[i] ? (
          iss.kind !== 'unclear' && open.length > 0 && (
            <span class="rs-fixed num" key={i}>
              <Icon name="check" size={18} stroke={2.6} />
              {iss.kind === 'implausible' || iss.kind === 'twice' ? said(iss.field, it.data.readings?.[iss.field] ?? 0) : ''}
            </span>
          )
        ) : iss.kind === 'implausible' ? (
          <Implausible key={i} issue={iss} onFix={(v) => fix(i, setReading(it.data, iss.field, v))} />
        ) : iss.kind === 'twice' ? (
          <Twice key={i} issue={iss} onFix={(v) => fix(i, setReading(it.data, iss.field, v))} />
        ) : (
          <Unclear key={i} issue={iss} item={it} playing={props.playing} onPlay={props.onPlay} onFix={(data) => fix(i, data)} />
        ),
      )}
    </article>
  );
}

function Remember({ nick, pond, onAnswer }: { nick: string; pond: PondSummary; onAnswer: (a: 'yes' | 'no') => void }) {
  const [error, setError] = useState('');
  const yes = () =>
    api.addNickname(pond.id, nick).then(
      () => onAnswer('yes'),
      (e) => setError((e as Error).message),
    );
  return (
    <div class="rs-offer">
      <div class="stack-xs" style={{ gap: 2 }}>
        <span class="strong" style={{ color: 'var(--navy)' }}>
          Ingat “{nick}” = {pond.name}?
        </span>
        <span class="label ink2">Lain kali langsung masuk ke {pond.name}.</span>
      </div>
      {error && <p class="error">{error}</p>}
      <div class="grid2" style={{ gap: 8 }}>
        <button type="button" class="btn primary rs-48" onClick={yes}>
          Ya, ingat
        </button>
        <button type="button" class="btn secondary rs-48" onClick={() => onAnswer('no')}>
          Tidak
        </button>
      </div>
    </div>
  );
}

/** Numbers without a pond, or a name the app does not know yet: the farmer picks the pond. */
function PickPond({ item, ponds, onPick }: { item: RoundItem; ponds: PondSummary[]; onPick: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const suggested = item.suggestions.map((id) => ponds.find((p) => p.id === id)).filter((p): p is PondSummary => !!p);
  const late = [...ponds].sort((a, b) => (a.lastLogAt ? Date.parse(a.lastLogAt) : 0) - (b.lastLogAt ? Date.parse(b.lastLogAt) : 0));
  const pool = needle
    ? ponds.filter((p) => p.name.toLowerCase().includes(needle) || p.nicknames?.some((n) => n.toLowerCase().includes(needle))).slice(0, 6)
    : suggested.length
      ? suggested.slice(0, 4)
      : late.slice(0, 3);
  const hint = (p: PondSummary) => [p.kind ? (kindLabel[p.kind] ?? p.kind) : null, p.lastLogAt ? `terakhir ${fmtAgo(Date.parse(p.lastLogAt))}` : 'belum pernah dicatat'].filter(Boolean).join(' · ');
  return (
    <>
      <p class="label ink2">Terdengar: “{item.quote}”</p>
      <button type="button" class="rs-pick" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span class="grow">Pilih kolamnya</span>
        <span style={{ display: 'flex', transform: open ? 'rotate(180deg)' : undefined }}>
          <Icon name="down" />
        </span>
      </button>
      {open && (
        <div class="stack-sm">
          <label class="rp-search">
            <Icon name="search" size={20} />
            <input aria-label="Cari kolam" placeholder="Cari nama kolam" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
          </label>
          <span class="label muted">{needle ? 'Hasil cari:' : suggested.length ? 'Paling mirip:' : 'Paling lama belum dicatat:'}</span>
          {pool.map((p) => (
            <button type="button" class="rs-option" key={p.id} onClick={() => onPick(p.id)}>
              <span class="grow" style={{ display: 'flex', flexDirection: 'column' }}>
                <span class="strong">{p.name}</span>
                <span class="label muted">{hint(p)}</span>
              </span>
              <Icon name="next" />
            </button>
          ))}
          {needle && pool.length === 0 && <span class="label ink2" style={{ padding: '8px 0' }}>Tidak ada kolam dengan nama itu.</span>}
        </div>
      )}
    </>
  );
}

/** A number that cannot be right: "Maksudnya 29 °C?" or type it. */
function Implausible({ issue, onFix }: { issue: Extract<RoundIssue, { kind: 'implausible' }>; onFix: (v: number) => void }) {
  const [typing, setTyping] = useState(issue.suggestion === null);
  return (
    <div class="stack-sm">
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <span class="strong num">
          {FIELD[issue.field].label} terdengar {issue.heard}
        </span>
        <span class="label muted">{issue.note}</span>
      </div>
      {issue.suggestion !== null && !typing && (
        <>
          <button type="button" class="btn primary num" onClick={() => onFix(issue.suggestion!)}>
            Maksudnya {withUnit(issue.field, issue.suggestion)}?
          </button>
          <button type="button" class="btn secondary rs-48 label" onClick={() => setTyping(true)}>
            Bukan, ketik sendiri
          </button>
        </>
      )}
      {typing && <TypeValue field={issue.field} onDone={onFix} />}
    </div>
  );
}

function TypeValue({ field, onDone }: { field: ReadingField; onDone: (v: number) => void }) {
  const [v, setV] = useState('');
  const n = parseNum(v);
  const ok = n !== undefined && !Number.isNaN(n);
  return (
    <div class="stack-sm">
      <label class="field">
        <span class="field-label">
          {FIELD[field].label}
          {FIELD[field].unit ? ` (${FIELD[field].unit})` : ''}
        </span>
        <input class="input" inputMode={field === 'tds' ? 'numeric' : 'decimal'} placeholder={`mis. ${FIELD[field].example}`} value={v} onInput={(e) => setV(e.currentTarget.value)} autoFocus />
      </label>
      <button type="button" class="btn primary" disabled={!ok} onClick={() => ok && onDone(n!)}>
        Pakai angka ini
      </button>
    </div>
  );
}

/** The same pond and field said twice with different numbers: the last one is preselected. */
function Twice({ issue, onFix }: { issue: Extract<RoundIssue, { kind: 'twice' }>; onFix: (v: number) => void }) {
  const [sel, setSel] = useState(issue.values.length - 1);
  const label = FIELD[issue.field].label;
  const last = issue.values.length - 1;
  return (
    <div class="stack-sm" style={{ gap: 12 }}>
      <span class="label ink2">
        {label} disebut {issue.values.length === 2 ? 'dua' : issue.values.length} kali, angkanya beda. Pakai yang mana?
      </span>
      <div role="radiogroup" aria-label={`Pilih ${label.toLowerCase()}`} class="stack-sm">
        {issue.values.map((v, i) => (
          <button type="button" role="radio" aria-checked={i === sel} class={`rs-radio${i === sel ? ' on' : ''}`} key={i} onClick={() => setSel(i)}>
            <span class="rs-radio-dot">{i === sel && <Icon name="check" size={14} stroke={3} />}</span>
            <span class="grow" style={{ display: 'flex', flexDirection: 'column' }}>
              <span class="strong num">{said(issue.field, v)}</span>
              <span class="label muted">{i === last ? 'disebut terakhir' : i === 0 ? 'disebut lebih dulu' : `disebut ke-${i + 1}`}</span>
            </span>
          </button>
        ))}
      </div>
      <button type="button" class="btn primary num" onClick={() => onFix(issue.values[sel])}>
        Pakai {label === 'pH' ? 'pH' : label.toLowerCase()} {withUnit(issue.field, issue.values[sel])}
      </button>
    </div>
  );
}

/** Part of what was said about this pond was not understood: listen, say it again, or type it. */
function Unclear(props: { issue: Extract<RoundIssue, { kind: 'unclear' }>; item: RoundItem; playing: boolean; onPlay: () => void; onFix: (data: LogData) => void }) {
  const { item } = props;
  const [rec, setRec] = useState<{ stop: () => Promise<Blob> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [typing, setTyping] = useState(false);
  const [error, setError] = useState('');

  async function again() {
    if (rec) return void rec.stop();
    setError('');
    try {
      const r = await startRecording(60);
      setRec({ stop: r.stop });
      const audio = await r.finished;
      setRec(null);
      if (!audio.size) return;
      setBusy(true);
      const { round } = await sendRound(await voiceToWav(audio));
      const d = round.drafts.find((x) => x.pondId === item.pondId) ?? round.drafts.find((x) => x.pondId === null) ?? round.drafts[0];
      if (!d || d.issues.some((x) => x.kind === 'unclear')) return setError('Masih kurang jelas. Coba lagi lebih dekat ke HP, atau ketik.');
      const twice = d.issues.find((x) => x.kind === 'twice');
      let data: LogData = { ...item.data, ...d.data, readings: { ...item.data.readings, ...d.data.readings } };
      if (twice?.kind === 'twice') data = setReading(data, twice.field, twice.values[twice.values.length - 1]);
      props.onFix(data);
    } catch (err) {
      setRec(null);
      const why = waitReason(err);
      setError(
        isDenied(err)
          ? 'Mikrofon belum diizinkan. Ketik saja dulu.'
          : why === 'quota'
            ? 'Jatah baca AI hari ini habis. Ketik saja dulu.'
            : why
              ? 'Belum bisa dibaca sekarang. Ketik saja dulu.'
              : err instanceof ApiError
                ? err.message
                : 'Mikrofon tidak bisa dipakai. Ketik saja dulu.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {props.issue.text && <p class="label ink2">Terdengar sebagian: “{props.issue.text}”</p>}
      <button type="button" class="rp-play" onClick={props.onPlay} aria-pressed={props.playing}>
        <Glyph name={props.playing ? 'pause' : 'play'} size={20} />
        <span class="grow">{props.playing ? 'Memutar rekaman…' : 'Putar rekaman'}</span>
      </button>
      {busy && (
        <p class="working" role="status">
          AI membaca suara…
        </p>
      )}
      {error && <p class="error">{error}</p>}
      {typing ? (
        <TypeAll data={item.data} onDone={props.onFix} />
      ) : rec ? (
        <button type="button" class="btn danger" onClick={again}>
          <span class="rs-rec-dot" />
          Merekam… ketuk kalau selesai
        </button>
      ) : (
        <div class="row" style={{ gap: 8 }}>
          <button type="button" class="btn primary grow" onClick={again} disabled={busy}>
            <Icon name="mic" /> Rekam ulang
          </button>
          <button type="button" class="btn secondary" onClick={() => setTyping(true)} disabled={busy}>
            Ketik
          </button>
        </div>
      )}
    </>
  );
}

/** Type the numbers for one pond of the round. */
function TypeAll({ data, onDone }: { data: LogData; onDone: (d: LogData) => void }) {
  const r = data.readings ?? {};
  const show = (v?: number) => (v === undefined ? '' : String(v).replace('.', ','));
  const [v, setV] = useState<Record<ReadingField, string>>({ temperature: show(r.temperature), ph: show(r.ph), tds: show(r.tds) });
  const [dead, setDead] = useState(data.mortality ?? 0);
  const nums = Object.fromEntries((Object.keys(v) as ReadingField[]).map((k) => [k, parseNum(v[k])]));
  const bad = Object.values(nums).some((n) => n !== undefined && Number.isNaN(n));
  const done = () => {
    const readings = Object.fromEntries(Object.entries(nums).filter(([, n]) => n !== undefined)) as LogData['readings'];
    onDone({ ...data, readings, mortality: dead || undefined });
  };
  return (
    <div class="stack-sm" style={{ gap: 12 }}>
      {(Object.keys(FIELD) as ReadingField[]).map((k) => (
        <label class="field" key={k}>
          <span class="field-label">
            {FIELD[k].label}
            {FIELD[k].unit ? ` (${FIELD[k].unit})` : ''}
          </span>
          <input class="input" inputMode={k === 'tds' ? 'numeric' : 'decimal'} placeholder={`mis. ${FIELD[k].example}`} value={v[k]} onInput={(e) => setV({ ...v, [k]: e.currentTarget.value })} />
        </label>
      ))}
      <div class="field">
        <span class="field-label">Sidat mati (ekor)</span>
        <Stepper value={dead} onChange={setDead} quick={[5, 10, 50]} />
      </div>
      {bad && <p class="error">Angka pengukuran tidak valid</p>}
      <button type="button" class="btn primary" disabled={bad} onClick={done}>
        Pakai angka ini
      </button>
    </div>
  );
}
