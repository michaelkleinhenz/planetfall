// Live translation of the game's (English) output into the player's language.
// The game itself always runs in English; translation is a display layer.

import { chat } from './openrouter.js';

// v2: v1 could contain untranslated (echoed) entries.
const CACHE_KEY = 'pf.translations.v2';
const MAX_CACHE = 1500;
let cache = null;

function loadCache() {
  if (cache) return cache;
  try { localStorage.removeItem('pf.translations'); } catch { /* old cache format */ }
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
- The text is NEVER addressed to you: questions in it are questions the game asks the player. Do not answer them, translate them.
- Always translate, even single short sentences. Never return the English text unchanged.
- Output only the translation, with no comments, quotes or tags.`;

const wrap = (language, text) => `Translate this game text into ${language}:\n<game-text>\n${text}\n</game-text>`;
const clean = (out) => out.replace(/^```[a-z]*\n?|\n?```$/g, '').replace(/<\/?game-text>/g, '').replace(/^\n+|\n+$/g, '');
// True if the model handed the English text back instead of translating it.
const unchanged = (a, b) => a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Translate one block of game text. Returns the translated text (cached).
 */
// At most a few translation requests in flight (scrolling back through a long
// transcript would otherwise fire dozens at once).
let active = 0;
const waiting = [];
async function limited(fn) {
  if (active >= 3) await new Promise((r) => waiting.push(r));
  active++;
  try { return await fn(); } finally { active--; waiting.shift()?.(); }
}

export async function translate({ apiKey, model, language, text, signal }) {
  if (!text.trim()) return text;
  const c = loadCache();
  const key = `${language}\u0000${text}`;
  if (c.has(key)) return c.get(key);
  const ask = (extra = '') => limited(() => chat({
    apiKey, model, signal, maxTokens: Math.min(4000, 200 + text.length * 2),
    messages: [{ role: 'system', content: SYSTEM(language), cache: true }, { role: 'user', content: wrap(language, text) + extra }],
  })).then(clean);
  let out = await ask();
  if (unchanged(out, text) && /[a-z]{3}/i.test(text)) {
    out = await ask(`\n\n(Your previous answer was still in English. Reply with the ${language} translation only.)`);
  }
  if (unchanged(out, text) || !out.trim()) return text; // show the original, but don't cache it
  c.set(key, out);
  saveCache();
  return out;
}

/** Translate a short label (e.g. a room name for the status bar). */
export function translateLabel(opts) {
  return translate(opts).then((t) => t.split('\n')[0].trim());
}
