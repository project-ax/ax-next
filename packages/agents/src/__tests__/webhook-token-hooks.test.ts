import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestHarness, type TestHarness, stopPostgresContainer } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createAgentsPlugin } from '../plugin.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    await h.close({ onError: () => {} });
  }
  // Drop the table between tests to keep cases isolated.
  const cleanup = new (await import('pg')).default.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS agents_v1_agents');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

async function makeHarness(): Promise<TestHarness> {
  const h = await createTestHarness({
    services: {
      'http:register-route': async () => ({ unregister: () => {} }),
      'auth:require-user': async () => ({ user: { id: 'u1', isAdmin: false } }),
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createAgentsPlugin({}),
    ],
  });
  harnesses.push(h);
  return h;
}

async function createAgent(harness: TestHarness, ownerUserId: string): Promise<string> {
  const out = await harness.bus.call<
    { actor: { userId: string; isAdmin: boolean }; input: unknown },
    { agent: { id: string } }
  >(
    'agents:create',
    harness.ctx({ userId: ownerUserId }),
    {
      actor: { userId: ownerUserId, isAdmin: false },
      input: {
        displayName: 'a', allowedTools: [], mcpConfigIds: [],
        model: 'claude-opus-4-7', visibility: 'personal',
      },
    },
  );
  return out.agent.id;
}

describe('agents:rotate-webhook-token', () => {
  it('issues a fresh URL-safe token to the owner', async () => {
    const harness = await makeHarness();
    const id = await createAgent(harness, 'u1');
    const out = await harness.bus.call<
      { actor: { userId: string; isAdmin: boolean }; agentId: string },
      { token: string }
    >(
      'agents:rotate-webhook-token',
      harness.ctx({ userId: 'u1' }),
      { actor: { userId: 'u1', isAdmin: false }, agentId: id },
    );
    expect(typeof out.token).toBe('string');
    // base64url-encoded 32 bytes → exactly 43 chars (no padding)
    expect(out.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('replaces the prior token on second call (true rotation)', async () => {
    const harness = await makeHarness();
    const id = await createAgent(harness, 'u1');
    const a = await harness.bus.call<
      { actor: { userId: string; isAdmin: boolean }; agentId: string },
      { token: string }
    >('agents:rotate-webhook-token', harness.ctx({ userId: 'u1' }),
      { actor: { userId: 'u1', isAdmin: false }, agentId: id });
    const b = await harness.bus.call<
      { actor: { userId: string; isAdmin: boolean }; agentId: string },
      { token: string }
    >('agents:rotate-webhook-token', harness.ctx({ userId: 'u1' }),
      { actor: { userId: 'u1', isAdmin: false }, agentId: id });
    expect(a.token).not.toBe(b.token);
  });

  it('allows admin to rotate any agent', async () => {
    const harness = await makeHarness();
    const id = await createAgent(harness, 'u1');
    const out = await harness.bus.call<
      { actor: { userId: string; isAdmin: boolean }; agentId: string },
      { token: string }
    >('agents:rotate-webhook-token', harness.ctx({ userId: 'admin' }),
      { actor: { userId: 'admin', isAdmin: true }, agentId: id });
    expect(typeof out.token).toBe('string');
  });

  it('forbids rotation by non-owner non-admin', async () => {
    const harness = await makeHarness();
    const id = await createAgent(harness, 'u1');
    await expect(harness.bus.call(
      'agents:rotate-webhook-token', harness.ctx({ userId: 'u2' }),
      { actor: { userId: 'u2', isAdmin: false }, agentId: id },
    )).rejects.toThrow(/forbidden|access/i);
  });

  it('throws not-found when agent does not exist', async () => {
    const harness = await makeHarness();
    await expect(harness.bus.call(
      'agents:rotate-webhook-token', harness.ctx({ userId: 'u1' }),
      { actor: { userId: 'u1', isAdmin: false }, agentId: 'agt_missing' },
    )).rejects.toThrow(/not-found|not found/i);
  });
});

describe('agents:resolve does NOT expose webhookToken (Finding #3 regression)', () => {
  it('agents:resolve response does not carry webhookToken field', async () => {
    const harness = await makeHarness();
    const id = await createAgent(harness, 'u1');
    // Set a token so there IS one in the DB — the field should still not appear.
    await harness.bus.call('agents:rotate-webhook-token', harness.ctx({ userId: 'u1' }),
      { actor: { userId: 'u1', isAdmin: false }, agentId: id });
    const out = await harness.bus.call<
      { agentId: string; userId: string }, { agent: object }
    >('agents:resolve', harness.ctx({ userId: 'u1' }), { agentId: id, userId: 'u1' });
    expect(Object.keys(out.agent)).not.toContain('webhookToken');
  });

  it('agents:list-for-user response items do not carry webhookToken', async () => {
    const harness = await makeHarness();
    const id = await createAgent(harness, 'u1');
    await harness.bus.call('agents:rotate-webhook-token', harness.ctx({ userId: 'u1' }),
      { actor: { userId: 'u1', isAdmin: false }, agentId: id });
    const out = await harness.bus.call<
      { userId: string }, { agents: object[] }
    >('agents:list-for-user', harness.ctx({ userId: 'u1' }), { userId: 'u1' });
    expect(out.agents.length).toBeGreaterThan(0);
    for (const agent of out.agents) {
      expect(Object.keys(agent)).not.toContain('webhookToken');
    }
  });

  it('agents:create response does not carry webhookToken', async () => {
    const harness = await makeHarness();
    const out = await harness.bus.call<
      { actor: { userId: string; isAdmin: boolean }; input: unknown },
      { agent: object }
    >('agents:create', harness.ctx({ userId: 'u1' }), {
      actor: { userId: 'u1', isAdmin: false },
      input: {
        displayName: 'b', allowedTools: [], mcpConfigIds: [],
        model: 'claude-opus-4-7', visibility: 'personal',
      },
    });
    expect(Object.keys(out.agent)).not.toContain('webhookToken');
  });

  it('agents:update response does not carry webhookToken', async () => {
    const harness = await makeHarness();
    const id = await createAgent(harness, 'u1');
    const out = await harness.bus.call<
      { actor: { userId: string; isAdmin: boolean }; agentId: string; patch: unknown },
      { agent: object }
    >('agents:update', harness.ctx({ userId: 'u1' }), {
      actor: { userId: 'u1', isAdmin: false },
      agentId: id,
      patch: { displayName: 'updated' },
    });
    expect(Object.keys(out.agent)).not.toContain('webhookToken');
  });
});

describe('agents:ensure-webhook-token', () => {
  it('generates a token on first call (lazy)', async () => {
    const harness = await makeHarness();
    const id = await createAgent(harness, 'u1');
    const out = await harness.bus.call<
      { actor: { userId: string; isAdmin: boolean }; agentId: string },
      { token: string }
    >('agents:ensure-webhook-token', harness.ctx({ userId: 'u1' }),
      { actor: { userId: 'u1', isAdmin: false }, agentId: id });
    expect(typeof out.token).toBe('string');
    expect(out.token.length).toBeGreaterThan(0);
  });

  it('returns the same token on repeated calls (idempotent)', async () => {
    const harness = await makeHarness();
    const id = await createAgent(harness, 'u1');
    const a = await harness.bus.call<
      { actor: { userId: string; isAdmin: boolean }; agentId: string },
      { token: string }
    >('agents:ensure-webhook-token', harness.ctx({ userId: 'u1' }),
      { actor: { userId: 'u1', isAdmin: false }, agentId: id });
    const b = await harness.bus.call<
      { actor: { userId: string; isAdmin: boolean }; agentId: string },
      { token: string }
    >('agents:ensure-webhook-token', harness.ctx({ userId: 'u1' }),
      { actor: { userId: 'u1', isAdmin: false }, agentId: id });
    expect(a.token).toBe(b.token);
  });

  it('allows admin to ensure any agent token', async () => {
    const harness = await makeHarness();
    const id = await createAgent(harness, 'u1');
    const out = await harness.bus.call<
      { actor: { userId: string; isAdmin: boolean }; agentId: string },
      { token: string }
    >('agents:ensure-webhook-token', harness.ctx({ userId: 'admin' }),
      { actor: { userId: 'admin', isAdmin: true }, agentId: id });
    expect(typeof out.token).toBe('string');
  });

  it('forbids non-owner non-admin', async () => {
    const harness = await makeHarness();
    const id = await createAgent(harness, 'u1');
    await expect(harness.bus.call(
      'agents:ensure-webhook-token', harness.ctx({ userId: 'u2' }),
      { actor: { userId: 'u2', isAdmin: false }, agentId: id },
    )).rejects.toThrow(/forbidden|access/i);
  });

  it('throws not-found when agent does not exist', async () => {
    const harness = await makeHarness();
    await expect(harness.bus.call(
      'agents:ensure-webhook-token', harness.ctx({ userId: 'u1' }),
      { actor: { userId: 'u1', isAdmin: false }, agentId: 'agt_missing' },
    )).rejects.toThrow(/not-found|not found/i);
  });
});

describe('agents:rotate-webhook-token fires agents:webhook-token-rotated (Finding #5)', () => {
  it('fires agents:webhook-token-rotated with agentId payload after rotation', async () => {
    const harness = await makeHarness();
    const id = await createAgent(harness, 'u1');

    const firedEvents: Array<{ agentId: string }> = [];
    harness.bus.subscribe<{ agentId: string }>(
      'agents:webhook-token-rotated', 'test-observer',
      async (_ctx, payload) => {
        firedEvents.push(payload);
        return undefined;
      },
    );

    await harness.bus.call(
      'agents:rotate-webhook-token', harness.ctx({ userId: 'u1' }),
      { actor: { userId: 'u1', isAdmin: false }, agentId: id },
    );

    expect(firedEvents).toHaveLength(1);
    expect(firedEvents[0]!.agentId).toBe(id);
    // Token must NOT appear in the event payload.
    expect(Object.keys(firedEvents[0]!)).not.toContain('token');
  });

  it('fires exactly once per rotation call', async () => {
    const harness = await makeHarness();
    const id = await createAgent(harness, 'u1');

    let fireCount = 0;
    harness.bus.subscribe('agents:webhook-token-rotated', 'test-counter',
      async () => { fireCount++; return undefined; });

    await harness.bus.call('agents:rotate-webhook-token', harness.ctx({ userId: 'u1' }),
      { actor: { userId: 'u1', isAdmin: false }, agentId: id });
    await harness.bus.call('agents:rotate-webhook-token', harness.ctx({ userId: 'u1' }),
      { actor: { userId: 'u1', isAdmin: false }, agentId: id });

    expect(fireCount).toBe(2);
  });
});

describe('agents:resolve-by-webhook-token', () => {
  it('returns the agent when the token matches', async () => {
    const harness = await makeHarness();
    const id = await createAgent(harness, 'u1');
    const { token } = await harness.bus.call<
      { actor: { userId: string; isAdmin: boolean }; agentId: string },
      { token: string }
    >('agents:rotate-webhook-token', harness.ctx({ userId: 'u1' }),
      { actor: { userId: 'u1', isAdmin: false }, agentId: id });
    const out = await harness.bus.call<{ token: string }, { agent: { id: string } } | null>(
      'agents:resolve-by-webhook-token', harness.ctx({ userId: 'system' }), { token });
    expect(out).not.toBeNull();
    expect(out!.agent.id).toBe(id);
    // Resolved agent must not expose webhookToken either (Finding #3).
    expect(Object.keys(out!.agent)).not.toContain('webhookToken');
  });

  it('returns null on unknown token', async () => {
    const harness = await makeHarness();
    const out = await harness.bus.call<{ token: string }, { agent: { id: string } } | null>(
      'agents:resolve-by-webhook-token', harness.ctx({ userId: 'system' }), { token: 'nope-not-real' });
    expect(out).toBeNull();
  });

  it('returns null on empty token (no oracle)', async () => {
    const harness = await makeHarness();
    const out = await harness.bus.call<{ token: string }, { agent: { id: string } } | null>(
      'agents:resolve-by-webhook-token', harness.ctx({ userId: 'system' }), { token: '' });
    expect(out).toBeNull();
  });
});
