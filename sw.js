// Dispatch service worker
// Registered at scope "/" by index.html
// Chrome PWA install requires a non-empty fetch handler.

const CACHE_NAME = 'dispatch-shell-v2';
const SHELL_URL = '/';

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.add(SHELL_URL))
      .catch(err => console.warn('SW shell cache failed:', err))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    Promise.all([
      caches.keys().then(names =>
        Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
      ),
      self.clients.claim()
    ])
  );
});

self.addEventListener('fetch', event => {
  // Only intercept navigation requests (main HTML page loads).
  // Everything else — API calls to the Cloudflare Worker, RSS fetches,
  // icons — passes through to the network untouched. This keeps the
  // news feed and REIT data live at all times.
  if (event.request.mode !== 'navigate') {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .catch(() => caches.match(SHELL_URL))
  );
});
