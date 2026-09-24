# Getting started

[Overview](README.md) · [Architecture](ARCHITECTURE.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [License](LICENSE.md)

## Prerequisites

- A Prime Agent installation with native RLM subagents, package loading, and executable-model discovery for the optional `/router` preflight. Confirm capabilities against your installed Prime Agent, not this repository's development dependencies.
- Access to your configured controller, author, and reviewer selectors. The built-in defaults are `openai-codex/gpt-6-astra`, `openai-codex/gpt-5.6-sol`, and `openai-codex/gpt-5.6-luna`, respectively. Access is account- and catalog-dependent; these instructions do not promise universal entitlement or a future release.
- Node.js **22.19.0 or later** for development and test commands. The package's local dev dependency `@earendil-works/pi-coding-agent@0.86.0` supplies API/types for checks; **0.86.0 is not the version of the installed Prime Agent runtime**. One local runtime reported `prime-agent --version` as `0.9.6` and admitted native children with both built-in child selectors; this observation is not a supported-version range or a model-access guarantee.

## Install and activate

From a shell, use the absolute path to the `prime-router` source checkout as `<package-directory>` (the checkout folder need not be renamed):

```sh
prime-agent package install <package-directory>
```

This is the user-scope install. For one project, run from that project's root:

```sh
prime-agent package install <package-directory> --local
```

`--local` installs into the current project instead of the user configuration. In a running Prime session, use `/reload` after installing or changing the package. Start/select the configured **controller** as the parent model (the built-in default is `openai-codex/gpt-6-astra`). Ask for a normal coding task; no command prefix is needed. Optionally use `/router <task>` to send an explicit task. The command refuses a parent whose active model does not match the effective controller and never switches the model or session.

## Configure role models

In a UI session, bare `/router` shows effective settings and opens a role/model picker. Choose a role, a native executable model, and either current-session override or saved future default; cancel leaves settings unchanged. Without a UI, bare `/router` shows status/help. `/router models` shows effective settings without the picker in either mode, including while busy. Use explicit commands:

```text
/router model author provider/model-id
/router model reviewer provider/model-id
/router model controller provider/model-id
/router default author provider/model-id
/router reset author
/router reset all
```

`/router model`, `/router reset`, and the picker’s current-session choice require an idle session. These changes affect later turns, not work already in flight. `/router default <controller|author|reviewer> <provider/model-id>` (or the picker’s saved-default choice) can run while busy and saves a default for **new sessions**, not the current session. Each session freezes its defaults when created; overrides are branch-local session metadata that persist across reload/resume. `/router reset <role|all>` clears current-session overrides back to **that session's frozen defaults**, not the latest saved defaults. Use `/reload` after installing or changing the extension; it does not turn saved future defaults into current-session defaults. Router does not automatically migrate saved defaults, frozen session defaults, or overrides when built-in selectors change. After upgrading, inspect `/router models`. If an old author or reviewer selector is only a session override, clear it with `/router reset author` or `/router reset reviewer`. Reset does not bypass a stale frozen default. For a stale frozen current session, use `/router model author openai-codex/gpt-5.6-sol` and `/router model reviewer openai-codex/gpt-5.6-luna`. Set future sessions explicitly with `/router default author openai-codex/gpt-5.6-sol` and `/router default reviewer openai-codex/gpt-5.6-luna`. Saved defaults live under Prime Agent’s agent directory at `router/models.json` (schema version 1, optional `defaults.controller`, `defaults.author`, and `defaults.reviewer` selectors). Current-session metadata is separate. The file and session data can reveal your provider/model choices; do not put secrets in selectors. Invalid syntax, roles, or selectors produce an error rather than an automatic substitute; an explicit selector must appear in Prime’s executable-model catalog. A malformed saved defaults file is reported and never overwritten silently. It blocks new session snapshots and saved-default writes; an existing session with a valid frozen snapshot can still use its snapshot and current-session controls. Repair the file before saving future defaults. Changing the configured controller does **not** change the active parent model. Select the matching parent model yourself before delegation. Router requires an explicit root-session header `rlmDepth === 0`. Native children (`rlmDepth > 0`) are disabled even when their model matches. Older or unknown-depth sessions can lack a valid header and may not support configuration or automatic routing; start a supported root session rather than editing session data.

## Show native children in Herdr (opt-in)

In a genuine Herdr terminal attached to your **existing root controller Prime session**, enter:

```text
/router herdr on
```

That is the normal setup. Router uses the command's actual attached-client context from an updated Prime host: the invoking Herdr workspace/tab/pane and socket plus the Prime daemon socket and executable launcher for this session. You do **not** need to copy a root session ID, socket path, launcher path, package path, or descriptor. The command will not use stale process environment as a substitute. The host must expose the optional command-only `getInvokingClientContext()` API. Update the **Prime source runtime** and restart both the daemon and this session’s worker through Prime’s supported lifecycle; then resume the **same saved session** before trying the new command. A daemon restart alone can leave its old worker running. `/reload` only reloads the extension and cannot add the host API. Source or package edits do not upgrade processes that are already running. No exact published version or release availability is claimed. Do not use unverified stop/resume commands; confirm the lifecycle for your installation first. If a legacy binding was made with inherited context but no saved caller context, run `/router herdr off` from its **original Herdr environment** before enabling the one-command binding; do not overwrite it from a different client. If Prime lacks the API, Router asks you to update Prime Agent and retry from Herdr; if there is no Herdr invoking client, it asks you to invoke the command from your Herdr terminal. Do not switch to a different session or provide credentials to fix either case. Windows viewer shell execution is not supported.

### Advanced troubleshooting only

If you need the older explicit transport path and the extension already has genuine inherited Herdr context, `/router herdr on <absolute-prime-daemon-socket> <absolute-prime-launcher>` remains available. When attaching an existing root without inherited context, the packaged `bin/herdr-bind.mjs` helper can still create a private descriptor from the genuine Herdr pane, followed by `/router herdr bind <absolute-descriptor-path>` in that **same root**. These are not recommended setup steps and do not replace the one-command path. They require exact context for the same live root and daemon; do not guess or copy values from another session. Paths with spaces in explicit command arguments are unsupported. A descriptor expires after 120 seconds, is atomically claimed once and deleted even on validation or sync failure, and rejects wrong roots, symlinks, and unsafe permissions. There is no automatic fallback to the descriptor when bare `on` fails. See [Security](SECURITY.md) for its same-user trust limit.

Other controls in that root session:

```text
/router herdr status
/router herdr sync
/router herdr off
```

`on` (bare or explicit) or `bind` attempts an initial reconciliation. If it fails with no owned viewers, the bridge returns to off; if owned viewers remain, it preserves ownership for explicit cleanup. Before opening child panes, the public Prime CLI list must confirm this same live top-level root session on the selected daemon, and Herdr must confirm the caller pane. The enabled state, transport binding, caller context (from bare `on` or `bind`), and owned-pane registry are saved in branch-local session metadata. `status` reports enablement and owned viewer count, not a history of errors; command failures report errors. `sync` requests a manual reconciliation if a parent event was missed. `off` disables reconciliation and closes **only verified Router-owned panes**, not unrelated Herdr panes or Prime children. After resolving an error, inspect `status`: if on, try `sync`; if off, retry bare `on` from the attached Herdr terminal. Advanced explicit binding may require a fresh descriptor. Role-model settings are unchanged.

Each verified live **direct** Prime child is represented by its own pane that attaches to that child's **existing session** on the verified Prime daemon; the pane is a viewer, not a new model agent. Router checks native children using the public Prime CLI list. A role is assigned only when the child's exact model uniquely matches the configured author or reviewer; otherwise the label is `worker`. Pane metadata uses the child's actual name and model. Reconciliation runs after supported parent `tool_execution_end` and `agent_end` events, not by polling. Child-only changes may remain stale until the next parent event or manual `sync`; immediate terminal visibility is not promised. The intended result is separate entries in **Herdr's Agents sidebar**, but sidebar registration and recognition remain **unverified** until you run a live Herdr test. Do not treat a pane or dashboard entry alone as proof.


## Check models if delegation cannot start

1. Use `/router models` to inspect effective role selectors. Run `prime-agent model list` to inspect catalog entries. A listed model is **not** proof that a native child spawn is allowed.
2. In the controller's Python REPL, use `await rlm.find_models("<model-id>")` to diagnose author and reviewer availability. Match exact `provider/model-id` selectors. The actual `rlm.spawn(..., model="provider/model-id")` admission is authoritative.
3. `/router <task>` checks the live executable-model catalog for both effective child selectors before sending a task. If discovery is unavailable, fails, or omits a selector, it reports the issue and starts no task. Ordinary-task delegation still depends on native spawn admission. Check authorization and model discovery; do not silently replace a missing selector.

A successful source test does not establish live account authorization or a future Prime release's behavior. If a run pauses, consult its checkpoint and native child status rather than assuming the reviewer finished. [Architecture](ARCHITECTURE.md) covers recovery; [Security](SECURITY.md) covers local artifacts.
