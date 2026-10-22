// Agent Loop — thin launcher for the dispatcher (agent-loop.mjs, bundled next to this file).
// ONE universal button (status bar, bottom-left): starts the self-routing dispatcher in
// --watch, or stops it if already running. There are no modes or reviewer choices — the
// dispatcher senses which of Claude/Codex/Grok are available each pass and routes itself.
//
// The dispatcher ships INSIDE the extension rather than being read out of the open repo. That is
// not just for portability: the dispatcher git-checks-out task branches as it works, so a copy
// living in the working tree could be swapped out from under a relaunch. The extension's install
// directory is outside every repo, so no branch checkout can ever touch it.
const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const setup = require('./setup.js');
const watcher = require('./watcher.js');

const TERMINAL_NAME = 'Agent Loop';
const DISPATCHER = path.join(__dirname, 'agent-loop.mjs');
const CONFIG_EXAMPLE = path.join(__dirname, '..', 'agent-loop.env.example');
const PKG = require('../package.json');
// Non-secret keys only. CLICKUP_TOKEN and other credentials stay out of the extension host.
const STATE_ENV_KEYS = new Set([
  'AGENT_LOOP_LOCK', 'AGENT_LOOP_STOP', 'AGENT_LOOP_STOP_REPORT', 'AGENT_LOOP_LOG',
  'AGENT_LOOP_HEARTBEAT_FILE', 'AGENT_LOOP_UNSAFE', 'AGENT_LOOP_BENCH_FILE', 'AGENT_LOOP_ROUNDS',
  'AGENT_LOOP_WATCHER', 'AGENT_LOOP_WATCHER_CMD', 'AGENT_LOOP_WATCHER_POLL_S',
  'AGENT_LOOP_WATCHER_MAX_FIXES', 'AGENT_LOOP_WATCHER_MAX_CALLS_PER_H',
  'AGENT_LOOP_WATCHER_REPORT', 'AGENT_LOOP_WATCHER_LOG', 'AGENT_LOOP_WATCHER_STATE',
  'AGENT_LOOP_WATCHER_CODER_LOGS', 'AGENT_LOOP_IMPLEMENT_TIMEOUT_S',
  'AGENT_LOOP_REVIEW_TIMEOUT_S', 'AGENT_LOOP_VERIFY_TIMEOUT_S', 'AGENT_LOOP_VERIFY_SEED_DIRS',
]);

// Read only the three state-path settings from the same env file as the dispatcher. Do not load
// CLICKUP_TOKEN into the extension host: the launcher never needs that secret.
function loadStateEnv(baseEnv = process.env, home = os.homedir(), fsApi = fs) {
  const result = {};
  for (const key of STATE_ENV_KEYS) if (baseEnv[key]) result[key] = baseEnv[key];
  const candidates = [baseEnv.AGENT_LOOP_ENV, path.join(home, '.agent-loop.env')].filter(Boolean);
  for (const file of candidates) {
    try {
      if (!fsApi.existsSync(file)) continue;
      for (const line of fsApi.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (m && STATE_ENV_KEYS.has(m[1]) && !result[m[1]]) {
          result[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
      }
      break;
    } catch { /* unreadable env file → dispatcher will surface its own config error */ }
  }
  return result;
}

function resolveStatePaths(env, home = os.homedir()) {
  const statePath = (configured, fallback) => configured ? path.resolve(home, configured) : path.join(home, fallback);
  return {
    lock: statePath(env.AGENT_LOOP_LOCK, '.agent-loop.lock'),
    stop: statePath(env.AGENT_LOOP_STOP, '.agent-loop.stop'),
    report: statePath(env.AGENT_LOOP_STOP_REPORT, '.agent-loop-stop-report.md'),
    log: statePath(env.AGENT_LOOP_LOG, '.agent-loop.log'),
    heartbeat: statePath(env.AGENT_LOOP_HEARTBEAT_FILE, '.agent-loop-heartbeat.json'),
    unsafe: statePath(env.AGENT_LOOP_UNSAFE, '.agent-loop.unsafe'),
    bench: statePath(env.AGENT_LOOP_BENCH_FILE, '.agent-loop-bench.json'),
    rounds: statePath(env.AGENT_LOOP_ROUNDS, '.agent-loop-rounds.json'),
    watcherReport: statePath(env.AGENT_LOOP_WATCHER_REPORT, '.agent-loop-watcher-report.md'),
    watcherLog: statePath(env.AGENT_LOOP_WATCHER_LOG, '.agent-loop-watcher.log'),
    watcherState: statePath(env.AGENT_LOOP_WATCHER_STATE, '.agent-loop-watcher-state.json'),
  };
}

function childEnv(cwd, paths) {
  return {
    AGENT_LOOP_REPO: cwd,
    AGENT_LOOP_LOCK: paths.lock,
    AGENT_LOOP_STOP: paths.stop,
    AGENT_LOOP_STOP_REPORT: paths.report,
    AGENT_LOOP_LOG: paths.log,
    AGENT_LOOP_HEARTBEAT_FILE: paths.heartbeat,
    AGENT_LOOP_UNSAFE: paths.unsafe,
    AGENT_LOOP_BENCH_FILE: paths.bench,
    AGENT_LOOP_ROUNDS: paths.rounds,
  };
}

// Re-resolved on every use: the setup wizard can rewrite the env file mid-session, and a value
// frozen at activation would leave the button watching a lock the dispatcher no longer writes.
const statePaths = () => resolveStatePaths(loadStateEnv());
const lockFile = () => statePaths().lock;
const stopFile = () => statePaths().stop;
const reportFile = () => statePaths().report;
const INCOMPLETE_LOCK_GRACE_MS = 10_000;
const UNKNOWN_IDENTITY_GRACE_MS = 10 * 60_000;

let statusItem, poller, activeTerminal;

// The lock — not the terminal — tells us whether the loop is running, because a terminal outlives
// the node process it launched. But EXISTENCE is not liveness: a force-stop or crash skips the
// dispatcher's exit handler and leaves the file behind, which used to pin the button on
// "running"/"stopping" forever with no way back. So validate the PID inside it.
function parseLockRecord(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const pid = Number(text);
    return Number.isSafeInteger(pid) && pid > 0 ? { pid, nonce: null } : null;
  }
  try {
    const parsed = JSON.parse(text);
    if (!Number.isSafeInteger(parsed?.pid) || parsed.pid <= 0) return null;
    return { pid: parsed.pid, nonce: typeof parsed.nonce === 'string' ? parsed.nonce : null };
  } catch { return null; }
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }       // EPERM = exists but not ours to signal
}
function pidIdentity(pid) {
  try {
    if (process.platform === 'win32') {
      const out = cp.execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      if (!out.trim()) return 'unknown';
      return /agent-loop/i.test(out) ? 'yes' : 'no';
    }
    const out = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return /agent-loop/i.test(out) ? 'yes' : 'no';
  } catch { return 'unknown'; }
}
function lockLooksLive({ record, ageMs, pidAlive: ownerAlive, identity }) {
  // An empty/partial record can exist for a moment between exclusive create and write. It must not
  // be treated as running forever if the writer crashes in that window.
  if (!record) return ageMs < INCOMPLETE_LOCK_GRACE_MS;
  if (!ownerAlive) return false;
  if (ageMs < INCOMPLETE_LOCK_GRACE_MS) return true;
  if (identity === 'yes') return true;
  if (identity === 'no') return false;
  // On a platform where command-line inspection is unavailable, the dispatcher's heartbeat is the
  // fallback. Once that has been absent for the same 10-minute floor as the runner, self-heal.
  return ageMs < UNKNOWN_IDENTITY_GRACE_MS;
}
// Removes lock/stop files left by a dead dispatcher, so the button recovers by itself.
// Only delete if the on-disk lock still matches the stale record we inspected — a live dispatcher
// can reclaim the path between our PID check and unlink (audit: extension stale-lock race). The
// comparison is on the raw bytes rather than the parsed record: two different writes that happen to
// parse to the same pid/nonce are still different owners, and byte equality is the stricter test.
// Rename-then-unlink is closer to CAS than compare+unlink: between compare and unlink another
// owner could install a new lock; rename either moves our observed content or fails.
function clearStaleFiles(observedRaw) {
  const LOCK_FILE = lockFile(), STOP_FILE = stopFile();
  const expected = String(observedRaw ?? '');
  let current;
  try {
    current = fs.readFileSync(LOCK_FILE, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      try { fs.unlinkSync(STOP_FILE); } catch { /* gone */ }
    }
    return;
  }
  if (current !== expected) return;
  const tomb = `${LOCK_FILE}.clearing-${process.pid}-${Date.now()}`;
  try {
    fs.renameSync(LOCK_FILE, tomb);
  } catch {
    return; // lost the race to another writer/reclaimer
  }
  try {
    if (fs.readFileSync(tomb, 'utf8') !== expected) {
      try { fs.renameSync(tomb, LOCK_FILE); } catch { /* best effort restore */ }
      return;
    }
  } catch { /* tomb unreadable — still remove it */ }
  try { fs.unlinkSync(tomb); } catch { /* gone */ }
  try { fs.unlinkSync(STOP_FILE); } catch { /* gone */ }
}
function isRunning() {
  let raw, ageMs;
  const LOCK_FILE = lockFile();   // resolve once: the env file can change between calls
  try {
    raw = fs.readFileSync(LOCK_FILE, 'utf8');
    ageMs = Math.max(0, Date.now() - fs.statSync(LOCK_FILE).mtimeMs);
  } catch (e) {
    return e.code !== 'ENOENT';                        // unreadable is fail-safe: do not double-start
  }
  const record = parseLockRecord(raw);
  const ownerAlive = !!record && pidAlive(record.pid);
  const identity = ownerAlive && ageMs >= INCOMPLETE_LOCK_GRACE_MS
    ? pidIdentity(record.pid)
    : 'unknown';
  if (lockLooksLive({ record, ageMs, pidAlive: ownerAlive, identity })) return true;
  clearStaleFiles(raw);
  return false;
}
// Only meaningful while something is actually running; a stop flag with no live dispatcher is stale.
const isStopping = () => fs.existsSync(stopFile()) && isRunning();

function repoRoot() {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length ? folders[0].uri.fsPath : undefined;
}

function findTerminal() {
  return pickTerminal(vscode.window.terminals, activeTerminal);
}

function pickTerminal(terminals, preferred) {
  if (preferred && terminals.includes(preferred)) return preferred;
  return [...terminals].reverse().find(t => t.name === TERMINAL_NAME);
}

function start() {
  const cwd = repoRoot();
  if (!cwd) { vscode.window.showErrorMessage('Agent Loop: open a project folder first.'); return; }
  if (!fs.existsSync(path.join(cwd, '.git'))) {
    vscode.window.showErrorMessage('Agent Loop: this folder is not a git repository — the dispatcher works on task branches.');
    return;
  }
  if (!fs.existsSync(DISPATCHER)) {
    vscode.window.showErrorMessage(`Agent Loop: the bundled dispatcher is missing (${DISPATCHER}). Reinstall the extension.`);
    return;
  }
  const paths = statePaths();
  try { fs.unlinkSync(paths.stop); } catch { /* no stale Safe Stop flag → nothing to clear */ }
  // AGENT_LOOP_REPO pins the dispatcher to this repo regardless of where the runner itself lives.
  const term = vscode.window.createTerminal({
    name: TERMINAL_NAME,
    cwd,
    // Pin the resolved paths into the child so the extension and dispatcher cannot diverge even when
    // the settings came from ~/.agent-loop.env rather than the extension host's process environment.
    env: childEnv(cwd, paths),
  });
  activeTerminal = term;
  term.show();
  term.sendText(`node "${DISPATCHER}" --watch`);
  armWatcher();
  render();
}

// Cooperative stop: the dispatcher finishes the round it is in, writes a handover report and exits
// with the tree and board consistent. Use this when you need the repo for something urgent.
function safeStop() {
  if (!isRunning()) { vscode.window.showInformationMessage('Agent Loop: not running.'); render(); return; }
  try {
    fs.writeFileSync(stopFile(), `requested ${new Date().toISOString()} from the Agent Loop button\n`);
  } catch (e) {
    vscode.window.showErrorMessage(`Agent Loop: could not request a safe stop (${e.message}).`);
    return;
  }
  const term = findTerminal();
  if (term) term.show();
  vscode.window.showInformationMessage(
    'Agent Loop: safe stop requested — it will finish the current round (up to ~15 min), write a handover report, then exit. Watch the terminal.');
  render();
}

// Escape hatch: kills the terminal immediately. Can leave a task mid-implement (the next start
// recovers `coding` to review when commits exist, otherwise ready), so it is a command, not default.
function recoverUnsafeStop() {
  const cwd = repoRoot();
  if (!cwd) { vscode.window.showErrorMessage('Agent Loop: open a project folder first.'); return; }
  if (!fs.existsSync(DISPATCHER)) {
    vscode.window.showErrorMessage(`Agent Loop: the bundled dispatcher is missing (${DISPATCHER}). Reinstall the extension.`);
    return;
  }
  const paths = statePaths();
  const term = vscode.window.createTerminal({
    name: TERMINAL_NAME,
    cwd,
    env: childEnv(cwd, paths),
  });
  activeTerminal = term;
  term.show();
  term.sendText(`node "${DISPATCHER}" --recover`);
}

function forceStop() {
  const term = findTerminal();
  if (!term) {
    vscode.window.showErrorMessage('Agent Loop: could not find the live terminal. Use the PID shown in the lock file to stop it manually.');
    return;
  }
  term.dispose();
  // Deliberately NOT deleting the lock here: disposing the terminal kills the process asynchronously,
  // so removing its lock straight away could let a new instance start alongside a dying one. The
  // poller's isRunning() cleans up within ~3s, but only once the PID is provably gone.
  vscode.window.showWarningMessage('Agent Loop: force-stopped. A task may be left mid-implement; the next start recovers it.');
  render();
}

// Opens the config file for hand-editing. Everything the dispatcher can be told lives in one env
// file; seeding it from the shipped example on first open means it arrives documented rather than
// blank. 'wx' so a concurrent window that got there first is never overwritten.
async function openConfig(file = setup.envFile(), example = CONFIG_EXAMPLE, fsApi = fs) {
  if (!fsApi.existsSync(file)) {
    try { fsApi.writeFileSync(file, fsApi.readFileSync(example, 'utf8'), { mode: 0o600, flag: 'wx' }); }
    catch { /* raced, or the example is missing → fall through and open whatever exists */ }
  }
  if (!fsApi.existsSync(file)) {
    vscode.window.showErrorMessage(`Agent Loop: could not create ${file}. Copy agent-loop.env.example there by hand.`);
    return;
  }
  vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
}

// Button: unconfigured → setup, idle → start, running → safe stop, stop pending → offer an escape
// hatch (so a pending stop that will never be consumed, e.g. the dispatcher died right after the
// request, is recoverable from the UI instead of needing someone to delete files by hand).
function toggle() {
  if (!setup.isConfigured()) return setup.runSetup();
  if (isStopping()) {
    vscode.window.showWarningMessage(
      'Agent Loop: a safe stop is already pending — it stops at the end of the current unit of work.',
      'Force stop now', 'Cancel the stop request', 'Keep waiting',
    ).then(pick => {
      if (pick === 'Force stop now') forceStop();
      else if (pick === 'Cancel the stop request') {
        try { fs.unlinkSync(stopFile()); vscode.window.showInformationMessage('Agent Loop: stop request cancelled — it keeps running.'); }
        catch (e) { vscode.window.showErrorMessage(`Agent Loop: could not cancel (${e.message}).`); }
        render();
      }
    });
    return;
  }
  if (isRunning()) safeStop();
  else start();
}

function render() {
  if (!statusItem) return;
  if (!setup.isConfigured()) {
    statusItem.text = '$(gear) Agent Loop: set up';
    statusItem.tooltip = 'Agent Loop is not configured yet — click to add your ClickUp token and create the task list.';
  } else if (isStopping()) {
    statusItem.text = '$(sync~spin) Agent Loop: stopping…';
    statusItem.tooltip = 'Safe stop pending — finishing the current round, then it exits cleanly.';
  } else if (isRunning()) {
    statusItem.text = '$(primitive-square) Agent Loop';
    statusItem.tooltip = 'Agent Loop is running — click for a SAFE stop (finishes the current round, then writes a handover report).';
  } else {
    statusItem.text = '$(rocket) Agent Loop';
    statusItem.tooltip = 'Start the Agent Loop: self-routing dispatcher (senses Claude/Codex/Grok each pass)';
  }
}

let watcherTimer = null;
let watcherBusy = false;
let watcherMemory = null;
let watcherClaudeOnPath = null;
let playbookLogged = false;
let claudeSelfCheck = null;
let claudeCheckPromise = null;
let watcherArmedAt = 0;
let watcherSawDispatcher = false;

function armWatcher() {
  watcherArmedAt = Date.now();
  watcherSawDispatcher = false;
  ensureWatcher();
}

function watcherSettings() {
  const env = loadStateEnv();
  if (watcherClaudeOnPath == null) watcherClaudeOnPath = watcher.claudeOnPath();
  const configured = watcher.watcherMode(env.AGENT_LOOP_WATCHER, watcherClaudeOnPath);
  return {
    env,
    paths: resolveStatePaths(env),
    configured,
    mode: watcher.effectiveWatcherMode(configured, claudeSelfCheck),
  };
}

function ensureClaudeSelfCheck(env, paths) {
  if (claudeSelfCheck || claudeCheckPromise) return;
  const command = env.AGENT_LOOP_WATCHER_CMD || watcher.DEFAULT_CLAUDE_CMD;
  claudeCheckPromise = watcher.spawnCaptured(command, { input: 'Reply with exactly: OK' }).then(result => {
    if (watcher.claudeSelfCheckPassed(result)) {
      claudeSelfCheck = { ok: true };
      return;
    }
    claudeSelfCheck = { ok: false, reason: result.why || String(result.text || result.err || 'did not reply OK').slice(0, 300) };
    try { watcher.appendLog(paths.watcherLog, watcher.claudeSelfCheckLog(claudeSelfCheck)); } catch { /* log is best-effort */ }
  }).catch(e => {
    claudeSelfCheck = { ok: false, reason: e.message };
    try { watcher.appendLog(paths.watcherLog, watcher.claudeSelfCheckLog(claudeSelfCheck)); } catch { /* log is best-effort */ }
  });
}

function ensureWatcher() {
  const { env, paths, configured } = watcherSettings();
  if (configured === 'off') return;
  if (configured === 'full') ensureClaudeSelfCheck(env, paths);
  if (!watcherArmedAt) watcherArmedAt = Date.now();
  if (watcherTimer) return;
  if (configured === 'playbook' && !playbookLogged) {
    try { watcher.appendLog(paths.watcherLog, 'watcher playbook only; claude is not on PATH'); } catch { /* log is best-effort */ }
    playbookLogged = true;
  }
  const pollMs = watcher.pollSeconds(env.AGENT_LOOP_WATCHER_POLL_S) * 1000;
  watcherTimer = setInterval(() => { void watcherTick(); }, pollMs);
  void watcherTick();
}

function stopWatcher() {
  if (!watcherTimer) return;
  clearInterval(watcherTimer);
  watcherTimer = null;
}

function readLogChunk(file, offset) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return { lines: [], nextOffset: offset || 0, lastLine: '' }; }
  const start = Math.min(Math.max(0, offset || 0), size);
  const fh = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    if (buf.length) fs.readSync(fh, buf, 0, buf.length, start);
    const chunk = watcher.readNewLog(buf, 0);
    const tailStart = Math.max(0, size - 8000);
    const tail = Buffer.alloc(size - tailStart);
    if (tail.length) fs.readSync(fh, tail, 0, tail.length, tailStart);
    const parts = tail.toString('utf8').split(/\n/).filter(Boolean);
    return { lines: chunk.lines, nextOffset: start + chunk.nextOffset, lastLine: parts[parts.length - 1] || '' };
  } finally { fs.closeSync(fh); }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// The dispatcher's durable churn map: task id → count, plus `rescope:` and `ops:` keys.
// Missing or unreadable means there is no tally to send. A list or a bare value is not a tally.
function readRoundsTally(file, fsApi = fs) {
  try {
    const body = JSON.parse(fsApi.readFileSync(file, 'utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    return body;
  } catch { return null; }
}

async function collectFacts(env, paths, mode) {
  const now = Date.now();
  const heartbeat = readJson(paths.heartbeat);
  let heartbeatAgeMs = null;
  try { heartbeatAgeMs = Math.max(0, now - fs.statSync(paths.heartbeat).mtimeMs); } catch { /* missing file */ }
  let lockRaw = null;
  let lockExists = false;
  try { lockRaw = fs.readFileSync(paths.lock, 'utf8'); lockExists = true; } catch { /* no lock */ }
  const lock = lockRaw == null ? null : parseLockRecord(lockRaw);
  const lockPidAlive = !!(lock && pidAlive(lock.pid));
  const pidAliveNow = !!(heartbeat && pidAlive(heartbeat.pid));
  let stopFlag = '';
  try { stopFlag = fs.readFileSync(paths.stop, 'utf8'); } catch { /* not stopping */ }
  const unsafeRaw = readJson(paths.unsafe);
  let unsafe = null;
  if (unsafeRaw) {
    const pids = [...new Set([...(unsafeRaw.children || []), unsafeRaw.pid].filter(Boolean))];
    let sandboxNewerThanStop = false;
    const stoppedAt = unsafeRaw.at ? Date.parse(unsafeRaw.at) : NaN;
    if (unsafeRaw.sandboxDir && Number.isFinite(stoppedAt)) {
      sandboxNewerThanStop = watcher.newestMtime(unsafeRaw.sandboxDir) > stoppedAt;
    }
    unsafe = { pids: pids.map(pid => ({ pid, alive: pidAlive(pid) })), sandboxNewerThanStop };
  }
  if (!watcherMemory) {
    watcherMemory = watcher.loadMemory(paths.watcherState);
    if (!fs.existsSync(paths.watcherState)) {
      let size = 0;
      try { size = fs.statSync(paths.log).size; } catch { /* no log yet */ }
      watcherMemory.offset = size;
    }
  }
  const chunk = readLogChunk(paths.log, watcherMemory.offset || 0);
  const stageLimitMs = watcher.stageLimitMs(heartbeat && heartbeat.stage, env);
  let cpuRatio = null;
  let ioUnchanged = null;
  let ioGapMs = null;
  let children = null;
  if (pidAliveNow && heartbeatAgeMs != null && heartbeatAgeMs > stageLimitMs) {
    const sample = await watcher.sampleProcess(heartbeat.pid);
    cpuRatio = sample.cpuRatio;
    ioUnchanged = sample.ioUnchanged;
    ioGapMs = sample.ioGapMs;
    children = sample.children;
  }
  const coderParts = [];
  let coderActiveBeforeKill = false;
  for (const file of String(env.AGENT_LOOP_WATCHER_CODER_LOGS || '').split(',').map(s => s.trim()).filter(Boolean)) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      coderParts.push(watcher.tailText(text, 200));
      const mtime = fs.statSync(file).mtimeMs;
      if (watcher.coderWasActiveBeforeKill(chunk.lines, mtime)) coderActiveBeforeKill = true;
    } catch { /* unreadable coder log is not evidence */ }
  }
  let stoppedForMs = null;
  if (heartbeat && heartbeat.stage === 'stopped' && heartbeat.stageSince) {
    const since = Date.parse(heartbeat.stageSince);
    if (Number.isFinite(since)) stoppedForMs = now - since;
  } else if (chunk.lastLine && /Safe Stop complete/i.test(lineBodySafe(chunk.lastLine))) {
    const at = Date.parse((/^\[([^\]]+)\]/.exec(String(chunk.lastLine)) || [])[1] || '');
    if (Number.isFinite(at)) stoppedForMs = now - at;
  }
  const seeds = String(env.AGENT_LOOP_VERIFY_SEED_DIRS || '').split(',').map(s => s.trim()).filter(Boolean);
  return {
    now,
    env,
    version: PKG.version,
    os: process.platform,
    claudeMode: mode === 'full' ? 'full' : 'playbook',
    phase2: watcher.PHASE2,
    heartbeat,
    heartbeatAgeMs,
    stageLimitMs,
    pid: heartbeat && heartbeat.pid,
    pidAlive: pidAliveNow,
    lock,
    lockExists,
    lockPidAlive,
    stopFlag,
    lines: chunk.lines,
    nextOffset: chunk.nextOffset,
    lastLogLine: chunk.lastLine,
    stoppedForMs,
    unsafe,
    cpuRatio,
    ioUnchanged,
    ioGapMs,
    children,
    coderLogText: watcher.redact(coderParts.join('\n')),
    coderActiveBeforeKill,
    onlyWorkingCoder: null,
    configuredSeedCount: seeds.length,
    maxFixes: numberSetting(env.AGENT_LOOP_WATCHER_MAX_FIXES, 2),
    maxCallsPerHour: numberSetting(env.AGENT_LOOP_WATCHER_MAX_CALLS_PER_H, 4),
    pass: heartbeat && heartbeat.pass,
    loopStopped: !pidAliveNow && !lockPidAlive,
    rounds: readRoundsTally(paths.rounds),
  };
}

function lineBodySafe(line) {
  return String(line).replace(/^\s*\[[^\]]*\]\s*/, '');
}

function numberSetting(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function runNode(args, cwd) {
  return new Promise(resolve => {
    const child = cp.spawn(process.execPath, args, {
      cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...childEnv(cwd, statePaths()) },
    });
    let out = '';
    const timer = setTimeout(() => { watcher.killProcessTree(child.pid); }, 120_000);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', code => { clearTimeout(timer); resolve({ code, out: watcher.redact(out) }); });
    child.on('error', e => { clearTimeout(timer); resolve({ code: 1, out: watcher.redact(e.message) }); });
  });
}

async function applyDecision(decision, paths) {
  const effects = decision.effects || {};
  let probeNote = '';
  if (effects.probe) {
    probeNote = await watcher.runProbes(decision.probeMode || 'probe');
  }
  if (effects.kill) {
    let lock = null;
    try { lock = parseLockRecord(fs.readFileSync(paths.lock, 'utf8')); } catch { /* lock already gone */ }
    const heartbeat = readJson(paths.heartbeat);
    if (!lock || !heartbeat || lock.pid !== heartbeat.pid || !lock.nonce || lock.nonce !== heartbeat.nonce) {
      watcher.appendLog(paths.watcherLog, 'refused to kill: lock nonce does not match the heartbeat');
    } else {
      watcher.killProcessTree(lock.pid);
    }
  }
  if (effects.recover) {
    const cwd = repoRoot();
    if (cwd) await runNode([DISPATCHER, '--recover', '--yes'], cwd);
  }
  if (effects.resetStub && decision.taskId && /^\w[\w-]*$/.test(decision.taskId)) {
    const cwd = repoRoot();
    if (cwd) await runNode([DISPATCHER, '--reset-stub', decision.taskId, '--yes'], cwd);
  }
  if (effects.bench && decision.coderName && /^(claude|codex|grok)$/.test(decision.coderName)) {
    const cwd = repoRoot();
    if (cwd) await runNode([DISPATCHER, '--bench-coder', decision.coderName, '--yes'], cwd);
  }
  if (effects.clearLock) { try { fs.unlinkSync(paths.lock); } catch { /* already gone */ } }
  if (effects.clearStop) { try { fs.unlinkSync(paths.stop); } catch { /* already gone */ } }
  if (effects.writeStopFlag) fs.writeFileSync(paths.stop, watcher.watcherStopText(new Date()));
  if (decision.report) {
    const body = probeNote ? `${decision.report}\n- probe output:\n\n\`\`\`\n${probeNote}\n\`\`\`\n` : decision.report;
    watcher.writeReport(paths.watcherReport, body);
  }
  if (decision.logLine) watcher.appendLog(paths.watcherLog, decision.logLine);
  if (effects.notify && vscode.window) {
    const show = decision.response === 'STOP' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    show(`Agent Loop watcher: ${decision.summary || decision.row}`, 'Open report').then(pick => {
      if (pick) vscode.commands.executeCommand('agentLoop.openWatcherReport');
    });
  }
  if (effects.start) {
    let flag = '';
    try { flag = fs.readFileSync(paths.stop, 'utf8'); } catch { /* no flag */ }
    if (watcher.isUserStop(flag) || watcher.isWatcherStop(flag)) {
      watcher.appendLog(paths.watcherLog, 'not restarting: a stop flag is set');
    } else if (!isRunning()) start();
  }
}

async function watcherTick() {
  if (watcherBusy) return;
  watcherBusy = true;
  try {
    const { env, paths, mode } = watcherSettings();
    if (mode === 'off') { stopWatcher(); return; }
    const facts = await collectFacts(env, paths, mode);
    let decision = watcher.evaluate(facts, watcherMemory || watcher.emptyMemory());
    if (decision.needsClaude) {
      const answer = await watcher.runClaude(env.AGENT_LOOP_WATCHER_CMD || null, decision.bundle);
      const claude = answer.ok ? { text: answer.text } : { unavailable: true, why: answer.why };
      const calls = [...((decision.memory && decision.memory.claudeCalls) || []), Date.now()];
      decision = watcher.evaluate(facts, { ...decision.memory, claudeCalls: calls }, claude);
    }
    watcherMemory = decision.memory;
    try { watcher.saveMemory(paths.watcherState, watcherMemory); } catch { /* state file is best-effort */ }
    await applyDecision(decision, paths);
    const present = !!(facts.pidAlive || facts.lockExists || facts.unsafe
      || watcher.isUserStop(facts.stopFlag) || watcher.isWatcherStop(facts.stopFlag));
    if (present) watcherSawDispatcher = true;
    if (watcher.watcherShouldStop({
      present, sawDispatcher: watcherSawDispatcher, armedAt: watcherArmedAt, now: Date.now(),
    })) stopWatcher();
  } catch (e) {
    try {
      const paths = statePaths();
      watcher.appendLog(paths.watcherLog, `watcher tick failed: ${e.message}`);
    } catch { /* nothing else we can record */ }
  } finally {
    watcherBusy = false;
  }
}

function openWatcherReport() {
  const file = statePaths().watcherReport;
  if (!fs.existsSync(file)) { vscode.window.showInformationMessage('Agent Loop: no watcher report yet.'); return; }
  return vscode.workspace.openTextDocument(file).then(doc => vscode.window.showTextDocument(doc));
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('agentLoop.toggle', toggle),
    vscode.commands.registerCommand('agentLoop.setup', () => setup.runSetup()),
    vscode.commands.registerCommand('agentLoop.checkBoard', () => setup.recheckBoard()),
    vscode.commands.registerCommand('agentLoop.openConfig', () => openConfig()),
    vscode.commands.registerCommand('agentLoop.safeStop', safeStop),
    vscode.commands.registerCommand('agentLoop.forceStop', forceStop),
    vscode.commands.registerCommand('agentLoop.openStopReport', async () => {
      const REPORT_FILE = reportFile();
      if (!fs.existsSync(REPORT_FILE)) { vscode.window.showInformationMessage('Agent Loop: no handover report yet.'); return; }
      vscode.window.showTextDocument(await vscode.workspace.openTextDocument(REPORT_FILE));
    }),
    vscode.commands.registerCommand('agentLoop.recover', recoverUnsafeStop),
    vscode.commands.registerCommand('agentLoop.openWatcherReport', () => openWatcherReport()),
  );

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.command = 'agentLoop.toggle';
  render();
  statusItem.show();
  context.subscriptions.push(statusItem);

  // First run on a new machine: there is no token and no board, so ask instead of leaving a button
  // that would fail on click. Guarded by workspace-independent global state so dismissing it once
  // does not re-open the wizard in every window — the status bar keeps offering it.
  if (!setup.isConfigured() && !context.globalState.get('agentLoop.setupOffered')) {
    context.globalState.update('agentLoop.setupOffered', true);
    setup.runSetup().then(render, () => render());
  }

  // Poll the lock/stop files: the dispatcher can start, stop itself at the end of a round, or die,
  // none of which fire a terminal event.
  if (isRunning()) ensureWatcher();

  let wasRunning = isRunning();
  poller = setInterval(() => {
    const running = isRunning();
    if (watcher.shouldEnsureWatcher(running, !!watcherTimer)) ensureWatcher();
    if (running !== wasRunning) {
      if (!running) vscode.window.showInformationMessage(
        `Agent Loop: stopped. Handover report: ${reportFile()}`, 'Open report')
        .then(pick => { if (pick) vscode.commands.executeCommand('agentLoop.openStopReport'); });
      wasRunning = running;
    }
    render();
  }, 3000);
  context.subscriptions.push({ dispose: () => clearInterval(poller) });

  context.subscriptions.push(vscode.window.onDidCloseTerminal(t => {
    if (t === activeTerminal) activeTerminal = undefined;
    if (t.name === TERMINAL_NAME) render();
  }));
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  __test: {
    loadStateEnv, resolveStatePaths, parseLockRecord, lockLooksLive, pickTerminal,
    DISPATCHER, CONFIG_EXAMPLE, openConfig, childEnv, STATE_ENV_KEYS, readRoundsTally,
  },
};
