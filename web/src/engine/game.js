// Runs the translated game that is currently loaded (engine/current.js).  The host supplies I/O callbacks:
//   output(text, {fixed})   - game text
//   input() -> Promise<str> - next command line
//   status({room, score, moves})
//   save(snapshot) -> Promise<bool>, restore() -> Promise<snapshot|null>
//   ended() -> Promise<void> (called after QUIT; resolve to restart)
//
// Infocom games are JavaScript translations of their ZIL source (runtime.js);
// Magnetic Scrolls games are their original 68000 program (ms/host.js).

import { current } from './current.js';
import {
  initRuntime, resetState, RestartSignal, QuitSignal, RestoreSignal, tell, seedRandom, snapshot as zSnapshot,
} from './runtime.js';
import { runMagnetic, snapshot as msSnapshot } from './ms/host.js';

/** Is the current game a Magnetic Scrolls game? */
export const isMagnetic = () => current.code?.ENGINE === 'magnetic';

/** The current game state (for undo and saves). */
export function snapshot() {
  return isMagnetic() ? msSnapshot() : zSnapshot();
}

export async function runGame(io, { seed } = {}) {
  if (!current.code) throw new Error('No game loaded (see engine/current.js).');
  if (isMagnetic()) return runMagnetic(io, { seed });
  const { start, mainLoop, ROUTINES } = current.code;
  if (seed !== undefined) seedRandom(seed);
  initRuntime(current.story, ROUTINES, io);
  let entry = 'start';
  for (;;) {
    try {
      if (entry === 'start') {
        resetState();
        await start();
      } else {
        await mainLoop();
      }
      return; // not reached: the main loop never returns
    } catch (e) {
      if (e instanceof RestartSignal) { io.restarted?.(); entry = 'start'; continue; }
      if (e instanceof RestoreSignal) { if (e.notice) tell(e.notice); entry = 'main'; continue; }
      if (e instanceof QuitSignal) {
        if (io.ended) await io.ended();
        else return;
        io.restarted?.();
        entry = 'start';
        continue;
      }
      throw e;
    }
  }
}
