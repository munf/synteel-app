import { useCallback, useEffect, useState } from 'preact/hooks';
import { api, isAuthError, onSessionLost, type FarmState, type Me, type NowcastState } from './api.ts';
import { PondDetail } from './screens/pond.tsx';
import { Problem } from './screens/problem.tsx';
import { Profile, Rewards } from './screens/profile.tsx';
import { Record } from './screens/record.tsx';
import { AddPond, FarmSetup, NoPonds } from './screens/setup.tsx';
import { SignIn } from './screens/signin.tsx';
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
  | { name: 'profile'; invite?: boolean }
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
  /** undefined while checking the session; null when nobody is signed in. */
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [state, setState] = useState<FarmState | null>(null);
  const [error, setError] = useState('');
  const [route, setRoute] = useState<Route>({ name: 'today' });
  const [nowcast, setNowcast] = useState<NowcastState | null>(null);

  const signedOut = useCallback(() => {
    setMe(null);
    setState(null);
    setNowcast(null);
    setRoute({ name: 'today' });
  }, []);

  const refresh = useCallback(() => {
    api.farm().then(
      (s) => {
        setState(s);
        setError('');
        // The estimate is a bonus: if it fails, the rest of the app still works.
        if (s.farm) api.nowcast().then(setNowcast, () => {});
      },
      (e) => !isAuthError(e) && setError(e.message),
    );
  }, []);

  const loadMe = useCallback(() => {
    setError('');
    api.me().then(
      async (m) => {
        // Removed from the farm this phone had open, but still in another one: open that.
        if (!m.farm && m.farms.length) m = await api.switchFarm(m.farms[0].id).catch(() => m);
        setMe(m);
      },
      (e) => (isAuthError(e) ? signedOut() : setError(e.message)),
    );
  }, [signedOut]);

  useEffect(() => {
    // Any request that finds the session gone (PIN reset by the owner, signed out) returns to sign-in.
    onSessionLost(signedOut);
    loadMe();
    return () => onSessionLost(null);
  }, [loadMe, signedOut]);

  const userId = me?.user.id;
  const farmId = me?.farm?.id;
  useEffect(() => {
    if (userId === undefined) return;
    refresh();
    if (farmId === undefined) return;
    // Keep the estimate fresh while the app stays open on the pond side.
    const timer = setInterval(() => api.nowcast().then(setNowcast, () => {}), 5 * 60_000);
    return () => clearInterval(timer);
  }, [userId, farmId, refresh]);

  const go: Go = (r) => {
    setRoute(r);
    window.scrollTo(0, 0);
  };

  const signedIn = (m: Me) => {
    setState(null);
    setNowcast(null);
    setRoute({ name: 'today' });
    setMe(m);
    window.scrollTo(0, 0);
  };

  const switchFarm = async (id: number) => {
    const m = await api.switchFarm(id);
    signedIn(m);
  };

  const role = state?.role ?? null;
  const owner = role === 'owner';

  let body;
  if (error && (me === undefined || !state)) {
    body = (
      <div class="screen">
        <p class="error">Tidak bisa terhubung ke server: {error}</p>
        <button class="btn secondary" onClick={me ? refresh : loadMe}>
          Coba lagi
        </button>
      </div>
    );
  } else if (me === null) {
    body = <SignIn onSignedIn={signedIn} />;
  } else if (!me || !state) {
    body = (
      <div class="screen">
        <p class="muted">Memuat…</p>
      </div>
    );
  } else if (!state.farm) {
    body = <FarmSetup onDone={loadMe} onLogout={() => api.logout().catch(() => {}).then(signedOut)} />;
  } else if (route.name === 'add-pond' && owner) {
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
  } else if (route.name === 'profile') {
    body = <Profile key={farmId} state={state} me={me} go={go} invite={route.invite} onSwitch={switchFarm} onLogout={signedOut} />;
  } else if (state.ponds.length === 0) {
    body = <NoPonds farm={state.farm} userName={me.user.name} onAdd={owner ? () => go({ name: 'add-pond' }) : undefined} onProfile={() => go({ name: 'profile' })} />;
  } else if (route.name === 'pond') {
    body = <PondDetail key={route.id} id={route.id} nowcast={nowcast} go={go} />;
  } else if (route.name === 'record') {
    body = <Record key={route.pondId ?? 0} ponds={state.ponds} initialPondId={route.pondId} onSaved={refresh} />;
  } else if (route.name === 'watch') {
    body = <Watch state={state} nowcast={nowcast} onChanged={refresh} go={go} />;
  } else if (route.name === 'problem') {
    body = <Problem key={route.pondId ?? 0} ponds={state.ponds} initialPondId={route.pondId} onSaved={refresh} go={go} />;
  } else if (route.name === 'rewards') {
    body = <Rewards state={state} go={go} />;
  } else {
    body = <Today state={state} userName={me.user.name} nowcast={nowcast} go={go} onRetryWeather={refresh} />;
  }

  const ready = Boolean(me && state?.farm && state.ponds.length);
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
