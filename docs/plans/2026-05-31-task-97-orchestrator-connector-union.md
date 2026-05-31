# TASK-97 — Orchestrator union resolves connectors into the sandbox

**Status:** plan
**Epic:** connectors-first-class (design `docs/plans/2026-05-31-connectors-first-class-design.md`, Phasing step 4)
**Branch:** `auto-ship/TASK-97-orchestrator-connector-union`

## Problem

The chat-orchestrator unions skills (attachments + defaults + builtins + authored
drafts) and resolves their `Capabilities` (allowedHosts / credentials / mcpServers /
packages) into the sandbox. Connectors (TASK-91 store, TASK-92 manifest ref, TASK-93
approval wall) exist but **nothing routes them into the sandbox**. This card adds the
connector parallel to the skills union.

## Scope (read the design on how much to wire)

The card's "effective connector set = catalog defaults + manager-added + private":

- **catalog defaults** — NEW `connectors:list-defaults` hook (mirrors
  `skills:list-defaults`): admin-curated workspace defaults, flagged via a
  `default_attached` column on `connectors_v1_connectors`. WIRED.
- **private items** — the owner's own connectors. Resolved via the union of
  default-attached + the owner's full list (`connectors:list` already returns these
  by owner). WIRED.
- **manager-added catalog items** — a per-agent connector ATTACHMENT. @ax/agents has
  NO connector-attachment column, and the AgentForm connector-attachment work is the
  OTHER half of design Phase 4, explicitly scoped OUT of this card. NOT wired here
  (would be half-wired code — a write path nothing calls). Returned as a follow-up.
  The union code is structured so an attachment source slots in cleanly later.

So the resolvable effective set today = **default-attached connectors ∪ the owner's
own connectors**, deduped by id. This is a coherent, testable, non-half-wired slice —
the same half-wired seam TASK-91 used (store live, full consumer later).

**Out of scope (per design + card):** per-agent default removal; manager-added agent
attachment; the authored-connector resolver (`agents:resolve-authored-connectors`);
AgentForm / MCP-form UI; migration of skill caps into connectors.

## Approval posture

Catalog/default/private connector caps flow into the sandbox DIRECTLY (ungated),
the SAME trust posture as catalog/default SKILL caps (`skills:resolve` /
`skills:list-defaults` return caps ungated). The approved-caps wall (TASK-93) gates
MODEL-AUTHORED declarations at their resolver (like authored skills are gated inside
@ax/agents), NOT admin/manager-curated ones. There is no authored-connector resolver
yet, so "respect approval" in this card = preserve that pattern (don't fold
unapproved model-authored connector caps — there are none to fold yet). The union
reads admin-curated connectors only.

## Tasks

### Task 1 — `connectors:list-defaults` hook (@ax/connectors)
- Migration: `ALTER TABLE connectors_v1_connectors ADD COLUMN IF NOT EXISTS
  default_attached BOOLEAN NOT NULL DEFAULT false` (in-place, idempotent — mirrors
  skills migration line 45).
- Store: `listDefaults()` → full `Connector[]` (NOT summaries — the union needs
  capabilities) for rows with `default_attached = true`, sorted by id asc.
- Store: `setDefaultAttached(userId, connectorId, value)` (the admin write that
  TASK-100/UI will call; tested here, half-wired write OK because it's reachable +
  tested via the package canary, same as host-grants:revoke). Actually — defer the
  setter to avoid a half-wired write with no caller; seed `default_attached` directly
  in tests via upsert? No: upsert doesn't set it. Decision: add `setDefaultAttached`
  AND expose it as `connectors:set-default-attached` so it's reachable via the bus
  (the admin Catalog route in a later card calls it) — but that's a write with no
  caller = half-wired. CLEANER: have `upsert` accept an optional `defaultAttached`
  so the admin upsert path (existing `connectors:upsert`) sets it; no new hook, no
  half-wired setter. The union reads it via `connectors:list-defaults`.
- Hook: `connectors:list-defaults` → `{ connectors: Connector[] }` (full connectors,
  capabilities included — the union needs them). Return schema added + wired into
  the leak-guard test (capabilities is the only mechanism-vocab home).
- Types: `ListDefaultsInput { userId? }`, `ListDefaultsOutput { connectors: Connector[] }`,
  `ListDefaultsOutputSchema`.
- Tests: store listDefaults filters + sorts; upsert defaultAttached round-trips;
  hook returns full connectors; leak-guard covers the new schema.

### Task 2 — orchestrator connector union (@ax/chat-orchestrator)
- After the skills union builds `baseAllowSet` / `baseCreds` / `slotOwners` /
  `skillSlotEnvNames` and BEFORE the registry auto-allow loop, resolve the effective
  connector set and fold each connector's caps:
  - `connectors:list-defaults` (hasService-gated, non-fatal: throw/absent → []).
  - `connectors:list` + `connectors:resolve` for the owner's own connectors
    (hasService-gated, non-fatal). Union default ∪ own by id (own does not need to
    win — same connector id, same caps; dedupe by id, first wins).
  - Fold via a new `foldConnectorCaps` (mirror `foldAuthoredSkillCaps`): hosts →
    `baseAllowSet`; credential slots → `baseCreds` namespaced `connector:<id>:<slot>`
    with ref `account:<svc>` (tagged) | `connector:<id>:<slot>` (untagged); append to
    a `connectorSlotEnvNames` list feeding the bare-env projection.
  - Registry auto-allow: include connector packages in the npm/pypi detection loop.
  - mcpServers: materialize each connector as an `installedSkills` entry with a
    SYNTHETIC SKILL.md (the connector's usageNote as body + a name line) so the
    EXISTING sandbox materialization writes its `.mcp.json`. Namespace the sandbox
    dir id `connector-<id>` so it can't collide with a real skill dir.
  - **Dedup against skill caps:** hosts/registry are Sets (idempotent). Credential
    slots are namespaced per-subject (`skill:` vs `connector:`) so they never
    collide — a connector and a skill both wanting `LINEAR_API_KEY` coexist, and the
    bare-env projection's first-writer-wins keeps skills' precedence (connectors
    appended AFTER skill slots).
- The env projection's `skillSlots` input gains the connector slots (appended last).
- Non-fatal everywhere: a connector resolve failure logs + skips that connector
  (FEWER connectors, never wider reach) — connectors are additive.
- Tests (orchestrator.test.ts or a new connector-union.test.ts):
  1. union: default + private connector hosts/creds/packages reach proxy:open-session
     + the connector's mcpServers reach installedSkills.
  2. dedup: a connector + a skill declaring the same host → one allowlist entry; same
     bare slot → both coexist namespaced, skill wins the bare-env stamp.
  3. non-fatal: `connectors:list-defaults` throws → session still opens (not
     terminated), skill caps unaffected.

### Task 3 — wire + verify build graph
- @ax/chat-orchestrator already builds without @ax/connectors (type-only mirror of
  the connector shapes per I2 — NO runtime import, NO new package.json dep, NO
  tsconfig reference needed; the orchestrator duplicates the hook I/O shapes
  structurally like it does for every other peer hook).
- Verify isolated `pnpm --filter @ax/chat-orchestrator build` + `pnpm --filter
  @ax/connectors build` green (the TASK-91 preset-tsconfig trap does NOT apply — no
  new preset dep).
- `pnpm build && pnpm test` (changed packages) + lint.

## Boundary review (new hook: `connectors:list-defaults`)
- **Alternate impl:** `@ax/connectors-sqlite` registers the same hook reading a
  `default_attached` column from a sqlite table. Mechanism-agnostic.
- **Leaky fields:** none. Output is `{ connectors: Connector[] }`; backing-mechanism
  vocab lives only inside each connector's `capabilities` subtree (pinned by the
  leak-guard test, extended to this schema).
- **Subscriber risk:** the orchestrator keys off connector `id` + declared
  `allowedHosts`/`credentials`/`packages`/`mcpServers`, never off "is this MCP?".
- **Wire surface:** not an IPC action (host-internal union read only).

## Invariants
- I2: orchestrator type-mirrors connector shapes (no runtime cross-plugin import).
- I3: no half-wired plugin — `connectors:list-defaults` is registered + tested +
  reachable; the orchestrator union is its live consumer.
- I4: connectors stay the one source of truth; the union READS them, never copies
  rows into a skill table.
- I5 (sandbox boundary): connector caps fold the minimum reach declared; credential
  slots namespaced + the bare-env projection's trusted-name-wins guard prevents a
  connector hijacking a trusted credential, identical to the skill path.
