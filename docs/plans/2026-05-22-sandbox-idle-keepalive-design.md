# Sandbox Idle-Keepalive — Design

**Date:** 2026-05-22
**Status:** Approved design, pre-implementation
**Scope:** Single-user (kind / `replicas: 1`). Simplest correct change; no warm-pool cap, no eviction, no operator config seam.

## Problem

Every chat turn spins up a fresh sandbox pod and re-materializes `/permanent`
from the workspace bundle (a `git clone` whose cost grows with workspace size).
For larger workspaces this dominates turn latency. We want to leave a sandbox
running for a short idle window after the latest turn so the next turn on the
same conversation reuses the warm runner and skips the re-materialize.

## Key finding: the stack already expects warm sandboxes

The persistence and routing layers were built for keepalive; one flag
contradicts them.

- **Runner is persistent by design.** Its inbox loop blocks on `inbox.next()`
  after a turn, ready to service the next user message.
- **Reuse path already exists.** `chat-orchestrator` `runAgentInvoke` routes a
  turn into an existing live session when `ctx.conversationId` maps to an
  `active_session_id` that `session:is-alive` confirms — skipping
  `sandbox:open-session` entirely (orchestrator.ts ~585–720).
- **Conversations layer keeps the pointer warm.** On `chat:turn-end` it clears
  `active_req_id` but deliberately **keeps `active_session_id`** — comment:
  "The sandbox stays alive for the next turn" (conversations/plugin.ts:325).
  Its `session:terminate` subscriber clears `active_session_id` across all
  bound rows via `clearBySessionId` (plugin.ts:338).
- **Sandbox providers self-clean on exit.** `sandbox-k8s` open-session wires
  `void exited.then(...)` → `session:terminate` + `killPod` (open-session.ts:412),
  independent of the orchestrator.

The single thing forcing a fresh pod every turn is **`oneShot` (defaults
`true`)**: on the first `chat:turn-end`, `onTurnEnd` queues a `cancel` into the
inbox (orchestrator.ts:1319). The runner drains and exits, `handle.exited`
resolves, `session:terminate` fires, `active_session_id` is cleared — so the
next turn always falls through to a fresh spawn + re-materialize.

So this is not "build sandbox pooling." It is: **resolve the turn on
`chat:turn-end` instead of tearing down, and reap on an idle window instead of
immediately.**

## Why teardown must not trust the runner

The naive version — let the runner self-time-out and exit — has a fatal hole:
**you cannot ask a hung process to kill itself.** A wedged event loop, a gVisor
freeze, an OOM-throttle, or an SDK-child deadlock that takes the parent loop
with it all prevent the self-reap path from ever running. Under that failure the
pod sits at phase=Running, `session:terminate` never fires, `active_session_id`
stays set, and the next turn routes into a dead inbox and hangs until
`chatTimeoutMs` (10 min) — repeatedly, until the wall-clock ceiling.

The reaper of last resort must therefore live **outside** the sandbox —
something that kills the pod without the runner's cooperation. `handle.kill()`
(→ `killPod` → kubelet SIGTERM, grace, then SIGKILL) is exactly that. So the
**load-bearing idle reaper is host-side**: a per-session idle timer that calls
`handle.kill()` on expiry. It reaps a healthy idle pod and a wedged pod by the
same path.

## Design: three reaper layers

| Layer | Owner | Covers | Latency |
|---|---|---|---|
| **Primary — host idle timer → graceful `cancel`, then force `handle.kill()`** | orchestrator | normal idle **+ wedged/frozen runner** | idle window (~5 min) + grace (~10 s) |
| **Floor — runner self-idle exit** | runner | host process crashed, runner still healthy | idle floor (~10–15 min) |
| **Ceiling — `activeDeadlineSeconds`** | k8s | host crashed **and** runner wedged (double-failure) | ≤ 6 hr |

The host timer is primary because its force step (`handle.kill()` → `killPod`)
does not trust the runner — that is what closes the hang hole. But it reaps
**graceful-first**: on idle expiry it queues a `cancel` into the inbox (the
existing one-shot mechanism, just delayed) and starts a short grace timer.

- **Healthy runner:** receives the `cancel`, drains, emits its single real
  `event.chat-end`, and exits — `handle.exited` fires the cleanup. The grace
  timer is cleared. This is the common path and it preserves today's
  `chat:end` semantics (see "Subscriber semantics" below).
- **Wedged runner:** can't process the `cancel`. The grace timer expires →
  `handle.kill()` → kubelet SIGKILL → `handle.exited` fires the cleanup. The
  one cost is that a hung session never emits `chat:end` (memory-strata's
  consolidation trigger is lost for that one degenerate session — acceptable).

The runner floor adds only host-crash robustness (a wedged runner cannot
self-exit, so the floor never helps the wedge case). The ceiling is the rare
double-failure backstop.

## Subscriber semantics — what stays unchanged

The investigation found the channel-web request path and the `chat:end`
consumers are already compatible with keepalive, which keeps the blast radius
small:

- **SSE already completes on `chat:turn-end`.** `channel-web` dispatches
  `agent:invoke` fire-and-forget (routes-chat.ts:411) and the browser streams
  the reply over an SSE channel that attaches a `chat:turn-end` subscriber and
  closes on it (sse.ts:22–28). So the UI shows a complete turn on turn-end
  today, independent of the one-shot cancel/`chat:end`/teardown that follows.
  **No SSE change.**
- **audit-log does not subscribe to `chat:end`** (only `event.http-egress`).
  **Unaffected.**
- **memory-strata uses `chat:end` as a debounced, per-agent consolidation
  trigger** that reads canonical inbox/docs state, not the payload messages
  (plugin.ts:167,204). Because the graceful reap keeps a healthy runner
  emitting a real `chat:end` on exit, memory-strata still fires — once per
  session-end instead of once per turn, coalesced by its existing debouncer.
  **No memory-strata change.**
- **CLI stays one-shot** (`keepAlive` defaults off). Its `chat:end`-driven
  resolution and per-turn teardown are unchanged.

The one thing that genuinely moves: a single user message emits **two**
`chat:turn-end` events (role=`tool` then role=`assistant`, both
`reason: 'user-message-wait'`, both carrying the originating `reqId`;
main.ts:949–999). The per-request deferred resolves on the **first** turn-end
seen for that `reqId` — the `Deferred.settled` guard makes the second a no-op,
and the idle-timer (re)arm is idempotent.

## Constants (hardcoded — no operator config seam)

- **Host idle window:** ~5 min (300 s). Reset on each turn routed to the session.
- **Runner self-idle floor:** ~10–15 min. Must sit strictly between the host
  window and `activeDeadlineSeconds` so the host timer normally wins and the
  floor only acts when the host is gone.
- **`activeDeadlineSeconds`:** **21600 (6 hr)**, changed from the current `3600`
  default in `packages/sandbox-k8s/src/config.ts:120`.

Final values for the two timers are tunable during implementation; the ordering
constraint (`hostWindow < runnerFloor < activeDeadlineSeconds`) is the invariant.

## Component changes

### `chat-orchestrator` (the bulk)

- **Keepalive mode.** Add a caller-set `keepAlive` flag alongside the existing
  `oneShot` (web/channel preset = keepalive; CLI stays one-shot). Code-level
  caller distinction, not an operator config seam.
- **`onTurnEnd(ctx, payload)` resolves the request and arms the reaper.** Pass
  the turn-end payload through (plugin.ts subscriber currently drops it). In
  keepalive mode `onTurnEnd`:
  1. Resolves the per-request deferred (look up `payload.reqId`, falling back to
     the `sessionId` index like `onChatEnd`) with a synthesized
     `{ kind: 'complete', messages: [] }` — the real content already streamed
     via SSE and persisted via `chat:turn-end → conversations`; the channel-web
     caller ignores the return (fire-and-forget). Idempotent across the two
     turn-ends via `Deferred.settled`.
  2. (Re)arms the per-session idle timer. **Does not queue `cancel`.**
- **`runAgentInvoke` keepalive tail.** When the deferred resolves on turn-end:
  skip the step-7 `handle.kill()`, skip the per-invoke `proxy:close-session`,
  and leave the handle in the registry. (One-shot path unchanged.)
- **Session→handle registry.** A `sessionId → { handle, idleTimer, graceTimer }`
  map that outlives the request, populated on fresh spawn. At spawn we register
  a single `handle.exited.then(...)` cleanup that fires `proxy:close-session`
  once and deletes the registry entry — covering every exit path (graceful
  cancel, force-kill, runner floor, ceiling).
- **Idle-timer callback (graceful-then-force):** queue a `cancel` into the
  inbox (reusing the existing `cancelledSessions` dedup) and start a grace
  timer; on grace expiry call `handle.kill()`. A routed turn arriving first
  clears both timers via the re-arm.
- **Relocate `proxy:close-session`** from the per-invoke `finally` (keepalive
  mode) to the `handle.exited` cleanup, so the proxy session lives exactly as
  long as the runner. It is opened once per sandbox (fresh-spawn only,
  orchestrator.ts:759); the routed invoke never opened one so its `finally`
  already skips it. API-key-only credentials (this deployment) need no rotation
  across the idle window.

### `agent-claude-sdk-runner`

- Bound the inbox wait with an idle timeout (the floor) in `inbox-loop.ts` /
  `main.ts`. On expiry the `userMessages()` generator `return`s exactly as it
  does on `cancel` (main.ts:399–400) → the SDK drains → the runner emits its
  single `event.chat-end` and exits. No new exit path: it reuses the cancel
  drain. The sandbox provider's existing `watchPodExit` → `session:terminate`
  handles the unwind. The floor must be configured longer than the host idle
  window so the host timer normally wins.

### `sandbox-k8s` / `sandbox-subprocess`

- No behavioral change. `handle.kill()` and self-cleanup-on-exit already exist.
  Only the `activeDeadlineSeconds` default changes (k8s config).

### `session:is-alive`

- **Unchanged** for this slice. The host timer bounds the wedge window to the
  idle window, so the chance of routing a turn into a not-yet-reaped wedged
  runner is small and self-correcting (one `sandbox-exit-before-chat-end`
  terminated turn, then a fresh spawn). Probing pod-Ready is a recorded future
  hardening, not part of this slice.

## Recorded decisions / known interactions

1. **6 hr ceiling vs 1 hr.** Raising `activeDeadlineSeconds` to 21600 means a
   continuously-active conversation stays warm for 6 hours before the wall-clock
   ceiling forces a re-spawn (effectively never for a single user). The only
   cost is the rare **double-failure** orphan — host process crashed *and* its
   runner is wedged so the floor can't fire — which now lingers up to 6 hr
   instead of 1. Given the floor covers host-crash-with-healthy-runner and the
   host timer covers wedge-with-live-host, the double failure is unlikely enough
   that the longer window is a fair trade for never killing an active session.
2. **`activeDeadlineSeconds` is wall-clock from pod start and cannot be reset on
   a live pod.** So it caps total warmth, not idle time. The idle timers (host +
   runner floor) are what bound idle pods; the ceiling only bites a session
   active for the full window.
3. **Mid-turn wedge is out of scope.** A runner that wedges *during* a turn
   (not idle) still hangs until `chatTimeoutMs` (10 min). This is unchanged from
   today — keepalive does not make it worse — and improving it (liveness probe /
   per-turn watchdog) is a separate concern.
4. **Workspace freshness is a non-issue.** The runner already commits + bundles
   `/permanent` at every turn boundary, so a warm working tree stays consistent
   with host storage across turns; reuse loses nothing.

## Out of scope (deferred)

- Warm-pool cap, LRU eviction, per-user limits (multi-tenant governance).
- Operator-tunable config for idle windows.
- `session:is-alive` liveness probing.
- Multi-replica session affinity (host is `replicas: 1`; affinity routing is
  already deferred in the chart).
- Mid-turn hang detection.

## Invariant check

- **I1 (transport/storage-agnostic hooks):** no new hook surface — reuses
  `chat:turn-end`, `session:terminate`, `handle.kill()`. No backend vocabulary
  added.
- **I3 (no half-wired plugins):** keepalive is wired in the channel-web preset
  in the same change that adds it; the CLI keeps one-shot. No dormant code path.
- **I5 (capabilities minimized):** no new runner-served port or capability; the
  runner gains only an inbox-wait timeout. The host gains no new reach (it
  already holds `handle`).
