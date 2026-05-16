import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
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
  if (container) await container.stop();
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
        displayName: 'a', systemPrompt: '', allowedTools: [], mcpConfigIds: [],
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
    // base64url-encoded 32 bytes → 43 chars (no padding); allow 40+ to be safe
    expect(out.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
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
