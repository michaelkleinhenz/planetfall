// A small 16-bit x86 CPU (8086 plus the 80186/286 real-mode additions) for
// running Legend Entertainment's DOS programs. Memory is the 1 MB real-mode
// address space; BIOS and DOS services are not here but in dos.js, which the
// CPU calls when code runs at the service stubs (segment F000, offsets below
// 0x400: one stub per interrupt vector).
//
// Registers: r[0..7] = AX CX DX BX SP BP SI DI; s[0..3] = ES CS SS DS.

export const AX = 0, CX = 1, DX = 2, BX = 3, SP = 4, BP = 5, SI = 6, DI = 7;
export const ES = 0, CS = 1, SS = 2, DS = 3;
export const STUB_SEG = 0xf000;

const CF = 0x1, PF = 0x4, AF = 0x10, ZF = 0x40, SF = 0x80, TF = 0x100, IF = 0x200, DF = 0x400, OF = 0x800;
export const FLAGS = { CF, PF, AF, ZF, SF, TF, IF, DF, OF };

const PARITY = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let b = i, p = 1;
  while (b) { p ^= b & 1; b >>= 1; }
  PARITY[i] = p ? PF : 0;
}

export class CpuError extends Error {}

export class Cpu {
  constructor(mem) {
    this.mem = mem;                 // Uint8Array(0x110000)
    this.r = new Uint16Array(8);
    this.s = new Uint16Array(4);
    this.ip = 0;
    this.flags = 0x0002;
    this.count = 0;
    this.halted = false;
    // Hooks set by the machine.
    this.service = null;            // (vector) => void, for stubs
    this.portIn = () => 0xff;
    this.portOut = () => {};
    this.pendingIrq = [];           // hardware interrupt vectors waiting for IF
    this.trace = null;
  }

  // ---- memory ---------------------------------------------------------------
  rb(seg, off) { return this.mem[((seg << 4) + (off & 0xffff)) & 0xfffff]; }
  rw(seg, off) {
    const a = ((seg << 4) + (off & 0xffff)) & 0xfffff;
    if ((off & 0xffff) === 0xffff) return this.mem[a] | (this.mem[((seg << 4)) & 0xfffff] << 8);
    return this.mem[a] | (this.mem[a + 1] << 8);
  }
  wb(seg, off, v) { this.mem[((seg << 4) + (off & 0xffff)) & 0xfffff] = v; }
  ww(seg, off, v) {
    const a = ((seg << 4) + (off & 0xffff)) & 0xfffff;
    this.mem[a] = v;
    if ((off & 0xffff) === 0xffff) this.mem[(seg << 4) & 0xfffff] = v >> 8;
    else this.mem[a + 1] = v >> 8;
  }

  fetchb() { const v = this.rb(this.s[CS], this.ip); this.ip = (this.ip + 1) & 0xffff; return v; }
  fetchw() { const v = this.rw(this.s[CS], this.ip); this.ip = (this.ip + 2) & 0xffff; return v; }
  fetchsb() { const v = this.fetchb(); return v & 0x80 ? v - 256 : v; }

  push(v) { this.r[SP] -= 2; this.ww(this.s[SS], this.r[SP], v); }
  pop() { const v = this.rw(this.s[SS], this.r[SP]); this.r[SP] += 2; return v; }

  // ---- registers --------------------------------------------------------------
  getr8(i) { return i < 4 ? this.r[i] & 0xff : this.r[i - 4] >> 8; }
  setr8(i, v) {
    if (i < 4) this.r[i] = (this.r[i] & 0xff00) | (v & 0xff);
    else this.r[i - 4] = (this.r[i - 4] & 0xff) | ((v & 0xff) << 8);
  }

  // ---- ModR/M -------------------------------------------------------------------
  // Decodes the ModR/M byte; sets this.mod, this.reg, this.rm and, for memory
  // operands, this.eaSeg / this.eaOff.
  modrm() {
    const m = this.fetchb();
    this.mod = m >> 6; this.reg = (m >> 3) & 7; this.rm = m & 7;
    if (this.mod === 3) return;
    let off, seg = DS;
    const r = this.r;
    switch (this.rm) {
      case 0: off = r[BX] + r[SI]; break;
      case 1: off = r[BX] + r[DI]; break;
      case 2: off = r[BP] + r[SI]; seg = SS; break;
      case 3: off = r[BP] + r[DI]; seg = SS; break;
      case 4: off = r[SI]; break;
      case 5: off = r[DI]; break;
      case 6:
        if (this.mod === 0) { off = this.fetchw(); } else { off = r[BP]; seg = SS; }
        break;
      default: off = r[BX];
    }
    if (this.mod === 1) off += this.fetchsb();
    else if (this.mod === 2) off += this.fetchw();
    this.eaOff = off & 0xffff;
    this.eaSeg = this.segOverride >= 0 ? this.s[this.segOverride] : this.s[seg];
  }
  getrm8() { return this.mod === 3 ? this.getr8(this.rm) : this.rb(this.eaSeg, this.eaOff); }
  setrm8(v) { if (this.mod === 3) this.setr8(this.rm, v); else this.wb(this.eaSeg, this.eaOff, v); }
  getrm16() { return this.mod === 3 ? this.r[this.rm] : this.rw(this.eaSeg, this.eaOff); }
  setrm16(v) { if (this.mod === 3) this.r[this.rm] = v; else this.ww(this.eaSeg, this.eaOff, v); }
  dataSeg() { return this.segOverride >= 0 ? this.s[this.segOverride] : this.s[DS]; }

  // ---- flags -----------------------------------------------------------------------
  setSZP(v, w) {
    let f = this.flags & ~(SF | ZF | PF);
    if (w) { v &= 0xffff; if (v & 0x8000) f |= SF; } else { v &= 0xff; if (v & 0x80) f |= SF; }
    if (!v) f |= ZF;
    f |= PARITY[v & 0xff];
    this.flags = f;
  }
  flag(f) { return (this.flags & f) !== 0; }
  setFlag(f, on) { if (on) this.flags |= f; else this.flags &= ~f; }

  // ALU: op 0 add, 1 or, 2 adc, 3 sbb, 4 and, 5 sub, 6 xor, 7 cmp. Returns result.
  alu(op, a, b, w) {
    const mask = w ? 0xffff : 0xff, sign = w ? 0x8000 : 0x80;
    let res, cf = 0, of = 0, af = 0;
    switch (op) {
      case 0: case 2: {
        const c = op === 2 && (this.flags & CF) ? 1 : 0;
        res = a + b + c;
        cf = res > mask; res &= mask;
        of = ((a ^ res) & (b ^ res) & sign) !== 0;
        af = ((a ^ b ^ res) & 0x10) !== 0;
        break;
      }
      case 3: case 5: case 7: {
        const c = op === 3 && (this.flags & CF) ? 1 : 0;
        res = a - b - c;
        cf = res < 0; res &= mask;
        of = ((a ^ b) & (a ^ res) & sign) !== 0;
        af = ((a ^ b ^ res) & 0x10) !== 0;
        break;
      }
      case 1: res = a | b; break;
      case 4: res = a & b; break;
      case 6: res = a ^ b; break;
    }
    this.setSZP(res, w);
    let f = this.flags & ~(CF | OF | AF);
    if (cf) f |= CF; if (of) f |= OF; if (af) f |= AF;
    this.flags = f;
    return res;
  }
  inc(v, w) {
    const mask = w ? 0xffff : 0xff, sign = w ? 0x8000 : 0x80;
    const res = (v + 1) & mask;
    const cf = this.flags & CF;
    this.setSZP(res, w);
    this.flags = (this.flags & ~(OF | AF | CF)) | cf | (res === sign ? OF : 0) | ((res & 0xf) === 0 ? AF : 0);
    return res;
  }
  dec(v, w) {
    const mask = w ? 0xffff : 0xff, sign = w ? 0x8000 : 0x80;
    const res = (v - 1) & mask;
    const cf = this.flags & CF;
    this.setSZP(res, w);
    this.flags = (this.flags & ~(OF | AF | CF)) | cf | (res === sign - 1 ? OF : 0) | ((res & 0xf) === 0xf ? AF : 0);
    return res;
  }

  // Shifts and rotates: op 0 rol, 1 ror, 2 rcl, 3 rcr, 4 shl, 5 shr, 6 sal, 7 sar.
  shift(op, v, n, w) {
    const bits = w ? 16 : 8, mask = w ? 0xffff : 0xff, sign = w ? 0x8000 : 0x80;
    n &= 0x1f;
    if (!n) return v;
    let cf = this.flags & CF ? 1 : 0, res = v;
    switch (op) {
      case 0:
        for (let i = 0; i < n; i++) { cf = (res & sign) ? 1 : 0; res = ((res << 1) | cf) & mask; }
        this.setFlag(CF, cf); this.setFlag(OF, ((res & sign) ? 1 : 0) ^ cf);
        return res;
      case 1:
        for (let i = 0; i < n; i++) { cf = res & 1; res = (res >> 1) | (cf ? sign : 0); }
        this.setFlag(CF, cf); this.setFlag(OF, ((res ^ (res << 1)) & sign) !== 0);
        return res;
      case 2:
        for (let i = 0; i < n; i++) { const hi = (res & sign) ? 1 : 0; res = ((res << 1) | cf) & mask; cf = hi; }
        this.setFlag(CF, cf); this.setFlag(OF, ((res & sign) ? 1 : 0) ^ cf);
        return res;
      case 3:
        for (let i = 0; i < n; i++) { const lo = res & 1; res = (res >> 1) | (cf ? sign : 0); cf = lo; }
        this.setFlag(CF, cf); this.setFlag(OF, ((res ^ (res << 1)) & sign) !== 0);
        return res;
      case 4: case 6:
        cf = n <= bits ? (v >> (bits - n)) & 1 : 0;
        res = n < 32 ? (v << n) & mask : 0;
        this.setSZP(res, w); this.setFlag(CF, cf);
        this.setFlag(OF, ((res & sign) ? 1 : 0) ^ cf);
        return res;
      case 5:
        cf = n <= bits ? (v >> (n - 1)) & 1 : 0;
        res = v >> n;
        this.setSZP(res, w); this.setFlag(CF, cf);
        this.setFlag(OF, n === 1 && (v & sign) !== 0);
        return res;
      case 7: {
        const sv = w ? (v << 16) >> 16 : (v << 24) >> 24;
        const k = Math.min(n, bits);
        cf = (sv >> (k - 1)) & 1;
        res = (sv >> k) & mask;
        this.setSZP(res, w); this.setFlag(CF, cf); this.setFlag(OF, false);
        return res;
      }
    }
    return res;
  }

  // ---- interrupts ------------------------------------------------------------------
  interrupt(n) {
    this.push(this.flags);
    this.push(this.s[CS]);
    this.push(this.ip);
    this.flags &= ~(IF | TF);
    this.ip = this.mem[n * 4] | (this.mem[n * 4 + 1] << 8);
    this.s[CS] = this.mem[n * 4 + 2] | (this.mem[n * 4 + 3] << 8);
  }
  iret() {
    this.ip = this.pop();
    this.s[CS] = this.pop();
    this.flags = (this.pop() & 0x0fd5) | 0x0002;
  }

  divError() { this.ip = this.instrStart; this.interrupt(0); }

  // ---- execution ---------------------------------------------------------------------
  /** Run up to n instructions (stops early when this.stop is set). */
  run(n) {
    const end = this.count + n;
    this.stop = false;
    while (this.count < end && !this.stop) {
      if (this.pendingIrq.length && (this.flags & IF) && !this.inhibit) this.interrupt(this.pendingIrq.shift());
      this.inhibit = false;
      if (this.s[CS] === STUB_SEG && this.ip < 0x400) {
        // A BIOS/DOS service stub: the service runs, then returns like IRET
        // (services that change the caller's flags edit them on the stack).
        const vec = this.ip >> 2;
        this.count++;
        this.service(vec);
        if (this.stop && this.retry) { this.retry = false; continue; }
        if (this.skipIret) { this.skipIret = false; continue; }
        this.iret();
        continue;
      }
      this.step();
    }
  }

  step() {
    this.count++;
    this.instrStart = this.ip;
    this.instrCs = this.s[CS];
    this.segOverride = -1;
    let rep = 0;
    let op;
    for (;;) {
      op = this.fetchb();
      if (op === 0x26) this.segOverride = ES;
      else if (op === 0x2e) this.segOverride = CS;
      else if (op === 0x36) this.segOverride = SS;
      else if (op === 0x3e) this.segOverride = DS;
      else if (op === 0xf2 || op === 0xf3) rep = op;
      else if (op === 0xf0) { /* lock */ }
      else break;
    }
    const r = this.r, s = this.s;
    if (op < 0x40 && (op & 7) < 6) {
      const alu = op >> 3;
      let a, b, res;
      switch (op & 7) {
        case 0: this.modrm(); res = this.alu(alu, this.getrm8(), this.getr8(this.reg), 0); if (alu !== 7) this.setrm8(res); return;
        case 1: this.modrm(); res = this.alu(alu, this.getrm16(), r[this.reg], 1); if (alu !== 7) this.setrm16(res); return;
        case 2: this.modrm(); res = this.alu(alu, this.getr8(this.reg), this.getrm8(), 0); if (alu !== 7) this.setr8(this.reg, res); return;
        case 3: this.modrm(); res = this.alu(alu, r[this.reg], this.getrm16(), 1); if (alu !== 7) r[this.reg] = res; return;
        case 4: a = r[AX] & 0xff; b = this.fetchb(); res = this.alu(alu, a, b, 0); if (alu !== 7) this.setr8(0, res); return;
        case 5: b = this.fetchw(); res = this.alu(alu, r[AX], b, 1); if (alu !== 7) r[AX] = res; return;
      }
    }
    switch (op) {
      case 0x06: this.push(s[ES]); return;
      case 0x07: s[ES] = this.pop(); this.inhibit = true; return;
      case 0x0e: this.push(s[CS]); return;
      case 0x0f: return this.op0f();
      case 0x16: this.push(s[SS]); return;
      case 0x17: s[SS] = this.pop(); this.inhibit = true; return;
      case 0x1e: this.push(s[DS]); return;
      case 0x1f: s[DS] = this.pop(); return;
      case 0x27: { // DAA
        let al = r[AX] & 0xff; const oldAl = al, oldCf = this.flags & CF;
        let cf = 0;
        if ((al & 0xf) > 9 || (this.flags & AF)) { al += 6; cf = oldCf || al > 0xff; this.flags |= AF; } else this.flags &= ~AF;
        if (oldAl > 0x99 || oldCf) { al += 0x60; cf = 1; }
        al &= 0xff; this.setr8(0, al); this.setSZP(al, 0); this.setFlag(CF, cf); return;
      }
      case 0x2f: { // DAS
        let al = r[AX] & 0xff; const oldAl = al, oldCf = this.flags & CF;
        let cf = 0;
        if ((al & 0xf) > 9 || (this.flags & AF)) { al -= 6; cf = oldCf || al < 0; this.flags |= AF; } else this.flags &= ~AF;
        if (oldAl > 0x99 || oldCf) { al -= 0x60; cf = 1; }
        al &= 0xff; this.setr8(0, al); this.setSZP(al, 0); this.setFlag(CF, cf); return;
      }
      case 0x37: case 0x3f: { // AAA / AAS
        if ((r[AX] & 0xf) > 9 || (this.flags & AF)) {
          if (op === 0x37) { r[AX] = r[AX] + 0x106; } else { r[AX] = (r[AX] - 6) & 0xffff; r[AX] = (r[AX] & 0xff) | ((((r[AX] >> 8) - 1) & 0xff) << 8); }
          this.flags |= AF | CF;
        } else this.flags &= ~(AF | CF);
        r[AX] &= 0xff0f; return;
      }
    }
    if (op >= 0x40 && op <= 0x47) { r[op & 7] = this.inc(r[op & 7], 1); return; }
    if (op >= 0x48 && op <= 0x4f) { r[op & 7] = this.dec(r[op & 7], 1); return; }
    if (op >= 0x50 && op <= 0x57) { this.push(r[op & 7]); return; } // PUSH SP pushes the old value (286)
    if (op >= 0x58 && op <= 0x5f) { r[op & 7] = this.pop(); return; }
    if (op >= 0x70 && op <= 0x7f) { const d = this.fetchsb(); if (this.cond(op & 0xf)) this.ip = (this.ip + d) & 0xffff; return; }
    if (op >= 0x91 && op <= 0x97) { const t = r[AX]; r[AX] = r[op & 7]; r[op & 7] = t; return; }
    if (op >= 0xb0 && op <= 0xb7) { this.setr8(op & 7, this.fetchb()); return; }
    if (op >= 0xb8 && op <= 0xbf) { r[op & 7] = this.fetchw(); return; }
    if (op >= 0xd8 && op <= 0xdf) { this.modrm(); return; } // no coprocessor: ESC is ignored
    switch (op) {
      case 0x60: { const sp = r[SP]; for (let i = 0; i < 8; i++) this.push(i === SP ? sp : r[i]); return; }
      case 0x61: { for (let i = 7; i >= 0; i--) { const v = this.pop(); if (i !== SP) r[i] = v; } return; }
      case 0x62: { this.modrm(); const v = (r[this.reg] << 16) >> 16; const lo = (this.rw(this.eaSeg, this.eaOff) << 16) >> 16, hi = (this.rw(this.eaSeg, this.eaOff + 2) << 16) >> 16; if (v < lo || v > hi) { this.ip = this.instrStart; this.interrupt(5); } return; }
      case 0x68: this.push(this.fetchw()); return;
      case 0x69: case 0x6b: {
        this.modrm();
        const a = (this.getrm16() << 16) >> 16;
        const b = op === 0x69 ? (this.fetchw() << 16) >> 16 : this.fetchsb();
        const p = a * b;
        r[this.reg] = p & 0xffff;
        const ov = p !== ((p << 16) >> 16);
        this.setFlag(CF, ov); this.setFlag(OF, ov);
        return;
      }
      case 0x6a: this.push(this.fetchsb() & 0xffff); return;
      case 0x6c: case 0x6d: case 0x6e: case 0x6f: return this.stringOp(op, rep);
      case 0x80: case 0x82: { this.modrm(); const b = this.fetchb(); const res = this.alu(this.reg, this.getrm8(), b, 0); if (this.reg !== 7) this.setrm8(res); return; }
      case 0x81: { this.modrm(); const b = this.fetchw(); const res = this.alu(this.reg, this.getrm16(), b, 1); if (this.reg !== 7) this.setrm16(res); return; }
      case 0x83: { this.modrm(); const b = this.fetchsb() & 0xffff; const res = this.alu(this.reg, this.getrm16(), b, 1); if (this.reg !== 7) this.setrm16(res); return; }
      case 0x84: this.modrm(); this.alu(4, this.getrm8(), this.getr8(this.reg), 0); return;
      case 0x85: this.modrm(); this.alu(4, this.getrm16(), r[this.reg], 1); return;
      case 0x86: { this.modrm(); const a = this.getrm8(); this.setrm8(this.getr8(this.reg)); this.setr8(this.reg, a); return; }
      case 0x87: { this.modrm(); const a = this.getrm16(); this.setrm16(r[this.reg]); r[this.reg] = a; return; }
      case 0x88: this.modrm(); this.setrm8(this.getr8(this.reg)); return;
      case 0x89: this.modrm(); this.setrm16(r[this.reg]); return;
      case 0x8a: this.modrm(); this.setr8(this.reg, this.getrm8()); return;
      case 0x8b: this.modrm(); r[this.reg] = this.getrm16(); return;
      case 0x8c: this.modrm(); this.setrm16(s[this.reg & 3]); return;
      case 0x8d: this.modrm(); r[this.reg] = this.eaOff; return;
      case 0x8e: this.modrm(); s[this.reg & 3] = this.getrm16(); if ((this.reg & 3) === SS) this.inhibit = true; return;
      case 0x8f: { this.modrm(); const v = this.pop(); this.setrm16(v); return; }
      case 0x90: return;
      case 0x98: r[AX] = (r[AX] & 0x80) ? r[AX] | 0xff00 : r[AX] & 0xff; return;
      case 0x99: r[DX] = (r[AX] & 0x8000) ? 0xffff : 0; return;
      case 0x9a: { const o = this.fetchw(), sg = this.fetchw(); this.push(s[CS]); this.push(this.ip); s[CS] = sg; this.ip = o; return; }
      case 0x9b: return;
      case 0x9c: this.push(this.flags | 0xf000); return;
      case 0x9d: this.flags = (this.pop() & 0x0fd5) | 0x0002; return;
      case 0x9e: this.flags = (this.flags & 0xff00) | ((r[AX] >> 8) & 0xd5) | 2; return;
      case 0x9f: this.setr8(4, this.flags & 0xff); return;
      case 0xa0: this.setr8(0, this.rb(this.dataSeg(), this.fetchw())); return;
      case 0xa1: r[AX] = this.rw(this.dataSeg(), this.fetchw()); return;
      case 0xa2: this.wb(this.dataSeg(), this.fetchw(), r[AX] & 0xff); return;
      case 0xa3: this.ww(this.dataSeg(), this.fetchw(), r[AX]); return;
      case 0xa4: case 0xa5: case 0xa6: case 0xa7: case 0xaa: case 0xab: case 0xac: case 0xad: case 0xae: case 0xaf:
        return this.stringOp(op, rep);
      case 0xa8: this.alu(4, r[AX] & 0xff, this.fetchb(), 0); return;
      case 0xa9: this.alu(4, r[AX], this.fetchw(), 1); return;
      case 0xc0: case 0xc1: case 0xd0: case 0xd1: case 0xd2: case 0xd3: {
        this.modrm();
        const w = op & 1;
        const n = op <= 0xc1 ? this.fetchb() : op <= 0xd1 ? 1 : r[CX] & 0xff;
        if (w) this.setrm16(this.shift(this.reg, this.getrm16(), n, 1));
        else this.setrm8(this.shift(this.reg, this.getrm8(), n, 0));
        return;
      }
      case 0xc2: { const n = this.fetchw(); this.ip = this.pop(); r[SP] += n; return; }
      case 0xc3: this.ip = this.pop(); return;
      case 0xc4: case 0xc5: {
        this.modrm();
        r[this.reg] = this.rw(this.eaSeg, this.eaOff);
        s[op === 0xc4 ? ES : DS] = this.rw(this.eaSeg, this.eaOff + 2);
        return;
      }
      case 0xc6: this.modrm(); this.setrm8(this.fetchb()); return;
      case 0xc7: this.modrm(); this.setrm16(this.fetchw()); return;
      case 0xc8: {
        const size = this.fetchw(), level = this.fetchb() & 0x1f;
        this.push(r[BP]);
        const frame = r[SP];
        for (let i = 1; i < level; i++) { r[BP] -= 2; this.push(this.rw(s[SS], r[BP])); }
        if (level > 0) this.push(frame);
        r[BP] = frame; r[SP] -= size;
        return;
      }
      case 0xc9: r[SP] = r[BP]; r[BP] = this.pop(); return;
      case 0xca: { const n = this.fetchw(); this.ip = this.pop(); s[CS] = this.pop(); r[SP] += n; return; }
      case 0xcb: this.ip = this.pop(); s[CS] = this.pop(); return;
      case 0xcc: this.interrupt(3); return;
      case 0xcd: this.interrupt(this.fetchb()); return;
      case 0xce: if (this.flags & OF) this.interrupt(4); return;
      case 0xcf: this.iret(); return;
      case 0xd4: { const b = this.fetchb(); if (!b) return this.divError(); const al = r[AX] & 0xff; r[AX] = ((Math.floor(al / b)) << 8) | (al % b); this.setSZP(r[AX] & 0xff, 0); return; }
      case 0xd5: { const b = this.fetchb(); const v = ((r[AX] & 0xff) + (r[AX] >> 8) * b) & 0xff; r[AX] = v; this.setSZP(v, 0); return; }
      case 0xd6: this.setr8(0, this.flags & CF ? 0xff : 0); return;
      case 0xd7: this.setr8(0, this.rb(this.dataSeg(), (r[BX] + (r[AX] & 0xff)) & 0xffff)); return;
      case 0xe0: case 0xe1: case 0xe2: {
        const d = this.fetchsb();
        r[CX]--;
        const z = (this.flags & ZF) !== 0;
        if (r[CX] && (op === 0xe2 || (op === 0xe1 ? z : !z))) this.ip = (this.ip + d) & 0xffff;
        return;
      }
      case 0xe3: { const d = this.fetchsb(); if (!r[CX]) this.ip = (this.ip + d) & 0xffff; return; }
      case 0xe4: this.setr8(0, this.portIn(this.fetchb(), 0)); return;
      case 0xe5: r[AX] = this.portIn(this.fetchb(), 1); return;
      case 0xe6: this.portOut(this.fetchb(), r[AX] & 0xff, 0); return;
      case 0xe7: this.portOut(this.fetchb(), r[AX], 1); return;
      case 0xe8: { const d = this.fetchw(); this.push(this.ip); this.ip = (this.ip + d) & 0xffff; return; }
      case 0xe9: { const d = this.fetchw(); this.ip = (this.ip + d) & 0xffff; return; }
      case 0xea: { const o = this.fetchw(), sg = this.fetchw(); this.ip = o; s[CS] = sg; return; }
      case 0xeb: { const d = this.fetchsb(); this.ip = (this.ip + d) & 0xffff; return; }
      case 0xec: this.setr8(0, this.portIn(r[DX], 0)); return;
      case 0xed: r[AX] = this.portIn(r[DX], 1); return;
      case 0xee: this.portOut(r[DX], r[AX] & 0xff, 0); return;
      case 0xef: this.portOut(r[DX], r[AX], 1); return;
      case 0xf4: this.halted = true; this.stop = true; return;
      case 0xf5: this.flags ^= CF; return;
      case 0xf6: case 0xf7: return this.grp3(op & 1);
      case 0xf8: this.flags &= ~CF; return;
      case 0xf9: this.flags |= CF; return;
      case 0xfa: this.flags &= ~IF; return;
      case 0xfb: this.flags |= IF; this.inhibit = true; return;
      case 0xfc: this.flags &= ~DF; return;
      case 0xfd: this.flags |= DF; return;
      case 0xfe: {
        this.modrm();
        if (this.reg === 0) this.setrm8(this.inc(this.getrm8(), 0));
        else if (this.reg === 1) this.setrm8(this.dec(this.getrm8(), 0));
        else this.bad(op);
        return;
      }
      case 0xff: {
        this.modrm();
        switch (this.reg) {
          case 0: this.setrm16(this.inc(this.getrm16(), 1)); return;
          case 1: this.setrm16(this.dec(this.getrm16(), 1)); return;
          case 2: { const t = this.getrm16(); this.push(this.ip); this.ip = t; return; }
          case 3: { const o = this.rw(this.eaSeg, this.eaOff), sg = this.rw(this.eaSeg, this.eaOff + 2); this.push(s[CS]); this.push(this.ip); this.ip = o; s[CS] = sg; return; }
          case 4: this.ip = this.getrm16(); return;
          case 5: { const o = this.rw(this.eaSeg, this.eaOff), sg = this.rw(this.eaSeg, this.eaOff + 2); this.ip = o; s[CS] = sg; return; }
          case 6: { const v = this.getrm16(); this.push(v); return; }
        }
        return this.bad(op);
      }
    }
    this.bad(op);
  }

  op0f() {
    const op2 = this.fetchb();
    this.bad(0x0f00 | op2);
  }

  bad(op) {
    throw new CpuError(`Unsupported instruction ${op.toString(16)} at ${this.instrCs.toString(16)}:${this.instrStart.toString(16)}`);
  }

  cond(c) {
    const f = this.flags;
    let v;
    switch (c >> 1) {
      case 0: v = f & OF; break;
      case 1: v = f & CF; break;
      case 2: v = f & ZF; break;
      case 3: v = f & (CF | ZF); break;
      case 4: v = f & SF; break;
      case 5: v = f & PF; break;
      case 6: v = !(f & SF) !== !(f & OF); break;
      case 7: v = (f & ZF) || (!(f & SF) !== !(f & OF)); break;
    }
    v = !!v;
    return c & 1 ? !v : v;
  }

  grp3(w) {
    this.modrm();
    const r = this.r;
    switch (this.reg) {
      case 0: case 1: if (w) this.alu(4, this.getrm16(), this.fetchw(), 1); else this.alu(4, this.getrm8(), this.fetchb(), 0); return;
      case 2: if (w) this.setrm16(~this.getrm16() & 0xffff); else this.setrm8(~this.getrm8() & 0xff); return;
      case 3: if (w) this.setrm16(this.alu(5, 0, this.getrm16(), 1)); else this.setrm8(this.alu(5, 0, this.getrm8(), 0)); return;
      case 4: { // MUL
        if (w) { const p = r[AX] * this.getrm16(); r[AX] = p & 0xffff; r[DX] = (p >>> 16) & 0xffff; const ov = r[DX] !== 0; this.setFlag(CF, ov); this.setFlag(OF, ov); }
        else { const p = (r[AX] & 0xff) * this.getrm8(); r[AX] = p; const ov = (p & 0xff00) !== 0; this.setFlag(CF, ov); this.setFlag(OF, ov); }
        return;
      }
      case 5: { // IMUL
        if (w) { const p = ((r[AX] << 16) >> 16) * ((this.getrm16() << 16) >> 16); r[AX] = p & 0xffff; r[DX] = (p >> 16) & 0xffff; const ov = p !== ((p << 16) >> 16); this.setFlag(CF, ov); this.setFlag(OF, ov); }
        else { const p = (((r[AX] & 0xff) << 24) >> 24) * ((this.getrm8() << 24) >> 24); r[AX] = p & 0xffff; const ov = p !== ((p << 24) >> 24); this.setFlag(CF, ov); this.setFlag(OF, ov); }
        return;
      }
      case 6: { // DIV
        if (w) {
          const d = this.getrm16(); if (!d) return this.divError();
          const n = (r[DX] * 0x10000) + r[AX]; const q = Math.floor(n / d);
          if (q > 0xffff) return this.divError();
          r[AX] = q; r[DX] = n % d;
        } else {
          const d = this.getrm8(); if (!d) return this.divError();
          const n = r[AX]; const q = Math.floor(n / d);
          if (q > 0xff) return this.divError();
          r[AX] = ((n % d) << 8) | q;
        }
        return;
      }
      case 7: { // IDIV
        if (w) {
          const d = (this.getrm16() << 16) >> 16; if (!d) return this.divError();
          const n = ((r[DX] << 16) | r[AX]) | 0; const q = Math.trunc(n / d);
          if (q > 32767 || q < -32768) return this.divError();
          r[AX] = q & 0xffff; r[DX] = (n - q * d) & 0xffff;
        } else {
          const d = (this.getrm8() << 24) >> 24; if (!d) return this.divError();
          const n = (r[AX] << 16) >> 16; const q = Math.trunc(n / d);
          if (q > 127 || q < -128) return this.divError();
          r[AX] = (((n - q * d) & 0xff) << 8) | (q & 0xff);
        }
        return;
      }
    }
  }

  stringOp(op, rep) {
    const r = this.r, s = this.s;
    const w = op & 1;
    const step = (this.flags & DF ? -1 : 1) * (w ? 2 : 1);
    const src = this.dataSeg();
    const once = () => {
      switch (op) {
        case 0xa4: this.wb(s[ES], r[DI], this.rb(src, r[SI])); r[SI] += step; r[DI] += step; return;
        case 0xa5: this.ww(s[ES], r[DI], this.rw(src, r[SI])); r[SI] += step; r[DI] += step; return;
        case 0xa6: this.alu(7, this.rb(src, r[SI]), this.rb(s[ES], r[DI]), 0); r[SI] += step; r[DI] += step; return;
        case 0xa7: this.alu(7, this.rw(src, r[SI]), this.rw(s[ES], r[DI]), 1); r[SI] += step; r[DI] += step; return;
        case 0xaa: this.wb(s[ES], r[DI], r[AX] & 0xff); r[DI] += step; return;
        case 0xab: this.ww(s[ES], r[DI], r[AX]); r[DI] += step; return;
        case 0xac: this.setr8(0, this.rb(src, r[SI])); r[SI] += step; return;
        case 0xad: r[AX] = this.rw(src, r[SI]); r[SI] += step; return;
        case 0xae: this.alu(7, r[AX] & 0xff, this.rb(s[ES], r[DI]), 0); r[DI] += step; return;
        case 0xaf: this.alu(7, r[AX], this.rw(s[ES], r[DI]), 1); r[DI] += step; return;
        case 0x6c: this.wb(s[ES], r[DI], this.portIn(r[DX], 0)); r[DI] += step; return;
        case 0x6d: this.ww(s[ES], r[DI], this.portIn(r[DX], 1)); r[DI] += step; return;
        case 0x6e: this.portOut(r[DX], this.rb(src, r[SI]), 0); r[SI] += step; return;
        case 0x6f: this.portOut(r[DX], this.rw(src, r[SI]), 1); r[SI] += step; return;
      }
    };
    if (!rep) { once(); return; }
    const cmp = op === 0xa6 || op === 0xa7 || op === 0xae || op === 0xaf;
    while (r[CX]) {
      once();
      r[CX]--;
      if (cmp) {
        const z = (this.flags & ZF) !== 0;
        if (rep === 0xf3 ? !z : z) break;
      }
    }
  }
}
