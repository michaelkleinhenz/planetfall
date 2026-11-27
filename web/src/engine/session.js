// GameSession: runs the game and exposes it as "send a command, get the
// response".  Each response is the text the game printed between two READs.

import { runGame, snapshot as takeSnapshot } from './game.js';

export class GameSession {
  constructor({ onStatus, onSave, onRestore, onUpper } = {}) {
    this.onStatus = onStatus || (() => {});
    this.onUpper = onUpper || (() => {});
    this.onSave = onSave || (async () => false);
    this.onRestore = onRestore || (async () => null);
    this.segments = [];
    this.waiters = [];       // resolve functions waiting for the next response
    this.pendingInput = null; // resolve function of the game's READ
    this.ended = false;
    this.endResolve = null;
    this.lastSnapshot = null;
    this.upper = new UpperWindow();
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
      // A key press: the host sends a line, the runtime feeds it key by key.
      inputChar: () => new Promise((resolve) => {
        this.pendingInput = resolve;
        this.lastSnapshot = takeSnapshot();
        this.flush({ ended: false, keyInput: true });
      }),
      // The upper window (status lines, Bureaucracy's forms, Beyond Zork's map)
      split: (n) => this.upper.split(n),
      window: (w) => this.upper.select(w),
      cursor: (l, c) => this.upper.moveTo(l, c),
      upperPos: () => ({ line: this.upper.line, col: this.upper.col }),
      upper: (text) => this.upper.write(text),
      highlight: (style) => this.upper.style(style),
      clear: (w) => this.upper.clear(w),
      eraseLine: () => this.upper.eraseLine(),
      status: (s) => this.onStatus(s),
      // Magnetic Scrolls games: the picture for the current scene (or null).
      picture: (n, { alone = false } = {}) => { this.picture = n; this.pictureAlone = alone; },
      // A new game begins: drop what the old game printed, and tell the host.
      restarted: () => { this.shownPicture = null; this.segments = []; this.restartedFlag = true; this.upper = new UpperWindow(); },
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
    // A new picture goes with the text that brought it (kept on its first segment).
    if (this.picture !== this.shownPicture) {
      if (this.picture == null) this.shownPicture = null;
      else if (segments.length && !segments[0].fixed) { segments[0].picture = this.picture; this.shownPicture = this.picture; }
      // (A picture with no text: Legend's screens, which come one after another.)
      else if (!segments.length && this.pictureAlone) { segments.push({ text: '', fixed: false, picture: this.picture }); this.shownPicture = this.picture; }
    }
    const text = segments.map((s) => s.text).join('');
    const waiters = this.waiters;
    this.waiters = [];
    const restarted = !!this.restartedFlag;
    this.restartedFlag = false;
    const upper = this.upper.view();
    this.onUpper(upper, this.upper.cursorView());
    // The game reads single keys (a form, "press any key"): input goes to it as typed.
    this.waitingForKey = !!extra.keyInput;
    for (const w of waiters) w({ segments, text, restarted, upper, ...extra });
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

/**
 * The Z-machine's upper window as a grid of characters: games position the
 * cursor and write into it (status lines, forms, maps). Reverse video is kept
 * per character.
 */
export class UpperWindow {
  constructor() { this.height = 0; this.rows = []; this.line = 1; this.col = 1; this.inverse = false; this.active = false; }
  split(n) {
    this.height = Math.max(0, Number(n) || 0);
    this.rows.length = Math.min(this.rows.length, this.height);
  }
  select(w) {
    this.active = Number(w) === 1;
    if (this.active) { this.line = 1; this.col = 1; }
  }
  moveTo(l, c) { this.line = Math.max(1, l); this.col = Math.max(1, c); }
  style(s) { this.inverse = (s & 1) === 1; if (s === 0) this.inverse = false; }
  row(n) {
    while (this.rows.length < n) this.rows.push([]);
    return this.rows[n - 1];
  }
  write(text) {
    for (const ch of text) {
      if (ch === '\n') { this.line++; this.col = 1; continue; }
      if (this.col > 120) continue;
      const r = this.row(this.line);
      while (r.length < this.col - 1) r.push({ ch: ' ', inv: false });
      r[this.col - 1] = { ch, inv: this.inverse };
      this.col++;
    }
  }
  eraseLine() {
    const r = this.row(this.line);
    r.length = Math.min(r.length, this.col - 1);
  }
  clear(w) {
    w = Number(w);
    if (w === -1) { this.height = 0; this.rows = []; this.line = 1; this.col = 1; }
    else if (w === -2 || w === 1) { this.rows = []; this.line = 1; this.col = 1; }
  }
  /** Where the cursor is, when the game writes into this window. */
  cursorView() { return this.active ? { line: this.line, col: this.col } : null; }

  /** What the page shows: the visible rows, or null when there is nothing. */
  view() {
    const rows = this.rows.slice(0, this.height || this.rows.length);
    const has = rows.some((r) => r.some((c) => c.ch !== ' ' || c.inv));
    if (!this.height || !has) return null;
    return rows.map((r) => r.map((c) => ({ ...c })));
  }
}
