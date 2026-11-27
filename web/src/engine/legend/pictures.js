// Decodes the pictures of Legend Entertainment's games (Gateway generation:
// GATE_nnn.PIC files).
//
// A PIC file starts with a directory of 12-byte entries (u32 file offset,
// u8 frame count, u8 flags, u16 width, u16 height, 2 unknown bytes); the
// lowest offset is the directory's size. An entry holds 4 bytes per frame
// (positions), then a palette when flag 0x10 is set (16, 48 or 768 bytes by
// display class, the low nibble of the flags), then the pixels as a PKWARE
// DCL "implode" stream. Rows are padded to whole bytes; 4-bit pixels have the
// left pixel in the low nibble. Flag 0x40 marks an XOR overlay: a change
// drawn onto the picture before it (an open drawer, an animation frame).
//
// Formats as documented by the gateway-port project's notes (file layouts
// only; this is an independent implementation).

// ---- PKWARE DCL "explode" (after zlib's contrib/blast) ------------------------

function construct(rep) {
  const length = [];
  for (const r of rep) { const n = (r >> 4) + 1; for (let i = 0; i < n; i++) length.push(r & 15); }
  const count = new Array(14).fill(0);
  for (const l of length) count[l]++;
  const offs = new Array(14).fill(0);
  for (let i = 1; i < 13; i++) offs[i + 1] = offs[i] + count[i];
  const sym = new Array(length.length).fill(0);
  length.forEach((l, s) => { if (l) sym[offs[l]++] = s; });
  return { count, sym };
}
const LIT = construct([11, 124, 8, 7, 28, 7, 188, 13, 76, 4, 10, 8, 12, 10, 12, 10, 8, 23, 8, 9, 7, 6, 7, 8, 7, 6, 55, 8, 23, 24, 12, 11, 7, 9, 11, 12, 6, 7, 22, 5, 7, 24, 6, 11, 9, 6, 7, 22, 7, 11, 38, 7, 9, 8, 25, 11, 8, 11, 9, 12, 8, 12, 5, 38, 5, 38, 5, 11, 7, 5, 6, 21, 6, 10, 53, 8, 7, 24, 10, 27, 44, 253, 253, 253, 252, 252, 252, 13, 12, 45, 12, 45, 12, 61, 12, 45, 44, 173]);
const LEN = construct([2, 35, 36, 53, 38, 23]);
const DIST = construct([2, 20, 53, 230, 247, 151, 248]);
const BASE = [3, 2, 4, 5, 6, 7, 8, 9, 10, 12, 16, 24, 40, 72, 136, 264];
const EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8];

/** Explode a DCL stream starting at pos; returns at most `limit` bytes. */
export function explode(b, pos, limit) {
  let bitbuf = 0, bitcnt = 0, p = pos;
  const bits = (need) => {
    let val = bitbuf;
    while (bitcnt < need) { if (p >= b.length) throw new Error('Picture data ends early'); val |= b[p++] << bitcnt; bitcnt += 8; }
    bitbuf = val >> need; bitcnt -= need;
    return val & ((1 << need) - 1);
  };
  const decode = ({ count, sym }) => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 14; len++) {
      code |= bits(1) ^ 1;
      const c = count[len];
      if (code < first + c) return sym[index + (code - first)];
      index += c; first += c; first <<= 1; code <<= 1;
    }
    throw new Error('Bad picture data');
  };
  const lit = bits(8), dict = bits(8);
  if (lit > 1 || dict < 4 || dict > 6) throw new Error('Bad picture data');
  const out = new Uint8Array(limit);
  let n = 0;
  while (n < limit) {
    if (bits(1)) {
      const s = decode(LEN);
      const len = BASE[s] + bits(EXTRA[s]);
      if (len === 519) break;
      const db = len === 2 ? 2 : dict;
      const dist = (decode(DIST) << db) + bits(db) + 1;
      for (let i = 0; i < len && n < limit; i++, n++) out[n] = out[n - dist];
    } else out[n++] = lit ? decode(LIT) : bits(8);
  }
  return out;
}

// ---- PIC files --------------------------------------------------------------------

const PALETTE_SIZE = [0, 16, 48, 768, 48];

// The standard EGA colours, for pictures without a palette of their own.
const EGA = [0, 1, 2, 3, 4, 5, 20, 7, 56, 57, 58, 59, 60, 61, 62, 63];
const egaColour = (v) => {
  const c = (hi, lo) => ((v >> hi) & 1) * 0xaa + ((v >> lo) & 1) * 0x55;
  return [c(2, 5), c(1, 4), c(0, 3)];
};

export class PicFile {
  constructor(bytes, series) {
    this.bytes = bytes;
    this.series = series; // hundreds digit of the file number: 3 = 8-bit pixels
    const u32 = (o) => (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;
    const u16 = (o) => bytes[o] | (bytes[o + 1] << 8);
    let end = bytes.length;
    this.entries = [];
    for (let o = 0; o + 12 <= end; o += 12) {
      const off = u32(o);
      if (off && off < end) end = off;
      const frames = bytes[o + 4], flags = (bytes[o + 5] << 8) | frames;
      this.entries.push({ off, frames, flags, width: u16(o + 6), height: u16(o + 8) });
    }
    this.cache = new Map();
  }

  get count() { return this.entries.length; }

  /** Entry n: {width, height, x, y, overlay, palette: [[r,g,b]...] | null, pixels}, or null. */
  entry(n) {
    if (this.cache.has(n)) return this.cache.get(n);
    let e = null;
    try { e = this.decode(n); } catch { e = null; }
    this.cache.set(n, e);
    return e;
  }

  decode(n) {
    const d = this.entries[n];
    if (!d || !d.off || !d.width || !d.height) return null;
    const b = this.bytes;
    let p = d.off;
    let x = 0, y = 0;
    if (d.frames) { x = b[p] | (b[p + 1] << 8); y = b[p + 2] | (b[p + 3] << 8); }
    p += 4 * d.frames;
    let palette = null;
    if (d.flags & 0x1000) {
      const size = PALETTE_SIZE[(d.flags >> 8) & 15] ?? 0;
      const raw = b.subarray(p, p + size);
      p += size;
      if (size === 16) palette = Array.from(raw, (v) => egaColour(v & 63));
      else if (size) {
        palette = [];
        for (let i = 0; i + 2 < raw.length; i += 3) palette.push([raw[i], raw[i + 1], raw[i + 2]].map((v) => Math.round((v & 63) * 255 / 63)));
      }
    }
    const depth = this.series === 3 ? 8 : this.series === 0 ? 1 : 4;
    const rowBytes = depth === 8 ? d.width : depth === 4 ? (d.width + 1) >> 1 : (d.width + 7) >> 3;
    const data = explode(b, p, rowBytes * d.height);
    const pixels = new Uint8Array(d.width * d.height);
    for (let row = 0; row < d.height; row++) {
      const r = row * rowBytes, o = row * d.width;
      for (let i = 0; i < d.width; i++) {
        pixels[o + i] = depth === 8 ? data[r + i]
          : depth === 4 ? (i & 1 ? data[r + (i >> 1)] >> 4 : data[r + (i >> 1)] & 15)
            : (data[r + (i >> 3)] >> (7 - (i & 7))) & 1;
      }
    }
    return { width: d.width, height: d.height, x, y, overlay: (d.flags & 0x4000) !== 0, palette, pixels };
  }
}

/**
 * The pictures of one game, numbered file * 256 + entry (GATE_102.PIC entry 0
 * is 102 * 256). picture(n, entries) gives a picture with the later entries
 * of the same file drawn on it, as the game drew them (XOR overlays and
 * plain pieces): {width, height, palette, pixels}. picture("102:15,18,17")
 * is the same as picture(102 * 256 + 15, [18, 17]).
 */
export class LegendPictures {
  constructor(files, prefix) {
    this.files = files;   // NAME -> Uint8Array
    this.prefix = prefix; // 'GATE'
    this.pics = new Map();
    this.cache = new Map();
  }

  file(num) {
    if (!this.pics.has(num)) {
      const name = `${this.prefix}_${String(num).padStart(3, '0')}.PIC`;
      const bytes = this.files[name];
      this.pics.set(num, bytes ? new PicFile(bytes, Math.floor(num / 100)) : null);
    }
    return this.pics.get(num);
  }

  /** Is entry n of file num an overlay? */
  isOverlay(num, n) {
    const f = this.file(num);
    const e = f?.entries[n];
    return !!e && (e.flags & 0x4000) !== 0;
  }

  picture(id, overlays = []) {
    // "file:base,entry,entry..." (as the machine reports what it drew).
    if (typeof id === 'string') {
      const [file, list] = id.split(':');
      const [base, ...rest] = (list ?? '').split(',').map(Number);
      return this.picture(Number(file) * 256 + base, rest);
    }
    const key = `${id}:${overlays.join(',')}`;
    if (this.cache.has(key)) return this.cache.get(key);
    let pic = null;
    try { pic = this.compose(id, overlays); } catch { pic = null; }
    this.cache.set(key, pic);
    return pic;
  }

  compose(id, overlays) {
    const f = this.file(id >> 8);
    const base = f?.entry(id & 0xff);
    if (!base || base.overlay) return null;
    const pixels = Uint8Array.from(base.pixels);
    for (const n of overlays) {
      const o = f.entry(n);
      if (!o) continue;
      // Overlays are placed relative to the picture's own position.
      const ox = o.x - base.x, oy = o.y - base.y;
      for (let yy = 0; yy < o.height; yy++) {
        const ty = oy + yy;
        if (ty < 0 || ty >= base.height) continue;
        for (let xx = 0; xx < o.width; xx++) {
          const tx = ox + xx;
          if (tx < 0 || tx >= base.width) continue;
          // XOR overlays change the picture; other entries are drawn over it.
          if (o.overlay) pixels[ty * base.width + tx] ^= o.pixels[yy * o.width + xx];
          else pixels[ty * base.width + tx] = o.pixels[yy * o.width + xx];
        }
      }
    }
    const palette = base.palette ?? EGA.map(egaColour);
    return { width: base.width, height: base.height, palette, pixels };
  }
}
