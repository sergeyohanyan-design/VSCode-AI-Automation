'use strict';

// Playbook for the extension watcher. No vscode import and no read of the env file: the
// extension passes already-parsed non-secret settings in. Decisions are pure so the offline
// selftest can drive them with fake logs and fake process samples.

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const PHASE2 = true;
const CLAUDE_TIMEOUT_MS = 120_000;
const FIX_WINDOW_MS = 6 * 60 * 60 * 1000;
const CALL_WINDOW_MS = 60 * 60 * 1000;
const REPEAT_N = 3;
const REPEAT_WINDOW_MS = 15 * 60 * 1000;
const P2_LINGER_MS = 5 * 60 * 1000;
const P7_WINDOW_MS = 1000;
const P9_GRACE_MS = 10 * 60 * 1000;
const FAST_MS = 15 * 1000;
const CONFIDENCE_MIN = 0.7;
const MAX_WAIT_MIN = 60;
const BOARD_HOLD_PASSES = 3;
const CPU_WEDGE = 0.7;
const WATCHER_START_GRACE_MS = 2 * 60 * 1000;

// Checked against `claude --help` and a real `claude -p` run. --bare forces API-key auth and
// rejects a subscription login ("Not logged in"), so it is not used. --tools "" disables every
// built-in tool, --permission-prompts none denies anything that would prompt, and
// --no-session-persistence keeps the temp run off disk.
const DEFAULT_CLAUDE_ARGS = [
  'claude', '-p', '--model', 'sonnet', '--tools', '',
  '--permission-prompts', 'none', '--no-session-persistence',
];
const DEFAULT_CLAUDE_CMD = DEFAULT_CLAUDE_ARGS.map(quoteCmdArg).join(' ');

const ACTIONS = [
  'wait', 'clear_stale_lock', 'kill_and_recover', 'kill_lingering', 'recover',
  'probe_coders', 'stop_and_report', 'reset_stub', 'bench_coder',
];

const SHELL_HELPERS = new Set([
  'cmd', 'cmd.exe', 'conhost', 'conhost.exe', 'powershell', 'powershell.exe',
  'pwsh', 'pwsh.exe', 'bash', 'sh', 'dash', 'sleep', 'timeout', 'timeout.exe',
]);

const TITLES = {
  P1: 'CPU-spin wedge',
  P2: 'Lingering after Safe Stop',
  P3: 'Stale lock',
  P4: 'Unsafe-stop marker',
  P5: 'Zero-commit stub branch',
  P6: 'Unmerged predecessor branches',
  P7: 'Task branch missing for a fix',
  P8: 'Coder out of credit',
  P9: 'Reviewer quota',
  P10: 'Parked review',
  P11: 'No coder available',
  P12: 'Reviewer probe hides a broken review command',
  P13: 'Verify livelock',
  P14: 'Max turns with no new commit',
  P15: 'Re-scope loop',
  P16: 'Wrong repository',
  P17: 'Idle kill during real work',
  P19: 'Implementation ceiling repeat',
  P18: 'Unknown problem',
  'user-stop': 'User Safe Stop',
  'watcher-stop': 'Watcher Safe Stop',
};

function quoteCmdArg(arg) {
  const text = String(arg);
  if (text === '') return '""';
  if (/[\s"]/.test(text)) return `"${text.replace(/"/g, '\\"')}"`;
  return text;
}

function redact(text) {
  let s = String(text ?? '');
  s = s.replace(/\bpk_[A-Za-z0-9_]+\b/g, 'pk_[redacted]');
  s = s.replace(/\bsk-[A-Za-z0-9_-]+\b/g, 'sk-[redacted]');
  s = s.replace(/\bxai-[A-Za-z0-9_-]+\b/g, 'xai-[redacted]');
  s = s.replace(/\bghp_[A-Za-z0-9]+\b/g, 'ghp_[redacted]');
  s = s.replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]');
  s = s.replace(/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))=[^\s'"]+/gi, '$1=[redacted]');
  s = s.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1[redacted]@');
  return s;
}

function readNewLog(buffer, offset = 0) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer ?? ''), 'utf8');
  const start = Math.max(0, Math.min(Number(offset) || 0, buf.length));
  let end = -1;
  for (let i = buf.length - 1; i >= start; i--) {
    if (buf[i] === 0x0a) { end = i; break; }
  }
  if (end < start) return { lines: [], nextOffset: start };
  const lines = buf.subarray(start, end + 1).toString('utf8').split(/\n/).filter(l => l.length > 0);
  return { lines, nextOffset: end + 1 };
}

function lineBody(line) {
  return String(line).replace(/^\s*\[[^\]]*\]\s*/, '');
}

function lineAt(line) {
  const m = /^\s*\[([^\]]+)\]/.exec(String(line));
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? t : null;
}

function normalizeSignature(line) {
  return lineBody(line)
    .replace(/\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?/g, '#')
    .replace(/\b[0-9a-f]{7,40}\b/gi, '#')
    .replace(/\b\d+\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

function stageLimitMs(stage, env = {}) {
  const num = (key, fallback) => {
    const v = Number(env[key]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  const extra = 10 * 60 * 1000;
  const seconds = {
    implement: num('AGENT_LOOP_IMPLEMENT_TIMEOUT_S', 1200),
    review: num('AGENT_LOOP_REVIEW_TIMEOUT_S', 600),
    adjudicate: num('AGENT_LOOP_REVIEW_TIMEOUT_S', 600),
    verify: num('AGENT_LOOP_VERIFY_TIMEOUT_S', 1500),
  }[stage];
  if (seconds) return seconds * 1000 + extra;
  return 10 * 60 * 1000 + extra;
}

function tailText(text, n = 200) {
  return String(text ?? '').split(/\r?\n/).slice(-n).join('\n');
}

function creditExhausted(text) {
  return /\bHTTP\s*402\b|balance exhausted/i.test(String(text || ''));
}

function isUserStop(text) {
  const s = String(text || '');
  return s.trim().length > 0 && !/by the watcher/i.test(s);
}

function isWatcherStop(text) {
  return /by the watcher/i.test(String(text || ''));
}

function watcherStopText(when = new Date()) {
  const iso = when instanceof Date ? when.toISOString() : new Date(when).toISOString();
  return `requested ${iso} by the watcher\n`;
}

function identityMatches(facts) {
  const lock = facts && facts.lock;
  const hb = facts && facts.heartbeat;
  if (!lock || !hb) return false;
  if (!Number.isInteger(lock.pid) || lock.pid <= 0) return false;
  if (lock.pid !== hb.pid) return false;
  if (typeof lock.nonce !== 'string' || lock.nonce.length === 0) return false;
  if (lock.nonce !== hb.nonce) return false;
  if (facts.pid != null && facts.pid !== lock.pid) return false;
  return true;
}

function childName(child) {
  return String(child && child.name != null ? child.name : child || '').toLowerCase();
}

function shellOnly(children) {
  return Array.isArray(children) && children.every(child => SHELL_HELPERS.has(childName(child)));
}

function hasAgentChild(children) {
  return Array.isArray(children) && children.some(child => !SHELL_HELPERS.has(childName(child)));
}

function p1Signals(facts) {
  const stage = facts.heartbeat && facts.heartbeat.stage;
  const limit = Number.isFinite(facts.stageLimitMs) ? facts.stageLimitMs : stageLimitMs(stage, facts.env);
  return facts.pidAlive === true
    && Number.isFinite(facts.heartbeatAgeMs) && facts.heartbeatAgeMs > limit
    && Number.isFinite(facts.cpuRatio) && facts.cpuRatio >= CPU_WEDGE
    && facts.ioUnchanged === true
    && Number(facts.ioGapMs) >= 10_000
    && Array.isArray(facts.children) && facts.children.length === 0;
}

function coderWasActiveBeforeKill(lines, mtimeMs) {
  if (!Number.isFinite(mtimeMs)) return false;
  for (let i = (lines || []).length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!/killed-idle/.test(String(line))) continue;
    const at = lineAt(line);
    if (at != null && at >= mtimeMs && at - mtimeMs < 60_000) return true;
  }
  return false;
}

function p2Signals(facts) {
  const stageStopped = facts.heartbeat && facts.heartbeat.stage === 'stopped';
  const logStopped = /Safe Stop complete/i.test(lineBody(facts.lastLogLine || ''));
  const cpu = facts.cpuRatio;
  return facts.pidAlive === true
    && (stageStopped || logStopped)
    && Number.isFinite(facts.stoppedForMs) && facts.stoppedForMs >= P2_LINGER_MS
    && (cpu == null || cpu < 0.2)
    && shellOnly(facts.children);
}

function p4Ready(facts) {
  const marker = facts.unsafe;
  if (!marker || !Array.isArray(marker.pids) || marker.pids.length === 0) return false;
  if (marker.pids.some(pid => pid && pid.alive)) return false;
  if (marker.sandboxNewerThanStop === true) return false;
  return true;
}

function preconditions(action, facts = {}, memory = {}) {
  switch (action) {
    case 'wait':
      return { ok: true, why: 'none' };
    case 'clear_stale_lock':
      return { ok: facts.lockExists === true && facts.lockPidAlive === false, why: 'the lock pid is dead' };
    case 'kill_and_recover':
      return { ok: p1Signals(facts) && identityMatches(facts), why: 'P1 signals are all true and the pid+nonce match' };
    case 'kill_lingering':
      return {
        ok: p2Signals(facts) && identityMatches(facts) && !hasAgentChild(facts.children),
        why: 'P2 signals are true, identity matches, and no agent CLI is still a child',
      };
    case 'recover':
      return { ok: p4Ready(facts), why: 'every marker pid is dead and the sandbox is not newer than the stop' };
    case 'probe_coders':
      return { ok: !memory.probed || !memory.probed[facts.incident || 'probe'], why: 'at most once per incident' };
    case 'stop_and_report':
      return { ok: true, why: 'always' };
    case 'reset_stub':
      return {
        ok: facts.loopStopped === true && facts.stubCommits === 0 && facts.stubRemote === false && !!facts.taskId,
        why: 'the loop is stopped, the branch has 0 commits beyond its base, and there is no remote copy',
      };
    case 'bench_coder':
      return {
        ok: facts.coderCreditExhausted === true && !!facts.coderName,
        why: 'the coder log shows HTTP 402 or balance exhausted',
      };
    default:
      return { ok: false, why: 'not on the allowlist' };
  }
}

function emptyEffects() {
  return {
    kill: false, clearLock: false, clearStop: false, start: false, recover: false,
    probe: false, writeStopFlag: false, notify: false, waitMin: 0, resetStub: false, bench: false,
  };
}

function effectsFor(action) {
  const effects = emptyEffects();
  if (action === 'wait') effects.waitMin = 0;
  if (action === 'clear_stale_lock') effects.clearLock = true;
  if (action === 'kill_and_recover') {
    effects.kill = true; effects.clearLock = true; effects.clearStop = true; effects.start = true;
  }
  if (action === 'kill_lingering') {
    effects.kill = true; effects.clearLock = true; effects.clearStop = true;
  }
  if (action === 'recover') { effects.recover = true; effects.start = true; }
  if (action === 'probe_coders') effects.probe = true;
  if (action === 'stop_and_report') { effects.writeStopFlag = true; effects.notify = true; }
  if (action === 'reset_stub') { effects.resetStub = true; effects.clearStop = true; effects.start = true; }
  if (action === 'bench_coder') effects.bench = true;
  return effects;
}

function watcherMode(value, claudeOnPath) {
  const mode = String(value || 'auto').toLowerCase();
  if (mode === 'off') return 'off';
  if (mode === 'on' || mode === 'auto') return claudeOnPath ? 'full' : 'playbook';
  return claudeOnPath ? 'full' : 'playbook';
}

// Full mode stays playbook until a self-check has answered OK. A failed check stays playbook.
function effectiveWatcherMode(mode, selfCheck) {
  if (mode !== 'full') return mode;
  if (!selfCheck || selfCheck.ok !== true) return 'playbook';
  return 'full';
}

function claudeSelfCheckPassed(result) {
  return !!(result && result.ok === true && /\bOK\b/.test(result.text || ''));
}

function claudeSelfCheckLog(result) {
  const reason = redact(result && result.reason ? result.reason : 'did not reply OK');
  return `claude self-check failed (${reason}); watcher playbook only`;
}

// The first tick after Start has no lock yet. Keep the timer until this run has been seen,
// or until the grace period ends with no dispatcher.
function watcherShouldStop(state = {}) {
  if (state.present) return false;
  const grace = Number.isFinite(state.graceMs) ? state.graceMs : WATCHER_START_GRACE_MS;
  const elapsed = Number(state.now) - Number(state.armedAt);
  if (!state.sawDispatcher && Number.isFinite(elapsed) && elapsed < grace) return false;
  return true;
}

function shouldEnsureWatcher(running, hasTimer) {
  return running === true && !hasTimer;
}

function pollSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 60;
  return Math.min(3600, Math.max(10, Math.floor(n)));
}

function claudeOnPath() {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const r = cp.spawnSync(cmd, ['claude'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    return r.status === 0 && String(r.stdout || '').trim().length > 0;
  } catch { return false; }
}

function emptyNarration() {
  return {
    sessionId: null, stamp: null, lastSentAt: null, pending: [],
    budgetNotedAt: null, runId: null, trustNoted: false,
  };
}

function copyNarration(value) {
  const n = value && typeof value === 'object' ? value : {};
  const stamp = n.stamp && Number.isFinite(n.stamp.size) && Number.isFinite(n.stamp.mtimeMs)
    ? { size: n.stamp.size, mtimeMs: n.stamp.mtimeMs }
    : null;
  return {
    sessionId: typeof n.sessionId === 'string' && n.sessionId ? n.sessionId : null,
    stamp,
    lastSentAt: Number.isFinite(n.lastSentAt) ? n.lastSentAt : null,
    pending: Array.isArray(n.pending) ? n.pending.slice(-NARRATION_PENDING_CAP) : [],
    budgetNotedAt: Number.isFinite(n.budgetNotedAt) ? n.budgetNotedAt : null,
    runId: typeof n.runId === 'string' && n.runId ? n.runId : null,
    trustNoted: n.trustNoted === true,
  };
}

function emptyMemory() {
  return {
    offset: 0, fixes: {}, claudeCalls: [], probed: {}, holds: {}, notified: {},
    errors: [], quietUntil: {}, lastPass: null, keptLines: [], runId: null,
    stubRepair: null, commitCounts: {},
    narration: emptyNarration(),
    eventState: { stage: null, stageTask: null },
  };
}

function cloneMemory(memory = {}) {
  const fixes = {};
  for (const [key, times] of Object.entries(memory.fixes || {})) fixes[key] = [...times];
  return {
    offset: memory.offset || 0,
    fixes,
    claudeCalls: [...(memory.claudeCalls || [])],
    probed: { ...(memory.probed || {}) },
    holds: { ...(memory.holds || {}) },
    notified: { ...(memory.notified || {}) },
    errors: (memory.errors || []).map(item => ({ ...item })),
    quietUntil: { ...(memory.quietUntil || {}) },
    lastPass: memory.lastPass ?? null,
    keptLines: [...(memory.keptLines || [])],
    runId: memory.runId || null,
    stubRepair: memory.stubRepair
      ? { taskId: memory.stubRepair.taskId || null, line: memory.stubRepair.line || null }
      : null,
    commitCounts: copyCommitCounts(memory.commitCounts),
    narration: copyNarration(memory.narration),
    eventState: {
      stage: memory.eventState && memory.eventState.stage || null,
      stageTask: memory.eventState && memory.eventState.stageTask || null,
    },
  };
}

function runNonce(facts) {
  if (facts.lock && facts.lock.nonce) return String(facts.lock.nonce);
  if (facts.heartbeat && facts.heartbeat.nonce) return String(facts.heartbeat.nonce);
  return null;
}

function clearRunState(mem) {
  mem.keptLines = [];
  mem.errors = [];
  mem.notified = {};
  mem.quietUntil = {};
  mem.holds = {};
  mem.probed = {};
  mem.runId = null;
  mem.stubRepair = null;
  mem.commitCounts = {};
  mem.narration = emptyNarration();
  mem.eventState = { stage: null, stageTask: null };
}

function forgetRun(memory) {
  const mem = cloneMemory(memory || {});
  clearRunState(mem);
  return mem;
}

function linesAfterLatestStart(lines) {
  const all = lines || [];
  let start = -1;
  for (let i = 0; i < all.length; i++) {
    if (/=== start:/.test(lineBody(all[i]))) start = i;
  }
  return start < 0 ? all.slice() : all.slice(start);
}

function recentTimes(times, now, windowMs) {
  return (times || []).filter(t => now - t < windowMs);
}

function copyCommitCounts(existing) {
  const source = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  const out = {};
  for (const [id, samples] of Object.entries(source)) {
    if (!Array.isArray(samples)) continue;
    out[id] = samples.filter(n => Number.isInteger(n) && n >= 0);
  }
  return out;
}

// One sample per new verify-failure line. A missing count is not a sample, so a
// branch the watcher cannot see does not look flat.
function appendCommitCounts(existing, lines, readCount) {
  const out = copyCommitCounts(existing);
  for (const line of lines || []) {
    if (!/\bverify FAILED\b/.test(lineBody(line))) continue;
    const id = taskOf(lineBody(line));
    if (!id || typeof readCount !== 'function') continue;
    const n = readCount(id);
    if (!Number.isInteger(n) || n < 0) continue;
    if (!out[id]) out[id] = [];
    out[id].push(n);
  }
  return out;
}

function taskOf(body) {
  const text = String(body || '').trim();
  const m = /\b(?:of|implement|review)\s+([A-Za-z0-9_-]+)/.exec(text)
    || /^(\S+)\s+verify\b/.exec(text)
    || /^(\S+)\s+(?:claude|codex|grok)\b/i.exec(text);
  return m ? m[1] : null;
}

function findBodies(lines, re) {
  return lines.filter(line => re.test(lineBody(line)));
}

function quotaPhrase(text) {
  const m = /try again at\s+([^\n.]+)/i.exec(lineBody(text));
  if (!m) return null;
  const raw = m[1].trim();
  const hasDate = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(raw)
    || /\b20\d{2}\b/.test(raw)
    || /\d+(?:st|nd|rd|th)\b/i.test(raw);
  const clockOnly = /^\d{1,2}:\d{2}\s*(?:AM|PM)\b/i.test(raw) && !hasDate;
  if (clockOnly) return { kind: 'short', raw };
  if (hasDate) return { kind: 'long', raw };
  return null;
}

function clockOnDay(raw, baseMs) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)\b/i.exec(raw || '');
  if (!m || !Number.isFinite(baseMs)) return null;
  let hour = Number(m[1]) % 12;
  if (/pm/i.test(m[3])) hour += 12;
  const day = new Date(baseMs);
  day.setHours(hour, Number(m[2]), 0, 0);
  const when = day.getTime();
  if (when < baseMs) return when + 24 * 60 * 60 * 1000;
  return when;
}

function resumedAfter(lines, fromMs) {
  return lines.some(line => {
    const at = lineAt(line);
    if (at == null || (fromMs != null && at < fromMs)) return false;
    return /probe (?:claude|codex|grok): available|^\s*implement |\breview \S+ via /.test(lineBody(line));
  });
}

function matchP5(lines) {
  const refuse = findBodies(lines, /REFUSING fresh fork of\b/).filter(line => /0 commit\(s\) beyond/.test(lineBody(line)));
  const eligible = findBodies(lines, /no ready task is eligible:/).filter(line => /blocked by unfinished predecessors/.test(lineBody(line)));
  if (!refuse.length || eligible.length < 2) return null;
  const id = (/REFUSING fresh fork of\s+([^:]+):/.exec(lineBody(refuse[0])) || [])[1] || null;
  return { line: refuse[refuse.length - 1], taskId: id ? id.trim() : null };
}

// A ref is passed to git as one argv element. `..` is the rev-range operator, so it is rejected
// before any command is built. The charset is the extra gate.
function safeGitRef(name) {
  return typeof name === 'string'
    && name.length > 0
    && !name.includes('..')
    && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name);
}

function parseStubLine(line) {
  const body = lineBody(line);
  const quoted = /branch\s+`([^`]+)`\s+already exists\s+\(\d+\s+commit\(s\)\s+beyond\s+`([^`]+)`\)/.exec(body);
  const plain = /branch\s+(\S+)\s+already exists\s+\(\d+\s+commit\(s\)\s+beyond\s+([A-Za-z0-9][A-Za-z0-9._/-]*)/.exec(body);
  const match = quoted || plain;
  if (!match || !safeGitRef(match[1]) || !safeGitRef(match[2])) return null;
  return { branch: match[1], base: match[2] };
}

function matchP7(lines) {
  const hits = findBodies(lines, /task branch missing for a fix/).filter(line => /→\s*blocked|->\s*blocked|\bblocked\b/.test(lineBody(line)));
  if (!hits.length) return null;
  const hit = hits[hits.length - 1];
  const at = lineAt(hit);
  const implement = [...lines].reverse().find(line => line !== hit && /\bimplement /.test(lineBody(line)) && (at == null || (lineAt(line) != null && lineAt(line) <= at)));
  if (!implement || at == null || lineAt(implement) == null) return null;
  if (at - lineAt(implement) > P7_WINDOW_MS) return null;
  return hit;
}

function matchP8(lines, facts) {
  const exits = lines.filter(line => /\b(claude|codex|grok) exited 1 →/.test(lineBody(line)));
  if (!exits.length || !creditExhausted(facts.coderLogText)) return null;
  const hit = exits[exits.length - 1];
  const who = (/\b(claude|codex|grok) exited 1 →/.exec(lineBody(hit)) || [])[1];
  const at = lineAt(hit);
  const probe = [...lines].reverse().find(line => new RegExp(`probe ${who}: available`).test(lineBody(line)));
  if (!probe) return null;
  if (at != null && lineAt(probe) != null && at - lineAt(probe) > 3 * 60 * 1000) return null;
  return { line: hit, coderName: who };
}

function onlyCoderUp(lines, coder) {
  let saw = false;
  const up = new Set();
  for (const line of lines) {
    const m = /probe (claude|codex|grok): (available|unavailable)/.exec(lineBody(line));
    if (!m) continue;
    saw = true;
    if (m[2] === 'available') up.add(m[1]);
    else up.delete(m[1]);
  }
  return saw && up.size === 1 && up.has(coder);
}

function matchP9(lines, now) {
  const hits = lines.map(line => ({ line, quota: quotaPhrase(line) })).filter(item => item.quota);
  if (!hits.length) return null;
  const hit = hits[hits.length - 1];
  if (hit.quota.kind === 'long') {
    return { line: hit.line, quota: hit.quota, response: 'STOP', action: 'stop_and_report' };
  }
  const at = lineAt(hit.line) || now;
  const resetAt = clockOnDay(hit.quota.raw, at);
  if (resetAt != null && now >= resetAt + P9_GRACE_MS && !resumedAfter(lines, resetAt)) {
    return { line: hit.line, quota: hit.quota, response: 'STOP', action: 'stop_and_report', escalated: true };
  }
  return { line: hit.line, quota: hit.quota, response: 'WAIT', action: 'wait', waitMin: 10 };
}

function matchP11(lines, now) {
  const hits = findBodies(lines, /STOP: no coder available/).filter(line => {
    const at = lineAt(line);
    return at != null && now - at >= 0 && now - at <= REPEAT_WINDOW_MS;
  });
  if (hits.length < REPEAT_N) return null;
  return hits[hits.length - 1];
}

function matchP12(lines) {
  const fails = lines.filter(line => {
    const body = lineBody(line);
    return /unavailable \(exit 1\)/.test(body) && !/quota|rate-limit|benched until/i.test(body);
  });
  const quick = fails.filter(line => {
    const at = lineAt(line);
    if (at == null) return false;
    return lines.some(prev => {
      const pt = lineAt(prev);
      return pt != null && pt <= at && at - pt <= FAST_MS && /\breview \S+ via /.test(lineBody(prev));
    });
  });
  if (quick.length < 2) return null;
  const probed = lines.some(line => /probe (?:claude|codex|grok): available/.test(lineBody(line)));
  if (!probed) return null;
  return quick[quick.length - 1];
}

function sameSignature(group) {
  const sig = normalizeSignature(group[0]);
  return group.every(line => normalizeSignature(line) === sig);
}

function matchP13(lines, facts) {
  const fails = findBodies(lines, /\bverify FAILED\b/);
  if (fails.length < 2) return null;
  const byTask = new Map();
  for (const line of fails) {
    const id = taskOf(lineBody(line)) || 'task';
    if (!byTask.has(id)) byTask.set(id, []);
    byTask.get(id).push(line);
  }
  for (const [id, group] of byTask) {
    const fast = group.filter(line => {
      const at = lineAt(line);
      if (at == null) return false;
      return lines.some(prev => {
        const pt = lineAt(prev);
        return pt != null && pt <= at && at - pt <= FAST_MS && new RegExp(`\\b${id} verify:`).test(lineBody(prev));
      });
    });
    if (fast.length >= 2 && sameSignature(fast)) return fast[fast.length - 1];
    const counts = facts.commitCounts && facts.commitCounts[id];
    const flat = Array.isArray(counts) && counts.length >= 2 && counts.every(n => n === counts[0]);
    if (group.length >= 3 && flat && sameSignature(group)) return group[group.length - 1];
  }
  return null;
}

function matchP14(lines, facts) {
  const hits = findBodies(lines, /exited 1 \(max turns reached\)/);
  const byTask = new Map();
  for (const line of hits) {
    const id = taskOf(lineBody(line)) || 'task';
    if (!byTask.has(id)) byTask.set(id, []);
    byTask.get(id).push(line);
  }
  for (const [id, group] of byTask) {
    if (group.length < 2) continue;
    if (facts.commitsGrew && facts.commitsGrew[id] === true) continue;
    return group[group.length - 1];
  }
  return null;
}

function matchP15(lines, now) {
  const hits = findBodies(lines, /Claude re-scope diagnosis/);
  const byTask = new Map();
  for (const line of hits) {
    const at = lineAt(line);
    if (at != null && now - at > 24 * 60 * 60 * 1000) continue;
    const id = taskOf(lineBody(line)) || 'task';
    if (!byTask.has(id)) byTask.set(id, []);
    byTask.get(id).push(line);
  }
  let best = null;
  for (const group of byTask.values()) {
    if (group.length >= 2 && (!best || group.length > best.count)) best = { count: group.length, line: group[group.length - 1] };
  }
  if (!best) return null;
  return { line: best.line, count: best.count, response: best.count >= 3 ? 'STOP' : 'NOTIFY', action: best.count >= 3 ? 'stop_and_report' : 'wait' };
}

function matchP16(lines, facts) {
  const configured = Number(facts.configuredSeedCount);
  if (!Number.isFinite(configured) || configured <= 0) return null;
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (/=== start:/.test(lineBody(lines[i]))) start = i;
  if (start < 0) return null;
  const after = lines.slice(start + 1);
  const paths = new Set();
  let first = null;
  for (const line of after) {
    const body = lineBody(line);
    if (/verify seed skipped:/.test(body)) continue;
    const m = /seed skipped:\s+(\S+)\s+does not exist in/.exec(body);
    if (!m) continue;
    if (!first) first = line;
    paths.add(m[1]);
  }
  if (paths.size < configured) return null;
  const branched = after.some(line => /\bimplement /.test(lineBody(line)));
  return { line: first, branched };
}

function matchP17(lines, facts) {
  if (facts.coderActiveBeforeKill !== true) return null;
  const hits = findBodies(lines, /killed-idle/);
  const byTask = new Map();
  for (const line of hits) {
    const id = taskOf(lineBody(line)) || 'task';
    if (!byTask.has(id)) byTask.set(id, []);
    byTask.get(id).push(line);
  }
  for (const group of byTask.values()) {
    if (group.length >= 2) return group[group.length - 1];
  }
  return null;
}

// One kill writes a TIMEOUT line and a phase line. Only the phase line that says
// killed-ceiling counts, so the pair is one kill. Idle kills are P17.
function matchP19(lines, now) {
  const hits = findBodies(lines, /killed-ceiling/);
  const byTask = new Map();
  for (const line of hits) {
    const at = lineAt(line);
    if (at != null && now - at > 24 * 60 * 60 * 1000) continue;
    const id = taskOf(lineBody(line));
    if (!id) continue;
    if (!byTask.has(id)) byTask.set(id, []);
    byTask.get(id).push(line);
  }
  const repeats = [];
  for (const [taskId, group] of byTask) {
    if (group.length >= 2) {
      repeats.push({ taskId, count: group.length, line: group[group.length - 1] });
    }
  }
  return repeats;
}

function fixedText(row, extra = {}) {
  const steps = {
    P1: 'The watcher kills the stuck process tree, clears the lock and the stop flag, and starts the loop again. A coding task that already has commits is moved to review on the next start.',
    P2: 'The watcher kills the leftover process and deletes both the lock and the stop flag. Start the loop from the button when you want it running.',
    P3: 'The watcher deletes the lock whose process is gone. Start the loop from the button.',
    P4: 'Run Agent Loop: Recover unsafe stop, or `node src/agent-loop.mjs --recover`, once every pid in the marker is dead and the sandbox has no file newer than the stop.',
    P5: '1. Delete the local branch only if `git rev-list --count <base>..<branch>` is 0 and the branch has no remote. 2. Set that task back to ready.',
    P6: 'Remove the outdated dependency. This check does not test ancestry.',
    P7: 'The branch name is derived from the task name. Restore the previous task name so the branch matches again.',
    P8: 'Log that coder out of its CLI so the next coder can take the task. Do not edit the CLI config file.',
    P9: extra.quota ? `The vendor said: ${extra.quota}` : 'Wait for the vendor reset time, then let the loop continue.',
    P10: 'This is the designed wait for the reviewer to come back. Leave the loop running.',
    P11: 'Read the probe output below. Fix the named CLI auth or model setting yourself. The watcher does not edit CLI config.',
    P12: 'The availability probe passed and the review command failed. Compare the review command with the model the account can use. The watcher does not edit CLI config.',
    P13: 'The same verify failure is repeating and the branch is not growing. Fix the verify command or the harness. This is not a task-code problem.',
    P14: 'Raise AGENT_LOOP_MAX_TURNS, or split the task.',
    P15: extra.count >= 3
      ? 'Stop. The same task was re-scoped 3 times in 24 hours. Split it or rewrite the acceptance criteria by hand.'
      : 'The same task was re-scoped twice in 24 hours. Read the latest diagnosis before it cycles again.',
    P16: 'The loop was started in a repository that does not contain the configured seed paths. Stop it and start it from the right folder.',
    P17: 'Raise AGENT_LOOP_IMPLEMENT_IDLE_S. The coder was still working. Do not blame the agent.',
    P19: `The coder hit the ceiling ${extra.count} times on the same task. These kills do not count toward the round limit. Split the task or raise AGENT_LOOP_IMPLEMENT_TIMEOUT_S.`,
    P18: extra.humanFix || 'Read the report and decide whether to leave the loop running.',
    'user-stop': 'The button or another user action requested Safe Stop. The watcher will wait for the loop to exit and will not start it again.',
  };
  return steps[row] || 'Read the watcher report.';
}

function matchPlaybook(facts, now) {
  const lines = facts.lines || [];
  if (p1Signals(facts)) {
    return { row: 'P1', response: 'AUTO', action: 'kill_and_recover', line: null };
  }
  if (p2Signals(facts)) {
    return { row: 'P2', response: 'AUTO', action: 'kill_lingering', line: facts.lastLogLine || null };
  }
  if (facts.lockExists && facts.lockPidAlive === false) {
    return { row: 'P3', response: 'AUTO', action: 'clear_stale_lock', line: null };
  }
  if (facts.lockExists && facts.heartbeat && facts.lock && facts.lockPidAlive && facts.lock.nonce && facts.heartbeat.nonce && facts.lock.nonce !== facts.heartbeat.nonce) {
    return { row: 'P3', response: 'NOTIFY', action: 'wait', line: null, humanFix: 'The lock pid is still alive but its nonce does not match the heartbeat. The watcher will not delete it.' };
  }
  if (facts.unsafe) {
    if (p4Ready(facts)) return { row: 'P4', response: 'AUTO', action: 'recover', line: null };
    return { row: 'P4', response: 'STOP', action: 'stop_and_report', line: null, humanFix: 'An unsafe-stop marker is present, and either a pid is still alive or a sandbox file is newer than the stop. Do not recover yet.' };
  }
  const p5 = matchP5(lines);
  if (p5) {
    if (!facts.phase2) {
      return { row: 'P5', response: 'NOTIFY', action: 'wait', line: p5.line, taskId: p5.taskId };
    }
    if (facts.loopStopped !== true) {
      if (!p5.taskId) {
        return { row: 'P5', response: 'NOTIFY', action: 'wait', line: p5.line, taskId: p5.taskId };
      }
      return {
        row: 'P5', response: 'AUTO', action: 'wait', line: p5.line, taskId: p5.taskId,
        prepareStubReset: true,
        humanFix: `The watcher is stopping the loop. After it exits it runs --reset-stub and starts the loop again. If that is refused: ${fixedText('P5')}`,
      };
    }
    const stubFacts = { ...facts, taskId: p5.taskId, loopStopped: true };
    if (preconditions('reset_stub', stubFacts, {}).ok) {
      return { row: 'P5', response: 'AUTO', action: 'reset_stub', line: p5.line, taskId: p5.taskId };
    }
    return { row: 'P5', response: 'NOTIFY', action: 'wait', line: p5.line, taskId: p5.taskId };
  }
  const p6 = findBodies(lines, /REFUSING fresh fork\b/).find(line => /satisfied blockers still carry unmerged branches/.test(lineBody(line)));
  if (p6) return { row: 'P6', response: 'NOTIFY', action: 'wait', line: p6 };
  const p7 = matchP7(lines);
  if (p7) return { row: 'P7', response: 'NOTIFY', action: 'wait', line: p7 };
  const p8 = matchP8(lines, facts);
  if (p8) {
    const only = facts.onlyWorkingCoder === true || (facts.onlyWorkingCoder == null && onlyCoderUp(lines, p8.coderName));
    if (facts.phase2) return { row: 'P8', response: 'AUTO', action: 'bench_coder', line: p8.line, coderName: p8.coderName, alsoNotify: true };
    if (only) return { row: 'P8', response: 'STOP', action: 'stop_and_report', line: p8.line, coderName: p8.coderName };
    return { row: 'P8', response: 'NOTIFY', action: 'wait', line: p8.line, coderName: p8.coderName };
  }
  const p9 = matchP9(lines, now);
  if (p9 && !(p9.response === 'WAIT' && resumedAfter(lines, lineAt(p9.line)))) {
    return { row: 'P9', response: p9.response, action: p9.action, line: p9.line, quotaText: p9.quota.raw, waitMin: p9.waitMin || 0 };
  }
  const parked = findBodies(lines, /left parked/).length > 0 && findBodies(lines, /no ready task is eligible/).length > 0;
  if (parked && facts.pidAlive && Number.isFinite(facts.heartbeatAgeMs) && facts.heartbeatAgeMs < 2 * 60 * 1000 && shellOnly(facts.children)) {
    return { row: 'P10', response: 'WAIT', action: 'wait', line: findBodies(lines, /left parked/).pop(), waitMin: 60 };
  }
  const p11 = matchP11(lines, now);
  if (p11) return { row: 'P11', response: 'STOP', action: 'probe_coders', line: p11, probeMode: 'probe', thenStop: true };
  const p12 = matchP12(lines);
  if (p12) return { row: 'P12', response: 'STOP', action: 'probe_coders', line: p12, probeMode: 'review', thenStop: true };
  const p13 = matchP13(lines, facts);
  if (p13) return { row: 'P13', response: 'STOP', action: 'stop_and_report', line: p13 };
  const p14 = matchP14(lines, facts);
  if (p14) return { row: 'P14', response: 'NOTIFY', action: 'wait', line: p14 };
  const p15 = matchP15(lines, now);
  if (p15) return { row: 'P15', response: p15.response, action: p15.action, line: p15.line, count: p15.count };
  const p16 = matchP16(lines, facts);
  if (p16) {
    const humanFix = p16.branched
      ? `${fixedText('P16')} A branch was created; delete it if it does not belong in this repository.`
      : fixedText('P16');
    return { row: 'P16', response: 'STOP', action: 'stop_and_report', line: p16.line, humanFix };
  }
  const p17 = matchP17(lines, facts);
  if (p17) return { row: 'P17', response: 'NOTIFY', action: 'wait', line: p17 };
  const p19 = matchP19(lines, now);
  if (p19.length) {
    const pick = p19[0];
    return {
      row: 'P19', response: 'NOTIFY', action: 'wait',
      line: pick.line, count: pick.count, taskId: pick.taskId,
      signature: `P19:${pick.taskId}`, repeats: p19,
    };
  }
  const limit = Number.isFinite(facts.stageLimitMs)
    ? facts.stageLimitMs
    : stageLimitMs(facts.heartbeat && facts.heartbeat.stage, facts.env);
  const frozen = facts.pidAlive === true && Number.isFinite(facts.heartbeatAgeMs) && facts.heartbeatAgeMs > limit;
  return frozen ? { row: 'P18', response: 'STOP', action: 'ask_claude', line: null, frozen: true } : null;
}

function ingestErrors(lines, memory, now) {
  for (const line of lines) {
    const body = lineBody(line);
    if (!/✖|REFUSING|FAILED|STOP:|exited [1-9]|FATAL|unsafe-child/i.test(body)) continue;
    const at = lineAt(line) || now;
    memory.errors.push({ sig: normalizeSignature(line), at });
  }
  memory.errors = memory.errors.filter(item => now - item.at < REPEAT_WINDOW_MS).slice(-200);
}

function repeatedError(memory) {
  const counts = new Map();
  for (const item of memory.errors) counts.set(item.sig, (counts.get(item.sig) || 0) + 1);
  let best = null;
  for (const [sig, count] of counts) {
    if (count >= REPEAT_N && (!best || count > best.count)) best = { sig, count };
  }
  return best;
}

function renderReport(parts) {
  const lines = [
    '# Agent Loop watcher',
    '',
    `- when: ${parts.when}`,
    `- playbook: ${parts.row} ${parts.title}`,
    `- matched: ${parts.matched}`,
    `- what the watcher did: ${parts.did}`,
    `- result: ${parts.result}`,
    `- loop: ${parts.loopNote}`,
    `- what to do next: ${parts.humanFix}`,
  ];
  if (parts.quotaText) lines.push(`- vendor reset text: ${parts.quotaText}`);
  if (parts.claudeNote) lines.push(`- claude: ${parts.claudeNote}`);
  if (parts.probeNote) lines.push(`- probe: ${parts.probeNote}`);
  lines.push('');
  return redact(lines.join('\n'));
}

function loopNoteFor(action, response) {
  if (action === 'kill_and_recover' || action === 'recover' || action === 'reset_stub') return 'the watcher starts the loop again after the fix';
  if (action === 'kill_lingering' || action === 'clear_stale_lock') return 'the loop stays stopped; start it from the button when you want it';
  if (response === 'STOP' || action === 'stop_and_report') return 'the watcher requested Safe Stop and will not start the loop again';
  if (response === 'WAIT') return 'the watcher left the loop running';
  return 'the watcher left the loop running and wrote this report';
}

function buildBundle(facts, hit, memory) {
  const lines = (facts.lines || []).slice(-200).map(line => redact(line));
  return {
    instruction: 'Reply with JSON only: {"diagnosis":"...","action":"<id>","confidence":0.0,"why":"...","human_fix":"..."}',
    trigger: hit.frozen ? 'frozen heartbeat with no playbook row' : 'repeated error with no playbook row',
    signature: memory.errors.length ? memory.errors[memory.errors.length - 1].sig : null,
    heartbeat: facts.heartbeat || null,
    logLines: lines,
    rounds: facts.rounds || null,
    version: facts.version || null,
    os: facts.os || null,
    allowlist: ACTIONS.map(id => ({ id, preconditions: preconditions(id, facts, memory).why })),
  };
}

function parseClaudeVerdict(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, reason: 'malformed JSON' };
  let body;
  try { body = JSON.parse(raw.slice(start, end + 1)); }
  catch { return { ok: false, reason: 'malformed JSON' }; }
  if (!body || typeof body !== 'object') return { ok: false, reason: 'malformed JSON' };
  const action = body.action;
  const confidence = Number(body.confidence);
  if (!ACTIONS.includes(action)) return { ok: false, reason: 'unknown action', action, confidence };
  if (!Number.isFinite(confidence) || confidence < CONFIDENCE_MIN) {
    return { ok: false, reason: 'low confidence', action, confidence };
  }
  return {
    ok: true,
    action,
    confidence,
    diagnosis: String(body.diagnosis || ''),
    why: String(body.why || ''),
    humanFix: String(body.human_fix || ''),
  };
}

function noDecision(memory) {
  return {
    row: null, title: null, response: null, action: null, needsClaude: false, bundle: null,
    effects: emptyEffects(), probeMode: null, taskId: null, coderName: null, matched: null,
    report: null, logLine: null, memory, summary: null, refused: null, quiet: false,
  };
}

// An in-progress stub repair survives the watcher stop flag it just wrote. A user Safe Stop
// cancels it. Returning null lets that user-stop path run.
function continueStubRepair(facts, mem) {
  const repair = mem.stubRepair;
  if (!repair) return null;
  if (isUserStop(facts.stopFlag)) {
    mem.stubRepair = null;
    return null;
  }
  const alive = facts.pidAlive === true || facts.lockPidAlive === true;
  if (alive) {
    if (p2Signals(facts) && identityMatches(facts)) {
      return {
        hit: {
          row: 'P2', response: 'AUTO', action: 'kill_lingering',
          line: facts.lastLogLine || null, taskId: repair.taskId || null,
        },
      };
    }
    return { quiet: true };
  }
  const stubFacts = { ...facts, taskId: repair.taskId, loopStopped: true };
  mem.stubRepair = null;
  if (facts.phase2 && preconditions('reset_stub', stubFacts, mem).ok) {
    return {
      hit: {
        row: 'P5', response: 'AUTO', action: 'reset_stub',
        line: repair.line || null, taskId: repair.taskId || null,
      },
    };
  }
  return {
    hit: {
      row: 'P5', response: 'NOTIFY', action: 'wait',
      line: repair.line || null, taskId: repair.taskId || null,
    },
  };
}

function evaluate(facts = {}, memory = {}, claude) {
  const now = Number.isFinite(facts.now) ? facts.now : Date.now();
  const mem = cloneMemory(memory);
  if (Number.isFinite(facts.nextOffset)) mem.offset = facts.nextOffset;
  if (mem.lastPass != null && facts.pass != null && facts.pass < mem.lastPass) mem.holds = {};
  if (facts.pass != null) mem.lastPass = facts.pass;
  const nonce = runNonce(facts);
  const resetRun = !!(facts.runReset || (nonce && mem.runId && mem.runId !== nonce));
  if (resetRun) clearRunState(mem);
  if (nonce) mem.runId = nonce;
  const freshLines = facts.lines || [];
  const buffer = [...(mem.keptLines || []), ...freshLines];
  if (buffer.some(line => /=== start:/.test(lineBody(line)))) mem.errors = [];
  const freshRun = linesAfterLatestStart(freshLines);
  mem.keptLines = linesAfterLatestStart(buffer).slice(-300);
  if (resetRun && typeof facts.readCommitCount === 'function') {
    mem.commitCounts = appendCommitCounts({}, freshRun, facts.readCommitCount);
  } else if (!resetRun && facts.commitCounts && typeof facts.commitCounts === 'object') {
    mem.commitCounts = copyCommitCounts(facts.commitCounts);
  }
  ingestErrors(freshRun, mem, now);
  const seen = { ...facts, lines: mem.keptLines, commitCounts: mem.commitCounts };

  if (mem.stubRepair) {
    const step = continueStubRepair(seen, mem);
    if (step && step.quiet) return noDecision(mem);
    if (step && step.hit) return finish(seen, mem, now, step.hit, claude);
  }

  if (isUserStop(facts.stopFlag) && p1Signals(seen) && identityMatches(seen)) {
    return finish(seen, mem, now, {
      row: 'P1', response: 'AUTO', action: 'kill_and_recover', line: null, noRestart: true,
      humanFix: 'The watcher kills the stuck process and deletes the lock. Your Safe Stop stays in place, so the loop is not started again.',
    }, claude);
  }

  if (isUserStop(facts.stopFlag) || isWatcherStop(facts.stopFlag)) {
    if (p2Signals(seen) && identityMatches(seen)) {
      return finish(seen, mem, now, { row: 'P2', response: 'AUTO', action: 'kill_lingering', line: facts.lastLogLine || null }, claude);
    }
    const row = isUserStop(facts.stopFlag) ? 'user-stop' : 'watcher-stop';
    return finish(seen, mem, now, {
      row, response: 'WAIT', action: 'wait', line: null,
      humanFix: fixedText('user-stop'),
    }, claude);
  }

  let hit = matchPlaybook(seen, now);
  if (hit && hit.row === 'P19' && Array.isArray(hit.repeats)) {
    const open = hit.repeats.find(item => !mem.notified[`P19:${item.taskId}`]);
    const pick = open || hit.repeats[0];
    hit = {
      row: 'P19', response: 'NOTIFY', action: 'wait',
      line: pick.line, count: pick.count, taskId: pick.taskId,
      signature: `P19:${pick.taskId}`,
    };
  }
  if (!hit) {
    const repeated = repeatedError(mem);
    if (repeated) hit = { row: 'P18', response: 'NOTIFY', action: 'ask_claude', line: repeated.sig, frozen: false, signature: repeated.sig };
  }
  if (!hit) return noDecision(mem);

  const signature = hit.signature || `${hit.row}:${normalizeSignature(hit.line || hit.row)}`;
  hit.signature = signature;
  if (mem.holds[signature] != null && facts.pass != null && facts.pass < mem.holds[signature]) {
    return noDecision(mem);
  }
  if (mem.quietUntil[signature] && now < mem.quietUntil[signature] && hit.row !== 'P1' && hit.row !== 'P2' && hit.response !== 'STOP' && hit.action !== 'stop_and_report') {
    const quiet = finish(facts, mem, now, hit, claude);
    quiet.logLine = null;
    quiet.effects = emptyEffects();
    quiet.report = null;
    quiet.quiet = true;
    return quiet;
  }
  return finish(facts, mem, now, hit, claude);
}

function finish(facts, mem, now, hit, claude) {
  const maxFixes = Number.isFinite(Number(facts.maxFixes)) ? Number(facts.maxFixes) : 2;
  const maxCalls = Number.isFinite(Number(facts.maxCallsPerHour)) ? Number(facts.maxCallsPerHour) : 4;
  let action = hit.action;
  let response = hit.response;
  let claudeNote = null;
  let diagnosis = hit.humanFix || fixedText(hit.row, hit);
  let refused = null;
  const signature = hit.signature || `${hit.row}:${normalizeSignature(hit.line || hit.row)}`;

  const auto = ['kill_and_recover', 'kill_lingering', 'clear_stale_lock', 'recover', 'reset_stub', 'bench_coder'].includes(action);
  if (auto && recentTimes(mem.fixes[signature], now, FIX_WINDOW_MS).length >= maxFixes) {
    action = 'stop_and_report';
    response = 'STOP';
    diagnosis = `The same signature already used ${maxFixes} automatic fix(es) in 6 hours. Stopping.`;
    hit.escalated = true;
  }

  if (action === 'ask_claude') {
    const calls = recentTimes(mem.claudeCalls, now, CALL_WINDOW_MS);
    if (claude && claude.unavailable) {
      claudeNote = `unavailable (${redact(claude.why || 'unknown')})`;
      action = hit.frozen ? 'stop_and_report' : 'wait';
      response = hit.frozen ? 'STOP' : 'NOTIFY';
    } else if (claude && claude.text) {
      const verdict = parseClaudeVerdict(claude.text);
      if (!verdict.ok) {
        claudeNote = `no fix (${verdict.reason})`;
        action = hit.frozen ? 'stop_and_report' : 'wait';
        response = hit.frozen ? 'STOP' : 'NOTIFY';
      } else {
        const gate = preconditions(verdict.action, { ...facts, incident: signature, coderCreditExhausted: creditExhausted(facts.coderLogText), coderName: hit.coderName, taskId: hit.taskId }, mem);
        if (!gate.ok) {
          refused = gate.why;
          claudeNote = `rejected ${verdict.action}: ${gate.why}`;
          action = hit.frozen ? 'stop_and_report' : 'wait';
          response = hit.frozen ? 'STOP' : 'NOTIFY';
        } else {
          action = verdict.action;
          response = action === 'stop_and_report' ? 'STOP' : action === 'wait' ? 'WAIT' : 'AUTO';
          diagnosis = verdict.diagnosis || diagnosis;
          hit.humanFix = verdict.humanFix || diagnosis;
          claudeNote = `action ${action} (${verdict.confidence})`;
        }
      }
    } else if ((facts.claudeMode === 'full') && calls.length < maxCalls && claude == null) {
      return {
        row: 'P18', title: TITLES.P18, response: null, action: null, needsClaude: true,
        bundle: buildBundle(facts, hit, mem), effects: emptyEffects(), probeMode: null,
        taskId: null, coderName: null, matched: redact(hit.line || ''), report: null,
        logLine: 'P18 needs a Claude decision', memory: mem, summary: TITLES.P18, refused: null, quiet: false,
      };
    } else {
      claudeNote = facts.claudeMode === 'full' ? 'unavailable (hourly call limit)' : 'unavailable (playbook only; claude is not on PATH)';
      action = hit.frozen ? 'stop_and_report' : 'wait';
      response = hit.frozen ? 'STOP' : 'NOTIFY';
    }
  }

  const view = {
    ...facts,
    incident: signature,
    coderCreditExhausted: creditExhausted(facts.coderLogText) || facts.coderCreditExhausted === true,
    coderName: hit.coderName || facts.coderName,
    taskId: hit.taskId || facts.taskId,
  };
  if (ACTIONS.includes(action)) {
    const gate = preconditions(action, view, mem);
    if (!gate.ok) {
      refused = gate.why;
      if (action === 'kill_and_recover' || action === 'kill_lingering') {
        action = 'wait';
        response = 'NOTIFY';
        diagnosis = `Refused to kill: ${gate.why}`;
      } else if (action !== 'wait' && action !== 'stop_and_report') {
        action = response === 'STOP' ? 'stop_and_report' : 'wait';
      }
    }
  }

  if (hit.row === 'user-stop' || hit.row === 'watcher-stop') {
    action = 'wait';
    response = 'WAIT';
    diagnosis = fixedText('user-stop');
  }

  const effects = effectsFor(ACTIONS.includes(action) ? action : 'wait');
  if (hit.row === 'user-stop' || hit.row === 'watcher-stop') {
    effects.start = false;
    effects.kill = false;
    effects.clearLock = false;
    effects.clearStop = false;
    effects.writeStopFlag = false;
    effects.recover = false;
  }
  if (hit.prepareStubReset) {
    effects.writeStopFlag = true;
    effects.start = false;
    effects.resetStub = false;
    effects.kill = false;
    mem.stubRepair = { taskId: hit.taskId || null, line: hit.line || null };
  }
  if (hit.noRestart) {
    effects.start = false;
    effects.clearStop = false;
    effects.writeStopFlag = false;
  }
  if (response === 'NOTIFY' || response === 'STOP') effects.notify = true;
  if (hit.alsoNotify) effects.notify = true;
  if (hit.thenStop) {
    effects.writeStopFlag = true;
    effects.notify = true;
    effects.start = false;
  }
  if (action === 'probe_coders') effects.probe = true;
  if (hit.waitMin) effects.waitMin = Math.min(MAX_WAIT_MIN, hit.waitMin);
  if (response === 'WAIT' && !effects.waitMin) effects.waitMin = 10;
  if (mem.notified[signature] && response === 'NOTIFY') effects.notify = false;

  if (['kill_and_recover', 'kill_lingering', 'clear_stale_lock', 'recover', 'reset_stub', 'bench_coder'].includes(action)) {
    mem.fixes[signature] = recentTimes(mem.fixes[signature], now, FIX_WINDOW_MS);
    mem.fixes[signature].push(now);
  }
  if (action === 'probe_coders') mem.probed[signature] = true;
  if (action === 'recover' || action === 'reset_stub') {
    const pass = Number.isFinite(facts.pass) ? facts.pass : 0;
    mem.holds[signature] = pass + BOARD_HOLD_PASSES;
  }
  if (response === 'WAIT' && hit.row !== 'user-stop' && hit.row !== 'watcher-stop') {
    mem.quietUntil[signature] = now + effects.waitMin * 60 * 1000;
  }
  if (effects.notify || response === 'STOP') mem.notified[signature] = now;

  const matched = hit.line ? redact(String(hit.line)) : '(no single log line)';
  const humanFix = hit.humanFix || diagnosis;
  const did = hit.escalated
    ? `escalated to stop_and_report after ${maxFixes} fix attempt(s)`
    : `${response} ${action}`;
  const report = renderReport({
    when: new Date(now).toISOString(),
    row: hit.row,
    title: TITLES[hit.row] || hit.row,
    matched,
    did,
    result: refused ? `refused (${refused})` : did,
    loopNote: hit.noRestart
      ? 'the watcher killed the stuck process and left your Safe Stop in place'
      : hit.prepareStubReset
        ? 'the watcher stopped the loop and will reset the stub after it exits'
        : hit.row === 'user-stop' || hit.row === 'watcher-stop'
        ? 'the watcher will not restart a loop that was stopped'
        : loopNoteFor(action, response),
    humanFix,
    quotaText: hit.quotaText || null,
    claudeNote,
    probeNote: null,
  });
  const logLine = `${hit.row} ${TITLES[hit.row] || ''} → ${did}${refused ? ` (refused: ${refused})` : ''}`;
  return {
    row: hit.row,
    title: TITLES[hit.row] || hit.row,
    response,
    action,
    needsClaude: false,
    bundle: null,
    effects,
    probeMode: hit.probeMode || null,
    taskId: view.taskId || null,
    coderName: view.coderName || null,
    matched,
    report,
    logLine: redact(logLine),
    memory: mem,
    summary: `${TITLES[hit.row] || hit.row}: ${humanFix}`.slice(0, 240),
    humanFix,
    refused,
    quiet: false,
    signature,
  };
}

function killProcessTree(pid, opts = {}) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, detail: 'no pid' };
  const platform = opts.platform || process.platform;
  if (platform === 'win32') {
    const spawnSync = opts.spawnSync || cp.spawnSync;
    const r = spawnSync('taskkill', ['/PID', String(id), '/T', '/F'], {
      stdio: 'ignore', windowsHide: true, timeout: 5000,
    });
    return { ok: r.status === 0 || r.status === 128, detail: `taskkill exit ${r.status}` };
  }
  const kill = opts.kill || ((target, sig) => process.kill(target, sig));
  try {
    kill(-id, 'SIGKILL');
    return { ok: true, detail: 'killed process group' };
  } catch (e) {
    try {
      kill(id, 'SIGKILL');
      return { ok: true, detail: 'killed pid' };
    } catch (e2) {
      if (e2.code === 'ESRCH') return { ok: true, detail: 'already gone' };
      return { ok: false, detail: e2.message };
    }
  }
}

function settleKill(input = {}) {
  if (!input.requested) return { proceed: true, reason: null };
  if (!input.identityOk) return { proceed: false, reason: 'lock nonce does not match the heartbeat' };
  if (input.stillAlive) return { proceed: false, reason: input.detail || 'pid still alive after kill' };
  return { proceed: true, reason: null };
}

function pidExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

async function waitUntilDead(pid, opts = {}) {
  const alive = opts.alive || pidExists;
  const wait = opts.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 10_000;
  const stepMs = opts.stepMs || 200;
  const start = Date.now();
  while (alive(pid)) {
    if (Date.now() - start >= timeoutMs) return false;
    const left = timeoutMs - (Date.now() - start);
    await wait(Math.min(stepMs, Math.max(0, left)));
  }
  return true;
}

function spawnCaptured(argv, { input = null, cwd, timeoutMs = CLAUDE_TIMEOUT_MS } = {}) {
  const dir = cwd || fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-watcher-'));
  const cmd = Array.isArray(argv) ? argv.map(quoteCmdArg).join(' ') : String(argv);
  return new Promise(resolve => {
    let out = '';
    let err = '';
    let settled = false;
    const child = cp.spawn(cmd, {
      cwd: dir, shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, cwd: dir, text: redact(out), err: redact(err) });
    };
    const timer = setTimeout(() => {
      killProcessTree(child.pid);
      finish({ ok: false, unavailable: true, why: 'timeout', code: null });
    }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => finish({ ok: false, unavailable: true, why: e.message, code: null }));
    child.on('close', code => {
      if (code === 0) {
        finish({ ok: true, unavailable: false, why: null, code });
        return;
      }
      const auth = /not logged|authentication|organization|usage limit|rate limit|quota/i.test(err);
      finish({
        ok: false,
        unavailable: true,
        why: auth ? redact(err).slice(0, 300) : `exit ${code}`,
        code,
      });
    });
    try {
      if (input != null) child.stdin.write(String(input));
      child.stdin.end();
    } catch { /* child already gone */ }
  });
}

async function runClaude(cmd, bundle, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-watcher-'));
  const payload = redact(typeof bundle === 'string' ? bundle : JSON.stringify(bundle));
  const argv = cmd ? null : DEFAULT_CLAUDE_ARGS;
  const command = cmd || argv.map(quoteCmdArg).join(' ');
  const result = await spawnCaptured(command, { input: payload, cwd: dir, timeoutMs: opts.timeoutMs || CLAUDE_TIMEOUT_MS });
  if (!result.ok) return result;
  if (!parseClaudeVerdict(result.text).ok) {
    return { ...result, ok: false, unavailable: true, why: 'no parseable verdict' };
  }
  return result;
}

function probePlan(mode) {
  const prompt = 'Reply with exactly: OK';
  if (mode === 'review') {
    return [
      { name: 'claude', command: 'claude -p --model sonnet', input: prompt },
      { name: 'codex', command: 'codex exec --sandbox workspace-write -c model_reasoning_effort="medium"', input: prompt },
      { name: 'grok', command: null, promptFile: true, input: prompt },
    ];
  }
  return [
    { name: 'claude', command: 'claude -p --model sonnet', input: prompt },
    { name: 'codex', command: 'codex login status', input: null },
    { name: 'grok', command: null, promptFile: true, input: prompt },
  ];
}

async function runProbes(mode, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-probe-'));
  const pieces = [];
  for (const item of probePlan(mode)) {
    let command = item.command;
    let input = item.input;
    if (item.promptFile) {
      const file = path.join(dir, `${item.name}-prompt.txt`);
      fs.writeFileSync(file, item.input);
      command = `grok --prompt-file "${file}" --always-approve --no-plan --max-turns 2 --output-format plain`;
      input = null;
    }
    if (opts.runner) {
      pieces.push(`${item.name}: ${redact(await opts.runner(item))}`);
      continue;
    }
    const result = await spawnCaptured(command, { input, cwd: dir, timeoutMs: opts.timeoutMs || 60_000 });
    pieces.push(`${item.name}: ${redact(result.text || result.why || '')}`);
  }
  return pieces.join('\n');
}

function loadMemory(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? { ...emptyMemory(), ...parsed } : emptyMemory();
  } catch { return emptyMemory(); }
}

function saveMemory(file, memory) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(memory));
  fs.renameSync(tmp, file);
}

function appendLog(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `[${new Date().toISOString()}] ${redact(line)}\n`);
}

function writeReport(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, redact(body));
  fs.renameSync(tmp, file);
}

function newestMtime(dir) {
  let newest = 0;
  const walk = current => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) walk(full);
        else newest = Math.max(newest, fs.statSync(full).mtimeMs);
      } catch { /* unreadable file is not newer evidence */ }
    }
  };
  walk(dir);
  return newest;
}

function parseSample(text) {
  const out = { cpu: null, read: null, write: null, children: [], missing: false };
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line.trim() === 'MISSING') out.missing = true;
    const cpu = /^CPU=(-?\d+)/.exec(line);
    const read = /^READ=(-?\d+)/.exec(line);
    const write = /^WRITE=(-?\d+)/.exec(line);
    const kids = /^KIDS=(.*)$/.exec(line);
    if (cpu) out.cpu = Number(cpu[1]);
    if (read) out.read = Number(read[1]);
    if (write) out.write = Number(write[1]);
    if (kids) out.children = kids[1].split(',').map(s => s.trim()).filter(Boolean).map(name => ({ name }));
  }
  return out;
}

function sampleScript(pid) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) throw new Error('pid must be an integer');
  if (process.platform === 'win32') {
    return `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${id}"; if (-not $p) { 'MISSING'; exit }; $cpu = [int64]$p.KernelModeTime + [int64]$p.UserModeTime; $read = [int64]$p.ReadTransferCount; $write = [int64]$p.WriteTransferCount; $kids = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=${id}" | ForEach-Object { $_.Name }); "CPU=$cpu"; "READ=$read"; "WRITE=$write"; "KIDS=$($kids -join ',')"`;
  }
  return `if [ ! -d /proc/${id} ]; then echo MISSING; exit 0; fi; awk '{print "CPU=" ($14+$15)*10}' /proc/${id}/stat; awk '/^(read_bytes|write_bytes)/{print toupper(substr($1,1,4)) "=" $2}' /proc/${id}/io; kids=$(ps -o comm= --ppid ${id} | paste -sd, -); echo "KIDS=$kids"`;
}

async function sampleProcess(pid, opts = {}) {
  const gapMs = opts.gapMs == null ? 10_000 : opts.gapMs;
  const read = opts.read || (script => cp.execFileSync(
    process.platform === 'win32' ? 'powershell' : 'sh',
    process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', script] : ['-c', script],
    { encoding: 'utf8', timeout: 8000, windowsHide: true },
  ));
  const wait = opts.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  try {
    const first = parseSample(read(sampleScript(pid)));
    if (first.missing) return { cpuRatio: null, ioUnchanged: null, ioGapMs: gapMs, children: null };
    await wait(gapMs);
    const second = parseSample(read(sampleScript(pid)));
    if (second.missing || first.cpu == null || second.cpu == null) {
      return { cpuRatio: null, ioUnchanged: null, ioGapMs: gapMs, children: second.children || null };
    }
    const cpuSeconds = process.platform === 'win32'
      ? (second.cpu - first.cpu) / 1e7
      : (second.cpu - first.cpu) / 1000;
    const cpuRatio = cpuSeconds / (gapMs / 1000);
    const ioUnchanged = first.read === second.read && first.write === second.write;
    return { cpuRatio, ioUnchanged, ioGapMs: gapMs, children: second.children };
  } catch {
    return { cpuRatio: null, ioUnchanged: null, ioGapMs: gapMs, children: null };
  }
}

const NARRATION_PENDING_CAP = 30;
const NARRATION_MIN_MS = 300 * 1000;

function watcherVerbose(value) {
  if (value == null || String(value).trim() === '') return true;
  return !/^(off|false|0|no)$/i.test(String(value).trim());
}

function narrationMode(value) {
  const mode = String(value || 'off').trim().toLowerCase();
  if (mode === 'problems' || mode === 'events') return mode;
  return 'off';
}

function narrationMinMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return NARRATION_MIN_MS;
  return Math.floor(n * 1000);
}

function narrationArgs(base = DEFAULT_CLAUDE_ARGS) {
  return base.filter(arg => arg !== '--no-session-persistence' && arg !== '--bare');
}

function narrationCommand({ sessionId, resume = false } = {}, base) {
  const args = narrationArgs(base);
  const at = args.indexOf('-p');
  args.splice(at >= 0 ? at + 1 : args.length, 0, resume ? '--resume' : '--session-id', sessionId);
  return args;
}

function narrationSessionId(randomUUID) {
  const make = randomUUID || (() => require('crypto').randomUUID());
  return make();
}

// A recorded size and mtime is the watcher's own write. Any other change means
// the human typed in the session, so the next turn starts a new one.
function sessionChangedByOther(recorded, current) {
  if (!recorded || !Number.isFinite(recorded.size) || !Number.isFinite(recorded.mtimeMs)) return false;
  if (!current || current.exists === false) return true;
  return current.size !== recorded.size || current.mtimeMs !== recorded.mtimeMs;
}

function findSessionStat(root, sessionId, fsApi = fs) {
  if (!root || !sessionId) return { exists: false };
  let names = [];
  try { names = fsApi.readdirSync(root, { withFileTypes: true }); }
  catch { return { exists: false }; }
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, `${sessionId}.jsonl`);
    try {
      const st = fsApi.statSync(file);
      return { exists: true, size: st.size, mtimeMs: st.mtimeMs };
    } catch { /* a different project directory */ }
  }
  return { exists: false };
}

// Stage changes, status lines, verdicts and kills. A repeated `… coder stage`
// heartbeat tick is not an event.
function notableEvents({ lines = [], heartbeat = null, previous = null } = {}) {
  let stage = previous && previous.stage || null;
  let stageTask = previous && previous.stageTask || null;
  const events = [];
  for (const line of lines || []) {
    const body = lineBody(line).trim();
    const tick = /^…\s+(?:claude|codex|grok)\s+(implement|review|adjudicate|verify|land|probe)\s+(\S+)/i.exec(body);
    if (tick || /^…\s+/.test(body)) {
      if (tick) {
        const nextStage = tick[1].toLowerCase();
        const taskId = tick[2];
        if (nextStage !== stage || taskId !== stageTask) {
          events.push({ kind: 'stage', stage: nextStage, taskId, text: `${taskId} stage ${nextStage}` });
          stage = nextStage;
          stageTask = taskId;
        }
      }
      continue;
    }
    const status = /^(\S+)\s+→\s+(\S.*)$/.exec(body);
    if (status) {
      events.push({
        kind: 'status', taskId: status[1], status: status[2].trim(),
        text: `${status[1]} → ${status[2].trim()}`,
      });
      continue;
    }
    const named = /^(\S+)\s+(?:claude|codex|grok)=(pass|fail)\b/i.exec(body);
    const adj = /^(\S+)\s+Claude adjudication=(pass|fail)\b/.exec(body);
    if (named || adj) {
      events.push({ kind: 'verdict', taskId: (named || adj)[1], text: redact(body) });
      continue;
    }
    if (/killed-ceiling|killed-idle|TIMEOUT after/.test(body)) {
      events.push({ kind: 'kill', taskId: taskOf(body), text: redact(body) });
    }
  }
  if (heartbeat && heartbeat.stage && heartbeat.stage !== stage) {
    const taskId = stageTask;
    events.push({
      kind: 'stage', stage: heartbeat.stage, taskId,
      text: taskId ? `${taskId} stage ${heartbeat.stage}` : `stage ${heartbeat.stage}`,
    });
    stage = heartbeat.stage;
  }
  return { events, state: { stage, stageTask } };
}

function unmatchedNotable(lines) {
  const hits = (lines || []).filter(line => /\bFAILED\b|\bFAIL\b|killed-ceiling|killed-idle|TIMEOUT after/.test(lineBody(line)));
  if (!hits.length) return null;
  const detail = hits.map(line => redact(lineBody(line).trim())).join('\n');
  return { kind: 'notable', text: `notable event, no row matched\n${detail}` };
}

function planNarration({
  mode = 'off', now = 0, minMs = NARRATION_MIN_MS, maxCalls = 4,
  calls = [], lastSentAt = null, pending = [], incoming = [],
} = {}) {
  if (narrationMode(mode) === 'off') return { send: false, pending: [], reason: 'off' };
  const selected = narrationMode(mode);
  const wanted = [];
  for (const item of incoming || []) {
    if (item.kind === 'playbook' || item.kind === 'notable') wanted.push(item);
    else if (selected === 'events' && ['stage', 'status', 'verdict', 'kill', 'error'].includes(item.kind)) wanted.push(item);
  }
  const held = [...(pending || []), ...wanted];
  const recent = (calls || []).filter(t => now - t < CALL_WINDOW_MS);
  if (held.length && recent.length >= maxCalls) {
    return {
      send: false, pending: [], reason: 'budget',
      channelLine: 'narration skipped: hourly call limit',
    };
  }
  const immediate = held.some(item => item.kind === 'playbook');
  const queue = held.slice(-NARRATION_PENDING_CAP);
  if (immediate) return { send: true, items: queue, pending: [], reason: 'row' };
  const due = lastSentAt == null || now - lastSentAt >= minMs;
  if (queue.length && due) return { send: true, items: queue, pending: [], reason: 'batch' };
  return { send: false, pending: queue, reason: queue.length ? 'rate' : 'empty' };
}

function narrationPrompt(items, { first = false } = {}) {
  const lines = (items || []).map(item => redact(item.text || '')).filter(Boolean);
  if (!first) return lines.join('\n');
  const parts = [
    'You are the Agent Loop watcher narrator.',
    'Explain in short, plain sentences what happened, whether it is normal, and what the human should do.',
    'Nothing is a valid answer.',
    'Do not invent causes the log does not show.',
  ];
  const matched = (items || []).find(item => item.row);
  if (matched) {
    parts.push(`Matched ${matched.row}${matched.title ? `: ${matched.title}` : ''}.`);
    if (matched.fixed) parts.push(redact(matched.fixed));
  }
  parts.push('Lines:');
  parts.push(lines.join('\n'));
  return parts.join('\n');
}

const CLAUDE_PANEL_VIEW = 'claudeVSCodePanel';
const NARRATION_TRUST_LINE = 'Open this folder in Claude Code once and accept the trust prompt.';

function claudePanelViewType(tab) {
  if (!tab || typeof tab !== 'object') return '';
  const input = tab.input && typeof tab.input === 'object' ? tab.input.viewType : '';
  return String(tab.viewType || input || '');
}

function isClaudePanelTab(tab) {
  return claudePanelViewType(tab).endsWith(CLAUDE_PANEL_VIEW);
}

// `before` and `after` are tab objects. Identity is the match. One new Claude
// panel tab is that tab. None, a different view type, or two new Claude tabs
// is no result — two new tabs are ambiguous.
function findNewClaudeTab(before, after) {
  const prior = new Set(before || []);
  const seen = new Set();
  const added = [];
  for (const tab of after || []) {
    if (!tab || prior.has(tab) || seen.has(tab) || !isClaudePanelTab(tab)) continue;
    seen.add(tab);
    added.push(tab);
  }
  return added.length === 1 ? added[0] : null;
}

// open: show the session. refresh: close and open the editor tab again.
// defer: the human is in that tab. leave: they closed it.
function narrationSurfaceAction({ presented = false, tracked = false, open = false, focused = false } = {}) {
  if (!presented || !tracked) return 'open';
  if (!open) return 'leave';
  if (focused) return 'defer';
  return 'refresh';
}

function narrationTrustFailure(text) {
  return /has not been trusted/i.test(String(text || ''));
}

module.exports = {
  PHASE2, ACTIONS, DEFAULT_CLAUDE_ARGS, DEFAULT_CLAUDE_CMD, CLAUDE_TIMEOUT_MS,
  WATCHER_START_GRACE_MS, NARRATION_PENDING_CAP,
  REPEAT_N, REPEAT_WINDOW_MS, CONFIDENCE_MIN, P7_WINDOW_MS,
  redact, readNewLog, normalizeSignature, stageLimitMs, tailText, creditExhausted, taskOf,
  isUserStop, isWatcherStop, watcherStopText, identityMatches, preconditions,
  parseClaudeVerdict, evaluate, quoteCmdArg, killProcessTree, settleKill, waitUntilDead, spawnCaptured, runClaude,
  probePlan, runProbes, loadMemory, saveMemory, appendLog, writeReport, newestMtime,
  parseSample, sampleScript, sampleProcess, watcherMode, pollSeconds, claudeOnPath,
  emptyMemory, forgetRun, p1Signals, p2Signals, coderWasActiveBeforeKill,
  effectiveWatcherMode, claudeSelfCheckPassed, claudeSelfCheckLog,
  watcherShouldStop, shouldEnsureWatcher, parseStubLine, safeGitRef, appendCommitCounts,
  watcherVerbose, narrationMode, narrationMinMs, narrationArgs, narrationCommand,
  narrationSessionId, sessionChangedByOther, findSessionStat, notableEvents,
  unmatchedNotable, planNarration, narrationPrompt, copyNarration, emptyNarration,
  isClaudePanelTab, findNewClaudeTab, narrationSurfaceAction, narrationTrustFailure,
  NARRATION_TRUST_LINE,
};
