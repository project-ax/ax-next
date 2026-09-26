# TASK-574 — defer the attended continuation until the undo window closes

Human ruling (2026-09-26, option A): an attended approval no longer hands the
continuation to the warm agent at once. It waits out the 10 s undo window, so an
Undo inside the window cancels a continuation nothing has seen yet — no extra
"held again" reply — and approve-after-the-window continues exactly once.

## Root cause (confirmed by code read)

`decisions:approve` on the attended path called `deliverResolution` inline. The
runner pulled the `decision-resolved` entry within milliseconds and the model
started re-issuing its call. An Undo then reset the row to `pending`
(`store.restore` only refuses once `consumed_at`/`replayed_at`/`replay_claimed_at`
is set), the re-issued call found no standing authorisation, and the gate held
it again on the same row: a genuine re-hold, rendered as a second held reply.
Undo cannot recall an inbox entry the runner already consumed.

## Design

Mirror the existing deferred host replay (`replay_due_at` + sweep), on its own
columns so the sweep that replays irreversible calls can never pick up an
attended row:

- `delivery_due_at` — when the deferred delivery is due (`resolvedAt + UNDO_WINDOW_MS`).
- `delivery_req_id` — the validated continuation reqId riding the delivery (store-internal, never on `Decision`).
- `delivered_at` — stamped by the one-shot claim. `restore` refuses a row that carries it.

Store:
- `claimForApproval` takes `deliveryDueAt` + `continuationReqId`; resets `delivered_at`.
- `claimDueDeliveries(now, limit)` — conditional UPDATE clears `delivery_due_at`, stamps `delivered_at`, requires `status='executed'`, `consumed_at IS NULL`.
- `restore` clears `delivery_due_at`/`delivery_req_id`, and refuses `delivered_at IS NOT NULL`.
- `takeApproval` clears `delivery_due_at` (an agent that took the yes up itself needs no nudge).

Plugin:
- Attended approve: claim with `deliveryDueAt`, return `path: 'agent-executes'`, `pendingUntil: deliveryDueAt`, `streamReqId: <validated id>`. No inline delivery.
- Sweep gains `delivered`: claim due deliveries, `deliverResolution`, and on a failed delivery run the TASK-277 fallback (flight + host replay / park) — moved out of approve.
- A one-shot in-process nudge at `UNDO_WINDOW_MS` runs the sweep so the latency is ~10 s, not 10–15 s. The durable due-time + sweep remains the guarantee.
- `decisions:undo` pre-check also refuses a delivered row.

channel-web:
- Wire `pendingUntil = replayDueAt ?? deliveryDueAt` → the card shows the existing "You said yes — it is about to go ahead. Undo stops it before it runs." copy during the window. `undoable` also requires `deliveredAt === null`.
- `continuationActions.continueApprovedTurn` attaches at `pendingUntil` (timer keyed by decision id) instead of at once; the open-conversation gate is checked when the timer fires. `cancelApprovedTurn(decisionId)` drops it; the queue's undo success calls it through a new `onDecisionUndone` hook. No "Thinking…" hang after an Undo.

## Tasks

1. decisions store + migration + types + fake store (+ store.test cases). Load-bearing.
2. decisions plugin: approve/sweep/undo/nudge + canary tests (repro, race, fallback moved). Load-bearing.
3. channel-web: wire mapping + continuation deferral/cancel + tests. Load-bearing (UI sanity on fast approve).
4. Memory shard + comments that describe the old immediate delivery.

## Residual risk (documented, not fixed)

A session that ends INSIDE the 10 s window falls back to the host replay at
sweep time; the client stream it attached at `pendingUntil` then gets no turn
and sits on "Thinking…" until the page is re-read. Before this change the same
fallback was decided at approve time and the client never attached.
