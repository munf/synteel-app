import { useEffect, useMemo, useState } from 'preact/hooks';
import { api, type Briefing, type FarmState, type Nowcast, type NowcastPoint, type NowcastState, type RiskFactor } from '../api.ts';
import type { Go } from '../app.tsx';
import { actionIcon, armAlarms, askNotifyPermission, canNotify, GLYPH, loadDone, notifyPermission, onDoneChange, saveDone, tonightChecks, type NightCheck } from '../alarms.ts';
import { NowcastChart } from '../chart.tsx';
import { fmtClock, fmtTemp, readingWord } from '../labels.ts';
import { usePrefs } from '../prefs.ts';
import { Icon, Shape, type Tone } from '../ui.tsx';
import { isEn, t } from '../i18n.ts';
import './watch.css';

const HOUR = 3600_000;
const rank = { ok: 0, warning: 1, critical: 2 } as const;
const worst = (nc: Nowcast) => Math.max(rank[nc.now.level], rank[nc.peak.level]);
const BAR = ['#3FB984', '#F0B323', '#F04438'];
// Mirrors the nowcast's own cut-offs (score ≥ 3 perhatian, ≥ 5 bahaya).
const DANGER_SCORE = 5;
const LEVEL_SHAPE = {
  ok: { d: 'M6 1a5 5 0 1 0 0 10A5 5 0 0 0 6 1z', fill: '#3FB984' },
  warning: { d: 'M1 1h10v10H1z', fill: '#F0B323' },
  critical: { d: 'M5.13 1.5a1 1 0 0 1 1.74 0l4.5 8a1 1 0 0 1-.87 1.5H1.5a1 1 0 0 1-.87-1.5z', fill: '#F04438' },
} as const;

/** A stroke icon from a path (the check and reason icons of the design). */
export function Glyph({ d, size = 22, stroke = 2 }: { d: string; size?: number; stroke?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
      <path d={d} />
    </svg>
  );
}

const LEVEL_WORD = { ok: t('Aman', 'Safe'), warning: t('Perhatian', 'Caution'), critical: t('Bahaya', 'Danger') };
const TONE: Record<keyof typeof LEVEL_WORD, Tone> = { ok: 'ok', warning: 'warn', critical: 'bad' };

/** "30,4 °C · Terlalu panas", or the pond's first warning. */
function pondDetail(p: FarmState['ponds'][number]) {
  const temp = p.latest.temperature;
  const st = p.status.temperature;
  if (temp && st && st !== 'ok') return `${fmtTemp(temp.value)} · ${readingWord('temperature', temp.value, st, p.limits.temperature).text}`;
  return p.findings.find((f) => f.level === 'critical' || f.level === 'warning')?.title ?? t('Risiko oksigen malam ini', 'Oxygen risk tonight');
}

const LevelShape = ({ level, size = 28 }: { level: keyof typeof LEVEL_SHAPE; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden="true">
    <path d={LEVEL_SHAPE[level].d} fill={LEVEL_SHAPE[level].fill} />
  </svg>
);

/** One line per thing the agent looked at, so the farmer (and owner) can see why it says what it says. */
function stepLabel(step: Briefing['steps'][number], pondName: (id: number) => string) {
  const pond = typeof step.args.pond_id === 'number' ? pondName(step.args.pond_id) : '';
  switch (step.tool) {
    case 'get_ponds':
      return t('Melihat semua kolam dan peringatannya', 'Looked at all ponds and their warnings');
    case 'get_night_forecast':
      return t(`Membaca prakiraan malam ${pond}`, `Read the night forecast for ${pond}`);
    case 'get_weather':
      return t('Membaca cuaca 18 jam ke depan', 'Read the weather for the next 18 hours');
    case 'get_pond_history':
      return t(`Membaca catatan ${step.args.days ?? 3} hari terakhir ${pond}`, `Read the last ${step.args.days ?? 3} days of records for ${pond}`);
    case 'search_guidance':
      return t(`Mencari panduan: “${step.args.query ?? ''}”`, `Searched the guidance: “${step.args.query ?? ''}”`);
    case 'submit_briefing':
      return t('Menyusun ringkasan malam dan jadwal cek', 'Wrote the night summary and check schedule');
    default:
      return step.tool;
  }
}

/** A risk factor as a short chip: a few words and an icon. */
function chip(f: RiskFactor, p: NowcastPoint): { icon: string; label: string } {
  switch (f.id) {
    case 'temp':
      return { icon: GLYPH.thermo, label: p.temp === null ? t('Air agak panas', 'Water a bit hot') : t(`Air agak panas ${fmtTemp(p.temp)}`, `Water a bit hot ${fmtTemp(p.temp)}`) };
    case 'signs':
      return { icon: GLYPH.up, label: t('Sidat naik', 'Eels rising') };
    case 'aeration_off':
      return { icon: GLYPH.fan, label: t('Aerator mati', 'Aerator off') };
    case 'aeration_weak':
      return { icon: GLYPH.fan, label: t('Aerasi lemah', 'Weak aeration') };
    case 'no_aeration':
      return { icon: GLYPH.fan, label: t('Tanpa aerasi', 'No aeration') };
    case 'partial_aeration':
      return { icon: GLYPH.fan, label: t('Aerasi tidak 24 jam', 'Aeration not 24 hours') };
    case 'algae_night':
      return { icon: GLYPH.drop, label: t('Air hijau di malam hari', 'Green water at night') };
    case 'cloudy':
      return { icon: GLYPH.cloud, label: t('Mendung', 'Overcast') };
    case 'density':
      return { icon: GLYPH.users, label: t('Kolam padat', 'Crowded pond') };
    case 'leftover':
      return { icon: GLYPH.trash, label: t('Sisa pakan', 'Leftover feed') };
    case 'rain':
      return { icon: GLYPH.rain, label: t('Hujan deras', 'Heavy rain') };
    case 'unwatched':
      return { icon: GLYPH.clock, label: t('Lama belum dicek', 'Not checked for a while') };
    default:
      return { icon: GLYPH.eye, label: f.label };
  }
}

/** The three strongest reasons, kept in the order the nowcast lists them. */
function chips(p: NowcastPoint) {
  const top = new Set([...p.factors].sort((a, b) => b.points - a.points).slice(0, 3));
  return p.factors.filter((f) => top.has(f)).map((f) => chip(f, p));
}

const localHour = (t: number) => Number(new Date(t).toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Asia/Jakarta' }));
const localDay = (t: number) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });

/** "besok sore", "nanti malam" ("in 23 hours" in English): where the 24-hour strip ends. */
function endLabel(t: number, now: number) {
  const h = localHour(t);
  const today = localDay(t) === localDay(now);
  // English part-of-day phrases ("tomorrow afternoon") do not fit the narrow tick: say how far ahead instead.
  if (isEn) return `in ${Math.max(1, Math.round((t - now) / HOUR))} hours`;
  const part = h < 5 ? 'dini hari' : h < 11 ? 'pagi' : h < 15 ? 'siang' : h < 19 ? 'sore' : 'malam';
  return `${today ? 'nanti' : 'besok'} ${part}`;
}

/** "Kolam A, Kolam B, Kolam C" → "Kolam A, B, C". */
function pondList(names: string[]) {
  for (const word of ['Kolam ', 'Pond ']) {
    if (names.length > 1 && names.every((n) => n.startsWith(word))) return `${word}${names.map((n) => n.slice(word.length)).join(', ')}`;
  }
  return names.join(', ');
}

/** Times as people say them, for the voice: "01.00" → "1", "23.30" → "23 lewat 30". */
const spokenTimes = (s: string) => s.replace(/\b(\d{2})\.(\d{2})\b/g, (_, h, m) => `${Number(h)}${m === '00' ? '' : ` lewat ${Number(m)}`}`);

const ALL_DONE = t('Semua cek malam ini sudah selesai.', 'All checks for tonight are done.');
const alarmAt = (at: number) => t(`Alarm berbunyi di HP ini jam ${fmtClock(at)}.`, `The alarm rings on this phone at ${fmtClock(at)}.`);

interface Row {
  key: string;
  t: number;
  action: string;
  ponds: string;
  checks: NightCheck[];
  agent: boolean;
  why: string;
  alarm: boolean;
  done: boolean;
}

/** Checks with the same action at the same time are one row for all their ponds. */
function groupRows(checks: NightCheck[], done: Record<string, boolean>): Row[] {
  const rows = new Map<string, NightCheck[]>();
  for (const c of checks) {
    const k = `${c.t}|${c.action}`;
    rows.set(k, [...(rows.get(k) ?? []), c]);
  }
  return [...rows.entries()].map(([key, cs]) => {
    const first = cs[0];
    // "· puncak rawan" when this is the check for the pond's worst hour.
    const atPeak = cs.length === 1 && first.peak && first.peak.level !== 'ok' && Math.abs(first.peak.t - first.t) <= HOUR;
    const agent = cs.find((c) => c.agent);
    const why = (agent ? `${agent.why ?? agent.reason}` : /^risiko/i.test(first.reason) ? first.reason : '').replace(/°c\b/g, '°C');
    return {
      key,
      t: first.t,
      action: first.action,
      ponds: pondList(cs.map((c) => c.pondName)) + (atPeak ? t(' · puncak rawan', ' · peak risk') : ''),
      checks: cs,
      agent: !!agent,
      why,
      alarm: cs.some((c) => c.alarm),
      done: cs.every((c) => done[c.key]),
    };
  });
}

export function Watch({ state, nowcast, onChanged: _onChanged, go }: { state: FarmState; nowcast: NowcastState | null; onChanged: () => void; go: Go }) {
  const prefs = usePrefs();
  const [open, setOpen] = useState(prefs.techOpen);
  const [done, setDone] = useState(loadDone);
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [briefBusy, setBriefBusy] = useState(false);
  const [briefError, setBriefError] = useState('');
  const [why, setWhy] = useState(false);
  const [showSteps, setShowSteps] = useState(false);
  const [listening, setListening] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [permission, setPermission] = useState(notifyPermission);

  useEffect(() => {
    api.briefing().then((r) => setBriefing(r.briefing), () => {});
    const off = onDoneChange(setDone);
    return () => {
      off();
      window.speechSynthesis?.cancel();
    };
  }, []);

  const checks = useMemo(() => (nowcast ? tonightChecks(briefing, nowcast, state.ponds) : []), [briefing, nowcast, state.ponds]);
  useEffect(() => {
    if (nowcast) armAlarms(checks, go);
    // `go` is the app's router; a new function each render, the same behaviour.
  }, [checks]);

  const makeBriefing = async () => {
    setBriefBusy(true);
    setBriefError('');
    try {
      setBriefing((await api.makeBriefing()).briefing);
    } catch (err) {
      setBriefError((err as Error).message);
    } finally {
      setBriefBusy(false);
    }
  };

  if (!nowcast)
    return (
      <div class="screen">
        <h1>{t('Waspada malam ini', "Tonight's watch")}</h1>
        <p class="muted">{t('Memuat perkiraan…', 'Loading the forecast…')}</p>
      </div>
    );

  const now = Date.now();
  const weather = nowcast.weather.available;
  const located = state.farm?.lat != null || !!state.farm?.locationName;
  const casts = [...nowcast.ponds].sort((a, b) => worst(b) - worst(a) || a.peak.t - b.peak.t);
  const focus = casts[0];
  const pondName = (id: number) => state.ponds.find((p) => p.id === id)?.name ?? t('Kolam', 'Pond');
  const risky = !!focus && focus.peak.level !== 'ok';
  // Other ponds at Bahaya or Perhatian tonight: by their own status or their night forecast.
  const castOf = (id: number) => nowcast.ponds.find((n) => n.pondId === id);
  const levelOf = (p: FarmState['ponds'][number]) => {
    const nc = castOf(p.id);
    const own = p.level === 'critical' ? 2 : p.level === 'warning' ? 1 : 0;
    return Math.max(own, nc ? worst(nc) : 0);
  };
  const others = state.ponds.filter((p) => !risky || p.id !== focus?.pondId);
  const alsoBad = others.filter((p) => levelOf(p) === 2);
  const alsoWarn = others.filter((p) => levelOf(p) === 1);
  const calmOthers = others.length - alsoBad.length - alsoWarn.length;

  const headline = !focus
    ? t('Belum ada perkiraan kolam', 'No pond forecast yet')
    : !risky
      ? t('Semua kolam aman malam ini', 'All ponds safe tonight')
      : weather
        ? t(`${pondName(focus.pondId)} rawan, puncaknya jam ${fmtClock(focus.peak.t)}`, `${pondName(focus.pondId)} at risk, peak at ${fmtClock(focus.peak.t)}`)
        : t(`${pondName(focus.pondId)} perlu dijaga malam ini`, `${pondName(focus.pondId)} needs watching tonight`);
  const reasons = risky ? chips(focus.peak) : [];

  // 24 hourly bars from the current hour; the peak bar is the tallest.
  const ahead = focus ? focus.hours.filter((h) => h.t > now - HOUR).slice(0, 24) : [];
  const peakIdx = risky ? ahead.findIndex((h) => h.t === focus.peak.t) : -1;
  const peakCol = Math.max(7, Math.min(13, peakIdx - 2));

  const rows = groupRows(checks, done);
  const warnNames = new Set(alsoWarn.map((p) => p.name));
  const warnCheck = rows.find((r) => !r.done && r.checks.some((c) => warnNames.has(c.pondName)));
  const nextIdx = rows.findIndex((r) => !r.done);
  const next = nextIdx >= 0 ? rows[nextIdx] : null;
  const rest = rows.filter((_, i) => i !== nextIdx);
  const doneCount = rows.filter((r) => r.done).length;
  const hasAlarm = rows.some((r) => r.alarm && !r.done);

  const toggle = (row: Row) => {
    const nextDone = { ...done };
    for (const c of row.checks) nextDone[c.key] = !row.done;
    setDone(nextDone);
    saveDone(nextDone);
    setExpanded(null);
  };

  const fromRules = briefing?.source === 'rules';
  const speech = typeof window !== 'undefined' && 'speechSynthesis' in window;
  const listen = () => {
    const synth = window.speechSynthesis;
    if (listening) {
      synth.cancel();
      setListening(false);
      return;
    }
    const text = spokenTimes(
      [
        `${headline}.`,
        reasons.length ? t(`Alasannya: ${reasons.map((r) => r.label).join(', ')}.`, `Reasons: ${reasons.map((r) => r.label).join(', ')}.`) : '',
        briefing?.summary ?? '',
        next
          ? t(`Cek berikutnya jam ${fmtClock(next.t)}: ${next.action}, ${next.ponds.replace(' · ', ', ')}.`, `Next check at ${fmtClock(next.t)}: ${next.action}, ${next.ponds.replace(' · ', ', ')}.`)
          : ALL_DONE,
      ]
        .filter(Boolean)
        .join(' '),
    ).replace(/°/g, t(' derajat', ' degrees'));
    const u = new SpeechSynthesisUtterance(text);
    u.lang = t('id-ID', 'en-GB');
    u.rate = 0.95;
    const voice = synth.getVoices().find((v) => v.lang.replace('_', '-').toLowerCase().startsWith(t('id', 'en')));
    if (voice) u.voice = voice;
    u.onend = () => setListening(false);
    u.onerror = () => setListening(false);
    synth.cancel();
    synth.speak(u);
    setListening(true);
  };

  const allowAlarm = async () => setPermission(await askNotifyPermission());

  const focusPoint = focus && (rank[focus.peak.level] > rank[focus.now.level] ? focus.peak : focus.now);

  return (
    <div class="screen">
      <header class="w-head">
        <h1>{t('Waspada malam ini', "Tonight's watch")}</h1>
        <span class="meta">
          {weather ? t('perkiraan', 'forecast') : t('dari catatan', 'from records')} · {fmtClock(nowcast.generatedAt)}
        </span>
      </header>

      <section class="hero w-night">
        {fromRules && (
          <span class="w-tag">
            <Glyph d={GLYPH.list} size={16} />
            {t('Dari aturan · AI sedang tidak tersedia', 'From rules · AI is not available right now')}
          </span>
        )}
        <div class="w-headline">
          {focus && <LevelShape level={focus.peak.level} />}
          <div class="stack-xs">
            {focus && (
              <span class="label strong" style={{ color: '#fff' }}>
                {LEVEL_WORD[focus.peak.level]}
              </span>
            )}
            <h2>{headline}</h2>
          </div>
        </div>
        {reasons.length > 0 && (
          <ul class="w-chips" aria-label={t('Alasan', 'Reasons')}>
            {reasons.map((r) => (
              <li key={r.label}>
                <Glyph d={r.icon} size={18} />
                {r.label}
              </li>
            ))}
          </ul>
        )}
        {!risky && focus && <p>{t('Tidak ada jam rawan dalam 24 jam ke depan. Tetap ukur pagi dan sore.', 'No risky hours in the next 24 hours. Keep measuring morning and afternoon.')}</p>}

        {weather && ahead.length > 0 && (
          <figure class="w-risk" aria-label={t(
              `Risiko per jam dari ${fmtClock(ahead[0].t)} sampai ${fmtClock(ahead.at(-1)!.t)}${risky ? `, puncak jam ${fmtClock(focus.peak.t)}` : ''}`,
              `Hourly risk from ${fmtClock(ahead[0].t)} to ${fmtClock(ahead.at(-1)!.t)}${risky ? `, peak at ${fmtClock(focus.peak.t)}` : ''}`,
            )}>
            {peakIdx >= 0 && (
              <div class="w-ticks">
                <span class="peak row" style={{ gridColumn: `${Math.max(1, Math.min(19, peakIdx - 2))} / span 6`, justifyContent: 'center', gap: 4 }}>
                  <Shape tone={TONE[focus.peak.level]} />
                  {LEVEL_WORD[focus.peak.level]}
                </span>
              </div>
            )}
            <div class="w-bars">
              {ahead.map((h, i) => (
                <span
                  key={h.t}
                  style={{
                    height: `${i === peakIdx ? 64 : 14 + rank[h.level] * 20}px`,
                    background: BAR[rank[h.level]],
                    opacity: i === 0 || i === peakIdx ? 1 : 0.8,
                    borderRadius: h.level === 'ok' ? 999 : 3,
                    boxShadow: i === peakIdx ? '0 0 0 2px #fff' : 'none',
                  }}
                />
              ))}
            </div>
            <div class="w-ticks">
              <span style={{ gridColumn: '1 / span 6' }}>{t('sekarang', 'now')}</span>
              {peakIdx >= 0 && (
                <span class="peak" style={{ gridColumn: `${peakCol} / span 6` }}>
                  {fmtClock(focus.peak.t)}
                </span>
              )}
              <span class="end" style={{ gridColumn: '19 / span 6' }}>
                {endLabel(ahead.at(-1)!.t, now)}
              </span>
            </div>
            <div class="row label" style={{ flexWrap: 'wrap', gap: '4px 16px', color: 'var(--on-navy)' }}>
              <span class="row" style={{ gap: 6 }}>
                <Shape tone="ok" /> {t('Aman', 'Safe')}
              </span>
              <span class="row" style={{ gap: 6 }}>
                <Shape tone="warn" /> {t('Perhatian', 'Caution')}
              </span>
              <span class="row" style={{ gap: 6 }}>
                <Shape tone="bad" /> {t('Bahaya', 'Danger')}
              </span>
              <span>{t('· makin tinggi makin rawan', '· taller means riskier')}</span>
            </div>
          </figure>
        )}
        {fromRules && <p class="label" style={{ color: 'var(--on-navy-2)' }}>{t('Dari ambang batas dan catatan 3 hari. Disusun ulang saat AI tersedia lagi.', 'From thresholds and 3 days of records. Rebuilt when the AI is back.')}</p>}

        {!weather && (
          <div class="w-noweather">
            <div class="msg">
              <Glyph d={GLYPH.cloudOff} />
              <span class="stack-xs">
                <span class="strong">{t('Cuaca belum tersedia', 'Weather not available yet')}</span>
                <span class="label" style={{ color: 'var(--on-navy)' }}>
                  {located
                    ? t(
                        'Data cuaca belum bisa diambil, jadi risiko per jam belum bisa dihitung. Cek di bawah tetap dari aturan dan catatan kolam.',
                        'The weather data could not be fetched, so hourly risk cannot be worked out yet. The checks below still come from rules and pond records.',
                      )
                    : t(
                        'Lokasi tambak belum diatur, jadi risiko per jam belum bisa dihitung. Cek di bawah tetap dari aturan dan catatan kolam.',
                        'The farm location is not set, so hourly risk cannot be worked out yet. The checks below still come from rules and pond records.',
                      )}
                </span>
              </span>
            </div>
            {!located && (
              <button class="btn light" onClick={() => go({ name: 'profile' })}>
                <Glyph d={GLYPH.pin} size={20} />
                {t('Atur lokasi tambak', 'Set the farm location')}
              </button>
            )}
          </div>
        )}

        <div class={`w-actions${speech ? '' : ' one'}`}>
          {speech && (
            <button type="button" class="w-listen" aria-pressed={listening} onClick={listen}>
              <Glyph d={listening ? GLYPH.stop : GLYPH.speaker} size={20} />
              {listening ? t('Berhenti', 'Stop') : t('Dengarkan', 'Listen')}
            </button>
          )}
          <button type="button" class="w-why" aria-expanded={why} onClick={() => setWhy(!why)}>
            {t('Kenapa?', 'Why?')}
            <span class="w-chev" style={{ display: 'inline-flex' }}>
              <Icon name="down" size={18} />
            </span>
          </button>
        </div>

        {why && (
          <div class="w-explain">
            {briefing ? (
              <>
                <span class="sub">
                  {briefing.source === 'agent' ? t('Ringkasan malam dari AI', 'Night summary from the AI') : t('Ringkasan malam dari aturan', 'Night summary from rules')} ·{' '}
                  {fmtClock(briefing.generatedAt)}
                </span>
                <p style={{ color: 'var(--on-navy)' }}>{briefing.summary}</p>
                {briefing.steps.length > 0 && (
                  <>
                    <button type="button" class="w-steps-btn" aria-expanded={showSteps} onClick={() => setShowSteps(!showSteps)}>
                      <span>{t(`Yang dilihat AI (${briefing.steps.length} langkah)`, `What the AI looked at (${briefing.steps.length} ${briefing.steps.length === 1 ? 'step' : 'steps'})`)}</span>
                      <span class="w-chev" style={{ display: 'inline-flex' }}>
                        <Icon name="down" size={18} />
                      </span>
                    </button>
                    {showSteps && (
                      <ol>
                        {briefing.steps.map((s, i) => (
                          <li key={i}>{stepLabel(s, pondName)}</li>
                        ))}
                      </ol>
                    )}
                  </>
                )}
                <span class="sub">{t('Saran, bukan diagnosis. AI hanya boleh menambah cek, tidak menghapus.', 'Advice, not a diagnosis. The AI can only add checks, never remove them.')}</span>
              </>
            ) : (
              <p style={{ color: 'var(--on-navy)' }}>
                {t(
                  'Belum ada ringkasan malam hari ini. AI akan membaca catatan, prakiraan dan cuaca, lalu menyusun rencana malam.',
                  'No night summary today yet. The AI will read the records, forecasts and weather, then write a plan for the night.',
                )}
              </p>
            )}
            {briefError && <p class="label" style={{ color: '#FDA29B', fontWeight: 600 }}>{briefError}</p>}
            <button type="button" class="w-link" disabled={briefBusy} onClick={makeBriefing}>
              {briefBusy ? t('AI sedang membaca data…', 'The AI is reading the data…') : briefing ? t('Susun ulang', 'Redo') : t('Susun ringkasan malam sekarang', 'Write the night summary now')}
            </button>
          </div>
        )}
      </section>

      <section class="stack" style={{ gap: 12 }}>
        <div class="w-head">
          <h2>{t('Jadwal cek', 'Check schedule')}</h2>
          {rows.length > 0 && (
            <span class="meta">
              {t(`${doneCount} dari ${rows.length} selesai`, `${doneCount} of ${rows.length} done`)}
            </span>
          )}
        </div>

        {rows.length === 0 && <p class="ink2">{t('Tidak ada cek khusus. Ukur pagi dan sore seperti biasa.', 'No special checks. Measure morning and afternoon as usual.')}</p>}

        {next && (
          <article class="w-next">
            <div class="row between">
              <span class="kicker">{t('BERIKUTNYA', 'NEXT')}</span>
              <span class="time">{fmtClock(next.t)}</span>
            </div>
            <div class="row">
              <span class="icon-box" style={{ color: 'var(--accent-ink)' }}>
                <Glyph d={actionIcon(next.action)} size={24} />
              </span>
              <div class="grow stack-xs" style={{ gap: 0 }}>
                <span class="h2">{next.action}</span>
                <span class="meta">{next.ponds}</span>
              </div>
              {next.agent && <span class="w-ai">{t('Tambahan AI', 'From the AI')}</span>}
            </div>
            {next.why && <span class="label ink2">{next.why}</span>}
            {next.alarm && <span class="label ink2">{alarmAt(next.t)}</span>}
            <button class="btn primary" onClick={() => toggle(next)}>
              <Icon name="check" size={20} stroke={3} />
              {t('Sudah dicek', 'Checked')}
            </button>
          </article>
        )}
        {rows.length > 0 && !next && <p class="note ok">{ALL_DONE}</p>}

        {rest.length > 0 && (
          <div class="w-rows">
            {rest.map((r) => (
              <div key={r.key} class={`w-row${r.done ? ' done' : ''}`}>
                <button type="button" aria-expanded={expanded === r.key} onClick={() => setExpanded(expanded === r.key ? null : r.key)}>
                  <span class="t">{fmtClock(r.t)}</span>
                  <Glyph d={actionIcon(r.action)} />
                  <span class="grow stack-xs" style={{ gap: 0 }}>
                    <span class="a">{r.action}</span>
                    <span class="meta">{r.ponds}</span>
                  </span>
                  {r.agent && <span class="w-ai">{t('Tambahan AI', 'From the AI')}</span>}
                  {r.alarm && !r.done && (
                    <span class="bell" aria-label="Alarm">
                      <Glyph d={GLYPH.bell} size={20} />
                    </span>
                  )}
                  {r.done && (
                    <span class="tick" aria-label={t('Sudah dicek', 'Checked')}>
                      <Icon name="check" size={20} stroke={3} />
                    </span>
                  )}
                </button>
                {expanded === r.key && (
                  <div class="more">
                    {r.why && <span>{r.why}</span>}
                    {r.alarm && !r.done && <span>{alarmAt(r.t)}</span>}
                    <button type="button" onClick={() => toggle(r)}>
                      {r.done ? t('Batal, belum dicek', 'Undo, not checked yet') : t('Tandai sudah dicek', 'Mark as checked')}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {hasAlarm && (
          <div class="w-quiet">
            {canNotify() && permission === 'default' && (
              <button type="button" onClick={allowAlarm}>
                <Glyph d={GLYPH.bell} size={18} />
                {t('Izinkan alarm di HP ini', 'Allow alarms on this phone')}
              </button>
            )}
            <span>{t('Alarm berbunyi kalau Synteel terbuka di HP. Versi aplikasi Android menyusul.', 'Alarms ring while Synteel is open on the phone. An Android app version is coming.')}</span>
          </div>
        )}
      </section>

      {(alsoBad.length > 0 || alsoWarn.length > 0) && (
        <section class="stack" style={{ gap: 12 }}>
          <h2>{t('Juga perlu dilihat', 'Also worth a look')}</h2>
          <div class="card list">
            {alsoBad.map((p) => (
              <button key={p.id} class="list-row w-also" onClick={() => go({ name: 'pond', id: p.id })}>
                <span class="grow stack-xs" style={{ gap: 0 }}>
                  <span class="strong">{p.name}</span>
                  <span class="label ink2 num">{pondDetail(p)}</span>
                </span>
                <span class="word bad strong">
                  <Shape tone="bad" /> {t('Bahaya', 'Danger')}
                </span>
                <Icon name="next" size={20} />
              </button>
            ))}
            {alsoWarn.length > 0 && (
              <button class="list-row w-also" onClick={() => (alsoWarn.length === 1 ? go({ name: 'pond', id: alsoWarn[0].id }) : go({ name: 'record' }))}>
                <span class="grow stack-xs" style={{ gap: 0 }}>
                  <span class="strong">{pondList(alsoWarn.map((p) => p.name))}</span>
                  <span class="label ink2">{warnCheck
                      ? t(`Ikut dicek jam ${fmtClock(warnCheck.t)}`, `Included in the ${fmtClock(warnCheck.t)} check`)
                      : alsoWarn.length === 1
                        ? pondDetail(alsoWarn[0])
                        : t(`${alsoWarn.length} kolam perlu perhatian`, `${alsoWarn.length} ponds need attention`)}</span>
                </span>
                <span class="word warn strong">
                  <Shape tone="warn" /> {t('Perhatian', 'Caution')}
                </span>
                <Icon name="next" size={20} />
              </button>
            )}
          </div>
        </section>
      )}

      {calmOthers > 0 && (
        <button class="w-calm" onClick={() => go({ name: 'record' })}>
          <span class="word ok strong">
            <Shape tone="ok" /> {t('Aman', 'Safe')}
          </span>
          <span class="grow">
            {t(
              `${calmOthers} kolam ${focus && risky ? 'lain ' : ''}aman malam ini`,
              `${calmOthers} ${focus && risky ? 'other ' : ''}${calmOthers === 1 ? 'pond' : 'ponds'} safe tonight`,
            )}
          </span>
          <span style={{ color: 'var(--muted)', display: 'inline-flex' }}>
            <Icon name="next" size={20} />
          </span>
        </button>
      )}

      {focus && focusPoint && (
        <section class="card w-tech" style={{ padding: 0, gap: 0, overflow: 'hidden' }}>
          <button aria-expanded={open} onClick={() => setOpen(!open)}>
            <span class="row">
              <span style={{ color: 'var(--accent)', display: 'inline-flex' }}>
                <Icon name="sliders" />
              </span>
              {t('Lihat detail teknis', 'View technical details')}
            </span>
            <span class="w-chev" style={{ color: 'var(--muted)', display: 'inline-flex' }}>
              <Icon name="down" />
            </span>
          </button>
          {open && (
            <div class="stack" style={{ padding: '0 20px 20px' }}>
              <span class="meta">
                {pondName(focus.pondId)} · {t('perkiraan suhu air per jam. Area biru = rentang perkiraan.', 'estimated water temperature per hour. Blue area = estimate range.')}
              </span>
              <NowcastChart nc={focus} />
              <div class="stack-sm">
                <div class="row between">
                  <span class="strong">{t(`Alasan risiko ${fmtClock(focusPoint.t)}`, `Why ${fmtClock(focusPoint.t)} is risky`)}</span>
                  <span class="meta">
                    {t(`skor ${focusPoint.score} · Bahaya mulai ${DANGER_SCORE}`, `score ${focusPoint.score} · Danger from ${DANGER_SCORE}`)}
                  </span>
                </div>
                {focusPoint.factors.map((f) => (
                  <div class="factor" key={f.id}>
                    <span class="grow ink2">{f.label}</span>
                    <span class="track">
                      <span style={{ width: `${Math.min(100, (f.points / 3) * 100)}%` }} />
                    </span>
                    <span class="strong" style={{ width: 24, textAlign: 'right' }}>
                      +{f.points}
                    </span>
                  </div>
                ))}
              </div>
              <span class="label ink2">
                {t(
                  'Ringkasan malam disusun AI Meta (Muse Spark) dari prakiraan, cuaca dan catatan. Skor risiko dari aturan Synteel.',
                  'Night summary written by Meta AI (Muse Spark) from forecasts, weather and records. Risk score from Synteel rules.',
                )}
              </span>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
