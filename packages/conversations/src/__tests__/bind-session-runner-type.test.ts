import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { createTestHarness, type TestHarness, stopPostgresContainer } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createConversationsPlugin } from '../plugin.js';
import type {
  BindSessionInput,
  BindSessionOutput,
  CreateInput,
  CreateOutput,
  GetMetadataInput,
  GetMetadataOutput,
} from '../types.js';

// ---------------------------------------------------------------------------
// `conversations:bind-session` records WHICH runner is about to serve the turn.
//
// The regression this exists for, found by the §8 acceptance walk (2026-08-21):
// every conversation reported `runnerType: "claude-sdk"`, including ones the
// aisdk runner demonstrably served — the transcript's own header said `aisdk`
// while the row said otherwise. `runner_type` was frozen at create from a
// host-wide config constant, a design that was correct while one host meant one
// runner and became wrong when PR #399 made the runner a per-AGENT choice.
//
// The property under test is specifically that the value FOLLOWS A SWITCH.
// A test that only checked create would have passed against the buggy code, so
// the cases below all bind at least twice.
// ---------------------------------------------------------------------------

interface MockAgent {
  id: string;
  workspaceRef: string | null;
  runner?: string;
}

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

async function makeHarness(
  agents: ReadonlyMap<string, MockAgent>,
): Promise<TestHarness> {
  const h = await createTestHarness({
    services: {
      'agents:resolve': async (
        _ctx,
        input: unknown,
      ): Promise<{ agent: MockAgent }> => {
        const { agentId } = input as { agentId: string };
        const agent = agents.get(agentId);
        if (agent === undefined) {
          throw new Error(`mock agents:resolve: unknown agent '${agentId}'`);
        }
        return { agent };
      },
      'workspace:list': async () => ({ paths: [] as string[] }),
      'workspace:read': async () => ({ found: false }) as const,
      'workspace:apply': async () => ({
        version: 'v-stub',
        delta: { before: null, after: 'v-stub', changes: [] },
      }),
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

const AGENTS = new Map<string, MockAgent>([
  ['agt_x', { id: 'agt_x', workspaceRef: null, runner: 'claude-sdk' }],
]);

async function seedConversation(h: TestHarness): Promise<string> {
  const conv = await h.bus.call<CreateInput, CreateOutput>(
    'conversations:create',
    h.ctx({ userId: 'u1' }),
    { userId: 'u1', agentId: 'agt_x' },
  );
  return conv.conversationId;
}

async function bind(
  h: TestHarness,
  conversationId: string,
  input: Partial<BindSessionInput>,
): Promise<void> {
  await h.bus.call<BindSessionInput, BindSessionOutput>(
    'conversations:bind-session',
    h.ctx({ userId: 'u1' }),
    {
      conversationId,
      sessionId: 'sess-1',
      reqId: 'req-1',
      ...input,
    } as BindSessionInput,
  );
}

async function readRunnerType(
  h: TestHarness,
  conversationId: string,
): Promise<string | null> {
  const meta = await h.bus.call<GetMetadataInput, GetMetadataOutput>(
    'conversations:get-metadata',
    h.ctx({ userId: 'u1' }),
    { conversationId, userId: 'u1' },
  );
  return meta.runnerType;
}

describe('conversations:bind-session — runner_type follows the runner', () => {
  it('overwrites the seeded value when the agent switches runner', async () => {
    // THE regression. Create under claude-sdk, then bind as aisdk — which is
    // exactly what the host does after someone PATCHes `agents.runner`.
    const h = await makeHarness(AGENTS);
    const id = await seedConversation(h);
    expect(await readRunnerType(h, id)).toBe('claude-sdk');

    await bind(h, id, { runnerType: 'aisdk' });
    expect(await readRunnerType(h, id)).toBe('aisdk');

    // ...and back again, because switching is not one-way.
    await bind(h, id, { runnerType: 'claude-sdk' });
    expect(await readRunnerType(h, id)).toBe('claude-sdk');
  });

  it('leaves the stored value alone when the caller omits runnerType', async () => {
    // "I don't know which runner" must never be able to erase a value that
    // was right. Omission is not the same as null.
    const h = await makeHarness(AGENTS);
    const id = await seedConversation(h);
    await bind(h, id, { runnerType: 'aisdk' });

    await bind(h, id, {});
    expect(await readRunnerType(h, id)).toBe('aisdk');
  });

  it('rejects a malformed runner id instead of storing it', async () => {
    const h = await makeHarness(AGENTS);
    const id = await seedConversation(h);
    await expect(
      bind(h, id, { runnerType: 'Not A Runner Id' }),
    ).rejects.toThrow(/runnerType/);
    // The rejected bind must not have moved the stored value.
    expect(await readRunnerType(h, id)).toBe('claude-sdk');
  });

  it('still binds the session when runnerType is absent', async () => {
    // Back-compat: the field is optional on the wire, so an older caller
    // (or a preset without @ax/chat-orchestrator) keeps working.
    const h = await makeHarness(AGENTS);
    const id = await seedConversation(h);
    await expect(bind(h, id, {})).resolves.toBeUndefined();
  });
});
