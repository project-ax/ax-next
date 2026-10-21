/** Actual bootstrap/ACL boundary: agents -> tool-policy snapshot remains acyclic,
 * while consent resolves actual personal ownership and durable team membership. */
import { createLogger } from '@ax/core';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createTeamsPlugin } from '@ax/teams';
import { createToolPolicyPlugin, type EvaluateResult } from '@ax/tool-policy';
import { createTestHarness, startTestContainer, stopPostgresContainer, type TestHarness } from '@ax/test-harness';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { createAgentsPlugin } from '../plugin.js';
import type { CreateOutput } from '../types.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
let h: TestHarness;
const logger = createLogger({ reqId: 'consent-test', writer: () => {} });
beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);
afterEach(async () => { await h?.close(); });
afterAll(async () => { if (container) await stopPostgresContainer(container); });

it('boots actual agents, teams and policy; enforces ACL/scoped grants and purges after actual deletion', async () => {
  h = await createTestHarness({
    services: {
      'http:register-route': async () => ({ unregister: () => {} }),
      'auth:require-user': async () => { throw new Error('HTTP auth is not used in hook test'); },
    },
    plugins: [createDatabasePostgresPlugin({ connectionString }), createTeamsPlugin(), createAgentsPlugin(), createToolPolicyPlugin()],
  });
  expect(h.bus.hasService('agents:resolve')).toBe(true);
  expect(h.bus.hasService('agents:can-manage-routines')).toBe(true);
  const ctx = (userId: string, agentId = 'agent-create') => h.ctx({ userId, agentId, logger });
  const { team } = await h.bus.call<unknown, { team: { id: string } }>('teams:create', ctx('alice'), { actor: { userId: 'alice' }, displayName: 'Routine team' });
  for (const [userId, role] of [['bob', 'admin'], ['member', 'member']]) {
    await h.bus.call('teams:add-member', ctx('alice'), { actor: { userId: 'alice' }, teamId: team.id, userId, role });
  }
  async function create(visibility: 'personal' | 'team') {
    return (await h.bus.call<unknown, CreateOutput>('agents:create', ctx('alice'), {
      actor: { userId: 'alice', isAdmin: false }, input: {
        displayName: visibility, visibility, ...(visibility === 'team' ? { teamId: team.id } : {}),
        model: 'anthropic/claude-opus-4-7', allowedTools: [], mcpConfigIds: [],
      },
    })).agent.id;
  }
  const personal = await create('personal'), teamAgent = await create('team');
  async function grant(userId: string, agentId: string, decisionId: string, expectedRevision = '0') {
    const replay = ctx(userId, agentId);
    replay.state.set('decisions:routine-consent-grant', { userId, agentId, decisionId, expectedRevision, toolName: 'routine_create' });
    return h.bus.call('tool-policy:grant-routine-consent', replay, { decisionId, expectedRevision });
  }
  // A well-formed repeat create: malformed input holds on purpose (TASK-906).
  const createInput = { requestId: 'q', definition: { name: 'Weekly summary', promptBody: 'Summarize.', trigger: { kind: 'interval', every: '1h' } } };
  async function verdict(userId: string, agentId: string) {
    return (await h.bus.call<unknown, EvaluateResult>('tool-policy:evaluate', ctx(userId, agentId), { agentId, call: { name: 'routine_create', input: createInput } })).verdict;
  }
  await expect(grant('bob', personal, 'personal-other')).rejects.toMatchObject({ code: 'forbidden' });
  await grant('alice', personal, 'personal');
  expect(await verdict('alice', personal)).toBe('allow');
  await grant('alice', teamAgent, 'team-alice');
  expect(await verdict('bob', teamAgent)).toBe('hold');
  await grant('bob', teamAgent, 'team-bob');
  expect(await verdict('bob', teamAgent)).toBe('allow');
  await expect(grant('member', teamAgent, 'team-member')).rejects.toMatchObject({ code: 'forbidden' });
  await expect(grant('outsider', teamAgent, 'team-outsider')).rejects.toMatchObject({ code: 'forbidden' });
  await h.bus.call('teams:remove-member', ctx('alice'), { actor: { userId: 'alice' }, teamId: team.id, userId: 'bob' });
  expect(await verdict('bob', teamAgent)).toBe('hold');
  await expect(h.bus.call('tool-policy:get-routine-consent', ctx('bob', teamAgent), { agentId: teamAgent })).rejects.toMatchObject({ code: 'forbidden' });
  await h.bus.call('agents:delete', ctx('alice', personal), { actor: { userId: 'alice', isAdmin: false }, agentId: personal });
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    expect((await client.query('SELECT * FROM tool_policy_v1_routine_consent WHERE agent_id=$1', [personal])).rows).toHaveLength(0);
    expect((await client.query('SELECT * FROM tool_policy_v1_routine_consent_deliveries WHERE agent_id=$1', [personal])).rows).toHaveLength(0);
    expect((await client.query('SELECT * FROM tool_policy_v1_routine_consent WHERE agent_id=$1', [teamAgent])).rows).toHaveLength(2);
  } finally { await client.end(); }
  await expect(grant('alice', personal, 'late-personal')).rejects.toMatchObject({ code: 'not-found' });
});
