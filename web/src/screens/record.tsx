import { useState } from 'preact/hooks';
import { api, type Behavior, type LogData, type PondSummary } from '../api.ts';
import { behaviorLabel, colorLabel, leftoverLabel, smellLabel } from '../labels.ts';
import { Chips, Field, FindingCard, LevelBadge } from '../ui.tsx';

type Leftover = keyof typeof leftoverLabel;
type Color = keyof typeof colorLabel;
type Smell = keyof typeof smellLabel;

// Accept both "27,5" and "27.5": farmers' phones often default to a comma keypad.
const parseNum = (s: string) => (s.trim() === '' ? undefined : Number(s.replace(',', '.')));

export function Record({ ponds, initialPondId, onSaved }: { ponds: PondSummary[]; initialPondId?: number; onSaved: () => void }) {
  const [pondId, setPondId] = useState<string[]>(initialPondId ? [String(initialPondId)] : ponds[0] ? [String(ponds[0].id)] : []);
  const [temperature, setTemperature] = useState('');
  const [ph, setPh] = useState('');
  const [tds, setTds] = useState('');
  const [mortality, setMortality] = useState(0);
  const [leftover, setLeftover] = useState<Leftover[]>([]);
  const [behavior, setBehavior] = useState<Behavior[]>([]);
  const [color, setColor] = useState<Color[]>([]);
  const [smell, setSmell] = useState<Smell[]>([]);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PondSummary | null>(null);

  const reset = () => {
    setTemperature('');
    setPh('');
    setTds('');
    setMortality(0);
    setLeftover([]);
    setBehavior([]);
    setColor([]);
    setSmell([]);
    setNote('');
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    setError('');
    const readings = { temperature: parseNum(temperature), ph: parseNum(ph), tds: parseNum(tds) };
    if (Object.values(readings).some((v) => v !== undefined && Number.isNaN(v))) {
      setError('Angka pengukuran tidak valid');
      return;
    }
    const data: LogData = {
      readings: Object.fromEntries(Object.entries(readings).filter(([, v]) => v !== undefined)),
      mortality: mortality || undefined,
      feeding: leftover[0] ? { leftover: leftover[0] } : undefined,
      behavior: behavior.length ? behavior : undefined,
      water: color[0] || smell[0] ? { color: color[0], smell: smell[0] } : undefined,
      note: note || undefined,
    };
    setBusy(true);
    try {
      const { pond } = await api.addLog(Number(pondId[0]), data);
      setResult(pond);
      reset();
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div class="screen stack">
        <div>
          <p class="eyebrow">Tersimpan</p>
          <div class="pond-head">
            <h1>{result.name}</h1>
            <LevelBadge level={result.level} />
          </div>
        </div>
        {result.findings.length === 0 ? (
          <p class="muted">Tidak ada peringatan. Kolam aman berdasarkan catatan ini.</p>
        ) : (
          result.findings.map((f) => <FindingCard key={f.id} finding={f} />)
        )}
        <button class="primary" onClick={() => setResult(null)}>
          Catat lagi
        </button>
      </div>
    );
  }

  if (ponds.length === 0) return <div class="screen"><p class="muted">Tambahkan kolam dulu di Hari Ini.</p></div>;

  return (
    <form class="screen stack" onSubmit={submit}>
      <div>
        <p class="eyebrow">Catat</p>
        <h1>Kondisi kolam</h1>
        <p class="muted small">Isi yang kamu tahu saja. Catatan suara dan foto menyusul.</p>
      </div>

      <Field label="Kolam">
        <Chips options={Object.fromEntries(ponds.map((p) => [String(p.id), p.name]))} value={pondId} onChange={(v) => v.length && setPondId(v)} />
      </Field>

      <div class="grid3">
        <Field label="Suhu °C">
          <input inputMode="decimal" value={temperature} onInput={(e) => setTemperature(e.currentTarget.value)} placeholder="27,5" />
        </Field>
        <Field label="pH">
          <input inputMode="decimal" value={ph} onInput={(e) => setPh(e.currentTarget.value)} placeholder="7,4" />
        </Field>
        <Field label="TDS ppm">
          <input inputMode="numeric" value={tds} onInput={(e) => setTds(e.currentTarget.value)} placeholder="300" />
        </Field>
      </div>

      <Field label="Sidat mati (ekor)">
        <div class="stepper">
          <button type="button" onClick={() => setMortality(Math.max(0, mortality - 1))} aria-label="Kurangi">
            −
          </button>
          <output>{mortality}</output>
          <button type="button" onClick={() => setMortality(mortality + 1)} aria-label="Tambah">
            +
          </button>
        </div>
      </Field>

      <Field label="Perilaku sidat">
        <Chips options={behaviorLabel} value={behavior} onChange={setBehavior} multiple />
      </Field>
      <Field label="Sisa pakan">
        <Chips options={leftoverLabel} value={leftover} onChange={setLeftover} />
      </Field>
      <Field label="Warna air">
        <Chips options={colorLabel} value={color} onChange={setColor} />
      </Field>
      <Field label="Bau air">
        <Chips options={smellLabel} value={smell} onChange={setSmell} />
      </Field>
      <Field label="Catatan">
        <textarea rows={2} value={note} onInput={(e) => setNote(e.currentTarget.value)} placeholder="mis. habis hujan deras" />
      </Field>

      {error && <p class="error">{error}</p>}
      <button class="primary" disabled={busy || !pondId.length}>
        Simpan catatan
      </button>
    </form>
  );
}
