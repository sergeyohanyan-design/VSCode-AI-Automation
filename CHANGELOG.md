# Changelog

## 1.1.1

- The example verify harness documents and implements the changed-tests rule: a run narrowed to the diff's own test files is only safe when the diff contains nothing but test files. A diff with any production file runs the whole suite. The tempting inverse (`if (changedTests.length) run just those`) wins on nearly every real task, because a feature ships with its own new test, so the suite never runs and the commit is proved only against tests written to pass. Backend-style tasks verify slower as a result; that is the intended cost.
- `npm test` now exercises the example harness end to end against a throwaway git repo, asserting that a production-plus-test diff plans the full suite and a test-only diff passes its changed tests through unchanged.

## 1.1.0

- Implement rounds use an idle-progress deadline (default 8 minutes of no stdout and no sandbox writes) plus the existing 20-minute wall-clock ceiling, so a coder that is still writing is not killed mid-verify. `AGENT_LOOP_IMPLEMENT_IDLE_S=0` restores the old wall-clock-only cap. The implement prompt is told the remaining budget; each round logs first-write / last-write / post-write times.
- `AGENT_LOOP_VERIFY_SEED_DIRS` now seeds coder and reviewer clones as well as the persistent verify sandbox, via a cache of directory junctions/symlinks that never links into the primary repo.
- Windows process-tree kill assigns the child to a Job Object (`KILL_ON_JOB_CLOSE`) and enumerates live descendants. `taskkill` exit 128 with the root already gone is no longer a fatal stop when no descendant is alive; that path takes the ordinary timeout (PARTIAL commit → in review). A confirmed-live descendant still fences the loop. `--recover` (and **Agent Loop: Recover unsafe stop**) can commit preserved sandbox work once everything is dead.
- Claude adjudication of a Codex failure retries once on an unparseable reply. Hitting the CLI `--max-turns` budget is logged as a distinct outcome from a crash; `AGENT_LOOP_MAX_TURNS` (default 40) interpolates into the default implement commands.
- Opt-in forge check after a successful push (`AGENT_LOOP_CI_WAIT_S`, default 0 = off). A red check returns the task to changes requested and does not let a successor chain onto that branch. No checks, missing credentials, unknown forge, or still-pending at the cap are a clean skip. Verify commands may print `AGENT_LOOP_VERIFY_SCOPE:` so a scoped run is visible in the log.

## 1.0.10

- Refuse `AGENT_LOOP_VERIFY` commands that point back into the primary repository, because they can silently verify the wrong tree and return an incorrect verdict. The startup error shows the repo-relative sandbox-safe command; `AGENT_LOOP_VERIFY_ALLOW_PRIMARY=1` is available for deliberate opt-out.
