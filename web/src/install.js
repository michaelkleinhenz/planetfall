// Installing the app: the service worker (offline play, fast start) and the
// "Install as an app" button on the main game list. Chrome, Edge and Android
// offer their own install prompt; on iPhone and iPad (Safari has none) the
// button shows how to add the app to the home screen.

const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

export function initInstall() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
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
