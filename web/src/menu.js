// Main menu: choose a game, continue or start fresh, and back up / restore
// all user data (which lives only in this browser).

import { GAMES } from './games/registry.js';
import { store, gameKey, downloadBackup, inspectBackup, restoreBackup } from './storage.js';
import { t, getLanguage } from './i18n.js';

import { emblem, EMBLEMS } from './emblems.js';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** URL of the page with a game selected. */
export const gameUrl = (id) => `?game=${encodeURIComponent(id)}`;

/** Colours for a generated cover, derived from the game id. */
function coverColors(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  return { c1: `hsl(${hue} 45% 9%)`, c2: `hsl(${(hue + 40) % 360} 40% 16%)`, c3: `hsl(${(hue + 180) % 360} 70% 66%)` };
}

function gameCard(meta, save) {
  const named = Object.keys(store.get(gameKey(meta.id, 'saves'), {})).length;
  const card = el('article', 'game-card');
  card.dataset.game = meta.id;
  card.dataset.search = [meta.title, meta.subtitle, meta.author, meta.year].filter(Boolean).join(' ').toLowerCase();
  const cover = el('a', 'gc-cover');
  cover.href = gameUrl(meta.id);
  cover.setAttribute('aria-label', meta.title);
  if (meta.cover) {
    // The game's box art.
    const img = el('img', 'gc-cover-img');
    img.src = meta.cover;
    img.alt = `${meta.title} — cover`;
    img.width = 264; img.height = 352;
    img.loading = 'lazy';
    img.decoding = 'async';
    cover.classList.add('has-image');
    cover.append(img);
  } else {
    // A generated cover panel when there is no cover image.
    if (!EMBLEMS[meta.id]) {
      const c = coverColors(meta.id);
      cover.style.setProperty('--c1', c.c1); cover.style.setProperty('--c2', c.c2); cover.style.setProperty('--c3', c.c3);
    }
    const art = el('span', 'gc-emblem');
    if (EMBLEMS[meta.id]) art.innerHTML = emblem(meta.id);
    else { art.classList.add('gc-initial'); art.textContent = meta.title.replace(/^The /, '')[0]; }
    cover.append(el('span', 'gc-stars'), art, el('span', 'gc-cover-title', meta.title), el('span', 'gc-cover-year', String(meta.year)));
  }
  const body = el('div', 'gc-body');
  body.append(el('h3', null, meta.title));
  body.append(el('div', 'gc-sub', `${meta.subtitle ? meta.subtitle + ' · ' : ''}${meta.author}, ${meta.year}`));
  body.append(el('p', 'gc-blurb', meta.blurb[getLanguage()] || meta.blurb.en));
  if (save?.meta) {
    const date = new Date(save.meta.date).toLocaleDateString(getLanguage());
    body.append(el('p', 'gc-progress', (save.meta.clock ? t('menuProgressClock', { room: save.meta.room || '—', clock: save.meta.clock, date }) : t('menuProgress', { room: save.meta.room || '—', score: save.meta.score ?? 0, date }))
      + (named ? ` · ${t('menuSaves', { n: named })}` : '')));
  }
  const actions = el('div', 'gc-actions');
  const play = el('a', 'btn primary', save ? t('menuContinue') : t('menuPlay'));
  play.href = gameUrl(meta.id);
  actions.append(play);
  if (save) {
    const fresh = el('button', 'btn ghost', t('menuNewGame'));
    fresh.type = 'button';
    fresh.addEventListener('click', () => {
      if (!confirm(t('menuNewGameConfirm', { title: meta.title }))) return;
      store.remove(gameKey(meta.id, 'autosave'));
      store.remove(gameKey(meta.id, 'automap'));
      location.href = gameUrl(meta.id);
    });
    actions.append(fresh);
  }
  if (meta.gallery) {
    // Box contents, manual and feelies; some games need them to be played.
    const gal = el('a', 'gc-gallery', t('menuGallery'));
    gal.href = meta.gallery;
    gal.target = '_blank';
    gal.rel = 'noopener';
    gal.title = t('galleryTitle');
    actions.append(gal);
  }
  body.append(actions);
  body.append(el('p', 'gc-license', `${t('menuLicense')}: ${meta.license}`));
  card.append(cover, body);
  return card;
}

export function renderMenu({ openSettings }) {
  document.body.classList.add('menu-mode');
  document.getElementById('menu').hidden = false;
  document.title = 'Planetfall AI';
  const cards = document.getElementById('game-cards');
  cards.replaceChildren();
  const entries = Object.values(GAMES).map((meta) => ({ meta, save: store.get(gameKey(meta.id, 'autosave'), null) }));
  // Games in progress first (most recent first), then all others by year.
  const inProgress = entries.filter((e) => e.save).sort((a, b) => new Date(b.save.meta?.date || 0) - new Date(a.save.meta?.date || 0));
  const others = entries.filter((e) => !e.save).sort((a, b) => a.meta.year - b.meta.year || a.meta.title.localeCompare(b.meta.title));

  const search = el('input', 'menu-search');
  search.type = 'search';
  search.placeholder = t('menuSearch', { n: entries.length });
  search.setAttribute('aria-label', search.placeholder);
  const empty = el('p', 'menu-empty muted');
  empty.hidden = true;
  cards.append(search);

  const section = (title, list) => {
    if (!list.length) return;
    const h = el('h3', 'menu-sub', title);
    const grid = el('div', 'game-grid');
    for (const e of list) grid.append(gameCard(e.meta, e.save));
    cards.append(h, grid);
  };
  section(t('menuYourGames'), inProgress);
  section(inProgress.length ? t('menuAllGames') : '', others);
  cards.append(empty);

  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    for (const card of cards.querySelectorAll('.game-card')) {
      const hit = !q || card.dataset.search.includes(q);
      card.hidden = !hit;
      if (hit) shown++;
    }
    for (const grid of cards.querySelectorAll('.game-grid')) {
      const any = [...grid.children].some((c) => !c.hidden);
      grid.hidden = !any;
      if (grid.previousElementSibling?.classList.contains('menu-sub')) grid.previousElementSibling.hidden = !any;
    }
    empty.hidden = shown > 0;
    empty.textContent = t('menuNoMatch', { q: search.value.trim() });
  });

  const status = document.getElementById('data-status');
  document.getElementById('backup').onclick = () => {
    downloadBackup({ includeKey: document.getElementById('backup-key').checked });
    status.textContent = t('dataBackupDone');
  };
  const file = document.getElementById('restore-file');
  document.getElementById('restore').onclick = () => { file.value = ''; file.click(); };
  file.onchange = async () => {
    const f = file.files?.[0];
    if (!f) return;
    try {
      const backup = JSON.parse(await f.text());
      const info = inspectBackup(backup);
      const games = info.games.map((id) => GAMES[id]?.title || id).join(', ') || t('dataNoGames');
      const date = info.created ? new Date(info.created).toLocaleString(getLanguage()) : '?';
      if (!confirm(t('dataRestoreConfirm', { date, games }))) return;
      restoreBackup(backup);
      status.textContent = t('dataRestoreDone');
      setTimeout(() => location.reload(), 600);
    } catch (err) {
      status.textContent = t('dataRestoreFailed', { error: err.message });
    }
  };
  document.getElementById('menu-settings').onclick = openSettings;
}
