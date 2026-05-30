/**
 * Pure capability-set algebra for the self-authored skill projection (Phase 4).
 *
 * A self-authored draft declares its desired capabilities in SKILL.md
 * frontmatter — this is a PROPOSAL, never a grant. The host discovery
 * projection grants only `proposal ∩ approved`, where `approved` is the set of
 * capabilities a human approved at the wall (host-side store, outside the
 * agent's reach — invariant #5, no self-grant). The `delta = proposal −
 * approved` drives the upfront approval card (PR-B).
 *
 * `ApprovedCapEntry` is duplicated structurally here rather than imported from
 * @ax/skills — invariant #2 (no cross-plugin imports; the hook bus IS the API).
 * It mirrors @ax/skills' SkillsApprovedCapsListOutput entry shape.
 */
import type { CapabilitySlot, McpServerSpec, SkillCapabilities } from '@ax/skills-parser';
import { parseSkillManifest, buildSkillManifestYaml } from '@ax/skills-parser';

export type ApprovedCapKind = 'host' | 'slot' | 'npm' | 'pypi' | 'mcp';

export interface ApprovedCapEntry {
  kind: ApprovedCapKind;
  value: string;
}

/** A capabilities object that grants nothing — the safe projection default.
 * Deep-frozen: it is a shared singleton, so mutating it would corrupt every
 * caller. Build fresh arrays in consumers; never push into this. */
export const EMPTY_CAPABILITIES: SkillCapabilities = Object.freeze({
  allowedHosts: Object.freeze([]) as unknown as string[],
  credentials: Object.freeze([]) as unknown as CapabilitySlot[],
  mcpServers: Object.freeze([]) as unknown as McpServerSpec[],
  packages: Object.freeze({
    npm: Object.freeze([]) as unknown as string[],
    pypi: Object.freeze([]) as unknown as string[],
  }),
});

/**
 * Project ONE self-authored bundle: parse its frontmatter proposal, intersect
 * with the approved set, and rebuild a caps-stripped manifest. Pure (no I/O) —
 * the caller supplies `approved` (the real resolver fetches it from
 * skills:approved-caps-list; the CLI stub passes []). Returns null on an
 * unparseable manifest so the caller skips the draft (one bad draft must not
 * break discovery). The rebuilt manifest carries name+description+version only
 * (EMPTY capabilities) — frontmatter alone grants nothing.
 */
export function projectAuthoredBundle(
  manifestYaml: string,
  approved: ApprovedCapEntry[],
): {
  description: string;
  capabilities: SkillCapabilities;
  delta: SkillCapabilities;
  manifestYaml: string;
} | null {
  const parsed = parseSkillManifest(manifestYaml);
  if (!parsed.ok) return null;
  const { capabilities, delta } = intersectProposalWithApproved(
    parsed.value.capabilities,
    approved,
  );
  const stripped = buildSkillManifestYaml({
    id: parsed.value.id,
    description: parsed.value.description,
    version: parsed.value.version,
    capabilities: EMPTY_CAPABILITIES,
  });
  return { description: parsed.value.description, capabilities, delta, manifestYaml: stripped };
}

/**
 * Split a frontmatter proposal into the approved subset (projected into the
 * skill's live caps) and the unapproved delta (drives the approval card).
 * Matching is by identity key per kind: host string, slot NAME, package name,
 * MCP server NAME. The proposal is the source of each entry's detail (slot
 * kind/account, MCP spec) — `approved` only gates which entries pass.
 */
export function intersectProposalWithApproved(
  proposal: SkillCapabilities,
  approved: ApprovedCapEntry[],
): { capabilities: SkillCapabilities; delta: SkillCapabilities } {
  const has = (kind: ApprovedCapKind, value: string): boolean =>
    approved.some((e) => e.kind === kind && e.value === value);

  const capHosts: string[] = [];
  const deltaHosts: string[] = [];
  for (const h of proposal.allowedHosts) (has('host', h) ? capHosts : deltaHosts).push(h);

  const capCreds: CapabilitySlot[] = [];
  const deltaCreds: CapabilitySlot[] = [];
  for (const c of proposal.credentials) (has('slot', c.slot) ? capCreds : deltaCreds).push(c);

  const capNpm: string[] = [];
  const deltaNpm: string[] = [];
  for (const p of proposal.packages.npm) (has('npm', p) ? capNpm : deltaNpm).push(p);

  const capPypi: string[] = [];
  const deltaPypi: string[] = [];
  for (const p of proposal.packages.pypi) (has('pypi', p) ? capPypi : deltaPypi).push(p);

  const capMcp: McpServerSpec[] = [];
  const deltaMcp: McpServerSpec[] = [];
  for (const m of proposal.mcpServers) (has('mcp', m.name) ? capMcp : deltaMcp).push(m);

  return {
    capabilities: {
      allowedHosts: capHosts,
      credentials: capCreds,
      mcpServers: capMcp,
      packages: { npm: capNpm, pypi: capPypi },
    },
    delta: {
      allowedHosts: deltaHosts,
      credentials: deltaCreds,
      mcpServers: deltaMcp,
      packages: { npm: deltaNpm, pypi: deltaPypi },
    },
  };
}
