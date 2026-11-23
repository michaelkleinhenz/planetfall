// All user data lives in this browser's localStorage under keys starting with
// "pf.": settings (pf.settings), per-game data (pf.<game>.autosave, .saves,
// .cmdhistory) and the translation cache. Nothing is sent to any server.
// Backups are plain JSON files the user downloads and can load again.

const PREFIX = 'pf.';
const BACKUP_APP = 'planetfall-ai';
const BACKUP_VERSION = 1;

export const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

/** Storage key for one kind of per-game data. */
export const gameKey = (gameId, name) => `${PREFIX}${gameId}.${name}`;

/** Before multiple games existed, Planetfall's data used un-prefixed keys. */
export function migrateLegacyKeys() {
  for (const name of ['autosave', 'saves', 'cmdhistory']) {
    try {
      const old = localStorage.getItem(PREFIX + name);
      if (old != null && localStorage.getItem(gameKey('planetfall', name)) == null) {
        localStorage.setItem(gameKey('planetfall', name), old);
      }
      if (old != null) localStorage.removeItem(PREFIX + name);
    } catch { /* storage unavailable */ }
  }
}

function ownKeys() {
  const keys = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) keys.push(k);
    }
  } catch { /* storage unavailable */ }
  return keys.sort();
}

/**
 * Collect all user data as a backup object.
 * @param {{includeKey?: boolean}} opts - include the OpenRouter API key (off by default)
 */
export function createBackup({ includeKey = false } = {}) {
  const data = {};
  for (const k of ownKeys()) {
    if (k.startsWith(PREFIX + 'translations')) continue; // a cache; rebuilt on demand
    let v = localStorage.getItem(k);
    if (k === PREFIX + 'settings' && !includeKey) {
      try { const s = JSON.parse(v); delete s.apiKey; v = JSON.stringify(s); } catch { /* keep as is */ }
    }
    data[k] = v;
  }
  return { app: BACKUP_APP, version: BACKUP_VERSION, created: new Date().toISOString(), data };
}

/** Offer the backup as a file download. */
export function downloadBackup(opts) {
  const backup = createBackup(opts);
  const blob = new Blob([JSON.stringify(backup, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `planetfall-ai-backup-${backup.created.slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return backup;
}

/** Check a parsed backup file; returns a short summary or throws. */
export function inspectBackup(backup) {
  if (!backup || backup.app !== BACKUP_APP || typeof backup.data !== 'object') throw new Error('not a backup of this app');
  if (backup.version > BACKUP_VERSION) throw new Error('backup is from a newer version of the app');
  const keys = Object.keys(backup.data).filter((k) => k.startsWith(PREFIX));
  const games = [...new Set(keys.map((k) => /^pf\.([^.]+)\.(autosave|saves|cmdhistory)$/.exec(k)?.[1]).filter(Boolean))];
  return { created: backup.created, keys: keys.length, games, hasKey: /"apiKey"\s*:\s*"[^"]+"/.test(backup.data[PREFIX + 'settings'] || '') };
}

/**
 * Replace all user data with the backup's. The OpenRouter key currently stored
 * is kept when the backup doesn't contain one.
 */
export function restoreBackup(backup) {
  inspectBackup(backup);
  const currentSettings = store.get(PREFIX + 'settings', {});
  for (const k of ownKeys()) if (!k.startsWith(PREFIX + 'translations')) localStorage.removeItem(k);
  for (const [k, v] of Object.entries(backup.data)) {
    if (k.startsWith(PREFIX) && typeof v === 'string') localStorage.setItem(k, v);
  }
  const restored = store.get(PREFIX + 'settings', {});
  if (!restored.apiKey && currentSettings.apiKey) store.set(PREFIX + 'settings', { ...restored, apiKey: currentSettings.apiKey });
}
