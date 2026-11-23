// Main menu: choose a game, continue or start fresh, and back up / restore
// all user data (which lives only in this browser).

import { GAMES } from './games/registry.js';
import { store, gameKey, downloadBackup, inspectBackup, restoreBackup } from './storage.js';
import { t, getLanguage } from './i18n.js';

const ICONS = {
  planetfall: '<svg viewBox="0 0 64 64"><circle cx="32" cy="34" r="15" fill="var(--accent)"/><ellipse cx="32" cy="34" rx="27" ry="7" fill="none" stroke="var(--accent-2)" stroke-width="3"/></svg>',
  zork1: '<svg viewBox="0 0 64 64" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linejoin="round"><path d="M12 30 32 14l20 16"/><path d="M17 27v23h30V27"/><path d="M28 50V38h8v12" stroke="var(--accent-2)"/></svg>',
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** URL of the page with a game selected. */
export const gameUrl = (id) => `?game=${encodeURIComponent(id)}`;

export function renderMenu({ openSettings }) {
  document.body.classList.add('menu-mode');
  document.getElementById('menu').hidden = false;
  document.title = 'Planetfall AI';
  const cards = document.getElementById('game-cards');
  cards.replaceChildren();
  for (const meta of Object.values(GAMES)) {
    const save = store.get(gameKey(meta.id, 'autosave'), null);
    const named = Object.keys(store.get(gameKey(meta.id, 'saves'), {})).length;
    const card = el('article', 'game-card');
    const icon = el('div', 'gc-icon');
    icon.innerHTML = ICONS[meta.id] || '';
    const body = el('div');
    body.append(el('h3', null, meta.title));
    body.append(el('div', 'gc-sub', `${meta.subtitle ? meta.subtitle + ' · ' : ''}${meta.author}, ${meta.year}`));
    body.append(el('p', 'gc-blurb', meta.blurb[getLanguage()] || meta.blurb.en));
    if (save?.meta) {
      const date = new Date(save.meta.date).toLocaleDateString(getLanguage());
      body.append(el('p', 'gc-progress', t('menuProgress', { room: save.meta.room || '—', score: save.meta.score ?? 0, date })
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
        location.href = gameUrl(meta.id);
      });
      actions.append(fresh);
    }
    actions.append(el('span', 'gc-license', `${t('menuLicense')}: ${meta.license}`));
    card.append(icon, body, actions);
    cards.append(card);
  }

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
