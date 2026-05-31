# TASK-89 — Make server early-bind authoritative (retry bind + 503 POST)

Follow-up to TASK-88 (#246, client-side ~30s SSE-open retry). This closes the
cold-respawn 404 **at the source** so the window never opens.

## Problem

`packages/channel-web/src/server/routes-chat.ts` `postMessage` does a best-effort
early bind of `active_req_id` before the 202 (lines ~461-506): guarded by
`if (bus.hasService('conversations:bind-session'))` + try/catch that logs
`chat_bind_session_failed` and falls through. When the bind doesn't land,
`active_req_id` only gets written by the orchestrator AFTER `sandbox:open-session`
— seconds later for a cold runner pod — so `GET /api/chat/stream/:reqId` 404s
until then.

## Contract (from the card, triage-resolved)

- Retry the bind with a small bounded budget.
- If the bind still can't be established → **503** on the POST (client retries the
  whole turn), not a 202 for a reqId whose stream can never open.
- Happy path unchanged: bind succeeds first try → 202, no added latency.
- Keep `chat_bind_session_failed` telemetry.

## Design

Extract a helper in `routes-chat.ts` (same file, internal — no hook-surface change,
no boundary review needed):

```
async function bindActiveReqIdAuthoritative(
  bus, ctx,
  { conversationId, sessionId, reqId },
): Promise<boolean>
```

- `bus.hasService('conversations:bind-session')` false → return `false` (can never
  bind → 503). Keeps the established `hasService` convention (orchestrator gates the
  same hook the same way; not a manifest call).
- Loop on a `Date.now() + BIND_TOTAL_BUDGET_MS` deadline (BIND_TOTAL_BUDGET_MS=400):
  - call `conversations:bind-session` → success returns `true`.
  - on throw: log `chat_bind_session_failed` (existing telemetry, preserved), then
    if budget remains, sleep a capped-exponential backoff (25ms ×2, cap 150ms,
    clamped to remaining budget) and retry; else return `false`.

`postMessage` calls it; on `false` → `res.status(503).json({ error: 'bind-unavailable' })`
and return (do NOT fire agent:invoke — there's no openable stream).

On `true` → existing flow: fire agent:invoke fire-and-forget, return 202.

Scope is strictly server-side. `transport.ts` is untouched: a non-OK POST already
throws in `sendMessages` → runtime onError → CONNECTION_LOST banner + manual retry
(the safe whole-turn re-POST). A 503 flows through that path unchanged.

## Tasks (independent, testable)

1. **Implement the bounded-retry bind helper + 503 wiring** in `routes-chat.ts`.
   - Add `BIND_TOTAL_BUDGET_MS`, `BIND_BACKOFF_*` consts, the helper, and the
     `postMessage` call-site change (203/503 branch). TDD.
   - Load-bearing: yes (the whole card).

2. **Tests** in `routes-chat.test.ts` (live testcontainers-postgres harness):
   - **Happy path unchanged**: bind succeeds first try → 202 with the conversation's
     `active_req_id` set (assert via `conversations:get-by-req-id` resolving the
     minted reqId, or a DB peek), and no added latency in the common case
     (assert the bind hook is called exactly once on the happy path).
   - **Transient-then-recovers**: a bind that throws on the first N calls then
     succeeds within the window → 202 with `active_req_id` set.
   - **Never-establishes**: a bind that always throws (or hasService false) → 503,
     not 202; agent:invoke NOT dispatched.
   - Use a stub `conversations:bind-session` plugin that the test can program to
     fail-then-succeed / always-fail, layered so it (not the real conversations
     plugin) answers the bind during these cases. NOTE the real conversations plugin
     also registers it — a duplicate registration throws; the stub-driven cases must
     boot a harness variant where ONLY the stub registers bind-session, OR the helper
     is unit-tested directly against a hand-rolled bus. Prefer a direct
     handler-level unit test of `bindActiveReqIdAuthoritative` for the
     retry/never-establishes cases (fast, deterministic, no fake timers against a
     live container), and one full-stack happy-path assertion via the existing boot.

   Decide in implementation which layering is cleanest given the harness; both
   acceptance bullets (recovers→202, never→503) must be covered by a unit test per
   the card.

## Gate

`pnpm --filter @ax/channel-web build && pnpm --filter @ax/channel-web test` +
lint green. Whole-branch `pnpm build`.

## Boundary review

No hook-surface change (internal helper in one file; the `conversations:bind-session`
signature is unchanged). New error string `bind-unavailable` is a route response
body, not a hook payload. No new dependency. No sandbox/IPC/untrusted-content change
→ security-checklist N/A (pure host-side control-flow on an existing trusted path).
