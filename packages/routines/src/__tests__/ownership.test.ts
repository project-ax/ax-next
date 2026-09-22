/**
 * TASK-397 — a routine is owned by its agent, not by whoever last edited the
 * file.
 *
 * The hazard these tests pin down: `.ax/routines/<name>.md` lives in the agent
 * workspace, and since TASK-257 partitioned that workspace on `agentId` alone,
 * a TEAM agent's workspace is genuinely shared. The sync path used to stamp
 * the author of every `workspace:applied` delta onto the row, and `fire.ts`
 * fires the routine as that stored user, with that user's credential scope.
 * So the second authorised person to touch a teammate's routine silently took
 * over its schedule — and nothing in the UI said so.
 *
 * These go through the REAL store against a real postgres, the real
 * `handleWorkspaceApplied` and the real `createFireRoutine`, because the bug
 * lived in the seam between them: an `ON CONFLICT ... DO UPDATE SET
 * author_user_id = excluded.author_user_id` in one file, read back as an
 * execution identity in another. A unit test of either half alone passes
 * happily while the pair is broken.
 */
import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import {
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { HookBus, PluginError, makeAgentContext, type AgentContext } from '@ax/core';
import { runRoutinesMigration, type RoutinesDatabase } from '../migrations.js';
import { createRoutinesStore, type RoutinesStore } from '../store.js';
import { handleWorkspaceApplied } from '../sync.js';
import { createFireRoutine, type FireDeps, type PendingFires } from '../fire.js';

pg.types.setTypeParser(20, (v) => Number(v));

let container: StartedPostgreSqlContainer;
let db: Kysely<RoutinesDatabase>;

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  db = new Kysely<RoutinesDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: container.getConnectionUri() }) }),
  });
  await runRoutinesMigration(db);
}, 120_000);

afterEach(async () => {
  await sql`TRUNCATE routines_v1_definitions, routines_v1_fires`.execute(db);
});

afterAll(async () => {
  await db.destroy();
  if (container) await stopPostgresContainer(container);
}, 60_000);

const ENC = new TextEncoder();
const PATH = '.ax/routines/standup.md';
const TEAM_AGENT = 'agt_team';

/** A valid interval routine. `body` varies so the spec hash changes on edit. */
function routineFile(body: string): Uint8Array {
  return ENC.encode([
    '---', 'name: standup', 'description: d',
    'trigger:', '  kind: interval', '  every: "60s"',
    'conversation: per-fire', '---', body,
  ].join('\n') + '\n');
}

function ctx(userId: string): AgentContext {
  return makeAgentContext({ sessionId: 's', agentId: TEAM_AGENT, userId });
}

/**
 * Drive one `workspace:applied` as `writerUserId`. No webhook trigger and no
 * deletes, so nothing on the bus is reached — the fake bus below is only here
 * to satisfy the dependency shape.
 */
async function applyAs(
  store: RoutinesStore,
  writerUserId: string,
  kind: 'added' | 'modified',
  body: string,
): Promise<void> {
  await handleWorkspaceApplied(
    {
      store,
      bus: new HookBus(),
      webhookRoutes: new Map<string, () => void>(),
      fireRoutine: async () => ({
        status: 'ok' as const, conversationId: 'c', error: null, renderedPrompt: 'p',
      }),
    },
    ctx(writerUserId),
    {
      before: null,
      after: 'v1' as unknown as ReturnType<typeof import('@ax/core').asWorkspaceVersion>,
      author: { agentId: TEAM_AGENT, userId: writerUserId },
      changes: [{ path: PATH, kind, contentAfter: async () => routineFile(body) }],
    },
    new Date('2026-09-18T09:00:00Z'),
  );
}

/** Records every identity the fire path hands to each hook it calls. */
interface FireIdentities {
  resolve: string[];
  conversationCreate: string[];
  invokeCtx: string[];
}

function makeFireBus(seen: FireIdentities): HookBus {
  const bus = new HookBus();
  bus.registerService('agents:resolve', 'test', async (_c, input) => {
    const i = input as { agentId: string; userId: string };
    seen.resolve.push(i.userId);
    return { agent: { id: i.agentId, ownerId: 'team_1', workspaceRef: null } };
  });
  bus.registerService('conversations:create', 'test', async (_c, input) => {
    seen.conversationCreate.push((input as { userId: string }).userId);
    return { conversationId: 'cnv_1' };
  });
  bus.registerService('agent:invoke', 'test', async (c) => {
    seen.invokeCtx.push(c.userId);
    return { kind: 'complete', messages: [] };
  });
  return bus;
}

async function fireStoredRoutine(store: RoutinesStore): Promise<FireIdentities> {
  const seen: FireIdentities = { resolve: [], conversationCreate: [], invokeCtx: [] };
  const row = await store.findOne({ agentId: TEAM_AGENT, path: PATH });
  expect(row).not.toBeNull();
  const pending: PendingFires = new Map();
  const fire = createFireRoutine({ bus: makeFireBus(seen), pending } as FireDeps);
  const result = await fire(row!, 'tick');
  expect(result.status).toBe('ok');
  // `agent:invoke` is fire-and-forget (`void deps.bus.call(...)`), so let the
  // microtask that carries it run before reading what it saw.
  await new Promise((r) => { setImmediate(r); });
  return seen;
}

describe('TASK-397 — routine ownership does not follow the file writer', () => {
  it('a teammate editing the file does not take over the routine', async () => {
    const store = createRoutinesStore(db);

    // u_alice creates the routine in the shared (team) agent workspace.
    await applyAs(store, 'u_alice', 'added', 'stand up');
    const afterCreate = await store.findOne({ agentId: TEAM_AGENT, path: PATH });
    expect(afterCreate?.ownerUserId).toBe('u_alice');

    // u_bob — also authorised for this agent — edits the same file.
    await applyAs(store, 'u_bob', 'modified', 'stand up, differently');

    // The edit lands…
    const afterEdit = await store.findOne({ agentId: TEAM_AGENT, path: PATH });
    expect(afterEdit?.promptBody).toBe('stand up, differently');
    // …and the ownership does NOT. On main this row reads 'u_bob'.
    expect(afterEdit?.ownerUserId).toBe('u_alice');
  });

  it('the execution identity is unchanged after a different authorised user writes the file', async () => {
    const store = createRoutinesStore(db);

    await applyAs(store, 'u_alice', 'added', 'stand up');
    const before = await fireStoredRoutine(store);

    await applyAs(store, 'u_bob', 'modified', 'stand up, differently');
    const after = await fireStoredRoutine(store);

    // Every identity the fire path uses — the ACL gate, the conversation it
    // opens, and the context the turn actually runs in — is the same before
    // and after Bob's write. On main, `after` is u_bob throughout, which is
    // Bob's credential scope running Alice's schedule.
    expect(after).toEqual(before);
    expect(after.resolve).toEqual(['u_alice']);
    expect(after.conversationCreate).toEqual(['u_alice']);
    expect(after.invokeCtx).toEqual(['u_alice']);
  });

  it('the fire stays bounded by agents:resolve — a denied identity does not fire', async () => {
    // The bound TASK-397 must not widen: removing the per-writer key does not
    // remove the gate. If `agents:resolve` refuses the owner, nothing runs.
    const store = createRoutinesStore(db);
    await applyAs(store, 'u_alice', 'added', 'stand up');
    const row = await store.findOne({ agentId: TEAM_AGENT, path: PATH });

    const bus = new HookBus();
    let invoked = 0;
    bus.registerService('agents:resolve', 'test', () => {
      throw new PluginError({ code: 'forbidden', plugin: 'test', message: 'no' });
    });
    bus.registerService('conversations:create', 'test', async () => ({ conversationId: 'c' }));
    bus.registerService('agent:invoke', 'test', async () => { invoked += 1; return {}; });

    const fire = createFireRoutine({ bus, pending: new Map() } as FireDeps);
    const result = await fire(row!, 'tick');
    expect(result.status).toBe('error');
    expect(result.error).toContain('forbidden');
    expect(invoked).toBe(0);
  });
});

describe('TASK-397 — reconcileOwners re-derives ownership from the agent', () => {
  it('moves a drifted row back to the agent owner and reports how many it corrected', async () => {
    const store = createRoutinesStore(db);
    await applyAs(store, 'u_alice', 'added', 'stand up');

    // Simulate a pre-TASK-397 row that the old ON CONFLICT had re-owned, or a
    // routine created by a teammate before ownership transferred.
    await sql`
      UPDATE routines_v1_definitions SET owner_user_id = 'u_bob'
    `.execute(db);

    const corrected = await store.reconcileOwners({
      agents: [{ agentId: TEAM_AGENT, ownerUserId: 'u_owner' }],
    });
    expect(corrected).toBe(1);
    const row = await store.findOne({ agentId: TEAM_AGENT, path: PATH });
    expect(row?.ownerUserId).toBe('u_owner');

    // Idempotent: a steady-state tick corrects nothing.
    expect(await store.reconcileOwners({
      agents: [{ agentId: TEAM_AGENT, ownerUserId: 'u_owner' }],
    })).toBe(0);
  });

  it('leaves rows of agents that are NOT in the list alone', async () => {
    // `agents:list-personal-owners` returns user-owned agents only, so a
    // team-owned agent never appears in `agents`. Its routines must not be
    // rewritten — a team id is not a user, and this must not invent one.
    const store = createRoutinesStore(db);
    await applyAs(store, 'u_alice', 'added', 'stand up');

    const corrected = await store.reconcileOwners({
      agents: [{ agentId: 'agt_someone_else', ownerUserId: 'u_other' }],
    });
    expect(corrected).toBe(0);
    const row = await store.findOne({ agentId: TEAM_AGENT, path: PATH });
    expect(row?.ownerUserId).toBe('u_alice');
  });

  it('does not touch updated_at — correcting an identity is not an edit', async () => {
    const store = createRoutinesStore(db);
    await applyAs(store, 'u_alice', 'added', 'stand up');
    const before = await db.selectFrom('routines_v1_definitions')
      .select(['updated_at']).executeTakeFirstOrThrow();

    await store.reconcileOwners({
      agents: [{ agentId: TEAM_AGENT, ownerUserId: 'u_owner' }],
    });

    const after = await db.selectFrom('routines_v1_definitions')
      .select(['updated_at']).executeTakeFirstOrThrow();
    expect(after.updated_at.toISOString()).toBe(before.updated_at.toISOString());
  });
});

describe('TASK-397 — migration', () => {
  it('renames author_user_id to owner_user_id, carrying values across', async () => {
    // Stand up a table in the pre-TASK-397 shape in its own schema, then run
    // the migration against it. This is the upgrade path every existing
    // deployment takes; a fresh CREATE TABLE would not exercise the rename.
    await sql`DROP SCHEMA IF EXISTS t397_legacy CASCADE`.execute(db);
    await sql`CREATE SCHEMA t397_legacy`.execute(db);
    // A dedicated Kysely whose POOL pins the search_path. `SET search_path`
    // on the shared pool would bind to one checked-out connection and the
    // next statement could land on another.
    const legacy = new Kysely<RoutinesDatabase>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({
          connectionString: container.getConnectionUri(),
          options: '-c search_path=t397_legacy',
        }),
      }),
    });
    try {
      await sql`
        CREATE TABLE routines_v1_definitions (
          agent_id TEXT NOT NULL, path TEXT NOT NULL,
          author_user_id TEXT NOT NULL,
          name TEXT NOT NULL, description TEXT NOT NULL, spec_hash TEXT NOT NULL,
          trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('interval','cron','webhook')),
          trigger_spec JSONB NOT NULL, active_hours JSONB,
          silence_token TEXT, silence_max INTEGER NOT NULL DEFAULT 300,
          conversation TEXT NOT NULL CHECK (conversation IN ('per-fire','shared')),
          prompt_body TEXT NOT NULL,
          next_run_at TIMESTAMPTZ, last_run_at TIMESTAMPTZ,
          last_status TEXT, last_error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (agent_id, path)
        )
      `.execute(legacy);
      await sql`
        INSERT INTO routines_v1_definitions
          (agent_id, path, author_user_id, name, description, spec_hash,
           trigger_kind, trigger_spec, conversation, prompt_body)
        VALUES ('agt_legacy', '.ax/routines/old.md', 'u_legacy', 'old', 'd', 'h',
                'interval', ${'{"kind":"interval","every":"60s"}'}::jsonb,
                'per-fire', 'body')
      `.execute(legacy);

      await runRoutinesMigration(legacy);

      const cols = await sql<{ column_name: string }>`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 't397_legacy'
           AND table_name = 'routines_v1_definitions'
      `.execute(legacy);
      const names = cols.rows.map((r) => r.column_name);
      expect(names).toContain('owner_user_id');
      expect(names).not.toContain('author_user_id');

      const row = await sql<{ owner_user_id: string }>`
        SELECT owner_user_id FROM routines_v1_definitions WHERE agent_id = 'agt_legacy'
      `.execute(legacy);
      expect(row.rows[0]?.owner_user_id).toBe('u_legacy');

      // Idempotent: running it a second time is a no-op, not an error.
      await runRoutinesMigration(legacy);
    } finally {
      await legacy.destroy();
      await sql`DROP SCHEMA IF EXISTS t397_legacy CASCADE`.execute(db);
    }
  });
});
