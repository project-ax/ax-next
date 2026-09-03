# TASK-278 — post-approval continuation renders live (plan)

## Problem (verified, not assumed)

A hold ENDS the turn on both runners (sdk: `main.ts` turn boundary after
`drainHoldLatch`; aisdk: `stopWhen: holdLatch.tripped` + `ctx.endTurn` every
loop). `chat:turn-end` → server clears `active_req_id`, emits `done`, evicts
the buffer → the browser stream closes. Correct.

On approve (attended path) the runner wakes on `decision-resolved` and runs a
host-initiated turn — but `run-runner.ts nextMessage()` sets
`currentReqId = undefined` ("no client waiting on a reqId"), so `emitChunk`
skips EVERY chunk. The content only reaches the user via turn-end → display
log → visible on reload. The client opens nothing (no reqId exists anywhere).
Copy says "we can carry straight on". That is the whole bug; the
"neither lib file opens chat/stream" claim in the brief is true but a
strawman — the stream belongs to the chat runtime, and no continuation reqId
exists for anyone to open.

## Fix: mint a continuation reqId at approve time and stream it

1. **Route `POST /api/workspace/decisions/:id/approve`** (channel-web):
   mint R2 (`makeReqId` from `@ax/core`), pass as `continuationReqId` into
   `decisions:approve`. When output `path === 'agent-executes'`, read
   `conversations:get-metadata` (liveness: `activeSessionId` non-null) then
   `conversations:bind-session(conversationId, sessionId, R2)`; respond
   `streamReqId: R2`. Any failure → `streamReqId: null` (today's behavior,
   honest receipts). Both hooks as `optionalCalls` with degradations.
   No new hook signatures here; consumer-side boundary note in PR body.
2. **`decisions:approve`**: input `+= continuationReqId?: string` (opaque,
   bounded). On the delivered agent-executes path only, put it on the
   `decision-resolved` entry and echo as output `streamReqId`. All other
   paths: ignored / null. Boundary review (hook-signature change) in PR body.
3. **Session inbox** (inmemory + postgres): `decision-resolved` entry
   `+= reqId?: string` — validate (bounded, optional) + pass through claim
   projection. Same field name/shape as existing `user-message` reqId.
4. **IPC wire** `SessionNextMessageResponseSchema`: decision-resolved
   `+= reqId` optional (else the runner's poll strips it).
5. **runner-core `nextMessage()`**: adopt `entry.reqId` when present instead
   of forcing `undefined`. `endTurn` already forwards `currentReqId`, so
   turn-end compare-clear, SSE `done`, and routine correlation follow with no
   further change. Covers BOTH runners (shared shell).
6. **Client**: `ApproveResult += streamReqId`; `useConversationDecisions`
   approve: when the decision belongs to the open thread and `streamReqId`
   non-null → `continuationActions.resume(reqId)`; runtime registers
   transport-backed resume → `chat.resumeStream()`; `AxChatTransport`
   overrides `reconnectToStream` to open `GET /api/chat/stream/R2`
   (buffer replay + live subs via existing `openSseStream`/`buildTurnStream`),
   returning `null` (quiet no-op) when no continuation is pending or the GET
   404s — never the retry banner (a regenerate here could DUPLICATE an
   already-running turn).
7. **Copy**: unchanged — "carry straight on" becomes true; null-streamReqId
   paths keep today's honest receipts.

## Tests (one per layer; Bug Fix Policy)

- decisions approve: with/without continuationReqId → entry + output.
- session stores (both): reqId survives queue→claim; validation rejects junk.
- runner-core decision-turn: entry reqId adopted → chunks emitted under R2;
  absent → skipped (existing).
- route: agent-executes → bind called, response carries R2; bind/metadata
  failure → null; other paths → null, no bind.
- client acceptance: approval on open thread with streamReqId → consumer
  opened for R2 (`GET /api/chat/stream/R2`); wrong-thread approval → none.
- transport: `reconnectToStream` with pending R2 opens GET; without → null.

## Risks

- R3 interleaving (user sends a message during an open hold): bind clobbers
  R3's active_req_id, but turn-end compare-and-clear is self-healing as long
  as every turn ends (analyzed in PR). Documented, not guarded.
- Appending R2 deltas to turn N's completed message via SDK resume: verify
  against installed ai@6 behavior in the client test (mock transport level,
  not full SDK).
