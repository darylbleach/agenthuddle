// Service worker for app.agenthuddle.net: shows notifications from your Mac.
// The push carries text your Mac encrypted for this device; it's opened here with the key made when
// this device was paired (kept in IndexedDB, never readable), so the relay and push service can't read it.
/*TUNNEL*/

function idb() {
  return new Promise((res, rej) => { const r = indexedDB.open('agenthuddle', 1); r.onupgradeneeded = () => r.result.createObjectStore('pairs', { keyPath: 'macId' }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
async function getPair(id) {
  const db = await idb();
  return new Promise((res, rej) => { const r = db.transaction('pairs').objectStore('pairs').get(id); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => e.waitUntil((async () => {
  let title = 'Agent Huddle', body = 'Something on your Mac needs you.', data = {}, tag;
  try {
    const p = e.data.json();
    const rec = await getPair(p.m);
    if (rec) {
      const n = await openNotify(await notifyKey(rec.priv, rec.macPub), p.m, p.n);
      title = String(n.title || title).slice(0, 120); body = String(n.body || '').slice(0, 400);
      data = { mac: p.m, room: n.roomId || null }; tag = n.tag ? `ah-${n.tag}` : undefined;
    }
  } catch {}
  // Every push must show something (browsers require it), so failures fall back to the generic text.
  await self.registration.showNotification(title, { body, data, tag, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', renotify: !!tag });
})()));

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const { mac, room } = e.notification.data || {};
  const target = mac ? `/#open=${mac}${room ? '.' + room : ''}` : '/';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const w = wins.find((c) => new URL(c.url).origin === self.location.origin);
    if (w) { w.postMessage({ open: { mac, room } }); return w.focus(); }
    return self.clients.openWindow(target);
  })());
});
