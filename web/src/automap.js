// Automap: records the rooms the player visits and the moves between them, and
// draws them as a map. Rooms are placed on a grid as they are discovered: a
// room reached by going east sits one cell east of the room it was reached
// from (or the nearest free cell). Exits that haven't been taken yet show as
// short stubs; nothing is revealed about rooms the player hasn't seen.

import { inspect } from './engine/runtime.js';
import { currentRoom, roomExits } from './ai/scene.js';

const VEC = {
  north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0],
  ne: [1, -1], nw: [-1, -1], se: [1, 1], sw: [-1, 1],
};
const OPPOSITE = {
  north: 'south', south: 'north', east: 'west', west: 'east', ne: 'sw', sw: 'ne', nw: 'se', se: 'nw',
  up: 'down', down: 'up', in: 'out', out: 'in',
};
const ALIASES = {
  n: 'north', s: 'south', e: 'east', w: 'west', northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
  u: 'up', d: 'down', inside: 'in', outside: 'out', enter: 'in', exit: 'out', leave: 'out',
};
// Commands that move the player without naming a compass direction.
const MOTION = /^(go|walk|run|enter|exit|leave|climb|crawl|swim|jump|board|disembark|get (in|out|on|off|into)|cross|follow|step|slide|descend|ascend|ride|sail|row|fly|stand up)\b/;

/** The direction a command moves in ("go north", "n", "climb up"), or null. */
export function parseDirection(command) {
  let s = String(command).toLowerCase().trim().replace(/[.!]+$/, '');
  s = s.replace(/^(go|walk|run|move|head|crawl|climb|swim|ride|row|sail|fly)\s+(to the\s+)?/, '');
  if (s in VEC || s in OPPOSITE) return s;
  return ALIASES[s] ?? null;
}

export class Automap {
  /** `data`: a stored map ({rooms, edges}) or null. */
  constructor(data) {
    this.rooms = data?.rooms ?? {}; // id -> {name, x, y, exits: [dir]}
    this.edges = data?.edges ?? []; // {a, b, da, db}: da = direction from a to b, db = back
    this.here = null;
  }

  toJSON() { return { rooms: this.rooms, edges: this.edges }; }

  clear() { this.rooms = {}; this.edges = []; this.here = null; }

  occupant(x, y) {
    for (const [id, r] of Object.entries(this.rooms)) if (r.x === x && r.y === y) return Number(id);
    return 0;
  }

  /** The free cell nearest to (x, y), searching rings around it. */
  freeCell(x, y) {
    if (!this.occupant(x, y)) return [x, y];
    for (let ring = 1; ring < 50; ring++) {
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          if (!this.occupant(x + dx, y + dy)) return [x + dx, y + dy];
        }
      }
    }
    return [x, y];
  }

  /** Make sure a room is on the map; place it next to `from` (in `dir`) if new. */
  add(id, from = 0, dir = null) {
    if (!id) return false;
    const room = this.rooms[id];
    if (room) {
      room.name = inspect.objectName(id) || room.name;
      return false;
    }
    let x = 0; let y = 0;
    const origin = this.rooms[from];
    if (origin) {
      const v = VEC[dir];
      if (v) {
        // Further along the same direction if the next cell is taken.
        let k = 1;
        while (k < 4 && this.occupant(origin.x + k * v[0], origin.y + k * v[1])) k++;
        [x, y] = this.freeCell(origin.x + k * v[0], origin.y + k * v[1]);
      } else {
        // Up, down, in, out and other moves: off to the side, keeping the
        // neighbouring compass cells free for the room's ordinary exits.
        const side = { up: [1, -2], down: [-1, 2], in: [2, 1], out: [-2, -1] }[dir] ?? [2, 2];
        [x, y] = this.freeCell(origin.x + side[0], origin.y + side[1]);
      }
    } else if (Object.keys(this.rooms).length) {
      // Not connected to anything known (a teleport, a restored game): below the rest.
      const maxY = Math.max(...Object.values(this.rooms).map((r) => r.y));
      [x, y] = this.freeCell(0, maxY + 2);
    }
    this.rooms[id] = { name: inspect.objectName(id) || '?', x, y, exits: [] };
    return true;
  }

  /** Remember which exits a room has (for the stubs of unexplored ones). */
  noteExits(id) {
    if (this.rooms[id]) this.rooms[id].exits = roomExits(id);
  }

  link(a, b, dir) {
    let e = this.edges.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
    if (!e) { e = { a, b, da: null, db: null }; this.edges.push(e); }
    if (!dir) return;
    if (e.a === a) e.da = dir; else e.db = dir;
  }

  /** Called before and after each command: records where it led. Returns true if the map changed. */
  observe(command, before) {
    const after = currentRoom();
    let changed = false;
    if (before && !this.rooms[before]) { this.add(before); this.noteExits(before); changed = true; }
    if (!after) return changed;
    // Several commands in one line ("n. e"): the rooms in between are unknown.
    const single = !/[.,;]|\bthen\b/i.test(String(command).trim().replace(/[.!]+$/, ''));
    const dir = single ? parseDirection(command) : null;
    if (after !== before) {
      const moved = single && (dir || MOTION.test(String(command).toLowerCase().trim()));
      changed = this.add(after, moved ? before : 0, dir) || changed;
      if (moved && before && this.rooms[before]) this.link(before, after, dir);
      changed = true;
    }
    if (!this.rooms[after]) changed = this.add(after) || changed;
    this.noteExits(after);
    this.here = after;
    return changed;
  }

  /** The current room is on the map (for a game loaded from a save). */
  sync() {
    const id = currentRoom();
    if (id) { this.add(id); this.noteExits(id); this.here = id; }
  }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

const CELL_W = 132;
const CELL_H = 78;
const BOX_W = 104;
const BOX_H = 40;
const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}, text) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
}

/** Split a room name into at most two lines of about 16 characters. */
function wrapName(name) {
  const words = String(name).split(/\s+/);
  const lines = [''];
  for (const w of words) {
    const cur = lines[lines.length - 1];
    if (cur && (cur + ' ' + w).length > 16) {
      if (lines.length === 2) { lines[1] = (lines[1] + ' ' + w).slice(0, 15) + '…'; break; }
      lines.push(w);
    } else lines[lines.length - 1] = cur ? cur + ' ' + w : w;
  }
  return lines.map((l) => (l.length > 17 ? l.slice(0, 16) + '…' : l));
}

/** Where a line from a room's centre in direction `dir` leaves its box. */
function port(cx, cy, dir) {
  const v = VEC[dir];
  if (!v) return [cx, cy];
  return [cx + (v[0] * BOX_W) / 2, cy + (v[1] * BOX_H) / 2];
}

/**
 * Draw the map into an <svg>. `labelFor(name)` may translate room names.
 * Returns the current room's centre in map coordinates.
 */
export function drawMap(map, el, labelFor = (n) => n) {
  el.replaceChildren();
  const center = (r) => [r.x * CELL_W, r.y * CELL_H];
  const lines = svg('g', { class: 'am-lines' });
  const boxes = svg('g', { class: 'am-rooms' });
  const used = new Map(); // room id -> set of directions drawn as connections

  const mark = (id, dir) => { if (!dir) return; if (!used.has(id)) used.set(id, new Set()); used.get(id).add(dir); };
  for (const e of map.edges) {
    const ra = map.rooms[e.a]; const rb = map.rooms[e.b];
    if (!ra || !rb) continue;
    const [ax, ay] = center(ra); const [bx, by] = center(rb);
    const [x1, y1] = port(ax, ay, e.da ?? (e.db ? OPPOSITE[e.db] : null));
    const [x2, y2] = port(bx, by, e.db ?? (e.da ? OPPOSITE[e.da] : null));
    mark(e.a, e.da); mark(e.b, e.db);
    // A one-way passage, or one whose way back isn't known yet, is dashed.
    const twoWay = e.da && e.db;
    const curved = !(e.da in VEC) || (e.db && !(e.db in VEC));
    const cls = `am-link${twoWay ? '' : ' am-oneway'}`;
    if (curved) {
      const mx = (x1 + x2) / 2 + (y2 - y1) * 0.18; const my = (y1 + y2) / 2 - (x2 - x1) * 0.18;
      lines.append(svg('path', { d: `M${x1} ${y1} Q${mx} ${my} ${x2} ${y2}`, class: cls }));
    } else {
      lines.append(svg('line', { x1, y1, x2, y2, class: cls }));
    }
    // Up/down/in/out: say so on the line.
    const tag = (d) => ({ up: 'U', down: 'D', in: 'IN', out: 'OUT' }[d]);
    const label = [tag(e.da), e.db && tag(e.db)].filter(Boolean).join('/');
    if (label) {
      const lx = (x1 + x2) / 2; const ly = (y1 + y2) / 2;
      lines.append(svg('text', { x: lx, y: ly - 4, class: 'am-tag', 'text-anchor': 'middle' }, label));
    }
  }

  for (const [idStr, r] of Object.entries(map.rooms)) {
    const id = Number(idStr);
    const [cx, cy] = center(r);
    // Stubs for exits not taken yet.
    for (const d of r.exits || []) {
      if (used.get(id)?.has(d)) continue;
      const v = VEC[d];
      if (v) {
        const [px, py] = port(cx, cy, d);
        lines.append(svg('line', { x1: px, y1: py, x2: px + v[0] * 14, y2: py + v[1] * 12, class: 'am-stub' }));
      }
    }
    const g = svg('g', { class: `am-room${id === map.here ? ' am-here' : ''}` });
    const name = labelFor(r.name);
    g.append(svg('title', {}, name));
    g.append(svg('rect', { x: cx - BOX_W / 2, y: cy - BOX_H / 2, width: BOX_W, height: BOX_H, rx: 7 }));
    const rows = wrapName(name);
    rows.forEach((line, i) => {
      g.append(svg('text', { x: cx, y: cy + (i - (rows.length - 1) / 2) * 12 + 4, 'text-anchor': 'middle' }, line));
    });
    // Unexplored up/down/in/out exits: a small marker in the corner.
    const extra = (r.exits || []).filter((d) => !(d in VEC) && !used.get(id)?.has(d));
    if (extra.length) {
      const sym = extra.map((d) => ({ up: '↑', down: '↓', in: '⇥', out: '⇤' }[d])).join('');
      g.append(svg('text', { x: cx + BOX_W / 2 - 4, y: cy - BOX_H / 2 + 10, 'text-anchor': 'end', class: 'am-extra' }, sym));
    }
    boxes.append(g);
  }
  el.append(lines, boxes);
  const here = map.rooms[map.here];
  return here ? center(here) : [0, 0];
}
