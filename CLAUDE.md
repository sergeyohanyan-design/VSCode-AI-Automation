# Working on Agent Loop

## The release rule — mandatory, every time

Any change to the tool ships as a release. Not "when it feels significant" — the
tool is distributed as a `.vsix` that does **not** auto-update, so a fix that is
only on `main` reaches nobody. Every time work lands on `src/`, `examples/`, the
config example, or the docs:

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
   publish if the tag disagrees with `package.json`, and attaches the artifact
   plus `SHA256SUMS.txt` to a GitHub release.

The local `.vsix` is gitignored on purpose — the downloadable artifact is built
from the tag by CI so it can never drift from the source.

## Redistribution — this repo ships to strangers

Nothing project-specific, machine-specific or personal may enter a shipped file:
no absolute paths, no ClickUp list ids, no tokens, no references to whatever
repository the tool is being exercised against. `npm test` enforces part of this;
the rest is judgment. Defaults are generic or absent, never someone's board.

The same applies to packaging: vsce honors `.vscodeignore` and ignores
`.gitignore`, so anything local must be listed in **both**.
