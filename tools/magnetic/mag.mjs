// Read an original Magnetic Scrolls story file (.mag): code, messages, dictionary.
export function parseMag(b) {
  const L = (o) => ((b[o] << 24) | (b[o+1] << 16) | (b[o+2] << 8) | b[o+3]) >>> 0;
  if (L(0) !== 0x4d615363) throw new Error('not a .mag');
  const version = b[13];
  const codeSize = L(14), s1 = L(18), s2 = L(22), dictSize = L(26), dec = L(30);
  let p = 42;
  const code = b.slice(p, p += codeSize);
  const strings = b.slice(p, p + s1 + s2); p += s1 + s2;
  const dict = dictSize ? b.slice(p, p + dictSize) : null;
  const table = strings.subarray(dec);
  const W = (o) => (table[o] << 8) | table[o+1];
  const first2 = W(0x100);
  const messages = [];
  for (let i = 0; ; i++) {
    if (0x100 + 2 * i + 1 >= table.length) break;
    let off = i === 0 ? 0 : W(0x100 + 2 * i);
    if (i && first2 && i >= first2) off += s1;
    if (i > 0 && 0x100 + 2*i >= dec - 0) { /* bounds */ }
    if (off >= strings.length) break;
    let mask = 1, s = '';
    for (let n = 0; n < 4000; n++) {
      let c = 0;
      while (c < 0x80) {
        if (off >= strings.length) { c = 0x80; break; }
        c = (strings[off] & mask) ? table[0x80 + c] : table[c];
        mask = (mask << 1) & 0xff; if (!mask) { mask = 1; off++; }
      }
      c &= 0x7f;
      if (!c) break;
      s += String.fromCharCode(c);
    }
    messages.push(s);
    if (messages.length > 5000) break;
  }
  return { version, code, messages, dict };
}
