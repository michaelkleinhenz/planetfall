// Debug reports: when a player hits a bug, they download a file that lets a
// developer replay it exactly. The app logs every input it sends to the game
// together with the game's raw (English) reply, and keeps a snapshot of the
// complete game state (memory, globals, random number state) taken before each
// of the last commands. A snapshot plus the commands after it reproduces the
// game's behaviour deterministically: see tools/debug-report.mjs.

const MAX_LOG = 250; // log entries kept (and stored with the autosave)
const MAX_CHECKPOINTS = 12; // snapshots kept, in memory only
const MAX_OUTPUT = 6000; // characters of game output per entry
const MAX_ERRORS = 30;

/** The deployed build: module URLs carry ?v=<commit> (see tools/stamp.mjs). */
export const BUILD = (() => {
  try { return new URL(import.meta.url).searchParams.get('v') || 'local'; } catch { return 'unknown'; }
})();

export class DebugLog {
  constructor(saved) {
    this.entries = Array.isArray(saved?.entries) ? saved.entries.slice(-MAX_LOG) : [];
    this.next = this.entries.length ? this.entries[this.entries.length - 1].n + 1 : 0;
    this.checkpoints = []; // {n, snapshot}: state before log entry n
    this.errors = [];
  }

  toJSON() { return { entries: this.entries.slice(-MAX_LOG) }; }

  add(kind, detail = {}) {
    const entry = { n: this.next++, kind, time: new Date().toISOString(), ...detail };
    this.entries.push(entry);
    if (this.entries.length > MAX_LOG * 1.2) this.entries.splice(0, this.entries.length - MAX_LOG);
    return entry;
  }

  /** A checkpoint: the complete game state before entry n. */
  checkpoint(n, snapshot) {
    if (!snapshot) return;
    this.checkpoints.push({ n, snapshot });
    if (this.checkpoints.length > MAX_CHECKPOINTS) this.checkpoints.shift();
  }

  /** Before sending input to the game. */
  input(command, { snapshot, room, keyInput }) {
    const entry = this.add(keyInput ? 'key' : 'line', { input: command, roomBefore: room });
    this.checkpoint(entry.n, snapshot);
    return entry;
  }

  /** After the game replied to an input. */
  output(entry, res, room) {
    entry.output = String(res?.text ?? '').slice(0, MAX_OUTPUT);
    entry.roomAfter = room;
    if (res?.ended) entry.ended = true;
    if (res?.restarted) entry.restarted = true;
    if (res?.keyInput) entry.nextIsKey = true;
    if (res?.error) entry.error = errorText(res.error);
  }

  error(source, err) {
    this.errors.push({ time: new Date().toISOString(), source, error: errorText(err) });
    if (this.errors.length > MAX_ERRORS) this.errors.shift();
  }

  /** Record uncaught errors and rejected promises of the page. */
  captureErrors(target = window) {
    target.addEventListener('error', (e) => this.error('window', e.error ?? e.message));
    target.addEventListener('unhandledrejection', (e) => this.error('promise', e.reason));
  }
}

function errorText(err) {
  if (!err) return '';
  if (err instanceof Error) return `${err.name}: ${err.message}\n${err.stack ?? ''}`.trim();
  return String(err);
}

/** Offer an object as a JSON file download. */
export function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const REPORT_README = [
  'Debug report of Planetfall AI (Infocom games translated from ZIL to JavaScript).',
  'log: every input sent to the game (n, kind line/key, input, raw game output, room object before/after).',
  'checkpoints: the complete game state (base64 memory, globals, RNG) before log entry n.',
  'current: the game state now (before the next input).',
  'transcript: what the player saw, with the commands the AI sent and translations.',
  'Replay: node tools/debug-report.mjs <report.json> [--from N] [extra commands...]',
].join('\n');
