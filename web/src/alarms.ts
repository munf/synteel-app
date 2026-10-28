// Night-check alarms. A web page can only ring while it is open (in front or in a background
// tab), so this is honest about it: while Synteel is open, tonight's checks marked as alarms
// open the full-screen alarm at their time, with a loud tone, vibration and a notification
// when the phone allows it. Nothing here depends on the AI: the checks come from the rules
// (plus any the briefing added), and the timing is plain clock arithmetic.
import { useEffect, useState } from 'preact/hooks';
import { api, type Briefing, type NowcastState, type PondSummary } from './api.ts';
import type { Go } from './app.tsx';
import { fmtClock } from './labels.ts';

export interface ArmedCheck {
  /** Same key as the Jadwal cek tick: `${pondId}-${t}`. */
  key: string;
  t: number;
  pondId: number;
  pondName: string;
  action: string;
  alarm: boolean;
  /** The pond's worst hour tonight, for the line under the alarm card. */
  peak: { t: number; level: 'ok' | 'warning' | 'critical' } | null;
}

/** One check tonight, for one pond: from the rules, or added by the briefing agent. */
export interface NightCheck extends ArmedCheck {
  /** What the rules or the agent said, in full (the action above is the short form). */
  reason: string;
  agent: boolean;
  /** The agent's reason for adding it. */
  why?: string;
}

const HOUR = 3600_000;

// The rules' routine checks, in the few words the schedule shows.
const ROUTINE_SHORT: Record<string, string> = {
  'Ukur suhu, pH, TDS dan amati sidat': 'Ukur suhu, pH, TDS',
  'Lihat perilaku sidat dan aerator': 'Lihat sidat dan aerator',
  'Ukur suhu, pH, TDS dan buang sisa pakan': 'Ukur suhu, pH, TDS, buang sisa pakan',
  'Pastikan aerator nyala sebelum tidur': 'Pastikan aerator nyala',
};

/** "Risiko tinggi: sidat terlihat naik …" is a reason, not something to do: turn it into the action. */
export function shortAction(reason: string): string {
  if (!/^risiko/i.test(reason)) return ROUTINE_SHORT[reason] ?? reason;
  return /naik ke permukaan|berkumpul/i.test(reason) ? 'Lihat sidat di permukaan' : 'Cek aerator dan sidat';
}

/** Tonight's checks: the briefing's when there is one (rules + agent), otherwise the rules' own. */
export function tonightChecks(briefing: Briefing | null, nowcast: NowcastState, ponds: PondSummary[], now = Date.now()): NightCheck[] {
  const raw = briefing
    ? briefing.checks.map((c) => ({ t: c.t, pondId: c.pondId, reason: c.action, alarm: c.alarm, agent: c.source === 'agent', why: c.why }))
    : nowcast.ponds.flatMap((nc) => nc.checks.map((c) => ({ t: c.t, pondId: nc.pondId, reason: c.reason, alarm: c.alarm, agent: false, why: undefined as string | undefined })));
  return raw
    .filter((c) => c.t >= now - 2 * HOUR && c.t <= now + 24 * HOUR)
    .map((c) => {
      const nc = nowcast.ponds.find((n) => n.pondId === c.pondId);
      return {
        ...c,
        key: `${c.pondId}-${c.t}`,
        pondName: ponds.find((p) => p.id === c.pondId)?.name ?? 'Kolam',
        action: shortAction(c.reason),
        peak: nc ? { t: nc.peak.t, level: nc.peak.level } : null,
      };
    })
    .sort((a, b) => a.t - b.t);
}

/**
 * Keeps tonight's alarms armed from anywhere in the app (not only while Waspada is open):
 * reads today's briefing and re-arms whenever the estimate refreshes.
 */
export function useAlarms(go: Go, nowcast: NowcastState | null, ponds: PondSummary[] | undefined) {
  useEffect(() => {
    if (!nowcast || !ponds?.length) return;
    let live = true;
    api.briefing().then(
      (r) => live && armAlarms(tonightChecks(r.briefing, nowcast, ponds), go),
      () => live && armAlarms(tonightChecks(null, nowcast, ponds), go),
    );
    return () => {
      live = false;
    };
    // `go` changes every render of the app; the alarms only need the latest one, set on each arm.
  }, [nowcast, ponds]);
}

const DONE_KEY = 'synteel.checksDone';
const SNOOZE_MS = 10 * 60_000;
/** An alarm missed by more than this (phone off, app closed) is not rung late. */
const LATE_MS = 30 * 60_000;
const TICK_MS = 10_000;

// ---------- which checks are done (shared with the Waspada screen) ----------

export function loadDone(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(DONE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

export function saveDone(done: Record<string, boolean>) {
  // Forget ticks older than two days so the list does not grow forever.
  const cutoff = Date.now() - 2 * 86400_000;
  const kept = Object.fromEntries(Object.entries(done).filter(([k, v]) => v && Number(k.split('-').at(-1)) > cutoff));
  try {
    localStorage.setItem(DONE_KEY, JSON.stringify(kept));
  } catch {
    // private mode: kept for this session by the caller's state
  }
  doneListeners.forEach((l) => l(kept));
}

export function markDone(keys: string[]) {
  const done = loadDone();
  for (const k of keys) done[k] = true;
  saveDone(done);
}

const doneListeners = new Set<(d: Record<string, boolean>) => void>();
/** Lets the Waspada list update when an alarm is answered elsewhere. */
export function onDoneChange(fn: (d: Record<string, boolean>) => void) {
  doneListeners.add(fn);
  return () => void doneListeners.delete(fn);
}

// ---------- scheduler ----------

let armed: ArmedCheck[] = [];
let navigate: Go | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
/** Alarms already rung in this session (key → time it may ring again, for snoozes). */
const rung = new Map<string, number>();
let ringing: string | null = null;

/** Tonight's checks, all of them (the alarm screen shows the next one after answering). */
export const armedChecks = () => armed;

const DUE_SOON_MS = 30 * 60_000;
/** Something to do in Waspada: a check that is due within 30 minutes (or overdue) and not ticked yet. */
export function needsAttention(checks: ArmedCheck[], done: Record<string, boolean>, now = Date.now()) {
  return checks.some((c) => !done[c.key] && c.t <= now + DUE_SOON_MS);
}

const armListeners = new Set<() => void>();
/**
 * The red dot on the Waspada tab. It used to follow pond risk alone, so it stayed on after every
 * check was done. Now it means "there is a check to do now"; a risky pond with no checks at all
 * (no estimate yet) still shows it.
 */
export function useWatchDot(ponds: PondSummary[] | undefined): boolean {
  const [, bump] = useState(0);
  useEffect(() => {
    const again = () => bump((n) => n + 1);
    armListeners.add(again);
    const off = onDoneChange(again);
    const t = setInterval(again, 30_000);
    return () => {
      armListeners.delete(again);
      off();
      clearInterval(t);
    };
  }, []);
  if (armed.length) return needsAttention(armed, loadDone());
  return !!ponds?.some((p) => p.level === 'critical');
}
export const findArmed = (at: number, pondId: number) => armed.find((c) => c.t === at && c.pondId === pondId) ?? null;

/** Replace the list of checks to watch; called whenever the plan for tonight is known again. */
export function armAlarms(checks: ArmedCheck[], go: Go) {
  queueMicrotask(() => armListeners.forEach((l) => l()));
  armed = [...checks].sort((a, b) => a.t - b.t);
  navigate = go;
  if (!timer) {
    timer = setInterval(tick, TICK_MS);
    // A phone waking up from sleep: check right away instead of waiting for the next tick.
    document.addEventListener('visibilitychange', tick);
  }
  tick();
}

function tick() {
  if (ringing || !navigate) return;
  const now = Date.now();
  const done = loadDone();
  const due = armed.find((c) => c.alarm && !done[c.key] && c.t <= now && now - c.t < LATE_MS + SNOOZE_MS && (rung.get(c.key) ?? 0) <= now);
  if (!due) return;
  ringing = due.key;
  rung.set(due.key, Infinity);
  notify(due);
  navigate({ name: 'alarm', at: due.t, pondId: due.pondId });
}

/** The alarm screen calls this when the alarm is answered or closed. */
export function alarmClosed(key: string) {
  if (ringing === key) ringing = null;
}

/** Ring again in 10 minutes even if the screen is left; returns the new time. */
export function snoozeAlarm(key: string): number {
  const until = Date.now() + SNOOZE_MS;
  rung.set(key, until);
  return until;
}

export function unsnoozeAlarm(key: string) {
  rung.set(key, Infinity);
}

// ---------- notification ----------

export const canNotify = () => typeof Notification !== 'undefined';
export const notifyPermission = () => (canNotify() ? Notification.permission : 'denied');

export async function askNotifyPermission(): Promise<NotificationPermission> {
  // Unlock audio with the same tap, so the alarm tone may play later without one.
  unlockAudio();
  if (!canNotify()) return 'denied';
  return Notification.requestPermission();
}

function notify(c: ArmedCheck) {
  if (!canNotify() || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(`Alarm cek ${fmtClock(c.t)} · ${c.pondName}`, {
      body: c.action,
      tag: 'synteel-alarm',
      requireInteraction: true,
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    // Some phones only allow notifications from a service worker; the alarm screen still opens.
  }
}

// ---------- the tone ----------

let ctx: AudioContext | null = null;
let beeper: ReturnType<typeof setInterval> | null = null;

function audio(): AudioContext | null {
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  ctx ??= new AC();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

export function unlockAudio() {
  audio();
}

/** Two short loud beeps, repeated every 1.2 s until stopped, with vibration where there is one. */
export function startTone() {
  stopTone();
  const ac = audio();
  const burst = () => {
    navigator.vibrate?.([400, 200, 400]);
    if (!ac) return;
    const t0 = ac.currentTime + 0.02;
    for (const [i, freq] of [880, 1175].entries()) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'square';
      osc.frequency.value = freq;
      const s = t0 + i * 0.3;
      gain.gain.setValueAtTime(0.0001, s);
      gain.gain.exponentialRampToValueAtTime(0.5, s + 0.02);
      gain.gain.setValueAtTime(0.5, s + 0.2);
      gain.gain.exponentialRampToValueAtTime(0.0001, s + 0.25);
      osc.connect(gain).connect(ac.destination);
      osc.start(s);
      osc.stop(s + 0.27);
    }
  };
  burst();
  beeper = setInterval(burst, 1200);
}

export function stopTone() {
  if (beeper) clearInterval(beeper);
  beeper = null;
  navigator.vibrate?.(0);
}

// ---------- icons for checks (24 grid, stroke), as in the design ----------

export const GLYPH = {
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  fan: 'M12 12c0-3 1-7 4-7s3 4 0 5.5M12 12c3 0 7 1 7 4s-4 3-5.5 0M12 12c0 3-1 7-4 7s-3-4 0-5.5M12 12c-3 0-7-1-7-4s4-3 5.5 0',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  drop: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z',
  thermo: 'M10 13.5V5a2 2 0 0 1 4 0v8.5a4 4 0 1 1-4 0z',
  rain: 'M7 15h10a4 4 0 0 0 0-8 6 6 0 0 0-11.5 1.5A3.3 3.3 0 0 0 7 15zM8 19l-1 2M12 19l-1 2M16 19l-1 2',
  cloud: 'M7 18h10a4 4 0 0 0 0-8 6 6 0 0 0-11.5 1.5A3.3 3.3 0 0 0 7 18z',
  up: 'M12 19V5M6 11l6-6 6 6',
  users: 'M9 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM2 21a7 7 0 0 1 14 0M16 4a4 4 0 0 1 0 8M18 14a6 6 0 0 1 4 7',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  speaker: 'M4 9v6h4l5 4V5L8 9zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12',
  stop: 'M7 7h10v10H7z',
  bell: 'M12 5a6 6 0 0 0-6 6v4l-2 2h16l-2-2v-4a6 6 0 0 0-6-6zM10 20a2 2 0 0 0 4 0',
  list: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
  cloudOff: 'M3 3l18 18M9 7.2A6 6 0 0 1 17 9a4 4 0 0 1 2.6 6.9M16 17H7a3.3 3.3 0 0 1-1.6-6.2',
  pin: 'M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11zM12 7.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z',
} as const;

/** An icon for what a check asks for: measure, aerator, leftover feed, or look at the eels. */
export function actionIcon(action: string): string {
  const a = action.toLowerCase();
  if (/ukur/.test(a)) return /suhu/.test(a) ? GLYPH.thermo : GLYPH.drop;
  if (/aerator|aerasi|udara/.test(a)) return GLYPH.fan;
  if (/pakan/.test(a)) return GLYPH.trash;
  if (/hujan/.test(a)) return GLYPH.rain;
  return GLYPH.eye;
}
