#!/usr/bin/env node
/**
 * agent-loop.mjs — user-run UNIVERSAL dispatcher for the ClickUp agent loop.
 *
 * WHY: Claude Code's auto-mode classifier won't let Claude spawn grok/codex. This script
 * is YOUR process, so nothing gates it. It self-routes: on every pass it senses which of
 * the three agents (Claude, Codex, Grok) are available and picks the best workflow. There
 * is ONE entry point and one button — no --mode / --reviewers to choose.
 *
 * AVAILABILITY MATRIX (C=Claude X=Codex G=Grok; "available" = CLI up & not rate-limited):
 *   C X G  Grok codes → Codex reviews  → pass: Approved (Claude lands next pass) · 5r: re-scope → ready or stalled
 *   C X .  Claude codes → Codex reviews → pass: Approved (Claude lands next pass) · 5r: re-scope → ready or stalled
 *   C . G  Grok codes → Claude reviews  → pass: Approved (Claude lands next pass) · 5r: re-scope → ready or stalled
 *   C . .  Claude codes+self-review     → pass: leave on Review (await Codex) · 5r: re-scope → ready or stalled
 *   . X G  Grok codes → Codex reviews   → pass: put on Approved (await Claude) · 5r: stalled
 *   . X .  STOP (reviewer up, no coder)
 *   . . G  Grok codes+self-review       → pass: leave on Review · 5r: stalled
 *   . . .  STOP (no coder)
 * INVARIANT: nothing is ever committed/pushed that was reviewed by the agent that wrote it. Codex
 *   reviews whenever it is up; when Codex is down, Claude reviews and MAY land — but only work Grok
 *   coded. Claude-coded + Claude-reviewed still parks on Review awaiting Codex, because there the
 *   reviewer would be the author. Deploy is ALWAYS human-gated.
 * NEVER PICKED UP: the planning column (see NEVER_PICKUP), TRACKER ONLY epics, and ANY task that has
 *   subtasks — on every path, including an explicit <taskId>. The subtask rule is the load-bearing
 *   one: the TRACKER ONLY marker only works if someone typed it, and on a ClickUp plan that has spent
 *   its custom-field usages it cannot even be added to an existing task (400 FIELD_033). Having
 *   children needs no maintenance — a parent tracks work, it is not the work. A task is ALSO refused when its PARENT sits in the planning
 *   column, so parking an epic there holds its entire chain without editing every child. That costs
 *   one extra read per candidate and fails closed: a parent that cannot be read defers the task to
 *   the next pass rather than guessing it is free to run.
 * TRACKER ROLL-UP: a tracker is never implemented, but its status is kept honest. Every pass, a
 *   parent whose children are ALL done becomes `committed`, and one whose children are all
 *   done-or-approved (at least one approved — Codex signed off, Claude has not landed them) becomes
 *   `approved`. Forward-only: a done parent is never walked backwards. Costs two queue reads plus
 *   one read per candidate parent, and needs no agent, so it runs whatever is available.
 *
 * When Claude is available, each pass first does PM housekeeping before coding new work:
 *   - verify + land Codex-approved parked tasks in dependency order (parents before children),
 *   - drain the Review queue through Codex (if up) → Approved on pass,
 *   - then start the normal coding lane.
 * If Claude is down, Approved stays parked while the degraded coding lane continues.
 *
 * STALLED: a task that churns MAX_ROUNDS without converging gets ONE Claude re-scope diagnosis
 * (Opus). If Claude is up AND judges it a fixable AC/description contradiction, THIS dispatcher
 * (the only thing holding the ClickUp token — the re-scope call itself never gets it) applies
 * Claude's corrected description and returns the task straight to `ready`; the round continues,
 * nothing stops. Only a genuine multi-concern split (needs a human to break it into subtasks), or
 * Claude being unavailable to even attempt the diagnosis, actually parks the task on `stalled` — and
 * ANY pre-existing Stalled task also gets a fresh resolution attempt at the top of every pass while
 * Claude is up (see stalledStopOutcome), before the dispatcher gives up and reports a stop. The
 * dispatcher only truly stops before probes/new work when Claude is down and can't resolve it, or
 * when the diagnosis itself concluded a human split is required.
 *
 * A coder that exits 0 having changed NOTHING is only stalled when its branch is empty too. If the
 * branch already carries commits beyond its base, an earlier round finished the work (typically a
 * coder that timed out during wrap-up, whose commit is labelled PARTIAL but is complete) and the
 * task goes to `in review` instead — stalling it there would halt the queue over work that is done.
 * The re-scope prompt is told the task's REAL round count for the same reason: asserting "you
 * churned MAX_ROUNDS, it must be too big" to diagnose a round-1 no-op invites a bogus split.
 *
 * PREREQS: Node 18+, and grok / codex / claude on PATH. A ClickUp personal API token.
 *
 * TOKEN: keep it OUTSIDE the repo — task branches reset to main, so a token file inside the
 *        repo can get swept into a commit. Create ~/.agent-loop.env with one line:
 *          CLICKUP_TOKEN=pk_your_token_here
 *        The script auto-loads it. (ClickUp → Settings → Apps → API Token.)
 *
 * USE:  run from the root of the git repository the loop should work on. The VS Code button does
 *       this for you (it launches the copy bundled inside the extension); these are the same
 *       entry points by hand.
 *         node agent-loop.mjs --watch    # the universal loop (what the button runs)
 *         node agent-loop.mjs            # one pass, then exit
 *         node agent-loop.mjs <taskId>   # force one specific task through the lane
 *         node agent-loop.mjs --check    # token + board + required-status probe, no agents
 *         node agent-loop.mjs --selftest # unit-test the verdict parser, no network
 *
 * SINGLE INSTANCE: two --watch instances race on the shared git tree and corrupt each other.
 *   A PID lock (~/.agent-loop.lock) refuses a second launch and self-heals a stale lock.
 *
 * SAFE STOP: the dispatcher OWNS the working tree while it runs, so don't edit files there. When you
 *   need the repo back, request a cooperative stop instead of killing the terminal:
 *     - press the Agent Loop status-bar button while it is running (or run "Agent Loop: Safe Stop"), or
 *     - create the flag by hand:  echo stop > ~/.agent-loop.stop
 *   The loop then finishes the round it is already in (never interrupting a coder or reviewer
 *   mid-flight), writes a handover report to ~/.agent-loop-stop-report.md (working-tree state, board
 *   snapshot, churn tally, how to resume), clears the flag, releases the lock and exits 0. A Safe
 *   Stop pressed during the idle window is picked up within ~3s. Killing the terminal instead is a
 *   HARD stop: it can leave a task on `coding` (the next start/pass safely recovers it to `in review`
 *   when its branch has commits, otherwise to `ready`).
 *
 * ISOLATION: every coder/reviewer/verify/re-scope call runs in its own throwaway `git clone` under
 *   os.tmpdir() (no remotes, no credential helper, sanitized env — see agentChildEnv), never the
 *   primary tree. Only THIS process ever touches the primary repo, and only to fetch+CAS-import a
 *   sandbox's branch tip or push an already-reviewed SHA. This is defense-in-depth, NOT an OS
 *   filesystem jail: nothing stops an agent given (or that invents) an absolute path from reaching
 *   the primary repo anyway. So every agent call snapshots the primary's `git status --porcelain`
 *   immediately before and after; any change is treated as a fatal, fenced stop for a human to
 *   inspect (detects the escape, does not prevent it). Closing this for real needs an OS-level
 *   sandbox (container / Job Object with a restricted token / Windows Sandbox) — out of scope here.
 *
 * DEPENDENCIES: a `ready` task is only picked up when every task in its "Blocked By" custom
 *   field OR native ClickUp dependency ("waiting_on") is Approved or done/closed. Approved
 *   deliberately unblocks its child so degraded-mode coding can continue from the exact reviewed
 *   parent branch while Claude is unavailable. Epics use the custom field, subtasks use native
 *   deps (the custom-field-usage plan cap can be hit on a large breakdown).
 *
 * BRANCH CHAINING: a fresh implement forks from BASE, unless the task has EXACTLY ONE Approved
 *   or done blocker — then it forks from that blocker's branch so a sequential chain accumulates.
 *   Review diffs against the same base, so reviewers see only each task's own increment.
 *
 * CONFIG (env, most from the .env file): CLICKUP_TOKEN (required), AGENT_LOOP_LIST_ID (required —
 *   no default board; a checkout that forgets this fails loudly instead of hitting someone else's
 *   board), AGENT_LOOP_REPO (default cwd), AGENT_LOOP_BASE (default main),
 *   AGENT_LOOP_VERIFY (test cmd; empty=skip) runs in a PERSISTENT sandbox reused across every verify
 *   (default ~/.agent-loop-verify-sandbox, override AGENT_LOOP_VERIFY_SANDBOX) — just a git checkout
 *   of the reviewed SHA each time, not a fresh clone, so gitignored dirs seeded once (see next) survive
 *   forever untouched. AGENT_LOOP_VERIFY_SEED_DIRS (comma-separated repo-relative dep dirs, e.g.
 *   vendor/node_modules/a sqlite db file) are copied from the primary repo into that sandbox ONCE, on
 *   first creation — without this VERIFY fails every time on a missing-dependency error unrelated to
 *   the diff, since a git clone/checkout never materializes gitignored files (default empty=none),
 *   AGENT_LOOP_CONTRACT_FILE (optional per-repo prompt
 *   addendum — e.g. a locale/i18n contract or required test pattern — appended to every
 *   implement/review prompt if present; default <repo>/tools/agent-loop.contract.md, silently
 *   omitted if missing — this script itself carries no project-specific instructions),
 *   AGENT_LOOP_POLL (watch interval s, default 60), AGENT_LOOP_MAX_ROUNDS (default 5),
 *   AGENT_LOOP_HEARTBEAT_S (terminal progress tick during long agent stages, default 30, 0=off),
 *   AGENT_LOOP_IMPLEMENT_TIMEOUT_S (default 1200) / _REVIEW_TIMEOUT_S (600) / _VERIFY_TIMEOUT_S
 *   (1500) — raise the verify cap for a slow full-suite gate,
 *   AGENT_LOOP_GIT_TIMEOUT_S (default 120), AGENT_LOOP_CLICKUP_TIMEOUT_S (default 30),
 *   AGENT_LOOP_LOG, AGENT_LOOP_LOCK, AGENT_LOOP_ROUNDS (durable churn tally), AGENT_LOOP_ENV,
 *   plus command overrides
 *   AGENT_LOOP_CLAUDE_IMPLEMENT / _CLAUDE_CMD / _CLAUDE_RESCOPE_CMD / _CODEX_CMD / _CODEX_PROBE_CMD / _GROK_CMD
 *   (see CMD below).
 *
 * BOARD PORTABILITY: every ClickUp status name and custom-field name is a board-config default,
 *   not a hardcoded assumption — point AGENT_LOOP_LIST_ID at any new/future list and it works
 *   unmodified as long as that list's workflow uses the same 8 status names (ready/coding/in
 *   review/changes requested/blocked/stalled/approved/committed) and the two custom fields
 *   "Acceptance Criteria" / "Blocked By". If a new board spells any of those differently, override
 *   via env — no code edit: AGENT_LOOP_STATUS_READY / _CODING / _REVIEW / _CHANGES / _BLOCKED /
 *   _STALLED / _APPROVED / _COMMITTED, and AGENT_LOOP_AC_FIELD / AGENT_LOOP_BLOCKED_BY_FIELD.
 *   `--check` reads these same vars, so it validates whatever board this run is actually pointed at.
 *   Task ORDERING never depends on naming/numbering conventions (no "M14a-3"-style parsing anywhere)
 *   — only native ClickUp dependencies + the Blocked By field, so any task-naming scheme works.
 *
 * MODEL: Claude runs on Sonnet everywhere (coding, reviewing, probing) except one call — the
 *   re-scope diagnosis fired when a task hits MAX_ROUNDS without converging (split vs. AC-fix
 *   judgment call) — which runs on Opus. See CMD.claudeRescope below.
 */

import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdtempSync, appendFileSync, existsSync, readFileSync, unlinkSync, rmSync, renameSync, statSync, utimesSync, cpSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve as pathResolve, sep as pathSep, normalize as pathNormalize } from 'node:path';

// ---------- args ----------
const argv = process.argv.slice(2);
const opts = { watch: false, selftest: false, check: false, taskId: null };
for (const a of argv) {
  if (a === '--watch') opts.watch = true;
  else if (a === '--selftest') opts.selftest = true;
  else if (a === '--check') opts.check = true;
  else if (!a.startsWith('--')) opts.taskId = a;
}

// ---------- .env (gitignored — this is where CLICKUP_TOKEN goes) ----------
for (const p of [process.env.AGENT_LOOP_ENV, `${homedir()}/.agent-loop.env`].filter(Boolean)) {
  try {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    break;
  } catch {}
}

// ---------- config ----------
const TOKEN   = process.env.CLICKUP_TOKEN;
// No hardcoded default: this dispatcher is generic across repos/boards, and silently falling back
// to one specific ClickUp board would mean a checkout that forgot to set this talks to somebody
// else's board instead of failing loudly.
const LIST_ID = process.env.AGENT_LOOP_LIST_ID;
const REPO    = process.env.AGENT_LOOP_REPO || process.cwd();
const BASE    = process.env.AGENT_LOOP_BASE || 'main';
const VERIFY  = process.env.AGENT_LOOP_VERIFY || '';
// VERIFY runs in a throwaway `git clone` (openDetachedWorktree), which — like any git clone — never
// contains gitignored dependency dirs (vendor/, node_modules/). Without this, a VERIFY that needs
// installed packages fails on EVERY run with a missing-autoloader/missing-module error that has
// nothing to do with the diff being verified (reproduced live: every task bounced to "changes
// requested" on a fake failure). Comma-separated repo-relative paths, copied from the PRIMARY repo
// into the verify sandbox before VERIFY runs — reusing what's already installed there instead of
// reinstalling from scratch (measured: a cold `composer install` alone took ~6 minutes, most of
// VERIFY's 10-minute cap). Default empty: no behavior change for a repo that doesn't need this.
const VERIFY_SEED_DIRS = (process.env.AGENT_LOOP_VERIFY_SEED_DIRS || '').split(',').map(s => s.trim()).filter(Boolean);
// Optional per-repo prompt addendum (e.g. a locale/i18n contract, a required test pattern) —
// baked into every implement/review prompt if the file exists, otherwise silently omitted. Lets a
// specific project shape agent behavior WITHOUT any project-specific text living in this script.
const CONTRACT_FILE = process.env.AGENT_LOOP_CONTRACT_FILE || join(REPO, 'tools', 'agent-loop.contract.md');
const PROJECT_CONTRACT = existsSync(CONTRACT_FILE) ? readFileSync(CONTRACT_FILE, 'utf8').trim() : '';
// Numeric env parsing that REFUSES garbage. A bare Number() turns a typo into NaN, and NaN
// silently breaks control flow: setTimeout(NaN) fires immediately (a 1ms busy loop that hammers
// the ClickUp API), and `rounds >= NaN` is always false (escalation could never fire).
// Every knob here ends up in setTimeout, whose delay is a SIGNED 32-BIT ms value: anything over
// 2**31-1 silently becomes a 1ms timer (verified: 2147484s → a 1ms busy loop, the very failure mode
// validation was added to prevent). So an upper bound is mandatory, not cosmetic — Number.isFinite
// is not enough. Bounds are per-knob and deliberately modest; nothing here needs days.
const TIMER_MAX_S = Math.floor((2 ** 31 - 1) / 1000);   // 2147483 s ≈ 24.8 days
export function num(envName, dflt, min, max = TIMER_MAX_S) {   // default bound, so an omitted max still can't make a 1ms timer
  const raw = process.env[envName];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    console.error(`⚠ ${envName}="${raw}" is invalid (need a number in [${min}, ${max}]) — using ${dflt}`);
    return dflt;
  }
  return n;
}
const POLL       = num('AGENT_LOOP_POLL', 60, 5, 86_400);   // <5s hammers the ClickUp API; >1 day is nonsense
const MAX_ROUNDS = num('AGENT_LOOP_MAX_ROUNDS', 5, 1, 100); // must be >=1 or escalation never fires
// Terminal heartbeat cadence for long agent stages. 0 disables. Read per call so --selftest can shorten it.
const heartbeatMs = () => num('AGENT_LOOP_HEARTBEAT_S', 30, 0, 86_400) * 1000;
// No TTY here: git must fail fast instead of waiting on a credential prompt that nothing can answer.
process.env.GIT_TERMINAL_PROMPT = '0';
export const TIMEOUT_CODE = 124;   // conventional `timeout(1)` exit code; callers treat non-zero as failure
// Stage timeouts. The defaults below come from measurement, not guesswork, on a queue that ran
// hundreds of real tasks — but the right value depends on YOUR suite, so each one is env-overridable.
//
// Implement: a 12-minute cap killed 19 of 25 implement lanes, and the log showed they were being cut
// off at the buzzer rather than thrashing — those lanes had committed 650-1441 insertion partials, one
// of which was a COMPLETE fix with a green suite that passed review verbatim once resubmitted. Lanes
// that did finish took a median 9.3min / max 10.5min, only ~1.5min of slack under that cap. 20 buys
// real headroom without hiding a lane that is genuinely stuck.
export const IMPLEMENT_TIMEOUT_MS = num('AGENT_LOOP_IMPLEMENT_TIMEOUT_S', 20 * 60, 60, 6 * 3600) * 1000;
// Review: diff-sized reads, median 2.4min, but a 6-minute wall was hit 7 times (one task twice in a
// row, then passed in 3.1min on the third try). 10 covers that tail.
export const REVIEW_TIMEOUT_MS = num('AGENT_LOOP_REVIEW_TIMEOUT_S', 10 * 60, 60, 6 * 3600) * 1000;
// Verify: the deterministic, credential-stripped gate has to finish a dependency refresh plus the
// full suite once. Raise this for a big mobile/monorepo suite; lower it for a fast unit-test command.
export const VERIFY_TIMEOUT_MS = num('AGENT_LOOP_VERIFY_TIMEOUT_S', 25 * 60, 60, 6 * 3600) * 1000;
const mmss = ms => `${Math.floor(ms / 60000)}m${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}s`;
class FatalLoopError extends Error {
  constructor(message, { preserveCoding = false, unsafeChild = false } = {}) {
    super(message);
    this.name = 'FatalLoopError';
    this.preserveCoding = preserveCoding;
    this.unsafeChild = unsafeChild;
  }
}

// ClickUp status/custom-field NAMES are board configuration, not code — a board is free to spell
// its workflow differently, and a brand-new list created tomorrow shouldn't need an edit here to
// work. Every literal below has an env override; the defaults are simply the names the setup wizard
// asks you to create, and `--check` validates whatever board this run is actually pointed at. Point
// AGENT_LOOP_LIST_ID at a new list and, if its ClickUp Status field or custom fields use different
// names, override the matching AGENT_LOOP_STATUS_*/AGENT_LOOP_*_FIELD var in its .env — no code edit.
const str = (envName, dflt) => process.env[envName] || dflt;
const S = {
  ready:     str('AGENT_LOOP_STATUS_READY',     'ready'),
  coding:    str('AGENT_LOOP_STATUS_CODING',    'coding'),
  review:    str('AGENT_LOOP_STATUS_REVIEW',    'in review'),
  changes:   str('AGENT_LOOP_STATUS_CHANGES',   'changes requested'),
  blocked:   str('AGENT_LOOP_STATUS_BLOCKED',   'blocked'),
  stalled:   str('AGENT_LOOP_STATUS_STALLED',   'stalled'),
  approved:  str('AGENT_LOOP_STATUS_APPROVED',  'approved'),
  committed: str('AGENT_LOOP_STATUS_COMMITTED', 'committed'),
};
const AC_FIELD   = str('AGENT_LOOP_AC_FIELD', 'Acceptance Criteria');
const AC_DESCRIPTION_MARKER = 'Agent Loop implementation contract';
const AC_DESCRIPTION_REPLACE_MARKER = 'Acceptance criteria mode: replace';
const BLOCKED_BY = str('AGENT_LOOP_BLOCKED_BY_FIELD', 'Blocked By');
// Statuses the dispatcher must NEVER pull work from, on ANY path — including an explicit <taskId>.
// The planning column is a parking spot for work a human has not finished specifying; a task sitting
// there is not a work order. Deliberately NOT part of S: the queues only ever query S's values, so
// listing it there would just make `--check` report a status the loop never needs as "MISSING".
// Both spellings ship by default deliberately. A board seen live spelled it "planned" one day and
// "planed" (one 'n') the next — a status NAME is board configuration a human can retype at any time,
// and matching only one spelling would let that silently turn the guard into a no-op. A guard that
// fails open on a typo is worse than no guard, so accept both.
const NEVER_PICKUP = new Set(
  str('AGENT_LOOP_STATUS_NEVER_PICKUP', 'planed,planned')
    .split(',').map(x => x.trim().toLowerCase()).filter(Boolean),
);
const CLICKUP    = 'https://api.clickup.com/api/v2';
// A rate-limit / quota / cooldown signature in an agent's output → treat that agent as down.
// Scoped so it won't fire on ordinary review prose that merely mentions "quota" or "try again".
const LIMIT_RE   = /you've hit your usage limit|usage limit|rate.?limit|quota exceeded|too many requests|resets? at|try again (?:later|at|in|on|tomorrow)|cooldown|overloaded/i;

// A reviewer that returned no parseable verdict is "unavailable" (crashed/quota/cooldown — never
// actually reviewed the diff) rather than a genuine "fail" ONLY when its exit code says so, or its
// output carries a known quota signature. A non-zero exit is the authoritative half of this check:
// seen live as a Windows codex sandbox-helper crash ("helper_sandbox_lock_failed") that doesn't
// match any quota wording — before this, anything not matching LIMIT_RE fell through to a content
// "fail" verdict, wasting a churn round asking the coder to fix issues that were never raised.
export function reviewerUnavailable(verdict, code, out) {
  return !verdict && (code !== 0 || LIMIT_RE.test(out || ''));
}

// Agent command templates — override via env if a CLI's flags change. Prompt is delivered on
// stdin for claude/codex and via --prompt-file for grok (its stdin isn't a prompt channel).
// --skip-git-repo-check is required here (unlike CMD.codex below): the probe runs in PROBE_CWD, a
// neutral mkdtemp dir that is deliberately NOT a git repo, and codex refuses to run at all outside
// a trusted/git directory without this flag — verified it exits 1 with "Not inside a trusted
// directory" otherwise, which the probe then misreads as "codex is down".
const codexProbeCommand = () => process.env.AGENT_LOOP_CODEX_PROBE_CMD
  || process.env.AGENT_LOOP_CODEX_CMD
  || `codex exec --sandbox read-only --skip-git-repo-check`;
const CMD = {
  grok:            (pf, maxTurns = 40) => process.env.AGENT_LOOP_GROK_CMD?.replace('{pf}', pf)
                        || `grok --prompt-file "${pf}" --always-approve --no-plan --max-turns ${maxTurns} --output-format plain`,
  claudeImplement: ()  => process.env.AGENT_LOOP_CLAUDE_IMPLEMENT || `claude -p --model sonnet --permission-mode bypassPermissions --max-turns 40`,
  claude:          ()  => process.env.AGENT_LOOP_CLAUDE_CMD || `claude -p --model sonnet`,
  // Opus is reserved for the one hard call in this pipeline: diagnosing a task that has
  // churned MAX_ROUNDS times without converging (split vs. AC-fix). Every other Claude call
  // (coding, reviewing, probing) uses Sonnet.
  claudeRescope:   ()  => process.env.AGENT_LOOP_CLAUDE_RESCOPE_CMD || `claude -p --model opus`,
  // workspace-write (not read-only) so Codex can actually RUN the project's tests during review —
  // read-only makes it withhold approval for lack of test evidence (churn). Scratch writes are
  // discarded by `git reset --hard HEAD` after each review round (see reviewAndResolve).
  codex:           ()  => process.env.AGENT_LOOP_CODEX_CMD || `codex exec --sandbox workspace-write -c model_reasoning_effort="high"`,
};

// ---------- audit log (gitignored) ----------
const LOG_FILE = process.env.AGENT_LOOP_LOG || `${homedir()}/.agent-loop.log`;
const log = msg => { const line = `[${new Date().toISOString()}] ${msg}`; console.log(line); try { appendFileSync(LOG_FILE, line + '\n'); } catch {} };

// ---------- verdict parser (string-aware brace scan) ----------
export function extractVerdict(out) {
  const ok = s => { try { const j = JSON.parse(s); if (j && typeof j === 'object' && 'verdict' in j) return j; } catch {} return null; };
  let v = ok(out.trim()); if (v) return v;
  const anchor = out.lastIndexOf('"verdict"'); if (anchor === -1) return null;
  for (let start = out.lastIndexOf('{', anchor); start !== -1; start = out.lastIndexOf('{', start - 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let k = start; k < out.length; k++) {
      const ch = out[k];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; }
      else if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) { v = ok(out.slice(start, k + 1)); break; }
    }
    if (v) return v;
  }
  return null;
}

// Declared here but INVOKED at the bottom of the file, after every const is initialized. Running it
// inline here meant anything defined further down was still in its temporal dead zone, so a probe
// touching it silently tested a ReferenceError instead of the real code path.
async function selftest() {
  const a = extractVerdict('{"verdict":"pass","blocking_issues":[],"notes":"ok"}');
  const b = extractVerdict('noise\ncodex\n{"verdict":"fail","blocking_issues":["bad {brace} here"],"notes":"see foo{bar}"}\ntokens used 42');
  const c = LIMIT_RE.test("ERROR: You've hit your usage limit. Try again at Jul 29.") && !extractVerdict("no json here");
  // heartbeat: a labelled child that outlives one interval must tick, and an unlabelled one must not.
  process.env.AGENT_LOOP_HEARTBEAT_S = '1';
  const ticks = [], real = console.log;
  console.log = m => { const s = String(m); if (/^\s+…/.test(s)) ticks.push(s); real(m); };   // forward too: the sample lines are the point
  const slowChild = 'node -e "setTimeout(()=>console.log(\'child done\'),2400)"';
  const r = await runProc(slowChild, { label: 'selftest', timeout: 30_000 });
  const labelled = ticks.filter(l => /… selftest \d+m\d\ds\/0m30s/.test(l)).length;
  ticks.length = 0;
  await runProc(slowChild, { timeout: 30_000 });
  const d = r.code === 0 && r.out.includes('child done') && labelled >= 1 && ticks.length === 0;
  console.log = real;

  // timeout ENFORCEMENT, two properties at once:
  //  (a) runProc RETURNS at the cap. spawn's own `timeout` only signals the shell; the agent CLI
  //      beneath it kept the stdio pipes open, so 'close' never fired and the promise outlived the
  //      cap by the grandchild's full lifetime (measured: 300ms cap → returned at 12s).
  //  (b) the GRANDCHILD is actually dead. Proven by side effect, not by process listing: the
  //      grandchild tries to write a file after 1.2s; a working tree-kill means it never does.
  const orphanProof = join(tmpdir(), 'al-selftest-orphan-proof.txt');
  try { unlinkSync(orphanProof); } catch {}
  const tStart = Date.now();
  const slow = await runProc(
    `node -e "setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(orphanProof).replace(/"/g, '\\"')},'alive'),1200)"`,
    { timeout: 400 },
  );
  const tookMs = Date.now() - tStart;
  await new Promise(r => setTimeout(r, 2500));            // outlast the grandchild's write deadline
  const orphanActed = existsSync(orphanProof);
  try { unlinkSync(orphanProof); } catch {}
  const e = slow.code === TIMEOUT_CODE && tookMs < 3000 && /TIMEOUT after/.test(slow.out) && !orphanActed;
  if (!e) console.log(`  timeout probe: code=${slow.code} (want ${TIMEOUT_CODE}) took=${tookMs}ms (want <3000) orphanStillActed=${orphanActed} (want false)`);

  // The stage caps are env-configurable, so assert the PARSE, not a fixed number: with no override
  // set the documented default must come out, and with one set it must land inside the allowed
  // range. Asserting the literal here would fail every user who legitimately raised a cap.
  const capOk = (envName, ms, defaultS) => Number.isFinite(ms)
    && ms >= 60_000 && ms <= 6 * 3600_000
    && (process.env[envName] ? true : ms === defaultS * 1000);
  const implementCap = capOk('AGENT_LOOP_IMPLEMENT_TIMEOUT_S', IMPLEMENT_TIMEOUT_MS, 20 * 60);
  if (!implementCap) console.log(`  implementation cap probe: ${IMPLEMENT_TIMEOUT_MS}ms out of range or not the 1200000ms default`);
  const reviewCap = capOk('AGENT_LOOP_REVIEW_TIMEOUT_S', REVIEW_TIMEOUT_MS, 10 * 60);
  if (!reviewCap) console.log(`  review cap probe: ${REVIEW_TIMEOUT_MS}ms out of range or not the 600000ms default`);
  const verifyCap = capOk('AGENT_LOOP_VERIFY_TIMEOUT_S', VERIFY_TIMEOUT_MS, 25 * 60);
  if (!verifyCap) console.log(`  verification cap probe: ${VERIFY_TIMEOUT_MS}ms out of range or not the 1500000ms default`);

  // config validation: garbage must fall back to the default, never NaN
  process.env.AGENT_LOOP_SELFTEST_NUM = 'abc';
  const f1 = num('AGENT_LOOP_SELFTEST_NUM', 60, 5) === 60;
  process.env.AGENT_LOOP_SELFTEST_NUM = '0';
  const f2 = num('AGENT_LOOP_SELFTEST_NUM', 5, 1) === 5;      // below min → default
  process.env.AGENT_LOOP_SELFTEST_NUM = '90';
  const f3 = num('AGENT_LOOP_SELFTEST_NUM', 60, 5) === 90;    // valid → honoured
  // a finite value past the 32-bit timer limit must be REJECTED, not turned into a 1ms busy loop
  process.env.AGENT_LOOP_SELFTEST_NUM = '2147484';
  const f4 = num('AGENT_LOOP_SELFTEST_NUM', 60, 5) === 60;
  process.env.AGENT_LOOP_SELFTEST_NUM = String(Number.MAX_SAFE_INTEGER);
  const f5 = num('AGENT_LOOP_SELFTEST_NUM', 60, 5) === 60;
  delete process.env.AGENT_LOOP_SELFTEST_NUM;
  const f = f1 && f2 && f3 && f4 && f5;
  if (!f) console.log(`  config probe: garbage=${f1} belowMin=${f2} valid=${f3} pastTimerLimit=${f4} maxSafeInt=${f5}`);

  // lock identity: THIS process is agent-loop, a plain node child is not. Without that distinction
  // a recycled PID would make a dead owner look alive and refuse every future launch.
  const decoy = spawn(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 400));
  const self = isAgentLoopProcess(process.pid), foreign = isAgentLoopProcess(decoy.pid);
  try { decoy.kill(); } catch {}
  // 'unknown' is an acceptable answer on platforms that cannot introspect a PID (the caller then
  // falls back to lock mtime) — what must NEVER happen is misreporting one as the other.
  const g = self !== 'no' && foreign !== 'yes' && (self === 'yes' || foreign === 'unknown');
  if (!g) console.log(`  lock-identity probe: self=${self} (want 'yes') foreignNodeChild=${foreign} (want 'no')`);

  // tryComment must SWALLOW a failing comment: letting one abort a lane is what silently destroyed a
  // completed commit (lane unwound → task reset to `ready` → next `checkout -B` rewound the branch).
  let h = false;
  try {
    const realFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error('simulated ClickUp comment outage'));
    await tryComment('selftest-task', 'this must not throw');
    globalThis.fetch = realFetch;
    h = true;
  } catch { h = false; }

  // Lock records carry a nonce so ownership cannot be confused by PID reuse. A heartbeat must
  // recognize its own record and reject a replacement record written by a delayed stale reclaimer.
  const owner = makeLockOwner(1234, 'selftest-owner');
  const parsedOwner = parseLockRecord(owner.raw);
  const replacement = makeLockOwner(4321, 'replacement');
  const i = parsedOwner?.pid === 1234 && parsedOwner?.nonce === 'selftest-owner'
    && sameLockOwner(parsedOwner, owner) && !sameLockOwner(parseLockRecord(replacement.raw), owner);

  // A cleanup failure must become a fatal stop, not leave a dirty tree for every future pass to
  // reject forever. Inject git results so the offline selftest never touches the real repository.
  let j = false;
  try {
    await restoreOwnedTree('selftest cleanup', async () => ({ code: 1, out: 'simulated index lock' }));
  } catch (err) { j = err instanceof FatalLoopError; }

  const oldProbeOverride = process.env.AGENT_LOOP_CODEX_CMD;
  process.env.AGENT_LOOP_CODEX_CMD = 'custom-codex-review';
  const k = codexProbeCommand() === 'custom-codex-review';
  if (oldProbeOverride === undefined) delete process.env.AGENT_LOOP_CODEX_CMD;
  else process.env.AGENT_LOOP_CODEX_CMD = oldProbeOverride;

  const l = canStartNewWork(() => false) && !canStartNewWork(() => true);

  // Fresh implement must NEVER create-or-reset when the branch already exists (even at base).
  // Missing → create; existing → refuse. No checkout -B path remains.
  const m = freshForkPlan({ branchExists: false, commitsBeyondBase: 0 }).mode === 'create'
    && freshForkPlan({ branchExists: true, commitsBeyondBase: 0 }).mode === 'refuse'
    && freshForkPlan({ branchExists: true, commitsBeyondBase: 0 }).reason === 'branch-exists'
    && freshForkPlan({ branchExists: true, commitsBeyondBase: 1 }).mode === 'refuse'
    && freshForkPlan({ branchExists: true, commitsBeyondBase: 3 }).reason === 'existing-commits'
    && freshForkPlan({ branchExists: false, commitsBeyondBase: 9 }).mode === 'create';
  if (!m) console.log('  freshForkPlan probe: refused silent rewind incorrectly');

  // An implementer is forbidden to commit/reset/rebase/switch, but unattended safety cannot depend
  // on prompt compliance. Same-branch HEAD movement must be normalized back onto the dispatcher-
  // recorded start SHA while preserving the working tree; branch switches/detaches remain fatal.
  const historyPlanOk = sandboxHistoryPlan({
    expectedBranch: 'agent-loop/task-x',
    currentBranch: 'agent-loop/task-x',
    startSha: 'a'.repeat(40),
    currentSha: 'a'.repeat(40),
  }).mode === 'keep'
    && sandboxHistoryPlan({
      expectedBranch: 'agent-loop/task-x',
      currentBranch: 'agent-loop/task-x',
      startSha: 'a'.repeat(40),
      currentSha: 'b'.repeat(40),
    }).mode === 'normalize'
    && sandboxHistoryPlan({
      expectedBranch: 'agent-loop/task-x',
      currentBranch: 'other',
      startSha: 'a'.repeat(40),
      currentSha: 'b'.repeat(40),
    }).mode === 'refuse'
    && sandboxHistoryPlan({
      expectedBranch: 'agent-loop/task-x',
      currentBranch: '',
      startSha: 'a'.repeat(40),
      currentSha: 'b'.repeat(40),
    }).mode === 'refuse';
  if (!historyPlanOk) console.log('  sandbox history normalization policy probe: failed');

  let fakeHistoryHead = 'b'.repeat(40);
  const historyCommands = [];
  const historyNormalized = await normalizeSandboxHistory(async command => {
    historyCommands.push(command);
    if (command === 'symbolic-ref --quiet --short HEAD') {
      return { code: 0, out: 'agent-loop/task-x\n' };
    }
    if (command === 'rev-parse HEAD') return { code: 0, out: `${fakeHistoryHead}\n` };
    if (command === `reset --mixed ${'a'.repeat(40)}`) {
      fakeHistoryHead = 'a'.repeat(40);
      return { code: 0, out: '' };
    }
    return { code: 1, out: `unexpected command: ${command}` };
  }, 'agent-loop/task-x', 'a'.repeat(40));
  const historyNormalizeOk = historyNormalized.normalized === true
    && historyNormalized.from === 'b'.repeat(40)
    && fakeHistoryHead === 'a'.repeat(40)
    && historyCommands.filter(command => command.startsWith('reset --mixed ')).length === 1;
  if (!historyNormalizeOk) console.log('  sandbox history normalization execution probe: failed', { historyNormalized, historyCommands });

  // Exact incident regression: a fix sandbox starts at the imported task commit, the implementer
  // runs `reset --mixed HEAD~1`, edits, and returns. Normalization must preserve the working file,
  // restore the recorded start SHA, and allow the dispatcher commit to remain a descendant.
  const historyRepo = mkdtempSync(join(tmpdir(), 'al-selftest-history-'));
  let historyGitOk = false;
  try {
    await gitAt(historyRepo, 'init -q');
    await gitAt(historyRepo, 'config user.name "Agent Loop Selftest"');
    await gitAt(historyRepo, 'config user.email "agent-loop-selftest@example.invalid"');
    writeFileSync(join(historyRepo, 'work.txt'), 'base\n');
    await gitAt(historyRepo, 'add work.txt');
    await gitAt(historyRepo, 'commit -q -m base');
    const historyBranch = 'agent-loop/task-history';
    await gitAt(historyRepo, `checkout -q -b ${historyBranch}`);
    writeFileSync(join(historyRepo, 'work.txt'), 'task\n');
    await gitAt(historyRepo, 'add work.txt');
    await gitAt(historyRepo, 'commit -q -m task');
    const historyStart = await revParseAt(historyRepo, 'HEAD');
    await gitAt(historyRepo, 'reset --mixed HEAD~1');
    writeFileSync(join(historyRepo, 'work.txt'), 'task-fixed\n');
    const normalized = await normalizeSandboxHistory(args => gitAt(historyRepo, args), historyBranch, historyStart);
    await gitAt(historyRepo, 'add -A');
    await gitAt(historyRepo, 'commit -q -m canonical-fix');
    const historyFinal = await revParseAt(historyRepo, 'HEAD');
    const ancestry = await gitAt(historyRepo, `merge-base --is-ancestor ${historyStart} ${historyFinal}`);
    historyGitOk = normalized.normalized === true
      && ancestry.code === 0
      && readFileSync(join(historyRepo, 'work.txt'), 'utf8') === 'task-fixed\n';
  } catch (error) {
    console.log('  sandbox history exact Git regression probe threw:', error.message);
  } finally {
    try { rmSync(historyRepo, { recursive: true, force: true }); } catch {}
  }
  if (!historyGitOk) console.log('  sandbox history exact Git regression probe: failed');

  // commitOrPreserve must not hard-reset: failed commit → FatalLoopError (preserve).
  let n = false;
  try {
    await commitOrPreserve(async () => ({ code: 1, out: 'hook rejected' }), 'msg', 'selftest preserve');
  } catch (err) { n = err instanceof FatalLoopError && /PRESERVED/.test(err.message); }
  if (!n) console.log('  commitOrPreserve probe: failed');

  // agentChildEnv must strip secrets, redirect AGENT_LOOP_REPO away from the primary, keep PATH.
  const primary = 'D:\\repo\\primary';
  const sandbox = 'D:\\tmp\\sandbox';
  const stripped = agentChildEnv({
    PATH: '/usr/bin',
    CLICKUP_TOKEN: 'pk_secret',
    GITHUB_TOKEN: 'ghp_x',
    OPENAI_API_KEY: 'sk-keep',
    GIT_TERMINAL_PROMPT: '1',
    AGENT_LOOP_REPO: primary,
    INIT_CWD: primary,
  }, { sandboxDir: sandbox, primaryRepo: primary });
  const o = stripped.CLICKUP_TOKEN === undefined
    && stripped.GITHUB_TOKEN === undefined
    && stripped.OPENAI_API_KEY === 'sk-keep'
    && stripped.GIT_TERMINAL_PROMPT === '0'
    && stripped.PATH === '/usr/bin'
    && stripped.AGENT_LOOP_REPO === pathResolve(sandbox)
    && stripped.INIT_CWD === pathResolve(sandbox)
    && stripped.AGENT_LOOP_SANDBOX === '1';
  if (!o) console.log('  agentChildEnv probe: failed', stripped);

  // create-ref must use zero-OID CAS (never unconditional update-ref).
  const p = createBranchRefCmd('agent-loop/task-x', 'abc'.padEnd(40, '0')).includes(ZERO_OID)
    && createBranchRefCmd('b', 'd'.repeat(40)) === `update-ref refs/heads/b ${'d'.repeat(40)} ${ZERO_OID}`
    && fastForwardBranchRefCmd('b', 'a'.repeat(40), 'c'.repeat(40)).endsWith(` ${'c'.repeat(40)}`);
  if (!p) console.log('  create-ref CAS probe: failed');

  // verify must lose AI provider keys (nothing there needs them); agent mode must keep them.
  const withKeys = { PATH: '/usr/bin', OPENAI_API_KEY: 'sk-a', ANTHROPIC_API_KEY: 'sk-b', GITHUB_TOKEN: 'ghp_x' };
  const forVerify = agentChildEnv(withKeys, { stripProviderKeys: true });
  const forAgent = agentChildEnv(withKeys, {});
  const q = forVerify.OPENAI_API_KEY === undefined && forVerify.ANTHROPIC_API_KEY === undefined && forVerify.GITHUB_TOKEN === undefined
    && forAgent.OPENAI_API_KEY === 'sk-a' && forAgent.ANTHROPIC_API_KEY === 'sk-b';
  if (!q) console.log('  stripProviderKeys probe: failed', { forVerify, forAgent });

  // findBranchCheckoutIn must locate a branch checked out in the PRIMARY worktree (always the
  // listing's first block) or any linked worktree, and must not false-positive on a different one.
  const wtFixture = [
    'worktree D:/repo', 'HEAD ' + 'a'.repeat(40), 'branch refs/heads/agent-loop/task-x-123', '',
    'worktree D:/repo/.worktrees/other', 'HEAD ' + 'b'.repeat(40), 'detached',
  ].join('\n');
  const branchCheckoutOk = findBranchCheckoutIn(wtFixture, 'agent-loop/task-x-123') === 'D:/repo'
    && findBranchCheckoutIn(wtFixture, 'agent-loop/task-y-999') === null;
  if (!branchCheckoutOk) console.log('  findBranchCheckoutIn probe: failed');

  // The lock's verify-grace window must outlast a genuine owner's worst-case detect+kill time, or a
  // reclaiming contender can finish verifying itself while the old owner is still mid-kill (audit:
  // "delayed contender" race) — this is arithmetic, not a stopwatch, so assert the relationship holds.
  const s = LOCK_VERIFY_GRACE_MS > (LOCK_HEARTBEAT_MS * LOCK_HEARTBEAT_MISS_LIMIT + KILL_TREE_CAP_MS);
  if (!s) console.log(`  lock-grace probe: ${LOCK_VERIFY_GRACE_MS}ms does not exceed detect+kill worst case`);

  // A lock record must round-trip its unsafe/reason fields so readUnsafeState() can see them, and a
  // record without them must read as safe (no false positives on an ordinary lock).
  const unsafeRoundTrip = parseLockRecord(JSON.stringify({ pid: 555, nonce: 'n', unsafe: true, reason: 'bad' }));
  const safeRoundTrip = parseLockRecord(JSON.stringify({ pid: 555, nonce: 'n' }));
  const t = unsafeRoundTrip?.unsafe === true && unsafeRoundTrip?.reason === 'bad' && safeRoundTrip?.unsafe === false;
  if (!t) console.log('  lock-record unsafe/reason probe: failed', { unsafeRoundTrip, safeRoundTrip });

  // markUnsafeChild must persist to BOTH targets given writable paths (using scratch files — never
  // the real UNSAFE_FILE/LOCK_FILE, which could interfere with an actually-running dispatcher).
  const scratchDir = mkdtempSync(join(tmpdir(), 'al-selftest-unsafe-'));
  const scratchUnsafeFile = join(scratchDir, 'unsafe.json');
  const scratchLockFile = join(scratchDir, 'lock.json');
  writeFileSync(scratchLockFile, LOCK_OWNER.raw);   // markUnsafeChild rewrites this in place, like the real lock
  const markedOk = await markUnsafeChild('selftest reason', { unsafeFile: scratchUnsafeFile, lockFile: scratchLockFile });
  let u = false;
  try {
    const fileBody = JSON.parse(readFileSync(scratchUnsafeFile, 'utf8'));
    const lockBody = JSON.parse(readFileSync(scratchLockFile, 'utf8'));
    u = markedOk && fileBody.reason === 'selftest reason' && lockBody.unsafe === true && lockBody.pid === LOCK_OWNER.pid;
  } catch (e) { console.log('  markUnsafeChild probe: failed', e.message); }
  allowLockRelease = true;   // markUnsafeChild flips this module-level flag; restore it — main() never ran in --selftest
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch {}
  if (!u) console.log('  markUnsafeChild probe: failed');

  // reviewerUnavailable: a crashed reviewer (non-zero exit, garbage output not matching any quota
  // wording — e.g. the live Windows codex "helper_sandbox_lock_failed" crash) must be UNAVAILABLE,
  // not a content "fail"; a quota message on exit 0 must still be caught by wording; and ordinary
  // exit-0 garbage (a genuine formatting-compliance miss, not a crash) must still fall to "fail".
  const w = reviewerUnavailable(null, 1, 'windows sandbox: helper_sandbox_lock_failed: lock sandbox binary') === true
    && reviewerUnavailable(null, 0, "ERROR: You've hit your usage limit. Try again at Jul 29.") === true
    && reviewerUnavailable(null, 0, 'not json, no verdict here') === false
    && reviewerUnavailable({ verdict: 'pass' }, 1, 'anything') === false;
  if (!w) console.log('  reviewerUnavailable probe: failed');

  // Codex PASS must always park the exact reviewed SHA on `approved`; Claude availability only
  // decides whether that approved queue can be landed on the NEXT pass.
  const codexPassParks = reviewPassAction('codex', 'commit') === 'approved'
    && reviewPassAction('codex', 'approved') === 'approved'
    && reviewPassAction('claude', 'commit') === 'commit'
    && reviewPassAction('grok', 'review') === 'review';
  if (!codexPassParks) console.log('  Codex PASS routing probe: failed');

  // Codex down + Claude reviewing: a Grok-coded diff may land on Claude's PASS, but a Claude-coded
  // one must still park — a reviewer must never be able to approve its own work onto main.
  const claudeReviewLanding = claudeReviewPassAction('grok') === 'approved'
    && claudeReviewPassAction('claude') === 'review'
    && reviewPassAction('claude', claudeReviewPassAction('grok')) === 'approved'
    && reviewPassAction('claude', claudeReviewPassAction('claude')) === 'review';
  if (!claudeReviewLanding) console.log('  Claude-review landing probe: failed');

  // The planning column and TRACKER ONLY epics must be refused on every path. Both spellings of
  // "planned" count, and an ordinary ready task must NOT be refused (a guard that blocks everything
  // would pass a naive test while wedging the whole loop).
  const planningRefused = !!pickupRefusalReason({ status: { status: 'planned' } })
    && !!pickupRefusalReason({ status: { status: 'planed' } })
    && !!pickupRefusalReason({ status: { status: 'PLANNED' } })
    && !!pickupRefusalReason({ status: { status: 'ready' }, custom_fields: [{ name: AC_FIELD, value: 'TRACKER ONLY — do not implement this parent.' }] })
    && !pickupRefusalReason({ status: { status: 'ready' }, custom_fields: [{ name: AC_FIELD, value: '1. Do the thing.' }] })
    && !pickupRefusalReason({ status: { status: S.changes }, custom_fields: [] })
    // A held parent must hold its children, whatever their own status says.
    && !!parentRefusalReason({ id: 'epic', status: { status: 'planned' } })
    && !!parentRefusalReason({ id: 'epic', status: { status: 'PLANNED' } })
    && !!parentRefusalReason({ id: 'epic', status: { status: 'planed' } })
    && !parentRefusalReason({ id: 'epic', status: { status: 'ready' } })
    && !parentRefusalReason({ id: 'epic', status: { status: S.committed } })
    && !parentRefusalReason(null)
    // Structural tracker refusal. The fixture is the real failure: the Admin/Guide epic had 21
    // subtasks and an EMPTY Acceptance Criteria, so the declared marker could not save it — and
    // FIELD_033 means the marker cannot even be added to it now.
    && !!containerRefusalReason({ id: 'epic', subtasks: new Array(21).fill({}) })
    && !!containerRefusalReason({ id: 'epic', subtasks: [{}] })
    && !containerRefusalReason({ id: 'leaf', subtasks: [] })
    && !containerRefusalReason({ id: 'leaf' })
    && !containerRefusalReason(null);

  // Tracker roll-up. The two fixtures are the real board shapes at the time this was written: the
  // Premium-Restaurants epic (7/7 committed, parent still on `ready`) and the Admin/Guide epic
  // (21 children, 7 planned + 14 ready, parent `planned`) which must NOT move.
  const kid = (status, type) => ({ status: { status, type } });
  const committedKid = kid(S.committed, 'done');
  const deployedKid = kid('deployed', 'closed');
  const approvedKid = kid(S.approved, 'custom');
  const readyKid = kid(S.ready, 'unstarted');
  const readyParent = kid(S.ready, 'unstarted');
  const rollup =
    trackerRollupStatus(readyParent, Array(7).fill(committedKid)) === S.committed
    // A chain finished and already marked deployed still counts as done.
    && trackerRollupStatus(readyParent, [committedKid, deployedKid]) === S.committed
    // Codex approved everything, Claude has not landed it → approved, not committed.
    && trackerRollupStatus(readyParent, [approvedKid, approvedKid]) === S.approved
    && trackerRollupStatus(readyParent, [committedKid, approvedKid]) === S.approved
    // One child still unfinished → the parent says nothing.
    && trackerRollupStatus(readyParent, [committedKid, readyKid]) === null
    && trackerRollupStatus(kid(S.planned ?? 'planned', 'open'), Array(7).fill(readyKid)) === null
    // Never write a status the parent already holds, and never walk a done parent backwards.
    && trackerRollupStatus(kid(S.committed, 'done'), Array(7).fill(committedKid)) === null
    && trackerRollupStatus(kid(S.committed, 'done'), [committedKid, approvedKid]) === null
    && trackerRollupStatus(kid(S.approved, 'custom'), [approvedKid]) === null
    // A childless task is not a tracker.
    && trackerRollupStatus(readyParent, []) === null
    && trackerRollupStatus(readyParent, null) === null;
  if (!rollup) console.log('  tracker roll-up probe: failed', {
    allCommitted: trackerRollupStatus(readyParent, Array(7).fill(committedKid)),
    allApproved: trackerRollupStatus(readyParent, [approvedKid, approvedKid]),
    mixed: trackerRollupStatus(readyParent, [committedKid, readyKid]),
  });
  if (!planningRefused) console.log('  planning-column/tracker pickup-refusal probe: failed');

  // `approved` is intentionally dependency-satisfying: a child can be prepared from the exact
  // reviewed parent branch while Claude is unavailable, without pretending arbitrary custom
  // statuses are complete.
  const approvedUnblocks = dependencySatisfied({ status: { status: S.approved, type: 'custom' } })
    && dependencySatisfied({ status: { status: S.committed, type: 'done' } })
    && !dependencySatisfied({ status: { status: S.review, type: 'custom' } });
  if (!approvedUnblocks) console.log('  approved dependency probe: failed');

  // Fresh child branches are created inside an isolated clone. Non-default branches from the
  // primary appear there as remote-tracking refs, so the start point must fall back to origin/name
  // when no local branch has been materialized yet.
  const sandboxChainBase = sandboxStartRef('agent-loop/task-parent', false, true) === 'refs/remotes/origin/agent-loop/task-parent'
    && sandboxStartRef('agent-loop/task-parent', true, true) === 'agent-loop/task-parent'
    && sandboxStartRef('agent-loop/task-parent', false, false) === 'agent-loop/task-parent';
  if (!sandboxChainBase) console.log('  sandbox chain-base probe: failed');

  // ClickUp returns status-filtered tasks newest-first. Approved landing must nevertheless be a
  // dependency order, not API order; cycles must fail closed instead of landing an arbitrary tip.
  const parent = { id: 'parent', date_created: '100', dependencies: [] };
  const child = { id: 'child', date_created: '200', dependencies: [{ task_id: 'child', depends_on: 'parent' }] };
  const grandchild = { id: 'grandchild', date_created: '300', dependencies: [{ task_id: 'grandchild', depends_on: 'child' }] };
  const independent = { id: 'independent', date_created: '50', dependencies: [] };
  const approvedOrder = orderApprovedTasks([grandchild, child, parent, independent]).map(task => task.id);
  let cycleRejected = false;
  try {
    orderApprovedTasks([
      { id: 'cycle-a', dependencies: [{ task_id: 'cycle-a', depends_on: 'cycle-b' }] },
      { id: 'cycle-b', dependencies: [{ task_id: 'cycle-b', depends_on: 'cycle-a' }] },
    ]);
  } catch (err) { cycleRejected = /cycle-a|cycle-b/.test(err.message); }
  const approvedOrdering = approvedOrder.join(',') === 'independent,parent,child,grandchild' && cycleRejected;
  if (!approvedOrdering) console.log('  approved ordering probe: failed', { approvedOrder, cycleRejected });

  // When an approved ancestor fails verification/landing, its descendants must stay parked for
  // this round; unrelated approved roots may continue.
  const failedApproved = new Set(['parent']);
  const approvedFailureGate = approvedBlockedThisRound(child, failedApproved)
    && !approvedBlockedThisRound(independent, failedApproved);
  if (!approvedFailureGate) console.log('  approved failure gate probe: failed');

  // Any stalled task is a hard round stop with a useful report. An empty stalled queue is not.
  const stalledReason = stalledStopReason([{ id: 'stalled-1', name: 'Needs Claude\nre-scope' }]);
  const stalledStops = stalledReason?.includes('stalled-1') && stalledReason.includes('Needs Claude re-scope')
    && !stalledReason.includes('\n')
    && stalledStopReason([]) === null;
  if (!stalledStops) console.log('  stalled stop probe: failed', stalledReason);

  // A successful coder process that produces no diff is not an ordinary dependency block: it needs
  // human/Claude diagnosis, and the coder's bounded explanation must survive in ClickUp.
  const longNoChangeOutput = `discard-me-${'x'.repeat(1300)}\nI refused because the required file is outside scope.`;
  const zeroChange = noChangeOutcome('grok', longNoChangeOutput);
  const emptyZeroChange = noChangeOutcome('grok', '');
  const secretZeroChange = noChangeOutcome('grok', 'OPENAI_API_KEY=sk-live-super-secret-value');
  const zeroChangeStalls = zeroChange.status === S.stalled
    && zeroChange.comment.includes('I refused because the required file is outside scope.')
    && !zeroChange.comment.includes('discard-me-')
    && zeroChange.comment.length < 1500
    && emptyZeroChange.status === S.stalled
    && emptyZeroChange.comment.includes('(coder returned no diagnostic output)')
    && secretZeroChange.comment.includes('OPENAI_API_KEY=[REDACTED]')
    && !secretZeroChange.comment.includes('sk-live-super-secret-value');
  if (!zeroChangeStalls) console.log('  zero-change stalled-routing probe: failed', { zeroChange, emptyZeroChange, secretZeroChange });

  // A no-op round is a failure only when the branch is empty too. With commits already on the
  // branch (an earlier round finished the work, e.g. it timed out during wrap-up) it must reach a
  // reviewer instead of parking on stalled and halting the whole queue.
  const zeroChangeRouting = zeroChangeRoute(2) === S.review
    && zeroChangeRoute(1) === S.review
    && zeroChangeRoute(0) === S.stalled;
  if (!zeroChangeRouting) console.log('  zero-change review-routing probe: failed', { two: zeroChangeRoute(2), zero: zeroChangeRoute(0) });

  // A lane killed by our own cap that still committed work must reach a reviewer, not be presumed
  // failed. A crash (any other non-zero exit) and a timeout that committed nothing both stay failures.
  const timeoutRouting = timeoutRoute(true, true) === S.review
    && timeoutRoute(true, false) === S.changes
    && timeoutRoute(false, true) === S.changes;
  if (!timeoutRouting) console.log('  timeout review-routing probe: failed', {
    committed: timeoutRoute(true, true), empty: timeoutRoute(true, false), crashed: timeoutRoute(false, true),
  });

  // The re-scope prompt must not hand Claude "it is too big" as a premise for a task that never
  // exhausted its rounds — that false premise is what turns a no-op stall into a split diagnosis.
  const fakeStalled = { name: 'probe task' };
  const partialRounds = Math.max(1, MAX_ROUNDS - 1);
  const rescopePartial = reScopePrompt(fakeStalled, 'ac', 'issues', partialRounds);
  const rescopeFull = reScopePrompt(fakeStalled, 'ac', 'issues', MAX_ROUNDS);
  const rescopePremise = rescopeFull.includes('too big or mis-scoped')
    && rescopeFull.includes(`after ${MAX_ROUNDS} of ${MAX_ROUNDS} allowed`)
    && (MAX_ROUNDS === 1 || (
      !rescopePartial.includes('too big or mis-scoped')
      && rescopePartial.includes('WITHOUT exhausting its round budget')
      && rescopePartial.includes(`after ${partialRounds} of ${MAX_ROUNDS} allowed`)
    ));
  if (!rescopePremise) console.log('  re-scope premise probe: failed', { partialRounds, partial: rescopePartial.slice(0, 400) });

  // The re-scope sandbox physically cannot see sibling task branches (hardenSandboxGit strips the
  // remote and its refs), so "I could not find the prerequisite" is an observation Claude is not
  // entitled to draw a conclusion from. Both premises must carry the warning, or a chained task whose
  // predecessor is merely unmerged gets diagnosed as needing a split it does not need.
  const rescopeBlindSpot = [rescopeFull, rescopePartial].every(p =>
    p.includes('SANDBOX BLIND SPOT')
    && p.includes('Never conclude that a prerequisite does not exist')
    && p.includes(BASE));
  if (!rescopeBlindSpot) console.log('  re-scope sandbox blind-spot probe: failed');

  // A successor may only fork off a predecessor branch when exactly ONE predecessor still carries
  // unmerged work. Zero → BASE (their commits are already there). Two or more → refuse: no single
  // base holds both, and silently taking BASE hands the coder a tree with neither prerequisite.
  const chainOne = chainBaseFrom(['agent-loop/task-parent']);
  const chainNone = chainBaseFrom([null, null]);
  const chainDup = chainBaseFrom(['agent-loop/task-parent', 'agent-loop/task-parent']);
  const chainMany = chainBaseFrom(['agent-loop/task-a', null, 'agent-loop/task-b']);
  const chainBaseSelection = chainOne.base === 'agent-loop/task-parent' && !chainOne.ambiguous
    && chainNone.base === null && !chainNone.ambiguous
    && chainBaseFrom([]).base === null
    // The same predecessor named twice is one base, not a conflict.
    && chainDup.base === 'agent-loop/task-parent' && !chainDup.ambiguous
    && chainMany.base === null && chainMany.ambiguous?.join(',') === 'agent-loop/task-a,agent-loop/task-b';
  if (!chainBaseSelection) console.log('  chain-base selection probe: failed', { chainOne, chainNone, chainDup, chainMany });

  // A task parked on `in review` may be handed to Claude only when the branch proves Claude wrote
  // none of it. The grok fixture is the verbatim R3/7 commit subject that exposed this: a PARTIAL
  // commit from a wrap-up timeout is still an attributable commit.
  const grokPartialMsg = '[R3/7] Enforce sponsor-only restaurant categories and narration exclusion [PARTIAL — grok exited 124 (timeout)]\n\nClickUp 86eyh4bcm. Not a finished attempt.';
  const grokFullMsg = 'Some task\n\nImplemented by grok via the agent-loop dispatcher (ClickUp 123).';
  const claudeFullMsg = 'Some task\n\nImplemented by claude via the agent-loop dispatcher (ClickUp 123).';
  const parkedReviewRouting =
    parkedReviewReviewer(codersFromCommits([grokPartialMsg])) === 'claude'
    && parkedReviewReviewer(codersFromCommits([grokFullMsg, grokPartialMsg])) === 'claude'
    && parkedReviewReviewer(codersFromCommits([claudeFullMsg])) === null
    && parkedReviewReviewer(codersFromCommits([grokFullMsg, claudeFullMsg])) === null
    && parkedReviewReviewer(codersFromCommits([grokFullMsg, 'hand fix: bump a constant'])) === null
    && parkedReviewReviewer(codersFromCommits(['Implemented by mystery-agent via the agent-loop dispatcher (ClickUp 1).'])) === null
    && parkedReviewReviewer(codersFromCommits([])) === null
    && parkedReviewReviewer(codersFromCommits(null)) === null;
  if (!parkedReviewRouting) console.log('  parked-review reviewer probe: failed', {
    grokPartial: parkedReviewReviewer(codersFromCommits([grokPartialMsg])),
    claudeOnly: parkedReviewReviewer(codersFromCommits([claudeFullMsg])),
    mixed: parkedReviewReviewer(codersFromCommits([grokFullMsg, claudeFullMsg])),
  });

  // ClickUp workspaces can exhaust custom-field usages and then reject edits to the existing
  // Acceptance Criteria field (FIELD_033). A deliberately marked standard task description is the
  // narrow fallback; ordinary descriptions must not silently expand an agent's implementation scope.
  const baseAcField = { name: AC_FIELD, value: 'Base acceptance criteria.' };
  const markedAc = acOf({
    custom_fields: [baseAcField],
    description: 'Agent Loop implementation contract\nKeep the existing public method signature.',
  });
  const replacementAc = acOf({
    custom_fields: [baseAcField],
    description: 'Agent Loop implementation contract\nAcceptance criteria mode: replace\nUse only the narrow corrected scope.',
  });
  const unmarkedAc = acOf({
    custom_fields: [baseAcField],
    description: 'Background notes only.',
  });
  const descriptionSupplement = markedAc.includes('Base acceptance criteria.')
    && markedAc.includes('Keep the existing public method signature.')
    && replacementAc.includes('Use only the narrow corrected scope.')
    && !replacementAc.includes('Base acceptance criteria.')
    && unmarkedAc === 'Base acceptance criteria.';
  if (!descriptionSupplement) console.log('  marked task-description AC supplement/replace probe: failed', { markedAc, replacementAc, unmarkedAc });

  // Contracts describe target state, not mandatory diff churn. Both implementer and reviewer must
  // explicitly reject cosmetic edits when a cleanup target was already absent at the branch base.
  const staleCleanupTask = { name: 'Remove obsolete entry' };
  const staleCleanupAc = 'Remove obsolete Foo entry from allowlist.json.';
  const implementTargetState = implementPrompt(staleCleanupTask, staleCleanupAc, '- Foo entry was not removed.')
    .includes('target state, not a mandatory list of changed files');
  const reviewTargetState = reviewPrompt('Codex', staleCleanupTask, staleCleanupAc, 'diff --git a/x b/x', 'base')
    .includes('already absent at the review base');
  const targetStatePrompts = implementTargetState && reviewTargetState;
  if (!targetStatePrompts) console.log('  target-state/no-cosmetic-diff prompt probe: failed', { implementTargetState, reviewTargetState });

  // A stalled task only auto-repairs when Claude's re-scope output is shaped EXACTLY like the
  // contract this dispatcher itself writes (see descriptionSupplement above) — anything else (a
  // genuine split recommendation, prose that merely mentions the marker, an oversized dump) must
  // fall back to the human-required stalled path, never a malformed auto-apply.
  const validFix = extractDescriptionFix('Diagnosis: fixable contradiction.\n```clickup-description\nAgent Loop implementation contract\nAcceptance criteria mode: replace\nCorrected scope only.\n```\n');
  const splitNoFix = extractDescriptionFix('Diagnosis: two independent concerns. Split into Foo and Bar subtasks; Bar depends on Foo.');
  const noMarkerNoFix = extractDescriptionFix('```clickup-description\nJust a corrected description with no marker line.\n```');
  const noReplaceNoFix = extractDescriptionFix('```clickup-description\nAgent Loop implementation contract\nMissing the replace marker.\n```');
  const oversizeNoFix = extractDescriptionFix(`\`\`\`clickup-description\nAgent Loop implementation contract\nAcceptance criteria mode: replace\n${'x'.repeat(20_001)}\n\`\`\``);
  const descriptionFixExtraction = validFix === 'Agent Loop implementation contract\nAcceptance criteria mode: replace\nCorrected scope only.'
    && splitNoFix === null && noMarkerNoFix === null && noReplaceNoFix === null && oversizeNoFix === null
    && extractDescriptionFix('') === null && extractDescriptionFix(undefined) === null;
  if (!descriptionFixExtraction) console.log('  Claude re-scope description-fix extraction probe: failed', { validFix, splitNoFix, noMarkerNoFix, noReplaceNoFix });

  // Claude must diagnose the exact task branch it is about to re-scope. Falling back to primary
  // HEAD can make branch-only files look nonexistent and authorize a false contract rewrite.
  const rescopeTaskTip = rescopeInspectionPlan('agent-loop/task-x', 'b'.repeat(40));
  const rescopeMissingBranch = rescopeInspectionPlan(null, null);
  const rescopeMissingTip = rescopeInspectionPlan('agent-loop/task-x', null);
  const rescopeLookups = [];
  const rescopeResolved = await resolveRescopeInspection(
    { id: 'task-x' },
    {
      findBranch: async () => 'agent-loop/task-x',
      readTip: async branch => {
        rescopeLookups.push(branch);
        return 'c'.repeat(40);
      },
    },
  );
  const rescopeInspection = rescopeTaskTip.mode === 'inspect'
    && rescopeTaskTip.branch === 'agent-loop/task-x'
    && rescopeTaskTip.sha === 'b'.repeat(40)
    && rescopeMissingBranch.mode === 'refuse'
    && rescopeMissingTip.mode === 'refuse'
    && rescopeResolved.mode === 'inspect'
    && rescopeResolved.sha === 'c'.repeat(40)
    && rescopeLookups.join(',') === 'agent-loop/task-x';
  if (!rescopeInspection) console.log('  Claude re-scope task-tip selection probe: failed', { rescopeTaskTip, rescopeMissingBranch, rescopeMissingTip, rescopeResolved, rescopeLookups });

  // A single Codex false-negative must not send a correct, unchanged SHA back through coding
  // forever. When Claude is already known available, it adjudicates the concrete blockers against
  // the actual reviewed tree. An adjudicated pass still goes through the normal exact-SHA verifier.
  const primaryFalseNegative = {
    verdict: 'fail',
    blocking_issues: ['resources/lang/ru/mobile_auth.php contains U+FFFD'],
    notes: 'otherwise aligned',
  };
  const adjudicatedPass = resolveAdjudicatedVerdict(primaryFalseNegative, {
    verdict: 'pass',
    blocking_issues: [],
    notes: 'Current bytes contain valid Если and no U+FFFD.',
  });
  const adjudicatedFail = resolveAdjudicatedVerdict(primaryFalseNegative, {
    verdict: 'fail',
    blocking_issues: ['resources/lang/ru/mobile_auth.php:42 still contains U+FFFD'],
    notes: 'reproduced from current bytes',
  });
  const noAdjudication = resolveAdjudicatedVerdict(primaryFalseNegative, null);
  const malformedAdjudicationPass = resolveAdjudicatedVerdict(primaryFalseNegative, {
    verdict: 'pass',
    blocking_issues: ['contradictory blocker'],
    notes: '',
  });
  const primaryPass = { verdict: 'pass', blocking_issues: [], notes: 'green' };
  const passStaysPass = resolveAdjudicatedVerdict(primaryPass, {
    verdict: 'fail',
    blocking_issues: ['must be ignored'],
    notes: '',
  });
  const adjudicationRouting = shouldAdjudicateReview('codex', primaryFalseNegative, true, true)
    && !shouldAdjudicateReview('codex', primaryFalseNegative, false, true)
    && !shouldAdjudicateReview('codex', primaryFalseNegative, true, false)
    && !shouldAdjudicateReview('claude', primaryFalseNegative, true, true)
    && !shouldAdjudicateReview('codex', primaryPass, true, true);
  const adjudicationPromptProbe = reviewAdjudicationPrompt(
    { id: 'task-x', name: 'Mail locale catalogs' },
    'The file must contain valid Russian.',
    'diff --git a/x b/x',
    'base-branch',
    'a'.repeat(40),
    primaryFalseNegative,
  );
  const reviewAdjudication = adjudicatedPass.verdict.verdict === 'pass'
    && adjudicatedPass.adjudicated === true
    && adjudicatedFail.verdict.blocking_issues[0].includes(':42')
    && adjudicatedFail.adjudicated === true
    && noAdjudication.verdict === primaryFalseNegative
    && noAdjudication.adjudicated === false
    && malformedAdjudicationPass.verdict === primaryFalseNegative
    && malformedAdjudicationPass.adjudicated === false
    && passStaysPass.verdict === primaryPass
    && passStaysPass.adjudicated === false
    && adjudicationRouting
    && adjudicationPromptProbe.includes('a'.repeat(40))
    && adjudicationPromptProbe.includes('acceptance-criteria text is not repository content')
    && adjudicationPromptProbe.includes('path:line')
    && adjudicationPromptProbe.includes(primaryFalseNegative.blocking_issues[0]);
  if (!reviewAdjudication) console.log('  Codex-failure Claude adjudication probe: failed', { adjudicatedPass, adjudicatedFail, noAdjudication, passStaysPass });

  // Retry classification: only a transport fault, 429 or 5xx may be retried. A 4xx is deterministic
  // and retrying it just triples log noise — and a 401 retried 3x looks like flakiness, not a bad token.
  const st = s => Object.assign(new Error('x'), { status: s });
  const cuRetryClass = cuRetryable(new Error('fetch failed'))       // transport, no .status
    && cuRetryable(st(429)) && cuRetryable(st(500)) && cuRetryable(st(503))
    && !cuRetryable(st(400)) && !cuRetryable(st(401)) && !cuRetryable(st(404));
  if (!cuRetryClass) console.log('  ClickUp retry-classification probe: failed');

  // Quota-reset parsing. The absolute form is the live codex wording seen on 2026-08-07.
  const NOW = Date.parse('2026-08-07T08:00:00Z');
  // The live wording resets 28h out — past the 24h cap, so the clamp is the CORRECT answer here, not
  // the literal timestamp. Costs one early re-probe that simply re-blacklists; do not "fix" the cap.
  const qAbs = parseQuotaReset("ERROR: You've hit your usage limit. Upgrade to Pro or try again at Aug 8th, 2026 12:34 PM.", NOW);
  const qNear = parseQuotaReset('try again at Aug 7th, 2026 6:00 PM', NOW);  // inside the cap → exact
  const qRel = parseQuotaReset('rate limit reached, try again in 25 minutes', NOW);
  const quotaReset = qAbs === NOW + QUOTA_BLACKOUT_CAP_MS                    // beyond cap → clamped
    && qNear === Date.parse('Aug 7, 2026 6:00 PM')                           // ordinal suffix stripped
    && qRel === NOW + 25 * 60_000                                            // relative form honored
    && parseQuotaReset('some unrelated review prose', NOW) === null          // no false positive
    && parseQuotaReset('try again at not-a-date', NOW) === null              // unparseable → null, not NaN
    && parseQuotaReset('try again at Aug 1st, 2026 12:00 PM', NOW) === null  // already past → null
    && parseQuotaReset('try again in 999 days', NOW) === NOW + QUOTA_BLACKOUT_CAP_MS; // capped
  if (!quotaReset) console.log('  quota-reset parse probe: failed', { qAbs, qNear, qRel });

  // A Codex-down landing is reviewed by Claude, so the commit record must name the reviewer that
  // actually ran — claiming "Codex approved" turns the board into a false audit trail, and the
  // loop's whole invariant is that only reviewed work lands. Entries written as a bare SHA by an
  // older run must still decode, with an unknown (never a defaulted) reviewer.
  // Mutates the in-memory map only — a selftest must never write the live approved-SHA file.
  APPROVED_SHAS.set('selftest-attrib-new', { sha: 'abc1234', reviewer: 'claude' });
  APPROVED_SHAS.set('selftest-attrib-old', 'def5678');
  const attribution = getApprovedSha('selftest-attrib-new') === 'abc1234'
    && getApprovedReviewer('selftest-attrib-new') === 'claude'
    && getApprovedSha('selftest-attrib-old') === 'def5678'
    && getApprovedReviewer('selftest-attrib-old') === null
    && approvalPhrase('claude') === 'Claude approved'
    && approvalPhrase('codex') === 'Codex approved'
    && approvalPhrase('grok') === 'Grok (self) approved'
    && approvalPhrase(null) === 'Approved (reviewer not recorded)'
    && !approvalPhrase('claude').includes('Codex');
  APPROVED_SHAS.delete('selftest-attrib-new');
  APPROVED_SHAS.delete('selftest-attrib-old');
  if (!attribution) console.log('  reviewer attribution probe: failed', {
    sha: getApprovedSha('selftest-attrib-new'), claude: approvalPhrase('claude'), unknown: approvalPhrase(null),
  });

  const good = a?.verdict === 'pass' && b?.verdict === 'fail' && b.blocking_issues.length === 1
    && cuRetryClass && quotaReset && attribution
    && c && d && e && implementCap && reviewCap && verifyCap && timeoutRouting && f && g && h && i && j && k && l && m && historyPlanOk && historyNormalizeOk && historyGitOk && n && o && p && q && branchCheckoutOk && s && t && u && w
    && codexPassParks && claudeReviewLanding && planningRefused && approvedUnblocks && sandboxChainBase && approvedOrdering && approvedFailureGate && stalledStops && zeroChangeStalls && zeroChangeRouting && rescopePremise && rescopeBlindSpot && chainBaseSelection && parkedReviewRouting && rollup
    && descriptionSupplement && targetStatePrompts && descriptionFixExtraction && rescopeInspection && reviewAdjudication;
  console.log('selftest:', good ? 'OK' : `FAIL (verdicts=${!!(a && b && c)} heartbeat=${d} timeout=${e} implementCap=${implementCap} reviewCap=${reviewCap} verifyCap=${verifyCap} timeoutRouting=${timeoutRouting} config=${f} lockIdentity=${g} commentNonFatal=${h} lockOwnership=${i} cleanupFatal=${j} codexOverride=${k} stopGate=${l} freshFork=${m} historyPlan=${historyPlanOk} historyNormalize=${historyNormalizeOk} historyGit=${historyGitOk} preserve=${n} agentEnv=${o} createCas=${p} stripProviderKeys=${q} branchCheckout=${branchCheckoutOk} lockGrace=${s} lockUnsafeFields=${t} markUnsafeChild=${u} reviewerUnavailable=${w} codexPassParks=${codexPassParks} claudeReviewLanding=${claudeReviewLanding} planningRefused=${planningRefused} approvedUnblocks=${approvedUnblocks} sandboxChainBase=${sandboxChainBase} approvedOrdering=${approvedOrdering} approvedFailureGate=${approvedFailureGate} stalledStops=${stalledStops} zeroChangeStalls=${zeroChangeStalls} zeroChangeRouting=${zeroChangeRouting} rescopePremise=${rescopePremise} rescopeBlindSpot=${rescopeBlindSpot} chainBaseSelection=${chainBaseSelection} parkedReviewRouting=${parkedReviewRouting} rollup=${rollup} descriptionSupplement=${descriptionSupplement} targetStatePrompts=${targetStatePrompts} descriptionFixExtraction=${descriptionFixExtraction} rescopeInspection=${rescopeInspection} reviewAdjudication=${reviewAdjudication} cuRetryClass=${cuRetryClass} quotaReset=${quotaReset} attribution=${attribution})`);
  process.exit(good ? 0 : 1);
}

if (!TOKEN && !opts.selftest) { console.error('No CLICKUP_TOKEN. Put it in ~/.agent-loop.env  →  CLICKUP_TOKEN=pk_...'); process.exit(1); }   // --selftest is offline
if (!LIST_ID && !opts.selftest) { console.error('No AGENT_LOOP_LIST_ID. Put it in ~/.agent-loop.env  →  AGENT_LOOP_LIST_ID=<clickup list id>'); process.exit(1); }   // --selftest is offline

// ---------- single-instance lock ----------
const LOCK_FILE = process.env.AGENT_LOOP_LOCK || `${homedir()}/.agent-loop.lock`;
// Written when a child may still be editing; blocks reclaim/start until a human clears it.
const UNSAFE_FILE = process.env.AGENT_LOOP_UNSAFE || `${homedir()}/.agent-loop.unsafe`;
let allowLockRelease = true;   // false when a child may still be editing — do not free the lock
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// A write failure here used to be swallowed (logged, then an UNCONDITIONAL "marker written"
// message right after) — if BOTH lock ownership and the process-tree kill had already failed, a
// failed marker write meant the fence silently never existed, and a fresh start would see nothing
// and proceed. Now: retry each write briefly, and durably record the unsafe state in TWO independent
// places — the dedicated marker file, and a flag embedded in the lock record itself (a path already
// proven writable, since this process created/holds it). Only if BOTH fail does the fence not
// persist, and that failure is now reported loudly instead of masked by the next log line.
async function writeWithRetry(fn, attempts = 3, delayMs = 150) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { fn(); return true; }
    catch (e) { lastErr = e; if (i < attempts - 1) await sleep(delayMs); }
  }
  log(`  ⚠ write failed after ${attempts} attempt(s): ${lastErr?.message}`);
  return false;
}
async function markUnsafeChild(reason, { unsafeFile = UNSAFE_FILE, lockFile = LOCK_FILE } = {}) {
  allowLockRelease = false;
  const reasonText = String(reason || '').slice(0, 2000);
  const body = { at: new Date().toISOString(), reason: reasonText, pid: process.pid, children: [...ACTIVE_CHILDREN] };
  const fileOk = await writeWithRetry(() => writeFileSync(unsafeFile, JSON.stringify(body, null, 2)));
  const lockOk = await writeWithRetry(() => writeFileSync(lockFile, JSON.stringify({
    pid: LOCK_OWNER.pid, nonce: LOCK_OWNER.nonce, startedAt: LOCK_OWNER.startedAt,
    unsafe: true, reason: reasonText.slice(0, 500),
  })));
  if (fileOk || lockOk) {
    log(`🛑 unsafe-child marker recorded (marker file=${fileOk ? 'ok' : 'FAILED'}, lock record=${lockOk ? 'ok' : 'FAILED'}) — will not release lock; next start refuses until cleared`);
  } else {
    log(`🛑🛑 UNSAFE-CHILD MARKER COULD NOT BE WRITTEN ANYWHERE — the fence did NOT persist to disk. A concurrent start is NOT prevented by this run. Investigate disk/permissions at ${unsafeFile} and ${lockFile} immediately.`);
  }
  return fileOk || lockOk;
}
function clearUnsafeChildMarker() {
  try { unlinkSync(UNSAFE_FILE); } catch {}
}
// Checks BOTH durability targets so a single failed write during markUnsafeChild cannot silently
// drop the fence: the dedicated marker file, and the unsafe flag embedded in the current lock record.
function readUnsafeState() {
  if (existsSync(UNSAFE_FILE)) {
    let detail = '';
    try { detail = readFileSync(UNSAFE_FILE, 'utf8').slice(0, 500); } catch {}
    return { unsafe: true, detail: detail || '(unsafe marker file present but unreadable)' };
  }
  const record = readLockRecord();
  if (record?.unsafe) return { unsafe: true, detail: `lock record flagged unsafe: ${record.reason || '(no reason recorded)'}` };
  return { unsafe: false };
}
function refuseIfUnsafeMarker() {
  const state = readUnsafeState();
  if (!state.unsafe) return;
  console.error(`✖ refusing to start: an unsafe-child condition was recorded by a previous run.`);
  console.error(`  A previous run could not confirm agent subprocesses were dead. Inspect processes, then clear it.`);
  console.error(`  ${state.detail}`);
  console.error(`  To clear: delete ${UNSAFE_FILE} if present, and remove ${LOCK_FILE} if its record carries "unsafe":true.`);
  process.exit(1);
}
function makeLockOwner(pid = process.pid, nonce = randomUUID()) {
  const record = { pid, nonce, startedAt: new Date().toISOString() };
  return { ...record, raw: JSON.stringify(record) };
}
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
    return {
      pid: parsed.pid,
      nonce: typeof parsed.nonce === 'string' ? parsed.nonce : null,
      unsafe: parsed.unsafe === true,
      reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 500) : undefined,
    };
  } catch { return null; }
}
const LOCK_OWNER = makeLockOwner();
const readLockRecord = () => {
  try { return parseLockRecord(readFileSync(LOCK_FILE, 'utf8')); }
  catch { return null; }
};
const sameLockOwner = (record, owner = LOCK_OWNER) =>
  !!record && record.pid === owner.pid && !!record.nonce && record.nonce === owner.nonce;
// A recycled PID can make a long-dead owner look alive, which would refuse every future launch.
// Returns 'yes' | 'no' | 'unknown' — the caller must NOT collapse 'unknown' into 'yes', or an
// unidentifiable recycled PID wedges the lock forever (it falls back to lock mtime instead).
function isAgentLoopProcess(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] });
      if (out.trim() === '') return 'unknown';
      return /agent-loop/i.test(out) ? 'yes' : 'no';
    }
    return /agent-loop/i.test(readFileSync(`/proc/${pid}/cmdline`, 'utf8')) ? 'yes' : 'no';
  } catch { return 'unknown'; }   // e.g. macOS has no /proc, or the query failed
}
// exists→read→write was a TOCTOU race: two simultaneous launches could both see "no lock" and
// both proceed, which is exactly the double-instance git corruption the lock exists to prevent.
// 'wx' makes initial creation atomic — the loser gets EEXIST.
const lockAgeS = () => { try { return (Date.now() - statSync(LOCK_FILE).mtimeMs) / 1000; } catch { return Infinity; } };
// A delayed stale contender can wake after a new owner has verified itself, unlink that new lock, and
// take its place. The nonce heartbeat makes ownership revocable: the displaced process notices the
// replacement and kills any active child before the contender's startup grace expires.
const LOCK_HEARTBEAT_MS = 500;
const LOCK_HEARTBEAT_MISS_LIMIT = 2;   // touchLock() self-aborts after this many consecutive misses
const KILL_TREE_CAP_MS = 5000;         // must match killTree()'s own taskkill cap, below
// The grace window must OUTLAST the worst case for a genuinely-alive displaced owner to (a) notice
// the replacement via a missed heartbeat and (b) finish killing its active children — otherwise a
// reclaiming contender can finish verifying itself and start real work (git ops on the SAME primary
// repo) while the old owner is still mid-kill. 2500ms was shorter than killTree's own 5s cap alone,
// which reproduces exactly the double-instance race this lock exists to prevent (audit: "delayed
// contender" race). Kept as a formula, not a literal, so it can't silently drift out of sync again.
const LOCK_VERIFY_GRACE_MS = LOCK_HEARTBEAT_MS * LOCK_HEARTBEAT_MISS_LIMIT + KILL_TREE_CAP_MS + 1500;
let lockMisses = 0, lockLossInProgress = false;
async function abortForLostLock() {
  if (lockLossInProgress) return;
  lockLossInProgress = true;
  log(`🛑 LOST OWNERSHIP of ${LOCK_FILE} — terminating active subprocesses and exiting before another instance starts`);
  try {
    const kills = await Promise.all([...ACTIVE_CHILDREN].map(pid => killTree(pid)));
    if (kills.some(k => !k.ok)) {
      // Must write the durable marker — suppress-only left orphans reclaimable after this process exits.
      await markUnsafeChild(`lost-lock: process tree kill unverified (pids: ${[...ACTIVE_CHILDREN].join(',')})`);
    }
  } finally { process.exit(1); }
}
const touchLock = () => {
  const current = readLockRecord();
  if (!sameLockOwner(current)) {
    if (++lockMisses >= LOCK_HEARTBEAT_MISS_LIMIT) void abortForLostLock();
    return false;
  }
  try {
    const now = new Date();
    utimesSync(LOCK_FILE, now, now);
    lockMisses = 0;
    return true;
  }
  catch {
    if (++lockMisses >= 2) void abortForLostLock();
    return false;
  }
};
function startLockHeartbeat() {
  const h = setInterval(touchLock, LOCK_HEARTBEAT_MS);
  if (typeof h.unref === 'function') h.unref();
  return h;
}
async function acquireLock() {
  refuseIfUnsafeMarker();
  const take = () => { writeFileSync(LOCK_FILE, LOCK_OWNER.raw, { flag: 'wx' }); };
  try { take(); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const record = readLockRecord();
    const pid = record?.pid;
    const identity = pid && pid !== process.pid && alive(pid) ? isAgentLoopProcess(pid) : 'no';
    // 'unknown' = the OS wouldn't identify the process (e.g. macOS has no /proc). Refusing forever
    // on an unidentifiable live PID lets a recycled PID wedge the loop permanently, so fall back to
    // the refreshed mtime: a real running instance touches the lock every pass.
    const staleAfterS = Math.max(10 * POLL, 600);
    const age = lockAgeS();
    const freshIncomplete = !record && age < 10;   // exclusive create may briefly precede its JSON write
    if (freshIncomplete || identity === 'yes' || (identity === 'unknown' && age < staleAfterS)) {
      console.error(`✖ agent-loop is already running (${pid ? `pid ${pid}` : 'lock write in progress'}${identity === 'unknown' ? ', identity unverifiable' : ''}, lock touched ${Math.round(age)}s ago). Run exactly one instance.`);
      console.error(`  If you are certain it is dead: delete ${LOCK_FILE}`);
      process.exit(1);
    }
    const why = !pid ? 'unreadable lock file'
      : identity === 'unknown' ? `pid ${pid} unverifiable and the lock has not been touched for ${Math.round(age)}s (> ${staleAfterS}s)`
      : alive(pid) ? `pid ${pid} is alive but is NOT an agent-loop process (recycled pid)`
      : `dead pid ${pid}`;
    log(`(reclaiming stale lock — ${why})`);
    try { unlinkSync(LOCK_FILE); } catch {}
    try { take(); }
    catch { console.error(`✖ lost the race for ${LOCK_FILE} to another starting instance — exiting.`); process.exit(1); }
  }
  // Reclaim is unlink+create, which is not atomic. Wait longer than two ownership heartbeats before
  // proceeding; a live owner displaced by a delayed contender will stop itself during this window.
  await sleep(LOCK_VERIFY_GRACE_MS);
  // A peer may have written the unsafe marker during the grace window (e.g. lost-lock kill failed).
  refuseIfUnsafeMarker();
  const owner = readLockRecord();
  if (!sameLockOwner(owner)) {
    console.error(`✖ another instance (pid ${owner?.pid || 'unknown'}) took ${LOCK_FILE} during startup — exiting to avoid two instances on one git tree.`);
    process.exit(1);
  }
  const release = () => {
    if (!allowLockRelease) {
      log(`  ⚠ retaining lock ${LOCK_FILE}: unsafe child may still be alive`);
      return;
    }
    try { if (existsSync(LOCK_FILE) && sameLockOwner(readLockRecord())) unlinkSync(LOCK_FILE); } catch {}
  };
  process.on('exit', release);
  // Await tree-kill before exit so a new instance cannot start while an orphan still edits.
  let shuttingDown = false;
  const hardStop = async (code, sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`🛑 ${sig} — stopping active subprocesses before releasing the lock`);
    const kills = await Promise.all([...ACTIVE_CHILDREN].map(pid => killTree(pid)));
    if (kills.some(k => !k.ok)) {
      await markUnsafeChild(`${sig}: process tree kill unverified (pids: ${[...ACTIVE_CHILDREN].join(',')})`);
    }
    release();
    process.exit(code);
  };
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { void hardStop(sig === 'SIGINT' ? 130 : 143, sig); });
  }
}

// ---------- ClickUp REST ----------
const H = { Authorization: TOKEN, 'Content-Type': 'application/json' };
const CU_TIMEOUT = num('AGENT_LOOP_CLICKUP_TIMEOUT_S', 30, 5, 300) * 1000;
// Attempts per call, and the base for exponential backoff between them. 3 attempts at 2s/4s rides
// out a ~10s blip; the 2026-08-07 outage lasted ~5min, which is longer than any in-lane retry should
// cover — that one is correctly left to the next pass. This exists so a ONE-SHOT socket error can no
// longer unwind a lane that has already committed work.
const CU_TRIES   = num('AGENT_LOOP_CLICKUP_TRIES', 3, 1, 10);
const CU_BACKOFF = num('AGENT_LOOP_CLICKUP_BACKOFF_MS', 2000, 100, 60_000);
// Retry only what a retry can actually fix: transport faults (fetch failed / DNS / reset), an explicit
// timeout, 429, and 5xx. NEVER a 4xx — a bad token, a missing task or an invalid status is
// deterministic, and retrying it just triples the log noise before the same failure.
const cuRetryable = e => e.status === undefined || e.status === 429 || e.status >= 500;
async function cu(method, path, body) {
  // Without a signal a stalled socket hangs the whole pass indefinitely (ClickUp's transport is
  // known-flaky here). Throwing instead is safe: pass() catches and the next poll retries.
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(`${CLICKUP}${path}`, {
        method, headers: H, body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(CU_TIMEOUT),
      }).catch(e => {
        const err = new Error(`ClickUp ${method} ${path} → ${e.name === 'TimeoutError' ? `timed out after ${CU_TIMEOUT / 1000}s` : e.message}`);
        throw err; // no .status → transport fault → retryable
      });
      const txt = await r.text();
      if (!r.ok) {
        const err = new Error(`ClickUp ${method} ${path} → ${r.status}: ${txt}`);
        err.status = r.status;
        throw err;
      }
      return txt ? JSON.parse(txt) : {};
    } catch (e) {
      if (attempt >= CU_TRIES || !cuRetryable(e)) throw e;
      const waitMs = CU_BACKOFF * 2 ** (attempt - 1);
      log(`  ⚠ ${e.message} — retrying in ${waitMs}ms (attempt ${attempt}/${CU_TRIES})`);
      // Inlined rather than calling sleep() (declared ~600 lines below): const is in its temporal
      // dead zone until then, and this file has already shipped one TDZ bug from that exact pattern.
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}
const getList       = ()            => cu('GET', `/list/${LIST_ID}`);
const getTask       = id            => cu('GET', `/task/${id}`);
const setStatus     = (id, status)  => { log(`  ${id} → ${status}`); return cu('PUT', `/task/${id}`, { status }); };
// Used only by resolveStalledWithClaude to apply a Claude-authored AC/description fix — the ONE
// place this dispatcher rewrites task content instead of just its status.
const setDescription = (id, description) => { log(`  ${id}: description auto-repaired`); return cu('PUT', `/task/${id}`, { description }); };
const comment       = (id, text)    => cu('POST', `/task/${id}/comment`, { comment_text: text });
// Comments are INFORMATIONAL and must never abort a lane. They used to: ClickUp's comment endpoint
// failing while task updates still worked meant a lane unwound *after* a successful commit, the task
// was reset to `ready`, and the next attempt's `checkout -B` rewound the branch to its base and threw
// the commit away. Written with .catch (not await comment) so it can never recurse into itself.
const tryComment    = (id, text)    => comment(id, text).catch(e => log(`  ⚠ comment on ${id} failed (${e.message}) — continuing anyway`));
const tasksByStatus = status        => cu('GET', `/list/${LIST_ID}/task?statuses[]=${encodeURIComponent(status)}&order_by=created&subtasks=true`);
const getComments   = id            => cu('GET', `/task/${id}/comment`);
const getTaskWithSubtasks = id       => cu('GET', `/task/${id}?include_subtasks=true`);
// Best-effort context for re-scoping a task that was ALREADY stalled before this pass started (no
// fresh review verdict on hand) — never fatal, a re-scope with less context is still better than none.
async function recentCommentsText(id, n = 5) {
  try {
    const { comments = [] } = await getComments(id);
    return comments.slice(0, n).map(c => (c.comment_text || '').trim()).filter(Boolean).join('\n---\n');
  } catch (e) {
    log(`  ⚠ could not fetch comments for ${id} (${e.message}) — re-scoping without them`);
    return '';
  }
}

export function acceptanceCriteriaOf(t) {
  const fieldValue = (t.custom_fields || []).find(f => f.name === AC_FIELD)?.value;
  const ac = typeof fieldValue === 'string' ? fieldValue.trim() : '';
  const description = typeof t.description === 'string'
    ? t.description.replace(/\r\n?/g, '\n').trim()
    : '';
  const descriptionLines = description.split('\n');
  const firstLine = descriptionLines[0]?.trim();
  const supplement = firstLine === AC_DESCRIPTION_MARKER ? description : '';
  const replacesField = supplement
    && descriptionLines.slice(1).some(line => line.trim() === AC_DESCRIPTION_REPLACE_MARKER);
  if (replacesField) return supplement;
  return [ac, supplement && `TASK DESCRIPTION SUPPLEMENT:\n${supplement}`].filter(Boolean).join('\n\n');
}
const acOf       = acceptanceCriteriaOf;
const statusOf   = t => t.status?.status;
const statusDone = t => ['done', 'closed'].includes(t.status?.type);
const isTracker  = t => /TRACKER ONLY/i.test(acOf(t));   // intentionally-blocked epics ClickUp leaks into filters
// The single answer to "may the dispatcher work this task at all?", so every entry point agrees.
// The queue lanes already can't reach a planning-column task (they query S's statuses only), but the
// explicit <taskId> path fetches a task by ID and previously ran it through a lane with NO status or
// tracker check — so `agent-loop.mjs <epicId>` would implement a TRACKER ONLY epic.
// Parking an epic in the planning column must hold its whole chain. Before this, the guard looked
// only at each task's OWN status, so an epic sat in `planned` while its children sat in `ready` and
// the loop worked straight through them — which is exactly what happened to the Admin/Guide scoping
// chain (G1 and G2 committed before anyone noticed the parent was never cleared).
// Structural, marker-free: a task with subtasks is a tracker whatever its Acceptance Criteria says.
export const containerRefusalReason = t => {
  const n = (t?.subtasks || []).length;
  return n ? `has ${n} subtask(s) — a parent tracks work, it is not the work; implement its subtasks instead` : null;
};
export const parentRefusalReason = parent => {
  const status = parent ? statusOf(parent) : null;   // statusOf() is not null-safe
  return NEVER_PICKUP.has(String(status || '').toLowerCase())
    ? `parent ${parent?.id || '(unknown)'} is in never-pickup status "${status}"`
    : null;
};
export const pickupRefusalReason = t =>
  NEVER_PICKUP.has(String(statusOf(t) || '').toLowerCase()) ? `status "${statusOf(t)}" is never picked up`
  : isTracker(t) ? 'TRACKER ONLY epic — implement its subtasks instead'
  : null;
export const reviewPassAction = (reviewer, onPass) => reviewer === 'codex' ? 'approved' : onPass;
// Codex down, Claude up: Claude reviews in its place, and its PASS may LAND — but only when Claude
// did not write the diff. The invariant is no longer "Codex specifically" but the thing that
// invariant was protecting: nothing reaches main that was reviewed by its own author. A
// Claude-coded + Claude-reviewed task therefore still parks on `in review` awaiting Codex.
export const claudeReviewPassAction = coder => (coder === 'claude' ? 'review' : 'approved');
// A task parked on `in review` carries no memory of who coded it, so the queue used to need Codex.
// The branch itself is the record: every commit this dispatcher writes names its coder ("Implemented
// by X via the agent-loop dispatcher", or "[PARTIAL — X exited N]" for a failed round). No side file
// to drift from git. EVERY commit must name a known coder — one unattributed commit means something
// else contributed (a human, another tool, a hand-fix) and provenance is unclear. Unclear returns
// null, which keeps the task parked: never let a possible author review its own diff.
const KNOWN_CODERS = new Set(['grok', 'codex', 'claude']);
export function codersFromCommits(messages) {
  const list = Array.isArray(messages) ? messages : [];
  if (!list.length) return null;
  const out = new Set();
  for (const msg of list) {
    const m = /Implemented by (\S+) via the agent-loop dispatcher/.exec(msg)
      || /\[PARTIAL\s+[—-]\s+(\S+) exited/.exec(msg);
    const who = m ? m[1].toLowerCase() : null;
    if (!who || !KNOWN_CODERS.has(who)) return null;
    out.add(who);
  }
  return out;
}
export const parkedReviewReviewer = coders =>
  (coders && coders.size && !coders.has('claude') ? 'claude' : null);
export const dependencySatisfied = t => statusDone(t) || statusOf(t) === S.approved;
// A tracker's status should state what its children add up to. Leaving an epic on `ready` after all
// seven of its subtasks reached `committed` is just a false reading of the board.
//   every child done                                    → the parent is done      (`committed`)
//   every child done-or-approved, at least one approved  → the parent is approved  (Codex signed off;
//                                                          Claude has not landed them yet)
// Returns null when nothing should change, so the caller never writes a redundant status.
// Forward-only, deliberately: a `committed` parent whose child reopens is left alone.
// ponytail: downgrades were not asked for, and a done tracker that flaps back and forth is worse
// than one that is briefly stale. Add the reverse rule only if a reopened child actually misleads.
export function trackerRollupStatus(parent, children) {
  const kids = (children || []).filter(Boolean);
  if (!kids.length) return null;
  const done = kids.filter(statusDone).length;
  const approved = kids.filter(k => statusOf(k) === S.approved).length;
  if (done === kids.length) return statusDone(parent) ? null : S.committed;
  if (statusDone(parent)) return null;
  if (approved > 0 && done + approved === kids.length) {
    return statusOf(parent) === S.approved ? null : S.approved;
  }
  return null;
}
function blockerIds(t) {
  const ids = new Set();
  const f = (t.custom_fields || []).find(f => f.name === BLOCKED_BY);
  for (const x of (Array.isArray(f?.value) ? f.value : [])) { const id = typeof x === 'string' ? x : x?.id; if (id) ids.add(id); }
  for (const d of t.dependencies || []) if (d.task_id === t.id && d.depends_on) ids.add(d.depends_on);
  return [...ids];
}
export function orderApprovedTasks(tasks) {
  const byId = new Map((tasks || []).map(t => [t.id, t]));
  const indegree = new Map([...byId.keys()].map(id => [id, 0]));
  const children = new Map([...byId.keys()].map(id => [id, []]));
  for (const t of byId.values()) {
    for (const blocker of blockerIds(t)) {
      if (!byId.has(blocker)) continue;
      indegree.set(t.id, indegree.get(t.id) + 1);
      children.get(blocker).push(t.id);
    }
  }
  const stable = (a, b) => {
    const at = Number(byId.get(a)?.date_created || 0);
    const bt = Number(byId.get(b)?.date_created || 0);
    return at - bt || a.localeCompare(b);
  };
  const ready = [...byId.keys()].filter(id => indegree.get(id) === 0).sort(stable);
  const ordered = [];
  while (ready.length) {
    const id = ready.shift();
    ordered.push(byId.get(id));
    for (const child of children.get(id).sort(stable)) {
      const next = indegree.get(child) - 1;
      indegree.set(child, next);
      if (next === 0) {
        ready.push(child);
        ready.sort(stable);
      }
    }
  }
  if (ordered.length !== byId.size) {
    const cyclic = [...byId.keys()].filter(id => indegree.get(id) > 0).sort();
    throw new Error(`approved dependency cycle: ${cyclic.join(', ')}`);
  }
  return ordered;
}
export const approvedBlockedThisRound = (t, failedIds) => blockerIds(t).some(id => failedIds.has(id));
export function stalledStopReason(tasks) {
  if (!(tasks || []).length) return null;
  const safe = value => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  const summary = tasks.slice(0, 20).map(t => `${safe(t.id)} "${safe(t.name) || '(unnamed)'}"`).join(', ');
  const more = tasks.length > 20 ? `, … +${tasks.length - 20} more` : '';
  return `${tasks.length} stalled task(s) require Claude resolution before Agent Loop can continue: ${summary}${more}`;
}
export function noChangeOutcome(coder, output) {
  const safeCoder = String(coder ?? 'coder')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40) || 'coder';
  const diagnostic = String(output ?? '')
    .slice(-4000)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\b((?:OPENAI|ANTHROPIC|XAI|GEMINI|GOOGLE|CLICKUP|GITHUB|GH)_(?:API_)?(?:KEY|TOKEN|SECRET))\s*[:=]\s*["']?[^\s"'`]+/gi, '$1=[REDACTED]')
    .replace(/\b(?:sk-(?:ant-)?|xai-|gh[pousr]_|pk_|AIza)[A-Za-z0-9._-]{12,}\b/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~-]{12,}\b/gi, 'Bearer [REDACTED]')
    .trim()
    .slice(-1200)
    .replace(/```/g, '``\u200b`')
    || '(coder returned no diagnostic output)';
  return {
    status: S.stalled,
    comment: `🛑 **${safeCoder}** exited successfully but produced no changes → **stalled** for human/Claude diagnosis.\n\`\`\`\n${diagnostic}\n\`\`\``,
  };
}
// A coder exiting 0 with nothing left to change is only a failure when the BRANCH is also empty.
// If an earlier round already produced the work — the common case being a coder that timed out
// during wrap-up *after* committing, so its work is labelled PARTIAL but is in fact complete —
// then there is a real diff and the task belongs in review, not stalled. Same rule as the
// fresh-fork refusal above: commits beyond base decide review-vs-not.
export const zeroChangeRoute = commitsBeyondBase => (commitsBeyondBase > 0 ? S.review : S.stalled);

// Same principle as zeroChangeRoute, for the lane we killed ourselves. A coder that hit OUR cap
// rendered no verdict, so "changes requested" is an assumption, not an observation — and the log says
// it is usually the wrong one: these lanes are typically killed during wrap-up with the work already
// finished (one such round passed review verbatim once resubmitted). If it committed something, let a
// REVIEWER decide. A genuinely half-finished branch just fails that review and lands on `changes
// requested` from there, so the round budget is still enforced — one round per rejected review — and
// a timeout that committed nothing is still an outright failure.
export const timeoutRoute = (timedOut, committedPartial) => (timedOut && committedPartial ? S.review : S.changes);
async function depsSatisfied(t) {
  for (const bid of blockerIds(t)) {
    const b = await getTask(bid).catch(() => null);
    if (!b || !dependencySatisfied(b)) { log(`  ⏸ ${t.id} blocked by ${bid} (${b?.status?.status || 'unknown'})`); return false; }
  }
  return true;
}
// One fork base cannot carry two unmerged predecessors. land() pushes each task branch and NEVER
// merges to BASE, so a satisfied predecessor's commits live only on its own branch until a human
// integrates them. With several such predecessors, the old `ids.length !== 1 → null` silently fell
// back to BASE and the successor inherited NONE of their work — then burned its whole round budget
// rediscovering that its prerequisite "does not exist", which was true on its branch and false in the
// repository. Refuse and name the branches instead of guessing one.
export function chainBaseFrom(branches) {
  const uniq = [...new Set((branches || []).filter(Boolean))];
  if (uniq.length > 1) return { base: null, ambiguous: uniq };
  return { base: uniq[0] ?? null };
}
async function resolveChainBase(t) {   // fork/diff base: a dependency-satisfying blocker's branch, else BASE
  const ids = blockerIds(t);
  if (!ids.length) return { base: null };
  const branches = [];
  for (const bid of ids) {
    // Do not turn a transient ClickUp failure into "no blocker": using BASE in that case can compare a
    // chained branch against main, mistake inherited predecessor commits for this task's work, and
    // park an empty task on review. Let the bounded pass retry with authoritative dependency data.
    const b = await getTask(bid);
    if (!b || !dependencySatisfied(b)) return { base: null };
    // findExistingBranchOf (not existingBranchOf): a satisfied predecessor with NO branch on disk did
    // its work outside a lane — a human task, or one already merged and pruned — so its commits are on
    // BASE. existingBranchOf would invent the never-created branch name and every caller's `?? BASE`
    // would be bypassed, forking the successor off a ref that does not exist → instant `blocked`.
    branches.push(await findExistingBranchOf(b));   // predecessors may predate the ID suffix — resolve what's on disk
  }
  return chainBaseFrom(branches);
}
async function latestChangesComment(id) {
  const { comments = [] } = await getComments(id);
  const cr = comments.filter(c => (c.comment_text || '').toLowerCase().includes('changes requested'))
                     .sort((a, b) => Number(b.date) - Number(a.date));
  return cr[0]?.comment_text || '';
}

// ---------- subprocess runner ----------
// Labelled runs emit a heartbeat: an agent stage takes 10-20 min and otherwise prints NOTHING
// until it resolves, which is indistinguishable from a hang. Tick = elapsed/cap + the child's
// last output line. Console only (not the audit log) so the log stays a phase-boundary record.
// Kill a whole process TREE. spawn()'s own `timeout` only signals the direct child — with
// shell:true that's cmd.exe/sh, NOT the agent CLI beneath it. The CLI then keeps running AND
// holds the stdio pipes, so 'close' never fires and the promise hangs past its cap forever
// (measured: a 300ms cap returned only after the 12s grandchild finished). So: own timer and an
// awaited, bounded tree-kill whose result is surfaced to the caller.
const ACTIVE_CHILDREN = new Set();
async function killTree(pid) {   // function decl: lock-loss handling references it above
  if (!pid) return { ok: true, detail: 'no pid' };
  try {
    if (process.platform !== 'win32') {
      process.kill(-pid, 'SIGKILL');       // negative pid = the detached process group
      return { ok: true, detail: 'SIGKILL sent to process group' };
    }
    return await new Promise(resolve => {
      let settled = false;
      const finish = (ok, detail) => {
        if (settled) return;
        settled = true;
        clearTimeout(cap);
        resolve({ ok, detail });
      };
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore', shell: false, windowsHide: true,
      });
      const cap = setTimeout(() => {
        try { killer.kill('SIGKILL'); } catch {}
        finish(false, `taskkill itself exceeded ${KILL_TREE_CAP_MS}ms`);
      }, KILL_TREE_CAP_MS);
      killer.on('error', e => finish(false, `taskkill failed to start: ${e.message}`));
      killer.on('close', code => {
        // Do NOT treat "root PID gone" alone as success when taskkill failed: descendants can
        // reparent and keep editing while a new dispatcher takes the lock (audit: hard-stop race).
        const rootGone = !alive(pid);
        if (code === 0 && rootGone) finish(true, `taskkill exit 0; root gone`);
        else if (code === 0 && !rootGone) finish(false, `taskkill exit 0 but root pid ${pid} still alive`);
        else finish(false, `taskkill exit ${code}; root ${rootGone ? 'gone (descendants unverified)' : 'still alive'}`);
      });
    });
  } catch (e) {
    if (e.code === 'ESRCH') return { ok: true, detail: 'process already gone' };
    return { ok: false, detail: e.message };
  }
}
// Env for agent/verify children: never inherit ClickUp or push credentials (audit: secret inheritance).
// Also strip/redirect any pointer at the primary repo so a child cannot trivially `cd $AGENT_LOOP_REPO`.
// AI provider keys are left intact by default so coders/reviewers can still call their CLIs — EXCEPT
// under stripProviderKeys, used for VERIFY. Verify runs the project's own test/build command, not an
// agent CLI; it has no legitimate reason to reach an AI provider, so widening redaction there shrinks
// the blast radius of a compromised or malicious test (e.g. one that tries to exfiltrate a key) without
// touching the coder/reviewer, which still need these keys.
// True OS filesystem jails are not available here; this is defense-in-depth, not a seccomp sandbox.
export function agentChildEnv(base = process.env, { sandboxDir = null, primaryRepo = null, stripProviderKeys = false } = {}) {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (
      /CLICKUP/i.test(key)
      || /^(GITHUB_TOKEN|GH_TOKEN|GITLAB_TOKEN|NPM_TOKEN|NODE_AUTH_TOKEN|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)$/i.test(key)
      || /^(DOCKER_.*PASSWORD|AZURE_.*SECRET|HF_TOKEN)$/i.test(key)
    ) {
      delete env[key];
    }
    if (stripProviderKeys && /^(OPENAI|ANTHROPIC|GOOGLE|GEMINI|XAI|GROK|ELEVENLABS|COHERE|MISTRAL|PERPLEXITY|GROQ|TOGETHER|REPLICATE|HUGGINGFACE)_?API_?KEY$/i.test(key)) {
      delete env[key];
    }
  }
  delete env.CLICKUP_TOKEN;
  delete env.AGENT_LOOP_ENV; // path to the file that holds CLICKUP_TOKEN
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  env.GIT_ASKPASS = process.platform === 'win32' ? 'cmd.exe /c exit 1' : '/bin/false';
  env.SSH_ASKPASS = env.GIT_ASKPASS;

  const primary = primaryRepo ? pathNormalize(pathResolve(primaryRepo)) : null;
  const sandbox = sandboxDir ? pathNormalize(pathResolve(sandboxDir)) : null;
  // Point repo-oriented vars at the sandbox only — never at the primary tree.
  if (sandbox) {
    env.AGENT_LOOP_REPO = sandbox;
    env.PWD = sandbox;
    env.INIT_CWD = sandbox;
  } else {
    delete env.AGENT_LOOP_REPO;
  }
  if (primary) {
    const primaryLower = primary.toLowerCase();
    const isPrimaryPath = (val) => {
      if (typeof val !== 'string' || !val) return false;
      let n;
      try { n = pathNormalize(pathResolve(val)); } catch { return false; }
      const nl = n.toLowerCase();
      return nl === primaryLower || nl.startsWith(primaryLower + pathSep) || nl.startsWith(primaryLower + '/');
    };
    for (const key of Object.keys(env)) {
      if (key === 'PATH' || key === 'Path' || key === 'PATHEXT') continue; // never mangle PATH
      if (isPrimaryPath(env[key])) {
        if (sandbox) env[key] = sandbox;
        else delete env[key];
      }
    }
  }
  env.AGENT_LOOP_SANDBOX = '1';
  return env;
}

function runProc(cmd, { input, timeout, label, cwd, env, agent = false, stripProviderKeys = false } = {}) {
  return new Promise(resolve => {
    const childEnv = env || (agent
      ? agentChildEnv(process.env, { sandboxDir: cwd || null, primaryRepo: REPO, stripProviderKeys })
      : process.env);
    const p = spawn(cmd, { cwd: cwd || REPO, shell: true, detached: process.platform !== 'win32', env: childEnv });
    ACTIVE_CHILDREN.add(p.pid);
    let out = '', tail = '', settled = false, timingOut = false, outputTruncated = false;
    const OUTPUT_CAP = 8 * 1024 * 1024;
    const t0 = Date.now(), hb = heartbeatMs();
    const tick = label && hb > 0 ? setInterval(() => {
      console.log(`   … ${label} ${mmss(Date.now() - t0)}${timeout ? `/${mmss(timeout)}` : ''}${tail ? ` — ${tail.slice(0, 110)}` : ''}`);
    }, hb) : null;
    const done = r => {
      if (settled) return;                       // a tree-kill still fires 'close' afterwards — ignore it
      settled = true;
      if (tick) clearInterval(tick);
      if (killer) clearTimeout(killer);
      // Keep the PID registered when tree-kill failed so hard-stop can retry; deleting it here
      // left orphan agents untracked (audit: ACTIVE_CHILDREN cleared on killFailed).
      if (!r.killFailed) ACTIVE_CHILDREN.delete(p.pid);
      resolve(r);
    };
    const killer = timeout ? setTimeout(async () => {
      timingOut = true;
      const killed = await killTree(p.pid);
      const note = killed.ok
        ? `[agent-loop] TIMEOUT after ${mmss(timeout)} — killed process tree of pid ${p.pid} (${killed.detail})`
        : `[agent-loop] TIMEOUT after ${mmss(timeout)} — PROCESS TREE KILL FAILED for pid ${p.pid} (${killed.detail})`;
      log(`  ✖ ${label || cmd.slice(0, 60)}: ${note}`);
      done({ code: TIMEOUT_CODE, out: `${out}\n${note}`, killFailed: !killed.ok });
      // If kill eventually succeeds on a later hard-stop attempt, shutdown will remove it.
      if (killed.ok) ACTIVE_CHILDREN.delete(p.pid);
    }, timeout) : null;
    const take = d => {
      out += d;
      if (out.length > OUTPUT_CAP) {
        out = `[agent-loop] earlier output truncated at ${OUTPUT_CAP} bytes\n${out.slice(-OUTPUT_CAP)}`;
        outputTruncated = true;
      }
      const ls = String(d).split(/\r?\n/).filter(s => s.trim());
      if (ls.length) tail = ls[ls.length - 1].trim();
    };
    p.stdout.on('data', take);
    p.stderr.on('data', take);
    p.stdin.on('error', () => {});             // EPIPE is expected when a child exits before stdin drains
    if (input != null) { try { p.stdin.write(input); p.stdin.end(); } catch {} }
    p.on('close', code => { if (!timingOut) done({ code, out, outputTruncated }); });
    p.on('error', err => { if (!timingOut) done({ code: 1, out: String(err), outputTruncated }); });
  });
}
// git gets a default cap and a non-interactive env: a credential prompt on `push` would otherwise
// block forever with no TTY (Windows credential manager can pop a dialog nothing ever answers).
const GIT_TIMEOUT = num('AGENT_LOOP_GIT_TIMEOUT_S', 120, 10, 3600) * 1000;
const gitAt = async (repoPath, args, o = {}) => {
  const r = await runProc(
    `git -c credential.interactive=never -C "${repoPath}" ${args}`,
    { timeout: GIT_TIMEOUT, ...o },
  );
  if (r.killFailed) {
    throw new FatalLoopError(`git timed out and its process tree could not be confirmed stopped while running: ${args}`, {
      unsafeChild: true,
    });
  }
  return r;
};
const git = (args, o = {}) => gitAt(REPO, args, o);
const revParseAt = async (repoPath, rev) => {
  const r = await gitAt(repoPath, `rev-parse ${rev}`);
  if (r.code !== 0) throw new Error(`rev-parse ${rev} failed in ${repoPath} (git exit ${r.code}: ${r.out.trim().slice(0, 200)})`);
  return r.out.trim();
};

// ---------- agent sandbox (SEPARATE clone — not a linked worktree) ----------
// Linked worktrees share the primary repo's common .git; an agent can `git update-ref` main there.
// A local clone has independent refs. We also strip remotes + credential helpers and run agents
// with agentChildEnv() so they cannot push with inherited tokens.
function sandboxHandle(dir, meta = {}) {
  return {
    ok: true,
    dir,
    kind: 'clone',
    ...meta,
    async dispose() {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

async function hardenSandboxGit(dir) {
  // Fail-closed: a sandbox that still has remotes or credential helpers is not safe to hand to an agent.
  const remotes = await gitAt(dir, 'remote');
  if (remotes.code !== 0) {
    throw new Error(`sandbox harden: cannot list remotes (${remotes.out.trim().slice(0, 200)})`);
  }
  for (const name of remotes.out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
    const rm = await gitAt(dir, `remote remove ${name}`);
    if (rm.code !== 0) {
      throw new Error(`sandbox harden: cannot remove remote '${name}' (${rm.out.trim().slice(0, 200)})`);
    }
  }
  const left = await gitAt(dir, 'remote');
  if (left.code !== 0 || left.out.trim()) {
    throw new Error(`sandbox harden: remotes still present after remove (${left.out.trim().slice(0, 200)})`);
  }
  for (const cfg of ['credential.helper ""', 'core.askPass ""', 'remote.pushDefault ""']) {
    const c = await gitAt(dir, `config --local ${cfg}`);
    if (c.code !== 0) {
      throw new Error(`sandbox harden: config ${cfg} failed (${c.out.trim().slice(0, 200)})`);
    }
  }
}

// Materialize `name` as a real local branch (from its remote-tracking ref) if it isn't one already.
// Needed for any ref referenced by name AFTER hardening removes "origin" and its remote-tracking
// refs — e.g. a review diff base that isn't the branch actually checked out in this clone.
async function ensureLocalBranch(dir, name) {
  const have = await gitAt(dir, `rev-parse --verify --quiet refs/heads/${name}`);
  if (have.code === 0) return;   // already a local branch (e.g. the clone's default branch)
  const made = await gitAt(dir, `branch ${name} refs/remotes/origin/${name}`);
  if (made.code !== 0) throw new Error(`cannot materialize ${name} as a local branch before hardening (${made.out.trim().slice(0, 240)})`);
}

export function sandboxStartRef(name, localExists, remoteExists) {
  return !localExists && remoteExists ? `refs/remotes/origin/${name}` : name;
}

async function resolveSandboxStartRef(dir, name) {
  const local = await gitAt(dir, `rev-parse --verify --quiet refs/heads/${name}`);
  if (local.code !== 0 && local.code !== 1) {
    throw new Error(`cannot inspect local sandbox base ${name} (${local.out.trim().slice(0, 240)})`);
  }
  const remote = await gitAt(dir, `rev-parse --verify --quiet refs/remotes/origin/${name}`);
  if (remote.code !== 0 && remote.code !== 1) {
    throw new Error(`cannot inspect remote-tracking sandbox base ${name} (${remote.out.trim().slice(0, 240)})`);
  }
  return sandboxStartRef(name, local.code === 0, remote.code === 0);
}

// Independent clone for agent/verify work. `createFrom` creates a new branch (fails if it exists
// in the clone after fetch — primary already guarded). Otherwise checks out an existing branch.
// `alsoBranch`: an extra branch (e.g. a review diff base) the caller will reference by name AFTER
// this returns — materialized as a local branch before hardening removes the remote it came from.
async function openAgentSandbox(branch, { createFrom = null, detachAt = null, alsoBranch = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'al-clone-'));
  // --local uses hardlinked objects when possible (fast) but still independent refs.
  // --no-hardlinks forces object copies on platforms where hardlinks share mutability concerns.
  const clone = await runProc(
    `git -c credential.interactive=never clone --local --no-hardlinks "${REPO}" "${dir}"`,
    { timeout: Math.max(GIT_TIMEOUT, 600_000), label: 'clone sandbox' },
  );
  if (clone.code !== 0) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    return { ok: false, dir: null, branch, err: clone.out.trim() };
  }
  // Checkout BEFORE hardening: an existing (non-default-branch) checkout DWIMs a local branch off
  // refs/remotes/origin/<branch>, which only exists while the "origin" remote from the clone is
  // still there. hardenSandboxGit() removes that remote (and its remote-tracking refs) — running it
  // first left plain `checkout ${branch}` unable to find the branch at all ("did not match any
  // file(s) known to git"), even though the branch existed in the source repo.
  let setup;
  if (detachAt) {
    setup = await gitAt(dir, `checkout --detach ${detachAt}`);
  } else if (createFrom) {
    // Refuse if branch already exists in the primary (caller should have checked); still race-safe
    // via checkout -b failing if present after clone.
    let startRef;
    try {
      startRef = await resolveSandboxStartRef(dir, createFrom);
    } catch (e) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
      return { ok: false, dir: null, branch, err: e.message };
    }
    setup = await gitAt(dir, `checkout -b ${branch} ${startRef}`);
  } else {
    setup = await gitAt(dir, `checkout ${branch}`);
  }
  if (setup.code !== 0) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    return { ok: false, dir: null, branch, err: setup.out.trim() };
  }
  if (alsoBranch) {
    try {
      await ensureLocalBranch(dir, alsoBranch);
    } catch (e) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
      return { ok: false, dir: null, branch, err: e.message };
    }
  }
  try {
    await hardenSandboxGit(dir);
  } catch (e) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    return { ok: false, dir: null, branch, err: e.message };
  }
  return sandboxHandle(dir, { branch, detachAt, createFrom });
}

// Zero OID for git update-ref create-CAS: ref must not exist (audit: concurrent create race).
export const ZERO_OID = '0'.repeat(40);
export function createBranchRefCmd(branch, tip) {
  return `update-ref refs/heads/${branch} ${tip} ${ZERO_OID}`;
}
export function fastForwardBranchRefCmd(branch, tip, old) {
  return `update-ref refs/heads/${branch} ${tip} ${old}`;
}

// Pure: does `git worktree list --porcelain` show `branch` checked out anywhere — the primary tree
// (always the listing's first entry) or any linked worktree? Split from the git call so --selftest
// can exercise the parsing with a fixture instead of a real repo.
export function findBranchCheckoutIn(porcelainOutput, branch) {
  const wanted = `refs/heads/${branch}`;
  for (const block of String(porcelainOutput || '').split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const branchLine = lines.find(l => l.startsWith('branch '));
    if (branchLine && branchLine.slice('branch '.length).trim() === wanted) {
      const pathLine = lines.find(l => l.startsWith('worktree '));
      return pathLine ? pathLine.slice('worktree '.length).trim() : '(unknown worktree path)';
    }
  }
  return null;
}
// `update-ref` never touches the index or working files of a tree that has the ref checked out —
// it only moves where the ref points. Force-updating a branch that is checked out somewhere (e.g.
// a human — or this session — left it checked out in the primary tree for inspection, which happens
// routinely here) desyncs that tree from its own HEAD: `git status` then reports phantom
// staged/unstaged changes (reproduced: a false deletion) with no commit actually lost, but a
// thoroughly confusing tree. Refuse instead; the import retries once nothing has it checked out.
async function branchCheckedOutAnywhere(branch) {
  const list = await gitAt(REPO, 'worktree list --porcelain');
  if (list.code !== 0) throw new Error(`could not enumerate worktrees (git exit ${list.code}: ${list.out.trim().slice(0, 200)})`);
  const where = findBranchCheckoutIn(list.out, branch);
  return where ? { checkedOut: true, where } : { checkedOut: false };
}

// Import only the task branch tip from a sandbox into the primary repo. Never touches main.
// Objects are fetched first; the branch ref is updated only if missing (zero-OID CAS) or a FF.
async function importBranchFromSandbox(sandboxDir, branch) {
  const tip = await revParseAt(sandboxDir, 'HEAD');
  const fetchObj = await git(`fetch "${sandboxDir}" ${tip}`);
  if (fetchObj.code !== 0) {
    throw new Error(`could not fetch sandbox objects for ${branch}: ${fetchObj.out.trim().slice(0, 300)}`);
  }
  const checkedOut = await branchCheckedOutAnywhere(branch);
  if (checkedOut.checkedOut) {
    throw new Error(`refusing to import ${branch}: it is checked out in ${checkedOut.where} — force-updating its ref would desync that working tree from its index; check out something else there and this will retry`);
  }
  if (await branchExists(branch)) {
    const old = await revParseAt(REPO, branch);
    if (old === tip) return tip;
    const anc = await git(`merge-base --is-ancestor ${old} ${tip}`);
    if (anc.code !== 0) {
      throw new Error(`refusing non-FF import of ${branch} (${old.slice(0, 8)} ↛ ${tip.slice(0, 8)})`);
    }
    const upd = await git(fastForwardBranchRefCmd(branch, tip, old));
    if (upd.code !== 0) throw new Error(`update-ref ${branch} failed: ${upd.out.trim().slice(0, 200)}`);
  } else {
    // Compare-and-swap create: fails if another process created the ref between branchExists and now.
    const upd = await git(createBranchRefCmd(branch, tip));
    if (upd.code !== 0) {
      throw new Error(
        `create-ref CAS failed for ${branch} (another writer likely won the race): ${upd.out.trim().slice(0, 200)}`,
      );
    }
  }
  return tip;
}

// Publish the task branch into the PRIMARY repo the moment a lane starts, parked at its base.
// Before this, the ref only appeared via FF import AFTER the commit, so a lane running 20 minutes was
// completely invisible in the IDE's Source Control Graph — you could not see what the loop was
// building until it had already finished building it. Parking at base is routing-neutral BY DESIGN:
// unstickCoding() and implement()'s -B refusal both gate on commits BEYOND base (rev-list --count),
// and a ref at base has zero, so an abandoned lane still returns to `ready` exactly as before.
// Strictly cosmetic, therefore strictly best-effort: a bookkeeping ref must never fail real work.
async function publishBranchRef(branch, base) {
  try {
    if (await branchExists(branch)) return false;      // fixing/resumed lane — nothing to publish
    const tip = await revParseAt(REPO, base);
    const r = await git(createBranchRefCmd(branch, tip));   // zero-OID CAS: loses a create race harmlessly
    if (r.code !== 0) { log(`  ⚠ could not publish ${branch} for visibility (${r.out.trim().slice(0, 120)}) — work continues`); return false; }
    log(`  ${branch} published at ${tip.slice(0, 8)} — visible in the branch graph now, fast-forwards as commits land`);
    return true;
  } catch (e) {
    log(`  ⚠ could not publish ${branch} for visibility (${e.message.slice(0, 120)}) — work continues`);
    return false;
  }
}

// Back-compat names used by call sites — all agent paths use isolated clones now.
async function openTaskWorktree(branch, { createFrom = null, alsoBranch = null } = {}) {
  return openAgentSandbox(branch, { createFrom, alsoBranch });
}
async function openDetachedWorktree(sha) {
  return openAgentSandbox(null, { detachAt: sha });
}
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const bullets = xs => (xs || []).map(x => `- ${x}`).join('\n');
// ONE scratch dir per run (removed by the lock's release handler) instead of a fresh mkdtemp per
// prompt, which leaked a directory every round forever.
const PROMPT_DIR = mkdtempSync(join(tmpdir(), 'agent-loop-'));
// Neutral cwd for availability probes. probe() never touches the repo — it just asks "reply OK" —
// so there is no reason to hand a trivial agent invocation a working directory inside the primary
// tree (the previous default, via runProc's cwd-or-REPO fallback). Not a git repo at all, so nothing
// repo-relative is even reachable by accident.
const PROBE_CWD = mkdtempSync(join(tmpdir(), 'agent-loop-probe-'));
// Own exit hook, NOT the lock's release: --check/--selftest never take the lock and would leak.
process.on('exit', () => { try { rmSync(PROMPT_DIR, { recursive: true, force: true }); } catch {} try { rmSync(PROBE_CWD, { recursive: true, force: true }); } catch {} });
let promptSeq = 0;
const writePrompt = txt => { const p = join(PROMPT_DIR, `p${++promptSeq}.txt`); writeFileSync(p, txt); return p; };
const slug   = s => (s || 'task').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'task';
// The task ID is part of the branch name because the slug is TRUNCATED to 60 chars: two similarly
// named tasks collapse to the same branch, and `checkout -B` would then reset the other task's work.
// (Verified 2026-07-26: 0 live collisions but 6 of 31 slugs sit exactly at the truncation limit.)
const branchOf       = t => `agent-loop/task-${slug(t.name)}-${t.id}`;
const legacyBranchOf = t => `agent-loop/task-${slug(t.name)}`;
const branchExists = async b => {
  const r = await git(`rev-parse --verify --quiet refs/heads/${b}`);
  if (r.code === 0) return true;
  if (r.code === 1) return false;   // the documented "ref missing" result
  throw new Error(`could not inspect branch ${b} (git exit ${r.code}: ${r.out.trim().slice(0, 200)})`);
};
// Tasks branched before the ID suffix existed must still be found, or an in-flight task would be
// reported as "no branch; skipping" and silently stall.
async function findExistingBranchOf(t) {
  const b = branchOf(t);
  if (await branchExists(b)) return b;
  const l = legacyBranchOf(t);
  if (await branchExists(l)) { log(`  ${t.id} using pre-existing legacy branch \`${l}\``); return l; }
  return null;
}
// Every coder that contributed a commit to this task's branch, per the branch's own log. null =
// could not be established (no branch, git failed, or a commit nobody signed) → caller must park.
async function parkedReviewCoders(t) {
  const branch = await findExistingBranchOf(t);
  if (!branch) return null;
  const base = (await resolveChainBase(t)).base ?? BASE;
  const out = await git(`log --format=%B%x00 ${base}..${branch}`);
  if (out.code !== 0) return null;
  return codersFromCommits(out.out.split('\0').map(s => s.trim()).filter(Boolean));
}
export function rescopeInspectionPlan(branch, tip) {
  const resolvedBranch = typeof branch === 'string' ? branch.trim() : '';
  const resolvedTip = typeof tip === 'string' ? tip.trim() : '';
  if (!resolvedBranch) return { mode: 'refuse', reason: 'task branch does not exist' };
  if (!/^[0-9a-f]{40}$/i.test(resolvedTip)) {
    return { mode: 'refuse', reason: `task branch tip is invalid for ${resolvedBranch}` };
  }
  return { mode: 'inspect', branch: resolvedBranch, sha: resolvedTip };
}
export async function resolveRescopeInspection(
  task,
  {
    findBranch = findExistingBranchOf,
    readTip = branch => revParseAt(REPO, branch),
  } = {},
) {
  const branch = await findBranch(task);
  const tip = branch ? await readTip(branch) : null;
  return rescopeInspectionPlan(branch, tip);
}

// ---------- prompts ----------
const implementPrompt = (t, ac, priorIssues) =>
`You are the IMPLEMENTER in a code pipeline. You are running inside an isolated sandbox clone. Work ONLY under process.cwd() on the current git branch. Make the MINIMAL change that satisfies the task. Do NOT commit, push, switch branches, deploy, or open/edit any absolute path outside the sandbox (including any primary repo path). Only edit files in this working tree. Read AGENTS.md at the repo root for project rules first. When done, print a short summary of the files you changed.

Acceptance criteria define the required target state, not a mandatory list of changed files. Inspect the sandbox start state before editing. If a requested cleanup/removal is already satisfied, do not manufacture a cosmetic, whitespace-only, or delete/re-add diff; report the already-satisfied state and continue with the task's real unmet requirements.

TASK: ${t.name}

ACCEPTANCE CRITERIA:
${ac || '(none provided — infer from the task name and existing code)'}

${PROJECT_CONTRACT}
${priorIssues ? `\nA previous round was REJECTED in review. Treat each reported issue as a hypothesis against the current branch and current acceptance criteria. Reproduce it before editing; if a cleanup target is already absent or the issue conflicts with updated criteria, do not manufacture a diff for it. Fix only reproduced issues:\n${priorIssues}\n` : ''}`;

const reviewPrompt = (who, t, ac, diff, base) =>
`You are ${who}, an INDEPENDENT reviewer in a code pipeline. Review ONLY the diff below. Do not edit anything.

Acceptance criteria define the required target state, not a mandatory list of changed files. You are running in the checked-out task sandbox: inspect its files and the review base when an acceptance item depends on pre-existing state. If a cleanup/removal target was already absent at the review base, treat that item as already satisfied; do not fail solely because no deletion appears in the diff, and never require cosmetic or whitespace-only churn.

Every blocking issue is a factual claim about the CURRENT reviewed tree. Before reporting one, open
the exact current file in the sandbox and verify the claimed value or behavior. Acceptance-criteria
text, examples of forbidden values, prior review prose, and removed diff lines are not current file
content. Include a path:line and the observed current value or a focused command result for every
blocking issue. If you cannot reproduce a suspected defect from the current tree, do not report it.

Before flagging a referenced symbol, class, or function as missing an import/unresolved: the diff only shows CHANGED lines. A pre-existing import many lines above the changed hunk (or already present at the review base, never touched by this branch) will never appear in the diff text itself. Open the actual file in the sandbox and check its real top-of-file imports/use-statements before making that specific claim — do not infer "missing" purely from its absence in the diff.

TASK: ${t.name}
ACCEPTANCE CRITERIA:
${ac || '(none)'}

${PROJECT_CONTRACT}

DIFF (branch vs ${base}):
\`\`\`diff
${diff}
\`\`\`

Judge: does the change correctly and minimally satisfy the acceptance criteria? Any correctness bug, missing/weak test, or unrelated edit? Output ONLY one JSON object, nothing else:
{"verdict":"pass"|"fail","blocking_issues":["..."],"notes":"one or two sentences"}
Default to "fail" if the diff is empty or does not address the task.`;

export function resolveAdjudicatedVerdict(primaryVerdict, adjudicationVerdict) {
  if (primaryVerdict?.verdict !== 'fail') {
    return { verdict: primaryVerdict, adjudicated: false };
  }
  if (!['pass', 'fail'].includes(adjudicationVerdict?.verdict)) {
    return { verdict: primaryVerdict, adjudicated: false };
  }
  const blockers = adjudicationVerdict.blocking_issues;
  if (!Array.isArray(blockers)) {
    return { verdict: primaryVerdict, adjudicated: false };
  }
  if (adjudicationVerdict.verdict === 'pass' && blockers.length > 0) {
    return { verdict: primaryVerdict, adjudicated: false };
  }
  if (adjudicationVerdict.verdict === 'fail' && blockers.length === 0) {
    return { verdict: primaryVerdict, adjudicated: false };
  }
  return { verdict: adjudicationVerdict, adjudicated: true };
}
export const shouldAdjudicateReview = (reviewer, verdict, parsed, claudeUp) =>
  reviewer === 'codex' && verdict?.verdict === 'fail' && parsed === true && claudeUp === true;

export const reviewAdjudicationPrompt = (t, ac, diff, base, reviewedSha, primaryVerdict) =>
`You are Claude, the FAILURE ADJUDICATOR in a code-review pipeline. Codex rejected the exact
reviewed commit below. Treat every reported blocker as an untrusted hypothesis and fact-check it
against the CURRENT files at the checked-out immutable SHA. Do not edit, commit, or push anything.
Do not invoke network services or paid providers.

Remember: acceptance-criteria text is not repository content. Examples of forbidden/bad values in the AC,
prior review prose, removed diff lines, and values merely named in a blocker do not prove that those
values exist in the current tree. Open the actual file and inspect its current bytes/lines. You may
run focused local read-only checks or tests when useful.

For every blocker you uphold, cite path:line plus the observed current value or focused command
result that reproduces it. If every reported blocker is contradicted by the current tree and the
Codex notes say the remaining work is aligned, return pass. Do not invent cosmetic churn.

TASK: ${t.name}
TASK ID: ${t.id}
REVIEWED SHA: ${reviewedSha}
REVIEW BASE: ${base}

ACCEPTANCE CRITERIA:
${ac || '(none)'}

CODEX NOTES:
${primaryVerdict?.notes || '(none)'}

CODEX BLOCKING ISSUES:
${bullets(primaryVerdict?.blocking_issues)}

DIFF (reviewed SHA vs ${base}):
\`\`\`diff
${diff}
\`\`\`

Output ONLY one JSON object, nothing else:
{"verdict":"pass"|"fail","blocking_issues":["path:line — reproduced current-tree evidence"],"notes":"one or two sentences"}`;

// `rounds` is the task's ACTUAL churn. Never assert "too big or mis-scoped" as a premise when the
// task stalled before exhausting its budget: a task can reach here at round 1 (a no-op round, an
// operational failure), and handing Claude a false premise reliably produces a split
// recommendation for work that never churned at all.
const reScopePrompt = (t, ac, issues, rounds) =>
`You are the PM in a code pipeline. Task "${t.name}" is stalled after ${rounds || 'an unknown number of'} of ${MAX_ROUNDS} allowed review rounds. Do NOT edit code.
${rounds && rounds < MAX_ROUNDS ? `
IMPORTANT: it stalled WITHOUT exhausting its round budget, so churn is NOT established — do not assume it is too big. Consider first that a round may have produced no changes because an earlier round already completed the work (a coder that timed out during wrap-up commits work labelled PARTIAL that is in fact finished). Inspect the task branch before recommending any split; if the work looks complete, say so and recommend review instead of a split.
` : `
It has failed review every allowed round without converging — it is likely too big or mis-scoped.
`}

SANDBOX BLIND SPOT — read before concluding anything is missing: you are in an isolated clone holding ONLY this task's branch and \`${BASE}\`. Every sibling task branch has been removed, and finished predecessor work is pushed to its own branch and NEVER merged into \`${BASE}\` until a human integrates it. So a prerequisite built by another task is invisible here BY CONSTRUCTION. Never conclude that a prerequisite does not exist, was never built, or must be re-specified because you cannot find it in this tree — that inference is unavailable to you. If the task depends on something you cannot see, say the diagnosis is blocked on integration and recommend that, not a split.

ACCEPTANCE CRITERIA:
${ac || '(none)'}

RECURRING REVIEW ISSUES:
${issues || '(see task comments)'}

Diagnose in 2-4 sentences: is this ONE task holding multiple independent concerns (needs a human to split into subtasks), or is it a fixable AC/description contradiction (a scope guard forbidding what an AC item demands, a stale/duplicated requirement, or a missing prerequisite note) that a description rewrite alone resolves — no code split needed?

If, and ONLY if, it is that second case, ALSO output the complete corrected task description as a single fenced block tagged \`clickup-description\`. It must start with the exact first line "${AC_DESCRIPTION_MARKER}" and contain a line that is exactly "${AC_DESCRIPTION_REPLACE_MARKER}" — this text REPLACES the task's current description/AC verbatim (it is applied automatically, not read by a human first), so write the full corrected contract, not a diff or a summary of the change. Keep the task's real scope; fix only the contradiction.

If it genuinely needs a human to split into multiple tasks, do NOT output that fenced block — give your diagnosis and a recommended split (subtask names + dependency order); a human will do the ClickUp surgery.`;

// Claude's re-scope call is read-only over the code (verified — see resolveStalledWithClaude) but
// MAY hand back a corrected description in a fenced ```clickup-description block. Anything not
// shaped exactly like the contract this dispatcher itself writes (see acceptanceCriteriaOf) is
// rejected rather than applied — a malformed or missing marker means Claude judged this a genuine
// split, not a description fix.
export function extractDescriptionFix(out) {
  const m = /```clickup-description\r?\n([\s\S]*?)```/.exec(out || '');
  if (!m) return null;
  const body = m[1].replace(/\r\n?/g, '\n').trim();
  if (!body || body.length > 20_000) return null;
  const lines = body.split('\n');
  if (lines[0].trim() !== AC_DESCRIPTION_MARKER) return null;
  if (!lines.slice(1).some(l => l.trim() === AC_DESCRIPTION_REPLACE_MARKER)) return null;
  return body;
}

// ---------- agent invocation ----------
// Returns { v: verdict-object|null, unavailable }. Never edits (the diff is in the prompt).
async function reviewerRun(who, t, ac, diff, base) {
  const prompt = reviewPrompt(who[0].toUpperCase() + who.slice(1), t, ac, diff, base);
  let result;
  const label = `${who} review ${t.id}`;
  if (who === 'grok') { const pf = writePrompt(prompt); result = await runProc(CMD.grok(pf, 8), { timeout: REVIEW_TIMEOUT_MS, label }); }
  else if (who === 'codex') result = await runProc(CMD.codex(), { input: prompt, timeout: REVIEW_TIMEOUT_MS, label });
  else result = await runProc(CMD.claude(), { input: prompt, timeout: REVIEW_TIMEOUT_MS, label });
  if (result.killFailed) {
    throw new FatalLoopError(`${who} review timed out and its process tree could not be confirmed stopped; refusing reviewer cleanup`, {
      preserveCoding: true, unsafeChild: true,
    });
  }
  const out = result.out;
  const v = extractVerdict(out);
  return { v, unavailable: !v && LIMIT_RE.test(out || '') };
}

// Cheap "is this agent up?" probe: run a trivial generation. Failure or a rate-limit signature = down.
const PROBE_TXT = 'Reply with exactly: OK';

// A quota-exhausted CLI reports when it comes back ("try again at Aug 8th, 2026 12:34 PM"). Parse it
// so a doomed agent isn't re-probed every pass: on 2026-08-07 codex was out of credits for 14h and
// got probed 66 times (~13 min of wall-clock) for 66 identical answers, none of which said why.
// Returns a future epoch-ms, or null when nothing parseable is present.
export function parseQuotaReset(out, nowMs) {
  const m = /try again (?:at|on|in) ([^.\n]+?)(?:\.|$|\n)/i.exec(out || '');
  if (!m) return null;
  const raw = m[1].trim();
  // Relative form first ("try again in 25 minutes") — Date.parse would silently NaN on it.
  const rel = /^(\d+)\s*(second|minute|hour|day)s?$/i.exec(raw);
  let t;
  if (rel) {
    const unit = { second: 1e3, minute: 60e3, hour: 3600e3, day: 86400e3 }[rel[2].toLowerCase()];
    t = nowMs + Number(rel[1]) * unit;
  } else {
    // Absolute form. Strip ordinal suffixes ("Aug 8th" → "Aug 8"), which Date.parse rejects.
    t = Date.parse(raw.replace(/(\d+)(?:st|nd|rd|th)\b/i, '$1'));
  }
  if (!Number.isFinite(t) || t <= nowMs) return null;
  // Never trust a wildly distant reset (bad parse / vendor typo) enough to sideline an agent for
  // weeks — cap the blackout so the loop always re-checks eventually. Capped on BOTH branches: the
  // relative one used to return early and "try again in 999 days" would have benched an agent for years.
  return Math.min(t, nowMs + QUOTA_BLACKOUT_CAP_MS);
}
const QUOTA_BLACKOUT_CAP_MS = num('AGENT_LOOP_QUOTA_BLACKOUT_CAP_H', 24, 1, 168) * 3600_000;
// who → epoch-ms until which it is known-down. In-memory on purpose: a restart re-probing once is
// cheap and correct, and a stale on-disk blackout that outlives a topped-up account is not.
const QUOTA_UNTIL = new Map();

async function probe(who) {
  const until = QUOTA_UNTIL.get(who);
  if (until && Date.now() < until) {
    log(`  probe ${who}: unavailable (quota — skipping probe until ${new Date(until).toISOString()})`);
    return false;
  }
  if (until) QUOTA_UNTIL.delete(who); // reset time passed — probe for real again
  let r;
  // Probes also get a sanitized env (no ClickUp token) AND a neutral cwd outside the primary repo —
  // "is the CLI up?" has no reason to run with a working directory inside the tree it must not touch.
  if (who === 'grok') { const pf = writePrompt(PROBE_TXT); r = await runProc(CMD.grok(pf, 2), { timeout: 60_000, agent: true, cwd: PROBE_CWD }); }
  else if (who === 'codex') r = await runProc(codexProbeCommand(), { input: PROBE_TXT, timeout: 60_000, agent: true, cwd: PROBE_CWD });
  else r = await runProc(CMD.claude(), { input: PROBE_TXT, timeout: 60_000, agent: true, cwd: PROBE_CWD });
  if (r.killFailed) throw new FatalLoopError(`${who} availability probe timed out and its process tree could not be confirmed stopped`, { unsafeChild: true });
  const quota = LIMIT_RE.test(r.out || '');
  const up = r.code === 0 && !quota;
  if (up) { log(`  probe ${who}: available`); return true; }
  // Used to log a bare "unavailable", which is why 66 consecutive failures carried zero diagnosis.
  // The reason is the whole value of the probe: quota-until-tomorrow and a crashing CLI look
  // identical in the log but need completely different operator action.
  const reason = quota ? 'quota/rate-limit' : `exit ${r.code}`;
  const detail = (r.out || '').trim().split('\n').filter(Boolean).pop()?.slice(0, 200) || '(no output)';
  if (quota) {
    const resetAt = parseQuotaReset(r.out, Date.now());
    if (resetAt) {
      QUOTA_UNTIL.set(who, resetAt);
      log(`  probe ${who}: unavailable (quota — back at ${new Date(resetAt).toISOString()}, skipping probes until then): ${detail}`);
      return false;
    }
  }
  log(`  probe ${who}: unavailable (${reason}): ${detail}`);
  return false;
}

// ---------- churn round tracking (durable) ----------
// In-memory only meant a restart wiped the tally and churn could run unbounded across restarts —
// and this loop gets restarted often (kills, crashes, machine sleep). Persist it next to the lock.
const ROUNDS_FILE = process.env.AGENT_LOOP_ROUNDS || `${homedir()}/.agent-loop-rounds.json`;
const loadRounds = () => {
  if (!existsSync(ROUNDS_FILE)) return new Map();
  try { return new Map(Object.entries(JSON.parse(readFileSync(ROUNDS_FILE, 'utf8')))); }
  catch (e) { console.error(`⚠ round tally at ${ROUNDS_FILE} is unreadable (${e.message}) — starting from zero, churn caps restart`); return new Map(); }
};
const ROUNDS = loadRounds();
// tmp+rename so a crash mid-write cannot truncate the file into an unparseable state (which would
// silently reset every churn cap). Failures are LOUD: swallowing them hides an unbounded-churn risk.
const saveRounds = () => {
  const tmp = `${ROUNDS_FILE}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(Object.fromEntries(ROUNDS))); renameSync(tmp, ROUNDS_FILE); }
  catch (e) { log(`⚠ could NOT persist the round tally to ${ROUNDS_FILE} (${e.message}) — churn caps will reset if this process restarts`); }
};
const bumpRounds  = id => { const n = (ROUNDS.get(id) || 0) + 1; ROUNDS.set(id, n); saveRounds(); return n; };
// Report the task's ACTUAL churn, not the cap: a task can reach re-scope at round 1 (e.g. a
// no-op round), and telling Claude "churned 5 rounds" invites a split diagnosis for a task that
// never actually churned.
const roundsOf     = id => ROUNDS.get(id) || 0;
const resetRounds = id => { ROUNDS.delete(id); saveRounds(); };
// Operational failures (worktree/clone open, land prep) use a separate key so they don't confuse review churn.
const bumpOpsFailure = id => bumpRounds(`ops:${id}`);
const resetOpsFailure = id => { ROUNDS.delete(`ops:${id}`); saveRounds(); };

// Persisted reviewer-approved SHAs for tasks parked on `approved` (Claude was down at pass time).
// Without this, the next land used the live branch tip — any intervening commit could skip review.
const APPROVED_SHA_FILE = process.env.AGENT_LOOP_APPROVED_SHA || `${homedir()}/.agent-loop-approved-sha.json`;
const loadApprovedShas = () => {
  if (!existsSync(APPROVED_SHA_FILE)) return new Map();
  try { return new Map(Object.entries(JSON.parse(readFileSync(APPROVED_SHA_FILE, 'utf8')))); }
  catch (e) { console.error(`⚠ approved-sha store unreadable (${e.message}) — parked approvals will require re-review`); return new Map(); }
};
const APPROVED_SHAS = loadApprovedShas();
const saveApprovedShas = () => {
  const tmp = `${APPROVED_SHA_FILE}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(Object.fromEntries(APPROVED_SHAS))); renameSync(tmp, APPROVED_SHA_FILE); }
  catch (e) { log(`⚠ could NOT persist approved SHAs to ${APPROVED_SHA_FILE} (${e.message})`); }
};
// Records span passes: a task approved in one pass usually lands in a later one, so the reviewer's
// identity must be persisted with the SHA or the landing comment cannot name who actually approved.
// Entries were once a bare SHA string; those still read back (with an unknown reviewer) so an
// in-flight approval written by an older run is not silently dropped on upgrade.
const readApprovedEntry = id => {
  const raw = APPROVED_SHAS.get(id);
  if (!raw) return null;
  if (typeof raw === 'string') return { sha: raw, reviewer: null };
  return typeof raw.sha === 'string' ? { sha: raw.sha, reviewer: raw.reviewer || null } : null;
};
const setApprovedSha = (id, sha, reviewer = null) => { APPROVED_SHAS.set(id, { sha, reviewer }); saveApprovedShas(); };
const getApprovedSha = id => readApprovedEntry(id)?.sha || null;
const getApprovedReviewer = id => readApprovedEntry(id)?.reviewer || null;
const clearApprovedSha = id => { APPROVED_SHAS.delete(id); saveApprovedShas(); };
// Single source of truth for how a reviewer is named in comments. "(self)" on Grok because a
// Grok-reviewed branch was usually also Grok-coded.
const reviewerLabel = r => (!r ? null : r === 'grok' ? 'Grok (self)' : r[0].toUpperCase() + r.slice(1));
// An unrecorded reviewer must read as unknown, never as a default name.
const approvalPhrase = r => (reviewerLabel(r) ? `${reviewerLabel(r)} approved` : 'Approved (reviewer not recorded)');

// ---------- working-tree ownership guard ----------
// The dispatcher assumes it OWNS the tree: it runs `reset --hard` before each lane and `add -A`
// after the coder. Both silently destroy/absorb anything a human left there (observed: an
// interactive edit wiped mid-session). Refuse instead. `add -A` then stays safe by construction,
// because a lane only ever starts from a verified-clean tree.
const listUntracked = async () => {
  const r = await git('ls-files --others --exclude-standard');
  if (r.code !== 0) throw new FatalLoopError(`cannot inspect untracked files (git exit ${r.code}: ${r.out.trim().slice(0, 200)})`);
  return new Set(r.out.split(/\r?\n/).map(s => s.trim()).filter(Boolean));
};
// Deliberately REPORTS instead of deleting. An earlier version removed untracked files that
// appeared during a review, but nothing can distinguish reviewer scratch from a file a human
// created in the same window — so deletion risked destroying real work. Reporting means a stray
// file can halt the next lane via treeIsClean(); that is the correct trade (annoying > data loss).
// Full isolation is the only real fix — see the AGENT_LOOP_REPO/worktree note in the header.
async function reportNewUntracked(before) {
  const added = [...(await listUntracked())].filter(f => !before.has(f));
  if (!added.length) return added;
  log(`  ⚠ ${added.length} untracked file(s) appeared during the review — NOT deleted (could be yours):`);
  for (const f of added.slice(0, 20)) log(`      ${f}`);
  log(`      → if this is reviewer scratch, remove it: git -C "${REPO}" clean -fd`);
  return added;
}
// `reset --hard` destroys uncommitted TRACKED edits unrecoverably, so say what is being discarded
// before doing it. The lane-start guard means anything here appeared during the dispatcher's own
// review step, but an audit trail is what makes that claim checkable rather than assumed.
async function logBeforeDiscard() {
  const r = await git('status --porcelain --untracked-files=no');
  if (r.code !== 0) throw new FatalLoopError(`cannot inspect reviewer scratch (git exit ${r.code}: ${r.out.trim().slice(0, 200)})`);
  const s = r.out.trim();
  if (!s) return;
  log(`  discarding ${s.split(/\r?\n/).length} tracked change(s) left by the reviewer:`);
  for (const line of s.split(/\r?\n/).slice(0, 20)) log(`      ${line}`);
}

// Any tool-owned git failure must either restore a clean tree or stop the watcher. Continuing with
// staged/dirty files makes treeIsClean() reject every later lane forever. Untracked files are never
// deleted automatically because a human may have created them while the reviewer was running.
//
// SAFETY: re-check cleanliness of the *primary* tree immediately before any hard reset when
// `requireStillClean` is set — closes the treeIsClean→ClickUp→reset race that wiped concurrent edits.
// After `git add -A`, never call this on staged agent output: use commitOrPreserve() instead
// (hard reset after staging deletes newly added files from the working tree).
async function restoreOwnedTree(why, gitFn = git, { allowUntracked = false, requireStillClean = false } = {}) {
  if (requireStillClean) {
    const pre = await gitFn(`status --porcelain${allowUntracked ? ' --untracked-files=no' : ''}`);
    if (pre.code !== 0) {
      throw new FatalLoopError(`${why}: cannot re-check tree before reset (git exit ${pre.code}: ${pre.out.trim().slice(0, 200)})`);
    }
    if (pre.out.trim()) {
      throw new FatalLoopError(`${why}: tree became dirty before reset — refusing to discard concurrent edits:\n${pre.out.trim().slice(0, 800)}`);
    }
  }
  const reset = await gitFn('reset --hard HEAD -q');
  if (reset.code !== 0) {
    throw new FatalLoopError(`${why}: could not restore tracked files (git reset exit ${reset.code}: ${reset.out.trim().slice(0, 240)})`);
  }
  const status = await gitFn(`status --porcelain${allowUntracked ? ' --untracked-files=no' : ''}`);
  if (status.code !== 0) {
    throw new FatalLoopError(`${why}: could not verify the restored tree (git status exit ${status.code}: ${status.out.trim().slice(0, 240)})`);
  }
  if (status.out.trim()) {
    throw new FatalLoopError(`${why}: the tree is still dirty after reset; stopping for manual recovery:\n${status.out.trim().slice(0, 800)}`);
  }
  return true;
}

// After staging, prefer a recovery commit over hard-reset. Hard-reset of a staged *new* file
// removes it from the working tree (audit reproduction). If commit fails, leave dirty and fatal-stop.
async function commitOrPreserve(gitFn, message, why) {
  const c = await gitFn('commit -F -', { input: message });
  if (c.code === 0) return { committed: true, out: c.out };
  throw new FatalLoopError(
    `${why}: commit failed and staged/uncommitted work was PRESERVED (no hard reset):\n${c.out.trim().slice(0, 600)}`,
  );
}

async function treeIsClean(why) {
  const s = await git('status --porcelain');
  if (s.code !== 0) {
    throw new FatalLoopError(`refusing to ${why}: cannot read git status — ${s.out.trim().slice(0, 200)}`);
  }
  const dirty = s.out.trim();
  if (!dirty) return true;
  log(`🛑 REFUSING to ${why}: working tree is DIRTY and this step would 'reset --hard' / 'add -A' over it:`);
  for (const line of dirty.split(/\r?\n/).slice(0, 20)) log(`      ${line}`);
  log(`      → commit or stash it. To discard: git -C "${REPO}" reset --hard HEAD && git -C "${REPO}" clean -fd`);
  throw new FatalLoopError(`refusing to ${why}: working tree is dirty and needs manual ownership resolution`);
}

// Open a disposable worktree for review; primary worktree is never switched to the task branch.
async function checkoutForReview(t) {   // → { branch, base, wt } or null if the branch is missing
  const branch = await findExistingBranchOf(t);
  if (!branch) {
    await setStatus(t.id, S.blocked);
    await tryComment(t.id, `🟣 **PM** — no local task branch exists → **blocked** instead of retrying forever.`);
    return null;
  }
  const base = (await resolveChainBase(t)).base ?? BASE;
  // The diff base gets referenced by name (`git diff ${base}`) AFTER this worktree is hardened, so
  // it must be materialized as a local branch now, before hardening removes the remote it lives on.
  const wt = await openTaskWorktree(branch, { alsoBranch: base });
  if (!wt.ok) {
    throw new Error(`could not open review worktree for ${branch} (${(wt.err || '').slice(0, 240)})`);
  }
  return { branch, base, wt };
}

// Pure policy for a "fresh" implement (status is not changes-requested).
// Never rewind: if the branch already exists (even at base), refuse. Missing → create via
// `worktree add -b` only (fails if the name races into existence — no `checkout -B`).
export function freshForkPlan({ branchExists, commitsBeyondBase }) {
  const commits = Number(commitsBeyondBase) || 0;
  if (branchExists) return { mode: 'refuse', reason: commits > 0 ? 'existing-commits' : 'branch-exists', commits };
  return { mode: 'create', reason: 'missing', commits: 0 };
}

export function sandboxHistoryPlan({ expectedBranch, currentBranch, startSha, currentSha }) {
  if (!expectedBranch || currentBranch !== expectedBranch) {
    return { mode: 'refuse', reason: currentBranch ? 'branch-changed' : 'detached-head' };
  }
  if (!startSha || !currentSha) return { mode: 'refuse', reason: 'missing-head' };
  return currentSha === startSha
    ? { mode: 'keep', reason: 'unchanged' }
    : { mode: 'normalize', reason: 'head-moved' };
}

async function normalizeSandboxHistory(gitFn, expectedBranch, startSha) {
  if (!/^[0-9a-f]{40,64}$/i.test(String(startSha || ''))) {
    throw new FatalLoopError(`sandbox history guard: invalid recorded start SHA for ${expectedBranch || '(missing branch)'}`);
  }

  const branchResult = await gitFn('symbolic-ref --quiet --short HEAD');
  if (branchResult.code !== 0 && branchResult.code !== 1) {
    throw new FatalLoopError(`sandbox history guard: cannot inspect current branch (git exit ${branchResult.code}: ${branchResult.out.trim().slice(0, 200)})`);
  }
  const currentBranch = branchResult.code === 0 ? branchResult.out.trim() : '';
  const headResult = await gitFn('rev-parse HEAD');
  if (headResult.code !== 0) {
    throw new FatalLoopError(`sandbox history guard: cannot inspect HEAD (git exit ${headResult.code}: ${headResult.out.trim().slice(0, 200)})`);
  }
  const currentSha = headResult.out.trim();
  const plan = sandboxHistoryPlan({ expectedBranch, currentBranch, startSha, currentSha });
  if (plan.mode === 'refuse') {
    throw new FatalLoopError(
      `sandbox history guard: implementer left ${expectedBranch} on ${currentBranch || 'detached HEAD'} (${plan.reason}); preserving sandbox for inspection`,
    );
  }
  if (plan.mode === 'keep') {
    return { normalized: false, from: currentSha, to: startSha };
  }

  // The implementer may have committed, amended, rebased, or reset despite the prompt. This is an
  // isolated disposable clone: move only its branch ref back to the dispatcher-recorded start SHA
  // with --mixed so every working-tree/untracked edit survives, then let the dispatcher create the
  // one canonical FF commit. Review still validates the resulting content.
  const reset = await gitFn(`reset --mixed ${startSha}`);
  if (reset.code !== 0) {
    throw new FatalLoopError(
      `sandbox history guard: could not normalize ${expectedBranch} back to ${startSha.slice(0, 8)} without discarding files (git exit ${reset.code}: ${reset.out.trim().slice(0, 240)}); preserving sandbox`,
    );
  }

  const branchAfter = await gitFn('symbolic-ref --quiet --short HEAD');
  const headAfter = await gitFn('rev-parse HEAD');
  if (branchAfter.code !== 0 || branchAfter.out.trim() !== expectedBranch
      || headAfter.code !== 0 || headAfter.out.trim() !== startSha) {
    throw new FatalLoopError(
      `sandbox history guard: normalization verification failed for ${expectedBranch}; preserving sandbox`,
    );
  }
  return { normalized: true, from: currentSha, to: startSha };
}

// ---------- implement (coder = grok | claude) ----------
// Edits the branch inside a disposable worktree and commits a WIP snapshot. The primary worktree
// is not checked out to the task branch and is never hard-reset by this path.
async function implement(t, coder) {
  const id = t.id, ac = acOf(t);
  const fixing = statusOf(t) === S.changes;
  const existingBranch = await findExistingBranchOf(t);
  const branch = fixing ? existingBranch : branchOf(t);

  // Resolved ONCE for the whole fresh-fork path (refusal message and the fork itself): it costs a
  // ClickUp read per blocker, and asking twice mid-pass could even answer differently.
  let base = BASE;
  if (!fixing) {
    const chain = await resolveChainBase(t);
    if (chain.ambiguous) {
      log(`🛑 REFUSING fresh fork of ${id}: ${chain.ambiguous.length} satisfied blockers still carry unmerged branches (${chain.ambiguous.join(', ')}) — no single fork base holds them all`);
      await setStatus(id, S.blocked);
      await tryComment(id, `🟣 **PM** — refused to fork \`${branch}\`: ${chain.ambiguous.length} predecessors are done but still sit on their own branches (${chain.ambiguous.map(b => `\`${b}\``).join(', ')}), and \`${BASE}\` carries none of their work. Forking from \`${BASE}\` would hand the coder a tree missing every prerequisite → **blocked**. Integrate those branches (into \`${BASE}\`, or into one another so a single branch holds the chain), then return this to **ready**.`);
      return false;
    }
    base = chain.base ?? BASE;
    const plan = freshForkPlan({ branchExists: !!existingBranch, commitsBeyondBase: 0 });
    if (plan.mode === 'refuse') {
      let commits = 0;
      if (existingBranch) {
        const count = await git(`rev-list --count ${base}..${existingBranch}`);
        if (count.code !== 0) {
          throw new Error(`could not inspect commits on ${existingBranch} beyond ${base} (git exit ${count.code}: ${count.out.trim().slice(0, 240)})`);
        }
        commits = Number(count.out.trim()) || 0;
      }
      log(`🛑 REFUSING fresh fork of ${id}: branch \`${existingBranch}\` already exists (${commits} commit(s) beyond \`${base}\`) — never checkout -B`);
      await setStatus(id, commits > 0 ? S.review : S.blocked);
      await tryComment(id, commits > 0
        ? `🟣 **PM** — refused to re-create \`${existingBranch}\` (${commits} commit(s) beyond \`${base}\`) → **in review**. To rework: **changes requested**, or delete/rename the branch and return to **ready**.`
        : `🟣 **PM** — branch \`${existingBranch}\` already exists; refused silent reset → **blocked**. Delete the branch to start fresh, or use **changes requested** to resume.`);
      return false;
    }
  }

  log(`implement ${id} "${t.name}" via ${coder}${fixing ? ' (fixing)' : ''} [isolated clone]`);
  await setStatus(id, S.coding);

  let wt;
  if (fixing) {
    if (!branch) { await setStatus(id, S.blocked); await tryComment(id, `🔵 task branch missing for a fix → **blocked**.`); return false; }
    wt = await openTaskWorktree(branch);
    if (!wt.ok) {
      const rounds = bumpRounds(id);
      await tryComment(id, `🔵 could not open sandbox clone for \`${branch}\` (round ${rounds}/${MAX_ROUNDS}).\n\`\`\`\n${(wt.err || '').slice(-600)}\n\`\`\``);
      if (rounds >= MAX_ROUNDS) await escalate(t, [`sandbox open failed ${MAX_ROUNDS} times for fix branch`], false);
      else await setStatus(id, S.changes);
      return false;
    }
  } else {
    if (base !== BASE) log(`  ${id} chaining onto predecessor branch \`${base}\``);
    // The agent's branch lives in the sandbox; the primary repo gains the real commits via FF import
    // after the commit. publishBranchRef parks a ref at base FIRST so the branch is visible in the
    // IDE while the lane runs, instead of appearing only once the work is already done.
    wt = await openTaskWorktree(branch, { createFrom: base });
    if (!wt.ok) {
      await tryComment(id, `🔵 could not create \`${branch}\` off \`${base}\` in an isolated clone → blocked.\n\`\`\`\n${(wt.err || '').slice(-600)}\n\`\`\``);
      await setStatus(id, S.blocked);
      return false;
    }
    // After the sandbox exists, so a failed lane doesn't leave a ref for work that never started.
    await publishBranchRef(branch, base);
  }

  const gAt = (args, o) => gitAt(wt.dir, args, o);
  // If we must preserve uncommitted/staged work, do NOT force-remove the sandbox (that deletes files).
  let keepWorktree = false;
  try {
    const startBranch = await gAt('symbolic-ref --quiet --short HEAD');
    if (startBranch.code !== 0 || startBranch.out.trim() !== branch) {
      throw new FatalLoopError(
        `implementation ${id}: sandbox opened on ${startBranch.code === 0 ? startBranch.out.trim() : 'detached HEAD'} instead of ${branch}`,
      );
    }
    const sandboxStartSha = await revParseAt(wt.dir, 'HEAD');
    const priorIssues = fixing ? await latestChangesComment(id) : '';
    const prompt = implementPrompt(t, ac, priorIssues);
    let g;
    const label = `${coder} implement ${id}`;
    // Isolation here is defense-in-depth, not an OS jail (see agentChildEnv) — a coder given an
    // absolute/literal path can still reach the primary tree; nothing at the OS level stops it. This
    // cannot PREVENT that, but it DETECTS it immediately instead of finding out later: snapshot the
    // primary's status before/after the coder runs, exactly like reviewAndResolve() already does.
    const primaryBeforeCoder = await git('status --porcelain');
    if (primaryBeforeCoder.code !== 0) throw new FatalLoopError(`cannot snapshot primary tree before implement: ${primaryBeforeCoder.out.slice(0, 200)}`);
    if (coder === 'grok') { const pf = writePrompt(prompt); g = await runProc(CMD.grok(pf), { timeout: IMPLEMENT_TIMEOUT_MS, label, cwd: wt.dir, agent: true }); }
    else g = await runProc(CMD.claudeImplement(), { input: prompt, timeout: IMPLEMENT_TIMEOUT_MS, label, cwd: wt.dir, agent: true });

    if (g.killFailed) {
      keepWorktree = true;
      throw new FatalLoopError(`${coder} timed out and its process tree could not be confirmed stopped; refusing to touch git while it may still be editing (worktree left at ${wt.dir})`, {
        preserveCoding: true, unsafeChild: true,
      });
    }

    const primaryAfterCoder = await git('status --porcelain');
    if (primaryAfterCoder.code !== 0) throw new FatalLoopError(`cannot re-check primary tree after implement: ${primaryAfterCoder.out.slice(0, 200)}`);
    if (primaryAfterCoder.out !== primaryBeforeCoder.out) {
      keepWorktree = true;
      throw new FatalLoopError(
        `implementation ${id}: the PRIMARY working tree changed while ${coder} ran (isolation escape, or a human edited it against the running-loop warning) — refusing to continue; sandbox preserved at ${wt.dir} for inspection:\n${primaryAfterCoder.out.trim().slice(0, 800)}`,
        { unsafeChild: true },
      );
    }

    let normalizedHistory;
    try {
      normalizedHistory = await normalizeSandboxHistory(gAt, branch, sandboxStartSha);
    } catch (error) {
      keepWorktree = true;
      throw error;
    }
    if (normalizedHistory.normalized) {
      log(`  ⚠ ${id} implementer moved sandbox HEAD ${normalizedHistory.from.slice(0, 8)}; restored ${branch} to ${sandboxStartSha.slice(0, 8)} without discarding working files`);
    }

    if (g.code !== 0) {
      const timedOut = g.code === TIMEOUT_CODE;
      let outcome = 'no changes produced';
      const add = await gAt('add -A');
      if (add.code !== 0) {
        // Dirty coder output may still sit unstaged in the worktree — must not force-remove it.
        keepWorktree = true;
        outcome = `could not stage the worktree (\`git add\` failed: ${add.out.trim().slice(0, 200)}); worktree PRESERVED at ${wt.dir}`;
        const rounds = bumpRounds(id);
        await tryComment(id, `🔵 **${coder} FAILED** — exit ${g.code}${timedOut ? ' (timeout)' : ''}. ${outcome} → round ${rounds}/${MAX_ROUNDS}.\n\`\`\`\n${g.out.trim().slice(-1200)}\n\`\`\``);
        log(`  ${id} ${coder} exited ${g.code}${timedOut ? ' (timeout)' : ''} → round ${rounds}/${MAX_ROUNDS}`);
        if (rounds >= MAX_ROUNDS) await escalate(t, [`${coder} failed to complete ${MAX_ROUNDS} times (last exit ${g.code}${timedOut ? ', timeout' : ''})`], false);
        else await setStatus(id, S.changes);
        throw new FatalLoopError(`implementation ${id}: git add failed after coder exit; worktree PRESERVED at ${wt.dir}`);
      }
      const diff = await gAt('diff --cached');
      if (diff.code !== 0) {
        keepWorktree = true;
        outcome = `could not inspect staged work: ${diff.out.trim().slice(0, 200)}; worktree PRESERVED at ${wt.dir}`;
        const rounds = bumpRounds(id);
        await tryComment(id, `🔵 **${coder} FAILED** — exit ${g.code}${timedOut ? ' (timeout)' : ''}. ${outcome} → round ${rounds}/${MAX_ROUNDS}.\n\`\`\`\n${g.out.trim().slice(-1200)}\n\`\`\``);
        if (rounds >= MAX_ROUNDS) await escalate(t, [`${coder} failed to complete ${MAX_ROUNDS} times (last exit ${g.code}${timedOut ? ', timeout' : ''})`], false);
        else await setStatus(id, S.changes);
        throw new FatalLoopError(`implementation ${id}: staged-diff failed after coder exit; worktree PRESERVED at ${wt.dir}`);
      }
      if (diff.out.trim()) {
        try {
          await commitOrPreserve(gAt, `${t.name} [PARTIAL — ${coder} exited ${g.code}${timedOut ? ' (timeout)' : ''}]\n\nClickUp ${id}. Not a finished attempt.\n`, `partial commit for ${id}`);
          await importBranchFromSandbox(wt.dir, branch);
          outcome = 'partial work committed for inspection';
        } catch (e) {
          keepWorktree = true;
          throw new FatalLoopError(`${e.message}\nsandbox PRESERVED at ${wt.dir}`);
        }
      }
      if (timeoutRoute(timedOut, outcome === 'partial work committed for inspection') === S.review) {
        // Deliberately no bumpRounds: our own cap fired, so nothing judged this work. The reviewer's
        // failure path bumps and routes to `changes requested`, which is what bounds the churn.
        await tryComment(id, `🔵 **${coder} timed out** after ${mmss(IMPLEMENT_TIMEOUT_MS)} — ${outcome}. A timeout is not a verdict, so the branch goes to **in review** for a reviewer to judge whether the work is complete; the round tally stays at ${roundsOf(id)}/${MAX_ROUNDS}.\n\`\`\`\n${g.out.trim().slice(-1200)}\n\`\`\``);
        log(`  ${id} ${coder} timed out with work committed → in review (rounds unchanged ${roundsOf(id)}/${MAX_ROUNDS})`);
        await setStatus(id, S.review);
        return false;
      }
      const rounds = bumpRounds(id);
      await tryComment(id, `🔵 **${coder} FAILED** — exit ${g.code}${timedOut ? ' (timed out; process tree killed)' : ''}. ${outcome} → round ${rounds}/${MAX_ROUNDS}.\n\`\`\`\n${g.out.trim().slice(-1200)}\n\`\`\``);
      log(`  ${id} ${coder} exited ${g.code}${timedOut ? ' (timeout)' : ''} → round ${rounds}/${MAX_ROUNDS}`);
      if (rounds >= MAX_ROUNDS) await escalate(t, [`${coder} failed to complete ${MAX_ROUNDS} times (last exit ${g.code}${timedOut ? ', timeout' : ''})`], false);
      else await setStatus(id, S.changes);
      return false;
    }

    const add = await gAt('add -A');
    if (add.code !== 0) {
      keepWorktree = true;
      await setStatus(id, S.blocked);
      await tryComment(id, `🟣 **PM** — \`git add -A\` FAILED in worktree → **blocked** (worktree left at \`${wt.dir}\`).\n\`\`\`\n${add.out.slice(-600)}\n\`\`\``);
      throw new FatalLoopError(`implementation ${id}: git add failed; worktree PRESERVED at ${wt.dir}`);
    }
    const staged = await gAt('diff --cached');
    if (staged.code !== 0) {
      keepWorktree = true;
      await setStatus(id, S.blocked);
      await tryComment(id, `🟣 **PM** — \`git diff --cached\` FAILED; staged work PRESERVED at \`${wt.dir}\` → **blocked**.\n\`\`\`\n${staged.out.slice(-600)}\n\`\`\``);
      throw new FatalLoopError(`implementation ${id}: staged-diff failed; worktree PRESERVED at ${wt.dir}`);
    }
    if (!staged.out.trim()) {
      const base = (await resolveChainBase(t)).base ?? BASE;
      // A failed count must not manufacture a review: fall back to 0 (stall), the conservative side.
      const count = await git(`rev-list --count ${base}..${branch}`);
      const commits = count.code === 0 ? Number(count.out.trim()) || 0 : 0;
      if (zeroChangeRoute(commits) === S.review) {
        await setStatus(id, S.review);
        await tryComment(id, `🟣 **PM** — ${coder} exited 0 with nothing left to change, but \`${branch}\` already carries ${commits} commit(s) beyond \`${base}\` → **in review** (an earlier round finished the work).\n\`\`\`\n${g.out.trim().slice(-1200)}\n\`\`\``);
        log(`  ${id} ${coder} produced no changes; ${commits} commit(s) already on ${branch} → in review`);
        return false;
      }
      const noChange = noChangeOutcome(coder, g.out);
      await setStatus(id, noChange.status);
      await tryComment(id, noChange.comment);
      return false;
    }
    const msg = `${t.name}\n\nImplemented by ${coder} via the agent-loop dispatcher (ClickUp ${id}).\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n`;
    try {
      await commitOrPreserve(gAt, msg, `implementation commit for ${id}`);
      await importBranchFromSandbox(wt.dir, branch);
    } catch (e) {
      keepWorktree = true;
      await setStatus(id, S.blocked);
      await tryComment(id, `🟣 **PM** — commit/import FAILED; sandbox PRESERVED at \`${wt.dir}\` → **blocked**.\n${e.message.slice(0, 600)}`);
      throw new FatalLoopError(`${e.message}\nsandbox PRESERVED at ${wt.dir}`);
    }
    await tryComment(id, `🔵 **${coder} — implemented**${fixing ? ' (fix round)' : ''} (isolated clone)\n\`\`\`\n${g.out.trim().slice(-1200)}\n\`\`\``);
    return true;
  } finally {
    if (wt?.ok && !keepWorktree) await wt.dispose();
    else if (wt?.ok && keepWorktree) log(`  ⚠ sandbox preserved for recovery: ${wt.dir}`);
  }
}

// ---------- review + resolve outcome ----------
// reviewer: 'codex' | 'claude' | 'grok'(self).  onPass: 'commit' | 'approved' | 'review'.
// Codex always overrides onPass to `approved`; Claude verifies/lands that SHA on the next pass.
// escalateWithClaude: on hitting MAX_ROUNDS, ask Claude to diagnose before parking to stalled.
async function reviewAndResolve(t, reviewer, onPass, escalateWithClaude, claudeUp) {
  const id = t.id, ac = acOf(t);
  const co = await checkoutForReview(t); if (!co) return;
  const gAt = (args, o) => gitAt(co.wt.dir, args, o);
  // Never force-remove a worktree while an unconfirmed child may still be using it.
  let keepWorktree = false;
  try {
    const tipBefore = await revParseAt(REPO, co.branch);
    // Three-dot: diff from the MERGE BASE, not from the base branch's current tip. With two-dot,
    // any commit that lands on the base while this task branch is open shows up in the review diff
    // as a deletion BY the branch — the reviewer then fails the task for "reverting" unrelated work
    // it never touched, and the implementer correctly refuses to fix it, so the round is burned.
    const diffResult = await gAt(`diff ${co.base}...`);
    if (diffResult.code !== 0) throw new Error(`could not diff ${co.branch} against ${co.base} (git exit ${diffResult.code}: ${diffResult.out.trim().slice(0, 240)})`);
    const diff = diffResult.out;
    if (!diff.trim()) { await tryComment(id, `🟣 **PM** — empty diff vs \`${co.base}\` → blocked.`); await setStatus(id, S.blocked); return; }

    const who   = reviewerLabel(reviewer);
    const emoji = reviewer === 'codex' ? '🟢' : reviewer === 'grok' ? '🔵' : '🟣';
    log(`review ${id} via ${reviewer} (${diff.split('\n').length} diff lines vs ${co.base}) [worktree]`);

    const primaryBefore = await git('status --porcelain');
    if (primaryBefore.code !== 0) throw new FatalLoopError(`cannot snapshot primary tree before review: ${primaryBefore.out.slice(0, 200)}`);

    const prompt = reviewPrompt(who, t, ac, diff, co.base);
    let result;
    const label = `${reviewer} review ${id}`;
    if (reviewer === 'grok') { const pf = writePrompt(prompt); result = await runProc(CMD.grok(pf, 8), { timeout: REVIEW_TIMEOUT_MS, label, cwd: co.wt.dir, agent: true }); }
    else if (reviewer === 'codex') result = await runProc(CMD.codex(), { input: prompt, timeout: REVIEW_TIMEOUT_MS, label, cwd: co.wt.dir, agent: true });
    else result = await runProc(CMD.claude(), { input: prompt, timeout: REVIEW_TIMEOUT_MS, label, cwd: co.wt.dir, agent: true });
    if (result.killFailed) {
      keepWorktree = true;
      throw new FatalLoopError(`${reviewer} review timed out and its process tree could not be confirmed stopped; sandbox left at ${co.wt.dir}`, {
        preserveCoding: true, unsafeChild: true,
      });
    }

    const tipAfter = await revParseAt(REPO, co.branch);
    if (tipAfter !== tipBefore) {
      throw new FatalLoopError(
        `review ${id}: branch \`${co.branch}\` tip moved during review (${tipBefore.slice(0, 8)} → ${tipAfter.slice(0, 8)}); refusing to push or discard — inspect the ref`,
      );
    }
    const primaryAfter = await git('status --porcelain');
    if (primaryAfter.code !== 0) throw new FatalLoopError(`cannot re-check primary tree after review: ${primaryAfter.out.slice(0, 200)}`);
    if (primaryAfter.out !== primaryBefore.out) {
      throw new FatalLoopError(`review ${id}: primary working tree changed during review — refusing automatic cleanup`);
    }

    const out = result.out;
    const v = extractVerdict(out);
    const unavailable = reviewerUnavailable(v, result.code, out);
    if (unavailable) {
      await tryComment(id, `${emoji} **${who}** reviewer unavailable (crashed/quota/cooldown, exit ${result.code}) — left on **in review** to retry.\n\`\`\`\n${out.trim().slice(-600)}\n\`\`\``);
      await setStatus(id, S.review);
      log(`  ${id} ${reviewer} unavailable (exit ${result.code}) → left in review`);
      return;
    }
    const primaryVerdict = v || { verdict: 'fail', blocking_issues: [`${who} review unparseable`], notes: '' };
    await tryComment(id, `${emoji} **${who} review — ${primaryVerdict.verdict.toUpperCase()}**\n${primaryVerdict.notes || ''}\n${bullets(primaryVerdict.blocking_issues)}`);
    log(`  ${id} ${reviewer}=${primaryVerdict.verdict}`);

    let { verdict, adjudicated } = resolveAdjudicatedVerdict(primaryVerdict, null);
    // A single content reviewer is not authoritative when another already-probed independent
    // reviewer is available. Claude fact-checks only Codex's concrete blockers against this exact
    // immutable SHA; an overturned failure is still merely `approved` and must pass land()'s
    // credential-stripped deterministic verifier before anything is pushed.
    if (shouldAdjudicateReview(reviewer, primaryVerdict, Boolean(v), claudeUp)) {
      log(`  ${id} Claude adjudicating Codex failure at ${tipBefore.slice(0, 8)}`);
      const adjudicationHeadBefore = await revParseAt(co.wt.dir, 'HEAD');
      const adjudicationTreeBefore = await gAt('status --porcelain');
      if (adjudicationHeadBefore !== tipBefore || adjudicationTreeBefore.code !== 0 || adjudicationTreeBefore.out.trim()) {
        throw new FatalLoopError(
          `adjudication ${id}: review sandbox is not the clean reviewed SHA ${tipBefore.slice(0, 8)}; refusing fact-check`,
        );
      }
      const adjudication = await runProc(CMD.claude(), {
        input: reviewAdjudicationPrompt(t, ac, diff, co.base, tipBefore, primaryVerdict),
        timeout: REVIEW_TIMEOUT_MS,
        label: `claude adjudicate ${id}`,
        cwd: co.wt.dir,
        agent: true,
      });
      if (adjudication.killFailed) {
        keepWorktree = true;
        throw new FatalLoopError(`Claude adjudication timed out and its process tree could not be confirmed stopped; sandbox left at ${co.wt.dir}`, {
          preserveCoding: true, unsafeChild: true,
        });
      }
      const adjudicationVerdict = extractVerdict(adjudication.out);
      const adjudicatorUnavailable = reviewerUnavailable(adjudicationVerdict, adjudication.code, adjudication.out);
      if (adjudicatorUnavailable) {
        await tryComment(id, `🟣 **Claude failure adjudication unavailable** (exit ${adjudication.code}) — retaining Codex's original verdict without pretending a second review occurred.\n\`\`\`\n${adjudication.out.trim().slice(-600)}\n\`\`\``);
        log(`  ${id} Claude adjudication unavailable; retaining Codex failure`);
      } else if (!adjudicationVerdict) {
        await tryComment(id, `🟣 **Claude failure adjudication unparseable** — retaining Codex's original verdict.\n\`\`\`\n${adjudication.out.trim().slice(-600)}\n\`\`\``);
        log(`  ${id} Claude adjudication unparseable; retaining Codex failure`);
      } else {
        const resolved = resolveAdjudicatedVerdict(primaryVerdict, adjudicationVerdict);
        if (!resolved.adjudicated) {
          await tryComment(id, `🟣 **Claude failure adjudication malformed** — verdict/blockers disagree, so the original Codex failure is retained.\n\`\`\`\n${adjudication.out.trim().slice(-600)}\n\`\`\``);
          log(`  ${id} Claude adjudication malformed; retaining Codex failure`);
        } else {
          ({ verdict, adjudicated } = resolved);
          await tryComment(id, `🟣 **Claude failure adjudication — ${verdict.verdict.toUpperCase()}** at \`${tipBefore.slice(0, 8)}\`\n${verdict.notes || ''}\n${bullets(verdict.blocking_issues)}`);
          log(`  ${id} Claude adjudication=${verdict.verdict}`);
        }
      }

      const adjudicationHeadAfter = await revParseAt(co.wt.dir, 'HEAD');
      const adjudicationTreeAfter = await gAt('status --porcelain');
      if (
        adjudicationHeadAfter !== adjudicationHeadBefore
        || adjudicationTreeAfter.code !== 0
        || adjudicationTreeAfter.out !== adjudicationTreeBefore.out
      ) {
        keepWorktree = true;
        throw new FatalLoopError(
          `adjudication ${id}: Claude changed the read-only review sandbox; refusing verdict and preserving ${co.wt.dir}`,
        );
      }
      const tipAfterAdjudication = await revParseAt(REPO, co.branch);
      if (tipAfterAdjudication !== tipBefore) {
        throw new FatalLoopError(
          `adjudication ${id}: branch \`${co.branch}\` tip moved (${tipBefore.slice(0, 8)} → ${tipAfterAdjudication.slice(0, 8)}); refusing approval`,
        );
      }
      const primaryAfterAdjudication = await git('status --porcelain');
      if (primaryAfterAdjudication.code !== 0) throw new FatalLoopError(`cannot re-check primary tree after adjudication: ${primaryAfterAdjudication.out.slice(0, 200)}`);
      if (primaryAfterAdjudication.out !== primaryBefore.out) {
        throw new FatalLoopError(`adjudication ${id}: primary working tree changed — refusing automatic cleanup`);
      }
    }

    if (verdict.verdict === 'pass') {
      const passAction = reviewPassAction(reviewer, onPass);
      if (passAction === 'approved') {
        setApprovedSha(id, tipBefore, reviewer);
        await setStatus(id, S.approved);
        const approvalSource = adjudicated
          ? 'Claude adjudication disproved Codex blockers'
          : `${who} approved`;
        await tryComment(id, `🟢 ${approvalSource} at \`${tipBefore.slice(0, 8)}\` → **approved** for deterministic verification/commit on the next round. Reviewed SHA persisted; dependent tasks are now unblocked.`);
        return S.approved;
      }
      if (passAction === 'commit') {
        // Dispose the review sandbox BEFORE land so verify can open a fresh detached clone at this SHA.
        const reviewedSha = tipBefore;
        setApprovedSha(id, reviewedSha, reviewer); // durable even if land is deferred mid-push
        await co.wt.dispose();
        co.wt = null;
        return land(t, { branch: co.branch, reviewedSha, reviewer }, escalateWithClaude && claudeUp);
      }
      await tryComment(id, `${emoji} ${who} approved; awaiting Codex before commit → parked on **in review**.`); return setStatus(id, S.review);
    }

    const rounds = bumpRounds(id);
    if (rounds >= MAX_ROUNDS) return escalate(t, verdict.blocking_issues, escalateWithClaude && claudeUp);
    await tryComment(id, `🟣 **PM** — review failed (round ${rounds}/${MAX_ROUNDS}) → **changes requested**:\n${bullets(verdict.blocking_issues)}`);
    await setStatus(id, S.changes);
  } finally {
    if (co.wt?.ok && !keepWorktree) await co.wt.dispose();
    else if (co.wt?.ok && keepWorktree) log(`  ⚠ review worktree preserved for recovery: ${co.wt.dir}`);
  }
}

// Copy each configured dir from the PRIMARY repo into the verify sandbox, so VERIFY reuses
// already-installed dependencies instead of installing from scratch. Best-effort: a source dir that
// doesn't exist (e.g. never installed, or a repo that doesn't need this) is skipped, not fatal — an
// absent vendor/node_modules just means VERIFY fails the same way it always would without this.
function seedVerifyDirs(destDir) {
  for (const rel of VERIFY_SEED_DIRS) {
    const src = join(REPO, rel);
    if (!existsSync(src)) { log(`  ⚠ verify seed skipped: ${rel} does not exist in ${REPO}`); continue; }
    cpSync(src, join(destDir, rel), { recursive: true });
  }
}

// ---------- persistent verify sandbox (reused across runs, NOT a fresh clone every time) ----------
// Unlike coder/reviewer sandboxes, VERIFY never runs an AI agent — it runs a fixed, non-agentic shell
// command (the project's own test/build command), which has no reason to touch git refs and needs no
// push credentials, so the throwaway-clone isolation model those sandboxes need doesn't apply here.
// Reusing ONE sandbox and just checking out the new commit is what makes the one-time seed (above)
// pay off forever: `git checkout`/`clean -fd` only ever touch TRACKED files, so gitignored deps
// (vendor/, .env, a sqlite db) seeded once survive every future checkout untouched. Measured: a cold
// clone+install ran ~6 minutes; a checkout into an already-seeded sandbox is seconds.
const VERIFY_SANDBOX_DIR = process.env.AGENT_LOOP_VERIFY_SANDBOX || join(homedir(), '.agent-loop-verify-sandbox');
async function isUsableGitDir(dir) {
  if (!existsSync(dir)) return false;
  return (await gitAt(dir, 'rev-parse --git-dir')).code === 0;
}
async function createVerifySandbox() {
  rmSync(VERIFY_SANDBOX_DIR, { recursive: true, force: true });
  const clone = await runProc(
    `git -c credential.interactive=never clone --local --no-hardlinks "${REPO}" "${VERIFY_SANDBOX_DIR}"`,
    { timeout: Math.max(GIT_TIMEOUT, 600_000), label: 'clone verify sandbox' },
  );
  if (clone.code !== 0) throw new Error(`could not create verify sandbox: ${clone.out.trim().slice(0, 300)}`);
  if (VERIFY_SEED_DIRS.length) {
    log(`  verify sandbox: seeding [${VERIFY_SEED_DIRS.join(', ')}] (one-time setup)`);
    seedVerifyDirs(VERIFY_SANDBOX_DIR);
  }
}
// Checks out reviewedSha into the persistent sandbox (creating it fresh on first use), self-healing
// by wiping and recreating from scratch once if anything about the reuse path fails.
async function openVerifySandbox(reviewedSha) {
  const attempt = async () => {
    if (!(await isUsableGitDir(VERIFY_SANDBOX_DIR))) await createVerifySandbox();
    const fetch = await gitAt(VERIFY_SANDBOX_DIR, `fetch --quiet "${REPO}" ${reviewedSha}`);
    if (fetch.code !== 0) throw new Error(`verify sandbox fetch failed: ${fetch.out.trim().slice(0, 300)}`);
    const checkout = await gitAt(VERIFY_SANDBOX_DIR, 'checkout --quiet --detach FETCH_HEAD');
    if (checkout.code !== 0) throw new Error(`verify sandbox checkout failed: ${checkout.out.trim().slice(0, 300)}`);
    // Removes stray untracked files a PREVIOUS verify run left behind (e.g. build/cache output not
    // gitignored). Never touches ignored files, so the seeded deps are untouched.
    const clean = await gitAt(VERIFY_SANDBOX_DIR, 'clean -fd');
    if (clean.code !== 0) throw new Error(`verify sandbox clean failed: ${clean.out.trim().slice(0, 300)}`);
  };
  try {
    await attempt();
  } catch (e) {
    log(`  ⚠ verify sandbox unusable (${e.message.slice(0, 200)}) — recreating from scratch`);
    try {
      rmSync(VERIFY_SANDBOX_DIR, { recursive: true, force: true });
      await attempt();
    } catch (e2) {
      return { ok: false, dir: null, err: e2.message };
    }
  }
  return { ok: true, dir: VERIFY_SANDBOX_DIR };
}

// ---------- land (Commit/Push) — only ever reached after a Codex pass ----------
// Always push the exact reviewed SHA (not a mutable branch tip that may have moved since review).
async function land(t, { branch, reviewedSha, reviewer = null }, escalateOnCap = false) {
  const id = t.id;
  if (!branch || !reviewedSha) throw new Error(`land(${id}): branch and reviewedSha are required`);
  // Never assert "Codex approved" — Codex-down landings are reviewed by Claude, and a commit record
  // naming a reviewer that never ran turns the board's audit trail into a false claim.
  const approvedBy = approvalPhrase(reviewer);

  const tipNow = await revParseAt(REPO, branch);
  if (tipNow !== reviewedSha) {
    throw new FatalLoopError(
      `land ${id}: \`${branch}\` tip ${tipNow.slice(0, 8)} ≠ reviewed ${reviewedSha.slice(0, 8)}; refusing to push unreviewed commits`,
    );
  }

  if (VERIFY) {
    const t0 = Date.now();
    const vwt = await openVerifySandbox(reviewedSha);
    if (!vwt.ok) throw new Error(`could not open verify sandbox at ${reviewedSha.slice(0, 8)}: ${(vwt.err || '').slice(0, 200)}`);
    log(`  ${id} verify: ${VERIFY} @ ${reviewedSha.slice(0, 8)} (persistent sandbox, checkout in ${mmss(Date.now() - t0)})`);
    // No dispose(): this sandbox is intentionally persistent (reused by the next verify call), never
    // a throwaway clone — see openVerifySandbox. A timed-out kill-failure just logs, nothing to keep.
    const v = await runProc(VERIFY, { timeout: VERIFY_TIMEOUT_MS, label: `verify ${id}`, cwd: vwt.dir, agent: true, stripProviderKeys: true });
    if (v.killFailed) {
      throw new FatalLoopError(`verification for ${id} timed out and its process tree could not be confirmed stopped; sandbox left at ${vwt.dir}`, {
        unsafeChild: true,
      });
    }
    const tipAfterVerify = await revParseAt(REPO, branch);
    if (tipAfterVerify !== reviewedSha) {
      throw new FatalLoopError(`verify mutated ${branch} tip (${reviewedSha.slice(0, 8)} → ${tipAfterVerify.slice(0, 8)}); refusing push`);
    }
    if (v.code !== 0) {
      const rounds = bumpRounds(id);
      await tryComment(id, `🟣 **PM** — verify FAILED (\`${VERIFY}\`) → changes requested (round ${rounds}/${MAX_ROUNDS}).\n\`\`\`\n${v.out.slice(-800)}\n\`\`\``);
      log(`  ${id} verify FAILED (round ${rounds}/${MAX_ROUNDS})`);
      if (rounds >= MAX_ROUNDS) {
        await escalate(t, [`verify keeps failing (\`${VERIFY}\`) on a diff the reviewer approves — reviewer and suite disagree`], escalateOnCap);
        return false;
      }
      await setStatus(id, S.changes);
      return false;
    }
  }

  // Re-check tip immediately before push, then push the exact SHA (not the branch name alone).
  const tipBeforePush = await revParseAt(REPO, branch);
  if (tipBeforePush !== reviewedSha) {
    throw new FatalLoopError(
      `land ${id}: \`${branch}\` moved before push (${reviewedSha.slice(0, 8)} → ${tipBeforePush.slice(0, 8)}); refusing`,
    );
  }
  // Push only from the dispatcher process (has credentials). Agents never inherit them.
  const push = await git(`push -u origin ${reviewedSha}:refs/heads/${branch}`);
  const sha = reviewedSha.slice(0, 7);
  if (push.code !== 0) {
    const rounds = bumpRounds(id);
    setApprovedSha(id, reviewedSha); // keep the reviewed pin for retry
    await tryComment(id, `🟣 **PM** — ${approvedBy}${VERIFY ? ' + verify green' : ''} and \`${sha}\` is committed on \`${branch}\`, but **push FAILED** (round ${rounds}/${MAX_ROUNDS}). Reviewed SHA kept.\n\`\`\`\n${push.out.slice(-600)}\n\`\`\``);
    log(`  ${id} push FAILED (${sha} local only) → round ${rounds}/${MAX_ROUNDS}`);
    if (rounds >= MAX_ROUNDS) {
      await tryComment(id, `🛑 **PM** — push failed ${MAX_ROUNDS} times with commits still local on \`${branch}\` (\`${sha}\`) → **blocked** for a human.`);
      await setStatus(id, S.blocked);
      return false;
    }
    await setStatus(id, S.approved);
    return false;
  }
  clearApprovedSha(id);
  resetOpsFailure(id);
  await tryComment(id, `🟣 **PM** — ${approvedBy}${VERIFY ? ' + verify green' : ''}. \`${sha}\` on \`${branch}\` (pushed). → **committed**. Deploy is human-gated.`);
  await setStatus(id, S.committed);
  resetRounds(id);
  log(`review ${id} committed (${sha}, pushed)`);
  return true;
}

// ---------- Claude re-scope: diagnose churn/stall, auto-repair when it's an AC fix ----------
// Returns true when Claude's diagnosis was a fixable AC/description contradiction and this
// dispatcher (the only thing holding the ClickUp token) applied the fix and returned the task to
// `ready` — the caller must NOT also park it on `stalled`. Returns false when Claude judged it a
// genuine multi-concern split (still needs a human) or the sandbox/diagnosis itself was unusable;
// the caller falls back to parking on `stalled` as before. A FatalLoopError (sandbox escape,
// unkillable timeout) propagates uncaught, exactly as it did before this was split out of escalate().
async function resolveStalledWithClaude(t, issuesText) {
  const id = t.id;
  log(`  ${id} Claude re-scope diagnosis`);
  // Isolated detached clone + sanitized env — never inherit CLICKUP_TOKEN or run on the primary tree.
  // Diagnose the exact task branch. Falling back to primary HEAD is unsafe: task/predecessor-only
  // files then look absent and Claude can "repair" the contract using the wrong repository state.
  let inspection;
  try {
    inspection = await resolveRescopeInspection(t);
  } catch (error) {
    log(`  ⚠ cannot resolve task branch for re-scope (${error.message.slice(0, 200)}); refusing diagnosis`);
    return false;
  }
  if (inspection.mode !== 'inspect') {
    log(`  ⚠ ${inspection.reason}; refusing Claude re-scope instead of falling back to primary HEAD`);
    return false;
  }
  log(`  ${id} re-scope inspecting \`${inspection.branch}\` at ${inspection.sha.slice(0, 8)}`);
  const sb = await openDetachedWorktree(inspection.sha);
  if (!sb.ok) {
    log(`  ⚠ re-scope sandbox unavailable (${(sb.err || '').slice(0, 200)}); skipping Claude diagnosis`);
    return false;
  }
  let keepSandbox = false;
  try {
    // Same defense-in-depth detection as implement(): the prompt says "do NOT edit code" but
    // that is not enforced by anything below the OS, so verify the primary tree is untouched.
    const primaryBeforeRescope = await git('status --porcelain');
    if (primaryBeforeRescope.code !== 0) throw new FatalLoopError(`cannot snapshot primary tree before re-scope: ${primaryBeforeRescope.out.slice(0, 200)}`);
    const o = await runProc(CMD.claudeRescope(), {
      input: reScopePrompt(t, acOf(t), issuesText, roundsOf(id)),
      timeout: REVIEW_TIMEOUT_MS,
      label: `claude re-scope ${id}`,
      cwd: sb.dir,
      agent: true,
    });
    if (o.killFailed) {
      keepSandbox = true;
      throw new FatalLoopError(`Claude re-scope timed out and its process tree could not be confirmed stopped; sandbox left at ${sb.dir}`, {
        unsafeChild: true,
      });
    }
    const primaryAfterRescope = await git('status --porcelain');
    if (primaryAfterRescope.code !== 0) throw new FatalLoopError(`cannot re-check primary tree after re-scope: ${primaryAfterRescope.out.slice(0, 200)}`);
    if (primaryAfterRescope.out !== primaryBeforeRescope.out) {
      keepSandbox = true;
      throw new FatalLoopError(
        `re-scope ${id}: the PRIMARY working tree changed during a read-only diagnosis step — refusing to continue; sandbox preserved at ${sb.dir}:\n${primaryAfterRescope.out.trim().slice(0, 800)}`,
        { unsafeChild: true },
      );
    }
    const diagnosis = o.out.trim();
    const fix = extractDescriptionFix(o.out);
    if (fix) {
      await setDescription(id, fix);
      await tryComment(id, `🟣 **Claude — AC contradiction auto-repaired** (churned ${roundsOf(id)}/${MAX_ROUNDS} rounds):\n${diagnosis.slice(0, 1200)}\n\nDescription replaced with the corrected contract above → **ready** for a clean Agent Loop attempt.`);
      await setStatus(id, S.ready);
      resetRounds(id);
      return true;
    }
    if (diagnosis) await tryComment(id, `🟣 **Claude — re-scope needed** (churned ${roundsOf(id)}/${MAX_ROUNDS} rounds):\n${diagnosis.slice(-1500)}`);
    return false;
  } finally {
    if (!keepSandbox) await sb.dispose();
    else log(`  ⚠ re-scope sandbox preserved for recovery: ${sb.dir}`);
  }
}

// ---------- escalate churn → auto-repair via Claude, else stalled for a human ----------
async function escalate(t, issues, withClaude) {
  const id = t.id;
  if (withClaude && await resolveStalledWithClaude(t, bullets(issues))) return;
  await tryComment(id, `🛑 **PM** — hit ${MAX_ROUNDS} review rounds without converging → **stalled** for a human to split/re-scope.`);
  await setStatus(id, S.stalled);
  resetRounds(id);
}

// ---------- coding lane: implement then review + resolve ----------
async function runLane(t, { coder, reviewer, onPass, escalateWithClaude, claudeUp }) {
  try {
    if (!(await implement(t, coder))) return;              // blocked; nothing to review
    await reviewAndResolve(t, reviewer, onPass, escalateWithClaude, claudeUp);
  } catch (e) {
    // Any throw after the `coding` flip (ClickUp hiccup, git failure, killed child) used to bubble
    // straight to the watch-loop catch, leaving the task on `coding` — a status nothing else in the
    // queue ever looks at. It and everything chained behind it were then invisible until a RESTART.
    log(`✖ lane ${t.id} aborted: ${e.message}`);
    if (!e.preserveCoding) {
      try {
        const cur = await getTask(t.id);
        if (statusOf(cur) === S.coding) await unstickCoding(t, `Lane aborted mid-flight (\`${e.message}\`)`);
      } catch (e2) { log(`  ✖ could not un-stick ${t.id} from 'coding': ${e2.message} (next pass will recover it)`); }
    } else {
      log(`  ⚠ ${t.id} intentionally remains on 'coding': an unconfirmed child may still be editing`);
    }
    if (e instanceof FatalLoopError) throw e;
  }
}

// ---------- selectors ----------
// ClickUp's subtasks=true leaks an off-status parent into a filtered query — re-check own status.
const filterStatus = (tasks, s) => (tasks || []).filter(t => statusOf(t) === s && !pickupRefusalReason(t));
// A task payload does not carry its parent's status, so this costs one extra read — spent only on
// candidates that already passed the cheap checks. An unreadable parent refuses for this pass
// rather than guessing: the same fail-closed choice depsSatisfied() makes on a blocker it cannot
// read, and the next pass retries in 60s.
// Both async eligibility checks, in cost order. `parentCache` dedupes the parent read across a queue
// of siblings — 14 children of one held epic cost one read, not fourteen.
async function asyncPickupRefusal(t, parentCache = new Map()) {
  const parentId = t.parent || t.top_level_parent;
  if (parentId) {
    if (!parentCache.has(parentId)) parentCache.set(parentId, await getTask(parentId).catch(() => null));
    const parent = parentCache.get(parentId);
    if (!parent) return `parent ${parentId} could not be read — refusing this pass rather than guessing`;
    const held = parentRefusalReason(parent);
    if (held) return held;                                  // held siblings never pay for the read below
  }
  // Structural tracker check. A TRACKER ONLY marker in the Acceptance Criteria is the DECLARED guard,
  // but it is only as good as whoever remembered to type it — and on a ClickUp plan that has spent its
  // custom-field usages it cannot even be added to an existing task (HTTP 400 FIELD_033), which is
  // exactly the state this board is in. Having subtasks is not a marker anyone has to maintain: a
  // parent tracks work, it is not the work. The Admin/Guide epic (21 subtasks, empty AC) was coded as
  // an ordinary task the moment it left the planning column, produced nothing, and stalled the loop.
  const self = await getTaskWithSubtasks(t.id).catch(() => null);
  if (!self) return `could not confirm whether ${t.id} has subtasks — refusing this pass rather than guessing`;
  return containerRefusalReason(self);
}
// Only ever ONE task is coded per pass, so resolving the whole queue was pure waste: ClickUp
// returns newest-first, meaning a sequential chain's HEAD was checked LAST and every pass spent
// ~30 getTask calls (~90s) re-proving what it already knew. Walk oldest-first (= dependency order)
// and stop at the first eligible task: 1-2 calls instead of 30.
async function implementQueue() {
  const parentCache = new Map();            // one pass, one read per distinct parent
  const cr = filterStatus((await tasksByStatus(S.changes)).tasks, S.changes);
  for (const t of cr) {                     // resume interrupted work before starting anything new
    const held = await asyncPickupRefusal(t, parentCache);
    if (held) { log(`  ⏸ ${t.id} held: ${held}`); continue; }
    return [t];
  }
  const rd = filterStatus((await tasksByStatus(S.ready)).tasks, S.ready).reverse();
  let blocked = 0, heldByParent = 0;
  for (const t of rd) {
    const held = await asyncPickupRefusal(t, parentCache);
    if (held) { log(`  ⏸ ${t.id} held: ${held}`); heldByParent++; continue; }
    if (await depsSatisfied(t)) {
      if (blocked + heldByParent) log(`  (skipped ${blocked + heldByParent} newer ready task(s) ahead of it)`);
      return [t];
    }
    blocked++;
  }
  // Held and blocked are different conditions and used to be reported as one, which read as
  // "waiting on predecessors" for a chain that was actually parked by its parent.
  if (blocked || heldByParent) {
    const parts = [];
    if (blocked) parts.push(`${blocked} blocked by unfinished predecessors`);
    if (heldByParent) parts.push(`${heldByParent} held by a parent in the planning column`);
    log(`  ⏸ no ready task is eligible: ${parts.join(', ')}`);
  }
  return [];
}

// A task left at 'coding' only exists while implement() for it is running in THIS process
// (the loop is single-instance and sequential — see acquireLock). Finding one at process start
// means a prior run died mid-implement (crash, sleep, kill) before committing or setting a
// terminal status. Nothing else in the queue ever looks at 'coding', so without this the task
// — and everything chained behind it via "Blocked By" — is stuck invisible forever.
// Does this task's branch already carry work that a re-fork would destroy?
async function branchCommitsBeyondBase(t) {
  const branch = await findExistingBranchOf(t);
  if (!branch) return null;
  const base = (await resolveChainBase(t)).base ?? BASE;
  const r = await git(`rev-list --count ${base}..${branch}`);
  if (r.code !== 0) throw new Error(`could not inspect commits on ${branch} beyond ${base} (git exit ${r.code}: ${r.out.trim().slice(0, 240)})`);
  return { branch, base, commits: Number(r.out.trim()) || 0 };
}

// Getting a task OFF `coding` safely. Two hard-won rules:
//  1. Set the status FIRST, comment after (best-effort). The old order commented first, so a ClickUp
//     comment outage aborted before the status change — and since recovery is the first thing every
//     pass does, that wedged the ENTIRE loop on the same task forever.
//  2. Do not blindly reset to `ready`. The coder may have finished and COMMITTED before whatever
//     failed. A naive re-fork used to run `checkout -B <branch> <base>` and drop that commit;
//     implement() now refuses -B when commits exist (→ in review), and recovery mirrors that:
//     anything with commits goes to `in review`, empty branches back to `ready`.
async function unstickCoding(t, why) {
  // An inspection error is not evidence of "no work". Leave the task on coding and retry next pass;
  // treating a transient ClickUp/git failure as an empty branch can re-fork and destroy a commit.
  const info = await branchCommitsBeyondBase(t);
  const hasWork = !!info && info.commits > 0;
  const target = hasWork ? S.review : S.ready;
  await setStatus(t.id, target);
  log(`  ⚠ ${t.id} unstuck from 'coding' → ${target}${info ? ` (${info.commits} commit(s) on ${info.branch})` : ' (no branch/commits found)'}`);
  await tryComment(t.id, hasWork
    ? `⚠️ ${why}. Its branch \`${info.branch}\` already carries **${info.commits} commit(s)**, so it goes to **in review** instead of being re-forked — a re-fork would reset the branch to \`${info.base}\` and destroy that work.`
    : `⚠️ ${why}. No commits on its branch, so it is reset to **ready** to retry.`);
}

async function recoverOrphanedCoding() {
  const stuck = filterStatus((await tasksByStatus(S.coding)).tasks, S.coding);
  for (const t of stuck) {
    // per-task guard: one unrecoverable task must not wedge the pass (recovery runs first, every pass)
    try {
      await unstickCoding(t, 'A previous dispatcher run died while this task was mid-implement');
      resetOpsFailure(t.id);
    } catch (e) {
      // A recovery failure used to retry forever with no cap: a persistent fault (bad token scope,
      // a task ClickUp keeps rejecting) could keep ONE task on `coding` — and everything chained
      // behind it — invisible for good. Reuse the existing ops-failure counter: after MAX_ROUNDS
      // failed recovery attempts, force it to `blocked` so the rest of the queue can proceed.
      const n = bumpOpsFailure(t.id);
      log(`  ✖ could not recover ${t.id} from 'coding' (ops ${n}/${MAX_ROUNDS}): ${e.message}${n < MAX_ROUNDS ? ' — will retry next pass' : ''}`);
      if (n >= MAX_ROUNDS) {
        try {
          await setStatus(t.id, S.blocked);
          await tryComment(t.id, `🛑 **PM** — could not recover this task out of \`coding\` after ${MAX_ROUNDS} attempt(s) (last error: ${e.message.slice(0, 300)}) → **blocked** for manual inspection.`);
          resetOpsFailure(t.id);
        } catch (e2) {
          log(`  ✖ also could not force ${t.id} to blocked: ${e2.message} — will keep trying next pass`);
        }
      }
    }
  }
}

// ---------- Safe Stop (cooperative) ----------
// Closing the terminal is a HARD kill: it can cut a coder off mid-edit, leave the task on `coding`
// and the branch half-written. Safe Stop instead drops a flag file; the loop finishes the round it
// is already in, writes a handover report, and exits cleanly with the lock released — so a human can
// grab the tree for something urgent and restart later without losing work.
const STOP_FILE   = process.env.AGENT_LOOP_STOP || `${homedir()}/.agent-loop.stop`;
const REPORT_FILE = process.env.AGENT_LOOP_STOP_REPORT || `${homedir()}/.agent-loop-stop-report.md`;
const stopRequested = () => existsSync(STOP_FILE);
const canStartNewWork = (stopped = stopRequested) => !stopped();
const clearStop = () => { try { unlinkSync(STOP_FILE); } catch {} };

async function writeStopReport(when) {
  const L = [`# Agent Loop — Safe Stop handover`, ``,
    `- stopped at: ${new Date().toISOString()}`,
    `- stopped: ${when}`,
    `- flag: \`${STOP_FILE}\` (cleared, so the next start runs normally)`, ``];
  try {
    const branchResult = await git('rev-parse --abbrev-ref HEAD');
    const statusResult = await git('status --porcelain');
    if (branchResult.code !== 0 || statusResult.code !== 0) throw new Error(`git state query failed (branch=${branchResult.code}, status=${statusResult.code})`);
    const branch = branchResult.out.trim();
    const dirty = statusResult.out.trim();
    L.push(`## Working tree (\`${REPO}\`)`, ``, `- branch: \`${branch}\``,
      dirty ? `- **DIRTY** — a lane refuses to start until this is resolved:\n\n\`\`\`\n${dirty}\n\`\`\`` : `- clean ✅`, ``);
  } catch (e) { L.push(`## Working tree`, ``, `- could not read git state: ${e.message}`, ``); }
  L.push(`## Board`, ``);
  for (const s of [S.coding, S.changes, S.review, S.approved, S.ready, S.stalled]) {
    try {
      const own = filterStatus((await tasksByStatus(s)).tasks, s);
      L.push(`- **${s}**: ${own.length}${own.length ? ` — ${own.slice(0, 5).map(t => t.name).join(' · ')}` : ''}`);
    } catch (e) { L.push(`- **${s}**: query failed (${e.message})`); }
  }
  const tally = [...ROUNDS.entries()];
  L.push(``, `## Churn tally (durable — \`${ROUNDS_FILE}\`)`, ``,
    tally.length ? tally.map(([k, v]) => `- ${k}: ${v}/${MAX_ROUNDS} rounds`).join('\n') : `- (empty)`);
  L.push(``, `## To resume`, ``,
    `1. Finish your urgent work and leave the tree **clean** (commit/stash it) — a lane refuses to start on a dirty tree.`,
    `2. Press the Agent Loop button again; it re-materialises the dispatcher from \`main\`.`,
    `3. Anything sitting on \`coding\` is recovered automatically: branches with commits go to \`in review\`; branches without commits go to \`ready\`.`, ``);
  const body = L.join('\n');
  try { writeFileSync(REPORT_FILE, body); log(`  handover report → ${REPORT_FILE}`); }
  catch (e) { log(`  ⚠ could not write ${REPORT_FILE} (${e.message}); report follows:\n${body}`); }
}

async function stopSafely(when, { consistent = true } = {}) {
  log(`🛑 SAFE STOP — stopping ${when}. Nothing was interrupted mid-flight.`);
  await writeStopReport(when);
  clearStop();
  log(consistent
    ? `🛑 Safe Stop complete: tree and board are consistent. The tree is yours; restart the button when done.`
    : `🛑 Safety stop complete: inspect the handover report and resolve the recorded tree/task state before restarting.`);
}

function writeUnsafeStopReport(reason) {
  const body = [
    `# Agent Loop — UNSAFE child stop`,
    ``,
    `- stopped at: ${new Date().toISOString()}`,
    `- reason: ${reason}`,
    ``,
    `The dispatcher could not confirm that a timed-out subprocess was terminated.`,
    `It deliberately did not reset, stage, commit, switch branches, or change the task from \`coding\`.`,
    `Check running agent/node processes and the working tree before restarting.`,
    ``,
  ].join('\n');
  try { writeFileSync(REPORT_FILE, body); log(`  unsafe-stop report → ${REPORT_FILE}`); }
  catch (e) { log(`  ⚠ could not write ${REPORT_FILE} (${e.message}); report follows:\n${body}`); }
}

async function handleFatalStop(e) {
  log(`🛑 FATAL SAFETY STOP — ${e.message}`);
  if (e.unsafeChild) {
    // Fence: keep lock, write durable marker, do not run git/ClickUp while a child may live.
    await markUnsafeChild(e.message);
    writeUnsafeStopReport(e.message);
    try { await Promise.all([...ACTIVE_CHILDREN].map(pid => killTree(pid))); } catch {}
    clearStop();
  } else {
    await stopSafely(`after a fatal safety condition: ${e.message}`, { consistent: false });
  }
  process.exitCode = 1;
}

// Sleep in slices so a Safe Stop pressed during the idle window is noticed in ~3s, not up to POLL.
async function sleepUntilNextPass(seconds) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    if (stopRequested()) return true;
    await sleep(Math.min(3000, Math.max(0, end - Date.now())));
  }
  return stopRequested();
}

// ---------- one universal pass ----------
// claudeUp: pass the already-known availability when the caller has just probed it (avoids a
// redundant probe); omit it to probe fresh (the very first check of a pass, before anything else
// has sensed availability). When Claude IS up, every currently-stalled task that has NOT already
// been through a Claude re-scope diagnosis gets one resolution attempt via resolveStalledWithClaude
// before this reports a stop — a task Claude actually fixes (AC/description contradiction) drops out
// of the stop report and the pass carries on. A task already diagnosed as a genuine human-required
// split is left alone (no point re-running a 10-minute Opus call every pass) and still stops the round.
async function stalledStopOutcome(claudeUp) {
  let stalled = filterStatus((await tasksByStatus(S.stalled)).tasks, S.stalled);
  if (!stalled.length) return null;
  const up = claudeUp === undefined ? await probe('claude') : claudeUp;
  if (up && !stopRequested()) {
    const stillStalled = [];
    for (const s of stalled) {
      if (stopRequested()) { stillStalled.push(s); continue; }   // Safe Stop arrived mid-loop — defer, don't start more
      try {
        const full = await getTask(s.id);
        if (statusOf(full) !== S.stalled) continue;   // already resolved/moved since the list was read
        const issuesText = await recentCommentsText(s.id);
        // A task Claude already diagnosed as a genuine multi-concern split doesn't get re-diagnosed
        // every pass forever (a 10-minute Opus call, repeated every POLL interval, for nothing — the
        // verdict won't change until a human actually splits it). Only re-attempt tasks that never
        // got a Claude diagnosis at all (stalled while Claude was down, or from noChangeOutcome).
        if (issuesText.includes('Claude — re-scope needed')) { stillStalled.push(s); continue; }
        if (await resolveStalledWithClaude(full, issuesText)) continue;
      } catch (e) {
        if (e instanceof FatalLoopError) throw e;
        log(`✖ stalled resolution ${s.id} failed: ${e.message}`);
      }
      stillStalled.push(s);
    }
    stalled = stillStalled;
  }
  const reason = stalledStopReason(stalled);
  if (!reason) return null;
  log(`🛑 STOP: ${reason}`);
  return { stop: true, reason };
}

// Pure board bookkeeping — no agent, no availability requirement, so it runs on every pass whatever
// is up. Candidate parents are taken from the children that could actually have completed a chain
// (`committed` and `approved`), which keeps this to two queue reads plus one read per candidate
// instead of a full board crawl — a crawl would also have to paginate, since ClickUp caps a list
// query at 100 tasks and this board is already at that boundary.
async function rollUpTrackers() {
  const candidates = new Set();
  for (const s of [S.committed, S.approved]) {
    try {
      for (const t of (await tasksByStatus(s)).tasks || []) {
        const pid = t.parent || t.top_level_parent;
        if (pid) candidates.add(pid);
      }
    } catch (e) {
      log(`  ⚠ tracker roll-up skipped: could not read the "${s}" queue (${e.message})`);
      return;
    }
  }
  for (const pid of candidates) {
    try {
      const parent = await getTaskWithSubtasks(pid);
      const next = trackerRollupStatus(parent, parent.subtasks);
      if (!next) continue;
      const n = (parent.subtasks || []).length;
      await setStatus(pid, next);
      await tryComment(pid, `🟣 **PM** — all ${n} subtask(s) are ${next === S.committed ? '**committed**' : '**approved** or **committed**'} → parent rolled up to **${next}**.`);
      log(`  ${pid} tracker roll-up: ${n} subtask(s) → ${next}`);
    } catch (e) {
      log(`  ⚠ tracker roll-up failed for ${pid} (${e.message}) — left unchanged`);
    }
  }
}

async function pass() {
  const stalledAtStart = await stalledStopOutcome();
  if (stalledAtStart) return stalledAtStart;
  await rollUpTrackers();

  // EVERY pass, not just at startup: a task can land in 'coding' at any time (a lane that died
  // between the status flip and its terminal status). Recovering only at boot meant a running
  // watcher never looked again, so the task — and its whole dependent chain — stayed invisible
  // until someone restarted the process. Safe to run here: the loop is sequential, so nothing is
  // legitimately mid-implement at the start of a pass.
  await recoverOrphanedCoding();
  const coding   = await implementQueue();
  const review   = filterStatus((await tasksByStatus(S.review)).tasks, S.review);
  let approved   = filterStatus((await tasksByStatus(S.approved)).tasks, S.approved);
  try {
    approved = orderApprovedTasks(approved);
  } catch (e) {
    const reason = `cannot safely order approved tasks (${e.message})`;
    log(`🛑 STOP: ${reason}`);
    return { stop: true, reason };
  }

  if (!coding.length && !review.length && !approved.length) {
    log('idle: nothing ready/in-review/approved');
    return;
  }

  // Safe Stop is re-read at every decision point below, never sampled once: probes and a review can
  // take many minutes, so a flag dropped during them must still prevent the NEXT unit of work. Each
  // housekeeping item is also a unit — draining a whole approved/review queue after a stop request
  // could run for hours, far past the "finishes the current round" promise.
  if (!canStartNewWork()) {
    log('  ⏸ Safe Stop pending — starting nothing new');
    return;
  }

  // --- sense availability (top of the flowchart) ---
  const C = await probe('claude');
  if (!canStartNewWork()) return;   // the flag may have arrived during the probe

  if (C) {
    // Claude housekeeping runs FIRST: land every Codex-approved SHA in dependency order. If an
    // ancestor fails this round, park its descendants; unrelated approved roots may still land.
    const failedApproved = new Set();
    for (let i = 0; i < approved.length; i++) {
      const t = approved[i];
      if (stopRequested()) { log(`  ⏸ Safe Stop — deferring ${approved.length - i} approved task(s) to the next run`); break; }
      if (approvedBlockedThisRound(t, failedApproved)) {
        failedApproved.add(t.id); // transitively defer its descendants too
        log(`  ⏸ ${t.id} approved but its approved ancestor failed/parked this round — deferred`);
        continue;
      }
      if (!(await depsSatisfied(t))) {
        failedApproved.add(t.id);
        log(`  ⏸ ${t.id} approved but an external dependency is not satisfied — deferred`);
        continue;
      }
      try {
        const branch = await findExistingBranchOf(t);
        if (!branch) {
          await setStatus(t.id, S.blocked);
          await tryComment(t.id, `🟣 **PM** — approved task has no local branch → **blocked**.`);
          clearApprovedSha(t.id);
          failedApproved.add(t.id);
          continue;
        }
        const pinned = getApprovedSha(t.id);
        const tip = await revParseAt(REPO, branch);
        if (!pinned) {
          // Cannot trust the live tip as "reviewed" — force Codex again.
          await tryComment(t.id, `🟣 **PM** — approved without a persisted reviewed SHA → back to **in review** for re-review (Codex when it is up, otherwise Claude on a diff it did not write).`);
          await setStatus(t.id, S.review);
          failedApproved.add(t.id);
          continue;
        }
        if (tip !== pinned) {
          const approver = reviewerLabel(getApprovedReviewer(t.id));
          clearApprovedSha(t.id);
          await tryComment(t.id, `🟣 **PM** — branch \`${branch}\` moved since ${approver ? `${approver}'s` : 'the'} approval (\`${pinned.slice(0, 8)}\` → \`${tip.slice(0, 8)}\`) → **in review** (will not push unreviewed commits).`);
          await setStatus(t.id, S.review);
          failedApproved.add(t.id);
          continue;
        }
        const landed = await land(t, { branch, reviewedSha: pinned, reviewer: getApprovedReviewer(t.id) }, true);
        if (landed) resetOpsFailure(t.id);
        else failedApproved.add(t.id);
      } catch (e) {
        if (e instanceof FatalLoopError) throw e;
        failedApproved.add(t.id);
        const n = bumpOpsFailure(t.id);
        log(`✖ approved land ${t.id} failed (${n}/${MAX_ROUNDS}): ${e.message}`);
        await tryComment(t.id, `🟣 **PM** — land error (ops ${n}/${MAX_ROUNDS}): ${e.message.slice(0, 400)}`);
        if (n >= MAX_ROUNDS) {
          await setStatus(t.id, S.blocked);
          await tryComment(t.id, `🛑 **PM** — approved land failed ${MAX_ROUNDS} times → **blocked** so the queue can proceed.`);
        }
      }
      const stalledAfterLand = await stalledStopOutcome(true);
      if (stalledAfterLand) return stalledAfterLand;
    }

    if (!canStartNewWork()) return;
    const X = await probe('codex');
    if (!canStartNewWork()) return;
    // Normal PM housekeeping begins only after the approved queue was attended.
    for (const t of review) {
      if (stopRequested()) { log(`  ⏸ Safe Stop — deferring ${review.length - review.indexOf(t)} in-review task(s) to the next run`); break; }
      // Codex reviews whenever it is up. When it is down, Claude may stand in here exactly as it
      // does in the coding lane — but only on a diff the branch proves Claude did not write.
      let reviewer = 'codex';
      if (!X) {
        const coders = await parkedReviewCoders(t);
        if (parkedReviewReviewer(coders) !== 'claude') {
          log(`  ⏸ ${t.id} on review left parked (Codex down; ${coders ? `coded by ${[...coders].join('+')}` : 'coder not provable from branch history'})`);
          continue;
        }
        reviewer = 'claude';
        log(`  ${t.id} on review: Codex down → Claude reviews (branch coded by ${[...coders].join('+')})`);
      }
      try {
        await reviewAndResolve(t, reviewer, 'approved', true, true);
        resetOpsFailure(t.id);
      } catch (e) {
        if (e instanceof FatalLoopError) throw e;
        const n = bumpOpsFailure(t.id);
        log(`✖ review ${t.id} failed (${n}/${MAX_ROUNDS}): ${e.message}`);
        await tryComment(t.id, `🟣 **PM** — review error (ops ${n}/${MAX_ROUNDS}): ${e.message.slice(0, 400)}`);
        if (n >= MAX_ROUNDS) {
          await setStatus(t.id, S.blocked);
          await tryComment(t.id, `🛑 **PM** — review failed ${MAX_ROUNDS} times with non-fatal errors → **blocked** so the queue can proceed.`);
        }
      }
      const stalledAfterTaskReview = await stalledStopOutcome(true);
      if (stalledAfterTaskReview) return stalledAfterTaskReview;
    }

    // code the next ready task
    if (coding.length && canStartNewWork()) {
      // The candidate was selected before approved verification/review housekeeping. Re-read it:
      // an approved parent may just have failed verify and returned to changes-requested, so its
      // previously-unblocked child must not start from a stale queue snapshot.
      const selected = await getTask(coding[0].id);
      const stillEligible = statusOf(selected) === S.changes
        || (statusOf(selected) === S.ready && await depsSatisfied(selected));
      if (!stillEligible) {
        log(`  ⏸ ${coding[0].id} queue selection became ineligible during housekeeping — deferred`);
        return;
      }
      const G = await probe('grok');
      if (!canStartNewWork()) return;   // never open a 10-20 minute lane after a stop during Grok probe
      const coder = G ? 'grok' : 'claude';
      if (X) await runLane(selected, { coder, reviewer: 'codex',  onPass: 'approved', escalateWithClaude: true, claudeUp: true });
      else   await runLane(selected, { coder, reviewer: 'claude', onPass: claudeReviewPassAction(coder), escalateWithClaude: true, claudeUp: true });
      const stalledAfterCoding = await stalledStopOutcome(true);
      if (stalledAfterCoding) return stalledAfterCoding;
    }
    return;
  }

  // --- Claude down: cannot commit; only code-to-park is possible ---
  if (!canStartNewWork()) return;
  if (!coding.length) { log('Claude down; parked work (review/approved) can only be landed by Claude — waiting'); return; }
  const X = await probe('codex');
  if (!canStartNewWork()) return;
  const G = await probe('grok');
  if (!canStartNewWork()) return;
  if (X && G)       await runLane(coding[0], { coder: 'grok', reviewer: 'codex', onPass: 'approved', escalateWithClaude: false, claudeUp: false });
  else if (!X && G) await runLane(coding[0], { coder: 'grok', reviewer: 'grok',  onPass: 'review',   escalateWithClaude: false, claudeUp: false });
  else              log(`🛑 STOP: no coder available (Claude down, Grok ${G ? 'up' : 'down'}, Codex ${X ? 'up' : 'down'})`);
  const stalledAfterDegradedCoding = await stalledStopOutcome(false);
  if (stalledAfterDegradedCoding) return stalledAfterDegradedCoding;
}

// ---------- drivers ----------
async function main() {
  if (opts.check) {
    log('check: verifying ClickUp token + board + required statuses…');
    const list = await getList();
    const names = new Set((list.statuses || []).map(s => s.status));
    log(`  list: ${list.name}`);
    for (const s of Object.values(S)) log(`  status "${s}": ${names.has(s) ? 'present' : 'MISSING ✖'}`);
    for (const name of [S.ready, S.changes, S.review, S.approved, S.stalled]) {
      try { const { tasks = [] } = await tasksByStatus(name); log(`  ${name}: ${tasks.length} task(s)`); }
      catch (e) { log(`  ${name}: ERROR — ${e.message}`); }
    }
    return;
  }

  await acquireLock();
  startLockHeartbeat();   // starts before recovery and also covers explicit <taskId> runs
  log(`=== start: watch=${opts.watch} task=${opts.taskId || '(universal)'} base=${BASE} maxRounds=${MAX_ROUNDS} ===`);
  log(`⚠ agent lanes use ISOLATED clones under os.tmpdir() (independent refs — not linked worktrees). Primary: ${REPO}`);
  log(`  Agents run without CLICKUP_TOKEN / git push credentials; only this dispatcher pushes.`);
  log(`  This is defense-in-depth, NOT an OS filesystem jail: an agent given an absolute path can still`);
  log(`  reach ${REPO}. Primary-tree snapshots around every agent call detect that immediately (fatal stop) — they do not prevent it.`);

  if (opts.taskId) {                                    // debug: force one task through the lane its availability picks
    try {
      await recoverOrphanedCoding();
      const t = await getTask(opts.taskId);
      // Forcing a task by ID skips the queues, so it must repeat their eligibility check itself.
      const refusal = pickupRefusalReason(t) || await asyncPickupRefusal(t);
      if (refusal) { log(`🛑 refusing ${opts.taskId} "${t.name}": ${refusal}`); return; }
      const C = await probe('claude'), X = await probe('codex'), G = await probe('grok');
      const coder = G ? 'grok' : 'claude';
      if (C && X)      await runLane(t, { coder, reviewer: 'codex',  onPass: 'approved', escalateWithClaude: true,  claudeUp: true });
      else if (C)      await runLane(t, { coder, reviewer: 'claude', onPass: claudeReviewPassAction(coder), escalateWithClaude: true,  claudeUp: true });
      else if (X && G) await runLane(t, { coder: 'grok', reviewer: 'codex', onPass: 'approved', escalateWithClaude: false, claudeUp: false });
      else if (G)      await runLane(t, { coder: 'grok', reviewer: 'grok',  onPass: 'review',   escalateWithClaude: false, claudeUp: false });
      else             log('🛑 STOP: no coder available');
    } catch (e) {
      if (e instanceof FatalLoopError) await handleFatalStop(e);
      else throw e;
    }
    return;
  }

  if (stopRequested()) { log(`(clearing a leftover Safe Stop flag at ${STOP_FILE})`); clearStop(); }

  do {
    touchLock();
    let outcome;
    try { outcome = await pass(); }
    catch (e) {
      if (e instanceof FatalLoopError) { await handleFatalStop(e); break; }
      log(`✖ pass error: ${e.message}`);
    }
    if (outcome?.stop) { await stopSafely(outcome.reason); break; }
    if (process.exitCode) break;
    if (stopRequested()) { await stopSafely('after finishing the current round'); break; }
    if (opts.watch) {
      console.log(`… sleeping ${POLL}s (watch)`);
      if (await sleepUntilNextPass(POLL)) { await stopSafely('while idle between rounds'); break; }
    }
  } while (opts.watch);
}

if (opts.selftest) await selftest();   // exits from inside; everything above is initialized by now

try {
  await main();
} catch (e) {
  if (e instanceof FatalLoopError) {
    try { await handleFatalStop(e); }
    catch (reportError) { log(`✖ fatal-stop reporting also failed: ${reportError.message}`); }
  } else {
    log(`✖ ${e.message}`);
  }
  process.exitCode = 1;
}
