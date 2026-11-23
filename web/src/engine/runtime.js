// Runtime support for the JavaScript translation of Planetfall.
//
// The original game was written in ZIL for the Z-machine.  Its code freely
// manipulates object property tables, dictionary words and parser buffers as
// raw bytes, so this runtime keeps a small byte-addressed memory with the same
// layout conventions (objects, property tables, vocabulary, tables) and offers
// the primitive operations the translated code calls (hasFlag, move, getProp,
// tell, read, ...).  Game state = memory bytes + global variables + RNG state.

import { decodeText, dictKey } from './zscii.js';

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
  dictionary = new Map();
  const { dictionary: start, dictionaryCount, entryLength } = story.LAYOUT;
  for (let i = 0; i < dictionaryCount; i++) {
    const a = start + i * entryLength;
    const key = Array.from(mem.slice(a, a + 4), (b) => b.toString(16).padStart(2, '0')).join('');
    dictionary.set(key, a);
  }
  fixedFont = false;
  if (!rngSeeded) rngState = (Math.random() * 0x7fffffff) | 1;
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

export function get(tbl, i) { return rw(Number(tbl) + 2 * Number(i)); }
export function put(tbl, i, v) { ww(Number(tbl) + 2 * Number(i), v); return true; }
export function getb(tbl, i) { return mem[Number(tbl) + Number(i)]; }
export function putb(tbl, i, v) { mem[Number(tbl) + Number(i)] = Number(v) & 255; return true; }

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

function objAddr(o) { return story.LAYOUT.objTable + (o - 1) * 9; }

export function hasFlag(o, f) {
  if (!o) return false;
  return (mem[objAddr(o) + (f >> 3)] & (0x80 >> (f & 7))) !== 0;
}
export function setFlag(o, f) { if (o) mem[objAddr(o) + (f >> 3)] |= 0x80 >> (f & 7); return true; }
export function clearFlag(o, f) { if (o) mem[objAddr(o) + (f >> 3)] &= ~(0x80 >> (f & 7)); return true; }
export function loc(o) { return o ? mem[objAddr(o) + 4] : 0; }
export function first(o) { return o ? mem[objAddr(o) + 6] : 0; }
export function next(o) { return o ? mem[objAddr(o) + 5] : 0; }

export function remove(o) {
  if (!o) return true;
  const a = objAddr(o);
  const parent = mem[a + 4];
  if (parent) {
    const pa = objAddr(parent);
    if (mem[pa + 6] === o) {
      mem[pa + 6] = mem[a + 5];
    } else {
      let c = mem[pa + 6];
      while (c) {
        const ca = objAddr(c);
        if (mem[ca + 5] === o) { mem[ca + 5] = mem[a + 5]; break; }
        c = mem[ca + 5];
      }
    }
  }
  mem[a + 4] = 0; mem[a + 5] = 0;
  return true;
}

export function move(o, dest) {
  remove(o);
  const a = objAddr(o), da = objAddr(dest);
  mem[a + 4] = dest;
  mem[a + 5] = mem[da + 6];
  mem[da + 6] = o;
  return true;
}

function propTable(o) { return (mem[objAddr(o) + 7] << 8) | mem[objAddr(o) + 8]; }

export function getPropAddr(o, p) {
  if (!o) return 0;
  let a = propTable(o);
  a += 1 + 2 * mem[a];
  for (;;) {
    const sb = mem[a];
    if (sb === 0) return 0;
    const num = sb & 31;
    const len = (sb >> 5) + 1;
    if (num === p) return a + 1;
    if (num < p) return 0;
    a += 1 + len;
  }
}

/** NEXTP: the property after p (p = 0: the first property), or 0 at the end. */
export function nextProp(o, p) {
  let a = propTable(o);
  a += 1 + 2 * mem[a];
  if (p) {
    for (;;) {
      const sb = mem[a];
      if (sb === 0) return 0;
      const num = sb & 31;
      a += 2 + (sb >> 5);
      if (num === p) break;
    }
  }
  return mem[a] & 31;
}

export function propSize(addr) {
  if (!addr) return 0;
  return (mem[addr - 1] >> 5) + 1;
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
  const text = parts.join('');
  if (text) io.output(text, { fixed: fixedFont });
  return true;
}
export function print(s) { return tell(s); }
export function crlf() { return tell('\n'); }

/** Object name (TELL D obj). */
export function D(o) { return objectName(o); }
/** Number (TELL N n). */
export function N(n) { return String(Number(n)); }
/** Character (TELL C c). */
export function C(c) { return String.fromCharCode(Number(c)); }
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
export function dirOut() { return true; }
export function dirIn() { return true; }
export function isVerb(...actions) { return actions.some((a) => g.PRSA == a); }
export function enable(int) { return put(int, 0, 1); }
export function disable(int) { return put(int, 0, 0); }
export function globalValue(n) { return g[story.GLOBAL_NAMES[n - 16]]; }

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
  inbuf = Number(inbuf); lexv = Number(lexv);
  io.status?.({ room: objectName(g.HERE), score: g.SCORE, moves: g.MOVES });
  let line = await io.input();
  if (line && typeof line === 'object') {
    // Host request to jump to another game state (undo / load from the UI).
    loadSnapshot(line.snapshot);
    throw new RestoreSignal(line.notice ?? '');
  }
  const max = mem[inbuf];
  line = String(line).toLowerCase().replace(/[^\x20-\x7e]/g, ' ').slice(0, max - 1);
  for (let i = 0; i < line.length; i++) mem[inbuf + 1 + i] = line.charCodeAt(i);
  mem[inbuf + 1 + line.length] = 0;
  // tokenize
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
  const capacity = Math.min(mem[lexv] || 59, 29);
  const count = Math.min(tokens.length, capacity);
  mem[lexv + 1] = count;
  for (let k = 0; k < count; k++) {
    const t = tokens[k];
    const addr = dictionary.get(dictKey(t.text)) || 0;
    const e = lexv + 2 + 4 * k;
    mem[e] = addr >> 8; mem[e + 1] = addr & 255;
    mem[e + 2] = t.text.length;
    mem[e + 3] = t.pos + 1;
  }
  return true;
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
  isKnownWord(w) { return dictionary.has(dictKey(w)); },
};
