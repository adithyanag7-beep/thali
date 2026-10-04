// Thali service worker: keeps the app working offline.
// When you change any file, increase VERSION (e.g. '1.0.1') so phones pick up the update.
const VERSION = '1.0.0';
const CACHE = `thali-${VERSION}`;

const APP_FILES = [
  './',
  'index.html',
  'manifest.json',
  'css/app.css',
  'js/app.js',
  'js/config.js',
  'js/store.js',
  'js/nutrition.js',
  'js/image.js',
  'js/ai.js',
  'js/off.js',
  'js/scanner.js',
  'js/icons.js',
  'vendor/barcode-detector.js',
  'vendor/zxing_reader.wasm',
  'fonts/lexend-400.woff2',
  'fonts/lexend-600.woff2',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(APP_FILES.map(f => new Request(f, { cache: 'reload' }))))
  );
  // The first install takes over straight away; later updates wait for "Update now".
  if (!self.registration.active) self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('thali-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Claude and Open Food Facts always go to the network.
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('index.html', { cacheName: CACHE }).then(hit => hit || fetch(req))
    );
    return;
  }

  event.respondWith(
    caches.match(req, { cacheName: CACHE, ignoreSearch: true }).then(hit => {
      if (hit) return hit;
      return fetch(req).then(resp => {
        if (resp.ok && resp.type === 'basic') {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return resp;
      });
    })
  );
});
