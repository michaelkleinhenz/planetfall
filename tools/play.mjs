// Command-line player for the JavaScript translations.
//   node tools/play.mjs [--game zork1]                 interactive
//   node tools/play.mjs [--game zork1] cmds.txt [seed] scripted (echoes commands like a transcript)
import fs from 'node:fs';
import readline from 'node:readline';
import { runGame } from '../web/src/engine/game.js';
import { loadGame } from '../web/src/engine/current.js';
import { random } from '../web/src/engine/runtime.js';
import { GAMES } from '../web/src/games/registry.js';

const args = process.argv.slice(2);
let gameId = 'planetfall';
const gi = args.indexOf('--game');
if (gi >= 0) { gameId = args[gi + 1]; args.splice(gi, 2); }
// Games compiled but not (yet) listed in the registry can still be played here.
await loadGame(GAMES[gameId] ?? {
  id: gameId,
  title: gameId,
  load: () => Promise.all([import(`../web/src/games/${gameId}/game.js`), import(`../web/src/games/${gameId}/story-data.js`)]),
});

const file = args[0];
const seed = args[1] ? Number(args[1]) : 12345;
let lines = file ? fs.readFileSync(file, 'utf8').split('\n') : null;
let rl = null;
let saved = null;

const io = {
  output: (t) => process.stdout.write(t),
  // PLAY_UPPER=1 shows what the game draws in the upper window
  ...(process.env.PLAY_UPPER ? {
    upper: (t) => process.stdout.write(`\x1b[7m${t}\x1b[0m`),
    cursor: (l, c) => process.stdout.write(`\n[${l},${c}] `),
  } : {}),
  input: async () => {
    if (lines) {
      if (!lines.length || (lines.length === 1 && lines[0] === '')) process.exit(0);
      const l = lines.shift();
      process.stdout.write(l + '\n');
      // "@seed N" seeds the random number generator directly (as the test
      // oracle does) and reaches the game as an empty line.
      const m = /^@seed (\d+)$/.exec(l.trim());
      if (m) { random(-Number(m[1])); return ''; }
      return l;
    }
    rl ??= readline.createInterface({ input: process.stdin });
    return new Promise((res) => rl.once('line', res));
  },
  // A single key press: the next line, not echoed (as in the original).
  inputChar: async () => {
    if (lines) {
      if (!lines.length || (lines.length === 1 && lines[0] === '')) process.exit(0);
      return lines.shift();
    }
    return io.input();
  },
  save: async (s) => { saved = s; return true; },
  restore: async () => saved,
  ended: async () => process.exit(0),
};
runGame(io, { seed }).catch((e) => { console.error(e); process.exit(1); });
