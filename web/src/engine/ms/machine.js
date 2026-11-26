// The Magnetic Scrolls virtual machine: the 68000 program assembled from the
// original source (a "prog" file, Amiga hunk format with a symbol table), the
// game's messages, and the host calls the program makes through A-line and
// F-line instructions.
//
// The host calls follow the Magnetic Scrolls system: SETNOUNS tells the host
// where the noun table is, GETDATA/GETNOUNS/QCARRIED/GETTIED walk it, SEARCH
// and WORDSCAN/NOUNSCAN look words up in the dictionary, TEXT prints message N,
// CHAROUT prints a character and CHARIN reads one.

import { M68k, CpuError } from './m68k.js';

// A-line host calls, $A0FF downwards.
const A = {
  SEARCH: 0xff, GETDATA: 0xfe, SETNOUNS: 0xfd, NOUNSCAN: 0xfc, WORDSCAN: 0xfb,
  GETNOUNS: 0xfa, QCARRIED: 0xf9, TEXT: 0xf8, RANDOM1: 0xf7, RANDOM2: 0xf6,
  LOADFILE: 0xf5, SAVEFILE: 0xf4, CHAROUT: 0xf3, GETTIED: 0xf2, FINDZERO: 0xf1,
  GRAPHICS: 0xf0, PRINTER: 0xef, RESTART: 0xee, QUIT: 0xed, GETWTAB: 0xec,
  PUTWTAB: 0xeb, PRINTWORD: 0xea, COPYWORD: 0xe9, SETNE: 0xe8, SETEQ: 0xe7,
  SETNE_RET: 0xe6, SETEQ_RET: 0xe5, POPSP_RET: 0xe4, MAKE_DIFF: 0xe3,
  UNDO_DIFF: 0xe2, GET_NEXT_EV: 0xe1, PROMPT_EV: 0xe0, NOTIFY: 0xdf, INFO: 0xdc,
};

const STACK_TOP = 0x1f400;
const NOUN_SIZE = 14;

export class MachineError extends Error {}

/** Parse an Amiga hunk file: the code section and the symbol table. */
export function parseProg(bytes) {
  let p = 0;
  const L = () => { const v = ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0; p += 4; return v; };
  if (L() !== 0x3f3) throw new MachineError('Not a hunk file');
  while (L() !== 0) { /* resident libraries: none */ }
  const n = L(); L(); L();
  for (let i = 0; i < n; i++) L();
  let code = null, wtable = null;
  const symbols = {};
  for (let s = 0; s < n; s++) {
    const type = L();
    const size = L() * 4;
    if (type === 0x3e9) code = bytes.slice(p, p + size);
    else if (type === 0x3ea) wtable = bytes.slice(p, p + size);
    if (type !== 0x3eb) p += size;
    let t = L();
    if (t === 0x3ec) { for (let k; (k = L()); ) { L(); p += 4 * k; } t = L(); }
    if (t === 0x3f0) {
      for (let k; (k = L()); ) {
        let name = '';
        for (let i = 0; i < 4 * k; i++) { const c = bytes[p + i]; if (c) name += String.fromCharCode(c); }
        p += 4 * k;
        const v = L();
        if (!(name in symbols)) symbols[name] = v;
      }
      t = L();
    }
    if (t !== 0x3f2) throw new MachineError(`Bad hunk structure (section ${s})`);
  }
  return { code, wtable, symbols };
}

/**
 * The machine. `io` supplies:
 *   char(c)          - one output character after the game's formatting
 *   random()         - optional: a number in [0, 1) (defaults to a seeded generator)
 */
export class Machine {
  constructor({ code, wtable, messages, memorySize = 0x20000, wrap = false, stackTop = STACK_TOP }) {
    this.stackTop = stackTop;
    this.image = code;
    this.wtableImage = wtable;
    this.messages = messages;
    this.memorySize = memorySize;
    this.mem = new Uint8Array(memorySize);
    this.cpu = new M68k(this.mem);
    if (wrap) this.cpu.wrap = memorySize - 1;
    this.cpu.lineA = (op) => this.lineA(op);
    this.cpu.lineF = (op) => this.lineF(op);
    this.output = [];
    this.input = [];       // pending input characters
    this.state = 'running';
    this.rng = 1;
    this.textContinuation = 0;
    this.reset();
  }

  reset() {
    this.mem.fill(0);
    this.mem.set(this.image, 0);
    this.wtable = this.wtableImage ? Uint8Array.from(this.wtableImage) : null;
    const c = this.cpu;
    c.d.fill(0); c.a.fill(0); c.ccr = 0;
    c.a[7] = this.stackTop;
    c.pc = 0;
    this.nouns = { data: 0, messageCode: 0, clones: 0, maxNoun: 0, spaceTable: 0, minSpaceEntry: 0 };
    this.fmt = { capital: false, last: 10, pipe: false };
    this.state = 'running';
  }

  // ---- running -------------------------------------------------------------

  /**
   * Run until the game wants a character that hasn't been typed yet ('input'),
   * or it quits ('quit') or restarts ('restart').
   */
  run(limit = 50_000_000) {
    this.state = 'running';
    const start = this.cpu.count;
    while (this.state === 'running') {
      this.cpu.step();
      if (this.cpu.count - start > limit) throw new MachineError('The game ran too long without asking for input.');
    }
    return this.state;
  }

  /** Supply a command line (the game reads it a character at a time). */
  type(line) {
    for (const ch of line) this.input.push(ch.charCodeAt(0) & 0x7f);
    this.input.push(10);
  }

  // ---- state ---------------------------------------------------------------

  snapshot() {
    return { mem: this.mem.slice(0), cpu: this.cpu.snapshot(), nouns: { ...this.nouns }, fmt: { ...this.fmt }, rng: this.rng };
  }

  restore(s) {
    this.mem.set(s.mem);
    this.cpu.restore(s.cpu);
    this.nouns = { ...s.nouns };
    this.fmt = { ...s.fmt };
    this.rng = s.rng;
  }

  // ---- output formatting ---------------------------------------------------

  // The Magnetic Scrolls character conventions: $7F capitalises the next
  // letter, '^' is a line break, '@' is the plural "s", '_' a hard space, '|'
  // swallows the next character; a capital follows a full stop, and repeated
  // spaces and line breaks collapse.
  charout(c, channel = 0, plural = 0) {
    const f = this.fmt;
    c &= 0x7f;
    if (c === 0x7f) { f.capital = true; return; }
    if (c === 0) return;
    if (channel !== 0) return;
    if (c === 0x5e) c = 10; // ^
    if (c === 0x40) { if (plural) return; c = 0x73; } // @ -> s
    if (f.capital) {
      if (c > 0x60 && c < 0x7c) { c -= 0x20; f.capital = false; }
      else if ((c > 0x40 && c < 0x5c) || c === 0x27 || c === 0x22) f.capital = false;
    }
    if (c === 0x7e || c === 0x21 || c === 0x2e || c === 0x3f || c === 10) f.capital = true;
    if (c === 13) c = 10;
    if ((c === 10 || c === 32) && c === f.last) return;
    if (c === 0x7e) { // ~ : paragraph break
      if (f.last !== 10) this.emit(10);
      c = 10;
    }
    if (c === 0x5f) c = 32; // _
    if (f.last === 0x7c) { f.last = c; return; } // '|x' is dropped
    const punct = f.last === 0x2c || f.last === 0x2e || f.last === 0x21 || f.last === 0x3f;
    if (punct && ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a))) this.emit(32);
    f.last = c;
    if (c === 0x7c) return;
    this.emit(c);
  }

  emit(c) {
    if (c === 8) { this.output.pop(); this.fmt.last = 8; return; } // backspace
    this.output.push(String.fromCharCode(c));
    this.fmt.last = c;
  }

  takeOutput() {
    const s = this.output.join('');
    this.output = [];
    return s;
  }

  // ---- random numbers (a 31-bit LCG; deterministic when seeded) -----------

  seed(n) { this.rng = (n >>> 0) || 1; }
  random16() {
    this.rng = (Math.imul(this.rng, 1103515245) + 12345) >>> 0;
    return (this.rng >>> 8) & 0xffff;
  }

  // ---- host calls ----------------------------------------------------------

  lineF(op) {
    const c = this.cpu, n = this.nouns;
    if (n.minSpaceEntry && (op & 0x7ff) > n.minSpaceEntry) {
      if (!(op & 0x800)) c.push32(c.pc);
      const entry = n.spaceTable + 2 * (0x7ff - (op & 0x7ff));
      c.pc = (entry + sx16(c.r16(entry))) >>> 0;
      return;
    }
    if (op === 0xf000 && !n.messageCode) { // COUT before the noun table is set up
      this.charout(c.d[1] & 0xff);
      return;
    }
    c.push32(c.pc);
    c.pc = n.messageCode;
  }

  lineA(op) {
    const c = this.cpu, d = c.d, a = c.a, n = this.nouns;
    const code = op & 0xff;
    if (code < A.INFO) return this.charin(op);
    switch (code) {
      case A.INFO: {
        const what = c.pop16();
        if (what === 3) c.pop32();
        return;
      }
      case A.TEXT: {
        const msg = d[0] & 0xffff;
        const plural = d[2] & 0xff, channel = d[3] & 0xff;
        let text = this.messages[msg] ?? '';
        let i = c.c ? this.textContinuation : 0;
        for (; i < text.length; i++) {
          const ch = text.charCodeAt(i);
          // " @" ends the first part of a two-part message; the game prints
          // something (a noun) and calls TEXT again with the carry set.
          if (ch === 32 && text.charCodeAt(i + 1) === 0x40) {
            this.textContinuation = i + 2;
            c.c = 1;
            return;
          }
          this.charout(ch, channel, plural);
        }
        c.c = 0;
        return;
      }
      case A.CHAROUT: this.charout(d[1] & 0xff, d[3] & 0xff, d[2] & 0xff); return;
      case A.SETNOUNS:
        n.messageCode = a[3];
        n.data = a[0];
        n.clones = a[6];
        n.maxNoun = d[6];
        n.spaceTable = a[5];
        n.minSpaceEntry = d[7];
        return;
      case A.GETDATA: {
        let noun = d[0] & 0x3fff;
        if (n.maxNoun && noun > n.maxNoun) noun = c.r16(n.clones + 2 * (noun - n.maxNoun - 1));
        a[0] = (NOUN_SIZE * noun + n.data) >>> 0;
        return;
      }
      case A.GETNOUNS: {
        let d3 = d[3] & 0xffff;
        const d4 = d[4] & 0xffff;
        let p = a[0];
        c.c = 0;
        const wordwise = (d[5] & 0xff) !== 0;
        const want = wordwise ? d[2] & 0xffff : d[2] & 0xff;
        do {
          d3++;
          const v = wordwise ? c.r16(p) & 0x3fff : c.r8(p);
          if (v === want) { c.c = 1; break; }
          p += NOUN_SIZE;
        } while (d4 > d3);
        a[0] = (p + NOUN_SIZE) >>> 0;
        d[3] = ((d[3] & 0xffff0000) | (d3 & 0xffff)) >>> 0;
        return;
      }
      case A.QCARRIED: return this.qcarried();
      case A.GETTIED: {
        c.c = 0;
        let noun = d[2] & 0x7fff;
        const d4 = d[4] & 0x7fff;
        let p = n.data + 12 + NOUN_SIZE * noun;
        while (noun !== 0) {
          if ((c.r8(p) & 0x3f) || c.r8(p + 1) || noun === d4) { c.c = 1; break; }
          noun--; p -= NOUN_SIZE;
        }
        if (noun === 0) noun = 1;
        d[2] = ((d[2] & 0xffff0000) | noun) >>> 0;
        return;
      }
      case A.WORDSCAN: {
        let count = d[2] & 0x3fff;
        let p = a[1];
        const rd = this.wtable ? (x) => this.wtable[x] : (x) => c.r8(x);
        do { if (rd(p++) & 0x80) count--; } while (count > 0);
        d[2] &= 0xffff0000;
        a[1] = p >>> 0;
        return;
      }
      case A.NOUNSCAN: {
        let count = d[0] & 0x3fff;
        let p0 = a[0], p1 = a[1];
        const rd = this.wtable ? (x) => this.wtable[x] : (x) => c.r8(x);
        do {
          if (rd(p0++) & 0x80) {
            count--;
            while (c.r8(p1++) !== 0) { /* end of the adjective list */ }
          }
        } while (count > 0);
        d[0] &= 0xffff0000;
        a[0] = p0 >>> 0; a[1] = p1 >>> 0;
        return;
      }
      case A.FINDZERO: {
        let count = d[0] & 0xffff;
        let p = a[1];
        while (count-- !== 0) while (c.r8(p++) !== 0) { /* next zero */ }
        d[0] = (d[0] | 0xffff) >>> 0;
        a[1] = p >>> 0;
        return;
      }
      case A.SEARCH: return this.search();
      case A.RANDOM1: d[0] = ((d[0] & 0xffffff00) | (this.random16() & 0xff)) >>> 0; return;
      case A.RANDOM2: {
        const param = d[1] & 0xff;
        d[1] = ((param * this.random16()) >>> 16) & 0xff;
        return;
      }
      case A.SAVEFILE: d[7] = 0; this.saveRequest = { addr: a[1], length: d[1] & 0xffff }; this.state = 'save'; return;
      case A.LOADFILE: d[7] = 0; this.loadRequest = { addr: a[1], length: d[1] & 0xffff }; this.state = 'load'; return;
      case A.GRAPHICS:
        // LOAD_PIC: d0 = picture (0-based), d1 = 1 to show or 0 to hide, d2 = version.
        this.picture = { n: d[0] & 0xffff, show: (d[1] & 0xff) !== 0, version: d[2] & 0xff };
        this.pictureCount = (this.pictureCount || 0) + 1;
        return;
      case A.PRINTER: case A.NOTIFY: case A.PROMPT_EV: case A.MAKE_DIFF: return;
      case A.UNDO_DIFF: return;
      case A.RESTART: this.state = 'restart'; return;
      case A.QUIT: this.state = 'quit'; return;
      case A.GETWTAB: d[1] = ((d[1] & 0xffffff00) | this.wtable[a[1]]) >>> 0; return;
      case A.PUTWTAB: this.wtable[a[1]] = d[1] & 0xff; return;
      case A.PRINTWORD: {
        let p = a[1], i = 0;
        do { this.charout(this.wtable[p], d[1] & 0xff, 0); i++; } while (!(this.wtable[p++] & 0x80));
        a[1] = (a[1] + i) >>> 0;
        return;
      }
      case A.COPYWORD: {
        let s = a[1], t = a[0], i = 0;
        do { c.w8(t++, this.wtable[s]); i++; } while (!(this.wtable[s++] & 0x80));
        a[0] = (a[0] + i) >>> 0; a[1] = (a[1] + i) >>> 0;
        return;
      }
      case A.SETNE: c.z = 0; return;
      case A.SETEQ: c.z = 1; return;
      case A.SETNE_RET: c.z = 0; c.pc = c.pop32(); return;
      case A.SETEQ_RET: c.z = 1; c.pc = c.pop32(); return;
      case A.POPSP_RET: a[7] = (a[7] + 4) >>> 0; c.pc = c.pop32(); return;
      case A.GET_NEXT_EV: return this.getLineEvent(op);
    }
    throw new CpuError(`Unknown host call $${op.toString(16)} at $${c.opPc.toString(16)}`);
  }

  charin() {
    const c = this.cpu;
    if (!this.input.length) {
      c.pc = c.opPc; // ask again once there is input
      this.state = 'input';
      return;
    }
    const ch = this.input.shift();
    c.d[1] = ch;
    if (ch === 10) this.fmt.last = 10;
  }

  getLineEvent() {
    const c = this.cpu;
    const nl = this.input.indexOf(10);
    if (nl < 0) { c.pc = c.opPc; this.state = 'input'; return; }
    const chars = this.input.splice(0, nl + 1);
    chars.pop();
    // The line goes downwards from the end of memory (A1 counts up from there).
    let p = this.memorySize - c.a[1];
    for (const ch of chars) this.mem[p--] = ch;
    this.mem[p] = 0;
    c.a[1] = (c.a[1] + chars.length + 1) >>> 0;
    c.d[1] = 0;
    this.fmt.last = 10;
  }

  qcarried() {
    const c = this.cpu, d = c.d;
    let noun = d[0] & 0x7fff;
    let i;
    for (i = noun; i > 0; i--) {
      let z = 1;
      let done = false;
      noun = i;
      do {
        const p = this.nouns.data + noun * NOUN_SIZE;
        const b6 = c.r8(p + 6);
        if (b6 & 0x80) { z = 0; done = true; }            // out of play
        else if (c.r8(p + 5) & 1) { z = 0; done = true; } // pseudo noun
        else {
          const loc = c.r16(p + 8);
          if (loc === noun) { z = 0; break; }
          if (b6 === 0) { if (loc !== 0) z = 0; done = true; }   // simply in a room
          else if (b6 & 0xcc) { if (noun !== 0) z = 0; done = true; }
          else noun = loc;                                  // one level up
        }
      } while (!done);
      c.z = z;
      if (z) break;
    }
    if (i === 0) i = 1;
    d[0] = ((d[0] & 0xffff0000) | i) >>> 0;
  }

  // The dictionary search: matches the word at A6 against the word table at
  // A3 (sections separated by $82, ending in $81), filtering nouns by the
  // adjectives typed before them.
  search() {
    const c = this.cpu, d = c.d, a = c.a;
    const W = this.wtable;
    const rdw = W ? (x) => W[x] : (x) => c.r8(x);
    const syn = a[5];
    const synWord = W ? (i) => (W[syn + 2 * i] << 8) | W[syn + 2 * i + 1] : (i) => c.r16(syn + 2 * i);
    let A3 = a[3];
    a[5] = a[6];
    let A6 = a[6];
    const A5 = A6;
    const adjTable = a[0], adjBuffer = a[1];
    let matchbuf = a[2];
    const start = matchbuf;
    let type0 = 0, type1 = 0, adjflag = 0;
    let word = 0, section = d[6] & 0xffff, count = 0, islong = 0, longest = 0, oneLong = false;
    do {
      let c1 = rdw(A3++);
      if (c1 === 0x81) break;
      if (c1 === 0x82) { word = 0; section++; count = 0; A6 = A5; islong = 0; continue; }
      let c2 = c.r8(A6++) & 0x5f;
      if (c2 === 0 && c1 === 0x5f) { c2 = 0x5f; islong = 0x8000; }
      if (c2 === 0) c2 = 0xff;
      const t = c.r8(A6);
      if (((c1 > 0x80 && (c1 & 0x5f) === c2) || count > 99) && (t === 0 || t === 0x20 || t === 0x27)) {
        if (t === 0x27) { type0 = 2; type1 = c.r8(A6 + 1); }
        c.w16(matchbuf, section + islong); c.w16(matchbuf + 2, word); matchbuf += 4;
        count = 0;
        if (A6 - A5 > longest) longest = A6 - A5;
        A6 = A5; islong = 0; word++;
        while (c1 < 0x80) c1 = rdw(A3++);
      } else if (c1 > 0x80) { word++; count = 0; A6 = A5; islong = 0; }
      else if ((c1 & 0x5f) === c2) count++;
      else {
        count = 0; A6 = A5; islong = 0;
        while (!(rdw(A3++) & 0x80)) { /* skip the rest of the word */ }
        word++;
      }
    } while (rdw(A3) !== 0x81);

    // Resolve synonyms and check the adjectives of nouns (section 6).
    let read = start, out = start;
    while (read !== matchbuf) {
      adjflag = 0;
      let sec = c.r16(read); let w = c.r16(read + 2); read += 4;
      const long = sec & 0x8000; sec &= 0x7fff;
      if (sec === 11) { const s = synWord(w); sec = s & 0x1f; w = (s >> 5) & 0x7ff; }
      let keep = true;
      if (sec === 6 && c.r16(adjBuffer) !== 0) {
        let list = adjTable;
        for (let k = 0; k < w; k++) while (c.r8(list++) !== 0) { /* next noun's adjectives */ }
        let ab = adjBuffer, given;
        while ((given = c.r16(ab)) !== 0) {
          ab += 2;
          let p = list;
          for (;;) {
            const adj = c.r8(p++);
            if (adj === 0) { adjflag = 1; break; }
            if (adj - 3 === given) break;
          }
        }
        if (adjflag) keep = false;
      }
      if (keep) {
        c.w16(out, sec + long); c.w16(out + 2, w); out += 4;
        if (long) oneLong = true;
      }
    }
    // Words with '_' (several-word names) beat their single-word parts.
    if (oneLong) {
      let r = start, o = start;
      while (r !== out) {
        const sec = c.r16(r), w = c.r16(r + 2); r += 4;
        if (sec & 0x8000) { c.w16(o, sec & 0x7fff); c.w16(o + 2, w); o += 4; }
      }
      out = o;
      A6 = A5 + longest;
    } else A6 = A5 + 1;
    a[6] = A6 >>> 0;
    a[2] = out >>> 0;
    d[0] = ((d[0] & 0xffff0000) | (type0 << 8) | type1) >>> 0;
    d[1] = ((d[1] & 0xffff0000) | adjflag) >>> 0;
  }
}

function sx16(v) { v &= 0xffff; return v & 0x8000 ? v - 0x10000 : v; }
