import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { stopPostgresContainer } from '@ax/test-harness';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { runAgentsMigration, type AgentsDatabase } from '../migrations.js';
import { createAgentStore } from '../store.js';

let container: StartedPostgreSqlContainer;
let db: Kysely<AgentsDatabase>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  db = new Kysely<AgentsDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: container.getConnectionUri() }) }),
  });
  await runAgentsMigration(db);
}, 120_000);

afterAll(async () => {
  await db.destroy();
  await stopPostgresContainer(container);
});

beforeEach(async () => {
  await db.deleteFrom('agents_v1_agents').execute();
});

async function seedAgent(id: string) {
  await db.insertInto('agents_v1_agents').values({
    agent_id: id, owner_id: 'u1', owner_type: 'user', visibility: 'personal',
    display_name: 'a', system_prompt: '', allowed_tools: JSON.stringify([]),
    mcp_config_ids: JSON.stringify([]), model: 'claude-opus-4-7',
    workspace_ref: null,
  } as never).execute();
}

describe('AgentStore webhook helpers', () => {
  it('getByWebhookToken returns null when no agent has the token', async () => {
    await seedAgent('agt_a');
    const store = createAgentStore(db);
    expect(await store.getByWebhookToken('missing')).toBeNull();
  });

  it('setWebhookToken persists; getByWebhookToken finds the agent', async () => {
    await seedAgent('agt_a');
    const store = createAgentStore(db);
    await store.setWebhookToken('agt_a', 'tok123');
    const agent = await store.getByWebhookToken('tok123');
    expect(agent).not.toBeNull();
    expect(agent!.id).toBe('agt_a');
    // webhookToken is NOT on the public Agent DTO — verify via getWebhookToken.
    const rawToken = await store.getWebhookToken('agt_a');
    expect(rawToken).toBe('tok123');
  });

  it('setWebhookToken on unknown agent throws PluginError(not-found)', async () => {
    const store = createAgentStore(db);
    await expect(store.setWebhookToken('agt_missing', 'tok')).rejects.toThrow(/not-found|not found/i);
  });

  it('getWebhookToken returns the token after setWebhookToken', async () => {
    await seedAgent('agt_a');
    const store = createAgentStore(db);
    await store.setWebhookToken('agt_a', 'tok');
    expect(await store.getWebhookToken('agt_a')).toBe('tok');
  });

  it('getWebhookToken returns null for a fresh agent (no token set)', async () => {
    await seedAgent('agt_a');
    const store = createAgentStore(db);
    expect(await store.getWebhookToken('agt_a')).toBeNull();
  });

  it('webhookToken is NOT present on the public Agent DTO from getById', async () => {
    await seedAgent('agt_a');
    const store = createAgentStore(db);
    await store.setWebhookToken('agt_a', 'tok');
    const agent = await store.getById('agt_a');
    expect(agent).not.toBeNull();
    // webhookToken must not appear on the public DTO (Finding #3 regression pin).
    expect(Object.keys(agent!)).not.toContain('webhookToken');
  });

  it('setWebhookToken rotates — second call replaces prior token', async () => {
    await seedAgent('agt_a');
    const store = createAgentStore(db);
    await store.setWebhookToken('agt_a', 'first');
    await store.setWebhookToken('agt_a', 'second');
    expect(await store.getByWebhookToken('first')).toBeNull();
    expect((await store.getByWebhookToken('second'))?.id).toBe('agt_a');
  });

  it('partial unique index prevents two agents holding the same token', async () => {
    await seedAgent('agt_a');
    await seedAgent('agt_b');
    const store = createAgentStore(db);
    await store.setWebhookToken('agt_a', 'shared');
    await expect(store.setWebhookToken('agt_b', 'shared')).rejects.toThrow();
  });
});
