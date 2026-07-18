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

// ── 1. PUSH NOTIFICATIONS ───────────────────────────────────────
self.addEventListener('push', event => {
  if (event.data) {
    try {
      const data = event.data.json();
      const options = {
        body: data.body || 'New updates are available!',
        icon: '/icon-192.png',
        badge: '/icon.svg',
        data: { url: data.url || '/' },
        vibrate: [100, 50, 100],
        actions: [
          { action: 'open', title: 'Read Now' }
        ]
      };
      event.waitUntil(
        self.registration.showNotification(data.title || 'Dispatch', options)
      );
    } catch (e) {
      // Fallback if data payload isn't structured JSON
      event.waitUntil(
        self.registration.showNotification('Dispatch', {
          body: event.data.text(),
          icon: '/icon-192.png'
        })
      );
    }
  }
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  let targetUrl = '/';
  if (event.notification.data && event.notification.data.url) {
    targetUrl = event.notification.data.url;
  }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // If a tab is already open, focus it and navigate to the article
      for (let client of windowClients) {
        if (client.url === targetUrl && 'focus' in client) {
          return client.focus();
        }
      }
      // If no tab is open, open a new one
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});

// ── 2. BACKGROUND SYNC ──────────────────────────────────────────
// Fires when connectivity is restored to push pending tasks
self.addEventListener('sync', event => {
  if (event.tag === 'sync-news') {
    console.log('Background sync triggered: Fetching latest news feeds...');
    // If you add custom background sync fetch logic, wrap it in event.waitUntil() here
  }
});

// ── 3. PERIODIC BACKGROUND SYNC ──────────────────────────────────
// Fires routinely in the background based on OS engagement scores
self.addEventListener('periodicsync', event => {
  if (event.tag === 'fetch-latest-news') {
    console.log('Periodic background sync triggered: Pre-fetching news updates...');
    // If you add custom periodic fetch logic, wrap it in event.waitUntil() here
  }
});
