# Prime Router

`prime-router` is a Prime Agent capability package that guides an existing controller session through coding work. The built-in role models are **`openai-codex/gpt-6-astra` as controller**, **`openai-codex/gpt-5.6-sol` as code author**, and **`openai-codex/gpt-5.6-luna` as reviewer/test runner**. Configure roles with `/router`; effective role models can differ from the built-ins. No shadow agent or replacement parent session is started. The workflow is inspired by pi-analyst-worker-orchestrator, but does not include or execute that extension.

[Getting started](GETTING_STARTED.md) · [Architecture](ARCHITECTURE.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [MIT license](LICENSE.md)

## Use

Install this package in Prime Agent, select the controller model, and ask for a coding change in ordinary language. **`/router` is optional.** See [Getting started](GETTING_STARTED.md) for installation scopes, `/reload`, and model-access checks. Availability of configured model selectors depends on your Prime installation, live catalog, and account access; no model is silently substituted.

On a controller turn, the extension supplies the bundled workflow. The controller can create a run checkpoint in `.router/runs/<run-id>/state.json`, ask the configured author to implement, inspect the result, ask the configured reviewer to review and run checks, then request bounded author fixes. It reports results or an operator blocker. Simple noncoding questions do not need children. [Architecture](ARCHITECTURE.md) describes the hooks and native follow-ups.

Role settings are explicit: `/router model <controller|author|reviewer> <provider/model-id>` overrides a role in the current session; `/router default <role> <provider/model-id>` saves a default for **new** sessions; `/router reset <role|all>` restores frozen defaults in the current session. `/router models` shows effective settings. Current-session changes require an idle session and affect later turns, not in-flight work. See [Getting started](GETTING_STARTED.md) for UI and non-UI use. Changing the controller setting never switches the active model.

Router does not migrate saved settings or session metadata when built-in selectors change. After upgrading, inspect `/router models`. Use `/router reset author` and `/router reset reviewer` only to clear session overrides; reset still restores that session’s frozen defaults. Use `/router default author openai-codex/gpt-5.6-sol` and `/router default reviewer openai-codex/gpt-5.6-luna` for new sessions. If the frozen defaults in the current session are stale, use the corresponding `/router model` commands for that session.

## Optional Herdr child panes

Herdr integration is **off by default**. In a genuine Herdr terminal attached to your existing Prime **root** controller session, enter `/router herdr on`. Router takes the invoking client's Herdr pane and Prime daemon/launcher context from the updated Prime host; you do not paste a session ID, socket, launcher, or descriptor. Use `/router herdr status` to inspect state, `/router herdr sync` after a missed event, and `/router herdr off` to disable the bridge and close only verified Router-owned panes. This needs updated Prime **source runtime code** in both the daemon and the affected session worker. Restarting the daemon alone may leave an old worker running; use Prime’s supported lifecycle to restart that worker and resume the same saved session before enabling the bridge. `/reload` only reloads Router and cannot add a host API. No published release or version is promised. Existing processes are not upgraded by source edits. For a legacy contextless inherited binding, use `/router herdr off` from its original Herdr environment before switching to one-command setup. If the capability or Herdr caller is missing, the command fails with guidance instead of guessing from process environment. Explicit transport arguments and the terminal bind helper remain advanced troubleshooting options, not normal setup. See [Getting started](GETTING_STARTED.md).

The integration aims to show **each native direct child in Herdr's Agents sidebar**, not just a dashboard. For each verified child, it creates a separate Herdr pane that **attaches to the same native Prime child session**; it does not spawn another model agent or replace the parent. A pane alone does not prove Herdr has registered or recognized an Agents-sidebar row. This requires a later live test in Herdr; it has **not** been verified here. Child updates are event-driven snapshots and can lag until the next parent event; they are not guaranteed real-time. Herdr does not change `/router model`, `/router default`, or the active session model.

This is **prompt-guided orchestration**, not a deterministic job scheduler. Continuation needs Prime's native child reply/exit follow-ups and the controller's decisions. The reviewer's prompt-based read-only role is not a permission boundary; use separate worktree or tool restrictions where needed. Run artifacts can contain sensitive task text and logs. See [Security](SECURITY.md).

## Development

Run `npm test` and `npm run pack:check` in the source checkout. These check types, mock extension behavior, validate package contents, and dry-run packing; they do not prove live model admission or end-to-end orchestration. See [Contributing](CONTRIBUTING.md).

The `prime-router` package manifest lists the extension, workflow skill, and all linked documentation, including the unchanged [MIT license](LICENSE.md), for packing. Check the actual tarball before distribution.
