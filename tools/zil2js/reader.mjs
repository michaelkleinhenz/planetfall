// ZIL/MDL reader: turns ZIL source text into a tree of nodes.
//
// Node shapes:
//   { t: 'form',  items: [...] }   <...>
//   { t: 'list',  items: [...] }   (...)
//   { t: 'atom',  v: 'NAME' }
//   { t: 'num',   v: 123 }
//   { t: 'str',   v: 'text' }      (raw string contents, escapes resolved)
//   { t: 'gval',  v: node }        ,X
//   { t: 'lval',  v: node }        .X
//   { t: 'quote', v: node }        'X
//   { t: 'seg',   v: node }        !X  (segments; only used in macros)
//   { t: 'char',  v: 'c' }         !\c
//   { t: 'macro', v: node }        %<...>  (compile-time evaluation)

const ATOM_STOP = new Set([' ', '\t', '\n', '\r', '\f', '<', '>', '(', ')', '"', ';', '[', ']', '{', '}']);

export function readZil(text, file = '?') {
  let i = 0;
  const n = text.length;
  let line = 1;

  function err(msg) {
    throw new Error(`${file}:${line}: ${msg}`);
  }

  function skipWs() {
    while (i < n) {
      const c = text[i];
      if (c === '\n') { line++; i++; }
      else if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\x0c') i++;
      else break;
    }
  }

  function readOne() {
    for (;;) {
      skipWs();
      if (i >= n) return undefined;
      const c = text[i];
      if (c === ';') { // comment: skip the next object
        i++;
        const skipped = readOne();
        if (skipped === undefined) return undefined;
        continue;
      }
      break;
    }
    const c = text[i];
    const startLine = line;
    if (c === '<') {
      i++;
      const items = readSeq('>');
      return { t: 'form', items, line: startLine };
    }
    if (c === '(') {
      i++;
      const items = readSeq(')');
      return { t: 'list', items, line: startLine };
    }
    if (c === '[') {
      i++;
      const items = readSeq(']');
      return { t: 'list', items, vector: true, line: startLine };
    }
    if (c === '"') {
      i++;
      let s = '';
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\') { s += text[i + 1]; i += 2; continue; }
        if (text[i] === '\n') line++;
        s += text[i++];
      }
      i++;
      return { t: 'str', v: s, line: startLine };
    }
    if (c === ',') { i++; return { t: 'gval', v: readOne(), line: startLine }; }
    if (c === '.') {
      // .X local value (but a bare "." can't occur outside escapes)
      i++; return { t: 'lval', v: readOne(), line: startLine };
    }
    if (c === "'") { i++; return { t: 'quote', v: readOne(), line: startLine }; }
    if (c === '%') {
      i++;
      if (text[i] === '%') i++;
      return { t: 'macro', v: readOne(), line: startLine };
    }
    if (c === '#') {
      // #TYPE value  (e.g. #BYTE 5) -- keep as a special list
      i++;
      const type = readAtomText();
      const val = readOne();
      return { t: 'hash', type, v: val, line: startLine };
    }
    if (c === '!') {
      i++;
      if (text[i] === '\\') { const ch = text[i + 1]; i += 2; return { t: 'char', v: ch, line: startLine }; }
      return { t: 'seg', v: readOne(), line: startLine };
    }
    if (c === '*') {
      // octal number *377*
      const m = /^\*([0-7]+)\*/.exec(text.slice(i, i + 20));
      if (m) { i += m[0].length; return { t: 'num', v: parseInt(m[1], 8), line: startLine }; }
    }
    if (c === '\\' && (text[i + 1] === '\n' || text[i + 1] === '\r' || text[i + 1] === ' ' || text[i + 1] === '\f')) {
      // page break marker
      i++;
      return readOne();
    }
    const a = readAtomText();
    if (a === '') err(`unexpected character ${JSON.stringify(c)}`);
    if (/^[-+]?[0-9]+$/.test(a)) return { t: 'num', v: parseInt(a, 10), line: startLine };
    return { t: 'atom', v: a, line: startLine };
  }

  function readAtomText() {
    let s = '';
    while (i < n) {
      const c = text[i];
      if (c === '\\') { s += text[i + 1]; i += 2; continue; }
      if (ATOM_STOP.has(c)) break;
      if ((c === ',' || c === "'") && s.length > 0) break;
      if (c === ',' || c === "'" || c === '!') {
        if (s.length === 0) break;
      }
      // a '.' inside an atom is legal in MDL only when escaped; treat as stop
      if (c === '.' && s.length === 0) break;
      s += c; i++;
    }
    return s;
  }

  function readSeq(close) {
    const items = [];
    for (;;) {
      skipWs();
      if (i >= n) err(`unterminated, expected ${close}`);
      if (text[i] === close) { i++; return items; }
      if (text[i] === ';') { i++; readOne(); continue; }
      const node = readOne();
      if (node === undefined) err(`unterminated, expected ${close}`);
      items.push(node);
    }
  }

  const out = [];
  for (;;) {
    const node = readOne();
    if (node === undefined) break;
    out.push(node);
  }
  return out;
}

// Pretty-print a node back to ZIL-ish text (used in comments / errors).
export function show(node) {
  if (node === undefined) return '?';
  switch (node.t) {
    case 'form': return '<' + node.items.map(show).join(' ') + '>';
    case 'list': return '(' + node.items.map(show).join(' ') + ')';
    case 'atom': return node.v;
    case 'num': return String(node.v);
    case 'str': return JSON.stringify(node.v);
    case 'gval': return ',' + show(node.v);
    case 'lval': return '.' + show(node.v);
    case 'quote': return "'" + show(node.v);
    case 'seg': return '!' + show(node.v);
    case 'char': return '!\\' + node.v;
    case 'macro': return '%' + show(node.v);
    case 'hash': return '#' + node.type + ' ' + show(node.v);
  }
  return '??';
}
