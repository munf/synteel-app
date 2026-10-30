import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { parseBmkg, type BmkgForecast, type BmkgStep } from '../src/bmkg.ts';
import { findDesa, nearestDesa, searchDesa } from '../src/desa.ts';
import { applyPower, assessPowerNight, powerBackupLabel, tonight, type StormHour } from '../src/power.ts';
import type { Nowcast, NowcastPoint } from '../src/nowcast.ts';
import type { Pond } from '../src/domain.ts';
import { guard, runBriefing, type BriefingInput } from '../src/agent.ts';
import { withLang } from '../src/i18n.ts';
import { knowledge } from '../src/knowledge.ts';
import { farmWithWorker, server } from './helpers.ts';

const H = 3600_000;
const TZ = 'Asia/Jakarta';
// 14.00 WIB: tonight is 17.00 today to 06.00 tomorrow.
const NOW = Date.parse('2026-10-28T07:00:00Z');
const at = (wib: string) => Date.parse(`2026-10-28T${wib}:00+07:00`);
const next = (wib: string) => Date.parse(`2026-10-29T${wib}:00+07:00`);

function storm(over: Partial<Record<string, Partial<StormHour>>> = {}): StormHour[] {
  const hours: StormHour[] = [];
  for (let t = NOW - 12 * H; t <= NOW + 36 * H; t += H) hours.push({ t, code: 3, cape: 800, gusts: 20, rain: 0, ...over[new Date(t).toISOString()] });
  return hours;
}
const iso = (t: number) => new Date(t).toISOString();
const step = (t: number, s: Partial<BmkgStep> = {}): BmkgStep => ({ t, code: 3, desc: 'Berawan', descEn: 'Mostly Cloudy', rain: 0, wind: 5, humidity: 80, temp: 25, cloud: 90, ...s });
const bmkgSteps = (thunderAt?: number) => [at('18:00'), at('21:00'), next('00:00'), next('03:00'), next('06:00')].map((t) => (t === thunderAt ? step(t, { code: 95, desc: 'Hujan Petir', descEn: 'Thunderstorm', rain: 6 }) : step(t)));

test('tonight runs 17.00 to 06.00 farm time, from now once the night has begun', () => {
  assert.deepEqual(tonight(NOW, TZ), { from: at('17:00'), to: next('06:00'), evening: at('17:00') });
  const late = at('23:10');
  assert.equal(tonight(late, TZ).from, late);
  assert.equal(tonight(late, TZ).to, next('06:00'));
  const early = next('02:00');
  assert.equal(tonight(early, TZ).to, next('06:00'));
  assert.equal(tonight(early, TZ).evening, at('17:00'));
});

test('a calm night is low and has no preparation checks', () => {
  const p = assessPowerNight({ storm: storm(), bmkg: bmkgSteps(), now: NOW, timezone: TZ, backup: 'none' });
  assert.equal(p.level, 'low');
  assert.deepEqual(p.reasons, []);
  assert.deepEqual(p.checks, []);
  assert.equal(p.note, null);
});

test('both sources forecasting thunder make a risky night; one source alone is medium and says they disagree', () => {
  const om = storm({ [iso(at('21:00'))]: { code: 95 }, [iso(at('22:00'))]: { code: 95 } });
  const both = assessPowerNight({ storm: om, bmkg: bmkgSteps(at('21:00')), now: NOW, timezone: TZ, backup: 'genset' });
  assert.equal(both.level, 'high');
  assert.equal(both.thunder.disagree, false);
  assert.deepEqual(both.reasons.map((r) => r.source), ['open-meteo', 'bmkg']);
  assert.match(both.reasons[0].text, /Open-Meteo: badai petir jam 21\.00–22\.00/);
  assert.match(both.reasons[1].text, /BMKG: hujan petir sekitar jam 21\.00/);

  const bmkgOnly = assessPowerNight({ storm: storm(), bmkg: bmkgSteps(at('21:00')), now: NOW, timezone: TZ, backup: 'genset' });
  assert.equal(bmkgOnly.level, 'medium');
  assert.equal(bmkgOnly.thunder.disagree, true);
  assert.match(bmkgOnly.note!, /BMKG memperkirakan petir, Open-Meteo tidak/);

  // Thunder from one source plus strong gusts is two strong signs.
  const gusty = assessPowerNight({ storm: storm({ [iso(at('21:00'))]: { code: 95, gusts: 58 } }), bmkg: bmkgSteps(), now: NOW, timezone: TZ, backup: null });
  assert.equal(gusty.level, 'high');
  assert.ok(gusty.reasons.some((r) => r.id === 'gust' && /58 km\/jam/.test(r.text)));
});

test('weak signs alone stay low; daytime storms do not count for tonight', () => {
  const p = assessPowerNight({ storm: storm({ [iso(at('22:00'))]: { rain: 9 } }), bmkg: bmkgSteps(), now: NOW, timezone: TZ, backup: null });
  assert.equal(p.level, 'low');
  assert.equal(p.reasons[0].id, 'heavy_rain');
  const day = assessPowerNight({ storm: storm({ [iso(at('15:00'))]: { code: 95, gusts: 60 } }), bmkg: bmkgSteps(), now: NOW, timezone: TZ, backup: null });
  assert.equal(day.level, 'low');
});

test('preparation checks follow the power backup', () => {
  const om = storm({ [iso(next('01:00'))]: { code: 95 } });
  const run = (backup: 'genset' | 'battery' | 'none' | null) => assessPowerNight({ storm: om, bmkg: bmkgSteps(next('00:00')), now: NOW, timezone: TZ, backup }).checks;
  assert.deepEqual(run('genset').map((c) => c.reason), ['Siapkan genset dan bahan bakar', 'Cek aerator masih nyala']);
  assert.equal(run('genset')[0].t, at('17:00'));
  assert.equal(run('genset')[1].alarm, true, 'the storm hour falls in sleeping time');
  assert.equal(run('battery')[0].reason, 'Pastikan aki atau baterai cadangan terisi penuh');
  assert.deepEqual(run('none').slice(0, 2).map((c) => c.reason), ['Kurangi pakan malam ini supaya sisa pakan tidak memakai oksigen', 'Tentukan siapa yang bangun cek aerator kalau listrik padam']);
  assert.match(run(null)[0].why!, /^Malam rawan listrik padam: /);
});

const pond = (aeration: Pond['aeration'] = 'full'): Pond => ({ id: 1, name: 'Kolam A', kind: null, volumeL: null, areaM2: null, setting: 'outdoor', shaded: true, aeration, depthCm: 30, nicknames: [] });
function nowcast(score: (t: number) => number): Nowcast {
  const point = (t: number): NowcastPoint => {
    const s = score(t);
    return { t, temp: 28, sigma: 0.5, score: s, level: s >= 5 ? 'critical' : s >= 3 ? 'warning' : 'ok', factors: s ? [{ id: 'signs', label: 'Sidat terlihat naik', points: s }] : [] };
  };
  const hours: NowcastPoint[] = [];
  for (let t = NOW - 2 * H; t <= NOW + 24 * H; t += H) hours.push(point(t));
  return { pondId: 1, generatedAt: NOW, basis: { weather: true, anchor: null, calibrationPairs: 0, offset: 0, fit: [] }, now: point(NOW), hours, measurements: [], peak: point(NOW), checks: [], lastCheckAt: null } as unknown as Nowcast;
}

test('a risky night raises the danger of a pond already at Perhatian, not of a calm pond', () => {
  const om = storm({ [iso(at('21:00'))]: { code: 95 } });
  const power = assessPowerNight({ storm: om, bmkg: bmkgSteps(at('21:00')), now: NOW, timezone: TZ, backup: 'none' });
  const raised = applyPower(nowcast((t) => (t >= at('20:00') ? 3 : 0)), pond(), power, NOW, TZ);
  const h = raised.hours.find((x) => x.t === at('22:00'))!;
  assert.equal(h.level, 'critical');
  assert.ok(h.factors.some((f) => f.id === 'power_night' && f.points === 2));
  assert.equal(raised.peak.level, 'critical');
  assert.ok(raised.checks.some((c) => c.reason.startsWith('Kurangi pakan')));

  const calm = applyPower(nowcast(() => 0), pond(), power, NOW, TZ);
  assert.ok(calm.hours.every((x) => x.level === 'ok'));
  // A pond without aerators is not touched at all.
  const none = applyPower(nowcast((t) => (t >= at('20:00') ? 3 : 0)), pond('none'), power, NOW, TZ);
  assert.ok(none.hours.every((x) => !x.factors.some((f) => f.id.startsWith('power'))));
});

test('while the power is out, ponds with aerators are Bahaya (Perhatian with a backup)', () => {
  const outage = { id: 1, startedAt: iso(NOW - 20 * 60_000), endedAt: null, startedBy: 1, endedBy: null };
  const out = (backup: 'genset' | 'none') => applyPower(nowcast(() => 0), pond(), assessPowerNight({ storm: storm(), bmkg: null, now: NOW, timezone: TZ, backup, outage }), NOW, TZ);
  assert.equal(out('none').now.level, 'critical');
  assert.match(out('none').now.factors[0].label, /Listrik padam sejak 13\.40/);
  assert.equal(out('genset').now.level, 'warning');
  // An outage left open for more than a day no longer counts.
  const stale = assessPowerNight({ storm: storm(), bmkg: null, now: NOW, timezone: TZ, backup: 'none', outage: { ...outage, startedAt: iso(NOW - 30 * H) } });
  assert.equal(stale.outage, null);
});

test('BMKG answers are parsed into 3-hour steps', () => {
  const f = parseBmkg(
    {
      lokasi: { adm4: '34.04.07.2001', desa: 'Caturtunggal', kecamatan: 'Depok', kotkab: 'Sleman', provinsi: 'DI Yogyakarta' },
      data: [{ cuaca: [[{ utc_datetime: '2026-10-28 14:00:00', t: 25, tcc: 99, tp: 6.2, weather: 95, weather_desc: 'Hujan Petir', weather_desc_en: 'Thunderstorm', ws: 12, hu: 90 }], [{ utc_datetime: '2026-10-28 17:00:00', t: 24, tcc: 80, tp: 0, weather: 3, weather_desc: 'Berawan', weather_desc_en: 'Mostly Cloudy', ws: 4, hu: 92 }]] }],
    },
    NOW,
  );
  assert.equal(f.adm4, '34.04.07.2001');
  assert.equal(f.steps.length, 2);
  assert.deepEqual([f.steps[0].t, f.steps[0].code, f.steps[0].rain], [Date.parse('2026-10-28T14:00:00Z'), 95, 6.2]);
  assert.throws(() => parseBmkg({ data: [] }, NOW));
});

test('villages: nearest to a point, by code, and by name', () => {
  const [near] = nearestDesa(-7.7733, 110.3967);
  assert.equal(near.code, '34.04.07.2001');
  assert.equal(near.name, 'Caturtunggal');
  assert.equal(near.kabupaten, 'Sleman');
  assert.ok(near.km < 0.5);
  assert.equal(findDesa('34.04.07.2001')?.kecamatan, 'Depok');
  assert.equal(searchDesa('caturtunggal')[0].code, '34.04.07.2001');
  assert.deepEqual(searchDesa('desa depok sleman').map((d) => d.name).sort(), ['Caturtunggal', 'Condongcatur', 'Maguwoharjo']);
  assert.deepEqual(searchDesa('ab'), []);
});

const fakeBmkg = (thunder: boolean) => async (adm4: string): Promise<BmkgForecast> => ({
  adm4,
  place: { desa: 'Tridadi', kecamatan: 'Sleman', kotkab: 'Sleman', provinsi: 'DI Yogyakarta' },
  steps: bmkgSteps(thunder ? at('21:00') : undefined),
  fetchedAt: NOW,
});

test('API: nowcast carries tonight’s power label and the BMKG region; owners pick the region and backup', async () => {
  const s = await farmWithWorker(iso(NOW), { getBmkg: fakeBmkg(true), getStorm: async () => storm({ [iso(at('21:00'))]: { code: 95 } }), geocode: async () => ({ lat: -7.72, lon: 110.36, label: 'Sleman' }) });
  await s.owner('PUT', '/farm', { name: 'Tambak Sidat Mitra', locationName: 'Sleman', powerBackup: 'none' });
  const nc = (await s.worker('GET', '/nowcast')).json;
  assert.equal(nc.power.level, 'high');
  assert.equal(nc.power.backup, 'none');
  assert.equal(nc.weather.bmkg.source, 'BMKG');
  assert.equal(nc.weather.bmkg.region.desa, 'Tridadi');
  assert.equal(nc.weather.bmkg.region.auto, true);
  assert.ok(nc.ponds[0].checks.some((c: { reason: string }) => c.reason.startsWith('Kurangi pakan')));

  // Region search and pick: owners only.
  const found = (await s.worker('GET', '/wilayah?q=caturtunggal')).json.results;
  assert.equal(found[0].code, '34.04.07.2001');
  assert.equal((await s.worker('PUT', '/farm/wilayah', { code: '34.04.07.2001' })).status, 403);
  assert.equal((await s.owner('PUT', '/farm/wilayah', { code: '99.99.99.9999' })).status, 400);
  const picked = (await s.owner('PUT', '/farm/wilayah', { code: '34.04.07.2001' })).json;
  assert.deepEqual([picked.region.desa, picked.region.auto], ['Caturtunggal', false]);
  assert.equal((await s.owner('GET', '/nowcast')).json.weather.bmkg.region.desa, 'Caturtunggal');
  await s.owner('PUT', '/farm/wilayah', { code: null });
  assert.equal((await s.owner('GET', '/nowcast')).json.weather.bmkg.region.auto, true);

  assert.equal((await s.worker('PUT', '/farm/power', { powerBackup: 'genset' })).status, 403);
  assert.equal((await s.owner('PUT', '/farm/power', { powerBackup: 'solar' })).status, 400);
  assert.equal((await s.owner('PUT', '/farm/power', { powerBackup: 'genset' })).json.farm.powerBackup, 'genset');
  assert.equal((await s.owner('GET', '/nowcast')).json.power.checks[0].reason, 'Siapkan genset dan bahan bakar');
});

test('API: "Listrik padam" records the start, how long it has been out, and when it came back', async () => {
  const s = await farmWithWorker(iso(NOW));
  const started = await s.worker('POST', '/outages', {});
  assert.equal(started.status, 201);
  const id = started.json.outage.id;
  assert.equal(started.json.outage.startedAt, iso(NOW));
  // A second tap while it is still out is the same power cut.
  assert.equal((await s.owner('POST', '/outages', {})).json.outage.id, id);
  const moved = (await s.worker('PUT', `/outages/${id}`, { minutesAgo: 45 })).json.outage;
  assert.equal(moved.startedAt, iso(NOW - 45 * 60_000));
  assert.equal((await s.worker('GET', '/outages/open')).json.outage.id, id);
  // Ponds with aerators are Bahaya while it is out (the test ponds have no aeration set: counted as with aerators).
  assert.equal((await s.worker('GET', '/nowcast')).json.ponds[0].now.level, 'critical');
  s.now.t = new Date(NOW + 30 * 60_000);
  const ended = (await s.worker('POST', `/outages/${id}/end`)).json.outage;
  assert.equal(ended.endedAt, iso(NOW + 30 * 60_000));
  assert.equal((await s.worker('GET', '/outages/open')).json.outage, null);
  assert.equal((await s.worker('PUT', `/outages/${id}`, { minutesAgo: 5 })).status, 400);
  assert.equal((await s.worker('PUT', '/outages/9999', { minutesAgo: 5 })).status, 404);
});

function briefing(power: BriefingInput['power']): BriefingInput {
  return {
    farmName: 'Tambak Uji',
    now: NOW,
    timezone: TZ,
    ponds: [{ id: 1, name: 'Kolam A', phase: 'elver', week: 3, level: 'ok', findings: [], latest: {}, lastLogAt: null }],
    nowcasts: [nowcast(() => 0)],
    weather: [{ t: NOW + H, airTemp: 27, rain: 1, cloud: 90 }],
    history: () => [],
    bmkg: { region: { desa: 'Tridadi', kecamatan: 'Sleman', kabupaten: 'Sleman' }, steps: [{ t: at('21:00'), code: 63, desc: 'Hujan Lebat', rain: 27, wind: 10, temp: 24 }], error: null },
    power,
  };
}

test('briefing agent: get_bmkg_forecast tool, BMKG rain counts for the rain words, rules mention a risky night', async () => {
  const power = assessPowerNight({ storm: storm(), bmkg: bmkgSteps(at('21:00')), now: NOW, timezone: TZ, backup: 'none' });
  const input = briefing({ ...power, level: 'high' });
  // BMKG forecasts 27 mm in 3 hours (9 mm/hour): "hujan deras" is not overstated.
  const b = guard(input, { summary: 'BMKG memperkirakan hujan deras dan petir malam ini, sedangkan Open-Meteo tidak. Lebih aman bersiap.', checks: [] }, [], 'm');
  assert.equal(b.source, 'agent');
  // Without the agent: the rules say it themselves.
  const rules = await runBriefing(input, []);
  assert.match(rules.summary, /rawan listrik padam: kurangi pakan dan tentukan siapa yang cek aerator/);
  assert.ok(rules.checks.length === 0 || rules.checks.every((c) => c.source === 'rules'));
});

test('briefing agent: the get_bmkg_forecast tool gives BMKG steps and both sources on thunder', async () => {
  const power = assessPowerNight({ storm: storm(), bmkg: bmkgSteps(at('21:00')), now: NOW, timezone: TZ, backup: 'none' });
  const answers = [
    { tool_calls: [{ id: 'a', type: 'function', function: { name: 'get_bmkg_forecast', arguments: '{}' } }] },
    { tool_calls: [{ id: 'b', type: 'function', function: { name: 'submit_briefing', arguments: JSON.stringify({ summary: 'BMKG memperkirakan petir malam ini, Open-Meteo tidak. Lebih aman bersiap: tentukan siapa yang cek aerator.', checks: [] }) } }] },
  ];
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = JSON.parse(raw);
      const last = body.messages.at(-1);
      if (last.role === 'tool') seen.push(last.content);
      if (body.messages[0].role === 'system') seen.push(body.messages[0].content);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '', ...answers.shift() } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const b = await runBriefing(briefing(power), [{ name: 'meta', apiKey: 'k', base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, model: 'm' }]);
    assert.equal(b.source, 'agent');
    assert.deepEqual(b.steps.map((s) => s.tool), ['get_bmkg_forecast', 'submit_briefing']);
    assert.match(seen[0], /berbeda soal petir/);
    const tool = JSON.parse(seen.find((x) => x.includes('"source":"BMKG"'))!);
    assert.equal(tool.village, 'Tridadi, Sleman, Sleman');
    assert.equal(tool.steps[0].weather, 'Hujan Lebat');
    assert.deepEqual([tool.power_cut_tonight.thunder_bmkg, tool.power_cut_tonight.thunder_open_meteo, tool.power_cut_tonight.sources_disagree], [true, false, true]);
    // The backup in the farmer's words, not the stored code.
    assert.equal(tool.power_cut_tonight.power_backup, 'Tidak ada');
  } finally {
    server.close();
  }
});

test('the battery option reads "Aki atau baterai cadangan" (English "Battery backup") in checks, briefing, agent tool and SOP', async () => {
  assert.equal(powerBackupLabel('battery'), 'Aki atau baterai cadangan');
  assert.equal(withLang('en', () => powerBackupLabel('battery')), 'Battery backup');
  assert.deepEqual([powerBackupLabel('genset'), powerBackupLabel('none'), powerBackupLabel(null)], ['Genset', 'Tidak ada', 'Belum diisi']);
  const om = storm({ [iso(next('01:00'))]: { code: 95 } });
  const power = assessPowerNight({ storm: om, bmkg: bmkgSteps(next('00:00')), now: NOW, timezone: TZ, backup: 'battery' });
  assert.equal(withLang('en', () => assessPowerNight({ storm: om, bmkg: bmkgSteps(next('00:00')), now: NOW, timezone: TZ, backup: 'battery' })).checks[0].reason, 'Make sure the battery backup is fully charged');
  const rules = await runBriefing(briefing({ ...power, level: 'high' }), []);
  assert.match(rules.summary, /pastikan aki atau baterai cadangan terisi penuh/);
  // No "UPS" left in what farmers read: the emergency steps and the monthly SOP.
  const texts = JSON.stringify([(knowledge.emergencies as any).emergencies.map((e: any) => e.operator_actions), (knowledge.sop as any).tasks]);
  assert.doesNotMatch(texts, /UPS/);
  assert.match(texts, /aki atau baterai cadangan/);
});

test('the demo template and its copies have no power backup: a risky night says feed less and who checks the aerator', async () => {
  const s = server(iso(NOW), { demoPhone: '620000000000', getBmkg: fakeBmkg(true), getStorm: async () => storm({ [iso(at('21:00'))]: { code: 95 } }) });
  const template = await s.api.buildDemoTemplate();
  assert.equal(s.store.farm(template).getFarm()!.powerBackup, 'none');
  const visitor = s.client();
  const me = (await visitor('POST', '/auth/demo')).json;
  assert.notEqual(me.farm.id, template);
  assert.equal(s.store.farm(me.farm.id).getFarm()!.powerBackup, 'none');
  const nc = (await visitor('GET', '/nowcast')).json;
  assert.equal(nc.power.level, 'high');
  assert.equal(nc.power.backup, 'none');
  assert.deepEqual(nc.power.checks.slice(0, 2).map((c: { reason: string }) => c.reason), ['Kurangi pakan malam ini supaya sisa pakan tidak memakai oksigen', 'Tentukan siapa yang bangun cek aerator kalau listrik padam']);
});
