# TASK-277 — decide attended-vs-replay from a live session lookup at approve time

**Card:** TASK-277 (HIGH). **Gates:** the TASK-236 acceptance walk.
**Package:** `@ax/decisions`.

## Problem

`packages/decisions/src/plugin.ts:415` routes an approval with:

```ts
const attended = current.attendance === 'attended';
```

`Decision.attendance` does **not** mean "an agent is still warm". Read
`attendance.ts`: `attendanceFor` is `origin === 'web' ? 'attended' : 'unattended'`.
It answers **which channel opened the conversation**, it is captured at hold time,
and it is never revisited. A web conversation is therefore `attended` *forever* —
including hours after its session died.

So on approve, a decision whose session has ended still takes the attended branch:
the row is claimed `status='executed'`, **no replay is scheduled**, and
`deliverResolution` finds no session, logs `decision_delivery_skipped_no_session`,
and **its return value is discarded**. The row reads executed, the call never runs,
nothing tells the user. The approval is silently consumed.

`attendance.ts`'s own header names this as the unrecoverable direction of the two:

> unattended misread as attended: the host never replays, and the decision waits
> for a warm agent that is already gone. Nothing runs, ever, and nothing says so.

It also contradicts design §3.3 and `delivery.ts`'s comment, both of which say the
unattended path takes over when there is no session.

## Fix

Two changes, both in the `decisions:approve` handler.

### 1. Liveness is a live read, not a stored field

The **row** says whether an agent could *ever* be there; a **live read** says
whether one *is*. Both must hold.

Before the claim (so the row lands in its correct terminal status in one write,
preserving the existing "decided BEFORE the claim" property):

```ts
const liveSessionId =
  current.attendance === 'attended'
    ? ((await conversationChannel(bus, replayContext(current), current.conversationId))
        ?.activeSessionId ?? null)
    : null;
const attended = liveSessionId !== null;
```

- Gated on `current.attendance === 'attended'` so a routine-origin row costs no
  extra read — it can never be attended.
- `conversationChannel` is already exported from `attendance.ts` and already
  returns `null` for every "we do not know" (absent store, unreadable row, throw).
  Unknown → `unattended` → the host replays → **the call still happens**. That is
  the safe direction, per `attendance.ts`'s asymmetry.
- The ctx is `replayContext(current)` — the DECISION's owner/agent, never the
  approving request's. Same rule as the freshness read and `deliverResolution`;
  see the 2026-08-21 TASK-227 memory note. An approver whose ctx names a different
  user reads back nothing, which is indistinguishable from "session gone".

`parked` / `deferred` / `immediate` and `replayDueAt` / `replayClaimedAt` then fall
out of the corrected `attended` with no further change — including the undo window
for an irreversible call, which an idle-expired decision now correctly gets.

### 2. `deliverResolution`'s return is handled, not discarded

The live read closes the hours-wide hole; a millisecond-wide race remains (the
session ends between the lookup and the queue). It must not be silent.

```ts
const delivery = await deliverResolution({ bus, ctx, decision: claimed, outcome: 'approved' });
if (!delivery.delivered) {
  ctx.logger.warn('decision_delivery_fell_back_to_replay', {
    plugin: PLUGIN_NAME, decisionId, reason: delivery.reason,
  });
  const replayed = await settleReplay({
    store: store!, bus, ctx: replayContext(claimed), decision: claimed, now,
  });
  return {
    decision: (await store!.get(decisionId, ownerUserId)) ?? claimed,
    executed: replayed.executed,
    path: replayed.path,
    error: replayed.error,
    pendingUntil: null,
  };
}
```

`settleReplay` already covers all three landings and needs no new store method:
executor ran → `markReplayed` + `executed` receipt; no host executor →
`parkForAgent` + `pending-agent` receipt; threw → `markFailed` + `failed` receipt.
All three `reason`s (`no-session`, `no-session-plugin`, `queue-failed`) take this
branch — in each the agent was not told, so the host must not assume it was.

Double-execution is not reachable: `markReplayed` takes the row out of the
standing-authorisation set, so a late agent re-issue finds no yes to cash in.

**Delete the now-false comment** in that branch claiming "if the session is already
gone the standing authorisation simply waits on the row for the agent's next run" —
that is precisely what did not happen.

## Tasks

| # | Task | Load-bearing? |
|---|---|---|
| 1 | Tests first, in `src/__tests__/decisions.canary.test.ts` (the existing `decisions:approve` harness) | yes — Bug Fix Policy |
| 2 | The two `plugin.ts` changes above | yes |
| 3 | Vacuity-check: revert each change, confirm the matching test goes red | yes — a guard that cannot fail is not a guard |

### Test cases (task 1)

1. **The regression.** Attended row (`origin: 'web'`), session since ended
   (`activeSessionId: null`), host executor present, reversible → approve →
   the executor was invoked **exactly once**, row ends `executed` with
   `replayedAt` set. *Assert the side effect (executor call count), never the
   status field — a row reading `executed` is exactly the false signal this card
   is about.*
2. **No regression on the live path.** Attended row, session live → approve →
   queued to the session inbox, host executor **not** invoked, row `executed`,
   `replayedAt` null.
3. **Idle-expired with no host executor** → row ends `approved-pending-agent`,
   not `executed`.
4. **Idle-expired + irreversible** → `deferred`: `replayDueAt` set, undo window
   honoured, executor not yet invoked.
5. **The race.** Live at lookup, delivery returns not-delivered → falls back to
   replay, executor invoked exactly once, warn logged.
6. **Unknown lookup** (metadata hook absent / throws) on an attended row →
   treated as unattended, the call still happens.

## Invariants / boundary review

No hook signature changes; no new hook; no payload field added. `conversationChannel`
is an existing intra-package helper. `conversations:get-metadata` is already in the
manifest's `optionalCalls` (used by the hold-time attendance read) — **verify** it is
listed there and that the extra call site needs no manifest change. No cross-plugin
import. Internal-implementation patch → no boundary review needed.

Not a sandbox / IPC / plugin-loading / untrusted-content / new-dependency change →
`security-checklist` not triggered. The one adjacent question — a model-authored
`call.name` reaching a dynamic hook — is pre-existing in `replay.ts` and unchanged.

## Out of scope

- `decisions:executed` having no subscriber → **TASK-279**, next card.
- The post-approval continuation turn not rendering live → **TASK-278**.
- Undo vs `replayedAt` → **TASK-280** (ruled: intended, grace period only).
