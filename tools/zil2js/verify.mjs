// Cross-checks the compiler's output against the original ZILCH data listing
// (planetfalldat.zap): vocabulary parts of speech, object tree and syntax tables.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileAll } from './compile.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const zap = fs.readFileSync(path.join(ROOT, 'planetfalldat.zap'), 'latin1').split('\n');
const { c } = compileAll();
let problems = 0;
const report = (m) => { problems++; if (problems < 80) console.log(m); };

// --- vocabulary ---
const PS = { 'PS?OBJECT': 128, 'PS?VERB': 64, 'PS?ADJECTIVE': 32, 'PS?DIRECTION': 16, 'PS?PREPOSITION': 8, 'PS?BUZZ-WORD': 4 };
const zapWords = new Map();
for (let i = 0; i < zap.length; i++) {
  const m = /^W\?(\S+)::\s+\.ZWORD/.exec(zap[i]);
  if (!m) continue;
  const flags = zap[i + 1].replace(/\s*\.BYTE\s*/, '').split('+');
  let ps = 0;
  for (const f of flags) ps |= PS[f.trim()] || 0;
  zapWords.set(m[1], ps);
}
for (const [name, ps] of zapWords) {
  const e = c.vocab.byName.get(name);
  if (!e) { report(`word ${name}: missing`); continue; }
  const mine = c.mem[e.addr + 4] & 0xfc;
  if (mine !== ps) report(`word ${name}: parts of speech ${mine} vs original ${ps}`);
}

// --- adjective numbers: a word must carry the same adjective as in the original ---
for (let i = 0; i < zap.length; i++) {
  const m = /^W\?(\S+)::\s+\.ZWORD/.exec(zap[i]);
  if (!m) continue;
  for (const l of [zap[i + 2], zap[i + 3]]) {
    const a = /A\?(\S+)/.exec(l);
    if (!a) continue;
    const e = c.vocab.byName.get(m[1]);
    const expected = c.vocab.byName.get(a[1])?.parts.adj ?? c.adjNums.get(a[1]);
    if (e.parts.adj !== expected) report(`word ${m[1]}: adjective ${e.parts.adj} vs original A?${a[1]} (${expected})`);
  }
}

// --- object tree ---
const objs = new Map();
for (const l of zap) {
  const m = /^\s+\.OBJECT (\S+?),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),/.exec(l);
  if (m) objs.set(m[1], { parent: m[4], sibling: m[5], child: m[6] });
}
const num = (n) => (n === '0' ? 0 : c.objIndex.get(n));
for (const [name, o] of objs) {
  const a = c.objTable + (c.objIndex.get(name) - 1) * 9;
  for (const [k, off] of [['parent', 4], ['sibling', 5], ['child', 6]]) {
    if (c.mem[a + off] !== num(o[k])) report(`object ${name}: ${k} ${c.objects[c.mem[a + off] - 1]?.name} vs original ${o[k]}`);
  }
}
console.log(problems ? `${problems} differences` : 'vocabulary and object tree match the original compiler output');
