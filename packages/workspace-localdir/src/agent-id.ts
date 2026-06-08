// ---------------------------------------------------------------------------
// agentId validation — the per-tenant subtree key.
//
// The resolved mount confines an agent to `<root>/<agentId>` (its own subtree).
// `agentId` reaches a `path.join` (here) and a host `subPath` (the NFS sibling
// plugin), so it MUST be validated before it's used as a path segment — a `..`
// or `/` segment would escape the per-agent subtree (design §9, defense in
// depth). The contract is `^[a-z0-9-]+$`: lowercase alnum + dashes, non-empty.
// An empty/absent agentId is NOT an error — it means "anonymous, no durable
// mount" — so callers treat a falsy/invalid id as "no mount", not a throw.
//
// Kept as this plugin's OWN copy (invariant I2 — no cross-plugin imports); the
// NFS sibling holds an identical, independent copy. Structural duplication is
// the boundary cost; a drift would surface as a test failure, not a silent
// security gap.
// ---------------------------------------------------------------------------

const AGENT_ID_RE = /^[a-z0-9-]+$/;

/**
 * True iff `agentId` is a safe per-tenant subtree key (`^[a-z0-9-]+$`).
 * Rejects empty strings, uppercase, dots, slashes, and traversal segments.
 */
export function isValidAgentId(agentId: string | undefined): agentId is string {
  return typeof agentId === 'string' && AGENT_ID_RE.test(agentId);
}
