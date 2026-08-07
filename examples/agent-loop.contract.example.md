Copy this file into your repository as `tools/agent-loop.contract.md` and replace the contents with
your own project rules. Everything in it is appended verbatim to every implement and review prompt,
so keep it short and imperative — it is a standing instruction, not documentation.

Delete the file (or leave it absent) and nothing is appended; the dispatcher carries no
project-specific instructions of its own.

---

EXAMPLE — replace all of the following:

- Every user-facing string goes through the i18n layer. Never hardcode display text.
- Every bugfix ships with a regression test that fails without the fix.
- Do not add a dependency for something the standard library already does.
- Public API changes require the OpenAPI spec in `docs/api.yaml` to be updated in the same commit.
- Database changes go in a migration; never edit an existing migration that has shipped.
