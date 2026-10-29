import { readFileSync } from 'node:fs';

const dir = new URL('../../knowledge/', import.meta.url);
const load = (name: string) => JSON.parse(readFileSync(new URL(name, dir), 'utf8'));

export const knowledge = {
  thresholds: load('thresholds.json'),
  nurseryProgram: load('nursery-program.json'),
  sop: load('sop.json'),
  alarmLevels: load('alarm-levels.json'),
  emergencies: load('emergencies.json'),
};

/** English wording of the emergency steps, for GET /knowledge with x-lang: en. */
export const emergenciesEn = load('emergencies.en.json');
