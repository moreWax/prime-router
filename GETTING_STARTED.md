# Getting started

[Overview](README.md) · [Architecture and diagrams](ARCHITECTURE.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [MIT license](LICENSE.md)

## Before you install

You need Prime Agent with package loading and native RLM children, plus account access to your chosen role models. The recommended lineup is controller `openai-codex/gpt-6-astra`, author `openai-codex/gpt-6-sol`, and reviewer `openai-codex/gpt-6-luna`. Each exact selector must appear in Prime's **live executable-model catalog**. A catalog entry alone does not prove that native child admission will succeed.

The recommended lineup is not the current built-in lineup. The current source defaults are controller `openai-codex/gpt-6-astra`, author `openai-codex/gpt-5.6-sol`, and reviewer `openai-codex/gpt-5.6-luna`.

## Install

Install from the public GitHub repository; no private-repository authentication is required:

```sh
prime-agent package install git:github.com/moreWax/prime-router
```

Or install a source checkout without renaming its folder:

```sh
prime-agent package install /absolute/path/to/prime-router
```

These are documented Prime Agent Git and directory package sources. They install to user settings by default. To install for one project, run either command from that project's root with `--local` at the end. The repository is public, but `package.json` sets `"private": true`, so npm publication is disabled. In an already running session, enter `/reload` to reload the installed extension after installation or edits **to that installed copy**. Updating a separate source checkout does not update an already installed Git package; update the installed package first. `/reload` does **not** restart Prime's daemon or session worker, upgrade the runtime, or add host APIs.

In a supported **root** Prime session, select the effective controller model yourself. Then request an ordinary coding task; no `/router` prefix is required. `/router <task>` explicitly sends a task through the workflow after checking the executable child selectors. It will not change your parent session or active model. The extension disables routing in native children and sessions without a verified root header (`rlmDepth === 0`).

## Configure roles

Run `/router models` to see effective selectors and whether the active parent matches the controller. In a UI, bare `/router` also opens a role/model picker; without a UI it shows status and help. To apply the recommended GPT-6 lineup to the current session, first confirm all three exact selectors in the live executable-model catalog, then run:

```text
/router model controller openai-codex/gpt-6-astra
/router model author openai-codex/gpt-6-sol
/router model reviewer openai-codex/gpt-6-luna
```

Other explicit controls work in either mode:

```text
/router model <role> <provider/model-id>
/router default <role> <provider/model-id>
/router reset <role>
/router reset all
```

Replace `provider/model-id` with an exact selector shown in Prime's **live executable-model catalog**. Model overrides and resets need an idle session and affect later turns, not in-flight work. `/router default <role> <provider/model-id>` may run while busy but changes **only new sessions**. A session freezes its defaults at creation, and branch-local overrides survive reload/resume. `/router reset <role|all>` clears overrides back to that session's **frozen defaults**, not recently saved defaults. Router does not automatically migrate defaults, session snapshots, or overrides when built-in selectors change. Changing the configured controller never switches your active parent model.

After an upgrade, check `/router models`. If old selectors are overrides, reset them only if the frozen defaults are suitable. If frozen defaults are stale, use `/router model` with the recommended GPT-6 selectors above, or choose other selectors from the live executable catalog. Use the corresponding `/router default` commands only when you want those selectors for future sessions. Saved defaults are in Prime Agent's agent directory under `router/models.json`; a malformed file blocks new snapshots and saved-default writes rather than being silently overwritten. Existing valid frozen snapshots can still use current-session controls. Do not put secrets in model selectors.

## If a child cannot start

1. Check `/router models` and select the matching controller parent model yourself.
2. Run `prime-agent model list` for a catalog view. A listing does **not** prove native child authorization. The `/router <task>` preflight requires Prime's `modelRegistry.getExecutableModels()` and both effective child selectors in its live results; if discovery fails, it sends no task.
3. For a more precise diagnosis, in the current controller Python REPL run `await rlm.find_models("<model-id>")` for author and reviewer. Exact `rlm.spawn(..., model="provider/model-id")` admission is authoritative. Do not substitute an unapproved model silently.

The ordinary-language workflow relies on the controller making decisions after native child follow-ups. A missing follow-up or failed admission can stop progress. Inspect the run checkpoint and native child status rather than treating silence as success; see [Architecture](ARCHITECTURE.md).

## Optional Herdr child viewers (advanced integration)

This bridge is **off by default** and is not required for Router. In a genuine Herdr terminal attached to your existing **root controller session**, enter:

```text
/router herdr on
/router herdr status
/router herdr sync
/router herdr off
```

Bare `on` uses authenticated invoking-client metadata from Prime's optional command-scoped `getInvokingClientContext()` host API. It does not ask for or infer a session ID, socket, launcher, or pane. The API must exist in the **running daemon and affected session worker**. If you changed Prime source, restart both through your installation's supported lifecycle and resume the **same saved session**; restarting only the daemon can leave an old worker. `/reload` only reloads Router. No exact released host version is claimed. Missing API or Herdr caller fails with guidance, not an environment guess. A legacy inherited-context binding should be turned off from its original Herdr environment before using bare `on` elsewhere.

`on` attempts an initial sync. `status` reports opt-in, tracked viewer records (**not currently verified ownership**), deferred count, observed activity, last successful sync, and fixed error categories; it hides transport paths. `sync` retries after missed parent events. `off` closes only panes with exact verified Router ownership; it can drop a proven-absent viewer record. A freshly split pane racing `off` might remain untagged and require manual recovery, rather than risk closing an unowned pane.

Each eligible live **direct** child gets a viewer pane attached to its existing native session, not a second agent. At most eight tracked viewers retain their slots; later children are deferred, not a global sync failure. After a verified viewer disappears, Router recreates it only if successful strict workspace inventory for the bound caller proves the pane absent. Inventory errors, missing caller origin, and mismatched ownership fail closed or retain the record; do not force a replacement by guessing. Child activity is reported as `working` **only** if native `isStreaming` or `isCompacting` is explicitly true; otherwise it is `unknown`, not inferred `idle` or `done`. Updates occur on supported parent events and can lag until another event or manual `sync`. The intended Herdr **Agents sidebar** entry per child is **not yet verified by a live Herdr test**; pane creation alone is not proof. This inventory behavior was checked against Herdr **0.9.1, protocol 22** and mocked tests, not a live Herdr control session. The bridge does not change role models or the active parent session. See [Architecture](ARCHITECTURE.md) and [Security](SECURITY.md) for trust and lifecycle limits.

**Troubleshooting only:** `/router herdr on <absolute-prime-daemon-socket> <absolute-prime-launcher>` retains an explicit path when genuine inherited Herdr context exists. The packaged `bin/herdr-bind.mjs` helper plus `/router herdr bind <absolute-descriptor-path>` can bind an existing root from its genuine Herdr pane. These paths require the same live root and daemon, not guessed or borrowed values; bare `on` never falls back to them. Explicit command paths with spaces are unsupported. The descriptor expires after 120 seconds and is claimed once. Windows viewer shell execution is not supported. Follow [Security](SECURITY.md) before using either advanced path.
