# Settings — Unified Skills / Connectors / Credentials (Design)

**Date:** 2026-06-01
**Status:** Design — brainstormed; pending spec review → decomposition.
**Supersedes:** `docs/plans/2026-06-01-settings-skills-connectors-credentials-overhaul-design.md` (the "overhaul" doc — its keystone + surface designs are carried in verbatim here) and the in-flight TASK-121 "admin-fold" brainstorm. This is the single source of truth for the Settings reorg.
**Surfaces:** `packages/channel-web` (user Settings tabs + admin nav), `packages/credentials` (+ mirrors), `packages/connectors`, `packages/skills`, `packages/host-grants`, `packages/chat-orchestrator`.

## Goal

Unify two complementary tracks into one coherent Settings reorg so they don't collide (both rewrite `SkillsTab`/`ConnectorsTab`/`KeysTab` + the connector form):

1. **Structure / navigation (the "fold"):** make Skills, Connectors, Credentials each *one* surface a non-technical user meets once. Adopt an **app-store model** — "Installed" (on your assistant) vs "Not installed" (available in the workspace catalog) — *inside* the Skills and Connectors tabs. Fold the admin **Catalog**, **Connector catalog**, and **Skills awaiting review** surfaces inline and remove them from the nav. Let a non-admin **self-install** from the catalog.
2. **Authoring / modeling:** make creating/editing a skill, connector, or key something a non-technical user can do from the UI — no jargon (`credential slot`, raw `SKILL.md`, "Advanced — how it connects") as the primary surface — plus the credential **per-slot refs** modeling fix.

The reconciliation between the two: the admin connector **registry stops being a separate surface**. Its CRUD/curation folds *inside* the unified Connectors tab; the mechanism-first form (below) is the shared component admins use to curate the catalog and users use to author private connectors.

## Background (current state, verified against code)

- **Nav** (`AdminSidebar.tsx`): "Settings" group (Skills, Connectors, Credentials — every user) + "Admin" group (AI model keys, Default AI model, Sign-in methods, Agents, **Catalog**, **Skills awaiting review**, **Connector catalog**, Teams — admins only). `AdminTabId` enumerates all of these.
- **Skills tab** (`SkillsTab.tsx` → `UserSkillsPanelBody.tsx`): installed skills have Edit/Share/Delete; "Install a new skill" is the **raw `SKILL.md` editor** (`SkillEditor.tsx`) by default; "Authored by your agents" is **approve-only**.
- **Connectors tab** (`ConnectorsTab.tsx`): lists "Connected services"; status renders literal **"connected / not connected / checking…"** (`:237-240`); user can only Connect/Reconnect — **no add, no edit**. **Allowed sites** is a *revoke-only* card at the bottom (`:280`, a TASK-120 explainer line was added).
- **Credentials/Keys tab** (`KeysTab.tsx`): "Add a key" has a **free-text Service** field (auto-slugged to `account:<service>`) + a **single Value**.
- **Admin Connector Registry** (`ConnectorRegistry.tsx`): full CRUD; mechanism hidden behind **"Advanced — how it connects"** (MCP stdio/http + hosts + comma-string of credential slots). **No npm/pypi package field** though `capabilities.packages` supports it.
- **Admin Catalog** (`CatalogTab.tsx`) curates org-wide skills + default-on; **Skills awaiting review** (`AdmitQueueTab.tsx`) approves submissions. These duplicate the Skills concept one nav layer down.
- **Egress** is **default-deny**: the credential-proxy per-session allowlist is the only gate. Reachable hosts = union of connector/skill `allowedHosts` + per-agent `host-grants` ("always allow") + provider host. `host-grants` is **allow-only**. `web_search`/`web_extract` (`@ax/web-tools`) is host-executed via Anthropic, **global on/off**.

## Decisions (resolved in brainstorm)

**Structure / fold:**
1. **App-store model inside the tabs.** Skills & Connectors tabs each split into **Installed** (active on the current agent) and **Not installed / Available** (the workspace catalog you can add). The "Not installed" shelf *is* the catalog.
2. **Fold the admin surfaces inline; remove them from nav.** `Catalog`, `Connector catalog`, `Skills awaiting review` drop from `AdminTabId` + `AdminSidebar`. Admin curation (set-default, remove-from-workspace, edit-definition, approve-pending) becomes **per-row + section controls inside** the Skills/Connectors tabs, gated on `isAdmin`. The admin **Connector Registry as a separate surface is gone** — folded into the Connectors tab.
3. **Self-install.** A non-admin can install a catalog skill / connect a catalog connector from the "Not installed" shelf (a user-scoped attach to their agent), shown with a **capability-consent card** at install (what hosts/keys it needs — same posture as today's connector connect flow).
4. **Nav groups stay "Settings" + "Admin".** No ownership ("Your stuff/Workspace") labels — install-state lives *inside* the tabs. "Admin" = genuinely workspace-level config with no user counterpart: **Agents, AI model keys, Default AI model, Sign-in methods, Teams**.

**Authoring / modeling (carried from the overhaul doc):**
5. **Credential model → per-slot refs (adaptive).** Single-secret connector collapses to one *Value*; ≥2 slots → one labeled field per slot. (Keystone, below.)
6. **Connector mechanism types = MCP server / Direct API / Command-line tool.** "Downloadable binary" folds into Command-line tool (npm/pypi); not a fourth type (no capability-grammar support; raw binary fetch is an egress+exec risk).
7. **Allowed sites = its own section + proactive add.** No per-agent deny-list, no per-agent web-tools toggle (egress is already default-deny; declined).
8. **Full user connector authoring.** A user can create/edit/delete connectors they own; created connectors are **private** to them. Catalog/shared connectors stay read-only for non-admins. **No approval wall for human-authored private connectors** (the wall gates *model*-authored reach only).
9. **Skill editor = form-first; raw markdown as escape hatch; Adopt-&-edit for authored; additional files supported.**

### Out of scope (explicitly declined / deferred)
- Per-agent **deny/blocklist** for hosts; per-agent **web-tools** on/off toggle.
- Provider/model API keys in "Add a key" — they stay in the Default-AI-model surface.
- The curated **service-first picker tiles** ("Connect Google Drive") + new shared-connector **catalog wire surface** — this design *unblocks* them but does not build them.

---

## Keystone: per-slot credential refs

The cross-cutting modeling change everything leans on. Land it first.

### Derivation rule (back-compat by construction)
- A connector with **exactly one** credential slot → ref stays **`account:<service>`** (unchanged). Existing keys resolve as-is; the "share one key per service across connectors+skills" behaviour is preserved for the common case.
- A connector with **two or more** credential slots → ref is **`account:<service>:<slot>`** per slot. Fixes today's collision (two slots both falling back to `account:<connectorId>` overwrite each other) and lets an MCP server declare e.g. `CLIENT_ID` + `CLIENT_SECRET` distinctly.

The UI mirrors the rule: 1 slot → a single *Value* field; ≥2 → one labeled field per slot.

### Labels (kills "what's a credential slot?")
Every per-slot field is labeled with the slot's `description` (e.g. "Personal access token"), with the machine name + mechanism hint as mono subtext (`GITHUB_TOKEN · env var`). Truthful per mechanism: stdio MCP → env var; http MCP → header; Direct API → request auth.

### Blast radius (same derivation, mirrored)
- `Destination` type gains an **optional `slot`** on the `account` variant.
- `refForDestination` — three mirrored copies (`credentials/src/refs.ts`, `credentials-admin-routes/src/destination-routes.ts`, `channel-web/src/lib/credentials.ts`) + the shared `credentials/src/refs-fixtures.ts` drift guard.
- Connector credential-plan — two mirrored copies (`connectors/src/credential-plan.ts`, `channel-web/src/lib/connectors.ts`): `serviceTagForSlot` / `accountRef` / `deriveCredentialPlan`.
- Orchestrator: the fold (`connector-union.ts` `account:${service}`) + `haveExisting`/capability cards (`orchestrator.ts`, `connector-card.ts`, `skill-broker/.../request-capability.ts`).

No new service-hook signature — `credentials:set/get/list` unchanged (the ref string is just shaped differently); only the `Destination` shape (+ mirrors) gains `slot`.

---

## Navigation (after the fold)

```
Settings              (every user)
  Skills              ← Installed / Not-installed inside
  Connectors          ← Connected / Available inside
  Credentials
Admin                 (admins only — workspace-level config, no user counterpart)
  Agents · AI model keys · Default AI model · Sign-in methods · Teams
```

`AdminTabId` drops `catalog`, `admit-queue`, and `connectors` (the registry). Server `/admin/*` routes stay role-gated (defense in depth) even though the controls now render inside the user tabs.

## Surface designs

### Skills tab (unified, app-store)
```
Skills — what your assistant can do
INSTALLED (n)                                    [ + Create ]
  <name>            🏢 default / your own        [Edit] [Remove] [Share]
NOT INSTALLED · available in your workspace (n)  [search…]
  <name>                                         [Install]
  (admin per-row: ⚙ set-default · remove-from-workspace · edit)
  (admin: + Add to workspace   ·   Awaiting review (n) )
```
- **Installed** — skills active on the current agent (your own + catalog-installed + 🏢 admin defaults). Per-row Remove; your own private ones get Edit/Delete + "Submit to workspace."
- **Not installed** — workspace-catalog skills not yet installed → **Install** (with capability consent). Searchable. *This shelf is the old Catalog.*
- **Form-first editor** (decision 9): "Create"/"Install"/"Edit" opens a form — Name (→ slug `id`), Description, **Connectors** (multi-select → manifest `connectors: []`), Instructions (body), **Additional files** (path + contents; bundle, ≤512 KiB), "Available to all my agents by default" checkbox, and an **"Advanced — edit raw `SKILL.md`"** toggle kept in sync (today's raw editor demoted to opt-in).
- **"Authored by your agents" → Adopt-&-edit:** "Edit" copies the agent's authored draft into the user's **installed** skills (`skills:upsert` scope `user`, incl. files), opens the form, marks the draft adopted.
- **Admin-only, inline** (`isAdmin`): per-row ⚙ set-as-default / remove-from-workspace / edit-definition; section-level **+ Add to workspace** and **Awaiting review (n)** (the old admit queue, now an inline affordance — approve/reject pending submissions).

### Connectors tab (unified, app-store)
- **Connected** vs **Available** (mirror of Installed/Not-installed) → **Connect** (with consent).
- **Status wording** replaces "connected/not connected" with **Ready / Needs a key / Can't reach it / Checking…** — plain-language equivalents of reachable/unreachable/needs-key, mechanism-agnostic.
- **Authoring:** "New connector" + Edit/Delete on connectors the user **owns** (hand-made + agent-authored-then-promoted), via the shared mechanism-first form (below). **Catalog/shared** connectors are read-only for non-admins (badge + Connect/Reconnect only). Admins curate the **Available** shelf inline (add/edit/set-default/remove) — this *is* the folded registry.
- **Allowed sites** moves into **its own section** with a proactive **"Add a site"** (host → `host-grants:grant`) alongside revoke. Per-agent, as today.
- **New user-facing routes** (no new service hooks): `/settings/connectors` CRUD (owner forced to caller, `visibility` forced `private`, admin-only fields rejected) reusing `connectors:upsert/get/list/delete`; `/settings/allowed-sites` add/revoke reusing `host-grants:grant/revoke/list`.

### Connector form (mechanism-first, shared — lives *inside* the Connectors tab)
- **Mechanism picker up top** (segmented) — **MCP server / Direct API / Command-line tool** — reshapes the fields. The "Advanced — how it connects" disclosure is **removed** (this supersedes the TASK-121 "Advanced" idea).
  - *MCP server*: transport (stdio `command`+`args` / http `url`) + secrets (env for stdio, headers for http).
  - *Direct API*: allowed hosts + key(s) (proxy-injected).
  - *Command-line tool*: **npm/pypi package** picker (registry + package name — **new field**) + allowed hosts + env secrets. Binary folds in here.
- Credential slots are **structured rows** (description + machine name + optional `account`), not a comma-string.
- **Admin variant** exposes `visibility: shared` + "default-on for all agents"; **user variant** hides them (forces private).

### Credentials tab — "Add a key"
- **Service** becomes a **dropdown of the user's existing connectors** + a **"Custom…"** free-text fallback (a service with no connector → single `account:<service>` Value, today's behaviour).
- Selecting a connector reveals **its declared slots** → per-slot fields (single collapses to *Value*), with the friendly labels above.
- Provider/model keys unaffected (separate surface).

## Invariant & boundary notes (CLAUDE.md)

- **#2 (no cross-plugin imports):** new channel-web routes declare hook payload shapes locally. The per-slot `Destination` change keeps the mirrored-copy posture (no runtime import of `@ax/credentials`).
- **#4 (one source of truth):** the fold removes the *duplicate* skills/connectors surfaces — the catalog lives in exactly one place (the "Not installed" shelf), curated inline. No concept is reachable under two names.
- **#5 (capabilities minimized) + untrusted input:** all new forms take browser-supplied content (connector specs, skill manifests/files, host strings, secrets). **Invoke `security-checklist`** for the connector form, skill editor, credential write paths, and the **self-install** path. User connector routes force owner = caller + `visibility: private` server-side. Human-authored private connectors skip the model-authored approval wall (the human is the granting authority for their own agents); **self-installing a catalog item shows a capability-consent card** but needs no wall (the item is admin-vetted).
- **#6 (one UI language):** all surfaces compose existing `channel-web` shadcn primitives; add any missing primitive via the shadcn CLI (`-c packages/channel-web`). **Invoke the `shadcn` skill** for the form work.
- **Boundary review:** no new service-hook *signatures* (reuses `connectors:*`, `host-grants:*`, `skills:*`, `credentials:*`); only `Destination` gains optional `slot`, and new HTTP routes are added (schemas in their plugin's directory).

## Decomposition into PR-sized cards

| # | Card | Phase | Depends on |
|---|------|-------|-----------|
| 1 | **Per-slot credential refs** — `Destination.slot`, mirrored `refForDestination` + fixtures, `deriveCredentialPlan`, orchestrator fold + cards, single-secret back-compat | P0 foundation | — |
| 2 | **Nav fold** — drop `catalog`/`admit-queue`/`connectors`(registry) from `AdminTabId` + `AdminSidebar`; Admin group = Agents/keys/model/sign-in/teams | P1 structure | — |
| 3 | **Skills tab → app-store** — Installed/Not-installed sections; fold Catalog curation + Awaiting-review inline (admin); non-admin **self-install** + consent (reuses `CatalogTab`/`AdmitQueueTab` logic) | P1 structure | 2 |
| 4 | **Connectors tab → app-store** — Connected/Available; fold registry curation inline (admin); non-admin **self-connect** + consent (reuses `ConnectorRegistry` logic) | P1 structure | 2 |
| 5 | **Mechanism-first connector form** (MCP / Direct API / CLI + npm/pypi; structured slot rows) — shared component inside the Connectors tab; removes the Advanced disclosure | P2 authoring | 1, 4 |
| 6 | **User connector authoring** — `/settings/connectors` CRUD (owner=caller, private forced), New/Edit/Delete own; catalog read-only | P2 authoring | 5 |
| 7 | **Connector status wording** — Ready / Needs a key / Can't reach it / Checking… | P2 authoring | 4 |
| 8 | **Allowed sites** — own section + proactive add (`/settings/allowed-sites`) | P2 authoring | 4 |
| 9 | **Add-a-key** — Service dropdown (connectors + custom) + per-slot fields + friendly labels | P2 authoring | 1 |
| 10 | **Skill editor form-first** — fields + additional files + synced raw-markdown toggle | P2 authoring | 3 |
| 11 | **Adopt-&-edit authored skills** | P2 authoring | 10 |
| 12 | **Unified Settings end-to-end manual-acceptance walk** `(walk)` | P3 | 3,4,5,6,7,8,9,10,11 |

Cards 7, 8 are largely independent and can ship alongside the 1→…→6 stack. The P1 fold (2,3,4) establishes the structure so the P2 forms are built once, into their final home.

## Open questions / risks
- **Adopt semantics** (card 11): exact hook path (reuse `skills:authored-activate`/a clear, vs a thin `skills:adopt-authored` helper) — resolve in the plan.
- **Existing stored credentials**: single-secret back-compat means no migration for the common case; **verify** there are no multi-slot connectors already relying on the colliding `account:<connectorId>` ref before card 1 (likely none).
- **Form ⇄ raw-markdown sync** (card 10): round-trip must preserve unknown frontmatter keys; lean on `@ax/skills-parser` as the single parse authority.
- **Self-install policy** (card 3/4): confirmed open to all users (the catalog is the workspace's vetted shelf); the install needs a user-scoped attach path + a consent card — verify a user-scoped attach hook exists or add a thin one.
- **Awaiting-review placement** (card 3): folded as an admin section/affordance inside the Skills tab; confirm it reads well there vs. a dedicated admin sub-view.
