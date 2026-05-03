import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { PluginError } from '@ax/core';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createConversationsPlugin } from '../plugin.js';
import type {
  CreateInput,
  CreateOutput,
  DeleteInput,
  GetByReqIdInput,
  GetByReqIdOutput,
  GetInput,
  GetOutput,
  ListInput,
  ListOutput,
} from '../types.js';

// ---------------------------------------------------------------------------
// ACL gate test — every conversations:* hook MUST call agents:resolve
// before touching the store (Invariant J1). We mock agents:resolve via a
// programmable handler so each test can declare exactly which (agentId,
// userId) tuples are reachable.
// ---------------------------------------------------------------------------

interface MockResolveCall {
  agentId: string;
  userId: string;
}

interface MockResolvePolicy {
  /**
   * Return value:
   *   - 'allow'    → resolve succeeds (returns a stub agent).
   *   - 'forbid'   → resolve throws PluginError code='forbidden'.
   *   - 'notfound' → resolve throws PluginError code='not-found'.
   */
  decide(call: MockResolveCall): 'allow' | 'forbid' | 'notfound';
}

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

async function setReqIdViaStore(
  _h: TestHarness,
  conversationId: string,
  reqId: string | null,
): Promise<void> {
  // Task 14 will own active_req_id via `conversations:bind-session`;
  // until then, raw SQL through pg.Client is the simplest fixture.
  const client = new (await import('pg')).default.Client({ connectionString });
  await client.connect();
  try {
    await client.query(
      'UPDATE conversations_v1_conversations SET active_req_id = $1, updated_at = NOW() WHERE conversation_id = $2',
      [reqId, conversationId],
    );
  } finally {
    await client.end().catch(() => {});
  }
}

async function makeHarness(policy: MockResolvePolicy): Promise<{
  h: TestHarness;
  calls: MockResolveCall[];
}> {
  const calls: MockResolveCall[] = [];
  const h = await createTestHarness({
    services: {
      'agents:resolve': async (
        _ctx,
        input: unknown,
      ): Promise<{ agent: { id: string; visibility: string } }> => {
        const call = input as MockResolveCall;
        calls.push(call);
        const decision = policy.decide(call);
        if (decision === 'allow') {
          return {
            agent: { id: call.agentId, visibility: 'personal' },
          };
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
      // Phase D — conversations:get reads from workspace jsonl. ACL
      // tests don't exercise that path; default to "no jsonl" so
      // happy-path gets return empty turns without a workspace
      // round-trip past the gate.
      'workspace:list': async () => ({ paths: [] as string[] }),
      'workspace:read': async () => ({ found: false }) as const,
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createConversationsPlugin(),
    ],
  });
  harnesses.push(h);
  return { h, calls };
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
  // Drop tables so each test starts fresh.
  const cleanup = new (await import('pg')).default.Client({ connectionString });
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

describe('@ax/conversations ACL gate', () => {
  it('every hook calls agents:resolve before touching the store', async () => {
    // Allow everything. We assert that create / get / delete each fire
    // an agents:resolve call so a future regression that bypasses the
    // gate breaks this test.
    const { h, calls } = await makeHarness({
      decide: () => 'allow',
    });

    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    expect(calls).toEqual([{ agentId: 'agt_a', userId: 'userA' }]);

    // get + delete also gate.
    await h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, userId: 'userA' },
    );
    expect(calls).toHaveLength(2);

    await h.bus.call<DeleteInput, void>(
      'conversations:delete',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, userId: 'userA' },
    );
    expect(calls).toHaveLength(3);
  });

  it('list with agentId calls agents:resolve; list without does NOT (implicit ACL via user_id)', async () => {
    const { h, calls } = await makeHarness({
      decide: () => 'allow',
    });

    // No agentId → implicit ACL, no resolve call.
    await h.bus.call<ListInput, ListOutput>(
      'conversations:list',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA' },
    );
    expect(calls).toHaveLength(0);

    // With agentId → resolve gate fires.
    await h.bus.call<ListInput, ListOutput>(
      'conversations:list',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    expect(calls).toEqual([{ agentId: 'agt_a', userId: 'userA' }]);
  });

  it('forbidden agent: User A creates a conversation; User B cannot get it', async () => {
    // userA is allowed; userB is forbidden for the same agent.
    const { h } = await makeHarness({
      decide: ({ userId }) => (userId === 'userA' ? 'allow' : 'forbid'),
    });

    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );

    // userB calls get with the matching userId (so the user_id filter
    // would let it through), but agents:resolve forbids → 'forbidden'.
    // Note: in conversations:get the row is filtered by userId first;
    // userB is NOT the owner of the conversation, so this case
    // collapses to 'not-found' before even calling agents:resolve.
    let caught: unknown;
    try {
      await h.bus.call<GetInput, GetOutput>(
        'conversations:get',
        h.ctx({ userId: 'userB' }),
        { conversationId: created.conversationId, userId: 'userB' },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('not-found');
  });

  it('agents:resolve forbid on userA propagates as forbidden from create', async () => {
    // A more direct test: when agents:resolve denies the creator's own
    // request, conversations:create rejects with 'forbidden'.
    const { h } = await makeHarness({ decide: () => 'forbid' });

    let caught: unknown;
    try {
      await h.bus.call<CreateInput, CreateOutput>(
        'conversations:create',
        h.ctx({ userId: 'userA' }),
        { userId: 'userA', agentId: 'agt_a' },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('forbidden');
    expect((caught as PluginError).plugin).toBe('@ax/conversations');
  });

  it("agents:resolve 'not-found' propagates as not-found from create", async () => {
    const { h } = await makeHarness({ decide: () => 'notfound' });

    let caught: unknown;
    try {
      await h.bus.call<CreateInput, CreateOutput>(
        'conversations:create',
        h.ctx({ userId: 'userA' }),
        { userId: 'userA', agentId: 'agt_does_not_exist' },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('not-found');
  });

  it('User C cannot see User A\'s conversations via list-by-user', async () => {
    // Allow both users to create their own — list is a user-filtered
    // read, no agents:resolve when agentId is omitted.
    const { h } = await makeHarness({ decide: () => 'allow' });

    await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a', title: 'A1' },
    );
    await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a', title: 'A2' },
    );
    await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userC' }),
      { userId: 'userC', agentId: 'agt_a', title: 'C1' },
    );

    const cList = await h.bus.call<ListInput, ListOutput>(
      'conversations:list',
      h.ctx({ userId: 'userC' }),
      { userId: 'userC' },
    );
    expect(cList).toHaveLength(1);
    expect(cList[0]!.title).toBe('C1');

    // Sanity: userA sees both of theirs, NOT userC's.
    const aList = await h.bus.call<ListInput, ListOutput>(
      'conversations:list',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA' },
    );
    expect(aList.map((c) => c.title).sort()).toEqual(['A1', 'A2']);
  });

  describe('conversations:get-by-req-id', () => {
    it('returns the row when (userA, reqId) matches', async () => {
      const { h, calls } = await makeHarness({ decide: () => 'allow' });

      const created = await h.bus.call<CreateInput, CreateOutput>(
        'conversations:create',
        h.ctx({ userId: 'userA' }),
        { userId: 'userA', agentId: 'agt_a' },
      );

      // Fixture an active_req_id directly via the store. Task 14 ships
      // the production writer (`conversations:bind-session`); for Task 7
      // we just READ the column.
      await setReqIdViaStore(h, created.conversationId, 'req-deadbeef');

      // Reset call log so we can assert this hook does NOT call agents:resolve.
      calls.length = 0;
      const got = await h.bus.call<GetByReqIdInput, GetByReqIdOutput>(
        'conversations:get-by-req-id',
        h.ctx({ userId: 'userA' }),
        { userId: 'userA', reqId: 'req-deadbeef' },
      );
      expect(got.conversationId).toBe(created.conversationId);
      expect(got.activeReqId).toBe('req-deadbeef');
      // Per the type doc — the route layer is responsible for chaining
      // agents:resolve. The hook itself doesn't gate.
      expect(calls).toHaveLength(0);
    });

    it("returns not-found when userB asks for userA's reqId (J9)", async () => {
      const { h } = await makeHarness({ decide: () => 'allow' });

      const created = await h.bus.call<CreateInput, CreateOutput>(
        'conversations:create',
        h.ctx({ userId: 'userA' }),
        { userId: 'userA', agentId: 'agt_a' },
      );
      await setReqIdViaStore(h, created.conversationId, 'req-secret');

      let caught: unknown;
      try {
        await h.bus.call<GetByReqIdInput, GetByReqIdOutput>(
          'conversations:get-by-req-id',
          h.ctx({ userId: 'userB' }),
          { userId: 'userB', reqId: 'req-secret' },
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PluginError);
      expect((caught as PluginError).code).toBe('not-found');
    });

    it('returns not-found when reqId does not exist (foreign-guess case)', async () => {
      const { h } = await makeHarness({ decide: () => 'allow' });

      let caught: unknown;
      try {
        await h.bus.call<GetByReqIdInput, GetByReqIdOutput>(
          'conversations:get-by-req-id',
          h.ctx({ userId: 'userA' }),
          { userId: 'userA', reqId: 'req-nonexistent' },
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PluginError);
      expect((caught as PluginError).code).toBe('not-found');
    });

    it('skips tombstoned (soft-deleted) rows', async () => {
      const { h } = await makeHarness({ decide: () => 'allow' });

      const created = await h.bus.call<CreateInput, CreateOutput>(
        'conversations:create',
        h.ctx({ userId: 'userA' }),
        { userId: 'userA', agentId: 'agt_a' },
      );
      await setReqIdViaStore(h, created.conversationId, 'req-zombie');
      await h.bus.call<DeleteInput, void>(
        'conversations:delete',
        h.ctx({ userId: 'userA' }),
        { conversationId: created.conversationId, userId: 'userA' },
      );

      let caught: unknown;
      try {
        await h.bus.call<GetByReqIdInput, GetByReqIdOutput>(
          'conversations:get-by-req-id',
          h.ctx({ userId: 'userA' }),
          { userId: 'userA', reqId: 'req-zombie' },
        );
      } catch (err) {
        caught = err;
      }
      expect((caught as PluginError).code).toBe('not-found');
    });

    it('rejects empty / oversize reqId as not-found (boundary)', async () => {
      const { h } = await makeHarness({ decide: () => 'allow' });

      for (const bad of ['', 'x'.repeat(257)]) {
        let caught: unknown;
        try {
          await h.bus.call<GetByReqIdInput, GetByReqIdOutput>(
            'conversations:get-by-req-id',
            h.ctx({ userId: 'userA' }),
            { userId: 'userA', reqId: bad },
          );
        } catch (err) {
          caught = err;
        }
        expect((caught as PluginError).code).toBe('not-found');
      }
    });
  });

  it('soft-deleted conversation is unreachable via get AND list', async () => {
    const { h } = await makeHarness({ decide: () => 'allow' });
    const a = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a', title: 'gone' },
    );
    const b = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a', title: 'kept' },
    );

    await h.bus.call<DeleteInput, void>(
      'conversations:delete',
      h.ctx({ userId: 'userA' }),
      { conversationId: a.conversationId, userId: 'userA' },
    );

    const list = await h.bus.call<ListInput, ListOutput>(
      'conversations:list',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA' },
    );
    expect(list.map((c) => c.title)).toEqual(['kept']);

    let caught: unknown;
    try {
      await h.bus.call<GetInput, GetOutput>(
        'conversations:get',
        h.ctx({ userId: 'userA' }),
        { conversationId: a.conversationId, userId: 'userA' },
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as PluginError).code).toBe('not-found');

    // Sanity: the kept one still works.
    const ok = await h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId: 'userA' }),
      { conversationId: b.conversationId, userId: 'userA' },
    );
    expect(ok.conversation.title).toBe('kept');
  });
});
