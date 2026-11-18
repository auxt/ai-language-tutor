// Offline cache for the app shell. Bump VERSION when files change.
const VERSION = 'frazy-es-v8';
const FILES = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest', 'icons/icon.svg',
  'js/app.js', 'js/audio.js', 'js/phrases.js', 'js/pron.js', 'js/session.js', 'js/store.js',
  'vendor/ts-fsrs.mjs', 'audio/manifest.json',
  'js/lang/es.js', 'js/lang/de.js', 'js/lang/fr.js', 'js/lang/ar.js', 'js/lang/ru.js',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('frazy-es-') && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Network first so updates show up; cache as the offline fallback.
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.status === 200) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
