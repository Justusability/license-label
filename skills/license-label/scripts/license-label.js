#!/usr/bin/env node
/*
 * Licence label: a plain-language summary of the open-source licences inside an app.
 *
 * Reads the dependency lockfiles in a project folder (npm, yarn, pnpm, bun, plus
 * Python where it can), takes each package's *declared* licence, sorts the packages
 * onto a five-step scale of conditions, and writes one self-contained HTML label.
 *
 * No dependencies. Node 18 or later. Reads the project; writes only the files you name.
 * A reading aid, not legal advice. Declared licences can be wrong.
 */
'use strict';
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- the scale
const GROUPS = [
  { name: 'No conditions',
    short: 'Use it however you like.',
    copies: 'Nothing you have to do.',
    service: 'Nothing you have to do.' },
  { name: 'Keep the notice',
    short: "Use it freely, but keep the author's copyright and licence notice with it.",
    copies: 'Ship the copyright and licence notices for these parts with your app, for example an "Open-source licences" screen or a notices file. Apache-licensed parts also ask you to keep any NOTICE file and say if you changed their files.',
    service: "Code that stays on your server: nothing to hand over. Code that reaches people's browsers or phones is generally treated as a copy, so the notices should travel with it." },
  { name: 'Share changes to that part',
    short: "Your own code stays yours. If you change that part's own files, you share those changes.",
    copies: 'Keep the notices. If you changed the files of one of these parts, publish those changes under the same licence. For LGPL parts, people must also be able to swap in their own version of that part. Using them unchanged, as a normal dependency, is the easy case.',
    service: 'Nothing extra for code that only runs on your server. Anything sent to browsers or phones follows the "handing out copies" rule.' },
  { name: 'Share the whole program',
    short: "If you hand out the app, the whole app's source must be offered under the same licence.",
    copies: "If you give people copies of an app that includes these parts, you are expected to offer the source of the whole app under the same licence (GPL). If that is not what you want, replace the part or get advice before you ship.",
    service: 'Running it on your own server without handing out copies does not, on its own, require you to share your source.' },
  { name: 'Share it even when hosted',
    short: 'Like the step before, and it also applies when people only use the app over the internet.',
    copies: 'Same as "share the whole program": offer the whole app\'s source under the same licence.',
    service: 'People who use your app over a network must be able to get its source too (AGPL and similar). For a hosted product this is the one to take most seriously: replace the part, open your source, or get advice.' },
];
const UNKNOWN = 5;
const UNKNOWN_NAME = 'Not open source, or unknown';
const groupName = (g) => (g < 5 ? GROUPS[g].name : UNKNOWN_NAME);

const G0 = new Set(['0BSD', 'UNLICENSE', 'CC0-1.0', 'WTFPL', 'MIT-0', 'CC-PDDC', 'PUBLIC DOMAIN']);
const G1 = new Set(['MIT', 'ISC', 'ZLIB', 'PYTHON-2.0', 'PSF-2.0', 'BLUEOAK-1.0.0', 'CC-BY-3.0', 'CC-BY-4.0',
  'BSL-1.0', 'W3C', 'POSTGRESQL', 'HPND', 'NCSA', 'X11', 'CURL', 'OFL-1.1', 'ARTISTIC-2.0', 'MIT-CMU', 'BSD',
  'APACHE', 'LIBPNG', 'FTL', 'ICU', 'NTP', 'UPL-1.0', 'AFL-2.1', 'AFL-3.0']);
const FAMILIES = [
  [/^AGPL/, 4], [/^(EUPL|OSL)/, 4], [/^LGPL/, 2], [/^GPL/, 3], [/^(MPL|EPL|CDDL|CPL|MS-RL)/, 2],
  [/^(SSPL|BUSL|ELASTIC|POLYFORM|CC-BY-NC|CC-BY-ND|CC-BY-SA|COMMONS-CLAUSE)/, UNKNOWN],
  [/^(BSD-|APACHE-|UNICODE)/, 1],
];
const FREE_TEXT = [ // older free-text licence fields, mostly Python
  ['AFFERO', 4], ['LESSER GENERAL', 2], ['LGPL', 2], ['GENERAL PUBLIC', 3], ['GPL', 3], ['MOZILLA', 2],
  ['APACHE', 1], ['BSD', 1], ['MIT', 1], ['ISC', 1], ['PYTHON SOFTWARE', 1], ['PSF', 1],
  ['PUBLIC DOMAIN', 0], ['UNLICENSE', 0],
];

function classifyId(id) {
  const u = id.trim().toUpperCase().replace(/(-ONLY|-OR-LATER|\+)$/, '');
  if (!u || ['UNLICENSED', 'UNKNOWN', 'NONE', 'PROPRIETARY'].includes(u) || u.startsWith('SEE LICEN')) return UNKNOWN;
  if (G0.has(u)) return 0;
  if (G1.has(u)) return 1;
  for (const [rx, g] of FAMILIES) if (rx.test(u)) return g;
  return null;
}

/** Group (0-4, or UNKNOWN) for a declared licence. With OR you may choose, so the
 *  lightest option counts. With AND every licence applies, so the strictest counts. */
function classify(raw) {
  raw = String(raw == null ? '' : raw).trim();
  if (!raw) return UNKNOWN;
  const toks = raw.match(/\(|\)|[^\s()]+/g) || [];
  let pos = 0;
  const fail = () => { throw new Error('not spdx'); };
  const atom = () => {
    if (pos >= toks.length) fail();
    const t = toks[pos++];
    if (t === '(') {
      const g = expr();
      if (toks[pos] !== ')') fail();
      pos++;
      return g;
    }
    if ([')', 'AND', 'OR', 'WITH'].includes(t)) fail();
    const g = classifyId(t);
    if (g === null) fail();
    if ((toks[pos] || '').toUpperCase() === 'WITH') pos += 2; // an exception only loosens
    return g;
  };
  const andExpr = () => {
    let g = atom();
    while ((toks[pos] || '').toUpperCase() === 'AND') { pos++; g = Math.max(g, atom()); }
    return g;
  };
  function expr() {
    let g = andExpr();
    while ((toks[pos] || '').toUpperCase() === 'OR') { pos++; g = Math.min(g, andExpr()); }
    return g;
  }
  try {
    const g = expr();
    if (pos === toks.length) return g;
  } catch (e) { /* fall through to free text */ }
  const u = raw.toUpperCase();
  if (u.startsWith('SEE LICEN')) return UNKNOWN;
  if (u.length < 120) for (const [word, g] of FREE_TEXT) if (u.includes(word)) return g;
  return UNKNOWN;
}

// ---------------------------------------------------------------- reading
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'venv', 'env', '__pycache__', 'target',
  'storybook-static', 'coverage', 'vendor', 'Pods', 'site-packages']);
const LICENCE_FILE = /^(LICEN[SC]E|COPYING|NOTICE|UNLICENSE|THIRD[-_ ]?PARTY[-_ ]?(LICEN[SC]ES?|NOTICES?))([.\-_].*)?$/i;
const NPM_LOCKS = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb'];
const MANIFEST = /^(package(-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|uv\.lock|poetry\.lock|Pipfile\.lock|pyproject\.toml|requirements.*\.txt)$/;

const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } };
const listDir = (p) => { try { return fs.readdirSync(p).sort(); } catch (e) { return []; } };
function firstLine(p) {
  const t = readText(p);
  if (!t) return '';
  const l = t.split('\n').find((x) => x.trim());
  return l ? l.trim().slice(0, 120) : '';
}
const licenceFiles = (dir) => listDir(dir).filter((n) => LICENCE_FILE.test(n)).map((n) => path.join(dir, n));

function pkgJsonLicence(pj) {
  let lic = pj.license || pj.licenses;
  if (Array.isArray(lic)) lic = lic.map((x) => (x && typeof x === 'object' ? x.type : x)).join(' OR ');
  else if (lic && typeof lic === 'object') lic = lic.type;
  return lic || '';
}

/** Folders under root that hold a dependency manifest, plus the project's own licence files. */
function findParts(root, maxDepth = 4) {
  const parts = [];
  const own = [];
  const walk = (dir, depth) => {
    const names = listDir(dir);
    const files = new Set(names.filter((n) => !isDir(path.join(dir, n))));
    const npm = files.has('package.json') && (NPM_LOCKS.some((l) => files.has(l)) || isDir(path.join(dir, 'node_modules')));
    const py = ['uv.lock', 'poetry.lock', 'Pipfile.lock', 'pyproject.toml'].some((f) => files.has(f)) ||
      [...files].some((f) => /^requirements.*\.txt$/.test(f));
    if (npm || py) parts.push({ dir, rel: path.relative(root, dir) || '.', npm, py, files });
    for (const f of files) {
      if (LICENCE_FILE.test(f)) own.push({ path: path.relative(root, path.join(dir, f)), full: path.join(dir, f), first: firstLine(path.join(dir, f)) });
    }
    if (depth >= maxDepth) return;
    for (const n of names) {
      if (files.has(n) || SKIP_DIRS.has(n) || n.startsWith('.')) continue;
      walk(path.join(dir, n), depth + 1);
    }
  };
  walk(root, 0);
  return { parts, own };
}

function add(pkgs, eco, name, version, lic, shipped, part, extra = {}) {
  const key = `${eco}:${name}@${version}`;
  let p = pkgs.get(key);
  if (!p) {
    p = { eco, name, version, licence: String(lic || ''), group: classify(lic), shipped: false, parts: [],
      via: [], dir: null, source: '' };
    pkgs.set(key, p);
  }
  p.shipped = p.shipped || shipped;
  if (!p.parts.includes(part)) p.parts.push(part);
  if (extra.via && extra.via.length && (!p.via.length || extra.via.length < p.via.length)) p.via = extra.via;
  if (extra.dir && !p.dir) p.dir = extra.dir;
  if (extra.source && !p.source) p.source = extra.source;
  return p;
}

function readNpmLock(part, pkgs, notes, lockName, entries) {
  // who brought each package in: the shortest chain from your own package.json
  const parent = new Map([['', null]]);
  const resolve = (base, dep) => {
    for (;;) {
      const cand = (base ? base + '/' : '') + 'node_modules/' + dep;
      if (entries[cand]) return cand;
      if (!base) return null;
      const i = base.lastIndexOf('/node_modules/');
      base = i >= 0 ? base.slice(0, i) : '';
    }
  };
  const queue = [''];
  // workspaces and linked folders count as your own code
  for (const [k, e] of Object.entries(entries)) {
    if (e.link && e.resolved && entries[e.resolved] && !parent.has(e.resolved)) { parent.set(e.resolved, ''); queue.push(e.resolved); }
  }
  while (queue.length) {
    const k = queue.shift();
    const e = entries[k] || {};
    const fields = ['dependencies', 'optionalDependencies', 'peerDependencies'];
    if (!k.includes('node_modules/')) fields.push('devDependencies');
    for (const f of fields) {
      for (const dep of Object.keys(e[f] || {})) {
        const r = resolve(k, dep);
        if (r && !parent.has(r)) { parent.set(r, k); queue.push(r); }
      }
    }
  }
  const nameOf = (k) => entries[k].name || k.slice(k.lastIndexOf('node_modules/') + 13);
  let count = 0;
  for (const [k, e] of Object.entries(entries)) {
    if (!k.includes('node_modules/') || e.link) continue;
    const dir = path.join(part.dir, k);
    let lic = e.license;
    if (!lic) lic = pkgJsonLicence(readJson(path.join(dir, 'package.json')) || {});
    const chain = [];
    for (let c = parent.get(k); c; c = parent.get(c)) if (c.includes('node_modules/')) chain.unshift(nameOf(c));
    add(pkgs, 'npm', nameOf(k), e.version || '?', lic, !e.dev, part.rel,
      { via: chain, dir: isDir(dir) ? dir : null, source: lockName });
    count++;
  }
  notes.push(`${path.join(part.rel, lockName)}: ${count} packages, licences read from the lockfile.`);
}

/** yarn, pnpm, bun and old npm lockfiles do not record licences: follow package.json
 *  through what is installed. Start from "dependencies" for the app, then "devDependencies". */
function readNodeModules(part, pkgs, notes) {
  const rootPj = readJson(path.join(part.dir, 'package.json')) || {};
  if (!isDir(path.join(part.dir, 'node_modules'))) {
    notes.push(`${part.rel}: found package.json but no package-lock.json and nothing installed, so nothing could be resolved. Run your install first.`);
    return;
  }
  const findOnDisk = (fromDir, dep) => {
    for (let d = fromDir; ; d = path.dirname(d)) {
      const cand = path.join(d, 'node_modules', dep);
      if (fs.existsSync(path.join(cand, 'package.json'))) { try { return fs.realpathSync(cand); } catch (e) { return cand; } }
      if (d === part.dir || path.dirname(d) === d) return null;
    }
  };
  const seen = new Map(); // real dir -> {shipped, via}
  const run = (startDeps, shipped) => {
    const queue = [];
    for (const dep of startDeps) {
      const r = findOnDisk(part.dir, dep);
      if (r && !seen.has(r)) { seen.set(r, { shipped, via: [] }); queue.push(r); }
    }
    while (queue.length) {
      const dir = queue.shift();
      const pj = readJson(path.join(dir, 'package.json')) || {};
      const me = seen.get(dir);
      const deps = Object.keys({ ...pj.dependencies, ...pj.optionalDependencies, ...pj.peerDependencies });
      for (const dep of deps) {
        const r = findOnDisk(dir, dep);
        if (r && !seen.has(r)) { seen.set(r, { shipped, via: [...me.via, pj.name || path.basename(dir)] }); queue.push(r); }
      }
    }
  };
  run(Object.keys({ ...rootPj.dependencies, ...rootPj.optionalDependencies }), true);
  run(Object.keys(rootPj.devDependencies || {}), false);
  let count = 0;
  for (const [dir, info] of seen) {
    const pj = readJson(path.join(dir, 'package.json'));
    if (!pj || !pj.name || !pj.version) continue;
    add(pkgs, 'npm', pj.name, pj.version, pkgJsonLicence(pj), info.shipped, part.rel,
      { via: info.via, dir, source: 'node_modules' });
    count++;
  }
  notes.push(`${part.rel}: no package-lock.json, so ${count} installed packages were read from node_modules, following package.json.`);
}

function readNpm(part, pkgs, notes) {
  for (const n of ['package-lock.json', 'npm-shrinkwrap.json']) {
    if (!part.files.has(n)) continue;
    const lock = readJson(path.join(part.dir, n));
    if (lock && lock.packages) return readNpmLock(part, pkgs, notes, n, lock.packages);
  }
  return readNodeModules(part, pkgs, notes);
}

const normPy = (n) => n.replace(/[-_.]+/g, '-').toLowerCase();

async function readPython(part, pkgs, notes, online) {
  const wanted = new Map(); // normalised name -> version or null
  for (const f of [...part.files].sort()) {
    const text = readText(path.join(part.dir, f));
    if (text == null) continue;
    if (f === 'uv.lock' || f === 'poetry.lock') {
      for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
        const name = (block.match(/^name\s*=\s*"([^"]+)"/m) || [])[1];
        const version = (block.match(/^version\s*=\s*"([^"]+)"/m) || [])[1];
        if (name && !/^source\s*=\s*\{[^}]*(virtual|editable)/m.test(block)) wanted.set(normPy(name), version || null);
      }
    } else if (f === 'Pipfile.lock') {
      const j = readJson(path.join(part.dir, f)) || {};
      for (const sec of ['default', 'develop']) {
        for (const [n, v] of Object.entries(j[sec] || {})) wanted.set(normPy(n), ((v && v.version) || '').replace(/^=+/, '') || null);
      }
    } else if (/^requirements.*\.txt$/.test(f)) {
      for (const line of text.split('\n')) {
        if (/^\s*(#|-|$)/.test(line)) continue;
        const m = line.match(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:==\s*([^\s;#]+))?/);
        if (m && !wanted.has(normPy(m[1]))) wanted.set(normPy(m[1]), m[2] || null);
      }
    } else if (f === 'pyproject.toml') {
      const m = text.match(/^\[project\][\s\S]*?^dependencies\s*=\s*\[([\s\S]*?)\]/m);
      if (m) {
        for (const s of m[1].match(/["']([^"']+)["']/g) || []) {
          const n = (s.slice(1).match(/^[A-Za-z0-9][A-Za-z0-9._-]*/) || [])[0];
          if (n && !wanted.has(normPy(n))) wanted.set(normPy(n), null);
        }
      }
    }
  }
  if (!wanted.size) return;
  const installed = new Map();
  for (const venv of ['.venv', 'venv', 'env']) {
    const lib = path.join(part.dir, venv, 'lib');
    const sites = isDir(lib) ? listDir(lib).map((d) => path.join(lib, d, 'site-packages')).concat(path.join(lib, 'site-packages')) : [];
    for (const site of sites) {
      for (const dn of listDir(site)) {
        if (!dn.endsWith('.dist-info')) continue;
        const meta = readText(path.join(site, dn, 'METADATA'));
        if (!meta) continue;
        let name = '', ver = '', expr = '', lic = '';
        const cls = [];
        for (const line of meta.split('\n')) {
          if (!line.trim()) break;
          const i = line.indexOf(':');
          const k = line.slice(0, i), v = line.slice(i + 1).trim();
          if (k === 'Name') name = v;
          else if (k === 'Version') ver = v;
          else if (k === 'License-Expression') expr = v;
          else if (k === 'License' && !lic) lic = v;
          else if (k === 'Classifier' && v.startsWith('License ::')) cls.push(v.split('::').pop().trim());
        }
        if (name) installed.set(normPy(name), { ver, lic: expr || cls.join(' AND ') || lic, dir: path.join(site, dn) });
      }
    }
  }
  const names = new Map(wanted);
  for (const [n, i] of installed) if (!names.has(n)) names.set(n, i.ver); // an installed environment shows indirect packages too
  let found = 0, looked = 0;
  for (const n of [...names.keys()].sort()) {
    let v = names.get(n), lic = '', source = 'not installed here', dir = null;
    if (installed.has(n)) {
      ({ ver: v, lic, dir } = installed.get(n));
      source = 'installed package metadata';
      found++;
    } else if (online) {
      try {
        const r = await fetch(`https://pypi.org/pypi/${n}${v ? '/' + v : ''}/json`, { signal: AbortSignal.timeout(10000) });
        const info = (await r.json()).info;
        const cls = (info.classifiers || []).filter((c) => c.startsWith('License ::')).map((c) => c.split('::').pop().trim());
        lic = info.license_expression || cls.join(' AND ') || info.license || '';
        v = v || info.version;
        source = 'pypi.org';
        looked++;
      } catch (e) { source = 'lookup failed'; }
    }
    add(pkgs, 'pypi', n, v || '?', lic, true, part.rel, { source, dir });
  }
  let msg = `${part.rel}: ${names.size} Python packages (${found} read from an installed environment` +
    (online ? `, ${looked} looked up on pypi.org).` : ').');
  if (names.size - found - looked > 0) msg += ' Python lockfiles do not record licences; install the project or run with --online to fill the gaps.';
  if (!installed.size) msg += ' Without an installed environment or a lockfile, indirect Python packages are not listed.';
  notes.push(msg);
}

/** A second opinion: ask deps.dev what licence it has on record for each package in the app. */
async function secondOpinion(pkgs) {
  const todo = [...pkgs.values()].filter((p) => p.shipped && p.version !== '?');
  let checked = 0, failed = 0, silent = 0;
  const differ = [];
  const one = async (p) => {
    const url = `https://api.deps.dev/v3/systems/${p.eco}/packages/${encodeURIComponent(p.name)}/versions/${encodeURIComponent(p.version)}`;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) { failed++; return; }
      const theirs = ((await r.json()).licenses || []).join(' AND ');
      checked++;
      if (!theirs) { silent++; return; }
      const g = classify(theirs);
      if (g !== p.group) { p.second = { licence: theirs, group: g }; differ.push(p); }
    } catch (e) { failed++; }
  };
  for (let i = 0; i < todo.length; i += 12) await Promise.all(todo.slice(i, i + 12).map(one));
  return { checked, failed, silent, differ };
}

// ---------------------------------------------------------------- the label
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => n.toLocaleString('en-AU');
const plural = (n, word) => `${num(n)} ${n === 1 ? word : word.endsWith('y') ? word.slice(0, -1) + 'ies' : word + 's'}`;
const some = (arr, n = 6) => arr.slice(0, n).join(', ') + (arr.length > n ? ' and others' : '');

// One library is often published as a package per operating system. Show those as one line.
const PLATFORM = /-(darwin|linux|linuxmusl|win32|freebsd|openbsd|netbsd|android|sunos|aix|wasm32|wasi)(-[a-z0-9_]+)*$/;
function families(items) {
  const byFam = new Map();
  for (const p of items) {
    const fam = PLATFORM.test(p.name) ? p.name.replace(PLATFORM, '-*') : p.name;
    if (!byFam.has(fam)) byFam.set(fam, []);
    byFam.get(fam).push(p);
  }
  const out = [];
  for (const [fam, ps] of byFam) {
    const names = new Set(ps.map((p) => p.name));
    if (fam.endsWith('-*') && names.size > 1) out.push({ name: fam, members: ps, builds: names.size });
    else for (const n of names) out.push({ name: n, members: ps.filter((p) => p.name === n), builds: 1 });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Words worth knowing about inside a licence file that could not be placed on the scale. */
function mentions(text) {
  const found = [];
  if (/\bAGPL|Affero/i.test(text)) found.push('the AGPL (step 5)');
  else if (/(^|[^AL])GPL|GNU General Public/i.test(text)) found.push('the GPL (step 4)');
  if (/subscription/i.test(text)) found.push('a subscription');
  if (/non-?commercial/i.test(text)) found.push('non-commercial use');
  if (/\bin production\b|production use/i.test(text)) found.push('limits on production use');
  return found;
}

// ---------------------------------------------------------------- how it is shipped
const SHIP = {
  hosted: { name: 'Hosted app', count: 'Open-source parts in your app',
    blurb: 'People use it over the internet. The server side stays with you; the front-end code goes to their browsers.' },
  copies: { name: 'App people download or install', count: 'Open-source parts in your app',
    blurb: 'People receive the software itself: a desktop or phone app, an installer, or a copy on their own servers.' },
  static: { name: 'Static site', count: 'Open-source parts used to build your site',
    blurb: 'The site is built once and served as finished pages. Most parts only run during the build.' },
  package: { name: 'Published package', count: 'Open-source parts your package pulls in',
    blurb: 'You publish your own files. When someone installs the package, the parts it needs are fetched from their own authors.' },
};

/** A first guess at how a folder is shipped, with the clue it came from. A person should confirm it. */
function guessShip(pj) {
  if (!pj) return { ship: 'hosted', why: '' };
  const deps = { ...pj.dependencies, ...pj.devDependencies, ...pj.optionalDependencies };
  const has = (...names) => names.find((n) => n in deps);
  let clue = has('electron', 'react-native', 'expo', '@tauri-apps/api', '@capacitor/core');
  if (clue) return { ship: 'copies', why: clue };
  const server = has('next', 'nuxt', '@remix-run/node', '@sveltejs/kit', 'express', 'fastify', 'hono', '@nestjs/core');
  const site = has('astro', '@11ty/eleventy', '@docusaurus/core', 'vitepress', 'gatsby');
  if (!pj.private && !server && !site && (pj.bin || pj.files || pj.exports || pj.main)) {
    return { ship: 'package', why: pj.bin ? 'a "bin" entry in package.json' : 'package.json is set up for publishing' };
  }
  if (site && !server && !has('@astrojs/node', '@astrojs/vercel', '@astrojs/netlify', '@astrojs/cloudflare')) return { ship: 'static', why: site };
  return { ship: 'hosted', why: server || '' };
}

/** What the strictest step means, for the way this app is shipped. */
function meaning(ship, g) {
  if (ship === 'static') {
    return {
      a: ['Building the site', g >= 3
        ? 'Using these parts to build your site does not, on its own, put your site under their licence.'
        : 'Nothing to do. Parts that only run while the site is built ask nothing of you when used unchanged.'],
      b: ['What visitors receive', [
        'Nothing you have to do.',
        'If code from these parts ends up inside your pages (scripts, styles, fonts), keep its notice with it. Build tools usually leave notices in the output, or can be set to.',
        'The same as "keep the notice". If you changed a share-changes part\'s own files and that code is in your pages, share those changes.',
        'If code from these parts ends up inside the pages you publish, that is a copy of it, and the licence\'s sharing terms apply to it. Check what is in your built pages, and get advice.',
        'If code from these parts ends up inside the pages you publish, that is a copy of it, and the licence\'s sharing terms apply to it. Check what is in your built pages, and get advice.'][g]],
      note: 'This tool cannot see which parts end up inside your finished pages. Most only run during the build.',
    };
  }
  if (ship === 'package') {
    return {
      a: ['What you hand out', g >= 3
        ? 'Your own files. But a package that needs these parts cannot be used without them, so their sharing terms reach everyone who uses yours. Replace the part, or get advice.'
        : 'Only your own files, under your own licence. If your published files include code copied or bundled from these parts, keep its notice with it.'],
      b: ['What your users inherit', `Anyone who installs your package gets these parts too, so step ${g + 1} shows up on their label. ` + [
        'It asks nothing of them.',
        'They keep the notices, which is routine.',
        'They can use the parts unchanged without sharing anything of their own.',
        'Many will not be able to use your package in software they hand out.',
        'Many will not be able to use your package at all, hosted products included.'][g]],
      note: 'You are not the one handing these parts out, but your choice of parts becomes part of every project that uses your package.',
    };
  }
  return {
    a: ['Handing out copies', GROUPS[g].copies], b: ['Running it as a service', GROUPS[g].service], you: ship === 'copies' ? 0 : 1,
    note: '"Handing out copies" means people get the software itself: a download, an app-store app, an installer, source code, or the front-end code a website sends to a browser. "Running it as a service" means it stays on your server and people only use it.',
  };
}

function ownLicenceNames(file) {
  const t = readText(file) || '';
  const out = [];
  for (const [rx, name] of [[/MIT License/i, 'MIT'], [/CC0/i, 'CC0-1.0'], [/Apache License/i, 'Apache-2.0'],
    [/Affero General Public/i, 'AGPL'], [/Lesser General Public/i, 'LGPL'], [/Mozilla Public/i, 'MPL-2.0'], [/BSD/, 'BSD']]) {
    if (rx.test(t)) out.push(name);
  }
  if (!out.includes('AGPL') && !out.includes('LGPL') && /GNU General Public/i.test(t)) out.push('GPL');
  return out;
}

function summarise(pkgs) {
  const shipped = [0, 0, 0, 0, 0, 0];
  const tools = [0, 0, 0, 0, 0, 0];
  for (const p of pkgs.values()) (p.shipped ? shipped : tools)[p.group]++;
  const top = (arr) => { let t = null; for (let g = 0; g < 5; g++) if (arr[g]) t = g; return t; };
  return { shipped, tools, strictest: top(shipped), toolsStrictest: top(tools) };
}

function packageList(items, showVia) {
  const byLic = new Map();
  for (const p of items) {
    const k = p.licence || 'no licence declared';
    if (!byLic.has(k)) byLic.set(k, []);
    byLic.get(k).push(p);
  }
  return [...byLic.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).map(([lic, ps]) => {
    const rows = families(ps).map((f) => {
      const vers = [...new Set(f.members.map((p) => p.version))].join(', ');
      const first = f.members.find((p) => p.via.length) || f.members[0];
      const via = showVia && first.via.length ? ` <span class="via">via ${esc(first.via.join(' → '))}</span>` : '';
      const tool = f.members.some((p) => p.shipped) ? '' : ' <span class="tag">build tool</span>';
      const builds = f.builds > 1 ? ` <span class="via">· one library, ${f.builds} operating-system builds</span>` : '';
      return `<li><span class="pk">${esc(f.name)}</span> <span class="ver">${esc(vers)}</span>${tool}${builds}${via}</li>`;
    }).join('');
    return `<div class="lic"><h4>${esc(lic)} <span class="n">${ps.length}</span></h4><ul>${rows}</ul></div>`;
  }).join('');
}

const CSS = `
:root{--ink:#082F20;--deep:#041B12;--mid:#206347;--neon:#68DBAA;--soft:#D8F2E4;--bg:#E8F6EE;
--amber:#F0BD72;--amberink:#322719;--purple:#6E5FD3;--body:#191B21;--muted:#596170}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--body);font:16px/1.5 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;padding:32px 16px 64px}
.label{max-width:640px;margin:0 auto 24px;background:#fff;border:3px solid var(--ink);border-radius:18px;padding:28px 28px 20px}
.kicker{font:500 12px/1 "JetBrains Mono",ui-monospace,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--mid)}
h1,h2,h3,.big{font-family:"Space Grotesk",Inter,system-ui,sans-serif;font-weight:500;color:var(--ink);letter-spacing:-.03em}
h1{font-size:44px;line-height:1;margin:10px 0 6px;overflow-wrap:anywhere}
.sub{color:var(--muted);font-size:14px;margin:0}
.ship{margin-top:12px;font-size:14.5px}
.pill{display:inline-block;background:var(--ink);color:#fff;border-radius:99px;padding:1px 10px;font-weight:600;font-size:13px;margin-right:4px}
.means .you{outline:3px solid var(--ink)}
.rule{border:0;border-top:10px solid var(--ink);margin:18px 0 14px}
.rule.thin{border-top-width:3px}
.count{display:flex;align-items:baseline;justify-content:space-between;gap:16px}
.count .big{font-size:56px;line-height:1}
.count p{margin:0;font-weight:600;color:var(--ink)}
.small{font-size:14px;color:var(--muted);margin:6px 0 0}
h2{font-size:30px;line-height:1.05;margin:8px 0 8px}
h3{font-size:19px;margin:0 0 4px;letter-spacing:-.02em}
.means{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px}
.means div{background:var(--bg);border-radius:18px;padding:14px 16px}
.means p{margin:0;font-size:14.5px}
.row{border-top:1px solid var(--ink)}
.row summary{display:grid;grid-template-columns:22px 1fr auto;gap:10px;align-items:center;padding:10px 0;cursor:pointer;list-style:none}
.row summary::-webkit-details-marker{display:none}
.step{width:22px;height:22px;border-radius:50%;background:var(--soft);color:var(--deep);font:500 12px/22px "Space Grotesk",system-ui,sans-serif;text-align:center}
.row.has .step{background:var(--mid);color:#fff}
.row.top .step{background:var(--neon);color:var(--deep);outline:3px solid var(--ink)}
.row.unk.has .step{background:var(--amber);color:var(--amberink)}
.rn{font-weight:600;color:var(--ink)}
.rn small{display:block;font-weight:400;color:var(--muted);font-size:13.5px}
.num{font:500 22px/1 "Space Grotesk",system-ui,sans-serif;color:var(--ink);text-align:right}
.num small{display:block;font:400 12px/1.4 Inter,system-ui,sans-serif;color:var(--muted)}
.row.empty .num,.row.empty .rn{color:var(--muted)}
.bar{grid-column:2/4;height:8px;border-radius:99px;background:var(--bg);overflow:hidden}
.bar i{display:block;height:100%;border-radius:99px;background:var(--mid);min-width:0}
.row.unk .bar i{background:var(--amber)}
.detail{padding:4px 0 14px 32px}
.lic h4{margin:10px 0 4px;font:500 12.5px/1.3 "JetBrains Mono",ui-monospace,Menlo,monospace;color:var(--ink)}
.lic .n{color:var(--muted);font-weight:400}
.lic ul{margin:0;padding:0;list-style:none;font-size:13.5px}
.lic li{padding:1px 0;overflow-wrap:anywhere}
.pk{font-weight:600}.ver,.via{color:var(--muted)}
.tag{font-size:11px;border:1px solid var(--muted);border-radius:99px;padding:0 6px;color:var(--muted)}
.todo{margin:0;padding:0;list-style:none}
.todo li{position:relative;padding:8px 0 8px 32px;border-top:1px solid #d5ddd8}
.todo li:first-child{border-top:0}
.todo li::before{content:"";position:absolute;left:2px;top:11px;width:16px;height:16px;border:2px solid var(--ink);border-radius:50%}
.flagbox{background:var(--amber);color:var(--amberink);border:3px solid var(--amberink);border-radius:18px;padding:14px 16px;margin-top:14px}
.flagbox h3{color:var(--amberink);font-size:22px}
.flagbox ul{margin:8px 0 0;padding-left:18px;font-size:15px}
.flagbox li{margin-bottom:6px}
.flagbox .via,.flagbox .small{color:var(--amberink);opacity:.8}
.seen{display:inline-block;background:var(--soft);color:var(--deep);border-radius:99px;padding:0 8px;font-size:12.5px}
.look{background:#FDF3E3;border-radius:18px;padding:14px 16px;margin-top:12px}
.look h3{color:var(--amberink)}
.look ul{margin:6px 0 0;padding-left:18px;font-size:14.5px}
.look p{margin:4px 0 0;font-size:14.5px}
.q{color:var(--muted);font-style:italic}
table{width:100%;border-collapse:collapse;font-size:14px}
td,th{text-align:left;padding:5px 8px 5px 0;border-top:1px solid #d5ddd8;vertical-align:top}
th{font-weight:600;color:var(--ink);border-top:0}
.fine{font-size:13px;color:var(--muted)}
.fine p{margin:6px 0}
.index a{color:var(--ink);font-weight:600}
.index p{font-size:15px}
.foot{max-width:640px;margin:14px auto 0;font-size:12.5px;color:var(--muted);display:flex;gap:10px;align-items:center}
.foot a{color:inherit}
.foot svg{width:22px;height:22px;flex:none}
.means h3 .tag{display:inline-block;white-space:nowrap;vertical-align:middle;font-family:Inter,system-ui,sans-serif;letter-spacing:0}
code{white-space:nowrap;font:500 12.5px "JetBrains Mono",ui-monospace,Menlo,monospace}
@media(max-width:520px){.label{padding:20px 16px}.means{grid-template-columns:1fr}h1{font-size:34px}.count .big{font-size:44px}}
@media print{body{background:#fff;padding:0}}
`;

function labelCard({ project, rel, pkgs, own, notes, changes, generated, opinion, anchor, declared, isPrivate, hasPkgJson, ship, shipWhy, flags }) {
  const M = SHIP[ship];
  const s = summarise(pkgs);
  const all = [...pkgs.values()];
  const top = s.strictest;
  const shippedTotal = s.shipped.reduce((a, b) => a + b, 0);
  const toolsTotal = s.tools.reduce((a, b) => a + b, 0);
  const H = [];
  H.push(`<div class="kicker">Licence label</div><h1>${esc(project)}</h1>`);
  H.push(`<p class="sub">${rel && rel !== '.' ? `Folder <code>${esc(rel)}</code>. ` : ''}Made ${esc(generated)}. Based on the licence each package declares for itself.</p>`);
  H.push(`<div class="ship"><span class="pill">${esc(M.name)}</span> ${esc(M.blurb)} <span class="via">${shipWhy === 'set' ? 'Set by you.' : `A guess${shipWhy ? `, from ${esc(shipWhy)}` : ''}. If it is wrong, set it with <code>--ship</code>.`}</span></div>`);
  if (flags && flags.length) {
    H.push(`<div class="flagbox" role="alert"><h3>${flags.length === 1 ? '1 thing needs' : `${flags.length} things need`} your attention</h3><ul>${flags.map((f) => `<li><b>${esc(flagText(f, project))}</b> ${esc(flagWhy(f, ship))} <span class="via">Flagged ${esc(f.since)}.</span></li>`).join('')}</ul><p class="small">A flag stays here until its cause goes away, or you record that you have checked it. Tell your coding agent you have checked it and why, or run this tool with <code>--accept "package=why it is fine"</code>.</p></div>`);
  }
  H.push('<hr class="rule">');
  H.push(`<div class="count"><p>${esc(M.count)}</p><span class="big">${num(shippedTotal)}</span></div>`);
  if (toolsTotal) H.push(`<p class="small">Plus ${plural(toolsTotal, 'build tool')} used to make the app (dev dependencies). They are not part of what you hand out, so they are counted separately.</p>`);
  H.push(`<hr class="rule thin"><div class="kicker">Strictest condition ${ship === 'static' || ship === 'package' ? 'among these parts' : 'in your app'}</div>`);
  if (top === null) {
    H.push('<h2>Nothing on the scale yet.</h2><p>No open-source packages with a recognised licence were found.</p>');
  } else {
    const g = GROUPS[top];
    const at = all.filter((p) => p.shipped && p.group === top);
    const lics = [...new Set(at.map((p) => p.licence))].sort();
    const fams = families(at).length;
    const from = plural(at.length, 'package') + (fams < at.length ? `, which is ${plural(fams, 'library')} once operating-system builds are counted together` : '');
    H.push(`<h2>${esc(g.name)}.</h2><p>${esc(g.short)} <span class="via">Step ${top + 1} of 5, from ${from} (${esc(lics.slice(0, 4).join(', '))}${lics.length > 4 ? '…' : ''}).</span></p>`);
    const m = meaning(ship, top);
    const box = (x, i) => `<div${m.you === i ? ' class="you"' : ''}><h3>${esc(x[0])}${m.you === i ? ' <span class="tag">how you ship</span>' : ''}</h3><p>${esc(x[1])}</p></div>`;
    H.push(`<div class="means">${box(m.a, 0)}${box(m.b, 1)}</div>`);
    H.push(`<p class="small">${esc(m.note)}</p>`);
  }
  if (s.shipped[UNKNOWN]) H.push(`<div class="look"><h3>${plural(s.shipped[UNKNOWN], 'part')} could not be placed on the scale.</h3><p>The label above does not cover them. See "Needs a look" below.</p></div>`);

  H.push('<hr class="rule"><div class="kicker">Where every part sits</div>');
  const most = Math.max(1, ...s.shipped);
  for (let g = 0; g < 6; g++) {
    const n = s.shipped[g], t = s.tools[g];
    const short = g < 5 ? GROUPS[g].short : 'Read these yourself before relying on them.';
    const cls = 'row' + (n ? ' has' : ' empty') + (g === top ? ' top' : '') + (g === 5 ? ' unk' : '');
    const items = all.filter((p) => p.group === g).sort((a, b) => Number(b.shipped) - Number(a.shipped));
    const body = items.length ? packageList(items, g >= 2) : '<p class="small">None found.</p>';
    H.push(`<details class="${cls}"><summary><span class="step">${g < 5 ? g + 1 : '?'}</span><span class="rn">${esc(groupName(g))}<small>${esc(short)}</small></span><span class="num">${num(n)}${t ? `<small>+${num(t)} build</small>` : ''}</span><span class="bar"><i style="width:${((n / most) * 100).toFixed(1)}%"></i></span></summary><div class="detail">${body}</div></details>`);
  }
  H.push('<p class="small">Select a row to see the packages. "via" shows which of your own choices brought a package in.</p>');

  H.push('<hr class="rule"><div class="kicker">The minimum to do</div><ul class="todo">');
  const keep = all.filter((p) => p.shipped && p.group >= 1 && p.group <= 4);
  if (ship === 'package' && hasPkgJson && classify(declared) === UNKNOWN) H.push('<li><b>Name your own licence in package.json.</b> Until you do, tools cannot read it. See "How your own project looks to others" below.</li>');
  if (keep.length && ship === 'static') H.push(`<li><b>Keep the notices for any code that ends up in your pages.</b> ${plural(keep.length, 'part')} ask for this if their code is included. Parts that only run during the build need nothing.</li>`);
  else if (keep.length && ship === 'package') H.push('<li><b>Keep the notices for anything bundled into your published files.</b> Parts your users install separately carry their own notices.</li>');
  else if (keep.length) H.push(`<li><b>Keep the notices for ${plural(keep.length, 'package')}.</b> ${ship === 'hosted' ? 'This matters for the code that reaches browsers; what stays on your server has nothing to hand over.' : 'Ship their copyright and licence text with the app.'} Run this tool with <code>--notices</code> to collect the texts into one file.</li>`);
  const partP = all.filter((p) => p.shipped && p.group === 2);
  if (partP.length) {
    const fams = families(partP);
    const roots = [...new Set(partP.filter((p) => p.via.length).map((p) => p.via[0]))].sort();
    const where = roots.length && partP.every((p) => p.via.length)
      ? `They all come in through ${some(roots, 5)}, not something you added directly`
      : some(fams.map((f) => f.name));
    H.push(`<li><b>Leave ${plural(fams.length, 'share-changes part')} unchanged, or share your changes to them.</b> ${esc(where)}. Using them as they come is fine. Editing their own files means publishing those edits.</li>`);
  }
  for (const g of [3, 4]) {
    const gp = families(all.filter((p) => p.shipped && p.group === g)).map((f) => f.name);
    if (gp.length) H.push(`<li><b>Decide what to do about ${esc(some(gp))}.</b> ${esc(ship === 'static' || ship === 'package' ? meaning(ship, g).b[1] : g === 3 ? GROUPS[3].copies : GROUPS[4].service)}</li>`);
  }
  const unk = all.filter((p) => p.group === UNKNOWN);
  const unkShip = unk.filter((p) => p.shipped);
  if (unkShip.length) H.push(`<li><b>Read the licence of ${plural(unkShip.length, 'part')} yourself.</b> They are listed next.${ship === 'package' ? ' Your users inherit them too.' : ''}</li>`);
  if (top === null || (top === 0 && !unkShip.length)) H.push('<li><b>Nothing required.</b> Check again when your dependencies change.</li>');
  H.push('<li><b>Make the label again when your dependencies change.</b> One new package can move the strictest step.</li></ul>');

  if (unk.length) {
    H.push('<div class="look"><h3>Needs a look</h3><ul>');
    for (const p of unk.sort((a, b) => Number(b.shipped) - Number(a.shipped) || a.name.localeCompare(b.name))) {
      const why = p.licence ? `declares "${esc(p.licence)}"` : 'declares no licence';
      let extra = '';
      const lf = p.dir ? licenceFiles(p.dir) : [];
      if (lf.length) {
        extra = ` Its licence file starts: <span class="q">"${esc(firstLine(lf[0]))}"</span>`;
        const said = mentions(readText(lf[0]) || '');
        if (said.length) extra += ` Further down it mentions ${esc(said.join(', '))}.`;
      }
      if (['not installed here', 'lookup failed'].includes(p.source)) extra = ' It is not installed here, so its licence could not be read.';
      const via = p.via.length ? ` (via ${esc(p.via.join(' → '))})` : '';
      H.push(`<li><span class="pk">${esc(p.name)}</span> <span class="ver">${esc(p.version)}</span>${p.shipped ? '' : ' <span class="tag">build tool</span>'} ${why}${via}.${extra}${p.accepted ? ` <span class="seen">Checked${p.accepted.date ? ` ${esc(p.accepted.date)}` : ''}: ${esc(p.accepted.note || 'recorded as fine')}</span>` : ''}</li>`);
    }
    H.push('</ul></div>');
  }
  if (s.toolsStrictest !== null && s.toolsStrictest >= 3 && (top === null || s.toolsStrictest > top)) {
    const gp = families(all.filter((p) => !p.shipped && p.group >= 3 && p.group < 5)).map((f) => f.name);
    H.push(`<p class="small">Some build tools sit further along the scale (${esc(some(gp))}). That does not change what you ship, as long as they are not included in it.</p>`);
  }

  if (opinion) {
    H.push('<hr class="rule thin"><div class="kicker">Second opinion</div>');
    const failed = (opinion.silent ? ` It had no licence on record for ${plural(opinion.silent, 'package')}.` : '') + (opinion.failed ? ` ${plural(opinion.failed, 'lookup')} did not come back.` : '');
    if (!opinion.differ.length) {
      H.push(`<p>deps.dev, a public index run by Google, was asked about ${plural(opinion.checked, 'package')} and has none of them on a different step from the one declared.${failed}</p>`);
    } else {
      H.push(`<p>deps.dev, a public index run by Google, was asked about ${plural(opinion.checked, 'package')}. It puts ${plural(opinion.differ.length, 'package')} on a different step from the one declared. Neither side is automatically right, so read these.${failed}</p><table><tr><th>Package</th><th>Declares</th><th>deps.dev says</th></tr>`);
      for (const p of opinion.differ) {
        H.push(`<tr><td>${esc(p.name)} <span class="ver">${esc(p.version)}</span></td><td>${esc(p.licence || 'nothing')}<br><span class="via">${esc(groupName(p.group))}</span></td><td>${esc(p.second.licence)}<br><span class="via">${esc(groupName(p.second.group))}</span></td></tr>`);
      }
      H.push('</table>');
    }
  }

  if (changes) {
    H.push('<hr class="rule thin"><div class="kicker">Since the last label</div>');
    if (!changes.added.length && !changes.removed.length && !changes.moved.length) {
      H.push(`<p>No changes since ${esc(changes.when)}.</p>`);
    } else {
      const bits = [];
      if (changes.added.length) bits.push(`${changes.added.length} added`);
      if (changes.removed.length) bits.push(`${changes.removed.length} removed`);
      if (changes.moved.length) bits.push(`${changes.moved.length} changed licence`);
      const nm = (g) => (g === null || g === undefined ? 'nothing' : `"${GROUPS[g].name}"`);
      const verdict = changes.was === top ? 'The strictest step is unchanged.'
        : `<b>The strictest step moved from ${esc(nm(changes.was))} to ${esc(nm(top))}.</b>`;
      H.push(`<p>Since ${esc(changes.when)}: ${bits.join(', ')}. ${verdict}</p>`);
      if (changes.notable.length) H.push(`<p class="small">New parts at step 3 or beyond, or unknown: ${esc(some(changes.notable, 12))}</p>`);
    }
  }

  if (hasPkgJson && (declared || !isPrivate)) {
    H.push('<hr class="rule thin"><div class="kicker">How your own project looks to others</div>');
    const g = classify(declared);
    if (g !== UNKNOWN) {
      H.push(`<p>Your <code>package.json</code> declares "${esc(declared)}". Tools that read licences automatically will place your project at step ${g + 1}, ${esc(GROUPS[g].name.toLowerCase())}.</p>`);
      if (top !== null && top > g) H.push(`<p class="small">That covers your own code. Parts inside sit further along the scale, and their rules still apply to anyone you hand the whole thing to.</p>`);
    } else {
      const file = own.find((o) => /^LICEN[SC]E/i.test(path.basename(o.path)));
      const named = file ? ownLicenceNames(file.full) : [];
      H.push(`<div class="look" style="margin-top:6px"><h3>${declared ? `Your package.json declares "${esc(declared)}".` : 'Your package.json declares no licence.'}</h3><p>Tools that read licences automatically, this one included, cannot place that. ${isPrivate ? 'It only matters if you publish the package.' : 'Anyone who uses your package will find it under "needs a look", even if your licence is generous.'}${named.length ? ` Your licence file mentions ${esc(named.join(' and '))}. Naming a standard licence in <code>package.json</code> lets tools read it.` : ''}</p></div>`);
    }
  }
  if (own.length) {
    H.push('<hr class="rule thin"><div class="kicker">Licence files in your own project</div><p class="small" style="margin-bottom:6px">These cover code that lives in your folders, including anything copied in. They are not part of the count above.</p><table>');
    for (const o of own.slice(0, 12)) H.push(`<tr><td><code>${esc(o.path)}</code></td><td class="q">"${esc(o.first)}"</td></tr>`);
    H.push('</table>');
  }

  H.push('<hr class="rule"><div class="fine">' +
    '<p><b>How to read this.</b> This label sorts packages by the licence each one <i>declares</i> in its own package details. Declared licences can be wrong, missing or out of date, and a package can contain files under other licences. ' +
    (opinion ? 'The declared licences were compared with one public index, and nothing was checked against the licence texts themselves.' : 'Nothing here was checked against the actual licence texts.') + '</p>' +
    '<p><b>What it does not see.</b> Code, fonts, images, icons or snippets copied into your folders (including code an AI assistant wrote or pasted), online services your app calls, and anything installed outside the lockfiles. It counts every part that is not marked as a build tool; it does not know which of them reach the browser, the finished pages or your published files.</p>' +
    '<p><b>Not legal advice.</b> It is a plain-language starting point. If something sits at step 4 or 5, is unknown, or matters commercially, read the licence and ask a lawyer.</p>' +
    `<p>${notes.map(esc).join('<br>')}</p></div>`);

  return `<main class="label" id="${esc(anchor || 'label')}">${H.join('')}</main>`;
}

/** The whole page: one label per app folder, with a short index when there is more than one. */
function page(project, labels, leftovers) {
  let index = '';
  if (labels.length > 1) {
    const rows = labels.map((l) => {
      const s = summarise(l.pkgs);
      const sum = (a) => a.reduce((x, y) => x + y, 0);
      return `<tr><td><a href="#${esc(l.anchor)}">${esc(l.project)}</a><br><span class="via">${l.rel === '.' ? 'project root' : `<code>${esc(l.rel)}</code>`}</span></td><td>${esc(SHIP[l.ship].name)}</td><td>${num(sum(s.shipped))}</td><td>${esc(s.strictest === null ? '–' : `${s.strictest + 1}. ${GROUPS[s.strictest].name}`)}</td><td>${s.shipped[UNKNOWN] ? num(s.shipped[UNKNOWN]) : '–'}</td><td>${l.flags && l.flags.length ? `<b>${l.flags.length}</b>` : '–'}</td></tr>`;
    }).join('');
    index = `<section class="label index"><div class="kicker">Licence labels</div><h1>${esc(project)}</h1><p>This project holds ${plural(labels.length, 'separate app')}. Each gets its own label, because a licence applies to the software that contains the code. What is inside your website does not change the rules for the product you sell, and the other way round.</p><table><tr><th>App</th><th>Shipped as</th><th>Parts</th><th>Strictest step</th><th>Needs a look</th><th>Flags</th></tr>${rows}</table>${leftovers.length ? `<p class="small">${leftovers.map(esc).join('<br>')}</p>` : ''}</section>`;
  }
  const logo = '<svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><circle cx="24" cy="24" r="24" fill="#082F20"/><g transform="translate(24 24) scale(0.84) translate(-24 -24)"><path d="M14 13V16.5" stroke="#B6A9FF" stroke-width="6.2" stroke-linecap="round"/><path d="M14 25A10 10 0 0 0 34 25V13" stroke="#FFFFFF" stroke-width="6.2" stroke-linecap="round"/><circle cx="24" cy="24.8" r="4.4" fill="#68DBAA"/></g></svg>';
  return `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Licence label: ${esc(project)}</title><style>${CSS}</style></head><body>${index}${labels.map(labelCard).join('')}<div class="foot">${logo}<span>Made with <a href="https://github.com/Justusability/license-label">Licence label</a> by Justusability. No head scratching. Just usability.</span></div></body></html>`;
}

function markdownSummary({ project, rel, pkgs, changes, opinion, ship, flags }) {
  const s = summarise(pkgs);
  const top = s.strictest;
  const L = [`### Licence label: ${project}${rel && rel !== '.' ? ` (\`${rel}\`)` : ''}`, ''];
  L.push(`Shipped as: ${SHIP[ship].name.toLowerCase()}.`, '');
  if (flags && flags.length) L.push('**Needs your attention**', '', ...flags.map((f) => `- ${f.isNew ? '**New.** ' : ''}${flagText(f, project)} ${flagWhy(f, ship)}`), '');
  L.push(top === null ? 'Nothing on the scale yet.' : `**Strictest step in the app: ${top + 1} of 5, ${GROUPS[top].name}.** ${GROUPS[top].short}`, '');
  if (changes && changes.was !== top && changes.was !== undefined) {
    const nm = (g) => (g === null ? 'nothing' : `"${GROUPS[g].name}"`);
    L.push(`**The strictest step moved from ${nm(changes.was)} to ${nm(top)}.**`, '');
  }
  L.push('| Step | In the app | Build tools |', '|---|---|---|');
  for (let g = 0; g < 6; g++) L.push(`| ${g < 5 ? g + 1 + ' ' : ''}${groupName(g)} | ${s.shipped[g]} | ${s.tools[g]} |`);
  const unk = [...pkgs.values()].filter((p) => p.shipped && p.group === UNKNOWN);
  if (unk.length) L.push('', `**Needs a look:** ${some(unk.map((p) => `\`${p.name}\` (${p.licence || 'no licence declared'})`), 10)}`);
  if (changes && changes.notable.length) L.push('', `**New at step 3 or beyond, or unknown:** ${some(changes.notable.map((k) => '`' + k + '`'), 10)}`);
  if (opinion && opinion.differ.length) L.push('', `**deps.dev disagrees on:** ${some(opinion.differ.map((p) => `\`${p.name}\``), 10)}`);
  L.push('', '_Based on declared licences, which can be wrong. Not legal advice._', '');
  return L.join('\n');
}

function writeNotices(file, pkgs) {
  const out = ['THIRD-PARTY NOTICES', '',
    'This app includes the open-source packages below. Each is listed with the licence it declares',
    'and the licence text found in the installed package.', ''];
  let missing = 0;
  for (const p of [...pkgs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!p.shipped) continue;
    out.push('='.repeat(78), `${p.name} ${p.version}  (${p.licence || 'no licence declared'})`, '='.repeat(78));
    const files = p.dir ? licenceFiles(p.dir).concat(licenceFiles(path.join(p.dir, 'licenses'))) : [];
    if (!files.length) { missing++; out.push('[No licence file found in the installed package. Add it by hand.]', ''); }
    for (const f of files) { const t = readText(f); if (t) out.push(t.trim(), ''); }
  }
  fs.writeFileSync(file, out.join('\n'));
  return missing;
}

// ---------------------------------------------------------------- flags
// A flag is raised only for a change a person should hear about, and it stays open until
// the cause goes away or the person records that they have checked it.
const nameOfKey = (k) => k.slice(k.indexOf(':') + 1, k.lastIndexOf('@'));
const stepName = (g) => (g === null || g === undefined ? 'nothing on the scale' : g < 5 ? `step ${g + 1} (${GROUPS[g].name.toLowerCase()})` : 'off the scale');

function findFlags(l, prevL, today) {
  const flags = [];
  const live = [...l.pkgs.entries()].filter(([, p]) => p.shipped && !p.accepted);
  const onScale = live.map(([, p]) => p.group).filter((g) => g < UNKNOWN);
  const top = onScale.length ? Math.max(...onScale) : null; // parts you have recorded as checked do not count
  if (prevL && prevL.packages) {
    const old = prevL.packages;
    const oldByName = new Map();
    for (const [k, o] of Object.entries(old)) {
      const n = nameOfKey(k);
      if (!oldByName.has(n) || o.group > oldByName.get(n).group) oldByName.set(n, o);
    }
    const found = { relicensed: [], unknown: [], strong: [] };
    for (const [k, p] of live) {
      const before = old[k] || oldByName.get(p.name);
      if (before && before.licence !== p.licence && p.group >= 2 && (p.group > before.group || p.group >= 3)) found.relicensed.push({ ...p, was: before.licence });
      else if (before && before.shipped) continue; // you already had it, on the same terms
      else if (p.group === UNKNOWN) found.unknown.push(p);
      else if (p.group >= 3) found.strong.push(p);
    }
    for (const kind of Object.keys(found)) {
      for (const f of families(found[kind])) {
        const p = f.members.find((m) => m.via.length) || f.members[0];
        flags.push({ id: `${kind}:${f.name}`, kind, pkg: f.name, names: [...new Set(f.members.map((m) => m.name))], version: p.version,
          licence: p.licence, group: p.group, via: p.via, was: p.was, since: today, isNew: true });
      }
    }
    const was = prevL.strictest === undefined ? null : prevL.strictest;
    if (top !== null && top >= 2 && top > (was === null ? -1 : was)) {
      const because = families(live.map(([, p]) => p).filter((p) => p.group === top)).map((f) => f.name);
      flags.push({ id: `step:${top}`, kind: 'step', from: was, to: top, group: top, because, since: today, isNew: true });
      // one flag per cause: the step moving already names the part that moved it
      for (let i = flags.length - 1; i >= 0; i--) if (flags[i].kind === 'strong' && because.includes(flags[i].pkg)) flags.splice(i, 1);
    }
  }
  const ids = new Set(flags.map((f) => f.id));
  for (const f of (prevL && prevL.flags) || []) { // still open from earlier runs
    if (ids.has(f.id)) continue;
    const alive = f.kind === 'step' ? top !== null && top >= f.to
      : live.some(([, p]) => (f.names || [f.pkg]).includes(p.name) && (f.kind === 'unknown' ? p.group === UNKNOWN : f.kind === 'strong' ? p.group >= 3 : true));
    if (alive) flags.push({ ...f, isNew: false });
  }
  return flags;
}

function flagText(f, project) {
  const via = f.via && f.via.length ? ` (brought in by ${f.via.join(' → ')})` : '';
  if (f.kind === 'step') return `The strictest licence in ${project} moved from ${stepName(f.from)} to ${stepName(f.to)}${f.because && f.because.length ? `, because of ${some(f.because, 3)}` : ''}.`;
  if (f.kind === 'relicensed') return `${f.pkg} changed its licence: it declared "${f.was || 'nothing'}", and version ${f.version} declares "${f.licence || 'nothing'}", which is ${stepName(f.group)}${via}.`;
  if (f.kind === 'unknown') return `A new part could not be placed on the scale: ${f.pkg} declares ${f.licence ? `"${f.licence}"` : 'no licence'}${via}.`;
  return `A new part sits at ${stepName(f.group)}: ${f.pkg} declares "${f.licence}"${via}.`;
}

function flagWhy(f, ship) {
  if (f.group === UNKNOWN) return 'It is not a standard open-source licence, so read its licence file before you rely on it.';
  if (ship === 'static' || ship === 'package') return meaning(ship, f.group).b[1];
  return ship === 'copies' ? GROUPS[f.group].copies : GROUPS[f.group].service;
}

/** The message for a person, in plain words: what changed, why it matters, what they can do. */
function flagMessage(open, labelPath, root) {
  const lines = ['Licence label: something changed in this project that the person should know about.', ''];
  for (const { l, f } of open) lines.push(`- ${flagText(f, l.project)} ${flagWhy(f, l.ship)}`);
  lines.push('', 'What they can do: replace the part, read its licence, or say that they have checked it and it is fine.',
    'If they say they have checked it, this records their reason so it stops being flagged (the command is for the agent to run, not the person):',
    `  node "${process.argv[1]}" "${root}" -o "${labelPath}" --accept "package-name=their reason"`, '', `The full label is at ${labelPath}.`);
  return lines.join('\n');
}

/** Claude Code Stop-hook output: a short warning the person sees, and context the agent
 *  receives so that it tells the person in its reply. Printed once per new flag. */
function hookSpeak(fresh, labelPath, root) {
  const first = flagText(fresh[0].f, fresh[0].l.project);
  process.stdout.write(JSON.stringify({
    systemMessage: `Licence label: ${fresh.length === 1 ? '1 change needs' : `${fresh.length} changes need`} your attention. ${first}${fresh.length > 1 ? ' (and more)' : ''}`,
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: flagMessage(fresh, labelPath, root) + '\n\nThe person has not been told yet. They would want to hear this now, in two or three plain sentences, with the suggested next step. This is based on declared licences and is not legal advice.',
    },
  }) + '\n');
  return 0;
}

// ---------------------------------------------------------------- command line
const HELP = `license-label [project folder] [options]

Writes a plain-language licence label (HTML) for the open-source parts in a project.

  -o, --out FILE       HTML file to write (default: license-label.html)
      --name NAME      project name shown on the label
      --notices FILE   also collect the licence texts of the app's packages into one file
      --summary FILE   also write a short Markdown summary (for pull-request comments)
      --ship HOW       how it is shipped: hosted, copies, static or package.
                       Use folder=HOW to set one folder (repeatable). Guessed if not set.
      --verify         ask deps.dev for a second opinion on each package in the app (online)
      --online         look up Python licences on pypi.org when packages are not installed
      --fail-above N   exit with code 2 if the app goes beyond step N (1-5) or has unknowns
      --accept "NAME=WHY"  record that you have checked a package and it is fine,
                       so it stops being flagged (saved in license-label.config.json)
      --seen           clear the open flags
      --hook           for agent hooks: when something new is flagged, hand the agent
                       a message to pass on to the person
      --if-changed     only refresh: do nothing unless a label already exists here
                       and a lockfile changed since it was made (for hooks)
  -h, --help           show this help

Based on declared licences, which can be wrong. Not legal advice.`;

function parseArgs(argv) {
  const a = { project: '.', out: 'license-label.html', ship: {}, accept: [] };
  const takes = { '-o': 'out', '--out': 'out', '--name': 'name', '--notices': 'notices', '--summary': 'summary', '--fail-above': 'failAbove' };
  const flags = { '--seen': 'seen', '--hook': 'hook', '--verify': 'verify', '--online': 'online', '--if-changed': 'ifChanged', '-h': 'help', '--help': 'help' };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--ship') {
      const v = argv[++i] || '';
      const [k, how] = v.includes('=') ? [v.slice(0, v.lastIndexOf('=')), v.slice(v.lastIndexOf('=') + 1)] : ['*', v];
      if (!SHIP[how]) throw new Error(`--ship takes one of: ${Object.keys(SHIP).join(', ')}`);
      a.ship[k.replace(/\/+$/, '') || '.'] = how;
    } else if (t === '--accept') {
      const v = argv[++i] || '';
      if (!v || v.startsWith('-')) throw new Error('--accept needs "package=why it is fine"');
      const eq = v.indexOf('=');
      a.accept.push({ package: (eq < 0 ? v : v.slice(0, eq)).trim(), note: eq < 0 ? '' : v.slice(eq + 1).trim() });
    } else if (takes[t]) {
      if (i + 1 >= argv.length) throw new Error(`${t} needs a value`);
      a[takes[t]] = argv[++i];
    } else if (flags[t]) a[flags[t]] = true;
    else if (t.startsWith('-')) throw new Error(`Unknown option ${t}`);
    else a.project = t;
  }
  if (a.failAbove !== undefined) {
    a.failAbove = Number(a.failAbove);
    if (!Number.isInteger(a.failAbove) || a.failAbove < 1 || a.failAbove > 5) throw new Error('--fail-above takes a step from 1 to 5');
  }
  return a;
}

async function main(argv) {
  let a;
  try { a = parseArgs(argv); } catch (e) { console.error(e.message + '\n\n' + HELP); return 1; }
  if (a.help) { console.log(HELP); return 0; }
  const root = path.resolve(a.project);
  const log = console.log;
  if (a.hook) console.log = () => {}; // a hook's output must be only the message for the agent
  if (!isDir(root)) { console.error(`Not a folder: ${root}`); return 1; }
  const { parts, own } = findParts(root);
  const dataPath = a.out.replace(/\.html?$/i, '') + '.json';
  if (a.ifChanged && !fs.existsSync(dataPath)) return 0;
  if (a.ifChanged) {
    const last = fs.statSync(dataPath).mtimeMs;
    let newest = 0;
    for (const p of parts) for (const f of p.files) if (MANIFEST.test(f)) newest = Math.max(newest, fs.statSync(path.join(p.dir, f)).mtimeMs);
    if (newest <= last) return 0;
  }
  if (!parts.length) {
    console.error('No dependency manifests found (looked for package.json, package-lock.json, yarn.lock, pnpm-lock.yaml, requirements.txt, pyproject.toml, uv.lock, poetry.lock).');
    return 1;
  }
  const generated = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
  const project = a.name || (readJson(path.join(root, 'package.json')) || {}).name || path.basename(root);
  const sum = (arr) => arr.reduce((x, y) => x + y, 0);
  const config = readJson(path.join(root, 'license-label.config.json')) || readJson(path.join(root, 'licence-label.config.json')) || {};

  // One label per folder that has its own dependencies: each is a separate piece of software.
  const labels = [];
  const leftovers = [];
  for (const part of parts) {
    const pkgs = new Map();
    const notes = [];
    if (part.npm) readNpm(part, pkgs, notes);
    if (part.py) await readPython(part, pkgs, notes, a.online);
    if (!pkgs.size) { leftovers.push(...notes); continue; }
    let opinion = null;
    if (a.verify) {
      opinion = await secondOpinion(pkgs);
      notes.push(`deps.dev was asked about ${opinion.checked + opinion.failed} packages in the app (${opinion.failed} did not come back).`);
    }
    const name = ((config.apps && config.apps[part.rel]) || {}).name || (part.rel === '.' ? project : (readJson(path.join(part.dir, 'package.json')) || {}).name || part.rel);
    const pj = readJson(path.join(part.dir, 'package.json'));
    const cfg = (config.apps && config.apps[part.rel]) || {};
    const set = a.ship[part.rel] || a.ship['*'] || (SHIP[cfg.ship] ? cfg.ship : null);
    const guess = guessShip(pj);
    labels.push({ ship: set || guess.ship, shipWhy: set ? 'set' : guess.why, rel: part.rel, project: name, pkgs, notes, opinion, generated, own: [],
      hasPkgJson: !!pj, declared: pj ? pkgJsonLicence(pj) : '', isPrivate: !!(pj && pj.private),
      anchor: 'label-' + (part.rel === '.' ? 'root' : part.rel.replace(/[^A-Za-z0-9]+/g, '-')) });
  }
  if (!labels.length) {
    console.error('Found dependency manifests, but no packages could be resolved.\n' + leftovers.join('\n'));
    return 1;
  }
  for (const o of own) { // a licence file belongs to the nearest app above it; one above them all applies to all
    const holders = labels.filter((l) => l.rel === '.' || o.path.startsWith(l.rel + path.sep))
      .sort((x, y) => y.rel.length - x.rel.length);
    for (const l of holders.length ? [holders[0]] : labels) l.own.push(o);
  }

  // "I've seen this": packages the person has checked and recorded as fine.
  const accepted = Array.isArray(config.accepted) ? config.accepted : [];
  if (a.accept.length) {
    for (const want of a.accept) {
      const hit = labels.flatMap((l) => [...l.pkgs.values()]).find((p) => p.name === want.package);
      if (!hit) { console.error(`--accept: no package named "${want.package}" in this project.`); return 1; }
      const entry = { package: hit.name, licence: hit.licence, note: want.note, date: new Date().toISOString().slice(0, 10) };
      const i = accepted.findIndex((x) => x.package === hit.name);
      if (i >= 0) accepted[i] = entry; else accepted.push(entry);
    }
    config.accepted = accepted;
    const configPath = fs.existsSync(path.join(root, 'licence-label.config.json')) && !fs.existsSync(path.join(root, 'license-label.config.json'))
      ? path.join(root, 'licence-label.config.json') : path.join(root, 'license-label.config.json');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    console.log(`Recorded in ${path.relative(process.cwd(), configPath) || configPath}: ${a.accept.map((x) => x.package).join(', ')}`);
  }
  for (const l of labels) {
    for (const p of l.pkgs.values()) p.accepted = accepted.find((x) => x.package === p.name && (!x.licence || x.licence === p.licence)) || null;
  }

  const prev = readJson(dataPath);
  const prevLabels = (prev && prev.labels) || {};
  const fresh = [];
  const data = { project, generated, labels: {} };
  let fail = false, anyMoved = false, notable = 0, worst = null, unknownTotal = 0;
  for (const l of labels) {
    const s = summarise(l.pkgs);
    const top = s.strictest;
    const now = {};
    for (const [k, p] of l.pkgs) now[k] = { licence: p.licence, group: p.group, shipped: p.shipped };
    const old = prevLabels[l.rel] && prevLabels[l.rel].packages;
    if (old) {
      const added = Object.keys(now).filter((k) => !(k in old)).sort();
      l.changes = {
        when: prev.generated || 'the last run', was: prevLabels[l.rel].strictest === undefined ? null : prevLabels[l.rel].strictest, added,
        removed: Object.keys(old).filter((k) => !(k in now)).sort(),
        moved: Object.keys(now).filter((k) => k in old && now[k].licence !== old[k].licence).sort(),
        notable: added.filter((k) => now[k].shipped && now[k].group >= 2),
      };
    } else l.changes = null;
    l.flags = a.seen ? [] : findFlags(l, prevLabels[l.rel], generated);
    for (const f of l.flags) if (f.isNew) fresh.push({ l, f });
    data.labels[l.rel] = { name: l.project, ship: l.ship, strictest: top, counts: { in_app: s.shipped, build_tools: s.tools },
      flags: l.flags.map(({ isNew, ...f }) => f), packages: now };
    const moved = !!l.changes && l.changes.was !== top;
    anyMoved = anyMoved || moved;
    notable += l.changes ? l.changes.notable.length : 0;
    unknownTotal += s.shipped[UNKNOWN];
    if (top !== null && (worst === null || top > worst)) worst = top;
    const unchecked = [...l.pkgs.values()].filter((p) => p.shipped && !p.accepted);
    const topUnchecked = Math.max(-1, ...unchecked.filter((p) => p.group < UNKNOWN).map((p) => p.group));
    if (a.failAbove !== undefined && (topUnchecked + 1 > a.failAbove || unchecked.some((p) => p.group === UNKNOWN))) fail = true;

    console.log(`Licence label for ${l.project}${l.rel === '.' ? '' : ` (${l.rel})`}: ${sum(s.shipped)} parts in the app, ${sum(s.tools)} build tools.`);
    console.log(`Shipped as: ${SHIP[l.ship].name.toLowerCase()}${l.shipWhy === 'set' ? '' : ' (a guess; set it with --ship)'}`);
    console.log('Strictest step in the app: ' + (top === null ? 'none' : `${top + 1} of 5, ${GROUPS[top].name}`));
    for (let g = 0; g < 6; g++) console.log(`  ${groupName(g).padEnd(28)} ${String(s.shipped[g]).padStart(5)} in app  ${String(s.tools[g]).padStart(5)} build tools`);
    if (l.changes && (l.changes.added.length || l.changes.removed.length || l.changes.moved.length)) {
      console.log(`Since ${l.changes.when}: +${l.changes.added.length} -${l.changes.removed.length} ~${l.changes.moved.length}` + (moved ? '  STRICTEST STEP CHANGED' : ''));
    }
    for (const f of l.flags) console.log(`${f.isNew ? 'FLAG (new)' : 'FLAG (open)'}  ${flagText(f, l.project)}`);
    if (l.opinion) console.log(`Second opinion (deps.dev): ${l.opinion.checked} checked, ${l.opinion.differ.length} on a different step, ${l.opinion.silent} with no licence on record, ${l.opinion.failed} failed.`);
    console.log('');
  }
  for (const n of leftovers) console.log(n);
  fs.writeFileSync(a.out, page(project, labels, leftovers));
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 1));
  if (a.summary) fs.writeFileSync(a.summary, labels.map(markdownSummary).join('\n'));
  if (a.notices) {
    const all = new Map();
    for (const l of labels) for (const [k, p] of l.pkgs) if (p.shipped && !all.has(k)) all.set(k, p);
    const missing = writeNotices(a.notices, all);
    console.log(`Notices written to ${a.notices}` + (missing ? ` (${missing} packages had no licence file to copy)` : ''));
  }
  console.log(`${labels.length > 1 ? `${labels.length} labels` : 'Label'} written to ${a.out}`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT,
      `strictest=${worst === null ? 0 : worst + 1}\nunknown=${unknownTotal}\nmoved=${anyMoved}\nnotable=${notable}\nspeak=${fresh.length > 0}\nflags=${labels.reduce((n, l) => n + l.flags.length, 0)}\n`);
  }
  if (a.hook && fresh.length) { console.log = log; return hookSpeak(fresh, a.out, root); }
  console.log = log;
  return fail ? 2 : 0;
}

module.exports = { classify, families, mentions, guessShip, summarise, main, GROUPS, UNKNOWN };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; },
    (e) => { console.error(e && e.stack ? e.stack : e); process.exitCode = 1; });
}
