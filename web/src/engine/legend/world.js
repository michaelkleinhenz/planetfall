// What the app can see of a Legend game's world, read from the game's memory:
// the object table (found at start-up), each object's name, location and
// flags, and the dictionary (VOCAB.DAT).
//
// Object table: 6 bytes per object number (far pointer to the object's record,
// then its type). A record starts with the byte offsets (plus one) of its
// names in OBJECT.DAT. Where an object is: the word at +0x0e for types 2 and
// 4, +0x0c for types 7 and 8 (the player, object "you", keeps the room it is
// in at +0x0c). Flags at +4: 0x2000 can be opened, 0x0800 open.
// (Layouts as described by the gateway-port project's notes, checked here.)

const LOCATION = { 2: 0x0e, 4: 0x0e, 7: 0x0c, 8: 0x0c };
const CONTAINER = 0x2000, OPEN = 0x0800;

/** Names in OBJECT.DAT by token (byte offset + 1). */
export function objectNames(bytes) {
  const names = new Map();
  let start = 2;
  for (let i = 2; i < bytes.length; i++) {
    if (bytes[i] === 0) { names.set(start - 1, String.fromCharCode(...bytes.subarray(start, i))); start = i + 1; }
  }
  return names;
}

/** The dictionary: [{word, flags}] (flags: 1 verb, 2 noun, 4 adjective, 8 preposition, 0x40 plural). */
export function vocabulary(bytes) {
  const u16 = (o) => bytes[o] | (bytes[o + 1] << 8);
  let p = 0;
  const tw = u16(p); p += 2;
  const tree = [];
  for (let i = 0; i < tw; i++, p += 2) tree.push(u16(p));
  const size = u16(p); p += 2;
  const text = [];
  let code = tw - 2;
  for (let i = 0; i < size; i++) {
    const byte = bytes[p + i];
    for (let b = 0; b < 8; b++) {
      code = tree[code | ((byte >> b) & 1)];
      if (code & 0x8000) { text.push(code ^ 0xffff); code = tw - 2; }
    }
  }
  p += size;
  const count = u16(p); p += 2;
  const words = [];
  for (let i = 0; i < count; i++, p += 4) {
    const off = u16(p), flags = u16(p + 2);
    let w = '';
    for (let j = off; j < text.length && text[j]; j++) w += String.fromCharCode(text[j]);
    words.push({ word: w, flags });
  }
  return words;
}

export class LegendWorld {
  constructor(machine, objectDat) {
    this.machine = machine;
    this.names = objectNames(objectDat);
    this.table = null;
    this.player = 0;
  }

  get mem() { return this.machine.dos.mem; }
  w16(a) { const m = this.mem; return m[a] | (m[a + 1] << 8); }

  /** Find the object table: consecutive far pointers to records that start with name tokens. */
  find() {
    const mem = this.mem;
    const ok = (e) => {
      const off = this.w16(e), seg = this.w16(e + 2), type = this.w16(e + 4);
      if (type < 1 || type > 8) return false;
      const rec = seg * 16 + off;
      if (rec >= 0xa0000) return false;
      const t = this.w16(rec);
      return t === 0 || this.names.has(t);
    };
    for (let a = 0x500; a < 0xa0000 - 6 * 64; a += 2) {
      if (!ok(a)) continue;
      let run = 0;
      while (run < 64 && ok(a + run * 6)) run++;
      if (run < 64) continue;
      let start = a;
      while (start - 6 >= 0 && ok(start - 6)) start -= 6;
      // Entry 0 is the table's header (objects are numbered from 1); it may
      // look like an entry too. The right numbering puts the player ("you")
      // in a room (type 1).
      for (const base of [start - 6, start]) {
        let count = 0;
        while (ok(base + (count + 1) * 6)) count++;
        if (count < 100) continue;
        this.table = base;
        this.count = count;
        this.player = 0;
        for (let id = 1; id <= count; id++) if (this.name(id) === 'you') { this.player = id; break; }
        // ...and what the player wears or carries points back at the player.
        const room = this.player ? this.room() : 0;
        if (room >= 1 && room <= count && this.record(room).type === 1 && this.children(this.player).length) return true;
      }
      a = start + 64 * 6;
    }
    this.table = null;
    return false;
  }

  record(id) {
    const e = this.table + id * 6;
    return { rec: this.w16(e + 2) * 16 + this.w16(e), type: this.w16(e + 4) };
  }
  name(id) {
    if (!this.table || id < 1 || id > this.count) return '';
    return this.names.get(this.w16(this.record(id).rec)) ?? '';
  }
  flags(id) { return this.w16(this.record(id).rec + 4); }
  location(id) {
    const { rec, type } = this.record(id);
    const off = LOCATION[type];
    return off == null ? 0 : this.w16(rec + off);
  }

  /** The room the player is in (object number). */
  room() {
    if (!this.table) return 0;
    return this.w16(this.record(this.player).rec + 0x0c);
  }

  /** Objects whose location is `where`. */
  children(where) {
    const out = [];
    for (let id = 1; id <= this.count; id++) {
      if (id === this.player) continue;
      const { type } = this.record(id);
      if (LOCATION[type] == null) continue;
      if (this.location(id) === where) out.push(id);
    }
    return out;
  }

  /**
   * What the player can refer to: { id, name, how: 'carried'|'here', inside }.
   * Things inside closed containers are left out.
   */
  scene() {
    if (!this.table) return [];
    const out = [];
    const seen = new Set();
    const walk = (where, how, depth, inside) => {
      for (const id of this.children(where)) {
        if (seen.has(id)) continue;
        seen.add(id);
        const name = this.name(id);
        if (name) out.push({ id, name, how, inside, flags: this.flags(id) });
        const f = this.flags(id);
        if (depth < 2 && (!(f & CONTAINER) || (f & OPEN))) walk(id, how, depth + 1, name);
      }
    };
    walk(this.player, 'carried', 0, null);
    walk(this.room(), 'here', 0, null);
    return out;
  }
}
