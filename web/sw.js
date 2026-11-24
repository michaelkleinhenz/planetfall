// Service worker: makes the installed app start fast and work offline.
// The app shell (code, styles, fonts, covers) is cached at install; each game
// is cached the first time it is opened, and then plays offline. Pages always
// try the network first, so a new release arrives with the next reload.
// tools/stamp.mjs fills in VERSION and PRECACHE when the site is deployed;
// without them (local development) everything goes to the network first.
const VERSION = '__VERSION__';
const PRECACHE = [/* __PRECACHE__ */];
const DEV = VERSION.startsWith('__');
const CACHE = `pfai-${DEV ? 'dev' : VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    if (!DEV) {
      const cache = await caches.open(CACHE);
      // One by one, so that a single missing file does not stop the installation.
      await Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => {})));
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('pfai-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

async function networkFirst(request, cacheKey = request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(cacheKey, response.clone());
    return response;
  } catch (err) {
    const hit = await cache.match(cacheKey, { ignoreSearch: cacheKey === request ? false : true });
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(request, event) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  const fresh = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  });
  if (hit) { event.waitUntil(fresh.catch(() => {})); return hit; }
  return fresh;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // the AI (OpenRouter) and other sites: untouched
  if (request.mode === 'navigate') {
    // The app is one page; ?game=... only selects the game.
    event.respondWith(networkFirst(request, new URL('./', self.registration.scope).href));
    return;
  }
  if (DEV) { event.respondWith(networkFirst(request)); return; }
  // Versioned code and styles (?v=<release>) never change: cache first.
  if (url.searchParams.has('v')) { event.respondWith(cacheFirst(request)); return; }
  // Fonts, covers, icons: from the cache, refreshed in the background.
  event.respondWith(staleWhileRevalidate(request, event));
});
