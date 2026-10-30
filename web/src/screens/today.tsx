import type { FarmState, Nowcast, NowcastState, PondSummary } from '../api.ts';
import type { Go } from '../app.tsx';
import { useState } from 'preact/hooks';
import { fmtAgo, fmtClock, fmtNum, fmtTemp, greeting, phaseLabel, readingWord } from '../labels.ts';
import { EmptyState, Icon, initialOf, PondThumb, pondMeta, Shape, SimChip, StatusPill, type IconName } from '../ui.tsx';
import { alarmReason, sensorCritical, silenceSensorAlarm, useSensorRinging } from '../sensor-alarm.ts';
import { DueRechecks, useRechecks } from './recheck.tsx';
import { CaseBrief, useCases } from './case.tsx';
import { LOCALE, t } from '../i18n.ts';
import { errorWords } from '../pondprofile.tsx';
import { BmkgPanel, OutageBanner, PowerNightCard } from './power.tsx';
import './today.css';

const rank = { ok: 0, info: 0, warning: 1, critical: 2 } as const;
const SHOWN = [
  ['temperature', t('Suhu', 'Temp')],
  ['ph', 'pH'],
  ['tds', 'TDS'],
] as const;
/** Status stack bar: the status shape colours, plus grey for ponds not recorded today (no status yet). */
// Light values: #D92D20, #A86A00, #1E8A5F, #D9E1EC; the dark theme swaps them through the tokens.
const BAR = { critical: 'var(--bad-dot)', warning: 'var(--warn-dot)', ok: 'var(--ok-dot)', none: 'var(--rule)' } as const;

const fmtValue = (key: 'temperature' | 'ph' | 'tds', v: number) => (key === 'temperature' ? fmtTemp(v) : fmtNum(v));

/** Farm-time date "YYYY-MM-DD" of a timestamp. */
const ymdOf = (ms: number) => new Date(ms + 7 * 3600_000).toISOString().slice(0, 10);

/** "Dicatat 17.15" today, "Dicatat Selasa 17.15" before; never an amber colour (amber is Perhatian). */
function loggedLine(lastAt: number | null, today: string) {
  if (lastAt === null) return t('Belum pernah dicatat', 'Never recorded');
  const when = ymdOf(lastAt) === today ? fmtClock(lastAt) : fmtClock(lastAt, true);
  return t(`Dicatat ${when}`, `Recorded ${when}`);
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
        <PondThumb kind={pond.kind} pond={pond} />
        <div class="grow stack-xs">
          <span class="h2">
            {pond.name}
            <SimChip pond={pond} />
          </span>
          <span class="meta num">{pond.batch && pond.program ? `${phaseLabel[pond.batch.phase]} · ${t('minggu', 'week')} ${pond.program.week}` : pondMeta(pond)}</span>
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
      {/* The head stays as tall as the thumbnail; the eel count sits with the recording time at the foot. */}
      <div class="row between label ink2 num" style={{ width: '100%' }}>
        <span>{loggedLine(lastAt, today)}</span>
        {alive != null && <span>{t(`sekitar ${alive.toLocaleString(LOCALE)} ekor`, `about ${alive.toLocaleString(LOCALE)} ${alive === 1 ? 'eel' : 'eels'}`)}</span>}
      </div>
    </button>
  );
}

/** A pond with nothing recorded yet: no status, dashes instead of numbers. */
function UnrecordedCard({ pond, go }: { pond: PondSummary; go: Go }) {
  return (
    <button class="pond-card" onClick={() => go({ name: 'pond', id: pond.id })}>
      <div class="row top">
        <PondThumb kind={pond.kind} pond={pond} />
        <div class="grow stack-xs">
          <div class="row between" style={{ gap: 8 }}>
            <span class="h2">
              {pond.name}
              <SimChip pond={pond} />
            </span>
            <span class="label ink2" style={{ whiteSpace: 'nowrap', fontWeight: 400 }}>
              {t('Belum dicatat hari ini', 'Not recorded today')}
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
            <span class="label ink2">{t('belum diukur', 'not measured yet')}</span>
          </div>
        ))}
      </div>
      <span class="label ink2">{t('Belum pernah dicatat', 'Never recorded')}</span>
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
          <span class="h2">{t('Semua kolam aman', 'All ponds safe')}</span>
          <span class="meta">{t(`${ponds.length} kolam dalam batas baik`, `${ponds.length} ${ponds.length === 1 ? 'pond' : 'ponds'} within good limits`)}</span>
        </div>
      </div>
      <hr class="rule" />
      <div class="row">
        <PondThumb kind={oldest.kind} pond={oldest} size={48} />
        <div class="grow stack-xs">
          <span class="meta">{t('Paling lama belum dicatat', 'Longest without a record')}</span>
          <span class="strong">
            {oldest.name} · {oldest.lastLogAt ? fmtAgo(at(oldest), now) : t('belum pernah dicatat', 'never recorded')}
          </span>
        </div>
        <button class="btn compact tint" onClick={() => go({ name: 'record-pond', pondId: oldest.id })}>
          {t('Catat', 'Record')}
        </button>
      </div>
    </section>
  );
}

/** A pond fed by a Synteel device is Bahaya: say which and why, at the top of Beranda, until it recovers. */
function SensorAlarms({ ponds, go, now }: { ponds: PondSummary[]; go: Go; now: number }) {
  const ringing = useSensorRinging();
  const bad = sensorCritical(ponds);
  if (bad.length === 0) return null;
  return (
    <section class="stack-sm" aria-label={t('Alarm sensor', 'Sensor alarm')}>
      {bad.map((p, i) => (
        <div key={p.id} class="note bad sensor-alarm" role="alert">
          <Icon name="siren" />
          <span class="stack-sm grow">
            <span class="note-title">
              {t('Alarm sensor', 'Sensor alarm')}: {p.name} — {alarmReason(p)}
            </span>
            {p.lastLogAt && (
              <span>
                {now - Date.parse(p.lastLogAt) < 60_000
                  ? t('Diukur oleh sensor · baru saja', 'Measured by the sensor · just now')
                  : t(`Diukur oleh sensor · ${fmtAgo(Date.parse(p.lastLogAt), now)}`, `Measured by the sensor · ${fmtAgo(Date.parse(p.lastLogAt), now)}`)}
              </span>
            )}
            <span class="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                class="btn compact danger"
                onClick={() => {
                  silenceSensorAlarm();
                  go({ name: 'pond', id: p.id });
                }}
              >
                {t('Lihat kolam', 'View pond')} <Icon name="arrow" size={18} />
              </button>
              {ringing && i === 0 && (
                <button type="button" class="btn compact secondary" onClick={silenceSensorAlarm}>
                  {t('Matikan bunyi', 'Stop the sound')}
                </button>
              )}
            </span>
          </span>
        </div>
      ))}
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
  const tg = l.target;
  if (tg && ((tg.min !== undefined && value < tg.min) || (tg.max !== undefined && value > tg.max))) return 'info' as const;
  return 'ok' as const;
}

function WeatherCard({
  nowcast,
  focus,
  pond,
  many,
  onRetry,
  onPlace,
  owner,
  onWeatherChanged,
}: {
  nowcast: NowcastState;
  focus: Nowcast | undefined;
  pond: PondSummary | undefined;
  /** More than one pond: name the pond the forecast is for. */
  many: boolean;
  onRetry: () => void;
  onPlace: () => void;
  /** Owners may change the BMKG village ("Ganti wilayah"). */
  owner: boolean;
  onWeatherChanged: () => void;
}) {
  const [why, setWhy] = useState(false);
  const w = nowcast.weather;
  if (!w.available || w.hours.length === 0) {
    const noPlace = w.error === 'Lokasi tambak belum diatur' || w.error === 'Farm location not set';
    return (
      <EmptyState
        icon="cloud"
        text={
          noPlace
            ? t('Atur lokasi tambak supaya cuaca dan suhu air bisa diperkirakan.', 'Set the farm location so the weather and water temperature can be estimated.')
            : t('Cuaca belum termuat; perkiraan memakai data terakhir.', 'The weather has not loaded; estimates use the latest data.')
        }
        action={
          <button class="btn secondary" onClick={noPlace ? onPlace : onRetry}>
            {noPlace ? t('Atur lokasi tambak', 'Set the farm location') : t('Coba lagi', 'Try again')}
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
    ? t(`Hujan sekitar jam ${fmtClock(rainy.t)}. Jaga supaya air hujan tidak masuk kolam, lalu ukur TDS sesudahnya.`, `Rain around ${fmtClock(rainy.t)}. Keep rainwater out of the ponds, then measure TDS afterwards.`)
    : hot >= 32
      ? t(`Siang panas sampai ${fmtTemp(Math.round(hot))}. Pastikan peneduh terpasang dan ukur suhu air sore.`, `Hot day, up to ${fmtTemp(Math.round(hot))}. Make sure the shade is up and measure the water temperature in the afternoon.`)
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
      <span class="label ink2">{t('Cuaca tambak', 'Farm weather')}{w.place ? ` · ${w.place}` : ''}</span>
      {water?.temp != null && (
        <div class="stack-sm">
          <span class="label semi ink2">
            {many && pond
              ? t(`Perkiraan suhu air ${pond.name} jam ${fmtClock(water.t)}`, `Estimated water temperature in ${pond.name} at ${fmtClock(water.t)}`)
              : t(`Perkiraan suhu air kolam jam ${fmtClock(water.t)}`, `Estimated pond water temperature at ${fmtClock(water.t)}`)}
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
          {focus?.basis.thermal && <span class="label ink2">{errorWords(focus.basis.thermal, true)}</span>}
        </div>
      )}
      <div class="row" style={{ gap: 8, ...(water?.temp != null ? { borderTop: '1px solid var(--line)', paddingTop: 16 } : {}) }}>
        <span style={{ color: nowH.rain >= 0.5 ? 'var(--accent)' : 'var(--ink-2)', display: 'flex' }}>
          <Icon name={icon(nowH)} />
        </span>
        <span class="num" style={{ fontSize: '1.125rem', fontWeight: 800, whiteSpace: 'nowrap' }}>
          {fmtTemp(Math.round(nowH.airTemp))}
        </span>
        <span class="label ink2">
          {t('suhu udara', 'air temperature')}
          {rainy ? t(` · hujan sekitar ${fmtClock(rainy.t)}`, ` · rain around ${fmtClock(rainy.t)}`) : ''}
        </span>
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
      {w.bmkg && <BmkgPanel bmkg={w.bmkg} owner={owner} onChanged={onWeatherChanged} />}
      <button type="button" class="link-btn row" style={{ alignSelf: 'flex-start', gap: 8, fontWeight: 800 }} aria-expanded={why} onClick={() => setWhy(!why)}>
        {t('Kenapa?', 'Why?')}
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
              <svg width="56" height="56" viewBox="0 0 64 64" role="img" aria-label={t(`Perkiraan cocok ${good} dari ${fit.length} kali`, `Estimate matched ${good} of ${fit.length} times`)} style={{ flex: 'none' }}>
                <circle cx="32" cy="32" r="26" fill="none" style={{ stroke: 'var(--tint)' }} stroke-width="8" />
                <circle cx="32" cy="32" r="26" fill="none" style={{ stroke: 'var(--accent)' }} stroke-width="8" stroke-linecap="round" stroke-dasharray={`${(good / fit.length) * circumference} ${circumference}`} transform="rotate(-90 32 32)" />
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
              <span class="strong">{fit.length >= 3
                  ? good / fit.length >= 0.7
                    ? t('Perkiraan bisa dipercaya', 'The estimate can be trusted')
                    : t('Perkiraan masih sering meleset', 'The estimate is still often off')
                  : t('Perkiraan sedang belajar', 'The estimate is still learning')}</span>
              <span class="label ink2">
                {fit.length >= 3
                  ? t(
                      `${good} dari ${fit.length} ukuran suhu terakhir cocok dengan perkiraan (selisih 0,5 °C atau kurang).`,
                      `${good} of the last ${fit.length} temperature readings matched the estimate (0.5 °C off or less).`,
                    )
                  : t('Butuh beberapa ukuran suhu pagi dan sore untuk mencocokkan cuaca dengan kolam.', 'It needs a few morning and afternoon temperature readings to match the weather to the pond.')}
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
  onWeatherChanged,
}: {
  state: FarmState;
  userName: string;
  nowcast: NowcastState | null;
  go: Go;
  onRetryWeather: () => void;
  /** The owner changed the BMKG village: reload the estimate. */
  onWeatherChanged: () => void;
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
  // Open dead-eel cases, reloaded with the farm.
  const cases = useCases(undefined, state);
  const soon = rechecks.soon[0];
  const alive = ponds.reduce((s, p) => s + (p.program?.estimatedAlive ?? 0), 0);
  const groups = (['critical', 'warning', 'ok', 'none'] as const).filter((k) => counts[k] > 0);
  const owner = state.role === 'owner';

  // The check after the next one, and tonight's peak, in one line under the hero.
  const after = next ? laterCheck(nowcast, next.check.t) : null;
  const peak = next?.check.nc.peak;
  const peakLine = peak && peak.level !== 'ok' && peak.t > now ? t(`Puncak rawan jam ${fmtClock(peak.t)}.`, `Riskiest at ${fmtClock(peak.t)}.`) : '';
  const thenLine = [after ? t(`Lalu ${fmtClock(after.t)} ${lowerFirst(after.reason)}.`, `Then at ${fmtClock(after.t)} ${lowerFirst(after.reason)}.`) : '', peakLine].filter(Boolean).join(' ');

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
              {t('Profil dan info', 'Profile and info')} <Icon name="next" size={16} stroke={2.5} />
            </span>
          </span>
        </button>
      </header>

      <SensorAlarms ponds={ponds} go={go} now={now} />

      {nowcast?.power?.outage && <OutageBanner startedAt={nowcast.power.outage.startedAt} go={go} />}

      <DueRechecks due={rechecks.due} update={rechecks.update} go={go} />

      {cases.list.map((c) => (
        <CaseBrief key={c.id} c={c} go={go} />
      ))}

      {soon && rechecks.due.length === 0 && (
        <div class="note info" style={{ alignItems: 'center' }}>
          <Icon name="clock" />
          <span class="grow">
            {t(`Cek ulang ${soon.pondName} jam ${fmtClock(soon.dueAt)}`, `Re-check ${soon.pondName} at ${fmtClock(soon.dueAt)}`)}
          </span>
        </div>
      )}

      {/* While a re-check is due it is the single focus: the plan card waits. */}
      {rechecks.due.length > 0 ? null : next ? (
        <section class="hero">
          <div class="row top between">
            <div class="stack-sm">
              <span class="label semi" style={{ color: 'var(--on-navy-2)' }}>
                {t('Cek berikutnya', 'Next check')}
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
            {t('Lihat Waspada', 'Open Watch')} <Icon name="arrow" size={20} />
          </button>
        </section>
      ) : (
        <section class="hero">
          <span class="label semi" style={{ color: 'var(--on-navy-2)' }}>
            {t('Hari ini', 'Today')}
          </span>
          <p class="h2" style={{ color: '#fff' }}>
            {t('Catat kondisi kolam pagi dan sore supaya Synteel bisa ikut menjaga.', 'Record pond conditions morning and afternoon so Synteel can help keep watch.')}
          </p>
          <button class="btn light" onClick={() => go({ name: 'record' })}>
            <Icon name="pencil" size={20} /> {t('Catat kondisi sekarang', 'Record conditions now')}
          </button>
        </section>
      )}

      {/* Tonight's power-cut label sits with the next check: shape + word, reasons, one tap to "Listrik padam". */}
      {nowcast?.power && nowcast.power.level !== 'low' && !nowcast.power.outage && <PowerNightCard power={nowcast.power} go={go} compact />}

      <button
        class="summary-link"
        onClick={() => go({ name: 'record' })}
        aria-label={t(
          `${ponds.length} kolam: ${counts.critical} bahaya, ${counts.warning} perhatian, ${counts.ok} aman, ${counts.none} belum dicatat hari ini. Buka daftar kolam`,
          `${ponds.length} ponds: ${counts.critical} danger, ${counts.warning} caution, ${counts.ok} safe, ${counts.none} not recorded today. Open the pond list`,
        )}
      >
        <div class="row between" style={{ width: '100%' }}>
          <h2>{t(`${ponds.length} kolam`, `${ponds.length} ${ponds.length === 1 ? 'pond' : 'ponds'}`)}</h2>
          <span class="label ink2">{alive ? t(`sekitar ${alive.toLocaleString(LOCALE)} ekor`, `about ${alive.toLocaleString(LOCALE)} ${alive === 1 ? 'eel' : 'eels'}`) : ''}</span>
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
              {counts.critical} {t('Bahaya', 'Danger')}
            </span>
            <span class="word warn">
              <Shape tone="warn" />
              {counts.warning} {t('Perhatian', 'Caution')}
            </span>
            <span class="word ok">
              <Shape tone="ok" />
              {counts.ok} {t('Aman', 'Safe')}
            </span>
          </div>
        )}
        {counts.none > 0 && (
          <span class="label ink2" style={{ fontWeight: 400 }}>
            {t(`${counts.none} belum dicatat hari ini · status muncul sesudah dicatat`, `${counts.none} not recorded today · status shows once recorded`)}
          </span>
        )}
      </button>

      {shown.length > 0 ? (
        <section class="stack">
          <h2>{t('Perlu perhatian', 'Needs attention')}</h2>
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
          <Icon name="plus" size={20} /> {t('Tambah kolam', 'Add a pond')}
        </button>
      ) : (
        <button class="go-row" style={{ color: 'var(--ink)' }} onClick={() => go({ name: 'record' })}>
          <span class="grow" style={{ display: 'flex', flexDirection: 'column' }}>
            <span class="strong">{t(`Lihat semua ${ponds.length} kolam`, `See all ${ponds.length} ponds`)}</span>
            {need.length > shown.length && <span class="label ink2">
                {t(
                  `${need.length - shown.length} kolam lain juga perlu perhatian`,
                  need.length - shown.length === 1 ? '1 other pond also needs attention' : `${need.length - shown.length} other ponds also need attention`,
                )}
              </span>}
          </span>
          <Icon name="arrow" size={20} />
        </button>
      )}

      {nowcast ? (
        <WeatherCard nowcast={nowcast} focus={focus} pond={focusPond} many={ponds.length > 1} onRetry={onRetryWeather} onPlace={() => go({ name: 'profile' })} owner={owner} onWeatherChanged={onWeatherChanged} />
      ) : (
        <p class="label ink2">{t('Memuat cuaca…', 'Loading the weather…')}</p>
      )}

      <button class="card" style={{ border: 0, flexDirection: 'row', alignItems: 'center', gap: 12, textAlign: 'left' }} onClick={() => go({ name: 'rewards' })}>
        <span class="icon-box">
          <Icon name="flame" />
        </span>
        <span class="grow stack-xs">
          <span class="strong">{state.streak > 0
              ? t(`${state.streak} hari mencatat beruntun`, state.streak === 1 ? '1 day of recording' : `${state.streak} days of recording in a row`)
              : t('Mulai catat tiap hari', 'Start recording every day')}</span>
          <span class="label ink2">{t('Lihat hadiah rajin mencatat', 'See the rewards for steady recording')}</span>
        </span>
        <Icon name="next" />
      </button>

      <button class="go-row" style={{ color: 'var(--ink)', paddingLeft: 16 }} onClick={() => go({ name: 'help' })}>
        <span style={{ color: 'var(--accent)', display: 'flex' }}>
          <Icon name="headset" />
        </span>
        <span class="grow" style={{ display: 'flex', flexDirection: 'column' }}>
          <span class="strong">{t('Hubungi bantuan', 'Contact support')}</span>
          <span class="label ink2">{t('Ada kendala? Tim Synteel membalas lewat email', 'Having trouble? The Synteel team replies by e-mail')}</span>
        </span>
        <span class="muted" style={{ display: 'flex' }}>
          <Icon name="next" size={20} />
        </span>
      </button>
    </div>
  );
}

const levelWord = { ok: t('Aman', 'Safe'), warning: t('Perhatian', 'Caution'), critical: t('Bahaya', 'Danger') };
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** The first suggested check after `t` on any pond, for the "Lalu …" line. */
function laterCheck(nowcast: NowcastState | null, after: number) {
  const all = (nowcast?.ponds ?? []).flatMap((nc) => nc.checks.filter((c) => c.t > after));
  all.sort((a, b) => a.t - b.t);
  return all[0] ?? null;
}
