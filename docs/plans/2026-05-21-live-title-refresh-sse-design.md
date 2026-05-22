# Live title refresh via SSE

**Date:** 2026-05-21
**Status:** Design — approved, not yet implemented.
**Context:** `TODO.md` → "Live title refresh after the poll window." PR #120
widened the client-side `pollConversationTitle` window to ~10s, but a title
that the backend persists *after* that window still doesn't surface until a
sidebar `list()` refresh (page nav/reload) — there's no server→client push
channel. The TODO names the real fix: a title-update signal (SSE/websocket) or
a low-frequency background `list()` poll. We pick SSE, following the existing
`GET /api/chat/stream/:reqId` precedent.

## Decision (approved)

**Additive, not replacing.** The existing client poll stays as the fast path
for the just-created active thread. We add a long-lived **per-user** SSE that
surfaces *any* of the user's conversation titles the moment the backend writes
them. The two paths are idempotent — both set the same value — so overlap is
harmless. We deliberately do **not** rip out the poll (smaller blast radius;
leaves the working assistant-ui `generateTitle` integration untouched).

We push titles over **Server-Sent Events**, not websockets or a background
poll: SSE is already the project's server→client streaming transport
(`/api/chat/stream/:reqId`), it's one-directional (which is all we need), and
it reuses `http-server`'s `res.stream()` + the per-connection bus-subscriber
pattern verbatim.

## Architecture

Three units, each independently testable:

### 1. `conversations:title-updated` — new subscriber event (single source of truth)

`setConversationTitle` (`packages/conversations/src/plugin.ts`) is the **only**
write point for a conversation title, and it already computes
`updated: boolean`. We fire a new subscriber event on the in-process bus
**only when `updated === true`** (a real change), immediately before
`return { updated: true }`:

```text
conversations:title-updated  →  { conversationId: string; userId: string; title: string }
```

- **Silent on no-ops.** Not fired when `ifNull=true` hits an already-titled row,
  nor on the not-found re-check path. Subscribers only ever see real changes.
- **Covers every caller.** Today that's `@ax/conversation-titles`' auto-title
  pipeline; a future user-driven rename UI also goes through `set-title`, so it
  gets live multi-tab sync for free.
- The conversations manifest gains the fired event in its declaration; the
  channel-web manifest declares it `subscribes` to it.

### 2. `GET /api/chat/title-events` — per-user SSE route (channel-web)

Per-**user**, not per-conversation: the sidebar wants updates for *any* of the
user's conversations over **one** connection, not one connection per row. The
handler mirrors `createSseHandler` (`packages/channel-web/src/server/sse.ts`):

1. `auth:require-user` → `userId`. 401 on rejection (route closed by default).
2. Open `text/event-stream; charset=utf-8` via `res.stream()`.
3. Subscribe to `conversations:title-updated` with a per-connection key
   (`@ax/channel-web/title-events/<userId>-<rand>`), filtering
   `payload.userId === userId`. A user never sees another user's titles.
4. Per matching event, write one frame:
   `data: {"conversationId":"…","title":"…"}\n\n`.
5. 25s `:\n\n` keepalive (unref'd interval); `stream.onClose` → unsubscribe +
   clear timer. Cleanup is idempotent.

**No replay buffer** (unlike chat chunks). Titles live in the DB and the
initial `list()` on page load already renders current state; the SSE only needs
to push *changes* that happen while connected. A frame missed during a
disconnect is recovered by the client's resync-on-connect (unit 3), so we don't
carry the buffer/eviction machinery the chat stream needs.

### 3. Long-lived client consumer (channel-web)

A single SSE connection opened once at app/sidebar mount, using
`fetch` + `ReadableStream` exactly like `transport.ts`
(`credentials: 'include'`, `accept: text/event-stream`) — **not** a raw
`EventSource`, which can't send credentials cleanly:

- Each parsed `{ conversationId, title }` frame → update the matching
  `SessionRow.title` in `session-store` (and the assistant-ui thread-list
  title). An unknown `conversationId` is ignored (not in this user's loaded
  list, or already removed).
- **Resync on (re)connect:** run `list()` once each time the stream opens, to
  catch any title that landed while disconnected. This is what lets us skip a
  server-side replay buffer.
- **Reconnect** with capped exponential backoff; **abort** on unmount.
- The existing `pollConversationTitle` is **unchanged**.

## Data flow

```text
assistant turn ends
  → @ax/conversation-titles (chat:turn-end subscriber) generates title
  → conversations:set-title  (updated === true)
       → fire conversations:title-updated { conversationId, userId, title }   [in-process bus]
            → GET /api/chat/title-events subscriber (filtered by userId)
                 → data: { conversationId, title }                            [SSE frame]
                      → client updates session-store row + thread-list title  [no reload]
```

## Invariants (carried from review history)

- **I1 — Single source of truth (invariant #4).** The event fires from the
  `set-title` write point, never from `@ax/conversation-titles`. One write →
  one signal, regardless of caller.
- **I2 — Fire only on real change.** No event on the `ifNull` no-op or
  not-found path. A test asserts silence on both.
- **I3 — Transport/storage-agnostic payload (invariant #1).** Payload is
  `{ conversationId, userId, title }` — all domain concepts, no `sha`/`bucket`/
  `pod`/`socket` leakage.
- **I4 — User isolation.** The SSE subscriber filters `payload.userId ===
  userId` (userId derived server-side from `auth:require-user`, never from the
  request). A cross-user isolation test is mandatory.
- **I5 — No half-wired window (invariant #3).** Backend event + route + client
  consumer ship in one PR. The route auto-registers inside the channel-web
  plugin, already loaded in the CLI and k8s presets — no preset edit needed.
- **I6 — Single-replica caveat (documented, deferred).** The event rides the
  in-process bus, identical to chat-stream. The host is `replicas: 1` today
  (HPA/multi-replica explicitly deferred in the chart). When multi-replica
  lands, *both* SSEs need the cross-replica `eventbus` (LISTEN/NOTIFY) or
  session affinity — a shared future concern, not solved here (YAGNI).

## Boundary review (new subscriber event)

- **Alternate impl this event could have:** titles stored in a KV/document
  backend instead of a SQL column — the event payload is unchanged
  (`{ conversationId, userId, title }`), so the abstraction holds.
- **Payload field names that might leak:** none. All three fields are
  domain-level.
- **Subscriber risk:** the SSE handler keys off `userId` and `conversationId`,
  both stable domain identifiers — no backend-specific field to break on.
- **Wire surface:** the SSE frame `{ conversationId, title }` is a wire shape;
  its schema lives in channel-web (where the route lives), not a central file.

## Security note (see `security-checklist` skill, run at implementation)

- Auth-gated (`auth:require-user`), read-only, and user-filtered — a connection
  only ever receives the caller's own titles.
- Title text is model-generated (untrusted), but it is already rendered to the
  sidebar via `list()` as plain React text content (no raw-HTML injection sink);
  the SSE introduces **no new injection surface**.
- The `conversations:title-updated` payload carries model output across the bus;
  the SSE handler treats it as data and JSON-encodes it into the frame.

## Testing

- **Backend unit (conversations):** `set-title` fires `conversations:title-updated`
  with the correct payload **only** when `updated === true`; silent on the
  `ifNull` already-titled no-op and on not-found. (Bug-fix/new-behavior policy.)
- **Backend SSE (channel-web):** 401 when unauthenticated; cross-user isolation
  (user A's title never reaches user B's stream); frame format; cleanup
  unsubscribes on client disconnect. Mirror `sse.test` patterns.
- **Frontend (channel-web):** consumer updates the matching row, ignores an
  unknown `conversationId`, runs `list()` resync on connect, and reconnects with
  backoff. Mirror `transport` test patterns.
- **MANUAL-ACCEPTANCE (kind `ax-next-dev`):** create a chat, let the title land
  *past* the ~10s poll window with the tab open → the sidebar title updates with
  **no reload**.

## Out of scope

- Replacing the client poll (chose additive).
- Cross-replica delivery (rides the future chat-stream multi-replica fix).
- A general-purpose per-user "conversation events" channel (rename/delete/new) —
  this is title-only; broaden it when a second event-type actually needs it.
