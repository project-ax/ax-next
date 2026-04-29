import { randomBytes } from 'node:crypto';
import { PluginError } from '@ax/core';
import { ContentBlockSchema, type ContentBlock } from '@ax/ipc-protocol';
import { z } from 'zod';
import type { Kysely } from 'kysely';
import type {
  ConversationDatabase,
  ConversationsRow,
  TurnsRow,
} from './migrations.js';
import { scopedConversations } from './scope.js';
import type {
  Conversation,
  Turn,
  TurnRole,
} from './types.js';

// Array-of-blocks parser — used at every store ingress AND egress (we don't
// trust the JSONB column blindly; the same canonical schema validates on
// both sides of the DB boundary).
const ContentBlockArraySchema = z.array(ContentBlockSchema);

const PLUGIN_NAME = '@ax/conversations';

// ---------------------------------------------------------------------------
// Validation helpers — caller-supplied strings are bounded BEFORE INSERT.
// The DB has a CHECK on role; everything else is enforced here because
// length limits don't translate cleanly to SQL.
// ---------------------------------------------------------------------------

const TITLE_MAX = 256;
const VALID_ROLES: ReadonlySet<TurnRole> = new Set([
  'user',
  'assistant',
  'tool',
]);

function invalid(message: string): PluginError {
  return new PluginError({
    code: 'invalid-payload',
    plugin: PLUGIN_NAME,
    message,
  });
}

export function validateTitle(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw invalid('title must be a string or null');
  }
  if (value.length === 0 || value.length > TITLE_MAX) {
    throw invalid(`title must be 1-${TITLE_MAX} chars`);
  }
  return value;
}

export function validateRole(value: unknown): TurnRole {
  if (typeof value !== 'string' || !VALID_ROLES.has(value as TurnRole)) {
    throw invalid("role must be 'user', 'assistant', or 'tool'");
  }
  return value as TurnRole;
}

export function validateContentBlocks(value: unknown): ContentBlock[] {
  // Canonical Anthropic-compatible schema lives in @ax/ipc-protocol; this
  // is the single source of truth for both the IPC wire and our JSONB
  // column (Invariant I4).
  const parsed = ContentBlockArraySchema.safeParse(value);
  if (!parsed.success) {
    throw invalid(
      `contentBlocks must be an array of ContentBlock objects: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// ID minting — `crypto.randomBytes`-derived prefixed ids, mirroring the
// `agt_` / `usr_` posture in @ax/agents and @ax/auth-oidc.
// ---------------------------------------------------------------------------

export function mintConversationId(): string {
  return `cnv_${randomBytes(16).toString('base64url')}`;
}

export function mintTurnId(): string {
  return `trn_${randomBytes(16).toString('base64url')}`;
}

// ---------------------------------------------------------------------------
// Row → domain mapping. Defensive — JSONB columns return parsed JS values
// from `pg`'s default casts; we narrow them before exposing.
// ---------------------------------------------------------------------------

export function rowToConversation(row: ConversationsRow): Conversation {
  return {
    conversationId: row.conversation_id,
    userId: row.user_id,
    agentId: row.agent_id,
    title: row.title,
    activeSessionId: row.active_session_id,
    activeReqId: row.active_req_id,
    runnerType: row.runner_type,
    runnerSessionId: row.runner_session_id,
    workspaceRef: row.workspace_ref,
    lastActivityAt:
      row.last_activity_at === null ? null : row.last_activity_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function rowToTurn(row: TurnsRow): Turn {
  // We don't trust the DB blindly — JSONB columns can drift across schema
  // changes, replication hiccups, manual SQL, or future migrations. The
  // canonical ContentBlockSchema validates on read AND write so the type
  // promise we make to consumers stays honest.
  const parsedBlocks = ContentBlockArraySchema.safeParse(row.content_blocks);
  if (!parsedBlocks.success) {
    throw new PluginError({
      code: 'corrupt-row',
      plugin: PLUGIN_NAME,
      message: `conversations_v1_turns.${row.turn_id} has invalid content_blocks JSONB: ${parsedBlocks.error.message}`,
    });
  }
  if (
    row.role !== 'user' &&
    row.role !== 'assistant' &&
    row.role !== 'tool'
  ) {
    throw new PluginError({
      code: 'corrupt-row',
      plugin: PLUGIN_NAME,
      message: `conversations_v1_turns.${row.turn_id} has invalid role`,
    });
  }
  return {
    turnId: row.turn_id,
    turnIndex: row.turn_index,
    role: row.role,
    contentBlocks: parsedBlocks.data,
    createdAt: row.created_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Store API. The plugin's hook handlers call into this; the lint rule
// `local/no-bare-tenant-tables` enforces that bare `selectFrom` against
// `conversations_v1_*` only happens inside this file (or scope.ts /
// tests).
// ---------------------------------------------------------------------------

export interface ConversationStoreCreateArgs {
  userId: string;
  agentId: string;
  title: string | null;
}

export interface ConversationStoreAppendTurnArgs {
  conversationId: string;
  role: TurnRole;
  contentBlocks: ContentBlock[];
}

export interface ConversationStore {
  /** Single-row lookup; skips tombstones. Used in hook handlers after agents:resolve. */
  getByIdNotDeleted(conversationId: string): Promise<Conversation | null>;
  /**
   * Lookup a non-tombstoned conversation by `(user_id, active_req_id)`.
   * Returns null if no row matches OR the row is tombstoned. Used by the
   * `conversations:get-by-req-id` hook (Week 10–12 Task 7, Invariant J9).
   */
  getByReqIdForUser(
    userId: string,
    reqId: string,
  ): Promise<Conversation | null>;
  /** Multi-row reads always go through scopedConversations(). */
  listForUser(userId: string, agentId?: string): Promise<Conversation[]>;
  /** Read all turns for a conversation in turn_index order. */
  listTurns(conversationId: string): Promise<Turn[]>;
  create(args: ConversationStoreCreateArgs): Promise<Conversation>;
  appendTurn(args: ConversationStoreAppendTurnArgs): Promise<Turn>;
  /** Soft delete — sets deleted_at on the matching row. Idempotent: returns false on missing/already-deleted. */
  softDelete(conversationId: string): Promise<boolean>;
  /**
   * Set `active_session_id` + `active_req_id` atomically on the row
   * matching `(conversationId, userId)`. Returns true if a non-tombstoned
   * row was updated, false otherwise (including foreign-user rows). The
   * plugin-level handler turns false into PluginError('not-found') (J6).
   */
  setActiveSession(args: {
    conversationId: string;
    userId: string;
    sessionId: string;
    reqId: string;
  }): Promise<boolean>;
  /**
   * Clear `active_session_id` + `active_req_id` on the row matching
   * `(conversationId, userId)`. Returns true if a non-tombstoned row was
   * updated, false otherwise.
   */
  clearActiveSession(args: {
    conversationId: string;
    userId: string;
  }): Promise<boolean>;
  /**
   * Compare-and-clear `active_req_id` on the row matching `conversationId`
   * IFF the current `active_req_id` equals `expectedReqId`. Used by the
   * `chat:turn-end` subscriber so a stale callback (turn-end for r1
   * arrives after a fresh r2 has been bound) does NOT clobber the
   * newer in-flight reqId. `active_session_id` is left untouched (J6:
   * the sandbox stays alive for the next user message).
   *
   * Returns true if a row was updated, false otherwise (mismatched
   * reqId, tombstoned, or already null).
   */
  clearActiveReqId(
    conversationId: string,
    expectedReqId: string,
  ): Promise<boolean>;
  /**
   * Host-internal: clear `active_session_id` + `active_req_id` on EVERY
   * conversation bound to `sessionId`. Triggered by the `session:terminate`
   * subscriber — there's no userId scope because the host is observing
   * a sandbox teardown, not acting on behalf of a tenant. By J6 / I4 the
   * "many conversations bound to one sessionId" case shouldn't normally
   * happen, but a defensive multi-row clear is correct: if the session is
   * gone, no conversation may keep an active_req_id pointing at it.
   *
   * Returns the number of rows updated (0+).
   */
  clearBySessionId(sessionId: string): Promise<number>;
}

export function createConversationStore(
  db: Kysely<ConversationDatabase>,
): ConversationStore {
  return {
    async getByIdNotDeleted(conversationId) {
      const row = await db
        .selectFrom('conversations_v1_conversations')
        .selectAll('conversations_v1_conversations')
        .where('conversation_id', '=', conversationId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      return row === undefined ? null : rowToConversation(row);
    },

    async getByReqIdForUser(userId, reqId) {
      // Filter by user_id FIRST so a foreign reqId can't trigger a row
      // existence oracle: every miss is identical to "no such row" from
      // the caller's perspective. The conversations_v1_conversations_owner
      // index covers (user_id, agent_id) — adding active_req_id to the
      // WHERE clause is still cheap because user_id alone narrows to a
      // single user's rowset.
      const row = await db
        .selectFrom('conversations_v1_conversations')
        .selectAll('conversations_v1_conversations')
        .where('user_id', '=', userId)
        .where('active_req_id', '=', reqId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      return row === undefined ? null : rowToConversation(row);
    },

    async listForUser(userId, agentId) {
      let q = scopedConversations(db, { userId }).orderBy('created_at', 'desc');
      if (agentId !== undefined) {
        q = q.where('agent_id', '=', agentId);
      }
      const rows = await q.execute();
      return rows.map(rowToConversation);
    },

    async listTurns(conversationId) {
      const rows = await db
        .selectFrom('conversations_v1_turns')
        .selectAll('conversations_v1_turns')
        .where('conversation_id', '=', conversationId)
        .orderBy('turn_index', 'asc')
        .execute();
      return rows.map(rowToTurn);
    },

    async create({ userId, agentId, title }) {
      const id = mintConversationId();
      const now = new Date();
      const row = await db
        .insertInto('conversations_v1_conversations')
        .values({
          conversation_id: id,
          user_id: userId,
          agent_id: agentId,
          title,
          active_session_id: null,
          active_req_id: null,
          deleted_at: null,
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return rowToConversation(row as ConversationsRow);
    },

    async appendTurn({ conversationId, role, contentBlocks }) {
      // Compute turn_index inside a transaction with row-level locking on
      // the conversation row. Concurrent inserts on the same conversation
      // serialize through SELECT ... FOR UPDATE, so the UNIQUE(
      // conversation_id, turn_index) constraint can never trip — the
      // index lookup, mint, and insert all happen under the lock.
      return await db.transaction().execute(async (trx) => {
        // Lock the conversation row to serialize appendTurn calls for
        // this conversation. Reading + write happen inside the same tx
        // so isolation is consistent.
        //
        // The `deleted_at IS NULL` filter closes a TOCTOU window: a
        // concurrent softDelete landing between the plugin's pre-check
        // (`getByIdNotDeleted`) and the FOR UPDATE acquisition would
        // otherwise let turns slip into a tombstoned conversation.
        // executeTakeFirstOrThrow → NoResultError surfaces as a
        // PluginError('not-found') in the plugin layer.
        await trx
          .selectFrom('conversations_v1_conversations')
          .select('conversation_id')
          .where('conversation_id', '=', conversationId)
          .where('deleted_at', 'is', null)
          .forUpdate()
          .executeTakeFirstOrThrow();

        const lastRow = await trx
          .selectFrom('conversations_v1_turns')
          .select('turn_index')
          .where('conversation_id', '=', conversationId)
          .orderBy('turn_index', 'desc')
          .limit(1)
          .executeTakeFirst();
        const nextIndex = lastRow === undefined ? 0 : lastRow.turn_index + 1;

        const id = mintTurnId();
        const now = new Date();
        const row = await trx
          .insertInto('conversations_v1_turns')
          .values({
            turn_id: id,
            conversation_id: conversationId,
            turn_index: nextIndex,
            role,
            // Kysely's pg dialect serializes JSONB on the way down; pass
            // the array directly via JSON.stringify (matches @ax/agents
            // store pattern for allowed_tools).
            content_blocks: JSON.stringify(contentBlocks) as unknown,
            created_at: now,
          } as never)
          .returningAll()
          .executeTakeFirstOrThrow();

        // Touch updated_at on the parent row so list orderings stay
        // sensible. Stays inside the same tx.
        await trx
          .updateTable('conversations_v1_conversations')
          .set({ updated_at: now })
          .where('conversation_id', '=', conversationId)
          .execute();

        return rowToTurn(row as TurnsRow);
      });
    },

    async softDelete(conversationId) {
      const result = await db
        .updateTable('conversations_v1_conversations')
        .set({ deleted_at: new Date(), updated_at: new Date() })
        .where('conversation_id', '=', conversationId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0n) > 0;
    },

    async setActiveSession({ conversationId, userId, sessionId, reqId }) {
      // Filter by user_id alongside conversation_id so a foreign caller
      // can never bind a row they don't own. Non-existence + foreign-user
      // both look identical from the caller's perspective: numUpdatedRows
      // === 0 → 'not-found' at the plugin layer.
      const result = await db
        .updateTable('conversations_v1_conversations')
        .set({
          active_session_id: sessionId,
          active_req_id: reqId,
          updated_at: new Date(),
        })
        .where('conversation_id', '=', conversationId)
        .where('user_id', '=', userId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0n) > 0;
    },

    async clearActiveSession({ conversationId, userId }) {
      const result = await db
        .updateTable('conversations_v1_conversations')
        .set({
          active_session_id: null,
          active_req_id: null,
          updated_at: new Date(),
        })
        .where('conversation_id', '=', conversationId)
        .where('user_id', '=', userId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0n) > 0;
    },

    async clearActiveReqId(conversationId, expectedReqId) {
      // Compare-and-clear on `active_req_id`. If a fresh reqId has already
      // been bound (e.g. a second user message arrived between this turn-
      // end being fired and the subscriber running), the WHERE will miss
      // and the newer in-flight reqId is preserved. This is essential for
      // J6's "no stale clobber" property.
      const result = await db
        .updateTable('conversations_v1_conversations')
        .set({ active_req_id: null, updated_at: new Date() })
        .where('conversation_id', '=', conversationId)
        .where('active_req_id', '=', expectedReqId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0n) > 0;
    },

    async clearBySessionId(sessionId) {
      // No user_id filter — host-internal observation of a sandbox
      // teardown. We clear active_session_id AND active_req_id together
      // because if the session is gone, an in-flight reqId pointing at
      // it is dead too.
      const result = await db
        .updateTable('conversations_v1_conversations')
        .set({
          active_session_id: null,
          active_req_id: null,
          updated_at: new Date(),
        })
        .where('active_session_id', '=', sessionId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0n);
    },
  };
}

