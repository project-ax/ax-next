# 2026-05-05 — k8s acceptance regressions (Phase 2 wrap-up)

Phase 1 (PR #45) shipped a failing acceptance suite at
`presets/k8s/src/__tests__/k8s-e2e/runner-owned-sessions-k8s-gap.test.ts`
gated on `AX_K8S_E2E=1`. Phase 2 fixed two of the three regressions the
suite pins. One assertion remains as a known follow-up.

## What shipped

Three fixes in this PR — all share the root cause "ids not threaded
end-to-end through the IPC chain":

1. **`sandbox-k8s` + `sandbox-subprocess` + `chat-orchestrator`** —
   `OpenSessionInputSchema.owner` now accepts an optional
   `conversationId`; `chat-orchestrator` forwards `ctx.conversationId`
   when set. `session:create` writes `conversation_id` into the v2 row
   atomically; the runner reads it back via `session:get-config`.

2. **`ipc-http` listener** — per-request ctx now carries
   `auth.userId`/`auth.agentId`/`auth.conversationId` (parity with the
   `ipc-server` Unix-socket sibling that was fixed in PR #18). Without
   this, runner-side `/conversation.store-runner-session` and
   `/event.turn-end` calls flowed with `ctx.userId='ipc-http'`, breaking
   userId-scoped store updates and silencing chat:turn-end subscribers.

3. **`conversations:get`** — builds a synthetic ctx scoped to
   `conv.userId` + `conv.agentId` before the workspace round-trip. The
   host-side workspace plugins derive `workspaceId` from
   `(ctx.userId, ctx.agentId)`; channel-web's `initCtx`
   (userId='system', agentId='@ax/channel-web') looked up an empty
   workspace and returned `turns: []`.

## Bug 2 as side-effect

Bug 2's e2e (composer Send button never returns after turn end) closed
as a side effect of the `ipc-http` listener fix. The SSE per-connection
done-frame subscriber keys off `ctx.conversationId`; with that field
finally propagating, the done frame writes and the AI SDK runtime flips
the running flag.

## Known follow-up

Bug 1's e2e assertion 3 (turn-2 transcript contains "4711") still
fails. Investigation: the SDK is returning `model:"<synthetic>"`
placeholders with `usage.input_tokens=0` for every chat in this kind
cluster — runner pods exit ~1.6s after `pod_ready`, far too short for
a real Anthropic call. This is independent of the threading fixes
(assertions 1+2 verify the threading works) and reproduces on Bug 2's
chats too. Likely an environment issue: invalid Anthropic key,
credential-proxy substitution gap, or model ID unreachable. Worth a
dedicated follow-up.

## Bug 3

Still passes. Kept as a regression net.
