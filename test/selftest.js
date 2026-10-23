#!/usr/bin/env node
'use strict';

// Runs with no VS Code, no network and no ClickUp token: it exercises the pure helpers, the
// packaging contract, and the redistribution guards. `npm test` runs this plus the dispatcher's
// own --selftest.

const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
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
  {
    lock: abs('custom.lock'),
    stop: abs('custom.stop'),
    report: abs('custom-report.md'),
    log: path.join(HOME, '.agent-loop.log'),
    heartbeat: path.join(HOME, '.agent-loop-heartbeat.json'),
    unsafe: path.join(HOME, '.agent-loop.unsafe'),
    bench: path.join(HOME, '.agent-loop-bench.json'),
    rounds: path.join(HOME, '.agent-loop-rounds.json'),
    watcherReport: path.join(HOME, '.agent-loop-watcher-report.md'),
    watcherLog: path.join(HOME, '.agent-loop-watcher.log'),
    watcherState: path.join(HOME, '.agent-loop-watcher-state.json'),
  },
);

// A RELATIVE override resolves against home, and an absent one falls back to the documented default
// in home. Both branches are platform-independent, and neither was covered before.
const mixed = t.resolveStatePaths({ AGENT_LOOP_LOCK: path.join('sub', 'a.lock') }, HOME);
assert.equal(mixed.lock, path.resolve(HOME, path.join('sub', 'a.lock')));
assert.equal(mixed.stop, path.join(HOME, '.agent-loop.stop'));
assert.equal(mixed.report, path.join(HOME, '.agent-loop-stop-report.md'));
assert.equal(mixed.heartbeat, path.join(HOME, '.agent-loop-heartbeat.json'));
assert.equal(mixed.rounds, path.join(HOME, '.agent-loop-rounds.json'));
assert.equal(mixed.watcherState, path.join(HOME, '.agent-loop-watcher-state.json'));

const child = t.childEnv(abs('repo'), t.resolveStatePaths({}, HOME));
assert.equal(child.AGENT_LOOP_HEARTBEAT_FILE, path.join(HOME, '.agent-loop-heartbeat.json'));
assert.equal(child.AGENT_LOOP_LOG, path.join(HOME, '.agent-loop.log'));
assert.equal(child.AGENT_LOOP_UNSAFE, path.join(HOME, '.agent-loop.unsafe'));
assert.equal(child.AGENT_LOOP_BENCH_FILE, path.join(HOME, '.agent-loop-bench.json'));
assert.equal(child.AGENT_LOOP_ROUNDS, path.join(HOME, '.agent-loop-rounds.json'));
assert.equal(child.CLICKUP_TOKEN, undefined);
assert.equal(child.GITHUB_TOKEN, undefined);

const stubQuoted = 'REFUSING fresh fork of 123: branch `agent-loop/task-a-123` already exists (0 commit(s) beyond `main`)';
const stubCalls = [];
const stubGit = t.readStubGit('repo', stubQuoted, args => {
  stubCalls.push(args);
  if (args[0] === 'rev-list') return { code: 0, out: '0\n' };
  return { code: 0, out: 'refs/remotes/origin/agent-loop/task-a-123\n' };
});
assert.equal(stubGit.commits, 0);
assert.equal(stubGit.hasRemote, true);
assert.equal(stubGit.base, 'main');
assert.deepEqual(stubCalls[0], ['rev-list', '--count', 'main..agent-loop/task-a-123']);
assert.equal(t.readStubGit('repo', 'branch `../secret` already exists (0 commit(s) beyond `main`)', () => {
  throw new Error('git must not run');
}), null);
const stubPlain = t.readStubGit(
  'repo',
  'REFUSING fresh fork of 123: branch agent-loop/task-a-123 already exists (0 commit(s) beyond main)',
  args => (args[0] === 'rev-list' ? { code: 0, out: '4\n' } : { code: 0, out: '' }),
);
assert.equal(stubPlain.commits, 4);
assert.equal(stubPlain.hasRemote, false);
assert.equal(t.readStubGit('repo', stubQuoted, () => ({ code: 1, out: '' })), null);
const countCalls = [];
const counted = t.countBranchCommits('repo', '123', args => {
  countCalls.push(args);
  if (args[0] === 'for-each-ref') return { code: 0, out: 'main\nagent-loop/task-a-123\nagent-loop/task-b-1234\n' };
  return { code: 0, out: '7\n' };
});
assert.equal(counted, 7);
assert.deepEqual(countCalls[1], ['rev-list', '--count', 'agent-loop/task-a-123']);
assert.equal(t.countBranchCommits('repo', '999', () => ({ code: 0, out: 'main\n' })), null);
assert.equal(t.countBranchCommits('repo', '../x', () => { throw new Error('git must not run'); }), null);
assert.equal(t.countBranchCommits('repo', '123', args => (
  args[0] === 'for-each-ref' ? { code: 0, out: 'evil..name-123\n' } : { code: 0, out: '1\n' }
)), null);

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

const secretDrop = t.loadStateEnv(
  {},
  'C:\\Users\\Test',
  {
    existsSync: () => true,
    readFileSync: () => [
      'CLICKUP_TOKEN=pk_secret',
      'GITHUB_TOKEN=ghp_secret',
      'AGENT_LOOP_WATCHER=on',
      'AGENT_LOOP_HEARTBEAT_FILE=D:\\state\\hb.json',
    ].join('\n'),
  },
);
assert.equal(secretDrop.CLICKUP_TOKEN, undefined);
assert.equal(secretDrop.GITHUB_TOKEN, undefined);
assert.equal(secretDrop.AGENT_LOOP_WATCHER, 'on');
assert.equal(secretDrop.AGENT_LOOP_HEARTBEAT_FILE, 'D:\\state\\hb.json');
assert.equal(t.STATE_ENV_KEYS.has('CLICKUP_TOKEN'), false);
assert.equal(t.STATE_ENV_KEYS.has('GITHUB_TOKEN'), false);
assert.deepEqual(t.readRoundsTally('rounds.json', {
  readFileSync: () => '{"task-a":2,"rescope:task-a":1}',
}), { 'task-a': 2, 'rescope:task-a': 1 });
assert.equal(t.readRoundsTally('missing.json', {
  readFileSync: () => { throw new Error('ENOENT'); },
}), null);
assert.equal(t.readRoundsTally('bad.json', { readFileSync: () => 'not-json' }), null);
assert.equal(t.readRoundsTally('list.json', { readFileSync: () => '[1,2]' }), null);

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
  path.join(SRC, 'watcher.js'),
  path.join(SRC, 'setup.js'),
  path.join(ROOT, 'agent-loop.env.example'),
  path.join(ROOT, 'package.json'),
  // The .vsix ships these too (they are absent from .vscodeignore) and the marketplace
  // renders them, so a board id pasted into a changelog entry is as public as one in source.
  path.join(ROOT, 'README.md'),
  path.join(ROOT, 'SETUP.md'),
  path.join(ROOT, 'CHANGELOG.md'),
  path.join(ROOT, 'AI_Setup.md'),
  path.join(ROOT, 'CLAUDE.md'),
  path.join(ROOT, 'CONTRIBUTING.md'),
];
const LEAK_PATTERNS = [
  ['a real ClickUp token', /\bpk_\d{6,}[_A-Z0-9]*/],
  ['a machine-specific Windows path', /[A-Za-z]:\\+Users\\+(?!Test\b)[A-Za-z0-9._-]+/],
  ['a machine-specific POSIX home path', /\/(?:home|Users)\/(?!Test\b)[A-Za-z0-9._-]+\//],
  ['a hardcoded ClickUp list id', /AGENT_LOOP_LIST_ID\s*(?:\|\||=)\s*['"]\d/],
  ['a ClickUp workspace or list id', /\b\d{10,}\b/],
  // Incidents are worth writing down; the reporter's board is not. `XY12 re-scoped twice` and a
  // verbatim `ClickUp ab12cd34e` fixture both shipped in src before anyone noticed. Describe the
  // task, never name it; the placeholder id in a fixture must be numeric, like `ClickUp 123`.
  // The second alternative reads a real id by SHAPE (letters and digits mixed), so it survives a
  // different workspace's prefixes while leaving prose like `ClickUp workspace` alone.
  ['a private board task reference',
    /\bGP\d{1,3}[a-z]?\b|ClickUp\s+(?![0-9]+\b)(?![A-Za-z]+\b)[A-Za-z0-9]{7,}/],
  // A Claude project directory encodes the workspace path as a drive letter, two dashes, then
  // the rest of the path. Branch names lowercase the same task label the board pattern catches.
  ['a Claude projects slug', /\b[A-Za-z]--[A-Za-z0-9]/],
  ['a non-placeholder UUID',
    /\b(?!00000000-0000-4000-8000-0000000000[0-9a-f]{2}\b)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ['a private task branch', /\btask-gp\d{1,3}[a-z]?-/i],
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
for (const internal of ['GIT_TERMINAL_PROMPT', 'AGENT_LOOP_SELFTEST_NUM', 'AGENT_LOOP_SHUTDOWN_PROBE']) envKeys.delete(internal);
for (const key of [...envKeys].sort()) {
  assert.ok(configExample.includes(key), `agent-loop.env.example does not document ${key}`);
}
for (const key of t.STATE_ENV_KEYS) {
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
for (const required of ['src/extension.js', 'src/setup.js', 'src/watcher.js', 'src/agent-loop.mjs', 'package.json', 'agent-loop.env.example', 'README.md', 'LICENSE.md']) {
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
for (const cmd of ['agentLoop.toggle', 'agentLoop.setup', 'agentLoop.checkBoard', 'agentLoop.openConfig', 'agentLoop.safeStop', 'agentLoop.forceStop', 'agentLoop.openStopReport', 'agentLoop.recover', 'agentLoop.openWatcherReport']) {
  assert.ok(pkg.contributes.commands.some(c => c.command === cmd), `package.json does not contribute ${cmd}`);
}

// ---------- the verify example reserves its focused run for test-only diffs ----------
// A task that ships production code AND its own new test must run the WHOLE suite. The new test
// passes by construction, so a run narrowed to it proves nothing about the coverage guards, cache
// invalidation and other callers the change may have broken — CI would be the first to notice.
// Exercised for real against a throwaway repo under os.tmpdir(): no network, no project touched.
{
  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-verify-'));
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
    return r;
  };
  const write = (rel, body) => {
    fs.mkdirSync(path.join(repo, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
  };
  // No package.json on purpose: the first suite command then fails immediately instead of reaching
  // for the network, and the run is already over having printed which command it chose.
  const runVerify = () => spawnSync(
    process.execPath,
    [path.join(ROOT, 'examples', 'agent-loop-verify.example.mjs')],
    { cwd: repo, encoding: 'utf8', env: { ...process.env, AGENT_LOOP_BASE: 'main' } },
  ).stdout;

  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'selftest@example.invalid');
    git('config', 'user.name', 'selftest');
    // Local to this fixture only. A globally-configured signing key would otherwise block on a
    // passphrase prompt and hang the suite.
    git('config', 'commit.gpgsign', 'false');
    write('README.md', 'base\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    // The example diffs against origin/<base>, and a temp repo has no remote — point the ref here.
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const base = git('rev-parse', 'HEAD').stdout.trim();

    write('src/a.js', 'export const a = 1;\n');
    write('src/a.test.js', 'test("a", () => {});\n');
    git('add', '-A');
    git('commit', '-qm', 'feature plus its own test');
    const mixed = runVerify();
    assert.ok(!/test-only/.test(mixed),
      `a production+test diff must not take the focused path, got:\n${mixed}`);
    assert.ok(/\$ npm run lint\r?\n/.test(mixed),
      `a production+test diff must run the whole suite, got:\n${mixed}`);

    git('reset', '-q', '--hard', base);
    write('src/a.test.js', 'test("a", () => {});\n');
    git('add', '-A');
    git('commit', '-qm', 'test only');
    const testOnly = runVerify();
    assert.ok(/test-only/.test(testOnly),
      `a test-only diff must take the focused path, got:\n${testOnly}`);
    assert.ok(testOnly.includes('$ npm run lint -- src/a.test.js'),
      `a test-only diff must pass its changed tests through unchanged, got:\n${testOnly}`);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

// ---------- watcher playbook ----------
// Pure decisions. No vscode, no network, no live process sample. Log lines use the dispatcher's
// `[ISO] ` prefix. Paths and task ids in here are fixtures (`Task A`, ClickUp-style `123`).
const watcher = require(path.join(SRC, 'watcher.js'));
const NOW = Date.parse('2026-10-22T12:00:00.000Z');

function atLocal(hour, minute, base = NOW) {
  const d = new Date(base);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}
function stamp(ms, body) {
  return `[${new Date(ms).toISOString()}] ${body}`;
}
function baseFacts(over = {}) {
  return {
    now: NOW,
    pid: 10,
    pidAlive: true,
    lockExists: true,
    lockPidAlive: true,
    lock: { pid: 10, nonce: 'abc' },
    heartbeat: { pid: 10, nonce: 'abc', stage: 'idle', pass: 1 },
    heartbeatAgeMs: 1000,
    children: [],
    lines: [],
    env: {},
    claudeMode: 'playbook',
    maxFixes: 2,
    maxCallsPerHour: 4,
    phase2: false,
    cpuRatio: 0,
    ioUnchanged: false,
    ioGapMs: 10_000,
    ...over,
  };
}
function decide(over, memory, claude) {
  return watcher.evaluate(baseFacts(over), memory || watcher.emptyMemory(), claude);
}
function wedge(over = {}) {
  return {
    heartbeat: { pid: 10, nonce: 'abc', stage: 'implement', pass: 1 },
    heartbeatAgeMs: 1_900_000,
    cpuRatio: 1,
    ioUnchanged: true,
    ioGapMs: 10_000,
    children: [],
    ...over,
  };
}

async function watcherChecks() {
  assert.equal(watcher.PHASE2, true);
  assert.equal(watcher.stageLimitMs('implement', {}), 1_800_000);
  assert.equal(watcher.stageLimitMs('review', {}), 1_200_000);
  assert.equal(watcher.stageLimitMs('adjudicate', {}), 1_200_000);
  assert.equal(watcher.stageLimitMs('verify', {}), 2_100_000);
  assert.equal(watcher.stageLimitMs('idle', {}), 1_200_000);
  assert.equal(watcher.stageLimitMs('verify', { AGENT_LOOP_VERIFY_TIMEOUT_S: '1800' }), 2_400_000);
  assert.equal(watcher.pollSeconds(undefined), 60);
  assert.equal(watcher.pollSeconds(5), 10);
  assert.equal(watcher.pollSeconds(99_999), 3600);
  assert.equal(watcher.watcherMode('off', true), 'off');
  assert.equal(watcher.watcherMode('auto', false), 'playbook');
  assert.equal(watcher.watcherMode('auto', true), 'full');
  assert.equal(watcher.watcherMode('on', false), 'playbook');
  assert.equal(watcher.quoteCmdArg(''), '""');
  assert.equal(watcher.quoteCmdArg('sonnet'), 'sonnet');
  assert.deepEqual(watcher.DEFAULT_CLAUDE_ARGS, [
    'claude', '-p', '--model', 'sonnet', '--tools', '',
    '--permission-prompts', 'none', '--no-session-persistence',
  ]);
  assert.equal(watcher.DEFAULT_CLAUDE_ARGS.includes('--bare'), false);
  assert.ok(watcher.DEFAULT_CLAUDE_CMD.includes('--tools ""'));
  assert.equal(watcher.DEFAULT_CLAUDE_CMD.includes('--bare'), false);
  assert.equal(watcher.effectiveWatcherMode('full', null), 'playbook');
  assert.equal(watcher.effectiveWatcherMode('full', { ok: false, reason: 'Not logged in' }), 'playbook');
  assert.equal(watcher.effectiveWatcherMode('full', { ok: true }), 'full');
  assert.equal(watcher.effectiveWatcherMode('off', { ok: true }), 'off');
  assert.equal(watcher.claudeSelfCheckPassed({ ok: true, text: 'OK\n' }), true);
  assert.equal(watcher.claudeSelfCheckPassed({ ok: false, text: 'OK\n' }), false);
  assert.equal(watcher.claudeSelfCheckPassed({ ok: true, text: 'Not logged in' }), false);
  assert.ok(watcher.claudeSelfCheckLog({ ok: false, reason: 'Not logged in' }).includes('playbook only'));
  assert.equal(watcher.WATCHER_START_GRACE_MS, 2 * 60 * 1000);
  assert.equal(watcher.watcherShouldStop({
    present: false, sawDispatcher: false, armedAt: 0, now: 1500,
  }), false);
  assert.equal(watcher.watcherShouldStop({
    present: false, sawDispatcher: false, armedAt: 0, now: watcher.WATCHER_START_GRACE_MS + 1,
  }), true);
  assert.equal(watcher.watcherShouldStop({
    present: true, sawDispatcher: false, armedAt: 0, now: 999999,
  }), false);
  assert.equal(watcher.watcherShouldStop({
    present: false, sawDispatcher: true, armedAt: 0, now: 1500,
  }), true);
  assert.equal(watcher.shouldEnsureWatcher(true, false), true);
  assert.equal(watcher.shouldEnsureWatcher(true, true), false);
  assert.equal(watcher.shouldEnsureWatcher(false, false), false);
  assert.equal(watcher.REPEAT_N, 3);
  assert.equal(watcher.REPEAT_WINDOW_MS, 15 * 60 * 1000);

  const secret = [
    'pk_123456_ABC',
    'sk-abcDEF123',
    'xai-abcDEF123',
    'ghp_abcDEF123456',
    'Bearer super-secret',
    'CLICKUP_TOKEN=pk_123456_ABC',
    'https://user:pass@example.com/a',
  ].join(' ');
  const red = watcher.redact(secret);
  for (const raw of ['pk_123456', 'sk-abc', 'xai-abc', 'ghp_abc', 'super-secret', 'user:pass']) {
    assert.equal(red.includes(raw), false, `redact left ${raw} in: ${red}`);
  }
  assert.ok(red.includes('pk_[redacted]'));
  assert.ok(red.includes('sk-[redacted]'));
  assert.ok(red.includes('xai-[redacted]'));
  assert.ok(red.includes('ghp_[redacted]'));
  assert.ok(red.includes('Bearer [redacted]'));
  assert.ok(red.includes('CLICKUP_TOKEN=[redacted]'));
  assert.ok(red.includes('https://[redacted]@example.com/a'));

  assert.equal(
    watcher.normalizeSignature('[2026-10-22T12:00:00.000Z] task abcdef1234 failed 3 times'),
    'task # failed # times',
  );
  assert.equal(
    watcher.normalizeSignature('[2026-10-22T12:00:00.000Z] FATAL code 1'),
    watcher.normalizeSignature('[2026-10-22T12:01:00.000Z] FATAL code 22'),
  );

  const partial = Buffer.from('hello\npartial');
  const got = watcher.readNewLog(partial, 0);
  assert.deepEqual(got.lines, ['hello']);
  assert.equal(got.nextOffset, 6);
  assert.deepEqual(watcher.readNewLog(partial, 100).lines, []);

  assert.equal(watcher.identityMatches(baseFacts()), true);
  assert.equal(watcher.identityMatches(baseFacts({ lock: { pid: 10, nonce: 'OTHER' } })), false);
  assert.equal(watcher.identityMatches(baseFacts({ heartbeat: { pid: 11, nonce: 'abc', stage: 'idle' } })), false);
  assert.ok(watcher.isUserStop('requested 2026-10-22T11:00:00.000Z from the Agent Loop button\n'));
  assert.equal(watcher.isUserStop(watcher.watcherStopText(new Date(NOW))), false);
  assert.equal(watcher.isWatcherStop(watcher.watcherStopText(new Date(NOW))), true);
  assert.ok(watcher.watcherStopText(new Date(NOW)).includes('by the watcher'));

  const alive = { lockExists: true, lockPidAlive: true, lock: { pid: 10, nonce: 'abc' }, heartbeat: { pid: 10, nonce: 'abc' }, pid: 10, pidAlive: true };
  assert.equal(watcher.preconditions('wait', {}).ok, true);
  assert.equal(watcher.preconditions('clear_stale_lock', { lockExists: true, lockPidAlive: false }).ok, true);
  assert.equal(watcher.preconditions('clear_stale_lock', { lockExists: true, lockPidAlive: true }).ok, false);
  assert.equal(watcher.preconditions('kill_and_recover', baseFacts(wedge())).ok, true);
  assert.equal(watcher.preconditions('kill_and_recover', baseFacts(wedge({ lock: { pid: 10, nonce: 'OTHER' } }))).ok, false);
  assert.equal(watcher.preconditions('kill_lingering', baseFacts({
    heartbeat: { pid: 10, nonce: 'abc', stage: 'stopped' }, stoppedForMs: 6 * 60 * 1000, cpuRatio: 0, children: [],
  })).ok, true);
  assert.equal(watcher.preconditions('kill_lingering', baseFacts({
    heartbeat: { pid: 10, nonce: 'abc', stage: 'stopped' }, stoppedForMs: 6 * 60 * 1000, cpuRatio: 0, children: [{ name: 'claude.exe' }],
  })).ok, false);
  assert.equal(watcher.preconditions('recover', { unsafe: { pids: [{ alive: false }], sandboxNewerThanStop: false } }).ok, true);
  assert.equal(watcher.preconditions('recover', { unsafe: { pids: [{ alive: true }], sandboxNewerThanStop: false } }).ok, false);
  assert.equal(watcher.preconditions('probe_coders', {}, {}).ok, true);
  assert.equal(watcher.preconditions('probe_coders', { incident: 'x' }, { probed: { x: true } }).ok, false);
  assert.equal(watcher.preconditions('stop_and_report', {}).ok, true);
  assert.equal(watcher.preconditions('reset_stub', { loopStopped: true, stubCommits: 0, stubRemote: false, taskId: '123' }).ok, true);
  assert.equal(watcher.preconditions('reset_stub', { loopStopped: false, stubCommits: 0, stubRemote: false, taskId: '123' }).ok, false);
  assert.equal(watcher.preconditions('bench_coder', { coderCreditExhausted: true, coderName: 'grok' }).ok, true);
  assert.equal(watcher.preconditions('bench_coder', { coderCreditExhausted: false, coderName: 'grok' }).ok, false);
  assert.equal(watcher.preconditions('rm_rf', {}).ok, false);
  assert.equal(alive.lock.pid, 10);

  assert.equal(watcher.parseClaudeVerdict('nope').ok, false);
  assert.equal(watcher.parseClaudeVerdict('{"action":"rm_rf","confidence":1}').reason, 'unknown action');
  assert.equal(watcher.parseClaudeVerdict('{"action":"wait","confidence":0.2}').reason, 'low confidence');
  const parsed = watcher.parseClaudeVerdict('note {"diagnosis":"d","action":"wait","confidence":0.8,"why":"w","human_fix":"h"} tail');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.action, 'wait');
  assert.equal(parsed.humanFix, 'h');

  const probe = watcher.probePlan('probe');
  assert.equal(probe.find(item => item.name === 'codex').command, 'codex login status');
  assert.equal(probe.find(item => item.name === 'claude').input, 'Reply with exactly: OK');
  assert.equal(probe.find(item => item.name === 'claude').command, 'claude -p --model sonnet');
  const reviewPlan = watcher.probePlan('review');
  assert.ok(reviewPlan.find(item => item.name === 'codex').command.includes('codex exec'));
  assert.equal(reviewPlan.find(item => item.name === 'grok').promptFile, true);

  const killed = stamp(NOW, '123 grok phase: wall 2:10 killed-idle');
  assert.equal(watcher.coderWasActiveBeforeKill([killed], NOW - 30_000), true);
  assert.equal(watcher.coderWasActiveBeforeKill([killed], NOW - 120_000), false);
  assert.equal(watcher.coderWasActiveBeforeKill([killed], NOW + 1000), false);

  const p1 = decide(wedge());
  assert.equal(p1.row, 'P1');
  assert.equal(p1.action, 'kill_and_recover');
  assert.equal(p1.effects.kill, true);
  assert.equal(p1.effects.clearLock, true);
  assert.equal(p1.effects.clearStop, true);
  assert.equal(p1.effects.start, true);

  const wrongNonce = decide(wedge({ lock: { pid: 10, nonce: 'OTHER' } }));
  assert.equal(wrongNonce.row, 'P1');
  assert.equal(wrongNonce.effects.kill, false);
  assert.equal(wrongNonce.effects.start, false);
  assert.ok(wrongNonce.refused);

  const longVerify = decide({
    heartbeat: { pid: 10, nonce: 'abc', stage: 'verify', pass: 2 },
    heartbeatAgeMs: 1_800_000,
    cpuRatio: 1,
    ioUnchanged: true,
    children: [],
  });
  assert.equal(longVerify.row, null);

  const nullChildren = decide(wedge({ children: null, cpuRatio: 1 }));
  assert.notEqual(nullChildren.row, 'P1');
  assert.equal(nullChildren.effects.kill, false);

  const p2 = decide({
    heartbeat: { pid: 10, nonce: 'abc', stage: 'stopped', pass: 1 },
    stoppedForMs: 6 * 60 * 1000,
    cpuRatio: 0.05,
    children: [{ name: 'cmd.exe' }],
    lastLogLine: stamp(NOW, 'Safe Stop complete: tree clean'),
  });
  assert.equal(p2.row, 'P2');
  assert.equal(p2.action, 'kill_lingering');
  assert.equal(p2.effects.kill, true);
  assert.equal(p2.effects.start, false);
  assert.equal(p2.effects.clearStop, true);

  const p2early = decide({
    heartbeat: { pid: 10, nonce: 'abc', stage: 'stopped', pass: 1 },
    stoppedForMs: 60 * 1000,
    cpuRatio: 0,
    children: [],
  });
  assert.notEqual(p2early.row, 'P2');
  const p2agent = decide({
    heartbeat: { pid: 10, nonce: 'abc', stage: 'stopped', pass: 1 },
    stoppedForMs: 6 * 60 * 1000,
    cpuRatio: 0,
    children: [{ name: 'claude.exe' }],
  });
  assert.notEqual(p2agent.row, 'P2');

  const p3 = decide({ lockExists: true, lockPidAlive: false, pidAlive: false });
  assert.equal(p3.row, 'P3');
  assert.equal(p3.action, 'clear_stale_lock');
  assert.equal(p3.effects.clearLock, true);
  assert.equal(p3.effects.start, false);
  const mismatch = decide({ lock: { pid: 10, nonce: 'OTHER' }, lockPidAlive: true });
  assert.equal(mismatch.row, 'P3');
  assert.equal(mismatch.response, 'NOTIFY');
  assert.equal(mismatch.effects.clearLock, false);
  assert.equal(decide().row, null);

  let fixes = watcher.emptyMemory();
  let limited;
  for (let i = 0; i < 3; i++) {
    limited = decide({ lockExists: true, lockPidAlive: false, pidAlive: false, now: NOW + i }, fixes);
    fixes = limited.memory;
  }
  assert.equal(limited.action, 'stop_and_report');
  assert.equal(limited.effects.start, false);

  const p4 = decide({
    lockExists: false,
    lockPidAlive: false,
    pidAlive: false,
    unsafe: { pids: [{ pid: 4, alive: false }], sandboxNewerThanStop: false },
    pass: 1,
  });
  assert.equal(p4.action, 'recover');
  assert.equal(p4.effects.recover, true);
  assert.equal(p4.effects.start, true);
  const held = decide({
    lockExists: false,
    lockPidAlive: false,
    pidAlive: false,
    unsafe: { pids: [{ pid: 4, alive: false }], sandboxNewerThanStop: false },
    pass: 2,
  }, p4.memory);
  assert.equal(held.row, null);
  const p4stop = decide({
    lockExists: false,
    unsafe: { pids: [{ pid: 4, alive: true }], sandboxNewerThanStop: false },
  });
  assert.equal(p4stop.response, 'STOP');
  assert.equal(p4stop.effects.recover, false);
  const p4file = decide({
    lockExists: false,
    unsafe: { pids: [{ pid: 4, alive: false }], sandboxNewerThanStop: true },
  });
  assert.equal(p4file.response, 'STOP');
  const lockFirst = decide({
    lockExists: true,
    lockPidAlive: false,
    pidAlive: false,
    unsafe: { pids: [{ pid: 4, alive: false }], sandboxNewerThanStop: false },
  });
  assert.equal(lockFirst.row, 'P3');

  const stub = stamp(NOW, 'REFUSING fresh fork of 123: branch agent-loop/task-a-123 already exists (0 commit(s) beyond main)');
  const elig = stamp(NOW, 'no ready task is eligible: 2 blocked by unfinished predecessors');
  const p5 = decide({ lines: [stub, elig, elig] });
  assert.equal(p5.row, 'P5');
  assert.equal(p5.response, 'NOTIFY');
  assert.equal(p5.effects.start, false);
  assert.ok(p5.report.includes('git rev-list --count'));
  const p5auto = decide({
    lines: [stub, elig, elig],
    phase2: true,
    loopStopped: true,
    stubCommits: 0,
    stubRemote: false,
    lockExists: false,
    lockPidAlive: false,
    pidAlive: false,
  });
  assert.equal(p5auto.action, 'reset_stub');
  assert.equal(p5auto.taskId, '123');
  assert.equal(p5auto.effects.clearStop, true);
  const p5running = decide({
    lines: [stub, elig, elig],
    phase2: true,
  });
  assert.equal(p5running.effects.writeStopFlag, true);
  assert.equal(p5running.effects.resetStub, false);
  assert.equal(p5running.effects.start, false);
  assert.equal(p5running.memory.stubRepair && p5running.memory.stubRepair.taskId, '123');
  const watcherFlag = 'requested 2026-10-22T12:00:00.000Z by the watcher\n';
  const p5wait = decide({
    lines: [],
    phase2: true,
    stopFlag: watcherFlag,
  }, p5running.memory);
  assert.notEqual(p5wait.row, 'watcher-stop');
  assert.equal(p5wait.logLine, null);
  assert.equal(p5wait.effects.resetStub, false);
  assert.equal(p5wait.effects.start, false);
  assert.equal(p5wait.memory.stubRepair && p5wait.memory.stubRepair.taskId, '123');
  const p5done = decide({
    lines: [],
    phase2: true,
    stopFlag: watcherFlag,
    pidAlive: false,
    lockExists: false,
    lockPidAlive: false,
    loopStopped: true,
    stubCommits: 0,
    stubRemote: false,
  }, p5wait.memory);
  assert.equal(p5done.action, 'reset_stub');
  assert.equal(p5done.effects.start, true);
  assert.equal(p5done.effects.clearStop, true);
  assert.equal(p5done.memory.stubRepair, null);
  const p5refuse = decide({
    lines: [],
    phase2: true,
    stopFlag: watcherFlag,
    pidAlive: false,
    lockExists: false,
    lockPidAlive: false,
    loopStopped: true,
    stubCommits: 2,
    stubRemote: false,
  }, p5running.memory);
  assert.equal(p5refuse.response, 'NOTIFY');
  assert.equal(p5refuse.effects.resetStub, false);
  assert.equal(p5refuse.effects.start, false);
  assert.ok(p5refuse.report.includes('git rev-list --count'));
  assert.equal(p5refuse.memory.stubRepair, null);
  const p5user = decide({
    lines: [],
    stopFlag: 'requested 2026-10-22T12:00:00.000Z from the Agent Loop button\n',
  }, p5running.memory);
  assert.equal(p5user.row, 'user-stop');
  assert.equal(p5user.effects.start, false);
  assert.equal(p5user.effects.kill, false);
  assert.equal(p5user.memory.stubRepair, null);
  const p5linger = decide({
    lines: [],
    phase2: true,
    stopFlag: watcherFlag,
    heartbeat: { pid: 10, nonce: 'abc', stage: 'stopped', pass: 1 },
    stoppedForMs: 6 * 60 * 1000,
    cpuRatio: 0,
    children: [],
    lastLogLine: stamp(NOW, 'Safe Stop complete'),
  }, p5running.memory);
  assert.equal(p5linger.row, 'P2');
  assert.equal(p5linger.effects.kill, true);
  assert.equal(p5linger.effects.start, false);
  assert.equal(p5linger.memory.stubRepair && p5linger.memory.stubRepair.taskId, '123');
  const repaired = watcher.emptyMemory();
  repaired.stubRepair = { taskId: '123', line: 'x' };
  repaired.fixes = { 'P3:kept': [NOW] };
  const droppedRepair = watcher.forgetRun(repaired);
  assert.equal(droppedRepair.stubRepair, null);
  assert.deepEqual(droppedRepair.fixes, { 'P3:kept': [NOW] });
  assert.notEqual(decide({ lines: [stub, elig] }).row, 'P5');
  assert.notEqual(decide({
    lines: [
      stamp(NOW, 'REFUSING fresh fork of 123: branch agent-loop/task-a-123 already exists (2 commit(s) beyond main)'),
      elig, elig,
    ],
  }).row, 'P5');

  const buf = Buffer.from([stub, elig, elig].join('\n') + '\n');
  const firstChunk = watcher.readNewLog(buf, 0);
  assert.equal(decide({ lines: firstChunk.lines, nextOffset: firstChunk.nextOffset }).row, 'P5');
  const secondChunk = watcher.readNewLog(buf, firstChunk.nextOffset);
  assert.deepEqual(secondChunk.lines, []);
  assert.notEqual(decide({ lines: secondChunk.lines, nextOffset: secondChunk.nextOffset }).row, 'P5');

  const p6 = decide({
    lines: [stamp(NOW, 'REFUSING fresh fork of 123: satisfied blockers still carry unmerged branches')],
  });
  assert.equal(p6.row, 'P6');
  assert.equal(p6.response, 'NOTIFY');
  assert.ok(p6.report.includes('ancestry'));

  const p7 = decide({
    lines: [
      stamp(NOW, 'implement 123 "Task A" via grok (fixing) [isolated clone]'),
      stamp(NOW + 400, 'task branch missing for a fix → blocked'),
    ],
  });
  assert.equal(p7.row, 'P7');
  assert.equal(p7.response, 'NOTIFY');
  assert.notEqual(decide({
    lines: [
      stamp(NOW, 'implement 123 "Task A" via grok (fixing) [isolated clone]'),
      stamp(NOW + 5000, 'task branch missing for a fix → blocked'),
    ],
  }).row, 'P7');
  assert.notEqual(decide({
    lines: [stamp(NOW, 'task branch missing for a fix → blocked')],
  }).row, 'P7');

  const credit = 'HTTP 402 payment required';
  const p8notify = decide({
    lines: [
      stamp(NOW, 'probe grok: available'),
      stamp(NOW, 'probe claude: available'),
      stamp(NOW + 2000, '123 grok exited 1 → round 1/5'),
    ],
    coderLogText: credit,
  });
  assert.equal(p8notify.row, 'P8');
  assert.equal(p8notify.response, 'NOTIFY');
  const p8stop = decide({
    lines: [
      stamp(NOW, 'probe grok: available'),
      stamp(NOW, 'probe claude: unavailable'),
      stamp(NOW + 2000, '123 grok exited 1 → round 1/5'),
    ],
    coderLogText: 'balance exhausted',
  });
  assert.equal(p8stop.response, 'STOP');
  const p8explicit = decide({
    lines: [
      stamp(NOW, 'probe grok: available'),
      stamp(NOW + 2000, '123 grok exited 1 → round 1/5'),
    ],
    coderLogText: credit,
    onlyWorkingCoder: false,
  });
  assert.equal(p8explicit.response, 'NOTIFY');
  assert.notEqual(decide({
    lines: [
      stamp(NOW, 'probe grok: available'),
      stamp(NOW + 2000, '123 grok exited 1 → round 1/5'),
    ],
    coderLogText: 'ordinary crash',
  }).row, 'P8');
  const p8bench = decide({
    phase2: true,
    lines: [
      stamp(NOW, 'probe grok: available'),
      stamp(NOW, 'probe claude: available'),
      stamp(NOW + 2000, '123 grok exited 1 → round 1/5'),
    ],
    coderLogText: credit,
  });
  assert.equal(p8bench.action, 'bench_coder');
  assert.equal(p8bench.effects.notify, true);
  assert.equal(p8bench.coderName, 'grok');

  const shortWait = decide({
    now: atLocal(10, 5),
    lines: [stamp(atLocal(10, 0), 'claude unavailable: try again at 10:30 AM')],
  });
  assert.equal(shortWait.row, 'P9');
  assert.equal(shortWait.response, 'WAIT');
  const midnightSeen = new Date(2026, 9, 22, 23, 0, 0).getTime();
  const midnight = decide({
    now: midnightSeen + 5 * 60 * 1000,
    lines: [stamp(midnightSeen, 'probe codex: unavailable (quota/rate-limit): try again at 2:31 AM')],
  });
  assert.equal(midnight.row, 'P9');
  assert.equal(midnight.response, 'WAIT');
  assert.equal(midnight.action, 'wait');
  const escalated = decide({
    now: atLocal(10, 20),
    lines: [stamp(atLocal(9, 30), 'claude unavailable: try again at 10:00 AM')],
  });
  assert.equal(escalated.row, 'P9');
  assert.equal(escalated.response, 'STOP');
  assert.ok(escalated.report.includes('10:00 AM'));
  const longQuota = decide({
    lines: [stamp(NOW, 'claude unavailable: try again at Sep 22nd, 2026 7:49 PM')],
  });
  assert.equal(longQuota.response, 'STOP');
  assert.ok(longQuota.report.includes('Sep 22nd, 2026 7:49 PM'));
  assert.notEqual(decide({
    now: atLocal(10, 10),
    lines: [
      stamp(atLocal(10, 0), 'claude unavailable: try again at 10:30 AM'),
      stamp(atLocal(10, 2), 'probe claude: available'),
    ],
  }).row, 'P9');
  const quietWait = decide({
    now: atLocal(10, 5),
    lines: [stamp(atLocal(9, 30), 'claude unavailable: try again at 10:00 AM')],
  });
  assert.equal(quietWait.response, 'WAIT');
  const brokeQuiet = decide({
    now: atLocal(10, 12),
    lines: [stamp(atLocal(9, 30), 'claude unavailable: try again at 10:00 AM')],
  }, quietWait.memory);
  assert.equal(brokeQuiet.response, 'STOP');
  assert.equal(brokeQuiet.quiet, false);
  assert.equal(brokeQuiet.effects.writeStopFlag, true);

  const parked = {
    heartbeatAgeMs: 30_000,
    children: [{ name: 'powershell.exe' }],
    lines: [
      stamp(NOW, '123 on review left parked (Codex down; coded by grok)'),
      stamp(NOW, 'no ready task is eligible: 1 blocked by unfinished predecessors'),
    ],
  };
  const p10 = decide(parked);
  assert.equal(p10.row, 'P10');
  assert.equal(p10.response, 'WAIT');
  assert.equal(p10.effects.kill, false);
  const p10quiet = decide({ ...parked, now: NOW + 60_000 }, p10.memory);
  assert.equal(p10quiet.quiet, true);
  assert.notEqual(decide({ ...parked, heartbeatAgeMs: 5 * 60 * 1000 }).row, 'P10');

  const stopCoder = stamp(NOW, 'STOP: no coder available');
  const p11 = decide({ lines: [stopCoder, stopCoder, stopCoder] });
  assert.equal(p11.row, 'P11');
  assert.equal(p11.action, 'probe_coders');
  assert.equal(p11.probeMode, 'probe');
  assert.equal(p11.effects.writeStopFlag, true);
  assert.equal(p11.effects.start, false);
  assert.notEqual(decide({ lines: [stopCoder, stopCoder] }).row, 'P11');
  const runT0 = Date.parse('2026-10-22T10:00:00Z');
  const oldStops = [0, 70, 140].map(s => stamp(runT0 + s * 1000, 'STOP: no coder available'));
  const run1 = decide({
    now: runT0 + 200 * 1000,
    lines: oldStops,
    heartbeat: { pid: 4242, nonce: 'n1', stage: 'idle', pass: 1 },
    lock: { pid: 4242, nonce: 'n1' },
    pass: 1,
  });
  assert.equal(run1.row, 'P11');
  const run1Fixes = { 'P3:kept': [runT0] };
  run1.memory.fixes = run1Fixes;
  const restarted = decide({
    now: runT0 + 260 * 1000,
    lines: [stamp(runT0 + 260 * 1000, 'probe grok: available')],
    heartbeat: { pid: 5151, nonce: 'n2', stage: 'idle', pass: 1 },
    lock: { pid: 5151, nonce: 'n2' },
    pass: 1,
  }, run1.memory);
  assert.notEqual(restarted.row, 'P11');
  assert.equal(restarted.effects.writeStopFlag, false);
  assert.deepEqual(restarted.memory.fixes, run1Fixes);
  assert.notEqual(decide({
    now: runT0 + 300 * 1000,
    lines: [
      ...oldStops,
      stamp(runT0 + 250 * 1000, '=== start: watch=true task=(universal)'),
      stamp(runT0 + 260 * 1000, 'probe grok: available'),
    ],
  }).row, 'P11');
  assert.notEqual(decide({ now: runT0 + 20 * 60 * 1000, lines: oldStops }).row, 'P11');
  const keptFixes = watcher.emptyMemory();
  keptFixes.fixes = { 'P3:kept': [NOW] };
  keptFixes.keptLines = ['old'];
  keptFixes.errors = [{ sig: 'a', at: NOW }];
  const forgotten = watcher.forgetRun(keptFixes);
  assert.deepEqual(forgotten.fixes, { 'P3:kept': [NOW] });
  assert.deepEqual(forgotten.keptLines, []);
  assert.deepEqual(forgotten.errors, []);

  const t0 = NOW;
  const p12 = decide({
    lines: [
      stamp(t0, 'probe claude: available'),
      stamp(t0, 'review 123 via claude (10 diff lines vs main) [worktree]'),
      stamp(t0 + 1000, '123 claude unavailable (exit 1) → left in review'),
      stamp(t0 + 20_000, 'review 123 via claude (10 diff lines vs main) [worktree]'),
      stamp(t0 + 21_000, '123 claude unavailable (exit 1) → left in review'),
    ],
  });
  assert.equal(p12.row, 'P12');
  assert.equal(p12.probeMode, 'review');
  assert.equal(p12.effects.writeStopFlag, true);
  assert.notEqual(decide({
    lines: [
      stamp(t0, 'probe claude: available'),
      stamp(t0, 'review 123 via claude (10 diff lines vs main) [worktree]'),
      stamp(t0 + 30_000, '123 claude unavailable (exit 1)'),
      stamp(t0 + 40_000, 'review 123 via claude (10 diff lines vs main) [worktree]'),
      stamp(t0 + 80_000, '123 claude unavailable (exit 1)'),
    ],
  }).row, 'P12');

  const p13fast = decide({
    lines: [
      stamp(t0, '123 verify: npm test @ abcdef12'),
      stamp(t0 + 1000, '123 verify FAILED (round 1/3)'),
      stamp(t0 + 20_000, '123 verify: npm test @ abcdef12'),
      stamp(t0 + 21_000, '123 verify FAILED (round 2/3)'),
    ],
  });
  assert.equal(p13fast.row, 'P13');
  assert.equal(p13fast.response, 'STOP');
  const cycle = [
    stamp(t0, '123 verify FAILED (round 1/3)'),
    stamp(t0 + 60_000, '123 verify FAILED (round 2/3)'),
    stamp(t0 + 120_000, '123 verify FAILED (round 3/3)'),
  ];
  assert.equal(decide({ lines: cycle, commitCounts: { '123': [4, 4, 4] } }).row, 'P13');
  assert.notEqual(decide({ lines: cycle, commitCounts: { '123': [4, 5, 6] } }).row, 'P13');
  assert.notEqual(decide({ lines: cycle }).row, 'P13');
  const sampled = watcher.appendCommitCounts(null, cycle, () => 4);
  assert.deepEqual(sampled, { '123': [4, 4, 4] });
  assert.equal(decide({ lines: cycle, commitCounts: sampled }).row, 'P13');
  assert.deepEqual(watcher.appendCommitCounts(sampled, [stamp(t0, '123 verify FAILED (round 4/3)')], () => 4)['123'], [4, 4, 4, 4]);
  assert.deepEqual(watcher.appendCommitCounts({}, cycle, () => null), {});
  const countedMem = watcher.emptyMemory();
  countedMem.commitCounts = { '123': [4, 4, 4] };
  countedMem.fixes = { 'P3:kept': [NOW] };
  const droppedCounts = watcher.forgetRun(countedMem);
  assert.deepEqual(droppedCounts.commitCounts, {});
  assert.deepEqual(droppedCounts.fixes, { 'P3:kept': [NOW] });

  const turns = [
    stamp(t0, '123 grok exited 1 (max turns reached) → round 1/5'),
    stamp(t0 + 1000, '123 grok exited 1 (max turns reached) → round 2/5'),
  ];
  const p14 = decide({ lines: turns });
  assert.equal(p14.row, 'P14');
  assert.equal(p14.response, 'NOTIFY');
  assert.ok(p14.report.includes('AGENT_LOOP_MAX_TURNS'));
  assert.notEqual(decide({ lines: turns, commitsGrew: { '123': true } }).row, 'P14');

  const scope = stamp(NOW, '123 Claude re-scope diagnosis');
  assert.equal(decide({ lines: [scope, stamp(NOW + 1000, '123 Claude re-scope diagnosis')] }).response, 'NOTIFY');
  assert.equal(decide({
    lines: [scope, stamp(NOW + 1000, '123 Claude re-scope diagnosis'), stamp(NOW + 2000, '123 Claude re-scope diagnosis')],
  }).response, 'STOP');
  assert.notEqual(decide({
    lines: [
      stamp(NOW - 25 * 60 * 60 * 1000, '123 Claude re-scope diagnosis'),
      stamp(NOW - 25 * 60 * 60 * 1000 + 1000, '123 Claude re-scope diagnosis'),
    ],
  }).row, 'P15');

  const p16 = decide({
    configuredSeedCount: 2,
    lines: [
      stamp(NOW, '=== start: watch'),
      stamp(NOW, 'seed skipped: tests/a does not exist in primary'),
      stamp(NOW, 'seed skipped: tests/b does not exist in primary'),
    ],
  });
  assert.equal(p16.row, 'P16');
  assert.equal(p16.response, 'STOP');
  const branched = decide({
    configuredSeedCount: 1,
    lines: [
      stamp(NOW, '=== start: watch'),
      stamp(NOW, 'seed skipped: tests/a does not exist in primary'),
      stamp(NOW, 'implement 123 "Task A" via grok [isolated clone]'),
    ],
  });
  assert.equal(branched.row, 'P16');
  assert.ok(branched.report.includes('branch was created'));
  assert.notEqual(decide({
    configuredSeedCount: 2,
    lines: [
      stamp(NOW, '=== start: watch'),
      stamp(NOW, 'seed skipped: tests/a does not exist in primary'),
    ],
  }).row, 'P16');
  assert.notEqual(decide({
    configuredSeedCount: 2,
    lines: [
      stamp(NOW, '=== start: watch'),
      stamp(NOW, 'seed skipped: tests/a does not exist in primary'),
      stamp(NOW, 'seed skipped: tests/a does not exist in primary'),
    ],
  }).row, 'P16');
  assert.notEqual(decide({
    configuredSeedCount: 1,
    lines: [
      stamp(NOW, '=== start: watch'),
      stamp(NOW, 'verify seed skipped: tests/a does not exist in primary'),
    ],
  }).row, 'P16');
  assert.notEqual(decide({
    lines: [
      stamp(NOW, '=== start: watch'),
      stamp(NOW, 'seed skipped: tests/a does not exist in primary'),
    ],
  }).row, 'P16');

  const idleKill = stamp(NOW, '123 grok phase: first-write 1:00 last-write 2:00 wall 2:10 killed-idle');
  const p17 = decide({
    coderActiveBeforeKill: true,
    lines: [idleKill, stamp(NOW + 1000, '123 grok phase: first-write 1:00 last-write 2:00 wall 2:10 killed-idle')],
  });
  assert.equal(p17.row, 'P17');
  assert.equal(p17.response, 'NOTIFY');
  assert.ok(p17.report.includes('AGENT_LOOP_IMPLEMENT_IDLE_S'));
  assert.notEqual(decide({ coderActiveBeforeKill: false, lines: [idleKill, idleKill] }).row, 'P17');
  assert.notEqual(decide({ coderActiveBeforeKill: true, lines: [idleKill] }).row, 'P17');

  assert.equal(
    watcher.taskOf('task1 grok phase: first-write 0m10s last-write 39m37s post-write 0m23s wall 40m00s killed-ceiling'),
    'task1',
  );
  const ceilingPair = (ms, id, coder = 'grok') => [
    stamp(ms, `✖ ${coder} implement ${id}: [agent-loop] TIMEOUT after 40m00s (ceiling) — killed process tree of pid 9`),
    stamp(ms + 1, `${id} ${coder} phase: first-write 0m10s last-write 39m37s post-write 0m23s wall 40m00s killed-ceiling`),
  ];
  const p19 = decide({ lines: [...ceilingPair(NOW - 2000, 'task1'), ...ceilingPair(NOW - 1000, 'task1')] });
  assert.equal(p19.row, 'P19');
  assert.equal(p19.response, 'NOTIFY');
  assert.equal(p19.action, 'wait');
  assert.equal(p19.effects.notify, true);
  assert.equal(p19.effects.kill, false);
  assert.equal(p19.effects.resetStub, false);
  assert.equal(p19.effects.bench, false);
  assert.ok(p19.report.includes('2 times'));
  assert.ok(p19.report.includes('do not count toward the round limit'));
  assert.ok(p19.report.includes('AGENT_LOOP_IMPLEMENT_TIMEOUT_S'));
  assert.notEqual(decide({ lines: ceilingPair(NOW, 'task1') }).row, 'P19');
  assert.notEqual(decide({
    lines: [...ceilingPair(NOW - 1000, 'task1'), ...ceilingPair(NOW, 'task2')],
  }).row, 'P19');
  assert.notEqual(decide({
    lines: [
      stamp(NOW, 'task1 grok phase: first-write 1:00 last-write 2:00 wall 2:10 killed-idle'),
      stamp(NOW + 1000, 'task1 grok phase: first-write 1:00 last-write 2:00 wall 2:10 killed-idle'),
    ],
  }).row, 'P19');
  assert.notEqual(decide({
    lines: [...ceilingPair(NOW - 25 * 60 * 60 * 1000, 'task1'), ...ceilingPair(NOW, 'task1')],
  }).row, 'P19');
  const p19Again = decide({ lines: [] }, p19.memory);
  assert.equal(p19Again.row, 'P19');
  assert.equal(p19Again.effects.notify, false);
  const p19Other = decide({
    lines: [...ceilingPair(NOW - 500, 'task2'), ...ceilingPair(NOW, 'task2')],
  }, p19.memory);
  assert.equal(p19Other.row, 'P19');
  assert.equal(p19Other.signature, 'P19:task2');
  assert.equal(p19Other.effects.notify, true);
  assert.equal(decide({
    lines: [...ceilingPair(NOW - 1000, 'task1', 'claude'), ...ceilingPair(NOW, 'task1', 'claude')],
  }).row, 'P19');
  assert.equal(decide({
    lines: [...ceilingPair(NOW - 1000, 'task1', 'codex'), ...ceilingPair(NOW, 'task1', 'codex')],
  }).row, 'P19');

  const userStop = decide({
    ...wedge(),
    stopFlag: 'requested 2026-10-22T11:00:00.000Z from the Agent Loop button\n',
  });
  assert.equal(userStop.row, 'P1');
  assert.equal(userStop.effects.kill, true);
  assert.equal(userStop.effects.start, false);
  assert.equal(userStop.effects.clearStop, false);
  assert.equal(userStop.effects.clearLock, true);
  assert.equal(userStop.effects.writeStopFlag, false);
  const userQuiet = decide({
    stopFlag: 'requested 2026-10-22T11:00:00.000Z from the Agent Loop button\n',
  });
  assert.equal(userQuiet.row, 'user-stop');
  assert.equal(userQuiet.effects.kill, false);
  assert.equal(userQuiet.effects.start, false);
  const watcherWedge = decide({
    ...wedge(),
    stopFlag: watcher.watcherStopText(new Date(NOW)),
  });
  assert.equal(watcherWedge.row, 'watcher-stop');
  assert.equal(watcherWedge.effects.kill, false);
  const watcherStop = decide({
    stopFlag: watcher.watcherStopText(new Date(NOW)),
    lockExists: true,
    lockPidAlive: false,
  });
  assert.equal(watcherStop.row, 'watcher-stop');
  assert.equal(watcherStop.effects.start, false);
  assert.equal(watcherStop.effects.clearLock, false);
  const userLinger = decide({
    stopFlag: 'requested 2026-10-22T11:00:00.000Z from the Agent Loop button\n',
    heartbeat: { pid: 10, nonce: 'abc', stage: 'stopped', pass: 1 },
    stoppedForMs: 6 * 60 * 1000,
    cpuRatio: 0.01,
    children: [],
    lastLogLine: stamp(NOW, 'Safe Stop complete: tree clean'),
  });
  assert.equal(userLinger.row, 'P2');
  assert.equal(userLinger.effects.kill, true);
  assert.equal(userLinger.effects.start, false);

  const frozen = {
    heartbeat: { pid: 10, nonce: 'abc', stage: 'idle', pass: 1 },
    heartbeatAgeMs: 1_300_000,
    cpuRatio: null,
    ioUnchanged: null,
    children: null,
    claudeMode: 'full',
  };
  const ask = decide(frozen);
  assert.equal(ask.row, 'P18');
  assert.equal(ask.needsClaude, true);
  assert.equal(ask.bundle.rounds, null);
  assert.ok(ask.bundle.allowlist.some(item => item.id === 'stop_and_report'));
  const withRounds = decide({ ...frozen, rounds: { 'task-a': 2, 'rescope:task-a': 1 } });
  assert.deepEqual(withRounds.bundle.rounds, { 'task-a': 2, 'rescope:task-a': 1 });
  const down = decide(frozen, watcher.emptyMemory(), { unavailable: true, why: 'timeout' });
  assert.equal(down.action, 'stop_and_report');
  assert.ok(down.report.includes('unavailable'));
  assert.ok(down.report.includes('timeout'));
  assert.equal(decide(frozen, watcher.emptyMemory(), { text: 'not json' }).action, 'stop_and_report');
  assert.equal(decide(frozen, watcher.emptyMemory(), {
    text: '{"diagnosis":"x","action":"rm_rf","confidence":0.99,"why":"y","human_fix":"z"}',
  }).action, 'stop_and_report');
  assert.equal(decide(frozen, watcher.emptyMemory(), {
    text: '{"diagnosis":"x","action":"wait","confidence":0.4,"why":"y","human_fix":"z"}',
  }).action, 'stop_and_report');
  const waited = decide(frozen, watcher.emptyMemory(), {
    text: '{"diagnosis":"cooling down","action":"wait","confidence":0.91,"why":"short","human_fix":"leave it"}',
  });
  assert.equal(waited.action, 'wait');
  assert.ok(waited.report.includes('leave it'));
  const rejected = decide(frozen, watcher.emptyMemory(), {
    text: '{"diagnosis":"stale","action":"clear_stale_lock","confidence":0.95,"why":"lock","human_fix":"delete"}',
  });
  assert.equal(rejected.action, 'stop_and_report');
  assert.ok(rejected.refused);
  const playbookOnly = decide({ ...frozen, claudeMode: 'playbook' });
  assert.equal(playbookOnly.needsClaude, false);
  assert.equal(playbookOnly.action, 'stop_and_report');
  assert.ok(playbookOnly.report.includes('not on PATH'));
  const cappedMem = watcher.emptyMemory();
  cappedMem.claudeCalls = [NOW - 1, NOW - 2, NOW - 3, NOW - 4];
  const capped = decide(frozen, cappedMem);
  assert.equal(capped.needsClaude, false);
  assert.ok(capped.report.includes('hourly'));

  let repeats = watcher.emptyMemory();
  let repeated;
  for (let i = 0; i < 3; i++) {
    repeated = decide({
      lines: [stamp(NOW + i * 1000, `FATAL disk full on the runner ${i}`)],
      heartbeatAgeMs: 1000,
      claudeMode: 'full',
    }, repeats, { unavailable: true, why: 'timeout' });
    repeats = repeated.memory;
  }
  assert.equal(repeated.row, 'P18');
  assert.equal(repeated.response, 'NOTIFY');
  assert.notEqual(repeated.action, 'stop_and_report');
  let twice = watcher.emptyMemory();
  let notYet;
  for (let i = 0; i < 2; i++) {
    notYet = decide({
      lines: [stamp(NOW, 'FATAL disk full on the runner 7')],
      heartbeatAgeMs: 1000,
    }, twice);
    twice = notYet.memory;
  }
  assert.equal(notYet.row, null);

  const again = decide({ lines: [stub, elig, elig] }, p5.memory);
  assert.equal(again.effects.notify, false);
  assert.equal(again.row, 'P5');

  const exe = process.execPath.includes(' ') ? `"${process.execPath}"` : process.execPath;
  const echoed = await watcher.spawnCaptured(
    `${exe} -e "process.stdin.pipe(process.stdout)"`,
    { input: 'hello pk_123456_ABC', timeoutMs: 15_000 },
  );
  assert.equal(echoed.ok, true, echoed.why || echoed.err);
  assert.ok(echoed.text.includes('hello'));
  assert.ok(echoed.text.includes('pk_[redacted]'));
  assert.equal(echoed.text.includes('pk_123456'), false);
  const quotaAnswer = JSON.stringify({
    diagnosis: 'reviewer quota reached', action: 'wait', confidence: 0.9, why: 'quota', human_fix: 'wait',
  });
  const quotaReply = await watcher.spawnCaptured(
    `${exe} -e "process.stdin.pipe(process.stdout)"`,
    { input: quotaAnswer, timeoutMs: 15_000 },
  );
  assert.equal(quotaReply.ok, true, quotaReply.why || quotaReply.err);
  assert.equal(quotaReply.unavailable, false);
  const quotaFail = await watcher.spawnCaptured(
    `${exe} -e "console.error('quota exceeded'); process.exit(1)"`,
    { timeoutMs: 15_000 },
  );
  assert.equal(quotaFail.ok, false);
  assert.equal(quotaFail.unavailable, true);
  assert.ok(String(quotaFail.why).toLowerCase().includes('quota'));

  const groupCalls = [];
  const groupKill = watcher.killProcessTree(42, {
    platform: 'linux',
    kill(target) {
      groupCalls.push(target);
      if (target < 0) {
        const err = new Error('no group');
        err.code = 'ESRCH';
        throw err;
      }
    },
  });
  assert.deepEqual(groupCalls, [-42, 42]);
  assert.equal(groupKill.ok, true);
  assert.equal(groupKill.detail, 'killed pid');
  assert.equal(watcher.settleKill({
    requested: true, identityOk: true, stillAlive: true, detail: 'taskkill exit 1',
  }).proceed, false);
  assert.equal(watcher.settleKill({ requested: true, identityOk: false, stillAlive: false }).proceed, false);
  assert.equal(watcher.settleKill({ requested: true, identityOk: true, stillAlive: false }).proceed, true);
  let polls = 0;
  assert.equal(await watcher.waitUntilDead(5, {
    alive: () => ++polls < 3,
    wait: async () => {},
    timeoutMs: 1000,
    stepMs: 1,
  }), true);
  assert.equal(await watcher.waitUntilDead(5, {
    alive: () => true,
    wait: async () => {},
    timeoutMs: 0,
  }), false);

  const started = watcher.notableEvents({
    lines: [stamp(NOW, '… grok implement task1 0:30/20:00 idle 0:10/8:00')],
  });
  assert.equal(started.events.length, 1);
  assert.equal(started.events[0].kind, 'stage');
  assert.equal(started.events[0].stage, 'implement');
  assert.equal(started.events[0].taskId, 'task1');
  const repeatedTick = watcher.notableEvents({
    lines: [stamp(NOW + 1000, '… grok implement task1 1:00/20:00 idle 0:01/8:00')],
    previous: started.state,
  });
  assert.equal(repeatedTick.events.length, 0);
  const moved = watcher.notableEvents({
    lines: [
      stamp(NOW, 'task1 → coding'),
      stamp(NOW, 'task1 codex=pass'),
      stamp(NOW, 'task1 Claude adjudication=fail'),
      stamp(NOW, 'task1 grok phase: wall 40m00s killed-ceiling'),
    ],
  });
  assert.deepEqual(moved.events.map(event => event.kind), ['status', 'verdict', 'verdict', 'kill']);
  const fromHeartbeat = watcher.notableEvents({
    heartbeat: { stage: 'verify' },
    previous: { stage: 'implement', stageTask: 'task1' },
  });
  assert.equal(fromHeartbeat.events.length, 1);
  assert.equal(fromHeartbeat.events[0].text, 'task1 stage verify');

  const stageEvent = { kind: 'stage', text: 'task1 stage implement' };
  const rowEvent = {
    kind: 'playbook', row: 'P19', title: 'Implementation ceiling repeat',
    fixed: 'Split the task.', text: 'P19',
  };
  const heldBatch = watcher.planNarration({
    mode: 'events', now: NOW, minMs: 300000, lastSentAt: NOW - 1000,
    incoming: [stageEvent], calls: [],
  });
  assert.equal(heldBatch.send, false);
  assert.equal(heldBatch.reason, 'rate');
  assert.equal(heldBatch.pending.length, 1);
  const flushed = watcher.planNarration({
    mode: 'events', now: NOW, minMs: 300000, lastSentAt: NOW - 300000,
    pending: heldBatch.pending, incoming: [], calls: [],
  });
  assert.equal(flushed.send, true);
  assert.equal(flushed.reason, 'batch');
  const immediate = watcher.planNarration({
    mode: 'problems', now: NOW, minMs: 300000, lastSentAt: NOW - 1000,
    incoming: [rowEvent, stageEvent], calls: [],
  });
  assert.equal(immediate.send, true);
  assert.ok(immediate.items.some(item => item.kind === 'playbook'));
  assert.ok(!immediate.items.some(item => item.kind === 'stage'));
  const overBudget = watcher.planNarration({
    mode: 'events', now: NOW, maxCalls: 4,
    calls: [NOW - 1, NOW - 2, NOW - 3, NOW - 4], incoming: [rowEvent],
  });
  assert.equal(overBudget.send, false);
  assert.equal(overBudget.reason, 'budget');
  assert.equal(overBudget.pending.length, 0);
  assert.ok(overBudget.channelLine);
  const overflow = watcher.planNarration({
    mode: 'events', now: NOW, minMs: 300000, lastSentAt: NOW,
    incoming: Array.from({ length: 40 }, (_, i) => ({ kind: 'status', text: `task1 → s${i}` })),
  });
  assert.equal(overflow.send, false);
  assert.equal(overflow.pending.length, watcher.NARRATION_PENDING_CAP);
  assert.equal(overflow.pending[overflow.pending.length - 1].text, 'task1 → s39');

  assert.equal(watcher.sessionChangedByOther(null, { exists: true, size: 1, mtimeMs: 1 }), false);
  assert.equal(watcher.sessionChangedByOther(
    { size: 1, mtimeMs: 1 }, { exists: true, size: 1, mtimeMs: 1 },
  ), false);
  assert.equal(watcher.sessionChangedByOther(
    { size: 1, mtimeMs: 1 }, { exists: true, size: 2, mtimeMs: 1 },
  ), true);
  assert.equal(watcher.sessionChangedByOther({ size: 1, mtimeMs: 1 }, { exists: false }), true);

  const narrArgs = watcher.narrationArgs();
  assert.ok(!narrArgs.includes('--no-session-persistence'));
  assert.ok(!narrArgs.includes('--bare'));
  assert.equal(narrArgs[narrArgs.indexOf('--tools') + 1], '');
  assert.equal(narrArgs[narrArgs.indexOf('--permission-prompts') + 1], 'none');
  const stripped = watcher.narrationArgs([...watcher.DEFAULT_CLAUDE_ARGS, '--bare']);
  assert.ok(!stripped.includes('--bare'));
  assert.ok(!stripped.includes('--no-session-persistence'));
  const sessionArg = '00000000-0000-4000-8000-000000000001';
  const createdCmd = watcher.narrationCommand({ sessionId: sessionArg });
  assert.ok(createdCmd.includes('--session-id'));
  assert.ok(!createdCmd.includes('--resume'));
  assert.ok(!createdCmd.includes('--bare'));
  const resumedCmd = watcher.narrationCommand({ sessionId: sessionArg, resume: true });
  assert.ok(resumedCmd.includes('--resume'));
  assert.ok(!resumedCmd.includes('--no-session-persistence'));
  const firstPrompt = watcher.narrationPrompt([rowEvent], { first: true });
  assert.ok(firstPrompt.includes('watcher narrator'));
  assert.ok(firstPrompt.includes('Do not invent'));
  assert.ok(firstPrompt.includes('P19'));
  assert.ok(firstPrompt.includes('Split the task.'));
  assert.equal(watcher.narrationPrompt([{ text: 'task1 → coding' }], { first: false }), 'task1 → coding');

  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-session-'));
  try {
    const projectDir = path.join(sessionRoot, 'slug');
    fs.mkdirSync(projectDir);
    fs.writeFileSync(path.join(projectDir, `${sessionArg}.jsonl`), 'x\n');
    const stat = watcher.findSessionStat(sessionRoot, sessionArg);
    assert.equal(stat.exists, true);
    assert.equal(stat.size, 2);
    assert.equal(watcher.findSessionStat(sessionRoot, '00000000-0000-4000-8000-000000000002').exists, false);
  } finally {
    fs.rmSync(sessionRoot, { recursive: true, force: true });
  }
}

watcherChecks().then(() => {
  console.log('agent-loop selftest: OK');
}).catch(err => {
  console.error(err);
  process.exit(1);
});
