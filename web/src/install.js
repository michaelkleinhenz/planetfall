// Installing the app: the service worker (offline play, fast start) and the
// "Install as an app" button on the main game list. Chrome, Edge and Android
// offer their own install prompt; on iPhone and iPad (Safari has none) the
// button shows how to add the app to the home screen.

import { t } from './i18n.js';

const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

export function initInstall() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
    // Then every game is downloaded in the background for offline play (about
    // 4.5 MB; not when the browser asks to save data). Progress shows on the menu.
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'games-cache') showOfflineStatus(e.data);
    });
    navigator.serviceWorker.ready.then((reg) => {
      if (navigator.connection?.saveData) return;
      reg.active?.postMessage({ type: 'cache-games' });
    }).catch(() => {});
  }
  const box = document.getElementById('install-app');
  const btn = document.getElementById('install-btn');
  if (!box || !btn) return;
  if (standalone()) return; // already running as the app
  let deferred = null;
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // show our own button instead of the mini-infobar
    deferred = e;
    box.hidden = false;
  });
  addEventListener('appinstalled', () => { box.hidden = true; deferred = null; });
  if (isIos()) box.hidden = false;
  btn.addEventListener('click', async () => {
    if (deferred) {
      deferred.prompt();
      const { outcome } = await deferred.userChoice;
      if (outcome === 'accepted') box.hidden = true;
      deferred = null;
    } else {
      document.getElementById('install-dialog')?.showModal();
    }
  });
}

/** "Downloading games for offline play: 12 of 31" / "All 31 games play offline". */
function showOfflineStatus({ state, done, total }) {
  const el = document.getElementById('offline-status');
  if (!el || !total) return;
  const games = Math.round(total / 2);
  const ready = Math.min(games, Math.floor(done / 2));
  el.hidden = false;
  el.classList.toggle('done', state === 'done');
  el.textContent = state === 'done' ? t('offlineAllReady', { n: games })
    : state === 'partial' ? t('offlinePartial', { n: ready, total: games })
    : t('offlineLoading', { n: ready, total: games });
}
