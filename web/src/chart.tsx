import { useState } from 'preact/hooks';
import type { Nowcast, NowcastPoint } from './api.ts';
import { fmtNum, riskLabel } from './labels.ts';
import { Shape, StatusPill, type Tone } from './ui.tsx';
import { LOCALE, t as tr } from './i18n.ts';

/** A status shape in the legend; sized inline because `.chart svg` stretches every svg in the figure. */
const KeyShape = ({ tone }: { tone: Tone }) => (
  <span style={{ display: 'inline-flex', width: 12, height: 12, flex: 'none' }}>
    <Shape tone={tone} />
  </span>
);

const W = 340;
const H = 196;
const PAD = { left: 30, right: 8, top: 10, bottom: 62 };
const STRIP_H = 12;
// Tick text in viewBox units: about 14 px on a phone-wide chart, the smallest size in the design.
const TICK = { fontSize: '15.4px' };

const clock = (t: number) => new Date(t).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });
const dayClock = (t: number) => new Date(t).toLocaleString(LOCALE, { weekday: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });

/**
 * Estimated water temperature from 12 hours ago to 24 hours ahead: the line is the
 * estimate (dashed once it is a forecast), the band ±1σ, dots are real readings.
 * Below it, one cell per hour for the oxygen risk. Tap or hover to read any hour.
 */
export function NowcastChart({ nc }: { nc: Nowcast }) {
  const points = nc.hours.filter((h) => h.temp !== null);
  const [active, setActive] = useState<NowcastPoint | null>(null);
  if (points.length < 2) return <p class="meta">{tr('Belum cukup data untuk grafik perkiraan.', 'Not enough data for the forecast chart yet.')}</p>;

  const t0 = nc.hours[0].t;
  const t1 = nc.hours.at(-1)!.t;
  const lo = Math.floor(Math.min(...points.map((p) => p.temp! - p.sigma!), ...nc.measurements.map((m) => m.value)) - 0.2);
  const hi = Math.ceil(Math.max(...points.map((p) => p.temp! + p.sigma!), ...nc.measurements.map((m) => m.value)) + 0.2);
  const plotBottom = H - PAD.bottom;
  const x = (t: number) => PAD.left + ((t - t0) / (t1 - t0)) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + ((hi - v) / (hi - lo)) * (plotBottom - PAD.top);

  const path = (pts: NowcastPoint[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.temp!).toFixed(1)}`).join('');
  const band =
    points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.temp! + p.sigma!).toFixed(1)}`).join('') +
    [...points].reverse().map((p) => `L${x(p.t).toFixed(1)},${y(p.temp! - p.sigma!).toFixed(1)}`).join('') +
    'Z';
  const past = points.filter((p) => p.t <= nc.now.t);
  const future = [past.at(-1)!, ...points.filter((p) => p.t > nc.now.t)].filter(Boolean);

  const step = Math.max(1, Math.round((hi - lo) / 3));
  const ticks: number[] = [];
  for (let v = lo; v <= hi; v += step) ticks.push(v);
  // Clock labels every 6 hours, on farm-local hours divisible by 6.
  const clockTicks = nc.hours.filter((h) => new Date(h.t + 7 * 3600_000).getUTCHours() % 6 === 0);
  const stripY = plotBottom + 32;
  const cellW = (W - PAD.left - PAD.right) / nc.hours.length;

  const pick = (e: PointerEvent) => {
    const svg = e.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    const t = t0 + (((e.clientX - rect.left) / rect.width) * W - PAD.left) / (W - PAD.left - PAD.right) * (t1 - t0);
    setActive(nc.hours.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a)));
  };
  const shown = active ?? nc.peak;

  return (
    <figure class="chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={tr(`Perkiraan suhu air 36 jam, sekarang ${nc.now.temp ?? '-'} °C`, `Estimated water temperature over 36 hours, now ${nc.now.temp ?? '-'} °C`)}
        onPointerMove={pick}
        onPointerDown={pick}
        onPointerLeave={() => setActive(null)}
      >
        {ticks.map((v) => (
          <g key={v}>
            <line class="grid" x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} />
            <text class="tick" style={TICK} x={PAD.left - 6} y={y(v) + 5} text-anchor="end">
              {v}°
            </text>
          </g>
        ))}
        {clockTicks.map((h) => (
          <text key={h.t} class="tick" style={TICK} x={x(h.t)} y={plotBottom + 22} text-anchor="middle">
            {clock(h.t)}
          </text>
        ))}

        <path class="band" d={band} />
        <path class="est" d={path(past)} />
        <path class="est future" d={path(future)} />

        <line class="now" x1={x(nc.now.t)} x2={x(nc.now.t)} y1={PAD.top} y2={plotBottom} />
        <text class="tick now-label" style={TICK} x={x(nc.now.t) + 5} y={PAD.top + 12}>
          {tr('sekarang', 'now')}
        </text>

        {nc.measurements.map((m) => (
          <circle key={m.t} class="measured" cx={x(m.t)} cy={y(m.value)} r={4.5} />
        ))}

        {nc.hours.map((h) =>
          // The peak hour is a triangle when it is risky: the strip carries the status shape, not colour alone.
          h.t === nc.peak.t && nc.peak.level !== 'ok' ? (
            <path
              key={h.t}
              class={`risk lv-${h.level}`}
              d={`M${x(h.t).toFixed(1)},${stripY - 1.5}L${(x(h.t) + 5.5).toFixed(1)},${stripY + STRIP_H}L${(x(h.t) - 5.5).toFixed(1)},${stripY + STRIP_H}Z`}
              stroke-linejoin="round"
            />
          ) : (
            <rect key={h.t} class={`risk lv-${h.level}`} x={x(h.t) - cellW / 2 + 1} y={stripY} width={Math.max(1, cellW - 2)} height={STRIP_H} rx={2} />
          ),
        )}
        <text class="tick" style={TICK} x={PAD.left - 8} y={stripY + 11} text-anchor="end">
          O₂
        </text>

        {active && (
          <g>
            <line class="cross" x1={x(active.t)} x2={x(active.t)} y1={PAD.top} y2={stripY + STRIP_H} />
            {active.temp !== null && <circle class="cross-dot" cx={x(active.t)} cy={y(active.temp)} r={4} />}
          </g>
        )}
      </svg>

      <figcaption class="stack-xs label" aria-live="polite">
        <span class="row between">
          <strong class="num">{active ? dayClock(shown.t) : tr(`Puncak risiko ${dayClock(shown.t)}`, `Peak risk ${dayClock(shown.t)}`)}</strong>
          <StatusPill level={shown.level}>{riskLabel[shown.level]}</StatusPill>
        </span>
        <span class="ink2">
          {[shown.temp !== null && tr(`Air ±${fmtNum(shown.temp)}\u00a0°C (±${fmtNum(shown.sigma!)})`, `Water ±${fmtNum(shown.temp)}\u00a0°C (±${fmtNum(shown.sigma!)})`), shown.factors[0]?.label].filter(Boolean).join(' · ')}
        </span>
      </figcaption>
      <p class="chart-key">
        <span class="key-line" /> {tr('perkiraan suhu air', 'estimated water temperature')} <span class="key-dot" /> {tr('hasil ukur', 'measured')}
      </p>
      <p class="chart-key" style={{ gap: '4px 12px' }}>
        <span>{tr('Pita bawah: risiko oksigen rendah per jam', 'Bottom strip: low-oxygen risk per hour')}</span>
        <span class="row" style={{ gap: 6 }}>
          <KeyShape tone="ok" /> {tr('Aman', 'Safe')}
        </span>
        <span class="row" style={{ gap: 6 }}>
          <KeyShape tone="warn" /> {tr('Perhatian', 'Caution')}
        </span>
        <span class="row" style={{ gap: 6 }}>
          <KeyShape tone="bad" /> {tr('Bahaya', 'Danger')}
          {nc.peak.level !== 'ok' ? tr(` (segitiga = puncak ${clock(nc.peak.t)})`, ` (triangle = peak at ${clock(nc.peak.t)})`) : ''}
        </span>
      </p>

      <details class="plain">
        <summary>{tr('Lihat sebagai tabel', 'View as a table')}</summary>
        <table class="table">
          <thead>
            <tr>
              <th>{tr('Jam', 'Time')}</th>
              <th>{tr('Suhu air', 'Water temperature')}</th>
              <th>{tr('Risiko', 'Risk')}</th>
            </tr>
          </thead>
          <tbody>
            {nc.hours
              .filter((h) => h.t >= nc.now.t - 3600_000)
              .filter((_, i) => i % 2 === 0)
              .map((h) => (
                <tr key={h.t}>
                  <td>{dayClock(h.t)}</td>
                  <td>{h.temp === null ? '–' : `${fmtNum(h.temp)} ±${fmtNum(h.sigma!)} °C`}</td>
                  <td>{riskLabel[h.level]}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
