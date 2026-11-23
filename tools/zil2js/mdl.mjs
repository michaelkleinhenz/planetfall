// A small MDL interpreter for the compile-time parts of ZIL: the DEFMAC macros
// and DEFINE functions games use to generate code and data (e.g. VERB?-style
// macros, PSEUDO tables, DEBUG-CODE). It works directly on reader nodes:
//
//   values are reader nodes ({t:'atom'|'num'|'str'|'char'|'form'|'list', ...}),
//   FALSE is null, closures are {t:'closure'}, builtins referenced as values
//   are {t:'builtin'}, and VOC results are {t:'vocab', word, part}.

import { show } from './reader.mjs';

const T = { t: 'atom', v: 'T' };
const atom = (v) => ({ t: 'atom', v });
const num = (v) => ({ t: 'num', v });
const truthy = (x) => x !== null && x !== undefined && x !== false;
const clean = (name) => name.replace(/!-.*$/, ''); // RETURN!- etc.

class ReturnSignal { constructor(value, depth) { this.value = value; this.depth = depth; } }
class AgainSignal { constructor(depth) { this.depth = depth; } }
class MapStop { constructor(value, leave) { this.value = value; this.leave = leave; } }
class MapRet { constructor(values) { this.values = values; } }

export class MDL {
  constructor({ globals = new Map(), onWarn = () => {} } = {}) {
    this.defs = new Map();      // name -> {params, body, macro}
    this.globals = globals;     // compile-time GVALs (numbers, nodes, closures)
    this.onWarn = onWarn;
    this.vocab = [];            // VOC results
    this.loopDepth = 0;
  }

  /** Register a <DEFINE name (params) body...> or <DEFMAC ...> form. */
  define(form) {
    const it = form.items;
    const name = clean(it[1].v);
    this.defs.set(name, { name, params: it[2].items || [], body: it.slice(3), macro: it[0].v === 'DEFMAC' });
  }

  has(name) { return this.defs.has(clean(name)); }
  isMacro(name) { return this.defs.get(clean(name))?.macro; }

  /** Expand a macro/function call form at compile time; returns a node. */
  expand(form) {
    const name = clean(form.items[0].v);
    const def = this.defs.get(name);
    return this.invoke(def, form.items.slice(1), new Map(), def.macro || this.hasQuotedParams(def));
  }

  hasQuotedParams(def) { return def.params.some((p) => p.t === 'quote' || (p.t === 'list' && p.items[0]?.t === 'quote')); }

  // ------------------------------------------------------------------ calls

  invoke(def, rawArgs, callerEnv, unevaluatedByDefault = false) {
    const env = new Map();
    env.parent = null;
    let mode = 'req';
    let i = 0;
    const evalArg = (node, quoted) => (quoted ? node : this.eval(node, callerEnv));
    for (const p of def.params) {
      if (p.t === 'str') {
        const s = p.v.toUpperCase();
        mode = s === 'OPTIONAL' || s === 'OPT' ? 'opt' : s === 'AUX' || s === 'EXTRA' ? 'aux'
          : s === 'ARGS' ? 'args' : s === 'TUPLE' ? 'tuple' : s === 'NAME' || s === 'BIND' ? 'skip' : mode;
        continue;
      }
      let name, quoted = false, deflt = null;
      if (p.t === 'atom') name = p.v;
      else if (p.t === 'quote') { name = p.v.v; quoted = true; }
      else if (p.t === 'list') {
        const n0 = p.items[0];
        if (n0.t === 'quote') { name = n0.v.v; quoted = true; } else name = n0.v;
        deflt = p.items[1] ?? null;
      } else continue;
      name = name.replace(/:.*$/, '');
      if (mode === 'skip') { mode = 'req'; continue; }
      if (mode === 'aux') { env.set(name, deflt ? this.eval(deflt, env) : null); continue; }
      if (mode === 'args') { env.set(name, { t: 'list', items: rawArgs.slice(i) }); i = rawArgs.length; continue; }
      if (mode === 'tuple') { env.set(name, { t: 'list', items: rawArgs.slice(i).map((a) => this.eval(a, callerEnv)) }); i = rawArgs.length; continue; }
      if (i < rawArgs.length) {
        env.set(name, evalArg(rawArgs[i++], quoted || unevaluatedByDefault && def.macro && quoted));
      } else if (mode === 'opt') {
        env.set(name, deflt ? this.eval(deflt, env) : null);
        env.set(`__unassigned:${name}`, true);
      } else {
        env.set(name, null);
      }
    }
    let result = null;
    for (const f of def.body) result = this.eval(f, env);
    return result;
  }

  callValue(fn, args, env) {
    if (fn?.t === 'closure') return this.invoke(fn.def, args.map((a) => ({ t: 'value', v: a })), env);
    if (fn?.t === 'builtin') return this.builtin(fn.name, args.map((a) => ({ t: 'value', v: a })), env);
    if (fn?.t === 'atom' && (this.defs.has(fn.v) || BUILTINS.has(fn.v))) {
      return this.callValue(this.defs.has(fn.v) ? { t: 'closure', def: this.defs.get(fn.v) } : { t: 'builtin', name: fn.v }, args, env);
    }
    throw new Error(`MDL: cannot call ${show(fn)}`);
  }

  // ------------------------------------------------------------------ eval

  lookup(env, name) {
    for (let e = env; e; e = e.parent) if (e.has(name)) return e.get(name);
    throw new Error(`MDL: unbound local .${name}`);
  }

  assigned(env, name) {
    for (let e = env; e; e = e.parent) if (e.has(name)) return !e.get(`__unassigned:${name}`);
    return false;
  }

  setLocal(env, name, value) {
    for (let e = env; e; e = e.parent) if (e.has(name)) { e.set(name, value); e.delete(`__unassigned:${name}`); return value; }
    env.set(name, value);
    return value;
  }

  gval(name) {
    if (this.globals.has(name)) return this.globals.get(name);
    if (this.defs.has(name)) return { t: 'closure', def: this.defs.get(name) };
    if (BUILTINS.has(name)) return { t: 'builtin', name };
    return null;
  }

  evalItems(items, env) {
    const out = [];
    for (const it of items) {
      if (it.t === 'seg') {
        const v = this.eval(it.v, env);
        if (v && (v.t === 'list' || v.t === 'form')) out.push(...v.items);
      } else out.push(this.eval(it, env));
    }
    return out;
  }

  eval(node, env) {
    if (node == null) return null;
    switch (node.t) {
      case 'value': return node.v;
      case 'num': case 'str': case 'char': case 'atom': case 'closure': case 'builtin': case 'vocab': case 'hash':
        return node;
      case 'quote': return node.v;
      case 'lval': return this.lookup(env, node.v.v.replace(/:.*$/, ''));
      case 'gval': return this.gval(node.v.v);
      case 'list': return { ...node, items: this.evalItems(node.items, env) };
      case 'macro': return this.eval(node.v, env);
      case 'seg': return this.eval(node.v, env);
      case 'form': return this.evalForm(node, env);
    }
    throw new Error(`MDL: cannot evaluate ${show(node)}`);
  }

  evalForm(node, env) {
    if (!node.items.length) return null; // <> is FALSE
    const head = node.items[0];
    const args = node.items.slice(1);
    if (head.t === 'num') return nth(this.eval(args[0], env), head.v);
    if (head.t === 'lval' || head.t === 'gval' || head.t === 'form') {
      const fn = this.eval(head, env);
      return this.callValue(fn, this.evalItems(args, env), env);
    }
    if (head.t !== 'atom') throw new Error(`MDL: bad form ${show(node)}`);
    const h = clean(head.v);
    if (SPECIAL.has(h)) return this.special(h, args, env, node);
    if (this.defs.has(h)) return this.invoke(this.defs.get(h), args, env, this.defs.get(h).macro);
    if (BUILTINS.has(h)) return this.builtin(h, args, env);
    // A ZIL form that is just data (e.g. <TABLE ...> inside generated code).
    return { ...node, items: [head, ...this.evalItems(args, env)] };
  }

  special(h, args, env, node) {
    switch (h) {
      case 'QUOTE': return args[0];
      case 'COND':
        for (const clause of args) {
          const items = clause.items || [];
          const test = this.eval(items[0], env);
          if (truthy(test)) {
            let r = test;
            for (const f of items.slice(1)) r = this.eval(f, env);
            return r;
          }
        }
        return null;
      case 'AND': { let r = T; for (const a of args) { r = this.eval(a, env); if (!truthy(r)) return null; } return r; }
      case 'OR': { for (const a of args) { const r = this.eval(a, env); if (truthy(r)) return r; } return null; }
      case 'PROG': case 'REPEAT': case 'BIND': {
        const local = new Map(); local.parent = env;
        let rest = args;
        if (rest[0]?.t === 'atom') rest = rest.slice(1); // activation name
        for (const b of rest[0]?.items || []) {
          if (b.t === 'str') continue;
          if (b.t === 'list') local.set(b.items[0].v, this.eval(b.items[1], local));
          else if (b.t === 'atom') local.set(b.v, null);
        }
        const body = rest.slice(1);
        const depth = ++this.loopDepth;
        try {
          for (;;) {
            let r = null;
            try {
              for (const f of body) r = this.eval(f, local);
            } catch (e) {
              if (e instanceof AgainSignal && e.depth === depth) continue;
              throw e;
            }
            if (h !== 'REPEAT') return r;
          }
        } catch (e) {
          if (e instanceof ReturnSignal) return e.value;
          throw e;
        } finally { this.loopDepth--; }
      }
      case 'RETURN': throw new ReturnSignal(args.length ? this.eval(args[0], env) : T, this.loopDepth);
      case 'AGAIN': throw new AgainSignal(this.loopDepth);
      case 'FUNCTION': return { t: 'closure', def: { name: 'lambda', params: args[0].items || [], body: args.slice(1), macro: false }, env };
      case 'SET': return this.setLocal(env, args[0].v ?? this.eval(args[0], env).v, this.eval(args[1], env));
      case 'SETG': { const v = this.eval(args[1], env); this.globals.set(args[0].v ?? this.eval(args[0], env).v, v); return v; }
      case 'ASSIGNED?': return this.assigned(env, args[0].v) ? T : null;
      case 'GASSIGNED?': return this.globals.has(args[0].v) || this.defs.has(args[0].v) ? T : null;
      case 'MAPF': case 'MAPR': {
        const finalFn = this.eval(args[0], env);
        const fn = this.eval(args[1], env);
        const lists = args.slice(2).map((a) => this.eval(a, env));
        const results = [];
        let leaveValue;
        const n = Math.min(...lists.map((l) => (l?.items || []).length));
        outer: for (let k = 0; k < (lists.length ? n : Infinity); k++) {
          const callArgs = lists.map((l) => (h === 'MAPR' ? { ...l, items: l.items.slice(k) } : l.items[k]));
          try {
            results.push(this.callValue(fn, callArgs, env));
          } catch (e) {
            if (e instanceof MapRet) { results.push(...e.values); continue; }
            if (e instanceof MapStop) {
              if (e.leave) { leaveValue = e.value; break outer; }
              results.push(...(e.value || [])); break outer;
            }
            throw e;
          }
        }
        if (leaveValue !== undefined) return leaveValue;
        if (!truthy(finalFn)) return results.length ? results[results.length - 1] : null;
        return this.callValue(finalFn, results, env);
      }
      case 'MAPRET': throw new MapRet(this.evalItems(args, env));
      case 'MAPSTOP': throw new MapStop(this.evalItems(args, env), false);
      case 'MAPLEAVE': throw new MapStop(args.length ? this.eval(args[0], env) : T, true);
    }
    throw new Error(`MDL: unhandled special ${h}`);
  }

  builtin(h, rawArgs, env) {
    const a = this.evalItems(rawArgs, env);
    const n = (x) => (x?.t === 'num' ? x.v : x?.t === 'char' ? x.v.charCodeAt(0) : Number(x?.v ?? 0));
    switch (h) {
      case 'FORM': return { t: 'form', items: a.map(toNode) };
      case 'LIST': return { t: 'list', items: a.map(toNode) };
      case 'VECTOR': case 'UVECTOR': return { t: 'list', vector: true, items: a.map(toNode) };
      case 'CHTYPE': {
        const type = a[1].v;
        if (type === 'FORM') return { t: 'form', items: a[0].items };
        if (type === 'LIST') return { t: 'list', items: a[0].items };
        if (type === 'ATOM') return a[0];
        return a[0];
      }
      case 'NTH': return nth(a[0], a.length > 1 ? n(a[1]) : 1);
      case 'REST': { const k = a.length > 1 ? n(a[1]) : 1; if (a[0].t === 'str') return { ...a[0], v: a[0].v.slice(k) }; return { ...a[0], items: a[0].items.slice(k) }; }
      case 'LENGTH': return num(len(a[0]));
      case 'EMPTY?': return len(a[0]) === 0 ? T : null;
      case 'LENGTH?': return len(a[0]) <= n(a[1]) ? num(len(a[0])) : null;
      case 'TYPE?': { const ty = typeOf(a[0]); return a.slice(1).some((x) => x.v === ty) ? atom(ty) : null; }
      case 'TYPE': return atom(typeOf(a[0]));
      case 'PRIMTYPE': return atom({ FORM: 'LIST', LIST: 'LIST' }[typeOf(a[0])] || typeOf(a[0]));
      case '==?': case '=?': case 'EQUAL?': return a.slice(1).some((b) => same(a[0], b)) ? T : null;
      case 'N==?': case 'N=?': return same(a[0], a[1]) ? null : T;
      case '+': return num(a.reduce((s, x) => s + n(x), 0));
      case '-': return num(a.length === 1 ? -n(a[0]) : a.slice(1).reduce((s, x) => s - n(x), n(a[0])));
      case '*': return num(a.reduce((s, x) => s * n(x), 1));
      case '/': return num(a.slice(1).reduce((s, x) => Math.trunc(s / n(x)), n(a[0])));
      case 'MOD': return num(n(a[0]) % n(a[1]));
      case 'G?': return n(a[0]) > n(a[1]) ? T : null;
      case 'L?': return n(a[0]) < n(a[1]) ? T : null;
      case 'G=?': return n(a[0]) >= n(a[1]) ? T : null;
      case 'L=?': return n(a[0]) <= n(a[1]) ? T : null;
      case '0?': return n(a[0]) === 0 ? T : null;
      case '1?': return n(a[0]) === 1 ? T : null;
      case 'LSH': return num(n(a[1]) >= 0 ? n(a[0]) << n(a[1]) : n(a[0]) >> -n(a[1]));
      case 'ORB': case 'BOR': return num(a.reduce((s, x) => s | n(x), 0));
      case 'ANDB': case 'BAND': return num(a.reduce((s, x) => s & n(x), -1));
      case 'XORB': return num(a.reduce((s, x) => s ^ n(x), 0));
      case 'NOT': return truthy(a[0]) ? null : T;
      case 'MAX': return num(Math.max(...a.map(n)));
      case 'MIN': return num(Math.min(...a.map(n)));
      case 'SPNAME': return { t: 'str', v: a[0].v };
      case 'PARSE': case 'ATOM': return atom(a[0].v);
      case 'STRING': return { t: 'str', v: a.map((x) => (x.t === 'char' ? x.v : x.t === 'str' ? x.v : x.t === 'atom' ? x.v : String(x.v))).join('') };
      case 'ASCII': return a[0].t === 'char' ? num(a[0].v.charCodeAt(0)) : { t: 'char', v: String.fromCharCode(n(a[0])) };
      case 'ERROR': throw new Error(`MDL ERROR: ${a.map(show).join(' ')}`);
      case 'PRINC': case 'PRIN1': case 'PRINT': case 'CRLF': case 'INSERT-FILE': return T;
      case 'PUTREST': a[0].items.splice(1, Infinity, ...(a[1]?.items || [])); return a[0];
      case 'PUT': { if (a[0].items) a[0].items[n(a[1]) - 1] = toNode(a[2]); return a[0]; }
      case 'GVAL': return this.gval(a[0].v);
      case 'LVAL': return this.lookup(env, a[0].v);
      case 'VOC': { const v = { t: 'vocab', word: a[0].v, part: a[1]?.v || 'NOUN' }; this.vocab.push(v); return v; }
      case 'APPLY': return this.callValue(a[0], a.slice(1), env);
      case 'EVAL': return this.eval(a[0], env);
      case 'TABLE': case 'LTABLE': case 'PTABLE': case 'PLTABLE': case 'ITABLE':
        return { t: 'form', items: [atom(h), ...a.map(toNode)] };
    }
    throw new Error(`MDL: unhandled builtin ${h}`);
  }
}

const SPECIAL = new Set(['QUOTE', 'COND', 'AND', 'OR', 'PROG', 'REPEAT', 'BIND', 'RETURN', 'AGAIN', 'FUNCTION', 'SET', 'SETG',
  'ASSIGNED?', 'GASSIGNED?', 'MAPF', 'MAPR', 'MAPRET', 'MAPSTOP', 'MAPLEAVE']);
const BUILTINS = new Set(['FORM', 'LIST', 'VECTOR', 'UVECTOR', 'CHTYPE', 'NTH', 'REST', 'LENGTH', 'EMPTY?', 'LENGTH?', 'TYPE?', 'TYPE',
  'PRIMTYPE', '==?', '=?', 'EQUAL?', 'N==?', 'N=?', '+', '-', '*', '/', 'MOD', 'G?', 'L?', 'G=?', 'L=?', '0?', '1?', 'LSH', 'ORB', 'BOR',
  'ANDB', 'BAND', 'XORB', 'NOT', 'MAX', 'MIN', 'SPNAME', 'PARSE', 'ATOM', 'STRING', 'ASCII', 'ERROR', 'PRINC', 'PRIN1', 'PRINT',
  'CRLF', 'INSERT-FILE', 'PUTREST', 'PUT', 'GVAL', 'LVAL', 'VOC', 'APPLY', 'EVAL', 'TABLE', 'LTABLE', 'PTABLE', 'PLTABLE', 'ITABLE']);

function toNode(x) { return x === null || x === undefined ? { t: 'form', items: [] } : x; }
function len(x) { return x?.t === 'str' ? x.v.length : (x?.items || []).length; }
function nth(x, k) {
  if (!x) return null;
  if (x.t === 'str') return { t: 'char', v: x.v[k - 1] };
  const v = (x.items || [])[k - 1];
  return v === undefined ? null : (v.t === 'form' && !v.items.length ? null : v);
}
function typeOf(x) {
  if (x === null) return 'FALSE';
  return { atom: 'ATOM', num: 'FIX', str: 'STRING', char: 'CHARACTER', form: 'FORM', list: 'LIST', closure: 'FUNCTION',
    builtin: 'SUBR', vocab: 'VOC', gval: 'GVAL', lval: 'LVAL', quote: 'FORM' }[x.t] || 'ANY';
}
function same(a, b) {
  if (a === null || b === null) return a === b;
  if (a.t !== b.t) return false;
  if (a.t === 'atom' || a.t === 'num' || a.t === 'str' || a.t === 'char') return a.v === b.v;
  return a === b;
}
