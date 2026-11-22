// ZIL -> JavaScript compiler for Planetfall.
//
// Reads the original ZIL sources, builds the Z-machine style data image
// (object tree, property tables, vocabulary, syntax tables, static tables)
// and translates every ROUTINE into a readable async JavaScript function.
//
// Usage: node tools/zil2js/compile.mjs  (writes web/src/game/*.js)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZil, show } from './reader.mjs';
import { encodeText, dictBytes, dictKey } from '../../web/src/engine/zscii.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');
const OUT_DIR = path.join(ROOT, 'web/src/game');

// The ZIL files, in the order planetfall.zil inserts them.
const FILES = ['syntax', 'misc', 'globals', 'parser', 'verbs', 'compone', 'comptwo', 'planetfall'];

// Known damage in the source snapshot: comptwo.zil is truncated in the middle of
// the last object (TRIFFID).  comptwo.zabstr shows the intended ending.
const FIXUPS = {
  comptwo: (text) => text.replace(/\(FLAGS ACTORBIL M\s*$/, '(FLAGS ACTORBIT)>\n'),
};

// Compile-time environment: this is the production build (PREDGEN), compiled by ZILCH.
const COMPILE_TIME_ASSIGNED = new Set(['PREDGEN', 'ZILCH']);

const warnings = [];
function warn(msg) { warnings.push(msg); }

// ---------------------------------------------------------------------------
// Load & flatten top-level definitions
// ---------------------------------------------------------------------------

function evalCompileTime(node) {
  // Supports the tiny subset of MDL used in %<COND ...> blocks.
  if (node.t === 'form') {
    const h = node.items[0]?.v;
    if (h === 'COND') {
      for (const clause of node.items.slice(1)) {
        if (evalCompileTime(clause.items[0])) {
          return clause.items.length > 1 ? clause.items[clause.items.length - 1] : null;
        }
      }
      return null;
    }
    if (h === 'GASSIGNED?') return COMPILE_TIME_ASSIGNED.has(node.items[1].v);
    if (h === 'NOT') return !evalCompileTime(node.items[1]);
  }
  if (node.t === 'atom' && node.v === 'T') return true;
  throw new Error('Unsupported compile-time expression: ' + show(node));
}

function topLevelForms() {
  const out = [];
  const visit = (node, file) => {
    if (!node) return;
    if (node.t === 'macro') {
      const r = evalCompileTime(node.v);
      if (r && typeof r === 'object') visit(r, file);
      return;
    }
    if (node.t === 'quote') return visit(node.v, file);
    if (node.t !== 'form') return;
    const head = node.items[0]?.v;
    if (head === 'PROG') { node.items.slice(2).forEach((n) => visit(n, file)); return; }
    node.file = file;
    out.push(node);
  };
  for (const f of FILES) {
    let text = fs.readFileSync(path.join(ROOT, f + '.zil'), 'latin1');
    if (FIXUPS[f]) text = FIXUPS[f](text);
    for (const node of readZil(text, f + '.zil')) visit(node, f);
  }
  return out;
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
function zilText(s) {
  // "|" is a line break; a source line break directly after "|" is dropped;
  // any other source line break becomes a space.
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '|') {
      out += '\n';
      if (s[i + 1] === '\r') i++;
      if (s[i + 1] === '\n') i++;
    } else if (c === '\r') {
      continue;
    } else if (c === '\n') {
      out += ' ';
    } else out += c;
  }
  return out;
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
    this.props = new Map();
    this.strings = [null];        // id -> text
    this.stringIds = new Map();
    this.routineIds = new Map();  // name -> id
    this.mem = [];
    this.memNotes = [];
  }

  // ---------------- collection ----------------

  collect(forms) {
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
        case 'ROUTINE': this.routines.set(it[1].v, f); break;
        case 'OBJECT': case 'ROOM':
          if (this.objIndex.has(it[1].v)) throw new Error('duplicate object ' + it[1].v);
          this.objIndex.set(it[1].v, this.objects.length + 1);
          this.objects.push({ name: it[1].v, room: head === 'ROOM', props: it.slice(2) });
          break;
        case 'GLOBAL': this.globals.set(it[1].v, it[2]); break;
        case 'CONSTANT': this.constants.set(it[1].v, it[2]); break;
        case 'SETG':
          // Top-level SETGs are compile-time constants unless declared as GLOBALs.
          if (!this.constants.has(it[1].v)) this.constants.set(it[1].v, it[2]);
          break;
        case 'SYNTAX': this.syntaxes.push(it.slice(1)); break;
        case 'SYNONYM': this.synonymDirs.push(it.slice(1).map((a) => a.v)); break;
        case 'BUZZ': this.buzz.push(...it.slice(1).map((a) => a.v)); break;
        case 'DIRECTIONS': this.directions.push(...it.slice(1).map((a) => a.v)); break;
        case 'PROPDEF': this.propdefs.set(it[1].v, it[2].v); break;
        case 'DEFMAC': case 'DEFINE': case 'VERSION': case 'FREQUENT-WORDS?': case 'OR': case 'PRINC':
        case 'GC': case 'BLOAT': case 'IFILE': case 'ENDLOAD': case 'GDECL': case 'SET': case 'COND':
        case 'ID': case 'IMAGE':
          break;
        default:
          warn('ignored top-level form ' + head);
      }
    }
    this.numberObjects();
    // Globals declared with GLOBAL override same-named top-level SETG constants.
    for (const g of this.globals.keys()) {
      if (this.constants.has(g) && !this.isConstantDecl(g)) this.constants.delete(g);
    }
  }

  isConstantDecl() { return false; }

  // Object numbers are observable: the game compares PRSO (which holds a
  // direction's property number after a WALK) with object constants such as
  // NOT-HERE-OBJECT.  To behave exactly like the original we reuse the object
  // numbering ZILCH chose, taken from its data listing when it is available.
  numberObjects() {
    this.sourceObjects = this.objects.slice();
    const listing = path.join(ROOT, 'planetfalldat.zap');
    if (!fs.existsSync(listing)) return;
    const order = [];
    for (const l of fs.readFileSync(listing, 'latin1').split('\n')) {
      const m = /^\s+\.OBJECT ([^,]+),/.exec(l);
      if (m) order.push(m[1]);
    }
    const byName = new Map(this.objects.map((o) => [o.name, o]));
    if (order.length !== this.objects.length || !order.every((n) => byName.has(n))) {
      warn('object numbering from planetfalldat.zap does not fit the source; using source order');
      return;
    }
    this.objects = order.map((n) => byName.get(n));
    this.objIndex = new Map(this.objects.map((o, i) => [o.name, i + 1]));
  }

  // ---------------- numbering ----------------

  number() {
    // Flags, in order of first appearance in object definitions.
    for (const o of this.objects) {
      for (const p of o.props) {
        if (p.items[0].v === 'FLAGS') for (const a of p.items.slice(1)) this.flag(a.v);
      }
    }
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
    if (!this.flags.has(name)) {
      this.flags.set(name, this.flags.size);
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
      this.stringIds.set(text, this.strings.length);
      this.strings.push(text);
    }
    return this.stringIds.get(text);
  }

  routineId(name) {
    if (!this.routines.has(name)) throw new Error('unknown routine ' + name);
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
        if (pname === 'SYNONYM') for (const a of p.items.slice(1)) entry(a.v).object = true;
        if (pname === 'ADJECTIVE') for (const a of p.items.slice(1)) setPart(entry(a.v), 'adj', this.adjNums.get(a.v));
        if (pname === 'PSEUDO') {
          for (let i = 1; i < p.items.length; i += 2) entry(p.items[i].v.toUpperCase()).object = true;
        }
      }
    }
    // Synonyms share all non-noun parts of speech with their canonical word.
    for (const [alias] of this.aliasOf) {
      const c = byName.get(canon(alias)) || entry(canon(alias));
      const e = entry(alias);
      for (const part of c.order) setPart(e, part, c.parts[part]);
    }
    // Words referenced from code (W?FOO)
    for (const w of this.referencedPrefixed('W?')) if (!byName.has(w)) entry(w);
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
        if (node.items[0].v === '-') return this.staticValue(node.items[1]) - node.items.slice(2).reduce((a, n) => a + this.staticValue(n), 0);
        break;
      case 'gval': return this.atomValue(node.v.v);
      case 'atom':
        if (node.v === 'T') return 1;
        return this.atomValue(node.v);
      case 'quote': return this.staticValue(node.v, ctx);
      case 'macro': return this.staticValue(evalCompileTime(node.v), ctx);
    }
    throw new Error('cannot evaluate statically: ' + show(node));
  }

  atomValue(name) {
    if (this.objIndex.has(name)) return this.objIndex.get(name);
    if (this.routines.has(name)) return this.routineId(name);
    if (this.flags.has(name)) return this.flags.get(name);
    if (this.constants.has(name)) {
      this.constValues ??= new Map();
      if (!this.constValues.has(name)) {
        const c = this.constants.get(name);
        this.constValues.set(name, typeof c === 'number' ? c : this.staticValue(c));
      }
      return this.constValues.get(name);
    }
    if (this.globals.has(name)) return this.globalNumber(name);
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

  globalNumber(name) {
    return this.globalOrder.indexOf(name) + 16;
  }

  table(node) {
    const kind = node.items[0].v;
    let args = node.items.slice(1);
    let byteMode = false, lengthPrefix = kind === 'LTABLE' || kind === 'PLTABLE';
    if (kind === 'ITABLE') {
      // <ITABLE [NONE|BYTE|WORD] count [init]>
      let spec = 'NONE';
      if (args[0].t === 'atom') { spec = args[0].v; args = args.slice(1); }
      const count = args[0].v;
      const isByte = spec === 'BYTE';
      this.align();
      const addr = this.here();
      if (spec === 'BYTE') this.byte(count);
      else if (spec === 'WORD') this.word(count);
      for (let i = 0; i < count; i++) (isByte ? this.byte(0) : this.word(0));
      return addr;
    }
    while (args.length && args[0].t === 'list') {
      for (const f of args[0].items) {
        if (f.v === 'BYTE') byteMode = true;
        if (f.v === 'LENGTH') lengthPrefix = true;
      }
      args = args.slice(1);
    }
    // Nested tables and strings must be allocated before this table starts.
    const values = args.map((a) => this.staticValue(a));
    this.align();
    const addr = this.here();
    if (lengthPrefix) (byteMode ? this.byte(values.length) : this.word(values.length));
    for (const v of values) (byteMode ? this.byte(v) : this.word(v));
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
    this.mem[2] = 0; this.mem[3] = 39; // release
    '880501'.split('').forEach((c, i) => { this.mem[18 + i] = c.charCodeAt(0); });
    this.mem[56] = 0;

    // Routine ids (1-based, in source order)
    let rid = 1;
    for (const name of this.routines.keys()) this.routineIds.set(name, rid++);

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
      this.globalInit[name] = init === undefined ? 0 : this.staticValue(init);
    }
    // Static tables referenced inside routines are allocated during code generation.

    // Syntax tables
    this.align();
    const verbs = [...this.verbSyntax.keys()].sort((a, b) => b - a);
    const vtblEntries = new Map();
    for (const act of verbs) {
      const list = this.verbSyntax.get(act);
      vtblEntries.set(act, this.here());
      this.byte(list.length);
      for (const s of list) {
        this.byte(s.objs); this.byte(s.prep1); this.byte(s.prep2); this.byte(s.fwim1);
        this.byte(s.fwim2); this.byte(s.loc1); this.byte(s.loc2); this.byte(s.action);
      }
    }
    this.align();
    const vtbl = this.here();
    for (let act = 255; act >= Math.min(...verbs); act--) this.word(vtblEntries.get(act) || 0);
    const atbl = this.here();
    for (const [, a] of this.actions) this.word(this.routineId(a.routine));
    const patbl = this.here();
    for (const [, a] of this.actions) this.word(a.pre ? this.routineId(a.pre) : 0);
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
      const PSBIT = { verb: 64, adj: 32, dir: 16, prep: 8, buzz: 4 };
      const P1 = { verb: 1, adj: 2, dir: 3, prep: 0, buzz: 0 };
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
        o.plist.push({ num: this.props.get(pname), bytes: this.propBytes(pname, p, o) });
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
    const vals = p.items.slice(1);
    const w = (v) => [(v >> 8) & 255, v & 255];
    if (this.directions.includes(pname)) {
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
        if (vals.length !== 1) throw new Error(`property ${pname} of ${o.name} has ${vals.length} values`);
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
  GETPT: 'getPropAddr', PTSIZE: 'propSize', GET: 'get', PUT: 'put', GETB: 'getb', PUTB: 'putb',
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
    const loop = this.loops[this.loops.length - 1];
    if (valNode) return this.stmt(valNode, { k: 'ret' });
    const val = { t: 'atom', v: 'T' };
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
      if (a.t === 'atom' && (a.v === 'CR' || a.v === 'CRLF')) { parts.push('"\\n"'); continue; }
      if (a.t === 'atom' && (a.v === 'D' || a.v === 'N' || a.v === 'C')) {
        const x = args[++i];
        const fn = a.v === 'D' ? 'D' : a.v === 'N' ? 'N' : 'C';
        if (this.isExpr(x) && !this.mayPrint(x)) { parts.push(`${fn}(${stripParens(this.ex(x))})`); continue; }
        flush();
        const t = this.tmp();
        out.push(...this.stmt(x, { k: 'set', v: t }));
        out.push(`tell(${fn}(${t}));`);
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
    throw new Error(`${this.name}: unknown variable ${n}`);
  }

  gval(name) {
    const c = this.c;
    if (c.globals.has(name)) return `g.${jsName(name)}`;
    if (c.objIndex.has(name) || c.flags.has(name)) return jsName(name);
    if (c.routines.has(name)) return `${jsName(name)}.id`;
    if (c.constants.has(name)) return jsName(name);
    const m = /^(P|W|A|PR|ACT|V)\?(.*)$/.exec(name);
    if (m) {
      c.prefixedValue(m[1], m[2]); // validate
      c.usedPrefixed.add(name);
      return `${m[1]}.${jsName(m[2])}`;
    }
    if (name === 'LOW-DIRECTION') return 'LOW_DIRECTION';
    throw new Error(`${this.name}: unknown global ,${name}`);
  }

  ex(node) {
    switch (node.t) {
      case 'jsraw': return node.v;
      case 'num': return node.v < 0 ? `(${node.v})` : String(node.v);
      case 'str': return JSON.stringify(zilText(node.v));
      case 'lval': {
        const n = node.v.v;
        if (this.locals.has(n)) return this.locals.get(n);
        if (this.c.globals.has(n)) return `g.${jsName(n)}`;
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
    if (head.t !== 'atom') throw new Error(`${this.name}: bad form ${show(node)}`);
    const h = head.v;
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
      case '0?': case 'ZERO?': return `(${A(0)} == 0)`;
      case '1?': return `(${A(0)} == 1)`;
      case 'NOT': return `!${wrap(A(0))}`;
      case 'AND': return args.length === 1 ? A(0) : `(${args.map((a) => this.ex(a)).join(' && ')})`;
      case 'OR': return args.length === 1 ? A(0) : `(${args.map((a) => this.ex(a)).join(' || ')})`;
      case '+': return `(${args.map((a) => this.ex(a)).join(' + ')})`;
      case '-': return args.length === 1 ? `(-${A(0)})` : `(${args.map((a) => this.ex(a)).join(' - ')})`;
      case '*': return `(${args.map((a) => this.ex(a)).join(' * ')})`;
      case 'BAND': return `(${A(0)} & ${A(1)})`;
      case 'BOR': return `(${A(0)} | ${A(1)})`;
      case 'IN?': return `(loc(${stripParens(A(0))}) == ${A(1)})`;
      case 'REST': return args.length === 1 ? `(${A(0)} + 1)` : `(${A(0)} + ${A(1)})`;
      case 'BACK': return args.length === 1 ? `(${A(0)} - 1)` : `(${A(0)} - ${A(1)})`;
      case 'PROB': return `prob(${stripParens(A(0))})`;
      case 'VERB?': return `isVerb(${args.map((a) => `V.${jsName(a.v)}`).join(', ')})`;
      case 'ENABLE': return `enable(${stripParens(A(0))})`;
      case 'DISABLE': return `disable(${stripParens(A(0))})`;
      case 'OPENABLE?': return `(hasFlag(${stripParens(A(0))}, DOORBIT) || hasFlag(${stripParens(A(0))}, CONTBIT))`;
      case 'ABS': return `Math.abs(${stripParens(A(0))})`;
      case 'CRLF': return 'crlf()';
      case 'SET': case 'SETG': return `(${this.varRef(args[0], h === 'SETG')} = ${stripParens(A(1))})`;
      case 'DLESS?': return `(--${this.varRef(args[0])} < ${A(1)})`;
      case 'IGRTR?': return `(++${this.varRef(args[0])} > ${A(1)})`;
      case 'APPLY': return `(await apply(${all().join(', ')}))`;
      case 'COND': return this.condEx(args);
      case 'TABLE': case 'LTABLE': case 'ITABLE': case 'PTABLE': case 'PLTABLE': {
        const addr = this.c.table(node);
        return `${addr} /* static table */`;
      }
      case 'USL': return 'true';
    }
    if (SIMPLE_HELPERS[h]) return `${SIMPLE_HELPERS[h]}(${all().join(', ')})`;
    if (ASYNC_HELPERS[h]) return `(await ${ASYNC_HELPERS[h]}(${all().join(', ')}))`;
    if (this.c.routines.has(h)) return `(await ${jsName(h)}(${all().join(', ')}))`;
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

// Names exported by the runtime; locals must not shadow them.
const RUNTIME_NAMES = new Set([
  'g', 'tell', 'print', 'crlf', 'eq', 'hasflag', 'setflag', 'clearflag', 'move', 'remove', 'loc', 'first', 'next',
  'getprop', 'putprop', 'getpropaddr', 'propsize', 'get', 'put', 'getb', 'putb', 'random', 'prob', 'isverb',
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

export function compileAll() {
  const c = new Compiler();
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
// PLANETFALL (c) 1983 Infocom, Inc.  Do not edit by hand -- edit the compiler instead.
`;
  const lines = [];
  lines.push(header('Planetfall game logic, translated from ZIL to JavaScript.'));
  lines.push(`import {
  g, tell, print, crlf, eq, hasFlag, setFlag, clearFlag, move, remove, loc, first, next,
  getProp, putProp, getPropAddr, propSize, get, put, getb, putb, random, prob, isVerb,
  enable, disable, apply, globalValue, btst, verify, dirOut, dirIn, div, mod,
  read, save, restore, restart, quit, printD, printB, printC, printN, printS, D, N, C, S,
} from '../engine/runtime.js';
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
  lines.push('ROUTINES.forEach((fn, id) => { if (fn) fn.id = id; });');
  lines.push(`export { GO as start, MAIN_LOOP as mainLoop };`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'planetfall.js'), lines.join('\n'));

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
    header('Planetfall story data (memory image, strings, layout).'),
    `export const MEMORY_BASE64 = ${JSON.stringify(b64)};`,
    '',
    '// Strings referenced by game data (property values, table entries, globals), by id.',
    `export const STRINGS = ${JSON.stringify(c.strings, null, 0).replace(/","/g, '",\n  "')};`,
    '',
    `export const GLOBAL_NAMES = ${JSON.stringify(c.globalOrder.map(jsName))};`,
    `export const INITIAL_GLOBALS = ${JSON.stringify(Object.fromEntries(Object.entries(c.globalInit).map(([k, v]) => [jsName(k), v])))};`,
    `export const LAYOUT = ${JSON.stringify({
      propDefaults: c.propDefaults, objTable: c.objTable, objectCount: c.objects.length,
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
  return c;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = compileAll();
  emit(result);
  for (const w of warnings) console.warn('warning:', w);
  console.log(`compiled ${result.c.routines.size} routines, ${result.c.objects.length} objects, ` +
    `${result.c.vocab.words.size} words, ${result.c.mem.length} bytes of data`);
}
