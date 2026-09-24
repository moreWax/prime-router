# Contributing

[Overview](README.md) · [Getting started](GETTING_STARTED.md) · [Architecture and diagrams](ARCHITECTURE.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md) · [MIT license](LICENSE.md)

This is a public repository. Work in a scoped branch, preserve unrelated edits, and use the repository's normal review process. Public visibility does not imply an npm release: `package.json` sets `"private": true`, so npm publication is disabled. Describe the behavior changed, tests run, and anything not verified in your review request.

## Reproduce source checks

Use Node.js **22.19.0 or later** in a source checkout:

```sh
npm ci
npm test
npm run pack:check
```

`npm ci` installs the lockfile-pinned dependencies. `npm test` runs `tsc --noEmit` and `tests/*.test.mjs` through Node's test runner. Extension tests exercise mocked Prime behavior, including routing/configuration and bridge failures. `pack:check` performs `npm pack --dry-run`; packaging tests also inspect its JSON file list. Inspect the tarball/file list and local documentation links before distribution. These checks **do not** establish live native-child admission, account model access, autonomous follow-up delivery, or Herdr Agents-sidebar recognition. The `@earendil-works/pi-coding-agent` dev dependency supplies local API/types, not an installed Prime runtime version. A successful source check is not an end-to-end host compatibility claim.

## Change and review

- Scope code changes, add focused tests, and update docs for observable behavior. Verify role precedence, frozen session defaults versus current overrides, reload/resume, controller matching, executable-model discovery failure, and malformed saved configuration where relevant.
- For Herdr changes, verify owner/session checks, strict Herdr 0.9.1/protocol 22 workspace inventory, deferred capacity, positive-only `working` reporting, and `off` races. In particular, a CLI or inventory error is not proof that a pane is absent; only successful validated caller-workspace inventory is. Record whether a live test on the required host API and actual Agents sidebar was possible. Mocked pane creation is not live sidebar proof. Never treat reviewer prompt instructions as a file permission boundary.
- Read [Architecture](ARCHITECTURE.md) and [Security](SECURITY.md) before changing native continuation, session metadata, or child-pane ownership. For Go contributions, use the installed `google-go-style` skill and its linked guide.
- Report test command exit codes and any skipped live checks. Do not use subprocess agents in place of native Prime children. Publication and release need separate maintainer action; `npm pack --dry-run` does not publish.

The package manifest is the source of truth for included files and extension/skill registration. Keep linked docs and the unchanged [MIT license](LICENSE.md) in the checked packed contents.
