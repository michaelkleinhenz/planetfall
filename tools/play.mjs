// Command-line player for the JavaScript translations.
//   node tools/play.mjs [--game zork1]                 interactive
//   node tools/play.mjs [--game zork1] cmds.txt [seed] scripted (echoes commands like a transcript)
import fs from 'node:fs';
import readline from 'node:readline';
import { runGame } from '../web/src/engine/game.js';
import { loadGame } from '../web/src/engine/current.js';
import { GAMES } from '../web/src/games/registry.js';

const args = process.argv.slice(2);
let gameId = 'planetfall';
const gi = args.indexOf('--game');
if (gi >= 0) { gameId = args[gi + 1]; args.splice(gi, 2); }
await loadGame(GAMES[gameId]);

const file = args[0];
const seed = args[1] ? Number(args[1]) : 12345;
let lines = file ? fs.readFileSync(file, 'utf8').split('\n') : null;
let rl = null;
let saved = null;

const io = {
  output: (t) => process.stdout.write(t),
  input: async () => {
    if (lines) {
      if (!lines.length || (lines.length === 1 && lines[0] === '')) process.exit(0);
      const l = lines.shift();
      process.stdout.write(l + '\n');
      return l;
    }
    rl ??= readline.createInterface({ input: process.stdin });
    return new Promise((res) => rl.once('line', res));
  },
  save: async (s) => { saved = s; return true; },
  restore: async () => saved,
  ended: async () => process.exit(0),
};
runGame(io, { seed }).catch((e) => { console.error(e); process.exit(1); });
