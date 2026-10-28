import { useCallback, useEffect, useState } from 'preact/hooks';
import { api, type FarmState, type NowcastState } from './api.ts';
import { PondDetail } from './screens/pond.tsx';
import { Problem } from './screens/problem.tsx';
import { Profile, Rewards } from './screens/profile.tsx';
import { Record } from './screens/record.tsx';
import { AddPond, FarmSetup, NoPonds } from './screens/setup.tsx';
import { Today } from './screens/today.tsx';
import { Watch } from './screens/watch.tsx';
import { Icon, type IconName } from './ui.tsx';

export type Route =
  | { name: 'today' }
  | { name: 'pond'; id: number }
  | { name: 'add-pond' }
  | { name: 'record'; pondId?: number }
  | { name: 'watch' }
  | { name: 'problem'; pondId?: number }
  | { name: 'profile' }
  | { name: 'rewards' };

export type Go = (r: Route) => void;

const tabs: { name: 'today' | 'record' | 'watch' | 'problem'; label: string; icon: IconName }[] = [
  { name: 'today', label: 'Beranda', icon: 'home' },
  { name: 'record', label: 'Catat', icon: 'pencil' },
  { name: 'watch', label: 'Waspada', icon: 'eye' },
  { name: 'problem', label: 'Masalah', icon: 'alert' },
];

const tabOf = (r: Route) => (r.name === 'pond' || r.name === 'add-pond' || r.name === 'profile' || r.name === 'rewards' ? 'today' : r.name);

export function App() {
  const [state, setState] = useState<FarmState | null>(null);
  const [error, setError] = useState('');
  const [route, setRoute] = useState<Route>({ name: 'today' });
  const [nowcast, setNowcast] = useState<NowcastState | null>(null);

  const refresh = useCallback(() => {
    api.farm().then(
      (s) => {
        setState(s);
        setError('');
      },
      (e) => setError(e.message),
    );
    // The estimate is a bonus: if it fails, the rest of the app still works.
    api.nowcast().then(setNowcast, () => {});
  }, []);

  useEffect(() => {
    refresh();
    // Keep the estimate fresh while the app stays open on the pond side.
    const timer = setInterval(() => api.nowcast().then(setNowcast, () => {}), 5 * 60_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const go: Go = (r) => {
    setRoute(r);
    window.scrollTo(0, 0);
  };

  let body;
  if (error && !state) {
    body = (
      <div class="screen">
        <p class="error">Tidak bisa terhubung ke server: {error}</p>
        <button class="btn secondary" onClick={refresh}>
          Coba lagi
        </button>
      </div>
    );
  } else if (!state) {
    body = (
      <div class="screen">
        <p class="muted">Memuat…</p>
      </div>
    );
  } else if (!state.farm) {
    body = <FarmSetup onDone={refresh} />;
  } else if (route.name === 'add-pond') {
    body = (
      <AddPond
        today={state.today}
        ponds={state.ponds}
        onDone={(id) => {
          refresh();
          go({ name: 'pond', id });
        }}
        onCancel={() => go({ name: 'today' })}
      />
    );
  } else if (state.ponds.length === 0) {
    body = <NoPonds farm={state.farm} onAdd={() => go({ name: 'add-pond' })} />;
  } else if (route.name === 'pond') {
    body = <PondDetail key={route.id} id={route.id} nowcast={nowcast} go={go} />;
  } else if (route.name === 'record') {
    body = <Record key={route.pondId ?? 0} ponds={state.ponds} initialPondId={route.pondId} onSaved={refresh} />;
  } else if (route.name === 'watch') {
    body = <Watch state={state} nowcast={nowcast} onChanged={refresh} go={go} />;
  } else if (route.name === 'problem') {
    body = <Problem key={route.pondId ?? 0} ponds={state.ponds} initialPondId={route.pondId} onSaved={refresh} go={go} />;
  } else if (route.name === 'profile') {
    body = <Profile state={state} go={go} />;
  } else if (route.name === 'rewards') {
    body = <Rewards state={state} go={go} />;
  } else {
    body = <Today state={state} nowcast={nowcast} go={go} onRetryWeather={refresh} />;
  }

  const ready = Boolean(state?.farm && state.ponds.length);
  const alerts = state?.ponds.some((p) => p.level === 'critical' || nowcast?.ponds.find((n) => n.pondId === p.id)?.peak.level === 'critical');

  return (
    <div class="shell">
      <main>{body}</main>
      {ready && (
        <nav class="tabs" aria-label="Menu utama">
          {tabs.map((t) => (
            <button key={t.name} class={tabOf(route) === t.name ? 'active' : ''} aria-current={tabOf(route) === t.name ? 'page' : undefined} onClick={() => go({ name: t.name })}>
              <Icon name={t.icon} />
              {t.label}
              {t.name === 'watch' && alerts && <span class="dot" aria-label="ada peringatan" />}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
