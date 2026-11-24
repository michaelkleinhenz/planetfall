// Planetfall AI — browser front end.
// Shows the main menu, or wires the selected translated game (engine/,
// games/) to the page and to the AI interpreter (ai/).

import { GameSession } from './engine/session.js';
import { inspect } from './engine/runtime.js';
import { interpret, isParserError } from './ai/interpreter.js';
import { currentScene, actionContext, currentRoom as roomObject } from './ai/scene.js';
import { Automap, drawMap } from './automap.js';
import { DebugLog, downloadJSON, BUILD, REPORT_README } from './debug.js';
import { playIntro, paletteOf } from './intro.js';
import { initRetro, retroControls, refreshRetroControls, sfx } from './retro.js';
import { initInstall } from './install.js';
import { pickDefaultModel, listModels } from './ai/openrouter.js';
import { translate, translateLabel } from './ai/translator.js';
import { getHint } from './ai/hints.js';
import { immerse, needsAtmosphere } from './ai/immersive.js';
import { t, setLanguage, applyStatic, normalizeLanguage, AI_LANGUAGE_NAME } from './i18n.js';
import { store, gameKey, migrateLegacyKeys } from './storage.js';
import { renderMenu } from './menu.js';
import { emblem } from './emblems.js';
import { GAMES } from './games/registry.js';
import { loadGame, current } from './engine/current.js';

const $ = (id) => document.getElementById(id);
const els = {
  transcript: $('transcript'), form: $('command-form'), input: $('command'), send: $('send'),
  hint: $('hint'), badge: $('mode-badge'), room: $('status-room'), score: $('status-score'), time: $('status-time'),
  undo: $('btn-undo'), hintBtn: $('btn-hint'), save: $('btn-save'), load: $('btn-load'), settingsBtn: $('btn-settings'),
  settings: $('settings-dialog'), setKey: $('set-key'), setModel: $('set-model'), setAi: $('set-ai'),
  setShow: $('set-show'), modelList: $('model-list'), setLang: $('set-lang'),
  slots: $('slots-dialog'), slotsTitle: $('slots-title'), slotsList: $('slots-list'), slotName: $('slot-name'),
  slotNameField: $('slot-name-field'), slotsOk: $('slots-ok'),
  topbar: document.querySelector('.topbar'), inputbar: $('inputbar'), more: $('more'), actions: $('actions'),
};

// ---------------------------------------------------------------------------
// Persistence (all local to this browser)
// ---------------------------------------------------------------------------

migrateLegacyKeys();

// The game is chosen with ?game=<id>; without it the main menu is shown.
const GAME_ID = (() => {
  const id = new URLSearchParams(location.search).get('game');
  return id && GAMES[id] ? id : null;
})();
/** Storage key for the current game's data. */
const K = (name) => gameKey(GAME_ID, name);

const settings = Object.assign(
  { apiKey: '', model: '', aiEnabled: true, showCommands: true, titleMotion: true, language: 'en', mapOpen: true },
  store.get('pf.settings', {}),
);
/** The header title's drifting art and light sweep can be turned off in settings. */
const applyTitleMotion = () => {
  if (settings.titleMotion) delete document.documentElement.dataset.titleMotion;
  else document.documentElement.dataset.titleMotion = 'off';
};
applyTitleMotion();
settings.language = normalizeLanguage(settings.language);
setLanguage(settings.language);
// 80s mode (CRT look, soundscapes): applied before anything is drawn.
initRetro();
// Installable app: service worker and the install button.
initInstall();
document.getElementById('retro-menu')?.append(retroControls());
document.getElementById('retro-settings')?.append(retroControls());
const saveSettings = () => store.set('pf.settings', settings);
const aiActive = () => settings.aiEnabled && !!settings.apiKey;
// Translation is active when a non-English language is chosen and the AI is on.
const targetLanguage = () => (aiActive() ? AI_LANGUAGE_NAME[settings.language] || '' : '');

// ---------------------------------------------------------------------------
// Transcript rendering
// ---------------------------------------------------------------------------

let transcriptLog = []; // serialisable entries, used for autosave
let currentRoom = '';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// On phones the keyboard stays open and only a small part of the transcript is
// visible, so each new turn is shown from its first line ("paging"); if the reply
// is longer than the visible area, a "More" button (or Enter on an empty line)
// pages down. On larger screens the view simply follows the newest text.
const paging = matchMedia('(pointer: coarse)').matches || matchMedia('(max-width: 700px)').matches;
if (paging) document.body.classList.add('paging');

function visibleBounds() {
  return {
    top: els.topbar.getBoundingClientRect().bottom,
    bottom: Math.min(els.inputbar.getBoundingClientRect().top, window.visualViewport?.height ?? innerHeight),
  };
}

function updatePageSpace() {
  const { top, bottom } = visibleBounds();
  document.body.style.setProperty('--page-space', `${Math.max(120, bottom - top - 40)}px`);
  // The automap panel fills the space between the top bar and the input bar.
  document.body.style.setProperty('--map-top', `${Math.round(top)}px`);
  document.body.style.setProperty('--map-bottom', `${Math.round(innerHeight - els.inputbar.getBoundingClientRect().top)}px`);
  updateMore();
}

function updateMore() {
  if (!paging) { els.more.hidden = true; return; }
  const last = els.transcript.lastElementChild;
  els.more.hidden = !last || last.getBoundingClientRect().bottom <= visibleBounds().bottom + 4;
}

/** Show a new turn from its beginning. */
function pinTurn(node) {
  if (!paging) return scrollDown();
  requestAnimationFrame(() => {
    const y = node.getBoundingClientRect().top + window.scrollY - visibleBounds().top - 10;
    window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
    setTimeout(updateMore, 400);
  });
}

function pageDown() {
  const { top, bottom } = visibleBounds();
  window.scrollBy({ top: Math.max(60, bottom - top - 48), behavior: 'smooth' });
  setTimeout(updateMore, 400);
}

function scrollDown() {
  if (paging) { requestAnimationFrame(updateMore); return; }
  requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
}

let moreFrame = 0;
window.addEventListener('scroll', () => {
  if (!moreFrame) moreFrame = requestAnimationFrame(() => { moreFrame = 0; updateMore(); });
}, { passive: true });
window.addEventListener('resize', updatePageSpace);
window.visualViewport?.addEventListener('resize', updatePageSpace);

/** The game's upper window, as the game drew it (rows of characters). */
function renderUpper(rows, cursor) {
  const box = document.getElementById('upper-window');
  if (!box) return;
  if (!rows) { box.hidden = true; box.replaceChildren(); return; }
  box.hidden = false;
  const frag = document.createDocumentFragment();
  rows.forEach((row, i) => {
    // the cursor (where the game is waiting for typing, e.g. a form field)
    if (cursor && cursor.line === i + 1) {
      row = row.slice();
      while (row.length < cursor.col) row.push({ ch: ' ', inv: false });
      row[cursor.col - 1] = { ...row[cursor.col - 1], cursor: true };
    }
    let run = '', inv = false;
    const flushRun = () => { if (!run) return; if (inv) frag.append(el('span', 'inv', run)); else frag.append(document.createTextNode(run)); run = ''; };
    for (const c of row) {
      if (c.cursor) { flushRun(); frag.append(el('span', 'upper-cursor', c.ch)); continue; }
      if (c.inv !== inv) { flushRun(); inv = c.inv; }
      run += c.ch;
    }
    flushRun();
    if (i < rows.length - 1) frag.append(document.createTextNode('\n'));
  });
  box.replaceChildren(frag);
}

function renderGameText(segments, container) {
  for (const seg of segments) {
    if (seg.fixed) {
      container.append(el('pre', 'game-text fixed', seg.text));
      continue;
    }
    // The title/copyright block (opening text and VERSION) gets its own compact styling.
    const banner = findBanner(seg.text);
    if (banner) {
      container.append(renderBanner(seg.text.split('\n').slice(banner.start, banner.end + 1)));
      const rest = splitAround(seg, banner);
      if (rest) renderGameText([rest], container);
      continue;
    }
    const p = el('p', 'game-text');
    // Room headings: lines that are exactly the current room's name (remembered per segment,
    // so they stay highlighted in translations and after reloads).
    const orig = seg.text.split('\n');
    if (!seg.titles) {
      seg.titles = orig.flatMap((line, i) => (currentRoom && (line === currentRoom ||
        line.startsWith(currentRoom + ', in the') || line.startsWith(currentRoom + ', on the')) ? [i] : []));
    }
    const showTranslation = seg.translated && !seg.showOriginal;
    const lines = (showTranslation ? seg.translated : seg.text).split('\n');
    const titleSet = new Set(lines.length === orig.length || !showTranslation ? seg.titles : []);
    lines.forEach((line, i) => {
      if (titleSet.has(i)) p.append(el('span', 'room-title', line));
      else p.append(document.createTextNode(line + (i < lines.length - 1 ? '\n' : '')));
    });
    if (seg.translated) {
      p.classList.add('translated');
      p.title = seg.showOriginal ? t('showTranslation') : t('showOriginal');
      p.addEventListener('click', () => {
        if (window.getSelection()?.toString()) return;
        seg.showOriginal = !seg.showOriginal;
        const fresh = el('div');
        renderGameText([seg], fresh);
        p.replaceWith(...fresh.childNodes);
      });
    }
    if (seg.translating) p.classList.add('translating');
    container.append(p);
  }
}

const BANNER_END = /^(Release|Revision)( number)? \d+ \/ Serial [Nn]umber \d+$/;

function findBanner(text) {
  const lines = text.split('\n');
  const start = lines.indexOf(current.meta?.bannerTitle);
  if (start >= 0) {
    for (let end = start + 1; end < Math.min(lines.length, start + 8); end++) {
      if (BANNER_END.test(lines[end])) return { start, end };
    }
  }
  // Otherwise: the paragraph that ends with the release / serial number line.
  const end = lines.findIndex((l) => BANNER_END.test(l));
  if (end < 1) return null;
  let s = end;
  while (s > 0 && end - s < 6 && lines[s - 1].trim()) s--;
  return s < end ? { start: s, end } : null;
}

function renderBanner(lines) {
  const box = el('div', 'banner');
  const text = el('div', 'banner-text');
  text.append(el('div', 'banner-title', lines[0]));
  if (lines[1]) text.append(el('div', 'banner-sub', lines[1]));
  const meta = el('div', 'banner-meta');
  lines.slice(2).forEach((l, i) => {
    if (i) meta.append(el('br'));
    meta.append(l);
  });
  text.append(meta);
  // The box cover beside it, where the card is wide enough (see the CSS).
  const cover = current.meta?.cover;
  if (cover) {
    box.classList.add('with-cover');
    box.style.setProperty('--banner-cover', `url("${cover}")`);
    const fig = el('div', 'banner-cover');
    const img = el('img');
    img.src = cover;
    img.alt = '';
    img.decoding = 'async';
    fig.append(img);
    const inner = el('div', 'banner-inner');
    inner.append(fig, text);
    box.append(inner);
    return box;
  }
  box.append(text);
  return box;
}

/** The part of a segment after the banner, keeping its translation in step. */
function splitAround(seg, { start, end }) {
  const cut = (text) => text.split('\n').filter((_, i) => i < start || i > end).join('\n').replace(/^\n+/, '');
  const text = cut(seg.text);
  if (!text.trim()) return null;
  // Keep the same object for the remainder so translation state and clicks stay attached.
  seg.rest ??= { fixed: false };
  seg.rest.text = text;
  if (seg.translated) {
    const tl = seg.translated.split('\n');
    seg.rest.translated = tl.length === seg.text.split('\n').length ? cut(seg.translated) : tl.slice(end + 1).join('\n').replace(/^\n+/, '');
  } else delete seg.rest.translated;
  seg.rest.translating = seg.translating;
  return seg.rest;
}

function renderEntry(entry, animate = true) {
  const turn = el('section', 'turn');
  if (!animate) turn.style.animation = 'none';
  if (entry.input != null) turn.append(el('p', 'player', entry.input));
  for (const step of entry.steps || []) {
    if (step.narration) {
      const p = el('p', `game-text narrated${step.immersive ? ' immersive' : ''}`, step.narration);
      p.title = t(step.immersive ? 'immersiveTitle' : 'narratedTitle');
      turn.append(p);
    }
    if (step.hint) {
      const note = el('div', 'ai-note hint-note', step.note);
      note.dataset.label = t(`hintLabel${step.level}`);
      if (step.level < 3 && entry === lastHintEntry) {
        const more = el('button', 'hint-more', t('hintStronger'));
        more.type = 'button';
        more.dataset.keepFocus = '';
        more.addEventListener('click', () => giveHint(true));
        note.append(more);
      }
      turn.append(note);
    } else if (step.note) turn.append(el('div', `ai-note${step.error ? ' error' : ''}`, step.note));
    const sameAsTyped = step.command && step.command.trim().toLowerCase() === String(entry.input ?? '').trim().toLowerCase();
    if (step.command && settings.showCommands && entry.viaAI && !sameAsTyped) {
      const wrap = el('div', 'interp');
      wrap.append(el('span', `chip${step.parserError ? ' error' : ''}`, step.command));
      turn.append(wrap);
    }
    if (step.segments?.length) renderGameText(step.segments, turn);
  }
  if (entry.system) turn.append(el('p', 'system-note', entry.system));
  els.transcript.append(turn);
  turn.entry = entry;
  lazyTranslator.observe(turn);
  return turn;
}

function addEntry(entry) {
  transcriptLog.push(entry);
  if (transcriptLog.length > 300) transcriptLog = transcriptLog.slice(-300);
  const node = renderEntry(entry);
  if (entry.input != null) pinTurn(node);
  else scrollDown();
  return node;
}

function showThinking(turnNode) {
  const t = el('div', 'thinking');
  t.append(el('i'), el('i'), el('i'));
  turnNode.append(t);
  scrollDown();
  return () => t.remove();
}

// ---------------------------------------------------------------------------
// Game session
// ---------------------------------------------------------------------------

let busy = false;
let undoStack = [];
let aiHistory = []; // {input, commands, output}
let commandHistory = GAME_ID ? store.get(K('cmdhistory'), []) : [];
let historyPos = -1;
let gameEnded = false;
let lastScore = null; // for the 80s mode's score jingle

const session = new GameSession({
  onStatus: ({ room, score, moves }) => {
    if (typeof score === 'number' && typeof lastScore === 'number' && score > lastScore && !GAMES[GAME_ID]?.clock) sfx.score();
    lastScore = score;
    currentRoom = room;
    els.room.textContent = room || '—';
    if (targetLanguage()) updateStatusRoom();
    els.score.textContent = score;
    els.time.textContent = GAMES[GAME_ID]?.clock ? clockTime(score, moves) : moves;
  },
  onUpper: (rows, cursor) => { renderUpper(rows, cursor); queueMicrotask(updateMode); },
  onSave: (snap) => openSlots('save', snap),
  onRestore: () => openSlots('load'),
});

let restartResponse = null; // set when the game restarted during the current input

// Inputs, raw replies and recent game states, for debug reports (see debug.js).
const debugLog = new DebugLog(GAME_ID ? store.get(K('debuglog'), null) : null);
debugLog.captureErrors();

async function sendToGame(command) {
  const before = safeRoom();
  const logEntry = debugLog.input(command, { snapshot: session.currentSnapshot(), room: before, keyInput: session.waitingForKey });
  const res = await session.send(command);
  debugLog.output(logEntry, res, safeRoom());
  gameEnded = !!res.ended;
  if (res.restarted) restartResponse = res;
  if (automap) {
    try { if (automap.observe(command, before)) saveMap(); } catch { /* the map never gets in the game's way */ }
    renderMap();
  }
  return res;
}

// ---------------------------------------------------------------------------
// Automap (desktop only): rooms visited and the ways between them
// ---------------------------------------------------------------------------

const mapEls = { panel: $('automap'), svg: $('automap-svg'), empty: $('am-empty'), btn: $('btn-map') };
const desktopMedia = matchMedia('(min-width: 1100px) and (hover: hover) and (pointer: fine)');
let automap = null;
const mapView = { scale: 0.85, cx: 0, cy: 0, panX: 0, panY: 0 };
const mapLabels = new Map(); // English room name -> translated label (or a pending promise)

function safeRoom() { try { return roomObject(); } catch { return 0; } }
const mapOpen = () => !mapEls.panel.hidden && desktopMedia.matches;
const saveMap = () => store.set(K('automap'), automap.toJSON());

function initMap() {
  automap = new Automap(store.get(K('automap'), null));
  try { automap.sync(); saveMap(); } catch { /* no room yet */ }
  setMapOpen(settings.mapOpen);
}

function setMapOpen(open) {
  mapEls.panel.hidden = !open;
  mapEls.btn.setAttribute('aria-pressed', String(open));
  updateMapShift();
  renderMap();
}

/** Room names in the transcript's language (translated once, then cached). */
function mapLabel(name) {
  const language = targetLanguage();
  if (!language) return name;
  const key = `${language}:${name}`;
  const hit = mapLabels.get(key);
  if (typeof hit === 'string') return hit;
  if (!hit) {
    mapLabels.set(key, translateLabel({ apiKey: settings.apiKey, model: settings.model, language, text: name })
      .then((label) => { mapLabels.set(key, label); renderMap(false); })
      .catch(() => mapLabels.set(key, name)));
  }
  return name;
}

function renderMap(recenter = true) {
  if (!automap || !mapOpen()) return;
  const [cx, cy] = drawMap(automap, mapEls.svg, mapLabel);
  if (recenter) Object.assign(mapView, { cx, cy, panX: 0, panY: 0 });
  applyMapView();
  mapEls.empty.hidden = Object.keys(automap.rooms).length > 1;
}

function applyMapView() {
  const r = mapEls.svg.getBoundingClientRect();
  if (!r.width) return;
  const w = r.width / mapView.scale;
  const h = r.height / mapView.scale;
  mapEls.svg.setAttribute('viewBox', `${mapView.cx + mapView.panX - w / 2} ${mapView.cy + mapView.panY - h / 2} ${w} ${h}`);
}

/** Move the text column left where it would run under the open map. */
function updateMapShift() {
  let shift = 0;
  if (mapOpen()) {
    const left = els.transcript.offsetLeft;
    const right = left + els.transcript.offsetWidth;
    const limit = window.innerWidth - mapEls.panel.offsetWidth - 18 - 24;
    shift = Math.max(0, Math.min(right - limit, left - 16));
  }
  document.body.style.setProperty('--map-shift', `${shift}px`);
}

mapEls.btn.addEventListener('click', () => {
  settings.mapOpen = mapEls.panel.hidden;
  saveSettings();
  setMapOpen(settings.mapOpen);
});
$('am-close').addEventListener('click', () => { settings.mapOpen = false; saveSettings(); setMapOpen(false); });
$('am-zoomin').addEventListener('click', () => { mapView.scale = Math.min(2, mapView.scale * 1.25); applyMapView(); });
$('am-zoomout').addEventListener('click', () => { mapView.scale = Math.max(0.3, mapView.scale / 1.25); applyMapView(); });
$('am-center').addEventListener('click', () => renderMap(true));
$('am-clear').addEventListener('click', () => {
  if (!automap || !confirm(t('mapClearConfirm'))) return;
  automap.clear();
  try { automap.sync(); } catch { /* no room */ }
  saveMap();
  renderMap();
});
mapEls.svg.addEventListener('wheel', (e) => {
  e.preventDefault();
  mapView.scale = Math.min(2, Math.max(0.3, mapView.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
  applyMapView();
}, { passive: false });
mapEls.svg.addEventListener('pointerdown', (e) => {
  const start = { x: e.clientX, y: e.clientY, panX: mapView.panX, panY: mapView.panY };
  mapEls.svg.setPointerCapture(e.pointerId);
  mapEls.svg.classList.add('dragging');
  const move = (ev) => {
    mapView.panX = start.panX - (ev.clientX - start.x) / mapView.scale;
    mapView.panY = start.panY - (ev.clientY - start.y) / mapView.scale;
    applyMapView();
  };
  const up = () => {
    mapEls.svg.classList.remove('dragging');
    mapEls.svg.removeEventListener('pointermove', move);
    mapEls.svg.removeEventListener('pointerup', up);
    mapEls.svg.removeEventListener('pointercancel', up);
  };
  mapEls.svg.addEventListener('pointermove', move);
  mapEls.svg.addEventListener('pointerup', up);
  mapEls.svg.addEventListener('pointercancel', up);
});
desktopMedia.addEventListener('change', () => { updateMapShift(); renderMap(); });
window.addEventListener('resize', () => { updateMapShift(); applyMapView(); });
new ResizeObserver(() => { updatePageSpace(); applyMapView(); }).observe(els.topbar);

/** A new game started (RESTART, or any input after QUIT): show it like a fresh page load. */
function startFresh(res) {
  els.transcript.replaceChildren();
  transcriptLog = [];
  undoStack = [];
  gameEnded = false;
  aiHistory = [{ input: '', commands: [], output: res.text }];
  const entry = { steps: [{ segments: res.segments }] };
  translateEntry(entry, addEntry(entry));
  window.scrollTo({ top: 0 });
  actionTarget = null;
  renderActions();
  updateMore();
}

function autosave() {
  const snap = session.currentSnapshot();
  if (!snap) return;
  store.set(K('debuglog'), debugLog.toJSON());
  store.set(K('autosave'), {
    snapshot: snap, transcript: transcriptLog.slice(-120), aiHistory: aiHistory.slice(-12),
    meta: { room: els.room.textContent, score: Number(els.score.textContent) || 0, moves: Number(els.time.textContent) || 0, clock: GAMES[GAME_ID]?.clock ? els.time.textContent : undefined, date: Date.now() },
  });
}

/**
 * Handle one input line. `opts.command` (from a quick-action button) is sent to
 * the game as-is, with `opts.label` shown in the transcript.
 */
async function handleInput(raw, opts = {}) {
  const text = raw.trim();
  if (busy) return;
  busy = true;
  setInputEnabled(false);
  try {
    if (gameEnded) {
      startFresh(await session.send(text));
      autosave();
      return;
    }
    if (!opts.command && HINT_WORDS.test(text) && settings.apiKey) {
      await giveHint(false, text);
      return;
    }
    undoStack.push(session.currentSnapshot());
    if (undoStack.length > 100) undoStack.shift();
    if (opts.command) {
      const res = await sendToGame(opts.command);
      const label = opts.label || opts.command;
      const entry = { input: label, viaAI: label.toLowerCase() !== opts.command, steps: [{ command: opts.command, segments: res.segments }] };
      let node = addEntry(entry);
      await translateEntry(entry, node);
      node = await addAtmosphere(entry, node, { input: label, command: opts.command, output: res.text });
      aiHistory.push({ input: opts.command, commands: [opts.command], output: res.text, reply: atmosphereOf(entry) });
    } else if (!aiActive() || text.startsWith('>') || text === '' || session.waitingForKey) {
      const cmd = text.replace(/^>\s*/, '');
      const res = await sendToGame(cmd);
      const entry = { input: text.replace(/[\x81-\x84]/g, (c) => '↑↓←→'[c.charCodeAt(0) - 129]), steps: [{ segments: res.segments }] };
      let node = addEntry(entry);
      await translateEntry(entry, node);
      if (!session.waitingForKey && cmd) node = await addAtmosphere(entry, node, { input: cmd, command: cmd, output: res.text });
      aiHistory.push({ input: cmd, commands: [cmd], output: res.text, reply: atmosphereOf(entry) });
    } else {
      await aiTurn(text);
    }
    if (restartResponse) { startFresh(restartResponse); restartResponse = null; }
    else if (gameEnded) addEntry({ system: t('gameEnded') });
    autosave();
  } finally {
    busy = false;
    setInputEnabled(true);
    renderActions();
    keepFocus();
  }
}

// ---------------------------------------------------------------------------
// Hints
// ---------------------------------------------------------------------------

const HINT_WORDS = /^\s*(hint|hints|help|clue|tipp|tipps|tip|hilfe|hinweis)\s*[?!.]*\s*$/i;
let hintLevel = 0;
let hintKey = '';
let lastHintEntry = null;

/** Ask for a hint; `stronger` raises the level for the same situation (1 nudge .. 3 solution). */
async function giveHint(stronger, typed) {
  if (!settings.apiKey) { addEntry({ input: typed || t('hintRequest'), steps: [{ note: t('hintNeedsKey'), error: true }] }); return; }
  const ownBusy = !busy;
  if (!ownBusy && !typed) return;
  if (ownBusy) { busy = true; setInputEnabled(false); }
  const key = `${currentRoom}|${els.score.textContent}`;
  hintLevel = key === hintKey ? Math.min(3, hintLevel + 1) : 1;
  if (!stronger && key !== hintKey) hintLevel = 1;
  hintKey = key;
  const entry = { input: typed || (stronger ? t('hintStronger') : t('hintRequest')), steps: [] };
  const prevHint = lastHintEntry;
  lastHintEntry = entry;
  if (prevHint) {
    // Only the newest hint offers a "stronger hint" button.
    const prevNode = [...els.transcript.children].find((n) => n.entry === prevHint);
    if (prevNode) rerender(prevNode, prevHint);
  }
  let node = addEntry(entry);
  const stop = showThinking(node);
  try {
    const hint = await getHint({
      apiKey: settings.apiKey, model: settings.model, level: hintLevel,
      language: AI_LANGUAGE_NAME[settings.language] || 'English', history: aiHistory,
    });
    entry.steps.push({ note: hint, hint: true, level: hintLevel });
  } catch (err) {
    entry.steps.push({ note: t('hintFailed', { error: errorText(err) }), error: true });
  } finally {
    stop();
    node = rerender(node, entry);
    if (ownBusy) { busy = false; setInputEnabled(true); renderActions(); keepFocus(); }
    autosave();
  }
}

async function aiTurn(text) {
  const entry = { input: text, viaAI: true, steps: [] };
  let node = renderEntry(entry);
  transcriptLog.push(entry);
  pinTurn(node);
  const stopThinking = showThinking(node);
  let result;
  try {
    result = await interpret({
      apiKey: settings.apiKey, model: settings.model, input: text, language: targetLanguage(),
      scene: currentScene(), history: aiHistory.slice(-10), immersive: immersiveOn(),
    });
  } catch (err) {
    stopThinking();
    // Fall back to the original parser so the game stays playable.
    const res = await sendToGame(text);
    entry.steps.push({ note: t('aiFailed', { error: errorText(err) }), error: true },
      { segments: res.segments });
    aiHistory.push({ input: text, commands: [text], output: res.text });
    node = rerender(node, entry);
    await translateEntry(entry, node);
    return;
  }
  stopThinking();
  if (result.reply) entry.steps.push({ narration: result.reply });
  const outputs = [];
  for (let i = 0; i < result.commands.length; i++) {
    let command = result.commands[i];
    let res = await sendToGame(command);
    let parserError = isParserError(res.text);
    if (parserError && i === 0) {
      // Give the AI one chance to rephrase using the parser's complaint.
      // (Parser errors take no game time, so retrying is safe.)
      try {
        const stop = showThinking(node);
        const fix = await interpret({
          apiKey: settings.apiKey, model: settings.model, input: text, language: targetLanguage(), scene: currentScene(),
          history: aiHistory.slice(-10), repair: { command, error: res.text }, immersive: immersiveOn(),
        });
        stop();
        if (fix.commands.length) {
          entry.steps.push({ command, segments: [], parserError: true });
          command = fix.commands[0];
          res = await sendToGame(command);
          parserError = isParserError(res.text);
          result.commands.splice(i, 1, ...fix.commands);
        } else if (fix.reply) {
          entry.steps.push({ narration: fix.reply });
        }
      } catch { /* keep the original response */ }
    }
    entry.steps.push({ command, segments: res.segments, parserError });
    outputs.push(res.text);
    node = rerender(node, entry);
    if (res.restarted || res.ended || /RESTART, RESTORE, or QUIT|\(Y is affirmative\)|Please answer YES or NO/.test(res.text)) break;
    if (parserError) break;
  }
  // Immersive mode: scenery the game has no word for is described by the AI.
  let described = false;
  if (result.describe && !result.commands.length && immersiveOn()) {
    const before = entry.steps.length;
    node = await addAtmosphere(entry, node, { input: text, command: `examine ${result.describe}`, output: '', force: true });
    described = entry.steps.length > before;
  }
  if (!result.commands.length && !result.reply && !described) entry.steps.push({ narration: t('cantMap') });
  node = rerender(node, entry);
  await translateEntry(entry, node);
  // Immersive mode: atmosphere where the game's last answer was a stock phrase.
  const lastStep = [...entry.steps].reverse().find((st) => st.segments);
  if (lastStep && outputs.length) {
    node = await addAtmosphere(entry, node, { input: text, command: lastStep.command ?? result.commands.at(-1), output: outputs.at(-1) });
  }
  aiHistory.push({ input: text, reply: [result.reply, atmosphereOf(entry)].filter(Boolean).join('\n'), commands: result.commands, output: outputs.join('\n') });
}

// ---------------------------------------------------------------------------
// Immersive mode (per game, with the AI on): atmosphere where the game is terse
// ---------------------------------------------------------------------------

const immersiveOn = () => aiActive() && !!GAME_ID && store.get(K('immersive'), false) === true;
const atmosphereOf = (entry) => entry.steps?.find((st) => st.immersive)?.narration ?? '';

/**
 * After the game answered `command` with a stock phrase ("There's nothing
 * special about the posters."), add the AI's description. The same thing in the
 * same room is described the same way every time (cached per game).
 */
async function addAtmosphere(entry, node, { input, command, output, force = false }) {
  if (!immersiveOn() || !command || gameEnded || (!force && !needsAtmosphere(output))) return node;
  const room = els.room.textContent || '';
  const key = `${settings.language}|${room}|${command.toLowerCase().replace(/\s+/g, ' ').trim()}`;
  const cache = store.get(K('immersion'), {});
  let text = cache[key];
  if (text == null) {
    const stop = showThinking(node);
    try {
      text = await immerse({
        apiKey: settings.apiKey, model: settings.model, language: targetLanguage(), input, command, output,
        scene: currentScene(), history: aiHistory.slice(-8),
      });
    } catch {
      text = null; // no atmosphere this time; try again next time
    }
    stop();
    if (text == null) return node;
    cache[key] = text;
    const keys = Object.keys(cache);
    if (keys.length > 400) for (const k of keys.slice(0, keys.length - 400)) delete cache[k];
    store.set(K('immersion'), cache);
  }
  if (!text) return node;
  entry.steps.push({ narration: text, immersive: true });
  return rerender(node, entry);
}

function rerender(node, entry) {
  // Only follow the output when the turn being updated is the newest one;
  // translating older turns must not yank the view away from what you read.
  const isLast = node === els.transcript.lastElementChild;
  const fresh = renderEntry(entry, false);
  lazyTranslator.unobserve(node);
  node.replaceWith(fresh);
  if (isLast) scrollDown();
  return fresh;
}

/** A short, localised description of an OpenRouter/network failure. */
function errorText(err) {
  const s = err?.status;
  const key = s === 401 || s === 403 ? 'errAuth' : s === 402 ? 'errCredits' : s === 429 ? 'errRate'
    : s === 404 || s === 400 && /model/i.test(err.message) ? 'errModel' : s >= 500 ? 'errServer'
    : err instanceof TypeError ? 'errNetwork' : s ? 'errOther' : null;
  if (!key) return err?.message || String(err);
  return settings.language === 'en' ? `${t(key)} (${err.message})` : `${t(key)} (${s || '—'})`;
}

// Rough language check: does this read like English rather than German?
function looksEnglish(text) {
  const words = text.toLowerCase().match(/[a-zäöüß']+/g) || [];
  const en = words.filter((w) => /^(the|you|your|is|are|and|not|can't|cannot|it|this|that|of|to|a|an|with|there|here|nothing|what|which)$/.test(w)).length;
  const de = words.filter((w) => /^(der|die|das|du|dein|deine|ist|sind|und|nicht|kannst|es|ein|eine|mit|hier|nichts|was|welche|zu|den|dem)$/.test(w)).length;
  return en > de;
}

/** AI-written lines (narrator replies, hints) that came back in English get translated too. */
async function translateAiLines(entry, language) {
  const steps = (entry.steps || []).filter((st) => (st.narration || st.hint) && !st.error &&
    st.lineLanguage !== language && !st.translatingLine);
  let changed = false;
  await Promise.all(steps.map(async (st) => {
    const text = st.originalNarration ?? st.narration ?? st.originalNote ?? st.note;
    st.translatingLine = true;
    try {
      if (looksEnglish(text)) {
        const tl = await translate({ apiKey: settings.apiKey, model: settings.model, language, text });
        if (st.narration != null) { st.originalNarration ??= st.narration; st.narration = tl; }
        else { st.originalNote ??= st.note; st.note = tl; }
        changed = true;
      }
      st.lineLanguage = language;
    } catch { /* keep the line as it is */ }
    st.translatingLine = false;
  }));
  return changed;
}

/** Translate all untranslated game text in an entry, updating its node as it goes. */
async function translateEntry(entry, node) {
  const language = targetLanguage();
  if (!language) return node;
  // Each entry is translated once per language. Segments still in progress or
  // already failed are skipped, so this is safe to call repeatedly.
  translateAiLines(entry, language).then((changed) => {
    const current = changed && [...els.transcript.children].find((n) => n.entry === entry);
    if (current) rerender(current, entry);
  });
  const segs = (entry.steps || []).flatMap((st) => st.segments || [])
    .filter((sg) => !sg.fixed && sg.text.trim() && (sg.translatedTo !== language || (!sg.translated && !sg.translating && !sg.translateError)))
    .filter((sg) => !sg.translating);
  for (const sg of segs) if (sg.translatedTo !== language) { delete sg.translated; delete sg.translateError; sg.translatedTo = language; }
  if (!segs.length) return node;
  segs.forEach((sg) => { sg.translating = true; });
  node = rerender(node, entry);
  await Promise.all(segs.map(async (sg) => {
    try {
      sg.translated = await translate({ apiKey: settings.apiKey, model: settings.model, language, text: sg.text });
    } catch (err) {
      sg.translateError = errorText(err);
    }
    sg.translating = false;
  }));
  const failed = segs.find((sg) => sg.translateError);
  if (failed) entry.steps.push({ note: t('translationFailed', { error: failed.translateError }), error: true });
  return rerender(node, entry);
}

async function updateStatusRoom() {
  const language = targetLanguage();
  if (!language || !currentRoom) { els.room.textContent = currentRoom || '—'; return; }
  const room = currentRoom;
  try {
    const t = await translateLabel({ apiKey: settings.apiKey, model: settings.model, language, text: room });
    if (room === currentRoom) els.room.textContent = t;
  } catch { /* keep English */ }
}

async function undo() {
  if (busy || !undoStack.length) return;
  busy = true;
  setInputEnabled(false);
  try {
    const snap = undoStack.pop();
    debugLog.checkpoint(debugLog.add('undo').n, snap);
    await session.load(snap);
    if (automap) { try { automap.sync(); } catch { /* keep the map */ } renderMap(); }
    gameEnded = false;
    aiHistory.pop();
    addEntry({ system: t('undone') });
    autosave();
  } finally {
    busy = false;
    setInputEnabled(true);
    renderActions();
    keepFocus();
  }
}

// ---------------------------------------------------------------------------
// Save / restore slots
// ---------------------------------------------------------------------------

let slotsResolve = null;
let slotsMode = 'save';
let slotsSelected = null;
let slotsSnapshot = null;

function listSaves() { return store.get(K('saves'), {}); }

function openSlots(mode, snap) {
  slotsMode = mode;
  slotsSnapshot = snap;
  slotsSelected = null;
  els.slotsTitle.textContent = mode === 'save' ? t('saveGameTitle') : t('restoreGameTitle');
  els.slotNameField.style.display = mode === 'save' ? '' : 'none';
  els.slotsOk.textContent = mode === 'save' ? t('saveButton') : t('restoreButton');
  els.slotName.value = mode === 'save' ? `${els.room.textContent !== '—' ? els.room.textContent : t('defaultSaveName')} — ${new Date().toLocaleString(settings.language)}` : '';
  drawSlots();
  els.slots.showModal();
  if (mode === 'save') els.slotName.select();
  return new Promise((resolve) => { slotsResolve = resolve; });
}

function drawSlots() {
  const saves = listSaves();
  els.slotsList.replaceChildren();
  const names = Object.keys(saves).sort((a, b) => saves[b].date - saves[a].date);
  if (!names.length) els.slotsList.append(el('p', 'empty', t('noSaves')));
  for (const name of names) {
    const b = el('button', `slot${slotsSelected === name ? ' selected' : ''}`);
    b.type = 'button';
    b.append(el('span', 'slot-name', name), el('span', 'slot-meta', new Date(saves[name].date).toLocaleDateString(settings.language)));
    const del = el('span', 'slot-del', '×');
    del.title = t('delete');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      const s = listSaves(); delete s[name]; store.set(K('saves'), s); drawSlots();
    });
    b.append(del);
    b.addEventListener('click', () => { slotsSelected = name; els.slotName.value = name; drawSlots(); });
    b.addEventListener('dblclick', () => { slotsSelected = name; els.slots.close('ok'); });
    els.slotsList.append(b);
  }
}

els.slots.addEventListener('close', () => {
  const ok = els.slots.returnValue === 'ok';
  const resolve = slotsResolve;
  slotsResolve = null;
  if (!resolve) return;
  if (slotsMode === 'save') {
    const name = els.slotName.value.trim();
    if (!ok || !name) return resolve(false);
    const saves = listSaves();
    saves[name] = { snapshot: slotsSnapshot, date: Date.now(), room: currentRoom };
    resolve(store.set(K('saves'), saves));
  } else {
    const saves = listSaves();
    resolve(ok && slotsSelected && saves[slotsSelected] ? saves[slotsSelected].snapshot : null);
  }
});

// ---------------------------------------------------------------------------
// Header: the game's name in letters cut from its box cover
// ---------------------------------------------------------------------------

function coverTitle(meta) {
  const brand = $('home');
  const title = $('game-title');
  // The glow (a filter) stays on the outer element: on the element with the
  // animated cover fill it would make Chrome draw a box around the text.
  const fill = document.createElement('span');
  fill.className = 'title-fill';
  fill.textContent = title.textContent;
  fill.dataset.text = title.textContent;
  title.replaceChildren(fill);
  brand.style.setProperty('--cover-img', `url("${meta.cover}")`);
  brand.classList.add('has-cover');
  // Glow in the cover's own most vivid colour.
  const img = new Image();
  img.addEventListener('load', () => {
    const [c1, c2] = paletteOf(img);
    brand.style.setProperty('--cover-glow', c1);
    brand.style.setProperty('--cover-glow-2', c2 ?? c1);
  }, { once: true });
  img.src = meta.cover;
}

// ---------------------------------------------------------------------------
// Debug report (Settings: "Report a problem")
// ---------------------------------------------------------------------------

/** Everything needed to understand and replay a problem; never the API key. */
function debugReport() {
  const meta = GAMES[GAME_ID];
  const safe = (f) => { try { return f(); } catch (e) { return { error: String(e?.message ?? e) }; } };
  const roomId = safeRoom();
  return {
    format: 'planetfall-ai-debug-report',
    version: 1,
    readme: REPORT_README,
    created: new Date().toISOString(),
    build: BUILD,
    page: location.origin + location.pathname + location.search,
    browser: { userAgent: navigator.userAgent, language: navigator.language, viewport: [innerWidth, innerHeight], pixelRatio: devicePixelRatio, paging },
    settings: {
      language: settings.language, aiEnabled: settings.aiEnabled, hasApiKey: !!settings.apiKey, aiActive: aiActive(),
      model: settings.model, showCommands: settings.showCommands, mapOpen: settings.mapOpen, immersive: immersiveOn(),
    },
    game: { id: GAME_ID, title: meta?.title, zVersion: current.story?.LAYOUT?.version },
    state: {
      busy, gameEnded, waitingForKey: !!session.waitingForKey,
      room: { id: roomId, name: safe(() => (roomId ? inspect.objectName(roomId) : '')) },
      header: { room: els.room.textContent, score: els.score.textContent, time: els.time.textContent },
      upperWindow: document.getElementById('upper-window')?.hidden ? null : document.getElementById('upper-window')?.textContent,
      lastInput: commandHistory[commandHistory.length - 1] ?? null,
      undoDepth: undoStack.length,
    },
    scene: safe(() => currentScene()),
    actions: safe(() => actionContext()),
    log: debugLog.entries,
    checkpoints: debugLog.checkpoints,
    current: session.currentSnapshot(),
    errors: debugLog.errors,
    transcript: transcriptLog.slice(-150),
    aiHistory,
    commandHistory: commandHistory.slice(-60),
    automap: automap?.toJSON() ?? null,
  };
}

$('debug-report').addEventListener('click', () => {
  if (!GAME_ID) { alert(t('debugNoGame')); return; }
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  downloadJSON(debugReport(), `debug-${GAME_ID}-${stamp}.json`);
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function openSettings() {
  els.setKey.value = settings.apiKey;
  els.setModel.value = settings.model;
  els.setAi.checked = settings.aiEnabled;
  els.setShow.checked = settings.showCommands;
  $('set-title-motion').checked = settings.titleMotion;
  els.setLang.value = settings.language;
  $('set-immersive-field').hidden = !GAME_ID;
  if (GAME_ID) {
    $('set-immersive').checked = store.get(K('immersive'), false) === true;
    $('set-immersive-label').textContent = t('immersiveLabel', { title: GAMES[GAME_ID].title });
  }
  els.settings.showModal();
  if (!els.modelList.childElementCount) {
    listModels().then((models) => {
      for (const m of models) {
        const o = document.createElement('option');
        o.value = m.id; o.label = m.name;
        els.modelList.append(o);
      }
    }).catch(() => {});
  }
}

els.settings.addEventListener('close', async () => {
  if (els.settings.returnValue !== 'ok') return;
  if (!GAME_ID) {
    settings.apiKey = els.setKey.value.trim();
    settings.model = els.setModel.value.trim();
    settings.aiEnabled = els.setAi.checked;
    settings.showCommands = els.setShow.checked;
    settings.titleMotion = $('set-title-motion').checked;
    applyTitleMotion();
    settings.language = normalizeLanguage(els.setLang.value);
    if (settings.apiKey && !settings.model) settings.model = await pickDefaultModel();
    saveSettings();
    setLanguage(settings.language);
    applyStatic();
    refreshRetroControls();
    renderMenu({ openSettings });
    return;
  }
  const prevTarget = targetLanguage();
  store.set(K('immersive'), $('set-immersive').checked);
  settings.apiKey = els.setKey.value.trim();
  settings.model = els.setModel.value.trim();
  settings.aiEnabled = els.setAi.checked;
  settings.showCommands = els.setShow.checked;
  settings.titleMotion = $('set-title-motion').checked;
  applyTitleMotion();
  const prevLang = settings.language;
  settings.language = normalizeLanguage(els.setLang.value);
  if (settings.apiKey && !settings.model) settings.model = await pickDefaultModel();
  saveSettings();
  setLanguage(settings.language);
  applyStatic();
  refreshRetroControls();
  updateMode();
  updateStatusRoom();
  renderActions();
  const target = targetLanguage();
  if (settings.language !== prevLang) {
    if (settings.language === 'en') addEntry({ system: t('nowEnglish') });
    else addEntry({ system: target ? t('nowGerman') : !settings.apiKey ? t('needsKey') : t('needsAi') });
  }
  if (target !== prevTarget) translateVisible();
});

/** After switching language: translate the most recent turns already on screen. */
// Story text is translated lazily: whenever a turn scrolls into view and is not
// yet translated into the current language. This covers the whole transcript,
// including turns from before a language switch or a reload.
const lazyTranslator = new IntersectionObserver((items) => {
  for (const it of items) {
    if (!it.isIntersecting || !targetLanguage()) continue;
    const node = it.target;
    if (node.isConnected && node.entry) translateEntry(node.entry, node);
  }
}, { rootMargin: '400px 0px' });

/** After switching language: re-render everything; visible turns get (re)translated. */
function translateVisible() {
  for (const node of [...els.transcript.querySelectorAll('section.turn')]) {
    const entry = node.entry;
    if (!entry) continue;
    if (!targetLanguage()) {
      for (const sg of (entry.steps || []).flatMap((st) => st.segments || [])) { delete sg.translated; delete sg.translatedTo; delete sg.translateError; }
      for (const st of entry.steps || []) {
        if (st.originalNarration != null) { st.narration = st.originalNarration; delete st.originalNarration; }
        if (st.originalNote != null) { st.note = st.originalNote; delete st.originalNote; }
        delete st.lineLanguage;
      }
    }
    rerender(node, entry);
  }
}

function updateMode() {
  const ai = aiActive();
  els.badge.textContent = ai ? (immersiveOn() ? t('badgeImmersive') : t('badgeAi')) : t('badgeClassic');
  els.badge.classList.toggle('ai', ai);
  els.badge.title = ai ? t('badgeTitleAi', { model: settings.model })
    : settings.apiKey ? t('badgeTitleClassicKey') : t('badgeTitleClassicNoKey');
  const example = current.meta?.example?.[settings.language] ?? current.meta?.example?.en;
  els.input.placeholder = session.waitingForKey ? t('placeholderKeys')
    : ai ? (example ? t('placeholderAiGame', { example }) : t('placeholderAi')) : t('placeholderClassic');
  els.hint.replaceChildren();
  if (ai) {
    els.hint.append(targetLanguage() ? t('hintAiTranslated') : t('hintAi'));
  } else {
    els.hint.append(t('hintClassic'));
    const a = el('a', null, settings.apiKey ? t('hintTurnOnAi') : t('hintAddKey'));
    a.href = '#'; a.addEventListener('click', (e) => { e.preventDefault(); openSettings(); });
    els.hint.append(a, t('hintPlainLanguage'));
    if (settings.language !== 'en') els.hint.append(t('hintNeededForTranslation'));
  }
}

// Cancel buttons are type="button" so that pressing Enter/Go in a field submits
// the dialog's primary action instead of cancelling it.
for (const b of document.querySelectorAll('dialog [data-close]')) {
  b.addEventListener('click', () => b.closest('dialog').close('cancel'));
}

// ---------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------

// The text field is never disabled while the game works: disabling it would
// blur it and close the phone keyboard. Submits are ignored while busy instead.
let workingSound = false;
function setInputEnabled(on) {
  // 80s mode: the floppy drive runs while the game or the AI works; a blip when done.
  if (!on && !workingSound) { workingSound = true; sfx.busy(true); }
  else if (on && workingSound) { workingSound = false; sfx.busy(false); sfx.reply(); }
  els.input.disabled = false;
  els.send.disabled = !on;
  els.form.classList.toggle('busy', !on);
  els.actions.setAttribute('aria-busy', String(!on));
  els.undo.disabled = !on || !undoStack.length;
}

function keepFocus() {
  if (document.activeElement !== els.input && !document.querySelector('dialog[open]')) {
    els.input.focus({ preventScroll: true });
  }
}

// Tapping these controls must not take focus away from the text field.
for (const ev of ['pointerdown', 'mousedown']) {
  document.addEventListener(ev, (e) => {
    if (e.target.closest('[data-keep-focus], .act')) e.preventDefault();
  });
}
els.more.addEventListener('click', pageDown);

// ---------------------------------------------------------------------------
// Quick actions
// ---------------------------------------------------------------------------

let actionTarget = null; // object whose verbs are shown

function actButton(label, cls, onClick, title) {
  const b = el('button', `act ${cls}`, label);
  b.type = 'button';
  if (title) b.title = title;
  b.addEventListener('click', () => { if (!busy) onClick(); });
  return b;
}

function runAction(command, label) {
  actionTarget = null;
  handleInput('', { command, label });
}

const VERB_COMMAND = {
  examine: 'examine', take: 'take', drop: 'drop', open: 'open', close: 'close', lookin: 'look in', read: 'read',
  eat: 'eat', wear: 'wear', remove: 'remove', turnon: 'turn on', turnoff: 'turn off', push: 'push', talk: 'talk to',
};

const objectLabels = new Map(); // English label -> translated label

function objectLabel(label) {
  if (!targetLanguage()) return label;
  const key = `${settings.language}:${label}`;
  if (objectLabels.has(key)) return objectLabels.get(key);
  objectLabels.set(key, label);
  translateLabel({ apiKey: settings.apiKey, model: settings.model, language: targetLanguage(), text: label })
    .then((tl) => { objectLabels.set(key, tl); renderActions(); })
    .catch(() => {});
  return label;
}

// The action bar scrolls sideways: by touch on phones; with a mouse also by the
// wheel and by dragging. The edges fade where more buttons are hidden.
function updateActionFade() {
  const bar = els.actions;
  const left = bar.scrollLeft > 2;
  const right = bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 2;
  if (left || right) bar.dataset.more = left && right ? 'both' : left ? 'left' : 'right';
  else delete bar.dataset.more;
}
els.actions.addEventListener('scroll', updateActionFade, { passive: true });
window.addEventListener('resize', updateActionFade);
els.actions.addEventListener('wheel', (e) => {
  const bar = els.actions;
  if (bar.scrollWidth <= bar.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
  e.preventDefault();
  bar.scrollLeft += e.deltaY;
}, { passive: false });
{
  let drag = null;
  let dragged = false;
  // A drag is not a click on the button it started on.
  els.actions.addEventListener('click', (ev) => { if (dragged) { ev.stopPropagation(); ev.preventDefault(); } }, { capture: true });
  els.actions.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    drag = { x: e.clientX, left: els.actions.scrollLeft, moved: false, id: e.pointerId };
  });
  els.actions.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) > 5) {
      drag.moved = true;
      els.actions.setPointerCapture(drag.id);
      els.actions.classList.add('dragging');
    }
    if (drag.moved) els.actions.scrollLeft = drag.left - dx;
  });
  const end = () => {
    if (drag?.moved) {
      dragged = true;
      setTimeout(() => { dragged = false; els.actions.classList.remove('dragging'); });
    }
    drag = null;
  };
  els.actions.addEventListener('pointerup', end);
  els.actions.addEventListener('pointercancel', end);
}

function renderActions() {
  renderActionButtons();
  updateActionFade();
}

function renderActionButtons() {
  const bar = els.actions;
  bar.replaceChildren();
  const last = transcriptLog[transcriptLog.length - 1];
  const lastText = (last?.steps || []).flatMap((st) => st.segments || []).map((sg) => sg.text).join('\n');

  // The game is waiting for a specific answer.
  if (gameEnded) return;
  if (/RESTART, RESTORE, or QUIT/.test(lastText)) {
    for (const k of ['restart', 'restore', 'quit']) bar.append(actButton(t(`act_${k}`), 'answer', () => runAction(k, t(`act_${k}`))));
    return;
  }
  if (/\(Y is affirmative\)|YES or NO|\(Type YES or NO\)/i.test(lastText)) {
    bar.append(actButton(t('act_yes'), 'answer', () => runAction('yes', t('act_yes'))),
      actButton(t('act_no'), 'answer', () => runAction('no', t('act_no'))));
    return;
  }
  // The game reads single keys (menus, forms): cursor keys and Return, for
  // devices without a keyboard.
  if (session.waitingForKey) {
    bar.append(actButton('↑', 'answer', () => handleInput(String.fromCharCode(129))),
      actButton('↓', 'answer', () => handleInput(String.fromCharCode(130))),
      actButton(t('act_return'), 'answer', () => handleInput('')));
    return;
  }

  const ctx = actionContext();
  if (actionTarget) {
    const o = ctx.objects.find((x) => x.obj === actionTarget);
    if (o) {
      bar.append(actButton('‹', 'back', () => { actionTarget = null; renderActions(); }, t('back')));
      bar.append(el('span', 'act-target', objectLabel(o.label)));
      for (const v of o.verbs) {
        const cmd = `${VERB_COMMAND[v]} ${o.cmd}`;
        bar.append(actButton(t(`verb_${v}`), 'verb', () => runAction(cmd, `${t(`verb_${v}`)}: ${objectLabel(o.label)}`)));
      }
      bar.scrollLeft = 0;
      return;
    }
    actionTarget = null;
  }
  for (const d of ctx.exits) {
    bar.append(actButton(t(`dir_${d}`), 'dir', () => runAction(d, t(`dirname_${d}`)), t(`dirname_${d}`)));
  }
  if (ctx.exits.length) bar.append(el('span', 'act-sep'));
  for (const k of ['look', 'inventory', 'wait']) {
    bar.append(actButton(t(`act_${k}`), 'cmd', () => runAction(k, t(`act_${k}`))));
  }
  if (ctx.objects.length) bar.append(el('span', 'act-sep'));
  for (const o of ctx.objects) {
    const b = actButton(objectLabel(o.label), `obj${o.held ? ' held' : ''}`, () => { actionTarget = o.obj; renderActions(); },
      o.held ? `${o.name} (${t('heldMark')})` : o.name);
    bar.append(b);
  }
  bar.scrollLeft = 0;
}

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const v = els.input.value;
  if (busy) return;
  if (!v.trim() && !els.more.hidden) { pageDown(); return; }
  if (v.trim()) {
    commandHistory.push(v);
    commandHistory = commandHistory.slice(-100);
    store.set(K('cmdhistory'), commandHistory);
  }
  historyPos = -1;
  els.input.value = '';
  handleInput(v);
});

// Z-machine key codes of the cursor keys, for games that read single keys
// (Beyond Zork's menus): sent at once when the input line is empty.
const ARROW_KEYS = { ArrowUp: 129, ArrowDown: 130, ArrowLeft: 131, ArrowRight: 132 };

els.input.addEventListener('keydown', (e) => {
  if (session?.waitingForKey && !els.input.value && ARROW_KEYS[e.key] && !busy) {
    e.preventDefault();
    handleInput(String.fromCharCode(ARROW_KEYS[e.key]));
    return;
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    if (!commandHistory.length) return;
    e.preventDefault();
    if (historyPos === -1) historyPos = commandHistory.length;
    historyPos = Math.max(0, Math.min(commandHistory.length, historyPos + (e.key === 'ArrowUp' ? -1 : 1)));
    els.input.value = commandHistory[historyPos] ?? '';
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && document.activeElement === els.input && !els.input.value) {
    e.preventDefault();
    undo();
  }
});

els.undo.addEventListener('click', undo);
els.hintBtn.addEventListener('click', () => giveHint(false));
els.save.addEventListener('click', () => { if (!busy) { els.input.value = ''; handleInput('>save'); } });
els.load.addEventListener('click', () => { if (!busy) { els.input.value = ''; handleInput('>restore'); } });
els.settingsBtn.addEventListener('click', openSettings);
els.badge.addEventListener('click', () => {
  if (!settings.apiKey) return openSettings();
  settings.aiEnabled = !settings.aiEnabled;
  saveSettings();
  updateMode();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/** A time game's clock, as the original interpreters showed it ("8:05 am"). */
function clockTime(h, m) {
  h = Number(h) || 0;
  return `${h % 12 || 12}:${String(Number(m) || 0).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

async function boot() {
  applyStatic();
  if (!GAME_ID) {
    renderMenu({ openSettings });
    return;
  }
  const meta = GAMES[GAME_ID];
  try {
    await loadGame(meta);
  } catch (err) {
    // Offline, with a game that has never been opened here (so it is not cached).
    $('game-title').textContent = meta.title.toUpperCase();
    addEntry({ system: navigator.onLine === false ? t('offlineNotCached', { title: meta.title }) : t('gameLoadFailed', { error: err.message }) });
    return;
  }
  document.title = `${meta.title} AI`;
  $('game-title').textContent = meta.title.toUpperCase();
  if (meta.cover) coverTitle(meta);
  $('emblem').innerHTML = emblem(meta.id);
  // The game's box contents (manual, maps, feelies) in the Infocom Gallery.
  if (meta.gallery) { $('btn-gallery').href = meta.gallery; $('btn-gallery').hidden = false; }
  document.body.dataset.game = meta.id;
  const second = $('status-second-label');
  second.dataset.i18n = meta.statusSecond === 'time' ? 'time' : 'moves';
  second.textContent = t(second.dataset.i18n);
  // Games that draw their own status line (upper window): none of it is shown here.
  if (meta.ownStatus) { els.score.closest('.stat').hidden = true; els.time.closest('.stat').hidden = true; els.room.style.visibility = 'hidden'; }
  // Time games have no score: only the clock is shown.
  if (meta.clock) els.score.closest('.stat').hidden = true;
  updateMode();
  const saved = store.get(K('autosave'), null);
  // A new game opens with its title sequence (?intro=0 skips it).
  const intro = !saved?.snapshot && new URLSearchParams(location.search).get('intro') !== '0'
    ? playIntro(meta, { t, lang: settings.language }) : null;
  const opening = await session.start();
  if (saved?.snapshot) {
    try {
      transcriptLog = saved.transcript || [];
      aiHistory = saved.aiHistory || [];
      for (const entry of transcriptLog) renderEntry(entry, false);
      debugLog.checkpoint(debugLog.add('resume').n, saved.snapshot);
      await session.load(saved.snapshot);
      addEntry({ system: t('welcomeBack') });
    } catch {
      store.remove(K('autosave'));
      transcriptLog = [];
      els.transcript.replaceChildren();
      addEntry({ steps: [{ segments: opening.segments }] });
    }
  } else {
    const entry = { steps: [{ segments: opening.segments }] };
    translateEntry(entry, addEntry(entry));
    aiHistory.push({ input: '', commands: [], output: opening.text });
    debugLog.checkpoint(debugLog.add('start', { output: opening.text.slice(0, 6000) }).n, session.currentSnapshot());
  }
  initMap();
  if (settings.apiKey && !settings.model) {
    settings.model = await pickDefaultModel();
    saveSettings();
    updateMode();
  }
  setInputEnabled(true);
  if (intro) {
    intro.then(() => {
      sfx.begin();
      els.input.focus({ preventScroll: true });
      // Replay the header title's reveal, which ran hidden behind the title sequence.
      const fill = document.querySelector('.title-fill');
      if (fill) { fill.style.animation = 'none'; void fill.offsetWidth; fill.style.animation = ''; }
    });
  }
  else els.input.focus({ preventScroll: true });
  updatePageSpace();
  renderActions();
  if (paging) {
    const turns = els.transcript.querySelectorAll('section.turn');
    const lastTurn = [...turns].reverse().find((n) => n.entry?.input != null);
    if (lastTurn) pinTurn(lastTurn); else window.scrollTo({ top: 0 });
  } else {
    window.scrollTo({ top: document.body.scrollHeight });
  }
}

boot();
