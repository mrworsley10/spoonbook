// Keeps the app itself on the phone so it opens instantly and survives a patchy signal.
// Recipes and photos always come fresh from Supabase; only the app's own files are cached here.
const CACHE = 'spoonbook-v2';
const SHELL = ['./', './index.html', './backend.js', './local.js', './nutrition.js', './config.js', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const own = url.origin === location.origin;
  const lib = /cdn\.jsdelivr\.net|unpkg\.com|tessdata\.projectnaptha\.com|cdnjs\.cloudflare\.com|fonts\.(googleapis|gstatic)\.com/.test(url.host);
  if (!own && !lib) return; // Supabase data and photos: straight to the network
  // the app's files: try the network first so updates arrive, fall back to the saved copy offline
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok || res.type === 'opaque'){ const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then(r => r || (own ? caches.match('./index.html') : undefined)))
  );
});
