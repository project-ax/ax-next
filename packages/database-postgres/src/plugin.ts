import { createLogger, faultLogFields, PluginError, type Logger, type Plugin } from '@ax/core';
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
const DEFAULT_CHECKOUT_TIMEOUT_MS = 5_000;
// Node turns any timer delay above this into 1 ms.
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
// Postgres refuses a larger statement_timeout, which would fail every connect.
const MAX_STATEMENT_TIMEOUT_MS = 2_147_483_647;

export interface DatabasePostgresConfig {
  connectionString: string;
  poolMax?: number;
  /**
   * How long a caller waits for a connection before the call fails with pg's
   * timeout error. That covers a free connection, one another caller hands
   * back, or a new one the database has to answer. A whole number of ms from
   * 1 to 2147483647; default 5000. Maps to pg's `connectionTimeoutMillis`.
   */
  checkoutTimeoutMs?: number;
  /**
   * How long one statement on a pooled connection may run, waiting for a lock
   * included, before Postgres cancels it with SQLSTATE `57014`. The connection
   * stays usable, and a surrounding transaction rolls back. A whole number of
   * ms from 1 to 2147483647; default 30000. Maps to pg's `statement_timeout`,
   * which is sent at connect time. A statement that legitimately needs longer,
   * such as a migration on a big table, runs inside a transaction that starts
   * with `SET LOCAL statement_timeout = 0`.
   */
  statementTimeoutMs?: number;
  /**
   * Optional logger for background connection failures (e.g., a postgres
   * restart in k8s): `database_postgres_pool_error` when an idle pooled
   * connection fails, and `database_postgres_client_error` when a checked-out
   * one does (TASK-1048). Both carry `faultLogFields` codes only. Defaults to
   * a stdout JSON logger tagged `reqId=database-postgres-bg`. Without these
   * listeners, an unhandled 'error' would crash the process.
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
    init({ bus }) {
      validateConnectionString(config.connectionString);
      refuseStatementTimeoutInConnectionString(config.connectionString);
      const checkoutTimeoutMs = resolveCheckoutTimeoutMs(config.checkoutTimeoutMs);
      const statementTimeoutMs = resolveStatementTimeoutMs(config.statementTimeoutMs);
      const bgLogger =
        config.logger ?? createLogger({ reqId: 'database-postgres-bg' });

      const pool = new pg.Pool({
        connectionString: config.connectionString,
        max: config.poolMax ?? 10,
        // TASK-1049: pg's default of 0 waits forever, both behind a full pool
        // and on a new connection the database never answers. A hung wait can
        // hold host shutdown past the pod's 30 s grace period. 5 s is far
        // above a normal wait and below the kernel's 10 s per-plugin shutdown
        // deadline.
        connectionTimeoutMillis: checkoutTimeoutMs,
        // TASK-1056: the database cancels a statement after this long, a lock
        // wait included, and the connection stays usable. Without it, a stuck
        // statement holds its pool slot forever. Nothing on this pool is
        // exempt; see SECURITY.md.
        statement_timeout: statementTimeoutMs,
      });
      // pg.Pool emits 'error' for idle-pool socket failures (e.g., postgres
      // restart). Without a listener Node treats it as unhandled and crashes
      // the process — exactly the failure mode this pool sits idle waiting
      // for between requests.
      pool.on('error', (err) => {
        bgLogger.error('database_postgres_pool_error', faultLogFields(err));
      });
      // TASK-1048: pg-pool listens for a client's 'error' only while the client
      // is idle in the pool. It removes that listener at checkout and puts it
      // back at release. A checked-out client whose session Postgres ends (a
      // restart, a failover, pg_terminate_backend) emits 'error' with nobody
      // listening, and Node turns that into an uncaught exception that ends the
      // host. Kysely adds no listener. So a checked-out client gets one for
      // exactly as long as pg-pool's is off ('acquire' fires before pg-pool
      // removes its own; 'release' fires after it puts it back). The caller
      // still sees the failure: its queries reject, and pg-pool drops the dead
      // client at release. A client that dies between queries emits twice
      // (the server's error with its SQLSTATE, then the socket closing); one
      // that dies mid-query hands the server's error to that query and emits
      // only the socket close, which has no code. Either way only the first
      // event is logged. Codes only: a driver's message can carry a host, a
      // user or a query value.
      const checkedOutListeners = new WeakMap<pg.PoolClient, (err: Error) => void>();
      pool.on('acquire', (client) => {
        let listener = checkedOutListeners.get(client);
        if (listener === undefined) {
          let reported = false;
          listener = (err) => {
            if (reported) return;
            reported = true;
            bgLogger.error('database_postgres_client_error', faultLogFields(err));
          };
          checkedOutListeners.set(client, listener);
        }
        client.on('error', listener);
      });
      pool.on('release', (_err, client) => {
        const listener = checkedOutListeners.get(client);
        if (listener !== undefined) client.removeListener('error', listener);
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
    async shutdown() {
      if (kysely !== undefined) {
        await kysely.destroy().catch(() => {
          // best-effort; PostgresDialect closes pg.Pool internally.
        });
        kysely = undefined;
      }
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

function resolveCheckoutTimeoutMs(value: unknown): number {
  if (value === undefined) return DEFAULT_CHECKOUT_TIMEOUT_MS;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_TIMER_DELAY_MS) {
    return value;
  }
  throw new PluginError({
    code: 'invalid-config',
    plugin: PLUGIN_NAME,
    message: `${PLUGIN_NAME}: checkoutTimeoutMs must be a whole number of milliseconds from 1 to ${MAX_TIMER_DELAY_MS}`,
  });
}

// pg lays the connection string's query parameters over the explicit config,
// so `?statement_timeout=0` (or a bare `?statement_timeout`, which pg reads as
// unset) would silently replace statementTimeoutMs or switch the bound off.
// The bound has one home: refuse the other. This reads the query the way pg
// does (pg-connection-string parses with `new URL`): tab, LF and CR are
// dropped everywhere before the query is split, so they can't break up a key
// or an escape. Each key is then decoded on its own (a malformed escape
// elsewhere can't hide it; a key with no `=` still counts), and any code unit
// at or below 0x20 is dropped from it, because `new URL` trims control
// characters and spaces off the end of the string. `statement_timeout` has
// none of those, so stripping them can only refuse more. `options` isn't
// checked: pg always sends the explicit parameter, and Postgres applies it
// after `-c` options (measured on 16). Linear: no backtracking regex.
function refuseStatementTimeoutInConnectionString(connectionString: string): void {
  const queryStart = connectionString.indexOf('?');
  if (queryStart === -1) return;
  const query = connectionString.slice(queryStart + 1).replace(/[\t\n\r]/g, '');
  for (const part of query.split('&')) {
    const rawKey = part.split('=', 1)[0] ?? '';
    let key = rawKey;
    try {
      key = decodeURIComponent(rawKey);
    } catch {
      // A malformed escape in this key: compare it raw.
    }
    if (key.replace(/[\x00-\x20]/g, '') === 'statement_timeout') {
      throw new PluginError({
        code: 'invalid-config',
        plugin: PLUGIN_NAME,
        message: `${PLUGIN_NAME}: connectionString must not set statement_timeout; use statementTimeoutMs`,
      });
    }
  }
}

function resolveStatementTimeoutMs(value: unknown): number {
  if (value === undefined) return DEFAULT_STATEMENT_TIMEOUT_MS;
  if (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_STATEMENT_TIMEOUT_MS
  ) {
    return value;
  }
  throw new PluginError({
    code: 'invalid-config',
    plugin: PLUGIN_NAME,
    message: `${PLUGIN_NAME}: statementTimeoutMs must be a whole number of milliseconds from 1 to ${MAX_STATEMENT_TIMEOUT_MS}`,
  });
}
