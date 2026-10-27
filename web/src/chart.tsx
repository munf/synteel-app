import { useState } from 'preact/hooks';
import type { Nowcast, NowcastPoint } from './api.ts';
import { fmtClock, fmtNum, riskLabel } from './labels.ts';

const W = 340;
const H = 180;
const PAD = { left: 30, right: 8, top: 10, bottom: 46 };
const STRIP_H = 10;

/**
 * Estimated water temperature from 12 hours ago to 24 hours ahead: the line is the
 * estimate (dashed once it is a forecast), the band ±1σ, dots are real readings.
 * Below it, one cell per hour for the oxygen risk. Tap or hover to read any hour.
 */
export function NowcastChart({ nc }: { nc: Nowcast }) {
  const points = nc.hours.filter((h) => h.temp !== null);
  const [active, setActive] = useState<NowcastPoint | null>(null);
  if (points.length < 2) return <p class="muted small">Belum cukup data untuk grafik perkiraan.</p>;

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
  const stripY = plotBottom + 18;
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
        aria-label={`Perkiraan suhu air 36 jam, sekarang ${nc.now.temp ?? '-'} °C`}
        onPointerMove={pick}
        onPointerDown={pick}
        onPointerLeave={() => setActive(null)}
      >
        {ticks.map((v) => (
          <g key={v}>
            <line class="grid" x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} />
            <text class="tick" x={PAD.left - 6} y={y(v) + 4} text-anchor="end">
              {v}°
            </text>
          </g>
        ))}
        {clockTicks.map((h) => (
          <text key={h.t} class="tick" x={x(h.t)} y={plotBottom + 13} text-anchor="middle">
            {fmtClock(h.t)}
          </text>
        ))}

        <path class="band" d={band} />
        <path class="est" d={path(past)} />
        <path class="est future" d={path(future)} />

        <line class="now" x1={x(nc.now.t)} x2={x(nc.now.t)} y1={PAD.top} y2={plotBottom} />
        <text class="tick now-label" x={x(nc.now.t) + 4} y={PAD.top + 9}>
          sekarang
        </text>

        {nc.measurements.map((m) => (
          <circle key={m.t} class="measured" cx={x(m.t)} cy={y(m.value)} r={4.5} />
        ))}

        {nc.hours.map((h) => (
          <rect key={h.t} class={`risk lv-${h.level}`} x={x(h.t) - cellW / 2 + 1} y={stripY} width={Math.max(1, cellW - 2)} height={STRIP_H} rx={2} />
        ))}
        <text class="tick" x={PAD.left - 6} y={stripY + 9} text-anchor="end">
          O₂
        </text>

        {active && (
          <g>
            <line class="cross" x1={x(active.t)} x2={x(active.t)} y1={PAD.top} y2={stripY + STRIP_H} />
            {active.temp !== null && <circle class="cross-dot" cx={x(active.t)} cy={y(active.temp)} r={4} />}
          </g>
        )}
      </svg>

      <figcaption class="chart-readout" aria-live="polite">
        <strong>{active ? fmtClock(shown.t, true) : `Puncak risiko ${fmtClock(shown.t, true)}`}</strong>
        {shown.temp !== null && (
          <span>
            {' '}· air ±{fmtNum(shown.temp)} °C (±{fmtNum(shown.sigma!)})
          </span>
        )}
        <span class={`risk-text lv-${shown.level}`}> · {riskLabel[shown.level]}</span>
        {shown.factors[0] && <span class="muted"> · {shown.factors[0].label}</span>}
      </figcaption>
      <p class="chart-key small muted">
        <span class="key-line" /> perkiraan suhu air <span class="key-dot" /> hasil ukur <span class="key-cell lv-ok" />
        <span class="key-cell lv-warning" />
        <span class="key-cell lv-critical" /> risiko oksigen rendah, sedang, tinggi
      </p>

      <details class="small">
        <summary>Lihat sebagai tabel</summary>
        <table class="table">
          <thead>
            <tr>
              <th>Jam</th>
              <th>Suhu air</th>
              <th>Risiko</th>
            </tr>
          </thead>
          <tbody>
            {nc.hours
              .filter((h) => h.t >= nc.now.t - 3600_000)
              .filter((_, i) => i % 2 === 0)
              .map((h) => (
                <tr key={h.t}>
                  <td>{fmtClock(h.t, true)}</td>
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
