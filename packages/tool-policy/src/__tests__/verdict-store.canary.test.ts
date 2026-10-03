/**
 * TASK-736 — the per-tool verdict store against a real Postgres, through the
 * real plugin and bus. The memory store's behaviour is pinned in
 * `verdict-hooks.test.ts`; this proves the SQL does the same thing — the
 * snapshot's "never overwrite a `user` row" conflict clause, the namespace
 * purge's `LIKE`, and that verdicts survive a restart.
 */
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import {
  createTestHarness,
  stopPostgresContainer,
  type TestHarness,
  startTestContainer,
} from '@ax/test-harness';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type { ToolPolicyDatabase } from '../migrations.js';
import { createToolPolicyPlugin } from '../plugin.js';
import { createDbVerdictStore } from '../verdict-store.js';
import type {
  EvaluateResult,
  GetConnectorDefaultsOutput,
  ListAgentOverridesOutput,
  SetAgentOverrideOutput,
  SnapshotConnectorForAgentOutput,
} from '../index.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

const NS = 'c5e0235982f';
const NS2 = 'c0123456789';
const SEND = `mcp.${NS}.send_message`;
const LIST = `mcp.${NS}.list_messages`;
const OTHER = `mcp.${NS2}.create_issue`;

async function boot(): Promise<TestHarness> {
  const h = await createTestHarness({
    plugins: [createDatabasePostgresPlugin({ connectionString }), createToolPolicyPlugin()],
  });
  harnesses.push(h);
  return h;
}

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} });
  const c = new pg.Client({ connectionString });
  await c.connect();
  try {
    await c.query('DROP TABLE IF EXISTS tool_policy_v1_connector_defaults');
    await c.query('DROP TABLE IF EXISTS tool_policy_v1_agent_overrides');
    await c.query('DROP TABLE IF EXISTS tool_policy_v1_agent_copied_namespaces');
  } finally {
    await c.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

const ctx = (h: TestHarness) => h.ctx({ userId: 'admin-1' });

async function verdictOf(h: TestHarness, name: string, agentId = 'agent-1'): Promise<string> {
  const r = await h.bus.call<unknown, EvaluateResult>('tool-policy:evaluate', h.ctx({ agentId }), {
    call: { name, input: {} },
    agentId,
  });
  return r.verdict;
}

async function rawRows(sql: string): Promise<unknown[]> {
  const c = new pg.Client({ connectionString });
  await c.connect();
  try {
    return (await c.query(sql)).rows;
  } finally {
    await c.end().catch(() => {});
  }
}

describe('verdict store canary (Postgres)', () => {
  it('connector defaults and agent overrides round-trip and survive a restart', async () => {
    const h1 = await boot();
    expect(await verdictOf(h1, SEND)).toBe('hold');
    await h1.bus.call('tool-policy:set-connector-defaults', ctx(h1), {
      connectorId: 'gmail',
      verdicts: [
        { toolKey: SEND, verdict: 'hold' },
        { toolKey: LIST, verdict: 'allow' },
      ],
    });
    expect(
      await h1.bus.call<unknown, SetAgentOverrideOutput>('tool-policy:set-agent-override', ctx(h1), {
        agentId: 'agent-1',
        toolKey: 'Bash',
        verdict: 'deny',
      }),
    ).toEqual({ ok: true });

    // The row really landed in Postgres, with who wrote it.
    expect(
      await rawRows(
        "SELECT agent_id, tool_key, verdict, origin, updated_by FROM tool_policy_v1_agent_overrides",
      ),
    ).toEqual([
      { agent_id: 'agent-1', tool_key: 'Bash', verdict: 'deny', origin: 'user', updated_by: 'admin-1' },
    ]);

    // A second process over the same database reads the same verdicts.
    const h2 = await boot();
    expect(await verdictOf(h2, 'Bash')).toBe('deny');
    expect(await verdictOf(h2, LIST)).toBe('allow');
    expect(await verdictOf(h2, SEND)).toBe('hold');
    const got = await h2.bus.call<unknown, GetConnectorDefaultsOutput>(
      'tool-policy:get-connector-defaults',
      ctx(h2),
      { connectorId: 'gmail', toolNamespaces: [NS] },
    );
    expect(got.defaults).toEqual([
      { toolKey: LIST, verdict: 'allow' },
      { toolKey: SEND, verdict: 'hold' },
    ]);
  });

  it('snapshot overwrites an earlier snapshot but never a user row', async () => {
    const h = await boot();
    await h.bus.call('tool-policy:set-connector-defaults', ctx(h), {
      connectorId: 'gmail',
      verdicts: [
        { toolKey: SEND, verdict: 'hold' },
        { toolKey: LIST, verdict: 'hold' },
      ],
    });
    await h.bus.call('tool-policy:set-agent-override', ctx(h), {
      agentId: 'agent-1',
      toolKey: SEND,
      verdict: 'deny',
    });
    const snap = () =>
      h.bus.call<unknown, SnapshotConnectorForAgentOutput>('tool-policy:snapshot-connector-for-agent', ctx(h), {
        agentId: 'agent-1',
        connectorId: 'gmail',
        toolNamespaces: [NS],
      });
    expect(await snap()).toEqual({ copied: 1 });
    // Admin tightens LIST to deny; a re-snapshot copies the new value.
    await h.bus.call('tool-policy:set-connector-defaults', ctx(h), {
      connectorId: 'gmail',
      verdicts: [{ toolKey: LIST, verdict: 'deny' }],
    });
    expect(await snap()).toEqual({ copied: 1 });
    const list = await h.bus.call<unknown, ListAgentOverridesOutput>(
      'tool-policy:list-agent-overrides',
      ctx(h),
      { agentId: 'agent-1' },
    );
    expect(list.overrides).toEqual([
      { toolKey: LIST, verdict: 'deny', ceiling: 'deny', origin: 'snapshot' },
      { toolKey: SEND, verdict: 'deny', ceiling: 'hold', origin: 'user' },
    ]);
  });

  it('purges: agents:deleted by agent, connectors:deleted by namespace only', async () => {
    const h = await boot();
    await h.bus.call('tool-policy:set-connector-defaults', ctx(h), {
      connectorId: 'gmail',
      verdicts: [{ toolKey: SEND, verdict: 'allow' }],
    });
    await h.bus.call('tool-policy:set-connector-defaults', ctx(h), {
      connectorId: 'linear',
      verdicts: [{ toolKey: OTHER, verdict: 'allow' }],
    });
    for (const [agentId, toolKey] of [
      ['agent-1', SEND],
      ['agent-1', 'Bash'],
      ['agent-2', OTHER],
      ['agent-3', 'Bash'],
    ] as const) {
      await h.bus.call('tool-policy:set-agent-override', ctx(h), { agentId, toolKey, verdict: 'deny' });
    }

    await h.bus.fire('connectors:deleted', h.ctx(), {
      connectorId: 'gmail',
      toolNamespaces: [{ server: 'gmail', toolNamespace: NS }],
    });
    await h.bus.fire('agents:deleted', h.ctx(), { agentId: 'agent-3' });

    expect(
      await rawRows('SELECT tool_namespace, tool_name FROM tool_policy_v1_connector_defaults'),
    ).toEqual([{ tool_namespace: NS2, tool_name: 'create_issue' }]);
    expect(
      await rawRows(
        'SELECT agent_id, tool_key FROM tool_policy_v1_agent_overrides ORDER BY agent_id, tool_key',
      ),
    ).toEqual([
      { agent_id: 'agent-1', tool_key: 'Bash' },
      { agent_id: 'agent-2', tool_key: OTHER },
    ]);
  });

  // TASK-752 — the store's own keyspace guard, against the real `LIKE`.
  it('purgeNamespaces refuses a malformed namespace and deletes nothing', async () => {
    const h = await boot();
    await h.bus.call('tool-policy:set-connector-defaults', ctx(h), {
      connectorId: 'gmail',
      verdicts: [{ toolKey: SEND, verdict: 'allow' }],
    });
    await h.bus.call('tool-policy:set-agent-override', ctx(h), { agentId: 'agent-1', toolKey: SEND, verdict: 'deny' });
    await h.bus.call('tool-policy:set-agent-override', ctx(h), { agentId: 'agent-1', toolKey: 'Bash', verdict: 'deny' });
    const store = await dbStore(h);
    // `%` would match `mcp.%.%` — every agent's connector rows. `c%` and an
    // empty string are the near misses.
    for (const bad of ['%', 'c%', '', `${NS}%`, 'C5E0235982F']) {
      await expect(store.purgeNamespaces([NS2, bad])).rejects.toThrow(/malformed tool namespace/);
    }
    expect(
      await rawRows('SELECT agent_id, tool_key FROM tool_policy_v1_agent_overrides ORDER BY tool_key'),
    ).toEqual([
      { agent_id: 'agent-1', tool_key: 'Bash' },
      { agent_id: 'agent-1', tool_key: SEND },
    ]);
    expect(await rawRows('SELECT tool_namespace FROM tool_policy_v1_connector_defaults')).toEqual([
      { tool_namespace: NS },
    ]);
  });

  it('a renamed connector server carries its defaults and every agent’s overrides across', async () => {
    const h = await boot();
    const NEW = 'cabcdef0123';
    await h.bus.call('tool-policy:set-connector-defaults', ctx(h), {
      connectorId: 'gmail',
      verdicts: [
        { toolKey: SEND, verdict: 'hold' },
        { toolKey: LIST, verdict: 'allow' },
      ],
    });
    // A stale row already under the new namespace is replaced, not merged.
    await h.bus.call('tool-policy:set-connector-defaults', ctx(h), {
      connectorId: 'gmail',
      verdicts: [{ toolKey: `mcp.${NEW}.send_message`, verdict: 'allow' }],
    });
    await h.bus.call('tool-policy:set-agent-override', ctx(h), { agentId: 'agent-1', toolKey: SEND, verdict: 'deny' });
    await h.bus.call('tool-policy:set-agent-override', ctx(h), { agentId: 'agent-2', toolKey: LIST, verdict: 'hold' });
    await h.bus.call('tool-policy:set-agent-override', ctx(h), { agentId: 'agent-2', toolKey: OTHER, verdict: 'deny' });
    await h.bus.call('tool-policy:set-agent-override', ctx(h), {
      agentId: 'agent-3',
      toolKey: `mcp.${NEW}.list_messages`,
      verdict: 'deny',
    });

    await h.bus.fire('connectors:tool-namespaces-changed', h.ctx(), {
      connectorId: 'gmail',
      renamed: [{ from: { server: 'gmail', toolNamespace: NS }, to: { server: 'mail', toolNamespace: NEW } }],
      removed: [],
    });

    expect(
      await rawRows(
        'SELECT connector_id, tool_namespace, tool_name, verdict FROM tool_policy_v1_connector_defaults ORDER BY tool_namespace, tool_name',
      ),
    ).toEqual([
      { connector_id: 'gmail', tool_namespace: NEW, tool_name: 'list_messages', verdict: 'allow' },
      { connector_id: 'gmail', tool_namespace: NEW, tool_name: 'send_message', verdict: 'hold' },
    ]);
    expect(
      await rawRows(
        'SELECT agent_id, tool_key, verdict, origin FROM tool_policy_v1_agent_overrides ORDER BY agent_id, tool_key',
      ),
    ).toEqual([
      { agent_id: 'agent-1', tool_key: `mcp.${NEW}.send_message`, verdict: 'deny', origin: 'user' },
      { agent_id: 'agent-2', tool_key: OTHER, verdict: 'deny', origin: 'user' },
      { agent_id: 'agent-2', tool_key: `mcp.${NEW}.list_messages`, verdict: 'hold', origin: 'user' },
    ]);
    expect(await verdictOf(h, `mcp.${NEW}.send_message`)).toBe('deny');
    expect(await verdictOf(h, `mcp.${NEW}.list_messages`, 'agent-3')).toBe('allow');
  });

  // TASK-754 — the copied-namespace record, against the real SQL.
  describe('copied namespaces (TASK-754)', () => {
    const snap = (h: TestHarness, extra: Record<string, unknown> = {}, agentId = 'agent-1') =>
      h.bus.call<unknown, SnapshotConnectorForAgentOutput>('tool-policy:snapshot-connector-for-agent', ctx(h), {
        agentId,
        connectorId: 'gmail',
        toolNamespaces: [NS],
        ...extra,
      });
    const setDefault = (h: TestHarness, toolKey: string, verdict: string) =>
      h.bus.call('tool-policy:set-connector-defaults', ctx(h), {
        connectorId: 'gmail',
        verdicts: [{ toolKey, verdict }],
      });

    it('a tool with no default at attach stays held after a loosening, and across a restart', async () => {
      const h1 = await boot();
      await snap(h1);
      await setDefault(h1, SEND, 'allow');
      expect(await verdictOf(h1, SEND)).toBe('hold');
      expect(await verdictOf(h1, SEND, 'agent-2')).toBe('allow');
      await h1.close({ onError: () => {} });
      harnesses.splice(harnesses.indexOf(h1), 1);
      const h2 = await boot();
      expect(await verdictOf(h2, SEND)).toBe('hold');
      await setDefault(h2, SEND, 'deny');
      expect(await verdictOf(h2, SEND)).toBe('deny');
    });

    it('a first-session copy claims once, even when two sessions open at the same moment', async () => {
      const h = await boot();
      await setDefault(h, LIST, 'hold');
      const store = await dbStore(h);
      const results = await Promise.all(
        [1, 2, 3, 4].map(() =>
          store.copyConnectorDefaults('agent-1', 'gmail', [NS], { onlyIfNotCopied: true }, 'u'),
        ),
      );
      expect(results.reduce((a, b) => a + b, 0)).toBe(1);
      expect(
        await rawRows('SELECT agent_id, tool_namespace, copied_by FROM tool_policy_v1_agent_copied_namespaces'),
      ).toEqual([{ agent_id: 'agent-1', tool_namespace: NS, copied_by: 'u' }]);
    });

    it('a first-session copy never overwrites a row written before the record existed', async () => {
      const h = await boot();
      await setDefault(h, SEND, 'allow');
      // A snapshot row copied by an attach that predates this table.
      await rawRows(
        `INSERT INTO tool_policy_v1_agent_overrides (agent_id, tool_key, verdict, origin, updated_by)
         VALUES ('agent-1', '${SEND}', 'hold', 'snapshot', 'old')`,
      );
      expect(await snap(h, { onlyIfNotCopied: true })).toEqual({ copied: 0 });
      expect(await verdictOf(h, SEND)).toBe('hold');
      // A repeat claim is a no-op.
      await setDefault(h, LIST, 'allow');
      expect(await snap(h, { onlyIfNotCopied: true })).toEqual({ copied: 0 });
      expect(await verdictOf(h, LIST)).toBe('hold');
    });

    it('an attach re-copies snapshot rows and keeps the record', async () => {
      const h = await boot();
      await setDefault(h, SEND, 'hold');
      expect(await snap(h)).toEqual({ copied: 1 });
      await setDefault(h, SEND, 'allow');
      expect(await snap(h)).toEqual({ copied: 1 });
      expect(await verdictOf(h, SEND)).toBe('allow');
      const list = await h.bus.call<unknown, ListAgentOverridesOutput>(
        'tool-policy:list-agent-overrides',
        ctx(h),
        { agentId: 'agent-1' },
      );
      expect(list.copiedNamespaces).toEqual([NS]);
    });

    it('purges and renames carry the record', async () => {
      const NEW = 'cabcdef0123';
      const h = await boot();
      await snap(h);
      await snap(h, { toolNamespaces: [NS2] }, 'agent-2');
      await snap(h, {}, 'agent-3');
      // A stale record already under the new namespace is replaced.
      await snap(h, { toolNamespaces: [NEW] }, 'agent-1');
      await h.bus.fire('connectors:tool-namespaces-changed', h.ctx(), {
        connectorId: 'gmail',
        renamed: [{ from: { server: 'gmail', toolNamespace: NS }, to: { server: 'mail', toolNamespace: NEW } }],
        removed: [],
      });
      await h.bus.fire('agents:deleted', h.ctx(), { agentId: 'agent-3' });
      expect(
        await rawRows(
          'SELECT agent_id, tool_namespace FROM tool_policy_v1_agent_copied_namespaces ORDER BY agent_id, tool_namespace',
        ),
      ).toEqual([
        { agent_id: 'agent-1', tool_namespace: NEW },
        { agent_id: 'agent-2', tool_namespace: NS2 },
      ]);
      await h.bus.fire('connectors:deleted', h.ctx(), {
        connectorId: 'linear',
        toolNamespaces: [{ server: 'linear', toolNamespace: NS2 }],
      });
      expect(
        await rawRows('SELECT agent_id, tool_namespace FROM tool_policy_v1_agent_copied_namespaces'),
      ).toEqual([{ agent_id: 'agent-1', tool_namespace: NEW }]);
    });

    it('copyConnectorDefaults refuses a malformed namespace and records nothing', async () => {
      const h = await boot();
      const store = await dbStore(h);
      await expect(
        store.copyConnectorDefaults('agent-1', 'gmail', [NS, '%'], { onlyIfNotCopied: false }, 'u'),
      ).rejects.toThrow(/malformed tool namespace/);
      // The table may not exist yet if nothing wrote; read through the store.
      expect(await store.copiedNamespacesFor('agent-1')).toEqual([]);
    });
  });
});

async function dbStore(h: TestHarness) {
  const { db } = await h.bus.call<unknown, { db: Kysely<ToolPolicyDatabase> }>(
    'database:get-instance',
    h.ctx(),
    {},
  );
  return createDbVerdictStore(db);
}
