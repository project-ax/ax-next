import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { createTestHarness, type TestHarness, stopPostgresContainer } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createConversationsPlugin } from '../plugin.js';
import type { CreateInput, CreateOutput } from '../types.js';

// ---------------------------------------------------------------------------
// `conversations:create` seeds runner_type and workspace_ref from the RESOLVED
// AGENT.
//
// `workspace_ref` is frozen at create (I10). `runner_type` is not, and that is
// the correction this suite encodes: it used to be frozen from a host-wide
// `ConversationsConfig.defaultRunnerType`, which was right while one host meant
// one runner. PR #399 made the runner a per-AGENT choice, and an agent's runner
// can be switched at any time — so create seeds it from the agent, and
// `conversations:bind-session` refreshes it every turn (see
// bind-session-runner-type.test.ts).
// ---------------------------------------------------------------------------

interface MockAgent {
  id: string;
  workspaceRef: string | null;
  runner?: string;
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
      // Phase D — conversations:get reads transcripts from the
      // workspace's runner-native jsonl. These tests don't exercise
      // that path, so default both hooks to "no jsonl found" → empty
      // turns. Tests that need turns wire up real bytes. Phase B adds
      // workspace:apply for drop-turn; stub for bootstrap.
      'workspace:list': async () => ({ paths: [] as string[] }),
      'workspace:read': async () => ({ found: false }) as const,
      'workspace:apply': async () => ({ version: 'v-stub', delta: { before: null, after: 'v-stub', changes: [] } }),
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
    await cleanup.query(
      'DROP TABLE IF EXISTS conversations_v1_conversations',
    );
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('conversations:create — seeding from the resolved agent', () => {
  it('seeds runner_type from the AGENT, not from a host-wide default', async () => {
    const h = await makeHarness({
      agents: new Map([
        ['agt_demo', { id: 'agt_demo', workspaceRef: 'wsp_demo', runner: 'aisdk' }],
      ]),
    });
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_demo' },
    );
    // The regression this pins: this used to be 'claude-sdk' for EVERY
    // conversation, including ones an aisdk agent went on to serve.
    expect(conv.runnerType).toBe('aisdk');
    expect(conv.workspaceRef).toBe('wsp_demo');
  });

  it('freezes workspace_ref = null when the agent had no workspaceRef', async () => {
    const h = await makeHarness({
      agents: new Map([
        ['agt_no_ws', { id: 'agt_no_ws', workspaceRef: null, runner: 'claude-sdk' }],
      ]),
    });
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_no_ws' },
    );
    expect(conv.workspaceRef).toBeNull();
    expect(conv.runnerType).toBe('claude-sdk');
  });

  it('records runner_type = null when the agent reports no runner', async () => {
    // Null means "no runner has served this conversation yet" — an honest
    // unknown. The old code guessed 'claude-sdk' here, which is how a wrong
    // value got onto every row in the first place.
    const h = await makeHarness({
      agents: new Map([
        ['agt_bare', { id: 'agt_bare', workspaceRef: null }],
      ]),
    });
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_bare' },
    );
    expect(conv.runnerType).toBeNull();
  });

  // Phase D (2026-05-17): routines pass `hidden: true` for per-fire
  // conversations so they don't appear in the chat sidebar.
  it('conversations:create respects optional hidden flag', async () => {
    const h = await makeHarness({
      agents: new Map([
        ['agt_a', { id: 'agt_a', workspaceRef: 'wsp_demo', runner: 'claude-sdk' }],
      ]),
    });
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'u1' }),
      {
        userId: 'u1',
        agentId: 'agt_a',
        title: 'a hidden one',
        hidden: true,
      },
    );
    expect(conv.hidden).toBe(true);
  });

  it('conversations:create defaults hidden to false when omitted', async () => {
    const h = await makeHarness({
      agents: new Map([
        ['agt_a', { id: 'agt_a', workspaceRef: 'wsp_demo', runner: 'claude-sdk' }],
      ]),
    });
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'u1' }),
      { userId: 'u1', agentId: 'agt_a' },
    );
    expect(conv.hidden).toBe(false);
  });
});
