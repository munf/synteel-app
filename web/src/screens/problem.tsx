import { useEffect, useState } from 'preact/hooks';
import { api, type Behavior, type Emergency, type LogData, type PondSummary } from '../api.ts';
import type { Go } from '../app.tsx';
import { fmtClock, fmtNum } from '../labels.ts';
import { Icon, PondPicker, PondThumb, Soon, Stepper, TickBox, type IconName } from '../ui.tsx';

type Sign = 'dead' | 'surface' | 'inlet' | 'feed' | 'skin' | 'water' | 'power' | 'other';

const SIGNS: { id: Sign; label: string; icon: IconName }[] = [
  { id: 'dead', label: 'Sidat mati', icon: 'dead' },
  { id: 'surface', label: 'Naik ke permukaan', icon: 'up' },
  { id: 'inlet', label: 'Kumpul di air masuk', icon: 'inlet' },
  { id: 'feed', label: 'Tidak mau makan', icon: 'bowl' },
  { id: 'skin', label: 'Luka, bercak, jamur', icon: 'spots' },
  { id: 'water', label: 'Air berubah warna atau bau', icon: 'drop' },
  { id: 'power', label: 'Aerator atau listrik mati', icon: 'bolt' },
  { id: 'other', label: 'Lainnya', icon: 'dots' },
];

// Which emergency SOP (knowledge/emergencies.json) answers which sign. Deterministic: works without the AI.
const SOP: Partial<Record<Sign, string>> = { dead: 'low_do', surface: 'low_do', inlet: 'low_do', power: 'power_outage', water: 'heavy_rain' };

const PLAIN: Record<string, string> = {
  'Cek aerator, diffuser dan selang udara': 'Cek aerator, batu aerasi dan selang udara',
  'Tambah aerasi atau oksigen darurat': 'Nyalakan aerator cadangan atau oksigen darurat kalau ada',
  'Tunda pemberian pakan': 'Jangan beri pakan dulu sampai sidat berenang normal',
};

interface Report {
  pond: PondSummary;
  signs: Sign[];
  dead: number;
  at: number;
}

function Result({ report, emergencies, go, onBack }: { report: Report; emergencies: Emergency[]; go: Go; onBack: () => void }) {
  const [done, setDone] = useState<Record<string, boolean>>({});
  const { pond, signs } = report;
  const steps = [
    ...new Set([
      ...signs.flatMap((s) => emergencies.find((e) => e.id === SOP[s])?.operator_actions ?? []),
      ...pond.findings.filter((f) => f.level !== 'info').flatMap((f) => f.actions),
    ]),
  ]
    .map((a) => PLAIN[a] ?? a)
    .filter((a, i, all) => all.indexOf(a) === i)
    .slice(0, 5);
  if (signs.includes('skin')) steps.push('Pisahkan sidat yang luka atau berjamur ke kolam karantina');
  const count = steps.filter((s) => done[s]).length;
  const causes = pond.findings.filter((f) => f.level === 'critical' || f.level === 'warning').slice(0, 3);
  const signText = SIGNS.filter((s) => signs.includes(s.id))
    .map((s) => s.label.toLowerCase())
    .join(', ');

  const summary = [
    `Laporan ${pond.name}, ${fmtClock(report.at, true)}`,
    `Terlihat: ${signText}${report.dead ? ` (${report.dead} ekor mati)` : ''}`,
    ...(['temperature', 'ph', 'tds'] as const).filter((k) => pond.latest[k]).map((k) => `${k === 'temperature' ? 'Suhu' : k === 'ph' ? 'pH' : 'TDS'} terakhir: ${fmtNum(pond.latest[k]!.value)}`),
    count ? `Sudah dilakukan: ${steps.filter((s) => done[s]).join('; ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <div class="screen">
      <header class="row">
        <button class="icon-btn" aria-label="Kembali" onClick={onBack}>
          <Icon name="back" />
        </button>
        <PondThumb kind={pond.kind} size={48} />
        <div class="stack-xs grow">
          <h1 style={{ lineHeight: 1 }}>
            {pond.name} · {fmtClock(report.at)}
          </h1>
          <span class="meta">{signText.charAt(0).toUpperCase() + signText.slice(1)}</span>
        </div>
      </header>

      <div class="note ok">
        <Icon name="check" />
        <span class="grow">Laporan tersimpan di catatan kolam.</span>
      </div>
      <div class="note warn" style={{ alignItems: 'center' }}>
        <Icon name="chat" />
        <span class="grow">Kabar otomatis ke pemilik tambak</span>
        <Soon />
      </div>

      {steps.length > 0 && (
        <section class="hero">
          <div class="row between">
            <h2>Lakukan sekarang</h2>
            <span class="label semi" style={{ color: 'var(--on-navy-2)' }}>
              {count} dari {steps.length} selesai
            </span>
          </div>
          <span class="progress">
            <span style={{ width: `${(count / steps.length) * 100}%` }} />
          </span>
          {steps.map((s) => (
            <button
              key={s}
              role="checkbox"
              aria-checked={!!done[s]}
              onClick={() => setDone({ ...done, [s]: !done[s] })}
              style={{ display: 'flex', gap: 12, alignItems: 'center', minHeight: 64, padding: '8px 12px', border: 0, borderRadius: 16, background: 'rgba(255,255,255,0.08)', color: '#fff', textAlign: 'left' }}
            >
              <TickBox on={!!done[s]} />
              <span>{s}</span>
            </button>
          ))}
          <span class="label" style={{ color: '#9FB0CF' }}>
            Langkah ini tetap muncul walau tanpa internet.
          </span>
        </section>
      )}

      <section class="card soft-bad">
        <div class="row top">
          <span class="icon-box bad">
            <Icon name="phone" />
          </span>
          <div class="stack-xs">
            <span class="strong" style={{ color: '#7A1A10' }}>
              Minta bantuan kalau
            </span>
            <span class="label" style={{ color: '#5C1A12' }}>
              Sidat mati bertambah dalam 6 jam, atau muncul bercak, luka atau jamur. Aplikasi ini tidak memberi dosis obat.
            </span>
          </div>
        </div>
        <a class="btn danger" href={`https://wa.me/?text=${encodeURIComponent(summary)}`} target="_blank" rel="noopener">
          <Icon name="chat" size={20} /> Kirim ringkasan lewat WhatsApp
        </a>
        <div class="row between">
          <span class="btn secondary grow" aria-disabled="true" style={{ opacity: 0.7 }}>
            <Icon name="phone" size={20} /> Telepon penyuluh
          </span>
          <Soon />
        </div>
      </section>

      {signs.includes('dead') && (
        <section class="card dashed">
          <div class="row between">
            <h2>Hitung dari foto</h2>
            <Soon />
          </div>
          <p class="ink2">Foto sidat mati di baskom putih, lalu AI menghitungnya otomatis (Meta SAM 3.1).</p>
        </section>
      )}

      <section class="card">
        <h2>Kemungkinan penyebab</h2>
        {causes.length === 0 && <p class="ink2">Catatan terakhir belum menunjukkan penyebab yang jelas. Ukur suhu, pH dan TDS sekarang.</p>}
        {causes.map((f, i) => (
          <div class="row top" key={f.id}>
            <span
              style={{ width: 32, height: 32, flex: 'none', borderRadius: 12, background: i === 0 ? 'var(--navy)' : 'var(--tint)', color: i === 0 ? '#fff' : 'var(--navy)', fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              {i + 1}
            </span>
            <div class="stack-xs">
              <span class="strong">{f.title}</span>
              <span class="label ink2">{f.detail}</span>
            </div>
          </div>
        ))}
        <span class="meta">Dari catatan kolam dan aturan ambang batas. Ini saran, bukan diagnosis.</span>
      </section>

      <section class="card">
        <div class="row">
          <span class="icon-box">
            <Icon name="clock" />
          </span>
          <div class="stack-xs grow">
            <span class="strong">Cek ulang 1 jam lagi</span>
            <span class="label ink2">Sidat sudah turun dan berenang normal?</span>
          </div>
        </div>
        <button class="btn primary" onClick={() => go({ name: 'record', pondId: pond.id })}>
          Catat kondisi sekarang
        </button>
        <div class="row between">
          <span class="meta">Pengingat otomatis</span>
          <Soon />
        </div>
      </section>
    </div>
  );
}

export function Problem({ ponds, initialPondId, onSaved, go }: { ponds: PondSummary[]; initialPondId?: number; onSaved: () => void; go: Go }) {
  // No pond preselected unless the farmer came from that pond's page: the wrong pond is worse than one more tap.
  const [pondId, setPondId] = useState<number | null>(initialPondId ?? null);
  const [signs, setSigns] = useState<Sign[]>([]);
  const [dead, setDead] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [emergencies, setEmergencies] = useState<Emergency[]>([]);

  useEffect(() => {
    api.knowledge().then((k) => setEmergencies(Array.isArray(k.emergencies?.emergencies) ? k.emergencies.emergencies : []), () => {});
  }, []);

  if (report) return <Result report={report} emergencies={emergencies} go={go} onBack={() => setReport(null)} />;

  const toggle = (s: Sign) => setSigns(signs.includes(s) ? signs.filter((x) => x !== s) : [...signs, s]);

  const submit = async () => {
    if (pondId === null) return;
    setBusy(true);
    setError('');
    const behavior: Behavior[] = [];
    if (signs.includes('surface')) behavior.push('surfacing');
    if (signs.includes('inlet')) behavior.push('gathering_inlet');
    if (signs.includes('feed')) behavior.push('not_eating');
    const data: LogData = {
      behavior: behavior.length ? behavior : undefined,
      mortality: signs.includes('dead') ? dead : undefined,
      aeration: signs.includes('power') ? 'off' : undefined,
      note:
        'Laporan masalah: ' +
        SIGNS.filter((s) => signs.includes(s.id))
          .map((s) => s.label.toLowerCase())
          .join(', '),
    };
    try {
      const { pond } = await api.addLog(pondId, data);
      onSaved();
      setReport({ pond, signs, dead: signs.includes('dead') ? dead : 0, at: Date.now() });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="screen">
      <section class="stack-sm">
        <h1>Ada masalah?</h1>
        <p class="ink2">Pilih kolamnya dulu, lalu pilih yang terlihat.</p>
      </section>

      <div class="field">
        <span class="field-label">Kolam mana?</span>
        <PondPicker ponds={ponds} value={pondId} onChange={setPondId} placeholder="Pilih kolam" />
      </div>

      <div class="row between" style={{ background: 'var(--navy)', color: '#fff', borderRadius: 16, padding: '12px 16px', minHeight: 64 }}>
        <span class="row">
          <Icon name="mic" />
          <span class="strong">Ceritakan dengan suara</span>
        </span>
        <Soon />
      </div>

      <section class="stack-sm">
        <span class="field-label">Pilih yang terlihat</span>
        <div class="grid2">
          {SIGNS.map((s) => {
            const on = signs.includes(s.id);
            return (
              <button key={s.id} type="button" class={`tile${on ? ' on' : ''}`} aria-pressed={on} onClick={() => toggle(s.id)}>
                <span class="icon-box">
                  <Icon name={s.icon} />
                </span>
                <span class="tile-label">{s.label}</span>
                <TickBox on={on} />
              </button>
            );
          })}
        </div>
      </section>

      {signs.includes('dead') && (
        <div class="field">
          <span class="field-label">Berapa ekor mati?</span>
          <Stepper value={dead} onChange={(n) => setDead(Math.max(1, n))} />
          <span class="field-hint">Taruh sidat mati di baskom putih supaya mudah dihitung.</span>
        </div>
      )}

      {error && <p class="error">{error}</p>}
      <button class="btn primary" disabled={pondId === null || signs.length === 0 || busy} onClick={submit}>
        {pondId === null ? 'Pilih kolam dulu' : signs.length === 0 ? 'Pilih yang terlihat' : 'Lihat yang harus dilakukan'}
        {pondId !== null && signs.length > 0 && <Icon name="arrow" size={20} />}
      </button>
      <span class="meta center" style={{ marginTop: -12 }}>
        Laporan darurat tidak memakai jatah baca AI.
      </span>
    </div>
  );
}
