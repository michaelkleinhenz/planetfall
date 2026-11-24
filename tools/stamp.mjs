// Copies web/ to a deploy directory and stamps every local script, module import
// and stylesheet URL with a version (?v=<id>). Static hosts such as GitHub Pages
// let browsers cache files for a while; with versioned URLs a normal reload of
// the page always picks up a new deployment.
//
// The version of a file is a hash of its stamped content, which includes the
// versions of everything it imports (like a Merkle tree). So a URL changes
// exactly when the file or anything it depends on changes: after a release,
// the installed app (sw.js) downloads only what really changed, and the games
// it keeps for offline play stay valid as long as they are the same.
//
//   node tools/stamp.mjs <out-dir> [release]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'web');
const out = path.resolve(process.argv[2] || path.join(root, 'dist'));
let release = process.argv[3] || process.env.GITHUB_SHA || '';
if (!release) {
  try { release = execSync('git rev-parse HEAD', { cwd: root }).toString().trim(); } catch { release = String(Date.now()); }
}
release = release.slice(0, 12);

const isLocal = (u) => !/^(https?:|data:|\/\/|#|mailto:)/.test(u);
const isCode = (u) => /\.(m?js|css)$/.test(u.split('?')[0]);
const hash = (text) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);

// Stamped text of every .js/.css/.html file, by absolute path (memoized; the
// import graph has no cycles).
const stamped = new Map();
const versionOf = (abs) => hash(stampedText(abs));

/** `u` (relative to `fromDir`) with the content version of the file it names. */
function stampUrl(u, fromDir) {
  if (!isLocal(u) || !isCode(u)) return u;
  const bare = u.split('?')[0];
  const abs = path.resolve(fromDir, bare);
  if (!fs.existsSync(abs)) return u;
  return `${bare}?v=${versionOf(abs)}`;
}

function stampedText(abs) {
  if (stamped.has(abs)) return stamped.get(abs);
  stamped.set(abs, null); // guards against a cycle
  const text = fs.readFileSync(abs, 'utf8');
  const dir = path.dirname(abs);
  let result = text;
  if (abs.endsWith('.html')) {
    result = text.replace(/\b(src|href)="([^"]+)"/g, (m, attr, u) => `${attr}="${stampUrl(u, dir)}"`);
  } else if (abs.endsWith('.js')) {
    // static imports/exports ("from './x.js'", "import './x.js'") and dynamic import('./x.js')
    result = text
      .replace(/(\bfrom\s*|\bimport\s*)(['"])(\.{1,2}\/[^'"]+)\2/g, (m, kw, q, u) => `${kw}${q}${stampUrl(u, dir)}${q}`)
      .replace(/(\bimport\(\s*)(['"])(\.{1,2}\/[^'"]+)\2/g, (m, kw, q, u) => `${kw}${q}${stampUrl(u, dir)}${q}`);
  } else if (abs.endsWith('.css')) {
    result = text.replace(/url\((['"]?)(\.{0,2}\/?[^'")]+\.css)\1\)/g, (m, q, u) => `url(${q}${stampUrl(u, dir)}${q})`);
  }
  stamped.set(abs, result);
  return result;
}

function copy(rel = '') {
  for (const entry of fs.readdirSync(path.join(src, rel), { withFileTypes: true })) {
    const r = path.join(rel, entry.name);
    const from = path.join(src, r);
    const to = path.join(out, r);
    if (entry.isDirectory()) { fs.mkdirSync(to, { recursive: true }); copy(r); continue; }
    if (r === 'sw.js') continue; // written below
    if (/\.(html|js|css)$/.test(entry.name)) fs.writeFileSync(to, stampedText(from));
    else fs.copyFileSync(from, to);
  }
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
copy();
fs.writeFileSync(path.join(out, 'version.json'), JSON.stringify({ version: release }) + '\n');

// The service worker: the app shell to cache at install, and every game, which
// it downloads in the background afterwards for offline play. URLs carry the
// same ?v= the pages request.
const list = (dir, filter) => {
  const found = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(src, rel), { withFileTypes: true })) {
      const r = path.posix.join(rel, e.name);
      if (e.isDirectory()) walk(r); else if (filter(r)) found.push(r);
    }
  };
  walk(dir);
  return found;
};
const withVersion = (r) => stampUrl(r, src);
const isGameFile = (r) => /^src\/games\/[^/]+\/(game|story-data)\.js$/.test(r);
const shell = [
  './',
  ...['styles.css', 'retro.css'].map(withVersion),
  ...list('src', (r) => r.endsWith('.js') && !isGameFile(r)).map(withVersion),
  ...list('fonts', (r) => r.endsWith('.woff2')),
  ...list('img', (r) => /\.(jpg|png|svg)$/.test(r)),
  'manifest.webmanifest',
];
const games = list('src/games', isGameFile).map(withVersion);
fs.writeFileSync(path.join(out, 'sw.js'), fs.readFileSync(path.join(src, 'sw.js'), 'utf8')
  .replace("'__VERSION__'", JSON.stringify(release))
  .replace('[/* __SHELL__ */]', JSON.stringify(shell, null, 1))
  .replace('[/* __GAMES__ */]', JSON.stringify(games, null, 1)));
console.log(`service worker: ${shell.length} shell files, ${games.length} game files for offline play`);
console.log(`stamped ${path.relative(root, out) || out} (release ${release})`);
