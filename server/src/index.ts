import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { backupStatusFile, createAdmin, eventLog, withAiLog } from './admin.ts';
import { createAi, withDailyCap } from './ai.ts';
import { createApi } from './api.ts';
import { captureStore, coverStore, removeFarmCaptures } from './captures.ts';
import { openDb, repo } from './db.ts';
import { DEMO_MAX_LIVE, DEMO_PER_IP_PER_DAY } from './demo.ts';
import { env } from './env.ts';
import { emergenciesEn, knowledge } from './knowledge.ts';
import { parseLang } from './i18n.ts';
import { mailer } from './mail.ts';
import { MONITOR_INTERVAL_MS, startMonitor } from './monitor.ts';
import type { Nowcast } from './nowcast.ts';

const app = new Hono().basePath('/api');

app.get('/health', (c) => c.json({ ok: true, modelApiKeyConfigured: env.aiChat.some((p) => p.apiKey !== '') }));

// The emergency steps follow the app's language (x-lang); the rest is reference data.
app.get('/knowledge', (c) =>
  c.json(parseLang(c.req.header('x-lang')) === 'en' ? { ...knowledge, emergencies: { ...knowledge.emergencies, ...emergenciesEn } } : knowledge),
);

const db = openDb();
const store = repo(db);
// What the team dashboard counts (admin.ts). AI calls are timed inside the daily cap, so its refusals are not counted.
const events = eventLog(db);
const ai = withDailyCap(withAiLog(createAi({ chat: env.aiChat, transcriber: env.aiTranscriber, mock: env.aiMock }), events), env.aiDailyCap);
const chain = env.aiChat.filter((p) => p.apiKey).map((p) => p.name).join(' → ');
console.log(`AI mode: ${ai.mode}${ai.mode === 'meta' ? ` (${chain}${env.aiTranscriber.apiKey ? ', voice: meta' : ', no voice'}${env.aiDailyCap ? `, cap ${env.aiDailyCap}/day` : ''})` : ''}`);
if (ai.mode === 'meta') console.log(`Briefing and case agent: ${env.agentChat.filter((p) => p.apiKey).map((p) => p.name).join(' → ')}`);
const api = createApi(store, { ai, saveCapture: captureStore(), cookieName: env.cookieName, demoPhone: env.demoPhone, farmAiCap: env.farmAiCap, agentProviders: env.agentChat.filter((p) => p.apiKey), sam: env.aiTranscriber.apiKey ? { apiKey: env.aiTranscriber.apiKey, base: env.aiTranscriber.base } : null, mail: mailer(env.smtp), removeFarmFiles: (farmId) => removeFarmCaptures(farmId), covers: coverStore(), demoLimits: { perIp: env.demoPerIp ?? DEMO_PER_IP_PER_DAY, maxLive: env.demoMaxLive ?? DEMO_MAX_LIVE }, events });
console.log(`Support mail: ${env.smtp ? `${env.smtp.host}:${env.smtp.port}` : 'not configured (tickets only stored)'}`);
// Team dashboard: off unless SYNTEEL_ADMIN_USER and SYNTEEL_ADMIN_PASSWORD are set. Registered before the app's routes.
app.route(
  '/admin',
  createAdmin(db, {
    creds: env.admin,
    cookieName: env.cookieName,
    demoPhone: env.demoPhone,
    farmAiCap: env.farmAiCap,
    events,
    // The services on this server (synteel-app.service, synteel-preview.service) and the public site.
    checks: [
      { id: 'app', nama: 'Aplikasi', ket: 'Aplikasi petani dan API (eel.synt.fun/app)', url: 'http://127.0.0.1:8788/api/health' },
      { id: 'preview', nama: 'Preview', ket: 'Versi uji dengan tambak demo (eel.synt.fun/preview)', url: 'http://127.0.0.1:8787/api/health' },
      { id: 'situs', nama: 'Situs', ket: 'Halaman depan dan kebijakan privasi (eel.synt.fun)', url: 'https://eel.synt.fun/' },
    ],
    backupStatus: backupStatusFile(process.env.SYNTEEL_BACKUP_STATUS ?? '/var/backups/synteel-status.json'),
  }),
);
console.log(`Admin dashboard: ${env.admin ? 'on' : 'off (no SYNTEEL_ADMIN_USER / SYNTEEL_ADMIN_PASSWORD)'}`);
app.route('/', api);

// Routes must all be registered before the first request, which the monitor makes.
app.get('/monitor', (c) => c.json({ intervalMs: MONITOR_INTERVAL_MS, ...monitor.status }));

const monitor = startMonitor(
  // Every farm, not just the ones somebody has open. Pond ids are unique across farms.
  async () => ({ ponds: (await Promise.all(store.farmIds().map((id) => api.nowcastFarm(id)))).flatMap((n) => n.ponds as Nowcast[]) }),
  (change) => console.log(`risk up: pond ${change.pondId} ${change.from} → ${change.to}: ${change.reasons.join('; ')}`),
);

// Linked Synteel devices (today: simulated ones from eel.synt.fun/sim) send their readings.
setInterval(() => {
  try {
    api.sendDeviceLogs();
  } catch (err) {
    console.error('device logs:', err);
  }
}, 60_000);

// Dead-eel cases: a re-check that went unanswered gets an agent run (and cases opened by a script their first).
const caseRechecks = () => {
  try {
    api.caseRechecks();
  } catch (err) {
    console.error('cases:', err);
  }
};
setTimeout(caseRechecks, 5_000);
setInterval(caseRechecks, 5 * 60_000);

// "Coba demo" copies are deleted 48 hours after they were made.
const expireDemos = () => {
  try {
    const n = api.expireDemos();
    if (n) console.log(`demo farms expired: ${n}`);
  } catch (err) {
    console.error('demo expiry:', err);
  }
};
setTimeout(expireDemos, 10_000);
setInterval(expireDemos, 30 * 60_000);

// Evening briefing: check every 10 minutes; each farm gets one from 17.00 local time.
setInterval(() => api.briefFarms().catch((err) => console.error('briefings:', err)), 10 * 60_000);

// Weekly water temperature pattern notes per farm (patterns.ts): checked every hour, each farm once a week.
setInterval(() => api.patternFarms().catch((err) => console.error('patterns:', err)), 60 * 60_000);

serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info) => {
  console.log(`synteel server listening on http://${env.host ?? 'localhost'}:${info.port}`);
});
