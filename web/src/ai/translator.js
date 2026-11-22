// Live translation of the game's (English) output into the player's language.
// The game itself always runs in English; translation is a display layer.

import { chat } from './openrouter.js';

const CACHE_KEY = 'pf.translations';
const MAX_CACHE = 1500;
let cache = null;

function loadCache() {
  if (cache) return cache;
  try { cache = new Map(JSON.parse(localStorage.getItem(CACHE_KEY) || '[]')); } catch { cache = new Map(); }
  return cache;
}
function saveCache() {
  try {
    const entries = [...cache].slice(-MAX_CACHE);
    localStorage.setItem(CACHE_KEY, JSON.stringify(entries));
  } catch { /* storage full: keep in memory only */ }
}

const SYSTEM = (language) => `You translate text from PLANETFALL, the 1983 Infocom science-fiction text adventure, into ${language}.
- Translate faithfully and completely, keeping the dry, witty Infocom tone (Floyd's childlike robot speech, Blather's bluster, the deadpan narrator).
- Keep EXACTLY the same line structure: the same number of lines, in the same order, with the same blank lines. Never merge or split lines.
- Keep proper names (Floyd, Blather, Feinstein, Kalamontee, Lawanda, Stellar Patrol, ...) unchanged.
- The in-game "phonetic" spellings on signs and labels (e.g. "Akmee Portabul Laazur", "kitcin akses kard", "Tranzportaashun Suplii") are part of a puzzle: keep them exactly as written, and you may add a short translation in parentheses.
- Words in CAPITALS that are game commands or answers (RESTART, RESTORE, QUIT, YES, NO, Y) stay in English, because the player may need to type them.
- Output only the translation, with no comments or quotes.`;

/**
 * Translate one block of game text. Returns the translated text (cached).
 */
export async function translate({ apiKey, model, language, text, signal }) {
  if (!text.trim()) return text;
  const c = loadCache();
  const key = `${language}\u0000${text}`;
  if (c.has(key)) return c.get(key);
  const out = (await chat({
    apiKey, model, signal, maxTokens: Math.min(4000, 200 + text.length * 2),
    messages: [{ role: 'system', content: SYSTEM(language) }, { role: 'user', content: text }],
  })).replace(/^```[a-z]*\n?|\n?```$/g, '');
  c.set(key, out);
  saveCache();
  return out;
}

/** Translate a short label (e.g. a room name for the status bar). */
export function translateLabel(opts) {
  return translate(opts).then((t) => t.split('\n')[0].trim());
}
