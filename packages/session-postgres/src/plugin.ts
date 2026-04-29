import { createLogger, PluginError, type Logger, type Plugin } from '@ax/core';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import {
  createInbox,
  type ClaimResult,
  type Inbox,
  type InboxEntry,
} from './inbox.js';
import { runSessionMigration, type SessionDatabase } from './migrations.js';
import {
  createSessionStore,
  OWNER_MISSING,
  UNKNOWN_SESSION,
  type AgentConfig,
  type SessionStore,
} from './store.js';

// ---------------------------------------------------------------------------
// @ax/session-postgres
//
// Postgres-backed peer of @ax/session-inmemory. Same five service hooks,
// same observable contract — only the storage differs.
//
// Why this plugin takes its own connectionString instead of reaching the
// shared pool via `database:get-instance`:
//
//   LISTEN/NOTIFY needs a dedicated client held open for the lifetime of
//   the subscription. A pooled connection can be returned to its idle set
//   mid-listen, breaking the binding. So we open both a pg.Pool (for
//   queries) and a pg.Client (for LISTEN) directly, side-by-side, against
//   the same connectionString. The eventbus-postgres plugin set this
//   precedent — we follow it intentionally for the same reason.
//
//   This is an INTENTIONAL bypass of the database hook. Any postgres
//   plugin that needs LISTEN follows the same shape.
//
// Hook contract: identical to @ax/session-inmemory. The contract tests
// in `src/__tests__/plugin.test.ts` exercise the same surface; if both
// plugins ever drift, those tests are the canary.
//
// Cross-replica wakeup: `session:queue-work` fires `pg_notify` on a
// per-session channel; `session:claim-work` blocks on LISTEN of the same
// channel. So a queue on instance A wakes a claim on instance B against
// the same database.
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/session-postgres';

export interface SessionPostgresConfig {
  connectionString: string;
  poolMax?: number;
  /**
   * Optional logger for background events that don't ride a request — pg.Pool
   * idle errors, LISTEN client socket errors, init failure cleanup. Defaults
   * to a stdout JSON logger tagged `reqId=session-postgres-bg`. Tests can
   * pass a noop or recording logger.
   */
  logger?: Logger;
}

// Same input/output shapes as session-inmemory — kept here as locally
// declared interfaces rather than imported across the plugin boundary
// (Invariant 2: no cross-plugin imports). The contract is the bus shape;
// type duplication is fine.
export interface SessionCreateInput {
  sessionId: string;
  workspaceRoot: string;
  /**
   * Owner triple. Required for sessions minted via the Week-9.5
   * orchestrator path; pre-9.5 callers MAY omit it, in which case the
   * v2 row is not written and `session:get-config` will reject with
   * `owner-missing`.
   *
   * Week 10–12 Task 15: optional `conversationId` ties this session to a
   * persisted conversation row; the runner reads it back via
   * `session:get-config` and uses non-null as the trigger to call
   * `conversation.fetch-history`. Null/undefined for non-conversation
   * sessions.
   */
  owner?: {
    userId: string;
    agentId: string;
    agentConfig: AgentConfig;
    conversationId?: string | null;
  };
}
export interface SessionCreateOutput {
  sessionId: string;
  token: string;
}
export interface SessionResolveTokenInput {
  token: string;
}
export type SessionResolveTokenOutput =
  | {
      sessionId: string;
      workspaceRoot: string;
      userId: string | null;
      agentId: string | null;
      /**
       * Conversation this session is bound to (Task 15). Null for canary /
       * admin sessions or for any session minted before Task 15. Used by
       * the IPC server to stamp ctx.conversationId on every per-request
       * AgentContext so runner-fired `chat:turn-end` subscribers see the
       * binding (auto-append, clearActiveReqId, SSE done-frame).
       */
      conversationId: string | null;
    }
  | null;
export type SessionGetConfigInput = Record<string, never>;
export interface SessionGetConfigOutput {
  userId: string;
  agentId: string;
  agentConfig: AgentConfig;
  /**
   * Conversation this session is bound to (Week 10–12 Task 15). Null for
   * non-conversation sessions; the runner uses non-null as the trigger
   * to call `conversation.fetch-history` at boot.
   */
  conversationId: string | null;
}
export interface SessionQueueWorkInput {
  sessionId: string;
  entry: InboxEntry;
}
export interface SessionQueueWorkOutput {
  cursor: number;
}
export interface SessionClaimWorkInput {
  sessionId: string;
  cursor: number;
  timeoutMs: number;
}
export type SessionClaimWorkOutput = ClaimResult;
export interface SessionTerminateInput {
  sessionId: string;
}
export type SessionTerminateOutput = Record<string, never>;

// ---------------------------------------------------------------------------
// session:is-alive — host-internal liveness probe (Week 10–12 Task 16, J6).
// True iff the row exists AND `terminated = false`. Nonexistent sessionIds
// return `{ alive: false }` rather than throwing — see session-inmemory's
// twin handler for rationale.
// ---------------------------------------------------------------------------
export interface SessionIsAliveInput {
  sessionId: string;
}
export interface SessionIsAliveOutput {
  alive: boolean;
}

function requireString(
  value: unknown,
  field: string,
  hookName: string,
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName,
      message: `'${field}' must be a non-empty string`,
    });
  }
}

function requireNonNegativeInt(
  value: unknown,
  field: string,
  hookName: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName,
      message: `'${field}' must be a non-negative integer`,
    });
  }
}

// AgentMessage.role narrowed to 'user' | 'assistant' in Phase 7 — must stay
// in lockstep with @ax/core's AgentMessage type and @ax/ipc-protocol's
// AgentMessageSchema. This is a trust-boundary check: the IPC server feeds
// untrusted wire payloads through `session:queue-work`, and a divergence
// here would create a second source of truth for what 'valid role' means.
const VALID_ROLES = new Set(['user', 'assistant']);

// ---------------------------------------------------------------------------
// validateOwner — runs at session:create time on the optional `owner`
// field. We require the full triple (no half-set owners) because a
// session that's "kind of" owned is exactly the bug I10 is meant to
// prevent. Mirrors @ax/session-inmemory's validateOwner so the two
// backends reject identical inputs identically.
// ---------------------------------------------------------------------------
function validateOwner(
  raw: unknown,
  hookName: string,
):
  | {
      userId: string;
      agentId: string;
      agentConfig: AgentConfig;
      conversationId: string | null;
    }
  | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName,
      message: `'owner' must be an object when present`,
    });
  }
  const userId = (raw as { userId?: unknown }).userId;
  const agentId = (raw as { agentId?: unknown }).agentId;
  const agentConfig = (raw as { agentConfig?: unknown }).agentConfig;
  const conversationIdRaw = (raw as { conversationId?: unknown }).conversationId;
  requireString(userId, 'owner.userId', hookName);
  requireString(agentId, 'owner.agentId', hookName);
  if (typeof agentConfig !== 'object' || agentConfig === null) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName,
      message: `'owner.agentConfig' must be an object`,
    });
  }
  const cfg = agentConfig as Record<string, unknown>;
  requireString(cfg.systemPrompt, 'owner.agentConfig.systemPrompt', hookName);
  requireString(cfg.model, 'owner.agentConfig.model', hookName);
  if (!Array.isArray(cfg.allowedTools) || !cfg.allowedTools.every((t) => typeof t === 'string')) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName,
      message: `'owner.agentConfig.allowedTools' must be a string[]`,
    });
  }
  if (!Array.isArray(cfg.mcpConfigIds) || !cfg.mcpConfigIds.every((t) => typeof t === 'string')) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName,
      message: `'owner.agentConfig.mcpConfigIds' must be a string[]`,
    });
  }
  // conversationId — optional. Accept `string|null|undefined`. Reject
  // empty strings so a wiring bug fails loud rather than silently
  // storing an unbound session.
  let conversationId: string | null;
  if (conversationIdRaw === undefined || conversationIdRaw === null) {
    conversationId = null;
  } else if (typeof conversationIdRaw === 'string' && conversationIdRaw.length > 0) {
    if (conversationIdRaw.length > 256) {
      throw new PluginError({
        code: 'invalid-payload',
        plugin: PLUGIN_NAME,
        hookName,
        message: `'owner.conversationId' must be ≤ 256 chars`,
      });
    }
    conversationId = conversationIdRaw;
  } else {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName,
      message: `'owner.conversationId' must be a non-empty string or null/undefined`,
    });
  }
  return {
    userId,
    agentId,
    agentConfig: {
      systemPrompt: cfg.systemPrompt as string,
      allowedTools: cfg.allowedTools as string[],
      mcpConfigIds: cfg.mcpConfigIds as string[],
      model: cfg.model as string,
    },
    conversationId,
  };
}

function requireInboxEntry(
  value: unknown,
  hookName: string,
): asserts value is InboxEntry {
  if (typeof value !== 'object' || value === null) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName,
      message: `'entry' must be an object`,
    });
  }
  const type = (value as { type?: unknown }).type;
  if (type === 'user-message') {
    const payload = (value as { payload?: unknown }).payload;
    if (
      typeof payload !== 'object' ||
      payload === null ||
      typeof (payload as { content?: unknown }).content !== 'string'
    ) {
      throw new PluginError({
        code: 'invalid-payload',
        plugin: PLUGIN_NAME,
        hookName,
        message: `'entry.payload' must be an AgentMessage`,
      });
    }
    const role = (payload as { role?: unknown }).role;
    if (typeof role !== 'string' || !VALID_ROLES.has(role)) {
      throw new PluginError({
        code: 'invalid-payload',
        plugin: PLUGIN_NAME,
        hookName,
        message: `'entry.payload.role' must be 'user' | 'assistant'`,
      });
    }
    // J9: every server-delivered user message MUST carry the host-minted
    // reqId so the runner can stamp event.stream-chunk emissions with
    // it. Mirrors @ax/session-inmemory.
    const reqId = (value as { reqId?: unknown }).reqId;
    if (typeof reqId !== 'string' || reqId.length === 0) {
      throw new PluginError({
        code: 'invalid-payload',
        plugin: PLUGIN_NAME,
        hookName,
        message: `'entry.reqId' must be a non-empty string for user-message entries`,
      });
    }
    return;
  }
  if (type === 'cancel') return;
  throw new PluginError({
    code: 'invalid-payload',
    plugin: PLUGIN_NAME,
    hookName,
    message: `'entry.type' must be 'user-message' or 'cancel'`,
  });
}

function validateConnectionString(connectionString: unknown): void {
  if (typeof connectionString !== 'string' || connectionString.length === 0) {
    throw new PluginError({
      code: 'invalid-config',
      plugin: PLUGIN_NAME,
      message: `${PLUGIN_NAME}: connectionString must be a non-empty string`,
    });
  }
  if (!/^postgres(ql)?:\/\//.test(connectionString)) {
    throw new PluginError({
      code: 'invalid-config',
      plugin: PLUGIN_NAME,
      message: `${PLUGIN_NAME}: connectionString must start with postgres:// or postgresql://`,
    });
  }
}

export function createSessionPostgresPlugin(
  config: SessionPostgresConfig,
): Plugin {
  validateConnectionString(config.connectionString);

  let pool: pg.Pool | undefined;
  let listenClient: pg.Client | undefined;
  let kysely: Kysely<SessionDatabase> | undefined;
  let store: SessionStore | undefined;
  let inbox: Inbox | undefined;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'session:create',
        'session:resolve-token',
        'session:get-config',
        'session:queue-work',
        'session:claim-work',
        'session:terminate',
        // Week 10–12 Task 16 (J6): host-internal liveness probe used by the
        // chat-orchestrator to decide between routing to an existing
        // sandbox session vs. opening a fresh one.
        'session:is-alive',
      ],
      // We deliberately do NOT call `database:get-instance` — see header
      // comment. session-postgres opens its own pool + listen client
      // because LISTEN can't share a pool.
      calls: [],
      subscribes: [],
    },

    async init({ bus }) {
      const bgLogger =
        config.logger ?? createLogger({ reqId: 'session-postgres-bg' });

      pool = new pg.Pool({
        connectionString: config.connectionString,
        max: config.poolMax ?? 10,
      });
      // pg.Pool emits 'error' for idle-pool errors (e.g., postgres restart in
      // k8s closing an idle connection). Without a listener Node treats them
      // as unhandled and crashes the process.
      pool.on('error', (err) => {
        bgLogger.error('session_postgres_pool_error', {
          err: err instanceof Error ? err : new Error(String(err)),
        });
      });
      kysely = new Kysely<SessionDatabase>({
        dialect: new PostgresDialect({ pool }),
      });

      listenClient = new pg.Client({ connectionString: config.connectionString });
      // Same risk on the LISTEN client — long-lived, idle most of the time,
      // exactly the connection a postgres restart will tear down. Crash-by-
      // unhandled-'error' is the failure mode we're avoiding here.
      listenClient.on('error', (err) => {
        bgLogger.error('session_postgres_listen_client_error', {
          err: err instanceof Error ? err : new Error(String(err)),
        });
      });

      // Mid-init failure: the kernel rolls back plugins 0..N-1 (the ones
      // that already initialized), but does NOT call our shutdown — our
      // init didn't complete, partial state may not be safe to close.
      // So we still own the cleanup of partial allocations between the
      // migrate / connect awaits.
      try {
        await runSessionMigration(kysely);
        await listenClient.connect();
      } catch (err) {
        try {
          await listenClient.end();
        } catch {
          // best-effort
        }
        try {
          await kysely.destroy();
        } catch {
          // best-effort; destroy() also closes the pool, so we don't double-end.
        }
        listenClient = undefined;
        kysely = undefined;
        pool = undefined;
        throw err;
      }

      store = createSessionStore(kysely);
      inbox = createInbox({
        db: kysely,
        listenClient,
        isTerminated: async (sessionId) => {
          const rec = await store!.get(sessionId);
          return rec === null || rec.terminated;
        },
      });

      // ----- session:create -----
      bus.registerService<SessionCreateInput, SessionCreateOutput>(
        'session:create',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const hookName = 'session:create';
          const sessionId = (input as { sessionId?: unknown })?.sessionId;
          const workspaceRoot = (input as { workspaceRoot?: unknown })?.workspaceRoot;
          const owner = (input as { owner?: unknown })?.owner;
          requireString(sessionId, 'sessionId', hookName);
          requireString(workspaceRoot, 'workspaceRoot', hookName);
          const validated = validateOwner(owner, hookName);
          const record = await store!.create(sessionId, workspaceRoot, validated);
          return { sessionId: record.sessionId, token: record.token };
        },
      );

      // ----- session:resolve-token -----
      bus.registerService<SessionResolveTokenInput, SessionResolveTokenOutput>(
        'session:resolve-token',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const hookName = 'session:resolve-token';
          const token = (input as { token?: unknown })?.token;
          requireString(token, 'token', hookName);
          return store!.resolveToken(token);
        },
      );

      // ----- session:get-config -----
      //
      // The runner calls this at boot via IPC. The IPC server's
      // authenticate() resolved the runner's bearer token to a sessionId
      // and stamped that onto ctx.sessionId — we read it here. There is
      // intentionally NO sessionId in the input; closing that door means
      // a runner can't ask for someone else's config. Sessions without
      // a v2 row return `owner-missing`; sessions that are unknown or
      // terminated return `unknown-session`.
      bus.registerService<SessionGetConfigInput, SessionGetConfigOutput>(
        'session:get-config',
        PLUGIN_NAME,
        async (ctx) => {
          const hookName = 'session:get-config';
          requireString(ctx.sessionId, 'ctx.sessionId', hookName);
          const record = await store!.get(ctx.sessionId);
          if (record === null || record.terminated) {
            throw new PluginError({
              code: UNKNOWN_SESSION,
              plugin: PLUGIN_NAME,
              hookName,
              message: `session '${ctx.sessionId}' does not exist or has been terminated`,
            });
          }
          if (
            record.userId === null ||
            record.agentId === null ||
            record.agentConfig === null
          ) {
            // Pre-9.5 session (no v2 row) OR a session minted by a
            // non-orchestrator caller. Either way, the runner has no
            // system prompt — refuse explicitly.
            throw new PluginError({
              code: OWNER_MISSING,
              plugin: PLUGIN_NAME,
              hookName,
              message: `session '${ctx.sessionId}' has no owner — minted before Week 9.5 or by a non-orchestrator caller`,
            });
          }
          return {
            userId: record.userId,
            agentId: record.agentId,
            agentConfig: record.agentConfig,
            // conversationId may be null for sessions created before
            // Task 15 (the column was added then) or for non-conversation
            // sessions (canary, admin probes). Either way, the runner
            // treats null as "no history to replay".
            conversationId: record.conversationId,
          };
        },
      );

      // ----- session:queue-work -----
      bus.registerService<SessionQueueWorkInput, SessionQueueWorkOutput>(
        'session:queue-work',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const hookName = 'session:queue-work';
          const sessionId = (input as { sessionId?: unknown })?.sessionId;
          const entry = (input as { entry?: unknown })?.entry;
          requireString(sessionId, 'sessionId', hookName);
          requireInboxEntry(entry, hookName);
          const record = await store!.get(sessionId);
          if (record === null || record.terminated) {
            throw new PluginError({
              code: UNKNOWN_SESSION,
              plugin: PLUGIN_NAME,
              hookName,
              message: `session '${sessionId}' does not exist or has been terminated`,
            });
          }
          return inbox!.queue(sessionId, entry);
        },
      );

      // ----- session:claim-work -----
      bus.registerService<SessionClaimWorkInput, SessionClaimWorkOutput>(
        'session:claim-work',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const hookName = 'session:claim-work';
          const sessionId = (input as { sessionId?: unknown })?.sessionId;
          const cursor = (input as { cursor?: unknown })?.cursor;
          const timeoutMs = (input as { timeoutMs?: unknown })?.timeoutMs;
          requireString(sessionId, 'sessionId', hookName);
          requireNonNegativeInt(cursor, 'cursor', hookName);
          requireNonNegativeInt(timeoutMs, 'timeoutMs', hookName);
          const record = await store!.get(sessionId);
          if (record === null) {
            throw new PluginError({
              code: UNKNOWN_SESSION,
              plugin: PLUGIN_NAME,
              hookName,
              message: `session '${sessionId}' does not exist`,
            });
          }
          return inbox!.claim(sessionId, cursor, timeoutMs);
        },
      );

      // ----- session:terminate -----
      //
      // After the service work is done, we ALSO `bus.fire('session:terminate',
      // ...)` so subscribers (e.g. @ax/conversations clearing
      // active_session_id, J6) observe the teardown without coupling through
      // a service-call dependency. Fire-and-forget — subscriber failures are
      // logged by HookBus and don't bubble back to the caller.
      bus.registerService<SessionTerminateInput, SessionTerminateOutput>(
        'session:terminate',
        PLUGIN_NAME,
        async (ctx, input) => {
          const hookName = 'session:terminate';
          const sessionId = (input as { sessionId?: unknown })?.sessionId;
          requireString(sessionId, 'sessionId', hookName);
          // Idempotent — store.terminate is a no-op on unknown.
          await store!.terminate(sessionId);
          // Wake any in-flight claims for this session; they'll see
          // terminated and resolve as `timeout` with echo cursor.
          await inbox!.terminate(sessionId);
          // Broadcast to subscribers. Same hookName is used for both service
          // and subscriber lanes; the bus keeps them separate.
          await bus.fire('session:terminate', ctx, { sessionId });
          return {};
        },
      );

      // ----- session:is-alive -----
      //
      // Liveness probe (Week 10–12 Task 16, J6). True iff the v1 row exists
      // AND has `terminated = false`. Nonexistent sessionIds return
      // `{ alive: false }` (the caller's reaction to "stale pointer" and
      // "never existed" is identical: open a fresh sandbox). Empty /
      // non-string sessionIds remain a hard `invalid-payload`.
      bus.registerService<SessionIsAliveInput, SessionIsAliveOutput>(
        'session:is-alive',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const hookName = 'session:is-alive';
          const sessionId = (input as { sessionId?: unknown })?.sessionId;
          requireString(sessionId, 'sessionId', hookName);
          const record = await store!.get(sessionId);
          return { alive: record !== null && !record.terminated };
        },
      );
    },

    async shutdown() {
      if (inbox !== undefined) {
        await inbox.shutdown();
        inbox = undefined;
      }
      if (listenClient !== undefined) {
        await listenClient.end().catch(() => {});
        listenClient = undefined;
      }
      if (kysely !== undefined) {
        await kysely.destroy().catch(() => {});
        kysely = undefined;
      }
      // pg.Pool is destroyed by kysely.destroy() (PostgresDialect closes it).
      pool = undefined;
      store = undefined;
    },
  };
}
