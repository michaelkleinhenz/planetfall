// Command-line player for the JavaScript translation.
//   node tools/play.mjs                 interactive
//   node tools/play.mjs cmds.txt [seed] scripted (echoes commands like a transcript)
import fs from 'node:fs';
import readline from 'node:readline';
import { runGame } from '../web/src/engine/game.js';

const file = process.argv[2];
const seed = process.argv[3] ? Number(process.argv[3]) : 12345;
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
