# TASK-117 — Replace native confirm() with styled Dialog for destructive deletes

epic: ux-polish · source: UX gap-analysis finding M4

## Problem

Three admin surfaces use the OS `window.confirm` for destructive deletes, which the
audit flagged (M4). They must use the shadcn `Dialog`-based confirm pattern that
`UserSkillsPanelBody` (the body behind SkillsTab) already uses — semantic tokens,
shadcn primitives only.

## Canonical pattern (UserSkillsPanelBody.tsx:478-508)

- `const [pendingDelete, setPendingDelete] = useState<T | null>(null)`
- delete button `onClick` → `setPendingDelete(entity)`
- `<Dialog open={true} onOpenChange={(v) => { if (!v) setPendingDelete(null) }}>`
  rendered only when `pendingDelete !== null`, containing:
  - `DialogContent > DialogHeader > DialogTitle`
  - muted-text body (`text-sm text-muted-foreground`)
  - footer `div.flex.justify-end.gap-2` with Cancel (`variant="outline"`) +
    Delete (`variant="destructive"`)
- the destructive action handler clears `pendingDelete` on success AND on error.

## Tasks (independent, testable)

### Task 1 — ConnectorRegistry.tsx
- Add `pendingDelete` state (`ConnectorSummary | null`).
- `remove(c)` → `setPendingDelete(c)`; new `confirmDelete()` runs
  `deleteConnector(pendingDelete.id)` + refresh, clears pending in both branches.
- Add Dialog after the list (`editing === null` branch).
- Delete `if (!confirm(...))`.
- Test file: list → click delete → dialog shows connector name → Cancel (no
  `deleteConnector` call, dialog gone) and Delete (calls `deleteConnector('<id>')`).

### Task 2 — AgentForm.tsx
- Same pattern, `AdminAgent | null`. Remove the stale `confirm()` comment.
- `deleteAgent(pendingDelete.id)`.
- Test file: confirm + cancel paths.

### Task 3 — AuthProvidersTab.tsx
- Same pattern, `AuthProviderEntry | null`. Keep the edit localized to the
  `handleDelete` region — TASK-115 runs concurrently and renames a label here.
- `deleteAuthProvider(pendingDelete.kind)`.
- Test file: confirm + cancel paths.

## YAGNI pass
All three tasks are load-bearing (acceptance requires all three files converted +
tests). No dead code. No shared confirm-dialog component extracted — the audit asked
for consistency with the existing per-component pattern, and three copies of a 20-line
JSX block is not enough duplication to justify a new abstraction (UserSkillsPanelBody
itself inlines it). If a 4th+ site appears, extract then.

## Out of scope / no boundary review
Pure channel-web UI. No hooks, IPC, untrusted content, or new deps → no boundary
review, no security-checklist.
