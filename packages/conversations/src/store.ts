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

function rowToConversation(row: ConversationsRow): Conversation {
  return {
    conversationId: row.conversation_id,
    userId: row.user_id,
    agentId: row.agent_id,
    title: row.title,
    activeSessionId: row.active_session_id,
    activeReqId: row.active_req_id,
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
  /** Multi-row reads always go through scopedConversations(). */
  listForUser(userId: string, agentId?: string): Promise<Conversation[]>;
  /** Read all turns for a conversation in turn_index order. */
  listTurns(conversationId: string): Promise<Turn[]>;
  create(args: ConversationStoreCreateArgs): Promise<Conversation>;
  appendTurn(args: ConversationStoreAppendTurnArgs): Promise<Turn>;
  /** Soft delete — sets deleted_at on the matching row. Idempotent: returns false on missing/already-deleted. */
  softDelete(conversationId: string): Promise<boolean>;
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
        await trx
          .selectFrom('conversations_v1_conversations')
          .select('conversation_id')
          .where('conversation_id', '=', conversationId)
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
  };
}

