// ZIL -> JavaScript compiler for Infocom games (version-3 Z-machine era ZIL).
//
// Reads a game's original ZIL sources, builds the Z-machine style data image
// (object tree, property tables, vocabulary, syntax tables, static tables)
// and translates every ROUTINE into a readable async JavaScript function.
//
// Usage: node tools/zil2js/compile.mjs [game|all]   (writes web/src/games/<game>/*.js)
// Games are configured in tools/zil2js/games.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZil, show } from './reader.mjs';
import { encodeText, dictBytes, dictKey, decodeText } from '../../web/src/engine/zscii.js';
import { GAMES } from './games.mjs';
import { MDL } from './mdl.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');

// Values that refer to strings and routines (the Z-machine's packed addresses)
// are numbered from these bases, so they never collide with small constants,
// object numbers or table addresses that share a table with them.
const STRING_BASE = 8192;
const ROUTINE_BASE = 20480;

// The game being compiled (set by compileAll).
let CFG = null;
let GAME_ID = null;

const warnings = [];
function warn(msg) { warnings.push(msg); }

// ---------------------------------------------------------------------------
// Load & flatten top-level definitions
// ---------------------------------------------------------------------------

const isNode = (x) => x && typeof x === 'object' && typeof x.t === 'string';

// Numeric CONSTANTs and SETGs seen anywhere at top level (including those nested
// in GLOBAL initialisers), for compile-time expressions like %<- ,A ,B>.
const COMPILE_CONSTANTS = new Map();
function collectCompileConstants(nodes) {
  const visit = (n, top) => {
    if (!isNode(n) || n.t !== 'form') return;
    const it = n.items;
    const h = it[0]?.v;
    if ((h === 'CONSTANT' || h === 'SETG') && it[1]?.t === 'atom' && it[2]?.t === 'num') COMPILE_CONSTANTS.set(it[1].v, it[2].v);
    if (top && (h === 'GLOBAL' || h === 'CONSTANT')) it.slice(2).forEach((x) => visit(x, false));
    if (!top && h === 'SETG') return;
  };
  nodes.forEach((n) => visit(n, true));
}

/**
 * Evaluate the small subset of MDL used in compile-time conditionals (%<...>):
 * COND, GASSIGNED?, ==?/=?/EQUAL?, NOT, AND, OR, global values of the game's
 * compile-time settings (e.g. ,ZORK-NUMBER), numbers, T and quoted code.
 * Returns a JS value (boolean/number) or a ZIL node to splice in.
 */
function evalCompileTime(node) {
  if (!node) return null;
  switch (node.t) {
    case 'num': return node.v;
    case 'str': return node;
    case 'quote': return node.v;
    case 'atom': return node.v === 'T' ? true : node;
    case 'gval': {
      const name = node.v.v;
      if (name in CFG.values) return CFG.values[name];
      if (COMPILE_CONSTANTS.has(name)) return COMPILE_CONSTANTS.get(name);
      return false; // unassigned at compile time
    }
    case 'macro': return evalCompileTime(node.v);
    case 'form': {
      if (!node.items.length) return false;
      const h = node.items[0].v;
      const args = node.items.slice(1);
      switch (h) {
        case 'COND':
          for (const clause of args) {
            const test = evalCompileTime(clause.items[0]);
            if (test) return clause.items.length > 1 ? evalCompileTime(clause.items[clause.items.length - 1]) : test;
          }
          return null;
        case 'GASSIGNED?': return CFG.assigned.includes(args[0].v) || args[0].v in CFG.values;
        case 'NOT': return !evalCompileTime(args[0]);
        case 'AND': { let r = true; for (const a of args) { r = evalCompileTime(a); if (!r) return r; } return r; }
        case 'OR': { for (const a of args) { const r = evalCompileTime(a); if (r) return r; } return false; }
        case '==?': case '=?': case 'EQUAL?': {
          const [a, ...rest] = args.map(evalCompileTime);
          return rest.some((b) => b === a);
        }
        case 'N==?': case 'N=?': return evalCompileTime(args[0]) !== evalCompileTime(args[1]);
        case '+': return args.reduce((a, n) => a + Number(evalCompileTime(n)), 0);
        case '*': return args.reduce((a, n) => a * Number(evalCompileTime(n)), 1);
        case '-': return args.length === 1 ? -evalCompileTime(args[0]) : args.slice(1).reduce((a, n) => a - Number(evalCompileTime(n)), Number(evalCompileTime(args[0])));
        case '/': return args.slice(1).reduce((a, n) => Math.trunc(a / Number(evalCompileTime(n))), Number(evalCompileTime(args[0])));
        case 'SETG': { const v = evalCompileTime(args[1]); if (typeof v === 'number') CFG.values[args[0].v] = v; return v; }
      }
      // Any other form: code to be compiled as-is.
      return node;
    }
    case 'list': return node;
  }
  throw new Error('Unsupported compile-time expression: ' + show(node));
}

/** Replace %<...> nodes nested anywhere inside a form or list by their result. */
function expandMacros(node) {
  if (!isNode(node)) return node;
  if (node.items) {
    const items = [];
    for (const child of node.items) {
      if (child.t === 'macro') {
        const r = evalCompileTime(child.v);
        if (isNode(r)) items.push(expandMacros(r));
        else if (r === true) items.push({ t: 'atom', v: 'T' });
        else if (typeof r === 'number') items.push({ t: 'num', v: r });
        // false/null: nothing is inserted
      } else {
        items.push(expandMacros(child));
      }
    }
    return { ...node, items };
  }
  if (node.v && isNode(node.v) && node.t !== 'macro') return { ...node, v: expandMacros(node.v) };
  return node;
}

function topLevelForms() {
  const out = [];
  const visit = (node, file) => {
    if (!node) return;
    if (node.t === 'macro') {
      const r = evalCompileTime(node.v);
      if (isNode(r)) visit(r, file);
      return;
    }
    if (node.t === 'quote') return visit(node.v, file);
    if (node.t === 'list') { node.items.forEach((n) => visit(n, file)); return; }
    if (node.t !== 'form') return;
    const head = node.items[0]?.v;
    if (head === 'PROG') { node.items.slice(2).forEach((n) => visit(n, file)); return; }
    // A top-level COND is evaluated when the file is loaded, i.e. at compile time.
    if (head === 'COND') {
      for (const clause of node.items.slice(1)) {
        if (evalCompileTime(clause.items[0])) { clause.items.slice(1).forEach((n) => visit(n, file)); break; }
      }
      return;
    }
    const expanded = expandMacros(node);
    expanded.file = file;
    out.push(expanded);
  };
  const parsed = [];
  for (const f of CFG.files) {
    const dir = path.join(ROOT, CFG.srcDir);
    const name = fs.readdirSync(dir).find((n) => n.toLowerCase() === f.toLowerCase() + '.zil');
    if (!name) throw new Error(`${GAME_ID}: missing source file ${f}.zil`);
    let text = fs.readFileSync(path.join(dir, name), 'latin1');
    if (CFG.fixups?.[f]) text = CFG.fixups[f](text);
    parsed.push([f, readZil(text, name)]);
  }
  COMPILE_CONSTANTS.clear();
  parsed.forEach(([, nodes]) => collectCompileConstants(nodes));
  for (const [f, nodes] of parsed) for (const node of nodes) visit(node, f);
  return out;
}

/** Decode Z-text from a story file, expanding abbreviations (z-chars 1-3). */
function decodeStory(d, addr, depth = 0) {
  const A = ['abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', ' \n0123456789.,!?_#\'"/\\-:()'];
  const abbr = (d[0x18] << 8) | d[0x19];
  let out = '', alph = 0, esc = -1, hi = 0, ab = -1;
  for (;;) {
    const w = (d[addr] << 8) | d[addr + 1];
    addr += 2;
    for (const z of [(w >> 10) & 31, (w >> 5) & 31, w & 31]) {
      if (ab >= 0) {
        const entry = abbr + 2 * (32 * (ab - 1) + z);
        if (depth < 2) out += decodeStory(d, ((d[entry] << 8) | d[entry + 1]) * 2, depth + 1);
        ab = -1; continue;
      }
      if (esc === 0) { hi = z; esc = 1; continue; }
      if (esc === 1) { out += String.fromCharCode((hi << 5) | z); esc = -1; continue; }
      if (z === 0) { out += ' '; continue; }
      if (z >= 1 && z <= 3) { ab = z; continue; }
      if (z === 4) { alph = 1; continue; }
      if (z === 5) { alph = 2; continue; }
      if (alph === 2 && z === 6) { esc = 0; alph = 0; continue; }
      out += A[alph][z - 6]; alph = 0;
    }
    if (w & 0x8000) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inferring per-game settings from the sources and the original story file
// ---------------------------------------------------------------------------

const sourceText = (name) => {
  const dir = path.join(ROOT, CFG.srcDir);
  const file = fs.readdirSync(dir).find((n) => n.toLowerCase() === name.toLowerCase());
  return file ? fs.readFileSync(path.join(dir, file), 'latin1') : null;
};

/**
 * Fill in what a game's configuration leaves out:
 *  - files: the files the main .zil inserts (INSERT-FILE / IFILE), then the main file;
 *  - values: compile-time settings the main file sets with <SETG NAME number>;
 *  - prob: the semantics of the game's own PROB macro.
 */
function inferConfig(cfg) {
  CFG = cfg;
  cfg.assigned ??= ['PREDGEN', 'ZILCH'];
  cfg.fixups ??= {};
  if (!cfg.files && cfg.main) {
    const main = sourceText(cfg.main + '.zil');
    if (!main) throw new Error(`${GAME_ID}: main file ${cfg.main}.zil not found`);
    const files = [];
    for (const node of readZil(main, cfg.main)) {
      if (node.t !== 'form') continue;
      const h = node.items[0]?.v;
      // INSERT-FILE, IFILE, or a game's own loader such as Infidel's INSERT-CRUFTY.
      if (/^(INSERT-FILE|IFILE|INSERT-[A-Z]+)$/.test(h) && node.items[1]?.t === 'str') {
        const f = node.items[1].v.toLowerCase();
        if (sourceText(f + '.zil') && !files.includes(f)) files.push(f);
      }
    }
    cfg.files = [...files, cfg.main];
  }
  if (!cfg.values) {
    cfg.values = {};
    if (cfg.main) {
      for (const node of readZil(sourceText(cfg.main + '.zil'), cfg.main)) {
        const it = node.t === 'form' ? node.items : [];
        if (it[0]?.v === 'SETG' && it[1]?.t === 'atom' && it[2]?.t === 'num') cfg.values[it[1].v] = it[2].v;
      }
    }
  }
  if (!cfg.prob) {
    // <DEFMAC PROB ...>: Zork-style <G? base <RANDOM 100>> means random < n;
    // Planetfall-style <NOT <L? base <RANDOM 100>>> means random <= n.
    cfg.prob = 'le';
    for (const f of cfg.files) {
      const t = sourceText(f + '.zil') || '';
      const m = /<DEFMAC\s+PROB\b[\s\S]*?(?=\n<)/.exec(t);
      if (m) { cfg.prob = /G\?\s+\.BASE/.test(m[0]) && !/NOT/.test(m[0]) ? 'lt' : 'le'; break; }
    }
  }
  return cfg;
}

/** Later ZILCH versions store 1 as the value byte of a noun; detect it in the story file. */
function inferNounValue() {
  const file = CFG.storyFile && path.join(ROOT, CFG.srcDir, CFG.storyFile);
  if (!file || !fs.existsSync(file)) return CFG.nounValueDefault;
  const d = fs.readFileSync(file);
  const w = (a) => (d[a] << 8) | d[a + 1];
  const dict = w(8);
  const n = d[dict];
  const len = d[dict + 1 + n];
  const count = w(dict + 2 + n);
  const start = dict + 4 + n;
  let ones = 0, zeros = 0;
  for (let i = 0; i < count; i++) {
    const a = start + i * len;
    if (d[a + 4] === 0x80) (d[a + 5] === 1 ? ones++ : zeros++);
  }
  return ones > zeros ? 1 : undefined;
}

/** Read the original story file (object names, release, serial) if the game has one. */
function readStoryFile() {
  if (!CFG.storyFile) return null;
  const file = path.join(ROOT, CFG.srcDir, CFG.storyFile);
  if (!fs.existsSync(file)) return null;
  const d = fs.readFileSync(file);
  const w = (a) => (d[a] << 8) | d[a + 1];
  if (d[0] !== 3) throw new Error(`${CFG.storyFile}: only version-3 story files are supported`);
  const objTable = w(0x0a) + 62;
  const names = [];
  // The object table ends where the first property table begins.
  let firstProp = Infinity;
  for (let n = 1; objTable + (n - 1) * 9 < firstProp; n++) {
    const a = objTable + (n - 1) * 9;
    const pt = w(a + 7);
    firstProp = Math.min(firstProp, pt);
    names.push(d[pt] ? decodeStory(d, pt + 1) : '');
  }
  return {
    data: d,
    release: w(2),
    serial: String.fromCharCode(...d.slice(18, 24)),
    objectNames: names,
    parents: names.map((_, i) => d[objTable + i * 9 + 4]),
  };
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

function jsName(name) {
  let s = name.replace(/-/g, '_').replace(/\?/g, '$').replace(/[#!]/g, '$').replace(/[^A-Za-z0-9_$]/g, '_');
  if (/^[0-9]/.test(s)) s = '_' + s;
  return s;
}

const JS_RESERVED = new Set(('break case catch class const continue debugger default delete do else enum export ' +
  'extends false finally for function if import in instanceof new null return super switch this throw true try ' +
  'typeof var void while with yield let static implements interface package private protected public await async ' +
  'arguments eval undefined').split(' '));

// ---------------------------------------------------------------------------
// String handling
// ---------------------------------------------------------------------------

/** Convert a ZIL string literal to the text the game prints. */
// The character that stands for a line break in strings (<SETG CRLF-CHARACTER !\~>).
let CRLF_CHAR = '|';

function zilText(s) {
  // "|" is a line break; a source line break directly after "|" is dropped;
  // any other source line break becomes a space.
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === CRLF_CHAR) {
      out += '\n';
      if (s[i + 1] === '\r') i++;
      if (s[i + 1] === '\n') i++;
    } else if (c === '\r') {
      continue;
    } else if (c === '\n') {
      out += ' ';
    } else out += c;
  }
  // The compiler that built these releases printed one space after a sentence
  // even where the source has two (verified against the original story files).
  return out.replace(/([.!?]["')]?) {2,}(?=\S)/g, '$1 ');
}

// ---------------------------------------------------------------------------
// The compiler proper
// ---------------------------------------------------------------------------

class Compiler {
  constructor() {
    this.constants = new Map();   // name -> number | {table}
    this.globals = new Map();     // name -> init node
    this.objects = [];            // {name, room, props: [list nodes]}
    this.objIndex = new Map();
    this.routines = new Map();    // name -> form
    this.syntaxes = [];
    this.synonymDirs = [];
    this.buzz = [];
    this.directions = [];
    this.propdefs = new Map();
    this.flags = new Map();
    this.bitSynonyms = new Map();
    this.props = new Map();
    this.strings = [null];        // id -> text
    this.stringIds = new Map();
    this.routineIds = new Map();  // name -> id
    this.mem = [];
    this.memNotes = [];
  }

  // ---------------- collection ----------------

  collect(forms) {
    this.mdl = new MDL({ onWarn: warn });
    for (const [k, v] of Object.entries(CFG.values)) this.mdl.globals.set(k, typeof v === 'number' ? { t: 'num', v } : v);
    for (const [k, v] of COMPILE_CONSTANTS) if (!this.mdl.globals.has(k)) this.mdl.globals.set(k, { t: 'num', v });
    // Built-in constants defined by the ZIL compiler itself.
    const builtins = {
      'PS?OBJECT': 128, 'PS?VERB': 64, 'PS?ADJECTIVE': 32, 'PS?DIRECTION': 16, 'PS?PREPOSITION': 8,
      'PS?BUZZ-WORD': 4, 'P1?NONE': 0, 'P1?OBJECT': 0, 'P1?VERB': 1, 'P1?ADJECTIVE': 2, 'P1?DIRECTION': 3,
    };
    for (const [k, v] of Object.entries(builtins)) this.constants.set(k, { t: 'num', v });
    for (const f of forms) {
      const head = f.items[0]?.v;
      const it = f.items;
      switch (head) {
        // A trailing ! (MDL's empty-oblist trailer) is not part of the name.
        case 'ROUTINE': this.routines.set(it[1].v.replace(/!$/, ''), f); break;
        case 'OBJECT': case 'ROOM':
          if (this.objIndex.has(it[1].v)) throw new Error('duplicate object ' + it[1].v);
          this.objIndex.set(it[1].v, this.objects.length + 1);
          this.objects.push({ name: it[1].v, room: head === 'ROOM', props: it.slice(2) });
          break;
        case 'GLOBAL': this.globals.set(it[1].v.replace(/:.*$/, ''), it[2]); break;
        case 'CONSTANT': this.constants.set(it[1].v, it[2]); break;
        case 'SETG':
          if (it[1].v === 'CRLF-CHARACTER' && it[2]?.t === 'char') CRLF_CHAR = it[2].v;
          // <SETG ROOM? ,HERE?>: an alias for a compile-time function.
          if (it[2]?.t === 'gval' && this.mdl.has(it[2].v.v)) {
            this.mdl.defs.set(it[1].v, this.mdl.defs.get(it[2].v.v));
            break;
          }
          if (it[2]?.t === 'num' || it[2]?.t === 'atom' || it[2]?.t === 'str') this.mdl.globals.set(it[1].v, it[2]);
          // Top-level SETGs are compile-time constants unless declared as GLOBALs.
          if (!this.constants.has(it[1].v)) this.constants.set(it[1].v, it[2]);
          break;
        case 'SYNTAX': this.syntaxes.push(it.slice(1)); break;
        case 'SYNONYM': case 'VERB-SYNONYM': case 'PREP-SYNONYM': case 'ADJ-SYNONYM': case 'DIR-SYNONYM': this.synonymDirs.push(it.slice(1).map((a) => a.v)); break;
        case 'BUZZ': this.buzz.push(...it.slice(1).map((a) => a.v)); break;
        case 'DIRECTIONS': this.directions.push(...it.slice(1).map((a) => a.v)); break;
        case 'PROPDEF': this.propdefs.set(it[1].v, it[2].v); break;
        case 'TELL-TOKENS': this.tellTokens = parseTellTokens(it.slice(1)); break;
        case 'BIT-SYNONYM': for (const a of it.slice(2)) if (a.t === 'atom') this.bitSynonyms.set(a.v, it[1].v); break;
        case 'DEFMAC': case 'DEFINE':
          this.mdl.define(f);
          break;
        case 'VERSION': case 'FREQUENT-WORDS?': case 'OR': case 'PRINC':
        case 'GC': case 'BLOAT': case 'IFILE': case 'ENDLOAD': case 'GDECL': case 'SET': case 'COND':
        case 'ID': case 'IMAGE': case 'INSERT-FILE': case 'SNAME': case 'PRINC':
          break;
        default:
          warn('ignored top-level form ' + head);
      }
    }
    this.expandUserMacros();
    this.numberObjects();
    // Globals declared with GLOBAL override same-named top-level SETG constants.
    for (const g of this.globals.keys()) {
      if (this.constants.has(g) && !this.isConstantDecl(g)) this.constants.delete(g);
    }
  }

  isConstantDecl() { return false; }

  /**
   * Later ZILCH versions stored a verb's syntaxes in reverse source order.
   * Look for the syntax lists in the original story file to tell which.
   */
  inferSyntaxOrder() {
    const d = this.story?.data;
    if (!d) return 'source';
    const key = (s) => `${s.objs & 3},${s.prep1 ? 1 : 0},${s.prep2 ? 1 : 0},${s.fwim1 ? 1 : 0},${s.fwim2 ? 1 : 0}`;
    let fwd = 0, rev = 0;
    for (const list of this.verbSyntax.values()) {
      if (list.length < 2) continue;
      const f = list.map(key).join(';');
      const r = [...list].reverse().map(key).join(';');
      if (f === r) continue;
      for (let p = 64; p < d.length - 8 * list.length; p++) {
        if (d[p] !== list.length) continue;
        const ks = [];
        for (let k = 0; k < list.length; k++) {
          const e = p + 1 + 8 * k;
          ks.push(`${d[e] & 3},${d[e + 1] ? 1 : 0},${d[e + 2] ? 1 : 0},${d[e + 3] ? 1 : 0},${d[e + 4] ? 1 : 0}`);
        }
        const k = ks.join(';');
        if (k === f) fwd++;
        else if (k === r) rev++;
      }
    }
    if (process.env.ZDEBUG) console.error('syntax order votes', { fwd, rev });
    return rev > fwd ? 'reverse' : 'source';
  }

  /**
   * Expand uses of the game's own DEFMACs and compile-time DEFINEs everywhere
   * (routines, objects, globals, constants). Macros the compiler implements
   * itself are left alone, as are names that are also routines.
   */
  expandUserMacros() {
    // A game whose own TELL prints differently from the standard one (e.g.
    // Cutthroats: D calls DPRINT, PRSO/PRSI tokens) gets its TELL expanded.
    this.gameTell = false;
    if (this.mdl.has('TELL') && !this.routines.has('TELL')) {
      try {
        const probe = show(this.mdl.expand({ t: 'form', items: [{ t: 'atom', v: 'TELL' }, { t: 'atom', v: 'D' }, { t: 'gval', v: { t: 'atom', v: 'X' } }] }));
        this.gameTell = !/<PRINTD /.test(probe);
      } catch (e) { if (process.env.ZDEBUG) console.error('TELL probe', e.message); }
    }
    const expandable = (h) => h && this.mdl.has(h) && (!NATIVE_MACROS.has(h) || (h === 'TELL' && this.gameTell)) && !this.routines.has(h);
    const walk = (node, depth = 0) => {
      if (!node || typeof node !== 'object' || !node.t) return node;
      if (node.t === 'form' && !node.native && node.items.length && node.items[0].t === 'atom' && expandable(node.items[0].v)) {
        if (depth > 50) throw new Error('macro expansion too deep: ' + show(node));
        let r;
        try { r = this.mdl.expand(node); } catch (e) { if (process.env.ZDEBUG) console.error(e.stack); throw new Error(`expanding ${show(node).slice(0, 120)}: ${e.message}`); }
        if (r === null) return { t: 'form', items: [] };
        if (node.items[0].v === 'TELL') return walk(tellFromExpansion(r), depth + 1);
        if (r.t === 'atom' && r.v === 'T') return r;
        return walk(r, depth + 1);
      }
      if (node.items) return { ...node, items: node.items.map((x) => walk(x, depth)) };
      if (node.v && typeof node.v === 'object' && node.v.t) return { ...node, v: walk(node.v, depth) };
      return node;
    };
    for (const [name, form] of this.routines) this.routines.set(name, walk(form));
    for (const o of this.objects) o.props = o.props.map((p) => walk(p));
    for (const [name, init] of this.globals) if (init) this.globals.set(name, walk(init));
    for (const [name, v] of this.constants) if (v && typeof v === 'object') this.constants.set(name, walk(v));
  }

  // Object numbers are observable: the game compares PRSO (which holds a
  // direction's property number after a WALK) with object constants such as
  // NOT-HERE-OBJECT.  To behave exactly like the original we reuse the object
  // numbering ZILCH chose, taken from its data listing or from the original
  // story file when one is available.
  numberObjects() {
    this.sourceObjects = this.objects.slice();
    let order = null;
    if (CFG.objectOrder?.zap) {
      const listing = path.join(ROOT, CFG.srcDir, CFG.objectOrder.zap);
      if (fs.existsSync(listing)) {
        order = [];
        for (const l of fs.readFileSync(listing, 'latin1').split('\n')) {
          const m = /^\s+\.OBJECT ([^,]+),/.exec(l);
          if (m) order.push(m[1]);
        }
      }
    } else if (CFG.objectOrder?.story && this.story) {
      order = this.matchStoryObjects();
    }
    const byName = new Map(this.objects.map((o) => [o.name, o]));
    if (!order || order.length !== this.objects.length || !order.every((n) => byName.has(n))) {
      if (order) warn('object numbering from the original does not fit the source; using source order');
      return;
    }
    this.objects = order.map((n) => byName.get(n));
    this.objIndex = new Map(this.objects.map((o, i) => [o.name, i + 1]));
    this.objectsMatchStory = !!this.story && this.story.objectNames.length === this.objects.length;
  }

  /**
   * Take the attribute numbers from the original story file: a flag gets the
   * bit that is set on exactly the same objects. Parsers compare flag numbers
   * (e.g. a syntax without FIND has 0, and GWIM tests for RMUNGBIT), so
   * the numbers matter.
   */
  flagsFromStory() {
    if (!this.objectsMatchStory) return;
    const d = this.story.data;
    const objTable = ((d[10] << 8) | d[11]) + 62;
    const n = this.objects.length;
    const bitSets = [];
    for (let b = 0; b < 32; b++) {
      const set = [];
      for (let i = 0; i < n; i++) if (d[objTable + i * 9 + (b >> 3)] & (0x80 >> (b & 7))) set.push(i);
      bitSets.push(set.join(','));
    }
    const flagSets = new Map();
    this.objects.forEach((o, i) => {
      for (const p of o.props) {
        if (p.items[0].v !== 'FLAGS') continue;
        for (const a of p.items.slice(1)) {
          const f = this.bitSynonyms.get(a.v) ?? a.v;
          if (!flagSets.has(f)) flagSets.set(f, new Set());
          flagSets.get(f).add(i);
        }
      }
    });
    const assigned = new Map();
    const usedBits = new Set();
    for (const [f, set] of flagSets) {
      const key = [...set].sort((a, b) => a - b).join(',');
      const b = bitSets.findIndex((k, i) => k === key && !usedBits.has(i));
      if (b >= 0) { assigned.set(f, b); usedBits.add(b); }
    }
    const unmatched = [...this.flags.keys()].filter((f) => !assigned.has(f));
    if (unmatched.length) warn(`flags not found in the story file (numbered freely): ${unmatched.join(' ')}`);
    let free = 0;
    for (const f of unmatched) {
      while (usedBits.has(free)) free++;
      assigned.set(f, free); usedBits.add(free);
    }
    this.flags = new Map([...assigned].sort((a, b) => a[1] - b[1]));
    this.flagNext = () => { let b = 0; while ([...this.flags.values()].includes(b)) b++; return b; };
  }

  /** Match source objects to the story file's object numbers by name and location. */
  matchStoryObjects() {
    const { objectNames, parents } = this.story;
    if (objectNames.length !== this.objects.length) {
      warn(`story file has ${objectNames.length} objects, source has ${this.objects.length}`);
      return null;
    }
    const descOf = (o) => {
      const d = o.props.find((p) => p.items[0].v === 'DESC');
      return d ? zilText(d.items[1].v) : '';
    };
    const locOf = (o) => {
      const p = o.props.find((q) => (q.items[0].v === 'IN' && !this.isExit(q)) || q.items[0].v === 'LOC');
      return p ? p.items[1].v : null;
    };
    const d = this.story.data;
    const w = (a) => (d[a] << 8) | d[a + 1];
    const objTable = w(10) + 62;
    const storySig = (i) => {
      let bits = 0;
      for (let k = 0; k < 4; k++) for (let x = d[objTable + i * 9 + k]; x; x &= x - 1) bits++;
      let p = w(objTable + i * 9 + 7);
      p += 1 + 2 * d[p];
      let props = 0;
      while (d[p]) { props++; p += 1 + (d[p] >> 5) + 1; }
      return `${bits}/${props}`;
    };
    const sourceSig = (o) => {
      const flags = new Set();
      let props = 0;
      for (const p of o.props) {
        const h = p.items[0].v;
        if (h === 'FLAGS') p.items.slice(1).forEach((a) => flags.add(this.bitSynonyms.get(a.v) ?? a.v));
        else if (h !== 'DESC' && !((h === 'IN' || h === 'LOC') && !this.isExit(p))) props++;
      }
      return `${flags.size}/${props}`;
    };
    const order = new Array(objectNames.length).fill(null);
    const used = new Set();
    // Pass 1: unique names. Pass 2: names plus parent. Pass 3: whatever is left, in order.
    for (let pass = 1; pass <= 3; pass++) {
      for (let i = 0; i < objectNames.length; i++) {
        if (order[i]) continue;
        let cands = this.objects.filter((o) => !used.has(o.name) && descOf(o) === objectNames[i]);
        if (pass >= 2 && cands.length > 1) {
          const parent = parents[i] ? objectNames[parents[i] - 1] : null;
          cands = cands.filter((o) => {
            const l = locOf(o);
            const lo = l && this.objects.find((x) => x.name === l);
            return lo ? descOf(lo) === parent : !parent;
          });
        }
        if (pass >= 2 && cands.length > 1) {
          // Same name and place (e.g. ROOMS and GLOBAL-OBJECTS): compare the
          // number of attributes and properties.
          const sig = storySig(i);
          const narrowed = cands.filter((o) => sourceSig(o) === sig);
          if (narrowed.length) cands = narrowed;
        }
        if (cands.length === 1 || (pass === 3 && cands.length)) {
          order[i] = cands[0].name;
          used.add(cands[0].name);
        }
      }
    }
    if (order.some((x) => !x)) {
      const missing = order.map((x, i) => (x ? null : `#${i + 1} "${objectNames[i]}"`)).filter(Boolean);
      const left = this.objects.filter((o) => !used.has(o.name)).map((o) => `${o.name} "${descOf(o)}"`);
      warn(`could not match every object to the story file: ${missing.join(', ')} / unmatched source: ${left.join(', ')}`);
      return null;
    }
    return order;
  }


  // ---------------- numbering ----------------

  number() {
    // Flags, in order of first appearance in object definitions.
    for (const o of this.objects) {
      for (const p of o.props) {
        if (p.items[0].v === 'FLAGS') for (const a of p.items.slice(1)) this.flag(a.v);
      }
    }
    this.flagsFromStory();
    // Properties: directions take the highest numbers.
    let pn = 31;
    for (const d of this.directions) this.props.set(d, pn--);
    this.lowDirection = pn + 1;
    this.constants.set('LOW-DIRECTION', { t: 'num', v: this.lowDirection });
    const dirSet = new Set(this.directions);
    const special = new Set(['IN', 'FLAGS', 'DESC', 'SYNONYM', 'ADJECTIVE', 'GLOBAL', 'PSEUDO']);
    const propNames = ['SYNONYM', 'ADJECTIVE', 'GLOBAL', 'PSEUDO'];
    for (const name of this.propdefs.keys()) propNames.push(name);
    for (const o of this.objects) {
      for (const p of o.props) {
        const name = p.items[0].v;
        if (name === 'IN' && this.isExit(p)) continue;
        if (dirSet.has(name)) continue;
        if (special.has(name) && !propNames.includes(name)) continue;
        if (!propNames.includes(name)) propNames.push(name);
      }
    }
    // Also properties only referenced from code (P?FOO).
    for (const name of this.referencedPrefixed('P?')) {
      if (!this.props.has(name) && !propNames.includes(name)) propNames.push(name);
    }
    for (const name of propNames) {
      if (!this.props.has(name)) this.props.set(name, pn--);
    }
    if (pn < 0) throw new Error('too many properties');
  }

  flag(name) {
    if (this.bitSynonyms.has(name)) name = this.bitSynonyms.get(name);
    if (!this.flags.has(name)) {
      this.flags.set(name, this.flagNext ? this.flagNext() : this.flags.size);
      if (this.flags.size > 32) throw new Error('too many flags');
    }
    return this.flags.get(name);
  }

  isExit(p) {
    // (IN ROOMS) is a location; (IN TO X) / (IN "msg") / (IN PER F) are exits.
    return p.items.length !== 2 || p.items[1].t === 'str';
  }

  referencedPrefixed(prefix) {
    if (!this._refs) {
      this._refs = new Set();
      const walk = (n) => {
        if (!n || typeof n !== 'object') return;
        if (n.t === 'atom') this._refs.add(n.v);
        if (n.items) n.items.forEach(walk);
        if (n.v && typeof n.v === 'object') walk(n.v);
      };
      for (const r of this.routines.values()) walk(r);
      for (const g of this.globals.values()) walk(g);
      for (const o of this.objects) o.props.forEach(walk);
    }
    return [...this._refs].filter((a) => a.startsWith(prefix)).map((a) => a.slice(prefix.length));
  }

  // ---------------- strings & routines ----------------

  stringId(text) {
    if (!this.stringIds.has(text)) {
      this.stringIds.set(text, STRING_BASE + this.strings.length);
      this.strings.push(text);
    }
    return this.stringIds.get(text);
  }

  routineId(name, { optional = false } = {}) {
    if (!this.routines.has(name)) {
      if (optional) { warn(`routine ${name} is referenced but not defined (treated as doing nothing)`); return 0; }
      throw new Error('unknown routine ' + name);
    }
    return this.routineIds.get(name);
  }

  // ---------------- vocabulary ----------------

  buildVocabulary() {
    const words = new Map(); // key -> entry
    const byName = new Map(); // source word name -> entry
    const entry = (name) => {
      const text = name === 'PERIOD' ? '.' : name === 'COMMA' ? ',' : name === 'QUOTE' ? '"' : name.toLowerCase();
      const key = dictKey(text);
      let e = words.get(key);
      if (!e) {
        e = { key, text, names: new Set(), object: false, parts: {} , order: [] };
        words.set(key, e);
      }
      e.names.add(name);
      byName.set(name, e);
      return e;
    };
    const setPart = (e, part, value) => {
      if (e.parts[part] === undefined) {
        e.parts[part] = value;
        e.order.push(part);
      }
    };
    this.vocab = { words, byName, entry };
    // Later versions of ZILCH (e.g. Zork I) give nouns a value byte too (1), and
    // their parser's WT? relies on it; Planetfall's parser special-cases nouns.
    const noun = (e) => {
      e.object = true;
      if (CFG.nounValue) setPart(e, 'object', CFG.nounValue);
    };

    // Buzz words
    let b = 255;
    this.buzzNums = new Map();
    for (const w of this.buzz) {
      const name = w === '.' ? 'PERIOD' : w === ',' ? 'COMMA' : w === '"' ? 'QUOTE' : w;
      if (!this.buzzNums.has(name)) this.buzzNums.set(name, b--);
      setPart(entry(name), 'buzz', this.buzzNums.get(name));
    }

    // Synonym groups (canonical word first)
    this.aliasOf = new Map();
    for (const group of this.synonymDirs) {
      for (const a of group.slice(1)) this.aliasOf.set(a, group[0]);
    }
    const canon = (w) => { while (this.aliasOf.has(w)) w = this.aliasOf.get(w); return w; };

    // Syntax: verbs and prepositions
    this.actNums = new Map();
    this.prepNums = new Map();
    let act = 255, prep = 255;
    for (const syn of this.syntaxes) {
      const verb = canon(syn[0].v);
      if (!this.actNums.has(verb)) this.actNums.set(verb, act--);
      for (const n of syn.slice(1)) {
        if (n.t === 'atom' && n.v === '=') break;
        if (n.t === 'atom' && n.v !== 'OBJECT') {
          const p = canon(n.v);
          if (!this.prepNums.has(p)) this.prepNums.set(p, prep--);
        }
      }
    }
    // Adjectives (in order of first appearance)
    this.adjNums = new Map();
    let adj = 255;
    for (const o of this.objects) {
      for (const p of o.props) {
        if (p.items[0].v === 'ADJECTIVE') {
          for (const a of p.items.slice(1)) {
            if (!this.adjNums.has(a.v)) this.adjNums.set(a.v, adj--);
          }
        }
      }
    }
    if (adj < 0) throw new Error('too many adjectives');

    // Assign parts of speech in the order ZILCH did: syntax first, then objects.
    for (const [v, n] of this.actNums) setPart(entry(v), 'verb', n);
    for (const [p, n] of this.prepNums) setPart(entry(p), 'prep', n);
    for (const d of this.directions) setPart(entry(d), 'dir', this.props.get(d));
    for (const o of this.objects) {
      for (const p of o.props) {
        const pname = p.items[0].v;
        if (pname === 'SYNONYM') for (const a of p.items.slice(1)) noun(entry(a.v));
        if (pname === 'ADJECTIVE') for (const a of p.items.slice(1)) setPart(entry(a.v), 'adj', this.adjNums.get(a.v));
        if (pname === 'PSEUDO') {
          for (let i = 1; i < p.items.length; i += 2) noun(entry(p.items[i].v.toUpperCase()));
        }
      }
    }
    // Synonyms share all non-noun parts of speech with their canonical word.
    for (const [alias] of this.aliasOf) {
      const c = byName.get(canon(alias)) || entry(canon(alias));
      const e = entry(alias);
      for (const part of c.order) setPart(e, part, c.parts[part]);
    }
    // Words created at compile time with VOC (e.g. by PSEUDO tables)
    for (const v of this.mdl.vocab) {
      const name = v.word.toUpperCase();
      const part = String(v.part).toUpperCase();
      if (part === 'ADJECTIVE' || part === 'ADJ') {
        if (!this.adjNums.has(name)) this.adjNums.set(name, adj--);
        setPart(entry(name), 'adj', this.adjNums.get(name));
      } else if (part === 'BUZZ') {
        setPart(entry(name), 'buzz', 1);
      } else {
        noun(entry(name));
      }
    }
    // Words referenced from code (W?FOO)
    for (const w of this.referencedPrefixed('W?')) if (!byName.has(w)) entry(w);
    if (CFG.nounValue) for (const e of words.values()) if (e.object) noun(e);
  }

  wordAddr(name) {
    const e = this.vocab.byName.get(name);
    if (!e) throw new Error('unknown word W?' + name);
    return e.addr;
  }

  // ---------------- memory image ----------------

  here() { return this.mem.length; }
  byte(v) { this.mem.push(v & 255); }
  word(v) { v = v & 0xffff; this.mem.push(v >> 8, v & 255); }
  align() { if (this.mem.length & 1) this.mem.push(0); }

  /** Resolve a constant-ish node (used in tables, properties, global initial values). */
  staticValue(node, ctx = 'value') {
    switch (node.t) {
      case 'num': return node.v;
      case 'str': return this.stringId(zilText(node.v));
      case 'form':
        if (node.items.length === 0) return 0;
        if (['TABLE', 'LTABLE', 'ITABLE', 'PTABLE', 'PLTABLE'].includes(node.items[0].v)) return this.table(node);
        if (node.items[0].v === '+') return node.items.slice(1).reduce((a, n) => a + this.staticValue(n), 0);
        if (node.items[0].v === '*') return node.items.slice(1).reduce((a, n) => a * this.staticValue(n), 1);
        if (node.items[0].v === '/') return node.items.slice(2).reduce((a, n) => Math.trunc(a / this.staticValue(n)), this.staticValue(node.items[1]));
        if (node.items[0].v === 'ASCII') return node.items[1].t === 'char' ? node.items[1].v.charCodeAt(0) : this.staticValue(node.items[1]);
        if (node.items[0].v === '-') return this.staticValue(node.items[1]) - node.items.slice(2).reduce((a, n) => a + this.staticValue(n), 0);
        break;
      case 'gval': return this.atomValue(node.v.v);
      case 'atom':
        if (node.v === 'T') return 1;
        return this.atomValue(node.v);
      case 'quote': return this.staticValue(node.v, ctx);
      case 'macro': return this.staticValue(evalCompileTime(node.v), ctx);
      case 'vocab': return this.wordAddr(node.word.toUpperCase());
    }
    throw new Error('cannot evaluate statically: ' + show(node));
  }

  atomValue(name) {
    if (this.objIndex.has(name)) return this.objIndex.get(name);
    if (this.routines.has(name)) return this.routineId(name);
    if (this.flags.has(name)) return this.flags.get(name);
    if (this.bitSynonyms.has(name) && this.flags.has(this.bitSynonyms.get(name))) return this.flags.get(this.bitSynonyms.get(name));
    if (this.constants.has(name)) {
      this.constValues ??= new Map();
      if (!this.constValues.has(name)) {
        const c = this.constants.get(name);
        this.constValues.set(name, typeof c === 'number' ? c : this.staticValue(c));
      }
      return this.constValues.get(name);
    }
    // A global named in a table or property stands for its (initial) value,
    // e.g. the address of the table it holds.
    if (this.globals.has(name)) return this.globalInitialValue(name);
    const m = /^(P|W|A|PR|ACT|V)\?(.*)$/.exec(name);
    if (m) return this.prefixedValue(m[1], m[2]);
    throw new Error('unknown atom ' + name);
  }

  prefixedValue(prefix, name) {
    switch (prefix) {
      case 'P': if (this.props.has(name)) return this.props.get(name); break;
      case 'W': return this.wordAddr(name);
      case 'A': if (this.adjNums.has(name)) return this.adjNums.get(name); break;
      case 'PR': if (this.prepNums.has(name)) return this.prepNums.get(name); break;
      case 'ACT': if (this.actNums.has(name)) return this.actNums.get(name); break;
      case 'V': if (this.actions.has(name)) return this.actions.get(name).num; break;
    }
    throw new Error(`unknown ${prefix}?${name}`);
  }

  globalInitialValue(name) {
    this.globalValues ??= new Map();
    if (!this.globalValues.has(name)) {
      const init = this.globals.get(name);
      this.globalValues.set(name, 0); // guards against self-reference
      this.globalValues.set(name, init == null ? 0 : this.staticValue(init));
    }
    return this.globalValues.get(name);
  }

  globalNumber(name) {
    return this.globalOrder.indexOf(name) + 16;
  }

  table(node) {
    const kind = node.items[0].v;
    let args = node.items.slice(1);
    let byteMode = false, lengthPrefix = kind === 'LTABLE' || kind === 'PLTABLE', lexv = false;
    const readFlags = () => {
      while (args.length && args[0].t === 'list') {
        for (const f of args[0].items) {
          if (f.v === 'BYTE') byteMode = true;
          if (f.v === 'LENGTH') lengthPrefix = true;
          if (f.v === 'LEXV') lexv = true;
        }
        args = args.slice(1);
      }
    };
    // Elements may be marked #BYTE / #WORD individually.
    const element = (a) => {
      if (a.t === 'hash') return { v: this.staticValue(a.v), byte: a.type === 'BYTE' };
      if (a.t === 'form' && (a.items[0]?.v === 'BYTE' || a.items[0]?.v === 'WORD') && a.items.length === 2) {
        return { v: this.staticValue(a.items[1]), byte: a.items[0].v === 'BYTE' };
      }
      return { v: this.staticValue(a), byte: byteMode };
    };
    const put = (e) => (e.byte ? this.byte(e.v) : this.word(e.v));

    if (kind === 'ITABLE') {
      // <ITABLE [NONE|BYTE|WORD] count [(flags)] [element pattern...]>
      let spec = 'NONE';
      if (args[0].t === 'atom') { spec = args[0].v; args = args.slice(1); }
      const count = args[0].v;
      args = args.slice(1);
      if (spec === 'BYTE') { byteMode = true; lengthPrefix = true; }
      if (spec === 'WORD') lengthPrefix = true;
      readFlags();
      const pattern = args.length ? args.map(element) : [{ v: 0, byte: byteMode }];
      this.align();
      const addr = this.here();
      if (lexv) { this.byte(count); this.byte(0); }          // parse buffer: max words, count
      else if (lengthPrefix) (byteMode ? this.byte(count) : this.word(count));
      for (let i = 0; i < count; i++) pattern.forEach(put);
      return addr;
    }
    readFlags();
    // Nested tables and strings must be allocated before this table starts.
    const values = args.map(element);
    this.align();
    const addr = this.here();
    if (lengthPrefix) (byteMode ? this.byte(values.length) : this.word(values.length));
    values.forEach(put);
    return addr;
  }

  buildActions() {
    // V?xxx numbers in order of first use in SYNTAX definitions.
    this.actions = new Map(); // name (without V-) -> {num, routine, pre}
    this.verbSyntax = new Map(); // ACT num -> [{...}]
    const canon = (w) => { while (this.aliasOf.has(w)) w = this.aliasOf.get(w); return w; };
    for (const syn of this.syntaxes) {
      const verb = canon(syn[0].v);
      const actNum = this.actNums.get(verb);
      let objs = 0, prep1 = 0, prep2 = 0, fwim1 = 0, fwim2 = 0, loc1 = 0, loc2 = 0;
      let i = 1;
      let pendingPrep = 0;
      for (; i < syn.length; i++) {
        const n = syn[i];
        if (n.t === 'atom' && n.v === '=') break;
        if (n.t === 'atom' && n.v === 'OBJECT') {
          objs++;
          if (objs === 1) prep1 = pendingPrep; else prep2 = pendingPrep;
          pendingPrep = 0;
        } else if (n.t === 'atom') {
          pendingPrep = this.prepNums.get(canon(n.v));
        } else if (n.t === 'list') {
          if (n.items[0].v === 'FIND') {
            const f = this.flag(n.items[1].v);
            if (objs === 1) fwim1 = f; else fwim2 = f;
          } else {
            let bits = 0;
            for (const a of n.items) {
              bits |= { HELD: 128, CARRIED: 64, 'IN-ROOM': 32, 'ON-GROUND': 16, TAKE: 8, MANY: 4, HAVE: 2 }[a.v] ?? 0;
            }
            if (objs === 1) loc1 = bits; else loc2 = bits;
          }
        }
      }
      if (objs === 0 && pendingPrep) prep1 = pendingPrep;
      const actionRoutine = syn[i + 1].v;
      const pre = syn[i + 2] ? syn[i + 2].v : null;
      const aname = actionRoutine.replace(/^V-/, '');
      if (!this.actions.has(aname)) {
        this.actions.set(aname, { num: this.actions.size, routine: actionRoutine, pre });
      } else if (pre && !this.actions.get(aname).pre) {
        this.actions.get(aname).pre = pre;
      }
      if (!this.verbSyntax.has(actNum)) this.verbSyntax.set(actNum, []);
      this.verbSyntax.get(actNum).push({ objs, prep1, prep2, fwim1, fwim2, loc1, loc2, action: this.actions.get(aname).num, verb, src: syn });
    }
  }

  buildMemory() {
    // Header (64 bytes)
    for (let i = 0; i < 64; i++) this.byte(0);
    this.mem[0] = 3;                 // version
    const release = this.story?.release ?? 1;
    const serial = this.story?.serial ?? '000000';
    this.mem[2] = release >> 8; this.mem[3] = release & 255;
    serial.split('').forEach((c, i) => { this.mem[18 + i] = c.charCodeAt(0); });
    this.mem[56] = 0;

    // Routine ids (1-based, in source order)
    let rid = 1;
    for (const name of this.routines.keys()) this.routineIds.set(name, ROUTINE_BASE + rid++);

    // Global variable numbers (Z-machine numbering starts at 16).
    // HERE, SCORE and MOVES come first: they drive the status line.
    const first = ['HERE', 'SCORE', 'MOVES'];
    for (const n of first) if (!this.globals.has(n)) this.globals.set(n, { t: 'num', v: 0 });
    this.globalOrder = [...first, ...[...this.globals.keys()].filter((g) => !first.includes(g))];

    // Vocabulary entries are placed later, but their addresses are needed by
    // tables (W?FOO), so reserve the dictionary space up front.
    this.align();
    this.dictStart = this.here();
    const entries = [...this.vocab.words.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
    for (const e of entries) {
      e.addr = this.here();
      for (let i = 0; i < 7; i++) this.byte(0);
    }
    this.dictEntries = entries;

    // Global initial values (tables are allocated here)
    this.globalInit = {};
    for (const name of this.globalOrder) {
      const init = this.globals.get(name);
      this.globalInit[name] = this.globalInitialValue(name);
    }
    // Static tables referenced inside routines are allocated during code generation.

    // Syntax tables
    this.align();
    const verbs = [...this.verbSyntax.keys()].sort((a, b) => b - a);
    if ((CFG.syntaxOrder ?? this.inferSyntaxOrder()) === 'reverse') {
      for (const list of this.verbSyntax.values()) list.reverse();
    }
    const vtblEntries = new Map();
    // The game's parser reads compact syntax tables when it defines P-SYNLEN-1.
    const compact = this.constants.has('P-SYNLEN-1');
    for (const act of verbs) {
      const list = this.verbSyntax.get(act);
      vtblEntries.set(act, this.here());
      this.byte(list.length);
      for (const s of list) {
        if (compact) {
          // Compact syntax tables (1987+): prep1 | objects << 6, action,
          // then fwim/loc for each object (and prep2 for the second).
          const n = s.objs & 3;
          this.byte(((n << 6) | (s.prep1 & 63)) & 255); this.byte(s.action);
          if (n >= 1) { this.byte(s.fwim1); this.byte(s.loc1); }
          if (n >= 2) { this.byte(s.prep2); this.byte(s.fwim2); this.byte(s.loc2); }
          continue;
        }
        this.byte(s.objs); this.byte(s.prep1); this.byte(s.prep2); this.byte(s.fwim1);
        this.byte(s.fwim2); this.byte(s.loc1); this.byte(s.loc2); this.byte(s.action);
      }
    }
    this.align();
    const vtbl = this.here();
    for (let act = 255; act >= Math.min(...verbs); act--) this.word(vtblEntries.get(act) || 0);
    const atbl = this.here();
    for (const [, a] of this.actions) this.word(this.routineId(a.routine, { optional: true }));
    const patbl = this.here();
    for (const [, a] of this.actions) this.word(a.pre ? this.routineId(a.pre, { optional: true }) : 0);
    const prtbl = this.here();
    const preps = [...this.prepNums].reverse();
    this.word(preps.length);
    for (const [w, n] of preps) { this.word(this.wordAddr(w)); this.word(n); }
    this.globalInit.VERBS = vtbl;
    this.globalInit.ACTIONS = atbl;
    this.globalInit.PREACTIONS = patbl;
    this.globalInit.PREPOSITIONS = prtbl;
    for (const n of ['VERBS', 'ACTIONS', 'PREACTIONS', 'PREPOSITIONS']) {
      if (!this.globalOrder.includes(n)) this.globalOrder.push(n);
      if (!this.globals.has(n)) this.globals.set(n, null);
    }

    // Fill in dictionary entries
    for (const e of entries) {
      const bytes = dictBytes(e.text);
      let ps = 0;
      const PSBIT = { object: 128, verb: 64, adj: 32, dir: 16, prep: 8, buzz: 4 };
      const P1 = { object: 0, verb: 1, adj: 2, dir: 3, prep: 0, buzz: 0 };
      if (e.object) ps |= 128;
      for (const p of e.order) ps |= PSBIT[p];
      const valued = e.order;
      const v1 = valued[0], v2 = valued[1];
      if (valued.length > 2) warn(`word ${e.text} has too many parts of speech: ${valued}`);
      if (v1) ps |= P1[v1];
      const a = e.addr;
      bytes.forEach((x, i) => { this.mem[a + i] = x; });
      this.mem[a + 4] = ps;
      this.mem[a + 5] = v1 ? e.parts[v1] : 0;
      this.mem[a + 6] = v2 ? e.parts[v2] : 0;
    }

    // Objects
    this.align();
    this.propDefaults = this.here();
    for (let p = 1; p <= 31; p++) {
      const name = [...this.props].find(([, n]) => n === p)?.[0];
      this.word(name && this.propdefs.has(name) ? this.propdefs.get(name) : 0);
    }
    this.objTable = this.here();
    const objs = this.objects.map((o, i) => ({ ...o, num: i + 1, attrs: 0, parent: 0, sibling: 0, child: 0 }));
    for (const o of objs) for (let i = 0; i < 9; i++) this.byte(0);
    // Tree: each object is inserted as the first child of its container.
    for (const so of this.sourceObjects) {
      const o = objs[this.objIndex.get(so.name) - 1];
      for (const p of o.props) {
        const pname = p.items[0].v;
        if (pname === 'IN' && !this.isExit(p) || pname === 'LOC') {
          const parent = objs[this.objIndex.get(p.items[1].v) - 1];
          if (!parent) { warn(`object ${o.name} is in unknown object ${p.items[1].v}; left without a location`); continue; }
          o.parent = parent.num;
          o.sibling = parent.child;
          parent.child = o.num;
        }
        if (pname === 'FLAGS') for (const f of p.items.slice(1)) o.attrs |= (1 << (31 - this.flag(f.v))) >>> 0;
      }
    }
    // Property values first (they may allocate tables), then the property tables.
    for (const o of objs) {
      o.plist = [];
      for (const p of o.props) {
        const pname = p.items[0].v;
        if (pname === 'DESC' || pname === 'FLAGS' || (pname === 'IN' && !this.isExit(p))) continue;
        let bytes;
        try { bytes = this.propBytes(pname, p, o); } catch (e) { throw new Error(`object ${o.name}, property ${show(p)}: ${e.message}`); }
        o.plist.push({ num: this.props.get(pname), bytes });
      }
    }
    for (const o of objs) {
      const desc = o.props.find((p) => p.items[0].v === 'DESC');
      const name = desc ? zilText(desc.items[1].v) : '';
      o.propAddr = this.here();
      const nameBytes = name ? encodeText(name) : [];
      this.byte(nameBytes.length / 2);
      nameBytes.forEach((b) => this.byte(b));
      const plist = o.plist;
      plist.sort((a, b) => b.num - a.num);
      for (const p of plist) {
        if (p.bytes.length < 1 || p.bytes.length > 8) throw new Error(`bad property size ${o.name} ${p.num}`);
        this.byte(32 * (p.bytes.length - 1) + p.num);
        p.bytes.forEach((b) => this.byte(b));
      }
      this.byte(0);
    }
    for (const o of objs) {
      const a = this.objTable + (o.num - 1) * 9;
      this.mem[a] = o.attrs >>> 24; this.mem[a + 1] = (o.attrs >>> 16) & 255;
      this.mem[a + 2] = (o.attrs >>> 8) & 255; this.mem[a + 3] = o.attrs & 255;
      this.mem[a + 4] = o.parent; this.mem[a + 5] = o.sibling; this.mem[a + 6] = o.child;
      this.mem[a + 7] = o.propAddr >> 8; this.mem[a + 8] = o.propAddr & 255;
    }
    if (objs.length > 255) throw new Error('too many objects');
  }

  propBytes(pname, p, o) {
    let vals = p.items.slice(1);
    // (LDESC "text" CR): a stray CR after a string is ignored.
    if (vals.length > 1 && vals[0].t === 'str' && vals.slice(1).every((v) => v.t === 'atom' && v.v === 'CR')) vals = [vals[0]];
    const w = (v) => [(v >> 8) & 255, v & 255];
    if (this.directions.includes(pname) && !(vals.length === 1 && vals[0].t === 'num')) {
      // Exits
      if (vals[0].t === 'str') return w(this.stringId(zilText(vals[0].v)));                 // NEXIT
      if (vals[0].v === 'PER') return [...w(this.routineId(vals[1].v)), 0];                 // FEXIT
      if (vals[0].v === 'SORRY') return w(this.stringId(zilText(vals[1].v)));
      if (vals[0].v !== 'TO') throw new Error('bad exit ' + show(p));
      const room = this.objIndex.get(vals[1].v);
      if (vals.length === 2) return [room];                                                 // UEXIT
      if (vals[2].v !== 'IF') throw new Error('bad exit ' + show(p));
      const elseStr = vals.findIndex((v) => v.t === 'atom' && v.v === 'ELSE');
      const str = elseStr >= 0 ? this.stringId(zilText(vals[elseStr + 1].v)) : 0;
      if (vals[4] && vals[4].v === 'IS') {                                                  // DEXIT
        return [room, this.objIndex.get(vals[3].v), ...w(str), 0];
      }
      return [room, this.globalNumber(vals[3].v), ...w(str)];                               // CEXIT
    }
    switch (pname) {
      case 'SYNONYM': return vals.flatMap((a) => w(this.wordAddr(a.v)));
      case 'ADJECTIVE': return vals.map((a) => this.vocab.byName.get(a.v).parts.adj);
      case 'GLOBAL': return vals.map((a) => this.objIndex.get(a.v));
      case 'PSEUDO': {
        const out = [];
        for (let i = 0; i < vals.length; i += 2) {
          out.push(...w(this.wordAddr(vals[i].v.toUpperCase())), ...w(this.routineId(vals[i + 1].v)));
        }
        return out;
      }
      default:
        // Several values: one word each (as ZILCH stored them).
        if (vals.length !== 1) return vals.flatMap((v) => w(this.staticValue(v)));
        return w(this.staticValue(vals[0]));
    }
  }

  canonWord(w) { while (this.aliasOf.has(w)) w = this.aliasOf.get(w); return w; }

  // ---------------------------------------------------------------------------
  // Code generation
  // ---------------------------------------------------------------------------

  generateCode() {
    const lines = [];
    for (const [name, form] of this.routines) {
      lines.push(new RoutineCompiler(this, name, form).compile());
    }
    return lines.join('\n\n');
  }
}

// ---------------------------------------------------------------------------
// Routine compiler
// ---------------------------------------------------------------------------

class NotExpr extends Error {}

const CONTROL = new Set(['RETURN', 'RTRUE', 'RFALSE', 'RFATAL', 'AGAIN', 'REPEAT', 'PROG', 'RSTACK']);

// ZIL builtins that compile to runtime helper calls with the same arity.
const SIMPLE_HELPERS = {
  'FSET?': 'hasFlag', FSET: 'setFlag', FCLEAR: 'clearFlag', MOVE: 'move', REMOVE: 'remove',
  LOC: 'loc', 'FIRST?': 'first', 'NEXT?': 'next', GETP: 'getProp', PUTP: 'putProp',
  GETPT: 'getPropAddr', PTSIZE: 'propSize', NEXTP: 'nextProp', NTH: 'get', GET: 'get', PUT: 'put', GETB: 'getb', PUTB: 'putb',
  RANDOM: 'random', PRINTD: 'printD', PRINTB: 'printB', PRINTC: 'printC', PRINTN: 'printN',
  PRINT: 'printS', PRINTI: 'print', VALUE: 'globalValue', BTST: 'btst', VERIFY: 'verify',
  DIROUT: 'dirOut', DIRIN: 'dirIn', '/': 'div', MOD: 'mod',
};
const ASYNC_HELPERS = { READ: 'read', SAVE: 'save', RESTORE: 'restore', RESTART: 'restart', QUIT: 'quit' };

class RoutineCompiler {
  constructor(c, name, form) {
    this.c = c;
    this.name = name;
    this.form = form;
    this.locals = new Map(); // ZIL name -> js name
    this.loops = [];
    this.tmpCount = 0;
    this.labelCount = 0;
    this.usesRestart = false;
  }

  localName(n) {
    let s = jsName(n).toLowerCase();
    if (JS_RESERVED.has(s) || RUNTIME_NAMES.has(s)) s += '_';
    return s;
  }

  tmp() {
    const t = `$${++this.tmpCount}`;
    return t;
  }

  compile() {
    const it = this.form.items;
    const argList = it[2].items;
    const params = [];
    const aux = [];
    let mode = 'req';
    for (const a of argList) {
      if (a.t === 'str') { mode = a.v === 'OPTIONAL' ? 'opt' : a.v === 'AUX' || a.v === 'EXTRA' ? 'aux' : mode; continue; }
      const nm = a.t === 'list' ? a.items[0].v : a.v;
      const init = a.t === 'list' ? a.items[1] : null;
      const js = this.localName(nm);
      this.locals.set(nm, js);
      if (mode === 'aux') aux.push({ js, init });
      else params.push({ js, init, opt: mode === 'opt' });
    }
    this.body = it.slice(3);
    const bodyLines = this.block(this.body, { k: 'ret' });
    const out = [];
    const docs = this.docComment();
    if (docs) out.push(docs);
    const paramStr = params.map((p) => (p.opt ? `${p.js} = ${p.init ? this.ex(p.init) : 0}` : p.js)).join(', ');
    out.push(`async function ${jsName(this.name)}(${paramStr}) {`);
    if (process.env.ZIL2JS_COVERAGE) out.push(`globalThis.__cov?.(${JSON.stringify(this.name)});`);
    const decl = [];
    for (const a of aux) decl.push(`${a.js} = ${a.init ? this.ex(a.init) : 0}`);
    if (decl.length) out.push(`  let ${decl.join(', ')};`);
    if (this.tmpCount) out.push(`  let ${Array.from({ length: this.tmpCount }, (_, i) => `$${i + 1}`).join(', ')};`);
    if (this.usesRestart) {
      out.push('restart: for (;;) {');
      bodyLines.forEach((l) => out.push(l));
      out.push('}');
    } else {
      bodyLines.forEach((l) => out.push(l));
    }
    out.push('}');
    return this.reindent(out).join('\n');
  }

  docComment() {
    // Keep the original leading comment of a routine, if it had one.
    return null;
  }

  // ---------------- statements ----------------

  indent(lines) { return lines.map((l) => '  ' + l); }

  block(forms, mode) {
    const out = [];
    // Type declarations (#DECL) are compiler hints only.
    forms = forms.filter((f) => !(f.t === 'hash' && f.type === 'DECL'));
    forms = forms.filter((f) => f.t !== 'str' || forms[forms.length - 1] === f);
    if (forms.length === 0) return this.emitValue('false', mode);
    forms.forEach((f, i) => {
      const last = i === forms.length - 1;
      out.push(...this.stmt(f, last ? mode : { k: 'void' }));
    });
    return this.indent(out);
  }

  emitValue(expr, mode) {
    switch (mode.k) {
      case 'void': return /^[\w$.]+$|^\d+$|^true$|^false$/.test(expr) ? [] : [`${stripParens(expr)};`];
      case 'ret': return [`return ${stripParens(expr)};`];
      case 'set': return [`${mode.v} = ${stripParens(expr)};`];
    }
    throw new Error('bad mode');
  }

  stmt(node, mode) {
    if (node.t === 'form' && node.items.length) {
      const h = node.items[0].t === 'atom' ? node.items[0].v : null;
      const args = node.items.slice(1);
      switch (h) {
        case 'RTRUE': return ['return true;'];
        case 'RFALSE': return ['return false;'];
        case 'RFATAL': return ['return M_FATAL;'];
        case 'RETURN': return this.returnStmt(args[0]);
        case 'AGAIN': {
          const loop = this.loops[this.loops.length - 1];
          if (!loop) { this.usesRestart = true; return ['continue restart;']; }
          return [`continue ${loop.label};`];
        }
        case 'COND': return this.condStmt(args, mode);
        case 'REPEAT': return this.loopStmt(args.slice(1), mode, args[0]);
        case 'PROG': return this.loopStmt(args.slice(1), mode, args[0], true);
        case 'AND': case 'OR':
          if (this.isExpr(node)) break;
          return this.andOrStmt(h, args, mode);
        case 'NOT':
          if (this.isExpr(node)) break;
          {
            const t = this.tmp();
            return [...this.stmt(args[0], { k: 'set', v: t }), ...this.emitValue(`!${t}`, mode)];
          }
        case 'TELL': return this.tellStmt(args, mode);
        case 'SET': case 'SETG':
          if (!this.isExpr(args[1])) {
            const target = this.varRef(args[0], h === 'SETG');
            return [...this.stmt(args[1], { k: 'set', v: target }), ...(mode.k === 'void' ? [] : this.emitValue(target, mode))];
          }
          break;
      }
    }
    if (this.isExpr(node)) return this.emitValue(this.ex(node), mode);
    // Hoist impure arguments of an ordinary call/builtin into temporaries.
    return this.hoisted(node, mode);
  }

  hoisted(node, mode) {
    const out = [];
    const args = node.items.slice(1);
    const newArgs = args.map((a) => {
      if (this.isSimple(a)) return a;
      const t = this.tmp();
      out.push(...this.stmt(a, { k: 'set', v: t }));
      return { t: 'jsraw', v: t };
    });
    const nf = { t: 'form', items: [node.items[0], ...newArgs] };
    out.push(...this.emitValue(this.ex(nf), mode));
    return out;
  }

  isSimple(n) {
    return n.t === 'num' || n.t === 'str' || n.t === 'lval' || n.t === 'gval' || n.t === 'atom' || n.t === 'jsraw' ||
      (n.t === 'form' && n.items.length === 0);
  }

  returnStmt(valNode) {
    // ZILCH semantics (verified against the compiled .zap output):
    // <RETURN value> always returns from the routine, while a bare <RETURN>
    // exits the innermost REPEAT/PROG (or the routine, outside of loops).
    // Older ZILCH (e.g. the 1983 Infidel) kept MDL's meaning instead: any
    // RETURN leaves the innermost loop, with its value.
    const loop = this.loops[this.loops.length - 1];
    if (valNode && !(CFG.oldReturn && loop)) return this.stmt(valNode, { k: 'ret' });
    const val = valNode ?? { t: 'atom', v: 'T' };
    if (!loop) return this.stmt(val, { k: 'ret' });
    if (loop.mode.k === 'ret') return this.stmt(val, { k: 'ret' });
    if (loop.mode.k === 'set') return [...this.stmt(val, loop.mode), `break ${loop.label};`];
    return [...this.stmt(val, { k: 'void' }), `break ${loop.label};`];
  }

  loopStmt(body, mode, bindings, isProg = false) {
    const label = `loop${++this.labelCount}`;
    const out = [];
    if (bindings && bindings.items && bindings.items.length) {
      for (const b of bindings.items) {
        const nm = b.t === 'list' ? b.items[0].v : b.v;
        const js = this.localName(nm);
        this.locals.set(nm, js);
        out.push(`${js} = ${b.t === 'list' ? this.ex(b.items[1]) : 0};`);
      }
    }
    this.loops.push({ label, mode });
    let inner;
    if (isProg) {
      inner = this.block(body, mode);
      if (mode.k !== 'ret') inner.push(`  break ${label};`);
    } else {
      inner = this.block(body, { k: 'void' });
    }
    this.loops.pop();
    const used = inner.some((l) => l.includes(` ${label};`));
    out.push(`${used ? label + ': ' : ''}for (;;) {`, ...inner, '}');
    return out;
  }

  condStmt(clauses, mode) {
    const out = [];
    let closers = 0;
    let first = true;
    let hasElse = false;
    let pendingElse = false;
    for (const clause of clauses) {
      const items = clause.items;
      const test = items[0];
      const body = items.slice(1);
      const isElse = (test.t === 'atom' && (test.v === 'T' || test.v === 'ELSE'));
      const prefix = first ? '' : '} else ';
      if (isElse) {
        if (first) { out.push(...this.block(body, mode).map((l) => l.slice(2))); return out; }
        out.push(`} else {`);
        out.push(...this.block(body.length ? body : [test], mode));
        hasElse = true;
        break;
      }
      if (body.length === 0) {
        // Clause value is the test value itself.
        if (mode.k === 'void') {
          if (this.isExpr(test)) {
            out.push(`${prefix}if (${stripParens(this.ex(test))}) {`);
          } else {
            const t = this.tmp();
            if (!first) { out.push('} else {'); closers++; }
            out.push(...this.indentIf(!first, this.stmt(test, { k: 'set', v: t })));
            out.push(`${first ? '' : '  '}if (${t}) {`);
            if (!first) { pendingElse = true; }
          }
        } else {
          const t = this.tmp();
          if (this.isExpr(test)) {
            out.push(`${prefix}if (${t} = ${stripParens(this.ex(test))}) {`);
          } else {
            if (!first) { out.push('} else {'); closers++; }
            out.push(...this.indentIf(!first, this.stmt(test, { k: 'set', v: t })));
            out.push(`${first ? '' : '  '}if (${t}) {`);
          }
          out.push(...this.indent(this.emitValue(t, mode)));
        }
        first = false;
        continue;
      }
      if (this.isExpr(test)) {
        out.push(`${prefix}if (${stripParens(this.ex(test))}) {`);
      } else {
        const t = this.tmp();
        if (!first) { out.push('} else {'); closers++; }
        out.push(...this.indentIf(!first, this.stmt(test, { k: 'set', v: t })));
        out.push(`${first ? '' : '  '}if (${t}) {`);
      }
      out.push(...this.block(body, mode));
      first = false;
    }
    if (!hasElse && mode.k !== 'void') {
      out.push('} else {');
      out.push(...this.indent(this.emitValue('false', mode)));
    }
    out.push('}');
    for (let i = 0; i < closers; i++) out.push('}');
    return this.fixIndent(out);
  }

  indentIf(cond, lines) { return cond ? this.indent(lines) : lines; }

  fixIndent(lines) {
    // Re-indent nested "} else {" chains produced for impure tests.
    let depth = 0;
    const out = [];
    for (const raw of lines) {
      const l = raw.trimStart();
      const extra = raw.length - l.length;
      if (l.startsWith('}')) depth = Math.max(0, depth - 1);
      out.push('  '.repeat(depth) + ' '.repeat(Math.max(0, extra - 2 * depth > 0 ? extra - 2 * depth : 0)) + l);
      if (l.endsWith('{')) depth++;
    }
    return this.reindent(lines);
  }

  reindent(lines) {
    // Normalise indentation by brace depth (bodies from block() are pre-indented).
    let depth = 0;
    const out = [];
    for (const raw of lines) {
      const l = raw.trim();
      if (l.startsWith('}')) depth--;
      out.push('  '.repeat(Math.max(depth, 0)) + l);
      if (l.endsWith('{')) depth++;
    }
    return out;
  }

  andOrStmt(h, args, mode) {
    const t = mode.k === 'set' ? mode.v : this.tmp();
    const out = [];
    let depth = 0;
    args.forEach((a, i) => {
      const pad = '  '.repeat(depth);
      out.push(...this.stmt(a, { k: 'set', v: t }).map((l) => pad + l));
      if (i < args.length - 1) {
        out.push(`${pad}if (${h === 'AND' ? '' : '!'}${t}) {`);
        depth++;
      }
    });
    for (let i = depth; i > 0; i--) out.push('  '.repeat(i - 1) + '}');
    if (mode.k !== 'set') out.push(...this.emitValue(t, mode));
    return out;
  }

  tellStmt(args, mode) {
    // Group TELL tokens into tell(...) calls. Tokens whose evaluation may print
    // (routine calls) are evaluated in their own statement to keep output order.
    const out = [];
    let parts = [];
    const flush = () => {
      if (parts.length) out.push(`tell(${mergeStrings(parts).join(', ')});`);
      parts = [];
    };
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.t === 'str') { parts.push(JSON.stringify(zilText(a.v))); continue; }
      if (a.t === 'tellcall') { flush(); out.push(...this.stmt(a.v, { k: 'void' })); continue; }
      if (a.t === 'atom' && (a.v === 'CR' || a.v === 'CRLF')) { parts.push('"\\n"'); continue; }
      // The game's own TELL-TOKENS definitions.
      const custom = a.t === 'atom' && this.c.tellTokens?.filter((e) => e.tokens.includes(a.v));
      if (custom?.length) {
        const next = args[i + 1];
        const e = custom.find((e) => !e.arg || e.arg === '*' || (next?.t === 'gval' && next.v.v === e.arg));
        if (e) {
          const x = e.arg ? args[++i] : null;
          const form = substLval(e.template, 'X', x);
          const h = form.items?.[0]?.v;
          const simple = { PRINTD: 'D', PRINTN: 'N', PRINTC: 'C', PRINT: 'S', PRINTB: 'S' }[h];
          if (h === 'CRLF') { parts.push('"\\n"'); continue; }
          if (simple && form.items.length === 2 && this.isExpr(form.items[1]) && !this.mayPrint(form.items[1])) {
            parts.push(`${simple}(${stripParens(this.ex(form.items[1]))})`);
            continue;
          }
          flush();
          out.push(...this.stmt(form, { k: 'void' }));
          continue;
        }
      }
      if (a.t === 'atom' && TELL_TOKENS[a.v]) {
        const x = args[++i];
        const fn = TELL_TOKENS[a.v];
        if (fn === 'A') {
          // <TELL A obj>: the game's own PRINTA routine (article + name).
          flush();
          out.push(`await PRINTA(${stripParens(this.ex(x))});`);
          continue;
        }
        if (this.isExpr(x) && !this.mayPrint(x)) { parts.push(`${fn}(${stripParens(this.ex(x))})`); continue; }
        flush();
        const t = this.tmp();
        out.push(...this.stmt(x, { k: 'set', v: t }));
        out.push(`tell(${fn}(${t}));`);
        continue;
      }
      if (a.t === 'atom' && this.c.props.has(a.v)) {
        // <TELL LDESC obj>: print a property of an object.
        const x = args[++i];
        parts.push(`S(getProp(${stripParens(this.ex(x))}, P.${jsName(a.v)}))`);
        this.c.usedPrefixed.add('P?' + a.v);
        continue;
      }
      if (this.isExpr(a) && !this.mayPrint(a)) { parts.push(`S(${stripParens(this.ex(a))})`); continue; }
      flush();
      const t = this.tmp();
      out.push(...this.stmt(a, { k: 'set', v: t }));
      out.push(`tell(S(${t}));`);
    }
    flush();
    if (mode.k !== 'void') out.push(...this.emitValue('true', mode));
    return out;
  }

  /**
   * An operand of AND/OR. ZILCH compiled <SET X constant> there as a store
   * that always succeeds, even when the constant is 0 or false (Hollywood
   * Hijinx's parser depends on <AND <WT? ...> <SET VAL 0>> being true).
   */
  condOperand(a) {
    const it = a.t === 'form' ? a.items : [];
    if ((it[0]?.v === 'SET' || it[0]?.v === 'SETG') && it.length === 3
        && (it[2].t === 'num' || (it[2].t === 'form' && !it[2].items.length))) {
      return `(${stripParens(this.ex(a))}, true)`;
    }
    return this.ex(a);
  }

  mayPrint(node) {
    // Any routine call might print.
    let found = false;
    const walk = (n) => {
      if (found || !n) return;
      if (n.t === 'form' && n.items.length && n.items[0].t === 'atom') {
        const h = n.items[0].v;
        if (this.c.routines.has(h) || h === 'APPLY' || h === 'PERFORM' || h === 'TELL') found = true;
      }
      if (n.items) n.items.forEach(walk);
    };
    walk(node);
    return found;
  }

  // ---------------- expressions ----------------

  isExpr(node) {
    if (!node || typeof node !== 'object') return true;
    if (node.t !== 'form') return true;
    if (node.items.length === 0) return true;
    const h = node.items[0].t === 'atom' ? node.items[0].v : null;
    if (CONTROL.has(h)) return false;
    if (h === 'TELL') return false;
    if (h === 'COND') {
      return node.items.slice(1).every((cl) => cl.items.length > 0 && cl.items.every((x) => this.isExpr(x)));
    }
    if (['TABLE', 'LTABLE', 'ITABLE', 'PTABLE', 'PLTABLE'].includes(h)) return true;
    return node.items.slice(1).every((x) => this.isExpr(x));
  }

  varRef(atomNode, isGlobal) {
    const n = atomNode.v;
    if (!isGlobal && this.locals.has(n)) return this.locals.get(n);
    if (this.c.globals.has(n)) return `g.${jsName(n)}`;
    if (this.locals.has(n)) return this.locals.get(n);
    throw new Error(`${this.name}: unknown variable ${typeof n === "string" ? n : show(atomNode)}`);
  }

  gval(name) {
    const c = this.c;
    if (c.globals.has(name)) return `g.${jsName(name)}`;
    if (c.objIndex.has(name) || c.flags.has(name)) return jsName(name);
    if (c.bitSynonyms.has(name) && c.flags.has(c.bitSynonyms.get(name))) return `${jsName(c.bitSynonyms.get(name))} /* ${name} */`;
    if (c.routines.has(name)) return `${jsName(name)}.id`;
    if (c.constants.has(name)) return jsName(name);
    const m = /^(P|W|A|PR|ACT|V)\?(.*)$/.exec(name);
    if (m) {
      c.prefixedValue(m[1], m[2]); // validate
      c.usedPrefixed.add(name);
      return `${m[1]}.${jsName(m[2])}`;
    }
    if (name === 'LOW-DIRECTION') return 'LOW_DIRECTION';
    if (name === 'SERIAL') return '0 /* ZILCH serial (unused) */';
    if (this.locals.has(name)) {
      // ,NAME for a local of this routine: ZILCH used the local.
      warn(`${this.name}: ,${name} refers to a local variable`);
      return this.locals.get(name);
    }
    throw new Error(`${this.name}: unknown global ,${name}`);
  }

  ex(node) {
    switch (node.t) {
      case 'jsraw': return node.v;
      case 'vocab': return `${this.c.wordAddr(node.word.toUpperCase())} /* word "${node.word.toLowerCase()}" */`;
      case 'num': return node.v < 0 ? `(${node.v})` : String(node.v);
      case 'str': return JSON.stringify(zilText(node.v));
      case 'lval': {
        const n = node.v.v;
        if (this.locals.has(n)) return this.locals.get(n);
        if (this.c.globals.has(n)) return `g.${jsName(n)}`;
        // .NAME for an object or constant: ZILCH used its value.
        if (this.c.objIndex.has(n) || this.c.constants.has(n)) {
          warn(`${this.name}: .${n} is not a local; using its global value`);
          return this.gval(n);
        }
        throw new Error(`${this.name}: unknown local .${n}`);
      }
      case 'gval': return this.gval(node.v.v);
      case 'atom':
        if (node.v === 'T') return 'true';
        if (this.locals.has(node.v)) return this.locals.get(node.v);
        try {
          return this.gval(node.v);
        } catch (e) {
          warn(`${this.name}: ignoring stray atom ${node.v}`);
          return `false /* stray atom ${node.v} in original source */`;
        }
      case 'quote': return this.ex(node.v);
      case 'form': return this.formEx(node);
    }
    throw new Error(`${this.name}: cannot compile ${show(node)}`);
  }

  formEx(node) {
    if (node.items.length === 0) return 'false';
    const head = node.items[0];
    const args = node.items.slice(1);
    const A = (i) => this.ex(args[i]);
    const all = () => args.map((a) => stripParens(this.ex(a)));
    // <1 .TBL>: element 1 of a table (MDL's NTH shorthand)
    if (head.t === 'num' && args.length === 1) return `get(${stripParens(A(0))}, ${head.v})`;
    if (head.t !== 'atom') throw new Error(`${this.name}: bad form ${show(node)}`);
    const h = head.v;
    // A game routine with a macro-like name (e.g. Planetfall's HERE?) is a call.
    if (MACRO_LIKE.has(h) && this.c.routines.has(h)) return `(await ${jsName(h)}(${all().join(', ')}))`;
    switch (h) {
      case 'EQUAL?': case '==?': {
        const first = args[0];
        const rest = args.slice(1).map((a) => this.ex(a));
        if (this.isSimple(first)) {
          const f = this.ex(first);
          return rest.length === 1 ? `(${f} == ${rest[0]})` : `(${rest.map((r) => `${f} == ${r}`).join(' || ')})`;
        }
        return `eq(${[this.ex(first), ...rest].map(stripParens).join(', ')})`;
      }
      case 'N==?': return `(${A(0)} != ${A(1)})`;
      case 'L?': return `(${A(0)} < ${A(1)})`;
      case 'G?': return `(${A(0)} > ${A(1)})`;
      case 'VALUE':
        // <VALUE NAME>: the variable called NAME (local first, then global).
        if (args[0].t === 'atom') return this.varRef(args[0]);
        return `globalValue(${stripParens(A(0))})`;
      case 'G=?': return `(${A(0)} >= ${A(1)})`;
      case 'L=?': return `(${A(0)} <= ${A(1)})`;
      case 'T?': return `!!${wrap(A(0))}`;
      case 'F?': return `!${wrap(A(0))}`;
      case '0?': case 'ZERO?': return `(${A(0)} == 0)`;
      case '1?': return `(${A(0)} == 1)`;
      case 'NOT': return `!${wrap(A(0))}`;
      case 'AND': return args.length === 1 ? A(0) : `(${args.map((a) => this.condOperand(a)).join(' && ')})`;
      case 'OR': return args.length === 1 ? A(0) : `(${args.map((a) => this.condOperand(a)).join(' || ')})`;
      case '+': return `(${args.map((a) => this.ex(a)).join(' + ')})`;
      case '-': return args.length === 1 ? `(-${A(0)})` : `(${args.map((a) => this.ex(a)).join(' - ')})`;
      case '*': return `(${args.map((a) => this.ex(a)).join(' * ')})`;
      case 'BAND': case 'ANDB': return `(${A(0)} & ${A(1)})`;
      case 'BOR': case 'ORB': return `(${A(0)} | ${A(1)})`;
      case 'IN?': return `(loc(${stripParens(A(0))}) == ${A(1)})`;
      case 'REST': return args.length === 1 ? `(${A(0)} + 1)` : `(${A(0)} + ${A(1)})`;
      case 'BACK': return args.length === 1 ? `(${A(0)} - 1)` : `(${A(0)} - ${A(1)})`;
      case 'PROB':
        if (args.length > 1) return `(await ZPROB(${stripParens(A(0))}))`;
        return CFG.prob === 'lt' ? `(${A(0)} > random(100))` : `prob(${stripParens(A(0))})`;
      case 'VERB?':
        // <VERB? ,X> (a typo in Cutthroats) compares PRSA with the value itself.
        return `isVerb(${args.map((a) => (a.t === 'atom' ? `V.${jsName(a.v)}` : stripParens(this.ex(a)))).join(', ')})`;
      case 'PRSO?': case 'PRSI?': case 'ROOM?': case 'HERE?': case 'WINNER?': {
        const v = { 'PRSO?': 'g.PRSO', 'PRSI?': 'g.PRSI', 'ROOM?': 'g.HERE', 'HERE?': 'g.HERE', 'WINNER?': 'g.WINNER' }[h];
        return `(${args.map((a) => `${v} == ${this.ex(a.t === 'atom' ? { t: 'gval', v: a } : a)}`).join(' || ')})`;
      }
      case 'BSET': case 'BCLEAR': {
        const fn = h === 'BSET' ? 'setFlag' : 'clearFlag';
        const o = stripParens(A(0));
        return `(${args.slice(1).map((b) => `${fn}(${o}, ${this.ex(b.t === 'atom' ? { t: 'gval', v: b } : b)})`).join(', ')})`;
      }
      case 'BSET?': {
        const o = stripParens(A(0));
        return `(${args.slice(1).map((b) => `hasFlag(${o}, ${this.ex(b.t === 'atom' ? { t: 'gval', v: b } : b)})`).join(' || ')})`;
      }
      case 'FLAMING?': return `(hasFlag(${stripParens(A(0))}, FLAMEBIT) && hasFlag(${stripParens(A(0))}, ONBIT))`;
      case 'ENABLE': return `enable(${stripParens(A(0))})`;
      case 'DISABLE': return `disable(${stripParens(A(0))})`;
      case 'OPENABLE?': return `(hasFlag(${stripParens(A(0))}, DOORBIT) || hasFlag(${stripParens(A(0))}, CONTBIT))`;
      case 'ABS': return `Math.abs(${stripParens(A(0))})`;
      case 'CRLF': return 'crlf()';
      case 'SET': case 'SETG':
        // <SET .X value>: sets the variable whose number is the value of X.
        if (args[0].t === 'lval' || args[0].t === 'gval') return `setVarIndirect(${stripParens(A(0))}, ${stripParens(A(1))})`;
        return `(${this.varRef(args[0], h === 'SETG')} = ${stripParens(A(1))})`;
      case 'INC': return `(++${this.varRef(args[0])})`;
      case 'DEC': return `(--${this.varRef(args[0])})`;
      case 'DLESS?': return `(--${this.varRef(args[0])} < ${A(1)})`;
      case 'IGRTR?': return `(++${this.varRef(args[0])} > ${A(1)})`;
      case 'APPLY': return `(await apply(${all().join(', ')}))`;
      case 'COND': return this.condEx(args);
      case 'TABLE': case 'LTABLE': case 'ITABLE': case 'PTABLE': case 'PLTABLE': {
        const addr = this.c.table(node);
        return `${addr} /* static table */`;
      }
      case 'USL': return 'true';
      case 'ASCII': return args[0].t === 'char' ? String(args[0].v.charCodeAt(0)) : A(0);
    }
    if (SIMPLE_HELPERS[h]) return `${SIMPLE_HELPERS[h]}(${all().join(', ')})`;
    if (ASYNC_HELPERS[h]) return `(await ${ASYNC_HELPERS[h]}(${all().join(', ')}))`;
    if (this.c.routines.has(h)) return `(await ${jsName(h)}(${all().join(', ')}))`;
    if (/^[A-Z][A-Z0-9-]*[A-Z0-9?]$/.test(h) && !this.c.mdl.has(h)) {
      // A routine the sources call but never define (left out of this release).
      warn(`${this.name}: calls undefined routine ${h} (treated as returning false)`);
      return 'false';
    }
    throw new Error(`${this.name}: unknown form ${h} in ${show(node)}`);
  }

  condEx(clauses) {
    // Pure COND as nested conditional expression.
    const parts = clauses.map((cl) => ({ test: cl.items[0], body: cl.items.slice(1) }));
    const build = (i) => {
      if (i >= parts.length) return 'false';
      const { test, body } = parts[i];
      const isElse = test.t === 'atom' && (test.v === 'T' || test.v === 'ELSE');
      const bodyEx = body.length ? (body.length === 1 ? this.ex(body[0]) : `(${body.map((b) => stripParens(this.ex(b))).join(', ')})`) : null;
      if (isElse) return bodyEx ?? 'true';
      if (!bodyEx) return `(${this.ex(test)} || ${build(i + 1)})`;
      return `(${stripParens(this.ex(test))} ? ${bodyEx} : ${build(i + 1)})`;
    };
    return build(0);
  }
}

// Macros the compiler implements natively (game definitions of these are ignored).
const NATIVE_MACROS = new Set(['TELL', 'VERB?', 'PRSO?', 'PRSI?', 'ROOM?', 'HERE?', 'WINNER?', 'PROB', 'ENABLE', 'DISABLE',
  'OPENABLE?', 'ABS', 'RFATAL', 'BSET', 'BCLEAR', 'BSET?', 'FLAMING?', 'MULTIFROB', 'MULTIBITS']);

const MACRO_LIKE = new Set(['VERB?', 'PRSO?', 'PRSI?', 'ROOM?', 'HERE?', 'WINNER?', 'PROB', 'OPENABLE?', 'FLAMING?', 'ABS']);

/**
 * <TELL-TOKENS (CRLF CR) <CRLF>  D * <DPRINT .X>  T ,PRSO <TPRINT-PRSO> ...>:
 * each entry is a token (or list of tokens), what follows it in a TELL
 * ("*" any value, bound to .X; ",NAME" exactly that global; nothing), and the
 * form to print it with.
 */
function parseTellTokens(items) {
  const out = [];
  for (let i = 0; i < items.length;) {
    const spec = items[i++];
    const tokens = spec.t === 'list' ? spec.items.map((a) => a.v) : [spec.v];
    let arg = null;
    const n = items[i];
    if (n?.t === 'atom' && /^\*(:|$)/.test(n.v)) { arg = '*'; i++; }
    else if (n?.t === 'gval') { arg = n.v.v; i++; }
    const template = items[i++];
    out.push({ tokens, arg, template });
  }
  return out;
}

/**
 * Turn the expansion of a game's own TELL macro (<PROG () <PRINTI "x">
 * <DPRINT ,O> <CRLF>>) back into a native TELL, keeping the game's own
 * printing routines as calls.
 */
function tellFromExpansion(r) {
  const body = r.t === 'form' && r.items[0]?.v === 'PROG' ? r.items.slice(2) : [r];
  const args = [{ t: 'atom', v: 'TELL' }];
  const simple = { PRINTD: 'D', PRINTN: 'N', PRINTC: 'C' };
  for (const f of body) {
    const h = f.t === 'form' ? f.items[0]?.v : null;
    if ((h === 'PRINTI' || h === 'PRINT') && f.items[1]?.t === 'str') args.push(f.items[1]);
    else if (h === 'CRLF') args.push({ t: 'atom', v: 'CR' });
    else if (simple[h]) args.push({ t: 'atom', v: simple[h] }, f.items[1]);
    else if (h === 'PRINT') args.push(f.items[1]);
    else args.push({ t: 'tellcall', v: f });
  }
  return { t: 'form', native: true, items: args };
}

/** Replace .NAME in a form by a node. */
function substLval(node, name, value) {
  if (!node || typeof node !== 'object') return node;
  if (node.t === 'lval' && node.v.v === name) return value;
  if (node.items) return { ...node, items: node.items.map((x) => substLval(x, name, value)) };
  return node;
}

const TELL_TOKENS = { D: 'D', DESC: 'D', OBJ: 'D', O: 'D', N: 'N', NUM: 'N', C: 'C', CHR: 'C', CHAR: 'C', A: 'A', AN: 'A' };

// Names exported by the runtime; locals must not shadow them.
const RUNTIME_NAMES = new Set([
  'g', 'tell', 'print', 'crlf', 'eq', 'hasflag', 'setflag', 'clearflag', 'move', 'remove', 'loc', 'first', 'next',
  'getprop', 'putprop', 'getpropaddr', 'propsize', 'nextprop', 'get', 'put', 'getb', 'putb', 'random', 'prob', 'isverb',
  'enable', 'disable', 'apply', 'globalvalue', 'btst', 'verify', 'dirout', 'dirin', 'div', 'mod', 'read', 'save',
  'restore', 'restart', 'quit', 'printd', 'printb', 'printc', 'printn', 'prints', 'd', 'n', 'c', 's', 'v', 'p', 'w',
  'a', 'pr', 'act',
]);

function stripParens(s) {
  if (s.startsWith('(') && s.endsWith(')')) {
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') { depth--; if (depth === 0 && i < s.length - 1) return s; }
      else if (s[i] === '"' || s[i] === "'") return s; // be conservative around strings
    }
    return s.slice(1, -1);
  }
  return s;
}

function wrap(s) {
  return /^[\w$.]+$/.test(s) || /^\(.*\)$/.test(s) && stripParens(s) !== s ? s : `(${s})`;
}

function mergeStrings(parts) {
  const out = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last && last.startsWith('"') && p.startsWith('"') && last.endsWith('"')) {
      out[out.length - 1] = JSON.stringify(JSON.parse(last) + JSON.parse(p));
    } else out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function compileAll(gameId = 'planetfall') {
  GAME_ID = gameId;
  if (!GAMES[gameId]) throw new Error('unknown game ' + gameId);
  warnings.length = 0;
  CRLF_CHAR = '|';
  CFG = inferConfig({ ...GAMES[gameId] });
  const c = new Compiler();
  c.story = readStoryFile();
  if (CFG.nounValue === undefined) CFG.nounValue = inferNounValue();
  c.usedPrefixed = new Set();
  c.collect(topLevelForms());
  c.number();
  c.buildVocabulary();
  c.buildActions();
  c.buildMemory();
  const code = c.generateCode();
  return { c, code };
}

function emit({ c, code }) {
  const header = (title) => `// ${title}
// AUTO-GENERATED by tools/zil2js/compile.mjs from the original ZIL source of
// ${CFG.title.toUpperCase()} (c) Infocom, Inc.  Do not edit by hand -- edit the compiler instead.${CFG.licenseNotice ? `\n// ${CFG.licenseNotice}` : ''}
`;
  const lines = [];
  lines.push(header(`${CFG.title} game logic, translated from ZIL to JavaScript.`));
  lines.push(`import {
  g, tell, print, crlf, eq, hasFlag, setFlag, clearFlag, move, remove, loc, first, next,
  getProp, putProp, getPropAddr, propSize, nextProp, get, put, getb, putb, random, prob, isVerb,
  enable, disable, apply, globalValue, setVarIndirect, btst, verify, dirOut, dirIn, div, mod,
  read, save, restore, restart, quit, printD, printB, printC, printN, printS, D, N, C, S,
} from '../../engine/runtime.js';
`);
  // Constants
  lines.push('// ---- Flags (object attributes) ----');
  lines.push(...[...c.flags].map(([n, v]) => `export const ${jsName(n)} = ${v};`));
  lines.push('', '// ---- Objects and rooms ----');
  lines.push(...c.objects.map((o, i) => `export const ${jsName(o.name)} = ${i + 1};`));
  lines.push('', '// ---- Constants ----');
  for (const [n, v] of c.constants) {
    if (c.globals.has(n) || c.objIndex.has(n) || c.flags.has(n)) continue;
    let val;
    try { val = c.staticValue(typeof v === 'number' ? { t: 'num', v } : v); } catch { continue; }
    lines.push(`export const ${jsName(n)} = ${val};`);
  }
  const group = (prefix, title) => {
    const names = [...c.usedPrefixed].filter((n) => n.startsWith(prefix + '?')).map((n) => n.slice(prefix.length + 1)).sort();
    const entries = names.map((n) => `  ${JSON.stringify(jsName(n)) === `"${jsName(n)}"` ? jsName(n) : JSON.stringify(jsName(n))}: ${c.prefixedValue(prefix, n)},`);
    lines.push('', `// ---- ${title} ----`, `export const ${prefix} = {`, ...entries, '};');
  };
  // Make sure every action number is available (for isVerb).
  for (const a of c.actions.keys()) c.usedPrefixed.add('V?' + a);
  for (const p of c.props.keys()) c.usedPrefixed.add('P?' + p);
  group('V', 'Actions (V?xxx)');
  group('P', 'Properties (P?xxx)');
  // code first (it registers W?/A?/PR?/ACT? uses), then the vocab constant groups
  const codeLines = code;
  group('W', 'Vocabulary words (W?xxx): dictionary addresses');
  group('A', 'Adjective numbers (A?xxx)');
  group('PR', 'Preposition numbers (PR?xxx)');
  group('ACT', 'Verb numbers (ACT?xxx)');
  lines.push('', '// ---- Routines ----', '', codeLines, '');
  lines.push('// Routine table: values stored in game data refer to routines by these ids.');
  lines.push('export const ROUTINES = [null,');
  for (const name of c.routines.keys()) lines.push(`  ${jsName(name)},`);
  lines.push('];');
  lines.push(`export const ROUTINE_BASE = ${ROUTINE_BASE};`);
  lines.push('ROUTINES.forEach((fn, i) => { if (fn) fn.id = ROUTINE_BASE + i; });');
  lines.push(`export { GO as start, MAIN_LOOP as mainLoop };`);
  const OUT_DIR = path.join(ROOT, 'web/src/games', GAME_ID);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'game.js'), lines.join('\n'));

  // Data module
  const b64 = Buffer.from(Uint8Array.from(c.mem)).toString('base64');
  const syntaxHelp = [];
  for (const [act, list] of c.verbSyntax) {
    for (const s of list) {
      const words = s.src.slice(0, s.src.findIndex((n) => n.t === 'atom' && n.v === '='))
        .filter((n) => n.t === 'atom').map((n) => (n.v === 'OBJECT' ? 'OBJ' : n.v.toLowerCase()));
      syntaxHelp.push(words.join(' '));
    }
  }
  const verbSynonyms = {};
  for (const [alias, canon] of c.aliasOf) {
    if (c.actNums.has(c.canonWord(canon))) (verbSynonyms[c.canonWord(canon).toLowerCase()] ??= []).push(alias.toLowerCase());
  }
  const data = [
    header(`${CFG.title} story data (memory image, strings, layout).`),
    `export const MEMORY_BASE64 = ${JSON.stringify(b64)};`,
    '',
    '// Strings referenced by game data (property values, table entries, globals), by id.',
    `export const STRINGS = ${JSON.stringify(c.strings, null, 0).replace(/","/g, '",\n  "')};`,
    '',
    `export const GLOBAL_NAMES = ${JSON.stringify(c.globalOrder.map(jsName))};`,
    `export const INITIAL_GLOBALS = ${JSON.stringify(Object.fromEntries(Object.entries(c.globalInit).map(([k, v]) => [jsName(k), v])))};`,
    `export const LAYOUT = ${JSON.stringify({
      propDefaults: c.propDefaults, objTable: c.objTable, objectCount: c.objects.length,
      stringBase: STRING_BASE, routineBase: ROUTINE_BASE,
      dictionary: c.dictStart, dictionaryCount: c.dictEntries.length, entryLength: 7,
      objectNames: c.objects.map((o) => o.name), rooms: c.objects.filter((o) => o.room).map((o) => o.name),
      flags: Object.fromEntries(c.flags), props: Object.fromEntries(c.props),
    })};`,
    `export const SYNTAX_HELP = ${JSON.stringify([...new Set(syntaxHelp)])};`,
    `export const VERB_SYNONYMS = ${JSON.stringify(verbSynonyms)};`,
    '',
    '// Full spellings of dictionary words (the dictionary itself only keeps 6 letters), by dictionary key.',
    `export const FULL_WORDS = ${JSON.stringify(Object.fromEntries(c.dictEntries.map((e) => [e.key,
      [...e.names].map((n) => (n === 'PERIOD' ? '.' : n === 'COMMA' ? ',' : n === 'QUOTE' ? '"' : n.toLowerCase()))])))};`,
    '',
  ];
  fs.writeFileSync(path.join(OUT_DIR, 'story-data.js'), data.join('\n'));
  const license = path.join(ROOT, CFG.srcDir, 'LICENSE');
  if (fs.existsSync(license)) fs.copyFileSync(license, path.join(OUT_DIR, 'LICENSE'));
  return c;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const which = process.argv[2] || 'all';
  for (const id of which === 'all' ? Object.keys(GAMES) : [which]) {
    const result = compileAll(id);
    emit(result);
    for (const w of warnings) console.warn(`warning (${id}):`, w);
    console.log(`${id}: compiled ${result.c.routines.size} routines, ${result.c.objects.length} objects, ` +
      `${result.c.vocab.words.size} words, ${result.c.mem.length} bytes of data`);
  }
}
