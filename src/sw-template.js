// Generated into dist/sw.js at build time (see vite.config.js).
const VERSION = '__VERSION__';
const SHELL = 'tg-shell-' + VERSION;
const PRECACHE = __PRECACHE__;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL)
      .then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('tg-shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    // App shell: cache first, so the app opens with no signal.
    if (req.mode === 'navigate') {
      e.respondWith(
        caches.open(SHELL)
          .then((c) => c.match(new URL('./', self.registration.scope).href, { ignoreVary: true }))
          .then((hit) => hit || fetch(req)),
      );
      return;
    }
    e.respondWith(
      caches.open(SHELL)
        .then((c) => c.match(req, { ignoreSearch: true, ignoreVary: true }))
        .then((hit) => hit || fetch(req)),
    );
    return;
  }

  // Map tiles saved for offline use.
  if (/tile/.test(url.hostname + url.pathname)) {
    e.respondWith(
      caches.open('tg-tiles')
        .then((c) => c.match(req.url, { ignoreVary: true }))
        .then((hit) => hit || fetch(req)),
    );
  }
});
