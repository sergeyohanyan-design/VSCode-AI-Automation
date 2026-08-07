# Contributing to Agent Loop

Thank you for your interest in improving **Agent Loop**.

This project is publicly available as source-available software. Before contributing, please read the repository's `LICENSE.md` and `CLA.md`.

## License and contributor agreement

All contributions are subject to the **Contributor License Agreement (`CLA.md`)**.

By submitting a pull request or other Contribution intended for inclusion in the Project, you confirm that you have read and agree to the CLA.

The CLA allows the Project Owner to keep the public project available under its current source-available license while retaining the ability to offer separate commercial licenses or change licensing for future releases.

## Before opening a pull request

Please:

1. Search existing issues and pull requests to avoid duplicating work.
2. Open an issue first for substantial architectural changes or major new features.
3. Keep changes focused on one problem or feature where practical.
4. Add or update tests when behavior changes.
5. Update relevant documentation.
6. Avoid unrelated formatting or refactoring in the same pull request.
7. Make sure you have the right to contribute every part of your submission.

## AI-generated or AI-assisted code

AI-assisted contributions are welcome, but the contributor remains responsible for the submitted code.

Before submitting AI-generated or AI-assisted material:

- review it yourself;
- test it;
- check it for security problems;
- make sure it does not include secrets or confidential material;
- make reasonable efforts to ensure it does not reproduce third-party code under incompatible terms; and
- disclose substantial AI-generated portions in the pull-request description when that information may help reviewers.

## Third-party code and dependencies

Do not copy code, documentation, assets, prompts, datasets, or other material from another project unless its license permits inclusion in this Project.

If your contribution adds a dependency, include:

- the dependency name;
- its license;
- why it is needed; and
- whether it is required at runtime or only during development.

Do not add a dependency with licensing terms that would require the Project to be relicensed without discussing it with the Project Owner first.

## Development

The extension has no build step and no runtime dependencies. Node 18+ is the only requirement.

```
npm test                  # extension selftest + the dispatcher's own offline selftest
npm run package           # build the .vsix (needs @vscode/vsce installed globally)
```

`npm test` runs with no VS Code, no network and no ClickUp token. It also enforces two rules that
protect this repository, and a pull request that trips either will fail:

- **Redistribution guards** — no API token, machine-specific path, or ClickUp workspace/list id may
  appear in any shipped file.
- **Config documentation** — every environment variable the dispatcher reads must be documented in
  `agent-loop.env.example`. Adding a setting means documenting it in the same change.

To try the extension by hand, open this repository in VS Code and press `F5` to launch an Extension
Development Host.

Before submitting a pull request, make sure `npm test` passes and that `npm run package` produces a
`.vsix` without errors.

## Pull requests

A useful pull request should include:

- a clear description of the problem;
- a summary of the solution;
- testing performed;
- screenshots or recordings for visible UI changes, when relevant;
- any compatibility considerations; and
- any new permissions, network access, telemetry, external APIs, models, or services introduced by the change.

## Security issues

Please do not publicly disclose an exploitable security vulnerability before the Project Owner has had a reasonable opportunity to investigate it.

Report security issues privately to:

sergey.ohanyan@gmail.com

## Code of conduct

Be professional and constructive. Technical disagreement is welcome; personal attacks, harassment, and abusive behavior are not.

## Questions

For contribution questions, contact:

sergey.ohanyan@gmail.com
