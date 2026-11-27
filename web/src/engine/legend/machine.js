// Runs a Legend Entertainment game (Gateway generation) as the original DOS
// program, on the x86 core and DOS services in cpu86.js / dos.js, and turns it
// into a text game:
//
// - Text: the game's own SCRIPT command writes everything it prints to a
//   transcript file; the machine turns it on at the start and reads what the
//   game writes there. (The opening, printed before SCRIPT can be typed, is
//   read from the screen instead: the game draws its text with the video
//   BIOS, so the characters and their positions are known.)
// - Input: commands are typed on the keyboard. "- MORE -" pauses are answered
//   with a space; other questions (QUIT's "are you sure?") go to the player.
// - Pictures: which picture entries the game reads from its PIC files, in
//   order, since the last full-size room picture.
// - Snapshots: memory as a difference from the state at the first prompt
//   (which is the same on every run), plus the CPU and DOS state.

import { Dos, KEYS } from './dos.js';
import { PicFile } from './pictures.js';

const SCRIPT_FILE = 'GAME.TXT';
const TEXT_LEFT = 33;        // the story window starts at this column
const MEM_SAVED = 0xa0000;   // memory kept in snapshots (conventional memory)

export class LegendError extends Error {}

export class LegendMachine {
  /**
   * files: { NAME: Uint8Array }; config: { exe, args, prefix }
   */
  constructor(files, config) {
    this.files = files;
    this.config = config;
    this.pics = new Map();
    for (const [name, bytes] of Object.entries(files)) {
      const m = /^[A-Z]+_(\d{3})\.PIC$/.exec(name);
      if (m) this.pics.set(name, { num: Number(m[1]), file: new PicFile(bytes, Math.floor(Number(m[1]) / 100)) });
    }
    this.baseline = null;
    this.reset();
  }

  // ---- set-up -------------------------------------------------------------------

  reset() {
    const dos = new Dos(this.files);
    this.dos = dos;
    this.script = '';
    this.scripting = false;
    this.lines = [];
    this.line = null;
    this.drawn = [];
    dos.onWrite = (name, bytes) => {
      if (name === SCRIPT_FILE) this.script += String.fromCharCode(...bytes);
    };
    dos.onChar = (ch, x, y, n, attr) => this.screenChar(ch, x, y, n, attr);
    dos.onRead = (name, pos, len) => this.fileRead(name, pos, len);
    dos.load(this.config.exe, this.config.args ?? '');
    // The script file's contents are not kept (only read as it is written).
    dos.discard = new Set([SCRIPT_FILE]);
  }

  /**
   * Start the game: through the title screens to the first prompt, then turn
   * on the transcript. Returns the opening text.
   */
  boot() {
    let opening = null;
    for (let i = 0; i < 200; i++) {
      const state = this.dos.run();
      if (state !== 'key') throw new LegendError(`The game stopped while starting (${state}).`);
      const row = this.cursorRow();
      // The launcher's title pages (drawn straight into text memory): skip them.
      if (/Press <Esc> to play/i.test(this.textMemory()) || !this.dos.screenText().trim()) { this.dos.key(KEYS.ESC); continue; }
      if (/- MORE -/.test(row)) { this.dos.key(KEYS.SPACE); continue; }
      if (this.atPrompt()) {
        if (opening == null) {
          opening = this.screenTranscript();
          this.lines = [];
          this.dos.key('script\r');
          continue;
        }
        if (this.scripting) break;
      }
      if (/transcript file name/i.test(row)) { this.dos.key(SCRIPT_FILE + '\r'); this.scripting = true; continue; }
      // A title picture waiting for a key.
      this.dos.key(KEYS.SPACE);
    }
    if (!this.scripting) throw new LegendError('The game did not reach its first prompt.');
    this.script = '';
    this.drawnAtBoot = this.drawn.slice();
    if (!this.baseline) this.baseline = this.dos.mem.slice(0, MEM_SAVED);
    this.opening = opening;
    return opening;
  }

  // ---- the screen ---------------------------------------------------------------

  /** What the text-mode screen memory shows. */
  textMemory() {
    let s = '';
    for (let i = 0; i < 80 * 25; i++) s += String.fromCharCode(this.dos.mem[0xb8000 + i * 2] || 32);
    return s;
  }

  /** The text on the cursor's row of the story window. */
  cursorRow() {
    const y = this.dos.cursor >> 8;
    return String.fromCharCode(...this.dos.grid.subarray(y * 80 + TEXT_LEFT, y * 80 + 80)).replace(/\xdb/g, ' ');
  }

  /** Is the game waiting at its ">" prompt? (The transcript gets the prompt only with the next line.) */
  atPrompt() {
    const y = this.dos.cursor >> 8;
    return this.dos.grid[y * 80 + TEXT_LEFT] === 0x3e && (this.dos.cursor & 0xff) > TEXT_LEFT; // '>'
  }

  screenChar(ch, x, y, n, attr) {
    // Questions in a box over the menus (QUIT's "Do you really want to QUIT?"),
    // drawn in yellow (XOR).
    if (attr === 0x8e && this.dialog) {
      const row = this.dialog.get(y) ?? new Map();
      row.set(x, ch);
      this.dialog.set(y, row);
    }
    if (x < TEXT_LEFT || this.scripting) return;
    let l = this.line;
    // (The cursor, a block character, is drawn after each character and then
    // overwritten by the next one.)
    if (!l || l.y !== y || x < l.x0 || (x < l.end && l.chars[x - l.x0] !== 0xdb)) {
      if (l) this.lines.push(l);
      l = this.line = { y, x0: x, chars: [], end: x };
    }
    l.chars[x - l.x0] = ch;
    l.end = x + 1;
  }

  /** The story text written to the screen so far (for the opening). */
  screenTranscript() {
    if (this.line) { this.lines.push(this.line); this.line = null; }
    const out = [];
    for (const l of this.lines) {
      const text = Array.from(l.chars, (c) => (c == null || c === 0xdb ? ' ' : String.fromCharCode(c))).join('').replace(/\s+$/, '');
      if (!text.trim()) continue;
      if (/^(\s*Loading\.\.\.|\s*- MORE -|>)/.test(text)) continue;
      // The status line: the room name, then the date and time far to the right.
      if (/\S\s{4,}\S.*\d:\d\d$/.test(text)) { this.statusLine = text.trim(); continue; }
      out.push({ x: l.x0, text: ' '.repeat(Math.max(0, l.x0 - TEXT_LEFT)) + text.replace(/^\s+/, '') });
    }
    // Lines that start at the window's edge continue the line before (except
    // a heading, which is a whole line).
    let text = '';
    out.forEach((l, i) => {
      if (i === 0) { text = l.text; return; }
      const prev = out[i - 1].text;
      const heading = i === 1 && prev.length < 40 && !/[.!?]$/.test(prev);
      text += l.x === TEXT_LEFT && !heading ? ' ' + l.text.trim() : '\n' + l.text;
    });
    return text.replace(/^ {3}(?=\S)/gm, '') + '\n';
  }

  /** The status line: room name and the game's clock. */
  status() {
    const g = this.dos.grid;
    for (let y = 0; y < 30; y++) {
      const row = String.fromCharCode(...g.subarray(y * 80 + TEXT_LEFT, y * 80 + 80)).replace(/\xdb/g, ' ');
      const m = /^(\S.*?)\s{3,}(\S.*\d:\d\d)\s*$/.exec(row);
      if (m) return { room: m[1].trim(), clock: m[2].trim() };
    }
    return { room: '', clock: '' };
  }

  /** The game's menu of things that can be referred to now (left part of the screen). */
  nounMenu() {
    const g = this.dos.grid, out = [];
    for (let y = 0; y < 60; y++) {
      const s = String.fromCharCode(...g.subarray(y * 80 + 14, y * 80 + 32)).replace(/\xdb/g, ' ').trim();
      const verb = String.fromCharCode(...g.subarray(y * 80 + 1, y * 80 + 14)).replace(/\xdb/g, ' ').trim();
      if (s && verb) out.push(s);
    }
    return out;
  }

  // ---- pictures -----------------------------------------------------------------------

  fileRead(name, pos) {
    const p = this.pics.get(name);
    if (!p) return;
    const n = p.file.entries.findIndex((e) => e.off === pos);
    if (n < 0) return;
    const e = p.file.entries[n];
    // A full-size picture starts a new scene; later entries are drawn on it.
    if (!(e.flags & 0x4000) && e.width >= 300) this.drawn = [];
    this.drawn.push({ num: p.num, n });
  }

  /** The picture on screen: "file:base,entry,entry..." (see LegendPictures), or null. */
  picture() {
    const d = this.drawn;
    if (!d.length) return null;
    const base = d[0];
    const f = this.pics.get(`${this.config.prefix}_${String(base.num).padStart(3, '0')}.PIC`)?.file;
    const e = f?.entries[base.n];
    if (!e || (e.flags & 0x4000) || e.width < 300) return null;
    const parts = [base.n];
    for (const x of d.slice(1)) if (x.num === base.num) parts.push(x.n);
    return `${base.num}:${parts.join(',')}`;
  }

  // ---- turns ------------------------------------------------------------------------

  /**
   * Type a line and run until the game wants the next one. Returns
   * { text, state }: state 'prompt' (the ">" prompt), 'question' (the game
   * asks something else; text ends with the question) or 'exit'.
   */
  command(line) {
    this.script = '';
    this.typed = line;
    this.dos.key(line + '\r');
    return this.continue();
  }

  /** The text of a question box drawn since the last command. */
  dialogText() {
    const rows = [...(this.dialog ?? new Map())].sort((a, b) => a[0] - b[0]);
    const lines = [];
    for (const [, row] of rows) {
      const xs = [...row.keys()].sort((a, b) => a - b);
      let t = '';
      for (let x = xs[0]; x <= xs[xs.length - 1]; x++) t += row.has(x) ? String.fromCharCode(row.get(x)) : ' ';
      t = t.replace(/[\xb0-\xdf]/g, ' ').trim();
      if (/[a-z]/i.test(t)) lines.push(t);
    }
    return lines.join(' ');
  }

  /** Run until the next prompt or question (after typing an answer). */
  continue() {
    this.dialog = new Map();
    for (let i = 0; i < 500; i++) {
      const state = this.dos.run();
      if (state === 'exit') return { text: this.takeScript(), state: 'exit' };
      const row = this.cursorRow();
      if (/- MORE -/.test(row)) { this.dos.key(KEYS.SPACE); continue; }
      if (this.atPrompt()) return { text: this.takeScript(), state: 'prompt' };
      // Some other question, asked on the screen only.
      const question = this.dialogText() || row.replace(/^>/, '').trim();
      return { text: this.takeScript(), state: 'question', question };
    }
    throw new LegendError('The game kept pausing.');
  }

  /** The new transcript text, without the prompt and the echoed command. */
  takeScript() {
    let t = this.script.replace(/\r\n/g, '\n');
    this.script = '';
    // The prompt and the command typed at it come first.
    if (this.typed != null) {
      const lines = t.split('\n');
      const i = lines.findIndex((l) => l.replace(/^>/, '').trim().toLowerCase() === this.typed.trim().toLowerCase());
      if (i >= 0 && i < 6) t = lines.slice(i + 1).join('\n');
      this.typed = null;
    }
    // Lines broken at a space continue on the next line.
    t = t.replace(/ \n(?=\S)/g, ' ');
    // Paragraphs are indented by three spaces.
    t = t.replace(/^ {3}(?=\S)/gm, '');
    return t.replace(/^\n+/, '');
  }

  // ---- snapshots ----------------------------------------------------------------------

  snapshot() {
    const mem = this.dos.mem, base = this.baseline;
    // Runs of bytes that differ from the first-prompt state: [offset, length, bytes...]
    const diff = [];
    for (let i = 0; i < MEM_SAVED;) {
      if (mem[i] === base[i]) { i++; continue; }
      let j = i;
      // Join runs separated by fewer than 8 equal bytes.
      while (j < MEM_SAVED) {
        if (mem[j] !== base[j]) { j++; continue; }
        let k = j;
        while (k < MEM_SAVED && k - j < 8 && mem[k] === base[k]) k++;
        if (k - j < 8 && k < MEM_SAVED) j = k; else break;
      }
      diff.push([i, mem.slice(i, j)]);
      i = j;
    }
    const cpu = this.dos.cpu, dos = this.dos;
    return {
      diff,
      cpu: { r: Array.from(cpu.r), s: Array.from(cpu.s), ip: cpu.ip, flags: cpu.flags, count: cpu.count },
      dos: {
        handles: dos.handles.map((h) => (h ? { ...h } : null)),
        written: [...dos.written].filter(([n]) => !dos.discard.has(n)).map(([n, f]) => [n, Uint8Array.from(f.data)]),
        cursor: dos.cursor, grid: dos.grid.slice(), ticks: dos.ticks, nextTick: dos.nextTick, psp: dos.psp, dta: dos.dta,
        videoMode: dos.videoMode, port61: dos.port61, picMask: dos.picMask,
      },
      drawn: this.drawn.map((d) => ({ ...d })),
      scripting: this.scripting,
    };
  }

  restore(s) {
    const dos = this.dos, mem = dos.mem;
    mem.set(this.baseline, 0);
    for (const [off, bytes] of s.diff) mem.set(bytes, off);
    const cpu = dos.cpu;
    cpu.r.set(s.cpu.r); cpu.s.set(s.cpu.s); cpu.ip = s.cpu.ip; cpu.flags = s.cpu.flags; cpu.count = s.cpu.count;
    cpu.pendingIrq = []; cpu.stop = false; cpu.retry = false; cpu.skipIret = false; cpu.halted = false;
    const d = s.dos;
    dos.handles = d.handles.map((h) => (h ? { ...h } : null));
    // Files the game wrote (RESTART.DAT, made at start-up) stay as they are
    // unless the snapshot has its own.
    if (d.written?.length) {
      dos.written = new Map(d.written.map(([n, data]) => [n, { data: Array.from(data) }]));
      for (const n of dos.discard) dos.written.set(n, { data: [] });
    }
    dos.cursor = d.cursor; dos.grid.set(d.grid); dos.ticks = d.ticks; dos.nextTick = d.nextTick; dos.psp = d.psp; dos.dta = d.dta;
    dos.videoMode = d.videoMode; dos.port61 = d.port61; dos.picMask = d.picMask;
    dos.keys = [];
    dos.keyPolls = 0;
    dos.state = 'key';
    this.drawn = s.drawn.map((x) => ({ ...x }));
    this.scripting = s.scripting;
    this.script = '';
  }
}
