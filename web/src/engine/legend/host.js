// Runs a Legend Entertainment game in the app: the same host contract as the
// other engines (engine/game.js), plus the view of the game's world (room,
// things in view, dictionary) that the status line, the map, the quick
// actions and the AI use.
//
// The game's files come in one pack (see tools/legend/build.mjs):
// "LGPK", u16 count, then per file u8 name length, name, u32 size; then the
// files' bytes in that order.

import { current } from '../current.js';
import { LegendMachine } from './machine.js';
import { KEYS } from './dos.js';
import { LegendWorld, vocabulary as readVocabulary } from './world.js';
import { LegendPictures } from './pictures.js';
import { compress, decompress, bytesToBase64, base64ToBytes } from './pack.js';

let machine = null;
let world = null;
let files = null;
let filesFor = null;
let score = 0;

export const legendMachine = () => machine;

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export function unpack(bytes) {
  const u16 = (o) => bytes[o] | (bytes[o + 1] << 8);
  const u32 = (o) => (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'LGPK') throw new Error('Not a Legend game pack');
  const count = u16(4);
  let p = 6;
  const list = [];
  for (let i = 0; i < count; i++) {
    const len = bytes[p++];
    const name = String.fromCharCode(...bytes.subarray(p, p + len));
    p += len;
    list.push([name, u32(p)]);
    p += 4;
  }
  const out = {};
  for (const [name, size] of list) { out[name] = bytes.subarray(p, p + size); p += size; }
  return out;
}

/** The current game's files (fetched once). */
export async function loadFiles() {
  const url = current.story.PACK;
  if (files && filesFor === url) return files;
  let bytes;
  if (typeof fetch === 'function' && typeof window !== 'undefined') {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Could not load the game files (${r.status}).`);
    bytes = new Uint8Array(await r.arrayBuffer());
  } else {
    // Node (tests and tools): read the pack from disk.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    bytes = new Uint8Array(fs.readFileSync(path.join(web, url)));
  }
  files = unpack(bytes);
  filesFor = url;
  return files;
}

// Screens of the game's own (the PV commset) as shown, by picture id ("screen:n").
const screens = new Map();
let screenCount = 0;

function showScreen() {
  const id = `screen:${++screenCount}`;
  screens.set(id, machine.screen());
  // (Only the recent ones are kept: the transcript shows them as they come.)
  for (const k of screens.keys()) { if (screens.size <= 40) break; screens.delete(k); }
  return id;
}

/** The pictures of the current game (for the app): room pictures and screens. */
export async function pictureSource() {
  const f = await loadFiles();
  const pics = new LegendPictures(f, current.code.CONFIG.prefix);
  return { picture: (id) => (String(id).startsWith('screen:') ? screens.get(id) ?? null : pics.picture(id)) };
}

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------

let baselines = new Map(); // game id -> first-prompt memory (the same on every run)

function createMachine(f) {
  const id = current.id;
  machine = new LegendMachine(f, current.code.CONFIG);
  if (baselines.has(id)) ({ mem: machine.baseline, vga: machine.vgaBaseline } = baselines.get(id));
  const opening = machine.boot();
  baselines.set(id, { mem: machine.baseline, vga: machine.vgaBaseline });
  world = new LegendWorld(machine, f['OBJECT.DAT']);
  world.find();
  vocab = null;
  score = 0;
  return opening;
}

/** The whole state, small enough to store: memory as a compressed difference from the first prompt. */
export function snapshot() {
  if (!machine) return null;
  const s = machine.snapshot();
  let size = 0;
  for (const [, b] of s.diff) size += 8 + b.length;
  const raw = new Uint8Array(size);
  let p = 0;
  for (const [off, b] of s.diff) {
    raw[p] = off & 0xff; raw[p + 1] = (off >> 8) & 0xff; raw[p + 2] = (off >> 16) & 0xff; raw[p + 3] = 0;
    raw[p + 4] = b.length & 0xff; raw[p + 5] = (b.length >> 8) & 0xff; raw[p + 6] = (b.length >> 16) & 0xff; raw[p + 7] = 0;
    raw.set(b, p + 8);
    p += 8 + b.length;
  }
  const { written, grid, ...dos } = s.dos;
  return {
    engine: 'legend', v: 1,
    mem: bytesToBase64(compress(raw)),
    grid: bytesToBase64(compress(grid)),
    vga: { regs: s.vga.regs, planes: bytesToBase64(compress(s.vga.planes)) },
    cpu: s.cpu, dos, drawn: s.drawn, scripting: s.scripting, score,
  };
}

export function loadSnapshot(s) {
  const raw = decompress(base64ToBytes(s.mem));
  const diff = [];
  for (let p = 0; p < raw.length;) {
    const off = raw[p] | (raw[p + 1] << 8) | (raw[p + 2] << 16);
    const len = raw[p + 4] | (raw[p + 5] << 8) | (raw[p + 6] << 16);
    diff.push([off, raw.subarray(p + 8, p + 8 + len)]);
    p += 8 + len;
  }
  const vga = s.vga && { regs: s.vga.regs, planes: decompress(base64ToBytes(s.vga.planes)) };
  machine.restore({ diff, cpu: s.cpu, dos: { ...s.dos, grid: decompress(base64ToBytes(s.grid)), written: [] }, vga, drawn: s.drawn, scripting: s.scripting });
  score = s.score ?? 0;
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

const SAVE = /^\s*save(\s+game)?\s*$/i;
const RESTORE = /^\s*(restore|load)(\s+game)?\s*$/i;
const SCRIPT = /^\s*(un)?script\b/i;
const YES_NO = /^\s*(y|yes|n|no)\s*[.!]?\s*$/i;

function countScore(text) {
  for (const m of text.matchAll(/score has just gone (up|down) by (\d+)/gi)) score += (m[1].toLowerCase() === 'up' ? 1 : -1) * Number(m[2]);
  const m = /your score is (-?\d+)/i.exec(text);
  if (m) score = Number(m[1]);
}

const SCREEN_HINT = '[The game shows a screen of its own. Type the keys to press (a number or letter, or a key name: Enter, Space, Esc, Up, Down, Left, Right, PgUp, PgDn); an empty line is Enter.]\n';

const KEY_NAMES = {
  enter: KEYS.ENTER, return: KEYS.ENTER, space: KEYS.SPACE, esc: KEYS.ESC, escape: KEYS.ESC,
  backspace: KEYS.BACKSPACE, tab: 0x0f09,
  up: 0x4800, down: 0x5000, left: 0x4b00, right: 0x4d00,
  pgup: 0x4900, pageup: 0x4900, pgdn: 0x5100, pagedown: 0x5100, home: 0x4700, end: 0x4f00,
  f1: KEYS.F1, f2: KEYS.F2, f3: KEYS.F3, f4: KEYS.F4, f5: KEYS.F5,
};
// The app's codes for the cursor keys (as the Z-machine numbers them).
const ARROWS = { 129: 0x4800, 130: 0x5000, 131: 0x4b00, 132: 0x4d00 };

/** The keys for what the player typed on a screen of the game's own. */
export function screenKeys(line) {
  const t = line.trim();
  if (!t) return [KEYS.ENTER];
  if (t.length === 1 && ARROWS[t.charCodeAt(0)]) return [ARROWS[t.charCodeAt(0)]];
  const words = t.toLowerCase().split(/[\s,]+/);
  if (words.every((w) => KEY_NAMES[w] !== undefined)) return words.map((w) => KEY_NAMES[w]);
  return [t];
}

/** The game loop: run until the game wants input, then ask the host. */
export async function runLegend(io) {
  const f = await loadFiles();
  let opening = createMachine(f);
  let pending = opening;
  let state = { state: 'prompt' };
  let inScreen = false;
  for (;;) {
    if (pending) { countScore(pending); io.output(pending); pending = ''; }
    if (state.state === 'exit') {
      if (!io.ended) return;
      await io.ended();
      opening = createMachine(f);
      io.restarted?.();
      pending = opening;
      state = { state: 'prompt' };
      continue;
    }
    if (state.state === 'question' && state.question) io.output(state.question + '\n');
    io.status?.(status());
    if (state.state === 'screen') {
      // A screen of the game's own: shown as it is, and it gets keys.
      if (!inScreen) io.output(SCREEN_HINT);
      inScreen = true;
      io.picture?.(showScreen(), { alone: true });
    } else {
      inScreen = false;
      io.picture?.(machine.picture());
    }
    const line = await (state.state === 'screen' && io.inputChar ? io.inputChar() : io.input());
    if (line && typeof line === 'object') {
      loadSnapshot(line.snapshot);
      if (line.notice) io.output(line.notice);
      state = { state: 'prompt' };
      continue;
    }
    const cmd = String(line);
    if (state.state === 'screen') {
      for (const k of screenKeys(cmd)) machine.dos.key(k);
      state = machine.continue();
      pending = state.text;
      continue;
    }
    if (state.state === 'question') {
      // RESTART: the app starts the game again itself (the game's own restart
      // would turn off the transcript).
      if (/restart\?/i.test(state.question ?? '') && /^\s*y/i.test(cmd)) {
        opening = createMachine(f);
        io.restarted?.();
        pending = opening;
        state = { state: 'prompt' };
        continue;
      }
      // Yes/no questions take one key.
      machine.dos.key(YES_NO.test(cmd) ? cmd.trim()[0].toLowerCase() : cmd + '\r');
      state = machine.continue();
      pending = state.text;
      continue;
    }
    if (SAVE.test(cmd)) {
      let ok = false;
      try { ok = !!(await io.save(snapshot())); } catch { ok = false; }
      io.output(ok ? 'Saved.\n' : 'Not saved.\n');
      continue;
    }
    if (RESTORE.test(cmd)) {
      let s = null;
      try { s = await io.restore(); } catch { s = null; }
      if (!s || s.engine !== 'legend') { io.output('Not restored.\n'); continue; }
      loadSnapshot(s);
      io.output('Restored.\n');
      continue;
    }
    if (SCRIPT.test(cmd)) { io.output('[A transcript is always kept here.]\n'); continue; }
    state = machine.command(cmd);
    pending = state.text;
  }
}

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

export function currentRoomId() { return world?.room() ?? 0; }

export function roomName(id) {
  if (!world || !id) return '';
  return world.name(id);
}

/** Exits are decided by the game's code, which the app can't read. */
export function exits() { return []; }

export function isLit() { return true; }

/** Score and the clock: the game's status line shows the date and time. */
export function status() {
  const st = machine?.status() ?? { room: '', clock: '' };
  // "May 17, 12:03": the clock goes into the moves field as hours and minutes.
  const t = /(\d+):(\d\d)$/.exec(st.clock);
  return {
    room: st.room || roomName(currentRoomId()),
    score,
    moves: t ? Number(t[1]) * 100 + Number(t[2]) : 0,
    clock: st.clock,
  };
}

/** Things in view or carried, in the shape the scene code expects. */
export function sceneNouns() {
  if (!world) return [];
  const words = nounWords();
  return world.scene().map((x) => {
    const parts = x.name.toLowerCase().split(/\s+/);
    // The noun: the last word of the name the parser knows ("debit card" -> "card").
    const word = [...parts].reverse().find((w) => words.has(w)) ?? parts[parts.length - 1];
    const adjectives = parts.filter((w) => w !== word);
    const opens = (x.flags & 0x2000) !== 0, open = (x.flags & 0x0800) !== 0;
    return {
      n: x.id, name: x.name, word, adjectives, how: x.how, inside: x.inside,
      open: opens && open, closed: opens && !open, container: opens, moveable: true,
    };
  });
}

let vocab = null;
function words() {
  if (!vocab) vocab = readVocabulary(files['VOCAB.DAT']);
  return vocab;
}
function nounWords() { return new Set(words().filter((w) => w.flags & 2).map((w) => w.word)); }

/** The dictionary by kind of word. */
export function vocabulary() {
  const clean = (list) => [...new Set(list.map((w) => w.word.toLowerCase()))].filter((w) => /^[a-z][a-z' -]*$/.test(w));
  const all = words();
  const of = (test) => clean(all.filter((w) => test(w.flags)));
  const directions = ['north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest', 'up', 'down', 'in', 'out'];
  return {
    verbs: of((f) => f & 1),
    adjectives: of((f) => (f & 4) && !(f & 1)),
    nouns: of((f) => (f & 2) && !(f & 1)),
    directions,
    meta: ['look', 'inventory', 'wait', 'again', 'undo', 'score', 'status', 'save', 'restore', 'restart', 'quit', 'verbose', 'brief', 'notify', 'credits', 'version'],
    prepositions: of((f) => f & 8),
    synonyms: [],
  };
}

/** The puzzles and answers of the game's hint book (for the AI hints). */
export function hintBook() {
  const bytes = files?.['HINTBOOK.TXT'];
  if (!bytes) return '(not available)';
  const text = String.fromCharCode(...bytes).replace(/\r\n/g, '\n');
  const start = text.search(/^SECTION 3A/m), end = text.search(/^SECTION 4/m);
  return (start >= 0 ? text.slice(start, end > start ? end : undefined) : text).trim();
}

/** Game variables for the hints: what can be read without the game's source. */
export function variables() {
  const st = status();
  return { ROOM: st.room, CLOCK: st.clock, SCORE: score };
}
