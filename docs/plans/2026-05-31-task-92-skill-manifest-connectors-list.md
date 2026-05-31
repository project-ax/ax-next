# TASK-92 — Skill manifest gains `connectors[]` reference list (additive)

**Branch:** `auto-ship/TASK-92-skill-manifest-connectors-list`
**Epic:** connectors-first-class
**Design:** `docs/plans/2026-05-31-connectors-first-class-design.md` (Phasing step 1)

## Problem

A skill must be able to **declare** the connectors it uses (a soft-dependency
reference list of connector IDs), alongside the still-authoritative `capabilities`
block. This is the manifest-schema half of the half-wired window: `capabilities`
stays authoritative and continues to materialize into the sandbox; `connectors[]`
is a declared reference only (nothing routes through it until TASK-100 closes the
window).

## Approach (key architectural fact)

The skills store does **not** persist `capabilities` as a column — it re-parses
`manifest_yaml` on read (`parseCapabilities` in `_row-mappers.ts`). The manifest
YAML is the single source of truth; capabilities are *derived*. `connectors[]`
follows the **exact same derived-from-manifest pattern**: parse it from the YAML,
surface it on the read payloads. **No migration, no new column.**

`connectors` is a **top-level** manifest field (sibling of `sourceUrl`), NOT a
capability — it is a reference list, not a capability grant. Backing-mechanism
vocab (transport/command/url/mcp/packages) stays only inside the opaque
`capabilities` object (predecessor leak-guard invariant).

## Boundary review (ax-conventions)

- **Alternate impl:** a future `@ax/skills-fs` registers the same `skills:*` hooks;
  `connectors: string[]` (opaque IDs) is storable by any backend. ✓
- **Leaky field names:** none — `connectors` is a list of connector ID slugs; no
  transport/command/url/mcp vocab. ✓
- **Subscriber risk:** a subscriber keys off the connector *id* (resolved later via
  `connectors:resolve`), never off "is this MCP?". ✓
- **One source of truth:** the list is a *reference* (soft dep), not a copy of
  connector definitions (those live in `@ax/connectors`). Capability block stays
  authoritative (half-wired window open). ✓
- **Additive:** defaults to `[]` when absent; existing skills load unchanged. ✓

## Tasks

### Task 1 — Parser (`@ax/skills-parser`)
- Add `connectors: string[]` to `ParsedManifest` (always present, defaults `[]`).
- Parse top-level `connectors:` (sibling of `sourceUrl`). Validate: array of
  strings; each matches connector-ID grammar `/^[a-z0-9][a-z0-9_-]*$/`, length
  1–128; bounded count (max 64); dedupe? No — preserve as declared (reference list).
- New `ManifestCode`: `'invalid-connector'`.
- Add `connectors` to the misplaced-cap-key guard? No — `connectors` is top-level
  by design; but DO reject `connectors` nested under `capabilities` (it's not a
  capability) for the same fail-loud reason. (Add a dedicated check.)
- `build.ts`: emit `connectors:` when non-empty (round-trip parity).
- Tests: accepts list / defaults `[]` / validates grammar+length+count / rejects
  non-array / rejects nested-under-capabilities / round-trips via build.

### Task 2 — Skills store surfacing (`@ax/skills`)
- Add `connectors: string[]` to `SkillSummary` and `ResolvedSkill` (`SkillDetail`
  extends `SkillSummary`).
- `_row-mappers.ts`: derive `connectors` from the parsed manifest (parallel to
  `capabilities`); fallback `[]` on corrupt manifest.
- `types.ts`: add `connectors: z.array(z.string())` to `SkillSummarySchema` and
  `ResolvedSkillSchema`.
- No migration (derived from existing `manifest_yaml`).

### Task 3 — Tests (round-trip is acceptance-required)
- Parser tests (Task 1).
- `_row-mappers` (or store) round-trip test: a skill whose manifest declares a
  non-empty `connectors[]` surfaces it on summary/detail/resolved; an absent field
  surfaces `[]`.
- `return-schemas.test.ts` drift coverage picks up the new field automatically
  (the schemas are asserted assignable to the interfaces).

## Out of scope (deferred — return as follow-ups)
- Routing connectors through `@ax/connectors` at spawn/proxy time (TASK-100 closes
  the half-wired window).
- Validating that referenced connector IDs *exist* (cross-plugin existence check) —
  the reference is a soft dependency; a dangling ref simply doesn't resolve.
- `build.ts` callers / promote flow emitting connectors from a connector picker UI.
