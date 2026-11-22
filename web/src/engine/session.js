// GameSession: runs the game and exposes it as "send a command, get the
// response".  Each response is the text the game printed between two READs.

import { runGame } from './game.js';
import { snapshot as takeSnapshot } from './runtime.js';

export class GameSession {
  constructor({ onStatus, onSave, onRestore } = {}) {
    this.onStatus = onStatus || (() => {});
    this.onSave = onSave || (async () => false);
    this.onRestore = onRestore || (async () => null);
    this.segments = [];
    this.waiters = [];       // resolve functions waiting for the next response
    this.pendingInput = null; // resolve function of the game's READ
    this.ended = false;
    this.endResolve = null;
    this.lastSnapshot = null;
  }

  /** Start the game; resolves with the opening text. */
  start(options = {}) {
    const io = {
      output: (text, { fixed } = {}) => {
        const last = this.segments[this.segments.length - 1];
        if (last && last.fixed === !!fixed) last.text += text;
        else this.segments.push({ text, fixed: !!fixed });
      },
      input: () => new Promise((resolve) => {
        this.pendingInput = resolve;
        this.lastSnapshot = takeSnapshot();
        this.flush({ ended: false });
      }),
      status: (s) => this.onStatus(s),
      save: (snap) => this.onSave(snap),
      restore: () => this.onRestore(),
      ended: () => new Promise((resolve) => {
        this.ended = true;
        this.endResolve = resolve;
        this.flush({ ended: true });
      }),
    };
    const first = this.nextResponse();
    runGame(io, options).catch((err) => {
      console.error(err);
      this.segments.push({ text: `\n[Internal error: ${err.message}]\n`, fixed: false });
      this.flush({ ended: true, error: err });
    });
    return first;
  }

  nextResponse() {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  flush(extra) {
    const segments = cleanSegments(this.segments);
    this.segments = [];
    const text = segments.map((s) => s.text).join('');
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w({ segments, text, ...extra });
  }

  /** Send a command line (or a {snapshot} load request); resolves with the response. */
  send(line) {
    const response = this.nextResponse();
    if (this.ended) {
      // Any input after QUIT starts a new game.
      this.ended = false;
      const r = this.endResolve;
      this.endResolve = null;
      r?.();
    } else {
      const resolve = this.pendingInput;
      this.pendingInput = null;
      if (!resolve) throw new Error('The game is not waiting for input.');
      resolve(line);
    }
    return response;
  }

  /** Jump to a saved state (used for undo and loading saves). */
  load(snap, notice = '') {
    return this.send({ snapshot: snap, notice });
  }

  /** State at the moment the game last asked for input. */
  currentSnapshot() { return this.lastSnapshot; }
}

// Strip the game's own ">" prompt and surrounding blank lines: the UI draws its own.
function cleanSegments(segments) {
  const out = segments.map((s) => ({ ...s }));
  if (out.length) {
    const last = out[out.length - 1];
    last.text = last.text.replace(/\n*>\s*$/, '').replace(/\s+$/, '');
    out[0].text = out[0].text.replace(/^\n+/, '');
  }
  return out.filter((s) => s.text.length);
}
