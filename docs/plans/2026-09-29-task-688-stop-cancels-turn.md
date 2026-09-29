# TASK-688 — Stop cancels the in-flight turn (both runners)

Launch blocker. The workspace has no Stop control and no host route cancels a
running turn. The original card blamed `lib/transport.ts` (deleted in #751); the
real gap is the whole path: SPA control -> host route -> orchestrator -> session
inbox -> runner -> model call / tool run.

## What reading + probing established

- `cancel` = "end the session" (`nextMessage()` -> null -> runner drains and
  exits). It never stops an in-flight turn. claude-sdk pulls ahead, so a mid-turn
  `cancel` only closes the SDK's input stream; aisdk does not read the inbox
  during a turn at all. => Stop needs its **own inbox entry**, `interrupt`.
- Real `claude` binary probe (2026-09-29, scripted fake Anthropic server):
  `Query.interrupt()` kills a running Bash (exit 137, tool_result is_error),
  yields `result{error_during_execution, terminal_reason: aborted_tools |
  aborted_streaming}`, keeps partial assistant text, and the same `query()`
  serves the next message. The runner's existing `result` branch already calls
  `endTurn`.
- ai@7: `agent.stream({abortSignal})` -> `abort` part; Bash already kills its
  process group on the tool `abortSignal`; host/sandbox-catalog tools ignore it.
- Stop can be clicked during a cold spawn (`active_req_id` is bound at POST time),
  when no session exists yet.

## Contract (shared by all streams)

| Thing | Shape |
|---|---|
| Inbox entry (host -> `session:queue-work`) | `{ type: 'interrupt' }` (no payload) |
| Wire (`session.next-message` response) | `{ type: 'interrupt', cursor }` |
| Host hook (`@ax/chat-orchestrator`) | `agent:interrupt` `{ conversationId: string; userId: string }` -> `{ interrupted: boolean }` |
| Route (`@ax/channel-web`) | `POST /api/chat/conversations/:id/interrupt`, no body. 200 `{ interrupted }`; 401 `{error:'unauthenticated'}`; 404 `{error:'conversation-not-found'}` (unknown AND foreign) |
| SPA api | `workspaceApi.interruptTurn(conversationId): Promise<{ interrupted: boolean }>` |
| Runner shell | `LoopContext.onInterrupt(handler): () => void` (disposer) |

## Tasks

1. **ipc-protocol + session backends**: `interrupt` arm in
   `SessionNextMessageResponseSchema`; `interrupt` in `@ax/session-inmemory` and
   `@ax/session-postgres` (types, queue validation, deliver, return schemas).
   Load-bearing: the wire.
2. **runner-core**: `InboxLoopEntry` gains `interrupt`; the shell owns a single
   inbox reader (`pump`), routes `interrupt` to `ctx.onInterrupt` handlers, keeps
   a read outstanding while a turn is active, latches an early interrupt, drops
   an idle one. Load-bearing: without it aisdk never sees the entry.
3. **aisdk loop**: per-turn `AbortController` -> `agent.stream({abortSignal})`;
   coherent transcript on abort; runner stays ready. Test: mock model + REAL
   Bash (`sleep && touch` marker must not appear).
4. **claude-sdk loop**: `queryIter.interrupt()` on `onInterrupt`. Test with the
   faked `query()`.
5. **orchestrator**: `agent:interrupt` (+ deferral for cold spawn). Tests via
   `createTestHarness`.
6. **channel-web server**: route + wire type + manifest `optionalCalls` + test
   mock registrants.
7. **channel-web SPA**: `interruptTurn`, Stop button in the composer (shadcn
   `Button`, semantic tokens), "Stopped" notice, never-stuck fallback.
8. **docs + memory**: architecture doc (`agent:interrupt`, `interrupt` entry),
   decisions shard, MANUAL-ACCEPTANCE scenario.

## Cut (YAGNI)

- Persisted "Stopped" marker (new display-event kind + turn-end reason).
- Targeting a specific reqId in the entry (the host only queues it for the
  conversation's `active_req_id`; a stale one is dropped by an idle runner).
- Aborting host tools already dispatched over IPC (no cancellation token).

## Boundary review (PR body)

- Alternate impl: `agent:interrupt` — a multi-replica orchestrator that routes
  the interrupt to the replica owning the session; `interrupt` entry —
  session-inmemory and session-postgres already implement it.
- Leaky names: none (`conversationId`, `userId`, `interrupted`).
- Subscriber risk: none — it is a service hook with one registrant, not a
  subscriber hook.
- Wire surface: the `interrupt` arm lives in `@ax/ipc-protocol`
  (`SessionNextMessageResponseSchema`), next to the other three inbox variants.
