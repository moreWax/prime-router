# Prime Router

Prime Router is a **Prime Agent capability package** for coding work in your existing controller session. It guides the controller to use **native, visible Prime children** for implementation and review. Ask for a change in ordinary language; `/router` is optional.

## Recommended model lineup

| Role | Recommended selector | Job |
| --- | --- | --- |
| Controller | `openai-codex/gpt-6-astra` | Plan, delegate, check evidence, and answer in the current parent session |
| Author | `openai-codex/gpt-6-sol` | Implement and run focused checks |
| Reviewer | `openai-codex/gpt-6-luna` | Review and run tests; instructed not to edit |

Apply the lineup to the current session with exact selectors:

```text
/router model controller openai-codex/gpt-6-astra
/router model author openai-codex/gpt-6-sol
/router model reviewer openai-codex/gpt-6-luna
```

Use these selectors only when all three appear in Prime's **live executable-model catalog** and your account can run them. `/router model controller` configures Router but does not switch the active parent model; select the matching controller in Prime. Router never silently substitutes a model.

This is the **recommended configuration**, not the current source defaults. The current built-ins are controller `openai-codex/gpt-6-astra`, author `openai-codex/gpt-5.6-sol`, and reviewer `openai-codex/gpt-5.6-luna`.

[Getting started](GETTING_STARTED.md) · [Architecture and diagrams](ARCHITECTURE.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [MIT license](LICENSE.md)

## Start in a minute

Install directly from the public GitHub repository using Prime Agent's documented Git package source:

```sh
prime-agent package install git:github.com/moreWax/prime-router
```

Or install a checked-out copy with `prime-agent package install /absolute/path/to/prime-router`. Add `--local` to either command from a project root for a project-scoped install; otherwise the install is user-scoped. In a running session, use `/reload` to load the installed extension after installation or edits to its installed copy; update an installed Git package separately. `/reload` does **not** upgrade the Prime daemon, its session worker, or host APIs.

Select the effective controller model in a **root** Prime session, then ask for a coding task, such as “Add input validation and tests for this endpoint.” For an explicit task, use `/router <task>`. If delegation is unavailable, inspect `/router models` and the live executable-model catalog; an exact native child spawn is the final access check. See [Getting started](GETTING_STARTED.md) for setup and troubleshooting.

## What it does

- Supplies a per-turn workflow to the existing matching controller. The controller may checkpoint a run in `.router/runs/<run-id>/state.json`, spawn an author, inspect the diff, request a reviewer/test run, and ask for bounded fixes. Simple noncoding questions need no child.
- Lets you set role selectors with `/router model <role> <provider/model-id>` for this session, `/router default <role> <provider/model-id>` for **new** sessions, and `/router reset <role|all>` to clear current overrides back to **this session's frozen defaults**. `/router models` shows the effective settings. Router does not migrate old saved settings or frozen snapshots when built-ins change.
- Offers an **optional, default-off Herdr bridge** for viewer panes attached to existing native direct children. From a genuine Herdr terminal attached to the root, use `/router herdr on`, then `/router herdr status|sync|off`. It requires Prime's optional invoking-client host API in both the running daemon and session worker; source changes and `/reload` alone cannot supply that API. The bridge retains up to eight tracked child viewers and defers excess children instead of failing the whole sync. It only recreates a missing viewer after strict successful workspace inventory proves absence; ownership mismatches remain for manual recovery. The goal is one child per Herdr Agents-sidebar entry, but **live sidebar recognition is unverified**. See [Getting started](GETTING_STARTED.md) and [Architecture](ARCHITECTURE.md).

## Limits and status

Router is **prompt-guided orchestration**, not a job scheduler or a replacement parent session. It depends on the controller's decisions and Prime's native child reply/exit follow-ups. It does not launch shadow agents, switch the parent model, guarantee autonomous continuation when a follow-up is missing, or enforce reviewer read-only access as a permission boundary. An optional Herdr viewer is not another model agent; event-driven updates may lag. Check [Security](SECURITY.md) before handling sensitive tasks or enabling Herdr.

Source tests and pack checks cover types, mocked behavior, and package contents. They **do not** prove live child admission, model entitlement, or Herdr sidebar behavior. The GitHub repository is public, but `package.json` sets `"private": true`, so npm publication remains disabled. No release version is claimed here. See [Contributing](CONTRIBUTING.md) for checks.
