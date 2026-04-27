import type { Kysely } from 'kysely';
import type { ConversationDatabase } from './migrations.js';

/**
 * Tenant-scoping helper (Invariant I7).
 *
 * Every multi-row read of `conversations_v1_conversations` MUST go
 * through this helper. The lint rule `local/no-bare-tenant-tables`
 * enforces that bare `db.selectFrom('conversations_v1_*')` only appears
 * in `store.ts` / `scope.ts` / test files.
 *
 * Returns a Kysely query builder pre-filtered to:
 *   - rows owned by `scope.userId` (user_id matches),
 *   - non-tombstoned rows (deleted_at IS NULL).
 *
 * Why a builder rather than `executeAll(...)`: callers need to chain
 * `.orderBy`, `.limit`, `.where('agent_id', '=', …)` etc. without
 * dragging unscoped query builders past the helper.
 *
 * Per-conversation reads (`getByIdNotDeleted`) are allowed to query
 * directly in `store.ts` because they're inside the file the lint rule
 * trusts AND because the plugin's hook handler ALWAYS calls
 * `agents:resolve` first with the row's `agent_id` (i.e. ACL is gated
 * on the agent, not just user_id).
 */
export interface ConversationScope {
  userId: string;
}

export function scopedConversations(
  db: Kysely<ConversationDatabase>,
  scope: ConversationScope,
) {
  return db
    .selectFrom('conversations_v1_conversations')
    .selectAll('conversations_v1_conversations')
    .where('user_id', '=', scope.userId)
    .where('deleted_at', 'is', null);
}
