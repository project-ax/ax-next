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

// W2 shared folders: `agents:can-manage-sharing` answers "may THIS actor
// manage the shared folders attached to THIS agent?". It is the same authority
// as `agents:can-manage-routines` — personal agent → only its owner; team agent
// → only a team admin; workspace-admin status never grants it. The actor is
// always `ctx.userId`, never anything in the payload.

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
  // Drop the table between tests to keep cases isolated.
  const cleanup = new (await import('pg')).default.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS agents_v1_agents');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

// `teamRole` omitted = the teams plugin is absent (no `teams:is-member`).
async function makeHarness(teamRole?: 'admin' | 'member'): Promise<TestHarness> {
  const h = await createTestHarness({
    services: {
      ...(teamRole ? { 'teams:is-member': async () => ({ member: true, role: teamRole }) } : {}),
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

async function createPersonalAgent(harness: TestHarness, ownerUserId: string): Promise<string> {
  const out = await harness.bus.call<unknown, { agent: { id: string } }>(
    'agents:create',
    harness.ctx({ userId: ownerUserId }),
    {
      actor: { userId: ownerUserId, isAdmin: false },
      input: {
        displayName: 'a', allowedTools: [], mcpConfigIds: [],
        model: 'anthropic/claude-opus-4-7', visibility: 'personal',
      },
    },
  );
  return out.agent.id;
}

// Creating a team agent needs a team admin, so the harness that creates it is
// the 'admin' one; the caller then re-asks from differently-roled harnesses
// (they share the same Postgres, so the agent row is visible to all of them).
async function createTeamAgent(harness: TestHarness): Promise<string> {
  const out = await harness.bus.call<unknown, { agent: { id: string } }>(
    'agents:create',
    harness.ctx({ userId: 'owner' }),
    {
      actor: { userId: 'owner', isAdmin: false },
      input: {
        displayName: 'team', allowedTools: [], mcpConfigIds: [],
        model: 'anthropic/claude-opus-4-7', visibility: 'team', teamId: 'team-1',
      },
    },
  );
  return out.agent.id;
}

describe('agents:can-manage-sharing', () => {
  it('registers the hook', async () => {
    const h = await makeHarness();
    expect(h.bus.hasService('agents:can-manage-sharing')).toBe(true);
  });

  it('allows the owner of a personal agent and denies an outsider', async () => {
    const h = await makeHarness();
    const agentId = await createPersonalAgent(h, 'owner');
    await expect(
      h.bus.call('agents:can-manage-sharing', h.ctx({ userId: 'owner' }), { agentId }),
    ).resolves.toEqual({ allowed: true });
    await expect(
      h.bus.call('agents:can-manage-sharing', h.ctx({ userId: 'outsider' }), { agentId }),
    ).resolves.toEqual({ allowed: false });
  });

  it('refuses a forged workspace-admin payload (strict input schema)', async () => {
    const h = await makeHarness();
    const agentId = await createPersonalAgent(h, 'owner');
    await expect(
      h.bus.call('agents:can-manage-sharing', h.ctx({ userId: 'outsider' }), { agentId, isAdmin: true }),
    ).rejects.toThrow();
    await expect(
      h.bus.call('agents:can-manage-sharing', h.ctx({ userId: 'outsider' }), { agentId, userId: 'owner' }),
    ).rejects.toThrow();
  });

  it('allows a team admin on a team agent, denies a team member, and denies when the teams plugin is absent', async () => {
    const admin = await makeHarness('admin');
    const agentId = await createTeamAgent(admin);
    await expect(
      admin.bus.call('agents:can-manage-sharing', admin.ctx({ userId: 'team-admin' }), { agentId }),
    ).resolves.toEqual({ allowed: true });

    const member = await makeHarness('member');
    await expect(
      member.bus.call('agents:can-manage-sharing', member.ctx({ userId: 'member' }), { agentId }),
    ).resolves.toEqual({ allowed: false });

    const noTeams = await makeHarness();
    await expect(
      noTeams.bus.call('agents:can-manage-sharing', noTeams.ctx({ userId: 'owner' }), { agentId }),
    ).resolves.toEqual({ allowed: false });
  });

  it('rejects an unknown agent with not-found', async () => {
    const h = await makeHarness();
    await expect(
      h.bus.call('agents:can-manage-sharing', h.ctx({ userId: 'owner' }), { agentId: 'agt_does_not_exist' }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});
