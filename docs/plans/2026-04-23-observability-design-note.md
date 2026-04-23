# Observability — minimal design note

**Date:** 2026-04-23
**Status:** Design sketch, not a plan. No implementation commitment yet.
**Author:** Vinay Pulim (with Claude)

## Why this note exists

v1 was hard to debug. Individual chat turns were hard to trace across the host → IPC → sandbox → agent → tool hops, and "what actually happened in turn X" usually required grepping three log streams with no reliable join key.

Week 3 just shipped the smallest e2e, so we now have a real hook bus and a real turn flowing end-to-end. This is the earliest point where observability design is grounded in something concrete rather than speculative — and the latest point where we can set invariants cheaply, before subscribers start depending on missing fields.

This note is **not** a plan to build an observability plugin. It's three invariants to lock in now, plus an explicit list of what we are deliberately *not* building yet.

## Evidence from v1 (what actually went wrong)

From investigation of `~/dev/ai/ax/`:

1. **Correlation ID threaded only at entry points.** `requestId` is generated at the HTTP boundary and bound to a child logger (`server-completions.ts:783`), then plumbed into sandbox pods via `AX_REQUEST_ID`. But sub-phases don't rebind — every IPC handler (`ipc-server.ts:308`, the `handler_start/done/error` trio) logs without the requestId. Every expensive action — `llm_call`, `call_tool`, `memory_write` — is invisible to a requestId grep. Optional threading = partial threading = useless threading.

2. **96 `console.log` calls bypass the structured logger.** Once some output skips the JSONL stream, the stream stops being a reliable source of truth. Scattered ad-hoc output across `src/cli/*` and `src/host/oauth.ts`.

3. **correlationId pairs request/response but doesn't reconstruct a turn tree.** v1's orchestration IPC schemas carry a correlationId for matching responses to requests. When a turn delegates (subagent, tool-that-calls-LLM), there's no parent/child relationship — just a flat pile of IDs.

What v1 got right: `TerminationPhase` + a single `logChatTermination` canonical event. One structured event per terminal outcome beat scattered error logs. Keep this pattern.

## Three invariants to lock in now

### 1. Correlation context lives on the hook bus `ctx`, not just in payloads

Every service hook invocation and every subscriber notification receives a `ctx` that includes:

- `session_id` — stable for the life of a chat session
- `turn_id` — unique per turn (one user message → one assistant response, including all tool calls and sub-model calls within)
- `parent_turn_id` — optional; set when a turn delegates to a subagent or a tool-that-calls-an-LLM

Required fields on `ctx`, not optional payload fields. The v1 lesson: if it's optional, it gets forgotten at a sub-phase, and the trace dies there.

A subscriber that wants to log, trace, or persist never has to ask "did the caller remember to pass the ID?" — the bus guarantees it.

### 2. `no-console` enforced by lint from day one

Alongside `no-restricted-imports` in `eslint.config.mjs`. The structured logger is the only sanctioned output path. Cheap now (zero existing violations); impossible later (v1 has 96 to unwind).

Exceptions (CLI output intended for humans on stdout) go through an explicit `cli.print()` helper, not raw `console.log`.

### 3. One canonical terminal event per turn

Port v1's `logChatTermination` pattern. A turn ends with exactly one structured event carrying `{ session_id, turn_id, phase, reason, duration_ms }`. Errors deep in a turn emit their own events but do not substitute for the terminal event. This is the single record a future observability plugin (or a human with `jq`) pivots on.

## What we are deliberately NOT building yet

- **No observability plugin.** Friction-driven skills policy applies to plugins too — we build it when 3+ sessions hit real tracing pain that the three invariants above didn't already solve.
- **No OpenTelemetry integration.** Committing to a wire format before we know what spans we actually want is the mistake. The correlation context on `ctx` is OTel-compatible in shape (it maps cleanly to trace_id / span_id / parent_span_id) but doesn't pick a backend.
- **No log aggregation backend.** Structured JSONL to stdout + file is enough until it isn't.
- **No sampling / retention policy.** Premature.
- **No UI for trace inspection.** Premature.

## What a future observability plugin would need (for design pressure, not to build)

When pain warrants it, an observability plugin would subscribe to hook-bus events, receive the `ctx` for free, and emit traces/metrics. It should not require changes to other plugins — if it does, invariant #1 failed and we fix that first.

The shape of such a plugin (OTel exporter, sqlite trace store, plain JSONL, something else) is explicitly deferred. The invariants above keep all of those options open.

## Open questions

- `turn_id` generation: kernel-assigned at turn start, or caller-supplied? Kernel-assigned is safer (can't be forgotten or collided) but requires the turn boundary to be a kernel concept.
- Do we want a `request_id` distinct from `turn_id` for the HTTP/transport layer, or collapse them? v1 had only `requestId` and suffered for it at the turn level. Leaning toward: transport-layer `request_id` is a separate optional field; `turn_id` is the observability primitive.
- Where does the `ctx` type live? `@ax/core`, presumably, since the hook bus does. Worth confirming when we wire this.

These are not blockers for the invariants. They're decisions for whoever first implements turn boundaries in the kernel.

## Recommendation

Adopt invariants 1–3 into `CLAUDE.md` (or the architecture doc, wherever the other invariants live) when the next hook-bus-touching PR lands. Do not open a separate PR just for this note — let it ride with real code that exercises the design.
