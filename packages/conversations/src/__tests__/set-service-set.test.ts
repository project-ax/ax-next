import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { PluginError } from '@ax/core';
import {
  createTestHarness,
  type TestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createConversationsPlugin } from '../plugin.js';
import type {
  CreateInput,
  CreateOutput,
  GetInput,
  GetOutput,
  SetServiceSetInput,
  SetServiceSetOutput,
} from '../types.js';


interface MockResolveCall {
  agentId: string;
  userId: string;
}

interface MockResolvePolicy {
  decide(call: MockResolveCall): 'allow' | 'forbid' | 'notfound';
  /**
   * Test seam for race-window simulation. Runs AFTER the policy
   * decides 'allow' but BEFORE we return the resolved agent. This is
   * the same point in the call graph where a concurrent caller could
   * delete the conversation row — the handler has already loaded the
   * row, but hasn't yet called store.setTitle.
   */
  onAllow?(call: MockResolveCall): Promise<void>;
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
      ): Promise<{ agent: { id: string } }> => {
        const call = input as MockResolveCall;
        resolveCalls.push(call);
        const decision = policy.decide(call);
        if (decision === 'allow') {
          if (policy.onAllow !== undefined) {
            await policy.onAllow(call);
          }
          return { agent: { id: call.agentId } };
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
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createConversationsPlugin(),
    ],
  });
  harnesses.push(h);
  return { h, resolveCalls };
}

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
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
  if (container) await stopPostgresContainer(container);
});

describe('conversations:set-service-set', () => {
  async function create(h: TestHarness, userId: string) {
    return h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId }),
      { userId, agentId: 'agt_a' },
    );
  }
  async function getServiceSet(h: TestHarness, id: string, userId: string) {
    const got = await h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId }),
      { conversationId: id, userId },
    );
    return got.conversation.serviceSet;
  }

  it('get returns serviceSet null by default', async () => {
    const { h } = await makeHarness({ decide: () => 'allow' });
    const conv = await create(h, 'userA');
    expect(await getServiceSet(h, conv.conversationId, 'userA')).toBeNull();
  });

  it('sets and clears serviceSet', async () => {
    const { h } = await makeHarness({ decide: () => 'allow' });
    const conv = await create(h, 'userA');
    const ctx = h.ctx({ userId: 'userA' });
    const set = await h.bus.call<SetServiceSetInput, SetServiceSetOutput>(
      'conversations:set-service-set',
      ctx,
      { conversationId: conv.conversationId, userId: 'userA', serviceSet: 'e2e' },
    );
    expect(set).toEqual({ ok: true });
    expect(await getServiceSet(h, conv.conversationId, 'userA')).toBe('e2e');

    const cleared = await h.bus.call<SetServiceSetInput, SetServiceSetOutput>(
      'conversations:set-service-set',
      ctx,
      { conversationId: conv.conversationId, userId: 'userA', serviceSet: null },
    );
    expect(cleared).toEqual({ ok: true });
    expect(await getServiceSet(h, conv.conversationId, 'userA')).toBeNull();
  });

  it('another user cannot set it (not-found, row untouched)', async () => {
    const { h, resolveCalls } = await makeHarness({ decide: () => 'allow' });
    const conv = await create(h, 'userA');
    resolveCalls.length = 0;
    await expect(
      h.bus.call<SetServiceSetInput, SetServiceSetOutput>(
        'conversations:set-service-set',
        h.ctx({ userId: 'userB' }),
        { conversationId: conv.conversationId, userId: 'userB', serviceSet: 'e2e' },
      ),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect(resolveCalls).toHaveLength(0);
    expect(await getServiceSet(h, conv.conversationId, 'userA')).toBeNull();
  });

  it('a missing conversation is not-found', async () => {
    const { h } = await makeHarness({ decide: () => 'allow' });
    await expect(
      h.bus.call<SetServiceSetInput, SetServiceSetOutput>(
        'conversations:set-service-set',
        h.ctx({ userId: 'userA' }),
        { conversationId: 'cnv_nope', userId: 'userA', serviceSet: 'e2e' },
      ),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('a forbidden agent propagates and leaves the row untouched', async () => {
    let allow = true;
    const { h } = await makeHarness({ decide: () => (allow ? 'allow' : 'forbid') });
    const conv = await create(h, 'userA');
    allow = false;
    await expect(
      h.bus.call<SetServiceSetInput, SetServiceSetOutput>(
        'conversations:set-service-set',
        h.ctx({ userId: 'userA' }),
        { conversationId: conv.conversationId, userId: 'userA', serviceSet: 'e2e' },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    allow = true;
    expect(await getServiceSet(h, conv.conversationId, 'userA')).toBeNull();
  });

  it('rejects an empty or non-string serviceSet as invalid-payload', async () => {
    const { h } = await makeHarness({ decide: () => 'allow' });
    const conv = await create(h, 'userA');
    for (const bad of ['', 7, undefined]) {
      await expect(
        h.bus.call(
          'conversations:set-service-set',
          h.ctx({ userId: 'userA' }),
          { conversationId: conv.conversationId, userId: 'userA', serviceSet: bad },
        ),
      ).rejects.toMatchObject({ code: 'invalid-payload' });
    }
  });

  it('a routine or external turn by the owner passes, like set-title', async () => {
    const { h } = await makeHarness({ decide: () => 'allow' });
    const conv = await create(h, 'userA');
    for (const source of ['routine', 'external'] as const) {
      await h.bus.call<SetServiceSetInput, SetServiceSetOutput>(
        'conversations:set-service-set',
        h.ctx({ userId: 'userA', source }),
        { conversationId: conv.conversationId, userId: 'userA', serviceSet: source },
      );
      expect(await getServiceSet(h, conv.conversationId, 'userA')).toBe(source);
    }
  });
});
