// Finds where an original Magnetic Scrolls program (.mag) keeps the player's
// room and its exits, for games whose source (and so symbol table) was never
// released.  The game is explored automatically: from each room every
// direction is tried (undoing after each), and the status line (which the
// games print on their own channel) names the room.
//
//   ROOM     the word that changes exactly when the room changes; its value
//            is the room number (the location of the room's noun).
//   NETWORK  the exits table: NET_SIZE bytes per room, each the room that
//            direction leads to, so every move seen must match it.
//
// Usage: node tools/magnetic/probe.mjs <file.mag> [commands to play first...]
// Prints the values for tools/magnetic/games.mjs.

import fs from 'node:fs';
import { Machine } from '../../web/src/engine/ms/machine.js';
import { parseMag } from './mag.mjs';

const DIRS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw', 'u', 'd', 'in', 'out'];

export function probe(bytes, prelude = [], maxRooms = 40) {
  const g = parseMag(bytes);
  const m = new Machine({ code: g.code, wtable: g.dict, messages: g.messages, ...magMemory(g) });
  m.seed(1);
  const go = (cmd) => { m.statusLine = ''; if (cmd) m.type(cmd); const st = m.run(); m.takeOutput(); return st; };
  const room = () => (m.statusLine || '').split('\t')[0].trim();
  go();
  for (const c of prelude) go(c);
  const states = [{ snap: m.snapshot(), name: room(), mem: m.mem.slice() }];
  const moves = [];
  for (let i = 0; i < states.length && states.length < maxRooms; i++) {
    for (let di = 0; di < DIRS.length; di++) {
      m.restore(states[i].snap);
      try { if (go(DIRS[di]) !== 'input') continue; } catch { continue; }
      const name = room();
      if (!name || name === states[i].name) continue;
      const after = m.mem.slice();
      // Rooms are explored once per name (two rooms may share one); each move keeps its own memory.
      if (!states.some((s) => s.name === name)) states.push({ snap: m.snapshot(), name, mem: after });
      moves.push({ from: i, di, mem: after });
    }
  }
  const N = m.mem.length;
  const w = (mem, a) => (mem[a] << 8) | mem[a + 1];
  // ROOM: equal for the same room name, different across every move.
  const rooms = [];
  for (let a = 0; a < N - 1; a += 2) {
    const byValue = new Map();
    let ok = true;
    for (const s of states) {
      const v = w(s.mem, a);
      if (v === 0 || v > 1000 || (byValue.has(v) && byValue.get(v) !== s.name)) { ok = false; break; }
      byValue.set(v, s.name);
    }
    if (ok && moves.every((t) => w(states[t.from].mem, a) !== w(t.mem, a))) rooms.push(a);
  }
  const result = { rooms: states.map((s) => s.name), moves: moves.length, candidates: [] };
  const compass = moves.filter((t) => t.di < 10);
  for (const ROOM of rooms) {
    for (const S of [10, 12]) {
      for (let B = 0; B < N - S; B++) {
        // Doors (and other exits handled in code) are not in the table, so allow some misses.
        const hits = compass.filter((t) => states[0].mem[B + (w(states[t.from].mem, ROOM) - 1) * S + t.di] === w(t.mem, ROOM)).length;
        if (hits >= compass.length * 0.75) result.candidates.push({ ROOM, NETWORK: B, NET_SIZE: S, hits });
      }
    }
  }
  result.candidates.sort((x, y) => y.hits - x.hits);
  result.compass = compass.length;
  return result;
}

/** Memory layout of an original release: 64K with address wrap for the early games. */
export function magMemory(g) {
  return { memorySize: Math.max(0x10000, g.code.length), wrap: g.code.length <= 0x10000, stackTop: 0xfffe };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  const [file, ...prelude] = process.argv.slice(2);
  const r = probe(new Uint8Array(fs.readFileSync(file)), prelude);
  console.log(`rooms visited: ${r.rooms.length} (${r.rooms.slice(0, 8).join(', ')}...), moves: ${r.moves}`);
  for (const c of r.candidates.slice(0, 10)) console.log(`ROOM 0x${c.ROOM.toString(16)}  NETWORK 0x${c.NETWORK.toString(16)}  NET_SIZE ${c.NET_SIZE}  (${c.hits}/${r.compass} moves)`);
  if (!r.candidates.length) console.log('No consistent exits table found: explore further (pass commands to play first).');
}
