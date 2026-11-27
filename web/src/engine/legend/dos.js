// Just enough of a PC, its BIOS and MS-DOS to run Legend Entertainment's
// games: an EXE loader, memory blocks, files (read-only game files plus files
// the game writes, kept in memory), the keyboard, the timer, and a video BIOS
// whose screen is not shown (the app shows the game's text, not its screen).

import { Vga } from './vga.js';
import { Cpu, CpuError, AX, CX, DX, BX, SP, BP, SI, DI, ES, CS, SS, DS, STUB_SEG, FLAGS } from './cpu86.js';

const MEM_SIZE = 0x110000;
const MEM_TOP = 0x9fff;          // last paragraph of conventional memory (640 KB)
const FIRST_MCB = 0x0070;
const COLS = 80, ROWS = 60;
const TICK_INSTRUCTIONS = 4000;  // instructions per 18.2 Hz timer tick (time runs fast: delays pass quickly)
// A reprogrammed (faster) timer still interrupts no more often than this: the
// game times the CPU with it at start-up and turns off its sound driver (then
// crashes calling it) on a machine that seems too slow.
const MIN_IRQ_INSTRUCTIONS = 3000;
const KEY_GAP = 3000;          // instructions between a key's make and break codes
const KEY_IDLE = 3_000_000;    // instructions without keys before a program with its own keyboard handler counts as waiting

export class DosError extends Error {}

export class Dos {
  /**
   * files: { NAME: Uint8Array } (upper-case DOS names, read-only)
   */
  constructor(files) {
    this.mem = new Uint8Array(MEM_SIZE);
    this.cpu = new Cpu(this.mem);
    this.cpu.service = (v) => this.service(v);
    this.cpu.portIn = (p, w) => this.portIn(p, w);
    this.cpu.portOut = (p, v, w) => this.portOut(p, v, w);
    this.vga = new Vga();
    this.cpu.vga = this.vga;
    this.files = new Map(Object.entries(files).map(([k, v]) => [k.toUpperCase(), v]));
    this.written = new Map();       // files the game created: NAME -> { data: number[] }
    this.handles = [];              // index = handle
    this.keys = new KeyBuffer(this.mem); // the BIOS key buffer (scan << 8 | ascii)
    this.typed = [];                // keys typed but not yet pressed (see pumpKeys)
    this.state = 'running';
    this.waiting = null;            // why the CPU stopped: 'key'
    this.onWrite = null;            // (name, bytes) for writes to created files
    this.onOpen = null;             // (name)
    this.onRead = null;             // (name, position, length)
    this.trace = null;
    this.ticks = 0;
    this.nextTick = TICK_INSTRUCTIONS;
    this.keyPolls = 0;
    this.dta = 0;
    this.exitCode = null;
    this.reset();
  }

  reset() {
    const m = this.mem;
    m.fill(0);
    // Interrupt vectors point to the service stubs at F000:4n.
    for (let n = 0; n < 256; n++) {
      m[n * 4] = (n * 4) & 0xff; m[n * 4 + 1] = (n * 4) >> 8;
      m[n * 4 + 2] = STUB_SEG & 0xff; m[n * 4 + 3] = STUB_SEG >> 8;
      m[(STUB_SEG << 4) + n * 4] = 0xcf; // IRET, never executed
    }
    // BIOS data area.
    this.w16(0x410, 0x0021 | (2 << 4));  // equipment: 80x25 colour, no FPU
    this.w16(0x413, 640);
    m[0x449] = 3; this.w16(0x44a, 80); m[0x484] = 24;
    this.w16(0x463, 0x3d4);
    this.w16(0x41a, 0x1e); this.w16(0x41c, 0x1e); this.w16(0x480, 0x1e); this.w16(0x482, 0x3e);
    // BIOS identification bytes.
    m[0xffffe] = 0xfc; // AT
    // One free memory block from FIRST_MCB to the top of conventional memory.
    this.writeMcb(FIRST_MCB, 0x5a, 0, MEM_TOP - FIRST_MCB);
    this.grid = new Uint8Array(COLS * ROWS).fill(32);
    this.cursor = 0;
    this.handles = [{ dev: 'con' }, { dev: 'con' }, { dev: 'con' }, { dev: 'nul' }, { dev: 'nul' }];
  }

  r16(a) { return this.mem[a] | (this.mem[a + 1] << 8); }
  w16(a, v) { this.mem[a] = v & 0xff; this.mem[a + 1] = (v >> 8) & 0xff; }

  // ---- memory blocks (real MCB chain) --------------------------------------
  writeMcb(seg, type, owner, size) {
    const a = seg << 4;
    this.mem[a] = type; this.w16(a + 1, owner); this.w16(a + 3, size);
  }
  mcbs() {
    const list = [];
    let seg = FIRST_MCB;
    for (let i = 0; i < 1000; i++) {
      const a = seg << 4;
      const type = this.mem[a], owner = this.r16(a + 1), size = this.r16(a + 3);
      if (type !== 0x4d && type !== 0x5a) throw new DosError(`Memory chain broken at ${seg.toString(16)}`);
      list.push({ seg, type, owner, size });
      if (type === 0x5a) break;
      seg += size + 1;
    }
    return list;
  }
  merge() {
    const list = this.mcbs();
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i], b = list[i + 1];
      if (a.owner === 0 && b.owner === 0) {
        a.size += b.size + 1; a.type = b.type;
        this.writeMcb(a.seg, a.type, 0, a.size);
        list.splice(i + 1, 1); i--;
      }
    }
  }
  alloc(paras, owner) {
    this.merge();
    let best = 0;
    for (const b of this.mcbs()) {
      if (b.owner !== 0) continue;
      if (b.size >= paras) {
        if (b.size > paras) {
          this.writeMcb(b.seg + paras + 1, b.type, 0, b.size - paras - 1);
          this.writeMcb(b.seg, 0x4d, owner, paras);
        } else this.writeMcb(b.seg, b.type, owner, paras);
        return { seg: b.seg + 1 };
      }
      best = Math.max(best, b.size);
    }
    return { error: 8, largest: best };
  }
  free(seg) {
    const a = (seg - 1) << 4;
    if (this.mem[a] !== 0x4d && this.mem[a] !== 0x5a) return 9;
    this.w16(a + 1, 0);
    this.merge();
    return 0;
  }
  resize(seg, paras) {
    const mcb = seg - 1, a = mcb << 4;
    const type = this.mem[a], owner = this.r16(a + 1), size = this.r16(a + 3);
    if (type !== 0x4d && type !== 0x5a) return { error: 9 };
    if (paras <= size) {
      if (paras < size) {
        this.writeMcb(mcb + paras + 1, type, 0, size - paras - 1);
        this.writeMcb(mcb, 0x4d, owner, paras);
        this.merge();
      }
      return {};
    }
    this.merge();
    // Grow into a free block that follows.
    const next = mcb + size + 1;
    let avail = size;
    if (type === 0x4d && this.mem[next << 4] !== undefined && this.r16((next << 4) + 1) === 0) {
      avail = size + 1 + this.r16((next << 4) + 3);
      if (avail >= paras) {
        const ntype = this.mem[next << 4];
        if (avail > paras) {
          this.writeMcb(mcb + paras + 1, ntype, 0, avail - paras - 1);
          this.writeMcb(mcb, 0x4d, owner, paras);
        } else this.writeMcb(mcb, ntype, owner, paras);
        return {};
      }
    }
    return { error: 8, largest: avail };
  }

  // ---- loading ---------------------------------------------------------------
  /** Load an EXE as DOS would and point the CPU at it. */
  load(name, args = '') {
    const img = this.file(name);
    if (!img) throw new DosError(`Missing ${name}`);
    const env = this.alloc(4, 8).seg;
    const envText = 'PATH=C:\\\0COMSPEC=C:\\COMMAND.COM\0\0\x01\0C:\\' + name.toUpperCase() + '\0';
    for (let i = 0; i < envText.length; i++) this.mem[(env << 4) + i] = envText.charCodeAt(i);
    const largest = this.alloc(0xffff, 0).largest;
    const psp = this.alloc(largest, 0).seg;
    this.w16(((psp - 1) << 4) + 1, psp);
    this.w16(((env - 1) << 4) + 1, psp);
    const p = psp << 4;
    this.mem[p] = 0xcd; this.mem[p + 1] = 0x20;
    this.w16(p + 2, psp + largest);
    this.w16(p + 0x2c, env);
    this.w16(p + 0x16, psp); // parent: itself
    for (let i = 0; i < 20; i++) this.mem[p + 0x18 + i] = i < 5 ? i : 0xff;
    this.w16(p + 0x32, 20); this.w16(p + 0x34, 0x18); this.w16(p + 0x36, psp);
    this.mem[p + 0x50] = 0xcd; this.mem[p + 0x51] = 0x21; this.mem[p + 0x52] = 0xcb;
    const tail = args ? ' ' + args : '';
    this.mem[p + 0x80] = tail.length;
    for (let i = 0; i < tail.length; i++) this.mem[p + 0x81 + i] = tail.charCodeAt(i);
    this.mem[p + 0x81 + tail.length] = 13;
    this.psp = psp;
    this.dta = (psp << 16) | 0x80;
    const cpu = this.cpu;
    if (img[0] === 0x4d && img[1] === 0x5a) {
      const h = (o) => img[o] | (img[o + 1] << 8);
      const lastPage = h(2), pages = h(4), nreloc = h(6), hdr = h(8) * 16;
      let size = pages * 512 - (lastPage ? 512 - lastPage : 0);
      size = Math.min(size, img.length) - hdr;
      const base = psp + 0x10;
      this.mem.set(img.subarray(hdr, hdr + size), base << 4);
      const rel = h(0x18);
      for (let i = 0; i < nreloc; i++) {
        const off = h(rel + i * 4), seg = h(rel + i * 4 + 2);
        const a = ((base + seg) << 4) + off;
        this.w16(a, (this.r16(a) + base) & 0xffff);
      }
      cpu.s[SS] = (h(0xe) + base) & 0xffff; cpu.r[SP] = h(0x10);
      cpu.s[CS] = (h(0x16) + base) & 0xffff; cpu.ip = h(0x14);
      this.imageEnd = base + Math.ceil(size / 16);
    } else {
      this.mem.set(img, p + 0x100);
      cpu.s[CS] = cpu.s[SS] = psp; cpu.r[SP] = 0xfffe; cpu.ip = 0x100;
      this.w16(p + 0xfffe, 0);
    }
    cpu.s[DS] = cpu.s[ES] = psp;
    cpu.r[AX] = 0; cpu.r[BX] = 0; cpu.r[CX] = 0xff; cpu.r[DX] = psp;
    cpu.flags = 0x0202;
  }

  /** Copy an EXE's image to seg and add reloc to its relocated words. */
  loadImage(img, seg, reloc) {
    const h = (o) => img[o] | (img[o + 1] << 8);
    if (!(img[0] === 0x4d && img[1] === 0x5a)) { this.mem.set(img, seg << 4); return; }
    const lastPage = h(2), pages = h(4), nreloc = h(6), hdr = h(8) * 16;
    let size = pages * 512 - (lastPage ? 512 - lastPage : 0);
    size = Math.min(size, img.length) - hdr;
    this.mem.set(img.subarray(hdr, hdr + size), seg << 4);
    const rel = h(0x18);
    for (let i = 0; i < nreloc; i++) {
      const off = h(rel + i * 4), sg = h(rel + i * 4 + 2);
      const a = ((seg + sg) << 4) + off;
      this.w16(a, (this.r16(a) + reloc) & 0xffff);
    }
  }

  file(name) {
    const n = this.baseName(name);
    if (this.written.has(n)) return Uint8Array.from(this.written.get(n).data);
    return this.files.get(n) ?? null;
  }
  baseName(name) {
    return name.replace(/^.*[\\/:]/, '').toUpperCase();
  }

  // ---- running ---------------------------------------------------------------
  /** Run until the game waits for a key it hasn't got ('key') or exits ('exit'). */
  run(limit = 200_000_000) {
    const cpu = this.cpu;
    const start = cpu.count;
    this.state = 'running';
    this.kbLast = cpu.count;
    while (this.state === 'running') {
      this.pumpKeys();
      if (this.state !== 'running') break;
      const slice = Math.max(1, Math.min(this.nextTick - cpu.count, 20000));
      try {
        cpu.run(slice);
      } catch (e) {
        if (e instanceof CpuError) throw new DosError(e.message);
        throw e;
      }
      if (cpu.halted) {
        cpu.halted = false;
        // HLT waits for an interrupt: skip ahead to the next tick.
        cpu.count = Math.max(cpu.count, this.nextTick);
      }
      if (cpu.count >= this.nextTick) this.tick();
      if (cpu.count - start > limit) throw new DosError('The game ran too long without waiting for input.');
    }
    return this.state;
  }

  tick() {
    // The timer interrupt comes at the rate the program set (PIT channel 0).
    const div = this.pitDivisor || 0x10000;
    this.nextTick = this.cpu.count + Math.max(MIN_IRQ_INSTRUCTIONS, Math.round(TICK_INSTRUCTIONS * div / 0x10000));
    if (!this.cpu.pendingIrq.includes(8)) this.cpu.pendingIrq.push(8);
  }

  /**
   * Typed keys reach the program as the hardware gives them: a make code,
   * then a break code, each through IRQ 1 (INT 9). The BIOS's handler puts
   * the key in its buffer on the make code; a program with its own handler
   * may pass it on or not. A program with its own handler waits for keys by
   * watching its own variables, so after a while with nothing to deliver it
   * counts as waiting.
   */
  pumpKeys() {
    const cpu = this.cpu;
    if (this.kbPhase) {
      if (cpu.count < this.kbNext || cpu.pendingIrq.includes(9)) return;
      if (this.kbPhase === 'make') {
        this.lastScan = this.kbScan | 0x80;
        cpu.pendingIrq.push(9);
        this.kbPhase = 'break';
        this.kbNext = cpu.count + KEY_GAP;
        return;
      }
      this.kbPhase = null;
      this.kbLast = cpu.count;
    }
    if (this.typed.length) {
      if (this.keys.full) return;
      const k = this.typed.shift();
      this.kbKey = k;
      this.kbScan = (k >> 8) || SCAN[String.fromCharCode(k & 0xff).toLowerCase()] || 0;
      this.lastScan = this.kbScan;
      cpu.pendingIrq.push(9);
      this.kbPhase = 'make';
      this.kbNext = cpu.count + KEY_GAP;
      return;
    }
    if (this.r16(9 * 4 + 2) !== STUB_SEG && cpu.count - this.kbLast > KEY_IDLE) { this.state = 'key'; this.kbLast = cpu.count; }
  }

  /** Queue a key: a character, or a BIOS code (scan << 8 | ascii). */
  key(k) {
    if (typeof k === 'string') {
      for (const ch of k) this.typed.push(SCAN[ch.toLowerCase()] !== undefined ? (SCAN[ch.toLowerCase()] << 8) | ch.charCodeAt(0) : ch.charCodeAt(0));
    } else this.typed.push(k);
  }

  // ---- I/O ports ----------------------------------------------------------------
  portIn(p, w) {
    if (w) return this.portIn(p, 0) | (this.portIn(p + 1, 0) << 8);
    const v = this.vga.portIn(p);
    if (v !== null) return v;
    switch (p) {
      case 0x3da: case 0x3ba: this.vga.attrFlip = false; this.retrace = (this.retrace + 1) & 3; return this.retrace & 2 ? 0x09 : 0x00;
      case 0x40: { const c = (TICK_INSTRUCTIONS - (this.nextTick - this.cpu.count)) * 65536 / TICK_INSTRUCTIONS; this.pitLatch = (65535 - c) & 0xffff; const v = this.pitLow ? this.pitLatch >> 8 : this.pitLatch & 0xff; this.pitLow = !this.pitLow; return v; }
      case 0x60: return this.lastScan ?? 0;
      case 0x61: return this.port61 ?? 0;
      case 0x21: return this.picMask ?? 0;
      case 0x201: return 0xf0;
    }
    return w ? 0xffff : 0xff;
  }
  portOut(p, v, w) {
    if (w) { this.portOut(p, v & 0xff, 0); this.portOut(p + 1, (v >> 8) & 0xff, 0); return; }
    if (this.vga.portOut(p, v)) return;
    switch (p) {
      case 0x61: this.port61 = v; break;
      case 0x21: this.picMask = v; break;
      case 0x43: this.pitLow = false; if ((v & 0xc0) === 0) { this.pitWrite = 0; this.pitNew = 0; } break;
      case 0x40:
        // Channel 0's reload value, low byte then high byte.
        if (this.pitWrite === 0) { this.pitNew = v; this.pitWrite = 1; } else { this.pitDivisor = this.pitNew | (v << 8); this.pitWrite = 0; }
        break;
    }
  }

  // ---- services --------------------------------------------------------------------
  setCarry(on) {
    // The flags the caller gets back are on the stack (IRET pops them).
    const c = this.cpu, a = ((c.s[SS] << 4) + ((c.r[SP] + 4) & 0xffff)) & 0xfffff;
    if (on) this.mem[a] |= 1; else this.mem[a] &= ~1;
  }
  setZero(on) {
    const c = this.cpu, a = ((c.s[SS] << 4) + ((c.r[SP] + 4) & 0xffff)) & 0xfffff;
    if (on) this.mem[a] |= 0x40; else this.mem[a] &= ~0x40;
  }
  fail(code) { this.cpu.r[AX] = code; this.setCarry(true); }

  service(v) {
    const c = this.cpu;
    if (this.trace) this.trace(v);
    switch (v) {
      case 0x08: {
        // Timer: count the tick, then run the program's INT 1C handler (if it
        // has one) on the way back.
        let t = (this.r16(0x46c) | (this.r16(0x46e) << 16)) + 1;
        if (t >= 0x1800b0) { t = 0; this.mem[0x470] = 1; }
        this.w16(0x46c, t & 0xffff); this.w16(0x46e, t >>> 16);
        this.ticks++;
        if (this.r16(0x1c * 4 + 2) !== STUB_SEG) {
          c.ip = this.r16(0x1c * 4); c.s[CS] = this.r16(0x1c * 4 + 2);
          c.skipIret = true;
        }
        return;
      }
      case 0x09: if (this.lastScan < 0x80 && this.kbKey != null) { this.keys.push(this.kbKey); this.kbKey = null; } return; // the BIOS's keyboard handler
      case 0x10: return this.video();
      case 0x11: c.r[AX] = this.r16(0x410); return;
      case 0x12: c.r[AX] = 640; return;
      case 0x15: c.setr8(4, 0x86); this.setCarry(true); return;
      case 0x16: return this.keyboard();
      case 0x17: c.setr8(4, 0); return;
      case 0x1a: return this.clock();
      case 0x1b: case 0x1c: case 0x23: case 0x24: return;
      case 0x20: this.exit(0); return;
      case 0x21: return this.dos();
      case 0x28: return;
      case 0x2f: if ((c.r[AX] >> 8) === 0x16 || (c.r[AX] >> 8) === 0x43) c.r[AX] &= 0xff00; return;
      case 0x33: c.r[AX] = 0; return; // no mouse
      case 0x67: c.r[AX] = 0x8400; return;
    }
    if (v >= 0x70 || (v >= 0x0a && v <= 0x0f)) return; // other IRQs
    if (v === 0x00) throw new DosError(`Divide error at ${c.rw(c.s[SS], c.r[SP] + 2).toString(16)}:${c.rw(c.s[SS], c.r[SP]).toString(16)}`);
    if (v === 0x05 || v === 0x06 || v === 0x07 || v === 0x04 || v === 0x03 || v === 0x01 || v === 0x02) return;
    throw new DosError(`Unsupported interrupt ${v.toString(16)} (AX=${c.r[AX].toString(16)})`);
  }

  exit(code) {
    this.exitCode = code;
    this.state = 'exit';
    this.cpu.stop = true;
    this.cpu.retry = true;
  }

  waitKey() {
    // (Typed keys still on their way: run on and try again.)
    if (this.typed.length || this.kbPhase) { this.cpu.stop = true; this.cpu.retry = true; this.cpu.waitingInService = true; return; }
    this.state = 'key';
    this.cpu.stop = true;
    this.cpu.retry = true;
  }

  keyboard() {
    const c = this.cpu, ah = c.r[AX] >> 8;
    switch (ah) {
      case 0x00: case 0x10:
        if (!this.keys.length) return this.waitKey();
        c.r[AX] = this.keys.shift(); this.keyPolls = 0; return;
      case 0x01: case 0x11:
        if (this.keys.length) { c.r[AX] = this.keys.peek(); this.setZero(false); this.keyPolls = 0; return; }
        this.setZero(true);
        // A program that only polls is waiting too.
        if (++this.keyPolls > 200) { this.keyPolls = 0; return this.waitKey(); }
        return;
      case 0x02: case 0x12: c.setr8(0, 0); return;
      case 0x03: case 0x05: return;
    }
  }

  clock() {
    const c = this.cpu, ah = c.r[AX] >> 8;
    if (ah === 0x00) {
      c.r[CX] = this.r16(0x46e); c.r[DX] = this.r16(0x46c); c.setr8(0, this.mem[0x470]); this.mem[0x470] = 0;
      // A program that waits by reading the clock gets there sooner.
      this.clockReads = (this.clockReads ?? 0) + 1;
      if (this.clockReads > 50) { this.clockReads = 0; c.count = Math.max(c.count, this.nextTick); }
      return;
    }
    if (ah === 0x02) { c.r[CX] = 0x1200; c.r[DX] = 0; this.setCarry(false); return; }
    if (ah === 0x04) { c.r[CX] = 0x1992; c.r[DX] = 0x0626; this.setCarry(false); return; }
    this.setCarry(true);
  }

  video() {
    const c = this.cpu, ah = c.r[AX] >> 8, al = c.r[AX] & 0xff;
    switch (ah) {
      case 0x00: this.mem[0x449] = al & 0x7f; this.videoMode = al & 0x7f; this.grid.fill(32); this.vga.reset(); this.vga.mode = al & 0x7f; this.onMode?.(al & 0x7f); return;
      case 0x10: this.vga.bios(al, c.r[BX], c.r[CX], c.r[DX], c.s[ES], this.mem); return;
      case 0x0c: case 0x0d: {
        // A pixel (16-colour planar modes).
        const x = c.r[CX], y = c.r[DX], a = y * 80 + (x >> 3), bit = 0x80 >> (x & 7), planes = this.vga.planes;
        if (ah === 0x0d) { let v = 0; for (let i = 0; i < 4; i++) if (planes[i][a] & bit) v |= 1 << i; c.setr8(0, v); return; }
        for (let i = 0; i < 4; i++) {
          const on = (al >> i) & 1;
          if (al & 0x80) { if (on) planes[i][a] ^= bit; } else if (on) planes[i][a] |= bit; else planes[i][a] &= ~bit;
        }
        this.vga.dirty = true;
        return;
      }
      case 0x0f: c.r[AX] = (80 << 8) | this.mem[0x449]; c.setr8(7, 0); return;
      case 0x02: this.cursor = c.r[DX]; return;
      case 0x01: case 0x05: case 0x0b: return;
      case 0x06: case 0x07: {
        // Scroll a window of the text grid.
        const top = c.r[CX] >> 8, left = c.r[CX] & 0xff, bottom = c.r[DX] >> 8, right = c.r[DX] & 0xff;
        const n = al, g = this.grid;
        for (let y = top; y <= bottom && y < ROWS; y++) {
          const src = ah === 0x06 ? y + n : y - n;
          for (let x = left; x <= right && x < COLS; x++) g[y * COLS + x] = !n || src < top || src > bottom ? 32 : g[src * COLS + x];
        }
        if (ah === 0x07 && n) for (let y = bottom; y >= top; y--) { const src = y - n; for (let x = left; x <= right && x < COLS; x++) g[y * COLS + x] = src < top ? 32 : g[src * COLS + x]; }
        this.onScroll?.(top, bottom, n);
        return;
      }
      case 0x03: c.r[CX] = 0x0607; c.r[DX] = this.cursor; return;
      case 0x08: c.r[AX] = 0x0700 | this.grid[(this.cursor >> 8) * COLS + (this.cursor & 0xff)]; return;
      case 0x09: case 0x0a: {
        const y = this.cursor >> 8, x = this.cursor & 0xff;
        for (let i = 0; i < c.r[CX] && x + i < COLS; i++) if (y < ROWS) this.grid[y * COLS + x + i] = al;
        this.onChar?.(al, x, y, c.r[CX], c.r[BX] & 0xff);
        return;
      }
      case 0x0e: {
        let y = this.cursor >> 8, x = this.cursor & 0xff;
        if (al === 13) x = 0; else if (al === 10) y++; else if (al === 8) x = Math.max(0, x - 1);
        else { if (y < ROWS && x < COLS) this.grid[y * COLS + x] = al; x++; }
        this.cursor = (y << 8) | x;
        this.onChar?.(al, x, y, 1, -1);
        return;
      }
      case 0x0d: c.setr8(0, 0); return;
      case 0x10:
        if (al === 0x17 || al === 0x15) return; // read palette: leave buffer as is
        return;
      case 0x11:
        if (al === 0x30) { c.s[ES] = STUB_SEG; c.r[BP] = 0x800; c.r[CX] = 16; c.setr8(2, 24); }
        return;
      case 0x12:
        if ((c.r[BX] & 0xff) === 0x10) { c.r[BX] = 0x0003; c.r[CX] = 0x0009; }
        return;
      case 0x1a:
        if (al === 0) { c.r[AX] = 0x001a; c.r[BX] = 0x0008; }
        return;
      case 0x1b: c.setr8(0, 0); return;
      case 0x4f: c.r[AX] = 0x0100; return; // no VESA
      case 0xfe: return;
    }
  }

  // ---- DOS -------------------------------------------------------------------------
  str(seg, off) {
    let s = '';
    for (let i = 0; i < 256; i++) {
      const ch = this.cpu.rb(seg, off + i);
      if (!ch) break;
      s += String.fromCharCode(ch);
    }
    return s;
  }

  openHandle(entry) {
    let h = this.handles.findIndex((x, i) => i >= 5 && !x);
    if (h < 0) h = this.handles.length;
    this.handles[h] = entry;
    return h;
  }

  dos() {
    const c = this.cpu, r = c.r, s = c.s;
    const ah = r[AX] >> 8, al = r[AX] & 0xff;
    this.setCarry(false);
    switch (ah) {
      case 0x01: case 0x07: case 0x08: {
        if (!this.keys.length) return this.waitKey();
        c.setr8(0, this.keys.shift() & 0xff); return;
      }
      case 0x06:
        if ((r[DX] & 0xff) === 0xff) {
          if (!this.keys.length) { this.setZero(true); c.setr8(0, 0); if (++this.keyPolls > 200) { this.keyPolls = 0; return this.waitKey(); } return; }
          this.setZero(false); c.setr8(0, this.keys.shift() & 0xff); return;
        }
        this.console(String.fromCharCode(r[DX] & 0xff)); return;
      case 0x0b: c.setr8(0, this.keys.length ? 0xff : 0); if (!this.keys.length && ++this.keyPolls > 200) { this.keyPolls = 0; return this.waitKey(); } return;
      case 0x0c: this.keys.clear(); if (al === 1 || al === 6 || al === 7 || al === 8) { r[AX] = al << 8; return this.dos(); } return;
      case 0x02: this.console(String.fromCharCode(r[DX] & 0xff)); return;
      case 0x09: { let t = ''; for (let i = 0; i < 4096; i++) { const ch = c.rb(s[DS], r[DX] + i); if (ch === 0x24) break; t += String.fromCharCode(ch); } this.console(t); return; }
      case 0x0d: return;
      case 0x0e: c.setr8(0, 3); return;
      case 0x19: c.setr8(0, 2); return;
      case 0x1a: this.dta = (s[DS] << 16) | r[DX]; return;
      case 0x25: c.ww(0, (al * 4), r[DX]); c.ww(0, al * 4 + 2, s[DS]); return;
      case 0x2a: r[CX] = 1992; r[DX] = (6 << 8) | 26; c.setr8(0, 5); return;
      case 0x2c: { const t = this.ticks; const sec = Math.floor(t / 18.2); r[CX] = ((12 + Math.floor(sec / 3600) % 12) << 8) | (Math.floor(sec / 60) % 60); r[DX] = ((sec % 60) << 8) | (Math.floor(t * 100 / 18.2) % 100); return; }
      case 0x29: {
        // Parse a file name into an FCB.
        let si = r[SI];
        const ch = () => c.rb(s[DS], si);
        if (al & 1) while (' \t;,=+:'.includes(String.fromCharCode(ch())) && ch()) si++;
        const fcb = r[DI];
        let drive = 0;
        if (ch() && c.rb(s[DS], si + 1) === 0x3a) { drive = (ch() | 0x20) - 0x60; si += 2; }
        if (!(al & 2) || drive) c.wb(s[ES], fcb, drive);
        const part = (len) => {
          let out = '';
          while (out.length < len) { const k = ch(); if (!k || ' \t.;,=+:/"[]<>|\r\\'.includes(String.fromCharCode(k))) break; out += String.fromCharCode(k).toUpperCase(); si++; }
          while (ch() && !' \t.;,=+:/"[]<>|\r\\'.includes(String.fromCharCode(ch()))) si++;
          return out;
        };
        const name = part(8);
        if (name || !(al & 4)) for (let i = 0; i < 8; i++) c.wb(s[ES], fcb + 1 + i, i < name.length ? name.charCodeAt(i) : 32);
        let ext = '';
        if (ch() === 0x2e) { si++; ext = part(3); }
        if (ext || !(al & 8)) for (let i = 0; i < 3; i++) c.wb(s[ES], fcb + 9 + i, i < ext.length ? ext.charCodeAt(i) : 32);
        r[SI] = si; c.setr8(0, (name + ext).includes('*') || (name + ext).includes('?') ? 1 : 0);
        return;
      }
      case 0x2b: case 0x2d: c.setr8(0, 0); return;
      case 0x2f: s[ES] = this.dta >>> 16; r[BX] = this.dta & 0xffff; return;
      case 0x30: r[AX] = 0x0005; r[BX] = 0; r[CX] = 0; return;
      case 0x33: if (al === 0 || al === 2) c.setr8(2, 0); else if (al === 5) c.setr8(2, 3); return;
      case 0x35: r[BX] = c.rw(0, al * 4); s[ES] = c.rw(0, al * 4 + 2); return;
      case 0x36: r[AX] = 32; r[BX] = 2000; r[CX] = 512; r[DX] = 4000; return;
      case 0x37: if (al === 0) c.setr8(2, 0x2f); return;
      case 0x38: return;
      case 0x3b: return;
      case 0x3c: case 0x5b: {
        const name = this.baseName(this.str(s[DS], r[DX]));
        this.written.set(name, { data: [] });
        r[AX] = this.openHandle({ name, pos: 0, write: true });
        this.onOpen?.(name, 'create');
        return;
      }
      case 0x3d: {
        const name = this.baseName(this.str(s[DS], r[DX]));
        if ((al & 3) !== 0 && !this.written.has(name)) {
          if (this.files.has(name)) this.written.set(name, { data: Array.from(this.files.get(name)) });
          else return this.fail(2);
        }
        if (!this.written.has(name) && !this.files.has(name)) return this.fail(2);
        r[AX] = this.openHandle({ name, pos: 0, write: (al & 3) !== 0 });
        this.onOpen?.(name, 'open');
        return;
      }
      case 0x3e: {
        if (r[BX] < 5) return;
        if (!this.handles[r[BX]]) return this.fail(6);
        this.handles[r[BX]] = null; return;
      }
      case 0x3f: {
        const h = this.handles[r[BX]];
        if (!h) return this.fail(6);
        if (h.dev === 'con') {
          // Console input: a line from the key queue.
          if (!this.keys.length) return this.waitKey();
          let n = 0;
          while (this.keys.length && n < r[CX]) {
            const ch = this.keys.shift() & 0xff;
            c.wb(s[DS], r[DX] + n++, ch === 13 ? 13 : ch);
            if (ch === 13) { if (n < r[CX]) c.wb(s[DS], r[DX] + n++, 10); break; }
          }
          r[AX] = n; return;
        }
        if (h.dev === 'nul') { r[AX] = 0; return; }
        const data = this.written.has(h.name) ? this.written.get(h.name).data : this.files.get(h.name);
        const n = Math.max(0, Math.min(r[CX], data.length - h.pos));
        this.onRead?.(h.name, h.pos, n);
        const base = r[DX];
        for (let i = 0; i < n; i++) c.wb(s[DS], base + i, data[h.pos + i]);
        h.pos += n; r[AX] = n; return;
      }
      case 0x40: {
        const h = this.handles[r[BX]];
        if (!h) return this.fail(6);
        const bytes = [];
        for (let i = 0; i < r[CX]; i++) bytes.push(c.rb(s[DS], r[DX] + i));
        if (h.dev === 'con') { this.console(String.fromCharCode(...bytes)); r[AX] = r[CX]; return; }
        if (h.dev === 'nul') { r[AX] = r[CX]; return; }
        if (!this.written.has(h.name)) return this.fail(5);
        if (this.discard?.has(h.name)) { h.pos += bytes.length; this.onWrite?.(h.name, bytes); r[AX] = r[CX]; return; }
        const data = this.written.get(h.name).data;
        if (!r[CX]) { data.length = h.pos; r[AX] = 0; return; }
        for (let i = 0; i < bytes.length; i++) data[h.pos + i] = bytes[i];
        for (let i = 0; i < data.length; i++) if (data[i] === undefined) data[i] = 0;
        h.pos += bytes.length;
        this.onWrite?.(h.name, bytes);
        r[AX] = r[CX]; return;
      }
      case 0x41: { const name = this.baseName(this.str(s[DS], r[DX])); if (!this.written.delete(name)) return this.fail(2); return; }
      case 0x42: {
        const h = this.handles[r[BX]];
        if (!h) return this.fail(6);
        if (h.dev) { r[AX] = 0; r[DX] = 0; return; }
        const size = this.written.has(h.name) ? this.written.get(h.name).data.length : this.files.get(h.name).length;
        const off = ((r[CX] << 16) | r[DX]) | 0;
        const pos = al === 0 ? off >>> 0 : al === 1 ? h.pos + off : size + off;
        h.pos = pos; r[AX] = pos & 0xffff; r[DX] = pos >>> 16; return;
      }
      case 0x43: { const name = this.baseName(this.str(s[DS], r[DX])); if (!this.file(name)) return this.fail(2); r[CX] = 0x20; return; }
      case 0x44: {
        if (al === 0) { const h = this.handles[r[BX]]; if (!h) return this.fail(6); r[DX] = h.dev === 'con' ? 0x80d3 : h.dev === 'nul' ? 0x8084 : 0x0002; return; }
        if (al === 1) return;
        if (al === 7 || al === 6) { c.setr8(0, 0xff); return; }
        if (al === 8) { r[AX] = 1; return; }
        if (al === 0xe) { c.setr8(0, 0); return; }
        return this.fail(1);
      }
      case 0x45: { const h = this.handles[r[BX]]; if (!h) return this.fail(6); r[AX] = this.openHandle({ ...h }); return; }
      case 0x46: { const h = this.handles[r[BX]]; if (!h) return this.fail(6); this.handles[r[CX]] = { ...h }; return; }
      case 0x47: c.wb(s[DS], r[SI], 0); return;
      case 0x48: {
        const res = this.alloc(r[BX], this.psp);
        if (res.error) { r[BX] = res.largest; return this.fail(8); }
        r[AX] = res.seg; return;
      }
      case 0x49: { const e = this.free(s[ES]); if (e) return this.fail(e); return; }
      case 0x4a: {
        const res = this.resize(s[ES], r[BX]);
        if (res.error) { r[BX] = res.largest; return this.fail(res.error); }
        return;
      }
      case 0x4c: this.exit(al); return;
      case 0x4e: case 0x4f: return this.find(ah === 0x4e);
      case 0x50: this.psp = r[BX]; return;
      case 0x51: case 0x62: r[BX] = this.psp; return;
      case 0x52: s[ES] = 0x0060; r[BX] = 0x0010; this.w16(0x60e, FIRST_MCB); return;
      case 0x54: c.setr8(0, 0); return;
      case 0x56: { const a = this.baseName(this.str(s[DS], r[DX])), b = this.baseName(this.str(s[ES], r[DI])); if (!this.written.has(a)) return this.fail(2); this.written.set(b, this.written.get(a)); this.written.delete(a); return; }
      case 0x57: if (al === 0) { r[CX] = 0; r[DX] = 0x18da; } return;
      case 0x58: if (al === 0) r[AX] = 0; return;
      case 0x59: r[AX] = 2; r[BX] = 0x0102; c.setr8(5, 0); return;
      case 0x4b: {
        const name = this.str(s[DS], r[DX]);
        const pb = (s[ES] << 4) + r[BX];
        if (al === 3) {
          // Load an overlay: the EXE image at a segment, relocated by a factor.
          const img = this.file(name);
          if (!img) return this.fail(2);
          this.loadImage(img, this.r16(pb), this.r16(pb + 2));
          this.onOpen?.(this.baseName(name), 'overlay');
          return;
        }
        throw new DosError(`EXEC of ${name} is not supported`);
      }
    }
    throw new DosError(`Unsupported DOS call ${ah.toString(16)} (AX=${r[AX].toString(16)})`);
  }

  find(first) {
    const c = this.cpu, r = c.r, s = c.s;
    if (first) {
      const pat = this.baseName(this.str(s[DS], r[DX]));
      const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') .replace(/\\\.\.\*$/, '(\\..*)?') + '$');
      const names = [...new Set([...this.files.keys(), ...this.written.keys()])].filter((n) => re.test(n)).sort();
      this.findList = names;
    }
    if (!this.findList?.length) return this.fail(first ? 2 : 18);
    const name = this.findList.shift();
    const dseg = this.dta >>> 16, doff = this.dta & 0xffff;
    const data = this.file(name);
    c.wb(dseg, doff + 0x15, 0x20);
    c.ww(dseg, doff + 0x16, 0); c.ww(dseg, doff + 0x18, 0x18da);
    c.ww(dseg, doff + 0x1a, data.length & 0xffff); c.ww(dseg, doff + 0x1c, data.length >>> 16);
    for (let i = 0; i < 13; i++) c.wb(dseg, doff + 0x1e + i, i < name.length ? name.charCodeAt(i) : 0);
  }

  /** The text grid as lines (trailing spaces trimmed). */
  screenText(rows = ROWS) {
    const out = [];
    for (let y = 0; y < rows; y++) out.push(String.fromCharCode(...this.grid.subarray(y * COLS, y * COLS + COLS)).replace(/\s+$/, ''));
    while (out.length && !out[out.length - 1]) out.pop();
    return out.join('\n');
  }

  console(text) {
    this.onConsole?.(text);
  }
}

// The BIOS keyboard buffer, in the BIOS data area as on a PC (some programs
// look at its head and tail themselves to see whether a key is waiting).
class KeyBuffer {
  constructor(mem) { this.mem = mem; }
  r16(a) { return this.mem[a] | (this.mem[a + 1] << 8); }
  w16(a, v) { this.mem[a] = v & 0xff; this.mem[a + 1] = (v >> 8) & 0xff; }
  get start() { return this.r16(0x480) || 0x1e; }
  get end() { return this.r16(0x482) || 0x3e; }
  get length() {
    const n = (this.r16(0x41c) - this.r16(0x41a)) / 2;
    return n >= 0 ? n : n + (this.end - this.start) / 2;
  }
  next(p) { p += 2; return p >= this.end ? this.start : p; }
  get full() { return this.next(this.r16(0x41c)) === this.r16(0x41a); }
  push(...keys) {
    for (const k of keys) {
      const tail = this.r16(0x41c), n = this.next(tail);
      if (n === this.r16(0x41a)) return; // full
      this.w16(0x400 + tail, k);
      this.w16(0x41c, n);
    }
  }
  peek() { return this.length ? this.r16(0x400 + this.r16(0x41a)) : 0; }
  shift() {
    if (!this.length) return 0;
    const head = this.r16(0x41a), k = this.r16(0x400 + head);
    this.w16(0x41a, this.next(head));
    return k;
  }
  clear() { this.w16(0x41a, this.r16(0x41c)); }
}

// Scan codes for typed characters (US layout).
const SCAN = {};
'1234567890-='.split('').forEach((ch, i) => { SCAN[ch] = 2 + i; });
'qwertyuiop[]'.split('').forEach((ch, i) => { SCAN[ch] = 0x10 + i; });
"asdfghjkl;'`".split('').forEach((ch, i) => { SCAN[ch] = 0x1e + i; });
'\\zxcvbnm,./'.split('').forEach((ch, i) => { SCAN[ch] = 0x2b + i; });
SCAN[' '] = 0x39; SCAN['\r'] = 0x1c; SCAN['\b'] = 0x0e; SCAN['\x1b'] = 0x01;
export const KEYS = { ENTER: 0x1c0d, ESC: 0x011b, SPACE: 0x3920, BACKSPACE: 0x0e08, F1: 0x3b00, F2: 0x3c00, F3: 0x3d00, F4: 0x3e00, F5: 0x3f00 };
