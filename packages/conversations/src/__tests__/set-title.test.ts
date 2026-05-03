import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { PluginError } from '@ax/core';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createConversationsPlugin } from '../plugin.js';
import type {
  CreateInput,
  CreateOutput,
  DeleteInput,
  GetMetadataInput,
  GetMetadataOutput,
  SetTitleInput,
  SetTitleOutput,
} from '../types.js';

// ---------------------------------------------------------------------------
// Phase F (2026-05-03). conversations:set-title — update an existing
// conversation row's title post-creation. Used by the Phase F
// auto-title pipeline (after the first user/assistant exchange) and any
// future user-driven rename UI.
//
// Semantics the harness exercises:
//   - happy path: ifNull undefined, row exists, returns { updated: true }
//   - agents:resolve forbidden / not-found propagate unchanged, store
//     untouched
//   - idempotent overwrite (ifNull undefined, repeat title) → still
//     returns updated=true (the SQL UPDATE matches every time)
//   - validation: empty / oversized title → invalid-payload
//   - ifNull=true gates on title IS NULL: hits null row, no-ops on
//     already-titled row (returns { updated: false })
//   - not-found: missing id, soft-deleted row, cross-tenant userId
// ---------------------------------------------------------------------------

interface MockResolveCall {
  agentId: string;
  userId: string;
}

interface MockResolvePolicy {
  decide(call: MockResolveCall): 'allow' | 'forbid' | 'notfound';
}

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

async function makeHarness(policy: MockResolvePolicy): Promise<{
  h: TestHarness;
  resolveCalls: MockResolveCall[];
}> {
  const resolveCalls: MockResolveCall[] = [];
  const h = await createTestHarness({
    services: {
      'agents:resolve': async (
        _ctx,
        input: unknown,
      ): Promise<{ agent: { id: string; workspaceRef: string | null } }> => {
        const call = input as MockResolveCall;
        resolveCalls.push(call);
        const decision = policy.decide(call);
        if (decision === 'allow') {
          return { agent: { id: call.agentId, workspaceRef: null } };
        }
        if (decision === 'notfound') {
          throw new PluginError({
            code: 'not-found',
            plugin: 'mock-agents',
            hookName: 'agents:resolve',
            message: `agent '${call.agentId}' not found`,
          });
        }
        throw new PluginError({
          code: 'forbidden',
          plugin: 'mock-agents',
          hookName: 'agents:resolve',
          message: `agent '${call.agentId}' not accessible to '${call.userId}'`,
        });
      },
      // Phase D — workspace reads aren't exercised here.
      'workspace:list': async () => ({ paths: [] as string[] }),
      'workspace:read': async () => ({ found: false }) as const,
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createConversationsPlugin(),
    ],
  });
  harnesses.push(h);
  return { h, resolveCalls };
}

async function readTitleFromDb(
  conversationId: string,
): Promise<string | null | undefined> {
  // undefined → row absent. null → row present, title NULL. string → titled.
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const r = await client.query<{ title: string | null }>(
      'SELECT title FROM conversations_v1_conversations WHERE conversation_id = $1',
      [conversationId],
    );
    if (r.rowCount === 0) return undefined;
    return r.rows[0]!.title;
  } finally {
    await client.end().catch(() => {});
  }
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    await h.close({ onError: () => {} });
  }
  const cleanup = new pg.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS conversations_v1_turns');
    await cleanup.query('DROP TABLE IF EXISTS conversations_v1_conversations');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await container.stop();
});

describe('conversations:set-title', () => {
  it('happy path: sets title on an existing conversation, returns updated=true', async () => {
    const { h, resolveCalls } = await makeHarness({ decide: () => 'allow' });
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    resolveCalls.length = 0;

    const out = await h.bus.call<SetTitleInput, SetTitleOutput>(
      'conversations:set-title',
      h.ctx({ userId: 'userA' }),
      { conversationId: conv.conversationId, userId: 'userA', title: 'Hello' },
    );
    expect(out).toEqual({ updated: true });

    // agents:resolve was invoked with the conversation's agentId.
    expect(resolveCalls).toEqual([{ agentId: 'agt_a', userId: 'userA' }]);

    // Title persisted.
    const md = await h.bus.call<GetMetadataInput, GetMetadataOutput>(
      'conversations:get-metadata',
      h.ctx({ userId: 'userA' }),
      { conversationId: conv.conversationId, userId: 'userA' },
    );
    expect(md.title).toBe('Hello');
  });

  it('agents:resolve forbidden propagates as forbidden; store untouched', async () => {
    // First create with allow, then flip to forbid.
    let allow = true;
    const { h } = await makeHarness({
      decide: () => (allow ? 'allow' : 'forbid'),
    });
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    allow = false;

    let caught: unknown;
    try {
      await h.bus.call<SetTitleInput, SetTitleOutput>(
        'conversations:set-title',
        h.ctx({ userId: 'userA' }),
        {
          conversationId: conv.conversationId,
          userId: 'userA',
          title: 'forbidden-write',
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('forbidden');
    expect((caught as PluginError).plugin).toBe('@ax/conversations');

    // Store NOT touched — title still null.
    expect(await readTitleFromDb(conv.conversationId)).toBeNull();
  });

  it("agents:resolve 'not-found' propagates as not-found from set-title", async () => {
    let allow = true;
    const { h } = await makeHarness({
      decide: () => (allow ? 'allow' : 'notfound'),
    });
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    allow = false;

    let caught: unknown;
    try {
      await h.bus.call<SetTitleInput, SetTitleOutput>(
        'conversations:set-title',
        h.ctx({ userId: 'userA' }),
        { conversationId: conv.conversationId, userId: 'userA', title: 'x' },
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as PluginError).code).toBe('not-found');
    expect(await readTitleFromDb(conv.conversationId)).toBeNull();
  });

  it('idempotent overwrite (ifNull undefined): repeat call still returns updated=true', async () => {
    const { h } = await makeHarness({ decide: () => 'allow' });
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );

    const a = await h.bus.call<SetTitleInput, SetTitleOutput>(
      'conversations:set-title',
      h.ctx({ userId: 'userA' }),
      { conversationId: conv.conversationId, userId: 'userA', title: 'same' },
    );
    expect(a).toEqual({ updated: true });

    const b = await h.bus.call<SetTitleInput, SetTitleOutput>(
      'conversations:set-title',
      h.ctx({ userId: 'userA' }),
      { conversationId: conv.conversationId, userId: 'userA', title: 'same' },
    );
    expect(b).toEqual({ updated: true });

    expect(await readTitleFromDb(conv.conversationId)).toBe('same');
  });

  it('rejects empty title with invalid-payload', async () => {
    const { h } = await makeHarness({ decide: () => 'allow' });
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    let caught: unknown;
    try {
      await h.bus.call<SetTitleInput, SetTitleOutput>(
        'conversations:set-title',
        h.ctx({ userId: 'userA' }),
        { conversationId: conv.conversationId, userId: 'userA', title: '' },
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as PluginError).code).toBe('invalid-payload');
    expect((caught as PluginError).plugin).toBe('@ax/conversations');
  });

  it('rejects 257-char title with invalid-payload', async () => {
    const { h } = await makeHarness({ decide: () => 'allow' });
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    let caught: unknown;
    try {
      await h.bus.call<SetTitleInput, SetTitleOutput>(
        'conversations:set-title',
        h.ctx({ userId: 'userA' }),
        {
          conversationId: conv.conversationId,
          userId: 'userA',
          title: 'x'.repeat(257),
        },
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as PluginError).code).toBe('invalid-payload');
  });

  it('ifNull=true on a null-title row sets the title and returns updated=true', async () => {
    const { h } = await makeHarness({ decide: () => 'allow' });
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );

    const out = await h.bus.call<SetTitleInput, SetTitleOutput>(
      'conversations:set-title',
      h.ctx({ userId: 'userA' }),
      {
        conversationId: conv.conversationId,
        userId: 'userA',
        title: 'first-title',
        ifNull: true,
      },
    );
    expect(out).toEqual({ updated: true });
    expect(await readTitleFromDb(conv.conversationId)).toBe('first-title');
  });

  it('ifNull=true on an already-titled row returns updated=false; row unchanged', async () => {
    const { h } = await makeHarness({ decide: () => 'allow' });
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a', title: 'Existing' },
    );

    const out = await h.bus.call<SetTitleInput, SetTitleOutput>(
      'conversations:set-title',
      h.ctx({ userId: 'userA' }),
      {
        conversationId: conv.conversationId,
        userId: 'userA',
        title: 'should-not-write',
        ifNull: true,
      },
    );
    expect(out).toEqual({ updated: false });
    expect(await readTitleFromDb(conv.conversationId)).toBe('Existing');
  });

  it('throws not-found on a missing conversationId; never calls agents:resolve', async () => {
    const { h, resolveCalls } = await makeHarness({ decide: () => 'allow' });

    let caught: unknown;
    try {
      await h.bus.call<SetTitleInput, SetTitleOutput>(
        'conversations:set-title',
        h.ctx({ userId: 'userA' }),
        {
          conversationId: 'cnv_does_not_exist',
          userId: 'userA',
          title: 'x',
        },
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as PluginError).code).toBe('not-found');
    expect((caught as PluginError).plugin).toBe('@ax/conversations');
    // Existence-leak check: we filtered by user_id BEFORE calling agents:resolve.
    expect(resolveCalls).toHaveLength(0);
  });

  it('throws not-found on a soft-deleted row', async () => {
    const { h } = await makeHarness({ decide: () => 'allow' });
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    await h.bus.call<DeleteInput, void>(
      'conversations:delete',
      h.ctx({ userId: 'userA' }),
      { conversationId: conv.conversationId, userId: 'userA' },
    );

    let caught: unknown;
    try {
      await h.bus.call<SetTitleInput, SetTitleOutput>(
        'conversations:set-title',
        h.ctx({ userId: 'userA' }),
        { conversationId: conv.conversationId, userId: 'userA', title: 'x' },
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as PluginError).code).toBe('not-found');
  });

  it('cross-tenant userId surfaces as not-found (no existence-leak)', async () => {
    const { h, resolveCalls } = await makeHarness({ decide: () => 'allow' });
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    resolveCalls.length = 0;

    let caught: unknown;
    try {
      await h.bus.call<SetTitleInput, SetTitleOutput>(
        'conversations:set-title',
        h.ctx({ userId: 'userB' }),
        {
          conversationId: conv.conversationId,
          userId: 'userB',
          title: 'sneaky',
        },
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as PluginError).code).toBe('not-found');
    // userId mismatch resolves to not-found BEFORE agents:resolve fires.
    expect(resolveCalls).toHaveLength(0);

    // Original row's title is still null.
    expect(await readTitleFromDb(conv.conversationId)).toBeNull();
  });
});
