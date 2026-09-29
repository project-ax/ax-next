# Per-user spend and rate limits (TASK-692)

Design note and build plan. Launch runs on operator-paid model keys, so one
user (or one runaway agent loop) can run up the operator's bill. This adds a
per-user daily spend cap, a per-user turn-rate cap, an operator view of who
spent what, and a kill switch, all changeable without a deploy.

## What the card got wrong (verified by reading, not grepping)

The card assumed model calls "already pass through the provider layer (`llm-*`
plugins)". They do not, for the traffic that matters:

- **Agent traffic never touches `llm:call:*`.** Both runners (claude-sdk and
  aisdk) run inside the sandbox and call the provider directly. The only host
  hop is the credential proxy, which swaps the `ax-cred:<hex>` placeholder for
  the real key on a raw MITM byte pipe (`packages/credential-proxy/src/listener.ts`,
  `handleMITMConnect`). When this card was written the proxy never parsed a
  response, and its `event.http-egress` audit fires once per CONNECT tunnel, not
  per request, so it could not count tokens or model requests. (TASK-715 later
  added a passive usage tap on the provider host's tunnels and a per-user gate;
  see `2026-09-29-provider-call-metering.md`. The audit event is unchanged.)
- **`llm:call:anthropic` / `llm:call:openrouter` serve only host-side helper
  calls** (conversation titles, memory extraction, the skill safety scan). They
  cost money too, but they are the minority of spend.
- **No limit exists anywhere.** Re-grepped `packages/*/src` for spend, quota,
  budget, rate-limit and cost terms; every hit is unrelated (context-window
  math, upload size, credential "usage" notes). Nothing to shrink the card by.
- **Stale line that made the card look plausible:** `presets/k8s/src/index.ts`
  said "Host-side LLM plugins were deleted in Phase 6". They were not (the
  preset loads both), and `packages/core/src/llm.ts` said `@ax/llm-anthropic`
  is the single registrant. Both comments are corrected in this PR.

## The chokepoint

There is no single byte of the system that both sees every model call and
knows its usage. So the design splits the two jobs that the card bundled:

1. **Gate (refuse before spending): `chat:start`, plus `chat:resume`.** Every
   turn a person or a routine starts (web chat, routines, heartbeats) goes
   through `agent:invoke`, which fires the veto-capable `chat:start` first. A
   limits subscriber there refuses the turn before a sandbox is spawned or a
   token is spent. A new runner cannot skip it because runners do not decide
   whether a turn starts. There is exactly one other way a turn starts: a
   parked agent woken by a resolved decision (`decision-resolved` on its
   inbox, queued by `@ax/decisions`, on approval, dismissal or expiry). That
   never passes `agent:invoke`, so `@ax/decisions` fires the new veto
   `chat:resume` first, as the decision's owner, and the same subscriber
   judges it (an independent review found this side door). A refused wake-up
   leaves the agent parked. The gate stops MODEL TURNS, not a call a person
   already approved: the sweep treats a refusal like any delivery nobody
   received, so the host replay still makes the approved call and the yes is
   never stranded. That is a stated residual, see the gaps below.
2. **Meter (count what was spent): the runner's turn boundary.** Both runners
   are built on `@ax/agent-runner-core`, whose `LoopContext.endTurn` is the one
   seam a loop uses to close a turn. This PR makes `usage` a REQUIRED field of
   `EndTurnInput` (`TurnUsage | null`), so a new loop cannot compile without
   saying what its turn cost. The shell forwards it on the assistant
   `event.turn-end`; `@ax/ipc-core` fires it as `chat:turn-end`; the limits
   plugin records it. A loop that cannot tell reports `null` and the host
   charges a flat conservative assumed cost, so "unknown" is never "free".
3. **Host-side helper calls:** `@ax/llm-anthropic` and `@ax/llm-openrouter`
   fire a new subscriber hook `llm:usage` after each successful call, and the
   same plugin records it. Fire-and-forget, so metering trouble never fails a
   helper call.

### Known gaps (stated, not hidden)

- **Direct provider calls from user code in the sandbox** (`curl` with the
  placeholder key) were gated only at the door and not counted (fixed in
  TASK-715: the credential proxy now measures every model response, the ledger
  takes the larger of the runner-reported and proxy-measured figures, and the
  proxy stops splicing the key at 2x the daily limit). What that leaves is in
  `2026-09-29-provider-call-metering.md` under "What stays unmetered or
  unbounded".
- **A single turn is not stopped mid-flight by the spend cap.** It is bounded
  by the runners' own step limits, and a suspension (kill switch) does
  interrupt in-flight turns. Overshoot is at most the turns already running.
- **A turn that ends abnormally** (runner crash, chat timeout) records no
  tokens; its turn still counts against the rate limit.
- **The kill switch stops agents, not a call a person already approved.** A
  paused account can still see one approved tool call run, by the host replay
  (no model turn, no model spend), for each hold that existed before it was
  paused: pausing stops new holds because it stops new turns. Gating the
  replay too would mean a suspended or over-cap person's approval silently does
  nothing, which is worse for everyone who is not abusing anything.
- **A database that stalls past 60 seconds lets a turn through.** The
  orchestrator bounds every `chat:start` subscriber at 60 s and skips one that
  has not settled (TASK-514). The gate fails closed on any error it can see,
  but not on a check that never returns. A stall that long takes chat itself
  down first (conversations live in the same database).
- **Bring-your-own-key users count too.** The host cannot tell at turn end
  whose key served a call, so every user's usage is metered.

## Limits and defaults (admin-changeable at runtime, stored as a setting)

| Setting | Default | Meaning |
|---|---|---|
| `dailySpendUsd` | 5.00 | Estimated spend per user over a rolling 24 hours. |
| `turnsPerHour` | 60 | Turns (user messages, routine fires) per user per rolling hour. |
| `assumedTurnCostUsd` | 0.25 | Charged when a loop reports no usage. |

Rolling windows, not calendar days: a calendar reset lets someone burn the cap
at 23:59 and again at 00:01. Estimated spend is tokens x a small built-in price
table (Anthropic families by name; anything unrecognised is priced at the top
tier, so an unknown model over-counts rather than hides). It is an abuse
control, not billing.

At the limit: the turn is refused with a stable reason code
(`usage-limit-daily`, `usage-limit-rate`, `usage-suspended`,
`usage-check-unavailable`); channel-web turns those into plain sentences. The
check fails CLOSED if the database is unreachable.

## Storage

`@ax/usage-limits` owns two tables (Postgres via `database:get-instance`):

- `usage_limits_v1_buckets (user_id, bucket_start, turns, input_tokens,
  output_tokens, cache_read_tokens, cache_write_tokens, cost_micros)`,
  primary key `(user_id, bucket_start)`, one row per user per minute. Rolling
  sums are one indexed range query. Rows older than 8 days are pruned.
- `usage_limits_v1_suspensions (user_id primary key, suspended_at,
  suspended_by, note)`.

The admit check (suspension, daily spend, hourly turns, then count the turn)
runs in one transaction under a per-user advisory lock, so two simultaneous
messages from one user cannot both slip under the cap and one user's lock never
blocks another's. Limits live in storage key `settings:usage-limits` (the
`@ax/branding` pattern).

## Surface

- Subscribes: `chat:start` (gate + count), `chat:resume` (gate), `chat:turn-end`
  (record), `llm:usage` (record). Registers two service hooks for the
  credential proxy (TASK-715): `usage:provider-status` and
  `usage:provider-record`.
- HTTP (admin only): `GET /admin/usage`, `PUT /admin/usage/limits`,
  `PUT|DELETE /admin/usage/users/:userId/suspension`. Suspending also
  interrupts that user's in-flight turns (`conversations:list` +
  `agent:interrupt`, both optional). An admin cannot suspend themselves.
- UI: a "Usage and limits" admin tab in `@ax/channel-web`; the friendly limit
  sentences in `lib/turn-error-labels.ts`.

## Tasks

1. **Protocol + runners (report usage).** `EventTurnEndSchema.usage` gains
   `cacheReadTokens`, `cacheWriteTokens`, `model`, all bounded. `runner-core`:
   `TurnUsage`, required `EndTurnInput.usage`, forwarded on the assistant
   turn-end. claude-sdk: sum per-API-response usage from `assistant` messages,
   de-duplicated by message id (a multi-block response is several SDK messages
   with the same id and usage). aisdk: sum `steps[].usage`. `@ax/core`:
   `fireLlmUsage` helper. Load-bearing: this is the meter.
2. **`@ax/usage-limits` backend.** Pricing, config, migrations, store, admit /
   record / suspend service, plugin, routes; tested against a real Postgres.
3. **Helper-call metering.** `llm-anthropic` and `llm-openrouter` fire
   `llm:usage`. Load-bearing: without it the operator view omits titles and
   memory extraction.
4. **Wiring + canary.** Register in preset-k8s; preset-k8s acceptance canary
   proves a real turn is metered, an over-cap user is refused, another user is
   unaffected, and the counter survives a plugin restart.
5. **UI.** Admin tab and the friendly limit copy.

Cut as YAGNI: per-user limit overrides, a fleet-wide cap, admin-editable prices,
a user-facing "how much have I used" page, charging turns that end abnormally.
Each is a follow-up card if launch shows the need.
