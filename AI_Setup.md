# AI-assisted setup

Rather than following [`SETUP.md`](./SETUP.md) yourself, you can hand the job to
the AI coding agent already running in your editor — Claude Code, Copilot,
Cursor, Codex, or any other.

**Copy everything between the two rules below into a new chat with that agent, in
the VS Code window that has your project open.**

The agent can do most of this itself: it can read your repo to work out the right
test command, write the config file, and check the board over the ClickUp API. It
cannot create the ClickUp statuses and custom fields — no API can — so for that
part it will hand you a precise checklist and then verify your work.

**One thing to know before you start:** the agent will need your ClickUp API
token to check the board for you. Pasting a token into an AI chat means it goes
to that vendor's servers and into your chat history. The prompt below tells the
agent to offer you a no-token path — where it prepares everything and you paste
the token into the wizard's password box yourself. Prefer that path. If you do
paste the token, regenerate it in ClickUp afterwards.

---

You are helping me set up the **Agent Loop** VS Code extension in this workspace.
It runs a self-routing AI dev loop — Claude, Codex and Grok CLIs coding and
reviewing against a ClickUp list used as the task board and state machine.

Work through the phases below **one at a time**. After each phase, tell me
plainly what you found or did, and wait for me before moving on. Do not batch the
whole thing and report at the end. If something is already configured correctly,
say so and skip it rather than redoing it.

**Rules for the whole session:**

- **Never print my ClickUp API token**, not in a message, a code block, a command
  you echo, or a file you show me. If you have to reference it, call it "the token".
- **Do not commit anything**, do not create branches, and do not modify my source
  files. The only file you should write is the config file in my home directory.
- **Prefer that I never give you the token at all.** Offer this first: you prepare
  everything else, and I run the extension's own setup wizard, which takes the
  token in a password field and never shows it to you. Only ask for the token if
  I decline that and explicitly ask you to do the API checks yourself.
- If a command fails, show me the actual error. Do not guess at a fix and retry
  silently.

### Phase 1 — Check the prerequisites

Run these and report which are present, with versions:

- `node --version` (must be 18 or newer)
- `git --version`, and confirm this workspace is a git repo with a remote
- Which agent CLIs are on PATH: `claude`, `codex`, `grok`

Then tell me what my agent lineup means for how the loop will behave, using this
rule: *nothing is ever committed that was reviewed by the agent that wrote it.*

- Claude + Codex + Grok, or Claude + Codex → work is coded, reviewed and lands automatically.
- Claude only → Claude codes and self-reviews, so work parks on `in review` and nothing lands.
- No Claude → work is coded and reviewed but parks on `approved`, because landing is Claude's job.

If I have fewer than two agents, say clearly that the loop will still run and do
useful work, but will not land anything on its own.

### Phase 2 — Work out my project's settings

Read this repository and propose values. Do not write anything yet — show me the
list and let me correct it.

- **Base branch** — check what the repo actually uses (`git symbolic-ref refs/remotes/origin/HEAD`,
  or the branch list). Do not assume `main`.
- **Test command** — derive it from what is actually here: `package.json` scripts,
  `Makefile`, `pyproject.toml`, `Cargo.toml`, `composer.json`, a CI workflow in
  `.github/workflows/`. Prefer the one CI runs. This becomes `AGENT_LOOP_VERIFY`,
  the gate that must pass before reviewed work is allowed to land.
- **Gitignored dependency directories** the test command needs — `node_modules`,
  `vendor`, a checked-in-nowhere test database, and so on. Verification runs in a
  fresh checkout, which has none of them, so anything missing here makes every
  single verification fail on a missing dependency unrelated to the change. This
  becomes `AGENT_LOOP_VERIFY_SEED_DIRS`.
- **The environment the suite needs, and whether it matches CI.** If the tests
  need a database, a queue or a cache, find out which engine **CI and production
  actually use**, then check what the suite would use here. Read the test config
  (`phpunit.xml`, `pytest.ini`/`tox.ini`, `jest.config`, `.env.testing`) against
  the CI workflow.

  This matters more than it looks. Most test configs declare environment
  *weakly* — phpunit's `<env>` defaults to `force="false"`, pytest-env and dotenv
  both yield to an already-set value — so any variable present in the
  environment when the suite starts wins. A test command or harness that pins a
  database engine therefore verifies a stack production does not run, and its
  green result proves nothing. Tell me if you find that mismatch here.

  The fix is never to hardcode an engine in the loop's config: set
  `AGENT_LOOP_VERIFY_ENV_FILE` to the same environment file CI loads. Note that
  the file is usually gitignored and verification runs in a fresh checkout, so
  give an absolute path outside the repo or add it to `AGENT_LOOP_VERIFY_SEED_DIRS`.

- **Whether the test suite is slow.** If a full run takes more than about 20
  minutes, say so — `AGENT_LOOP_VERIFY_TIMEOUT_S` needs raising, or the command
  needs narrowing.

### Phase 3 — Set up the ClickUp board

Tell me to do this part in the ClickUp UI, because the ClickUp API has no
endpoint for creating statuses or custom fields. Give me the checklist:

1. Create a List for agent-loop tasks, ideally in its own Space or Folder so its
   custom statuses do not leak into unrelated lists.
2. On that list — list Settings → Statuses, at the **list** level — create exactly
   these eight, spelled this way:
   `ready`, `coding`, `in review`, `changes requested`, `blocked`, `stalled`,
   `approved`, `committed`.
3. **Create `committed` in the "Done" category, not "Active".** Emphasize this to
   me. Dependency gating only treats done/closed-type statuses as finished, so if
   `committed` is Active, every chained task waits forever and nothing explains why.
4. Add two custom fields: **`Acceptance Criteria`** (long text) and
   **`Blocked By`** (Tasks relationship).
5. Have me send you the list ID from the URL: `https://app.clickup.com/<team>/v/li/<LIST_ID>`.

### Phase 4 — Write the config

The extension's config is a single env file at `~/.agent-loop.env`
(`%USERPROFILE%\.agent-loop.env` on Windows), deliberately outside every
repository — the dispatcher resets working trees as it moves between task
branches, so a token file inside a repo can get swept into a commit.

Read `agent-loop.env.example` from the extension's installation directory (find
it under `~/.vscode/extensions/`, or in this repo if I cloned it) — it documents
every available setting. Then offer me the two paths:

**Path A, recommended — I run the wizard.** Tell me to run **Agent Loop: Set up /
reconfigure ClickUp** from the command palette. It takes the token in a password
field, creates the list, and writes the config. You never see the token. Then
tell me to run **Agent Loop: Open the config file**, and talk me through adding
the values you proposed in Phase 2.

**Path B — you write the file.** Only if I ask. Write `~/.agent-loop.env` with
the settings from Phase 2 and the list ID from Phase 3, leaving
`CLICKUP_TOKEN=` empty for me to fill in by hand. Preserve any lines already in
the file that you did not write.

### Phase 5 — Verify

Have me run **Agent Loop: Check the ClickUp board** from the command palette. It
validates the token, reports which statuses and fields are missing, and writes
nothing.

If anything is missing, tell me exactly what to add and have me re-check. Do not
declare this done until the check comes back clean — a board that is missing a
status fails on the first pass, twenty minutes in, rather than at setup.

### Phase 6 — A first task, and what to expect

Read `examples/TASK_AUTHORING.md` from the extension directory or this repo, then
help me write **one** small first task on the list:

- A short, specific **name** — the git branch is derived from it, so it should not
  be renamed after work starts.
- A concrete **Acceptance Criteria** — this is the real spec, not the name. State
  exact requirements rather than a goal, name the tests or edge cases that must be
  covered, and add an explicit **SCOPE GUARD** line saying what the task must not
  touch.
- Status **`ready`**.

Pick something genuinely small and single-concern for the first run — one bug in
one file, not a feature spanning three layers. Then explain to me, briefly:

- Clicking the rocket starts the loop, and it takes over the working tree, so I
  should not edit files while it runs.
- Clicking it again is a **Safe Stop**: it finishes the current round, never
  interrupting an agent mid-task, writes a handover report to
  `~/.agent-loop-stop-report.md`, and exits cleanly.
- Deploy is never automated. The loop stops at `committed`.

Finally, give me a short summary of everything that was configured, and anything
you were not able to verify.
