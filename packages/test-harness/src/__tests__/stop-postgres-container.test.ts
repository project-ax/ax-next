import { describe, it, expect, afterEach } from 'vitest';
import { stopPostgresContainer } from '../stop-postgres-container.js';

// A fake container that, while `stop()` is awaited, raises whatever the test
// hands it via `process.emit('uncaughtException', ...)` — the exact channel a
// listener-less `pg.Pool` uses when the postgres server kills its idle
// connection during teardown (confirmed: code 57P01 arrives as
// uncaughtException, not unhandledRejection).
function fakeContainer(raise?: () => void): { stop(): Promise<void> } {
  return {
    async stop() {
      // Let the guard install, then raise on the next tick (mirrors the real
      // socket-error timing: it surfaces asynchronously around stop()).
      await new Promise((r) => setTimeout(r, 0));
      raise?.();
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

function pgError(code: string | undefined, message: string): Error {
  const e = new Error(message) as Error & { code?: string };
  if (code !== undefined) e.code = code;
  // pg labels these `name: 'error'`.
  e.name = 'error';
  return e;
}

const baselineUncaught = process.listenerCount('uncaughtException');
const baselineUnhandled = process.listenerCount('unhandledRejection');

afterEach(() => {
  // No matter what a case does, the helper must leave the process listener
  // counts back at baseline — it must not leak its temporary guards.
  expect(process.listenerCount('uncaughtException')).toBe(baselineUncaught);
  expect(process.listenerCount('unhandledRejection')).toBe(baselineUnhandled);
});

describe('stopPostgresContainer', () => {
  it('swallows a benign 57P01 uncaughtException raised during stop()', async () => {
    const container = fakeContainer(() => {
      process.emit(
        'uncaughtException',
        pgError('57P01', 'terminating connection due to administrator command'),
      );
    });
    // Resolves cleanly — the 57P01 was swallowed, not propagated.
    await expect(stopPostgresContainer(container)).resolves.toBeUndefined();
  });

  it('swallows 57P01 identified by message even when code is absent', async () => {
    const container = fakeContainer(() => {
      process.emit(
        'uncaughtException',
        pgError(undefined, 'terminating connection due to administrator command'),
      );
    });
    await expect(stopPostgresContainer(container)).resolves.toBeUndefined();
  });

  it('does NOT swallow a non-57P01 uncaughtException', async () => {
    // Install a sentinel listener so the re-emitted error has somewhere to go
    // (otherwise it would crash the vitest worker). We assert the helper
    // re-emitted it rather than swallowing it.
    let caught: Error | undefined;
    const sentinel = (e: unknown) => {
      caught = e as Error;
    };
    process.on('uncaughtException', sentinel);
    try {
      const container = fakeContainer(() => {
        process.emit('uncaughtException', pgError('23505', 'duplicate key value'));
      });
      await stopPostgresContainer(container);
    } finally {
      process.off('uncaughtException', sentinel);
    }
    expect(caught).toBeDefined();
    expect((caught as Error & { code?: string }).code).toBe('23505');
  });

  it('no-ops when the container is undefined', async () => {
    await expect(stopPostgresContainer(undefined)).resolves.toBeUndefined();
  });

  it('still calls stop() exactly once and awaits it', async () => {
    let stops = 0;
    const container = {
      async stop() {
        stops += 1;
        await new Promise((r) => setTimeout(r, 0));
      },
    };
    await stopPostgresContainer(container);
    expect(stops).toBe(1);
  });
});
