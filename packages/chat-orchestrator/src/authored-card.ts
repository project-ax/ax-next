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
  packages: { npm: string[]; pypi: string[] };
  mcpServers?: unknown[];
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
  const hosts = delta.allowedHosts;
  const slots = delta.credentials.map((c) => ({
    slot: c.slot,
    kind: 'api-key' as const,
    ...(c.account !== undefined ? { account: c.account } : {}),
    haveExisting: c.account !== undefined && vaultedRefs.has(`account:${c.account}`),
  }));
  const npm = delta.packages.npm;
  const pypi = delta.packages.pypi;
  if (hosts.length === 0 && slots.length === 0 && npm.length === 0 && pypi.length === 0) {
    return null; // nothing the card can show/approve (mcp-only or empty)
  }
  return { kind: 'skill', skillId, description, hosts, slots, authored: true, packages: { npm, pypi } };
}

/** Stable dedup key over the SHOWN delta (mcp excluded). */
export function authoredCardDedupKey(skillId: string, delta: AuthoredDeltaLike): string {
  const canon = JSON.stringify({
    h: [...delta.allowedHosts].sort(),
    s: [...delta.credentials.map((c) => c.slot)].sort(),
    n: [...delta.packages.npm].sort(),
    p: [...delta.packages.pypi].sort(),
  });
  return `${skillId}\u0000${canon}`;
}
