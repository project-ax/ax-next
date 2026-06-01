# TASK-126 — Skills tab → app-store (Installed / Not-installed)

**Branch:** `auto-ship/TASK-126-skills-app-store` · **Epic:** settings-unified · **Design:** `docs/plans/2026-06-01-settings-unified-skills-connectors-credentials-design.md` (card 3)

## Problem statement

Rebuild the Settings Skills tab as an app-store split:

- **INSTALLED** — skills active on the *current agent*: 🏢 admin defaults + agent-global + the user's own user-scoped attachments. Per-row Remove (only removable). Your-own private definitions also get Edit/Delete + "Submit to workspace".
- **NOT INSTALLED · available in your workspace** — the global catalog skills NOT yet installed on the current agent. Searchable. Per-row **Install** (user-scoped attach) gated behind a **capability-consent card**. *This shelf is the old Catalog.*
- **Admin-only inline** (`isAdmin`): per-row ⚙ set-as-default / remove-from-workspace / edit-definition (reuse CatalogTab logic), section-level **+ Add to workspace** + **Awaiting review (n)** approve/reject (reuse AdmitQueueTab logic). NO new nav entries (TASK-125 dropped them).

## Key architecture findings (verified against code @ origin/main)

1. **INSTALLED is per-(user,agent).** The backbone already exists: `GET /api/chat/connections/:agentId` (`routes-connections.ts`) returns `ConnectionSkill[]` with `source: 'default'|'agent'|'user'` + `removable`. `DELETE /api/chat/connections/:agentId/skills/:skillId` removes a user attachment. `lib/connections.ts` already wraps both.
2. **Current-agent selector** — `listChatAgents()` (`lib/agents.ts`) → `ChatAgentSummary[]`; ConnectorsTab already uses it for its allowed-sites agent switcher. Default to first agent.
3. **NOT-INSTALLED shelf = global catalog.** `listSkills()` (`lib/skills.ts`) → `/admin/skills` → `CatalogSkillSummary[]` (admin-only route). For NON-admins there is no list-global-catalog route today. → must add a user-facing read.
4. **Self-install hook exists, route does NOT.** `skills:attach-for-user` (host-internal, NOT IPC) exists; no HTTP route exposes it. → add thin `POST /api/chat/connections/:agentId/skills` (body `{ skillId }`, user-forced, ACL via agents:resolve, mirrors detach).
5. **Consent card posture** — mirror `ConnectorConnectDialog`: show what hosts/keys the skill needs before the attach completes. A skill's reach is its referenced connectors (TASK-100: skills declare no caps). So consent surfaces the skill's `connectors` (names) — admin-vetted item ⇒ consent card, NO approval wall (design §#5 / card acceptance).
6. **Admin curation reuse** — CatalogTab logic: `setSkillDefaultAttached`, `deleteSkill` (remove-from-workspace), edit via SkillEditor; AdmitQueueTab logic: `listCatalogRequests` + `BundleReviewDialog` (`decideCatalogRequest`).

## Decisions (logged to .claude/memory/decisions.md)

- **D1: INSTALLED reads `/api/chat/connections/:agentId`, not `listUserSkills()`.** The card says "active on the current agent"; connections is the existing per-agent union (default+agent+user). `listUserSkills()` is only the user's private DEFINITIONS (no agent binding) and would mis-model "installed". The current SkillsTab (which lists `listUserSkills`) is replaced.
- **D2: NOT-INSTALLED needs a user-readable global-catalog list.** Add `GET /api/chat/catalog-skills` (channel-web BFF, auth:require-user) returning global `skills:list{scope:'global'}` summaries (id/description/connectors/defaultAttached). Admin `/admin/skills` stays admin-only (defense-in-depth); the app-store shelf is every-user, so it needs its own non-admin read. Admin extras (tier, edit, set-default) still go through the admin `/admin/skills*` routes gated server-side.
- **D3: Self-install attach route** `POST /api/chat/connections/:agentId/skills` `{ skillId }` → `skills:attach-for-user` with `credentialBindings: {}` (skills declare no caps → no bindings). userId server-forced; agents:resolve ACL (404 no-leak); 201 `{ created }`. The skill id is validated to be a real GLOBAL catalog id server-side before attach (reject self-install of an arbitrary id — capability-min).
- **D4: Consent card = skill's connectors + "uses your workspace's vetted skill" note.** No keys are entered at skill-install (a skill's keys live on its connectors, connected separately). If the skill references connectors, the consent card lists them ("This skill uses: <connector names>") so the user sees the reach before attaching. Blocking accept, mirroring ConnectorConnectDialog's consent gate.
- **D5: Agent selector at top of tab.** Like ConnectorsTab. INSTALLED + NOT-INSTALLED are scoped to the selected agent.
- **D6: SkillsTab gains `isAdmin` prop** (passed from AdminShell). The body (new `SkillsAppStore`) takes it. UserSkillsPanelBody is retired as SkillsTab's body (its private-CRUD + authored + JIT-approve logic folds into the new INSTALLED section's own-skill rows / authored sub-section).

## Tasks (TDD, each independently testable)

### T1 — Wire surface: catalog-skills read + attach route (server, @ax/channel-web)
- Add to `routes-connections.ts`:
  - `listCatalog(req,res)` → `GET /api/chat/catalog-skills`: auth → `skills:list{scope:'global'}` → map to `{ skillId, description, connectors, defaultAttached }[]`. (No agent needed.)
  - `attach(req,res)` → `POST /api/chat/connections/:agentId/skills`: auth → agents:resolve ACL → parse `{ skillId }` → validate skillId ∈ global catalog (`skills:get{scope:'global'}` or list membership) else 404 → `skills:attach-for-user{userId,agentId,skillId,credentialBindings:{}}` → 201 `{ created }`.
- Register both in `server/plugin.ts`.
- `lib/connections.ts`: add `attachConnectionSkill(agentId, skillId)` + `listCatalogSkills()` (+ `CatalogSkillListing` type).
- Tests: `routes-connections` server test (attach happy/ACL-404/missing-id/non-catalog-id-404; catalog list shape). Boundary: NO new service-hook signatures (reuses skills:* + agents:resolve); new HTTP routes only (schemas local).
- **security-checklist** REQUIRED here (untrusted browser-supplied install request crossing trust boundary).

### T2 — SkillInstallConsentDialog (new component)
- New `components/settings/SkillInstallConsentDialog.tsx`: given a catalog skill listing, shows description + "This skill is from your workspace's vetted catalog" + (if `connectors.length`) "Uses: <connector chips>" + an "Install" button (blocking; mirrors ConnectorConnectDialog consent). On confirm → `attachConnectionSkill(agentId, skillId)` → `onInstalled()`.
- Test: renders connectors, calls attach on confirm, surfaces error.

### T3 — SkillsAppStore (new body) — INSTALLED + NOT-INSTALLED sections
- New `components/settings/SkillsAppStore.tsx` ({ isAdmin }):
  - Agent selector (listChatAgents; default first).
  - INSTALLED section (count): `getConnections(agentId)`. Row shows description + 🏢 default badge (source==='default') / "your own" (source==='user' + private def) ; Remove button only when `removable`. Own-private rows (cross-ref `listUserSkills()` by id) get Edit/Delete + Submit-to-workspace (reuse existing handlers + dialogs from UserSkillsPanelBody).
  - "+ Create" (own private skill) → SkillEditor in a dialog (userSkillsApi).
  - NOT-INSTALLED section (count, search input): `listCatalogSkills()` minus installed ids. Row → Install (opens SkillInstallConsentDialog).
  - Authored-by-your-agents sub-section + JIT approve (port from UserSkillsPanelBody).
- Test: INSTALLED renders default/own/removable correctly; NOT-INSTALLED excludes installed, search filters, Install opens consent.

### T4 — Admin inline folds (gated on isAdmin) in SkillsAppStore
- NOT-INSTALLED admin per-row: ⚙ menu (set-as-default via `setSkillDefaultAttached`, remove-from-workspace via `deleteSkill`, edit-definition via SkillEditor admin api). Section-level "+ Add to workspace" (SkillEditor admin api, `upsertSkill`).
- "Awaiting review (n)" admin affordance: collapsible section reusing `listCatalogRequests` + `BundleReviewDialog` (the AdmitQueueTab logic, inline).
- Test: admin sees ⚙ + Add-to-workspace + Awaiting-review; non-admin does not.

### T5 — Rewire SkillsTab + AdminShell + retire old tab body
- `SkillsTab.tsx` → `({ isAdmin }) => <SkillsAppStore isAdmin={isAdmin} />`.
- `AdminShell.tsx` → `<SkillsTab isAdmin={isAdmin} />`.
- Update `SkillsTab.test.tsx` to the new structure (INSTALLED/NOT-INSTALLED).
- Keep CatalogTab/AdmitQueueTab files (still referenced only as logic source; deletion out of scope, matches TASK-125 posture). UserSkillsPanelBody becomes orphaned (SkillsTab no longer imports it). Leave it (no nav, no import) — a follow-up can delete.

## Invariants
- #4 one source of truth: NOT-INSTALLED shelf is the *only* place the catalog renders for a user; admin curation is inline, not a second nav surface. No new concept name.
- #2 no cross-plugin imports: channel-web declares hook shapes locally (already the pattern in routes-connections).
- #5 capabilities minimized: attach route validates skillId ∈ global catalog + server-forced userId + agents:resolve ACL; consent card is informational (admin-vetted, no wall).
- #6 shadcn primitives + semantic tokens; invoke `shadcn` skill.

## YAGNI pass
- All tasks load-bearing for the card acceptance. No speculative hooks. Consent card carries NO key entry (skills have no own slots) — minimal by design.
