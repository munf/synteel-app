import { useEffect, useState } from 'preact/hooks';

type Tab = 'hari-ini' | 'catat' | 'waspada' | 'masalah';

const tabs: { id: Tab; label: string; blurb: string }[] = [
  { id: 'hari-ini', label: 'Hari Ini', blurb: 'Status kolam dan tugas hari ini.' },
  { id: 'catat', label: 'Catat', blurb: 'Catat lewat suara, foto, atau angka pH / TDS / suhu.' },
  { id: 'waspada', label: 'Waspada', blurb: 'Risiko malam ini dan jadwal cek malam.' },
  { id: 'masalah', label: 'Ada Masalah', blurb: 'Foto kolam, lalu langkah pertama yang harus dilakukan.' },
];

export function App() {
  const [tab, setTab] = useState<Tab>('hari-ini');
  const [serverOk, setServerOk] = useState<boolean | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((d) => setServerOk(Boolean(d.ok)))
      .catch(() => setServerOk(false));
  }, []);

  const current = tabs.find((t) => t.id === tab)!;

  return (
    <div class="shell">
      <header class="top">
        <span class="brand">Synt Eel</span>
        <span class={`dot ${serverOk ? 'ok' : serverOk === false ? 'down' : ''}`} title="Status server" />
      </header>

      <main class="screen">
        <h1>{current.label}</h1>
        <p class="muted">{current.blurb}</p>
        <p class="muted small">Sedang dibangun.</p>
      </main>

      <nav class="tabs">
        {tabs.map((t) => (
          <button key={t.id} class={t.id === tab ? 'active' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
