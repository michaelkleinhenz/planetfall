// Z-machine version 3 text encoding helpers (shared by the compiler and the runtime).
//
// Used for object short names and dictionary words, which the original game code
// manipulates directly as bytes (e.g. the parser copies a dictionary word into the
// name of PSEUDO-OBJECT), so they must be stored in the original encoding.

const A0 = 'abcdefghijklmnopqrstuvwxyz';
const A1 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const A2 = ' \n0123456789.,!?_#\'"/\\-:()'; // index 0 is the escape slot (z-char 6)

/** Encode text as a list of z-characters (5-bit values). */
export function toZchars(text) {
  const out = [];
  for (const ch of text) {
    let i;
    if (ch === ' ') { out.push(0); continue; }
    if ((i = A0.indexOf(ch)) >= 0) { out.push(i + 6); continue; }
    if ((i = A1.indexOf(ch)) >= 0) { out.push(4, i + 6); continue; }
    i = A2.indexOf(ch);
    if (i >= 1) { out.push(5, i + 6); continue; }
    const code = ch.charCodeAt(0) & 0x3ff;
    out.push(5, 6, code >> 5, code & 31);
  }
  return out;
}

/** Pack z-characters into bytes (3 per word, last word has the top bit set). */
export function packZchars(zchars) {
  const z = zchars.slice();
  while (z.length % 3 !== 0 || z.length === 0) z.push(5);
  const bytes = [];
  for (let i = 0; i < z.length; i += 3) {
    let w = (z[i] << 10) | (z[i + 1] << 5) | z[i + 2];
    if (i + 3 >= z.length) w |= 0x8000;
    bytes.push(w >> 8, w & 255);
  }
  return bytes;
}

/** Encode a string into packed Z-text bytes. */
export function encodeText(text) {
  return packZchars(toZchars(text));
}

/** Dictionary key for a word: first 6 z-chars of the lowercase word, packed into 4 bytes. */
export function dictBytes(word) {
  const z = toZchars(word.toLowerCase()).slice(0, 6);
  while (z.length < 6) z.push(5);
  return packZchars(z);
}

export function dictKey(word) {
  return dictBytes(word).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Decode packed Z-text starting at addr in a byte array. Returns {text, end}. */
export function decodeText(mem, addr, maxWords = Infinity) {
  let out = '';
  let alphabet = 0;
  let escape = -1; // -1 none, 0 waiting high, 1 waiting low
  let escHigh = 0;
  let words = 0;
  for (;;) {
    const w = (mem[addr] << 8) | mem[addr + 1];
    addr += 2;
    words++;
    for (const z of [(w >> 10) & 31, (w >> 5) & 31, w & 31]) {
      if (escape === 0) { escHigh = z; escape = 1; continue; }
      if (escape === 1) { out += String.fromCharCode((escHigh << 5) | z); escape = -1; continue; }
      if (z === 0) { out += ' '; alphabet = 0; continue; }
      if (z === 4) { alphabet = 1; continue; }
      if (z === 5) { alphabet = 2; continue; }
      if (z < 4) { alphabet = 0; continue; } // abbreviations are not used
      if (alphabet === 2 && z === 6) { escape = 0; alphabet = 0; continue; }
      if (alphabet === 0) out += A0[z - 6];
      else if (alphabet === 1) out += A1[z - 6];
      else out += A2[z - 6];
      alphabet = 0;
    }
    if (w & 0x8000 || words >= maxWords) break;
  }
  return { text: out, end: addr };
}
