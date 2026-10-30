// Tuck and Whisper — minimal service worker (skeleton).
// Caches the app shell so the PWA installs and opens offline; API calls are never cached.
const CACHE = 'taw-shell-v1';
const SHELL = ['./', './index.html', './manifest.json', './icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.includes('/api/')) return; // never cache API traffic
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
