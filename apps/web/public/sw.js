// PWA service worker for the DSH-Gateway portal (scope: /portal/).
//
// Deliberately a network passthrough with NO caching:
// - the gateway serves this app from disk and hot-update rebuilds swap hashed
//   assets, so a cache could keep serving stale bundles;
// - /gw/* auth data and the /console relay live outside this SW's scope.
// Its job is to satisfy the installability requirement (Chromium needs a
// fetch handler) and to keep the shell controlled for future offline work.

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request))
})
