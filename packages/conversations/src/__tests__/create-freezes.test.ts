import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createConversationsPlugin } from '../plugin.js';
import type { CreateInput, CreateOutput } from '../types.js';

// ---------------------------------------------------------------------------
// Phase B (2026-04-29) — `conversations:create` freezes runner_type
// (from ConversationsConfig.defaultRunnerType) and workspace_ref (from
// the resolved agent's workspaceRef) onto the new row. Both fields are
// frozen-at-create (mirrors I10) — never updated.
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
  defaultRunnerType?: string;
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
      // turns. Tests that need turns wire up real bytes.
      'workspace:list': async () => ({ paths: [] as string[] }),
      'workspace:read': async () => ({ found: false }) as const,
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createConversationsPlugin(
        args.defaultRunnerType === undefined
          ? {}
          : { defaultRunnerType: args.defaultRunnerType },
      ),
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
  if (container) await container.stop();
});

describe('conversations:create — Phase B freezing', () => {
  it('freezes runner_type from config + workspace_ref from the resolved agent', async () => {
    const h = await makeHarness({
      agents: new Map([
        ['agt_demo', { id: 'agt_demo', workspaceRef: 'wsp_demo' }],
      ]),
      defaultRunnerType: 'claude-sdk',
    });
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_demo' },
    );
    expect(conv.runnerType).toBe('claude-sdk');
    expect(conv.workspaceRef).toBe('wsp_demo');
  });

  it('freezes workspace_ref = null when the agent had no workspaceRef', async () => {
    const h = await makeHarness({
      agents: new Map([
        ['agt_no_ws', { id: 'agt_no_ws', workspaceRef: null }],
      ]),
      defaultRunnerType: 'claude-sdk',
    });
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_no_ws' },
    );
    expect(conv.workspaceRef).toBeNull();
    expect(conv.runnerType).toBe('claude-sdk');
  });

  it('defaults runner_type to "claude-sdk" when the config knob is omitted', async () => {
    const h = await makeHarness({
      agents: new Map([
        ['agt_no_ws', { id: 'agt_no_ws', workspaceRef: null }],
      ]),
    });
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_no_ws' },
    );
    expect(conv.runnerType).toBe('claude-sdk');
  });

  it('uses a custom defaultRunnerType when configured', async () => {
    const h = await makeHarness({
      agents: new Map([
        ['agt_no_ws', { id: 'agt_no_ws', workspaceRef: null }],
      ]),
      defaultRunnerType: 'codex-cli',
    });
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_no_ws' },
    );
    expect(conv.runnerType).toBe('codex-cli');
  });
});
