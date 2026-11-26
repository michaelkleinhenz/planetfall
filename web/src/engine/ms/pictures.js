// Decodes the pictures of the original Magnetic Scrolls releases (".gfx"
// files, "MaPi" format, as used by The Pawn, The Guild of Thieves and Jinxter).
//
// File layout: "MaPi", a 32-bit size, then a table of 32-bit file offsets, one
// per picture.  Each picture starts with a header:
//   +2/+4  left and right edge (width = right - left), +6 height,
//   +0x1c  16 palette entries (Atari ST words, 3 bits per channel: 0x0RGB),
//   +0x3c  number of nodes in the Huffman tree, +0x3e data size,
//   +0x42  the tree (two bytes per node), then the coded pixels.
// Decoding the tree gives either a colour (0..15) or, for values 16 and up, a
// run of (value - 16) more pixels of the previous colour.  Each row is then
// XORed with the row above it.

const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

export class PictureFile {
  constructor(bytes) {
    if (bytes.length < 12 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'MaPi') throw new Error('Not a Magnetic Scrolls picture file');
    this.bytes = bytes;
    // The offset table runs up to the first picture.
    const first = u32(bytes, 8);
    this.offsets = [];
    for (let o = 8; o < first && o + 4 <= bytes.length; o += 4) this.offsets.push(u32(bytes, o));
    this.cache = new Map();
  }

  get count() { return this.offsets.length; }

  /** Picture n (0-based): {width, height, palette: [[r,g,b] x16], pixels} or null. */
  picture(n) {
    if (this.cache.has(n)) return this.cache.get(n);
    let pic = null;
    try { pic = this.decode(n); } catch { pic = null; }
    this.cache.set(n, pic);
    return pic;
  }

  decode(n) {
    const off = this.offsets[n];
    const b = this.bytes;
    if (off == null || off === 0 || off + 0x42 > b.length) return null;
    const width = (u16(b, off + 4) - u16(b, off + 2)) & 0xffff;
    let height = u16(b, off + 6);
    if (!width || !height || width > 1024 || height > 1024) return null;
    const palette = [];
    for (let i = 0; i < 16; i++) {
      const w = u16(b, off + 0x1c + 2 * i);
      const c = (v) => Math.round((v & 7) * 255 / 7);
      palette.push([c(w >> 8), c(w >> 4), c(w)]);
    }
    const nodes = u16(b, off + 0x3c);
    const tree = off + 0x42;
    let p = tree + nodes * 2 + 2;
    const size = width * height;
    const px = new Uint8Array(size);
    let bit = 7, run = 0, colour = 0;
    for (let i = 0; i < size; i++, run = (run - 1) & 0xffff) {
      if (!run) {
        let node = nodes;
        while (node < 0x80) {
          if (p >= b.length) throw new Error('Picture data ends early');
          node = (b[p] & (1 << bit)) ? b[tree + 2 * node] : b[tree + 2 * node + 1];
          if (!bit) p++;
          bit = bit ? bit - 1 : 7;
        }
        node &= 0x7f;
        if (node >= 0x10) run = node - 0x10;
        else { colour = node; run = 1; }
      }
      px[i] = colour;
    }
    for (let i = width; i < size; i++) px[i] ^= px[i - width];
    // Drop blank (colour 0) rows at the bottom and top.
    const blank = (y) => { for (let x = 0; x < width; x++) if (px[y * width + x]) return false; return true; };
    let top = 0;
    while (height > 0 && blank(height - 1)) height--;
    while (top < height && blank(top)) top++;
    return { width, height: height - top, palette, pixels: px.subarray(top * width, height * width) };
  }
}
