// A tiny service worker so the site can be installed on a phone (Add to Home screen) and still open
// its shell when there is no signal. It is deliberately simple and safe:
//   * NETWORK FIRST: a new version of the site always wins; the saved copy is only a fallback.
//   * It only touches files from this website. The database, sign-in, AI functions and fonts are
//     other addresses, so they are never saved or altered here.
//   * Questions are not stored for offline use: with no signal you will see the page but not new data.
const CACHE = 'qb-shell-v1';

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const key = req.mode === 'navigate' ? '/' : req;     // every page is the same index.html
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)).catch(() => {}); }
      return res;
    } catch (err) {
      const hit = await caches.match(key);
      if (hit) return hit;
      throw err;
    }
  })());
});
