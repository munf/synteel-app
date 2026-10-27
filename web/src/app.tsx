import { useCallback, useEffect, useState } from 'preact/hooks';
import { api, type FarmState } from './api.ts';
import { PondDetail } from './screens/pond.tsx';
import { Record } from './screens/record.tsx';
import { AddPond, FarmSetup } from './screens/setup.tsx';
import { Today } from './screens/today.tsx';
import { Watch } from './screens/watch.tsx';

type Route =
  | { name: 'today' }
  | { name: 'pond'; id: number }
  | { name: 'add-pond' }
  | { name: 'record'; pondId?: number }
  | { name: 'watch' }
  | { name: 'problem' };

const tabs = [
  { name: 'today', label: 'Hari Ini' },
  { name: 'record', label: 'Catat' },
  { name: 'watch', label: 'Waspada' },
  { name: 'problem', label: 'Ada Masalah' },
] as const;

const tabOf = (r: Route) => (r.name === 'pond' || r.name === 'add-pond' ? 'today' : r.name);

export function App() {
  const [state, setState] = useState<FarmState | null>(null);
  const [error, setError] = useState('');
  const [route, setRoute] = useState<Route>({ name: 'today' });

  const refresh = useCallback(() => {
    api.farm().then(
      (s) => {
        setState(s);
        setError('');
      },
      (e) => setError(e.message),
    );
  }, []);

  useEffect(refresh, [refresh]);

  const go = (r: Route) => {
    setRoute(r);
    window.scrollTo(0, 0);
  };

  let body;
  if (error && !state) {
    body = (
      <div class="screen stack">
        <p class="error">Tidak bisa terhubung ke server: {error}</p>
        <button class="secondary" onClick={refresh}>
          Coba lagi
        </button>
      </div>
    );
  } else if (!state) {
    body = <div class="screen"><p class="muted">Memuat…</p></div>;
  } else if (!state.farm) {
    body = <FarmSetup onDone={refresh} />;
  } else if (state.ponds.length === 0 || route.name === 'add-pond') {
    body = (
      <AddPond
        today={state.today}
        onDone={(id) => {
          refresh();
          go({ name: 'pond', id });
        }}
        onCancel={state.ponds.length ? () => go({ name: 'today' }) : undefined}
      />
    );
  } else if (route.name === 'pond') {
    body = <PondDetail key={route.id} id={route.id} onBack={() => go({ name: 'today' })} onRecord={(id) => go({ name: 'record', pondId: id })} />;
  } else if (route.name === 'record') {
    body = <Record key={route.pondId ?? 0} ponds={state.ponds} initialPondId={route.pondId} onSaved={refresh} />;
  } else if (route.name === 'watch') {
    body = <Watch state={state} />;
  } else if (route.name === 'problem') {
    body = (
      <div class="screen stack">
        <p class="eyebrow">Ada Masalah</p>
        <h1>Segera hadir</h1>
        <p class="muted">Foto atau video kolam, lalu langkah pertama yang harus dilakukan.</p>
      </div>
    );
  } else {
    body = <Today state={state} onOpenPond={(id) => go({ name: 'pond', id })} onAddPond={() => go({ name: 'add-pond' })} />;
  }

  const ready = Boolean(state?.farm && state.ponds.length);
  const alerts = state?.ponds.filter((p) => p.level === 'critical').length ?? 0;

  return (
    <div class="shell">
      <header class="top">
        <span class="brand">Synt Eel</span>
      </header>
      <main>{body}</main>
      {ready && (
        <nav class="tabs">
          {tabs.map((t) => (
            <button key={t.name} class={tabOf(route) === t.name ? 'active' : ''} onClick={() => go({ name: t.name })}>
              {t.label}
              {t.name === 'watch' && alerts > 0 && <span class="count">{alerts}</span>}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
