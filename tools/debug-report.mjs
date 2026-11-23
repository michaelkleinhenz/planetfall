// Replays a debug report downloaded from the app (Settings -> Report a problem).
//
//   node tools/debug-report.mjs report.json                  summary, then replay from the oldest checkpoint
//   node tools/debug-report.mjs report.json --from 41        replay from the checkpoint at or before log entry 41
//   node tools/debug-report.mjs report.json --current "look" from the current state, run extra commands
//   node tools/debug-report.mjs report.json ... -- "examine brochure" "take it"   extra commands after the replay
//   options: --quiet (only differences and the extra commands), --log (print the whole input log)
//
// A checkpoint is the complete game state (memory, globals, random number
// state) before a logged input, so replaying the inputs after it must give the
// same output as in the player's browser. Differences are printed.
import fs from 'node:fs';
import { loadGame } from '../web/src/engine/current.js';
import { GAMES } from '../web/src/games/registry.js';

const args = process.argv.slice(2);
const file = args.shift();
if (!file) { console.error('usage: node tools/debug-report.mjs report.json [--from N] [--current] [--quiet] [--log] [-- commands...]'); process.exit(1); }
const opt = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const from = opt('--from');
const fromCurrent = flag('--current');
const quiet = flag('--quiet');
const showLog = flag('--log');
const dash = args.indexOf('--');
const extra = dash >= 0 ? args.slice(dash + 1) : args;

const report = JSON.parse(fs.readFileSync(file, 'utf8'));
if (report.format !== 'planetfall-ai-debug-report') { console.error('not a debug report'); process.exit(1); }
const meta = GAMES[report.game.id];
if (!meta) { console.error(`unknown game ${report.game.id}`); process.exit(1); }
await loadGame(meta);
const { GameSession } = await import('../web/src/engine/session.js');
const { inspect } = await import('../web/src/engine/runtime.js');
const { currentScene, sceneText, currentRoom } = await import('../web/src/ai/scene.js');

const say = (...a) => console.log(...a);
const norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
const roomName = (id) => (id ? `${inspect.objectName(id)} (#${id})` : '-');

// ---- summary
say(`== ${report.game.title} (${report.game.id}), build ${report.build}, ${report.created}`);
say(`settings: ${JSON.stringify(report.settings)}`);
say(`browser: ${report.browser?.userAgent}`);
say(`state: ${JSON.stringify(report.state)}`);
if (report.errors?.length) {
  say(`errors (${report.errors.length}):`);
  for (const e of report.errors) say(`  [${e.time}] ${e.source}: ${e.error.split('\n').slice(0, 4).join('\n    ')}`);
}
const log = report.log ?? [];
const shown = showLog ? log : log.slice(-12);
say(`input log (${log.length} entries, showing ${shown.length}):`);
for (const e of shown) {
  const io = e.input != null ? JSON.stringify(e.input) : '';
  say(`  #${e.n} ${e.kind} ${io}${e.error ? ' ERROR' : ''}${e.ended ? ' (ended)' : ''}`);
}
say(`checkpoints before entries: ${(report.checkpoints ?? []).map((c) => c.n).join(', ') || 'none'}`);
const lastAI = (report.transcript ?? []).slice(-3);
if (lastAI.length) {
  say('last transcript entries:');
  for (const t of lastAI) say(`  > ${t.input ?? t.system ?? ''}  ${(t.steps ?? []).map((s) => s.command).filter(Boolean).join(' | ')}`);
}

// ---- replay
const session = new GameSession({ onStatus: () => {}, onSave: () => false, onRestore: () => null, onUpper: () => {} });
await session.start({ seed: 1 });

let start;
if (fromCurrent) {
  start = { n: Infinity, snapshot: report.current };
} else {
  const cps = report.checkpoints ?? [];
  start = from != null ? [...cps].reverse().find((c) => c.n <= Number(from)) : cps[0];
  if (!start) start = { n: Infinity, snapshot: report.current };
}
if (!start.snapshot) { console.error('the report has no game state'); process.exit(1); }
await session.load(start.snapshot);
say(`\n== replaying from ${start.n === Infinity ? 'the current state' : `the checkpoint before #${start.n}`}, in ${roomName(currentRoom())}`);

let differences = 0;
for (const e of log) {
  if (e.n < start.n || (e.kind !== 'line' && e.kind !== 'key')) {
    // Undo, resume or a restart in the browser: the state jumps; continue from its checkpoint.
    const cp = (report.checkpoints ?? []).find((c) => c.n === e.n);
    if (e.n > start.n && cp) { await session.load(cp.snapshot); say(`-- #${e.n} ${e.kind}: state reloaded`); }
    continue;
  }
  const res = await session.send(e.input);
  const same = norm(res.text) === norm(e.output);
  if (!same) differences++;
  if (!quiet || !same) {
    say(`\n>${e.input}   [#${e.n}${same ? '' : ', DIFFERENT from the browser'}]`);
    say(res.text.trimEnd());
    if (!same) say(`--- the browser had:\n${String(e.output).trimEnd()}`);
  }
}
say(`\n== replay done: ${differences} difference(s); now in ${roomName(currentRoom())}`);

for (const cmd of extra) {
  const res = await session.send(cmd);
  say(`\n>${cmd}`);
  say(res.text.trimEnd());
}
try { say(`\n== scene\n${sceneText(currentScene())}`); } catch (e) { say(`(scene unavailable: ${e.message})`); }
process.exit(0);
