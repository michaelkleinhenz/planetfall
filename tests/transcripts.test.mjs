// Replays recorded command sequences through the JavaScript translation and
// compares the output with the recorded transcript. Planetfall's and Zork I's
// transcripts come from the original story files; the other games' were
// recorded from the translation after comparing it with the originals.
//
//   node tests/transcripts.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize } from './normalize.mjs';
import { runGame } from '../web/src/engine/game.js';
import { loadGame } from '../web/src/engine/current.js';
import { GAMES } from '../web/src/games/registry.js';
import { random, seedRandom } from '../web/src/engine/runtime.js';

const base = path.join(path.dirname(fileURLToPath(import.meta.url)), 'transcripts');

function play(commands) {
  // Fixed generator state for anything random before the first command.
  seedRandom(12345);
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
        // "@seed N" seeds the random number generator directly (for games
        // without a #RANDOM debugging command) and reaches the game as an empty line.
        const m = /^@seed (\d+)$/.exec(l.trim());
        if (m) { random(-Number(m[1])); return ''; }
        return l;
      },
      inputChar: async () => {
        while (lines.length && /^@seed \d+$/.test(lines[0].trim())) random(-Number(lines.shift().trim().slice(6)));
        if (!lines.length) { resolve(out); return new Promise(() => {}); }
        return lines.shift();
      },
      save: async (s) => { saved = s; return true; },
      restore: async () => saved,
      ended: async () => { resolve(out); return new Promise(() => {}); },
    };
    runGame(io).catch(reject);
  });
}

let failed = 0;
for (const gameId of fs.readdirSync(base).filter((d) => GAMES[d]).sort()) {
  await loadGame(GAMES[gameId]);
  const dir = path.join(base, gameId);
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.cmds')).sort()) {
  const cmds = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean);
  const expFile = path.join(dir, f.replace('.cmds', '.expected'));
  const actual = normalize(await play(cmds));
  if (!fs.existsSync(expFile)) {
    // A new transcript: record the current output (after checking it against
    // the original story file with the test oracle).
    fs.writeFileSync(expFile, actual);
    console.log(`new  ${gameId}/${f} (${cmds.length} commands): recorded`);
    continue;
  }
  const expected = fs.readFileSync(expFile, 'utf8');
  if (actual === expected) {
    console.log(`ok   ${gameId}/${f} (${cmds.length} commands)`);
  } else {
    failed++;
    const a = actual.split('\n'), e = expected.split('\n');
    let i = 0;
    while (i < a.length && a[i] === e[i]) i++;
    console.log(`FAIL ${gameId}/${f}: first difference at line ${i + 1}`);
    console.log(`  expected: ${JSON.stringify(e[i])}\n  actual:   ${JSON.stringify(a[i])}`);
  }
}
}
process.exit(failed ? 1 : 0);
