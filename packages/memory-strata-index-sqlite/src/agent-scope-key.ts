import { createHash } from 'node:crypto';

/**
 * Per-agent scope key for the memory index (TASK-186).
 *
 * The `memory:index:*` store is a SINGLE shared table across every agent in a
 * deployment (one sqlite db / one postgres table). Keying rows only by docId
 * pooled every agent's facts together — agent A's `memory_search` could return
 * agent B's. We scope every row by this key, derived from the calling agent's
 * context, so the store is partitioned per (userId, agentId).
 *
 * Derivation mirrors `@ax/workspace-git-server`'s `workspaceIdFor` — the same
 * `sha256(JSON.stringify([userId, agentId]))` the per-agent `/agent` git tier
 * uses to isolate repos — so the index partition lines up with the file-tier
 * partition. We can't import that helper (Invariant 2: no cross-plugin
 * imports), so each index backend carries its own copy (like `MAX_TOP_K`);
 * drift is caught by the shared `runIndexContract` isolation case.
 *
 * `JSON.stringify([userId, agentId])` is the unambiguous encoding: the array
 * brackets + quote-escaping mean distinct (userId, agentId) pairs can never
 * collide regardless of separator-shaped characters in either field. We never
 * store the raw userId/agentId — only this opaque digest — so no tenant
 * identity leaks into the storage layer.
 */
export function agentScopeKey(ctx: { userId: string; agentId: string }): string {
  const keyMaterial = JSON.stringify([ctx.userId, ctx.agentId]);
  return createHash('sha256').update(keyMaterial).digest('hex').slice(0, 16);
}
