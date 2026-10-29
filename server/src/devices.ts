// Synteel devices and their simulator. A device (today only the Nursery Gen5 prototype, as a simulation on
// eel.synt.fun/sim) has a code printed on it as text and QR. Linking the code in the app ties each of the
// device's tanks to a pond; its readings then arrive as logs with source 'sensor' and go through the same rules,
// forecast, alarms and night summary as anything a farmer records.
//
// Simulated devices never touch real ponds: linking one creates new ponds for it, marked as simulation.
import type { Db } from './db.ts';
import type { LogData } from './domain.ts';
import { tx } from './i18n.ts';

export type DeviceKind = 'gen5';
export type Scenario = 'normal' | 'power_cut' | 'blower_fail' | 'heat' | 'ammonia';
export const SCENARIOS: Scenario[] = ['normal', 'power_cut', 'blower_fail', 'heat', 'ammonia'];

interface UnitSpec {
  id: string;
  name: () => string;
}
interface KindSpec {
  name: () => string;
  units: UnitSpec[];
  /** What the device measures, shown before linking. */
  sensors: () => string[];
}

export const KINDS: Record<DeviceKind, KindSpec> = {
  gen5: {
    name: () => 'Synteel Nursery Gen5',
    units: [
      { id: 'tank1', name: () => tx('Tangki 1', 'Tank 1') },
      { id: 'tank2', name: () => tx('Tangki 2', 'Tank 2') },
    ],
    sensors: () => [
      tx('Oksigen terlarut (DO)', 'Dissolved oxygen (DO)'),
      tx('Suhu', 'Temperature'),
      'pH',
      'TDS',
      tx('Amonia', 'Ammonia'),
      tx('Nitrit', 'Nitrite'),
      tx('Level air', 'Water level'),
      tx('Listrik PLN dan UPS', 'Mains power and UPS'),
      tx('Blower dan oksigen cadangan', 'Blower and backup oxygen'),
    ],
  },
};

export interface Device {
  code: string;
  kind: DeviceKind;
  simulated: boolean;
  scenario: Scenario;
  /** When the current scenario started (ms). */
  scenarioAt: number;
  createdAt: number;
  /** Last time the simulator page or the app looked at it (ms); idle simulations stop sending. */
  seenAt: number;
}

export interface DeviceLink {
  code: string;
  farmId: number;
  unit: string;
  pondId: number;
}

// ---------- simulation ----------

export interface UnitState {
  do: number;
  temperature: number;
  ph: number;
  tds: number;
  tan: number;
  no2: number;
  /** Water level, % of normal. */
  level: number;
}

export interface SimState {
  at: number;
  power: { mains: boolean; ups: boolean };
  blower: boolean;
  /** Backup oxygen valve: opens by itself when oxygen falls (the Gen5 automatic response). */
  oxygenValve: boolean;
  chiller: boolean;
  units: Record<string, UnitState>;
}

const BASE: Record<string, UnitState> = {
  tank1: { do: 7.2, temperature: 27.6, ph: 7.4, tds: 182, tan: 0.15, no2: 0.08, level: 100 },
  tank2: { do: 7.0, temperature: 27.8, ph: 7.3, tds: 176, tan: 0.18, no2: 0.1, level: 100 },
};
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Oxygen after the blower stops: falls, the backup valve opens at 4.5 mg/L, the fall overshoots, then recovers. */
function oxygenAfterStop(base: number, min: number): { value: number; valve: boolean } {
  const fall = 0.45; // mg/L per minute without aeration
  const opensAt = (base - 4.5) / fall; // minutes until the valve opens
  if (min < opensAt) return { value: base - fall * min, valve: false };
  const lag = 2; // the oxygen takes a while to reach the water
  if (min < opensAt + lag) return { value: 4.5 - fall * 0.8 * (min - opensAt), valve: true };
  const low = 4.5 - fall * 0.8 * lag;
  return { value: Math.min(6.4, low + 0.25 * (min - opensAt - lag)), valve: true };
}

/** The device's readings at `now`. Deterministic: the same moment always gives the same numbers. */
export function simulate(d: Pick<Device, 'scenario' | 'scenarioAt'>, now: number): SimState {
  const min = Math.max(0, (now - d.scenarioAt) / 60_000);
  const s = d.scenario;
  const state: SimState = {
    at: now,
    power: { mains: s !== 'power_cut', ups: s === 'power_cut' },
    blower: s !== 'power_cut' && s !== 'blower_fail',
    oxygenValve: false,
    chiller: s !== 'heat' && s !== 'power_cut',
    units: {},
  };
  for (const [unit, b] of Object.entries(BASE)) {
    // Small, slow wobble so live numbers look alive; different per tank.
    const k = unit === 'tank1' ? 0 : 1.7;
    const wobble = (amp: number, period: number) => amp * Math.sin(now / 60_000 / period + k);
    const u: UnitState = {
      do: b.do + wobble(0.08, 7),
      temperature: b.temperature + wobble(0.06, 11),
      ph: b.ph + wobble(0.02, 13),
      tds: b.tds + wobble(2, 9),
      tan: b.tan,
      no2: b.no2,
      level: 100 + wobble(0.4, 5),
    };
    if (s === 'power_cut' || s === 'blower_fail') {
      const o = oxygenAfterStop(b.do, min);
      u.do = o.value;
      state.oxygenValve ||= o.valve;
      if (s === 'power_cut') u.temperature += Math.min(1.2, 0.04 * min); // no chiller either
    }
    if (s === 'heat') {
      u.temperature = Math.min(31.8, b.temperature + 0.15 * min);
      u.do = b.do - Math.max(0, u.temperature - 28) * 0.35;
    }
    if (s === 'ammonia') {
      u.tan = Math.min(1.6, b.tan + 0.06 * min);
      u.no2 = Math.min(0.9, b.no2 + 0.025 * min);
    }
    state.units[unit] = { do: r1(Math.max(0.5, u.do)), temperature: r1(u.temperature), ph: r1(u.ph), tds: Math.round(u.tds), tan: r2(u.tan), no2: r2(u.no2), level: Math.round(u.level) };
  }
  return state;
}

/** One unit's state as a pond log. */
export function toLogData(s: SimState, unit: string): LogData {
  const u = s.units[unit];
  return {
    readings: { temperature: u.temperature, ph: u.ph, tds: u.tds, do: u.do, tan: u.tan, no2: u.no2 },
    aeration: s.blower ? 'on' : 'off',
  };
}

/** How often a linked device writes a log: often while something is happening, otherwise every 10 minutes. */
export const sendEveryMs = (d: Pick<Device, 'scenario' | 'scenarioAt'>, now: number) =>
  d.scenario !== 'normal' && now - d.scenarioAt < 45 * 60_000 ? 60_000 : 10 * 60_000;

/** Simulations nobody looked at for this long stop sending. */
export const IDLE_MS = 3 * 60 * 60_000;

// ---------- storage ----------

// Codes are read aloud and typed by hand: no 0/O, 1/I/L.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newCode(kind: DeviceKind): string {
  const pick = (n: number) => Array.from({ length: n }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
  return `${kind === 'gen5' ? 'G5' : 'SY'}-${pick(4)}-${pick(2)}`;
}
/** "g5 7kq2m4", "G5-7KQ2-M4" → "G5-7KQ2-M4". */
export function normalizeCode(raw: string): string {
  const s = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === 8 ? `${s.slice(0, 2)}-${s.slice(2, 6)}-${s.slice(6)}` : s;
}

type Row = Record<string, unknown>;
const toDevice = (r: Row): Device => ({
  code: r.code as string,
  kind: r.kind as DeviceKind,
  simulated: Boolean(r.simulated),
  scenario: r.scenario as Scenario,
  scenarioAt: r.scenario_at as number,
  createdAt: r.created_at as number,
  seenAt: r.seen_at as number,
});

export function deviceStore(db: Db) {
  db.exec(`
    create table if not exists devices (
      code text primary key,
      kind text not null,
      simulated integer not null default 1,
      scenario text not null default 'normal',
      scenario_at integer not null,
      created_at integer not null,
      seen_at integer not null
    );
    create table if not exists device_links (
      code text not null references devices(code),
      farm_id integer not null references farms(id),
      unit text not null,
      pond_id integer not null references ponds(id),
      linked_at integer not null,
      last_sent_at integer,
      primary key (code, unit)
    );
    create index if not exists device_links_pond on device_links (pond_id);
  `);
  return {
    create(kind: DeviceKind, now: number): Device {
      for (;;) {
        const code = newCode(kind);
        if (db.prepare('select 1 from devices where code = ?').get(code)) continue;
        db.prepare('insert into devices (code, kind, simulated, scenario, scenario_at, created_at, seen_at) values (?, ?, 1, ?, ?, ?, ?)').run(code, kind, 'normal', now, now, now);
        return this.get(code)!;
      }
    },
    get(code: string): Device | null {
      const r = db.prepare('select * from devices where code = ?').get(normalizeCode(code)) as Row | undefined;
      return r ? toDevice(r) : null;
    },
    seen(code: string, now: number) {
      db.prepare('update devices set seen_at = ? where code = ?').run(now, code);
    },
    setScenario(code: string, scenario: Scenario, now: number) {
      db.prepare('update devices set scenario = ?, scenario_at = ?, seen_at = ? where code = ?').run(scenario, now, now, code);
    },
    links(code: string): DeviceLink[] {
      return (db.prepare('select * from device_links where code = ? order by unit').all(code) as Row[]).map((r) => ({
        code: r.code as string,
        farmId: r.farm_id as number,
        unit: r.unit as string,
        pondId: r.pond_id as number,
      }));
    },
    link(l: DeviceLink, now: number) {
      db.prepare('insert into device_links (code, farm_id, unit, pond_id, linked_at) values (?, ?, ?, ?, ?)').run(l.code, l.farmId, l.unit, l.pondId, now);
    },
    unlink(code: string) {
      db.prepare('delete from device_links where code = ?').run(code);
    },
    /** The link of one pond, with its device. */
    forPond(pondId: number): (DeviceLink & { device: Device }) | null {
      const r = db.prepare('select l.*, d.* from device_links l join devices d on d.code = l.code where l.pond_id = ?').get(pondId) as Row | undefined;
      return r ? { code: r.code as string, farmId: r.farm_id as number, unit: r.unit as string, pondId: r.pond_id as number, device: toDevice(r) } : null;
    },
    /** Every link whose device was looked at recently, with when it last sent. */
    active(now: number): (DeviceLink & { device: Device; lastSentAt: number | null })[] {
      return (db.prepare('select l.*, d.* from device_links l join devices d on d.code = l.code where d.seen_at >= ?').all(now - IDLE_MS) as Row[]).map((r) => ({
        code: r.code as string,
        farmId: r.farm_id as number,
        unit: r.unit as string,
        pondId: r.pond_id as number,
        lastSentAt: (r.last_sent_at as number | null) ?? null,
        device: toDevice(r),
      }));
    },
    /** Send again right away (the scenario just changed). */
    resend(code: string) {
      db.prepare('update device_links set last_sent_at = null where code = ?').run(code);
    },
    sent(code: string, unit: string, now: number) {
      db.prepare('update device_links set last_sent_at = ? where code = ? and unit = ?').run(now, code, unit);
    },
  };
}
export type DeviceStore = ReturnType<typeof deviceStore>;
