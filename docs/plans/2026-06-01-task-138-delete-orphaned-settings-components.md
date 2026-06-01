# TASK-138 — Delete orphaned settings components (settings-unified epic, final cleanup)

Final cleanup of the settings-unified epic. The folds (TASK-125 nav, 126 Skills
app-store, 127 Connectors app-store, 128 connector form, 129 user authoring, 130
status wording, 131 allowed sites, 132 add-a-key, 133 skill editor, 134 adopt-&-edit)
have all merged. Their curation/logic was folded INLINE; the old standalone
components are now nav-dead. Delete the ones verified zero-production-references.

## Verification verdict (grep of `packages/channel-web/src`, excluding each file's own .tsx/.test.tsx)

| Component | Production refs | Verdict |
|---|---|---|
| `UserSkillsPanelBody.tsx` | only comments (no import) | DELETE + test |
| `CatalogTab.tsx` | only a comment in SkillsAppStore | DELETE + test |
| `AdmitQueueTab.tsx` | only comments (imports BundleReviewDialog, but nothing imports it) | DELETE + test |
| `ConnectorRegistry.tsx` | imported only by `admin-connectors.test.tsx` (a test) | DELETE + test + `admin-connectors.test.tsx` |
| `BundleReviewDialog.tsx` | **AwaitingReviewSection.tsx imports + renders it (live)** | **KEEP** — still referenced |
| `AuthoredSkillsSection.tsx` | **AgentForm.tsx imports + renders it (live)** | **KEEP** — still referenced |

The "comma-string↔rows compat shim TASK-128 added" is an inline adapter inside
ConnectorRegistry.tsx — deleting the file removes it. `splitList` in
`lib/connector-form.ts` STAYS (used internally by the live `capabilitiesFromForm`).

No server `/admin/*` route touched (defense-in-depth gates stay).

## Tasks

### Task 1 — Delete the verified-orphan component + test files (load-bearing)
Delete:
- `components/skills/UserSkillsPanelBody.tsx` + `components/skills/__tests__/UserSkillsPanelBody.test.tsx`
- `components/admin/CatalogTab.tsx` + `components/admin/__tests__/CatalogTab.test.tsx`
- `components/admin/AdmitQueueTab.tsx` + `components/admin/__tests__/AdmitQueueTab.test.tsx`
- `components/admin/ConnectorRegistry.tsx` + `components/admin/__tests__/ConnectorRegistry.test.tsx`
- `__tests__/admin-connectors.test.tsx`

### Task 2 — Comment hygiene (load-bearing: no dead-file pointers)
Repoint/past-tense the comments that cite a now-deleted file as a live exemplar:
- `components/admin/AgentForm.tsx` "(mirrors UserSkillsPanelBody)" → surviving exemplar
- `components/admin/AuthProvidersTab.tsx` "(mirrors UserSkillsPanelBody)" → surviving exemplar
- `components/settings/SkillsAppStore.tsx` "reusing the CatalogTab / AdmitQueueTab logic" / "(UserSkillsPanelBody)" → past-tense lineage, drop dead pointer
- `components/settings/AwaitingReviewSection.tsx` "(now nav-less) admin AdmitQueueTab" → past-tense lineage
- `__tests__/user-menu.test.tsx` UserSkillsPanelBody mention → light fix

### Task 3 — Gate (load-bearing)
`pnpm build` + `pnpm test --filter @ax/channel-web` + lint, all clean. Then a
whole-repo `pnpm test` to confirm no downstream package keyed off these (they're
channel-web-internal, so none expected, but verify).

## Out of scope / follow-ups
- BundleReviewDialog + AuthoredSkillsSection deletion — they are NOT orphaned; both
  are wired into live folds. Surface in handoff; no deletion.
