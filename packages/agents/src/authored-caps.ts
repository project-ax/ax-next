/**
 * Projection helper for the self-authored skill resolution (Phase 4, narrowed by
 * TASK-100).
 *
 * TASK-100 — a skill manifest no longer declares capabilities at all: its only
 * declared reach is the `connectors` it references (resolved into sandbox caps by
 * the orchestrator's skill→connector bridge). A model-authored skill is therefore
 * always zero-reach instruction scaffolding — there is no per-skill capability
 * proposal to intersect with an approved set, and no per-skill capability
 * approval card. A connector's reach is gated at `connectors:resolve` / the
 * connector approval card (the existing wall, connectorId subject — invariant #5,
 * no self-grant), so removing the skill-cap proposal does NOT widen reach.
 *
 * `ApprovedCapEntry` is duplicated structurally here rather than imported from
 * @ax/skills — invariant #2 (no cross-plugin imports; the hook bus IS the API).
 * It mirrors @ax/skills' SkillsApprovedCapsListOutput entry shape and is still
 * the wall's read shape for CONNECTOR grants.
 */
import { parseSkillManifest } from '@ax/skills-parser';

export type ApprovedCapKind = 'host' | 'slot' | 'npm' | 'pypi' | 'mcp';

export interface ApprovedCapEntry {
  kind: ApprovedCapKind;
  value: string;
}

/**
 * Project ONE self-authored bundle: parse its (cap-free) frontmatter and surface
 * its connector references. Pure (no I/O). Returns null on an unparseable
 * manifest so the caller skips the draft (one bad draft must not break
 * discovery). The manifest is returned verbatim — the parser already rejects any
 * capability block, so the materialized SKILL.md the SDK sees never carries one.
 */
export function projectAuthoredBundle(
  manifestYaml: string,
): {
  description: string;
  connectors: string[];
  manifestYaml: string;
} | null {
  const parsed = parseSkillManifest(manifestYaml);
  if (!parsed.ok) return null;
  return {
    description: parsed.value.description,
    connectors: parsed.value.connectors,
    manifestYaml,
  };
}
