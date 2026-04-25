import { createLogger, PluginError, type Logger, type Plugin } from '@ax/core';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

/**
 * @ax/database-postgres — owns the pg.Pool + Kysely instance for the
 * postgres-backed plugin family (storage-postgres, session-postgres, ...).
 *
 * Exposes a single service hook:
 *
 *   database:get-instance(ctx, {}) -> { db: Kysely<unknown> }
 *
 * Singleton semantics: every caller gets the same Kysely instance backed by
 * the same pg.Pool. Plugins that need a typed schema cast the returned
 * `db` to their own `Kysely<MySchema>` at the edge — the kernel-level type
 * stays generic so we don't leak any one plugin's table shape into the
 * shared contract.
 *
 * Why a separate plugin owns the pool:
 * - One source of truth (Invariant 4) — only one place opens connections.
 * - Storage / session / audit each have their own table prefix and
 *   migrations, but share the pool to avoid N pools per process.
 *
 * Why eventbus-postgres does NOT use this: LISTEN requires a dedicated,
 * non-pooled client held open for the lifetime of the subscription. Pool
 * connections can be returned mid-listen, breaking subscriptions. So
 * eventbus-postgres takes its own connectionString and opens a single
 * pg.Client. (See its plugin.ts for the deep-dive.)
 */

const PLUGIN_NAME = '@ax/database-postgres';

export interface DatabasePostgresConfig {
  connectionString: string;
  poolMax?: number;
  /**
   * Optional logger for background pg.Pool errors (idle-pool socket failures,
   * e.g., postgres restart in k8s). Defaults to a stdout JSON logger tagged
   * `reqId=database-postgres-bg`. Without a listener attached, an unhandled
   * 'error' from the pool would crash the process.
   */
  logger?: Logger;
}

export interface DatabaseGetInstanceOutput {
  db: Kysely<unknown>;
}

export function createDatabasePostgresPlugin(config: DatabasePostgresConfig): Plugin {
  let kysely: Kysely<unknown> | undefined;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['database:get-instance'],
      calls: [],
      subscribes: [],
    },
    // TODO(kernel-shutdown): destroy the pool on shutdown when the kernel
    // gains a plugin shutdown lifecycle. Today the process exits before
    // anything can close; pg cleans up its own sockets via Node teardown.
    init({ bus }) {
      validateConnectionString(config.connectionString);
      const bgLogger =
        config.logger ?? createLogger({ reqId: 'database-postgres-bg' });

      const pool = new pg.Pool({
        connectionString: config.connectionString,
        max: config.poolMax ?? 10,
      });
      // pg.Pool emits 'error' for idle-pool socket failures (e.g., postgres
      // restart). Without a listener Node treats it as unhandled and crashes
      // the process — exactly the failure mode this pool sits idle waiting
      // for between requests.
      pool.on('error', (err) => {
        bgLogger.error('database_postgres_pool_error', {
          err: err instanceof Error ? err : new Error(String(err)),
        });
      });
      kysely = new Kysely<unknown>({
        dialect: new PostgresDialect({ pool }),
      });

      bus.registerService<unknown, DatabaseGetInstanceOutput>(
        'database:get-instance',
        PLUGIN_NAME,
        async () => ({ db: kysely! }),
      );
    },
  };
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
