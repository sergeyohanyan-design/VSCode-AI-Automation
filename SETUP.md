# Setup

Getting from a fresh clone to a running loop. Budget about 20 minutes, most of it
in the ClickUp UI creating statuses the ClickUp API cannot create for you.

If you would rather have an AI agent walk you through this interactively inside
VS Code, use [`AI_Setup.md`](./AI_Setup.md) instead — it is the same procedure,
written as a prompt.

---

## 0. Before you start

You need all of these. The loop degrades gracefully when an *agent* is missing,
but not when the platform pieces are.

| Requirement | Why | Check |
|---|---|---|
| **Node.js 18+** | The dispatcher is a zero-dependency Node script. | `node --version` |
| **Git**, and a repo with a remote | Every task becomes a branch; approved work is pushed. | `git --version` |
| **VS Code 1.85+** or Cursor | Hosts the button. | Help → About |
| **A ClickUp account** | The board *is* the state machine. A free plan works. | — |
| **At least one agent CLI** | `claude`, `codex`, `grok` — on `PATH`. | `claude --version` |

**About the agent CLIs.** The loop senses which are available on every pass and
routes around the missing ones, but the routing has one rule it never breaks:
*nothing is committed that was reviewed by the agent that wrote it.* So:

- **Claude + Codex + Grok** — full pipeline, work lands automatically.
- **Claude + Codex** — full pipeline, Claude codes instead of Grok.
- **Claude only** — Claude codes and self-reviews, then work **parks** on `in review`
  awaiting a second opinion. Nothing lands. This is a useful drafting mode, not a
  finishing one.
- **No Claude** — work still gets coded and reviewed, but parks on `approved`
  because landing is Claude's job.

One agent is enough to start and see the thing work. Two are enough to land code.

---

## 1. Install the extension

**From your editor's marketplace** (the normal path — it auto-updates from here on).
Search **Agent Loop** in the Extensions panel, or:

```
code --install-extension SergeyOhanyan.agent-loop      # VS Code
cursor --install-extension SergeyOhanyan.agent-loop    # Cursor, VSCodium, Windsurf
```

Cursor and the other non-Microsoft builds cannot use the VS Code Marketplace; they take the same
extension from [Open VSX](https://open-vsx.org/extension/SergeyOhanyan/agent-loop), which is why the
command differs but the identifier does not.

**From a `.vsix`**, for an air-gapped machine or to pin a version. Download it from the
[latest release](https://github.com/sergeyohanyan-design/VSCode-AI-Automation/releases/latest),
check it against `SHA256SUMS.txt`, then:

```
code --install-extension agent-loop-<version>.vsix
```

Or in VS Code: Extensions → `…` menu → *Install from VSIX…*

Note that a hand-installed `.vsix` never auto-updates — to take a new version you download and
install again. That is the only reason to prefer the marketplace path.

**From source**, if you cloned this repo. There are no dependencies to install:

```
npm test
npx @vscode/vsce package
code --install-extension agent-loop-<version>.vsix
```

Reload the window. A **`$(gear) Agent Loop: set up`** item appears at the
bottom-left of the status bar. That label means "not configured yet" — it becomes
a rocket once it is.

---

## 2. Get a ClickUp API token

ClickUp → your avatar → **Settings** → **Apps** → **API Token** → *Generate*.

It looks like `pk_<digits>_<letters and digits>`. This is a **personal** token tied to your
user, not an OAuth app — it can do anything you can do in ClickUp. Treat it
accordingly:

- It is written to `~/.agent-loop.env` with `0600` permissions, **outside every
  repository**. That location is deliberate: the dispatcher resets working trees
  as it moves between task branches, and a token file living inside a repo can
  get swept into a commit.
- The VS Code extension itself never loads the token into memory. Only the setup
  wizard reads it, and only while it is talking to ClickUp.
- Regenerate it in ClickUp if it is ever exposed. Nothing in this project can
  revoke it for you.

---

## 3. Run the wizard

Click the status-bar item, or run **Agent Loop: Set up / reconfigure ClickUp**
from the command palette. It asks five things:

1. **Your API token** — validated against the live API immediately, so a typo
   fails here rather than twenty minutes into the first pass.
2. **Workspace → Space → Folder** — where to put the task list.
3. **A list name** — it creates the list for you.
4. **Base branch** — what task branches fork from and merge back into. Usually `main`.
5. **Verify command** — optional; see step 5.

It then writes `~/.agent-loop.env` and checks the board.

---

## 4. Add the statuses and fields by hand

**This is the part that cannot be automated.** ClickUp's public API can create a
List but has no endpoint for creating custom statuses or custom fields. The
wizard tells you exactly what is missing and offers a re-check.

### 4.1 Eight list-scoped statuses

Open the list → list **Settings** → **Statuses** → *Add Status*. Do this at the
**list** level, not the Space, so these do not leak into unrelated lists.

```
ready → coding → in review → changes requested → approved → committed
                      ↘ blocked            ↘ stalled
```

| Status | Category | Meaning |
|---|---|---|
| `ready` | Active | Fully specified, eligible for pickup once its blockers are done. |
| `coding` | Active | An agent is implementing it right now. Transient. |
| `in review` | Active | A reviewer needs to look at the diff. |
| `changes requested` | Active | Review failed; will be re-implemented against the stated issues. |
| `blocked` | Active | Needs a human. Not part of normal flow. |
| `stalled` | Active | Churned too many review rounds without converging. |
| `approved` | Active | Reviewed and signed off, waiting to be landed. |
| `committed` | **Done** | Reviewed and pushed — to its own task branch. Merging into the base branch is human-gated, so the work is *not* on `main` yet. |

> **`committed` must be created in the "Done" category, not "Active".** Dependency
> gating only treats done/closed-type statuses as "this blocker is finished". Get
> this wrong and every chained task waits forever, with no error message to tell
> you why. It is the single most common setup mistake.

Optionally add a ninth, `deployed` (category **Closed**), purely as a manual
marker. The dispatcher ignores it — deploy is always human-gated.

### 4.2 Two custom fields

Both are matched by **name**, so spelling matters (case does not).

| Field | Type | Purpose |
|---|---|---|
| `Acceptance Criteria` | Text (long) | The actual spec. The task *name* is only a label used to derive the branch name. |
| `Blocked By` | Tasks (relationship) | Prerequisite tasks. ClickUp's native "waiting on" dependency works too, and does not consume custom-field usages. |

> **Record every prerequisite edge, especially on tasks you split by hand.** The
> edge is not bookkeeping — it is what makes a task fork from its predecessor's
> branch instead of from `main`. A task missing the edge starts from a `main` that
> does not contain its prerequisite, and the coder spends its whole round budget
> concluding the prerequisite "does not exist" — true on its branch, false in the
> repository. When two finished prerequisites still sit on separate branches, no
> single fork base holds both: the task is parked on `blocked` naming them, and
> you integrate before returning it to `ready`.

Then run **Agent Loop: Check the ClickUp board** until it reports everything
present. You can also check from a terminal, which spawns no agents and writes
nothing:

```
node <extension-dir>/src/agent-loop.mjs --check
```

---

## 5. Point it at your project

Open the repository you want the loop to work on. The button always operates on
the folder open in the window.

Run **Agent Loop: Open the config file** — it opens `~/.agent-loop.env`, seeded
from [`agent-loop.env.example`](./agent-loop.env.example), which documents every
setting. The two that matter most beyond what the wizard wrote:

**`AGENT_LOOP_VERIFY`** — a test command run against the reviewed commit before
it is allowed to land, in an isolated checkout with credentials stripped. Leave
it empty and reviews still happen, but nothing independently proves the suite is
green. Setting it is the difference between "an agent said it was fine" and "the
tests agree".

```
AGENT_LOOP_VERIFY=npm test
```

**`AGENT_LOOP_VERIFY_SEED_DIRS`** — if your test command needs gitignored
dependency directories. A fresh checkout has no `node_modules/` or `vendor/`, so
without this, verification fails on every run with a missing-dependency error
that has nothing to do with the diff:

```
AGENT_LOOP_VERIFY_SEED_DIRS=node_modules,vendor
```

**Make verify run the same stack as CI.** Whatever the verify process exports
wins over the non-forced env declarations in your test config — phpunit's
`<env>` defaults to `force="false"`, and pytest-env and dotenv likewise yield to
an already-set value. Pin a database variable anywhere in that chain and your
suite quietly runs on a different engine than CI and production, so a green
verify proves nothing about production. Nothing in Agent Loop hardcodes an
engine; point it at the same environment file CI uses:

```
AGENT_LOOP_VERIFY_ENV_FILE=/absolute/path/to/.env.testing
```

Optionally add a **project contract** at `tools/agent-loop.contract.md` in your
repo — a short, imperative list of standing rules appended to every implement and
review prompt. See [`examples/agent-loop.contract.example.md`](./examples/agent-loop.contract.example.md).

---

## 6. Write one task and start

Create a task on the list, in `ready`, with a concrete `Acceptance Criteria`.
Read [`examples/TASK_AUTHORING.md`](./examples/TASK_AUTHORING.md) before writing
many — task sizing is what determines whether the loop converges or churns, and
it is the hardest-won knowledge in this project.

Start with something small and self-contained. Then click the rocket.

The loop takes over the working tree while it runs, so do not edit files in it.
When you want the repo back, click the button again for a **Safe Stop**: it
finishes the round it is in, never interrupting an agent mid-flight, writes a
handover report to `~/.agent-loop-stop-report.md`, and exits cleanly.

---

## Troubleshooting

**The button says "set up" and the wizard will not open.**
`~/.agent-loop.env` is missing `CLICKUP_TOKEN` or `AGENT_LOOP_LIST_ID`. Open it
with **Agent Loop: Open the config file** and check both are set.

**"could not read your ClickUp workspace".**
The token is valid but sees nothing, or was revoked. Regenerate it and re-run the
wizard.

**Everything sits in `ready` and nothing is picked up.**
In order of likelihood: a blocker is not in a *Done*-category status (see the
warning in 4.1); the task has subtasks, which is never picked up on any path; the
task or its parent is in the planning column; or its `Acceptance Criteria`
contains `TRACKER ONLY`.

**Work gets approved but never lands.**
Landing is Claude's job. Check `claude` is on `PATH` and not rate-limited.

**Review fails a task over files it never touched.**
If the objection names unrelated files — "reverted this", "deleted that test" —
and the coder then reports it changed nothing, check your version. Before
**v1.0.6** the review diff was taken against the base branch's current tip, so
anything merged into `main` while the task was open showed up as a deletion by
the task. Upgrade: the `.vsix` does not auto-update, so an old install keeps
doing this. The task is fine; do not rewrite it.

**Tasks bounce between review and changes-requested forever.**
Read the review comments. The same objection re-raised 5 rounds running means
the task is mis-scoped, not that the agent is failing —
[`examples/TASK_AUTHORING.md`](./examples/TASK_AUTHORING.md) §4.1 and §6 cover
this in full. The loop escalates it automatically after
`AGENT_LOOP_MAX_ROUNDS` rounds.

**Verification fails on every task with a missing dependency.**
Set `AGENT_LOOP_VERIFY_SEED_DIRS` (step 5).

**The button is stuck on "running" or "stopping".**
It reads `~/.agent-loop.lock` and validates the PID inside, so it self-heals
within about 10 minutes of a crash. To force it: **Agent Loop: Force Stop**, or
delete `~/.agent-loop.lock` and `~/.agent-loop.stop`.

**It refuses to start, citing an unsafe child.**
A previous run detected an agent touching your primary repository, and fenced
itself. Inspect the tree, then set `AGENT_LOOP_UNSAFE=1` for one run to clear it.

The full audit log is `~/.agent-loop.log`.
