// Planetfall AI — browser front end.
// Wires the translated game (engine/) to the page and to the AI interpreter (ai/).

import { GameSession } from './engine/session.js';
import { interpret, isParserError } from './ai/interpreter.js';
import { currentScene } from './ai/scene.js';
import { pickDefaultModel, listModels } from './ai/openrouter.js';
import { translate, translateLabel } from './ai/translator.js';
import { t, setLanguage, applyStatic, normalizeLanguage, AI_LANGUAGE_NAME } from './i18n.js';

const $ = (id) => document.getElementById(id);
const els = {
  transcript: $('transcript'), form: $('command-form'), input: $('command'), send: $('send'),
  hint: $('hint'), badge: $('mode-badge'), room: $('status-room'), score: $('status-score'), time: $('status-time'),
  undo: $('btn-undo'), save: $('btn-save'), load: $('btn-load'), settingsBtn: $('btn-settings'),
  settings: $('settings-dialog'), setKey: $('set-key'), setModel: $('set-model'), setAi: $('set-ai'),
  setShow: $('set-show'), modelList: $('model-list'), setLang: $('set-lang'),
  slots: $('slots-dialog'), slotsTitle: $('slots-title'), slotsList: $('slots-list'), slotName: $('slot-name'),
  slotNameField: $('slot-name-field'), slotsOk: $('slots-ok'),
};

// ---------------------------------------------------------------------------
// Persistence (all local to this browser)
// ---------------------------------------------------------------------------

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

const settings = Object.assign(
  { apiKey: '', model: '', aiEnabled: true, showCommands: true, language: 'en' },
  store.get('pf.settings', {}),
);
settings.language = normalizeLanguage(settings.language);
setLanguage(settings.language);
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

function scrollDown() {
  requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
}

function renderGameText(segments, container) {
  for (const seg of segments) {
    if (seg.fixed) {
      container.append(el('pre', 'game-text fixed', seg.text));
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

function renderEntry(entry, animate = true) {
  const turn = el('section', 'turn');
  if (!animate) turn.style.animation = 'none';
  if (entry.input != null) turn.append(el('p', 'player', entry.input));
  for (const step of entry.steps || []) {
    if (step.note) turn.append(el('div', `ai-note${step.error ? ' error' : ''}`, step.note));
    if (step.command && settings.showCommands && entry.viaAI) {
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
  scrollDown();
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
let commandHistory = store.get('pf.cmdhistory', []);
let historyPos = -1;
let gameEnded = false;

const session = new GameSession({
  onStatus: ({ room, score, moves }) => {
    currentRoom = room;
    els.room.textContent = room || '—';
    if (targetLanguage()) updateStatusRoom();
    els.score.textContent = score;
    els.time.textContent = moves;
  },
  onSave: (snap) => openSlots('save', snap),
  onRestore: () => openSlots('load'),
});

let restartResponse = null; // set when the game restarted during the current input

async function sendToGame(command) {
  const res = await session.send(command);
  gameEnded = !!res.ended;
  if (res.restarted) restartResponse = res;
  return res;
}

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
}

function autosave() {
  const snap = session.currentSnapshot();
  if (!snap) return;
  store.set('pf.autosave', { snapshot: snap, transcript: transcriptLog.slice(-120), aiHistory: aiHistory.slice(-12) });
}

async function handleInput(raw) {
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
    undoStack.push(session.currentSnapshot());
    if (undoStack.length > 100) undoStack.shift();
    const direct = !aiActive() || text.startsWith('>') || text === '';
    if (direct) {
      const cmd = text.replace(/^>\s*/, '');
      const res = await sendToGame(cmd);
      const entry = { input: text, steps: [{ segments: res.segments }] };
      await translateEntry(entry, addEntry(entry));
      aiHistory.push({ input: cmd, commands: [cmd], output: res.text });
    } else {
      await aiTurn(text);
    }
    if (restartResponse) { startFresh(restartResponse); restartResponse = null; }
    else if (gameEnded) addEntry({ system: t('gameEnded') });
    autosave();
  } finally {
    busy = false;
    setInputEnabled(true);
    els.input.focus();
  }
}

async function aiTurn(text) {
  const entry = { input: text, viaAI: true, steps: [] };
  let node = renderEntry(entry);
  transcriptLog.push(entry);
  const stopThinking = showThinking(node);
  let result;
  try {
    result = await interpret({
      apiKey: settings.apiKey, model: settings.model, input: text, language: targetLanguage(),
      scene: currentScene(), history: aiHistory.slice(-10),
    });
  } catch (err) {
    stopThinking();
    // Fall back to the original parser so the game stays playable.
    const res = await sendToGame(text);
    entry.steps.push({ note: t('aiFailed', { error: err.message }), error: true },
      { segments: res.segments });
    aiHistory.push({ input: text, commands: [text], output: res.text });
    node = rerender(node, entry);
    await translateEntry(entry, node);
    return;
  }
  stopThinking();
  if (result.reply) entry.steps.push({ note: result.reply });
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
          history: aiHistory.slice(-10), repair: { command, error: res.text },
        });
        stop();
        if (fix.commands.length) {
          entry.steps.push({ command, segments: [], parserError: true });
          command = fix.commands[0];
          res = await sendToGame(command);
          parserError = isParserError(res.text);
          result.commands.splice(i, 1, ...fix.commands);
        } else if (fix.reply) {
          entry.steps.push({ note: fix.reply });
        }
      } catch { /* keep the original response */ }
    }
    entry.steps.push({ command, segments: res.segments, parserError });
    outputs.push(res.text);
    node = rerender(node, entry);
    if (res.restarted || res.ended || /RESTART, RESTORE, or QUIT|\(Y is affirmative\)|Please answer YES or NO/.test(res.text)) break;
    if (parserError) break;
  }
  if (!result.commands.length && !result.reply) entry.steps.push({ note: t('cantMap') });
  aiHistory.push({ input: text, commands: result.commands, output: outputs.join('\n') });
  node = rerender(node, entry);
  await translateEntry(entry, node);
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

/** Translate all untranslated game text in an entry, updating its node as it goes. */
async function translateEntry(entry, node) {
  const language = targetLanguage();
  if (!language) return node;
  // Each entry is translated once per language. Segments still in progress or
  // already failed are skipped, so this is safe to call repeatedly.
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
      sg.translateError = err.message;
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
    await session.load(snap);
    gameEnded = false;
    aiHistory.pop();
    addEntry({ system: t('undone') });
    autosave();
  } finally {
    busy = false;
    setInputEnabled(true);
    els.input.focus();
  }
}

// ---------------------------------------------------------------------------
// Save / restore slots
// ---------------------------------------------------------------------------

let slotsResolve = null;
let slotsMode = 'save';
let slotsSelected = null;
let slotsSnapshot = null;

function listSaves() { return store.get('pf.saves', {}); }

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
      const s = listSaves(); delete s[name]; store.set('pf.saves', s); drawSlots();
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
    resolve(store.set('pf.saves', saves));
  } else {
    const saves = listSaves();
    resolve(ok && slotsSelected && saves[slotsSelected] ? saves[slotsSelected].snapshot : null);
  }
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function openSettings() {
  els.setKey.value = settings.apiKey;
  els.setModel.value = settings.model;
  els.setAi.checked = settings.aiEnabled;
  els.setShow.checked = settings.showCommands;
  els.setLang.value = settings.language;
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
  const prevTarget = targetLanguage();
  settings.apiKey = els.setKey.value.trim();
  settings.model = els.setModel.value.trim();
  settings.aiEnabled = els.setAi.checked;
  settings.showCommands = els.setShow.checked;
  const prevLang = settings.language;
  settings.language = normalizeLanguage(els.setLang.value);
  if (settings.apiKey && !settings.model) settings.model = await pickDefaultModel();
  saveSettings();
  setLanguage(settings.language);
  applyStatic();
  updateMode();
  updateStatusRoom();
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
    }
    rerender(node, entry);
  }
}

function updateMode() {
  const ai = aiActive();
  els.badge.textContent = ai ? t('badgeAi') : t('badgeClassic');
  els.badge.classList.toggle('ai', ai);
  els.badge.title = ai ? t('badgeTitleAi', { model: settings.model })
    : settings.apiKey ? t('badgeTitleClassicKey') : t('badgeTitleClassicNoKey');
  els.input.placeholder = ai ? t('placeholderAi') : t('placeholderClassic');
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

function setInputEnabled(on) {
  els.input.disabled = !on;
  els.send.disabled = !on;
  els.undo.disabled = !on || !undoStack.length;
}

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const v = els.input.value;
  if (busy) return;
  if (v.trim()) {
    commandHistory.push(v);
    commandHistory = commandHistory.slice(-100);
    store.set('pf.cmdhistory', commandHistory);
  }
  historyPos = -1;
  els.input.value = '';
  handleInput(v);
});

els.input.addEventListener('keydown', (e) => {
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

async function boot() {
  applyStatic();
  updateMode();
  const opening = await session.start();
  const saved = store.get('pf.autosave', null);
  if (saved?.snapshot) {
    try {
      transcriptLog = saved.transcript || [];
      aiHistory = saved.aiHistory || [];
      for (const entry of transcriptLog) renderEntry(entry, false);
      await session.load(saved.snapshot);
      addEntry({ system: t('welcomeBack') });
    } catch {
      store.remove('pf.autosave');
      transcriptLog = [];
      els.transcript.replaceChildren();
      addEntry({ steps: [{ segments: opening.segments }] });
    }
  } else {
    const entry = { steps: [{ segments: opening.segments }] };
    translateEntry(entry, addEntry(entry));
    aiHistory.push({ input: '', commands: [], output: opening.text });
  }
  if (settings.apiKey && !settings.model) {
    settings.model = await pickDefaultModel();
    saveSettings();
    updateMode();
  }
  setInputEnabled(true);
  els.input.focus();
  window.scrollTo({ top: document.body.scrollHeight });
}

boot();
