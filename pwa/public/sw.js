const CACHE = 'oloolua-v3';

self.addEventListener('install', e => {
  e.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Strategy:
// - Apps Script & cross-origin → never intercept
// - HTML (navigation requests) → network-first, fall back to cache (so updates land instantly when online)
// - Hashed assets (/assets/*) → cache-first, immutable
// - Everything else same-origin → network-first
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  const isHTML = e.request.mode === 'navigate' ||
    (e.request.headers.get('accept') || '').includes('text/html');
  const isHashedAsset = url.pathname.startsWith('/assets/');

  if (isHashedAsset) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }))
    );
    return;
  }

  // Network-first for HTML and everything else
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok && isHTML) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match(e.request).then(c => c || caches.match('/')))
  );
});
