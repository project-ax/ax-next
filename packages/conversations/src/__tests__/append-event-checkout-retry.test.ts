import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { Kysely } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  createTestHarness,
  stopPostgresContainer,
  startTestContainer,
  type TestHarness,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createLogger, PluginError, type Logger } from '@ax/core';
import { createConversationsPlugin } from '../plugin.js';
import type {
  AppendEventInput,
  AppendEventOutput,
  CreateInput,
  CreateOutput,
  GetInput,
  GetOutput,
} from '../types.js';

// ---------------------------------------------------------------------------
// TASK-1059: conversations:append-event retries a checkout that never got a
// connection, and nothing else.
//
// Real Postgres and the real pool: @ax/database-postgres with poolMax 1 and a
// 1 s checkout timeout, and the test holding the only connection. A checkout
// then fails with pg-pool's own error, as it does when the shared pool is
// starved in production. Where a test needs the pool to free up, the retry
// line itself releases the hold (the logger's writer sees it), so nothing
// here guesses at timing.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];
/** Every hold's release; afterEach runs them all. */
const releases: Array<() => void> = [];

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  // Release first: the pool can't end while the test holds its only
  // connection. splice(0) so a later teardown never re-runs an entry.
  for (const release of releases.splice(0)) release();
  for (const h of harnesses.splice(0)) await h.close({ onError: () => {} });
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

/** A one-connection pool with a 1 s checkout timeout, and the conversations plugin on it. */
async function boot(): Promise<{ h: TestHarness; db: Kysely<unknown> }> {
  const h = await createTestHarness({
    services: {
      'agents:resolve': async (_ctx, input: unknown) => {
        const call = input as { agentId: string };
        return { agent: { id: call.agentId, visibility: 'personal' } };
      },
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString, poolMax: 1, checkoutTimeoutMs: 1_000 }),
      // No purge sweep: its startup pass would take the only connection 5 s
      // after boot.
      createConversationsPlugin({ purgeSweepIntervalMs: 0 }),
    ],
  });
  harnesses.push(h);
  const { db } = await h.bus.call<unknown, { db: Kysely<unknown> }>(
    'database:get-instance',
    h.ctx(),
    {},
  );
  return { h, db };
}

async function createConv(h: TestHarness, userId: string): Promise<string> {
  const created = await h.bus.call<CreateInput, CreateOutput>(
    'conversations:create',
    h.ctx({ userId }),
    { userId, agentId: 'agt_a' },
  );
  return created.conversationId;
}

/** Check out the pool's only connection and keep it until the returned release runs. */
async function holdOnlyConnection(db: Kysely<unknown>): Promise<() => void> {
  let held!: () => void;
  const heldP = new Promise<void>((resolve) => {
    held = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = db.connection().execute(async () => {
    held();
    await gate;
  });
  releases.push(release);
  // If the hold's own connect fails, fail now with that error.
  await Promise.race([heldP, holder]);
  return release;
}

interface LogEntry {
  msg: string;
  level: string;
  [field: string]: unknown;
}

/**
 * Lines written through the REAL core logger. A hand-rolled logger would
 * `JSON.stringify` an Error binding to `{}`, so a check that a message is
 * absent would pass on code that still logs it.
 */
function captureLog(onEntry?: (entry: LogEntry) => void): {
  logger: Logger;
  lines: string[];
  entries: (msg: string) => LogEntry[];
} {
  const lines: string[] = [];
  const logger = createLogger({
    reqId: 'task-1059',
    writer: (line) => {
      lines.push(line);
      onEntry?.(JSON.parse(line) as LogEntry);
    },
  });
  const entries = (msg: string): LogEntry[] =>
    lines.map((line) => JSON.parse(line) as LogEntry).filter((entry) => entry.msg === msg);
  return { logger, lines, entries };
}

async function readConversation(
  h: TestHarness,
  conversationId: string,
  userId: string,
): Promise<GetOutput> {
  return h.bus.call<GetInput, GetOutput>('conversations:get', h.ctx({ userId }), {
    conversationId,
    userId,
  });
}

describe('conversations:append-event retries a checkout that never got a connection (TASK-1059)', () => {
  it('a checkout that fails once is retried, and the row is written once', async () => {
    const { h, db } = await boot();
    const userId = 'userA';
    const conversationId = await createConv(h, userId);
    const release = await holdOnlyConnection(db);
    const { logger, lines, entries } = captureLog((entry) => {
      if (entry.msg === 'conversations_append_event_retrying') release();
    });

    await expect(
      h.bus.call<AppendEventInput, AppendEventOutput>(
        'conversations:append-event',
        h.ctx({ conversationId, logger }),
        {
          conversationId,
          kind: 'turn',
          role: 'assistant',
          payload: { blocks: [{ type: 'text', text: 'hi back' }] },
        },
      ),
    ).resolves.toBeUndefined();

    const got = await readConversation(h, conversationId, userId);
    // One turn, so the retry wrote no duplicate.
    expect(got.turns.map((turn) => turn.contentBlocks)).toEqual([
      [{ type: 'text', text: 'hi back' }],
    ]);
    const retries = entries('conversations_append_event_retrying');
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({
      level: 'warn',
      conversationId,
      attempt: 1,
      retryInMs: 250,
      name: 'Error',
    });
    expect(retries[0]).not.toHaveProperty('err');
    expect(lines.join('\n')).not.toContain('timeout exceeded');
  });

  it('a turn error whose first checkout fails still reaches the display log', async () => {
    const { h, db } = await boot();
    const userId = 'userA';
    const conversationId = await createConv(h, userId);
    const release = await holdOnlyConnection(db);
    const { logger, entries } = captureLog((entry) => {
      if (entry.msg === 'conversations_append_event_retrying') release();
    });

    await h.bus.fire('chat:turn-error', h.ctx({ userId, conversationId, logger }), {
      reqId: 'r-1',
      reason: 'chat-run-timeout',
    });
    // A no-op once the retry line has released the hold. Without a retry line
    // nothing releases it, and the read below would wait out the hold instead
    // of showing the missing event.
    release();

    const got = await readConversation(h, conversationId, userId);
    const turnErrors = got.displayEvents.filter((event) => event.kind === 'turn-error');
    expect(turnErrors).toHaveLength(1);
    expect(turnErrors[0]!.payload).toMatchObject({ reqId: 'r-1', error: 'chat-run-timeout' });
    expect(entries('conversations_append_event_retrying')).toHaveLength(1);
    expect(entries('conversations_persist_turn_error_failed')).toEqual([]);
  });

  it('a pool that never frees up gives up after three checkouts and writes nothing', async () => {
    const { h, db } = await boot();
    const userId = 'userA';
    const conversationId = await createConv(h, userId);
    const release = await holdOnlyConnection(db);
    const { logger, entries } = captureLog();

    const thrown = await h.bus
      .call<AppendEventInput, AppendEventOutput>(
        'conversations:append-event',
        h.ctx({ conversationId, logger }),
        {
          conversationId,
          kind: 'turn',
          role: 'assistant',
          payload: { blocks: [{ type: 'text', text: 'never written' }] },
        },
      )
      .then(
        () => undefined,
        (err: unknown) => err,
      );

    expect(thrown).toBeInstanceOf(PluginError);
    expect((thrown as PluginError).code).toBe('unknown');
    // pg-pool's own error for a caller queued behind a full pool, not a hand-made one.
    expect(((thrown as PluginError).cause as Error).message).toBe(
      'timeout exceeded when trying to connect',
    );
    expect(
      entries('conversations_append_event_retrying').map((entry) => [
        entry.attempt,
        entry.retryInMs,
      ]),
    ).toEqual([
      [1, 250],
      [2, 1_000],
    ]);

    release();
    const got = await readConversation(h, conversationId, userId);
    expect(got.turns).toEqual([]);
  });

  it('a write that fails after it got its connection is not retried', async () => {
    const { h } = await boot();
    const conversationId = await createConv(h, 'userA');
    const { logger, entries } = captureLog();

    // The store refuses the kind inside the pinned callback, after hand-over.
    await expect(
      h.bus.call<AppendEventInput, AppendEventOutput>(
        'conversations:append-event',
        h.ctx({ conversationId, logger }),
        { conversationId, kind: 'not-a-kind' as never, payload: {} },
      ),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
    expect(entries('conversations_append_event_retrying')).toEqual([]);
  });
});
