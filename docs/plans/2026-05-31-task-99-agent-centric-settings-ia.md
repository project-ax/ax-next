# TASK-99 — Agent-centric Skills/Connectors/Credentials UI + admin Catalog + source badge

**Epic:** connectors-first-class · Phase 5 (UI/IA reorg)
**Design:** docs/plans/2026-05-31-connectors-first-class-design.md
**Branch:** auto-ship/TASK-99-agent-centric-settings-ia

## Problem

The agent settings surface (the AdminShell "Settings" section) is fragmented:
"Connections" (mislabeled), "Keys", plus the admin "MCP servers"→Connectors
registry and "Providers"/"Catalog"/"My Skills". The card collapses the
user-facing surface into three calm tabs — **Skills · Connectors · Credentials** —
each catalog-sourced item wearing at most one **"Catalog"** source badge; private
items show none. Admins keep one curation surface (Catalog for skills, the
connector registry for connectors, both flagging default-on). A solo user with no
curated catalog sees zero badges and zero "catalog" language.

This is a **UI-only** card. All data already exists:
- Skill source: `SkillSummary.scope` ('global' = catalog, 'user' = private).
- Connector source: `ConnectorSummary.visibility` ('shared') + `Connector.defaultAttached`.
- The `/admin/connectors` route is `auth:require-user`-gated + owner-scoped
  (TASK-98) — a non-admin lists/CRUDs their OWN connectors through it.
- Connector default-on already flows into agents via `connectors:list-defaults`
  (TASK-97); the admin form just doesn't surface the `defaultAttached` toggle yet.

No new hook, no new BFF endpoint, no schema change. Per-agent connector
attachment + per-agent opt-out stay deferred (design Out of scope; TASK-98).

## Tasks (independent, testable)

### Task 1 — `SourceBadge` shared component + helper
- New `components/SourceBadge.tsx`: `<SourceBadge source="catalog" />` renders
  `<Badge variant="secondary">Catalog</Badge>`; `source="private"` renders
  `null`. Pure, no fetch. shadcn `Badge` + semantic tokens only.
- Helpers: `skillSource(scope): 'catalog'|'private'` (`'global'→'catalog'`);
  `connectorSource({visibility, defaultAttached}): 'catalog'|'private'`
  (catalog iff `defaultAttached || visibility === 'shared'`).
- Test: `SourceBadge.test.tsx` — renders "Catalog" text for catalog, renders
  nothing (empty) for private; helper mapping table.

### Task 2 — `SkillsTab` (user Skills tab)
- New `components/settings/SkillsTab.tsx`: extract the "My Skills" content from
  `UserSkillsPanel` into a non-modal tab body. Keep the same wire calls
  (`listUserSkills`, `listAuthoredSkills`, create/edit/delete/share, JIT
  approve). Each catalog skill row (`scope === 'global'`) shows `<SourceBadge
  source="catalog"/>`; private (`scope === 'user'`) shows none.
- Reuse `UserSkillsPanel`'s table/dialog logic by refactoring its body into a
  shared `UserSkillsPanelBody` the modal wraps — avoids duplicating ~600 lines.
  (Keep `UserSkillsPanel` working: the user-menu "My Skills" entry still opens it
  during the transition; removing the menu entry is a follow-up, not this card —
  but wire the tab as the primary surface.)
- Tests: `SkillsTab.test.tsx` — three-tab presence is in AdminShell test;
  here assert a catalog skill shows the Catalog badge and a private skill does
  not; "No skills" empty state has no "catalog" copy.

### Task 3 — `ConnectorsTab` (user Connectors tab)
- New `components/settings/ConnectorsTab.tsx`: lists the user's connectors via
  `listConnectors()` (lib/connectors). Each tile (RoleCard or Card): service
  **name**, a "what it needs" caption (a personal/shared key, or "Nothing"
  when no credentials), connected/not state, and a `<SourceBadge>` (catalog iff
  `defaultAttached||visibility==='shared'`). Mechanism (transport/command/url/
  args) NEVER in the default view — only the admin registry edits it. A "Manage"
  link routes to the admin Connectors registry for editing (admins) / a
  read-only note (non-admins). Connect-flow copy respects `keyMode` (reuse
  TASK-96's `sharedKeyConsentMessage` for the shared-key consent line).
- Tests: `ConnectorsTab.test.tsx` — a `defaultAttached`/shared connector shows
  the Catalog badge; a private one shows none; tile copy is mechanism-free
  (assert no "stdio"/"http"/"command"/"url" text); "what it needs" caption.

### Task 4 — `CredentialsTab` (rename Keys)
- New `components/settings/CredentialsTab.tsx`: re-export / thin wrapper around
  the existing `KeysTab` body (it already IS the credentials vault — "Keys" +
  the account-keyed shared vault). Rename heading copy "My keys" → keep, tab
  label "Credentials". No behavior change. (Keep `KeysTab.tsx` as the impl;
  `CredentialsTab` = `KeysTab` re-export to minimize churn + preserve its test.)

### Task 5 — Rewire AdminShell + AdminSidebar user section
- `AdminTabId`: USER tabs become `'skills' | 'connectors-user' | 'credentials'`
  (drop `'connections'`, `'keys'`). ADMIN tabs unchanged (keep `'connectors'`
  registry, `'catalog'`, `'providers'`, etc.).
- `USER_NAV`: Skills (icon `Wrench`/`Sparkles`), Connectors (icon `Plug`),
  Credentials (icon `Key`). Default active tab = `'skills'`.
- `AdminShell`: render `SkillsTab`/`ConnectorsTab`/`CredentialsTab`; drop the
  `ConnectionsTab`/`KeysTab` imports from the user section. `TAB_META` updated.
- Disambiguate the admin "Connectors" registry label so the two nav entries
  don't collide: keep user tab label "Connectors" (Settings section) and the
  admin registry stays "Connectors" (Admin section) — tests scope by section /
  use getAllByRole. (If collision proves brittle in tests, label the admin
  registry "Connector catalog".)
- Update `AdminShell.test.tsx` + `AdminSidebar.test.tsx`: assert the three user
  tabs (Skills/Connectors/Credentials), default active = Skills, admin tabs
  still gated. Remove the stale Connections/Keys assertions.

### Task 6 — Admin connector default-on toggle
- `ConnectorRegistry.tsx` form: add a `defaultAttached` checkbox ("Default-on for
  all agents") in the form (carry through `formFromConnector` + the upsert body;
  the `Connector` type + PATCH already accept it). List view: show a "default"
  badge when `defaultAttached`. This is the "admin Catalog flags connectors
  default-on" half (skills already have it in `CatalogTab`).
- Update/extend the ConnectorRegistry test (create one if absent) to cover the
  default-on toggle round-trip.

### Task 7 — Cleanup + retire `ConnectionsTab` (allowed-sites)
- `ConnectionsTab` also showed **Allowed sites** (per-agent host grants). That's
  distinct from the three new tabs. Decision: fold "Allowed sites" into the
  **Connectors** tab as a secondary section (it's about what an agent can reach)
  OR keep it reachable. Minimal: move the Allowed-sites card into ConnectorsTab
  (agent switcher + revoke), preserving `getAllowedSites`/`revokeAllowedSite`.
  Retire `ConnectionsTab.tsx` + its test (the skills-merge view is superseded by
  the Skills tab + the agent's "what it can do" is the orchestrator union).
  → If folding allowed-sites bloats the card, keep ConnectionsTab's allowed-sites
    as a small section under Connectors and delete only the skills-merge half.

## YAGNI pass
- No new `/settings/connectors` endpoint (reuse `/admin/connectors`). ✓ cut.
- No per-agent connector attachment / opt-out (deferred). ✓ cut.
- No new source field on the wire (derive from scope/visibility). ✓ cut.
- Allowed-sites: keep (load-bearing, TASK-54) but relocate, not rebuild.

## Security
Admin Catalog curation crosses a trust boundary (flagging a connector default-on
grants it to every agent). The boundary is server-side (`/admin/connectors` PATCH
+ `connectors:list-defaults`), unchanged by this card — but run the
`security-checklist` skill in Phase 5 since admin-route-adjacent UI + untrusted
(connector name/usageNote/host) display text are touched. All untrusted strings
(connector name, usageNote, host, skill description) render through React text
nodes (auto-escaped) — never raw HTML.

## Gate
`pnpm install --frozen-lockfile` → `pnpm build` → `pnpm -F @ax/channel-web test`
+ lint changed files. Component tests cover the three-tab IA + badge
presence/absence. Run the FULL channel-web suite (transitive: AdminShell uses
every tab).
