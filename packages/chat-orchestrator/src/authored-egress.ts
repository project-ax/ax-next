import { skillCredentialEnvName } from './credential-namespace.js';

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
 * TASK-86 — credential slots are keyed PER-SKILL in the host-side credential map
 * by `skill:<id>:<slot>` (the same namespace the catalog loop uses). Two skills
 * declaring the SAME bare slot name (e.g. both `LINEAR_API_KEY`) therefore get
 * two distinct keys → two distinct proxy placeholders → they COEXIST instead of
 * the old fatal `skill-slot-collision` lockout. The bare env-var name the skill
 * actually reads is restored later by `projectEnvMapToBareNames` (the proxy
 * substitution is value-based, so the env-var NAME is only a placeholder
 * vehicle).
 *
 * SECURITY: a skill must never hijack a TRUSTED credential (an agent default).
 * Because skill slots are namespaced, they CAN'T overwrite the trusted bare key
 * in `baseCreds`; and the env projection makes the trusted bare name win the
 * sandbox env stamp. So the old guarantee holds as a benign no-op suppression
 * rather than a fatal terminate — there is no longer a collision to return.
 *
 * Mutates `baseAllowSet` / `baseCreds` / `slotOwners` in place (same objects the
 * catalog loop built). `slotOwners` is now keyed by the NAMESPACED env name, the
 * same key as `baseCreds`. Registry hosts for approved packages need no handling
 * here — the orchestrator's registry auto-allow loop already iterates the
 * authored skills.
 */
// Intentionally captures ONLY the fields the egress fold needs (allowed hosts +
// credential slots). `mcpServers` and `packages` are deliberately omitted —
// package registry hosts are handled by the orchestrator's registry auto-allow
// loop, and MCP approval is deferred (fail-closed) — neither flows through here.
export interface AuthoredCapsLike {
  id: string;
  capabilities: {
    allowedHosts: string[];
    credentials: Array<{ slot: string; kind: string; account?: string }>;
  };
}

export function foldAuthoredSkillCaps(
  authored: AuthoredCapsLike[],
  baseAllowSet: Set<string>,
  baseCreds: Record<string, { ref: string; kind: string }>,
  slotOwners: Map<string, string>,
): void {
  for (const s of authored) {
    for (const host of s.capabilities.allowedHosts) baseAllowSet.add(host);
    for (const slotDef of s.capabilities.credentials) {
      const envName = skillCredentialEnvName(s.id, slotDef.slot);
      // Idempotent: a single skill declaring the same slot twice is a no-op. Two
      // DIFFERENT skills can never collide here — the key carries the skill id.
      if (slotOwners.has(envName)) continue;
      const ref =
        slotDef.account !== undefined
          ? `account:${slotDef.account}`
          : `skill:${s.id}:${slotDef.slot}`;
      baseCreds[envName] = { ref, kind: slotDef.kind };
      slotOwners.set(envName, s.id);
    }
  }
}
