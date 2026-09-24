# Contributing

[Overview](README.md) · [Getting started](GETTING_STARTED.md) · [Architecture](ARCHITECTURE.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md) · [License](LICENSE.md)

## Work locally

Use Node.js **22.19.0 or later** for source checks. Install the lockfile-pinned project dependencies, then run:

```sh
npm ci
npm test
npm run pack:check
```

`npm test` runs `tsc --noEmit` and Node's tests in `tests/*.test.mjs`; `pack:check` is an `npm pack --dry-run`. Extension behavior tests mock Prime's API to check prompt injection, role routing, command preflight, configuration, and failure handling. Packaging tests inspect the actual `npm pack --dry-run --json` file list. Check local documentation links before distribution. None of these checks prove live native child spawning, model authorization, or reliable follow-up delivery. Dev API/types at `@earendil-works/pi-coding-agent@0.86.0` are **not** the installed Prime Agent runtime version. Confirm runtime behavior separately in an authorized Prime environment and record commands and limits honestly.

Keep changes scoped and preserve existing user edits. For extension changes, update focused tests and document any behavior or model-access changes. Check role precedence, session branch/reload behavior, controller-match guards, selector validation, and malformed saved configuration in tests; mock checks do not establish live model access. Never use an alternate subprocess agent to validate the native tree. For Go-focused contributions, read the installed `google-go-style` skill and follow its referenced guide. Review [Architecture](ARCHITECTURE.md) and [Security](SECURITY.md) before changing continuation or artifact handling.

The `prime-router` package allowlist includes the extension, workflow skill, and seven linked documentation files. Verify actual packed contents before making distribution claims. Publication and releases require separate maintainer action; checks do not publish anything.
