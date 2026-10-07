import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  createTestHarness,
  stopPostgresContainer,
  startTestContainer,
  type TestHarness,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import type { AgentContext } from '@ax/core';
import { createAgentsPlugin } from '../plugin.js';
import type { Actor, CreateInput, CreateOutput, ResolveInput, ResolveOutput } from '../types.js';

/**
 * Slice 2b — @ax/agents detaches a deleted connector from every agent
 * (`connectors:deleted` with idStillLive false) and sweeps dangling ids at boot.
 * Real @ax/agents on Postgres; @ax/connectors is stubbed (`connectors:live-ids`).
 */

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

let liveIds: Set<string>;
let liveIdsMode: 'present' | 'absent' | 'throws';
let liveIdsCalls: string[][];

async function boot(): Promise<TestHarness> {
  const services: Record<string, (ctx: AgentContext, input: unknown) => Promise<unknown>> = {
    'http:register-route': async () => ({ unregister: () => {} }),
    'auth:require-user': async () => {
      throw new Error('not used');
    },
  };
  if (liveIdsMode !== 'absent') {
    services['connectors:live-ids'] = async (_ctx, input) => {
      const { connectorIds } = input as { connectorIds: string[] };
      liveIdsCalls.push(connectorIds);
      if (liveIdsMode === 'throws') throw new Error('connectors store unavailable');
      return { live: connectorIds.filter((id) => liveIds.has(id)) };
    };
  }
  const h = await createTestHarness({
    services: services as never,
    plugins: [createDatabasePostgresPlugin({ connectionString }), createAgentsPlugin()],
  });
  harnesses.push(h);
  return h;
}

async function reboot(): Promise<TestHarness> {
  while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} });
  return boot();
}

async function newAgent(
  h: TestHarness,
  owner: string,
  opts: { teamId?: string; name?: string } = {},
): Promise<string> {
  const actor: Actor = { userId: owner, isAdmin: false };
  const out = await h.bus.call<CreateInput, CreateOutput>('agents:create', h.ctx({ userId: owner }), {
    actor,
    input: {
      displayName: opts.name ?? 'Quill',
      allowedTools: [],
      mcpConfigIds: [],
      model: 'anthropic/claude-opus-4-7',
      visibility: opts.teamId === undefined ? 'personal' : 'team',
      ...(opts.teamId === undefined ? {} : { teamId: opts.teamId }),
    },
  });
  return out.agent.id;
}

async function withPg<T>(fn: (c: import('pg').Client) => Promise<T>): Promise<T> {
  const c = new (await import('pg')).default.Client({ connectionString });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => {});
  }
}

async function row(
  agentId: string,
): Promise<{ attachments: string[]; exclusions: string[]; updatedAt: Date }> {
  return withPg(async (c) => {
    const r = await c.query(
      'SELECT connector_attachments, connector_exclusions, updated_at FROM agents_v1_agents WHERE agent_id = $1',
      [agentId],
    );
    const x = r.rows[0] as {
      connector_attachments: string[];
      connector_exclusions: string[];
      updated_at: Date;
    };
    return {
      attachments: x.connector_attachments,
      exclusions: x.connector_exclusions,
      updatedAt: x.updated_at,
    };
  });
}

async function setLists(
  agentId: string,
  lists: { attachments?: string[]; exclusions?: string[] },
): Promise<void> {
  await withPg(async (c) => {
    if (lists.attachments !== undefined) {
      await c.query('UPDATE agents_v1_agents SET connector_attachments = $2::jsonb WHERE agent_id = $1', [
        agentId,
        JSON.stringify(lists.attachments),
      ]);
    }
    if (lists.exclusions !== undefined) {
      await c.query('UPDATE agents_v1_agents SET connector_exclusions = $2::jsonb WHERE agent_id = $1', [
        agentId,
        JSON.stringify(lists.exclusions),
      ]);
    }
  });
}


async function fireDeleted(h: TestHarness, payload: Record<string, unknown>): Promise<void> {
  await h.bus.fire('connectors:deleted', h.ctx({ userId: 'someone' }), payload);
}

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

beforeEach(() => {
  liveIds = new Set();
  liveIdsMode = 'present';
  liveIdsCalls = [];
});

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} });
  await withPg((c) => c.query('DROP TABLE IF EXISTS agents_v1_agents'));
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

const payload = (connectorId: string, idStillLive: unknown) => ({
  connectorId,
  toolNamespaces: [],
  idStillLive,
});

describe('connectors:deleted subscriber', () => {
  it('removes the id from three agents attachments and exclusions, leaving other ids and order', async () => {
    const h = await boot();
    const a = await newAgent(h, 'u1');
    const b = await newAgent(h, 'u2');
    const c = await newAgent(h, 'u3');
    const untouched = await newAgent(h, 'u4');
    await setLists(a, { attachments: ['x', 'crm', 'y'] });
    await setLists(b, { exclusions: ['crm', 'z'] });
    await setLists(c, { attachments: ['crm'], exclusions: ['crm', 'q'] });
    await setLists(untouched, { attachments: ['x', 'y'], exclusions: ['z'] });
    const before = await row(untouched);

    await fireDeleted(h, payload('crm', false));

    expect(await row(a)).toMatchObject({ attachments: ['x', 'y'], exclusions: [] });
    expect(await row(b)).toMatchObject({ attachments: [], exclusions: ['z'] });
    expect(await row(c)).toMatchObject({ attachments: [], exclusions: ['q'] });
    const after = await row(untouched);
    expect(after).toMatchObject({ attachments: ['x', 'y'], exclusions: ['z'] });
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it.each([[true], [undefined], ['false'], [null]])(
    'idStillLive=%s changes nothing',
    async (flag) => {
      const h = await boot();
      const a = await newAgent(h, 'u1');
      await setLists(a, { attachments: ['crm'], exclusions: ['crm'] });
      await fireDeleted(h, payload('crm', flag));
      expect(await row(a)).toMatchObject({ attachments: ['crm'], exclusions: ['crm'] });
    },
  );

  it('removeConnectorEverywhere is safe under concurrent per-agent attach/detach', async () => {
    const h = await boot();
    const owners = Array.from({ length: 6 }, (_, i) => `u${i}`);
    const ids = await Promise.all(owners.map((o) => newAgent(h, o)));
    for (const id of ids) await setLists(id, { attachments: ['crm', 'keep'] });
    await Promise.all([
      ...ids.map((id, i) =>
        h.bus.call('agents:attach-connector', h.ctx({ userId: owners[i]! }), {
          actor: { userId: owners[i]!, isAdmin: false },
          agentId: id,
          connectorId: 'other',
        }),
      ),
      fireDeleted(h, payload('crm', false)),
    ]);
    for (const id of ids) {
      const r = await row(id);
      expect(r.attachments).not.toContain('crm');
      expect(r.attachments).toContain('keep');
      expect(r.attachments).toContain('other');
    }
  });
});

describe('boot sweep', () => {
  it('removes a dangling id, keeps live ones, and a second boot changes nothing', async () => {
    let h = await boot();
    const a = await newAgent(h, 'u1');
    const b = await newAgent(h, 'u2');
    await setLists(a, { attachments: ['live', 'gone'], exclusions: ['gone2'] });
    await setLists(b, { attachments: ['gone'], exclusions: ['live'] });
    liveIds = new Set(['live']);

    h = await reboot();
    expect(await row(a)).toMatchObject({ attachments: ['live'], exclusions: [] });
    expect(await row(b)).toMatchObject({ attachments: [], exclusions: ['live'] });
    expect(liveIdsCalls).toHaveLength(1);
    expect([...liveIdsCalls[0]!].sort()).toEqual(['gone', 'gone2', 'live']);

    const snap = await row(a);
    h = await reboot();
    expect(await row(a)).toEqual(snap);
    expect(h).toBeDefined();
  });

  it('with no connectors:live-ids service, nothing changes', async () => {
    let h = await boot();
    const a = await newAgent(h, 'u1');
    await setLists(a, { attachments: ['gone'] });
    liveIdsMode = 'absent';
    h = await reboot();
    expect(await row(a)).toMatchObject({ attachments: ['gone'] });
  });

  it('when connectors:live-ids throws, nothing changes and boot succeeds', async () => {
    let h = await boot();
    const a = await newAgent(h, 'u1');
    await setLists(a, { attachments: ['gone'] });
    liveIdsMode = 'throws';
    h = await reboot();
    expect(await row(a)).toMatchObject({ attachments: ['gone'] });
  });

  it('never sends or deletes a malformed stored id; batches at 500', async () => {
    let h = await boot();
    const a = await newAgent(h, 'u1');
    const many = Array.from({ length: 50 }, (_, i) => `c${i}`);
    await setLists(a, { attachments: many, exclusions: ['Bad Id!'] });
    const b = await newAgent(h, 'u2');
    const more = Array.from({ length: 50 }, (_, i) => `d${i}`);
    await setLists(b, { attachments: more });
    liveIds = new Set([...many, ...more]);
    h = await reboot();
    expect(liveIdsCalls.flat()).not.toContain('Bad Id!');
    expect((await row(a)).exclusions).toEqual(['Bad Id!']);
    expect((await row(a)).attachments).toHaveLength(50);
  });

  it('asks in batches of at most 500', async () => {
    let h = await boot();
    for (let a = 0; a < 11; a++) {
      const id = await newAgent(h, `u${a}`);
      await setLists(id, {
        attachments: Array.from({ length: 50 }, (_, i) => `c${a}-${i}`),
      });
    }
    h = await reboot();
    expect(liveIdsCalls.map((b) => b.length).sort((x, y) => y - x)).toEqual([500, 50]);
  });
});
