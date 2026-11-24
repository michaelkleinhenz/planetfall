// Service worker: the installed app starts fast and plays offline.
// At install it caches the app shell (code, styles, fonts, covers); then, on
// the page's request, it downloads every game in the background, so all of
// them play offline. URLs carry content versions (tools/stamp.mjs), so one
// long-lived cache serves all releases: a new release downloads only the files
// that changed, and files no release uses any more are removed.
// Pages always try the network first, so a release arrives with the next reload.
// Without stamping (local development) everything goes to the network first.
const VERSION = '__VERSION__';
const SHELL = [/* __SHELL__ */];
const GAMES = [/* __GAMES__ */];
const DEV = VERSION.startsWith('__');
const CACHE = DEV ? 'pfai-dev' : 'pfai-app';
const abs = (u) => new URL(u, self.registration.scope).href;

async function missing(cache, urls) {
  const have = new Set((await cache.keys()).map((r) => r.url));
  return urls.filter((u) => !have.has(abs(u)));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    if (!DEV) {
      const cache = await caches.open(CACHE);
      // One by one, so that a single missing file does not stop the installation.
      await Promise.all((await missing(cache, SHELL)).map((u) => cache.add(u).catch(() => {})));
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('pfai-') && key !== CACHE) await caches.delete(key);
    if (!DEV) {
      // Drop what this release no longer uses.
      const keep = new Set([...SHELL, ...GAMES].map(abs));
      const cache = await caches.open(CACHE);
      for (const req of await cache.keys()) if (!keep.has(req.url)) await cache.delete(req);
    }
    await self.clients.claim();
  })());
});

// "cache-games": download every game for offline play, reporting progress to the pages.
let gamesJob = null;
async function cacheGames() {
  const cache = await caches.open(CACHE);
  const todo = await missing(cache, GAMES);
  const total = GAMES.length;
  let done = total - todo.length;
  const report = async (state) => {
    for (const client of await self.clients.matchAll()) client.postMessage({ type: 'games-cache', state, done, total });
  };
  await report(todo.length ? 'loading' : 'done');
  const queue = [...todo];
  const worker = async () => {
    while (queue.length) {
      const u = queue.shift();
      try { await cache.add(u); done++; } catch { /* offline or a hiccup: next time */ }
      await report('loading');
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  await report(done >= total ? 'done' : 'partial');
}

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'cache-games' || DEV) return;
  gamesJob ??= cacheGames().finally(() => { gamesJob = null; });
  event.waitUntil(gamesJob);
});

async function networkFirst(request, key = request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(key, response.clone());
    return response;
  } catch (err) {
    const hit = await cache.match(key);
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
    event.respondWith(networkFirst(request, abs('./')));
    return;
  }
  if (DEV) { event.respondWith(networkFirst(request)); return; }
  // Versioned code and styles (?v=<content version>) never change: cache first.
  if (url.searchParams.has('v')) { event.respondWith(cacheFirst(request)); return; }
  // Fonts, covers, icons: from the cache, refreshed in the background.
  event.respondWith(staleWhileRevalidate(request, event));
});
