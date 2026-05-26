# Routines Phase D — design

**Status:** design, awaiting review
**Date:** 2026-05-17
**Builds on:** `docs/plans/2026-05-14-routines-design.md` §7.3 ("Phase D — UI + heartbeat bootstrap"); Phases A–C shipped (PRs #70, #71, #77 + follow-ups #78, #81, #84, #85, #88, #89, #91).
**Companion:** `docs/plans/_2026-05-17-routines-phase-d-mockup.html` (static visual reference).

## 1. Goal

Operator-visible observability over the routines system, plus a default heartbeat so a fresh agent has something to observe. Phase D ships **read-only over the spec** (routines still live in `.ax/routines/*.md`, edited via chat / git) and **action-only on triggering** (a per-row Fire now button). Concretely:

- A **Routines** modal accessible from the avatar dropdown menu (sibling to Credentials). Lists every routine the caller can see across their agents.
- Each row shows: name, owning agent, trigger summary, last status, last-run relative time.
- Click a row → expand to show the last 20 fire rows with the **rendered prompt that was actually sent** (new column added this phase) and any error.
- **Fire now** button per row. Interval / cron: fires immediately. Webhook: reveals an inline JSON payload form, then fires.
- All routine-fired conversations are **hidden from the chat sidebar**. They still exist as DB rows so the modal can reach them by id, but they don't pollute the sidebar's "today / yesterday" section.
- New agents auto-seed `.ax/routines/heartbeat.md` (daily check-in with silence-token so quiet days don't spam the conversation list).

Phase D is intentionally **observability + bootstrap only**. CRUD on routine specs, transcript view inside fires, and per-agent filter controls are explicit non-goals — defer until a real user asks.

## 2. Non-goals

- Create / edit / delete of routine specs through the UI. The spec is the source of truth; edits go through chat or git.
- Transcript view inside a fire's detail. Routine sandboxes are ephemeral and the runner pods don't persist transcripts back to the host, so a click-through would land on empty content. Surfaced as a known gap; revisit if/when host-side transcript persistence lands.
- Per-agent filter dropdown in the modal. Most users have one or two agents; the agent label on each row is sufficient.
- Backfilling existing routine conversations to `hidden=true`. Small enough number; goes-forward behavior only.
- Auto-seeding the heartbeat into pre-Phase D agents. Likewise goes-forward only.

## 3. UI design

### 3.1 Visual language

Matches the existing channel-web pattern exactly. No new shadcn primitives. Concretely:

- `Dialog` (installed) at `max-w-[720px]` — slightly wider than `SettingsPanel`'s `max-w-[640px]` to accommodate trigger chip + status + relative time + Fire now without cramping.
- Row layout: 32×32 muted square on the left (now a chevron toggle, not initials), flex-col label/subtitle, trailing controls. Identical spacing tokens to `CredentialsList` (`py-[1.125rem]`, `gap-3.5`, `border-b border-rule-soft`).
- Chips: hand-rolled `inline-flex` spans with semantic tokens (`bg-muted`, `text-muted-foreground`, `text-destructive`). No `Badge` primitive — the 11px sizes we need read better than `Badge`'s defaults.
- Collapse / expand: hand-rolled with React state + `animate-in fade-in-0 slide-in-from-top-1 duration-150`. Same pattern UserMenu uses for its popover. No `Collapsible` primitive needed.
- Fire-now feedback: inline status text below the button. Same pattern as `CredentialsList`'s inline error banner. No `Sonner` / toast dependency.
- Webhook Fire now: inline JSON form revealed beneath the button (not a nested Dialog — nested dialogs trap focus and confuse screen readers inside the parent Routines Dialog).

**Net: zero new shadcn installs.** Stays inside CLAUDE.md invariant #6.

### 3.2 Component tree

```
packages/channel-web/src/
  components/routines/
    RoutinesPanel.tsx       — Dialog shell, refreshKey idiom (mirror of SettingsPanel)
    RoutinesList.tsx        — fetch + expand/collapse rows
    TriggerChip.tsx         — "webhook /fixed (hmac)", "interval 24h", "cron 0 9 * * *"
    StatusChip.tsx          — ok / silenced / error / em-dash
    FireRowsTable.tsx       — last-N fires inside expanded row
    FireNowControl.tsx      — button (interval/cron) or inline JSON form (webhook)
  lib/routines.ts           — wire client (list / recentFires / fireNow)
```

A working skeleton already exists in those paths from the design exercise — it compiles against the wire shapes in §4 below. The mockup file (`_2026-05-17-routines-phase-d-mockup.html`) shows the visual outcome.

### 3.3 Lazy load

The list fetches on mount. Each row's expanded body fetches its fires on first open and caches subsequent toggles (`fires[key] === undefined` ? `loadFires()` : use cache). Keeps the modal fast for users with many routines.

### 3.4 Empty state

If `routines:list` returns `[]`, the modal shows:

> No routines yet. Routines live in `.ax/routines/*.md` in the agent's workspace — create one via chat or git.

(No `Seed heartbeat` button — heartbeat auto-seeds at agent-create time per §6.)

### 3.5 Entry point

`UserMenu` gains a new `data-action="routines"` button between Credentials and Settings:

```tsx
<button onClick={() => { setOpen(false); onOpenRoutines?.(); }} data-action="routines">
  <ListChecks aria-hidden strokeWidth={1.4} />
  <span>Routines</span>
</button>
```

The icon (`ListChecks` from `lucide-react`, already a dep) reads as "scheduled items". `onOpenRoutines` is plumbed through `Sidebar` → `AppShell` to a `<RoutinesPanel open={routinesOpen} onClose={() => setRoutinesOpen(false)} />` instance at app root.

## 4. Wire surface

### 4.1 New package: `@ax/routines-admin-routes`

Modeled exactly on `@ax/credentials-admin-routes`. Manifest:

```json
{
  "name": "@ax/routines-admin-routes",
  "registers": [],
  "calls": [
    "http:register-route",
    "routines:list",
    "routines:fire-now",
    "routines:recent-fires",
    "agents:resolve"
  ]
}
```

Three routes registered in `init`:

| Verb | Path | Body | Service hook |
|---|---|---|---|
| GET  | `/settings/routines` | — | `routines:list` (filter to caller's agents) |
| GET  | `/settings/routines/:agentId/fires?path=…&limit=N` | — | `routines:recent-fires` |
| POST | `/settings/routines/:agentId/fire` | `{ path: string, payload?: unknown }` | `routines:fire-now` |

**Scoping rule:** every route runs `requireUser` (same helper as `/settings/credentials/*`), then calls `agents:resolve({ agentId, userId })` to confirm ACL before invoking the underlying service hook. If `agents:resolve` returns `null` or throws `forbidden`, the route 403s without touching the routines plugin.

**Loading:** add to CLI preset and k8s preset same PR (CLAUDE.md invariant #3 — no half-wired plugins).

### 4.2 Extended service hook: `routines:fire-now`

Input gains optional `payload?: unknown`:

```ts
interface FireNowInput {
  agentId: string;
  path: string;
  source?: FireSource;
  payload?: unknown;  // NEW
}
```

`createFireRoutine`'s third arg already accepts `payload?: unknown` and threads it through `renderTemplate`; the `routines:fire-now` registered handler in `plugin.ts` just needs to forward `input.payload` into the `fireRoutine(row, source, payload)` call. Backward compatible — existing callers that don't pass payload behave as today.

### 4.3 New service hook: `routines:recent-fires`

```ts
'routines:recent-fires'
  (ctx, { agentId, path, limit }) → { fires: FireRow[] }
```

- `agentId`, `path`: required.
- `limit`: 1..100, default 20.
- Returns most-recent fires for the named routine, ordered `fired_at DESC`.
- `FireRow` adds the new `renderedPrompt: string | null` field (see §5).

Backed by a new `localStore.recentFires(input)` method in `routines/src/store.ts`:

```sql
SELECT id, agent_id, path, fired_at, trigger_source, status, error,
       conversation_id, rendered_prompt
  FROM routines_v1_fires
 WHERE agent_id = $1 AND path = $2
 ORDER BY fired_at DESC
 LIMIT $3
```

No new index needed — the existing `(agent_id, path)` covering index on the table handles the filter; `ORDER BY fired_at DESC LIMIT 20` is cheap against typical fire volumes.

## 5. Schema change

**Single additive migration in `@ax/routines`:**

```sql
ALTER TABLE routines_v1_fires
  ADD COLUMN rendered_prompt TEXT;
```

`NULL` for historical rows. New rows populated by two writers, both using the same `renderTemplate(row.promptBody, { payload })` call (lifted into a shared helper, since `fire.ts` and `plugin.ts:fire-now` both need it):

- **Tick / webhook fires** — computed inside `createFireRoutine` in `fire.ts` and stashed on `PendingFire`:

  ```ts
  export interface PendingFire {
    row: RoutineRow;
    conversationId: string;
    source: FireSource;
    renderedPrompt: string;        // NEW
    onTurnEnd: (turn: { contentBlocks?: unknown[] }) => Promise<void>;
  }
  ```

  The `chat:turn-end` subscriber in `plugin.ts` passes `pf.renderedPrompt` into its `recordFire` call.

- **`routines:fire-now` admin write** — `plugin.ts` records a fire row immediately on dispatch (line ~202). That `recordFire` call gets `renderTemplate(row.promptBody, { payload: input.payload })` (the same value `fire.ts` already passed to `agent:invoke`).

`recordFire` signature gains an optional `renderedPrompt?: string | null` parameter; existing callers default to `null`.

## 6. Heartbeat seed

### 6.1 The hook

`@ax/agents` fires a new subscriber-style event after `agentsStore.create` returns successfully:

```ts
'agents:created'
  (ctx, { agentId, ownerId, ownerType }) → void
```

Subscriber-pattern event (fired via `hooks.fire`, not a service hook — multiple subscribers can react; failures isolated per K10). The agents plugin **fires** it from its `agents:create` handler after the DB insert commits, before returning the response. The routines plugin **subscribes** (see §6.2).

### 6.2 The seeding subscriber

A new file `packages/routines/src/seed-heartbeat.ts` exports a subscriber that:

1. Listens to `agents:created`.
2. Reads the bundled heartbeat template (compiled into the package).
3. Issues `workspace:apply` against the new agent's workspace with the file as an `added` change at `.ax/routines/heartbeat.md`.
4. Logs success or warns on failure. **Per K10, never throws** — a seed failure must not block agent creation.

Wired in `plugin.ts`'s `init()` alongside the existing subscribers.

### 6.3 The template

`packages/routines/src/heartbeat-template.ts` exports a constant string:

```
---
name: heartbeat
description: daily check-in; says HEARTBEAT_OK and goes quiet when nothing's outstanding
trigger:
  kind: interval
  every: "24h"
conversation: shared
silenceToken: HEARTBEAT_OK
---
If nothing's outstanding for you to report on, just say `HEARTBEAT_OK` and nothing else. Otherwise, give a one-paragraph summary.
```

Shared conversation (one ongoing thread, not 365/year). Silence-token suppresses the no-news case via the existing Phase B mechanism.

### 6.4 Workspace-doesn't-exist case

Agent creation predates workspace materialization. `workspace:apply` from the seed runs before any chat opens against the agent. The current `workspace:apply` impl in `@ax/workspace-git` (and `@ax/workspace-git-server`) **does** auto-init an empty workspace on first apply for an unknown workspace — verified by the existing canary tests that seed a routine via `workspace:apply` before any other operation against that agent.

If that turns out to be wrong on closer reading during impl, fall back to lazy-seeding: have the seed subscriber stash a "pending seed" record (in-memory or a tiny `routines_v1_pending_seeds` table) and flush it on the first `workspace:materialized` event for that agent. Decide in the impl plan after a quick verification read of `workspace:apply` impl.

## 7. Hiding routine-fired conversations from the sidebar

Routine fires today call `conversations:create` (per-fire) or `conversations:find-or-create` (shared). The created conversations appear in the chat sidebar as `fixed @ <ts>` entries — confirmed in the Phase C MANUAL-ACCEPTANCE walk where 8+ entries showed up over the day.

**Change:** extend the input shape of both hooks with an optional `hidden?: boolean` field:

```ts
'conversations:create'
  (ctx, { userId, agentId, title, hidden? }) → { conversationId }

'conversations:find-or-create'
  (ctx, { userId, agentId, externalKey, fallback: { title, hidden? } }) → { conversation, created }
```

When `hidden=true`, the row is inserted with `hidden=t` (the column already exists from Phase A). The chat sidebar's conversations query is expected to already filter on `hidden=false` per Phase A's silence-token treatment — **verify in impl plan** by reading whatever endpoint backs the sidebar's "today / yesterday" list. If the filter isn't applied, add it (one-line WHERE clause) as part of this PR.

`@ax/routines/src/fire.ts` passes `hidden: true` on both call sites.

**Existing routine conversations** stay visible (no backfill). They predate this change; small enough volume to ignore.

## 8. Heartbeat sandbox-noise mitigation (revisit)

A consequence of §7: the heartbeat's shared conversation will also be hidden from the sidebar. Operators see fires only through the Routines modal. This is the intended UX per the brainstorm — heartbeats are "system" activity, not chat. The modal's fire detail (with rendered prompt) is the canonical surface for "what did the heartbeat say."

If a user later wants to *promote* a hidden conversation back to the sidebar (e.g., "the heartbeat said something interesting; let me reply"), that's out of scope here. Tracked as a known UX follow-up.

## 9. Testing

### 9.1 Unit

- `RoutinesList`: empty state, error state, row expand/collapse toggle, lazy fire-load on first open, cache on second open.
- `FireNowControl`: interval path fires immediately; webhook path opens form, parses JSON, surfaces parse errors.
- `TriggerChip` / `StatusChip`: each variant renders its expected text and a11y label.
- `lib/routines.ts`: URL encoding for agentId, error-body parsing, Date hydration.

### 9.2 Integration

- `@ax/routines-admin-routes`: ACL check returns 403 when caller doesn't own / share agent; happy path returns 200 with the expected payload shape.
- `routines:recent-fires`: returns rows in `fired_at DESC` order; honors `limit`.
- `routines:fire-now` with payload: payload threads to `renderTemplate` and lands in `routines_v1_fires.rendered_prompt`.

### 9.3 Canary

Extend the existing routines canary in `packages/routines/src/__tests__/canary.test.ts`:

- New case: after a fire, `recent-fires` returns a row whose `renderedPrompt` matches `renderTemplate(promptBody, { payload })`.
- New case: `conversations:create` called by routines with `hidden: true` causes the resulting row to have `hidden=t`. (Mock `conversations:create` to capture the input.)
- New case: `agents:created` event causes the routines seed subscriber to call `workspace:apply` with the heartbeat template.

### 9.4 MANUAL-ACCEPTANCE

New section in `deploy/MANUAL-ACCEPTANCE.md`:

> ## Scenario: Observe + manually fire a routine (Phase D)
>
> 1. Create a fresh agent via the admin UI. Confirm `.ax/routines/heartbeat.md` appears in its workspace (DB check on `routines_v1_definitions`).
> 2. Open the avatar menu → click **Routines**. The heartbeat appears with last_status=`—`, last-run=`never`.
> 3. Click **Fire now**. Within a few seconds, the row's status flips to `silenced` (heartbeat's silence-token returns HEARTBEAT_OK).
> 4. Expand the row. One fire row shows: timestamp, status=`silenced`, trigger=`MANUAL`, the rendered prompt body.
> 5. Confirm the heartbeat's `fixed @ <ts>` conversation is **not** in the chat sidebar.
> 6. (Optional) Create a webhook routine via chat with a `{{payload.foo}}` template; in the modal click **Fire now**, paste `{"foo":"bar"}`, submit; confirm the fire row's renderedPrompt shows the substituted value.

## 10. Migration order / PR shape

Suggested single PR (Phase D doesn't have a half-wired window to manage — all the changes are net-additive):

1. Schema migration: add `rendered_prompt` column.
2. `routines/src/store.ts` + `fire.ts` + `plugin.ts`: thread renderedPrompt through `recordFire`; add `routines:recent-fires` service hook + `localStore.recentFires`.
3. `routines/src/seed-heartbeat.ts` + `heartbeat-template.ts`: heartbeat seed subscriber.
4. `@ax/agents`: emit `agents:created` event after store.create commits.
5. `@ax/conversations`: extend `conversations:create` and `conversations:find-or-create` input schemas to accept `hidden?: boolean`; honor it.
6. `routines/src/fire.ts`: pass `hidden: true` on the create calls.
7. New package `@ax/routines-admin-routes` with three routes + ACL.
8. `presets/cli` + `presets/k8s`: load the new package.
9. `channel-web`: `RoutinesPanel` + `RoutinesList` + the four supporting components + `lib/routines.ts` + UserMenu plumbing + AppShell instance + tests.
10. `deploy/MANUAL-ACCEPTANCE.md`: new scenario.

All in one PR to satisfy invariant #3 (no half-wired plugins). The PR closes its own loop: a fresh canary run creates an agent → seeds the heartbeat → fires it → observes a hidden conversation + a fire row with rendered prompt → ticks the new acceptance scenario.

## 11. Risk register

- **`workspace:apply` against not-yet-materialized workspace.** Mitigation: verify behavior in impl plan; fall back to lazy seed on `workspace:materialized` if needed (§6.4).
- **`conversations:create` schema extension touches consumers outside routines.** Mitigation: the field is optional and defaults to `false`; no existing caller behavior changes.
- **`agents:created` is a new cross-plugin event.** Mitigation: matches existing patterns (`agents:webhook-token-rotated`, `workspace:applied`); declared in `@ax/agents` manifest under a new `fires:` list if such a list exists, or just documented if not.
- **Heartbeat seed failure on agent creation.** Mitigation: K10 — catch + log + don't propagate. Operator can manually re-seed via chat if needed.
- **`renderedPrompt` could be very large** (model output could be megabytes of context interpolated into a template). Mitigation: cap at 64 KiB in `recordFire`; truncate-with-ellipsis if exceeded. Matches the existing `silenceMaxChars` discipline.

## 12. Out of scope (follow-up tickets if/when needed)

- Transcript persistence so the Routines modal can show full agent replies, not just the rendered prompt.
- "Promote a hidden conversation to the sidebar" affordance.
- Backfill of `hidden=true` on pre-Phase D routine conversations.
- Heartbeat seed for pre-Phase D agents.
- Per-agent filter / search in the Routines modal.
- Agent-template concept (a richer "seed multiple files at agent creation" mechanism — the §6 hook generalizes naturally).
