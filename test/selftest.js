#!/usr/bin/env node
'use strict';

// Runs with no VS Code, no network and no ClickUp token: it exercises the pure helpers, the
// packaging contract, and the redistribution guards. `npm test` runs this plus the dispatcher's
// own --selftest.

const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

// extension.js and setup.js only touch vscode inside command handlers/activate(), so a tiny
// load-time stub is enough to exercise their pure helpers without an Extension Development Host.
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return {};
  return realLoad.call(this, request, parent, isMain);
};

let extension, setup;
try {
  extension = require(path.join(SRC, 'extension.js'));
  setup = require(path.join(SRC, 'setup.js'));
} finally {
  Module._load = realLoad;
}

// ---------- launcher state helpers ----------
const t = extension.__test;
assert.ok(t, 'extension.js must expose pure helpers through __test');

// What counts as an absolute path is platform-specific — "D:\state" is absolute on Windows and a
// plain relative name everywhere else — so build the fixture instead of hardcoding one shape. A
// hardcoded Windows path passes locally and fails the moment CI runs on Linux.
const ROOT_ABS = process.platform === 'win32' ? 'D:\\state' : '/state';
const HOME = path.join(ROOT_ABS, 'home');
const abs = name => path.join(ROOT_ABS, name);

// An absolute override is taken exactly as given.
assert.deepEqual(
  t.resolveStatePaths(
    {
      AGENT_LOOP_LOCK: abs('custom.lock'),
      AGENT_LOOP_STOP: abs('custom.stop'),
      AGENT_LOOP_STOP_REPORT: abs('custom-report.md'),
    },
    HOME,
  ),
  { lock: abs('custom.lock'), stop: abs('custom.stop'), report: abs('custom-report.md') },
);

// A RELATIVE override resolves against home, and an absent one falls back to the documented default
// in home. Both branches are platform-independent, and neither was covered before.
const mixed = t.resolveStatePaths({ AGENT_LOOP_LOCK: path.join('sub', 'a.lock') }, HOME);
assert.equal(mixed.lock, path.resolve(HOME, path.join('sub', 'a.lock')));
assert.equal(mixed.stop, path.join(HOME, '.agent-loop.stop'));
assert.equal(mixed.report, path.join(HOME, '.agent-loop-stop-report.md'));

const loaded = t.loadStateEnv(
  { AGENT_LOOP_ENV: 'test.env' },
  'C:\\Users\\Test',
  {
    existsSync: file => file === 'test.env',
    readFileSync: () => [
      'CLICKUP_TOKEN=must-not-enter-extension-memory',
      'AGENT_LOOP_LOCK="D:\\state\\from-file.lock"',
      "AGENT_LOOP_STOP='D:\\state\\from-file.stop'",
    ].join('\n'),
  },
);
assert.deepEqual(loaded, {
  AGENT_LOOP_LOCK: 'D:\\state\\from-file.lock',
  AGENT_LOOP_STOP: 'D:\\state\\from-file.stop',
});

assert.deepEqual(t.parseLockRecord('1234'), { pid: 1234, nonce: null });
assert.deepEqual(t.parseLockRecord('{"pid":4321,"nonce":"abc"}'), { pid: 4321, nonce: 'abc' });
assert.equal(t.parseLockRecord(''), null);
assert.equal(t.parseLockRecord('not-a-lock'), null);

const oldTerminal = { name: 'Agent Loop', id: 'old' };
const currentTerminal = { name: 'Agent Loop', id: 'current' };
assert.equal(t.pickTerminal([oldTerminal, currentTerminal], currentTerminal), currentTerminal);
assert.equal(t.pickTerminal([oldTerminal, currentTerminal], undefined), currentTerminal);

assert.equal(t.lockLooksLive({ record: null, ageMs: 500, pidAlive: false, identity: 'no' }), true);
assert.equal(t.lockLooksLive({ record: null, ageMs: 15_000, pidAlive: false, identity: 'no' }), false);
assert.equal(t.lockLooksLive({ record: { pid: 77 }, ageMs: 60_000, pidAlive: true, identity: 'no' }), false);
assert.equal(t.lockLooksLive({ record: { pid: 77 }, ageMs: 60_000, pidAlive: true, identity: 'yes' }), true);
assert.equal(t.lockLooksLive({ record: { pid: 77 }, ageMs: 700_000, pidAlive: true, identity: 'unknown' }), false);

// ---------- the dispatcher must actually ship inside the extension ----------
assert.ok(fs.existsSync(t.DISPATCHER), `bundled dispatcher missing at ${t.DISPATCHER}`);
const dispatcherSrc = fs.readFileSync(t.DISPATCHER, 'utf8');

// ---------- redistribution guards ----------
// This repository is published. Nothing machine-specific, private, or project-specific may ship in
// any file that goes out — a leaked token or somebody's board id is not recoverable after a push.
const SHIPPED = [
  path.join(SRC, 'agent-loop.mjs'),
  path.join(SRC, 'extension.js'),
  path.join(SRC, 'setup.js'),
  path.join(ROOT, 'agent-loop.env.example'),
  path.join(ROOT, 'package.json'),
];
const LEAK_PATTERNS = [
  ['a real ClickUp token', /\bpk_\d{6,}[_A-Z0-9]*/],
  ['a machine-specific Windows path', /[A-Za-z]:\\+Users\\+(?!Test\b)[A-Za-z0-9._-]+/],
  ['a machine-specific POSIX home path', /\/(?:home|Users)\/(?!Test\b)[A-Za-z0-9._-]+\//],
  ['a hardcoded ClickUp list id', /AGENT_LOOP_LIST_ID\s*(?:\|\||=)\s*['"]\d/],
  ['a ClickUp workspace or list id', /\b\d{10,}\b/],
];
for (const file of SHIPPED) {
  const src = fs.readFileSync(file, 'utf8');
  for (const [label, pattern] of LEAK_PATTERNS) {
    const m = src.match(pattern);
    assert.equal(m, null, `${path.relative(ROOT, file)} leaks ${label}: ${m && m[0]}`);
  }
}

// ---------- every knob must be documented ----------
// The config file is the product's whole configuration surface. A knob the dispatcher reads but the
// example never mentions is invisible to a user who did not write the code.
const configExample = fs.readFileSync(path.join(ROOT, 'agent-loop.env.example'), 'utf8');
const envKeys = new Set([
  ...(dispatcherSrc.match(/process\.env\.[A-Z_][A-Z0-9_]*/g) || []).map(s => s.slice('process.env.'.length)),
  ...(dispatcherSrc.match(/\b(?:num|str|bool)\(\s*'([A-Z_][A-Z0-9_]*)'/g) || []).map(s => s.match(/'([A-Z_][A-Z0-9_]*)'/)[1]),
  ...(dispatcherSrc.match(/process\.env\[['"]([A-Z_][A-Z0-9_]*)/g) || []).map(s => s.match(/([A-Z_][A-Z0-9_]*)$/)[1]),
]);
// Set by the dispatcher rather than read from config, or a fixture used only by --selftest.
for (const internal of ['GIT_TERMINAL_PROMPT', 'AGENT_LOOP_SELFTEST_NUM']) envKeys.delete(internal);
for (const key of [...envKeys].sort()) {
  assert.ok(configExample.includes(key), `agent-loop.env.example does not document ${key}`);
}

// ---------- setup: env-file merge ----------
const s = setup.__test;
assert.ok(s, 'setup.js must expose pure helpers through __test');

assert.deepEqual(s.parseEnv('CLICKUP_TOKEN=pk_1\n# comment\nAGENT_LOOP_BASE="main"\n'), {
  CLICKUP_TOKEN: 'pk_1',
  AGENT_LOOP_BASE: 'main',
});

// Existing managed keys are replaced in place; unmanaged lines and comments survive verbatim;
// genuinely new keys are appended. This is what lets the wizard be re-run over a hand-edited file.
const merged = s.mergeEnvText(
  '# my notes\nCLICKUP_TOKEN=old\nAGENT_LOOP_VERIFY=npm test\nAGENT_LOOP_STATUS_READY=todo\n',
  { CLICKUP_TOKEN: 'new', AGENT_LOOP_LIST_ID: '901100' },
);
assert.equal(merged, '# my notes\nCLICKUP_TOKEN=new\nAGENT_LOOP_VERIFY=npm test\nAGENT_LOOP_STATUS_READY=todo\nAGENT_LOOP_LIST_ID=901100\n');
assert.equal((merged.match(/^CLICKUP_TOKEN=/gm) || []).length, 1, 'must not duplicate an existing key');
assert.equal(s.mergeEnvText('', { A_B: '1' }), 'A_B=1\n');
assert.equal(s.mergeEnvText(undefined, { A_B: '1' }), 'A_B=1\n');

// ---------- setup: board verification ----------
assert.deepEqual(s.missingStatusNames(s.REQUIRED_STATUSES.map(status => ({ status }))), []);
assert.deepEqual(s.missingStatusNames([{ status: 'READY' }, { status: 'Coding' }]),
  s.REQUIRED_STATUSES.filter(x => x !== 'ready' && x !== 'coding'));
assert.deepEqual(s.missingStatusNames([]), s.REQUIRED_STATUSES);
assert.deepEqual(s.missingFieldNames([{ name: 'acceptance criteria' }, { name: 'Blocked By' }]), []);
assert.deepEqual(s.missingFieldNames([{ name: 'Blocked By' }]), ['Acceptance Criteria']);

// GET /list/{id} carries no url, so the deep link is composed — and must be omitted, not malformed,
// when the workspace id is unknown (e.g. an env file written by hand before AGENT_LOOP_TEAM_ID).
assert.equal(s.listUrl('90000000000', '90000000001'), 'https://app.clickup.com/90000000000/v/li/90000000001');
assert.equal(s.listUrl(undefined, '90000000001'), null);
assert.equal(s.listUrl('90000000000', undefined), null);

// The wizard's required names must match the dispatcher's own defaults, or a board it declares
// "ready" would still fail on the first pass.
for (const status of s.REQUIRED_STATUSES) {
  assert.ok(dispatcherSrc.includes(`'${status}'`), `dispatcher has no default status "${status}"`);
}
for (const field of s.REQUIRED_FIELDS) {
  assert.ok(dispatcherSrc.includes(`'${field}'`), `dispatcher has no default custom field "${field}"`);
}
// ...and the shipped config must document the same vocabulary it asks the user to create.
for (const name of [...s.REQUIRED_STATUSES, ...s.REQUIRED_FIELDS]) {
  assert.ok(configExample.includes(name), `agent-loop.env.example never mentions "${name}"`);
}

// ---------- openConfig seeds a missing config from the shipped example ----------
assert.ok(fs.existsSync(t.CONFIG_EXAMPLE), `config example missing at ${t.CONFIG_EXAMPLE}`);
{
  const written = {};
  const fakeFs = {
    existsSync: f => f === t.CONFIG_EXAMPLE || f in written,
    readFileSync: () => 'EXAMPLE BODY',
    writeFileSync: (f, body, opts) => {
      assert.equal(opts.flag, 'wx', 'must refuse to clobber a config another window just created');
      written[f] = body;
    },
  };
  // openConfig calls into the vscode stub to show the document, which the stub does not implement;
  // the assertion is about the seeding, so a throw after the write is expected and ignored.
  Promise.resolve(t.openConfig('fake.env', t.CONFIG_EXAMPLE, fakeFs)).catch(() => {});
  assert.equal(written['fake.env'], 'EXAMPLE BODY', 'a missing config must be seeded from the example');
}

// ---------- packaging: everything the runtime needs must be shippable ----------
const ignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8').split(/\r?\n/).map(l => l.trim());
for (const required of ['src/extension.js', 'src/setup.js', 'src/agent-loop.mjs', 'package.json', 'agent-loop.env.example', 'README.md', 'LICENSE.md']) {
  assert.ok(fs.existsSync(path.join(ROOT, required)), `missing ${required}`);
  assert.ok(!ignore.some(rule => rule === required || rule === `${required.split('/')[0]}/**`),
    `.vscodeignore would exclude ${required} from the .vsix`);
}
const pkg = require(path.join(ROOT, 'package.json'));
assert.equal(pkg.main, './src/extension.js');
assert.equal(pkg.license, 'SEE LICENSE IN LICENSE.md');

// The icon is easy to lose silently — a wrong path, or .vscodeignore swallowing images/ — and the
// only symptom is a grey placeholder on the Marketplace listing. Assert it is declared, present, and
// a PNG of at least the 128px the Marketplace requires. The PNG header carries the dimensions at a
// fixed offset, so this needs no image library.
assert.ok(pkg.icon, 'package.json declares no icon');
const iconPath = path.join(ROOT, pkg.icon);
assert.ok(fs.existsSync(iconPath), `icon missing at ${pkg.icon}`);
assert.ok(!ignore.some(rule => rule === pkg.icon || rule === `${pkg.icon.split('/')[0]}/**`),
  `.vscodeignore would exclude ${pkg.icon} from the .vsix`);
const png = fs.readFileSync(iconPath);
assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG', 'the icon must be a real PNG');
const [iw, ih] = [png.readUInt32BE(16), png.readUInt32BE(20)];
assert.equal(iw, ih, `icon must be square, got ${iw}x${ih}`);
assert.ok(iw >= 128, `icon must be at least 128px, got ${iw}px`);
for (const cmd of ['agentLoop.toggle', 'agentLoop.setup', 'agentLoop.checkBoard', 'agentLoop.openConfig', 'agentLoop.safeStop', 'agentLoop.forceStop', 'agentLoop.openStopReport']) {
  assert.ok(pkg.contributes.commands.some(c => c.command === cmd), `package.json does not contribute ${cmd}`);
}

console.log('agent-loop selftest: OK');
