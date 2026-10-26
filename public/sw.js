// Agent Huddle service worker: makes the app installable and opens instantly.
// Live data (/api) always goes to the network; the app shell falls back to cache when offline.
const CACHE = 'agenthuddle-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname === '/logout') return;
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('/', copy)); }
      return res;
    }).catch(async () => (await caches.match('/')) || new Response('Agent Huddle is offline. Check your connection and try again.', { status: 503, headers: { 'content-type': 'text/plain' } })));
    return;
  }
  if (url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest') {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    })));
  }
});
