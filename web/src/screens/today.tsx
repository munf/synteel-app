import type { FarmState, Nowcast, NowcastState, PondSummary } from '../api.ts';
import type { Go } from '../app.tsx';
import { useState } from 'preact/hooks';
import { fmtAgo, fmtClock, fmtNum, fmtTemp, greeting, phaseLabel, readingWord } from '../labels.ts';
import { EmptyState, Icon, initialOf, PondThumb, pondMeta, Shape, StatusPill, type IconName } from '../ui.tsx';
import { DueRechecks, useRechecks } from './recheck.tsx';
import './today.css';

const rank = { ok: 0, info: 0, warning: 1, critical: 2 } as const;
const SHOWN = [
  ['temperature', 'Suhu'],
  ['ph', 'pH'],
  ['tds', 'TDS'],
] as const;
/** Status stack bar: the status shape colours, plus grey for ponds not recorded today (no status yet). */
const BAR = { critical: '#D92D20', warning: '#A86A00', ok: '#1E8A5F', none: '#D9E1EC' } as const;

const fmtValue = (key: 'temperature' | 'ph' | 'tds', v: number) => (key === 'temperature' ? fmtTemp(v) : fmtNum(v));

/** Farm-time date "YYYY-MM-DD" of a timestamp. */
const ymdOf = (t: number) => new Date(t + 7 * 3600_000).toISOString().slice(0, 10);

/** "Dicatat 17.15" today, "Dicatat Selasa 17.15" before; never an amber colour (amber is Perhatian). */
function loggedLine(lastAt: number | null, today: string) {
  if (lastAt === null) return 'Belum pernah dicatat';
  return ymdOf(lastAt) === today ? `Dicatat ${fmtClock(lastAt)}` : `Dicatat ${fmtClock(lastAt, true)}`;
}

/** A pond that needs attention: why, and only the readings that are not good. */
function AttentionCard({ pond, go, today }: { pond: PondSummary; go: Go; today: string }) {
  const top = pond.findings.find((f) => f.level === 'critical' || f.level === 'warning');
  const lastAt = pond.lastLogAt ? Date.parse(pond.lastLogAt) : null;
  const flagged = SHOWN.flatMap(([key, label]) => {
    const r = pond.latest[key];
    const status = pond.status[key];
    if (!r || !status || status === 'ok') return [];
    return [{ key, label, value: fmtValue(key, r.value), word: readingWord(key, r.value, status, pond.limits[key]) }];
  });
  const alive = pond.program?.estimatedAlive;
  return (
    <button class="pond-card" onClick={() => go({ name: 'pond', id: pond.id })}>
      <div class="row top">
        <PondThumb kind={pond.kind} />
        <div class="grow stack-xs">
          <span class="h2">{pond.name}</span>
          <span class="meta num" style={{ display: 'flex', flexDirection: 'column' }}>
            <span>{pond.batch && pond.program ? `${phaseLabel[pond.batch.phase]} · minggu ${pond.program.week}` : pondMeta(pond)}</span>
            {alive != null && <span>sekitar {alive.toLocaleString('id-ID')} ekor</span>}
          </span>
        </div>
        <StatusPill level={pond.level} />
      </div>
      {top && <p style={{ color: top.level === 'critical' ? 'var(--bad)' : 'var(--warn)' }}>{top.title}</p>}
      {flagged.length > 0 && (
        <div class="readings">
          {flagged.map((r) => (
            <div class="reading" key={r.key}>
              <span class="k">{r.label}</span>
              <span class="v">{r.value}</span>
              <span class={`word ${r.word.tone}`}>
                <Shape tone={r.word.tone} />
                {r.word.text}
              </span>
            </div>
          ))}
        </div>
      )}
      <span class="label ink2">{loggedLine(lastAt, today)}</span>
    </button>
  );
}

/** A pond with nothing recorded yet: no status, dashes instead of numbers. */
function UnrecordedCard({ pond, go }: { pond: PondSummary; go: Go }) {
  return (
    <button class="pond-card" onClick={() => go({ name: 'pond', id: pond.id })}>
      <div class="row top">
        <PondThumb kind={pond.kind} />
        <div class="grow stack-xs">
          <div class="row between" style={{ gap: 8 }}>
            <span class="h2">{pond.name}</span>
            <span class="label ink2" style={{ whiteSpace: 'nowrap', fontWeight: 400 }}>
              Belum dicatat hari ini
            </span>
          </div>
          <span class="label ink2 num">{pondMeta(pond)}</span>
        </div>
      </div>
      <div class="readings">
        {SHOWN.map(([key, label]) => (
          <div class="reading" key={key}>
            <span class="k" style={{ color: 'var(--ink-2)' }}>
              {label}
            </span>
            <span class="v">–</span>
            <span class="label ink2">belum diukur</span>
          </div>
        ))}
      </div>
      <span class="label ink2">Belum pernah dicatat</span>
    </button>
  );
}

/** Every pond is fine: say so, and point at the pond recorded longest ago. */
function SafeCard({ ponds, go, now }: { ponds: PondSummary[]; go: Go; now: number }) {
  const at = (p: PondSummary) => (p.lastLogAt ? Date.parse(p.lastLogAt) : -Infinity);
  const oldest = ponds.reduce((a, b) => (at(b) < at(a) ? b : a));
  return (
    <section class="card">
      <div class="row">
        <span class="icon-box ok">
          <Icon name="check" size={24} stroke={2.5} />
        </span>
        <div class="grow stack-xs">
          <span class="h2">Semua kolam aman</span>
          <span class="meta">{ponds.length} kolam dalam batas baik</span>
        </div>
      </div>
      <hr class="rule" />
      <div class="row">
        <PondThumb kind={oldest.kind} size={48} />
        <div class="grow stack-xs">
          <span class="meta">Paling lama belum dicatat</span>
          <span class="strong">
            {oldest.name} · {oldest.lastLogAt ? fmtAgo(at(oldest), now) : 'belum pernah dicatat'}
          </span>
        </div>
        <button class="btn compact tint" onClick={() => go({ name: 'record-pond', pondId: oldest.id })}>
          Catat
        </button>
      </div>
    </section>
  );
}

/** The next suggested check across all ponds, so the hero card answers "what now?". */
function nextCheck(state: FarmState, nowcast: NowcastState | null) {
  const now = Date.now();
  const all = (nowcast?.ponds ?? []).flatMap((nc) => nc.checks.filter((c) => c.t >= now - 30 * 60_000).map((c) => ({ ...c, nc })));
  all.sort((a, b) => rank[b.nc.peak.level] - rank[a.nc.peak.level] || a.t - b.t);
  const first = all[0];
  if (!first) return null;
  return { check: first, pond: state.ponds.find((p) => p.id === first.nc.pondId) };
}

/** Where a forecast water temperature sits against the pond's limits (the same rule as the server's readings). */
function classifyTemp(value: number, l: PondSummary['limits']['temperature']) {
  if (!l) return undefined;
  const out = (b: { below?: number; above?: number } | null) => !!b && ((b.below !== undefined && value < b.below) || (b.above !== undefined && value > b.above));
  if (out(l.critical)) return 'critical' as const;
  if (out(l.warning)) return 'warning' as const;
  const t = l.target;
  if (t && ((t.min !== undefined && value < t.min) || (t.max !== undefined && value > t.max))) return 'info' as const;
  return 'ok' as const;
}

function WeatherCard({
  nowcast,
  focus,
  pond,
  many,
  onRetry,
  onPlace,
}: {
  nowcast: NowcastState;
  focus: Nowcast | undefined;
  pond: PondSummary | undefined;
  /** More than one pond: name the pond the forecast is for. */
  many: boolean;
  onRetry: () => void;
  onPlace: () => void;
}) {
  const [why, setWhy] = useState(false);
  const w = nowcast.weather;
  if (!w.available || w.hours.length === 0) {
    const noPlace = w.error === 'Lokasi tambak belum diatur';
    return (
      <EmptyState
        icon="cloud"
        text={noPlace ? 'Atur lokasi tambak supaya cuaca dan suhu air bisa diperkirakan.' : 'Cuaca belum termuat; perkiraan memakai data terakhir.'}
        action={
          <button class="btn secondary" onClick={noPlace ? onPlace : onRetry}>
            {noPlace ? 'Atur lokasi tambak' : 'Coba lagi'}
          </button>
        }
      />
    );
  }
  const nowH = w.hours[0];
  const icon = (h: { rain: number; cloud: number; t: number }): IconName => {
    const hour = new Date(h.t + 7 * 3600_000).getUTCHours();
    if (h.rain >= 0.5) return 'rain';
    if (hour >= 18 || hour < 6) return 'moon';
    return h.cloud > 60 ? 'cloud' : 'sun';
  };
  const strip = w.hours.filter((_, i) => i % 3 === 0).slice(0, 5);
  const rainy = w.hours.slice(0, 12).find((h) => h.rain >= 1);
  const hot = Math.max(...w.hours.slice(0, 12).map((h) => h.airTemp));
  const tip = rainy
    ? `Hujan sekitar jam ${fmtClock(rainy.t)}. Jaga supaya air hujan tidak masuk kolam, lalu ukur TDS sesudahnya.`
    : hot >= 32
      ? `Siang panas sampai ${fmtTemp(Math.round(hot))}. Pastikan peneduh terpasang dan ukur suhu air sore.`
      : null;
  const fit = focus?.basis.fit ?? [];
  const good = fit.filter((f) => Math.abs(f.error) <= 0.5).length;
  const circumference = 2 * Math.PI * 26;

  // The water temperature about three hours ahead: the evening the farmer is planning for.
  const target = Date.now() + 3 * 3600_000;
  const ahead = (focus?.hours ?? []).filter((h) => h.temp !== null && h.t >= Date.now());
  const water = ahead.length ? ahead.reduce((a, b) => (Math.abs(b.t - target) < Math.abs(a.t - target) ? b : a)) : null;
  const level = water?.temp != null ? classifyTemp(water.temp, pond?.limits.temperature) : undefined;
  const word = water?.temp != null ? readingWord('temperature', water.temp, level, pond?.limits.temperature) : null;

  return (
    <section class="card">
      <span class="label ink2">Cuaca tambak{w.place ? ` · ${w.place}` : ''}</span>
      {water?.temp != null && (
        <div class="stack-sm">
          <span class="label semi ink2">
            Perkiraan suhu air {many && pond ? pond.name : 'kolam'} jam {fmtClock(water.t)}
          </span>
          <div class="row between">
            <span class="big">{fmtTemp(water.temp)}</span>
            {word && (
              <span class={`pill ${word.tone}`}>
                <Shape tone={word.tone} />
                {word.text}
              </span>
            )}
          </div>
        </div>
      )}
      <div class="row" style={{ gap: 8, ...(water?.temp != null ? { borderTop: '1px solid var(--line)', paddingTop: 16 } : {}) }}>
        <span style={{ color: nowH.rain >= 0.5 ? 'var(--accent)' : 'var(--ink-2)', display: 'flex' }}>
          <Icon name={icon(nowH)} />
        </span>
        <span class="num" style={{ fontSize: '1.125rem', fontWeight: 800, whiteSpace: 'nowrap' }}>
          {fmtTemp(Math.round(nowH.airTemp))}
        </span>
        <span class="label ink2">suhu udara{rainy ? ` · hujan sekitar ${fmtClock(rainy.t)}` : ''}</span>
      </div>
      <div class="hours">
        {strip.map((h) => (
          <div key={h.t} class={h.rain >= 0.5 ? 'rain' : ''}>
            <span class="label ink2 num">{fmtClock(h.t)}</span>
            <span style={{ color: h.rain >= 0.5 ? 'var(--accent)' : 'var(--muted)', display: 'flex' }}>
              <Icon name={icon(h)} />
            </span>
            <span class="strong num" style={{ whiteSpace: 'nowrap' }}>
              {fmtTemp(Math.round(h.airTemp))}
            </span>
          </div>
        ))}
      </div>
      <button type="button" class="link-btn row" style={{ alignSelf: 'flex-start', gap: 8, fontWeight: 800 }} aria-expanded={why} onClick={() => setWhy(!why)}>
        Kenapa?
        <span style={{ display: 'flex', transform: why ? 'rotate(180deg)' : 'none' }}>
          <Icon name="down" size={20} />
        </span>
      </button>
      {why && (
        <>
          {tip && (
            <div class="note info">
              <Icon name="drop" />
              <span style={{ fontSize: '1rem' }}>{tip}</span>
            </div>
          )}
          <div class="row">
            {fit.length >= 3 ? (
              <svg width="56" height="56" viewBox="0 0 64 64" role="img" aria-label={`Perkiraan cocok ${good} dari ${fit.length} kali`} style={{ flex: 'none' }}>
                <circle cx="32" cy="32" r="26" fill="none" style={{ stroke: 'var(--tint)' }} stroke-width="8" />
                <circle cx="32" cy="32" r="26" fill="none" stroke="#2F6FE4" stroke-width="8" stroke-linecap="round" stroke-dasharray={`${(good / fit.length) * circumference} ${circumference}`} transform="rotate(-90 32 32)" />
                <text x="32" y="37" text-anchor="middle" font-size="16" font-weight="800" style={{ fill: 'var(--ink)' }}>
                  {good}/{fit.length}
                </text>
              </svg>
            ) : (
              <span class="icon-box grey">
                <Icon name="thermo" />
              </span>
            )}
            <div class="stack-xs grow">
              <span class="strong">{fit.length >= 3 ? (good / fit.length >= 0.7 ? 'Perkiraan bisa dipercaya' : 'Perkiraan masih sering meleset') : 'Perkiraan sedang belajar'}</span>
              <span class="label ink2">
                {fit.length >= 3
                  ? `${good} dari ${fit.length} ukuran suhu terakhir cocok dengan perkiraan (selisih 0,5 °C atau kurang).`
                  : 'Butuh beberapa ukuran suhu pagi dan sore untuk mencocokkan cuaca dengan kolam.'}
              </span>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

/** Ponds that need attention, most urgent first: level, then the night's peak risk, then the most problems, then the stalest. */
function byUrgency(ponds: PondSummary[], nowcast: NowcastState | null) {
  const peak = (p: PondSummary) => rank[nowcast?.ponds.find((n) => n.pondId === p.id)?.peak.level ?? 'ok'];
  const problems = (p: PondSummary) => p.findings.filter((f) => f.level === 'critical' || f.level === 'warning').length;
  const at = (p: PondSummary) => (p.lastLogAt ? Date.parse(p.lastLogAt) : 0);
  return ponds
    .filter((p) => p.level === 'critical' || p.level === 'warning')
    .sort((a, b) => rank[b.level] - rank[a.level] || peak(b) - peak(a) || problems(b) - problems(a) || at(a) - at(b));
}

export function Today({
  state,
  userName,
  nowcast,
  go,
  onRetryWeather,
}: {
  state: FarmState;
  userName: string;
  nowcast: NowcastState | null;
  go: Go;
  onRetryWeather: () => void;
}) {
  const now = Date.now();
  const ponds = state.ponds;
  const recordedToday = (p: PondSummary) => p.lastLogAt !== null && ymdOf(Date.parse(p.lastLogAt)) === state.today;
  // A pond not recorded today and not at risk has no status yet: it counts grey, not Aman.
  const counts = { critical: 0, warning: 0, ok: 0, none: 0 };
  for (const p of ponds) counts[p.level === 'critical' ? 'critical' : p.level === 'warning' ? 'warning' : recordedToday(p) ? 'ok' : 'none']++;
  const need = byUrgency(ponds, nowcast);
  const shown = need.slice(0, 2);
  const never = ponds.filter((p) => p.lastLogAt === null);
  const next = nextCheck(state, nowcast);
  const focusPond = need[0] ?? ponds[0];
  const focus = nowcast?.ponds.find((n) => n.pondId === focusPond?.id);
  const rechecks = useRechecks();
  const soon = rechecks.soon[0];
  const alive = ponds.reduce((s, p) => s + (p.program?.estimatedAlive ?? 0), 0);
  const groups = (['critical', 'warning', 'ok', 'none'] as const).filter((k) => counts[k] > 0);
  const owner = state.role === 'owner';

  // The check after the next one, and tonight's peak, in one line under the hero.
  const after = next ? laterCheck(nowcast, next.check.t) : null;
  const peak = next?.check.nc.peak;
  const peakLine = peak && peak.level !== 'ok' && peak.t > now ? `Puncak rawan jam ${fmtClock(peak.t)}.` : '';
  const thenLine = [after ? `Lalu ${fmtClock(after.t)} ${lowerFirst(after.reason)}.` : '', peakLine].filter(Boolean).join(' ');

  return (
    <div class="screen">
      <header>
        <button class="profile-link" onClick={() => go({ name: 'profile' })}>
          <span class="avatar">{initialOf(userName)}</span>
          <span class="grow" style={{ display: 'flex', flexDirection: 'column' }}>
            <span class="h2">
              {greeting()}, {userName}
            </span>
            <span class="more">
              Profil dan info <Icon name="next" size={16} stroke={2.5} />
            </span>
          </span>
        </button>
      </header>

      <DueRechecks due={rechecks.due} update={rechecks.update} go={go} />

      {soon && rechecks.due.length === 0 && (
        <div class="note info" style={{ alignItems: 'center' }}>
          <Icon name="clock" />
          <span class="grow">
            Cek ulang {soon.pondName} jam {fmtClock(soon.dueAt)}
          </span>
        </div>
      )}

      {/* While a re-check is due it is the single focus: the plan card waits. */}
      {rechecks.due.length > 0 ? null : next ? (
        <section class="hero">
          <div class="row top between">
            <div class="stack-sm">
              <span class="label semi" style={{ color: 'var(--on-navy-2)' }}>
                Cek berikutnya
              </span>
              <span class="big">{fmtClock(next.check.t)}</span>
            </div>
            {next.pond && (
              <StatusPill level={next.check.nc.peak.level}>
                {next.pond.name} {levelWord[next.check.nc.peak.level]}
              </StatusPill>
            )}
          </div>
          <p>{next.check.reason.replace(/°c\b/g, '°C')}</p>
          {thenLine && (
            <div class="recheck-line">
              <Icon name="clock" size={18} />
              <span>{thenLine}</span>
            </div>
          )}
          <button class="btn light" onClick={() => go({ name: 'watch' })}>
            Lihat Waspada <Icon name="arrow" size={20} />
          </button>
        </section>
      ) : (
        <section class="hero">
          <span class="label semi" style={{ color: 'var(--on-navy-2)' }}>
            Hari ini
          </span>
          <p class="h2" style={{ color: '#fff' }}>
            Catat kondisi kolam pagi dan sore supaya Synteel bisa ikut menjaga.
          </p>
          <button class="btn light" onClick={() => go({ name: 'record' })}>
            <Icon name="pencil" size={20} /> Catat kondisi sekarang
          </button>
        </section>
      )}

      <button
        class="summary-link"
        onClick={() => go({ name: 'record' })}
        aria-label={`${ponds.length} kolam: ${counts.critical} bahaya, ${counts.warning} perhatian, ${counts.ok} aman, ${counts.none} belum dicatat hari ini. Buka daftar kolam`}
      >
        <div class="row between" style={{ width: '100%' }}>
          <h2>{ponds.length} kolam</h2>
          <span class="label ink2">{alive ? `sekitar ${alive.toLocaleString('id-ID')} ekor` : ''}</span>
        </div>
        <div class="status-bar" style={{ width: '100%', gridTemplateColumns: groups.map((k) => `${counts[k]}fr`).join(' ') }}>
          {groups.map((k) => (
            <span key={k} style={{ background: BAR[k] }} />
          ))}
        </div>
        {counts.none < ponds.length && (
          <div class="grid3" style={{ width: '100%' }}>
            <span class="word bad">
              <Shape tone="bad" />
              {counts.critical} Bahaya
            </span>
            <span class="word warn">
              <Shape tone="warn" />
              {counts.warning} Perhatian
            </span>
            <span class="word ok">
              <Shape tone="ok" />
              {counts.ok} Aman
            </span>
          </div>
        )}
        {counts.none > 0 && (
          <span class="label ink2" style={{ fontWeight: 400 }}>
            {counts.none} belum dicatat hari ini · status muncul sesudah dicatat
          </span>
        )}
      </button>

      {shown.length > 0 ? (
        <section class="stack">
          <h2>Perlu perhatian</h2>
          {shown.map((p) => (
            <AttentionCard key={p.id} pond={p} go={go} today={state.today} />
          ))}
        </section>
      ) : never.length > 0 ? (
        never.slice(0, 2).map((p) => <UnrecordedCard key={p.id} pond={p} go={go} />)
      ) : (
        <SafeCard ponds={ponds} go={go} now={now} />
      )}

      {owner && never.length === ponds.length ? (
        <button class="btn dashed" onClick={() => go({ name: 'add-pond' })}>
          <Icon name="plus" size={20} /> Tambah kolam
        </button>
      ) : (
        <button class="go-row" style={{ color: 'var(--ink)' }} onClick={() => go({ name: 'record' })}>
          <span class="grow" style={{ display: 'flex', flexDirection: 'column' }}>
            <span class="strong">Lihat semua {ponds.length} kolam</span>
            {need.length > shown.length && <span class="label ink2">{need.length - shown.length} kolam lain juga perlu perhatian</span>}
          </span>
          <Icon name="arrow" size={20} />
        </button>
      )}

      {nowcast ? (
        <WeatherCard nowcast={nowcast} focus={focus} pond={focusPond} many={ponds.length > 1} onRetry={onRetryWeather} onPlace={() => go({ name: 'profile' })} />
      ) : (
        <p class="label ink2">Memuat cuaca…</p>
      )}

      <button class="card" style={{ border: 0, flexDirection: 'row', alignItems: 'center', gap: 12, textAlign: 'left' }} onClick={() => go({ name: 'rewards' })}>
        <span class="icon-box">
          <Icon name="flame" />
        </span>
        <span class="grow stack-xs">
          <span class="strong">{state.streak > 0 ? `${state.streak} hari mencatat beruntun` : 'Mulai catat tiap hari'}</span>
          <span class="label ink2">Lihat hadiah rajin mencatat</span>
        </span>
        <Icon name="next" />
      </button>

      <button class="go-row" style={{ color: 'var(--ink)', paddingLeft: 16 }} onClick={() => go({ name: 'help' })}>
        <span style={{ color: 'var(--accent)', display: 'flex' }}>
          <Icon name="headset" />
        </span>
        <span class="grow" style={{ display: 'flex', flexDirection: 'column' }}>
          <span class="strong">Hubungi bantuan</span>
          <span class="label ink2">Ada kendala? Tim Synteel membalas lewat WhatsApp</span>
        </span>
        <span class="muted" style={{ display: 'flex' }}>
          <Icon name="next" size={20} />
        </span>
      </button>
    </div>
  );
}

const levelWord = { ok: 'Aman', warning: 'Perhatian', critical: 'Bahaya' } as const;
const lowerFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

/** The first suggested check after `t` on any pond, for the "Lalu …" line. */
function laterCheck(nowcast: NowcastState | null, t: number) {
  const all = (nowcast?.ponds ?? []).flatMap((nc) => nc.checks.filter((c) => c.t > t));
  all.sort((a, b) => a.t - b.t);
  return all[0] ?? null;
}
