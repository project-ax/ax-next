# TASK-350 — a capability grant the workspace can answer

**Epic:** workspace-as-sole-interface (`docs/plans/2026-09-12-workspace-as-sole-interface.md`, Tier 1 #2).
**Scope decided with Vinay, 2026-09-15:** build the card's specified transport, name the gap it leaves, file the gap as its own card. See "The gap this does not close".

---

## The problem, from the code

`lib/workspace-api.ts`'s frame dispatch handles `done`, `error`, text and `decisionRaised`. A `permissionRequest` frame falls through to `return 'continue'` and is dropped. So an agent that hits the egress wall, or needs a skill credential mid-turn, has no way to ask on this surface. The wall holds server-side — this fails **closed**, not open — but the turn dead-ends with no path forward, and on the workspace that is the only outcome available.

## Two corrections to the card, both verified in code

The card is wrong about two things. Building what it literally says would produce a worse result, so this plan builds against the code and the card body gets corrected on the board.

**1. `permission-frames.ts` is not a grant helper.** The card says to reuse it "because it exists precisely so a second renderer does not re-invent the frame". That module is keyed on `CapabilityVerdict` (`'allow' | 'hold' | 'deny'`) and frames capability *rows* — `{icon, prefix: "Can", clause, suffix: "asks you first"}`. Its consumers are `routes-workspace.ts` and `workspace/bits.tsx`; `PermissionCard.tsx` does not import it (grep: 0). There is no existing React-free grant-card helper. Nothing to reuse here.

**2. One of the three kinds posts somewhere else.** The card says answering posts to `/api/chat/permission-decision`, "no new route". True for `skill` and `connector`. A `host` grant posts to `/api/chat/allow-host` with `{sessionId, host, persist}` via `grantHost`; `PermissionDecisionRequest` `.refine()`s that exactly one of `skillId`/`connectorId` is present, so there is no host arm to post to. The host card also has **three** buttons, not two: `Not now` / `Always for this agent` (`persist: true`) / `Just this once` (`persist: false`).

## The gap this does not close

The card's rationale and its transport contradict each other, and it is worth writing down so the next reader does not assume this shipped more than it did.

The card routes grants to Today by default *"because most grants will be raised by an agent working unattended with nobody watching."* But the only transport it names is the per-turn SSE frame, and `streamReply` has exactly one caller — `AgentView.tsx:342`, reached only after `sendMessage` or a pending-reply pickup. **On an idle Today, no stream is open.** A grant raised with the page closed, or after a reload, has nothing to arrive on. (Server-side replay via the TASK-82 chunk buffer only fires when a stream opens for that `reqId`; Today opens none.)

So what ships here is: *a grant raised while a turn is streaming becomes answerable from Today instead of killing the turn.* That is the dead-end the card exists to fix. It is **not** "unattended grants reach the queue" — that needs durable server-side pending-grant state plus a read route, and it is filed separately.

## Design

### The store — `src/lib/workspace-grant-store.ts`

A module singleton over `useSyncExternalStore`, cloned from `decision-raised-store.ts` (same file shape: `initial` / `state` / `listeners` / `subscribe` / `getSnapshot` / `notify` / `set`, one `use*` hook, a non-subscribing `get*Snapshot`, one `*Actions` object with `resetForTest` + `subscribeForTest`). The third `useSyncExternalStore` argument is the **stable** `initial`, never a fresh object — pinned by the sibling store's test.

A **list**, not chat's single slot: Today is a queue, and two grants can legitimately be open.

**Identity.** One grant, one row, never two live copies (invariant 4):

| kind | key |
|---|---|
| `skill` | `skill:${skillId}` |
| `connector` | `connector:${connectorId}` |
| `host` | `host:${host}` |

A repeat of an existing key **replaces in place** rather than appending, so a replayed frame does not double a row and the freshest `sessionId` wins for the POST. This mirrors the server's own buffer, which de-dupes permission cards by `skillId`/`host`.

**TASK-113 is kept.** A reactive `host` grant arriving while a `connector` grant is open is dropped. In a list the connector card would not literally be clobbered, so the rule could have been read as satisfied by showing both — but the wall is downstream of the same missing connector, so a second row would be noise pointing at a cause the first row already names. Chat drops it; the product should say one thing, not two.

### The copy — `src/lib/grant-copy.ts`

The trust copy is **not** currently importable: `GRANT_REASSURANCE` and the key-safety line are module-private consts and inline JSX inside chat-only `PermissionCard.tsx`, which TASK-360 deletes.

Repeating the literals in a second renderer would create exactly the hazard TASK-372 was just filed for — a second copy of security-critical text, in a file scheduled for deletion, with nothing keeping the two in step. So the shared strings **move out** into `src/lib/grant-copy.ts` (React-free, outside the deleted tree) and **both** renderers import them.

Chat's existing tests assert this copy by regex on rendered text, not by importing the consts, so moving the literal without changing the rendered string leaves them green and unedited.

### The renderer — `src/components/workspace/GrantRow.tsx`

A row in Today's existing bordered list, matching `DecisionRow`'s visual language. Composes installed shadcn primitives only — `Alert`, `Badge`, `Button`, `Input`, `Label` — with semantic tokens. Does not import `PermissionCard.tsx`.

Note `no-fixtures.test.ts` statically forbids any file directly under `src/components/workspace/` from importing `*-fixture` / `__tests__` / `/mock/` / `workspace-seed`.

Handles all three kinds. A card that handled one would leave the other two dead-ending, which is the bug.

### The wiring

`StreamHandlers` gains `onPermissionRequest?: (request: PermissionRequest) => void`; `streamReply` gains the frame branch, **non-terminal** (`return 'continue'`), alongside `decisionRaised`. `AgentView` passes it through to the store action — matching the workspace's callback idiom rather than writing the store from the transport the way chat does.

### The count — `TodayView`

Today's headline is built from a `WORDS` table of `'One decision'` … `'Five decisions'` and counts only `decisions.filter(isOpenDecision)`. With a grant in the queue both halves are wrong: the number is short, and "decision" is the wrong noun for a grant (the 2026-09-12 decision keeps grants and decisions as two types).

The heading's job is a **count**; the rows below already say what each thing is. An over-specific heading that is sometimes false is worse than a general one that is always true — and the zero case already carries no noun (`Nothing is waiting on you.`). So:

| open | before | after |
|---|---|---|
| 0 | `Nothing is waiting on you.` | unchanged |
| 1 | `One decision is waiting on you.` | `One thing is waiting on you.` |
| 2 | `Two decisions are waiting on you.` | `Two things are waiting on you.` |
| 6+ | `6 decisions are waiting on you.` | `6 things are waiting on you.` |

One sentence shape, no branching on queue composition, no way for it to lie. The summary sub-line (`N waiting on you`) already carries no noun and just needs the grant count added.

This edits assertions in `TodayView.test.tsx`. That is a deliberate copy change, not a test bent to fit an implementation.

## Tasks

1. `grant-copy.ts` + move the literals out of `PermissionCard.tsx`; chat's tests stay green **unedited**.
2. `workspace-grant-store.ts` + its test (identity, replace-in-place, TASK-113, reset seams).
3. `GrantRow.tsx` + its test (all three kinds, the POST per kind, failure leaves the row, no raw status).
4. Wire `StreamHandlers` → `streamReply` → `AgentView` → store, + test that a frame raises a row.
5. `TodayView` — render grants, fix the count, fix the copy, + tests.
6. Correct the TASK-350 card body on the board; file the durable-delivery follow-up.

## YAGNI pass

All six are load-bearing. 1 is the alternative to duplicating security copy. 5 is an explicit acceptance bullet. 6 is the card's own defect.

Cut: a `justResolved` receipt for grants (nothing persists them, so there is no resolved state to show); grant rendering in `AgentConversation` (that is TASK-351); any read route (out of scope by the decision above).

## Gate

`pnpm build`, then `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`.

Baseline on this branch before any change: `@ax/channel-web` 183 files / 1951 tests passing.

Security-checklist note required in the PR (capability boundary + untrusted content).
