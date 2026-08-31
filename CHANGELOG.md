# Changelog

## 1.0.10

- Refuse `AGENT_LOOP_VERIFY` commands that point back into the primary repository, because they can silently verify the wrong tree and return an incorrect verdict. The startup error shows the repo-relative sandbox-safe command; `AGENT_LOOP_VERIFY_ALLOW_PRIMARY=1` is available for deliberate opt-out.
