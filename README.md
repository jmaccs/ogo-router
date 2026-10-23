# OGO budgeted router

This Pi extension registers `ogo/auto`, routes each user request through the
categories in `ogo.json`, and keeps tool continuations on the model that
answered the user request. Select it with `/model` or `--model ogo/auto`.

Install this directory as a Pi package with `pi install .`, then start Pi and
select `ogo/auto`.

## Routing

- `low` allows tiers 0-1, `medium` allows tiers 0-2, and `high` allows tiers
  0-3 while the budget state permits them.
- Request text is classified with lightweight keyword rules. Edit
  `classifyCategory()` in `index.ts` if your prompts use different vocabulary.
- Category primaries and fallbacks are in `ogo.json`; tier assignments,
  quota estimates, and optional OpenRouter escalation are in `router.json`.
- `direct` requests (such as compaction) use tier 0. Tool continuations stay
  sticky. A transient retry repeats the same model once; later retries move
  through the category fallback list.
- Tier 3 is OpenRouter's built-in provider and is only considered for a
  `high`-thinking architecture, deep-analysis, or ultrabrain request. It is
  billed separately and excluded from the Go quota estimate.

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
to a clearly labeled local request-count estimate based on `router.json`.
Local estimates cannot observe usage from other clients and are not an
account-wide balance. A previously successful snapshot is retained and labeled
stale when refresh fails.

The meter uses `resetsAt` with 5-hour rolling and 7-day weekly windows; the
monthly pace estimate uses the calendar month preceding `resetsAt`. Usage
pressure has green/yellow/orange/red states with hysteresis. Red pressure caps
routing at tier 1; orange caps at tier 2. Local per-model request caps from
`router.json` remain an extra fallback guard for individual models.

For isolated tests, `OGO_ROUTER_DATA_DIR` overrides the default data directory.

## Development

Install dependencies and type-check:

```sh
bun install
bun test
bun run typecheck
```

The extension uses Pi's installed `@earendil-works/pi-coding-agent` API for
types; Pi itself supplies the runtime when loading the extension.
