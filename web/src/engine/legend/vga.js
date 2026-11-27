// The VGA's 16-colour planar graphics (mode 12h, 640x480), as much of it as
// Legend's games use: four bit planes behind the A000 window, the sequencer's
// map mask, the graphics controller (set/reset, rotate and logic function,
// read map, write modes 0-3, read modes 0-1, bit mask, latches), the
// attribute controller's palette and the DAC.
//
// The game draws its full-screen views (the PV commset, the DataMan) with its
// own code and fonts, straight into video memory; the app shows them as a
// picture of the screen.

const PLANE = 0x10000;

// The default 16-colour palette (attribute registers) and the DAC's first 64
// entries as the BIOS sets them for the 16-colour modes.
const ATTR_DEFAULT = [0, 1, 2, 3, 4, 5, 0x14, 7, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f];
const egaDac = (v) => {
  const c = (hi, lo) => ((v >> hi) & 1) * 42 + ((v >> lo) & 1) * 21;
  return [c(2, 5), c(1, 4), c(0, 3)];
};

export class Vga {
  constructor() {
    this.planes = [0, 1, 2, 3].map(() => new Uint8Array(PLANE));
    this.latch = new Uint8Array(4);
    this.seq = new Uint8Array(8);
    this.gc = new Uint8Array(16);
    this.attr = new Uint8Array(0x20);
    this.dac = new Uint8Array(256 * 3);
    this.reset();
  }

  reset() {
    for (const p of this.planes) p.fill(0);
    this.seq.fill(0); this.seq[2] = 0x0f;
    this.gc.fill(0); this.gc[8] = 0xff; this.gc[7] = 0x0f;
    this.attr.fill(0); ATTR_DEFAULT.forEach((v, i) => { this.attr[i] = v; }); this.attr[0x12] = 0x0f;
    for (let i = 0; i < 64; i++) this.dac.set(egaDac(i), i * 3);
    this.seqIndex = 0; this.gcIndex = 0; this.attrIndex = 0; this.attrFlip = false;
    this.dacWrite = 0; this.dacRead = 0; this.dacPart = 0;
    this.dirty = true;
  }

  // ---- memory --------------------------------------------------------------------
  read(off) {
    const l = this.latch;
    for (let i = 0; i < 4; i++) l[i] = this.planes[i][off];
    if (this.gc[5] & 8) {
      // Read mode 1: which of the 8 pixels match the colour compare register.
      const cmp = this.gc[2], care = this.gc[7];
      let v = 0xff;
      for (let i = 0; i < 4; i++) if (care & (1 << i)) v &= (cmp & (1 << i)) ? l[i] : ~l[i];
      return v & 0xff;
    }
    return l[this.gc[4] & 3];
  }

  write(off, value) {
    const gc = this.gc, l = this.latch, mode = gc[5] & 3;
    const mapMask = this.seq[2];
    let mask = gc[8];
    const rot = gc[3] & 7, fn = (gc[3] >> 3) & 3;
    let v = rot ? ((value >> rot) | (value << (8 - rot))) & 0xff : value;
    for (let i = 0; i < 4; i++) {
      if (!(mapMask & (1 << i))) continue;
      let d;
      if (mode === 1) { this.planes[i][off] = l[i]; continue; }
      if (mode === 0) d = (gc[1] & (1 << i)) ? ((gc[0] & (1 << i)) ? 0xff : 0) : v;
      else if (mode === 2) d = (value & (1 << i)) ? 0xff : 0;
      else d = (gc[0] & (1 << i)) ? 0xff : 0;
      const m = mode === 3 ? (mask & v) : mask;
      if (fn === 1) d &= l[i]; else if (fn === 2) d |= l[i]; else if (fn === 3) d ^= l[i];
      this.planes[i][off] = (d & m) | (l[i] & ~m & 0xff);
    }
    this.dirty = true;
  }

  // ---- ports -----------------------------------------------------------------------
  portOut(p, v) {
    switch (p) {
      case 0x3c4: this.seqIndex = v & 7; return true;
      case 0x3c5: this.seq[this.seqIndex] = v; return true;
      case 0x3ce: this.gcIndex = v & 15; return true;
      case 0x3cf: this.gc[this.gcIndex] = v; return true;
      case 0x3c0:
        if (!this.attrFlip) this.attrIndex = v & 0x1f;
        else { this.attr[this.attrIndex] = v; this.dirty = true; }
        this.attrFlip = !this.attrFlip;
        return true;
      case 0x3c8: this.dacWrite = v; this.dacPart = 0; return true;
      case 0x3c7: this.dacRead = v; this.dacPart = 0; return true;
      case 0x3c9:
        this.dac[this.dacWrite * 3 + this.dacPart] = v & 63;
        if (++this.dacPart === 3) { this.dacPart = 0; this.dacWrite = (this.dacWrite + 1) & 255; }
        this.dirty = true;
        return true;
    }
    return false;
  }

  portIn(p) {
    switch (p) {
      case 0x3c5: return this.seq[this.seqIndex];
      case 0x3cf: return this.gc[this.gcIndex];
      case 0x3c1: return this.attr[this.attrIndex];
      case 0x3c9: {
        const v = this.dac[this.dacRead * 3 + this.dacPart];
        if (++this.dacPart === 3) { this.dacPart = 0; this.dacRead = (this.dacRead + 1) & 255; }
        return v;
      }
    }
    return null;
  }

  // ---- the BIOS's palette calls (INT 10h AH=10h) --------------------------------------
  /** Returns false for a call it does not handle. */
  bios(al, bx, cx, dx, es, mem) {
    switch (al) {
      case 0x00: this.attr[bx & 0x1f] = bx >> 8; break;
      case 0x01: this.attr[0x11] = bx >> 8; break;
      case 0x02: for (let i = 0; i < 17; i++) this.attr[i === 16 ? 0x11 : i] = mem[((es << 4) + dx + i) & 0xfffff]; break;
      case 0x10: { const n = bx & 0xff; this.dac[n * 3] = (dx >> 8) & 63; this.dac[n * 3 + 1] = (cx >> 8) & 63; this.dac[n * 3 + 2] = cx & 63; break; }
      case 0x12: for (let i = 0; i < cx * 3; i++) this.dac[((bx & 0xff) * 3 + i) % 768] = mem[((es << 4) + dx + i) & 0xfffff] & 63; break;
      default: return false;
    }
    this.dirty = true;
    return true;
  }

  /** The palette as [r, g, b] for colours 0-15 (8 bits each). */
  palette() {
    const out = [];
    const colourSelect = this.attr[0x14] & 0x0f;
    for (let i = 0; i < 16; i++) {
      let n = this.attr[i] & 0x3f;
      if (this.attr[0x10] & 0x80) n = (n & 0x0f) | ((colourSelect & 3) << 4);
      n |= (colourSelect & 0x0c) << 4;
      out.push([0, 1, 2].map((k) => Math.round(this.dac[n * 3 + k] * 255 / 63)));
    }
    return out;
  }

  /** The screen (640x480) as colour numbers. */
  pixels(width = 640, height = 480) {
    const out = new Uint8Array(width * height);
    const [p0, p1, p2, p3] = this.planes;
    const stride = width >> 3;
    for (let y = 0; y < height; y++) {
      for (let xb = 0; xb < stride; xb++) {
        const a = y * stride + xb;
        const b0 = p0[a], b1 = p1[a], b2 = p2[a], b3 = p3[a];
        const o = y * width + xb * 8;
        for (let bit = 0; bit < 8; bit++) {
          const s = 7 - bit;
          out[o + bit] = ((b0 >> s) & 1) | (((b1 >> s) & 1) << 1) | (((b2 >> s) & 1) << 2) | (((b3 >> s) & 1) << 3);
        }
      }
    }
    return out;
  }

  snapshot() {
    return {
      planes: this.planes.map((p) => p.slice()), latch: Array.from(this.latch),
      seq: Array.from(this.seq), gc: Array.from(this.gc), attr: Array.from(this.attr), dac: Array.from(this.dac),
      seqIndex: this.seqIndex, gcIndex: this.gcIndex, attrIndex: this.attrIndex, attrFlip: this.attrFlip,
      dacWrite: this.dacWrite, dacRead: this.dacRead, dacPart: this.dacPart,
    };
  }

  restore(s) {
    s.planes.forEach((p, i) => this.planes[i].set(p));
    this.latch.set(s.latch); this.seq.set(s.seq); this.gc.set(s.gc); this.attr.set(s.attr); this.dac.set(s.dac);
    Object.assign(this, {
      seqIndex: s.seqIndex, gcIndex: s.gcIndex, attrIndex: s.attrIndex, attrFlip: s.attrFlip,
      dacWrite: s.dacWrite, dacRead: s.dacRead, dacPart: s.dacPart,
    });
    this.dirty = true;
  }
}
