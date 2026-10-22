# Changelog

## 1.2.2

- The headless Claude command no longer passes `--bare`. That flag accepts only an API key, so a subscription login failed every call with "Not logged in". When the watcher starts in full mode it sends `Reply with exactly: OK`. A failure is one watcher-log line, and only the playbook runs after that.
- The watcher no longer stops on the tick that follows Start, before the dispatcher has written its lock. It stays up until it has seen that run, or for 2 minutes with no dispatcher. The 3-second poller starts it again when the loop is running and the timer is gone.
- A new dispatcher run (a new lock nonce, or Start) drops the previous run's log lines, error counts, quiet windows, holds, and probe marks. Fix counters stay for their 6 hour limit. Playbook rows match only lines after the latest `=== start:` line. `STOP: no coder available` counts only when it happens 3 times within 15 minutes.
- A short reviewer cooldown whose clock time is already earlier than the log line is the next day. A line at 23:00 that says `try again at 2:31 AM` waits. It does not stop the loop.
- Exit 0 with a JSON verdict is a successful Claude call. The word "quota" in that verdict is not an auth failure. Auth or quota text counts only on stderr of a non-zero exit.
- A kill that misses the process group tries the pid itself. The lock and a new start happen only after the pid is gone, polled for up to 10 seconds. If it is still alive, the watcher writes the stop report and leaves the lock in place.

## 1.2.1

- The bundle sent to headless Claude for an unknown problem includes the churn tally from `~/.agent-loop-rounds.json` (`AGENT_LOOP_ROUNDS`). A missing or unreadable file is sent as no tally. The same resolved path is passed to the dispatcher the button starts.

## 1.2.0

- Heartbeat file (`~/.agent-loop-heartbeat.json`). The dispatcher rewrites it when the pass loop changes stage and on the stage runner's existing progress tick. The lock file's mtime is not liveness: it keeps moving after the pass loop has stopped. After Safe Stop the stage is `stopped`.
- Watcher in the extension host, on while the loop runs. It reads the heartbeat and new dispatcher-log lines from a saved byte offset. Known failures get a fixed response: repair, wait, report, or Safe Stop. An unknown frozen loop or an unknown error that repeats 3 times in 15 minutes is sent to headless `claude -p` (no tools, no project settings, 120s) and only an allowlisted action can run. Without Claude, the fixed playbook still runs.
- The watcher does not read the env file except non-secret state paths, does not hold the board token, does not edit git or the board itself, and does not restart a loop you stopped. Two automatic fixes of the same signature in 6 hours is the default cap; the next one stops the loop. Report: `~/.agent-loop-watcher-report.md`. Command: **Agent Loop: Open the watcher report**.
- A zero-commit local branch with no remote is deleted by `node src/agent-loop.mjs --reset-stub <task-id> --yes`, and the task is set back to ready, only when the loop is stopped. A branch that has commits, or a remote copy, is left alone. A coder that is out of credit is benched for at most 24 hours by `--bench-coder <name> --yes`; the dispatcher treats that coder as down until the file expires. Both commands re-check their preconditions. The watcher does not hold the board token.
- Settings: `AGENT_LOOP_WATCHER`, `AGENT_LOOP_WATCHER_CMD`, `AGENT_LOOP_WATCHER_POLL_S`, `AGENT_LOOP_WATCHER_MAX_FIXES`, `AGENT_LOOP_WATCHER_MAX_CALLS_PER_H`, `AGENT_LOOP_WATCHER_REPORT`, `AGENT_LOOP_WATCHER_LOG`, `AGENT_LOOP_WATCHER_STATE`, `AGENT_LOOP_WATCHER_CODER_LOGS`, `AGENT_LOOP_HEARTBEAT_FILE`, `AGENT_LOOP_BENCH_FILE`.

## 1.1.6

- Codex usage. The Codex availability probe was a full `codex exec` asking for "OK": about 18,000 input tokens per probe, every pass with work on the board. It is now `codex login status`, which uses no tokens. It also no longer falls back to `AGENT_LOOP_CODEX_CMD`, which is an inference command. Quota is learned from the real review instead. A quota rejection happens before inference.
- An unavailable Codex review (quota, or a crash mid-review) used to leave the task in review, and the next 60-second pass ran the whole review again. Codex is now benched until the reset time in its output, or for 15 minutes when there is none. The bench also applies to the rest of the same pass.
- Codex reviews default to `model_reasoning_effort="medium"` (was `high`). One high-effort review was measured at 1.82M input tokens, with 122k in its final request, because each agentic turn re-sends the context.
- Review prompts replace lockfile diffs (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, `go.sum` and others) with a one-line stub, and tell the reviewer to read only the changed files plus what an acceptance item needs, and to run only the tests that cover the change. The empty-diff check still sees the full diff, so a lockfile-only change is not blocked as empty.
- Selftest probes: `codexOverride` (default probe is `codex login status` even with a review override set), `benchProbe`, `lockfileFilter`.

## 1.1.5

- Republish of 1.1.4. Open VSX accepted 1.1.4 and left that version inactive, so it never became installable. Deleting it would reserve the version number permanently. The Windows Safe Stop exit fix is unchanged.

## 1.1.4

- On Windows, Safe Stop logged completion and left the dispatcher process running. The job-object helper was started with open stdin and stdout pipes and was only killed from the process `exit` handler, which cannot run while those pipes are still open, so the process and the helper waited on each other. The lock heartbeat kept touching the lock, and the next start was refused as already running. Returning from `main` now ends the helper (close its stdin, then kill it if it is still alive after a short wait), stops the heartbeat, and releases the lock when this process still owns it. The helper and its pipes are unref'd so they cannot keep the process alive by themselves. The `exit` handler still kills the helper if that shutdown did not run. The selftest probe `winJobShutdown` starts the helper in a child process, returns from main, and requires that child to exit within a few seconds. Other platforms skip the probe.

## 1.1.3

- The implement idle watchdog counted only child stdout and sandbox writes as progress. An agent that reads files and reasons produces neither, so one task burned 11 rounds in a night: each kill landed about 9 minutes in, after inference turns and successful tool calls, and left a branch with no commits. The chain then sat idle for about 11 hours. Before an idle kill, the watchdog now reads process-tree CPU once per quiet window. Growth counts as progress. A missing snapshot counts as progress too, so unreadable CPU waits for the wall-clock ceiling instead of killing a live agent. The ceiling is unchanged. The first quiet window only records a baseline, so a process that never burns CPU is stopped on the next window, not the first. A process wedged in a CPU spin also burns CPU, so the idle path no longer catches it; the wall ceiling was already that bound. Reverting the two `armIdle` calls makes `cpuBusySurvives` fail with code 124 at about 4 seconds. `cpuLiveness` fails if an absent root is summed as 0 instead of null. The POSIX `ps` snapshot (`ps -A -o pid=,ppid=,time=`) was executed under WSL and parsed, 119 of 119 rows; the live idle-kill probe has been run on Windows only.

## 1.1.2

- Hitting `AGENT_LOOP_MAX_ROUNDS` triggered a Claude re-scope, and a successful AC auto-repair called `resetRounds()` before returning the task to `ready`. Nothing counted the re-scopes, so every repair handed the task a fresh round budget. Measured on a real chain: one task re-scoped twice, was entitled to ~15 rounds, burned ~10, and grew its diff from 2180 to 3542 lines — while the durable tally never read above 4/5, which is why the cap looked like it never fired. `AGENT_LOOP_MAX_RESCOPES` (default 1) now bounds automatic repairs; 0 disables auto-repair entirely, so the first churn cap parks on `stalled` for a human. Capping rounds harder, or shrinking the task, does not work: size does not predict churn. The selftest probe `rescopeBudget` fails if the re-scope tally shares the round key that auto-repair resets.

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
