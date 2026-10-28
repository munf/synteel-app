import { useEffect, useMemo, useState } from 'preact/hooks';
import { api, type Briefing, type FarmState, type Nowcast, type NowcastPoint, type NowcastState, type RiskFactor } from '../api.ts';
import type { Go } from '../app.tsx';
import { actionIcon, armAlarms, askNotifyPermission, canNotify, GLYPH, loadDone, notifyPermission, onDoneChange, saveDone, tonightChecks, type NightCheck } from '../alarms.ts';
import { NowcastChart } from '../chart.tsx';
import { fmtClock } from '../labels.ts';
import { usePrefs } from '../prefs.ts';
import { Icon } from '../ui.tsx';
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
      return 'Melihat semua kolam dan peringatannya';
    case 'get_night_forecast':
      return `Membaca prakiraan malam ${pond}`;
    case 'get_weather':
      return 'Membaca cuaca 18 jam ke depan';
    case 'get_pond_history':
      return `Membaca catatan ${step.args.days ?? 3} hari terakhir ${pond}`;
    case 'search_guidance':
      return `Mencari panduan: “${step.args.query ?? ''}”`;
    case 'submit_briefing':
      return 'Menyusun briefing dan jadwal cek';
    default:
      return step.tool;
  }
}

/** A risk factor as a short chip: a few words and an icon. */
function chip(f: RiskFactor, p: NowcastPoint): { icon: string; label: string } {
  switch (f.id) {
    case 'temp':
      return { icon: GLYPH.thermo, label: p.temp === null ? 'Air hangat' : `Air hangat ${Math.round(p.temp)}°` };
    case 'signs':
      return { icon: GLYPH.up, label: 'Sidat naik' };
    case 'aeration_off':
      return { icon: GLYPH.fan, label: 'Aerator mati' };
    case 'aeration_weak':
      return { icon: GLYPH.fan, label: 'Aerasi lemah' };
    case 'no_aeration':
      return { icon: GLYPH.fan, label: 'Tanpa aerasi' };
    case 'partial_aeration':
      return { icon: GLYPH.fan, label: 'Aerasi tidak 24 jam' };
    case 'algae_night':
      return { icon: GLYPH.drop, label: 'Air hijau di malam hari' };
    case 'cloudy':
      return { icon: GLYPH.cloud, label: 'Mendung' };
    case 'density':
      return { icon: GLYPH.users, label: 'Kolam padat' };
    case 'leftover':
      return { icon: GLYPH.trash, label: 'Sisa pakan' };
    case 'rain':
      return { icon: GLYPH.rain, label: 'Hujan deras' };
    case 'unwatched':
      return { icon: GLYPH.clock, label: 'Lama belum dicek' };
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

/** "besok sore", "nanti malam": where the 24-hour strip ends. */
function endLabel(t: number, now: number) {
  const h = localHour(t);
  const part = h < 5 ? 'dini hari' : h < 11 ? 'pagi' : h < 15 ? 'siang' : h < 19 ? 'sore' : 'malam';
  return `${localDay(t) === localDay(now) ? 'nanti' : 'besok'} ${part}`;
}

/** "Kolam A, Kolam B, Kolam C" → "Kolam A, B, C". */
function pondList(names: string[]) {
  if (names.length > 1 && names.every((n) => n.startsWith('Kolam '))) return `Kolam ${names.map((n) => n.slice(6)).join(', ')}`;
  return names.join(', ');
}

/** Times as people say them, for the voice: "01.00" → "1", "23.30" → "23 lewat 30". */
const spokenTimes = (s: string) => s.replace(/\b(\d{2})\.(\d{2})\b/g, (_, h, m) => `${Number(h)}${m === '00' ? '' : ` lewat ${Number(m)}`}`);

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
    const why = agent ? `Tambahan AI: ${agent.why ?? agent.reason}` : /^risiko/i.test(first.reason) ? first.reason : '';
    return {
      key,
      t: first.t,
      action: first.action,
      ponds: pondList(cs.map((c) => c.pondName)) + (atPeak ? ' · puncak rawan' : ''),
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
        <h1>Malam ini</h1>
        <p class="muted">Memuat perkiraan…</p>
      </div>
    );

  const now = Date.now();
  const weather = nowcast.weather.available;
  const located = state.farm?.lat != null || !!state.farm?.locationName;
  const casts = [...nowcast.ponds].sort((a, b) => worst(b) - worst(a) || a.peak.t - b.peak.t);
  const focus = casts[0];
  const pondName = (id: number) => state.ponds.find((p) => p.id === id)?.name ?? 'Kolam';
  const risky = !!focus && focus.peak.level !== 'ok';
  const calmOthers = casts.filter((nc) => nc !== focus && nc.peak.level === 'ok' && nc.now.level === 'ok').length;

  const headline = !focus
    ? 'Belum ada perkiraan kolam'
    : !risky
      ? 'Semua kolam tenang malam ini'
      : weather
        ? `${pondName(focus.pondId)} rawan, puncaknya jam ${fmtClock(focus.peak.t)}`
        : `${pondName(focus.pondId)} perlu dijaga malam ini`;
  const reasons = risky ? chips(focus.peak) : [];

  // 24 hourly bars from the current hour; the peak bar is the tallest.
  const ahead = focus ? focus.hours.filter((h) => h.t > now - HOUR).slice(0, 24) : [];
  const peakIdx = risky ? ahead.findIndex((h) => h.t === focus.peak.t) : -1;
  const peakCol = Math.max(7, Math.min(13, peakIdx - 2));

  const rows = groupRows(checks, done);
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
        reasons.length ? `Alasannya: ${reasons.map((r) => r.label).join(', ')}.` : '',
        briefing?.summary ?? '',
        next ? `Cek berikutnya jam ${fmtClock(next.t)}: ${next.action}, ${next.ponds.replace(' · ', ', ')}.` : 'Semua cek malam ini sudah selesai.',
      ]
        .filter(Boolean)
        .join(' '),
    ).replace(/°/g, ' derajat');
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'id-ID';
    u.rate = 0.95;
    const voice = synth.getVoices().find((v) => v.lang.replace('_', '-').toLowerCase().startsWith('id'));
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
        <h1>Malam ini</h1>
        <span class="meta">
          {weather ? 'perkiraan' : 'dari catatan'} · {fmtClock(nowcast.generatedAt)}
        </span>
      </header>

      <section class="hero w-night">
        {fromRules && (
          <span class="w-tag">
            <Glyph d={GLYPH.list} size={16} />
            Dari aturan · AI sedang tidak tersedia
          </span>
        )}
        <div class="w-headline">
          {focus && <LevelShape level={focus.peak.level} />}
          <h2>{headline}</h2>
        </div>
        {reasons.length > 0 && (
          <ul class="w-chips" aria-label="Alasan">
            {reasons.map((r) => (
              <li key={r.label}>
                <Glyph d={r.icon} size={18} />
                {r.label}
              </li>
            ))}
          </ul>
        )}
        {!risky && focus && <p>Tidak ada jam rawan dalam 24 jam ke depan. Tetap ukur pagi dan sore.</p>}

        {weather && ahead.length > 0 && (
          <figure class="w-risk" aria-label={`Risiko per jam dari ${fmtClock(ahead[0].t)} sampai ${fmtClock(ahead.at(-1)!.t)}${risky ? `, puncak jam ${fmtClock(focus.peak.t)}` : ''}`}>
            <div class="w-bars">
              {ahead.map((h, i) => (
                <span key={h.t} style={{ height: `${i === peakIdx ? 64 : 14 + rank[h.level] * 20}px`, background: BAR[rank[h.level]], opacity: i === 0 || i === peakIdx ? 1 : 0.8 }} />
              ))}
            </div>
            <div class="w-ticks">
              <span style={{ gridColumn: '1 / span 6' }}>sekarang</span>
              {peakIdx >= 0 && (
                <span class="peak" style={{ gridColumn: `${peakCol} / span 6` }}>
                  {fmtClock(focus.peak.t)}
                </span>
              )}
              <span class="end" style={{ gridColumn: '19 / span 6' }}>
                {endLabel(ahead.at(-1)!.t, now)}
              </span>
            </div>
          </figure>
        )}
        {fromRules && <p class="label" style={{ color: 'var(--on-navy-2)' }}>Dari ambang batas dan catatan 3 hari. Disusun ulang saat AI tersedia lagi.</p>}

        {!weather && (
          <div class="w-noweather">
            <div class="msg">
              <Glyph d={GLYPH.cloudOff} />
              <span class="stack-xs">
                <span class="strong">Cuaca belum tersedia</span>
                <span class="label" style={{ color: 'var(--on-navy)' }}>
                  {located
                    ? 'Data cuaca belum bisa diambil, jadi risiko per jam belum bisa dihitung. Cek di bawah tetap dari aturan dan catatan kolam.'
                    : 'Lokasi tambak belum diatur, jadi risiko per jam belum bisa dihitung. Cek di bawah tetap dari aturan dan catatan kolam.'}
                </span>
              </span>
            </div>
            {!located && (
              <button class="btn light" onClick={() => go({ name: 'profile' })}>
                <Glyph d={GLYPH.pin} size={20} />
                Atur lokasi tambak
              </button>
            )}
          </div>
        )}

        <div class={`w-actions${speech ? '' : ' one'}`}>
          {speech && (
            <button type="button" class="w-listen" aria-pressed={listening} onClick={listen}>
              <Glyph d={listening ? GLYPH.stop : GLYPH.speaker} size={20} />
              {listening ? 'Berhenti' : 'Dengarkan'}
            </button>
          )}
          <button type="button" class="w-why" aria-expanded={why} onClick={() => setWhy(!why)}>
            Kenapa?
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
                  {briefing.source === 'agent' ? 'Briefing dari AI Meta (Muse Spark)' : 'Disusun dari aturan'} · {fmtClock(briefing.generatedAt)}
                </span>
                <p style={{ color: 'var(--on-navy)' }}>{briefing.summary}</p>
                {briefing.steps.length > 0 && (
                  <>
                    <button type="button" class="w-steps-btn" aria-expanded={showSteps} onClick={() => setShowSteps(!showSteps)}>
                      <span>Yang dilihat AI ({briefing.steps.length} langkah)</span>
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
                <span class="sub">Saran, bukan diagnosis. AI hanya boleh menambah cek, tidak menghapus.</span>
              </>
            ) : (
              <p style={{ color: 'var(--on-navy)' }}>Belum ada briefing hari ini. AI Meta akan membaca catatan, prakiraan dan cuaca, lalu menyusun rencana malam.</p>
            )}
            {briefError && <p class="label" style={{ color: '#FDA29B', fontWeight: 600 }}>{briefError}</p>}
            <button type="button" class="w-link" disabled={briefBusy} onClick={makeBriefing}>
              {briefBusy ? 'AI sedang membaca data…' : briefing ? 'Susun ulang' : 'Susun briefing sekarang'}
            </button>
          </div>
        )}
      </section>

      <section class="stack" style={{ gap: 12 }}>
        <div class="w-head">
          <h2>Jadwal cek</h2>
          {rows.length > 0 && (
            <span class="meta">
              {doneCount} dari {rows.length} selesai
            </span>
          )}
        </div>

        {rows.length === 0 && <p class="ink2">Tidak ada cek khusus. Ukur pagi dan sore seperti biasa.</p>}

        {next && (
          <article class="w-next">
            <div class="row between">
              <span class="kicker">BERIKUTNYA</span>
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
              {next.agent && <span class="w-ai">AI</span>}
            </div>
            {next.why && <span class="label ink2">{next.why}</span>}
            {next.alarm && <span class="label ink2">Alarm berbunyi di HP ini jam {fmtClock(next.t)}.</span>}
            <button class="btn primary" onClick={() => toggle(next)}>
              <Icon name="check" size={20} stroke={3} />
              Sudah dicek
            </button>
          </article>
        )}
        {rows.length > 0 && !next && <p class="note ok">Semua cek malam ini sudah selesai.</p>}

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
                  {r.agent && <span class="w-ai">AI</span>}
                  {r.alarm && !r.done && (
                    <span class="bell" aria-label="Alarm">
                      <Glyph d={GLYPH.bell} size={20} />
                    </span>
                  )}
                  {r.done && (
                    <span class="tick" aria-label="Sudah dicek">
                      <Icon name="check" size={20} stroke={3} />
                    </span>
                  )}
                </button>
                {expanded === r.key && (
                  <div class="more">
                    {r.why && <span>{r.why}</span>}
                    {r.alarm && !r.done && <span>Alarm berbunyi di HP ini jam {fmtClock(r.t)}.</span>}
                    <button type="button" onClick={() => toggle(r)}>
                      {r.done ? 'Batal, belum dicek' : 'Tandai sudah dicek'}
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
                Izinkan alarm di HP ini
              </button>
            )}
            <span>Alarm berbunyi kalau Synteel terbuka di HP. Versi aplikasi Android menyusul.</span>
          </div>
        )}
      </section>

      {risky && calmOthers > 0 && (
        <button class="w-calm" onClick={() => go({ name: 'record' })}>
          <LevelShape level="ok" size={14} />
          <span class="grow">{calmOthers} kolam lain tenang malam ini</span>
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
              Lihat detail teknis
            </span>
            <span class="w-chev" style={{ color: 'var(--muted)', display: 'inline-flex' }}>
              <Icon name="down" />
            </span>
          </button>
          {open && (
            <div class="stack" style={{ padding: '0 20px 20px' }}>
              <span class="meta">{pondName(focus.pondId)} · perkiraan suhu air per jam. Area biru = rentang perkiraan.</span>
              <NowcastChart nc={focus} />
              <div class="stack-sm">
                <div class="row between">
                  <span class="strong">Alasan risiko {fmtClock(focusPoint.t)}</span>
                  <span class="meta">
                    skor {focusPoint.score} · Bahaya mulai {DANGER_SCORE}
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
            </div>
          )}
        </section>
      )}
    </div>
  );
}
