// Copies web/ to a deploy directory and stamps every local script, module import
// and stylesheet URL with a version (?v=<id>). Static hosts such as GitHub Pages
// let browsers cache files for a while; with versioned URLs a normal reload of
// the page always picks up a new deployment.
//
//   node tools/stamp.mjs <out-dir> [version]
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'web');
const out = path.resolve(process.argv[2] || path.join(root, 'dist'));
let version = process.argv[3] || process.env.GITHUB_SHA || '';
if (!version) {
  try { version = execSync('git rev-parse HEAD', { cwd: root }).toString().trim(); } catch { version = String(Date.now()); }
}
version = version.slice(0, 12);

const isLocal = (u) => !/^(https?:|data:|\/\/|#|mailto:)/.test(u);
const stamp = (u) => (isLocal(u) && /\.(m?js|css)$/.test(u.split('?')[0]) ? `${u.split('?')[0]}?v=${version}` : u);

function rewrite(file, text) {
  if (file.endsWith('.html')) {
    return text.replace(/\b(src|href)="([^"]+)"/g, (m, attr, u) => `${attr}="${stamp(u)}"`);
  }
  if (file.endsWith('.js')) {
    // static imports/exports ("from './x.js'", "import './x.js'") and dynamic import('./x.js')
    return text
      .replace(/(\bfrom\s*|\bimport\s*)(['"])(\.{1,2}\/[^'"]+)\2/g, (m, kw, q, u) => `${kw}${q}${stamp(u)}${q}`)
      .replace(/(\bimport\(\s*)(['"])(\.{1,2}\/[^'"]+)\2/g, (m, kw, q, u) => `${kw}${q}${stamp(u)}${q}`);
  }
  if (file.endsWith('.css')) {
    return text.replace(/url\((['"]?)(\.{0,2}\/?[^'")]+\.css)\1\)/g, (m, q, u) => `url(${q}${stamp(u)}${q})`);
  }
  return text;
}

function copy(dir, rel = '') {
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.join(rel, entry.name);
    const from = path.join(dir, r);
    const to = path.join(out, r);
    if (entry.isDirectory()) { fs.mkdirSync(to, { recursive: true }); copy(dir, r); continue; }
    if (/\.(html|js|css)$/.test(entry.name)) fs.writeFileSync(to, rewrite(entry.name, fs.readFileSync(from, 'utf8')));
    else fs.copyFileSync(from, to);
  }
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
copy(src);
fs.writeFileSync(path.join(out, 'version.json'), JSON.stringify({ version }) + '\n');
console.log(`stamped ${path.relative(root, out) || out} with v=${version}`);
