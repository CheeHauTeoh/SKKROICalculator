// App-shell service worker. Shell files are cached on install and served cache-first; API calls go
// to the network only (the app handles offline itself via IndexedDB). Bump VERSION on every deploy.
const VERSION = 'skk-v1';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/api.js', '/i18n.js', '/idb.js', '/store.js', '/ui.js', '/manifest.webmanifest', '/icon.svg',
  '/views/login.js', '/views/lookup.js', '/views/visit.js', '/views/capture.js', '/views/uom.js', '/views/products.js', '/views/intel.js', '/views/import.js', '/views/admin.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return; // network only
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(VERSION).then(c => c.put('/index.html', copy)); return r; })
      .catch(() => caches.match('/index.html')));
    return;
  }
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
    return r;
  })));
});
self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });
