# TASK-373 — a grant that outlives the stream

**Epic:** workspace-as-sole-interface. Follows TASK-350, which made grants answerable but only while a turn streams.
**Scope:** skill and connector grants only. The host egress wall is TASK-375 — not for storage reasons, see below.

---

## What is already true, and what the card originally got wrong

The card said this needs "host-side state for open grants". It does not. `ChunkBuffer` already holds pending conversation-keyed cards, and the three properties that matter are all present:

- **Durable past the turn.** `skillCards` is explicitly exempt from the IDLE_TTL sweep — "a pending approval legitimately outlives the turn (the human may take minutes)".
- **Deduped.** `appendPermissionCard` updates in place; a re-proposal of the same subject never doubles.
- **Evicted on resolve.** `evictPermissionCard` is already wired to `onCardResolved`, so an answered grant stops replaying.

What is missing is **enumeration**, and with it the only hard part: **scoping**.

`skillCards` is `Map<conversationId, PermissionRequest[]>`. `tailPermissionCards(conversationId)` answers "what is pending on THIS conversation". Today needs "what is pending for ME". There is no by-user accessor and no enumerate-all accessor.

## Why the host wall is not here

Split to TASK-375 on 2026-09-15. `grantHost` → `proxy:add-host` widens the **live session's** allowlist; only `persist: true` writes a durable per-(user, agent) grant. So a host card shown after its turn ended offers "Just this once" — a control that would report success and change nothing. That is a different question to ask, not a storage gap, and the buffer's turn-scoped host lifetime is correct as written.

## Design

### Record the owner at append time, do not resolve it at read time

The obvious route implementation — enumerate every pending conversation, then ask `conversations:get` per conversation to find out whose it is — is both an N+1 (the shape already filed as TASK-248 on `/api/workspace/state`) and a weaker security posture, because the scope would be re-derived on every read.

The producer already knows. `createPermissionCardFillSubscriber` receives an `AgentContext` carrying `userId` and `agentId`. So:

```ts
appendPermissionCard(key, card, owner: { userId: string; agentId: string })
pendingGrantsForUser(userId): readonly { conversationId, agentId, card }[]
```

The filter runs in memory against identity the **producer** recorded. Nothing the caller sends participates in scoping, which is the strongest available posture and the one the existing workspace routes already describe: "`userId` is never read from the body, query, or params."

`pendingGrantsForUser` deliberately returns **conversation-keyed cards only**. Host cards are turn-scoped and answering a stale one is partly meaningless (TASK-375); including them would put a control on screen that cannot do what it says.

### The route

`GET /api/workspace/grants`, scoped by `auth:require-user` → 401, matching every other workspace read. No parameters — the caller cannot ask about anybody else, because there is nothing to ask with.

It returns `{ grants: [{ conversationId, agentId, request }] }`. No existence leak is possible: the response is built from the caller's own rows, so "no such conversation" and "not yours" are the same empty list rather than two distinguishable answers.

### The client

`workspaceApi.grants()`, fetched by `WorkspaceShell` on mount, merged into the existing `workspace-grant-store` through `raise()`.

Reusing `raise()` rather than adding a second entry point is what keeps a fetched grant and a streamed one one row: `raise` already replaces in place on the subject key (`skill:<id>` / `connector:<id>`), so a grant that is both fetched and streamed dedupes for free, and the newer payload wins.

## Tasks

1. `ChunkBuffer`: owner on append, `pendingGrantsForUser` accessor. Both call sites in `sse.ts` pass the ctx identity. Tests: owner recorded; filter excludes another user; host cards excluded; eviction still works.
2. `GET /api/workspace/grants` + route tests, including a cross-tenant read returning empty rather than 403-vs-404.
3. `workspaceApi.grants()` + fetch-on-mount + merge; test that fetched-then-streamed is one row.
4. `security-checklist` note (cross-tenant enumeration) and boundary-review answers — this adds a route, which TASK-350 deliberately did not.

## YAGNI pass

All four load-bearing. Cut: any pagination (the set is bounded by the per-conversation cap and only holds *pending* cards); any polling (fetch on mount plus the existing stream is the whole requirement); host-card enumeration (TASK-375).

## Known limit, to state in the PR rather than imply away

The buffer is in-memory and replica-local — Invariant J7, the chart refuses `replicas > 1`. A grant survives a page reload, an idle Today, and the turn ending. It does **not** survive a host restart. That is a real improvement over "only while streaming" and it is not the same as durable.

## Gate

`pnpm build`, then `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`.
