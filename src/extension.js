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

const TERMINAL_NAME = 'Agent Loop';
const DISPATCHER = path.join(__dirname, 'agent-loop.mjs');
const CONFIG_EXAMPLE = path.join(__dirname, '..', 'agent-loop.env.example');
const STATE_ENV_KEYS = new Set(['AGENT_LOOP_LOCK', 'AGENT_LOOP_STOP', 'AGENT_LOOP_STOP_REPORT']);

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
  const { lock, stop, report } = statePaths();
  try { fs.unlinkSync(stop); } catch { /* no stale Safe Stop flag → nothing to clear */ }
  // AGENT_LOOP_REPO pins the dispatcher to this repo regardless of where the runner itself lives.
  const term = vscode.window.createTerminal({
    name: TERMINAL_NAME,
    cwd,
    // Pin the resolved paths into the child so the extension and dispatcher cannot diverge even when
    // the settings came from ~/.agent-loop.env rather than the extension host's process environment.
    env: {
      AGENT_LOOP_REPO: cwd,
      AGENT_LOOP_LOCK: lock,
      AGENT_LOOP_STOP: stop,
      AGENT_LOOP_STOP_REPORT: report,
    },
  });
  activeTerminal = term;
  term.show();
  term.sendText(`node "${DISPATCHER}" --watch`);
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
  let wasRunning = isRunning();
  poller = setInterval(() => {
    const running = isRunning();
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
  __test: { loadStateEnv, resolveStatePaths, parseLockRecord, lockLooksLive, pickTerminal, DISPATCHER, CONFIG_EXAMPLE, openConfig },
};
