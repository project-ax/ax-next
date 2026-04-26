import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { PluginError } from '@ax/core';
import { createInbox } from '../inbox.js';
import { runSessionMigration, type SessionDatabase } from '../migrations.js';

// ---------------------------------------------------------------------------
// Inbox JSONB corruption test (review-feedback follow-up).
//
// Pre-Task-6 rows stored a bare ChatMessage in `payload`; Task 6 wraps that
// as `{ message, reqId }` so the runner can read the host-minted reqId
// back at claim time. A row whose JSONB doesn't match the wrap shape (a
// pre-Task-6 row left in flight across a deploy, or a manual DB write) is
// CORRUPTION: silent-skipping it would leave the user's message in the DB
// but unreachable at this cursor, and the long-poll claim loop would
// re-poll forever. The fix throws `corrupt-inbox-row` so the corruption
// surfaces as a terminal INTERNAL error — the runner exits 1, the
// orchestrator records terminated chat-end, and the operator can find +
// delete the bad row instead of debugging a mysterious hang.
//
// We exercise both the fast-path (claim() → fetchEntry) and the slow-path
// (LISTEN → wakeWaiter → fetchEntry) so a future refactor can't regress
// one without the other.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
});

afterAll(async () => {
  if (container) await container.stop();
});

const opened: { destroy: () => Promise<void> }[] = [];

afterEach(async () => {
  while (opened.length > 0) {
    const o = opened.pop()!;
    await o.destroy().catch(() => {});
  }
  const cleanupClient = new pg.Client({ connectionString });
  await cleanupClient.connect();
  try {
    await cleanupClient.query('DROP TABLE IF EXISTS session_postgres_v1_inbox');
    await cleanupClient.query('DROP TABLE IF EXISTS session_postgres_v1_sessions');
    await cleanupClient.query('DROP TABLE IF EXISTS session_postgres_v2_session_agent');
  } finally {
    await cleanupClient.end().catch(() => {});
  }
});

interface Setup {
  db: Kysely<SessionDatabase>;
  listenClient: pg.Client;
  inbox: ReturnType<typeof createInbox>;
}

async function makeInbox(): Promise<Setup> {
  const pool = new pg.Pool({ connectionString, max: 5 });
  const db = new Kysely<SessionDatabase>({ dialect: new PostgresDialect({ pool }) });
  opened.push({ destroy: () => db.destroy().catch(() => {}) as unknown as Promise<void> });
  await runSessionMigration(db);

  const listenClient = new pg.Client({ connectionString });
  await listenClient.connect();
  opened.push({ destroy: () => listenClient.end().catch(() => {}) as unknown as Promise<void> });

  const inbox = createInbox({
    db,
    listenClient,
    isTerminated: async () => false,
  });
  return { db, listenClient, inbox };
}

/**
 * Insert a row with the OLD pre-Task-6 shape — bare ChatMessage in the
 * JSONB payload, no `{ message, reqId }` wrap. Bypasses `inbox.queue`
 * (which would write the new shape) so we can simulate a row left over
 * from before Task 6 landed.
 */
async function insertLegacyRow(
  db: Kysely<SessionDatabase>,
  sessionId: string,
  cursor: number,
  bareMessage: { role: string; content: string },
): Promise<void> {
  // Use raw SQL so we don't have to fight Kysely's typed insert path on
  // the historically-shaped column. JSONB takes a string-encoded value.
  await sql`
    INSERT INTO session_postgres_v1_inbox (session_id, cursor, type, payload)
    VALUES (
      ${sessionId},
      ${cursor},
      'user-message',
      ${JSON.stringify(bareMessage)}::jsonb
    )
  `.execute(db);
}

describe('inbox corruption: malformed JSONB throws corrupt-inbox-row', () => {
  it('fast-path: claim() with a pre-Task-6 row throws PluginError(corrupt-inbox-row)', async () => {
    const { db, inbox } = await makeInbox();

    await insertLegacyRow(db, 's-corrupt-1', 0, {
      role: 'user',
      content: 'hello from a pre-Task-6 deploy',
    });

    let caught: unknown;
    try {
      await inbox.claim('s-corrupt-1', 0, 1000);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    const e = caught as PluginError;
    expect(e.code).toBe('corrupt-inbox-row');
    expect(e.plugin).toBe('@ax/session-postgres');
    expect(e.hookName).toBe('session:claim-work');
    // The message MUST surface enough state for an operator to triage:
    // the row id, session id, and recovery hint.
    expect(e.message).toMatch(/id=/);
    expect(e.message).toMatch(/s-corrupt-1/);
    expect(e.message).toMatch(/DELETE FROM session_postgres_v1_inbox/);

    await inbox.shutdown();
  }, 15000);

  it('slow-path: a malformed row landing during a blocked claim rejects the claim with corrupt-inbox-row', async () => {
    // Slow-path covers the LISTEN-driven re-fetch via wakeWaiter. A direct
    // INSERT does NOT issue pg_notify (only inbox.queue does), so we
    // INSERT the malformed row, then call inbox.queue() with a different
    // cursor on the same session to force a NOTIFY. The waiter at the
    // malformed row's cursor will wake, re-fetch, hit the corrupt row,
    // and reject.
    const { db, inbox } = await makeInbox();

    // Block on cursor 0; the malformed row will be inserted there.
    const claimP = inbox.claim('s-corrupt-2', 0, 5000);
    // Give the LISTEN time to install.
    await new Promise((r) => setTimeout(r, 100));
    // Insert the malformed row directly at cursor 0. No NOTIFY yet.
    await insertLegacyRow(db, 's-corrupt-2', 0, {
      role: 'user',
      content: 'malformed',
    });
    // Trigger a NOTIFY by queuing a (well-formed) entry at a different
    // cursor — this wakes the waiter, which re-fetches its own cursor 0
    // and hits the corruption.
    await inbox.queue('s-corrupt-2', {
      type: 'user-message',
      payload: { role: 'user', content: 'wake me' },
      reqId: 'r-wake',
    });

    let caught: unknown;
    try {
      await claimP;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('corrupt-inbox-row');

    await inbox.shutdown();
  }, 15000);
});
