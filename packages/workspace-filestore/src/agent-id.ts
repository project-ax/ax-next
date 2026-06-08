// ---------------------------------------------------------------------------
// agentId validation — the per-tenant subtree key (NFS `subPath`).
//
// The resolved NFS mount confines an agent to the `subPath=<agentId>` subtree
// within the shared export — other agents' subtrees are not even mounted
// (design §9). `agentId` becomes the `subPath`, so it MUST be validated before
// it's used as a path segment — a `..` or `/` segment would otherwise widen the
// mount past the agent's own subtree.
//
// The contract is `^[A-Za-z0-9_-]+$`: the base64url alphabet (alnum + `-` + `_`),
// non-empty. This matches how real ids are minted — `agt_${randomBytes(16)
// .toString('base64url')}` (see `@ax/agents`), which always contains `_` and
// usually uppercase. The original `^[a-z0-9-]+$` rejected every real agent and
// left the whole user-files mount inert (TASK-175). The base64url alphabet has
// no `/`, no `.`, and no whitespace, so a single segment stays traversal-safe:
// `..`, `/`, absolute paths, and the empty string are still rejected — the
// defense-in-depth boundary is preserved.
//
// An empty/absent agentId is NOT an error — it means "anonymous, no durable
// mount" — so callers treat a falsy/invalid id as "no mount", not a throw.
//
// Kept as this plugin's OWN copy (invariant I2 — no cross-plugin imports); the
// localDir sibling holds an identical, independent copy.
// ---------------------------------------------------------------------------

const AGENT_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * True iff `agentId` is a safe per-tenant subtree key (`^[A-Za-z0-9_-]+$` — the
 * base64url alphabet). Accepts real minted ids like `agt_<base64url>`; rejects
 * empty strings, dots, slashes, whitespace, and traversal segments.
 */
export function isValidAgentId(agentId: string | undefined): agentId is string {
  return typeof agentId === 'string' && AGENT_ID_RE.test(agentId);
}
