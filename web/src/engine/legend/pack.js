// Small helpers for snapshots: a byte-oriented LZ77 compressor (snapshots are
// stored in the browser, and the game's memory compresses well) and base64.
//
// Format: a sequence of blocks. A control byte c < 0x80 is followed by c + 1
// literal bytes; c >= 0x80 is a copy of (c - 0x80 + 4) bytes from a distance
// given by the next two bytes (1..65535).

const MIN = 4, MAX = 0x7f + MIN;

export function compress(input) {
  const n = input.length;
  const out = new Uint8Array(n + Math.ceil(n / 128) + 16);
  let o = 0;
  const head = new Int32Array(1 << 15).fill(-1);
  const prev = new Int32Array(n);
  const hash = (i) => ((input[i] << 10) ^ (input[i + 1] << 5) ^ input[i + 2] ^ (input[i + 3] << 13)) & 0x7fff;
  let lit = 0; // start of the pending literal run
  const flushLiterals = (end) => {
    while (lit < end) {
      const len = Math.min(128, end - lit);
      out[o++] = len - 1;
      out.set(input.subarray(lit, lit + len), o);
      o += len; lit += len;
    }
  };
  let i = 0;
  while (i + MIN <= n) {
    const h = hash(i);
    let best = 0, dist = 0;
    for (let c = head[h], tries = 0; c >= 0 && i - c <= 0xffff && tries < 16; c = prev[c], tries++) {
      let l = 0;
      while (l < MAX && i + l < n && input[c + l] === input[i + l]) l++;
      if (l > best) { best = l; dist = i - c; if (l === MAX) break; }
    }
    prev[i] = head[h]; head[h] = i;
    if (best >= MIN) {
      flushLiterals(i);
      out[o++] = 0x80 + best - MIN;
      out[o++] = dist & 0xff; out[o++] = dist >> 8;
      for (let k = 1; k < best && i + k + MIN <= n; k++) { const hk = hash(i + k); prev[i + k] = head[hk]; head[hk] = i + k; }
      i += best;
      lit = i;
    } else i++;
  }
  flushLiterals(n);
  return out.slice(0, o);
}

export function decompress(input) {
  let size = 0;
  for (let p = 0; p < input.length;) {
    const c = input[p];
    if (c < 0x80) { size += c + 1; p += c + 2; } else { size += c - 0x80 + MIN; p += 3; }
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (let p = 0; p < input.length;) {
    const c = input[p++];
    if (c < 0x80) { out.set(input.subarray(p, p + c + 1), o); o += c + 1; p += c + 1; } else {
      const len = c - 0x80 + MIN, dist = input[p] | (input[p + 1] << 8);
      p += 2;
      for (let k = 0; k < len; k++, o++) out[o] = out[o - dist];
    }
  }
  return out;
}

export function bytesToBase64(bytes) {
  if (typeof btoa === 'function') {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  return Buffer.from(bytes).toString('base64');
}

export function base64ToBytes(b64) {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}
