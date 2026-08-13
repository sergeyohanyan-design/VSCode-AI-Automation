# Agent Loop — Task List & ClickUp Instructions

Audience: this file is for **both humans and AI agents** (Claude / Codex / Grok, or any future
agent) that create, chain, or work through tasks for `agent-loop.mjs`. If you are an agent
about to create ClickUp tasks for this dispatcher to run, read the whole file before creating the
first task — the dependency and scoping rules below determine whether the loop converges cleanly
or churns forever on a mis-scoped task.

This file describes **the tool's contract**, not any one project's task list. It applies to any
repo the dispatcher is pointed at.

---

## 1. What this tool is

`agent-loop.mjs` is a small, dependency-free Node script that runs a 3-agent dev loop
(**Grok** codes, **Codex** and/or **Claude** review, **Claude** does PM housekeeping) against a
**ClickUp list** used as the durable task board. You (a human) run it — that is deliberate: Claude
Code's own auto-mode classifier refuses to let Claude spawn `grok`/`codex` as sub-processes, so the
dispatcher runs as *your* process instead, and nothing gates it.

Full behavioral spec (availability matrix, isolation model, Safe Stop, branch chaining) lives in
the doc-comment at the top of `agent-loop.mjs` itself — **read that first if you are setting this
up or debugging it**; this file is specifically about *how to author and chain ClickUp tasks* so
the loop can pick them up and converge, plus the one-time ClickUp/env setup that has to exist
before any task can flow.

One entry point, one behavior — there is no `--mode`/`--reviewers` to choose. Each pass senses which
of Claude / Codex / Grok are actually up (not rate-limited) and self-routes:

| Claude | Codex | Grok | What happens |
|---|---|---|---|
| ✓ | ✓ | ✓ | Grok codes → Codex reviews → pass: **commit + push**. 5 failed rounds → Claude re-scope diagnosis → auto-repaired to `ready`, or `stalled` if it's a genuine split. |
| ✓ | ✓ | ✗ | Claude codes → Codex reviews → same commit/push and escalation. |
| ✓ | ✗ | ✓ | Grok codes → Claude reviews → pass: **approved**, landed on the next pass. Claude reviews in Codex's place because it did not write this diff. |
| ✓ | ✗ | ✗ | Claude codes + self-reviews → parked on **in review** to await Codex (the reviewer would be the author). |
| ✗ | ✓ | ✓ | Grok codes → Codex reviews → pass: parked on **approved** to await Claude to actually land it. |
| ✗ | ✓ | ✗ | STOP — a reviewer is up but nothing can code. |
| ✗ | ✗ | ✓ | Grok codes + self-reviews → parked on **in review**. |
| ✗ | ✗ | ✗ | STOP — nothing is up. |

**Invariant that never changes:** nothing is committed/pushed that was **reviewed by the agent that
wrote it**. Codex reviews whenever it is up. When Codex is down, Claude reviews and may land — but
only work Grok coded; a Claude-coded diff still waits for Codex. And **deploy is always a separate,
human-gated step** — this tool never deploys anything.

**Never picked up:** a task in the **planned** column, **any task that has subtasks**, any task whose
Acceptance Criteria contains `TRACKER ONLY` (an epic — chain its subtasks instead), **or any task
whose parent is itself in the planned column**.

The **subtask** rule is the one to rely on. A `TRACKER ONLY` marker only protects a task if somebody
remembered to type it, and it lives in a custom field that ClickUp will refuse to edit once the
workspace has spent its field usages (HTTP 400 `FIELD_033`, see §5.5) — at which point you *cannot*
add the marker to an existing epic at all. This is not hypothetical: an epic with 21 subtasks and an
empty Acceptance Criteria was moved out of `planned`, whereupon the dispatcher picked the epic itself
up as ordinary work, ran a coder against it, produced nothing, and stalled — halting the loop for
everything. Having children requires no discipline to stay true. This holds on every path, including `node agent-loop.mjs <taskId>`. Override
the column name with `AGENT_LOOP_STATUS_NEVER_PICKUP` (comma-separated; defaults to
`planed,planned`).

That last rule is how you hold a whole initiative: park the parent epic in **planned** and every
child is refused, whatever its own status says — you do not have to edit 18 children. It is checked
per candidate with one extra read, and it fails closed (a parent that cannot be read defers the task
to the next pass). Note the corollary: a child in `ready` under a `planned` parent will NOT run, so
when you *do* clear an initiative, move the parent out of `planned` or nothing in it will start.

---

## 2. One-time ClickUp setup

Do this once per project/board. All of it is plain ClickUp UI — no ClickUp app/API scopes beyond a
personal token are needed.

### 2.1 Create a dedicated List

Create (or pick) a **List** in ClickUp to hold agent-loop tasks — anywhere in your hierarchy
(a dedicated Space/Folder is cleanest so the list-scoped statuses below don't leak into other
lists). Note its **List ID** — visible in the URL when you open the list
(`https://app.clickup.com/.../v/li/<LIST_ID>`) or via the ClickUp API. You'll need it for
`AGENT_LOOP_LIST_ID`.

### 2.2 Add exactly these 8 list-scoped statuses

Open the list → list Settings → **Statuses** → "Add Status" (do this at the **list** level, not
the Space, so it does not affect other lists). Create these statuses, spelled and cased exactly
like this (the dispatcher matches status strings literally):

```
ready → coding → in review → changes requested → approved → committed
                       ↘ blocked          ↘ stalled
```

| Status | Type | Meaning |
|---|---|---|
| `ready` | open | Task is fully specified and eligible to be picked up (once its dependencies are done). |
| `coding` | open | An agent is currently implementing it. Transient — the dispatcher recovers a task stuck here on the next pass/restart. |
| `in review` | open | A reviewer (Codex and/or Claude) needs to look at the diff. |
| `changes requested` | open | Review failed; will be re-implemented, fixing exactly the stated issues. |
| `approved` | open | Codex approved it but Claude wasn't up to actually commit/push it yet — parked for PM housekeeping to land later. |
| `blocked` | open | Something needs a human (missing branch, land error, dependency problem) — not part of normal flow. |
| `stalled` | open | Churned `AGENT_LOOP_MAX_ROUNDS` (default 5) review rounds without converging. Claude gets one auto-repair attempt (fixable AC contradiction → straight back to `ready`, no human step); only a genuine multi-concern split, or Claude being unavailable, leaves it here for a human (see §6). |
| `committed` | **done** | The task's branch was reviewed and pushed to the base branch. **This one MUST be configured with status type `done`** — dependency gating (`statusDone()`) only treats `done`/`closed`-typed statuses as "this blocker is finished." If `committed` is left as a plain "open"/"custom" status, every downstream chained task will wait forever. When adding it in ClickUp's status editor, pick the "Done" category (not "Active"/"Closed") for this status. |

Do **not** reuse your Space's default statuses (`to do` / `in progress` / `complete` etc.) for
this — those are a different, unrelated status set the dispatcher ignores. These 8 must be
list-scoped custom statuses on the agent-loop list itself.

**Optional 9th status:** since deploy is always a separate human-gated step the dispatcher never
touches, it's convenient to add a `deployed` status (type **closed**) purely as a manual marker you
drag a task to once you've actually deployed its merged commit — the dispatcher ignores it entirely,
it's just bookkeeping for humans.

Verify the setup any time with:
```
node agent-loop.mjs --check
```
It confirms the token works, prints which of the 8 statuses are present/missing, and shows a live
count of tasks in `ready` / `changes requested` / `in review` / `approved` / `stalled` — spawns no
agents, makes no board writes.

### 2.3 Add two custom fields

Both are matched **by name** (not by field ID — any board can create them fresh):

- **`Acceptance Criteria`** — type **Text** (long text/paragraph). This is the actual spec body for
  the task; the task's *name* is only a short label used to derive its git branch name.
- **`Blocked By`** — type **Tasks** (the "relationship to other tasks" field type, not a plain text
  field). Used to hand-pick this task's prerequisite task(s) when you aren't using ClickUp's native
  dependency feature (see §5).

### 2.4 Get a personal API token

ClickUp → click your avatar → **Settings** → **Apps** → **API Token** ("Generate"). This is a
personal token tied to your ClickUp user, not an OAuth app — that's what `CLICKUP_TOKEN` wants.

---

## 3. Local machine config

Create `~/.agent-loop.env` (outside any repo — task branches reset to the repo's base branch, so a
token file *inside* the repo risks being swept into a commit). One `KEY=value` per line:

```
CLICKUP_TOKEN=pk_your_token_here
AGENT_LOOP_LIST_ID=<the List ID from step 2.1>
AGENT_LOOP_VERIFY=<your project's test command, e.g. "npm test" or "php artisan test">
```

Both `CLICKUP_TOKEN` and `AGENT_LOOP_LIST_ID` are **required** — the script refuses to start
without them rather than silently defaulting to some other project's board. Everything else has a
sane default. **`agent-loop.env.example` in the repository root documents every setting** (repo path,
base branch, poll interval, churn cap, per-stage timeouts, board vocabulary, log/lock file locations,
per-agent CLI command overrides); copy it to `~/.agent-loop.env` and delete the lines you do not
need. `AGENT_LOOP_VERIFY` may be left empty to skip automated verification entirely, but you lose the
safety net that catches "review passed, tests didn't."

Running **Agent Loop: Set up / reconfigure ClickUp** from the command palette writes this file for
you, and **Agent Loop: Open the config file** opens it, seeded from the example on first use.

### 3.1 Optional: a per-repo prompt contract

If this project has a standing rule every task must follow (a data contract, a required test
pattern, a "never hardcode X" rule) that would otherwise need repeating in every task's Acceptance
Criteria, put it once in **`tools/agent-loop.contract.md`** in the target repo. If that file exists,
its contents are appended to *every* implement and review prompt automatically; if it doesn't
exist, nothing is added — the dispatcher script itself carries zero project-specific instructions.
Override the path with `AGENT_LOOP_CONTRACT_FILE` if you'd rather keep it elsewhere. See
`examples/agent-loop.contract.example.md` for the shape of one.

---

## 4. Writing a single task

A task = one **ClickUp task** on the configured list, with:

- **Name** — short, specific, unique. The git branch is derived from it
  (`agent-loop/task-<slug-of-name>-<task-id>`; the slug truncates at 60 characters), so keep it
  concise and don't rename it after work has started — the dispatcher looks up the branch by the
  name that was current when it was created (it does fall back to a pre-suffix legacy branch name
  for tasks created before this scheme, but don't rely on that for new tasks).
- **Acceptance Criteria** (the custom field, not the description) — the actual spec. Be concrete:
  - State the exact requirement(s), not just a goal — vague AC gets reviewed against whatever the
    reviewer imagines the goal was, which is a common source of churn.
  - Bake in required tests / edge cases explicitly as bullet requirements. A reviewer that finds an
    untested edge case will block on it regardless of whether the AC mentioned it — better to state
    it up front than lose a review round discovering it.
  - Add an explicit **SCOPE GUARD** line: name what this task must NOT touch (especially adjacent
    layers/files another task owns). This is the single biggest churn-preventer — see §6.
- **Status** — create it in `ready` if it's immediately eligible, or `blocked` if it's intentionally
  not ready yet (e.g. an epic/tracker — see §5.3).
- **Dependencies** — see §5. Leave empty if this task can start immediately off the base branch.

### 4.1 Sizing a task — one concern only

The single most important authoring rule: **a task should touch exactly one concern, in one
subsystem/layer.** "Layer" means: backend OR admin-SPA OR mobile OR web — not several in one task.
"Concern" means one bug/feature, not two independent ones bundled because they're nearby in the
code.

This is not a line-count rule — a 2000-line file with one cohesive concern is *safer* than a
400-line task secretly bundling two independent subtle issues. The tell is usually only visible in
review: a task that gets rejected, "fixed," and rejected again for a **different** reason (not the
same one repeated) is bundling two concerns. A task rejected for the **same** reason 3+ rounds in a
row is more often a scope contradiction (see next) than a sizing problem.

Before splitting, check the Acceptance Criteria for an internal contradiction — e.g. AC demanding a
change to something the SCOPE GUARD forbids touching, or an AC item whose prerequisite (a
cross-layer contract, an API shape) doesn't exist yet. Contradiction → fix the AC or add the missing
predecessor task; genuine bundling → split into single-concern subtasks that each restate the
original SCOPE GUARD.

---

## 5. Chaining tasks (dependencies)

A `ready` task is only eligible to be picked up once **every** one of its blockers has reached a
done/closed-type status (i.e. `committed`, per §2.2). There are two independent ways to declare a
blocker — either is honored, and you can mix them across a chain:

### 5.1 Native ClickUp dependency (preferred for most cases)

Open the downstream task → **Relationships** → **Depends on** / mark it "waiting on" the upstream
task. This is ClickUp's built-in dependency relationship (`waiting_on`). **Does not count against
any custom-field usage cap**, so prefer this for a large batch of chained tasks.

### 5.2 The `Blocked By` custom field

Set the **`Blocked By`** field (a Tasks-relationship field, §2.3) on the downstream task to the
upstream task's ID. Functionally identical to a native dependency from the dispatcher's point of
view — both are merged into the same blocker list. Useful when you want the relationship visible as
a field value, or when a ClickUp plan's custom-field-usage cap makes native dependencies more
practical for a specific subset.

### 5.3 Tracker / epic pattern

**The tracker's own status is maintained for you.** It is never implemented, but every pass rolls it
up to match what its children actually add up to:

| Children | Tracker becomes |
|---|---|
| all done (`committed`, or `deployed`) | `committed` |
| all done-or-`approved`, at least one `approved` | `approved` |
| anything else still open | left alone |

So a chain that finishes no longer leaves its parent sitting on `ready` lying about it, and a chain
Codex has fully approved while Claude is down shows as `approved` rather than as unstarted work. This
is **forward-only** by design: a tracker already at `committed` is never walked backwards if one
child reopens, because a done tracker flapping is worse than one that is briefly stale. Move it by
hand in that case.

For a parent umbrella task that should **never** itself be picked up (its subtasks are the real
work), put the literal marker text **`TRACKER ONLY`** anywhere in its Acceptance Criteria field.
The dispatcher filters any task matching that marker out of the pickup queue **regardless of its
current status** — this matters because ClickUp can auto-roll a parent's status up to `ready` once
all its children reach `ready`, which would otherwise make the tracker itself pickable. Keep the
tracker's own status at `blocked` as a visual cue; the marker is what actually protects it.

### 5.4 Branch chaining — why "exactly one blocker" matters

When a fresh task has **exactly one** blocker and that blocker is done, the dispatcher forks the new
task's branch from **the blocker's own branch** (not the base branch) — so a sequential chain
accumulates correctly, and review only ever diffs each task's own increment (not the whole
inherited history). If a task has zero or more-than-one blockers, it forks from the configured base
branch (`AGENT_LOOP_BASE`, default `main`) instead.

That increment is measured from the **merge base** with whichever branch it forked from, not from
that branch's current tip. Predecessor commits, and anything that lands on the base while this task
is open, therefore stay out of its review diff even when the fork point is hours old.

**Practical upshot:** a genuinely sequential pipeline (A → B → C → D) should give each task **exactly
one** blocker — its immediate predecessor — not "all prior tasks in the chain." Give a task multiple
blockers only when it truly needs several independent pieces of work to land first and doesn't care
about accumulating any single one's branch.

### 5.5 Editing a task after creation

Some ClickUp plans cap how many times a custom field can be **updated** in place (you'll see HTTP
400 `FIELD_033`, "Custom field usages exceeded for your plan") — this blocks editing an *existing*
task's Acceptance Criteria, but **creating** a new task with the field pre-filled is unaffected. If
you hit this changing an AC: back up the task's JSON, delete it, recreate it with the same name (so
the branch, if any already exists, is still found) and the corrected AC in the create call, then
re-add **both** directions of any native dependency — deleting a task also drops the link on its
former successor, not just the task itself.

---

## 6. When a task gets stuck (`stalled`)

If a task fails review `AGENT_LOOP_MAX_ROUNDS` times (default 5) without converging, it gets ONE
**Claude re-scope diagnosis** (Opus): is this one task bundling multiple concerns, or does it have a
fixable AC/description contradiction (a scope guard forbidding what an AC item demands, a stale
requirement, a missing prerequisite note)?

- **Fixable contradiction, Claude available:** Claude hands back the corrected description; the
  dispatcher (never the re-scope call itself — it holds no ClickUp token) applies it, posts a
  `🟣 Claude — AC contradiction auto-repaired` comment, and returns the task straight to **`ready`**.
  Nothing stops; no human step. The same auto-repair attempt also runs on any task that is ALREADY
  `stalled` at the top of a pass (e.g. left over from a run where Claude was down), so a `stalled`
  task doesn't need Claude to be up at the *original* failure — only at some later pass.
- **Genuine multi-concern split, or Claude unavailable to diagnose it:** the task moves to
  **`stalled`** and the dispatcher stops before probes/new work — this is the one case still left as
  a deliberate human checkpoint, because splitting into subtasks is a judgment call this dispatcher
  doesn't automate.

To resolve a task that is genuinely stuck on `stalled` (split needed, or Claude was down for every
attempt so far):
1. Read the re-scope comment (`🟣 Claude — re-scope needed`, or the review history if Claude was
   never available to diagnose it).
2. Split it into single-concern subtasks per §4.1 — each split AC should re-state the parent's SCOPE
   GUARD plus bake in the specific edge cases the reviewer kept re-raising, or the split halves will
   just re-discover them independently. (A simple AC contradiction usually self-resolves the next
   time Claude is up and this pass revisits it — you rarely need to hand-edit those.)
3. Re-chain dependencies (§5) so the split pieces (and anything that depended on the original) stay
   correctly ordered.
4. Delete the oversized original (or leave it as a record and just stop using it) and set the new
   task(s) to `ready`.

A coder that exits successfully having changed **nothing** is a different signal again, and it is
usually not a stall. If the task's branch already has commits beyond its base, the dispatcher routes
it to **`in review`** — an earlier round already finished the work (most often a coder that timed out
during wrap-up, leaving a commit labelled `PARTIAL` that is actually complete, so the next round
correctly finds nothing to do). Only a no-op on an *empty* branch parks on `stalled`. If you see a
task stalled at round 1 of 5, this is the case to check first: look at its branch before splitting it.

A task alternating **pass-then-verify-fail** (reviewer approves, but the test suite fails) is a
different signal: check whether the **base branch itself** is already red before assuming the task
is at fault — a task built on a broken foundation can never pass verification no matter how it's
implemented.

---

## 7. Running the loop

```
node agent-loop.mjs --watch     # continuous — what the IDE button runs
node agent-loop.mjs             # a single pass, then exit
node agent-loop.mjs <taskId>    # force one specific task through whatever lane availability picks
node agent-loop.mjs --check     # verify token + board + statuses; no agents spawned, no writes
node agent-loop.mjs --selftest  # offline unit tests (verdict parser, git-plumbing edge cases, etc.)
```

With the Agent Loop VS Code/Cursor extension installed there is one status-bar button — and it runs
the dispatcher bundled inside the extension, so you do not need a copy in your repo at all: click to
start the watch loop, click again for a **Safe Stop** (finishes the round already in
flight, never interrupts a coder/reviewer mid-task, writes a handover report, then exits cleanly).
Only ever run **one** instance against a given repo at a time — two concurrent `--watch` processes
race on the same shared git working tree and can corrupt it; a PID lock enforces this automatically.

For the full safety model (sandbox isolation, Safe Stop mechanics, orphan recovery, fatal-stop
fencing on tamper detection) read the doc-comment at the top of `agent-loop.mjs` — it is kept
current as the authoritative spec and deliberately not duplicated here in full.
