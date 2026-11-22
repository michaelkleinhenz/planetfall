// Planetfall AI — browser front end.
// Wires the translated game (engine/) to the page and to the AI interpreter (ai/).

import { GameSession } from './engine/session.js';
import { interpret, isParserError } from './ai/interpreter.js';
import { currentScene } from './ai/scene.js';
import { pickDefaultModel, listModels } from './ai/openrouter.js';
import { translate, translateLabel } from './ai/translator.js';

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
  { apiKey: '', model: '', aiEnabled: true, showCommands: true, language: '' },
  store.get('pf.settings', {}),
);
const saveSettings = () => store.set('pf.settings', settings);
const aiActive = () => settings.aiEnabled && !!settings.apiKey;
// Translation is active when a non-English language is chosen and the AI is on.
const targetLanguage = () => {
  const l = (settings.language || '').trim();
  return aiActive() && l && !/^english$/i.test(l) ? l : '';
};

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
      p.title = seg.showOriginal ? 'Original text — click to show the translation' : 'Click to show the original English text';
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

async function sendToGame(command) {
  const res = await session.send(command);
  gameEnded = !!res.ended;
  return res;
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
      const res = await session.send(text);
      gameEnded = false;
      undoStack = [];
      const entry = { input: text, steps: [{ segments: res.segments }] };
      await translateEntry(entry, addEntry(entry));
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
    if (gameEnded) addEntry({ system: 'The game has ended. Type anything to start a new game.' });
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
    entry.steps.push({ note: `${err.message} — sent your input to the original parser instead.`, error: true },
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
    if (res.ended || /RESTART, RESTORE, or QUIT|\(Y is affirmative\)|Please answer YES or NO/.test(res.text)) break;
    if (parserError) break;
  }
  if (!result.commands.length && !result.reply) entry.steps.push({ note: "I couldn't turn that into a game command." });
  aiHistory.push({ input: text, commands: result.commands, output: outputs.join('\n') });
  node = rerender(node, entry);
  await translateEntry(entry, node);
}

function rerender(node, entry) {
  const fresh = renderEntry(entry, false);
  node.replaceWith(fresh);
  scrollDown();
  return fresh;
}

/** Translate all untranslated game text in an entry, updating its node as it goes. */
async function translateEntry(entry, node) {
  const language = targetLanguage();
  if (!language) return node;
  const segs = (entry.steps || []).flatMap((st) => st.segments || []).filter((sg) => !sg.fixed && !sg.translated);
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
  if (failed) entry.steps.push({ note: `Translation failed (${failed.translateError}); showing the original text.`, error: true });
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
    addEntry({ system: 'Undone — back to the previous turn.' });
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
  els.slotsTitle.textContent = mode === 'save' ? 'Save game' : 'Restore a saved game';
  els.slotNameField.style.display = mode === 'save' ? '' : 'none';
  els.slotsOk.textContent = mode === 'save' ? 'Save' : 'Restore';
  els.slotName.value = mode === 'save' ? `${currentRoom || 'Game'} — ${new Date().toLocaleString()}` : '';
  drawSlots();
  els.slots.showModal();
  if (mode === 'save') els.slotName.select();
  return new Promise((resolve) => { slotsResolve = resolve; });
}

function drawSlots() {
  const saves = listSaves();
  els.slotsList.replaceChildren();
  const names = Object.keys(saves).sort((a, b) => saves[b].date - saves[a].date);
  if (!names.length) els.slotsList.append(el('p', 'empty', 'No saved games yet.'));
  for (const name of names) {
    const b = el('button', `slot${slotsSelected === name ? ' selected' : ''}`);
    b.type = 'button';
    b.append(el('span', 'slot-name', name), el('span', 'slot-meta', new Date(saves[name].date).toLocaleDateString()));
    const del = el('span', 'slot-del', '×');
    del.title = 'Delete';
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
  els.setLang.value = settings.language || '';
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
  settings.apiKey = els.setKey.value.trim();
  settings.model = els.setModel.value.trim();
  settings.aiEnabled = els.setAi.checked;
  settings.showCommands = els.setShow.checked;
  const prevLang = settings.language;
  settings.language = els.setLang.value.trim();
  if (settings.apiKey && !settings.model) settings.model = await pickDefaultModel();
  saveSettings();
  updateMode();
  const wanted = (settings.language || '').trim();
  if (settings.language !== prevLang || (wanted && !/^english$/i.test(wanted))) {
    updateStatusRoom();
    if (targetLanguage()) {
      if (settings.language !== prevLang) {
        addEntry({ system: `Now playing in ${wanted}. Translating… (click a passage to see the original English)` });
        translateVisible();
      }
    } else if (wanted && !/^english$/i.test(wanted)) {
      addEntry({ system: !settings.apiKey
        ? `Playing in ${wanted} needs the AI: add your OpenRouter API key in the settings (⚙).`
        : `Playing in ${wanted} needs the AI interpreter: turn on "Use the AI interpreter" in the settings (⚙).` });
    } else if (prevLang && settings.language !== prevLang) {
      addEntry({ system: 'Back to the original English text.' });
      translateVisible();
    }
  }
});

/** After switching language: translate the most recent turns already on screen. */
async function translateVisible() {
  const turns = [...els.transcript.querySelectorAll('section.turn')];
  const recent = transcriptLog.slice(-6);
  const nodes = turns.slice(-recent.length);
  for (const sg of recent.flatMap((e) => (e.steps || []).flatMap((st) => st.segments || []))) delete sg.translated;
  if (!targetLanguage()) { recent.forEach((e, i) => nodes[i] && rerender(nodes[i], e)); return; }
  await Promise.all(recent.map((e, i) => (nodes[i] ? translateEntry(e, nodes[i]) : null)));
}

function updateMode() {
  const ai = aiActive();
  els.badge.textContent = ai ? 'AI' : 'CLASSIC';
  els.badge.classList.toggle('ai', ai);
  els.badge.title = ai ? `AI interpreter (${settings.model}) — click to switch to the classic parser`
    : settings.apiKey ? 'Classic parser — click to switch on the AI interpreter' : 'Classic parser — add an OpenRouter key to use the AI';
  els.input.placeholder = ai ? 'Say anything… e.g. "grab the brush and head up the stairs"' : 'Type a command, e.g. "examine brush"';
  els.hint.replaceChildren();
  if (ai) {
    const lang = targetLanguage();
    els.hint.append(lang
      ? `AI interpreter on · playing in ${lang} — type in any language; click a passage to see the original.`
      : 'AI interpreter on — start a line with ">" to talk to the original parser directly.');
  } else {
    els.hint.append('Classic parser. ');
    const a = el('a', null, settings.apiKey ? 'Turn on the AI interpreter' : 'Add an OpenRouter key');
    a.href = '#'; a.addEventListener('click', (e) => { e.preventDefault(); openSettings(); });
    els.hint.append(a, ' to type in plain language.');
    const lang = (settings.language || '').trim();
    if (lang && !/^english$/i.test(lang)) els.hint.append(` (Needed for playing in ${lang}.)`);
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
  updateMode();
  const opening = await session.start();
  const saved = store.get('pf.autosave', null);
  if (saved?.snapshot) {
    try {
      transcriptLog = saved.transcript || [];
      aiHistory = saved.aiHistory || [];
      for (const entry of transcriptLog) renderEntry(entry, false);
      await session.load(saved.snapshot);
      addEntry({ system: 'Welcome back — your game was restored. (Type "restart" to begin again.)' });
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
