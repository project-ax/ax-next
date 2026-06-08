// ---------------------------------------------------------------------------
// agentId validation — the per-tenant subtree key (NFS `subPath`).
//
// The resolved NFS mount confines an agent to the `subPath=<agentId>` subtree
// within the shared export — other agents' subtrees are not even mounted
// (design §9). `agentId` becomes the `subPath`, so it MUST be validated before
// it's used as a path segment — a `..` or `/` segment would otherwise widen the
// mount past the agent's own subtree. The contract is `^[a-z0-9-]+$`: lowercase
// alnum + dashes, non-empty. An empty/absent agentId is NOT an error — it means
// "anonymous, no durable mount" — so callers treat a falsy/invalid id as "no
// mount", not a throw.
//
// Kept as this plugin's OWN copy (invariant I2 — no cross-plugin imports); the
// localDir sibling holds an identical, independent copy.
// ---------------------------------------------------------------------------

const AGENT_ID_RE = /^[a-z0-9-]+$/;

/**
 * True iff `agentId` is a safe per-tenant subtree key (`^[a-z0-9-]+$`).
 * Rejects empty strings, uppercase, dots, slashes, and traversal segments.
 */
export function isValidAgentId(agentId: string | undefined): agentId is string {
  return typeof agentId === 'string' && AGENT_ID_RE.test(agentId);
}
