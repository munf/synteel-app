import type { FarmState, Nowcast, NowcastState, PondSummary } from '../api.ts';
import type { Go } from '../app.tsx';
import { fmtAgo, fmtClock, fmtNum, greeting, readingWord } from '../labels.ts';
import { EmptyState, Icon, initialOf, PondThumb, pondMeta, Shape, StatusPill, toneOf, type IconName } from '../ui.tsx';
import { Rechecks } from './recheck.tsx';

const rank = { ok: 0, info: 0, warning: 1, critical: 2 } as const;
const SHOWN = [
  ['temperature', 'Suhu', '°'],
  ['ph', 'pH', ''],
  ['tds', 'TDS', ''],
] as const;

function PondCard({ pond, go, now }: { pond: PondSummary; go: Go; now: number }) {
  const top = pond.findings.find((f) => f.level === 'critical' || f.level === 'warning');
  const lastAt = pond.lastLogAt ? Date.parse(pond.lastLogAt) : null;
  const staleH = lastAt === null ? null : (now - lastAt) / 3600_000;
  return (
    <button class="pond-card" onClick={() => go({ name: 'pond', id: pond.id })}>
      <div class="row">
        <PondThumb kind={pond.kind} />
        <div class="grow stack-xs">
          <span class="h2">{pond.name}</span>
          <span class="meta">{pondMeta(pond)}</span>
        </div>
        <StatusPill level={pond.level} />
      </div>
      {top && <p style={{ color: top.level === 'critical' ? '#9A2015' : '#6B4100' }}>{top.title}</p>}
      <div class="readings">
        {SHOWN.map(([key, label, unit]) => {
          const r = pond.latest[key];
          const w = r ? readingWord(key, r.value, pond.status[key], pond.limits[key]) : null;
          return (
            <div class="reading" key={key}>
              <span class="k">{label}</span>
              <span class="v">{r ? `${fmtNum(r.value)}${unit}` : '–'}</span>
              {w ? (
                <span class={`word ${w.tone}`}>
                  <Shape tone={w.tone} />
                  {w.text}
                </span>
              ) : (
                <span class="meta">belum diukur</span>
              )}
            </div>
          );
        })}
      </div>
      <span class={staleH !== null && staleH >= 12 ? 'label stale' : 'meta'}>
        {lastAt === null ? 'Belum pernah dicatat' : `Dicatat ${fmtAgo(lastAt, now)}`}
      </span>
    </button>
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
  const ponds = [...state.ponds].sort((a, b) => rank[b.level] - rank[a.level]);
  const counts = { critical: 0, warning: 0, ok: 0 };
  for (const p of ponds) counts[p.level === 'critical' ? 'critical' : p.level === 'warning' ? 'warning' : 'ok']++;
  const next = nextCheck(state, nowcast);
  const focus = nowcast?.ponds.find((n) => n.pondId === ponds[0]?.id);

  return (
    <div class="screen">
      <header class="row">
        <button class="avatar" style={{ border: 0 }} aria-label="Profil" onClick={() => go({ name: 'profile' })}>
          {initialOf(userName)}
        </button>
        <div class="grow stack-xs" style={{ gap: 0 }}>
          <span class="h2">
            {greeting()}, {userName}
          </span>
          <span class="meta">{state.farm?.name}</span>
        </div>
      </header>

      <Rechecks go={go} />

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
          <button class="btn light" onClick={() => go({ name: 'record' })}>
            <Icon name="mic" size={20} /> Catat sekarang
          </button>
        </section>
      )}

      <section class="stack-sm">
        <div class="row between">
          <h2>{ponds.length} kolam</h2>
          <span class="meta">
            {(() => {
              const alive = ponds.reduce((s, p) => s + (p.program?.estimatedAlive ?? 0), 0);
              return alive ? `sekitar ${alive.toLocaleString('id-ID')} ekor` : '';
            })()}
          </span>
        </div>
        <div class="status-bar" style={{ gridTemplateColumns: `repeat(${ponds.length}, minmax(0, 1fr))` }}>
          {ponds.map((p) => (
            <span key={p.id} style={{ background: p.level === 'critical' ? '#F04438' : p.level === 'warning' ? '#F0B323' : '#3FB984' }} />
          ))}
        </div>
        <div class="grid3">
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
      </section>

      {ponds.map((p) => (
        <PondCard key={p.id} pond={p} go={go} now={now} />
      ))}

      {state.role === 'owner' && (
        <button class="btn dashed" onClick={() => go({ name: 'add-pond' })}>
          <Icon name="plus" size={20} /> Tambah kolam
        </button>
      )}

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
    </div>
  );
}
