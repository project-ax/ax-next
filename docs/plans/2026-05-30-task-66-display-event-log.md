# TASK-66 — Display event log: persist SSE frames; conversations:get reads it (no jsonl parse)

Epic: out-of-git. Design: `docs/plans/2026-05-30-out-of-git-design.md` (Part B, B1, B3; Phase 2a).

## Problem

Today `conversations:get` reconstructs an old chat's displayed history by globbing the
runner's git-committed SDK jsonl (`workspace:list`/`workspace:read`) and parsing it
(`parseJsonlToTurns`). Two failings the design names:

1. The jsonl is missing half the UI — approval/permission cards, surfaced
   provider/sandbox errors, etc. are host/orchestrator events the SDK never sees, so
   redisplay drops them.
2. The jsonl reparse is the last reason the per-turn git commit/bundle/`parent-mismatch`
   resync sits on the common chat hot path.

B1's fix: persist the exact ordered display frames the host already receives
(`event.turn-end` carrying the turn's `role` + `ContentBlock[]`, plus the host-only
display events `chat:turn-error` / `chat:permission-request`) into an append-only
`(conversationId, seq)` log, and make `conversations:get` read THAT log instead of
parsing the jsonl. B3's no-omission invariant: persist a completed turn's frames
durably BEFORE the turn-end ack (persist-before-ack).

## Scope (and the boundary)

This card delivers ONLY the display SoT: the event log + the `conversations:get` read
switch. It does NOT:

- add the resume rows / remove the jsonl commit (TASK-67),
- delete the legacy transcript read via `workspace:list`/`workspace:read` (co-exists
  until TASK-67/70 retire the git path — but `conversations:get` no longer USES it for
  rows that have event-log entries),
- rewrite the CLIENT live-vs-reload render paths into literally one fold. The client
  reload path (`history-adapter` → `Turn[]` → `blocksToParts`) stays; it now sources
  from the event log instead of the jsonl. "Same renderer path" is satisfied for
  content by construction (the persisted `event.turn-end` `contentBlocks` ARE the
  folded terminal state of the live `event.stream-chunk` deltas). Full client
  frame-fold unification (reload folds the persisted host-only card/error frames
  through the live transport) is a deferred follow-up — see Followups.

## Design decisions

- **Store: `conversation_events` Postgres rows, owned by `@ax/conversations`** (the
  design names Postgres rows for the display log; conversations already owns the
  conversation row and the `chat:turn-end` subscriber). Append-only, keyed
  `(conversation_id, seq)` with a monotonic per-conversation `seq` (single writer per
  conversation — the host — so contention-free, NOT a CAS). Columns: `event_kind`
  (`turn` | `permission-card` | `turn-error`), `role` (nullable; turns only),
  `payload` JSONB (the frame's display body), `created_at`.
- **Persist path: the `chat:turn-end` subscriber in `@ax/conversations`** persists the
  turn's frame (role + contentBlocks) as a `turn` event row. Host-only events
  (`chat:turn-error`, `chat:permission-request`) get their own subscribers that append
  `turn-error` / `permission-card` rows. All key off `ctx.conversationId` (already
  stamped by the IPC listener / orchestrator ctx). Empty/heartbeat turn-ends (no
  contentBlocks) are NOT persisted (they aren't displayed) — mirrors the existing
  `bumpLastActivity` skip.
- **Persist-before-ack (B3):** the `event.turn-end` IPC event handler must AWAIT the
  `chat:turn-end` subscriber chain (which now includes the persist) BEFORE writing the
  202 ack. Today the dispatcher writes 202 then fires fire-and-forget. Add an
  `awaitFire: true` flag to the turn-end `EventSpec` ONLY (stream-chunk and
  tool-post-call stay prompt-202 fire-and-forget — they aren't gated by no-omission;
  the turn-end carries the authoritative content). This keeps the persist inside the
  conversations plugin (no cross-plugin import, no new dispatcher dependency — it rides
  the existing `chat:turn-end` fire) while making persist-before-ack literally true.
- **Read switch:** `conversations:get` reads the event log. Content (`turn`) events
  project to the existing `Turn[]` wire shape (unchanged renderer path). Host-only
  events surface on a NEW additive `displayEvents` field on `GetOutput` so the existing
  `turns` rendering is untouched and the host-only SoT is complete + testable now (the
  client consumer of `displayEvents` is the deferred unification; the field ships with
  a host-side test that asserts it round-trips a persisted card/error — the SoT is
  reachable, not half-wired, because `conversations:get` populates AND returns it).
- **Card folds to terminal state on replay:** events are append-only; a later
  card-resolution `permission-card` row (same `skillId`/key, terminal status) is just a
  later event. The read projection takes the LAST event per card key, so replay yields
  the resolved card with no special final-state bookkeeping.
- **Legacy co-existence:** when the event log has NO rows for a conversation (pre-TASK-66
  rows whose turns predate this), `conversations:get` falls back to the jsonl read so
  old conversations still redisplay. New turns land in the event log. (Retiring the
  jsonl read entirely is TASK-67/70.)
- **`reconstructAttachmentBlocks` stays** (untrusted-input hardening) — applied to the
  reconstructed `Turn[]` exactly as today.

## Invariants

- I1 (transport/storage-agnostic): `conversations:append-event` payload is
  `{ conversationId, kind, role?, payload }` — `kind` is a display-semantic enum
  (`turn`/`permission-card`/`turn-error`), `seq` is a per-conversation monotonic int
  minted by the store (not exposed on the append input), `payload` is the UI frame body.
  No `jsonl`/`git`/`sqlite`/`oid`/`commit` vocab. The `conversation_events` table name +
  `seq` column are storage-internal (never on a hook payload).
- I2 (no cross-plugin imports): persist rides the bus (`chat:turn-end` subscriber +
  `conversations:append-event`); the dispatcher awaits the existing fire, no import.
- I3 (no half-wired): persist path AND `conversations:get` read path ship together;
  covered by the canary/redisplay test. `displayEvents` is populated by the read it
  ships with (not dangling).
- I4 (one SoT): the display log is the redisplay SoT; the jsonl stays the resume SoT
  (TASK-67). Content overlaps as two views per B3; no byte-identity requirement.
- I5 (capabilities): frames are untrusted model/host output, stored opaque,
  re-validated against `ContentBlockSchema` on read (existing posture);
  `reconstructAttachmentBlocks` re-validates the upload prefix.

## Tasks (independent, testable)

1. **Migration + store + types.** Add `conversation_events` table to
   `conversations/src/migrations.ts` (append-only, `(conversation_id, seq)` PK,
   `event_kind`, `role`, `payload` JSONB, `created_at`; index by conversation_id).
   Add `ConversationEventsRow` + extend `ConversationDatabase`. Add store methods
   `appendEvent(...)` (mints next seq atomically) and `listEvents(conversationId)`
   (ORDER BY seq). Add `ConversationDisplayEvent` + `AppendEventInput`/`Output` types
   (storage-agnostic). Tests: migration idempotency; append mints monotonic seq;
   list ordered; round-trip a turn + a card + an error.
2. **`conversations:append-event` service hook + persist subscribers.** Register
   `conversations:append-event` (host-internal; ctx-scoped, no agents:resolve — same
   posture as bind-session). Add `chat:turn-error` + `chat:permission-request`
   subscribers in `@ax/conversations` that append rows. Extend the existing
   `chat:turn-end` subscriber to append a `turn` row (non-heartbeat only). Update
   manifest `registers`/`subscribes`. Tests: each subscriber appends the right row;
   heartbeat turn-end appends nothing; missing conversationId is a no-op.
3. **persist-before-ack: dispatcher awaits turn-end fire.** Add `awaitFire?: boolean`
   to the turn-end `EventSpec`; the event dispatch awaits `evt.fire(...)` before the
   202 when set (turn-end only). Test: a slow `chat:turn-end` subscriber holds the 202
   open (the inverse of the tool-post-call prompt-202 test); the existing turn-end +
   tool-post-call-prompt tests stay green.
4. **`conversations:get` reads the event log.** Switch `getConversation` to read the
   event log: project `turn` events → `Turn[]` (assign turnIndex/createdAt), take the
   terminal per-card-key `permission-card` events + `turn-error` events →
   `displayEvents`. Apply `reconstructAttachmentBlocks` to the turns. Fall back to the
   jsonl read when the log is empty (legacy rows). Add `displayEvents` to `GetOutput`.
   Tests: redisplay from the log matches the jsonl-equivalent turns; a host-only card
   event surfaces in `displayEvents`; a later card-resolution event folds to terminal;
   empty-log falls back to jsonl.
5. **Preset / canary wiring + boundary review.** Confirm `conversations:append-event`
   has no new required producer gap in preset canaries (it's registered by the same
   plugin that already loads). Update `dependency-sync` / plugin-shape / return-schema
   tests as needed. Boundary review in the PR body.

## YAGNI pass

- The B3 structural turn-count/order divergence DETECTOR (cross-check display vs resume
  rows) is explicitly Phase 2-as-a-whole and needs the resume rows (TASK-67) to compare
  against — NOT buildable in this card. Deferred (followup) — load-bearing only once
  TASK-67 lands.
- `event.stream-chunk` per-delta persistence is NOT load-bearing for redisplay (the
  turn-end carries the folded terminal `ContentBlock[]`); persisting deltas would
  duplicate content. Not built. (The card lists turn-end/stream-chunk as the frames the
  host receives; turn-end is the one redisplay reads.)
- Full client frame-fold unification: deferred follow-up (Followups).
