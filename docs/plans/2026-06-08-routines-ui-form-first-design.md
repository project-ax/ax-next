# Routines UI: Settings relocation + form-first authoring

**Date:** 2026-06-08
**Status:** Approved design, pre-implementation
**Branch:** `feat/routines-ui-form-first`

## Problem

The Routines surface has two UX gaps:

1. **Wrong home.** "Routines" is a top-level entry in the bottom-of-sidebar
   `UserMenu`, sitting next to Settings and Sign out. It belongs *inside*
   Settings, alongside Skills / Connectors / Agents.

2. **No form-based authoring.** Per-user routines are read-only in the UI — the
   `RoutinesList` empty state literally says *"create one via chat or git."* The
   only routine editor that exists is the admin **Default Routines** editor
   (`DefaultRoutineEditor`), and it is **raw-markdown only** (a `.md` textarea +
   parsed preview). The "Create a skill" flow (`SkillEditor`) already does this
   the right way — a structured form by default, with an *"Advanced — edit raw"*
   escape hatch — and routines should match it.

## Goals

- Move the Routines surface out of `UserMenu` into a new **"Routines" tab** in
  the Settings shell (`AdminShell` / `AdminSidebar`). Every user sees their own
  routines; admins additionally see the Default Routines section at the top of
  the same tab (mirrors how the Skills tab folds in admin curation).
- Add **form-first create / edit / delete for a user's own routines** — a real
  new capability. Source of truth stays the workspace file
  (`.ax/routines/<slug>.md`); the UI writes it via `workspace:apply`.
- **Reuse one editor component** for both per-user routines and Default
  Routines, replacing the raw-only `DefaultRoutineEditor`.

## Non-goals (v1)

- **Webhook HMAC config in the structured form.** The form covers the
  `path` + `events` of a webhook trigger; the full HMAC sub-form
  (`secretRef` / `header` / `algorithm` / `prefix`) stays in **Advanced/raw**
  mode. The HMAC secret *value* is already entered via the per-row credential
  slot in `RoutinesList`.
- No change to the routines engine, tick loop, sync, or fire path.
- No new `routines:*` service hook for reads (the existing `routines:list`
  already returns everything the editor needs).

## Current state (verified)

- **`UserMenu.tsx`** renders a `Routines` item (`onOpenRoutines`) →
  `RoutinesPanel` modal, wired in `App.tsx` (`routinesOpen` state).
- **`RoutinesPanel.tsx`** = a Dialog containing `DefaultRoutinesSection`
  (admin-gated) + `RoutinesList` (observability only).
- **`DefaultRoutineEditor.tsx`** = raw `.md` textarea + live parsed preview via
  `parseRoutineFrontmatter`; defaults are interval-only (cron/webhook rejected
  by the upsert hook, surfaced at preview time).
- **`SkillEditor.tsx`** = the reference: structured `FormFields` by default,
  `advanced` checkbox flips to a raw `RawEditor`; toggle is parser-mediated
  (`parseSkillManifest` / `buildSkillManifestYaml` / `splitSkillMd`); save sends
  whichever surface is active.
- **`@ax/validator-routine`** exports `parseRoutineFrontmatter` (parser) via the
  browser-safe `/frontmatter` subpath. **No builder exists.** The parser is
  strict — `RoutineFrontmatterFields` is fully modeled, no unknown-key
  passthrough — so a build↔parse round-trip is lossless on modeled fields.
- **`@ax/routines-admin-routes`** serves `/settings/routines` (list),
  `/settings/routines/:agentId/fires`, `/settings/routines/:agentId/fire`. Each
  route: `requireUser` → `agents:resolve` ACL (403 on forbidden/not-found) →
  delegate to a `routines:*` hook. **No create/edit/delete route.**
- **`routes-agent-identity.ts`** (channel-web) is the precedent for writing
  `.ax/**` files from a host route: build a workspace-routed ctx, `workspace:apply`
  a `put`/`delete` `FileChange` with `parent:null` and a **CAS-retry** on
  `cause.actualParent`, map a validator veto (`PluginError{code:'rejected'}`) to
  400.
- **`workspace:apply` facade (`@ax/core`)** fires `workspace:pre-apply` (veto) →
  `workspace:apply-internal` → `workspace:applied` (observe-only) for **every**
  caller. So a host write of a routine file flows through
  `handleWorkspaceApplied`, which upserts `routines_v1_definitions` and binds the
  webhook route — no extra fan-out needed. (This supersedes the old "host
  callers must fire applied themselves" rule, which predates this facade.)

## Design

### A. `@ax/validator-routine` — add the serializer

Add a pure function to `src/frontmatter.ts`, exported via the `/frontmatter`
subpath:

```ts
export function buildRoutineMd(fields: RoutineFrontmatterFields): string
```

- Emits the `---`-fenced YAML frontmatter (via `js-yaml` `dump`, already a dep)
  followed by `fields.promptBody`.
- Only emits keys that are set: `silenceToken` / `activeHours` omitted when
  absent; `silenceMaxChars` omitted when it equals the parser default (300) to
  keep generated files clean; `conversation` always emitted.
- Trigger is emitted per discriminant (interval/cron/webhook incl. optional
  `events`/`hmac`).
- **Round-trip test:** for a set of representative fields,
  `parse(build(fields)) deep-equals fields`. Also a property-style check that
  `build(parse(md).fields)` re-parses to the same fields for each trigger kind.

This is the only change in `@ax/validator-routine`; it stays node-free and
browser-safe.

### B. `@ax/routines-admin-routes` — per-user write routes

Add two handlers + routes next to the existing three:

- `PUT /settings/routines/:agentId` — body `{ path?: string, sourceMd: string }`
  (strict zod, `sourceMd` capped like the defaults route at 64 KiB).
  1. `requireUser` (401).
  2. `agents:resolve({ agentId, userId: actor.id })` → 403 on forbidden/not-found
     (reuses the existing `isOwnedBy` helper). The resolve result also yields the
     **workspace owner** used for routing (see ctx note below).
  3. `parseRoutineFrontmatter(sourceMd)` → 400 with the parser's reason on
     failure (fail fast before touching the workspace).
  4. Derive the file path: if `path` is supplied it must match
     `^\.ax/routines/[^/]+\.md$` (the `ROUTINE_PATH` regex `sync.ts` enforces);
     otherwise derive `.ax/routines/<slug>.md` from the frontmatter `name`
     (slugified, validated). Editing keeps the original `path`; creating derives
     it. A 400 on an unsafe/duplicate-segment slug.
  5. Build a **workspace-routed ctx** (`agentId` = target agent, `userId` =
     workspace owner) and `workspace:apply` a `put` of the file with
     `parent:null`, retrying once with `cause.actualParent` on a CAS miss —
     the `routes-agent-identity.ts` contract.
  6. Map `PluginError{code:'rejected'}` (validator-routine veto / injection scan)
     → 400 with `err.message`; success → 200 `{ path }`.

- `DELETE /settings/routines/:agentId?path=…` — `requireUser` → ACL → validate
  `path` against `ROUTINE_PATH` → `workspace:apply` a `delete` (same CAS-retry)
  → 204. Deleting a webhook routine's file makes `handleWorkspaceApplied`
  unregister its route and purge the minted HMAC credential — already handled.

**Manifest:** add `workspace:apply` to `calls`. `agents:resolve` is already
declared. Import `WorkspaceApplyInput` / `FileChange` from `@ax/core` (the
kernel — allowed; not a cross-plugin import).

**ctx routing note (Invariant 4 / known hazard).** `workspace:apply` routes by
`(ctx.userId, ctx.agentId)`. The existing `ctxForActor` sets
`agentId = PLUGIN_NAME` — wrong for a workspace write. Add a
`ctxForWorkspace(ownerUserId, agentId)` helper. The owner is the agent's owner
(personal agents: the actor; team agents: the owning user), resolved from
`agents:resolve`. If the resolve output doesn't expose an owner id cleanly, v1
scopes write to **personal** agents (gate non-personal with a 400 "edit team
routines via chat/git for now") and we revisit — never a silent mis-route.

**Reads:** unchanged server-side. `routines:list` already returns the full
`RoutineRow` (incl. `promptBody`, `activeHours`, `silenceToken`,
`silenceMaxChars`) and the `list` handler relays each row whole.

### C. Client — `lib/routines.ts`

- Widen the `Routine` interface with the already-on-the-wire fields:
  `promptBody`, `activeHours`, `silenceToken`, `silenceMaxChars`.
- Add:
  ```ts
  routines.save(input: { agentId: string; path?: string; sourceMd: string }): Promise<{ path: string }>  // PUT
  routines.remove(input: { agentId: string; path: string }): Promise<void>                                // DELETE
  ```
  Same `X-Requested-With: ax-admin` + error-reading shape as the existing
  methods.

### D. Shared `RoutineEditor.tsx` (the SkillEditor pattern)

New `packages/channel-web/src/components/routines/RoutineEditor.tsx`.

- **State:** a structured `RoutineFormState` (name, description, trigger
  discriminated union, conversation, optional silenceToken / silenceMaxChars /
  activeHours, promptBody) as the source of truth; `advanced` flag + `rawText`
  buffer for the escape hatch; `agentId` (create-only).
- **Surfaces:** `FormFields` (default) and `RawEditor` (raw `.md` + parsed
  preview), exactly like `SkillEditor`. The advanced toggle is parser-mediated:
  `enterAdvanced` seeds `rawText` from `buildRoutineMd(form)`; `exitAdvanced`
  re-parses and only returns to the form when it parses, else stays raw and
  surfaces the error.
- **Live validity gate:** `activeMd = advanced ? rawText : buildRoutineMd(form)`,
  parsed via `parseRoutineFrontmatter`; Save disabled while it doesn't parse.
- **Injectable API + constraints** (mirrors `SkillEditor`'s `api` prop):
  ```ts
  interface RoutineEditorApi {
    save(input): Promise<{...}>;     // per-user: routines.save; default: upsert/updateDefaultRoutine
    // load is not needed — caller passes the initial RoutineFormState
  }
  interface RoutineEditorConstraints {
    allowedTriggers: Array<'interval' | 'cron' | 'webhook'>;
    showAgentPicker: boolean;
  }
  ```
- **Form fields:**
  - **Name** — slug (becomes the file name / frontmatter `name`).
  - **Description** — one line.
  - **Agent** — create-only picker via `listChatAgents()` (hidden for defaults
    and when editing).
  - **Trigger** — a select limited to `allowedTriggers`, with conditional fields:
    - interval → `every` (text, hint `30s | 5m | 1h | 1d`, min 60s).
    - cron → `expr` + `tz` (tz defaults to `Intl.DateTimeFormat().resolvedOptions().timeZone`).
    - webhook → `path` (must start `/`, not `/webhooks/`) + `events` (chip list).
      HMAC → note: "configure in Advanced."
  - **Conversation** — select `per-fire | shared`.
  - **Options** (collapsible) — `silenceToken`, `silenceMaxChars`, `activeHours`.
  - **Prompt body** — textarea (the markdown after the fence).
- **Default Routines reuse:** `allowedTriggers: ['interval']`,
  `showAgentPicker: false`. `DefaultRoutineEditor` is **replaced** by
  `RoutineEditor`; `DefaultRoutinesSection` is updated to mount it with the
  default-routines api (`upsertDefaultRoutine` / `updateDefaultRoutine`, which
  take the assembled `sourceMd`). The interval-only / webhook-cron-rejected
  messaging is preserved (the select simply doesn't offer them).

### E. List affordances + relocation

- **`RoutinesList`** gains a "New routine" button (opens `RoutineEditor` in
  create mode) and per-row **Edit** / **Delete** actions (Edit opens the editor
  seeded from the row's full fields; Delete confirms, then `routines.remove`).
  Observability (fires, fire-now, HMAC credential slot) is unchanged. After a
  save/delete the list re-fetches (existing `refreshKey` idiom).
- **Relocation:**
  - `AdminSidebar`: add `{ id: 'routines', label: 'Routines', icon: ListChecks }`
    to `USER_NAV`; extend `AdminTabId`.
  - `AdminShell`: render the routines surface for the `routines` tab — the
    per-user `RoutinesList` for everyone, with `DefaultRoutinesSection` above it
    for admins (the current `RoutinesPanel` body, minus the Dialog chrome).
  - `UserMenu`: remove the `Routines` menu item and the `onOpenRoutines` prop.
  - `App.tsx`: drop the `RoutinesPanel` modal + `routinesOpen` state + the
    `onOpenRoutines` wiring. `RoutinesPanel.tsx` is removed (its content moves
    into the tab) — or kept as the tab body sans Dialog; implementation picks
    the smaller diff.

## Invariants & review

- **No half-wired code (Invariant 3).** Editor + write routes + client land
  together so the surface is reachable end-to-end the moment it merges. The
  Settings tab is wired and the menu item removed in the same change.
- **Boundary review.** No new service hook. The two new routes are thin HTTP
  shims over the existing `workspace:apply` facade + `routines:list`; their body
  schemas live in the plugin directory. No backend-specific vocabulary on the
  wire (`sourceMd` / `path` are storage-agnostic).
- **Capabilities (Invariant 5).** `routines-admin-routes` gains exactly one new
  capability: `workspace:apply`. Every write route ACL-gates via
  `agents:resolve` before touching a workspace.
- **Untrusted input (security-checklist trigger — caller-provided file path +
  workspace write).** `sourceMd` is model/user-authored untrusted content:
  validated server-side via `parseRoutineFrontmatter` before apply, and the
  `workspace:apply` facade still runs the validator-routine veto + identity
  injection scan. Path is constrained to `^\.ax/routines/[^/]+\.md$` (no
  traversal). The editor renders all server strings via React escaping; raw mode
  is a `<Textarea>`, never `dangerouslySetInnerHTML`. Run the `security-checklist`
  skill during implementation for the write-route + path-handling slice.
- **One UI language (Invariant 6).** `RoutineEditor` composes existing shadcn
  primitives only (`Input`, `Label`, `Textarea`, `Select`, `Checkbox`, `Badge`,
  `Button`, `Alert`, `Popover`/`Command` for pickers) with semantic tokens —
  same kit `SkillEditor` uses. Invoke the `shadcn` skill if a primitive
  (e.g. `Select`, `Collapsible`) isn't installed yet (`-c packages/channel-web`).

## Testing

- `@ax/validator-routine`: `buildRoutineMd` round-trip tests (all three trigger
  kinds, with/without optional fields).
- `@ax/routines-admin-routes`: PUT/DELETE — happy path (apply called with the
  right `put`/`delete` change + workspace-routed ctx), ACL 403 on a
  non-resolvable agent, 400 on invalid `sourceMd`, 400 on bad path, CAS-retry on
  parent-mismatch, validator-veto → 400.
- `channel-web`: `RoutineEditor` form↔raw round-trip + Save-disabled-while-
  invalid; `RoutinesList` create/edit/delete affordances; `AdminShell` renders
  the Routines tab (per-user list always, defaults section admin-only);
  `UserMenu` no longer shows Routines. Existing `user-menu.test.tsx` and
  routines tests updated.

## Rough task breakdown (for the plan)

1. `buildRoutineMd` + round-trip tests in `@ax/validator-routine`.
2. PUT/DELETE write routes + `ctxForWorkspace` + tests in
   `@ax/routines-admin-routes`.
3. `lib/routines.ts`: widen `Routine`, add `save` / `remove`.
4. `RoutineEditor.tsx` (form + advanced raw, constraints/api) + tests.
5. Swap `DefaultRoutinesSection` to use `RoutineEditor`; delete
   `DefaultRoutineEditor`.
6. `RoutinesList` create/edit/delete affordances.
7. Relocation: `AdminSidebar` + `AdminShell` tab; remove from `UserMenu` +
   `App.tsx`; remove/repurpose `RoutinesPanel`.
8. Full `pnpm build` + `pnpm test` + lint; update touched tests.
