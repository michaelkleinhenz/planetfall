// Replays recorded command sequences through the JavaScript translation and
// compares the output with the transcript of the ORIGINAL game (release 39
// story file, COMPILED/planetfall.z3) for the same commands.
//
//   node tests/transcripts.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize } from './normalize.mjs';
import { runGame } from '../web/src/engine/game.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'transcripts');

function play(commands) {
  return new Promise((resolve, reject) => {
    let out = '';
    const lines = ['#random 42', ...commands];
    let saved = null;
    const io = {
      output: (t) => { out += t; },
      input: async () => {
        if (!lines.length) { resolve(out); return new Promise(() => {}); }
        const l = lines.shift();
        out += l + '\n';
        return l;
      },
      save: async (s) => { saved = s; return true; },
      restore: async () => saved,
      ended: async () => { resolve(out); return new Promise(() => {}); },
    };
    runGame(io).catch(reject);
  });
}

let failed = 0;
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.cmds')).sort()) {
  const cmds = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean);
  const expected = fs.readFileSync(path.join(dir, f.replace('.cmds', '.expected')), 'utf8');
  const actual = normalize(await play(cmds));
  if (actual === expected) {
    console.log(`ok   ${f} (${cmds.length} commands)`);
  } else {
    failed++;
    const a = actual.split('\n'), e = expected.split('\n');
    let i = 0;
    while (i < a.length && a[i] === e[i]) i++;
    console.log(`FAIL ${f}: first difference at line ${i + 1}`);
    console.log(`  expected: ${JSON.stringify(e[i])}\n  actual:   ${JSON.stringify(a[i])}`);
  }
}
process.exit(failed ? 1 : 0);
