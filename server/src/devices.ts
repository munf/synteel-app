// Synteel devices and their simulator. A device (today the Nursery Gen5, RDF Gen0 and Sensor Kit P1 prototypes, as
// simulations on eel.synt.fun/sim) has a code printed on it as text and QR. Linking the code in the app ties each of the
// device's tanks to a pond; its readings then arrive as logs with source 'sensor' and go through the same rules,
// forecast, alarms and night summary as anything a farmer records.
//
// Simulated devices never touch real ponds: linking one creates new ponds for it, marked as simulation.
import type { Db } from './db.ts';
import type { LogData } from './domain.ts';
import { tx } from './i18n.ts';

export type DeviceKind = 'gen5' | 'rdf0' | 'p1';
export type Scenario = 'normal' | 'power_cut' | 'blower_fail' | 'heat' | 'ammonia' | 'drum_jam';
export const SCENARIOS: Scenario[] = ['normal', 'power_cut', 'blower_fail', 'heat', 'ammonia', 'drum_jam'];

interface UnitSpec {
  id: string;
  name: () => string;
}
interface KindSpec {
  name: () => string;
  /** Start of the pond names it creates: "Gen5 Tangki 1". */
  short: string;
  /** First two letters of its codes. */
  prefix: string;
  units: UnitSpec[];
  /** What the device measures, shown before linking. */
  sensors: () => string[];
  /** The readings it sends to the pond. */
  readings: ReadingKey[];
  scenarios: Scenario[];
}
type ReadingKey = 'temperature' | 'ph' | 'tds' | 'do' | 'tan' | 'no2';
const ALL_READINGS: ReadingKey[] = ['temperature', 'ph', 'tds', 'do', 'tan', 'no2'];

export const KINDS: Record<DeviceKind, KindSpec> = {
  gen5: {
    name: () => 'Synteel Nursery Gen5',
    short: 'Gen5',
    prefix: 'G5',
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
    readings: ALL_READINGS,
    scenarios: ['normal', 'power_cut', 'blower_fail', 'heat', 'ammonia'],
  },
  // Rotary drum filter with built-in sensors, on one round tank: one device, one pond.
  rdf0: {
    name: () => 'Synteel RDF Gen0',
    short: 'RDF Gen0',
    prefix: 'R0',
    units: [{ id: 'tank', name: () => tx('Tangki', 'Tank') }],
    sensors: () => [
      tx('Oksigen terlarut (DO)', 'Dissolved oxygen (DO)'),
      tx('Suhu', 'Temperature'),
      'pH',
      'ORP',
      'EC/TDS',
      tx('Kekeruhan', 'Turbidity'),
      tx('Amonia (dari kualitas air)', 'Ammonia (estimated from water quality)'),
      tx('Level air kotor dan bersih', 'Dirty and clean water level'),
      tx('Drum, pompa dan pompa udara', 'Drum, pump and air pump'),
      tx('Kamera tangki', 'Tank camera'),
    ],
    readings: ALL_READINGS,
    scenarios: ['normal', 'power_cut', 'blower_fail', 'drum_jam'],
  },
  // A sensor kit on a pole for one ordinary pond: three probes (oxygen, pH, temperature) and a control box with a QR label.
  p1: {
    name: () => 'Synteel Sensor Kit P1',
    short: 'Sensor Kit P1',
    prefix: 'P1',
    units: [{ id: 'pond', name: () => tx('Kolam', 'Pond') }],
    sensors: () => [tx('Oksigen terlarut (DO)', 'Dissolved oxygen (DO)'), 'pH', tx('Suhu', 'Temperature')],
    readings: ['do', 'ph', 'temperature'],
    scenarios: ['normal', 'blower_fail', 'heat'],
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
  /** RDF only: turbidity (NTU), ORP (mV), water level before the drum (% of normal). */
  turbidity?: number;
  orp?: number;
  dirtyLevel?: number;
}

export interface SimState {
  at: number;
  power: { mains: boolean; ups: boolean };
  /** Gen5 blower, or the RDF's air pump. */
  blower: boolean;
  /** Backup oxygen valve: opens by itself when oxygen falls (the Gen5 automatic response; the RDF has none). */
  oxygenValve: boolean;
  chiller: boolean;
  /** RDF only: the drum turning, and the pump returning clean water. */
  drum?: boolean;
  pump?: boolean;
  units: Record<string, UnitState>;
}

const BASE: Record<DeviceKind, Record<string, UnitState>> = {
  gen5: {
    tank1: { do: 7.2, temperature: 27.6, ph: 7.4, tds: 182, tan: 0.15, no2: 0.08, level: 100 },
    tank2: { do: 7.0, temperature: 27.8, ph: 7.3, tds: 176, tan: 0.18, no2: 0.1, level: 100 },
  },
  rdf0: {
    tank: { do: 6.9, temperature: 27.9, ph: 7.3, tds: 190, tan: 0.16, no2: 0.09, level: 100, turbidity: 3, orp: 280, dirtyLevel: 100 },
  },
  // Only do, temperature and ph are measured; the rest never leaves the simulation.
  p1: {
    pond: { do: 6.6, temperature: 28.2, ph: 7.4, tds: 0, tan: 0, no2: 0, level: 100 },
  },
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
export function simulate(d: Pick<Device, 'scenario' | 'scenarioAt'> & { kind?: DeviceKind }, now: number): SimState {
  const kind = d.kind ?? 'gen5';
  const min = Math.max(0, (now - d.scenarioAt) / 60_000);
  const s = d.scenario;
  const rdf = kind === 'rdf0';
  const kit = kind === 'p1';
  const state: SimState = {
    at: now,
    // The Gen5 has a UPS for its controller; the RDF Gen0 has none.
    power: { mains: s !== 'power_cut', ups: !rdf && !kit && s === 'power_cut' },
    blower: s !== 'power_cut' && s !== 'blower_fail',
    oxygenValve: false,
    chiller: !rdf && !kit && s !== 'heat' && s !== 'power_cut',
    units: {},
  };
  if (rdf) {
    state.drum = s !== 'power_cut' && s !== 'drum_jam';
    state.pump = s !== 'power_cut';
  }
  for (const [unit, b] of Object.entries(BASE[kind])) {
    // Small, slow wobble so live numbers look alive; different per tank.
    const k = unit === 'tank2' ? 1.7 : 0;
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
    if (rdf) {
      u.turbidity = b.turbidity! + wobble(0.3, 6);
      u.orp = b.orp! + wobble(4, 8);
      u.dirtyLevel = 100 + wobble(0.5, 4);
    }
    if (!rdf && !kit && (s === 'power_cut' || s === 'blower_fail')) {
      const o = oxygenAfterStop(b.do, min);
      u.do = o.value;
      state.oxygenValve ||= o.valve;
      if (s === 'power_cut') u.temperature += Math.min(1.2, 0.04 * min); // no chiller either
    }
    if ((rdf || kit) && (s === 'power_cut' || s === 'blower_fail')) {
      // No backup oxygen on the RDF: oxygen keeps falling until someone acts.
      u.do = Math.max(2.6, b.do - (s === 'power_cut' ? 0.4 : 0.32) * min);
      if (s === 'power_cut') {
        // Nothing is pumped back: the tank drains a little into the filter, the filter side fills up.
        u.level = Math.max(88, 100 - 0.6 * min);
        u.dirtyLevel = Math.min(112, 100 + 0.6 * min);
      }
    }
    if (rdf && s === 'drum_jam') {
      // The drum stops, the screen clogs, dirty water backs up and overflows past the screen unfiltered.
      u.dirtyLevel = Math.min(140, 100 + 4 * min);
      u.turbidity = Math.min(28, b.turbidity! + 1.6 * min);
      u.tan = Math.min(1.5, b.tan + 0.08 * min);
      u.no2 = Math.min(0.8, b.no2 + 0.03 * min);
      u.do = Math.max(4.4, b.do - 0.1 * min);
      u.orp = Math.max(140, b.orp! - 6 * min);
    }
    if (s === 'heat') {
      u.temperature = Math.min(31.8, b.temperature + 0.15 * min);
      u.do = b.do - Math.max(0, u.temperature - 28) * 0.35;
    }
    if (s === 'ammonia') {
      u.tan = Math.min(1.6, b.tan + 0.06 * min);
      u.no2 = Math.min(0.9, b.no2 + 0.025 * min);
    }
    if (kit) {
      // Only what the kit's three probes measure.
      state.units[unit] = { do: r1(Math.max(0.5, u.do)), temperature: r1(u.temperature), ph: r1(u.ph) } as UnitState;
      continue;
    }
    state.units[unit] = {
      do: r1(Math.max(0.5, u.do)),
      temperature: r1(u.temperature),
      ph: r1(u.ph),
      tds: Math.round(u.tds),
      tan: r2(u.tan),
      no2: r2(u.no2),
      level: Math.round(u.level),
      ...(rdf && { turbidity: r1(u.turbidity!), orp: Math.round(u.orp!), dirtyLevel: Math.round(u.dirtyLevel!) }),
    };
  }
  return state;
}

/** One unit's state as a pond log: only the readings this kind of device measures. */
export function toLogData(s: SimState, unit: string, kind: DeviceKind = 'gen5'): LogData {
  const u = s.units[unit];
  const readings: NonNullable<LogData['readings']> = {};
  for (const key of KINDS[kind].readings) if (u[key] !== undefined) readings[key] = u[key];
  return { readings, aeration: s.blower ? 'on' : 'off' };
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
  return `${KINDS[kind].prefix}-${pick(4)}-${pick(2)}`;
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
