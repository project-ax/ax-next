# Week 13+ handoff — cleanups + additive plugins

**For:** session starting Week 13+, i.e. post-parity maintenance and growth.
**Previous slices:** Weeks 1–2, 3, 4–6, 7–9, 10–12. v2 is at feature parity with legacy AX.

---

## Goal (architecture doc Section 10)

```
Week 13+ — Cleanups + additive plugins
  • Now things are pluggable, cleanups are bounded — refactor a plugin
    in isolation instead of rippling through 20k LOC
  • @ax/workspace-gcs (or s3) lands additively against Section 4.5's contract —
    no subscriber (skill validator, scanner, audit) changes
```

This is explicitly **not** a single slice. It's the ongoing work after the architecture is in place. Write a focused handoff brief per Week-13+ slice; use Weeks 3–12 briefs as templates.

## The principle (repeat this to yourself before each Week-13+ slice)

> Every cleanup or addition should be a **single-plugin patch.** If you find yourself needing to change two or more plugins to do one thing, either (a) the hook surface is wrong — invoke the boundary-review checklist — or (b) you're doing too much in one slice.

This is the payoff of Weeks 1–12. Weeks 13+ either demonstrate that payoff or reveal where the abstraction leaked. Both outcomes are useful.

## First candidate — `@ax/workspace-gcs` (the contract validator)

The architecture doc explicitly calls this out. It's the canary test for whether Section 4.5's workspace contract holds:

- Write `@ax/workspace-gcs`. Use the manifest-object pattern (bucket/objects/\<hash\>, bucket/manifests/\<uuid\>, CAS-updated bucket/HEAD via `ifGenerationMatch`) per arch doc Section 4.5's backend contract.
- **Pass condition:** zero changes required in `@ax/audit`, `@ax/scanner-canary`, `@ax/memory-cortex`, or any other subscriber. If any subscriber needs to learn what "GCS" means, the contract leaked — fix the contract before landing the plugin.
- Ship a preset (`@ax/preset-gcs` or add a variant to `@ax/preset-k8s`) that swaps `@ax/workspace-git` for `@ax/workspace-gcs`.

This slice is the clearest measure of whether the plugin architecture actually works. If it's smooth, v2 delivered. If it's painful, iterate on Section 4.5 and document what was wrong.

## Later candidates — in rough priority order

Pick the one whose friction is actually present, not prospectively.

### Refactors (fix something that exists)

- **Replace `classify()` regex** with structured `hookName` on `PluginError` — if this wasn't folded in during Week 4–6 as recommended, it's still a live footgun.
- **`@ax/workspace-git-http`** — if multi-replica k8s actually requires it and Week 7–9 / 10–12 deferred it.
- **Per-plugin timeouts on service hooks** — arch doc Section 10 deferred this. First time a slow plugin hangs a chat, this becomes urgent.
- **Zod return-shape validation on service hooks** — arch doc Section 10 deferred this. Worth turning on once a plugin misbehaves in a way a type check would have caught.
- **`detectCycles` rename / split** — if Week 4–6 didn't clean this up.
- **Structured logger** — replace the JSON-line stub in `@ax/core` with pino or equivalent. Only worth doing when log volume becomes a real concern.

### Additions (new plugins)

- **Strata memory plugins** — the MVP-deferred memory system. Uses the design at `docs/plans/memory-strata-design.md`, not legacy cortex. Likely two sub-slices: (a) storage + retriever (hot-tier-in-context + warm/cold hybrid retrieval subscribing to `llm:pre-call`); (b) background processes (observer on `chat:end`, consolidator, promoter). Pulls `@ax/scheduler` forward. New deps: embedding provider, SQLite FTS5.
- **`@ax/scheduler`** — cron-triggered chat runs + background process runner for Strata's observer/consolidator/promoter. First consumer is Strata; later also cron-triggered chats triggering `chat:run` the same way channels do.
- **`@ax/llm-openrouter`** — deferred from 6.5b for MVP. Ships when non-Anthropic routing earns its keep (cost, capability, or user request).
- **`@ax/llm-router`** — when there are 2+ LLM provider plugins and a real routing decision to make.
- **`@ax/llm-openai`** — when a user actually requests it.
- **`@ax/agent-pi-session-runner`** — deferred from 6.5c for MVP. The 6.5 design doc (Section "Runner comparison") specifies the exact shape: single `ax-ipc` pi-ai api, honest model identifier, `customTools` shim through the IPC tool dispatcher. Host-side plugins unchanged. Good candidate for the "does the runner boundary actually hold?" check — if adding pi-session requires touching any host-side subscriber, something leaked.
- **`@ax/skills`** — proper v2 skills plugin. Port legacy's skill validation as a `workspace:applied` subscriber.
- **`@ax/diagnostic-collector`** — per-request collector, populated by hook subscribers. Port from legacy.
- **`@ax/teams`** (if deferred from 9.5) — team entity + membership + role model.
- **Public / org-wide agent visibility** — if 9.5 shipped personal+team only, add the `public` visibility tier when a real use case appears.
- **`@ax/channel-slack`** — deferred from Week 10–12 MVP. Architectural note for when it lands: Slack inbound via socket mode pins one replica per Slack workspace (that replica holds the websocket). Slack outbound is **stateless HTTPS to `slack.com/api`** from any replica — no `channel:outbound` eventbus coordination needed. Leaves just one coordination question: which replica holds the inbound socket, and how do we fail over if it dies (heartbeat + re-claim, probably).
- **`@ax/audit`** — deferred from Week 10–12 MVP. Subscribes to `chat:end`, `workspace:applied`, `tool:post-call`, `auth:user-signed-in`. Open scope decision: `storage:set` with keyed entries vs dedicated `audit:write` service hook — pick when a second audit consumer materializes.
- **`@ax/scanner-canary`** — deferred from Week 10–12 MVP. Subscribes to `workspace:pre-apply` (secret veto, pre-storage) and `llm:pre-call` (redaction before content reaches the model, per D4 in the 6.5 design). Tool output scanning at `llm:pre-call`, not `tool:post-call`. Port regex set from legacy. **Security gate:** this should land before the MVP opens to anyone outside the trusted initial users.

### Openclaw-style differentiators (what v1 couldn't do)

This is where v2 gets fun. Anything that was gated by monolith coupling in v1 is fair game:

- **Hot-swap an LLM mid-chat** (e.g., fallback on rate limit).
- **Parallel tool execution** (arch doc intentionally kept `tool:execute` sequential; revisit).
- **Third-party plugin loading from npm** (explicit allowlist — matches SC-SEC-002).
- **Bring-your-own workspace backend** — any implementation of Section 4.5's contract.

## Discipline reminders

- **No speculative plugins.** v2's whole point is that plugins are cheap to add *later*. That means: don't add them now unless the friction is present.
- **Boundary review on every hook change.** Arch doc and `CLAUDE.md` require it. It's cheap now, expensive once subscribers depend on a leaked field name.
- **Invariant 3 still applies at Week 13+.** Half-wired plugins are a trap at any point in the project's life, not just the greenfield phase.
- **Invariant 5 still applies at Week 13+.** Every new plugin / IPC action / tool should grant minimal capabilities. Don't let the "just one more feature" pressure erode the security posture.
- **Skills are still friction-driven** — only write a new skill when 3+ sessions have hit the same non-obvious friction.

## No single kickoff prompt

Each Week-13+ slice is its own thing. When you start one:

1. Identify the specific cleanup or addition — one thing, clearly motivated by real friction or a concrete feature request.
2. Write a focused handoff brief (`docs/plans/<date>-<topic>-handoff.md`) using Weeks 3–12 briefs as templates.
3. After `/clear`, paste a kickoff prompt pointing at that brief.

If the slice starts bleeding into three or four plugins, stop. Either split it, or invoke boundary-review because something about the hook surface is wrong.

---

## One last thing

If you're ever stuck deciding what to work on next in Week 13+: read `docs/plans/2026-04-22-plugin-architecture-design.md` Section 10's "What's NOT in scope (yet)" list. Those are explicitly deferred items — each one is a candidate for a Week-13+ slice when its motivation arrives:

- Hot-reload of plugins.
- Config hot-update.
- Security capability model (per-plugin permission grants).
- Inter-plugin transactions.
- Dynamic plugin discovery.

Each of these is fine to build when the pain shows up. Not before.
