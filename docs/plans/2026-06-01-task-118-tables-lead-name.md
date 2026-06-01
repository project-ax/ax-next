# TASK-118 — Skills/Catalog tables: lead with the human name, demote font-mono IDs

epic: ux-polish · source: UX gap-analysis finding M2 · base: main

## Problem

Three skill tables lead with a `font-mono` skill **ID** column; the human-readable
**description** (the closest thing to a friendly name — `SkillSummary` has no `name`
field) should be the primary/lead column. Raw connector id-badges (`SkillSummary.connectors`,
a `string[]` of connector IDs) sit in their own column as bare badges; the acceptance
wants the raw ids demoted behind a tooltip/disclosure rather than displayed lead-prominent.

## Approach (see decisions.md 2026-06-01 TASK-118)

- **Lead with Description.** Remove the dedicated leading "ID" column header in all three
  tables. The first column becomes Description (friendly). The skill `id` renders as a small
  muted `font-mono` subline (`text-xs text-muted-foreground`) *under* the description in the
  same primary cell. Source/default/update-available badges that were attached to the old ID
  cell move next to the id subline.
- **Connector ids behind a Tooltip.** Replace the column of raw connector id-badges with a
  compact "N connectors" trigger; the raw ids live in a `Tooltip` (shadcn, already installed)
  + a `title` attr (testable/accessible fallback). Zero connectors keeps the em-dash.
- **Localized** to table column/cell structure only — no dialog/handler/fetch changes
  (minimize conflict with sibling TASK-119).

## Tasks

### Task 1 — UserSkillsPanelBody: catalog table + authored table (TDD)
File: `packages/channel-web/src/components/skills/UserSkillsPanelBody.tsx`
Test: `packages/channel-web/src/components/skills/__tests__/UserSkillsPanelBody.test.tsx`

- Catalog table: header `Description | Connectors | Updated | (actions)` (drop the `ID` head).
  Primary cell = description (lead) + id subline (muted font-mono) carrying SourceBadge +
  default badge. Connectors cell = "N connectors" w/ Tooltip listing raw ids + `title`; em-dash
  when none.
- Authored table: header `Description | Agent | Status | (actions)` (drop the `ID` head).
  Primary cell = description (lead) + skillId subline (muted). Agent id stays its own muted cell.
- Tests:
  - existing "lists the user skills" still finds description + id text; assert description now
    leads (first cell) and id is in the muted subline.
  - new: a multi-connector skill shows "N connectors" and the raw ids are reachable via the
    trigger's `title` (not rendered as standalone lead badges).
  - keep edit/delete/share/approve aria-labels working (they key off `id`/`skillId`, unchanged).
- Wrap the rendered tables in `TooltipProvider` (or wrap each Tooltip) so Radix tooltip mounts.

### Task 2 — CatalogTab table (TDD)
File: `packages/channel-web/src/components/admin/CatalogTab.tsx`
Test: `packages/channel-web/src/components/admin/__tests__/CatalogTab.test.tsx`

- Header `Description | Tier | Default | Connectors | Updated | (actions)` (drop `ID`).
  Primary cell = description (lead) + id subline (muted font-mono) carrying the
  "Update available" badge. Connectors cell = "N connectors" Tooltip + `title`; em-dash none.
- Tests: existing "renders a list of skills" still finds id + description; assert description
  leads; connector ids reachable via title. Update-available badge still renders near id.

## Gate
- `pnpm build && pnpm test --filter @ax/channel-web` + `pnpm lint` (scoped to changed files).
- Whole-branch review via `ax-code-reviewer`.

## Out of scope (handoff follow-ups)
- Mapping connector IDs → friendly `ConnectorSummary.name` in these tables (needs a fetch+state;
  overlaps TASK-119 connector-display scope).
