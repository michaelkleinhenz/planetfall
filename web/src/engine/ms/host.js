// Runs a Magnetic Scrolls game in the app: the same host contract as the
// Z-machine games (engine/game.js), plus a view of the game's world (rooms,
// exits, nouns, dictionary) read from the program's own tables for the
// status line, the map and the AI.
//
// The world, as the original source defines it:
//   ROOM        the player's room number
//   NETWORK     exits: NET_SIZE bytes per room (N NE E SE S SW W NW U D [IN OUT]);
//               a room number, 0 for none, or a code for a special message
//   noun table  14 bytes per noun (see fred23jr's data.h); rooms are nouns too
//   word table  sections separated by $82: 4 verbs, 5 adjectives, 6 nouns,
//               7 directions, 11 synonyms ... (each word ends with bit 7 set)
//   ADJ.TBL     each noun's adjectives (adjective number + 3), zero-terminated

import { current } from '../current.js';
import { Machine } from './machine.js';

let machine = null;
let world = null;

export const msMachine = () => machine;

function base64ToBytes(b64) {
  if (!b64) return null;
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
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  return Buffer.from(bytes).toString('base64');
}

/** Create the machine for the current game (without running it). */
export function createMachine({ seed } = {}) {
  const { story } = current;
  machine = new Machine({
    code: base64ToBytes(story.CODE_BASE64),
    wtable: base64ToBytes(story.WTABLE_BASE64),
    messages: story.MESSAGES,
  });
  machine.seed(seed ?? ((Math.random() * 0x7fffffff) | 1));
  world = null;
  picture = null;
  pictureRoom = 0;
  return machine;
}

// ---------------------------------------------------------------------------
// Snapshots (undo, saves): the whole machine as JSON-friendly data.
// ---------------------------------------------------------------------------

export function snapshot() {
  if (!machine) return null;
  const s = machine.snapshot();
  return { engine: 'magnetic', mem: bytesToBase64(s.mem), wtable: machine.wtable ? bytesToBase64(machine.wtable) : null, cpu: s.cpu, nouns: s.nouns, fmt: s.fmt, rng: s.rng };
}

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

let picture = null;     // picture shown now (0-based number in the .gfx file), or null
let pictureRoom = 0;    // the room it was chosen for

/** The picture the game's own table gives a room (classic pictures only). */
export function roomPicture(room = roomNumber()) {
  if (!machine || !room) return null;
  const idx = current.code.SYMBOLS.PICTURE_INDEX;
  if (idx == null) return null;
  const mem = machine.mem;
  if (current.code.PICTURE_INDEX === 'rooms') {
    const n = mem[idx + room - 1];
    return n ? n - 1 : null;
  }
  // (picture, room, version) entries up to a negative picture number.
  for (let a = idx; a + 2 < mem.length && mem[a] < 0x80; a += 3) {
    if (mem[a + 1] === (room & 0xff) && mem[a + 2] === 0) return mem[a] ? mem[a] - 1 : null;
  }
  return null;
}

/** The picture shown now, or null. */
export function currentPicture() { return picture; }

/**
 * After a turn: the picture the game asked for (LOAD_PIC), or, when the room
 * changed without one (a brief description doesn't draw), the room's picture.
 */
function updatePicture(reset = false) {
  const room = roomNumber();
  const ev = machine.picture;
  machine.picture = null;
  if (ev && !reset) picture = ev.show ? (ev.version === 0 ? ev.n : roomPicture(room)) : null;
  else if (reset || room !== pictureRoom) picture = roomPicture(room);
  pictureRoom = room;
  return picture;
}

export function loadSnapshot(s) {
  machine.restore({ mem: base64ToBytes(s.mem), cpu: s.cpu, nouns: s.nouns, fmt: s.fmt, rng: s.rng });
  if (s.wtable && machine.wtable) machine.wtable.set(base64ToBytes(s.wtable));
  machine.input = [];
  machine.output = [];
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

const FILENAME_PROMPT = /enter filename\s*:\s*$/i;
const CONFIRM_PROMPT = /\(y\/n\)\??\s*$/i;

/** The game loop: run until the game wants input, then ask the host. */
export async function runMagnetic(io, { seed } = {}) {
  createMachine({ seed });
  let lastInput = snapshot();
  let askedName = false;
  let started = false;
  const flush = () => {
    // The games pad room titles and sentences with a space before line breaks.
    let text = machine.takeOutput().replace(/ +\n/g, '\n');
    // The file name and confirmation prompts of SAVE and RESTORE are answered
    // here, so they are not shown.
    const shown = text.replace(/please enter filename\s*:\s*$/i, '').replace(/are you sure \(y\/n\)\??\s*$/i, askedName ? '' : '$&');
    if (shown.trim()) { io.output(started ? shown : shown.replace(/^\s+/, '')); started = true; }
    return text;
  };
  for (;;) {
    let state;
    try {
      state = machine.run();
    } catch (e) {
      flush();
      throw e;
    }
    const text = flush();
    switch (state) {
      case 'input': {
        // SAVE and RESTORE ask for a file name first: the app has its own
        // save slots, so the name is answered here.
        if (FILENAME_PROMPT.test(text)) { machine.type('game'); askedName = true; continue; }
        // ...and then confirm it ("Are you sure (y/n)?").
        if (askedName && CONFIRM_PROMPT.test(text)) { askedName = false; machine.type('y'); continue; }
        askedName = false;
        io.status?.(status());
        io.picture?.(updatePicture());
        lastInput = snapshot();
        const line = await io.input();
        if (line && typeof line === 'object') {
          loadSnapshot(line.snapshot);
          io.picture?.(updatePicture(true));
          if (line.notice) io.output(line.notice);
          io.status?.(status());
          continue;
        }
        machine.type(String(line));
        continue;
      }
      case 'save': {
        // The saved game is the state at the prompt where SAVE was typed.
        let ok = false;
        try { ok = !!(await io.save(lastInput)); } catch { ok = false; }
        machine.cpu.d[7] = ok ? 0 : 0xffffffff;
        if (ok) io.output('Saved.\n');
        continue;
      }
      case 'load': {
        // The game restores its own variables (the block it asked for) from
        // the saved state, then carries on as after its own RESTORE.
        let s = null;
        try { s = await io.restore(); } catch { s = null; }
        if (!s || s.engine !== 'magnetic') { machine.cpu.d[7] = 0xffffffff; continue; }
        const { addr, length } = machine.loadRequest;
        machine.mem.set(base64ToBytes(s.mem).subarray(addr, addr + length), addr);
        if (s.wtable && machine.wtable) machine.wtable.set(base64ToBytes(s.wtable));
        machine.cpu.d[7] = 0;
        io.output('Restored.\n');
        continue;
      }
      case 'restart':
        machine.reset();
        io.restarted?.();
        continue;
      case 'quit':
        if (!io.ended) return;
        await io.ended();
        machine.reset();
        io.restarted?.();
        continue;
    }
  }
}

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

const NOUN_SIZE = 14;
const DIRECTIONS = ['north', 'ne', 'east', 'se', 'south', 'sw', 'west', 'nw', 'up', 'down', 'in', 'out'];

function sym(name) {
  const v = current.code.SYMBOLS[name];
  if (v === undefined) throw new Error(`No symbol ${name}`);
  return v;
}

/** The dictionary: word lists per section (read once per game). */
function dictionary() {
  if (world) return world;
  const m = machine;
  const src = m.wtable ?? m.mem;
  let a = m.wtable ? 0 : sym('TBL.WRD');
  const sections = [[]];
  let w = '';
  for (; a < src.length; a++) {
    const c = src[a];
    if (c === 0x81) break;
    if (c === 0x82) { sections.push([]); continue; }
    w += String.fromCharCode(c & 0x7f);
    if (c & 0x80) { sections[sections.length - 1].push(w); w = ''; }
  }
  // Each noun's adjective list.
  const nounCount = sections[6]?.length ?? 0;
  const adjectives = [];
  let p = sym('ADJ.TBL');
  for (let n = 1; n <= nounCount; n++) {
    const list = [];
    for (let b; (b = m.mem[p++]) !== 0;) list.push(sections[5]?.[b - 4]);
    adjectives[n] = list.filter(Boolean);
  }
  world = { sections, adjectives, nounCount };
  return world;
}

const word = (w) => String(w ?? '').replace(/_/g, ' ');

export function noun(n) {
  const m = machine;
  const a = m.nouns.data + NOUN_SIZE * n;
  const b = (i) => m.mem[a + i];
  const adjectives = dictionary().adjectives[n] ?? [];
  const base = word(dictionary().sections[6]?.[n - 1]).trim();
  return {
    n,
    // The name as the game prints it: "force_adj" nouns take their first adjective ("Rank Forest").
    name: (b(5) & 0x10) && adjectives.length ? `${word(adjectives[0])} ${base}` : base,
    word: base.toLowerCase(),
    adjectives: adjectives.map((x) => word(x).toLowerCase()),
    lit: !!(b(0) & 0x80), locked: !!(b(0) & 0x40), closed: !!(b(0) & 0x20), open: !!(b(0) & 0x10),
    localContents: !!(b(0) & 0x08), broken: !!(b(0) & 0x04), dead: !!(b(0) & 0x02), plural: !!(b(0) & 0x01),
    moveable: !!(b(3) & 0x10), lightable: !!(b(4) & 0x80), npc: !!(b(4) & 0x40),
    pseudo: !!(b(5) & 0x01), out: !!(b(6) & 0x80), room: !!(b(6) & 0x40), contained: !!(b(6) & 0x20),
    inseparable: !!(b(6) & 0x10), intrinsic: !!(b(6) & 0x08), worn: !!(b(6) & 0x04), hidden: !!(b(6) & 0x02),
    related: !!(b(6) & 0x01), locFlags: b(6), location: (b(8) << 8) | b(9),
    container: b(10) & 7, edible: (b(11) >> 5) & 7, wearable: (b(11) >> 1) & 3, fixed: !!(b(12) & 0x80),
  };
}

const rd16 = (a) => (machine.mem[a] << 8) | machine.mem[a + 1];

export function roomNumber() { return machine ? rd16(sym('ROOM')) : 0; }

/** The noun that is the room (R.NOUN in the original). */
export function roomNoun(room = roomNumber()) {
  if (!machine || !room) return 0;
  const { nounCount } = dictionary();
  for (let n = 1; n <= nounCount; n++) {
    const a = machine.nouns.data + NOUN_SIZE * n;
    if ((machine.mem[a + 6] & 0x40) && rd16(a + 8) === room) return n;
  }
  return 0;
}

/** Room ids for the app are the room nouns; their names are the nouns' words. */
export function currentRoomId() { return roomNoun(); }
export function roomName(id) { return id ? noun(id).name : ''; }

function roomCount() {
  return Math.floor((sym('NET_END') - sym('NETWORK')) / current.code.NET_SIZE);
}

/** Directions out of the player's room that lead to another room. */
export function exits(roomId = currentRoomId()) {
  if (!machine || !roomId) return [];
  const room = noun(roomId).location;
  const size = current.code.NET_SIZE;
  const base = sym('NETWORK') + size * (room - 1);
  const max = roomCount();
  const out = [];
  for (let i = 0; i < size; i++) {
    const v = machine.mem[base + i];
    if (v >= 1 && v <= max && v !== room) out.push(DIRECTIONS[i]);
  }
  return out;
}

export function isLit() {
  try { return machine.mem[sym('LIGHT')] !== 0 || rd16(sym('LIGHT')) !== 0; } catch { return true; }
}

export function status() {
  const scale = current.code.SCORE_SCALE ?? 1;
  return {
    room: roomName(currentRoomId()),
    score: rd16(sym('SCORE_')) * scale,
    moves: rd16(sym('CLOCK')),
  };
}

/** Is noun n where the player is (in the room, carried, worn), and how. */
function where(n, room) {
  const x = noun(n);
  if (x.out || x.room || x.hidden) return null;
  if (x.locFlags === 0) return x.location === 0 ? 'carried' : x.location === room ? 'here' : null;
  if (x.worn && x.location === 0) return 'worn';
  return null;
}

/** Things in view and carried, for the AI and the action buttons. */
export function sceneNouns() {
  const room = roomNumber();
  const rn = roomNoun(room);
  const { nounCount } = dictionary();
  const out = [];
  const seen = new Set();
  const add = (n, how, inside) => {
    if (seen.has(n)) return;
    seen.add(n);
    const x = noun(n);
    if (!x.name || x.pseudo && how !== 'scenery') return;
    out.push({ ...x, how, inside });
  };
  for (let n = 1; n <= nounCount; n++) {
    const w = where(n, room);
    if (w) add(n, w);
  }
  // Pseudo nouns (scenery a description mentions): their location points into
  // PSUDAT, a zero-terminated list of the rooms they are in.
  const psudat = current.code.SYMBOLS.PSUDAT;
  if (psudat !== undefined) {
    for (let n = 1; n <= nounCount; n++) {
      const x = noun(n);
      if (!x.pseudo || x.out) continue;
      for (let p = psudat + x.location, r; (r = machine.mem[p]) !== 0; p++) {
        if (r === room) { add(n, 'scenery'); break; }
      }
    }
  }
  // Contents of open containers in view, things related to the room (scenery).
  for (let pass = 0; pass < 3; pass++) {
    for (let n = 1; n <= nounCount; n++) {
      if (seen.has(n)) continue;
      const x = noun(n);
      if (x.out || x.room || x.hidden) continue;
      if (x.contained) {
        const c = out.find((o) => o.n === x.location);
        if (c && (c.open || !c.closed) && !c.npc) add(n, c.how === 'here' ? 'here' : 'carried', c.name);
      } else if (x.related && x.location === rn) add(n, 'scenery');
    }
  }
  return out;
}

/** The game's vocabulary for the AI interpreter. */
export function vocabulary() {
  const { sections } = dictionary();
  const clean = (list) => [...new Set((list ?? []).map((w) => w.toLowerCase().replace(/_/g, ' ')))].filter((w) => /^[a-z][a-z' -]*$/.test(w));
  return {
    verbs: clean(sections[4]),
    adjectives: clean(sections[5]),
    nouns: clean(sections[6]),
    directions: clean(sections[7]),
    meta: clean(sections[8]),
    prepositions: clean(sections[2]),
    synonyms: clean(sections[11]),
  };
}

/** Values of the game's main variables (by their names in the source). */
export function variables(names) {
  const out = {};
  for (const n of names) {
    const a = current.code.SYMBOLS[n];
    if (a !== undefined) out[n] = rd16(a);
  }
  return out;
}
