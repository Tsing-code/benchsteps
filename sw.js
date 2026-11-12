// Offline cache. Serves cached files instantly and refreshes them in the background,
// so a new deploy shows up the second time the app is opened.
// The cache name comes from version.js, so bumping APP_VERSION there is the only release step.
importScripts('version.js');
const VERSION = 'benchsteps-' + APP_VERSION;
const FILES = ['./', 'index.html', 'styles.css', 'app.js', 'version.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-180.png'];

self.addEventListener('install', e => {
  // cache:'reload' bypasses the HTTP cache so a new version never installs half-stale files
  e.waitUntil(caches.open(VERSION)
    .then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return; // never touch GitHub API calls
  if (url.searchParams.has('nocache')) { // used by "Check for updates": always ask the network
    e.respondWith(fetch(req, { cache: 'no-store' }));
    return;
  }
  e.respondWith(caches.open(VERSION).then(async cache => {
    const cached = await cache.match(req, { ignoreSearch: true });
    const network = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
    return cached || (await network) || (req.mode === 'navigate' ? cache.match('index.html') : Response.error());
  }));
});
