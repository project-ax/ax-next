/**
 * The hybrid materialization gate (TASK-74, design §D3). Pure function: given
 * the trust provenance, the declared capability proposal, and the safety-scan
 * verdict, classify a proposed skill into one of three materialization states.
 *
 *   clean scan  AND  origin = authored  AND  capabilityProposal = ∅
 *       → 'active'       (materialize freely next spawn, no human)
 *
 *   otherwise (any capability, OR origin ∈ {imported, attached})
 *       → 'pending'      (approve-before-materialize; nothing projects)
 *
 *   scan hit (any class)
 *       → 'quarantined'  (omit from projection; reason returned to the agent)
 *
 * The free path is deliberately the narrowest: self-authored instruction
 * scaffolding with zero reach. Anything with hosts/credentials/mcp/packages, or
 * anything pulled from outside, waits for a human; a scan hit is quarantined
 * regardless of provenance.
 */
import type { SkillCapabilities } from '@ax/skills-parser';
import type { AuthoredStatus, AuthoredOrigin } from './authored-store.js';

export function hasAnyCapability(caps: SkillCapabilities): boolean {
  return (
    caps.allowedHosts.length > 0 ||
    caps.credentials.length > 0 ||
    caps.mcpServers.length > 0 ||
    caps.packages.npm.length > 0 ||
    caps.packages.pypi.length > 0
  );
}

export function classifyProposal(args: {
  origin: AuthoredOrigin;
  capabilityProposal: SkillCapabilities;
  scanClean: boolean;
}): AuthoredStatus {
  if (!args.scanClean) return 'quarantined';
  if (args.origin === 'authored' && !hasAnyCapability(args.capabilityProposal)) {
    return 'active';
  }
  return 'pending';
}
