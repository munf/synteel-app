// Sensor alarms: a pond fed by a Synteel device that turns Bahaya rings once on this phone (the same tone and
// vibration as the night alarm, when alarms are on) and shows a banner on Beranda while it stays Bahaya.
// It rings again only after the pond has been out of Bahaya. Plain rules, nothing from the AI.
import { useEffect, useState } from 'preact/hooks';
import type { PondSummary, ReadingKey } from './api.ts';
import { startTone, stopTone } from './alarms.ts';
import { t } from './i18n.ts';
import { fmtNum, fmtTemp } from './labels.ts';
import { getPrefs } from './prefs.ts';

const KEY = 'synteel.sensorAlarmed';
/** The tone stops by itself after this long if nobody taps "Matikan bunyi". */
const RING_MS = 60_000;

function loadAlarmed(): Set<number> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]') as number[]);
  } catch {
    return new Set();
  }
}

let alarmed = loadAlarmed();
let ringing = false;
let stopTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify([...alarmed]));
  } catch {
    // private mode: remembered for this session only
  }
}

/** Ponds with a device that are Bahaya now: the banner on Beranda. */
export const sensorCritical = (ponds: PondSummary[]) => ponds.filter((p) => p.device && p.level === 'critical');

/** Called with every new farm state: ring for ponds that just turned Bahaya, forget ponds that recovered. */
export function checkSensorAlarms(ponds: PondSummary[] | undefined) {
  if (!ponds) return;
  const critical = new Set(sensorCritical(ponds).map((p) => p.id));
  let fresh = false;
  for (const id of critical) {
    if (!alarmed.has(id)) {
      alarmed.add(id);
      fresh = true;
    }
  }
  for (const id of [...alarmed]) {
    // Out of Bahaya (or no longer on this farm's list): may ring again next time.
    if (!critical.has(id)) alarmed.delete(id);
  }
  save();
  if (fresh && getPrefs().alarms) ring();
  else if (critical.size === 0 && ringing) silenceSensorAlarm();
}

function ring() {
  startTone();
  ringing = true;
  if (stopTimer) clearTimeout(stopTimer);
  stopTimer = setTimeout(silenceSensorAlarm, RING_MS);
  changed();
}

export function silenceSensorAlarm() {
  if (!ringing) return;
  stopTone();
  ringing = false;
  if (stopTimer) clearTimeout(stopTimer);
  stopTimer = null;
  changed();
}

/** True while the sensor alarm tone is sounding (the banner shows "Matikan bunyi"). */
export function useSensorRinging(): boolean {
  const [on, setOn] = useState(ringing);
  useEffect(() => {
    const l = () => setOn(ringing);
    listeners.add(l);
    l();
    return () => void listeners.delete(l);
  }, []);
  return on;
}

const SENSOR_WORD: Partial<Record<ReadingKey, () => string>> = {
  do: () => t('oksigen', 'oxygen'),
  temperature: () => t('suhu', 'temperature'),
  ph: () => 'pH',
  tds: () => 'TDS',
  tan: () => t('amonia', 'ammonia'),
  no2: () => t('nitrit', 'nitrite'),
};
const UNIT: Partial<Record<ReadingKey, string>> = { do: ' mg/L', tan: ' mg/L', no2: ' mg/L', tds: ' ppm' };

/** "oksigen 3,6 mg/L": the reading behind the pond's worst finding, or the finding's own words. */
export function alarmReason(p: PondSummary): string {
  const f = p.findings.find((x) => x.level === 'critical');
  const key = f?.id.match(/^threshold:([a-z0-9]+)/)?.[1] as ReadingKey | undefined;
  const r = key && p.latest[key];
  if (key && r && SENSOR_WORD[key]) return `${SENSOR_WORD[key]!()} ${key === 'temperature' ? fmtTemp(r.value) : fmtNum(Math.round(r.value * 100) / 100) + (UNIT[key] ?? '')}`;
  return f ? f.title.charAt(0).toLowerCase() + f.title.slice(1) : t('kondisi bahaya', 'danger');
}
