import { randomBytes } from 'node:crypto';
import { stopPostgresContainer } from './stop-postgres-container.js';

/**
 * One Postgres server per test file, one fresh database per test.
 *
 * WHY. Starting a Postgres container costs ~2–4.5 s locally (more on a loaded
 * CI runner, where starts also queue behind the host-wide start slots in
 * `container-start-slots.ts`). Creating a database on a running server costs
 * ~25 ms. Suites that started a container per TEST spent most of their time
 * booting Postgres: `@ax/routines` was ~9 of CI's ~22 test minutes.
 *
 * ISOLATION. Each `database()` is a new, empty database, so a test sees no
 * table, row, sequence, extension, or LISTEN channel from another — those are
 * all per-database in Postgres. What IS shared is server-wide state: roles,
 * `pg_stat_activity`, and `ALTER SYSTEM` settings. A test that stops the
 * server, terminates other backends, or changes server settings should keep
 * owning a container of its own.
 *
 * LIFETIME. The server starts lazily on the first `database()` and lives until
 * `stop()`. Call `stop()` from `afterAll` in the file that created it — with
 * Ryuk disabled (as in CI) nothing else reaps the container.
 */
export interface SharedPostgresContainer {
  getConnectionUri(): string;
  getUsername(): string;
  getDatabase(): string;
  exec(command: string[]): Promise<{ exitCode: number; output: string }>;
  stop(): Promise<unknown>;
}

export interface SharedPostgres {
  /** A connection string to a brand-new, empty database on the shared server. */
  database(): Promise<string>;
  /** Stop the server, if it was ever started. Safe to call more than once. */
  stop(): Promise<void>;
}

/**
 * `start` is how to start the server — typically
 * `() => startTestContainer(new PostgreSqlContainer('postgres:16-alpine'))`.
 * Passing it in keeps `pg` and testcontainers out of this package's
 * dependencies; the database is created with `psql` inside the container.
 */
export function createSharedPostgres(start: () => Promise<SharedPostgresContainer>): SharedPostgres {
  let server: Promise<SharedPostgresContainer> | null = null;
  let stopped = false;

  return {
    async database() {
      if (stopped) throw new Error('createSharedPostgres: database() after stop()');
      // One start for concurrent first callers. A failed start is not cached:
      // the next call tries again rather than replaying the same rejection.
      if (server === null) {
        server = start().catch((err: unknown) => {
          server = null;
          throw err;
        });
      }
      const container = await server;
      // Lowercase letters, digits and underscores only: a valid unquoted
      // identifier, so it needs no quoting in the CREATE below.
      const name = `t_${randomBytes(8).toString('hex')}`;
      const result = await container.exec([
        'psql', '-X', '-v', 'ON_ERROR_STOP=1',
        '-U', container.getUsername(), '-d', container.getDatabase(),
        '-c', `CREATE DATABASE ${name}`,
      ]);
      if (result.exitCode !== 0) {
        throw new Error(`createSharedPostgres: CREATE DATABASE failed (exit ${result.exitCode}): ${result.output}`);
      }
      const uri = new URL(container.getConnectionUri());
      uri.pathname = `/${name}`;
      return uri.toString();
    },
    async stop() {
      stopped = true;
      const pending = server;
      server = null;
      if (pending === null) return;
      let container: SharedPostgresContainer;
      try {
        container = await pending;
      } catch {
        return; // never started, nothing to stop
      }
      await stopPostgresContainer(container);
    },
  };
}
