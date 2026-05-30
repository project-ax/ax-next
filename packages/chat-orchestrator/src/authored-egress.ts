/**
 * PC-1 — fold an APPROVED self-authored skill's capabilities into the session's
 * base egress allowlist + credential map (Phase 4 PR-B). The projection
 * (agents:resolve-authored-skills) already filtered these to proposal ∩ approved,
 * so everything here is human-approved. Without this fold an approved authored
 * host projects into the skill's caps yet the proxy still blocks it
 * ("approved but unreachable").
 *
 * Credential refs are derived the SAME way the approval card wrote them and the
 * catalog grant binds them: an account-tagged slot → the shared `account:<svc>`
 * vault entry; an untagged slot → the per-skill `skill:<id>:<slot>` ref. So the
 * stored key and this binding always address the same row.
 *
 * SECURITY: an untrusted draft must never hijack a slot already owned by a
 * trusted source (an agent default or a catalog attachment). On the first such
 * collision we STOP and return it — the caller turns it into a fatal terminate
 * with a clear reason (mirrors the catalog attachment loop). We never override
 * the trusted binding.
 *
 * Mutates `baseAllowSet` / `baseCreds` / `slotOwners` in place (same objects the
 * catalog loop built). Registry hosts for approved packages need no handling
 * here — the orchestrator's registry auto-allow loop already iterates the
 * authored skills.
 */
export interface AuthoredCapsLike {
  id: string;
  capabilities: {
    allowedHosts: string[];
    credentials: Array<{ slot: string; kind: string; account?: string }>;
  };
}

export interface FoldCollision {
  slot: string;
  existingOwner: string;
  skillId: string;
}

export function foldAuthoredSkillCaps(
  authored: AuthoredCapsLike[],
  baseAllowSet: Set<string>,
  baseCreds: Record<string, { ref: string; kind: string }>,
  slotOwners: Map<string, string>,
): FoldCollision | null {
  for (const s of authored) {
    for (const host of s.capabilities.allowedHosts) baseAllowSet.add(host);
    for (const slotDef of s.capabilities.credentials) {
      if (slotOwners.has(slotDef.slot)) {
        return { slot: slotDef.slot, existingOwner: slotOwners.get(slotDef.slot)!, skillId: s.id };
      }
      const ref =
        slotDef.account !== undefined
          ? `account:${slotDef.account}`
          : `skill:${s.id}:${slotDef.slot}`;
      baseCreds[slotDef.slot] = { ref, kind: slotDef.kind };
      slotOwners.set(slotDef.slot, s.id);
    }
  }
  return null;
}
