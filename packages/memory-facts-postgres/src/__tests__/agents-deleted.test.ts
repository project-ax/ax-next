// TASK-718 — deleting an agent must delete what that agent remembered.
//
// `@ax/agents` fires `agents:deleted` AFTER the agent row is gone, and nothing
// used to delete this engine's rows for it: `memory_facts_v1` is one shared
// table per deployment, partitioned by `agent_key`, so a deleted agent's
// remembered facts about people sat there forever, unreachable (the agents:
// resolve ACL 404s them) but very much still stored.
//
// Every case below was written by asking what it does against the UNFIXED code
// (no subscriber at all) and against the plausible WRONG fixes. The wrong
// fixes that matter:
//   - key the delete off `ctx.agentId` instead of the event's `agentId` — the
//     ctx belongs to whoever ISSUED the delete, so this deletes the wrong
//     agent's memory (or nothing);
//   - skip payload validation — an empty id derives a real key and issues a
//     real DELETE;
//   - let a store failure escape — `fire` isolates it, but only by logging a
//     generic subscriber failure, and the purge's own error line is what an
//     operator greps for.
//
// It builds its own bus and its own Kysely (like `postgres-edges.test.ts`)
// because it needs a SECOND, independent connection to count rows without going
// through the plugin — `recall` only sees active rows, and "is the history
// gone" is a question about every row.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { stopPostgresContainer, startTestContainer } from '@ax/test-harness';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { HookBus, makeAgentContext, type AgentContext, type Logger, type Plugin } from '@ax/core';
import type {
  FactScanInput,
  FactScanOutput,
  RecallInput,
  RecallOutput,
  RecordInput,
  RecordOutput,
} from '@ax/memory-facts-contract';
import { createMemoryFactsPostgresPlugin } from '../plugin.js';
import { agentScopeKey } from '../agent-scope-key.js';
import { runFactsMigration } from '../schema.js';

const JAN = '2023-01-01T00:00:00.000Z';
const JUN = '2023-06-01T00:00:00.000Z';

const DELETED = 'agt_deleted';
const SURVIVOR = 'agt_survivor';

let container: StartedPostgreSqlContainer;
let connectionString: string;

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

afterAll(async () => {
  await stopPostgresContainer(container);
});

interface LogCall {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  bindings: Record<string, unknown> | undefined;
}

/** A logger that remembers what it was told, so a test can assert on it. */
function recordingLogger(calls: LogCall[]): Logger {
  const make = (level: LogCall['level']) => (msg: string, bindings?: Record<string, unknown>) => {
    calls.push({ level, msg, bindings });
  };
  const logger: Logger = {
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    child: () => logger,
  };
  return logger;
}

let calls: LogCall[];
/** The plugin's own pool. Some cases destroy it to simulate an outage. */
let db: Kysely<unknown>;
/** An independent pool that survives `db` being destroyed. */
let observer: Kysely<unknown>;
let bus: HookBus;
let plugin: Plugin;

function ctxFor(agentId: string): AgentContext {
  return makeAgentContext({
    sessionId: 's',
    agentId,
    userId: 'user-1',
    logger: recordingLogger(calls),
    workspace: { rootPath: '/tmp' },
  });
}

beforeEach(async () => {
  calls = [];
  db = new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
  });
  observer = new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
  });
  await runFactsMigration(observer);
  await sql`TRUNCATE memory_facts_v1`.execute(observer);

  bus = new HookBus();
  // Stand in for @ax/database-postgres: the facts plugin only knows the hook.
  bus.registerService<unknown, { db: Kysely<unknown> }>(
    'database:get-instance',
    '@ax/test-database',
    async () => ({ db }),
  );
  plugin = createMemoryFactsPostgresPlugin();
  await plugin.init({ bus, config: {} });
});

afterEach(async () => {
  await db.destroy().catch(() => {});
  await observer.destroy().catch(() => {});
});

/**
 * The same three facts for whichever agent: two values for ONE slot (so the
 * older one is CLOSED history, not an active row) and one slot-less fact. Same
 * user, same `about`/`slot`/values for every agent — only the scope key
 * separates them.
 */
async function seed(agentId: string): Promise<void> {
  const ctx = ctxFor(agentId);
  const record = (statements: RecordInput['statements']) =>
    bus.call<RecordInput, RecordOutput>('memory:facts:record', ctx, { statements });
  await record([
    { about: 'user', relation: 'lives_in', value: 'Boston', when: JAN, slot: 'lives_in', ownerUserId: 'user-1' },
  ]);
  await record([
    { about: 'user', relation: 'lives_in', value: 'Denver', when: JUN, slot: 'lives_in', ownerUserId: 'user-1' },
  ]);
  await record([
    { about: 'user', relation: 'likes_artist', value: 'Khalid', when: JAN, ownerUserId: 'user-1' },
  ]);
}

async function rawCount(agentId: string): Promise<number> {
  const out = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM memory_facts_v1 WHERE agent_key = ${agentScopeKey({ agentId })}
  `.execute(observer);
  return out.rows[0]!.n;
}

function recall(agentId: string): Promise<RecallOutput> {
  return bus.call<RecallInput, RecallOutput>('memory:facts:recall', ctxFor(agentId), {
    about: 'user',
    limit: 50,
  });
}

function scan(agentId: string): Promise<FactScanOutput> {
  return bus.call<FactScanInput, FactScanOutput>('memory:facts:scan', ctxFor(agentId), {
    limit: 50,
  });
}

function fireDeleted(issuer: AgentContext, payload: unknown): Promise<unknown> {
  return bus.fire('agents:deleted', issuer, payload);
}

function errorsLogged(): LogCall[] {
  return calls.filter((c) => c.level === 'error');
}

describe('manifest', () => {
  // Against the unfixed manifest (`subscribes: []`) this is red. It also keeps
  // the declaration honest in the other direction: a subscriber that is bound
  // without being declared is what the kernel's manifest check exists to catch.
  it('declares the agents:deleted subscription', () => {
    expect(createMemoryFactsPostgresPlugin().manifest.subscribes).toContain('agents:deleted');
  });
});

describe('agents:deleted subscriber (TASK-718)', () => {
  it("removes the deleted agent's facts, closed history included, and leaves a sibling agent whole", async () => {
    await seed(DELETED);
    await seed(SURVIVOR);
    // Precondition, so the assertions below can only fail for the right reason:
    // three rows each (the closed Boston row counts), two of them active.
    expect(await rawCount(DELETED)).toBe(3);
    expect(await rawCount(SURVIVOR)).toBe(3);
    const survivorRecall = await recall(SURVIVOR);
    const survivorScan = await scan(SURVIVOR);
    expect(survivorRecall.statements.map((s) => s.value).sort()).toEqual(['Denver', 'Khalid']);
    expect((await recall(DELETED)).statements).toHaveLength(2);

    // A neutral issuer: nobody's agentId in this test is the ctx's.
    await fireDeleted(ctxFor('agt_admin_console'), {
      agentId: DELETED,
      ownerId: 'user-1',
      ownerType: 'user',
    });

    // Gone through the store's own doors...
    expect((await recall(DELETED)).statements).toEqual([]);
    expect((await scan(DELETED)).statements).toEqual([]);
    // ...and gone from the table, including the closed Boston row that no read
    // hook shows — the case a "close them" (rather than "delete them") fix
    // would leave behind.
    expect(await rawCount(DELETED)).toBe(0);

    // The sibling is byte-for-byte what it was, and still recallable.
    expect(await rawCount(SURVIVOR)).toBe(3);
    expect(await recall(SURVIVOR)).toEqual(survivorRecall);
    expect(await scan(SURVIVOR)).toEqual(survivorScan);

    expect(errorsLogged()).toEqual([]);
    const info = calls.find((c) => c.level === 'info' && c.bindings?.agentId === DELETED);
    expect(info?.bindings?.purged).toBe(3);
  });

  // The ctx on a `fire` belongs to whoever issued the delete request (an admin,
  // or the sibling agent's own session), never to the agent being deleted.
  // Against a subscriber that derives the key from `ctx.agentId`, THIS is the
  // case that deletes the survivor's memory and keeps the deleted agent's.
  it("follows the event's agentId, not the agentId of the ctx that issued the delete", async () => {
    await seed(DELETED);
    await seed(SURVIVOR);

    await fireDeleted(ctxFor(SURVIVOR), {
      agentId: DELETED,
      ownerId: 'user-1',
      ownerType: 'user',
    });

    expect(await rawCount(DELETED)).toBe(0);
    expect(await rawCount(SURVIVOR)).toBe(3);
    expect((await recall(SURVIVOR)).statements.map((s) => s.value).sort()).toEqual([
      'Denver',
      'Khalid',
    ]);
  });

  it('is a no-op the second time the event arrives', async () => {
    await seed(DELETED);
    await seed(SURVIVOR);
    const payload = { agentId: DELETED, ownerId: 'user-1', ownerType: 'user' };

    await fireDeleted(ctxFor('agt_admin_console'), payload);
    await fireDeleted(ctxFor('agt_admin_console'), payload);

    expect(await rawCount(DELETED)).toBe(0);
    expect(await rawCount(SURVIVOR)).toBe(3);
    expect(errorsLogged()).toEqual([]);
    const purged = calls
      .filter((c) => c.level === 'info' && c.bindings?.agentId === DELETED)
      .map((c) => c.bindings?.purged);
    // 3 rows the first time, 0 the second: the count is the rows THIS run
    // removed, not a constant.
    expect(purged).toEqual([3, 0]);
  });

  // `fire` isolates a throwing subscriber, so "does not throw" alone would pass
  // for a subscriber that simply blew up. The assertion that names the
  // behaviour is the purge's OWN error line, with the agent id in it, and that
  // nothing was half-deleted.
  it('logs and swallows a store failure instead of throwing', async () => {
    await seed(DELETED);
    await db.destroy(); // the plugin's pool is gone; `observer` still works

    await expect(
      fireDeleted(ctxFor('agt_admin_console'), {
        agentId: DELETED,
        ownerId: 'user-1',
        ownerType: 'user',
      }),
    ).resolves.toMatchObject({ rejected: false });

    const errors = errorsLogged();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.msg).toBe('memory_facts_purge_for_deleted_agent_failed');
    expect(errors[0]!.bindings?.agentId).toBe(DELETED);
    expect(errors[0]!.bindings?.err).toBeDefined();
    expect(await rawCount(DELETED)).toBe(3);
  });

  describe('a malformed payload deletes nothing', () => {
    // A row whose key is the digest of the EMPTY id. Without the guard, an
    // event carrying `agentId: ''` derives exactly this key and deletes it —
    // so this sentinel is what makes the empty-string case observable at all;
    // the two real agents' keys are different digests and could not tell.
    async function insertEmptyIdSentinel(): Promise<void> {
      await sql`
        INSERT INTO memory_facts_v1
          (id, agent_key, about, relation, value, provenance, valid_start, valid_end, transaction_time)
        VALUES
          ('sentinel-1', ${agentScopeKey({ agentId: '' })}, 'user', 'likes_artist', 'Khalid',
           'extracted', ${JAN}, '9999-12-31T23:59:59.999Z', ${JAN})
      `.execute(observer);
    }

    it.each([
      ['no agentId', { ownerId: 'user-1' }],
      ['an empty agentId', { agentId: '' }],
      ['a numeric agentId', { agentId: 42 }],
      ['a null agentId', { agentId: null }],
      ['a null payload', null],
    ])('%s', async (_label, payload) => {
      await seed(DELETED);
      await seed(SURVIVOR);
      await insertEmptyIdSentinel();

      await expect(fireDeleted(ctxFor('agt_admin_console'), payload)).resolves.toMatchObject({ rejected: false });

      expect(await rawCount(DELETED)).toBe(3);
      expect(await rawCount(SURVIVOR)).toBe(3);
      expect(await rawCount('')).toBe(1);
      // Said out loud, at warn: a malformed event is a caller bug, not a store
      // outage, so it is not an error line and not silent.
      expect(calls.filter((c) => c.level === 'warn')).toHaveLength(1);
      expect(errorsLogged()).toEqual([]);
    });
  });
});
