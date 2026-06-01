/**
 * Stop a Postgres testcontainer without letting the benign teardown race fail
 * the suite.
 *
 * Why this exists: when `container.stop()` runs in `afterAll`, postgres
 * receives SIGTERM and kills every connection still bound to an open pool.
 * A `pg.Pool` created in a test has no `'error'` listener, so Node re-emits
 * that connection error as an **uncaughtException** — and vitest counts an
 * uncaught exception during teardown as a suite failure even when every
 * assertion passed. The error is always the same benign one:
 *
 *   { code: '57P01', message: 'terminating connection due to administrator
 *     command', name: 'error' }
 *
 * It is expected — the container is going away on purpose. So for the duration
 * of `stop()` (plus a tick afterward, since the socket error surfaces
 * asynchronously) we install a guard that swallows ONLY that 57P01 shape and
 * lets anything else propagate untouched. Pools that ARE drained in `afterEach`
 * keep working exactly as before; pools that race the stop no longer red the
 * suite. This is the deterministic teardown TASK-104 asks for, applied through
 * one shared helper so every postgres-testcontainer package behaves the same.
 *
 * Drop-in for `await container.stop()` — it no-ops on `undefined`, matching the
 * common `if (container) await container.stop()` guard.
 */

/** Minimal shape we need from a started container — avoids a runtime/type
 *  dependency on `@testcontainers/postgresql` inside the harness package. */
export interface StoppableContainer {
  stop(): Promise<unknown>;
}

const PG_ADMIN_SHUTDOWN_CODE = '57P01';
const PG_ADMIN_SHUTDOWN_MESSAGE =
  'terminating connection due to administrator command';

/** True iff `err` is the benign "postgres is shutting down" connection error. */
function isBenignAdminShutdown(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (code === PG_ADMIN_SHUTDOWN_CODE) return true;
  const message = (err as { message?: unknown }).message;
  return (
    typeof message === 'string' && message.includes(PG_ADMIN_SHUTDOWN_MESSAGE)
  );
}

/**
 * Stop the container, swallowing only the benign 57P01 admin-shutdown error
 * that a still-open pool emits as the server goes away. Real errors during
 * teardown still propagate and fail the suite.
 */
export async function stopPostgresContainer(
  container: StoppableContainer | undefined,
): Promise<void> {
  if (container === undefined) return;

  const onUncaught = (err: unknown): void => {
    if (isBenignAdminShutdown(err)) return; // swallow — expected, container is going away
    // Not ours: detach so we don't re-enter, then re-emit so any pre-existing
    // listener sees it (or Node crashes as it normally would with none).
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onRejection);
    process.emit('uncaughtException', err as Error);
  };
  const onRejection = (reason: unknown, promise: Promise<unknown>): void => {
    if (isBenignAdminShutdown(reason)) return; // swallow
    // Not ours: detach so we don't re-enter, then re-emit on the SAME promise
    // so any pre-existing listener sees it (or Node crashes as it normally
    // would). Reusing `promise` avoids minting a fresh unhandled rejection.
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onRejection);
    process.emit('unhandledRejection', reason, promise);
  };

  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);
  try {
    await container.stop();
    // The socket error surfaces asynchronously, sometimes a tick AFTER stop()
    // resolves — give it a macrotask to land while the guard is still armed.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  } finally {
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onRejection);
  }
}
