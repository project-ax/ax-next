# TASK-100 — Remove the skill capability block; caps flow only via connectors

**Branch:** auto-ship/TASK-100-remove-capability-block
**Design:** docs/plans/2026-05-31-connectors-first-class-design.md (Phase 6)
**Predecessor:** TASK-111 (skill→connector cap-resolution bridge, MERGED)

## Problem

During the half-wired window (TASK-91…TASK-111) a skill could declare reach two
ways: its own `capabilities:` block (legacy, authoritative) AND its top-level
`connectors[]` reference list (TASK-92, resolved into caps by TASK-111). Both
paths are live today. Invariant #4 (one source of truth) and #3 (no half-wired)
require closing the legacy path: a skill manifest must no longer carry caps;
reach comes only from the connectors it references.

Security invariant to preserve (TASK-111): a model-authored skill can only NAME a
connector id; reach comes from `connectors:resolve`, which reads only the live
human-approved/curated connectors table, so a pending/unapproved connector grants
ZERO sandbox reach. Removing the cap block must not weaken this.

## Tasks

### T1 — skills-parser: hard-reject `capabilities`, drop the field
- `manifest.ts`: REJECT any top-level `capabilities` key with a new
  `capability-block-forbidden` ManifestCode (hard fail). Remove cap-block parsing
  helpers that become dead. `ParsedManifest` drops `capabilities`; keeps
  `connectors`, `sourceUrl`, id/description/version.
- `build.ts`: drop `capabilities` param + emission.
- `capabilities.ts` + `index.ts`: KEEP the shared `Capabilities` types
  (connectors depend on them).
- Tests: reject-validator test; rewrite manifest/build tests.

### T2 — skills package: drop the cap field from domain types + readers
- `types.ts`: remove `capabilities` from SkillSummary/ResolvedSkill; update
  return-schemas. Keep `connectors`.
- `_row-mappers.ts`: drop `parseCapabilities`/`EMPTY_CAPABILITIES` from mappers.
- `catalog-tier.ts`/`propose-gate.ts`: a skill is now always zero-cap → simplify.
- `plugin.ts`/`settings-routes.ts`/`admin-routes.ts`/`check-updates.ts`/`store.ts`:
  drop skill-cap reads.

### T3 — chat-orchestrator: remove the skill-cap materialization path
- `orchestrator.ts`: ResolvedSkillForOrch loses `capabilities`; remove the skill
  egress fold, authored cap append, package detection, per-skill mcp/hosts/creds
  in installedSkillsForSandbox — connectors supply all via foldConnectorCaps.
- `authored-egress.ts` foldAuthoredSkillCaps: dead → remove + call.
- AuthoredResolvedSkillForOrch.proposalDelta: always empty → remove skill-cap
  card path; keep body/status projection.

### T4 — skill-broker request_capability: drop the skill-block branch
- `request-capability.ts`: card derives caps ONLY from referenced connectors.

### T5 — agents: drop the authored-skill cap-projection
- `authored-caps.ts`: proposal always empty → simplify projection.
- `authored-skills.ts`/`plugin.ts`/`skill-attachments-validation.ts`: drop
  skill.capabilities reads; attachment binding validation becomes empty/no-op.

### T6 — channel-web routes-connections
- Stop reading skill.capabilities.

### T7 — Data migration (idempotent, re-runnable)
- In @ax/skills init: for each global+user skill row whose manifest carries a
  `capabilities:` key, extract caps → `connectors:upsert` a connector named after
  the skill, rewrite manifest to drop caps + add connector ref, update row.
  Idempotent (already-migrated skipped); re-runnable; via hooks (no cross-plugin
  SQL). hasService-gated; if no connectors plugin → strip caps + warn.
- Authored drafts: strip the cap block.

### T8 — Invariant-#4 guard test
- Assert parsing a manifest with a `capabilities` block hard-fails; builtins are
  cap-free.

### T9 — Build+test+lint gate; security-checklist.

## YAGNI / risk
- KEEP approved-caps wall + connector approval (connectorId subject).
- KEEP Capabilities types in skills-parser, mcpConfigIds (TASK-107 deferred).
- Migration row count ~0 in fresh deploys but must be correct + idempotent.
