# TASK-261 — an in-thread approval control on the default `/` chat surface

**Card:** No in-thread approval card on the `/` chat surface — the agent promises one that isn't there.
**Epic:** agent-workspace. **Parent:** TASK-236 (walk-fail).
**Branch:** `auto-ship/TASK-261-approval-on-default-surface`.

> **Amended after rebase.** This was written against a `main` where the decisions
> collection was four routes. TASK-259 landed first and added a fifth,
> `GET /api/workspace/decisions/:decisionId` (the undo-window re-read). Read every
> "four decision routes" below as "the decisions collection" — the shipped rule is
> that the *whole collection* mounts unconditionally, pinned as a property by
> `routes-workspace-decisions-unflagged.test.ts` rather than as a count.

## The problem, precisely

`@ax/decisions` holds an outward-facing tool call inside `tool.pre-call` and writes a
`Decision` row. The whole resolution path — the four `/api/workspace/decisions*` routes,
the `useDecisionQueue` hook, `ApprovalCard`, the undo window — already ships. It is just
**unreachable from the surface people actually use**:

- `registerWorkspaceRoutes` mounts every `/api/workspace/*` route inside
  `if (opts.agentWorkspacePreview)`. Flag off ⇒ the four decision routes are never
  registered ⇒ 404, not merely hidden.
- `ApprovalCard` is rendered only by `AgentConversation`, which only `/workspace` mounts,
  which only renders when `features.agentWorkspacePreview` is true.
- The server ALREADY pushes a conversation-scoped `decisionRaised` SSE frame on the chat
  stream (`src/server/sse.ts` §4c-quater). `src/lib/transport.ts` — the `/` surface's
  reader — has no branch for it, so on `/` the frame falls through every `if` and is
  silently dropped. Only `workspace-api.ts` consumes it.

So a held call on `/` produces prose telling the user to approve something, and nothing
to approve it with.

## Chosen approach — branch (a), unflagged

Per the requester's clarifications on the card (this is spec):

1. **Render the shipped `ApprovalCard`, reused as-is** — approve / deny **and** the undo
   window. No second renderer, no reduced control.
2. **The approval path mounts unconditionally.** `AX_AGENT_WORKSPACE_PREVIEW` keeps
   gating `/workspace`; the four decision routes and the `/`-surface control do not
   consult it.
3. **One decision, one set of controls.** Both surfaces render the same component fed by
   the same `useDecisionQueue` hook against the same route. Nothing is forked.

### Placement — above the composer, the `PermissionCard` precedent

`PermissionCard` is the shipped in-app interactive card on `/`. It is **not** a
`MessagePrimitive` part: it renders inside `ComposerPrimitive.Root`, above the status row
and the input, driven by a module store the SSE reader writes to. The approval control
takes exactly that shape and the slot directly above it.

This is not a compromise placement. `/workspace` does the same thing: `approvalMessages()`
appends the open decisions to the **end** of the thread, sorted by `createdAt` — it does
not interleave them with the tool call that produced them. Pinned above the composer is
the same "last thing in the conversation" semantics, and it is where the reader's eyes
already are.

Making the card a real transcript part would need a decisionId↔toolCallId join that the
wire deliberately does not carry (`call` is dropped from the projection because
`call.input` is model-authored). Inventing one is out of scope and would fork the surfaces.

### Data flow

```
tool.pre-call hold → decisions:raised → SSE {reqId, decisionRaised:{decisionId,summary}}
                                              │
                       transport.ts branch ───┘  (non-terminal, nothing enters the transcript)
                                              ↓
                       decisionRaisedActions.raise()      (module store, a counter)
                                              ↓
                       useConversationDecisions() → useDecisionQueue().refresh()
                                              ↓
                       GET /api/workspace/decisions  (unflagged now)
                                              ↓
                       filter d.conversationId === useConversationId()
                                              ↓
                       <ApprovalCard/>  ← the same component /workspace renders
```

The **frame is a trigger, not the render source.** It carries only `{decisionId, summary}`
— nowhere near enough for `ApprovalCard` (detail, labels, preview, status, `undoable`).
The list route stays the one producer of decision rows (invariant 4); the frame just says
"read it again now". A page reload restores the card through the same read, with no buffer
replay to maintain.

## Tasks

### T1 — unmount the flag from the four decision routes (server)

`packages/channel-web/src/server/routes-workspace.ts`, `registerWorkspaceRoutes`.

Move `GET /api/workspace/decisions` and the three
`POST /api/workspace/decisions/:decisionId/{approve,dismiss,undo}` entries out of the
`if (opts.agentWorkspacePreview)` block into the always-mounted list next to
`/api/features`. Every other `/api/workspace/*` route stays gated. Rewrite the function's
doc comment to say which routes mount always and why.

No handler changes. The handlers already gate correctly on their own:
`authOr401` → `decisions:list` / `loadOwnedDecision` (owner-scoped `decisions:get`, then a
second `resolveAgentOr404`). Ungating widens *reachability*, not authority — and an
un-actionable hold is the security-relevant failure here, not the route.

**Test** (`src/__tests__/server/`): register with `agentWorkspacePreview: false` and assert
the four decision paths ARE registered while `/api/workspace/state` and
`/api/workspace/activity` are NOT; and with the flag on, everything is.

*Load-bearing at MVP?* Yes — without it the `/` control 404s on every default deployment.

### T2 — `decisionRaised` on the `/` transport

New `packages/channel-web/src/lib/decision-raised-store.ts` — the same
`useSyncExternalStore` single-module shape as `permission-card-store.ts` /
`agent-status-store.ts`. State is `{ raised: number }`: a monotonic count of
`decisionRaised` frames seen this page-load. Actions `raise()`, `reset()`,
`resetForTest()`. Hook `useDecisionRaised()`.

Why a counter and not the frame's payload: the payload cannot render the card (above), so
storing it would be a second, poorer copy of a row the list route owns. What the counter
buys is (a) a refresh trigger and (b) positive evidence that something IS waiting, which
T4 needs to decide whether a failed read is worth saying out loud.

`packages/channel-web/src/lib/transport.ts`:
- add the `decisionRaised` arm to the client's local `SseFrame` union (it re-declares the
  server union structurally rather than importing it);
- add a branch beside the `permissionRequest` one — same posture: validate the
  `decisionId` is a non-empty string, call `decisionRaisedActions.raise()`, `continue`.
  **Non-terminal, and it never touches `controller`** — nothing enters the transcript.

**Tests:** store unit test; a transport test asserting a `decisionRaised` frame bumps the
store, does not end the stream, and emits no UIMessageChunk.

### T3 — `useConversationDecisions()`

New `packages/channel-web/src/lib/conversation-decisions.ts`. Composes, owns no state of
its own:

- `useDecisionQueue()` — the existing hook. Not copied, not re-implemented: it is where
  the "never guess an outcome / a failed POST changes nothing and says so" rules live, and
  TASK-259's undo fix lands inside it. Consuming it means `/` inherits that for free.
- `useConversationId()` — the active conversation, `null` on the welcome state.
- `useDecisionRaised()` — refresh when a frame lands.

Behaviour:
- rows filtered to `d.conversationId === conversationId`, split on the canonical
  `isOpenDecision()` (not a second predicate), sorted by `createdAt` ascending
  (the same order `approvalMessages()` uses on `/workspace`);
- receipts capped at 3, **except** any row the server still reports `undoable` — the
  cap trims history, and a live Undo is not history;
- `conversationId === null` ⇒ no rows, and no failure line;
- refresh on a new `raised` count, and on a conversation change (a decision raised in
  another tab is otherwise invisible until reload);
- `decisionRaisedActions.reset()` when the conversation changes, so evidence from thread A
  cannot speak for thread B.

**Tests:** filtering, ordering, refresh-on-raise, reset-on-conversation-change.

### T4 — `<InThreadApprovals />` and its mount

New `packages/channel-web/src/components/InThreadApprovals.tsx`. Reads
`useConversationDecisions()` and renders one `ApprovalCard` per row, wired to the queue's
`approve` / `dismiss` / `undo` / `busyIds` / `notices` — the identical prop set
`AgentConversation` passes. Returns `null` when there is nothing to show.

Import path is `@/components/workspace/ApprovalCard`. The component is NOT moved: it sits
in a cluster with `decision-copy.ts`, `use-decision-clock.ts` and `DecisionRow.tsx`, and
splitting one member out of that cluster to make a directory name read better would churn
files two sibling cards are editing right now, for nothing. Its header comment gets a line
saying it now renders on both surfaces.

**The failed read.** `useDecisionQueue` separates a failed READ from an empty queue on
purpose. On `/` this fetch is ambient — it runs on every page load for every user — so an
error line on every conversation during an outage would be noise about approvals most
readers do not have. We say something only when we have positive evidence one exists:
`error !== null && raised > 0` renders a shadcn `Alert` with a retry that calls
`refresh()`. Otherwise the banner stays down — but **every** failed read is
`console.warn`ed regardless of evidence, deduped per distinct error so the cards'
own clock cannot spam it. Quiet in the UI, never silent everywhere: on a default
deployment this is the only decision surface there is, so a failure with no signal
at all would be this card's dead end reborn on the error path. The residual hole —
a failed FIRST read after a reload, where the frame is long gone, so the reader sees
nothing until the next read succeeds — is called out as a follow-up rather than
papered over.

Mount in `packages/channel-web/src/components/Composer.tsx`, inside
`ComposerPrimitive.Root`, immediately above `<PermissionCard />`.

**Tests** (`src/__tests__/in-thread-approvals.test.tsx`): a pending decision on the active
conversation renders `approval-<id>` with its primary and ghost labels; a decision on a
different conversation does not; approve POSTs and swaps in the server's row; the undo
affordance appears on the resolved row; a failed read with evidence shows the alert, and
without evidence shows nothing.

### T5 — memory + PR body

Log the decisions below to `.claude/memory/decisions.md`. No new hook surface is added, so
no boundary review is required; the PR body says so and explains the ungating.

## Decisions to log

| Decision | Rationale | Alternative rejected |
|---|---|---|
| Mount above the composer, not as a transcript part | `PermissionCard` precedent; `/workspace` also appends approvals at the end of the thread rather than interleaving | A real message part needs a decisionId↔toolCallId join the wire deliberately drops |
| Ungate only the four decision routes | Card spec: the remedy ships unflagged, the preview surface stays gated. Smallest reachability widening (invariant 5) | Ungating all of `/api/workspace/*`; a second `/api/chat/decisions*` mount (two producers, invariant 4) |
| The SSE frame refreshes; the list route renders | The frame carries `{decisionId, summary}` only — a card built from it would be a second, worse copy of the row | Rendering from the frame payload |
| Reuse `useDecisionQueue` verbatim | The decision machine has one client copy and it is that hook; TASK-259's undo fix lands inside it | A `/`-specific fetch hook — a second place to get an outcome wrong |
| `ApprovalCard` stays in `components/workspace/` | It is one of four files in a cluster; moving it churns files two sibling cards are editing | Moving it to a neutral directory |
| Quiet on a failed read with no evidence of a hold | This read is ambient on every page load; an outage must not put approval copy in front of every user | Always showing the error; never showing it |

## Out of scope / follow-ups

- A failed **first** decisions read (no live frame to corroborate) leaves a held call
  invisible until the next reload. Needs a bounded retry inside `useDecisionQueue`.
- Interleaving the card with the tool call that produced it. Needs a decisionId↔toolCallId
  link on the wire.
- TASK-260 (the hold rendering as a failed tool call) and TASK-259 (undo outliving
  `consumedAt`) are shipping in parallel and are not duplicated here.
