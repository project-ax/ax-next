import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createTestHarness,
  type TestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createAgentsPlugin } from '../plugin.js';

// agents:get-display-name is a HOST-ONLY lookup (no ACL) for artifacts.

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
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
    plugins: [createDatabasePostgresPlugin({ connectionString }), createAgentsPlugin({})],
  });
  harnesses.push(h);
  return h;
}

async function createAgent(h: TestHarness, owner: string, displayName: string): Promise<string> {
  const out = await h.bus.call<unknown, { agent: { id: string } }>('agents:create', h.ctx({ userId: owner }), {
    actor: { userId: owner, isAdmin: false },
    input: {
      displayName, allowedTools: [], mcpConfigIds: [],
      model: 'anthropic/claude-opus-4-7', visibility: 'personal',
    },
  });
  return out.agent.id;
}

describe('agents:get-display-name', () => {
  it("returns any agent's display name with no access check", async () => {
    const h = await makeHarness();
    const agentId = await createAgent(h, 'u1', 'Deal Desk');
    expect(
      await h.bus.call('agents:get-display-name', h.ctx({ userId: 'stranger' }), { agentId }),
    ).toEqual({ displayName: 'Deal Desk' });
  });

  it('answers not-found for an unknown agent', async () => {
    const h = await makeHarness();
    await expect(
      h.bus.call('agents:get-display-name', h.ctx({ userId: 'u1' }), { agentId: 'agt_nope' }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});
