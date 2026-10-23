# Pi budgeted router: build checklist

Extension that keeps the main loop on a mid-tier model, escalates to strong models only when needed, and steers by Go usage budgets.

**Current implementation:** `ogo/auto` and the M1 Go usage meter are implemented. In the current Pi installation, `opencode-go` models are present in the configured model store and OpenRouter is a built-in provider. The Go usage response schema was supplied as a redacted sample; no authenticated live account request was made. Delegation, escalation tools, review gates, and memory hooks remain future milestones.

## M0. Verify the ground

Settle the unknowns that shape every later step.

- [x] **Check how Go is exposed in pi.** `opencode-go` is configured in the current local model store; it is not assumed to be a Pi built-in. No live test request was sent.
- [ ] **Map Go's catalog to tiers.** List each model's context window and price, then assign T0 to T3.
- [x] **Decide where T3 comes from.** T3 is configured as OpenRouter Claude Opus; it is separately billed and excluded from Go quota estimates. Credentials and a live request remain unverified.
- [x] **Read `tui.md` and `types.ts`.** Confirmed `ctx.ui.setStatus`, `ctx.ui.setWidget`, and virtual-model route signatures against the installed Pi 1.3.0 declarations.
- [ ] **Check `pi --help` for skill flags.** Needed to restrict skills per subagent role.
- [x] **Find a Go usage source.** `GET https://opencode.ai/zen/go/v1/usage` with `Authorization: Bearer $OPENCODE_API_KEY` is the candidate source.
- [x] **Verify the usage response shape.** A redacted sample provides `usage.rolling`, `usage.weekly`, and `usage.monthly`, each with `status`, `percent`, and `resetsAt`. Unauthenticated access returned HTTP 401; do not send credentials during development or log/expose the API key. Validate the live authenticated response in the user's environment.

## M1. Router and budget meter

Virtual model `ogo/auto` with a visible budget. No subagents yet.

- [x] **Scaffold the extension.** `index.ts`, `router.json`, and the `ogo.json` category configuration.
- [x] **Register `ogo/auto`.** `thinkingLevels` of low, medium, high as the frugal-to-quality dial.
- [x] **Write `route()`.** `direct` uses T0; `user` uses deterministic category heuristics; `continuation` stays sticky.
- [x] **Write the ledger.** On `message_end`, append provider/model, cost, and timestamp to `~/.pi/agent/ogo-router-usage.jsonl`.
- [x] **Compute local 5h, weekly, and monthly estimates.** Request-count pace pressure, tier cap by state, with hysteresis.
- [x] **Add status line and widget.** Three bars, pace markers, current routed model, and pressure state.
- [x] **Add authoritative Go usage snapshots.** Fetch on session start and after settled agent runs, throttled to once per minute; validate and persist snapshots, and surface fetch/schema/persistence errors without exposing credentials.
- [x] **Use one effective budget source.** Prefer the latest Go percentages. Show the local Pi request count since the snapshot as a separate optimistic delta (not added to percentages because the API reports percentages, not a verified percent-per-request conversion). Without a valid snapshot, use the clearly labeled local estimate; retain a previous snapshot as stale after refresh failures.
- [x] **Apply endpoint data consistently.** Use rolling, weekly, and monthly `percent` values with `resetsAt` to compute usage and pace; keep separately billed OpenRouter usage outside Go totals. Monthly pace assumes the period starts one calendar month before `resetsAt`.
- [x] **Test fallback and reconciliation behavior.** Automated tests cover local fallback, successful mocked snapshots, local post-snapshot request counts, stale snapshots, and routing. Live authenticated account validation remains pending.

## M2. Delegation

Isolated subagents for scouting, chores, and execution.

- [ ] **Adapt the stock subagent example.** Install `index.ts`, `agents.ts`, and the agents directory.
- [ ] **Define roles.** scout (T0, read-only), mechanic (T0), worker (T1) as markdown with frontmatter.
- [ ] **Build the delegate wrapper.** Fallback chain across sibling models plus a circuit breaker.
- [ ] **Cap and spill outputs.** Long results go to a file, and the tool returns the path.
- [ ] **Record subagent usage.** Feed it into the ledger and the tool result `usage` field.
- [ ] **Preload skills into briefs.** Add a `skills:` allowlist per role.

## M3. Escalation and fallback

Flagship only when needed, and only within budget.

- [ ] **Add `request_escalation` tool.** The cheap model states what it tried and why it is stuck.
- [ ] **Build a stuck detector at `turn_end`.** Same error twice, three failed tool results, or tests failing after "done".
- [ ] **Add planner and debugger roles.** T3 or T2 by budget, read-only, with a dossier builder for their briefs.
- [ ] **Gate in `tool_call`.** Block or downgrade T3 delegation when the budget is red.
- [ ] **Add phase transitions in `route()`.** First edit, failure streak, and escalation flag, all inside the cap.
- [ ] **Implement the retry ladder.** Transient, then rate limit, then capability, then overflow handling.

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

## Core design

The upstream example has the strong model drive planning and make the first edit. I’d invert that. Flagship models are consultants, not drivers. The main loop sits on a mid-tier model, and flagship calls are short, isolated subagent runs with a curated brief and a compact artifact as output. A flagship call with 5k tokens of context costs far less than a flagship carrying a 100k transcript. It also sidesteps the prompt-cache penalty of switching the main thread’s model.

Two mechanisms, with a clear split:

Mechanism Use for
Virtual model route() Switching the main thread between tiers (sequential work in one context)
delegate tool, with subprocess agents Isolated, parallel, read-heavy, or advice-only work
Roles

Tiers are placeholders you fill from Go’s catalog (and any non-Go keys): T0 flash, T1 mid, T2 strong, T3 flagship.

Role Tier Tools Job
conductor (main thread) T1 all Talks to you, executes the plan, delegates
scout T0 read-only Recon, returns compressed context (the stock example)
mechanic T0 bash, edit Formatting, renames, running tests, log triage, commit messages
planner T3 (or T2 when budget is tight) read-only Writes PLAN.md with steps and acceptance checks
worker T1 all Executes one plan step in isolation
reviewer T2/T3 read-only Reviews the diff against the plan; runs only on triggers
debugger T3 read-only plus bash Gets a failure dossier, returns a diagnosis and a fix strategy, not edits
summarizer T0 none Compaction, branch summaries, memory distillation

### Where the delegation decision lives

Hook Decision
input Explicit overrides only (/deep, /quick, @scout). No model call.
before_agent_start Inject the role prompt, a one-line budget note, and the tool set for the tier. Check event.messageType to skip custom-triggered runs.
route() with reason user The main decision. Classify the task (Jev or heuristics) into a starting tier and phase. This is the only place classification latency is paid.
route() with reason continuation Sticky (preserves the cache). It changes only on observable events: the first edit, a failure streak, or an escalation request.
route() with reason retry The fallback ladder (below).
route() with reason direct Compaction and summaries always go to T0.
tool_call Budget gate: block or downgrade delegate calls to T3 when the budget is red.
turn_end Update the stuck detector and write the ledger.
agent_before_settle Review gate. If the diff is large or touches risky paths, run the reviewer once and return continue: true with its verdict. Guard it with a flag in state, because an unconditional continuation loops.

Cheap signals for escalation:

The same failing tool error twice, or three failed tool results in a row.
Tests still failing after the worker reports “done”.
An edit touching more than N files or sensitive paths.
A model-callable request_escalation tool, where the cheap model states what it tried and why it’s stuck. The budget gate then decides whether it gets T2 or T3.

The thinkingLevels of the virtual model (the docs say meaning is up to the router) work well as a frugal ↔ quality dial you set in /model. For example, low caps the tier at T1 and high allows T3 escalations.

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
