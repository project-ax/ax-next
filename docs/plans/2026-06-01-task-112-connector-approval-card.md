# TASK-112 — Connector approval card: render branch in PermissionCard + fire on warm-resume

Bug fix from the TASK-101 e2e walk. The host (TASK-94) already fires a
`kind:'connector'` SSE permission card, but channel-web never rendered it and the
orchestrator never re-fires it on the warm-resume path. Two bugs.

## Bug 1 (blocker) — channel-web has no `connector` kind anywhere

The `PermissionRequest` union (store + transport + server types) only has
`'skill'` and `'host'`. A `kind:'connector'` card:
- has NO render branch in `PermissionCard.tsx` → falls into the skill default →
  `request.description.length` throws (connector cards carry connectorId/name, NO
  description).
- the SSE buffer-fill subscriber drops it (neither `'skill'` nor `'host'`), so a
  card raised during a cold-boot SSE race is never replayed → un-approvable (the
  exact TASK-82 hazard skill cards were hardened against).
- the `/permission-decision` route only knows `skillId`.

Host connector card payload (source of truth = chat-orchestrator `connector-card.ts`):
`{ kind:'connector', connectorId, name, hosts:string[], slots:[{slot,kind:'api-key',account?,haveExisting?}], authored:true, packages:{npm,pypi} }`
— NO `description`.

## Bug 2 — upfront connector card misses the warm-resume path

`runAgentInvoke`'s routed/warm branch (orchestrator.ts ~L1239-1360) returns at
~L1359, BEFORE the fresh-spawn connector-card block (~L2107). So a draft proposed
mid-turn never gets carded on the next warm turn — surfaces a reactive egress wall
instead. The `connectors:list-authored` resolve also currently lives only after the
routed branch returns.

## Tasks (TDD — failing test FIRST per Bug Fix Policy)

### Task 1 — channel-web `PermissionRequest` union gains the connector kind
Files: `lib/permission-card-store.ts`, `lib/transport.ts` (SseFrame inner),
`server/types.ts`. Add a third member:
`{ kind:'connector'; connectorId:string; name:string; hosts:string[]; slots:[{slot,kind:'api-key',account?,haveExisting?}]; authored?:boolean; packages?:{npm,pypi} }`.
Re-declared locally at each boundary (I2; same posture as skill/host). `packages`
optional at the SSE boundary (liberal-in-what-you-accept, existing convention).
NO `description` field.

### Task 2 — `PermissionCard.tsx` connector render branch + approve path
- New `if (request.kind === 'connector')` branch (testid `permission-card-connector`).
  Title "Connect {request.name}", shows hosts badges + slot inputs + packages line
  + authored banner — reusing the skill branch's sub-render shape, NO description.
- `approveConnector()`: writes each filled slot via `setDestinationCredential`
  (account-tagged → `{kind:'account',service:s.account}`; untagged →
  `{kind:'account',service:connectorId}` — matches host `account:<slot.account ?? connectorId>`),
  then POSTs `/api/chat/permission-decision` with `{ conversationId, connectorId, shown }`
  (connectorId subject — reuses TASK-93 wall via the host grant), then
  `resumeActions.continueAfterGrant()`. Gated on conversationId + all slots filled.
- The shared `allSlotsFilled`, `connect`, `allow` guards updated to be connector-aware.

### Task 3 — `/permission-decision` route connector branch
Files: `wire/chat.ts` (schema), `server/routes-chat.ts`.
- `PermissionDecisionRequest` accepts EITHER `skillId` OR `connectorId` (both ≤128;
  `shown` shared). Use a refine so exactly one is present.
- Route: when `connectorId` present, call `agent:apply-authored-connector-grant`
  with `{conversationId,userId,agentId,connectorId,shown?}` (host is authoritative —
  unknown connectorId → not-authored → fall through to 200/skip; no catalog fallback
  for connectors). On `applied`, `onCardResolved(conversationId, connectorId)`.

### Task 4 — SSE buffer-fill + eviction for connector cards
Files: `server/sse.ts` (`createPermissionCardFillSubscriber`), `server/chunk-buffer.ts`.
- Buffer connector cards keyed by `ctx.conversationId` (conversationId-matched, like
  skill cards). `appendPermissionCard` de-dupes connector cards by `connectorId`.
- `tailPermissionCards`/replay already conversationId-keyed → connector cards ride it.
- `evictPermissionCard(conversationId, id)` also drops connector cards whose
  `connectorId === id` (keeps the one-arg callback; no signature churn).

### Task 5 — orchestrator warm-resume connector card fire
File: `chat-orchestrator/src/orchestrator.ts`.
- Extract the fresh-spawn card-fire block (~L2107-2144) into a local helper
  `fireUpfrontConnectorCards(ctx)` that resolves `connectors:list-authored`
  (best-effort, hasService-gated) + vaultedRefs + dedup-fires. Call it from BOTH
  the fresh-spawn path AND the routed/warm branch (before its return at ~L1359).
- Dedup map `upfrontConnectorCardsByConv` already shared across paths → no double-card.

## Tests (all FIRST)
- `permission-card.test.tsx`: connector card renders (no TypeError), shows name +
  hosts + slot field; Connect writes account-dest credential + POSTs
  `{connectorId,...}` to permission-decision + continues; declining dismisses.
- `routes-chat-card-eviction.test.ts` (or routes-chat.test.ts): a connectorId
  decision routes to `agent:apply-authored-connector-grant` + fires
  `onCardResolved(conv, connectorId)`.
- `chunk-buffer.test.ts`: connector card buffers + de-dups by connectorId + evicts.
- `route-by-conversation.test.ts`: a pending connector draft on the WARM/routed path
  fires ONE `kind:'connector'` chat:permission-request (the Bug-2 regression).

## Invariants
- I2 no cross-plugin imports: every connector shape re-declared locally.
- I4 one source of truth: reuse TASK-93 wall (connectorId subject), do NOT fork; reuse
  the single connector-card-fire path across fresh+warm.
- I5 trust boundary: connectorId is a client-supplied identifier matched against the
  agent's OWN drafts host-side (server-authoritative); no secret on the wire (key posts
  straight to the credential store). security-checklist in Phase 5.
- I6 shadcn primitives + semantic tokens only.
