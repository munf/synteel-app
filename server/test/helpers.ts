// Shared by the API tests: an in-memory server and a client that keeps its session cookie.
import { createApi } from '../src/api.ts';
import { openDb, repo } from '../src/db.ts';

export type Api = ReturnType<typeof createApi>;
export type Deps = Parameters<typeof createApi>[1];

/** Calls the API like a phone does: keeps the session cookie between requests. */
export function client(api: Api, headers: Record<string, string> = {}) {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const form = body instanceof FormData;
    const res = await api.request(path, {
      method,
      headers: { ...headers, ...(body !== undefined && !form && { 'content-type': 'application/json' }), ...(cookie && { cookie }) },
      body: body === undefined ? undefined : form ? (body as FormData) : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, json: res.status === 204 ? null : await res.json() };
  };
  /** A GET with the session that returns the raw response (pictures are not JSON). */
  const raw = (path: string) => api.request(path, { headers: { ...headers, ...(cookie && { cookie }) } });
  return Object.assign(call, { raw });
}

export type Call = ReturnType<typeof client>;

/** `now` is a mutable clock, so a test can move time forward. */
export function server(nowIso = '2026-10-28T03:00:00Z', deps: Deps = {}) {
  const store = repo(openDb(':memory:'));
  const now = { t: new Date(nowIso) };
  const api = createApi(store, { clock: () => now.t, getWeather: async () => ({ hours: [], fetchedAt: 0 }), geocode: async () => null, getBmkg: async () => { throw new Error('offline'); }, getStorm: async () => [], ...deps });
  return { store, api, now, client: (headers?: Record<string, string>) => client(api, headers) };
}

/** An owner with a farm and ponds, plus a worker who joined it. */
export async function farmWithWorker(nowIso?: string, deps?: Deps, pondNames = ['Kolam A', 'Kolam B', 'Kolam C']) {
  // With mail set up, Daftar needs the e-mailed code: keep codes here, pass every other message on.
  const codes: string[] = [];
  const mail = deps?.mail;
  const s = server(nowIso, mail ? { ...deps, mail: async (m) => (m.to ? void codes.push(m.subject.match(/\d{6}/)![0]) : mail(m)) } : deps);
  const owner = s.client();
  const email = mail ? 'petani@gmail.com' : undefined;
  if (email) await owner('POST', '/auth/code', { phone: '081111111111', email });
  await owner('POST', '/auth/register', { name: 'Petani Demo', phone: '081111111111', pin: '246810', email, emailCode: codes[0] });
  await owner('PUT', '/farm', { name: 'Tambak Sidat Mitra' });
  const ponds: { id: number; name: string }[] = [];
  for (const name of pondNames) ponds.push((await owner('POST', '/ponds', { name })).json.pond);
  const { code } = (await owner('POST', '/farm/invites', { role: 'worker' })).json;
  const worker = s.client();
  const joined = await worker('POST', '/auth/join', { code, name: 'Pak Joko', phone: '082222222222', pin: '135790' });
  return { ...s, owner, worker, workerId: joined.json.user.id as number, ponds };
}
