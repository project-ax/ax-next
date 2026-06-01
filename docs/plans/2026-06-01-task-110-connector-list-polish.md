# TASK-110 — Connector-list polish: `defaultAttached` on `ConnectorSummary` + retire My Skills modal entry

Followup from TASK-99. Two small UI cleanups after the 3-tab IA. Display polish; no
new hooks, no sandbox/IPC/credential boundary touched → no security-checklist needed.

## Problem

1. The user connector list (`ConnectorsTab`) badges admin default-on connectors via
   `connectorSource(c)`, whose `defaultAttached === true` branch produces the
   "Catalog" badge. But `c: ConnectorSummary` (the `/admin/connectors` LIST shape)
   doesn't carry `defaultAttached` — only `visibility`. So an admin-curated
   default-on, `visibility:'private'` connector shows NO badge (the branch is dead
   for lack of data). TASK-99 noted only the full `Connector` carries the flag.
2. The user-menu "My Skills" modal entry is redundant now that the Skills settings
   tab is the primary surface (the shared `UserSkillsPanelBody` renders in both).

## Tasks (independent, testable)

### Task 1 — `defaultAttached` on the connector summary (data plane → wire → mock)
- `packages/connectors/src/types.ts`: add `defaultAttached: boolean` to the
  `ConnectorSummary` interface and to `ConnectorSummarySchema` (`z.boolean()`).
- `packages/connectors/src/store.ts` `rowToSummary`: map
  `defaultAttached: row.default_attached === true` (same NULL-safe coercion as
  `rowToConnector`). The `scopedConnectors` query already `selectAll`s the column.
- `packages/channel-web/src/lib/connectors.ts`: add `defaultAttached: boolean` to
  its duplicated `ConnectorSummary` interface; `Connector extends ConnectorSummary`
  then drops its own `defaultAttached` re-declaration (now inherited).
- `packages/channel-web/mock/admin/connectors.ts` `toSummary`: map `defaultAttached`
  (and `toConnector` then drops the duplicate spread field, inheriting it).
- Tests:
  - `connectors/src/__tests__/store.test.ts`: a list-summary assertion that a
    default-flagged connector's summary carries `defaultAttached: true` and a
    non-flagged one `false` (would have caught the dropped field).
  - `connectors/src/__tests__/hooks.test.ts`: assert `connectors:list` summary
    carries `defaultAttached` matching the upserted flag.
  - `channel-web` `ConnectorsTab.test.tsx`: a default-on private connector shows the
    "Catalog" badge (the user-visible bug); a private non-default shows none.

### Task 2 — retire the "My Skills" user-menu modal entry
- `UserMenu.tsx`: remove the `my-skills` button, the `onOpenUserSkills` prop, the
  `BookOpen` import.
- `Sidebar.tsx`: remove the `onOpenUserSkills` prop + pass-through.
- `App.tsx`: remove `userSkillsOpen` state, `<UserSkillsPanel>` render, the
  `onOpenUserSkills` prop on `<Sidebar>`, and the `UserSkillsPanel` import.
- Delete `components/skills/UserSkillsPanel.tsx` (no remaining consumer — Half-Wired
  Code Policy). Keep `UserSkillsPanelBody.tsx` (rendered by `SkillsTab`).
- Tests:
  - Rename `skills/__tests__/UserSkillsPanel.test.tsx` →
    `UserSkillsPanelBody.test.tsx`; render `<UserSkillsPanelBody active />`; drop the
    3 modal-chrome tests (open=false, two `My Skills` title tests); keep all
    behavioral tests (delete/share/authored/JIT-approve).
  - `user-menu.test.tsx` / `UserMenu.test.tsx`: assert the `my-skills` menuitem is
    gone (regression guard for the removal).

## Gate
`pnpm build && pnpm test && pnpm lint` (changed files) green.
