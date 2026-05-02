/**
 * Derives a stable workspaceId from (userId, agentId).
 *
 * Output shape: `ws-` + first 16 hex chars of
 * sha256(JSON.stringify([userId, agentId])).
 * Length 19, lowercase hex, always satisfies WORKSPACE_ID_REGEX
 * (`^[a-z0-9][a-z0-9_-]{0,62}$`) — starts with `w`, only `[a-z0-9-]`.
 *
 * Stability is load-bearing. Changing this derivation post-deploy would
 * orphan every existing workspace's bare repo on the storage tier shards
 * (a workspace's shard is computed from its workspaceId, so a different
 * workspaceId points at a different shard with no repo there). The
 * pinned-output tests in `__tests__/workspace-id.test.ts` exist to catch
 * unintentional drift across SHA-256 implementation or formatting changes.
 *
 * Encoding via `JSON.stringify([userId, agentId])` makes the separation
 * unambiguous — distinct `(userId, agentId)` pairs cannot collide regardless
 * of separator-shaped characters in either field. (The earlier
 * `userId + '/' + agentId` derivation collided pairs like
 * `(a, b/c)` and `(a/b, c)` to the same hash; both came from authenticated
 * sessions so the collision wasn't exploitable, but defense-in-depth is
 * cheap and the JSON encoding is well-understood.)
 */
import { createHash } from 'node:crypto';

export function workspaceIdFor(ctx: { userId: string; agentId: string }): string {
  // JSON.stringify of a 2-element array is the unambiguous encoding here:
  // the array brackets and quote-escaping ensure the two fields can't bleed
  // into each other no matter what characters they contain.
  const keyMaterial = JSON.stringify([ctx.userId, ctx.agentId]);
  const h = createHash('sha256').update(keyMaterial).digest('hex');
  return `ws-${h.slice(0, 16)}`;
}
