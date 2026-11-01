// Keeps the app itself on the phone so it opens instantly and works with no signal.
// The app's files are fetched fresh when possible and saved for offline. Recipe data is saved by the app
// itself (see backend.js); this file also keeps a copy of every photo the app has shown.
const CACHE = 'spoonbook-v27';
const PHOTOS = 'spoonbook-photos'; // kept across updates
const SHELL = ['./', './index.html', './backend.js', './local.js', './simple.js', './mail.js', './diet.js', './nutrition.js', './config.js', './manifest.webmanifest', './privacy.html', './terms.html', './r.html', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== PHOTOS).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

async function photo(e, url){
  // signed photo links change every few days, so photos are saved under the address without the signature
  const key = url.origin + url.pathname;
  const c = await caches.open(PHOTOS);
  const hit = await c.match(key);
  if (hit) return hit;
  try {
    const res = await fetch(url.href, { mode: 'cors', credentials: 'omit' });
    if (res.ok){
      await c.put(key, res.clone());
      c.keys().then(k => { if (k.length > 600) k.slice(0, k.length - 600).forEach(x => c.delete(x)); });
    }
    return res;
  } catch { return fetch(e.request); }
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (/\.supabase\.co$/.test(url.hostname) && url.pathname.includes('/storage/v1/object/sign/')) return e.respondWith(photo(e, url));
  const own = url.origin === location.origin;
  const lib = /cdn\.jsdelivr\.net|unpkg\.com|tessdata\.projectnaptha\.com|cdnjs\.cloudflare\.com|fonts\.(googleapis|gstatic)\.com/.test(url.host);
  if (!own && !lib) return; // Supabase data: straight to the network
  // the app's files: try the network first so updates arrive, fall back to the saved copy offline
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok || res.type === 'opaque'){ const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: own }).then(r => r || (own ? caches.match('./index.html') : undefined)))
  );
});
