/**
 * Derives a stable workspaceId from (userId, agentId).
 *
 * Output shape: `ws-` + first 16 hex chars of sha256(userId + '/' + agentId).
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
 * Concatenation uses `/` as a separator. There is a known and acceptable
 * collision shape: pairs whose userId+'/'+agentId concatenation is
 * identical hash to identical values. For example, (userId='a',
 * agentId='b/c') and (userId='a/b', agentId='c') both hash 'a/b/c'. This
 * is acceptable because both userId and agentId come from authenticated
 * sessions where a malicious user can't choose a userId to collide with
 * someone else's (userId, agentId).
 */
import { createHash } from 'node:crypto';

export function workspaceIdFor(ctx: { userId: string; agentId: string }): string {
  const h = createHash('sha256')
    .update(ctx.userId)
    .update('/')
    .update(ctx.agentId)
    .digest('hex');
  return `ws-${h.slice(0, 16)}`;
}
