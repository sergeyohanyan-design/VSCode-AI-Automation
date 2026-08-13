# Agent Loop

## License

This project is source-available under the PolyForm Perimeter 1.0.1.

You may use, study, modify, and contribute to the software subject to the license terms. Use of this software to create or provide a competing product is not permitted.

Commercial licensing and other licensing arrangements are available from the copyright holder.

---

**One button that runs a self-routing AI development loop against a ClickUp board.**

Claude, Codex and Grok take turns coding and reviewing each other's work. A ClickUp list is the task
queue, the state machine and the audit trail. You press one button; work moves from `ready` to
`committed` on its own, and stops there — deploy is always yours.

---

## What it actually does

Every pass, the dispatcher senses which agent CLIs are up and not rate-limited, then routes itself.
There are no modes and no reviewer to pick.

| Claude | Codex | Grok | What happens |
|:---:|:---:|:---:|---|
| ✓ | ✓ | ✓ | Grok codes → Codex reviews → **commit + push** |
| ✓ | ✓ | ✗ | Claude codes → Codex reviews → **commit + push** |
| ✓ | ✗ | ✓ | Grok codes → Claude reviews → approved, lands next pass |
| ✓ | ✗ | ✗ | Claude codes and self-reviews → parks on `in review` |
| ✗ | ✓ | ✓ | Grok codes → Codex reviews → parks on `approved` |
| ✗ | ✗ | ✓ | Grok codes and self-reviews → parks on `in review` |
| ✗ | ✓ | ✗ | Stops — a reviewer is up but nothing can code |

**The invariant that never bends: nothing is ever committed that was reviewed by the agent that
wrote it.** When the second opinion isn't available, work parks instead of landing. That is the
whole design — an agent grading its own homework is not review.

Beyond the routing, the parts that matter in practice:

- **A verification gate.** Before reviewed work lands, your test command runs against the reviewed
  commit in an isolated checkout with credentials stripped. "The reviewer approved it" and "the
  suite is green" are different claims, and this one requires both. Nothing here pins a database or
  a service: whatever the verify process exports would override the non-forced env declarations in
  your test config, so a hardcoded engine would silently test a stack production does not run. Point
  `AGENT_LOOP_VERIFY_ENV_FILE` at the same environment file CI uses instead.
- **Isolation.** Every agent call runs in a throwaway `git clone` under the temp directory, with no
  remotes and no credential helper. The dispatcher is the only thing that touches your real repo.
  It snapshots `git status` before and after every call and stops hard if anything moved.
- **Churn escalation.** A task that fails review five rounds running is not retried blindly. It gets
  one diagnosis pass: a fixable contradiction in its acceptance criteria is repaired automatically
  and the task returns to `ready`; a genuine multi-concern task is parked for a human to split.
- **Safe Stop.** Click the button while it runs and it finishes the round it is in, never
  interrupting an agent mid-task, writes a handover report, and exits with the tree and board
  consistent.
- **Reviewers only ever see the task's own work.** The review diff is taken from the merge base
  with the base branch, never from its moving tip. A hotfix landing on `main` while a task is open
  is not part of that task's diff, so no reviewer can fail a task for "reverting" work it never
  touched — and no round is burned on an implementer refusing to fix a change it never made.
- **Dependency chaining.** A task whose completed blockers left exactly one unmerged branch forks
  from that branch, so sequential work accumulates and reviewers still see only each task's own
  increment. Landing pushes each task branch and never merges to `main`, so when two finished
  predecessors still sit on separate branches no single fork base holds both — the task is parked on
  `blocked` naming them, instead of quietly forking from `main` with neither prerequisite present.

---

## Requirements

- **Node.js 18+**, **Git**, **VS Code 1.85+** (or Cursor)
- A **ClickUp** account and a personal API token
- **At least one** of the `claude`, `codex`, `grok` CLIs on `PATH` — two to land code unattended

The extension ships the dispatcher inside itself. Your repository needs nothing added to it.

---

## Install

Download the `.vsix` from the
**[latest release](https://github.com/sergeyohanyan-design/VSCode-AI-Automation/releases/latest)**,
then:

```
code --install-extension agent-loop-<version>.vsix
```

Or in VS Code: Extensions → `…` menu → *Install from VSIX…*

> A `.vsix` install does **not** auto-update. To move to a new version, download it and install again.

Building it yourself instead — no dependencies, Node 18+ is all you need:

```
npm test && npx @vscode/vsce package
```

## Setup

Then click **Agent Loop: set up** in the status bar and follow the wizard. It validates your token,
creates the ClickUp list, and tells you exactly which statuses and custom fields to add by hand —
ClickUp's API cannot create those, so the wizard checks rather than pretends.

**[SETUP.md](./SETUP.md)** is the full walkthrough, including the one setting people get wrong
(`committed` must be created in ClickUp's *Done* category, or every chained task waits forever).

**[AI_Setup.md](./AI_Setup.md)** is the same procedure written as a prompt — paste it into Claude
Code, Copilot or Cursor and have your editor's agent configure it interactively.

---

## Configuration

Everything lives in one env file, **`~/.agent-loop.env`**, deliberately outside every repository:
the dispatcher resets working trees as it moves between task branches, so a token file inside a repo
can get swept into a commit.

**[`agent-loop.env.example`](./agent-loop.env.example) documents every setting.** Copy it and delete
what you don't need — two keys are required, everything else has a working default. Run
**Agent Loop: Open the config file** to open it, seeded from the example on first use.

| | |
|---|---|
| **Required** | `CLICKUP_TOKEN`, `AGENT_LOOP_LIST_ID` |
| **Your project** | base branch, repo path, project prompt contract |
| **Verification** | test command, sandbox location, dependency dirs to seed, test env file |
| **Board vocabulary** | all 8 status names, both custom field names, the never-pick-up column |
| **Agent commands** | the full CLI invocation for each agent — change model, flags, or binary |
| **Timing** | poll interval, churn cap, per-stage timeouts, retry policy |
| **State files** | lock, stop flag, log, handover report, churn tally |

Nothing about your board's vocabulary is hardcoded. If your workflow spells things differently,
override the names; no code change is needed. `npm test` enforces this — a setting the dispatcher
reads but the example never documents fails the build.

---

## Commands

| Command | |
|---|---|
| **Agent Loop: Start / Safe Stop** | The status-bar button. Start, or stop cleanly. |
| **Agent Loop: Set up / reconfigure ClickUp** | The first-run wizard. |
| **Agent Loop: Check the ClickUp board** | Validate token, statuses and fields. Writes nothing. |
| **Agent Loop: Open the config file** | Open `~/.agent-loop.env`. |
| **Agent Loop: Force Stop** | Kill now. May leave a task mid-implement; the next start recovers it. |
| **Agent Loop: Open last handover report** | What the last Safe Stop left behind. |

---

## Writing tasks

This is the part that determines whether the loop converges or churns, and it is worth ten minutes
before you write twenty tasks. **[examples/TASK_AUTHORING.md](./examples/TASK_AUTHORING.md)** covers
it in full. The short version:

- The **Acceptance Criteria** field is the spec. The task *name* is just a label the branch name is
  derived from.
- **One concern, one layer, per task.** Not a line-count rule — a large cohesive change is safer
  than a small one secretly bundling two independent issues.
- Add an explicit **SCOPE GUARD** line naming what the task must not touch. Single biggest
  churn-preventer there is.
- Bake required tests and known edge cases into the criteria. A reviewer will block on an untested
  edge case whether or not you mentioned it — better to state it than to lose a round discovering it.

Other examples in this repository:

- [`agent-loop.contract.example.md`](./examples/agent-loop.contract.example.md) — a per-project rules
  file appended to every implement and review prompt.
- [`agent-loop-verify.example.mjs`](./examples/agent-loop-verify.example.mjs) — a selective
  verification harness, for when running the whole suite is too slow. Also the worked example of
  loading test environment from a file rather than hardcoding an engine.

---

## Safety and scope

Be clear-eyed about what this is: **you are letting AI agents write, review and push code to your
repository unattended.** The guard rails are real but they are not a sandbox.

- Agent calls run in throwaway clones with no remotes and no credentials, and the dispatcher detects
  any agent that reaches back into your primary repo — **detects, not prevents.** Nothing stops an
  agent that invents an absolute path. Real containment needs an OS-level sandbox and is out of
  scope here.
- Only reviewed, verified commits are pushed, and only to task branches merged into your base branch.
- **Deploy is never automated.** The loop stops at `committed`.
- Your ClickUp token is a personal token with your full permissions. It lives in one file outside
  your repos, at `0600`, and the VS Code extension never loads it into memory.

Run it on a repository you can recover, with a base branch you can revert, and read the review
comments for the first few tasks.

---

## Contributing

Contributions are welcome, subject to [CONTRIBUTING.md](./CONTRIBUTING.md) and the Contributor
License Agreement in [CLA.md](./CLA.md). `npm test` needs no network, no token and no VS Code.

## License details

**Agent Loop is source-available, not OSI open-source software.**

See [`LICENSE.md`](./LICENSE.md) for the full PolyForm Perimeter License 1.0.1 text and the required
notices. The PolyForm license itself is the controlling legal text; the summary at the top of this
file does not replace or modify it.

### Commercial licensing

If you want to use Agent Loop in a way the public license does not permit — including any use that
would provide a competing product — contact **sergey.ohanyan@gmail.com** to discuss a separate
commercial license. See [COMMERCIAL-LICENSING.md](./COMMERCIAL-LICENSING.md).

The Contributor License Agreement allows the Project Owner to incorporate community contributions
while retaining the ability to offer the Project under separate commercial or future licensing terms.

---

Copyright © 2026 Sergey Ohanyan. All rights reserved.
