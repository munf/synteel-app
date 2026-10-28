import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { guard, nextTime, runBriefing, type BriefingInput } from '../src/agent.ts';
import type { Nowcast } from '../src/nowcast.ts';

const NOW = Date.parse('2026-10-28T10:00:00Z'); // 17.00 WIB
const H = 3600_000;

function input(): BriefingInput {
  const point = (t: number, level: 'ok' | 'warning' | 'critical') => ({ t, temp: 27, sigma: 0.3, score: level === 'critical' ? 6 : 0, level, factors: [{ id: 'signs', label: 'Sidat terlihat naik ke permukaan', points: 3 }] });
  const nc = {
    pondId: 2,
    generatedAt: NOW,
    basis: { weather: true, anchor: null, calibrationPairs: 0, offset: 0, fit: [] },
    now: point(NOW, 'warning'),
    hours: [point(NOW, 'warning'), point(NOW + 8 * H, 'critical')],
    measurements: [],
    peak: point(NOW + 8 * H, 'critical'),
    checks: [{ t: NOW + 5 * H, kind: 'look', reason: 'Cek sidat di permukaan', alarm: false }],
    lastCheckAt: NOW - H,
  } as Nowcast;
  return {
    farmName: 'Tambak Uji',
    now: NOW,
    timezone: 'Asia/Jakarta',
    ponds: [{ id: 2, name: 'Kolam B', phase: 'glass_eel', week: 3, level: 'critical', findings: [], latest: {}, lastLogAt: null }],
    nowcasts: [nc],
    weather: [{ t: NOW + H, airTemp: 26, rain: 4, cloud: 90 }],
    history: () => [],
  };
}

test('check times are read as the next such moment in farm time', () => {
  assert.equal(nextTime('21:30', NOW), Date.parse('2026-10-28T14:30:00Z'));
  assert.equal(nextTime('06.30', NOW), Date.parse('2026-10-28T23:30:00Z'));
  assert.equal(nextTime('25:00', NOW), null);
});

test('guardrails keep rule checks and drop bad agent checks', () => {
  const b = guard(
    input(),
    {
      summary: 'Kolam B rawan malam ini karena hujan dan sidat naik ke permukaan. Pastikan aerator nyala.',
      checks: [
        { pond_id: 2, time: '20:00', action: 'Tutup aliran air hujan ke Kolam B', alarm: false, why: 'Hujan 4 mm' },
        { pond_id: 99, time: '20:00', action: 'Cek kolam yang tidak ada', alarm: false, why: '-' },
        { pond_id: 2, time: '21:00', action: 'Beri obat antibiotik', alarm: false, why: '-' },
        { pond_id: 2, time: '22:10', action: 'Lihat sidat lagi', alarm: true, why: 'sama dengan cek aturan' },
        { pond_id: 2, time: '16:00', action: 'Terlalu jauh', alarm: false, why: 'besok sore' },
      ],
    },
    [],
    'meta/muse-spark-1.3',
  );
  assert.equal(b.source, 'agent');
  assert.deepEqual(
    b.checks.map((c) => [c.source, c.action]),
    [
      ['agent', 'Tutup aliran air hujan ke Kolam B'],
      ['rules', 'Cek sidat di permukaan'],
    ],
  );
});

test('a summary that talks about medicine falls back to the rules', () => {
  const b = guard(input(), { summary: 'Berikan obat jamur dengan dosis tinggi malam ini ke semua kolam.', checks: [] }, [], 'm');
  assert.equal(b.source, 'rules');
  assert.match(b.summary, /Kolam B paling rawan/);
});

test('the agent loop calls tools, then submits; the steps are recorded', async () => {
  const answers = [
    { tool_calls: [{ id: 'a', type: 'function', function: { name: 'get_ponds', arguments: '{}' } }] },
    { tool_calls: [{ id: 'b', type: 'function', function: { name: 'get_night_forecast', arguments: '{"pond_id":2}' } }] },
    {
      tool_calls: [
        {
          id: 'c',
          type: 'function',
          function: { name: 'submit_briefing', arguments: JSON.stringify({ summary: 'Kolam B paling rawan sekitar jam 01.00 karena sidat naik ke permukaan.', checks: [] }) },
        },
      ],
    },
  ];
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = JSON.parse(raw);
      const last = body.messages.at(-1);
      if (last.role === 'tool') seen.push(last.content);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '', ...answers.shift() } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const b = await runBriefing(input(), [{ name: 'meta', apiKey: 'k', base, model: 'm' }]);
    assert.equal(b.source, 'agent');
    assert.deepEqual(
      b.steps.map((s) => s.tool),
      ['get_ponds', 'get_night_forecast', 'submit_briefing'],
    );
    assert.match(seen[0], /Kolam B/);
    assert.match(seen[1], /rule_checks/);
    assert.equal(b.checks.length, 1);
  } finally {
    server.close();
  }
});

test('with no model the briefing comes from the rules', async () => {
  const b = await runBriefing(input(), []);
  assert.equal(b.source, 'rules');
  assert.equal(b.checks[0].source, 'rules');
});
