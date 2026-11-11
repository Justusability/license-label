'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { classify, families, guessShip } = require('../skills/license-label/scripts/license-label.js');

const BIN = path.join(__dirname, '..', 'skills', 'license-label', 'scripts', 'license-label.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'license-label-'));
const write = (dir, rel, content) => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
};
const run = (dir, ...args) => spawnSync('node', [BIN, '.', ...args], { cwd: dir, encoding: 'utf8' });

test('classify sorts licences onto the scale', () => {
  const cases = [
    ['MIT', 1], ['(MIT OR GPL-3.0-only)', 1], ['GPL-2.0-or-later WITH Classpath-exception-2.0', 3],
    ['AGPL-3.0-only', 4], ['MIT AND LGPL-3.0-or-later', 2], ['SEE LICENSE IN LICENSE', 5], ['UNLICENSED', 5],
    ['', 5], [undefined, 5], ['Apache Software License', 1], ['0BSD', 0], ['BUSL-1.1', 5], ['Weird-1.0', 5],
    ['GNU Affero General Public License v3', 4], ['MPL-2.0', 2], ['(MIT AND (GPL-2.0 OR BSD-3-Clause))', 1],
    ['Unlicense', 0], ['MIT OR', 1], ['SSPL-1.0', 5],
  ];
  for (const [lic, want] of cases) assert.strictEqual(classify(lic), want, String(lic));
});

test('operating-system builds collapse into one library', () => {
  const mk = (name) => ({ name, version: '1.0.0', via: [], shipped: true });
  const f = families([mk('@img/sharp-libvips-linux-x64'), mk('@img/sharp-libvips-darwin-arm64'), mk('left-pad'), mk('foo-linux')]);
  assert.deepStrictEqual(f.map((x) => [x.name, x.builds]), [['@img/sharp-libvips-*', 2], ['foo-linux', 1], ['left-pad', 1]]);
});

test('npm lockfile: build tools apart, chains, changes and --fail-above', () => {
  const d = tmp();
  write(d, 'package.json', { name: 'demo-app', dependencies: { a: '1.0.0' }, devDependencies: { t: '1.0.0' } });
  const lock = { lockfileVersion: 3, packages: {
    '': { name: 'demo-app', dependencies: { a: '1.0.0' }, devDependencies: { t: '1.0.0' } },
    'node_modules/a': { version: '1.0.0', license: 'MIT', dependencies: { b: '2.0.0' } },
    'node_modules/b': { version: '2.0.0', license: '(MIT OR GPL-3.0-only)' },
    'node_modules/t': { version: '1.0.0', license: 'GPL-3.0-only', dev: true },
  } };
  write(d, 'package-lock.json', lock);
  let r = run(d, '--fail-above', '3');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 parts in the app, 1 build tools/);
  assert.match(r.stdout, /Strictest step in the app: 2 of 5/);
  assert.match(fs.readFileSync(path.join(d, 'license-label.html'), 'utf8'), /Some build tools sit further along the scale \(t\)/);

  lock.packages['node_modules/c'] = { version: '3.0.0', license: 'AGPL-3.0-only' };
  lock.packages['node_modules/a'].dependencies.c = '3.0.0';
  write(d, 'package-lock.json', lock);
  r = run(d, '--fail-above', '3', '--summary', 'summary.md');
  assert.strictEqual(r.status, 2);
  assert.match(r.stdout, /STRICTEST STEP CHANGED/);
  const html = fs.readFileSync(path.join(d, 'license-label.html'), 'utf8');
  assert.match(html, /moved from &quot;Keep the notice&quot; to &quot;Share it even when hosted&quot;/);
  assert.match(html, /via a</);
  assert.match(fs.readFileSync(path.join(d, 'summary.md'), 'utf8'), /npm:c@3\.0\.0/);
});

test('--if-changed stays quiet until a lockfile changes', () => {
  const d = tmp();
  write(d, 'package.json', { name: 'x', dependencies: { a: '1' } });
  write(d, 'package-lock.json', { lockfileVersion: 3, packages: { '': {}, 'node_modules/a': { version: '1.0.0', license: 'MIT' } } });
  assert.strictEqual(run(d, '--if-changed').stdout, ''); // no label yet: a hook must not create one
  assert.ok(!fs.existsSync(path.join(d, 'license-label.html')));
  assert.match(run(d).stdout, /Label written/);
  assert.strictEqual(run(d, '--if-changed').stdout, '');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(d, 'package-lock.json'), later, later);
  assert.match(run(d, '--if-changed').stdout, /Label written/);
});

test('no npm lockfile: follows package.json through node_modules (pnpm-style links too)', () => {
  const d = tmp();
  write(d, 'package.json', { name: 'y', dependencies: { a: '1' }, devDependencies: { t: '1' } });
  write(d, 'yarn.lock', '# yarn lockfile v1\n');
  write(d, 'node_modules/.pnpm/a@1.0.0/node_modules/a/package.json', { name: 'a', version: '1.0.0', license: 'MIT', dependencies: { b: '1' } });
  write(d, 'node_modules/.pnpm/a@1.0.0/node_modules/b/package.json', { name: 'b', version: '1.0.0', license: 'SEE LICENSE IN LICENSE' });
  write(d, 'node_modules/.pnpm/a@1.0.0/node_modules/b/LICENSE', 'Commercial licence\nNeeds a subscription. Client-side code is AGPLv3.\n');
  fs.symlinkSync(path.join(d, 'node_modules/.pnpm/a@1.0.0/node_modules/a'), path.join(d, 'node_modules/a'));
  write(d, 'node_modules/t/package.json', { name: 't', version: '1.0.0', license: 'ISC' });
  const r = run(d, '--notices', 'N.txt');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 parts in the app, 1 build tools/);
  const html = fs.readFileSync(path.join(d, 'license-label.html'), 'utf8');
  assert.match(html, /Its licence file starts: <span class="q">"Commercial licence"/);
  assert.match(html, /Further down it mentions the AGPL \(step 5\), a subscription\./);
  assert.match(fs.readFileSync(path.join(d, 'N.txt'), 'utf8'), /Commercial licence/);
});

test('python: reads requirements and an installed environment', () => {
  const d = tmp();
  write(d, 'requirements.txt', 'requests==2.31.0\nflask\n# comment\n-r other.txt\n');
  write(d, '.venv/lib/python3.12/site-packages/requests-2.31.0.dist-info/METADATA',
    'Metadata-Version: 2.1\nName: requests\nVersion: 2.31.0\nLicense: Apache 2.0\nClassifier: License :: OSI Approved :: Apache Software License\n\nbody\n');
  write(d, '.venv/lib/python3.12/site-packages/certifi-2024.1.1.dist-info/METADATA',
    'Name: certifi\nVersion: 2024.1.1\nLicense-Expression: MPL-2.0\n\n');
  const r = run(d);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /Strictest step in the app: 3 of 5/);
  const data = JSON.parse(fs.readFileSync(path.join(d, 'license-label.json'), 'utf8'));
  assert.strictEqual(data.labels['.'].packages['pypi:requests@2.31.0'].group, 1);
  assert.strictEqual(data.labels['.'].packages['pypi:certifi@2024.1.1'].group, 2);
  assert.strictEqual(data.labels['.'].packages['pypi:flask@?'].group, 5);
});

test('each app folder gets its own label', () => {
  const d = tmp();
  write(d, 'package.json', { name: 'product', license: 'SEE LICENSE IN LICENSE', dependencies: { a: '1' }, devDependencies: { shared: '1' } });
  write(d, 'package-lock.json', { lockfileVersion: 3, packages: { '': {},
    'node_modules/a': { version: '1.0.0', license: 'MIT' },
    'node_modules/shared': { version: '1.0.0', license: 'MPL-2.0', dev: true } } });
  write(d, 'LICENSE', 'MIT License\nand docs under CC0\n');
  write(d, 'THIRD_PARTY_LICENSES.md', '# Third-Party Licenses\n');
  write(d, 'website/package.json', { name: 'site', dependencies: { shared: '1', paid: '1' } });
  write(d, 'website/package-lock.json', { lockfileVersion: 3, packages: { '': {},
    'node_modules/shared': { version: '1.0.0', license: 'MPL-2.0' },
    'node_modules/paid': { version: '1.0.0', license: 'SEE LICENSE IN LICENSE' } } });
  write(d, 'empty/package.json', { name: 'empty' });
  write(d, 'empty/yarn.lock', '');
  const r = run(d, '--fail-above', '3', '--summary', 's.md');
  assert.strictEqual(r.status, 2); // the website has an unknown
  assert.match(r.stdout, /Licence label for product: 1 parts in the app, 1 build tools\.\nShipped as: [^\n]+\nStrictest step in the app: 2 of 5/);
  assert.match(r.stdout, /Licence label for site \(website\): 2 parts in the app, 0 build tools\.\nShipped as: [^\n]+\nStrictest step in the app: 3 of 5/);
  assert.match(r.stdout, /2 labels written/);
  const data = JSON.parse(fs.readFileSync(path.join(d, 'license-label.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(data.labels), ['.', 'website']);
  assert.strictEqual(data.labels['.'].packages['npm:shared@1.0.0'].shipped, false);
  assert.strictEqual(data.labels.website.packages['npm:shared@1.0.0'].shipped, true);
  const html = fs.readFileSync(path.join(d, 'license-label.html'), 'utf8');
  assert.match(html, /This project holds 2 separate apps/);
  assert.match(html, /Your licence file mentions MIT and CC0-1\.0/);
  assert.match(html, /THIRD_PARTY_LICENSES\.md/);
  assert.strictEqual((html.match(/<main class="label"/g) || []).length, 2);
  assert.match(fs.readFileSync(path.join(d, 's.md'), 'utf8'), /### Licence label: site \(`website`\)/);
});

test('guesses how a folder is shipped', () => {
  assert.strictEqual(guessShip({ dependencies: { next: '1' } }).ship, 'hosted');
  assert.strictEqual(guessShip({ dependencies: { astro: '1' } }).ship, 'static');
  assert.strictEqual(guessShip({ dependencies: { astro: '1', '@astrojs/node': '1' } }).ship, 'hosted');
  assert.strictEqual(guessShip({ name: 'x', bin: { x: 'x.js' }, dependencies: { marked: '1' } }).ship, 'package');
  assert.strictEqual(guessShip({ private: true, main: 'i.js' }).ship, 'hosted');
  assert.strictEqual(guessShip({ devDependencies: { electron: '1' } }).ship, 'copies');
  assert.strictEqual(guessShip(null).ship, 'hosted');
});

test('--ship and the config file change the wording', () => {
  const d = tmp();
  write(d, 'package.json', { name: 'starter-name', dependencies: { astro: '1' } });
  write(d, 'package-lock.json', { lockfileVersion: 3, packages: { '': {}, 'node_modules/astro': { version: '1.0.0', license: 'MIT' } } });
  write(d, 'lib/package.json', { name: 'lib', files: ['dist'], license: 'MIT', dependencies: { g: '1' } });
  write(d, 'lib/package-lock.json', { lockfileVersion: 3, packages: { '': {}, 'node_modules/g': { version: '1.0.0', license: 'GPL-3.0-only' } } });
  let r = run(d);
  assert.match(r.stdout, /Shipped as: static site \(a guess/);
  assert.match(r.stdout, /Shipped as: published package \(a guess/);
  let html = fs.readFileSync(path.join(d, 'license-label.html'), 'utf8');
  assert.match(html, /What visitors receive/);
  assert.match(html, /Many will not be able to use your package in software they hand out/);
  assert.match(html, /A guess, from astro/);

  write(d, 'license-label.config.json', { apps: { '.': { ship: 'hosted', name: 'My Site' } } });
  r = run(d, '--ship', 'lib=copies');
  assert.match(r.stdout, /Licence label for My Site: /);
  assert.match(r.stdout, /Shipped as: hosted app\n/);
  assert.match(r.stdout, /Shipped as: app people download or install\n/);
  html = fs.readFileSync(path.join(d, 'license-label.html'), 'utf8');
  assert.match(html, /Set by you\./);
  assert.strictEqual(spawnSync('node', [BIN, '--ship', 'sideways']).status, 1);
});

test('flags: raised once, stay open, and stop when the person records a check', () => {
  const d = tmp();
  const lock = { lockfileVersion: 3, packages: { '': { dependencies: { a: '1' } },
    'node_modules/a': { version: '1.0.0', license: 'MIT', dependencies: { b: '1' } },
    'node_modules/b': { version: '1.0.0', license: 'ISC' } } };
  write(d, 'package.json', { name: 'app', private: true, dependencies: { a: '1', next: '1' } });
  write(d, 'package-lock.json', lock);
  let r = run(d);
  assert.strictEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /FLAG/); // a first label has nothing to compare with

  // an agent adds an AGPL part and a commercial one; b is relicensed in a new version
  lock.packages['node_modules/c'] = { version: '3.0.0', license: 'AGPL-3.0-only' };
  lock.packages['node_modules/paid'] = { version: '1.0.0', license: 'SEE LICENSE IN LICENSE' };
  lock.packages['node_modules/b'] = { version: '2.0.0', license: 'BUSL-1.1' };
  lock.packages['node_modules/a'].dependencies.c = '3';
  write(d, 'package-lock.json', lock);
  r = run(d, '--hook');
  assert.strictEqual(r.status, 0);
  const out = JSON.parse(r.stdout); // only the hook message, nothing else
  assert.match(out.systemMessage, /Licence label: 3 changes need your attention/);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'Stop');
  const said = out.hookSpecificOutput.additionalContext;
  assert.match(said, /something changed in this project that the person should know about/);
  assert.match(said, /moved from step 2 \(keep the notice\) to step 5 \(share it even when hosted\), because of c/);
  assert.doesNotMatch(said, /A new part sits at step 5/); // the step flag already names c
  assert.match(said, /A new part could not be placed on the scale: paid declares "SEE LICENSE IN LICENSE"/);
  assert.match(said, /b changed its licence: it declared "ISC", and version 2.0.0 declares "BUSL-1.1"/);
  let html = fs.readFileSync(path.join(d, 'license-label.html'), 'utf8');
  assert.match(html, /class="flagbox" role="alert"><h3>3 things need your attention/);

  r = run(d, '--hook'); // nothing new: stay quiet, but the flags are still open
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout + r.stderr, '');
  assert.strictEqual((run(d).stdout.match(/FLAG \(open\)/g) || []).length, 3);
  assert.strictEqual(run(d, '--fail-above', '3').status, 2);

  r = run(d, '--accept', 'c=only used in our own test rig', '--accept', 'paid=we have a subscription', '--accept', 'b=fine for us', '--fail-above', '3');
  assert.strictEqual(r.status, 0, r.stdout + r.stderr); // everything strict has been checked
  assert.doesNotMatch(r.stdout, /FLAG/);
  const cfg = JSON.parse(fs.readFileSync(path.join(d, 'license-label.config.json'), 'utf8'));
  assert.deepStrictEqual(cfg.accepted.map((x) => [x.package, x.licence]), [['c', 'AGPL-3.0-only'], ['paid', 'SEE LICENSE IN LICENSE'], ['b', 'BUSL-1.1']]);
  html = fs.readFileSync(path.join(d, 'license-label.html'), 'utf8');
  assert.doesNotMatch(html, /class="flagbox"/);
  assert.match(html, /class="seen">Checked \d{4}-\d\d-\d\d: we have a subscription/);

  // the checked package changes its licence again: the record no longer covers it
  lock.packages['node_modules/paid'].license = 'AGPL-3.0-only';
  write(d, 'package-lock.json', lock);
  r = run(d);
  assert.match(r.stdout, /FLAG \(new\)  paid changed its licence/);
  assert.doesNotMatch(run(d, '--seen').stdout, /FLAG/);
  assert.strictEqual(spawnSync('node', [BIN, d, '--accept', 'nope=x'], { cwd: d }).status, 1);
});

test('help and bad options', () => {
  assert.match(execFileSync('node', [BIN, '--help'], { encoding: 'utf8' }), /--fail-above/);
  assert.strictEqual(spawnSync('node', [BIN, '--nope']).status, 1);
});
