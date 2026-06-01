# Settings Overhaul — Skills / Connectors / Credentials (Design)

**Date:** 2026-06-01
**Status:** ⚠️ SUPERSEDED (2026-06-01) by `docs/plans/2026-06-01-settings-unified-skills-connectors-credentials-design.md`, which merges this doc's authoring + per-slot-credential keystone with the TASK-121 "admin-fold" / app-store ("Installed / Not installed") IA reorg into one non-colliding plan. This doc's keystone + surface designs were carried into the unified doc verbatim; build from the unified doc. Kept for the per-slot-ref blast-radius detail and decision history.
**Surfaces:** `packages/channel-web` (user Settings tabs + admin Connector Registry), `packages/credentials` (+ mirrors), `packages/connectors`, `packages/skills`, `packages/host-grants`, `packages/chat-orchestrator` (credential fold + cards).

## Goal

Close a batch of UX gaps and one modeling gap across the user-facing **Skills**, **Connectors**, and **Credentials** settings, plus the admin **Connector Catalog** form. Make connector/skill/credential authoring something a *non-technical user* can do from the UI — without exposing jargon ("credential slot", raw `SKILL.md`, "Advanced — how it connects") as the primary surface.

## Background (current state, verified against code)

- **Skills tab** (`SkillsTab.tsx` → `UserSkillsPanelBody.tsx`): installed skills already have Edit/Share/Delete; "Install a new skill" is the **raw `SKILL.md` editor** (`SkillEditor.tsx`) by default. The **"Authored by your agents"** list is *approve-only* — no edit.
- **Connectors tab** (`ConnectorsTab.tsx`): lists "Connected services"; per-connector status renders the literal strings **"connected" / "not connected" / "checking…"** (`:237-240`) regardless of mechanism. User can only Connect/Reconnect — **no add, no edit**. **"Allowed sites"** is a *revoke-only* card at the bottom of this tab (`:280`).
- **Credentials/Keys tab** (`KeysTab.tsx`): "Add a key" has a **free-text Service** field (auto-slugged to `account:<service>`) and a **single Value** field.
- **Admin Connector Registry** (`ConnectorRegistry.tsx`): full CRUD; mechanism config is hidden behind an **"Advanced — how it connects"** disclosure (MCP stdio/http + hosts + a comma-string of credential slots). **No npm/pypi package field exists**, though `capabilities.packages` supports it.
- **Egress posture** is **default-deny**: the credential-proxy per-session allowlist is the only gate (`listener.ts:10`). Reachable hosts = union of connector/skill `allowedHosts` + per-agent `host-grants` ("always allow") + provider host. `host-grants` is **allow-only** (grant/list/revoke; no deny). The open-web surface is `web_search`/`web_extract` (`@ax/web-tools`), host-executed via Anthropic, **global on/off**, not per-agent.

## Decisions (resolved in brainstorm)

1. **Credential model → per-slot refs (adaptive).** A credential maps to a connector's secrets *per declared slot*, but the form collapses a single-secret connector to one *Value* field. Field labels use the slot's plain-language `description` with the machine name as mono subtext.
2. **Connector mechanism types = MCP server / Direct API / Command-line tool.** "Downloadable binary" folds into Command-line tool (npm/pypi); it is *not* a fourth type (no capability-grammar support; raw binary fetch is an egress+exec risk).
3. **Allowed sites = its own section + proactive add.** No per-agent deny-list and no per-agent web-tools toggle (egress is already default-deny; these were declined).
4. **Full user connector authoring.** A user can create + edit + delete connectors they own; created connectors are **private** to them. Catalog/shared connectors stay read-only for non-admins. No approval wall for human-authored private connectors (the wall gates *model*-authored reach only).
5. **Skill editor = form-first, raw markdown as escape hatch; Adopt & edit for authored; additional files supported.**

### Out of scope (explicitly declined)
- Per-agent **deny/blocklist** for hosts.
- Per-agent **web-tools** (`web_search`/`web_extract`) on/off toggle.
- Provider/model API keys in "Add a key" — they stay in the existing Model-config surface.

---

## Keystone: per-slot credential refs

This is the cross-cutting change everything else leans on. Decide and land it first.

### Derivation rule (back-compat by construction)

- A connector with **exactly one** credential slot → ref stays **`account:<service>`** (unchanged). Existing keys resolve as-is, and the "share one key per service across connectors+skills" behaviour is preserved for the common case.
- A connector with **two or more** credential slots → ref is **`account:<service>:<slot>`** per slot. This fixes today's collision (two slots that both fall back to `account:<connectorId>` overwrite each other) and lets an MCP server declare e.g. `CLIENT_ID` + `CLIENT_SECRET` distinctly.

The UI mirrors the rule: 1 slot → a single *Value* field; ≥2 → one labeled field per slot.

### Labels (kills the "what's a credential slot?" jargon)
Every per-slot field is labeled with the slot's `description` (e.g. "Personal access token"), with the machine name + mechanism hint as mono subtext (`GITHUB_TOKEN · env var`). Truthful per mechanism: stdio MCP → env var; http MCP → header; Direct API → request auth.

### Blast radius (the same derivation, mirrored)
- `Destination` type gains an **optional `slot`** on the `account` variant.
- `refForDestination` — three mirrored copies (`credentials/src/refs.ts`, `credentials-admin-routes/src/destination-routes.ts`, `channel-web/src/lib/credentials.ts`) + the shared `credentials/src/refs-fixtures.ts` drift guard.
- Connector credential-plan — two mirrored copies (`connectors/src/credential-plan.ts`, `channel-web/src/lib/connectors.ts`): `serviceTagForSlot` / `accountRef` / `deriveCredentialPlan`.
- Orchestrator: the fold (`connector-union.ts:391` `account:${service}`) + `haveExisting`/capability cards (`orchestrator.ts:2753`, `connector-card.ts:66-67`, `skill-broker/.../request-capability.ts:255`).

No new service-hook signature — `credentials:set/get/list` are unchanged (the ref string is just shaped differently); only the `Destination` shape (and its mirrors) gains `slot`.

---

## Surface designs

### A. Credentials tab — "Add a key"
- **Service** becomes a **dropdown of the user's existing connectors** + a **"Custom…"** free-text fallback (a service with no connector yet → single `account:<service>` Value, today's behaviour).
- Selecting a connector reveals **its declared slots** → per-slot fields (single collapses to *Value*), with the friendly labels above.
- Provider/model keys are unaffected (separate surface).

### B. Connectors tab (user)
- **Status wording** replaces "connected/not connected" with **Ready / Needs a key / Can't reach it / Checking…** — plain-language equivalents of the admin registry's reachable/unreachable/needs-key, mechanism-agnostic.
- **Authoring:** "New connector" button + Edit/Delete actions on connectors the user **owns** (hand-made + agent-authored-then-promoted), via the shared mechanism-first form (§C). **Catalog/shared** connectors are read-only — "Catalog" badge + Connect/Reconnect only.
- **Allowed sites** moves out into **its own section** with a proactive **"Add a site"** (host text → `host-grants:grant`) alongside the existing revoke. Per-agent, as today.
- **New user-facing routes** (no new service hooks): `/settings/connectors` CRUD (owner forced to caller, `visibility` forced `private`, admin-only fields rejected) reusing `connectors:upsert/get/list/delete`; `/settings/allowed-sites` add/revoke reusing `host-grants:grant/revoke/list`.

### C. Connector form (shared by admin registry + user tab)
- **Mechanism picker up top** (segmented) — **MCP server / Direct API / Command-line tool** — reshapes the fields. The current "Advanced — how it connects" disclosure is removed.
  - *MCP server*: transport (stdio `command`+`args` / http `url`) + secrets (env for stdio, headers for http).
  - *Direct API*: allowed hosts + key(s) (proxy-injected).
  - *Command-line tool*: **npm/pypi package** picker (registry + package name — **new field**) + allowed hosts + env secrets. Binary folds in here.
- Credential slots are entered as **structured rows** (description + machine name + optional `account`), not a comma-separated string.
- **User variant** hides admin-only fields (`visibility: shared`, "default-on for all agents").

### D. Skills tab
- **Form-first New/Install skill:** Name (→ slug `id`), Description, **Connectors** (multi-select dropdown → manifest `connectors: []`), Instructions (body), **Additional files** (path + contents; bundle model, ≤512 KiB), "Available to all my agents by default" checkbox. **"Advanced — edit raw `SKILL.md`"** toggle, kept in sync with the fields (today's default view, demoted to opt-in).
- **"Authored by your agents" → Adopt & edit:** "Edit" copies the agent's authored draft into the user's **installed** skills (`skills:upsert` scope `user`, including any files), opens the form, and marks the draft adopted. The user then owns a first-class, shareable skill. (Implementation note: confirm whether "adopt" reuses `skills:authored-activate`/a clear, or needs a thin `skills:adopt-authored` helper — resolve in the plan.)

---

## Invariant & boundary notes (CLAUDE.md)

- **#2 (no cross-plugin imports):** new channel-web routes declare hook payload shapes locally (existing pattern). The per-slot `Destination` change keeps the mirrored-copy posture (no runtime import of `@ax/credentials`).
- **#5 (capabilities minimized) + untrusted input:** all new forms take browser-supplied content (connector specs, skill manifests/files, host strings, secret values). **Invoke `security-checklist`** when implementing the connector form, the skill editor, and the credential write paths. User connector routes force owner = caller and `visibility: private` server-side (can't over-grant). Human-authored private connectors intentionally skip the model-authored approval wall — the human *is* the granting authority for their own agents.
- **#6 (one UI language):** all surfaces compose existing `channel-web` shadcn primitives; add any missing primitive via the shadcn CLI (`-c packages/channel-web`). **Invoke the `shadcn` skill** for the form work.
- **Boundary review:** no new service-hook *signatures* (reuses `connectors:*`, `host-grants:*`, `skills:*`, `credentials:*`); only the `Destination` payload shape gains optional `slot`, and new HTTP routes are added (their schemas live in their plugin's directory). `host-grants` already exposes grant/list/revoke — proactive add is just a new caller.

## Decomposition into PR-sized cards

| # | Card | Depends on |
|---|------|-----------|
| 1 | **Per-slot credential refs** — `Destination.slot`, mirrored `refForDestination` + fixtures, `deriveCredentialPlan`, orchestrator fold + cards, single-secret back-compat | — (foundation) |
| 2 | **Add-a-key** — Service dropdown (connectors + custom) + per-slot fields + friendly labels | 1 |
| 3 | **Mechanism-first connector form** + npm/pypi package field (shared admin/user component) | 1 |
| 4 | **User connector authoring** — `/settings/connectors` CRUD, New/Edit/Delete own private, catalog read-only | 3 |
| 5 | **Connector status wording** — Ready / Needs a key / Can't reach it / Checking… | — (independent) |
| 6 | **Allowed sites** — own section + proactive add (`/settings/allowed-sites`) | — (independent) |
| 7 | **Skill editor form-first** — fields + additional files + synced raw-markdown toggle | — (independent) |
| 8 | **Adopt & edit authored skills** | 7 |

Cards 5, 6, 7 are independent of the credential refactor and can ship first as quick wins while the 1→2→3→4 stack lands.

## Open questions / risks
- **Adopt semantics** (card 8): exact hook path (reuse vs. thin new helper) — resolve in the implementation plan.
- **Existing stored credentials**: single-secret back-compat means no migration for the common case; confirm there are no multi-slot connectors already relying on the colliding `account:<connectorId>` ref before card 1 (likely none, but verify).
- **Form ⇄ raw-markdown sync** (card 7): round-trip must preserve unknown frontmatter keys; lean on `@ax/skills-parser` as the single parse authority.
