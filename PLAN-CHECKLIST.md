# Pi budgeted router: build checklist

Extension that keeps the main loop on a mid-tier model, escalates to strong models only when needed, and steers by Go usage budgets.

**Progress:** M0 groundwork and M1 routing/budget-meter work are implemented, with live authenticated usage validation still open. M2 isolated delegation is implemented, including role profiles, skill allowlists, usage accounting, task logs, and optional tmux panes. M3 escalation triggers, M4 review/memory hooks, and M5 operational tuning remain incomplete. In the current Pi installation, `opencode-go` models are present in the configured model store and OpenRouter is a built-in provider. The Go usage response schema was supplied as a redacted sample; no authenticated live account request was made.

## M0. Verify the ground

Settle the unknowns that shape every later step.

- [x] **Check how Go is exposed in pi.** `opencode-go` is configured in the current local model store; it is not assumed to be a Pi built-in. No live test request was sent.
- [ ] **Map Go's catalog to tiers.** List each model's context window and price, then assign T0 to T3.
- [x] **Decide where T3 comes from.** T3 is configured as OpenRouter Claude Opus; it is separately billed and excluded from Go quota estimates. Credentials and a live request remain unverified.
- [x] **Read `tui.md` and `types.ts`.** Confirmed `ctx.ui.setStatus`, `ctx.ui.setWidget`, and virtual-model route signatures against the installed Pi 1.3.0 declarations.
- [x] **Check skill isolation support.** Delegated subprocesses use `--no-skills`; only skills in the role allowlist are preloaded into the system prompt.
- [x] **Find a Go usage source.** `GET https://opencode.ai/zen/go/v1/usage` with `Authorization: Bearer $OPENCODE_API_KEY` is the candidate source.
- [x] **Verify the usage response shape.** A redacted sample provides `usage.rolling`, `usage.weekly`, and `usage.monthly`, each with `status`, `percent`, and `resetsAt`. Unauthenticated access returned HTTP 401; do not send credentials during development or log/expose the API key. Validate the live authenticated response in the user's environment.

## M1. Router and budget meter

Virtual model `ogo/auto` with budget routing and a live dashboard snapshot.

- [x] **Scaffold the extension.** `index.ts`, `router.json`, and the `ogo.json` category configuration.
- [x] **Register `ogo/auto`.** `thinkingLevels` of low, medium, high as the frugal-to-quality dial.
- [x] **Write `route()`.** `direct` uses T0; `user` uses deterministic category heuristics; `continuation` stays sticky.
- [x] **Write the ledger.** On `message_end`, append provider/model, cost, and timestamp to `~/.pi/agent/ogo-router-usage.jsonl`.
- [x] **Compute local 5h, weekly, and monthly estimates.** Request-count pace pressure, tier cap by state, with hysteresis.
- [x] **Add the budget dashboard.** Three usage bars, pace markers, current routed model, pressure state, API window status, local post-sync request counts, and catalog freshness are rendered in the tmux side panel; informational status is not piped into the main editor.
- [x] **Add authoritative Go usage snapshots.** Fetch on session start and after settled agent runs, throttled to once per minute; validate and persist snapshots, and surface fetch/schema/persistence errors without exposing credentials.
- [x] **Use one effective budget source.** Prefer the latest Go percentages. Show the local Pi request count since the snapshot as a separate optimistic delta (not added to percentages because the API reports percentages, not a verified percent-per-request conversion). Without a valid snapshot, use the clearly labeled local estimate; retain a previous snapshot as stale after refresh failures.
- [x] **Apply endpoint data consistently.** Use rolling, weekly, and monthly `percent` values with `resetsAt` to compute usage and pace; keep separately billed OpenRouter usage outside Go totals. Monthly pace assumes the period starts one calendar month before `resetsAt`.
- [x] **Test fallback and reconciliation behavior.** Automated tests cover local fallback, successful mocked snapshots, local post-snapshot request counts, stale snapshots, and routing. Live authenticated account validation remains pending.
- [x] **Add tmux side-panel integration.** Open a detached 42-column side pane at session start, refresh it from the dashboard snapshot, and close it at session shutdown. Non-tmux sessions retain the Pi UI fallback.

## M2. Delegation

Delegate only bounded work that benefits from isolation, parallelism, or a
different tool/model profile. The conductor remains the user-facing owner: it
chooses a role, gives that role a task brief and acceptance criteria, integrates
the result, and owns final edits and decisions. Subagents do not inherit the
conversation; pass only the relevant dossier, files, constraints, and expected
output.

- [x] **Adapt the stock subagent example.** Implement an isolated Pi CLI subprocess wrapper using JSON-mode message and usage capture, plus the role directory.
- [x] **Define role profiles.** Each profile declares its tier preference, allowed tools, job, output contract, and whether it may edit or delegate further.

| Role | Tier | Tools | Job |
|---|---|---|---|
| **conductor** (main thread) | T1 | all | Talks to you, executes the plan, delegates |
| **scout** | T0 | read-only | Recon, returns compressed context  |
| **mechanic** | T0 | bash, edit | Formatting, renames, running tests, log triage, commit messages |
| **planner** | T3 (or T2 when budget is tight) | read-only | Produces `PLAN.md` with ordered steps, dependencies, risks, and acceptance checks |
| **worker** | T1 | all | Executes one plan step in isolation |
| **reviewer** | T2/T3 | read-only | Reviews the diff against the plan; runs only on triggers |
| **debugger** | T3 | read-only plus bash | Gets a failure dossier, returns a diagnosis and a fix strategy, not edits |
| **summarizer** | T0 | none | Compaction, branch summaries, memory distillation |

- [x] **Route delegation by role, not just tier.** Use scout for unfamiliar areas or evidence gathering; planner for multi-step or cross-cutting work; worker for one accepted plan step; mechanic for bounded mechanical chores; reviewer for triggered diff review; debugger after the stuck signals in M3; summarizer only for compaction or durable-memory distillation. The conductor handles routine small changes directly.
- [x] **Keep role permissions narrow.** Scout, planner, reviewer, debugger, and summarizer are non-editing. Mechanic may edit only when the brief names the mechanical change and scope. Worker receives the tools needed for its single assigned step. No role may spawn another delegate by default; only the conductor orchestrates delegation.
- [x] **Define role-specific output contracts.** Scout returns findings with file/line evidence and unknowns; planner returns steps and acceptance checks; worker returns changed paths, validation, and blockers; mechanic summarizes exact mechanical edits and commands; reviewer returns only actionable findings with evidence; debugger returns a diagnosis and ranked fix strategy without editing; summarizer returns compact durable context and open items.
- [x] **Use explicit delegation patterns.** Recon precedes planning when repository context is unknown; independent scout tasks may run in parallel; workers execute isolated plan steps; reviewer runs after changes only on M4 triggers. The conductor checks results and tests before accepting them.
- [x] **Build the delegate wrapper.** Fallback chain across sibling models plus a circuit breaker.
- [x] **Cap and spill outputs.** Long results go to a file, and the tool returns the path.
- [x] **Record subagent usage.** Feed usage into the budget ledger and tool result `usage` field, tagging the role and provider so budget gates can account for delegated work.
- [x] **Preload skills into briefs.** Add a `skills:` allowlist per role; scout and summarizer default to none, while other roles receive only skills needed for their assigned task.
- [x] **Add task logs and optional tmux output panes.** Each delegate streams to a private log; up to three tasks can have live tail panes under the sidebar, with finished panes closed after a short success/failure-specific delay.

## M3. Escalation and fallback

Flagship only when needed, and only within budget.

- [ ] **Add `request_escalation` tool.** The cheap model states what it tried and why it is stuck.
- [ ] **Build a stuck detector at `turn_end`.** Same error twice, three failed tool results, or tests failing after "done".
- [ ] **Wire planner and debugger triggers.** Reuse their M2 role profiles; invoke the planner for complex plans and debugger only with a bounded failure dossier.
- [ ] **Gate in `tool_call`.** Block or downgrade T3 delegation when the budget is red.
- [ ] **Add phase transitions in `route()`.** First edit, failure streak, and escalation flag, all inside the cap.
- [ ] **Complete the retry ladder.** Implement explicit transient, rate-limit/quota, capability, and context-overflow handling. Main routing retries a transient failure once on the same model, then advances through configured fallbacks; delegates temporarily cool down failed models and try up to three candidates. Explicit error classification and context-overflow handling remain incomplete.

## M4. Review gate and memory

Quality check and durable context.

- [ ] **Add reviewer plus `agent_before_settle` gate.** Trigger on large or risky diffs and continue once, guarded by a state flag.
- [ ] **Hook `session_before_compact`.** T0 summarizer, with `PLAN.md` pointer, phase, and open escalations in `details`.
- [ ] **Write the memory files.** `PLAN.md` and a decisions log under `.pi/memory/`.
- [ ] **Log routing decisions.** `pi.appendEntry` for entries that stay out of model context.

## M5. Harden and tune

Make it trustworthy.

- [ ] **Harden usage polling and reconciliation.** Validate live reset/aggregation semantics, monitor endpoint lag, and test behavior with concurrent or delayed provider usage; current client bounds request frequency, handles auth/HTTP/schema failures, and retains the last valid snapshot.
- [ ] **Tune thresholds from observed usage.** After about a week, compare snapshots, optimistic local deltas, and actual routing outcomes.
- [ ] **Compare against a single-model baseline.** Cost and success on a few repeat tasks.

## Delegation strategy

The upstream example has the strong model drive planning and make the first edit. I’d invert that. Flagship models are consultants, not drivers. The main loop sits on a mid-tier model, and flagship calls are short, isolated subagent runs with a curated brief and a compact artifact as output. A flagship call with 5k tokens of context costs far less than a flagship carrying a 100k transcript. It also sidesteps the prompt-cache penalty of switching the main thread’s model.

Two mechanisms, with a clear split:

Mechanism Use for
Virtual model route() Switching the main thread between tiers (sequential work in one context)
delegate tool, with subprocess agents Isolated, parallel, read-heavy, or advice-only work

The role table and output contracts in M2 are the single source of truth.
Tiers remain config-driven placeholders until mapped from the Go catalog:
T0 flash, T1 mid, T2 strong, and T3 flagship.

### Where the delegation decision lives

| Hook | Delegation responsibility |
|---|---|
| `input` | Honor explicit role overrides such as `@scout`; do not make a classifier call just to select a role. |
| `before_agent_start` | Add the selected role's brief, budget note, and tool restrictions to delegated subprocesses; skip role injection for unrelated custom-triggered runs. |
| `route()` with reason `user` | Choose the conductor's starting tier and phase; delegation role selection remains a separate orchestration decision. |
| `route()` with reason `continuation` | Keep the conductor sticky; change tier only on observable transition signals. |
| `route()` with reason `retry` | Apply fallback and cooldown behavior for the active role without widening its permissions. |
| `route()` with reason `direct` | Route compaction/summarization work to T0. |
| `tool_call` | Enforce role permissions, output limits, concurrency limits, and budget caps before launching delegates. |
| `turn_end` | Update failure/stuck signals and usage accounting used to decide whether to invoke debugger or escalate. |
| `agent_before_settle` | Run the reviewer only for M4 triggers; guard continuation so the review gate runs once. |

Cheap signals for escalation:

The same failing tool error twice, or three failed tool results in a row.
Tests still failing after the worker reports “done”.
An edit touching more than N files or sensitive paths.
A model-callable request_escalation tool, where the cheap model states what it tried and why it’s stuck. The budget gate then decides whether it gets T2 or T3.

The virtual model's thinking level is the conductor's frugal ↔ quality dial.
It does not override role permissions or budget caps: a high level may permit a
T3 consultant role when budget allows, but cannot turn a read-only role into an
editor or bypass the delegate gate.

Sketch of the router:

```
typescript
pi.registerVirtualModel<RouterState>({
  provider: "ogo", id: "auto", name: "Auto (budgeted)",
  thinkingLevels: ["low", "medium", "high"],
  async route(req, ctx) {
    const cap = budget.maxTier(req.thinkingLevel);       // from the meter
    if (req.reason === "direct") return pick(ctx, "T0");
    if (req.reason === "retry")  return fallback(req, ctx, cap);
    const s = req.state ?? { tier: "T1", phase: "build", cooldown: {} };
    if (req.reason === "user")   return pick(ctx, clamp(await classify(req, ctx), cap), s);
    const next = transition(s, req.messages);            // first edit, fail streak, escalation flag
    return pick(ctx, clamp(next.tier, cap), next);
  },
});
```

## Fallback

On a retry, read req.failed.message.errorMessage and classify the failure:

Transient (timeout, 5xx): retry the same model once.
Rate limit or quota: switch to a sibling model in the same tier. If the Go window is exhausted, route to a non-Go provider or stop with a UI notice. Record a model cooldown in router state.
Capability failure (malformed tool calls repeatedly): go up one tier.
Context overflow: pi compacts first, then the router may pick a larger-context model.

Subagent processes get the same ladder in the delegate wrapper, with a circuit breaker so a dead model isn’t retried every turn.

## Skills

Pi advertises each skill’s name and description in the system prompt and the model loads SKILL.md on demand. The docs say a model can fail to load a relevant skill, and cheap models fail more often. So:

Preload for subagents. The delegate tool matches the task to skills and puts the relevant SKILL.md content directly into the brief.
Per-role allowlists. Add a skills: field to the role frontmatter so a scout sees none and a worker sees only the project’s. This cuts per-request prompt tokens. I haven’t verified how to restrict skills for a subprocess, so check pi --help for the flags.
Mark expensive or risky skills disable-model-invocation: true and trigger them with /skill:name.
Memory and compaction

Three layers, with durable artifacts preferred over transcript passing:

Transcript and compaction. Hook session_before_compact, summarize with the T0 summarizer, and put a pointer to PLAN.md, the current phase and any open escalations in compaction.details. Compaction limits follow the physical model of each request, so a small-context flash model will compact more often. Pi has per-model compaction overrides in settings.
Ledger outside context. Use pi.appendEntry() for routing decisions and budget snapshots, and an external JSONL for cross-session local usage. Keep authoritative Go snapshots distinct from optimistic local deltas so they can be reconciled rather than summed repeatedly.
Project memory. The planner writes .pi/memory/PLAN.md and a decisions log, and workers read them. Subagents are isolated, so nothing leaks between them except what you hand over. Cap subagent outputs and write long ones to a file, returning the path.

Before any escalation, build a dossier (goal, plan, failing output, relevant diff) instead of forwarding the transcript.

## Budget meter, widget, and steering

Use `GET https://opencode.ai/zen/go/v1/usage` with
`Authorization: Bearer $OPENCODE_API_KEY` as the intended authoritative Go
usage source. First verify its response fields, window definitions, and
refresh/lag semantics; do not guess the schema or treat a failed request as
zero usage. Keep the API key in the process environment and never include it in
logs, UI, or persisted snapshots.

Poll on session start and at a throttled cadence. The existing JSONL usage
ledger remains useful as an optimistic local delta between successful fetches:
record Pi-observed requests, combine only the post-snapshot delta with the last
valid snapshot, and reconcile it after a successful refresh. Establish a
timestamp/watermark from verified endpoint semantics to avoid double-counting
requests that the API already includes or has not yet aggregated. If the fetch
fails or returns invalid data, retain the last valid snapshot, keep applying
the local delta, and clearly mark the display stale/estimated. If no valid
snapshot has ever been fetched, use the ledger as a labeled fallback. This
local fallback cannot observe usage from OpenCode or other clients, so it must
not be presented as account-wide truth.

Derive 5-hour, weekly, and monthly budget state from the verified endpoint
values (and its reset boundaries), not from the illustrative per-model
request-count caps in `budget.html`. Retain those caps only as a temporary
steering fallback if the endpoint does not provide enough information. The
local cost ledger can still support `/session` comparison and later threshold
tuning.

Gate on pace, not just remaining quota. With used and elapsed as fractions of each window:

5 hours: a burst is normal, so only hard-clamp above about 90% used.
Weekly and monthly: pressure = used / elapsed.
State Tier cap
Green (pressure under 0.8) T3 allowed for plan, review, debug
Yellow (0.8–1.1) T3 only on explicit escalation
Orange (1.1–1.4 or 5-hour window above 75%) T2 max
Red (over 1.4 or any window above 90%) T0/T1 only, user notified

Add hysteresis so the tier doesn’t flap at a threshold. Show it with
`ctx.ui.setStatus` for a compact line (5h ▓▓░░ wk ▓▓▓░ mo ▓░░░ · yellow), plus
a widget for the three bars and pace markers. Confirmed the status, widget,
and virtual-model route signatures against the installed Pi 1.3.0 declarations.

The tier table should be config-driven (`router.json`: tier → provider/model,
plus per-model price and context size). OpenRouter T3 has separate billing and
must remain outside the Go meter.

## Build order

Virtual model with static tiers, the ledger, and the status line.
delegate tool with scout, worker and mechanic, adapted from the stock subagent example.
Escalation: request_escalation, the stuck detector, planner and debugger roles, and the budget gate.
Review gate and the compaction and memory hooks.
Verify and integrate the Go usage endpoint, then harden snapshot/delta reconciliation and the labeled local fallback.

## Reliability fixes backlog

The following work was identified in the routing and delegation review. Keep
these fixes separate from the M3-M5 feature milestones so reliability work can
be validated before adding more orchestration behavior.

### R1. Delegation correctness and lifecycle

- [x] Handle stderr with one stream listener, retain its most recent 64 KiB,
  and truncate large text using buffer slices.
- [x] Consume only authoritative child `message_end` events and deduplicate
  assistant usage by message timestamp.
- [x] Start child Pi processes with `--no-extensions` to avoid loading OGO in
  the child and recording the same usage twice.
- [x] Load role files lazily during tool execution and return role-load errors
  as delegate tool errors.
- [x] Catch per-task setup errors and settle parallel tasks so one rejection
  cannot orphan sibling scouts.
- [ ] Move large system/user prompts out of process arguments to avoid
  per-argument size limits and exposing task content in process listings.

### R2. Router fallback and budget enforcement

- [x] Keep failed-model cooldowns in routing state and filter after fallback
  expansion; persist cooldowns only if cross-restart behavior is needed.
- [x] Order fallbacks from the selected tier toward cheaper tiers first.
- [x] Enforce tier caps during continuations; over-cap models downgrade to the
  nearest eligible tier.
- [ ] Add a per-request spend ceiling checked when assistant usage is recorded
  (currently disabled by user choice; no threshold configured).
- [x] Keep T3 models out of the conductor route. Separately billed non-Go
  session/day USD caps remain disabled by user choice pending thresholds.
- [x] Classify retry failures (429/quota, 5xx, network, timeout,
  context/capability, and task failure); only transient provider failures retry
  the same model, while other failures exclude it from the current attempt.

### R3. Usage accounting and category stability

- [x] Tolerate malformed/torn ledger lines with a warning and maintain an
  in-memory ledger index rather than reparsing the entire file on each route.
- [x] Estimate local utilization as per-model request fractions against each
  model's configured quota, and use a rolling five-hour window.
- [x] Correct early-window pace behavior in both local and snapshot meters.
- [x] Keep the task category sticky across acknowledgments and permit new
  evidence to escalate, but not silently downgrade, the category.

### R4. Safe and bounded delegation

- [ ] Isolate editable attempts in per-attempt Git worktrees. Preserve partial
  output and diffs after timeout/failure; do not retry an edited tree without
  returning to a clean attempt.
- [ ] Retry/cool down only classified provider failures; add provider-level
  cooldowns, jitter, half-open probes, and provider diversity.
- [ ] Enforce read-only roles using tool allowlists, and validate editable-role
  diffs against an explicit allowed-path list before accepting results.
- [ ] Replace the single two-minute wall-clock timeout with per-role idle
  timeouts; return partial transcript and editable diff on timeout.
- [ ] Reserve estimated delegate spend before launch, reconcile actual usage
  afterward, and report cost and remaining headroom. Account for concurrent
  reservations.

### R5. Verification and evidence-based escalation

- [ ] Run configured tests/typecheck/lint after a worker completion claim and
  use deterministic failures and unexpectedly broad diffs as escalation
  signals.
- [ ] Estimate percent-per-request conversion from consecutive API snapshots
  and model-weighted observed usage; smooth it and validate it before using the
  estimate for routing or pre-flight reservation.

### Decisions before R4

- Choose per-attempt Git worktrees as the isolation mechanism (recommended),
  including how accepted changes are applied to the conductor's working tree.
- Set idle timeout values by role.
- Define the editable-role allowed-path format and whether out-of-scope diffs
  are rejected or merely reported.
- Configure session/day dollar caps and reservation behavior for concurrent
  delegation.
