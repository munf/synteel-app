import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { api, isAuthError, onSessionLost, type FarmState, type Me, type NowcastState } from './api.ts';
import { PondDetail } from './screens/pond.tsx';
import { Problem } from './screens/problem.tsx';
import { Profile, Rewards } from './screens/profile.tsx';
import { Record } from './screens/record.tsx';
import { AddPond, FarmSetup, NoPonds } from './screens/setup.tsx';
import { SignIn } from './screens/signin.tsx';
import { needsWelcome, Welcome, type SignInMode } from './screens/welcome.tsx';
import { Today } from './screens/today.tsx';
import { Watch } from './screens/watch.tsx';
import { RecordPond } from './screens/record-pond.tsx';
import { Round } from './screens/round.tsx';
import { History } from './screens/history.tsx';
import { Notebook } from './screens/notebook.tsx';
import { Quota } from './screens/quota.tsx';
import { Help } from './screens/help.tsx';
import { Alarm } from './screens/alarm.tsx';
import { ConnectDevice, formatCode } from './screens/device.tsx';
import { checkSensorAlarms } from './sensor-alarm.ts';
import { useAlarms, useWatchDot } from './alarms.ts';
import { ConnectionBanner, Icon, Notice, type IconName } from './ui.tsx';
import { t } from './i18n.ts';

export type Route =
  | { name: 'today' }
  | { name: 'pond'; id: number }
  | { name: 'add-pond' }
  | { name: 'record'; pondId?: number }
  | { name: 'watch' }
  | { name: 'problem'; pondId?: number }
  | { name: 'profile'; invite?: boolean }
  | { name: 'rewards' }
  /** Record one pond (from a row in the Catat list, or a pond page). */
  | { name: 'record-pond'; pondId: number }
  /** Check what a voice round heard; `queued` = a recording read later (offline or out of quota). */
  | { name: 'round'; queued?: string }
  /** `days`: how far back to show (notebook pages can be older than the usual 14 days). */
  | { name: 'history'; pondId: number; days?: number }
  /** Foto buku catatan: notebook page photos → rows to check; `pondId` when started from a pond. */
  | { name: 'notebook'; pondId?: number }
  | { name: 'quota' }
  | { name: 'help' }
  /** The night-check alarm, full screen. */
  | { name: 'alarm'; at: number; pondId: number }
  /** Hubungkan alat: link a Synteel device by its code (typed, scanned, or from a ?device= link). */
  | { name: 'device'; code?: string };

export type Go = (r: Route) => void;

const tabs: { name: 'today' | 'record' | 'watch' | 'problem'; label: string; icon: IconName }[] = [
  { name: 'today', label: t('Beranda', 'Home'), icon: 'home' },
  { name: 'record', label: t('Catat', 'Record'), icon: 'pencil' },
  { name: 'watch', label: t('Waspada', 'Watch'), icon: 'eye' },
  { name: 'problem', label: t('Masalah', 'Problem'), icon: 'siren' },
];

const TAB_OF: Partial<Record<Route['name'], (typeof tabs)[number]['name']>> = {
  pond: 'today', 'add-pond': 'today', profile: 'today', rewards: 'today', history: 'today', quota: 'today', help: 'today',
  'record-pond': 'record', round: 'record', device: 'record', notebook: 'record',
};

/** The simulator's QR opens …/app/?device=CODE: kept until someone is signed in to a farm, then opened. */
const linkedDevice = new URLSearchParams(location.search).get('device');

/** Drop ?device= from the address once used, so a reload does not open it again. */
function forgetDeviceParam() {
  const u = new URL(location.href);
  u.searchParams.delete('device');
  history.replaceState(history.state, '', u.pathname + u.search + u.hash);
}
const tabOf = (r: Route) => TAB_OF[r.name] ?? (r.name as (typeof tabs)[number]['name']);

export function App() {
  /** undefined while checking the session; null when nobody is signed in. */
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [state, setState] = useState<FarmState | null>(null);
  const [error, setError] = useState('');
  const [route, setRoute] = useState<Route>({ name: 'today' });
  const [nowcast, setNowcast] = useState<NowcastState | null>(null);
  /** Signed out because the session was lost (PIN reset, signed in elsewhere): Masuk says why. */
  const [ended, setEnded] = useState<{ phone: string } | null>(null);
  /** Last time the farm data loaded, for the connection banner. */
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [retrying, setRetrying] = useState(false);
  /** A retry has failed since the banner appeared: say it keeps trying by itself. */
  const [retried, setRetried] = useState(false);
  /** Sambutan on the first open on this phone; then the mode picked there opens Masuk. */
  const [welcome, setWelcome] = useState(needsWelcome);
  const [signinMode, setSigninMode] = useState<SignInMode>('login');
  /** The PIN just created on Daftar, shown once on Siapkan tambak. Kept in memory only. */
  const [newPin, setNewPin] = useState<string | null>(null);
  /** A device code from the link that opened the app, waiting for a signed-in farm. */
  const [pendingDevice, setPendingDevice] = useState<string | null>(linkedDevice);
  const meRef = useRef(me);
  meRef.current = me;

  const signedOut = useCallback(() => {
    setMe(null);
    setState(null);
    setNowcast(null);
    setNewPin(null);
    setSigninMode('login');
    setRoute({ name: 'today' });
  }, []);

  const sessionLost = useCallback(() => {
    // Only a session that existed can end; a first visit without one is just signed out.
    // The shared demo account has no PIN to type, so its number is not filled in.
    if (meRef.current) setEnded({ phone: meRef.current.demo ? '' : meRef.current.user.phone });
    signedOut();
  }, [signedOut]);

  const refresh = useCallback(
    () =>
      api.farm().then(
        (s) => {
          setState(s);
          setError('');
          setSyncedAt(Date.now());
          // The estimate is a bonus: if it fails, the rest of the app still works.
          if (s.farm) api.nowcast().then(setNowcast, () => {});
        },
        (e) => {
          if (isAuthError(e)) return;
          setError(e.message);
        },
      ),
    [],
  );

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
    onSessionLost(sessionLost);
    loadMe();
    return () => onSessionLost(null);
  }, [loadMe, sessionLost]);

  // Data on screen but the server is out of reach: retry by itself every 30 seconds,
  // and at once when the phone says it is back online.
  const offline = Boolean(error && me && state);
  const retry = useCallback(() => {
    setRetrying(true);
    refresh().finally(() => {
      setRetrying(false);
      setRetried(true);
    });
  }, [refresh]);
  useEffect(() => {
    if (!offline) return setRetried(false);
    const timer = setInterval(retry, 30_000);
    return () => clearInterval(timer);
  }, [offline, retry]);
  useEffect(() => {
    const lost = () => meRef.current && setError(t('HP tidak tersambung ke internet', 'The phone is not connected to the internet'));
    const back = () => meRef.current && refresh();
    window.addEventListener('offline', lost);
    window.addEventListener('online', back);
    return () => {
      window.removeEventListener('offline', lost);
      window.removeEventListener('online', back);
    };
  }, [refresh]);


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

  const signedIn = (m: Me, pin?: string) => {
    setNewPin(pin ?? null);
    setWelcome(false);
    setEnded(null);
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

  // Opened from a device QR link: once signed in to a farm, go straight to Hubungkan alat with the code filled in.
  const hasFarm = Boolean(me && state?.farm);
  useEffect(() => {
    if (!hasFarm || !pendingDevice) return;
    setRoute({ name: 'device', code: pendingDevice });
    setPendingDevice(null);
    forgetDeviceParam();
  }, [hasFarm, pendingDevice]);

  // Ponds fed by a Synteel device change by themselves: while one is linked and the app is in front,
  // reload the farm every 30 seconds (and at once when the app comes back to the front).
  const hasDevice = Boolean(state?.ponds.some((p) => p.device));
  useEffect(() => {
    if (!hasDevice || farmId === undefined) return;
    let live = true;
    const poll = () => {
      if (document.visibilityState !== 'visible') return;
      api.farm().then(
        (s) => {
          if (!live) return;
          setState(s);
          setSyncedAt(Date.now());
        },
        () => {},
      );
    };
    const timer = setInterval(poll, 30_000);
    document.addEventListener('visibilitychange', poll);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [hasDevice, farmId]);

  // A device pond that turns Bahaya rings once (alarms on) and shows on Beranda.
  useEffect(() => checkSensorAlarms(state?.ponds), [state]);

  const role = state?.role ?? null;
  // Night-check alarms ring from app start, on any screen, while the app is open.
  useAlarms(go, nowcast, state?.ponds);
  const owner = role === 'owner';

  let body;
  if (error && (me === undefined || !state)) {
    body = (
      <div class="screen">
        <p class="error">{t('Tidak bisa terhubung ke server', 'Cannot reach the server')}: {error}</p>
        <button class="btn secondary" onClick={me ? refresh : loadMe}>
          {t('Coba lagi', 'Try again')}
        </button>
      </div>
    );
  } else if (me === null) {
    // Help is reachable signed out too: an owner who forgot the PIN has no one else to ask.
    body =
      route.name === 'help' ? (
        <Help me={null} go={go} />
      ) : welcome && !ended ? (
        <Welcome
          onSignedIn={signedIn}
          onPick={(mode) => {
            setSigninMode(mode);
            setWelcome(false);
            window.scrollTo(0, 0);
          }}
        />
      ) : (
        <SignIn
          key={ended ? `ended:${ended.phone}` : `signin:${signinMode}`}
          initialMode={signinMode}
          onSignedIn={signedIn}
          onHelp={() => go({ name: 'help' })}
          sessionEnded={ended !== null}
          lastPhone={ended?.phone || undefined}
        />
      );
  } else if (!me || !state) {
    body = (
      <div class="screen">
        <p class="muted">{t('Memuat…', 'Loading…')}</p>
      </div>
    );
  } else if (!state.farm) {
    body = (
      <FarmSetup
        newPin={newPin ?? undefined}
        onDone={() => {
          setNewPin(null);
          loadMe();
        }}
        onLogout={() => api.logout().catch(() => {}).then(signedOut)}
        onJoined={(m) => {
          setNewPin(null);
          signedIn(m);
        }}
      />
    );
  } else if (route.name === 'add-pond' && owner) {
    body = (
      <AddPond
        onHome={() => {
          refresh();
          go({ name: 'today' });
        }}
        today={state.today}
        ponds={state.ponds}
        onDone={(id) => {
          refresh();
          go({ name: 'pond', id });
        }}
        onCancel={() => go({ name: 'today' })}
      />
    );
  } else if (route.name === 'device') {
    // Before the no-ponds screen: linking a simulated device is a way to get ponds.
    body = <ConnectDevice key={route.code ?? ''} initialCode={route.code} role={role} onLinked={refresh} go={go} />;
  } else if (route.name === 'profile') {
    body = <Profile key={farmId} state={state} me={me} go={go} invite={route.invite} onSwitch={switchFarm} onJoined={signedIn} onLogout={signedOut} onFarmChanged={refresh} />;
  } else if (state.ponds.length === 0) {
    body = <NoPonds farm={state.farm} userName={me.user.name} onAdd={owner ? () => go({ name: 'add-pond' }) : undefined} onProfile={() => go({ name: 'profile' })} />;
  } else if (route.name === 'pond') {
    body = <PondDetail key={route.id} id={route.id} nowcast={nowcast} role={role} ponds={state.ponds} onChanged={refresh} go={go} />;
  } else if (route.name === 'record') {
    body = <Record key={route.pondId ?? 0} state={state} initialPondId={route.pondId} onSaved={refresh} go={go} />;
  } else if (route.name === 'watch') {
    body = <Watch state={state} nowcast={nowcast} onChanged={refresh} go={go} />;
  } else if (route.name === 'problem') {
    body = <Problem key={route.pondId ?? 0} ponds={state.ponds} initialPondId={route.pondId} onSaved={refresh} go={go} />;
  } else if (route.name === 'rewards') {
    body = <Rewards state={state} go={go} />;
  } else if (route.name === 'record-pond') {
    body = <RecordPond key={route.pondId} ponds={state.ponds} pondId={route.pondId} onSaved={refresh} go={go} />;
  } else if (route.name === 'round') {
    body = <Round ponds={state.ponds} queued={route.queued} onSaved={refresh} go={go} />;
  } else if (route.name === 'history') {
    body = <History key={`${route.pondId}:${route.days ?? 0}`} ponds={state.ponds} pondId={route.pondId} days={route.days} role={role} onChanged={refresh} go={go} />;
  } else if (route.name === 'notebook') {
    body = <Notebook ponds={state.ponds} pondId={route.pondId} onSaved={refresh} go={go} />;
  } else if (route.name === 'quota') {
    body = <Quota role={role} go={go} />;
  } else if (route.name === 'help') {
    body = <Help me={me} go={go} />;
  } else if (route.name === 'alarm') {
    body = <Alarm ponds={state.ponds} at={route.at} pondId={route.pondId} role={role} onSaved={refresh} go={go} />;
  } else {
    body = <Today state={state} userName={me.user.name} nowcast={nowcast} go={go} onRetryWeather={refresh} />;
  }

  const ready = Boolean(me && state?.farm && state.ponds.length);
  // The red dot means a check is due now (not just that a pond is risky), so it clears once checked.
  const alerts = useWatchDot(state?.ponds);

  return (
    <div class="shell">
      <main>
        {me === null && pendingDevice && (
          <div class="conn-wrap">
            <Notice tone="info" icon="wifi" title={t(`Alat ${formatCode(pendingDevice)}`, `Device ${formatCode(pendingDevice)}`)}>
              {t('Masuk dulu. Sesudah itu alat ini langsung siap dihubungkan.', 'Sign in first. The device is then ready to connect.')}
            </Notice>
          </div>
        )}
        {offline && (
          <div class="conn-wrap">
            <ConnectionBanner since={syncedAt} retrying={retrying} stillOff={retried} onRetry={retry} />
          </div>
        )}
        {body}
      </main>
      {ready && (
        <nav class="tabs" aria-label={t('Menu utama', 'Main menu')}>
          {tabs.map((tab) => (
            <button key={tab.name} class={tabOf(route) === tab.name ? 'active' : ''} aria-current={tabOf(route) === tab.name ? 'page' : undefined} onClick={() => go({ name: tab.name })}>
              <span class="pill">
                <Icon name={tab.icon} />
                {tab.name === 'watch' && alerts && <span class="dot" aria-label={t('ada peringatan', 'warning')} />}
              </span>
              {tab.label}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
