// Runs the translated Planetfall game.  The host supplies I/O callbacks:
//   output(text, {fixed})   - game text
//   input() -> Promise<str> - next command line
//   status({room, score, moves})
//   save(snapshot) -> Promise<bool>, restore() -> Promise<snapshot|null>
//   ended() -> Promise<void> (called after QUIT; resolve to restart)

import * as story from '../game/story-data.js';
import { ROUTINES, start, mainLoop } from '../game/planetfall.js';
import {
  initRuntime, resetState, RestartSignal, QuitSignal, RestoreSignal, tell, seedRandom,
} from './runtime.js';

export async function runGame(io, { seed } = {}) {
  if (seed !== undefined) seedRandom(seed);
  initRuntime(story, ROUTINES, io);
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
      if (e instanceof RestartSignal) { entry = 'start'; continue; }
      if (e instanceof RestoreSignal) { if (e.notice) tell(e.notice); entry = 'main'; continue; }
      if (e instanceof QuitSignal) {
        if (io.ended) await io.ended();
        else return;
        entry = 'start';
        continue;
      }
      throw e;
    }
  }
}
