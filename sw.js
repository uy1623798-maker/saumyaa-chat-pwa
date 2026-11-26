const CACHE = 'duochat-shell-v12';
const SHELL = ['./', './index.html', './style.css', './app.js', './install.js', './db.js', './crypto.js', './manifest.webmanifest?v=2', './saumyaa-s-192.png', './saumyaa-s-512.png', './profile-photo.jpg'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('duochat-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
