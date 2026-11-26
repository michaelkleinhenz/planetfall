// A Motorola 68000 core for the Magnetic Scrolls games.
//
// Magnetic Scrolls wrote their adventures in 68000 assembly and ran the same
// program on every computer through a small virtual machine: a 68000 (user
// mode only) plus "A-line" instructions (opcodes $Axxx) that call into the host
// for text, the parser's dictionary search and the noun table, and "F-line"
// instructions ($Fxxx) that print messages. This file is the 68000 part; the
// host side (the A-line and F-line calls) is in machine.js.
//
// Memory is a flat byte array, big-endian like the 68000. Registers hold
// unsigned 32-bit numbers. The condition codes are kept as separate flags.

const MASK = { 1: 0xff, 2: 0xffff, 4: 0xffffffff };
const SIGN = { 1: 0x80, 2: 0x8000, 4: 0x80000000 };
const SIZES = [1, 2, 4];

export class CpuError extends Error {}

// Effective-address "locations" that are not memory addresses.
const LOC_D = -1;      // data register: -1 - reg
const LOC_A = -9;      // address register: -9 - reg
const LOC_IMM = -100;  // immediate value (in cpu.imm)

export class M68k {
  constructor(memory) {
    this.mem = memory;
    this.d = new Array(8).fill(0);
    this.a = new Array(8).fill(0);
    this.pc = 0;
    this.x = 0; this.n = 0; this.z = 0; this.v = 0; this.c = 0;
    this.imm = 0;
    this.lineA = null; // (opcode) => void
    this.lineF = null; // (opcode) => void
    this.count = 0;
    this.wrap = 0; // address mask for 64K story files, or 0
  }

  // ---- registers and flags ---------------------------------------------

  get ccr() { return (this.x << 4) | (this.n << 3) | (this.z << 2) | (this.v << 1) | this.c; }
  set ccr(v) { this.x = (v >> 4) & 1; this.n = (v >> 3) & 1; this.z = (v >> 2) & 1; this.v = (v >> 1) & 1; this.c = v & 1; }

  snapshot() {
    return { d: [...this.d], a: [...this.a], pc: this.pc, ccr: this.ccr };
  }

  restore(s) {
    this.d = [...s.d]; this.a = [...s.a]; this.pc = s.pc; this.ccr = s.ccr;
  }

  // ---- memory -------------------------------------------------------------

  // Addresses: the original 64K story files wrap at 64K (the 16-bit machines'
  // segments); otherwise an address outside memory is an error.
  addr(a, n) {
    if (this.wrap) return a & this.wrap;
    a >>>= 0;
    if (a + n > this.mem.length) throw new CpuError(`Address $${a.toString(16)} out of range (PC=$${(this.opPc ?? 0).toString(16)})`);
    return a;
  }
  r8(a) { return this.mem[this.addr(a, 1)]; }
  r16(a) {
    if (this.wrap) return (this.mem[a & this.wrap] << 8) | this.mem[(a + 1) & this.wrap];
    a = this.addr(a, 2); return (this.mem[a] << 8) | this.mem[a + 1];
  }
  r32(a) { return ((this.r16(a) << 16) | this.r16(a + 2)) >>> 0; }
  w8(a, v) { this.mem[this.addr(a, 1)] = v & 0xff; }
  w16(a, v) {
    if (this.wrap) { this.mem[a & this.wrap] = (v >>> 8) & 0xff; this.mem[(a + 1) & this.wrap] = v & 0xff; return; }
    a = this.addr(a, 2); this.mem[a] = (v >>> 8) & 0xff; this.mem[a + 1] = v & 0xff;
  }
  w32(a, v) { this.w16(a, v >>> 16); this.w16(a + 2, v); }
  read(a, size) { return size === 1 ? this.r8(a) : size === 2 ? this.r16(a) : this.r32(a); }
  write(a, size, v) { if (size === 1) this.w8(a, v); else if (size === 2) this.w16(a, v); else this.w32(a, v); }

  fetch16() { const v = this.r16(this.pc); this.pc = (this.pc + 2) >>> 0; return v; }
  fetch32() { const v = this.r32(this.pc); this.pc = (this.pc + 4) >>> 0; return v; }

  push32(v) { this.a[7] = (this.a[7] - 4) >>> 0; this.w32(this.a[7], v); }
  pop32() { const v = this.r32(this.a[7]); this.a[7] = (this.a[7] + 4) >>> 0; return v; }
  push16(v) { this.a[7] = (this.a[7] - 2) >>> 0; this.w16(this.a[7], v); }
  pop16() { const v = this.r16(this.a[7]); this.a[7] = (this.a[7] + 2) >>> 0; return v; }

  // ---- effective addresses -----------------------------------------------

  /** Brief extension word: d8(An,Xn) / d8(PC,Xn). */
  indexed(base) {
    const ext = this.fetch16();
    const reg = (ext >> 12) & 7;
    let idx = ext & 0x8000 ? this.a[reg] : this.d[reg];
    if (!(ext & 0x800)) idx = sx16(idx);
    else idx |= 0;
    return (base + sx8(ext) + idx) >>> 0;
  }

  /** Resolve an effective address; side effects ((An)+, -(An)) happen here. */
  ea(mode, reg, size) {
    switch (mode) {
      case 0: return LOC_D - reg;
      case 1: return LOC_A - reg;
      case 2: return this.a[reg];
      case 3: {
        const a = this.a[reg];
        this.a[reg] = (a + (reg === 7 && size === 1 ? 2 : size)) >>> 0;
        return a;
      }
      case 4: {
        this.a[reg] = (this.a[reg] - (reg === 7 && size === 1 ? 2 : size)) >>> 0;
        return this.a[reg];
      }
      case 5: { const d = sx16(this.fetch16()); return (this.a[reg] + d) >>> 0; }
      case 6: return this.indexed(this.a[reg]);
      case 7:
        switch (reg) {
          case 0: return sx16(this.fetch16()) >>> 0;
          case 1: return this.fetch32();
          case 2: { const base = this.pc; return (base + sx16(this.fetch16())) >>> 0; }
          case 3: { const base = this.pc; return this.indexed(base); }
          case 4:
            if (size === 4) this.imm = this.fetch32();
            else this.imm = this.fetch16() & MASK[size];
            return LOC_IMM;
        }
    }
    throw new CpuError(`Bad addressing mode ${mode}/${reg} at $${this.pc.toString(16)}`);
  }

  get(loc, size) {
    if (loc >= 0) return this.read(loc, size);
    if (loc === LOC_IMM) return this.imm & MASK[size];
    if (loc > LOC_A) return this.d[LOC_D - loc] & MASK[size];
    return this.a[LOC_A - loc] & MASK[size];
  }

  set(loc, size, v) {
    v &= MASK[size];
    if (loc >= 0) { this.write(loc, size, v); return; }
    if (loc > LOC_A) {
      const r = LOC_D - loc;
      if (size === 4) this.d[r] = v >>> 0;
      else this.d[r] = ((this.d[r] & ~MASK[size]) | v) >>> 0;
      return;
    }
    if (loc === LOC_IMM) throw new CpuError('Write to an immediate operand');
    // Address registers are always written whole (word values sign-extended).
    this.a[LOC_A - loc] = size === 2 ? sx16(v) >>> 0 : v >>> 0;
  }

  // ---- flags ---------------------------------------------------------------

  logic(r, size) {
    r &= MASK[size];
    this.n = r & SIGN[size] ? 1 : 0; this.z = r === 0 ? 1 : 0; this.v = 0; this.c = 0;
    return r;
  }

  add(s, d, size, x = 0, keepZ = false) {
    const m = MASK[size], sg = SIGN[size];
    const sum = (s & m) + (d & m) + x;
    const r = sum & m;
    this.c = this.x = sum > m ? 1 : 0;
    this.v = ((~(s ^ d)) & (s ^ r) & sg) ? 1 : 0;
    this.n = r & sg ? 1 : 0;
    if (keepZ) { if (r !== 0) this.z = 0; } else this.z = r === 0 ? 1 : 0;
    return r >>> 0;
  }

  sub(s, d, size, x = 0, keepZ = false, setX = true) {
    const m = MASK[size], sg = SIGN[size];
    s &= m; d &= m;
    const diff = d - s - x;
    const r = (diff & m) >>> 0;
    const borrow = diff < 0 ? 1 : 0;
    this.c = borrow; if (setX) this.x = borrow;
    this.v = ((s ^ d) & (d ^ r) & sg) ? 1 : 0;
    this.n = r & sg ? 1 : 0;
    if (keepZ) { if (r !== 0) this.z = 0; } else this.z = r === 0 ? 1 : 0;
    return r;
  }

  cmp(s, d, size) { this.sub(s, d, size, 0, false, false); }

  cond(cc) {
    switch (cc) {
      case 0: return true;
      case 1: return false;
      case 2: return !this.c && !this.z;      // HI
      case 3: return !!(this.c || this.z);    // LS
      case 4: return !this.c;                 // CC
      case 5: return !!this.c;                // CS
      case 6: return !this.z;                 // NE
      case 7: return !!this.z;                // EQ
      case 8: return !this.v;                 // VC
      case 9: return !!this.v;                // VS
      case 10: return !this.n;                // PL
      case 11: return !!this.n;               // MI
      case 12: return this.n === this.v;      // GE
      case 13: return this.n !== this.v;      // LT
      case 14: return !this.z && this.n === this.v; // GT
      case 15: return !!this.z || this.n !== this.v; // LE
    }
    return false;
  }

  // ---- execution -----------------------------------------------------------

  /** Run until `stop()` returns true (checked after every instruction). */
  run(stop) {
    for (;;) {
      this.step();
      if (stop()) return;
    }
  }

  step() {
    this.count++;
    this.opPc = this.pc;
    const op = this.fetch16();
    switch (op >>> 12) {
      case 0: return this.group0(op);
      case 1: return this.move(op, 1);
      case 2: return this.move(op, 4);
      case 3: return this.move(op, 2);
      case 4: return this.group4(op);
      case 5: return this.group5(op);
      case 6: return this.branch(op);
      case 7: {
        if (op & 0x100) return this.illegal(op);
        const v = sx8(op) >>> 0;
        this.d[(op >> 9) & 7] = v;
        this.logic(v, 4);
        return;
      }
      case 8: return this.group8(op);
      case 9: return this.addSub(op, false);
      case 10: return this.aline(op);
      case 11: return this.groupB(op);
      case 12: return this.groupC(op);
      case 13: return this.addSub(op, true);
      case 14: return this.shift(op);
      case 15:
        if (!this.lineF) return this.illegal(op);
        return this.lineF(op);
    }
  }

  illegal(op) {
    throw new CpuError(`Illegal instruction $${op.toString(16).padStart(4, '0')} at $${this.opPc.toString(16)}`);
  }

  // A-line: the Magnetic Scrolls "bespoke" opcodes are 68000 instructions with
  // their first byte replaced (RET, CALL, TEST, PUSH, PULL); the others ($A0xx)
  // are calls into the host.
  aline(op) {
    switch (op >>> 8) {
      case 0xa2: { this.pc = this.pop32(); return; } // RET = RTS
      case 0xa4: return this.branch(0x6100 | (op & 0xff)); // CALL = BSR
      case 0xa6: return this.group4(0x4a00 | (op & 0xff)); // TEST = TST
      case 0xa8: return this.group4(0x4800 | (op & 0xff)); // PUSH = MOVEM regs,-(A7)
      case 0xaa: return this.group4(0x4c00 | (op & 0xff)); // PULL = MOVEM (A7)+,regs
    }
    if (!this.lineA) return this.illegal(op);
    return this.lineA(op);
  }

  move(op, size) {
    const src = this.ea((op >> 3) & 7, op & 7, size);
    const v = this.get(src, size);
    const dmode = (op >> 6) & 7, dreg = (op >> 9) & 7;
    if (dmode === 1) { // MOVEA
      this.a[dreg] = size === 2 ? sx16(v) >>> 0 : v >>> 0;
      return;
    }
    const dst = this.ea(dmode, dreg, size);
    this.set(dst, size, v);
    this.logic(v, size);
  }

  branch(op) {
    const cc = (op >> 8) & 15;
    let disp = op & 0xff;
    const base = this.pc;
    if (disp === 0) disp = sx16(this.fetch16());
    else disp = sx8(disp);
    const target = (base + disp) >>> 0;
    if (cc === 1) { this.push32(this.pc); this.pc = target; return; } // BSR
    if (this.cond(cc)) this.pc = target;
  }

  // ---- group 0: immediate and bit operations ------------------------------

  group0(op) {
    const mode = (op >> 3) & 7, reg = op & 7;
    if (op & 0x100) {
      if (mode === 1) return this.illegal(op); // MOVEP: not used
      return this.bitOp(op, this.d[(op >> 9) & 7]);
    }
    const kind = (op >> 9) & 7;
    if (kind === 4) return this.bitOp(op, this.fetch16() & 0xff);
    const sz = (op >> 6) & 3;
    if (sz === 3) return this.illegal(op);
    const size = SIZES[sz];
    const imm = size === 4 ? this.fetch32() : this.fetch16() & MASK[size];
    // ORI/ANDI/EORI to CCR or SR.
    if (mode === 7 && reg === 4 && (kind === 0 || kind === 1 || kind === 5)) {
      const ccr = this.ccr;
      this.ccr = kind === 0 ? ccr | imm : kind === 1 ? ccr & imm : ccr ^ imm;
      return;
    }
    const loc = this.ea(mode, reg, size);
    const d = this.get(loc, size);
    switch (kind) {
      case 0: this.set(loc, size, this.logic(d | imm, size)); return;
      case 1: this.set(loc, size, this.logic(d & imm, size)); return;
      case 2: this.set(loc, size, this.sub(imm, d, size)); return;
      case 3: this.set(loc, size, this.add(imm, d, size)); return;
      case 5: this.set(loc, size, this.logic(d ^ imm, size)); return;
      case 6: this.cmp(imm, d, size); return;
    }
    return this.illegal(op);
  }

  bitOp(op, bit) {
    const mode = (op >> 3) & 7, reg = op & 7;
    const kind = (op >> 6) & 3; // BTST, BCHG, BCLR, BSET
    if (mode === 0) {
      bit &= 31;
      const v = this.d[reg];
      this.z = (v >>> bit) & 1 ? 0 : 1;
      if (kind === 1) this.d[reg] = (v ^ (1 << bit)) >>> 0;
      else if (kind === 2) this.d[reg] = (v & ~(1 << bit)) >>> 0;
      else if (kind === 3) this.d[reg] = (v | (1 << bit)) >>> 0;
      return;
    }
    bit &= 7;
    const loc = this.ea(mode, reg, 1);
    const v = this.get(loc, 1);
    this.z = (v >> bit) & 1 ? 0 : 1;
    if (kind === 1) this.set(loc, 1, v ^ (1 << bit));
    else if (kind === 2) this.set(loc, 1, v & ~(1 << bit));
    else if (kind === 3) this.set(loc, 1, v | (1 << bit));
  }

  // ---- group 4: miscellaneous ---------------------------------------------

  group4(op) {
    const mode = (op >> 3) & 7, reg = op & 7;
    if (op & 0x100) {
      if (((op >> 6) & 7) === 7) { // LEA
        this.a[(op >> 9) & 7] = this.ea(mode, reg, 4) >>> 0;
        return;
      }
      if (((op >> 6) & 7) === 6) { // CHK.W
        const bound = sx16(this.get(this.ea(mode, reg, 2), 2));
        const v = sx16(this.d[(op >> 9) & 7]);
        if (v < 0 || v > bound) throw new CpuError(`CHK failed at $${this.opPc.toString(16)}`);
        return;
      }
      return this.illegal(op);
    }
    const sz = (op >> 6) & 3;
    switch ((op >> 8) & 15) {
      case 0: { // NEGX / MOVE from SR
        if (sz === 3) { this.set(this.ea(mode, reg, 2), 2, this.ccr); return; }
        const size = SIZES[sz]; const loc = this.ea(mode, reg, size);
        this.set(loc, size, this.sub(this.get(loc, size), 0, size, this.x, true));
        return;
      }
      case 2: { // CLR
        if (sz === 3) return this.illegal(op);
        const size = SIZES[sz];
        this.set(this.ea(mode, reg, size), size, 0);
        this.n = 0; this.z = 1; this.v = 0; this.c = 0;
        return;
      }
      case 4: { // NEG / MOVE to CCR
        if (sz === 3) { this.ccr = this.get(this.ea(mode, reg, 2), 2) & 0x1f; return; }
        const size = SIZES[sz]; const loc = this.ea(mode, reg, size);
        this.set(loc, size, this.sub(this.get(loc, size), 0, size));
        return;
      }
      case 6: { // NOT / MOVE to SR
        if (sz === 3) { this.ccr = this.get(this.ea(mode, reg, 2), 2) & 0x1f; return; }
        const size = SIZES[sz]; const loc = this.ea(mode, reg, size);
        this.set(loc, size, this.logic(~this.get(loc, size), size));
        return;
      }
      case 8: {
        if (sz === 0) return this.illegal(op); // NBCD: not used
        if (sz === 1) {
          if (mode === 0) { // SWAP
            const v = this.d[reg];
            this.d[reg] = ((v >>> 16) | (v << 16)) >>> 0;
            this.logic(this.d[reg], 4);
            return;
          }
          this.push32(this.ea(mode, reg, 4)); // PEA
          return;
        }
        if (mode === 0) { // EXT
          if (sz === 2) { const v = sx8(this.d[reg]) & 0xffff; this.set(LOC_D - reg, 2, v); this.logic(v, 2); }
          else { const v = sx16(this.d[reg]) >>> 0; this.d[reg] = v; this.logic(v, 4); }
          return;
        }
        return this.movem(op, true);
      }
      case 10: { // TST / TAS / ILLEGAL
        if (sz === 3) {
          if (op === 0x4afc) return this.illegal(op);
          const loc = this.ea(mode, reg, 1); const v = this.get(loc, 1);
          this.logic(v, 1); this.set(loc, 1, v | 0x80);
          return;
        }
        const size = SIZES[sz];
        this.logic(this.get(this.ea(mode, reg, size), size), size);
        return;
      }
      case 12: return this.movem(op, false);
      case 14: return this.group4e(op);
    }
    return this.illegal(op);
  }

  group4e(op) {
    const mode = (op >> 3) & 7, reg = op & 7;
    switch ((op >> 6) & 3) {
      case 1:
        if (op === 0x4e71) return; // NOP
        if (op === 0x4e75) { this.pc = this.pop32(); return; } // RTS
        if (op === 0x4e77) { this.ccr = this.pop16() & 0x1f; this.pc = this.pop32(); return; } // RTR
        if ((op & 0xfff8) === 0x4e50) { // LINK
          const d = sx16(this.fetch16());
          this.push32(this.a[reg]);
          this.a[reg] = this.a[7];
          this.a[7] = (this.a[7] + d) >>> 0;
          return;
        }
        if ((op & 0xfff8) === 0x4e58) { // UNLK
          this.a[7] = this.a[reg];
          this.a[reg] = this.pop32();
          return;
        }
        return this.illegal(op);
      case 2: { const t = this.ea(mode, reg, 4); this.push32(this.pc); this.pc = t; return; } // JSR
      case 3: { this.pc = this.ea(mode, reg, 4); return; } // JMP
    }
    return this.illegal(op);
  }

  movem(op, toMemory) {
    const size = op & 0x40 ? 4 : 2;
    const mask = this.fetch16();
    const mode = (op >> 3) & 7, reg = op & 7;
    const regs = (i) => (i < 8 ? this.d : this.a);
    if (toMemory) {
      if (mode === 4) { // -(An): mask is reversed (bit 0 = A7)
        let addr = this.a[reg];
        for (let i = 15; i >= 0; i--) {
          if (!(mask & (1 << (15 - i)))) continue;
          addr = (addr - size) >>> 0;
          this.write(addr, size, regs(i)[i & 7]);
        }
        this.a[reg] = addr;
        return;
      }
      let addr = this.ea(mode, reg, size);
      for (let i = 0; i < 16; i++) {
        if (!(mask & (1 << i))) continue;
        this.write(addr, size, regs(i)[i & 7]);
        addr = (addr + size) >>> 0;
      }
      return;
    }
    let addr = mode === 3 ? this.a[reg] : this.ea(mode, reg, size);
    for (let i = 0; i < 16; i++) {
      if (!(mask & (1 << i))) continue;
      let v = this.read(addr, size);
      if (size === 2) v = sx16(v) >>> 0;
      regs(i)[i & 7] = v >>> 0;
      addr = (addr + size) >>> 0;
    }
    if (mode === 3) this.a[reg] = addr;
  }

  // ---- group 5: ADDQ, SUBQ, Scc, DBcc -------------------------------------

  group5(op) {
    const mode = (op >> 3) & 7, reg = op & 7;
    const sz = (op >> 6) & 3;
    if (sz === 3) {
      const cc = (op >> 8) & 15;
      if (mode === 1) { // DBcc
        const base = this.pc;
        const disp = sx16(this.fetch16());
        if (this.cond(cc)) return;
        const v = ((this.d[reg] & 0xffff) - 1) & 0xffff;
        this.d[reg] = ((this.d[reg] & 0xffff0000) | v) >>> 0;
        if (v !== 0xffff) this.pc = (base + disp) >>> 0;
        return;
      }
      this.set(this.ea(mode, reg, 1), 1, this.cond(cc) ? 0xff : 0); // Scc
      return;
    }
    const size = SIZES[sz];
    let q = (op >> 9) & 7; if (q === 0) q = 8;
    if (mode === 1) { // address register: whole register, no flags
      this.a[reg] = (op & 0x100 ? this.a[reg] - q : this.a[reg] + q) >>> 0;
      return;
    }
    const loc = this.ea(mode, reg, size);
    const d = this.get(loc, size);
    this.set(loc, size, op & 0x100 ? this.sub(q, d, size) : this.add(q, d, size));
  }

  // ---- group 8: OR, DIVU, DIVS --------------------------------------------

  group8(op) {
    const mode = (op >> 3) & 7, reg = op & 7, dn = (op >> 9) & 7;
    const opmode = (op >> 6) & 7;
    if (opmode === 3 || opmode === 7) { // DIVU / DIVS
      const s = this.get(this.ea(mode, reg, 2), 2);
      if (s === 0) throw new CpuError(`Division by zero at $${this.opPc.toString(16)}`);
      let q, r;
      if (opmode === 3) { q = Math.floor(this.d[dn] / s); r = this.d[dn] % s; if (q > 0xffff) { this.v = 1; this.c = 0; return; } }
      else {
        const dv = this.d[dn] | 0, sv = sx16(s);
        q = Math.trunc(dv / sv); r = dv - q * sv;
        if (q > 32767 || q < -32768) { this.v = 1; this.c = 0; return; }
      }
      this.d[dn] = (((r & 0xffff) << 16) | (q & 0xffff)) >>> 0;
      this.n = q & 0x8000 ? 1 : 0; this.z = (q & 0xffff) === 0 ? 1 : 0; this.v = 0; this.c = 0;
      return;
    }
    if ((op & 0x1f0) === 0x100) return this.illegal(op); // SBCD: not used
    const size = SIZES[opmode & 3];
    if (opmode < 4) {
      const v = this.get(this.ea(mode, reg, size), size);
      this.set(LOC_D - dn, size, this.logic(this.d[dn] | v, size));
    } else {
      const loc = this.ea(mode, reg, size);
      this.set(loc, size, this.logic(this.get(loc, size) | this.d[dn], size));
    }
  }

  // ---- ADD / SUB (groups 9 and D) -----------------------------------------

  addSub(op, isAdd) {
    const mode = (op >> 3) & 7, reg = op & 7, rn = (op >> 9) & 7;
    const opmode = (op >> 6) & 7;
    if (opmode === 3 || opmode === 7) { // ADDA / SUBA
      const size = opmode === 3 ? 2 : 4;
      let v = this.get(this.ea(mode, reg, size), size);
      if (size === 2) v = sx16(v);
      this.a[rn] = (isAdd ? this.a[rn] + v : this.a[rn] - v) >>> 0;
      return;
    }
    const size = SIZES[opmode & 3];
    if (opmode >= 4 && mode <= 1) { // ADDX / SUBX
      if (mode === 0) {
        const r = isAdd ? this.add(this.d[reg], this.d[rn], size, this.x, true) : this.sub(this.d[reg], this.d[rn], size, this.x, true);
        this.set(LOC_D - rn, size, r);
      } else {
        const s = this.get(this.ea(4, reg, size), size);
        const dl = this.ea(4, rn, size);
        const d = this.get(dl, size);
        this.set(dl, size, isAdd ? this.add(s, d, size, this.x, true) : this.sub(s, d, size, this.x, true));
      }
      return;
    }
    if (opmode < 4) {
      const s = this.get(this.ea(mode, reg, size), size);
      const d = this.d[rn];
      this.set(LOC_D - rn, size, isAdd ? this.add(s, d, size) : this.sub(s, d, size));
    } else {
      const loc = this.ea(mode, reg, size);
      const d = this.get(loc, size);
      const s = this.d[rn];
      this.set(loc, size, isAdd ? this.add(s, d, size) : this.sub(s, d, size));
    }
  }

  // ---- group B: CMP, CMPA, CMPM, EOR --------------------------------------

  groupB(op) {
    const mode = (op >> 3) & 7, reg = op & 7, rn = (op >> 9) & 7;
    const opmode = (op >> 6) & 7;
    if (opmode === 3 || opmode === 7) { // CMPA
      const size = opmode === 3 ? 2 : 4;
      let v = this.get(this.ea(mode, reg, size), size);
      if (size === 2) v = sx16(v) >>> 0;
      this.cmp(v, this.a[rn], 4);
      return;
    }
    const size = SIZES[opmode & 3];
    if (opmode < 4) { this.cmp(this.get(this.ea(mode, reg, size), size), this.d[rn], size); return; }
    if (mode === 1) { // CMPM (Ay)+,(Ax)+
      const s = this.get(this.ea(3, reg, size), size);
      const d = this.get(this.ea(3, rn, size), size);
      this.cmp(s, d, size);
      return;
    }
    const loc = this.ea(mode, reg, size);
    this.set(loc, size, this.logic(this.get(loc, size) ^ this.d[rn], size)); // EOR
  }

  // ---- group C: AND, MULU, MULS, EXG --------------------------------------

  groupC(op) {
    const mode = (op >> 3) & 7, reg = op & 7, rn = (op >> 9) & 7;
    const opmode = (op >> 6) & 7;
    if (opmode === 3) { // MULU
      const r = ((this.d[rn] & 0xffff) * this.get(this.ea(mode, reg, 2), 2)) >>> 0;
      this.d[rn] = r; this.logic(r, 4);
      return;
    }
    if (opmode === 7) { // MULS
      const r = (Math.imul(sx16(this.d[rn]), sx16(this.get(this.ea(mode, reg, 2), 2)))) >>> 0;
      this.d[rn] = r; this.logic(r, 4);
      return;
    }
    if ((op & 0x1f0) === 0x100) return this.illegal(op); // ABCD: not used
    if ((op & 0x1f8) === 0x140) { const t = this.d[rn]; this.d[rn] = this.d[reg]; this.d[reg] = t; return; }
    if ((op & 0x1f8) === 0x148) { const t = this.a[rn]; this.a[rn] = this.a[reg]; this.a[reg] = t; return; }
    if ((op & 0x1f8) === 0x188) { const t = this.d[rn]; this.d[rn] = this.a[reg]; this.a[reg] = t; return; }
    const size = SIZES[opmode & 3];
    if (opmode < 4) {
      const v = this.get(this.ea(mode, reg, size), size);
      this.set(LOC_D - rn, size, this.logic(this.d[rn] & v, size));
    } else {
      const loc = this.ea(mode, reg, size);
      this.set(loc, size, this.logic(this.get(loc, size) & this.d[rn], size));
    }
  }

  // ---- group E: shifts and rotates ----------------------------------------

  shift(op) {
    const sz = (op >> 6) & 3;
    let size, count, loc, kind, left = !!(op & 0x100);
    if (sz === 3) { // memory, by one
      size = 2; count = 1; kind = (op >> 9) & 3;
      loc = this.ea((op >> 3) & 7, op & 7, 2);
    } else {
      size = SIZES[sz]; kind = (op >> 3) & 3;
      const c = (op >> 9) & 7;
      count = op & 0x20 ? this.d[c] & 63 : c === 0 ? 8 : c;
      loc = LOC_D - (op & 7);
    }
    const m = MASK[size], sg = SIGN[size], bits = size * 8;
    let v = this.get(loc, size);
    let carry = 0, overflow = 0;
    switch (kind) {
      case 0: // ASL / ASR
        if (left) {
          for (let i = 0; i < count; i++) {
            carry = v & sg ? 1 : 0;
            const nv = (v << 1) & m;
            if ((nv & sg) !== (v & sg)) overflow = 1;
            v = nv >>> 0;
          }
        } else {
          for (let i = 0; i < count; i++) {
            carry = v & 1;
            v = ((v >>> 1) | (v & sg)) >>> 0;
          }
        }
        if (count) { this.x = carry; this.c = carry; } else this.c = 0;
        this.v = overflow;
        break;
      case 1: // LSL / LSR
        for (let i = 0; i < count; i++) {
          if (left) { carry = v & sg ? 1 : 0; v = ((v << 1) & m) >>> 0; }
          else { carry = v & 1; v = v >>> 1; }
        }
        if (count) { this.x = carry; this.c = carry; } else this.c = 0;
        this.v = 0;
        break;
      case 2: // ROXL / ROXR
        for (let i = 0; i < count; i++) {
          if (left) { carry = v & sg ? 1 : 0; v = (((v << 1) | this.x) & m) >>> 0; }
          else { carry = v & 1; v = ((v >>> 1) | (this.x ? sg : 0)) >>> 0; }
          this.x = carry;
        }
        this.c = this.x; this.v = 0;
        break;
      case 3: // ROL / ROR
        for (let i = 0; i < count; i++) {
          if (left) { carry = v & sg ? 1 : 0; v = (((v << 1) | carry) & m) >>> 0; }
          else { carry = v & 1; v = ((v >>> 1) | (carry ? sg : 0)) >>> 0; }
        }
        this.c = count ? carry : 0; this.v = 0;
        break;
    }
    v &= m;
    this.n = v & sg ? 1 : 0; this.z = v === 0 ? 1 : 0;
    this.set(loc, size, v);
    void bits;
  }
}

export function sx8(v) { v &= 0xff; return v & 0x80 ? v - 0x100 : v; }
export function sx16(v) { v &= 0xffff; return v & 0x8000 ? v - 0x10000 : v; }
