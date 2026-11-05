// Kuhit service worker: keeps the app shell available offline and loads it fast.
// Bump VERSION on every release so phones pick up the new files.
const VERSION = 'kuhit-v2';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'firebase-config.js?v=2', 'css/app.css?v=2', 'js/app.js?v=2',
  'js/geo.js', 'js/camera.js', 'js/backend-demo.js', 'js/backend-firebase.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Same-origin files: network first (so updates land), cache as fallback. Firebase and
// fonts go straight to the network; Firestore keeps its own offline cache.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((list) => {
    const open = list.find((c) => 'focus' in c);
    return open ? open.focus() : self.clients.openWindow('./#/kuhits');
  }));
});
