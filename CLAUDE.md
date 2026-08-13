# Working on Agent Loop

## The release rule — mandatory, every time

Any change to the tool ships as a release. Not "when it feels significant" — a fix
that is only on `main` reaches nobody. Editors auto-update the extension, but only
for people who installed it from a registry, and only once the release is actually
*in* that registry: v1.0.7 reached GitHub, no registry, and therefore no editor.
Every time work lands on `src/`, `examples/`, the config example, or the docs:

1. **Bump `version` in `package.json`.** Patch for a fix or a doc change, minor
   for a new setting or command, major for a breaking config change.
2. **Update all four docs.** These are not optional and not "if relevant":
   - `README.md` — what the tool does and the configuration summary table.
   - `SETUP.md` — the manual walkthrough.
   - `AI_Setup.md` — the same procedure as a prompt for an editor agent. It is a
     *separate* audience; a change explained only in SETUP.md is missing here.
   - `agent-loop.env.example` — every setting the dispatcher reads, with the
     reason it exists. `npm test` fails on an undocumented key.
   If a change genuinely does not touch one of them, say which and why, rather
   than skipping it silently.
3. **Run `npm test`** — selftest plus the redistribution and config-drift guards.
4. **Build the `.vsix`**: `npx --yes @vscode/vsce package --allow-missing-repository`.
5. **Commit, then tag and push the tag.** The tag is what publishes:
   ```
   git commit -am "release: v<version>"
   git tag v<version> && git push origin main && git push origin v<version>
   ```
   `.github/workflows/release.yml` rebuilds the `.vsix` from the tag, refuses to
   publish if the tag disagrees with `package.json`, attaches the artifact plus
   `SHA256SUMS.txt` to a GitHub release, and publishes to **Open VSX** — which is
   where Cursor, VSCodium and Windsurf take their updates from. Open VSX indexes
   asynchronously, so a new version can 404 for a few minutes after a green run;
   confirm with `npx ovsx get SergeyOhanyan.agent-loop --metadata`.
6. **Upload the `.vsix` to the VS Code Marketplace by hand**, at
   <https://marketplace.visualstudio.com/manage>. This step is deliberately not
   automated and it is the one that gets forgotten — skip it and VS Code users
   silently stay on the previous version while Cursor users move on.

   Automating it needs an Azure DevOps *global* PAT, which Microsoft retires on
   **2026-12-01**. The sanctioned replacement (Entra ID workload identity +
   `vsce publish --azure-credential`) requires a user-assigned managed identity,
   which requires an Azure subscription, and the service-principal variant is
   reported to fail against a *personally-owned* publisher — which this one is.
   Decision: stay manual, and revisit in **November 2026**, before the deadline.

The local `.vsix` is gitignored on purpose — the downloadable artifact is built
from the tag by CI so it can never drift from the source.

## Never touch another project — no exceptions

This repository is a tool that *operates on other repositories and a live ClickUp
board*. Working **on** it must never mean running it **against** anything real.

- **Never `import()` or plain-`node` `src/agent-loop.mjs`.** It self-executes: a
  "does the module load?" check starts a real pass, probes the agents, and writes
  task statuses and comments to the live board. This has already happened once —
  a task in `in review` was flipped to `blocked` with a misleading PM comment,
  because the run's `REPO` was this checkout while the task's branch lived in a
  different repository. To check the file after an edit:
  `node --check src/agent-loop.mjs` parses without executing, and `npm test` is
  the sandboxed entry point.
- **Never edit, branch, reset or otherwise touch another project's files**, and
  never act on its ClickUp tasks, comments or statuses. Not to reproduce a bug,
  not to verify a fix, not "read-only, just this once".
- **Build testing infrastructure here instead.** `test/selftest.js` makes no
  network calls and `--selftest` simulates ClickUp, so a new behaviour gets a new
  case in that harness — not a trial run against real data.
- **If something genuinely needs a live board**, create a dedicated throwaway
  ClickUp list for this project and point the config at it. The real board is
  never the test fixture.

## Redistribution — this repo ships to strangers

Nothing project-specific, machine-specific or personal may enter a shipped file:
no absolute paths, no ClickUp list ids, no tokens, no references to whatever
repository the tool is being exercised against. `npm test` enforces part of this;
the rest is judgment. Defaults are generic or absent, never someone's board.

The same applies to packaging: vsce honors `.vscodeignore` and ignores
`.gitignore`, so anything local must be listed in **both**.
