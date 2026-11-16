// =====================================================================
// sw.js — Service worker: cache του "κελύφους" της εφαρμογής.
// Το παιχνίδι θέλει δίκτυο (real-time), οπότε network-first.
// =====================================================================
const CACHE = 'ozfp-v1';
const SHELL = ['/', '/style.css', '/app.js', '/manifest.json', '/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Ποτέ cache για socket.io και API
  if (e.request.method !== 'GET' || url.pathname.startsWith('/socket.io') || url.pathname.startsWith('/api')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(url.pathname.startsWith('/room/') ? '/' : e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(url.pathname.startsWith('/room/') ? '/' : e.request))
  );
});
