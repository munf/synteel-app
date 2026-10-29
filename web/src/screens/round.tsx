import { useEffect, useRef, useState } from 'preact/hooks';
import { api, ApiError, type AutoFix, type LogData, type PondSummary, type ReadingField, type RoundDraft, type RoundIssue, type RoundResult } from '../api.ts';
import type { Go } from '../app.tsx';
import { startRecording, voiceToWav } from '../capture/media.ts';
import { fmtAgo, fmtClock, fmtNum, summarizeLog } from '../labels.ts';
import { clips, readClip, waitReason, type Clip, type RoundItem } from '../queue.ts';
import { Icon, kindLabel, StatusPill, Stepper } from '../ui.tsx';
import { sendRound, type Progress } from '../upload.ts';
import { fmtDur, Glyph, isDenied, isSlow, parseNum, UploadCard, useTick, type GlyphName } from './record-pond.tsx';
import { isEn, LOCALE, t } from '../i18n.ts';
import './record.css';

const FIELD: Record<ReadingField, { label: string; unit: string; example: string }> = {
  temperature: { label: t('Suhu', 'Temperature'), unit: '°C', example: t('28,5', '28.5') },
  ph: { label: 'pH', unit: '', example: t('7,4', '7.4') },
  tds: { label: 'TDS', unit: 'ppm', example: '150' },
};
/** "29 °C", "pH 7,4" as spoken back to the farmer. */
const said = (f: ReadingField, v: number) => (f === 'ph' ? `pH ${fmtNum(v)}` : `${FIELD[f].label} ${fmtNum(v)} ${FIELD[f].unit}`);
const withUnit = (f: ReadingField, v: number) => `${fmtNum(v)}${FIELD[f].unit ? ` ${FIELD[f].unit}` : ''}`;
const fmt1 = (n: number) => n.toLocaleString(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 2 });

/** "27,0 °C · pH 7,4 (dari 74) · 2 mati" */
function vals(data: LogData, autoFixed: AutoFix[] = []) {
  const r = data.readings ?? {};
  const from = (f: ReadingField) => {
    const a = autoFixed.find((x) => x.field === f);
    return a ? t(` (dari ${a.heard})`, ` (heard ${a.heard})`) : '';
  };
  const parts: string[] = [];
  if (r.temperature !== undefined) parts.push(`${fmt1(r.temperature)} °C${from('temperature')}`);
  if (r.ph !== undefined) parts.push(`pH ${fmt1(r.ph)}${from('ph')}`);
  if (r.tds !== undefined) parts.push(`TDS ${fmtNum(r.tds)} ppm${from('tds')}`);
  const rest = summarizeLog({ ...data, readings: undefined });
  if (rest) parts.push(rest);
  return parts.join(' · ') || t('Tanpa angka', 'No numbers');
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
      setError(
        err instanceof TypeError
          ? t('Belum ada sinyal. Catatan yang belum tersimpan tetap di sini, coba simpan lagi nanti.', 'No signal yet. Records not saved yet stay here; try saving again later.')
          : (err as Error).message,
      );
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
      <button type="button" class="icon-btn" aria-label={t('Kembali ke Catat', 'Back to Record')} onClick={back}>
        <Icon name="back" />
      </button>
      <div class="grow" style={{ display: 'flex', flexDirection: 'column' }}>
        <h1>{t('Cek hasil suara', 'Check voice results')}</h1>
        {clip && (
          <span class="meta num">
            {t(`Rekaman ${fmtDur(clip.seconds)} · direkam ${fmtClock(clip.createdAt)}`, `Recording, ${fmtDur(clip.seconds)} · recorded ${fmtClock(clip.createdAt)}`)}
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
          <UploadCard what={t('rekaman', 'recording')} p={progress} onOther={back} />
        ) : (
          <p class="working" role="status">
            {t('AI memilah suara per kolam…', 'AI is sorting the recording by pond…')}
          </p>
        )}
      </div>
    );

  if (clip === null)
    return (
      <div class="screen">
        {header}
        <p class="ink2">{t('Rekaman ini sudah tidak ada di HP. Mungkin sudah dicek dan disimpan.', 'This recording is no longer on the phone. It may already be checked and saved.')}</p>
        <button class="btn primary" onClick={back}>
          {t('Kembali ke Catat', 'Back to Record')}
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
          <h2>{t('Rekaman belum bisa dibaca', 'The recording could not be read yet')}</h2>
          <p class="ink2">{clip.error ?? t('Ada masalah saat membaca rekaman.', 'Something went wrong reading the recording.')}</p>
          <button class="btn primary" onClick={() => read(clip)}>
            <Glyph name="retry" /> {t('Coba lagi', 'Try again')}
          </button>
          <button class="btn secondary" onClick={discard}>
            {t('Buang rekaman', 'Discard the recording')}
          </button>
        </section>
      </div>
    );

  const result = clip.result;
  const mock = result.mode === 'mock' && (
    <p class="note info">
      <Icon name="info" />
      <span>{t('Mode contoh: hasil suara adalah contoh, bukan bacaan AI sungguhan.', 'Sample mode: voice results are samples, not real AI reads.')}</span>
    </p>
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
            <h2>{t('Suara belum terbaca', 'Could not read the recording')}</h2>
            <p class="ink2">
              {t('AI belum menangkap nama kolam atau angka dari rekaman ini. Rekaman tetap\u00a0disimpan.', 'The AI did not catch a pond name or number in this recording. The recording is still\u00a0kept.')}
            </p>
          </div>
          <button type="button" class="rp-play" onClick={play} aria-pressed={playing}>
            <Glyph name={playing ? 'pause' : 'play'} size={20} />
            <span class="grow">{playing
                ? t(`Memutar rekaman ${fmtDur(clip.seconds)}…`, `Playing the recording (${fmtDur(clip.seconds)})…`)
                : t(`Putar rekaman ${fmtDur(clip.seconds)}`, `Play the recording (${fmtDur(clip.seconds)})`)}</span>
          </button>
          <div class="stack rp-tips">
            <span class="label semi muted">{t('Supaya terbaca:', 'So it can be read:')}</span>
            {(
              [
                ['device', t('Dekatkan HP ke mulut', 'Hold the phone close to your mouth')],
                ['chat', t('Sebut “Kolam” dulu, lalu angkanya', 'Say the pond name first, then the numbers')],
                ['fan', t('Jauhi aerator saat bicara', 'Stay away from the aerator while you talk')],
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
            <Icon name="mic" /> {t('Rekam lagi', 'Record again')}
          </button>
          <button class="btn secondary" onClick={discard}>
            <Icon name="pencil" /> {t('Ketik sendiri', 'Type it in')}
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
            <h2>{t(`AI menemukan ${total}\u00a0kolam`, `AI found ${total}\u00a0${total === 1 ? 'pond' : 'ponds'}`)}</h2>
            <span class="label ink2 num">{pending
                ? t(`${clear.length + resolved.length} jelas · ${pending} perlu dicek`, `${clear.length + resolved.length} clear · ${pending} to check`)
                : t(`${total} jelas · semua sudah dicek`, `${total} clear · all checked`)}</span>
          </div>
          <span class="pill blue">{t('dari suara', 'from voice')}</span>
        </div>
        {savedN > 0 && (
          <div class="note ok" role="status" style={{ alignItems: 'center' }}>
            <Icon name="check" />
            <span class="num" style={{ fontSize: '1rem' }}>
              {allDone
                ? t(`Semua ${total} catatan tersimpan.`, `All ${total} records saved.`)
                : t(`${savedN} catatan tersimpan.`, `${savedN} record${savedN === 1 ? '' : 's'} saved.`)}
            </span>
          </div>
        )}
        {ready > 0 && (
          <button type="button" class="btn primary num" onClick={save} disabled={saving}>
            {saving
              ? t('Menyimpan…', 'Saving…')
              : savedN
                ? t(`Simpan ${ready} lagi`, `Save ${ready} more`)
                : t(`Simpan ${ready} yang jelas`, ready === 1 ? 'Save the clear one' : `Save the ${ready} clear ones`)}
          </button>
        )}
        {allDone && (
          <button type="button" class="btn primary" onClick={back}>
            {t('Kembali ke Catat', 'Back to Record')}
          </button>
        )}
        {error && <p class="error">{error}</p>}
        {pending > 0 && (
          <span class="label ink2">
            {t(
              `${pending} yang perlu dicek belum disimpan, tetap di sini sampai dicek.`,
              `${pending} to check ${pending === 1 ? 'is' : 'are'} not saved yet and ${pending === 1 ? 'stays' : 'stay'} here until checked.`,
            )}
          </span>
        )}
      </section>

      {alerts.map((p) => (
        <article class="card" key={p.id} style={{ gap: 12 }}>
          <div class="row between">
            <h2>
              {p.name}: {p.findings[0]?.title ?? t('perlu perhatian', 'needs attention')}
            </h2>
            <StatusPill level={p.level} />
          </div>
          {p.findings[0] && <p class="ink2">{p.findings[0].detail}</p>}
          <button type="button" class="rp-link" onClick={() => go({ name: 'pond', id: p.id })}>
            {t(`Lihat ${p.name}`, `View ${p.name}`)}
          </button>
        </article>
      ))}

      {checks.length > 0 && (
        <section class="stack-sm" style={{ gap: 12 }}>
          <h2>{t('Perlu dicek', 'To check')}</h2>
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
            <h2 class="num">{t(`${clear.length} jelas`, `${clear.length} clear`)}</h2>
            <span class={`label semi ${clearSaved ? 'rs-ok' : 'muted'}`}>{clearSaved ? t('Tersimpan', 'Saved') : t('Siap disimpan', 'Ready to save')}</span>
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
              {more ? t('Tutup', 'Close') : t(`Lihat ${clear.length - SHOW} lainnya`, `See ${clear.length - SHOW} more`)}
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
      ? {
          title: t('Jatah baca AI hari ini habis', "Today's AI reads are used up"),
          body: t('Rekaman tetap disimpan dan dibaca otomatis besok pagi, atau begitu jatah ditambah.', 'The recording is kept and read automatically tomorrow morning, or as soon as more reads are added.'),
        }
      : reason === 'ai'
        ? {
            title: t('AI sedang tidak tersedia', 'The AI is not available right now'),
            body: t('Rekaman disimpan di HP dan dibaca otomatis begitu AI tersedia lagi. Ketik sendiri tetap bisa.', 'The recording is kept on the phone and read automatically once the AI is back. You can still type it in.'),
          }
        : {
            title: t('Belum ada sinyal', 'No signal yet'),
            body: t('Rekaman disimpan di HP dan dibaca otomatis saat ada sinyal. Aplikasi boleh ditutup.', 'The recording is kept on the phone and read automatically when there is signal. You can close the app.'),
          };
  return (
    <section class="card rp-warn-card">
      <div class="row">
        <span class="icon-box rp-warn-box">{reason === 'quota' ? <Icon name="clock" /> : <Icon name="nowifi" />}</span>
        <h2 class="grow">{text.title}</h2>
      </div>
      <p class="ink2">{text.body}</p>
      {reason === 'quota' && (
        <button type="button" class="rp-link" onClick={() => go({ name: 'quota' })}>
          {t('Lihat dan tambah jatah AI', 'View and add daily AI reads')} <Icon name="next" size={16} />
        </button>
      )}
      <button type="button" class="btn primary" onClick={() => go({ name: 'record' })}>
        {t('Kembali ke Catat', 'Back to Record')}
      </button>
      <button type="button" class="btn secondary" onClick={onRetry}>
        <Glyph name="retry" /> {t('Coba baca sekarang', 'Try reading now')}
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
  const nick = it.heardName && !/^(kolam|pond)\s+\w{1,3}$/i.test(it.heardName) ? it.heardName : '';
  const name = pond ? pond.name : nick ? t('Kolam belum dikenal', 'Unknown pond') : t('Kolam belum jelas', 'Unclear pond');
  const kindText = unknown
    ? it.heardName
      ? t(`Terdengar “${it.heardName}”`, `Heard “${it.heardName}”`)
      : t('Angka disebut sebelum nama kolam', 'Numbers said before the pond name')
    : kind === 'unclear'
      ? t('Bagian kurang jelas', 'Part not clear')
      : kind === 'implausible'
        ? t('Angka janggal', 'Odd number')
        : t('Disebut dua kali', 'Said twice');
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
              {it.picked && it.heardName ? t(` · dari “${it.heardName}”`, ` · from “${it.heardName}”`) : ''} · {it.saved ? t('tersimpan', 'saved') : t('siap disimpan', 'ready to save')}
            </span>
          </div>
          {!it.saved && (
            <button type="button" class="rs-small-btn" onClick={props.onUndo}>
              {t('Ubah', 'Edit')}
            </button>
          )}
        </div>
        {it.picked && nick && it.remember === 'ask' && <Remember nick={nick} pond={pond!} onAnswer={(remember) => onChange({ remember })} />}
        {it.picked && nick && it.remember === 'yes' && (
          <span class="row label semi" style={{ gap: 8, color: 'var(--accent-ink)' }} role="status">
            <Icon name="check" size={18} stroke={2.6} />
            {t('Diingat', 'Remembered')}: “{nick}” = {pond?.name}
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
          <span class="label semi" style={{ color: 'var(--ink)' }}>
            {kindText}
          </span>
        </div>
      </div>

      {it.autoFixed.map((a) => (
        <span class="row label rs-ok num" style={{ gap: 8 }} key={a.field}>
          <Icon name="check" size={18} stroke={2.6} />
          {t(`${FIELD[a.field].label} terdengar ${a.heard}, otomatis dibaca ${fmtNum(a.value)}`, `${FIELD[a.field].label} heard as ${a.heard}, read as ${fmtNum(a.value)} automatically`)}
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
        <span class="strong" style={{ color: 'var(--navy-ink)' }}>
          {t('Ingat', 'Remember')} “{nick}” = {pond.name}?
        </span>
        <span class="label ink2">{t(`Lain kali langsung masuk ke ${pond.name}.`, `Next time it goes straight to ${pond.name}.`)}</span>
      </div>
      {error && <p class="error">{error}</p>}
      <div class="grid2" style={{ gap: 8 }}>
        <button type="button" class="btn primary rs-48" onClick={yes}>
          {t('Ya, ingat', 'Yes, remember')}
        </button>
        <button type="button" class="btn secondary rs-48" onClick={() => onAnswer('no')}>
          {t('Tidak', 'No')}
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
  const hint = (p: PondSummary) => [p.kind ? (kindLabel[p.kind] ?? p.kind) : null, p.lastLogAt ? t(`terakhir ${fmtAgo(Date.parse(p.lastLogAt))}`, `last ${fmtAgo(Date.parse(p.lastLogAt))}`) : t('belum pernah dicatat', 'never recorded')].filter(Boolean).join(' · ');
  return (
    <>
      <p class="label ink2">
        {t('Terdengar', 'Heard')}: “{item.quote}”
      </p>
      <button type="button" class="rs-pick" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span class="grow">{t('Pilih kolamnya', 'Pick the pond')}</span>
        <span style={{ display: 'flex', transform: open ? 'rotate(180deg)' : undefined }}>
          <Icon name="down" />
        </span>
      </button>
      {open && (
        <div class="stack-sm">
          <label class="rp-search">
            <Icon name="search" size={20} />
            <input aria-label={t('Cari kolam', 'Search ponds')} placeholder={t('Cari nama kolam', 'Search pond name')} value={q} onInput={(e) => setQ(e.currentTarget.value)} />
          </label>
          <span class="label muted">{needle ? t('Hasil cari:', 'Search results:') : suggested.length ? t('Paling mirip:', 'Closest match:') : t('Paling lama belum dicatat:', 'Longest without a record:')}</span>
          {pool.map((p) => (
            <button type="button" class="rs-option" key={p.id} onClick={() => onPick(p.id)}>
              <span class="grow" style={{ display: 'flex', flexDirection: 'column' }}>
                <span class="strong">{p.name}</span>
                <span class="label muted">{hint(p)}</span>
              </span>
              <Icon name="next" />
            </button>
          ))}
          {needle && pool.length === 0 && <span class="label ink2" style={{ padding: '8px 0' }}>
              {t('Tidak ada kolam dengan nama itu.', 'No pond with that name.')}
            </span>}
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
          {t(`${FIELD[issue.field].label} terdengar ${issue.heard}`, `${FIELD[issue.field].label} heard as ${issue.heard}`)}
        </span>
        <span class="label muted">{issue.note}</span>
      </div>
      {issue.suggestion !== null && !typing && (
        <>
          <button type="button" class="btn primary num" onClick={() => onFix(issue.suggestion!)}>
            {t(`Maksudnya ${withUnit(issue.field, issue.suggestion)}?`, `Did you mean ${withUnit(issue.field, issue.suggestion)}?`)}
          </button>
          <button type="button" class="btn secondary rs-48 label" onClick={() => setTyping(true)}>
            {t('Bukan, ketik sendiri', 'No, type it in')}
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
        <input class="input" inputMode={field === 'tds' ? 'numeric' : 'decimal'} placeholder={`${t('contoh', 'example')}: ${FIELD[field].example}`} value={v} onInput={(e) => setV(e.currentTarget.value)} autoFocus />
      </label>
      <button type="button" class="btn primary" disabled={!ok} onClick={() => ok && onDone(n!)}>
        {t('Pakai angka ini', 'Use this number')}
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
        {t(
          `${label} disebut ${issue.values.length === 2 ? 'dua' : issue.values.length} kali, angkanya beda. Pakai yang mana?`,
          `${label} was said ${issue.values.length === 2 ? 'twice' : `${issue.values.length} times`} with different numbers. Which one?`,
        )}
      </span>
      <div role="radiogroup" aria-label={t(`Pilih ${label.toLowerCase()}`, `Choose ${label}`)} class="stack-sm">
        {issue.values.map((v, i) => (
          <button type="button" role="radio" aria-checked={i === sel} class={`rs-radio${i === sel ? ' on' : ''}`} key={i} onClick={() => setSel(i)}>
            <span class="rs-radio-dot">{i === sel && <Icon name="check" size={14} stroke={3} />}</span>
            <span class="grow" style={{ display: 'flex', flexDirection: 'column' }}>
              <span class="strong num">{said(issue.field, v)}</span>
              <span class="label muted">{i === last ? t('disebut terakhir', 'said last') : i === 0 ? t('disebut lebih dulu', 'said first') : t(`disebut ke-${i + 1}`, `said as number ${i + 1}`)}</span>
            </span>
          </button>
        ))}
      </div>
      <button type="button" class="btn primary num" onClick={() => onFix(issue.values[sel])}>
        {isEn
          ? `Use ${issue.field === 'temperature' ? 'temperature' : label} ${withUnit(issue.field, issue.values[sel])}`
          : `Pakai ${label === 'pH' ? 'pH' : label.toLowerCase()} ${withUnit(issue.field, issue.values[sel])}`}
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
      if (!d || d.issues.some((x) => x.kind === 'unclear')) return setError(t('Masih kurang jelas. Coba lagi lebih dekat ke HP, atau ketik sendiri.', 'Still not clear. Try again closer to the phone, or type it in.'));
      const twice = d.issues.find((x) => x.kind === 'twice');
      let data: LogData = { ...item.data, ...d.data, readings: { ...item.data.readings, ...d.data.readings } };
      if (twice?.kind === 'twice') data = setReading(data, twice.field, twice.values[twice.values.length - 1]);
      props.onFix(data);
    } catch (err) {
      setRec(null);
      const why = waitReason(err);
      setError(
        isDenied(err)
          ? t('Mikrofon belum diizinkan. Ketik sendiri dulu.', 'The microphone is not allowed yet. Type it in for now.')
          : why === 'quota'
            ? t('Jatah baca AI hari ini habis. Ketik sendiri dulu.', "Today's AI reads are used up. Type it in for now.")
            : why
              ? t('Belum bisa dibaca sekarang. Ketik sendiri dulu.', 'It cannot be read right now. Type it in for now.')
              : err instanceof ApiError
                ? err.message
                : t('Mikrofon tidak bisa dipakai. Ketik sendiri dulu.', 'The microphone does not work. Type it in for now.'),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {props.issue.text && (
        <p class="label ink2">
          {t('Terdengar sebagian', 'Heard in part')}: “{props.issue.text}”
        </p>
      )}
      <button type="button" class="rp-play" onClick={props.onPlay} aria-pressed={props.playing}>
        <Glyph name={props.playing ? 'pause' : 'play'} size={20} />
        <span class="grow">{props.playing ? t('Memutar rekaman…', 'Playing the recording…') : t('Putar rekaman', 'Play the recording')}</span>
      </button>
      {busy && (
        <p class="working" role="status">
          {t('AI membaca suara…', 'AI is reading the voice recording…')}
        </p>
      )}
      {error && <p class="error">{error}</p>}
      {typing ? (
        <TypeAll data={item.data} onDone={props.onFix} />
      ) : rec ? (
        <button type="button" class="btn danger" onClick={again}>
          <span class="rs-rec-dot" />
          {t('Merekam… ketuk kalau selesai', 'Recording… tap when done')}
        </button>
      ) : (
        <div class="row" style={{ gap: 8 }}>
          <button type="button" class="btn primary grow" onClick={again} disabled={busy}>
            <Icon name="mic" /> {t('Rekam ulang', 'Record again')}
          </button>
          <button type="button" class="btn secondary" onClick={() => setTyping(true)} disabled={busy}>
            {t('Ketik sendiri', 'Type it in')}
          </button>
        </div>
      )}
    </>
  );
}

/** Type the numbers for one pond of the round. */
function TypeAll({ data, onDone }: { data: LogData; onDone: (d: LogData) => void }) {
  const r = data.readings ?? {};
  const show = (v?: number) => (v === undefined ? '' : isEn ? String(v) : String(v).replace('.', ','));
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
          <input class="input" inputMode={k === 'tds' ? 'numeric' : 'decimal'} placeholder={`${t('contoh', 'example')}: ${FIELD[k].example}`} value={v[k]} onInput={(e) => setV({ ...v, [k]: e.currentTarget.value })} />
        </label>
      ))}
      <div class="field">
        <span class="field-label">{t('Sidat mati (ekor)', 'Dead eels')}</span>
        <Stepper value={dead} onChange={setDead} quick={[5, 10, 50]} />
      </div>
      {bad && <p class="error">{t('Angka pengukuran tidak valid', 'A reading is not a valid number')}</p>}
      <button type="button" class="btn primary" disabled={bad} onClick={done}>
        {t('Pakai angka ini', 'Use this number')}
      </button>
    </div>
  );
}
