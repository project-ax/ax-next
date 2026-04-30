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
} from '../types.js';

// ---------------------------------------------------------------------------
// Phase B (2026-04-29). conversations:get-metadata returns the metadata
// projection — no turns (I6). Same ACL posture as conversations:get
// (user_id pre-filter then agents:resolve) so foreign / tombstoned rows
// surface as 'not-found'.
// ---------------------------------------------------------------------------

interface MockAgent {
  id: string;
  workspaceRef: string | null;
}

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

async function makeHarness(args: {
  agents: ReadonlyMap<string, MockAgent>;
  policy?: MockResolvePolicy;
}): Promise<{ h: TestHarness; calls: MockResolveCall[] }> {
  const calls: MockResolveCall[] = [];
  const policy: MockResolvePolicy = args.policy ?? { decide: () => 'allow' };
  const h = await createTestHarness({
    services: {
      'agents:resolve': async (
        _ctx,
        input: unknown,
      ): Promise<{ agent: MockAgent }> => {
        const call = input as MockResolveCall;
        calls.push(call);
        const decision = policy.decide(call);
        if (decision === 'notfound') {
          throw new PluginError({
            code: 'not-found',
            plugin: 'mock-agents',
            hookName: 'agents:resolve',
            message: `agent '${call.agentId}' not found`,
          });
        }
        if (decision === 'forbid') {
          throw new PluginError({
            code: 'forbidden',
            plugin: 'mock-agents',
            hookName: 'agents:resolve',
            message: `agent '${call.agentId}' forbidden for '${call.userId}'`,
          });
        }
        const agent = args.agents.get(call.agentId);
        if (agent === undefined) {
          throw new PluginError({
            code: 'not-found',
            plugin: 'mock-agents',
            hookName: 'agents:resolve',
            message: `agent '${call.agentId}' not found`,
          });
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

describe('conversations:get-metadata', () => {
  it('returns the metadata projection (no turns)', async () => {
    const { h } = await makeHarness({
      agents: new Map([
        ['agt_demo', { id: 'agt_demo', workspaceRef: 'wsp_demo' }],
      ]),
    });
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_demo' },
    );
    const md = await h.bus.call<GetMetadataInput, GetMetadataOutput>(
      'conversations:get-metadata',
      h.ctx({ userId: 'userA' }),
      { conversationId: conv.conversationId, userId: 'userA' },
    );
    expect(md).toMatchObject({
      conversationId: conv.conversationId,
      userId: 'userA',
      agentId: 'agt_demo',
      runnerType: 'claude-sdk',
      runnerSessionId: null,
      workspaceRef: 'wsp_demo',
      title: null,
      lastActivityAt: null,
    });
    expect(md.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Projection contract: explicitly no turns key.
    expect((md as Record<string, unknown>).turns).toBeUndefined();
  });

  it('returns not-found for a foreign user', async () => {
    const { h } = await makeHarness({
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
      h.bus.call<GetMetadataInput, GetMetadataOutput>(
        'conversations:get-metadata',
        h.ctx({ userId: 'u-OTHER' }),
        { conversationId: conv.conversationId, userId: 'u-OTHER' },
      ),
    ).rejects.toThrow(PluginError);
  });

  it('returns not-found for a tombstoned row', async () => {
    const { h } = await makeHarness({
      agents: new Map([
        ['agt_demo', { id: 'agt_demo', workspaceRef: null }],
      ]),
    });
    const conv = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_demo' },
    );
    await h.bus.call<DeleteInput, void>(
      'conversations:delete',
      h.ctx({ userId: 'userA' }),
      { conversationId: conv.conversationId, userId: 'userA' },
    );
    await expect(
      h.bus.call<GetMetadataInput, GetMetadataOutput>(
        'conversations:get-metadata',
        h.ctx({ userId: 'userA' }),
        { conversationId: conv.conversationId, userId: 'userA' },
      ),
    ).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('propagates "forbidden" when agents:resolve denies the gate for an owned row', async () => {
    // Create with a permissive policy, then re-make a harness that
    // forbids the same row. The conversations layer surfaces 'forbidden'
    // (from agents:resolve) verbatim — but the user_id pre-filter means
    // a foreign caller never reaches agents:resolve. This test pins
    // the gate's call shape: when the row IS owned by the caller, a
    // forbid from agents:resolve propagates as 'forbidden'.
    const allowMap = new Map<string, MockAgent>([
      ['agt_demo', { id: 'agt_demo', workspaceRef: null }],
    ]);
    const { h: hAllow } = await makeHarness({ agents: allowMap });
    const conv = await hAllow.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      hAllow.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_demo' },
    );

    // Now spin up a harness that forbids the gate. The same userA owns
    // the row, but agents:resolve says no — we expect a forbidden error
    // to bubble up.
    const { h: hDeny } = await makeHarness({
      agents: allowMap,
      policy: { decide: () => 'forbid' },
    });
    await expect(
      hDeny.bus.call<GetMetadataInput, GetMetadataOutput>(
        'conversations:get-metadata',
        hDeny.ctx({ userId: 'userA' }),
        { conversationId: conv.conversationId, userId: 'userA' },
      ),
    ).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('returns not-found for a foreign user with a code, not just a message', async () => {
    const { h } = await makeHarness({
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
      h.bus.call<GetMetadataInput, GetMetadataOutput>(
        'conversations:get-metadata',
        h.ctx({ userId: 'u-OTHER' }),
        { conversationId: conv.conversationId, userId: 'u-OTHER' },
      ),
    ).rejects.toMatchObject({
      code: 'not-found',
    });
  });
});
