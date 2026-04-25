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
import { createSessionStore, UNKNOWN_SESSION, type SessionStore } from './store.js';

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
}
export interface SessionCreateOutput {
  sessionId: string;
  token: string;
}
export interface SessionResolveTokenInput {
  token: string;
}
export type SessionResolveTokenOutput =
  | { sessionId: string; workspaceRoot: string }
  | null;
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

const VALID_ROLES = new Set(['user', 'assistant', 'system']);

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
        message: `'entry.payload' must be a ChatMessage`,
      });
    }
    const role = (payload as { role?: unknown }).role;
    if (typeof role !== 'string' || !VALID_ROLES.has(role)) {
      throw new PluginError({
        code: 'invalid-payload',
        plugin: PLUGIN_NAME,
        hookName,
        message: `'entry.payload.role' must be 'user' | 'assistant' | 'system'`,
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
        'session:queue-work',
        'session:claim-work',
        'session:terminate',
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
          requireString(sessionId, 'sessionId', hookName);
          requireString(workspaceRoot, 'workspaceRoot', hookName);
          const record = await store!.create(sessionId, workspaceRoot);
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
      bus.registerService<SessionTerminateInput, SessionTerminateOutput>(
        'session:terminate',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const hookName = 'session:terminate';
          const sessionId = (input as { sessionId?: unknown })?.sessionId;
          requireString(sessionId, 'sessionId', hookName);
          // Idempotent — store.terminate is a no-op on unknown.
          await store!.terminate(sessionId);
          // Wake any in-flight claims for this session; they'll see
          // terminated and resolve as `timeout` with echo cursor.
          await inbox!.terminate(sessionId);
          return {};
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
