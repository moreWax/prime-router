# Changelog

[Overview](README.md) · [Getting started](GETTING_STARTED.md) · [Architecture](ARCHITECTURE.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [License](LICENSE.md)

## Unreleased

- Change the built-in author and reviewer selectors to `openai-codex/gpt-5.6-sol` and `openai-codex/gpt-5.6-luna`; keep the controller at `openai-codex/gpt-6-astra` and preserve explicit saved and session settings.
- Rename the package to `prime-router` (Router), the optional command to `/router`, and the workflow paths to `extensions/router.ts`, `skills/router/SKILL.md`, and `.router/runs/`. Astra/Sol/Luna remain the built-in exact role selectors; configured effective models may differ.
- Add `/router` role/model selection, `/router models` effective view, current-session overrides, saved defaults for new sessions, and reset to frozen session defaults. Configuration does not switch the parent model or bypass native admission.
- Document install scopes, model-access checks, hook behavior, native child lifecycle, recovery limits, security limits, and contribution checks.
- Keep the Go skill reference portable by requiring discovery of the installed skill instead of a machine-specific path.
- Add in-progress, opt-in Herdr bridge for verified native direct children. From an attached Herdr terminal in the existing Prime root, bare `/router herdr on` uses the real command-client context supplied by the optional Prime host `getInvokingClientContext()` API; no user-supplied session ID, socket, launcher, or descriptor is needed. This requires updated Prime **source runtime code**, restart of both daemon and affected session worker through the supported lifecycle, and resumption of the same saved session. Restarting the daemon alone may leave an old worker; `/reload` cannot add the API. No release version or publication is asserted. Missing host/caller context fails with guidance, not an environment guess. Explicit transport arguments and the one-use `bin/herdr-bind.mjs` descriptor remain advanced troubleshooting options. The bridge attaches separate viewer panes to the existing direct child sessions without spawning replacement agents or changing role models. Reconciliation is event-driven and can lag; Herdr Agents-sidebar recognition still needs a live test.

No release date or published release is asserted here. The `prime-router` package manifest currently declares version `0.1.0`; it is marked private and is not published automatically. See [Getting started](GETTING_STARTED.md) for local use.
