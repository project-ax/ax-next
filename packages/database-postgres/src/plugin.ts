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
// TASK-1061: pg's TCP keepalive is off by default. First probe after this long
// idle; Node then probes every 1 s, 10 times (its documented setKeepAlive
// socket options), so a dead peer shows up in about 20 s. Not configurable.
const KEEPALIVE_INITIAL_DELAY_MS = 10_000;
// Node turns any timer delay above this into 1 ms.
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
// Postgres refuses a larger statement_timeout, which would fail every connect.
const MAX_STATEMENT_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;
// The same ceiling: Postgres refuses a larger idle_in_transaction_session_timeout.
const MAX_IDLE_IN_TRANSACTION_TIMEOUT_MS = 2_147_483_647;
// TASK-1058: pg-pool 3.13.0's two timeout rejections carry no code, so a
// code-only log line can't tell them from a database error or from each other.
// Each gets its own backend-neutral code:
// - `index.js:224` (`db-checkout-timeout`): the pool was full when the caller
//   asked, so it queued, and its wait ran out before it got a working
//   connection. The slots stayed busy (with work: the pool is starved; or
//   with new connections the database hasn't answered, since pg-pool counts
//   one still connecting as a used slot), or a slot freed up and the new
//   connection opened for the caller went unanswered: the queue timer keeps
//   running and fires first. So in an outage with more callers than
//   `poolMax`, the queued callers get this code too.
// - `:276` (`db-connect-timeout`): the pool had room when the caller asked,
//   and the database didn't answer the new connection opened for it. The
//   database is slow or unreachable; any of these in the same window means
//   the queued timeouts point at the database too.
// checkout-timeout.test.ts pins both messages against the real pool, so a
// pg-pool upgrade that rewords them fails there.
const CHECKOUT_TIMEOUT_CODES: ReadonlyMap<string, string> = new Map([
  ['timeout exceeded when trying to connect', 'db-checkout-timeout'],
  ['Connection terminated due to connection timeout', 'db-connect-timeout'],
]);

export interface DatabasePostgresConfig {
  connectionString: string;
  poolMax?: number;
  /**
   * How long a caller waits for a connection before the call fails with pg's
   * timeout error. That covers a free connection, one another caller hands
   * back, or a new one the database has to answer. The error is pg's own, with
   * a code added: `db-checkout-timeout` when the pool was full when the caller
   * asked, so it queued, and its wait ran out first (the slots stayed busy,
   * or the new connection opened for it once one freed up went unanswered);
   * `db-connect-timeout` when the pool had room and the database didn't answer
   * the new connection opened for the caller. A whole number of ms from 1 to
   * 2147483647; default 5000. Maps to pg's `connectionTimeoutMillis`.
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
   * How long a pooled connection may sit idle inside an open transaction,
   * between one statement and the next, before Postgres ends its session with
   * SQLSTATE `25P03`. Every lock the session held goes with it. Only that gap
   * counts: a statement that runs long is the statement timeout's job, and a
   * connection idle outside a transaction is never ended. The caller's next
   * statement fails with pg's code-less "Client has encountered a connection
   * error and is not queryable", the pool drops the connection when it's
   * released, and `database_postgres_client_error` logs `25P03`. A whole
   * number of ms from 1 to 2147483647; default 60000. Maps to pg's
   * `idle_in_transaction_session_timeout`, which is sent at connect time.
   *
   * Why 60 s: twice the statement timeout, and longer than any wait a holder
   * makes on another database call, which the database bounds itself (a
   * nested 5 s checkout plus a 30 s statement). So it ends only a holder stuck
   * on something with no bound of its own, such as routines' `blob:put`. A new
   * holder must not legitimately idle anywhere near 60 s. If you raise
   * `checkoutTimeoutMs` or `statementTimeoutMs`, keep this above their sum
   * (35 s at the defaults): below it, routines' `withLockedWebhookSecret`,
   * which holds its lock across the credential write on purpose, can be cut
   * off mid-write. That is documented here, not enforced.
   */
  idleInTransactionTimeoutMs?: number;
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
      refuseServerTimeoutsInConnectionString(config.connectionString);
      const checkoutTimeoutMs = resolveCheckoutTimeoutMs(config.checkoutTimeoutMs);
      const statementTimeoutMs = resolveStatementTimeoutMs(config.statementTimeoutMs);
      const idleInTransactionTimeoutMs = resolveIdleInTransactionTimeoutMs(
        config.idleInTransactionTimeoutMs,
      );
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
        // TASK-1061: a peer that vanishes without closing the connection is
        // otherwise never noticed on a quiet socket. Set here, not in the URL:
        // pg ignores a URL `keepalives` param. Detection takes ~20 s (see
        // KEEPALIVE_INITIAL_DELAY_MS).
        keepAlive: true,
        keepAliveInitialDelayMillis: KEEPALIVE_INITIAL_DELAY_MS,
        // TASK-1056: the database cancels a statement after this long, a lock
        // wait included, and the connection stays usable. Without it, a stuck
        // statement holds its pool slot forever. Nothing on this pool is
        // exempt; see SECURITY.md.
        statement_timeout: statementTimeoutMs,
        // TASK-1061: Postgres ends a session left idle inside an open
        // transaction for this long (25P03), and its locks go with it. Without
        // it, a holder awaiting something nothing else bounds (routines'
        // blob:put) kept its row and advisory locks forever. A session idle
        // outside a transaction is never ended. Why 60 s: see
        // idleInTransactionTimeoutMs.
        idle_in_transaction_session_timeout: idleInTransactionTimeoutMs,
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
        // Kysely checks connections out through `connect()` alone and rethrows
        // what it rejects with, so tagging here reaches every caller. The
        // 'acquire'/'release' listeners above stay on the real pool.
        dialect: new PostgresDialect({
          pool: { connect: () => pool.connect().catch(tagCheckoutTimeout), end: () => pool.end() },
        }),
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

/**
 * Sets `code` on pg-pool's checkout-timeout errors and rethrows that same
 * object, so its message, stack, cause and class stay pg-pool's. Only an exact
 * message match with no code of its own is tagged: a refused connection or an
 * auth failure keeps its own code, and a connection dropped without one stays
 * untagged.
 */
function tagCheckoutTimeout(err: unknown): never {
  if (err instanceof Error && (err as { code?: unknown }).code === undefined) {
    const code = CHECKOUT_TIMEOUT_CODES.get(err.message);
    if (code !== undefined) (err as { code?: string }).code = code;
  }
  throw err;
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

// Each server-side timeout the pool sets, keyed by the connection-string
// parameter that would override it, with the config field that owns it.
const URL_REFUSED_KEYS: ReadonlyMap<string, string> = new Map([
  ['statement_timeout', 'statementTimeoutMs'],
  ['idle_in_transaction_session_timeout', 'idleInTransactionTimeoutMs'],
]);

// pg lays the connection string's query parameters over the explicit config,
// so `?statement_timeout=0` or `?idle_in_transaction_session_timeout=0` (or a
// bare key, which pg reads as unset) would silently replace statementTimeoutMs
// or idleInTransactionTimeoutMs, or switch that bound off. Each bound has one
// home: refuse the other. This refuses at least every key
// pg would read (pg-connection-string parses with `new URL`): the query ends
// at the first `#`, and tab, LF and CR are dropped everywhere before it is
// split, so they can't break up a key or an escape. Each key is then decoded on its own (a malformed escape
// elsewhere can't hide it; a key with no `=` still counts), and any code unit
// at or below 0x20 is dropped from it, because `new URL` trims control
// characters and spaces off the end of the string. Neither refused key has
// any of those, so stripping them can only refuse more. `options` isn't
// checked: pg always sends the explicit parameter, and Postgres applies it
// after `-c` options (measured on 16 for both keys). Linear: no backtracking
// regex, and one Map lookup per key.
function refuseServerTimeoutsInConnectionString(connectionString: string): void {
  const queryStart = connectionString.indexOf('?');
  if (queryStart === -1) return;
  const hashAt = connectionString.indexOf('#', queryStart);
  const query = connectionString
    .slice(queryStart + 1, hashAt === -1 ? undefined : hashAt)
    .replace(/[\t\n\r]/g, '');
  for (const part of query.split('&')) {
    const rawKey = part.split('=', 1)[0] ?? '';
    let key = rawKey;
    try {
      key = decodeURIComponent(rawKey);
    } catch {
      // A malformed escape in this key: compare it raw.
    }
    const normalized = key.replace(/[\x00-\x20]/g, '');
    const field = URL_REFUSED_KEYS.get(normalized);
    if (field !== undefined) {
      throw new PluginError({
        code: 'invalid-config',
        plugin: PLUGIN_NAME,
        message: `${PLUGIN_NAME}: connectionString must not set ${normalized}; use ${field}`,
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

function resolveIdleInTransactionTimeoutMs(value: unknown): number {
  if (value === undefined) return DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS;
  if (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_IDLE_IN_TRANSACTION_TIMEOUT_MS
  ) {
    return value;
  }
  throw new PluginError({
    code: 'invalid-config',
    plugin: PLUGIN_NAME,
    message: `${PLUGIN_NAME}: idleInTransactionTimeoutMs must be a whole number of milliseconds from 1 to ${MAX_IDLE_IN_TRANSACTION_TIMEOUT_MS}`,
  });
}
