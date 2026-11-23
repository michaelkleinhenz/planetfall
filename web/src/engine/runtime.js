// Runtime support for the JavaScript translation of Planetfall.
//
// The original game was written in ZIL for the Z-machine.  Its code freely
// manipulates object property tables, dictionary words and parser buffers as
// raw bytes, so this runtime keeps a small byte-addressed memory with the same
// layout conventions (objects, property tables, vocabulary, tables) and offers
// the primitive operations the translated code calls (hasFlag, move, getProp,
// tell, read, ...).  Game state = memory bytes + global variables + RNG state.

import { decodeText, dictKey, dictBytes } from './zscii.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Global variables of the game (HERE, PRSO, SCORE, ...). */
export const g = {};

let mem = new Uint8Array(0);
let story = null;          // { MEMORY_BASE64, STRINGS, GLOBAL_NAMES, INITIAL_GLOBALS, LAYOUT }
let routines = [null];
let io = null;
let dictionary = new Map(); // dictKey -> address
let rngState = 1;
let fixedFont = false;

export class RestartSignal extends Error {}
export class QuitSignal extends Error {}
export class RestoreSignal extends Error {
  constructor(notice = 'Ok.\n') { super('restore'); this.notice = notice; }
}

function base64ToBytes(b64) {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

function bytesToBase64(bytes) {
  if (typeof btoa === 'function') {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  return Buffer.from(bytes).toString('base64');
}

/** Load (or reload) the initial game state. */
export function initRuntime(storyData, routineTable, ioHandlers) {
  story = storyData;
  routines = routineTable;
  io = ioHandlers;
  resetState();
}

export function resetState() {
  mem = base64ToBytes(story.MEMORY_BASE64);
  for (const k of Object.keys(g)) delete g[k];
  Object.assign(g, story.INITIAL_GLOBALS);
  V = story.LAYOUT.version ?? 3;
  dictionary = new Map();
  const { dictionary: start, dictionaryCount, entryLength } = story.LAYOUT;
  const keyLen = V <= 3 ? 4 : 6;
  for (let i = 0; i < dictionaryCount; i++) {
    const a = start + i * entryLength;
    const key = Array.from(mem.slice(a, a + keyLen), (b) => b.toString(16).padStart(2, '0')).join('');
    dictionary.set(key, a);
  }
  fixedFont = false;
  screenOut = true; tableOut.length = 0; currentWindow = 0;
  if (!rngSeeded) rngState = (Math.random() * 0x7fffffff) | 1;
  // Header Flags 1 as a v3 interpreter without a status window reports it
  // (like the reference interpreter): games then print what they would have
  // drawn in the upper window inline (Suspended, Seastalker, Deadline).
  if (V <= 3) mem[1] = (mem[1] & 0x8f) | 0x10 | 0x40;
  else {
    // Version 4+: bold, italic and fixed-width text are available; an 80-column
    // screen (games centre text with it); Z-machine standard 1.2.
    mem[1] = 0x1c;
    mem[0x11] &= 0x57;
    mem[0x20] = 25; mem[0x21] = 80;
    if (V >= 5) { mem[0x22] = 0; mem[0x23] = 80; mem[0x24] = 0; mem[0x25] = 25; mem[0x26] = 1; mem[0x27] = 1; }
    mem[0x32] = 1; mem[0x33] = 2;
  }
}

// ---------------------------------------------------------------------------
// Memory access
// ---------------------------------------------------------------------------

function rw(a) { const v = (mem[a] << 8) | mem[a + 1]; return v & 0x8000 ? v - 0x10000 : v; }
function ww(a, v) {
  v = Number(v) & 0xffff;
  mem[a] = v >> 8; mem[a + 1] = v & 255;
  if (a === 16 || a === 17) headerFlagsChanged();
}

// Addresses are unsigned 16-bit (a table above 32767 can come back from memory
// as a negative number).
const addr = (tbl, off) => (Number(tbl) + off) & 0xffff;
export function get(tbl, i) { return rw(addr(tbl, 2 * Number(i))); }
export function put(tbl, i, v) { ww(addr(tbl, 2 * Number(i)), v); return true; }
export function getb(tbl, i) { return mem[addr(tbl, Number(i))]; }
export function putb(tbl, i, v) { mem[addr(tbl, Number(i))] = Number(v) & 255; return true; }

function headerFlagsChanged() {
  const fixed = (mem[17] & 2) !== 0;
  if (fixed !== fixedFont) {
    fixedFont = fixed;
    io?.setFixedFont?.(fixed);
  }
}

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

// Version 3: 9-byte objects (32 attributes, byte links); version 4+: 14-byte
// objects (48 attributes, word links) and 63 properties with longer values.
let V = 3;
function objAddr(o) { return story.LAYOUT.objTable + (o - 1) * (V <= 3 ? 9 : 14); }
function link(o, k) { const a = objAddr(o); return V <= 3 ? mem[a + 4 + k] : (mem[a + 6 + 2 * k] << 8) | mem[a + 7 + 2 * k]; }
function setLink(o, k, v) {
  const a = objAddr(o);
  if (V <= 3) mem[a + 4 + k] = v;
  else { mem[a + 6 + 2 * k] = v >> 8; mem[a + 7 + 2 * k] = v & 255; }
}
const PARENT = 0, SIBLING = 1, CHILD = 2;

export function hasFlag(o, f) {
  if (!o) return false;
  return (mem[objAddr(o) + (f >> 3)] & (0x80 >> (f & 7))) !== 0;
}
export function setFlag(o, f) { if (o) mem[objAddr(o) + (f >> 3)] |= 0x80 >> (f & 7); return true; }
export function clearFlag(o, f) { if (o) mem[objAddr(o) + (f >> 3)] &= ~(0x80 >> (f & 7)); return true; }
export function loc(o) { return o ? link(o, PARENT) : 0; }
export function first(o) { return o ? link(o, CHILD) : 0; }
export function next(o) { return o ? link(o, SIBLING) : 0; }

export function remove(o) {
  if (!o) return true;
  const parent = link(o, PARENT);
  if (parent) {
    if (link(parent, CHILD) === o) {
      setLink(parent, CHILD, link(o, SIBLING));
    } else {
      let c = link(parent, CHILD);
      while (c) {
        if (link(c, SIBLING) === o) { setLink(c, SIBLING, link(o, SIBLING)); break; }
        c = link(c, SIBLING);
      }
    }
  }
  setLink(o, PARENT, 0); setLink(o, SIBLING, 0);
  return true;
}

export function move(o, dest) {
  remove(o);
  setLink(o, PARENT, dest);
  setLink(o, SIBLING, link(dest, CHILD));
  setLink(dest, CHILD, o);
  return true;
}

function propTable(o) { const a = objAddr(o) + (V <= 3 ? 7 : 12); return (mem[a] << 8) | mem[a + 1]; }

/** A property entry at a: its number, data length and header length. */
function propEntry(a) {
  const sb = mem[a];
  if (V <= 3) return { num: sb & 31, len: (sb >> 5) + 1, head: 1 };
  if (sb & 0x80) return { num: sb & 63, len: (mem[a + 1] & 63) || 64, head: 2 };
  return { num: sb & 63, len: sb & 0x40 ? 2 : 1, head: 1 };
}

export function getPropAddr(o, p) {
  if (!o) return 0;
  let a = propTable(o);
  a += 1 + 2 * mem[a];
  for (;;) {
    if (mem[a] === 0) return 0;
    const e = propEntry(a);
    if (e.num === p) return a + e.head;
    if (e.num < p) return 0;
    a += e.head + e.len;
  }
}

/** NEXTP: the property after p (p = 0: the first property), or 0 at the end. */
export function nextProp(o, p) {
  let a = propTable(o);
  a += 1 + 2 * mem[a];
  if (p) {
    for (;;) {
      if (mem[a] === 0) return 0;
      const e = propEntry(a);
      a += e.head + e.len;
      if (e.num === p) break;
    }
  }
  return mem[a] === 0 ? 0 : propEntry(a).num;
}

export function propSize(addr) {
  if (!addr) return 0;
  const b = mem[addr - 1];
  if (V <= 3) return (b >> 5) + 1;
  if (b & 0x80) return (b & 63) || 64;
  return b & 0x40 ? 2 : 1;
}

export function getProp(o, p) {
  const a = getPropAddr(o, p);
  if (!a) return rw(story.LAYOUT.propDefaults + 2 * (p - 1));
  return propSize(a) === 1 ? mem[a] : rw(a);
}

export function putProp(o, p, v) {
  const a = getPropAddr(o, p);
  if (!a) throw new Error(`putProp: object ${o} has no property ${p}`);
  if (propSize(a) === 1) mem[a] = Number(v) & 255; else ww(a, v);
  return true;
}

/** Short name of an object, decoded from its property table. */
export function objectName(o) {
  if (!o) return '';
  const a = propTable(o);
  if (mem[a] === 0) return '';
  return decodeText(mem, a + 1).text;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export function tell(...parts) {
  let text = parts.join('');
  if (!text) return true;
  if (tableOut.length) {
    const t = tableOut[tableOut.length - 1];
    for (const ch of text) putb(t.addr + 2, t.len++, ch === '\n' ? 13 : ch.charCodeAt(0));
    put(t.addr, 0, t.len);
    return true;
  }
  if (!screenOut) return true;
  if (currentFont === 3) text = font3(text);
  // Text for the upper window (v3 split screen, e.g. Seastalker's sonar)
  // goes to the front end's upper-window handler, if it has one.
  if (currentWindow === 1) { io.upper?.(text); return true; }
  io.output(text, { fixed: fixedFont });
  return true;
}

// v3 split screen: SPLIT sets the size of the upper window, SCREEN selects
// the window that output goes to.
let currentWindow = 0;
export function splitWindow(lines) { io.split?.(Number(lines)); if (!lines) currentWindow = 0; return true; }
export function setWindow(w) { currentWindow = Number(w); io.window?.(currentWindow); return true; }
// Screen control used by a few games' status lines (Suspended): the upper
// window is handled by the front end, so these only pass the request on.
const cursorPos = { line: 1, col: 1 };
export function cursorSet(line, col) {
  cursorPos.line = Number(line); cursorPos.col = Number(col);
  io.cursor?.(Number(line), Number(col));
  return true;
}
export function highlight(style) { io.highlight?.(Number(style)); return true; }
export function bufOut() { return true; }
export function clearScreen(w) { io.clear?.(Number(w)); return true; }
/** SOUND (Lurking Horror's beeps and effects): not played. */
export function sound() { return true; }
export function print(s) { return tell(s); }
export function crlf() { return tell('\n'); }

/** Object name (TELL D obj). */
export function D(o) { return objectName(o); }
/** Number (TELL N n). */
export function N(n) { return String(Number(n)); }
/** Character (TELL C c). */
export function C(c) { return Number(c) ? String.fromCharCode(Number(c)) : ''; }
/** A string value: either a literal or a string id from the story data. */
export function S(x) {
  if (typeof x === 'string') return x;
  const i = typeof x === 'number' ? x - (story.LAYOUT.stringBase ?? 0) : -1;
  if (i >= 0 && story.STRINGS[i] != null) return story.STRINGS[i];
  return `[missing string ${x}]`;
}
export function printD(o) { return tell(D(o)); }
export function printN(n) { return tell(N(n)); }
export function printC(c) { return tell(C(c)); }
export function printS(x) { return tell(S(x)); }
/** Print a dictionary word. */
export function printB(addr) { return tell(decodeText(mem, Number(addr), 2).text); }

// ---------------------------------------------------------------------------
// Misc primitives
// ---------------------------------------------------------------------------

export function eq(a, ...vals) { return vals.some((v) => a == v); }
export function btst(a, b) { return (a & b) === b; }
export function div(a, b) { return Math.trunc(a / b); }
export function mod(a, b) { return a % b; }
export function verify() { return true; }
// DIROUT n [table]: output streams. 1 = screen (-1 turns it off), 3 = a table
// (a word count, then the characters; these nest), 2 (transcript) and 4
// (command recording) are not supported. Suspended (v3) uses <DIROUT 1 table>
// for a table.
const tableOut = [];
let screenOut = true;
export function dirOut(n, table) {
  n = Number(n);
  if (n === 3 || (V <= 3 && table && n === 1)) {
    const t = { addr: Number(table) & 0xffff, len: 0 };
    put(t.addr, 0, 0);
    tableOut.push(t);
  } else if (n === -3 || (V <= 3 && tableOut.length && (n === 0 || n === -1))) {
    tableOut.pop();
  } else if (n === 1) screenOut = true;
  else if (n === -1) screenOut = false;
  return true;
}
export function dirIn() { return true; }

// ---------------------------------------------------------------------------
// Version 4 and 5 operations
// ---------------------------------------------------------------------------

/** INTBL? value table length [form]: address of the entry holding value, or 0. */
export function inTable(value, table, len, form = 0x82) {
  value = Number(value) & 0xffff; table = Number(table) & 0xffff; len = Number(len); form = Number(form);
  const words = (form & 0x80) !== 0;
  const size = form & 0x7f || (words ? 2 : 1);
  for (let i = 0, a = table; i < len; i++, a += size) {
    const v = words ? ((mem[a] << 8) | mem[a + 1]) : mem[a];
    if (v === value) return a;
  }
  return 0;
}

/** COPYT from to size: copy (or, with to = 0, clear) a table. */
export function copyTable(from, to, size) {
  from = Number(from) & 0xffff; to = Number(to) & 0xffff; size = Number(size);
  if (!to) { mem.fill(0, from, from + Math.abs(size)); return true; }
  if (size < 0) { for (let i = 0; i < -size; i++) mem[to + i] = mem[from + i]; return true; }
  mem.copyWithin(to, from, from + size);
  return true;
}

/** PRINTT table width [height skip]: print a block of characters. */
export function printTable(table, width, height = 1, skip = 0) {
  table = Number(table) & 0xffff; width = Number(width); height = Number(height); skip = Number(skip);
  const rows = [];
  for (let r = 0, a = table; r < height; r++, a += width + skip) {
    let row = '';
    for (let c = 0; c < width; c++) row += String.fromCharCode(mem[a + c]);
    rows.push(row);
  }
  // In the upper window every row starts below the first, in the same column.
  const pos = currentWindow === 1 && !tableOut.length && io.upperPos?.();
  if (pos) {
    rows.forEach((row, r) => { if (r) cursorSet(pos.line + r, pos.col); tell(row); });
    return true;
  }
  return tell(rows.join('\n'));
}

/** ZWSTR text length from coded: dictionary encoding of a word in a text buffer. */
export function encodeWord(text, len, from, coded) {
  let word = '';
  for (let i = 0; i < Number(len); i++) word += String.fromCharCode(mem[(Number(text) & 0xffff) + Number(from) + i]);
  dictBytes(word, V).forEach((b, i) => { mem[(Number(coded) & 0xffff) + i] = b; });
  return true;
}

/** A value as a signed 16-bit number (for comparisons in version 4+ games). */
export function s16(x) {
  x = Number(x);
  // (addresses the original kept above 32767 are negative there; see the compiler)
  const neg = story.LAYOUT.negativeFrom;
  if (neg && x >= neg && x < 0x8000) return x - 0x10000;
  return (x << 16) >> 16;
}

export function shift(n, places) {
  n = Number(n); places = Number(places);
  return places >= 0 ? (n << places) & 0xffff : n >> -places;
}
export function isOriginal() { return true; }
export function checkUnicode() { return 3; }
export function printUnicode(c) { return tell(String.fromCharCode(Number(c))); }
export function eraseLine() { io.eraseLine?.(); return true; }
/** CURGET table: the cursor position (the front end has no real cursor: line 1, column 1). */
export function cursorGet(table) {
  const pos = (currentWindow === 1 && io.upperPos?.()) || cursorPos;
  put(table, 0, pos.line); put(table, 1, pos.col); return true;
}
export function setColor(fg, bg) { io.color?.(Number(fg), Number(bg)); return true; }
let currentFont = 1;
// Font 3, the character graphics font (Z-machine standard §16; used by Beyond
// Zork's borders, map and gauges), as Unicode block and box characters.
const FONT3 = [
  ' ', '←', '→', '╱', '╲', ' ', '─', '─', '│', '│', '┴', '┬', '├', '┤', '└', '┌', '┐', '┘',
  '└', '┌', '┐', '┘', '█', '▀', '▄', '▌', '▐', '▄', '▀', '▌', '▐', '▝', '▗', '▖', '▘',
  '▝', '▗', '▖', '▘', '?', '?', '?', '?', '▔', '▁', '▏', '▕', ' ', '▏', '▎', '▍', '▌', '▋', '▊',
  '▉', '█', '▕', '▏', '╳', '┼', '↑', '↓', '↕', '⎕', '?',
  'ᚪ', 'ᛒ', 'ᛇ', 'ᛞ', 'ᛖ', 'ᚠ', 'ᚷ', 'ᚻ', 'ᛁ', 'ᛄ', 'ᛦ', 'ᛚ', 'ᛗ', 'ᚾ', 'ᚩ', 'ᖾ', 'ᚳ', 'ᚱ',
  'ᛋ', 'ᛏ', 'ᚢ', 'ᛠ', 'ᚹ', 'ᛉ', 'ᚥ', 'ᛟ', '↑', '↓', '↕', '?',
];
function font3(text) {
  let out = '';
  for (const ch of text) { const c = ch.charCodeAt(0); out += c >= 32 && c <= 126 ? FONT3[c - 32] : ch; }
  return out;
}
export function setFont(f) { const old = currentFont; if (Number(f)) currentFont = Number(f); return old; }
// Mouse, picture and window operations of later games: nothing to do here.
export function mouseInfo() { return true; }
export function mouseLimit() { return true; }
export function winPos() { return true; }
export function winSize() { return true; }
export function winAttr() { return true; }
export function winGet() { return 0; }
export function winPut() { return true; }
export function margin() { return true; }
export function picInfo() { return 0; }
export function display() { return true; }
export function displayClear() { return true; }
export function menu() { return 0; }
const userStack = [];
export function xpush(v) { userStack.push(v); return true; }
export function pop() { return userStack.pop() ?? 0; }
export function fstack(n) { for (let i = 0; i < Number(n); i++) userStack.pop(); return true; }
export function isVerb(...actions) { return actions.some((a) => g.PRSA == a); }
export function enable(int) { return put(int, 0, 1); }
export function disable(int) { return put(int, 0, 0); }
export function globalValue(n) { return g[story.GLOBAL_NAMES[n - 16]]; }
// <SET .X v>: store into variable number X. Only globals (16+) are reachable
// here; local variables of the running routine cannot be addressed by number.
export function setVarIndirect(n, v) {
  if (n >= 16 && story.GLOBAL_NAMES[n - 16]) g[story.GLOBAL_NAMES[n - 16]] = v;
  return v;
}

export async function apply(fn, ...args) {
  if (!fn) return false;
  const f = routines[fn - (story.LAYOUT.routineBase ?? 0)];
  if (!f) throw new Error(`apply: no routine ${fn}`);
  return f(...args);
}

// Random numbers.  RANDOM with a negative argument seeds a 32-bit xorshift
// generator (the same scheme as the ZVM interpreter, which makes transcripts
// reproducible and comparable); RANDOM 0 returns to unseeded randomness.
let rngSeeded = false;
export function seedRandom(seed) { rngState = seed | 0 || 1; rngSeeded = true; }
export function random(n) {
  n = Number(n);
  if (n < 1) { rngState = n | 0; return 0; }
  let seed = rngState;
  if (seed === 0) return 1 + ((Math.random() * n) | 0);
  seed ^= (seed << 13);
  seed ^= (seed >> 17);
  rngState = (seed ^= (seed << 5));
  return 1 + ((seed & 0x7fff) % n);
}
export function prob(n) { return random(100) <= n; }

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const SEPARATORS = new Set(['.', ',', '"']);

/** READ: wait for a line of input and tokenize it into the parse buffer. */
export async function read(inbuf, lexv) {
  inbuf = Number(inbuf) & 0xffff; lexv = Number(lexv) & 0xffff;
  keyBuffer.length = 0;
  io.status?.({ room: objectName(g.HERE), score: g.SCORE, moves: g.MOVES });
  let line = await io.input();
  if (line && typeof line === 'object') {
    // Host request to jump to another game state (undo / load from the UI).
    loadSnapshot(line.snapshot);
    throw new RestoreSignal(line.notice ?? '');
  }
  const max = mem[inbuf];
  line = String(line).toLowerCase().replace(/[^\x20-\x7e]/g, ' ');
  if (V <= 4) {
    // Text from byte 1, ended by a zero byte.
    line = line.slice(0, max - 1);
    for (let i = 0; i < line.length; i++) mem[inbuf + 1 + i] = line.charCodeAt(i);
    mem[inbuf + 1 + line.length] = 0;
  } else {
    // Version 5: byte 1 holds the length, the text follows from byte 2.
    line = line.slice(0, max);
    mem[inbuf + 1] = line.length;
    for (let i = 0; i < line.length; i++) mem[inbuf + 2 + i] = line.charCodeAt(i);
  }
  if (lexv) tokenize(inbuf, lexv);
  return V >= 5 ? 13 : true;
}

/** Split the text in a read buffer into words and look them up (also LEX). */
export function tokenize(inbuf, lexv, dict = 0, keepUnknown = false) {
  inbuf = Number(inbuf) & 0xffff; lexv = Number(lexv) & 0xffff;
  const start = V <= 4 ? 1 : 2;
  let line = '';
  if (V <= 4) { for (let i = inbuf + 1; mem[i]; i++) line += String.fromCharCode(mem[i]); }
  else { for (let i = 0; i < mem[inbuf + 1]; i++) line += String.fromCharCode(mem[inbuf + 2 + i]); }
  const tokens = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ') { i++; continue; }
    if (SEPARATORS.has(c)) { tokens.push({ text: c, pos: i }); i++; continue; }
    let j = i;
    while (j < line.length && line[j] !== ' ' && !SEPARATORS.has(line[j])) j++;
    tokens.push({ text: line.slice(i, j), pos: i });
    i = j;
  }
  const capacity = Math.min(mem[lexv] || 59, 59);
  const count = Math.min(tokens.length, capacity);
  mem[lexv + 1] = count;
  for (let k = 0; k < count; k++) {
    const t = tokens[k];
    const addr = dictionary.get(dictKey(t.text, V)) || 0;
    const e = lexv + 2 + 4 * k;
    if (!addr && keepUnknown) continue;
    mem[e] = addr >> 8; mem[e + 1] = addr & 255;
    mem[e + 2] = t.text.length;
    mem[e + 3] = t.pos + start;
  }
  return true;
}

/**
 * INPUT: one key press. The front end supplies lines, so this takes the
 * first character of the next line (Return for an empty one).
 */
// A typed line feeds its characters one key at a time (so forms that read key
// by key, like Bureaucracy's, can be filled in with lines).
const keyBuffer = [];
export async function readChar() {
  if (!keyBuffer.length) {
    io.status?.({ room: objectName(g.HERE), score: g.SCORE, moves: g.MOVES });
    const line = io.inputChar ? await io.inputChar() : await io.input();
    if (line && typeof line === 'object') {
      loadSnapshot(line.snapshot);
      throw new RestoreSignal(line.notice ?? '');
    }
    // One character: just that key (menus: Beyond Zork's \ and ]); longer
    // text: its keys and Return (form fields); nothing: Return.
    const text = String(line ?? '');
    for (const ch of text) keyBuffer.push(ch.charCodeAt(0));
    if (text.length !== 1) keyBuffer.push(13);
  }
  return keyBuffer.shift();
}

// ---------------------------------------------------------------------------
// Save / restore / restart / quit
// ---------------------------------------------------------------------------

export function snapshot() {
  return { version: 1, mem: bytesToBase64(mem), globals: { ...g }, rng: rngState };
}

export function loadSnapshot(s) {
  mem = base64ToBytes(s.mem);
  for (const k of Object.keys(g)) delete g[k];
  Object.assign(g, s.globals);
  rngState = s.rng;
  fixedFont = false;
  headerFlagsChanged();
}

export async function save() {
  try {
    return (await io.save(snapshot())) ? true : false;
  } catch {
    return false;
  }
}

export async function restore() {
  const s = await io.restore();
  if (!s) return false;
  loadSnapshot(s);
  throw new RestoreSignal();
}

// Undo inside the game (ISAVE / IRESTORE, e.g. Beyond Zork's UNDO command).
let undoSnapshot = null;
export async function saveUndo() { undoSnapshot = snapshot(); return 1; }
export async function restoreUndo() {
  if (!undoSnapshot) return 0;
  loadSnapshot(undoSnapshot);
  undoSnapshot = null;
  throw new RestoreSignal();
}

export async function restart() { throw new RestartSignal(); }
export async function quit() { throw new QuitSignal(); }

// ---------------------------------------------------------------------------
// Introspection helpers (used by the AI interpreter to describe the scene)
// ---------------------------------------------------------------------------

/** Full spelling(s) of the dictionary word at addr. */
function wordTexts(addr) {
  const key = Array.from(mem.slice(addr, addr + 4), (b) => b.toString(16).padStart(2, '0')).join('');
  return story.FULL_WORDS?.[key] || [decodeText(mem, addr, 2).text];
}

export const inspect = {
  get memory() { return mem; },
  objectName,
  objectWords(o) {
    const words = [];
    const syn = getPropAddr(o, story.LAYOUT.props.SYNONYM);
    if (syn) for (let i = 0; i < propSize(syn) / 2; i++) words.push(...wordTexts(rw(syn + 2 * i) & 0xffff));
    return words;
  },
  objectAdjectives(o) {
    // Adjective numbers -> words, via the dictionary.
    const adj = getPropAddr(o, story.LAYOUT.props.ADJECTIVE);
    if (!adj) return [];
    // Version 4+: the property lists the words themselves.
    if (V >= 4) {
      const out = [];
      for (let i = 0; i < propSize(adj) / 2; i++) out.push(...wordTexts(rw(adj + 2 * i) & 0xffff));
      return out;
    }
    const nums = new Set();
    for (let i = 0; i < propSize(adj); i++) nums.add(mem[adj + i]);
    const out = [];
    for (const a of dictionary.values()) {
      const ps = mem[a + 4];
      if (!(ps & 32)) continue;
      const v = (ps & 3) === 2 ? mem[a + 5] : mem[a + 6];
      if (nums.has(v)) out.push(...wordTexts(a));
    }
    return out;
  },
  children(o) { const out = []; for (let c = first(o); c; c = next(c)) out.push(c); return out; },
  pseudoWord(propAddr, i) { return wordTexts(rw(propAddr + 4 * i) & 0xffff)[0]; },
  hasFlag, loc, getPropAddr, propSize,
  isKnownWord(w) { return dictionary.has(dictKey(w, V)); },
};
