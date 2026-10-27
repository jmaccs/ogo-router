# OGO budgeted router

This Pi extension registers `ogo/auto`, routes each user request through the
categories in `ogo.json`, and keeps tool continuations on the model that
answered the user request. Select it with `/model` or `--model ogo/auto`.

Install this directory as a Pi package with `pi install .`, then start Pi and
select `ogo/auto`.

## Routing

- `low` allows tiers 0-1, `medium` allows tiers 0-2, and `high` allows tiers
  0-2 while the budget state permits them. Tier 3 is not a conductor model.
- Request text is classified with lightweight keyword rules. Edit
  `classifyCategory()` in `index.ts` if your prompts use different vocabulary.
- Category primaries and fallbacks are in `ogo.json`; tier assignments,
  quota estimates, and OpenRouter consultant models are in `router.json`.
- Delegation considers only models explicitly listed for a role's configured
  tiers. Within each tier it prefers available tool-capable OpenCode Go models
  with lower catalog input-plus-output prices.
- `direct` requests (such as compaction) use tier 0. Continuations stay on the
  current model while it remains under the live tier and quota caps; otherwise
  they downgrade. A classified transient provider error retries the model once,
  then applies a session-state cooldown and advances through eligible fallbacks.
- Tier 3 is not selected by the conductor. It remains available only to
  delegation roles configured for it, is billed separately, and is excluded
  from the Go quota estimate. Non-Go USD caps are currently disabled.

## Go usage and local reconciliation

Set `OPENCODE_API_KEY` in Pi's environment to enable the authoritative Go usage
request:

```text
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer $OPENCODE_API_KEY
```

The expected response contains `usage.rolling`, `usage.weekly`, and
`usage.monthly`, each with `status`, `percent`, and `resetsAt`. The extension
fetches on session start and after agent runs, throttled to at most once per
minute. Successful snapshots are cached in
`~/.pi/agent/ogo-router-usage-snapshot.json`.

Assistant usage is also appended to `~/.pi/agent/ogo-router-usage.jsonl`.
Requests observed by Pi since the last snapshot are shown as a separate
optimistic request-count delta; they are not added to the API percentages
because the API reports percentages, not a per-request conversion. If the
endpoint is unavailable or `OPENCODE_API_KEY` is missing, the meter falls back
to a clearly labeled local quota-weighted request-fraction estimate based on
per-model quotas in `router.json`. The local five-hour window rolls from the
current time; early-window pace estimates use conservative elapsed-time floors.
Local estimates cannot observe usage from other clients and are not an
account-wide balance. A previously successful snapshot is retained and labeled
stale when refresh fails.

Malformed or torn ledger lines are skipped with a warning. Valid entries are
indexed incrementally in memory, including appends made by other Pi processes.

The meter uses `resetsAt` with 5-hour rolling and 7-day weekly windows; the
monthly pace estimate uses the calendar month preceding `resetsAt`. Usage
pressure has green/yellow/orange/red states with hysteresis. Red pressure caps
routing at tier 1; orange caps at tier 2. Local per-model request caps from
`router.json` remain an extra fallback guard for individual models.

For isolated tests, `OGO_ROUTER_DATA_DIR` overrides the default data directory.

## TUI dashboard

When Pi starts inside tmux, OGO automatically creates a detached 42-column
split to the right of Pi's pane. This side panel shows the current budget
pressure and tier, usage bars, pace/source, and warnings. API window status,
Pi's request counts since the last sync, and models.dev catalog freshness are
grouped in a **Status** section at the bottom of the panel. The panel refreshes
from OGO's dashboard snapshot without writing these lines into the main editor
or its status/widget areas. OGO closes its sidebar pane at session shutdown.

The `/ogo-ui` command is available for the Pi UI sidebar fallback when tmux is
not available. Delegate output is handled separately: when the OGO tmux
sidebar is open, up to three delegate log panes can be stacked beneath it.
Each tails that task's log and closes after completion (15 seconds on success,
two minutes on failure); additional tasks continue without a dedicated pane.
Without tmux or an open sidebar, delegation still runs and writes task logs,
but no delegate pane is opened.

Set `OGO_ROUTER_DATA_DIR` to change the location of the dashboard state file,
usage ledger, catalog cache, and delegation logs/results from their default
`~/.pi/agent` directory.

## Model catalog and pricing

`router.json` configures the models.dev catalog endpoint, provider, refresh
interval, and timeout. The extension checks the provider catalog at most once
per 24 hours, with a 90-second request timeout, and caches parsed OpenCode Go
metadata in `~/.pi/agent/ogo-model-catalog.json`. Attempt timestamps (including
failures) are persisted separately to avoid repeated slow requests. Failed
refreshes retain the previous cache and leave the configured model order in
place when no catalog is available.

Fresh catalog prices rank candidates only within their configured delegation
tier. The input and output values are a relative selection score, not a Go
quota conversion or a prediction of an individual request's cost. Tool
capability metadata prevents selecting models explicitly marked as unable to
call tools. Pricing changes are logged by model ID and shown in the budget
side panel. New models are not automatically added to tiers: `router.json`
remains the explicit allowlist and budget boundary.

## Delegation

The `delegate` tool launches isolated `pi --mode json -p --no-session
--no-extensions` subprocesses. Each invocation receives only its bounded task
brief, acceptance criteria, role instructions, and explicitly allowlisted skill
content; it does not inherit the conductor's conversation or load extensions
that could duplicate parent-side usage accounting. The conductor remains
responsible for choosing a role, integrating results, and accepting edits.

Role profiles and their output contracts live in [`agents/`](./agents/). Their
`tier` and `fallback_tiers` are clamped to the current budget cap and available
authenticated models in `router.json`. Retries move through at most three
candidate models, favoring provider diversity. Only rate-limit, server, and
network failures cool down a model/provider or permit a retry; provider circuits
use jitter and a single half-open probe. Timeouts and task/tool errors do not
trip provider breakers, and no role is retried after issuing a tool call. Role
tool lists are intersected with tools active for the current session;
recursive `delegate` and OGO budget tools are excluded. Skills are loaded only
from each role's `skills:` allowlist.

Parallel mode accepts up to four independent tasks and is restricted to roles
marked `parallel: true` (currently scout). Results above 32 KiB are saved under
`~/.pi/agent/delegate-results/` (or the configured data directory) and the tool
returns a bounded excerpt and file path. Delegated assistant usage is appended
to the usage ledger with its role, provider, model, cost, and timestamps; the
tool result also reports aggregated token and cost usage, including failed
attempts that produced usage data. Each task also writes a private log under
`delegate-logs/`; in tmux, its live output can be viewed in a temporary pane
below the OGO sidebar.

## Implementation status

The virtual router, Go usage meter, model catalog ranking, and isolated
delegation tool are implemented. The M3 escalation workflow (explicit
escalation requests and stuck/review triggers), M4 reviewer gate and durable
memory hooks, and M5 live-account validation and threshold tuning remain
planned. The Go usage behavior is covered with mocked responses; it has not
been validated against a live authenticated account. See
[`PLAN-CHECKLIST.md`](./PLAN-CHECKLIST.md) for milestone details.

## Development

Install dependencies and type-check:

```sh
bun install
bun test
bun run typecheck
```

The extension uses Pi's installed `@earendil-works/pi-coding-agent` API for
types; Pi itself supplies the runtime when loading the extension.
