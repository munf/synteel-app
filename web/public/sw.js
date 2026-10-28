// Synteel service worker: keeps the app shell available at the pond with weak or no signal.
// - Navigations: network first (new deploys show up), cached index.html when offline.
// - Other same-origin GETs (hashed JS/CSS, fonts, icons): cache first, cached on first fetch.
// - Anything under api/ is never touched: it always goes to the network, uncached.
// All URLs are relative to this script, so the same build works under any sub-path.
// The build (vite.config.ts) replaces the two placeholders below with a content hash and the
// list of built files; served unprocessed they fall back to runtime caching only.
const VERSION = '__SW_VERSION__';
const PRECACHE = /*__SW_PRECACHE__*/ [];

const PREFIX = 'synteel-shell-';
const CACHE = PREFIX + VERSION;
const SCOPE = new URL(self.registration.scope);
const INDEX = new URL('index.html', SCOPE).href;

const isApi = (url) =>
  url.pathname.startsWith(new URL('api/', SCOPE).pathname) || /\/api(\/|$)/.test(url.pathname);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(['./', ...PRECACHE].map((p) => new URL(p, SCOPE).href)))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname) || isApi(url)) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(INDEX, copy));
          }
          return res;
        })
        .catch(async () => (await caches.match(INDEX)) ?? (await caches.match(SCOPE.href)) ?? Response.error()),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ??
        fetch(req).then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
