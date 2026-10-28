import type { FarmState, Nowcast, NowcastState, PondSummary } from '../api.ts';
import type { Go } from '../app.tsx';
import { fmtAgo, fmtClock, fmtNum, greeting, phaseLabel, readingWord } from '../labels.ts';
import { EmptyState, Icon, initialOf, PondThumb, pondMeta, Shape, StatusPill, type IconName } from '../ui.tsx';
import { DueRechecks, useRechecks } from './recheck.tsx';

const rank = { ok: 0, info: 0, warning: 1, critical: 2 } as const;
const SHOWN = [
  ['temperature', 'Suhu', '°'],
  ['ph', 'pH', ''],
  ['tds', 'TDS', ''],
] as const;
const BAR = { critical: '#F04438', warning: '#F0B323', ok: '#3FB984' } as const;

/** A pond that needs attention: why, and only the readings that are not good. */
function AttentionCard({ pond, go, now }: { pond: PondSummary; go: Go; now: number }) {
  const top = pond.findings.find((f) => f.level === 'critical' || f.level === 'warning');
  const lastAt = pond.lastLogAt ? Date.parse(pond.lastLogAt) : null;
  const staleH = lastAt === null ? null : (now - lastAt) / 3600_000;
  const flagged = SHOWN.flatMap(([key, label, unit]) => {
    const r = pond.latest[key];
    const status = pond.status[key];
    if (!r || !status || status === 'ok') return [];
    return [{ key, label, value: `${fmtNum(r.value)}${unit}`, word: readingWord(key, r.value, status, pond.limits[key]) }];
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
      {top && <p style={{ color: top.level === 'critical' ? '#9A2015' : '#6B4100' }}>{top.title}</p>}
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
      <span class={staleH !== null && staleH >= 12 ? 'label stale' : 'meta'}>
        {lastAt === null ? 'Belum pernah dicatat' : `Dicatat ${fmtAgo(lastAt, now)}`}
      </span>
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

function WeatherCard({ nowcast, focus, onRetry }: { nowcast: NowcastState; focus: Nowcast | undefined; onRetry: () => void }) {
  const w = nowcast.weather;
  if (!w.available || w.hours.length === 0) {
    return (
      <EmptyState
        icon="cloud"
        text={w.error === 'Lokasi tambak belum diatur' ? 'Atur lokasi tambak supaya cuaca dan suhu air bisa diperkirakan.' : 'Cuaca belum termuat; perkiraan memakai data terakhir.'}
        action={
          <button class="btn secondary" onClick={onRetry}>
            Coba lagi
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
      ? `Siang panas sampai ${Math.round(hot)}°. Pastikan peneduh terpasang dan ukur suhu air sore.`
      : null;
  const fit = focus?.basis.fit ?? [];
  const good = fit.filter((f) => Math.abs(f.error) <= 0.5).length;
  const circumference = 2 * Math.PI * 26;

  return (
    <section class="card">
      <div class="row top between">
        <div class="stack-xs">
          <span class="meta">Cuaca tambak{w.place ? ` · ${w.place}` : ''}</span>
          <div class="row" style={{ gap: 8 }}>
            <span style={{ color: 'var(--accent)' }}>
              <Icon name={icon(nowH)} size={40} stroke={1.8} />
            </span>
            <span class="big">{Math.round(nowH.airTemp)}°</span>
          </div>
          <span class="meta">suhu udara</span>
        </div>
        {focus?.now.temp != null && (
          <div class="box stack-xs" style={{ background: 'var(--tint)', alignItems: 'flex-end' }}>
            <span class="label ink2">Air kolam</span>
            <span class="title num">{fmtNum(Math.round(focus.now.temp * 10) / 10)}°</span>
            <span class="label ink2">perkiraan</span>
          </div>
        )}
      </div>
      <div class="hours">
        {strip.map((h) => (
          <div key={h.t} class={h.rain >= 0.5 ? 'rain' : ''}>
            <span class="meta">{fmtClock(h.t).slice(0, 2)}</span>
            <span style={{ color: h.rain >= 0.5 ? 'var(--accent)' : icon(h) === 'sun' ? '#E0A100' : 'var(--muted)' }}>
              <Icon name={icon(h)} />
            </span>
            <span class="strong num">{Math.round(h.airTemp)}°</span>
          </div>
        ))}
      </div>
      {tip && (
        <div class="note info">
          <Icon name="drop" />
          <span style={{ fontSize: '1rem' }}>{tip}</span>
        </div>
      )}
      <hr class="rule" />
      <div class="row">
        {fit.length >= 3 ? (
          <svg width="56" height="56" viewBox="0 0 64 64" role="img" aria-label={`Perkiraan cocok ${good} dari ${fit.length} kali`} style={{ flex: 'none' }}>
            <circle cx="32" cy="32" r="26" fill="none" stroke="#E3EBF7" stroke-width="8" />
            <circle cx="32" cy="32" r="26" fill="none" stroke="#2F6FE4" stroke-width="8" stroke-linecap="round" stroke-dasharray={`${(good / fit.length) * circumference} ${circumference}`} transform="rotate(-90 32 32)" />
            <text x="32" y="37" text-anchor="middle" font-size="16" font-weight="800" fill="#13203A">
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
              ? `${good} dari ${fit.length} ukuran suhu terakhir cocok dengan perkiraan (selisih 0,5° atau kurang).`
              : 'Butuh beberapa ukuran suhu pagi dan sore untuk mencocokkan cuaca dengan kolam.'}
          </span>
        </div>
      </div>
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
  const counts = { critical: 0, warning: 0, ok: 0 };
  for (const p of ponds) counts[p.level === 'critical' ? 'critical' : p.level === 'warning' ? 'warning' : 'ok']++;
  const need = byUrgency(ponds, nowcast);
  const shown = need.slice(0, 2);
  const next = nextCheck(state, nowcast);
  const focus = nowcast?.ponds.find((n) => n.pondId === (need[0] ?? ponds[0])?.id);
  const rechecks = useRechecks();
  const soon = rechecks.soon[0];
  const alive = ponds.reduce((s, p) => s + (p.program?.estimatedAlive ?? 0), 0);
  const groups = (['critical', 'warning', 'ok'] as const).filter((k) => counts[k] > 0);

  const recheckLine = soon && (
    <div class="recheck-line">
      <Icon name="clock" size={18} />
      <span>
        {next && soon.dueAt >= next.check.t ? 'Lalu cek' : 'Cek'} ulang {soon.pondName} jam {fmtClock(soon.dueAt)}
      </span>
    </div>
  );

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

      {next ? (
        <section class="hero">
          <div class="row top between">
            <div class="stack-sm">
              <span class="label semi" style={{ color: 'var(--on-navy-2)' }}>
                Cek berikutnya
              </span>
              <span class="big">{fmtClock(next.check.t)}</span>
            </div>
            {next.pond && <StatusPill level={next.check.nc.peak.level}>{next.pond.name}</StatusPill>}
          </div>
          <p>{next.check.reason}</p>
          {recheckLine}
          <button class="btn light" onClick={() => go({ name: 'watch' })}>
            Lihat rencana malam <Icon name="arrow" size={20} />
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
          {recheckLine}
          <button class="btn light" onClick={() => go({ name: 'record' })}>
            <Icon name="mic" size={20} /> Catat sekarang
          </button>
        </section>
      )}

      <button class="summary-link" onClick={() => go({ name: 'record' })} aria-label={`${ponds.length} kolam: ${counts.critical} bahaya, ${counts.warning} perhatian, ${counts.ok} aman. Buka daftar kolam`}>
        <div class="row between" style={{ width: '100%' }}>
          <h2>{ponds.length} kolam</h2>
          <span class="meta">{alive ? `sekitar ${alive.toLocaleString('id-ID')} ekor` : ''}</span>
        </div>
        <div class="status-bar" style={{ width: '100%', gridTemplateColumns: groups.map((k) => `${counts[k]}fr`).join(' ') }}>
          {groups.map((k) => (
            <span key={k} style={{ background: BAR[k] }} />
          ))}
        </div>
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
      </button>

      {shown.length > 0 ? (
        <section class="stack">
          <h2>Perlu perhatian</h2>
          {shown.map((p) => (
            <AttentionCard key={p.id} pond={p} go={go} now={now} />
          ))}
        </section>
      ) : (
        <SafeCard ponds={ponds} go={go} now={now} />
      )}

      <button class="go-row" onClick={() => go({ name: 'record' })}>
        <span class="grow" style={{ display: 'flex', flexDirection: 'column' }}>
          <span class="strong">Lihat semua {ponds.length} kolam</span>
          {need.length > shown.length && <span class="meta">{need.length - shown.length} kolam lain juga perlu perhatian</span>}
        </span>
        <Icon name="arrow" size={20} />
      </button>

      {nowcast ? <WeatherCard nowcast={nowcast} focus={focus} onRetry={onRetryWeather} /> : <p class="meta">Memuat cuaca…</p>}

      <button class="card" style={{ border: 0, flexDirection: 'row', alignItems: 'center', gap: 12, textAlign: 'left' }} onClick={() => go({ name: 'rewards' })}>
        <span class="icon-box">
          <Icon name="flame" />
        </span>
        <span class="grow stack-xs">
          <span class="strong">{state.streak > 0 ? `${state.streak} hari mencatat beruntun` : 'Mulai catat tiap hari'}</span>
          <span class="meta">Lihat hadiah rajin mencatat</span>
        </span>
        <Icon name="next" />
      </button>

      <button class="go-row" style={{ color: 'var(--ink)', paddingLeft: 16 }} onClick={() => go({ name: 'help' })}>
        <span style={{ color: 'var(--accent)', display: 'flex' }}>
          <Icon name="headset" />
        </span>
        <span class="grow" style={{ display: 'flex', flexDirection: 'column' }}>
          <span class="strong">Hubungi bantuan</span>
          <span class="meta">Ada kendala? Tim Synteel membalas lewat WhatsApp</span>
        </span>
        <span class="muted" style={{ display: 'flex' }}>
          <Icon name="next" size={20} />
        </span>
      </button>
    </div>
  );
}
