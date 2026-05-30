/**
 * Upfront authored-skill approval card (Phase 4 PR-B, decisions D-B1/D-B2/D-B3).
 * Pure: turns a draft's UNAPPROVED shown delta (hosts/slots/packages; mcp
 * excluded — deferred) into the `kind:'skill'` card payload, and computes a
 * stable per-conversation dedup key over the shown delta.
 *
 * The card payload structurally mirrors channel-web's PermissionRequest `skill`
 * variant — NOT an import (invariant #2). `authored:true` drives the warning
 * banner; the SSE subscriber matches the frame by conversationId.
 */
export interface AuthoredDeltaLike {
  allowedHosts: string[];
  credentials: Array<{ slot: string; kind: string; account?: string }>;
  // Optional so callers can hand a ResolvedSkillForOrch-style delta straight in;
  // normalized to [] internally (see normPackages).
  packages?: { npm?: string[]; pypi?: string[] };
  mcpServers?: unknown[];
}

/** Normalize the optional packages field to dense {npm,pypi} arrays. */
function normPackages(delta: AuthoredDeltaLike): { npm: string[]; pypi: string[] } {
  return { npm: delta.packages?.npm ?? [], pypi: delta.packages?.pypi ?? [] };
}

/**
 * True iff the SHOWN delta is non-empty (hosts OR slots OR npm OR pypi; mcp
 * excluded — deferred). Single source of truth for "is there anything to card"
 * — shared by buildAuthoredCardPayload's null check and the orchestrator's
 * cold-start filter, so they can't diverge.
 */
export function hasShownDelta(delta: AuthoredDeltaLike): boolean {
  const { npm, pypi } = normPackages(delta);
  return (
    delta.allowedHosts.length > 0 ||
    delta.credentials.length > 0 ||
    npm.length > 0 ||
    pypi.length > 0
  );
}

export interface AuthoredSkillCard {
  kind: 'skill';
  skillId: string;
  description: string;
  hosts: string[];
  slots: Array<{ slot: string; kind: 'api-key'; account?: string; haveExisting?: boolean }>;
  authored: true;
  packages: { npm: string[]; pypi: string[] };
}

/** Build the card, or null if the shown delta is empty (incl. mcp-only). */
export function buildAuthoredCardPayload(
  args: { skillId: string; description: string; delta: AuthoredDeltaLike },
  vaultedRefs: Set<string>,
): AuthoredSkillCard | null {
  const { skillId, description, delta } = args;
  if (!hasShownDelta(delta)) {
    return null; // nothing the card can show/approve (mcp-only or empty)
  }
  const hosts = delta.allowedHosts;
  const slots = delta.credentials.map((c) => ({
    slot: c.slot,
    kind: 'api-key' as const,
    ...(c.account !== undefined ? { account: c.account } : {}),
    haveExisting: c.account !== undefined && vaultedRefs.has(`account:${c.account}`),
  }));
  return { kind: 'skill', skillId, description, hosts, slots, authored: true, packages: normPackages(delta) };
}

/** Stable dedup key over the SHOWN delta (mcp excluded). */
export function authoredCardDedupKey(skillId: string, delta: AuthoredDeltaLike): string {
  const { npm, pypi } = normPackages(delta);
  const canon = JSON.stringify({
    h: [...delta.allowedHosts].sort(),
    s: [...delta.credentials.map((c) => c.slot)].sort(),
    n: [...npm].sort(),
    p: [...pypi].sort(),
  });
  // The skillId-to-delta separator below is the JS escape \u0000 (NOT a literal
  // NUL byte). Safe because skillIds are charset [a-z0-9._-] and can never
  // contain NUL, so the prefix is unambiguous — two distinct (skillId, delta)
  // pairs can't collide on the joined key.
  return `${skillId}\u0000${canon}`;
}
