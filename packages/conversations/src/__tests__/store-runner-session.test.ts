import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createConversationsPlugin } from '../plugin.js';
import type {
  CreateInput,
  CreateOutput,
  DeleteInput,
  GetMetadataInput,
  GetMetadataOutput,
  StoreRunnerSessionInput,
  StoreRunnerSessionOutput,
} from '../types.js';

// ---------------------------------------------------------------------------
// Phase B (2026-04-29). conversations:store-runner-session: idempotent
// first-bind for the runner's native session id (I7).
//   - bound first time
//   - re-bind same value: success no-op (already-bound-same)
//   - re-bind different value: PluginError({ code: 'conflict' })
//   - foreign / unknown / tombstoned: PluginError({ code: 'not-found' })
//   - empty / oversize runnerSessionId: PluginError({ code: 'invalid-payload' })
// ---------------------------------------------------------------------------

interface MockAgent {
  id: string;
  workspaceRef: string | null;
}

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

async function makeHarness(args: {
  agents: ReadonlyMap<string, MockAgent>;
}): Promise<TestHarness> {
  const h = await createTestHarness({
    services: {
      'agents:resolve': async (
        _ctx,
        input: unknown,
      ): Promise<{ agent: MockAgent }> => {
        const { agentId } = input as { agentId: string; userId: string };
        const agent = args.agents.get(agentId);
        if (agent === undefined) {
          throw new Error(`mock agents:resolve: unknown agent '${agentId}'`);
        }
        return { agent };
      },
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createConversationsPlugin(),
    ],
  });
  harnesses.push(h);
  return h;
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
  const cleanup = new (await import('pg')).default.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS conversations_v1_turns');
    await cleanup.query(
      'DROP TABLE IF EXISTS conversations_v1_conversations',
    );
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await container.stop();
});

describe('conversations:store-runner-session', () => {
  it('binds runner_session_id on first call; idempotent on repeat with same id', async () => {
    const h = await makeHarness({
      agents: new Map([
        ['agt_demo', { id: 'agt_demo', workspaceRef: null }],
      ]),
    });
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_demo' },
    );

    await h.bus.call<StoreRunnerSessionInput, StoreRunnerSessionOutput>(
      'conversations:store-runner-session',
      h.ctx({ userId: 'userA' }),
      { conversationId: conv.conversationId, runnerSessionId: 'sess_abc' },
    );
    // Idempotent re-bind: same value, no error.
    await h.bus.call<StoreRunnerSessionInput, StoreRunnerSessionOutput>(
      'conversations:store-runner-session',
      h.ctx({ userId: 'userA' }),
      { conversationId: conv.conversationId, runnerSessionId: 'sess_abc' },
    );

    const md = await h.bus.call<GetMetadataInput, GetMetadataOutput>(
      'conversations:get-metadata',
      h.ctx({ userId: 'userA' }),
      { conversationId: conv.conversationId, userId: 'userA' },
    );
    expect(md.runnerSessionId).toBe('sess_abc');
  });

  it('throws conflict on re-bind to a different runnerSessionId', async () => {
    const h = await makeHarness({
      agents: new Map([
        ['agt_demo', { id: 'agt_demo', workspaceRef: null }],
      ]),
    });
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_demo' },
    );
    await h.bus.call<StoreRunnerSessionInput, StoreRunnerSessionOutput>(
      'conversations:store-runner-session',
      h.ctx({ userId: 'userA' }),
      { conversationId: conv.conversationId, runnerSessionId: 'sess_abc' },
    );
    await expect(
      h.bus.call<StoreRunnerSessionInput, StoreRunnerSessionOutput>(
        'conversations:store-runner-session',
        h.ctx({ userId: 'userA' }),
        { conversationId: conv.conversationId, runnerSessionId: 'sess_OTHER' },
      ),
    ).rejects.toMatchObject({ code: 'conflict' });

    // The original value must remain.
    const md = await h.bus.call<GetMetadataInput, GetMetadataOutput>(
      'conversations:get-metadata',
      h.ctx({ userId: 'userA' }),
      { conversationId: conv.conversationId, userId: 'userA' },
    );
    expect(md.runnerSessionId).toBe('sess_abc');
  });

  it('throws not-found on foreign user / unknown id / tombstoned row', async () => {
    const h = await makeHarness({
      agents: new Map([
        ['agt_demo', { id: 'agt_demo', workspaceRef: null }],
      ]),
    });
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_demo' },
    );
    // Foreign user: ctx.userId mismatches owner.
    await expect(
      h.bus.call<StoreRunnerSessionInput, StoreRunnerSessionOutput>(
        'conversations:store-runner-session',
        h.ctx({ userId: 'u-OTHER' }),
        { conversationId: conv.conversationId, runnerSessionId: 'x' },
      ),
    ).rejects.toMatchObject({ code: 'not-found' });

    // Unknown id.
    await expect(
      h.bus.call<StoreRunnerSessionInput, StoreRunnerSessionOutput>(
        'conversations:store-runner-session',
        h.ctx({ userId: 'userA' }),
        { conversationId: 'cnv_unknown', runnerSessionId: 'x' },
      ),
    ).rejects.toMatchObject({ code: 'not-found' });

    // Tombstoned row.
    await h.bus.call<DeleteInput, void>(
      'conversations:delete',
      h.ctx({ userId: 'userA' }),
      { conversationId: conv.conversationId, userId: 'userA' },
    );
    await expect(
      h.bus.call<StoreRunnerSessionInput, StoreRunnerSessionOutput>(
        'conversations:store-runner-session',
        h.ctx({ userId: 'userA' }),
        { conversationId: conv.conversationId, runnerSessionId: 'x' },
      ),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects empty / oversize runnerSessionId at the boundary', async () => {
    const h = await makeHarness({
      agents: new Map([
        ['agt_demo', { id: 'agt_demo', workspaceRef: null }],
      ]),
    });
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_demo' },
    );
    await expect(
      h.bus.call<StoreRunnerSessionInput, StoreRunnerSessionOutput>(
        'conversations:store-runner-session',
        h.ctx({ userId: 'userA' }),
        { conversationId: conv.conversationId, runnerSessionId: '' },
      ),
    ).rejects.toMatchObject({ code: 'invalid-payload' });

    await expect(
      h.bus.call<StoreRunnerSessionInput, StoreRunnerSessionOutput>(
        'conversations:store-runner-session',
        h.ctx({ userId: 'userA' }),
        {
          conversationId: conv.conversationId,
          runnerSessionId: 'x'.repeat(257),
        },
      ),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });
});
