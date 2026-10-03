import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { PluginError, type Plugin } from '@ax/core';
import {
  createTestHarness,
  stopPostgresContainer,
  type TestHarness,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import {
  createMemoryEgressAllowlistStore,
  createMemoryVerdictStore,
  createToolPolicyPlugin,
} from '@ax/tool-policy';
import { createConnectorsPlugin } from '../plugin.js';
import {
  createConnectorRouteHandlers,
  type ConnectorRouteMode,
  type RouteRequest,
  type RouteResponse,
} from '../admin-routes.js';
import { deriveToolNamespace } from '../tool-namespace.js';
import type { Capabilities } from '../types.js';

/**
 * TASK-737 — `GET/PUT …/connectors/:id/tool-permissions`. Real connectors
 * plugin on Postgres, real @ax/tool-policy (memory verdict store), and a stub
 * `connectors:describe-tools` standing in for @ax/mcp-client.
 */

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];
let currentActor: { id: string; isAdmin: boolean } | null = null;

/** What the stub inventory answers, and what it was asked. */
let inventory: {
  status: 'ok' | 'unreachable' | 'needs-auth' | 'unknown';
  tools: (ns: string) => Array<Record<string, unknown>>;
} = { status: 'ok', tools: () => [] };
let inventoryCalls: Array<{ userId: string; connectorId: string; force?: boolean }> = [];
let inventoryThrows = false;

function authStubPlugin(): Plugin {
  return {
    manifest: {
      name: 'auth-stub',
      version: '0.0.0',
      registers: ['auth:require-user'],
      calls: [],
      subscribes: [],
    },
    async init({ bus }) {
      bus.registerService('auth:require-user', 'auth-stub', async () => {
        if (currentActor === null) {
          throw new PluginError({
            code: 'unauthenticated',
            plugin: 'auth-stub',
            hookName: 'auth:require-user',
            message: 'no session',
          });
        }
        return { user: currentActor };
      });
    },
  };
}

function inventoryStubPlugin(): Plugin {
  return {
    manifest: {
      name: 'inventory-stub',
      version: '0.0.0',
      registers: ['connectors:describe-tools'],
      calls: [],
      subscribes: [],
    },
    async init({ bus }) {
      bus.registerService(
        'connectors:describe-tools',
        'inventory-stub',
        async (_ctx, input: { userId: string; connectorId: string; force?: boolean }) => {
          inventoryCalls.push(input);
          if (inventoryThrows) throw new Error('inventory exploded');
          const ns = deriveToolNamespace(input.userId, input.connectorId, 'linear');
          return {
            status: inventory.status,
            tools: inventory.tools(ns),
            checkedAt: '2026-10-02T00:00:00.000Z',
          };
        },
      );
    },
  };
}

async function makeHarness(opts: { toolPolicy?: boolean; inventory?: boolean } = {}) {
  const plugins: Plugin[] = [
    createDatabasePostgresPlugin({ connectionString }),
    authStubPlugin(),
    createConnectorsPlugin(),
  ];
  if (opts.toolPolicy !== false) {
    plugins.push(
      createToolPolicyPlugin({
        egressStore: createMemoryEgressAllowlistStore(),
        verdictStore: createMemoryVerdictStore(),
      }),
    );
  }
  if (opts.inventory !== false) plugins.push(inventoryStubPlugin());
  const h = await createTestHarness({ plugins });
  harnesses.push(h);
  return h;
}

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 60_000);

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

afterEach(async () => {
  currentActor = null;
  inventory = { status: 'ok', tools: () => [] };
  inventoryCalls = [];
  inventoryThrows = false;
  while (harnesses.length > 0) {
    const h = harnesses.pop();
    if (h) await h.close();
  }
  const cleanup = new (await import('pg')).default.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('TRUNCATE connectors_v1_connectors, connectors_v1_authored');
  } finally {
    await cleanup.end();
  }
});

function caps(): Capabilities {
  return {
    allowedHosts: ['mcp.linear.app'],
    credentials: [],
    mcpServers: [
      {
        name: 'linear',
        transport: 'http',
        url: 'https://mcp.linear.app/mcp',
        allowedHosts: ['mcp.linear.app'],
        credentials: [],
      },
    ],
    packages: { npm: [], pypi: [] },
  };
}

function makeReq(opts: {
  params?: Record<string, string>;
  body?: unknown;
  query?: Record<string, string>;
}): RouteRequest {
  return {
    headers: {},
    body:
      opts.body === undefined
        ? Buffer.alloc(0)
        : Buffer.from(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)),
    cookies: {},
    query: opts.query ?? {},
    params: opts.params ?? {},
    signedCookie: () => null,
  };
}

function makeRes() {
  const captured: { status: number; body: unknown } = { status: 0, body: undefined };
  const res: RouteResponse = {
    status(n) {
      captured.status = n;
      return res;
    },
    json(v) {
      captured.body = v;
    },
    text(s) {
      captured.body = s;
    },
    end() {},
  };
  return { res, captured };
}

async function create(
  h: TestHarness,
  mode: ConnectorRouteMode,
  body: Record<string, unknown>,
): Promise<void> {
  const handlers = createConnectorRouteHandlers({ bus: h.bus, mode });
  const { res, captured } = makeRes();
  await handlers.create(makeReq({ body }), res);
  if (captured.status !== 201) {
    throw new Error(`seed failed: ${captured.status} ${JSON.stringify(captured.body)}`);
  }
}

async function getPerms(
  h: TestHarness,
  mode: ConnectorRouteMode,
  id: string,
  query?: Record<string, string>,
) {
  const handlers = createConnectorRouteHandlers({ bus: h.bus, mode });
  const { res, captured } = makeRes();
  await handlers.toolPermissions(makeReq({ params: { id }, ...(query && { query }) }), res);
  return captured;
}

async function putPerms(h: TestHarness, mode: ConnectorRouteMode, id: string, body: unknown) {
  const handlers = createConnectorRouteHandlers({ bus: h.bus, mode });
  const { res, captured } = makeRes();
  await handlers.setToolPermissions(makeReq({ params: { id }, body }), res);
  return captured;
}

const linear = {
  connectorId: 'linear',
  name: 'Linear',
  keyMode: 'personal',
  visibility: 'shared',
  capabilities: caps(),
};

function linearTools(ns: string) {
  return [
    {
      name: 'search_issues',
      title: 'Search issues',
      description: 'Finds issues.',
      readOnly: true,
      outward: false,
      toolKey: `mcp.${ns}.search_issues`,
    },
    {
      name: 'create_issue',
      title: 'Create issue',
      description: 'x'.repeat(5000),
      readOnly: false,
      outward: true,
      toolKey: `mcp.${ns}.create_issue`,
    },
    // A row that is not this connector's (a misbehaving inventory) never
    // reaches the editor.
    {
      name: 'stray',
      title: 'Stray',
      description: '',
      readOnly: true,
      outward: false,
      toolKey: 'mcp.c0000000000.stray',
    },
  ];
}

describe('tool-permissions routes — read', () => {
  it('returns the inventory (own tools only, text clamped) and no defaults yet', async () => {
    const h = await makeHarness();
    currentActor = { id: 'admin1', isAdmin: true };
    await create(h, 'admin', linear);
    inventory = { status: 'ok', tools: linearTools };
    const ns = deriveToolNamespace('admin1', 'linear', 'linear');

    const got = await getPerms(h, 'admin', 'linear');
    expect(got.status).toBe(200);
    const body = got.body as {
      status: string;
      checkedAt: string;
      tools: Array<{ toolKey: string; description: string }>;
      defaults: unknown[];
    };
    expect(body.status).toBe('ok');
    expect(body.checkedAt).toBe('2026-10-02T00:00:00.000Z');
    expect(body.tools.map((t) => t.toolKey)).toEqual([
      `mcp.${ns}.search_issues`,
      `mcp.${ns}.create_issue`,
    ]);
    expect(body.tools[1]!.description.length).toBe(1000);
    expect(body.defaults).toEqual([]);
    expect(inventoryCalls).toEqual([{ userId: 'admin1', connectorId: 'linear' }]);
  });

  it('refresh=1 asks the inventory to check the server again', async () => {
    const h = await makeHarness();
    currentActor = { id: 'admin1', isAdmin: true };
    await create(h, 'admin', linear);
    await getPerms(h, 'admin', 'linear', { refresh: '1' });
    expect(inventoryCalls).toEqual([{ userId: 'admin1', connectorId: 'linear', force: true }]);
  });

  it('an unavailable inventory still answers, with the saved defaults', async () => {
    const h = await makeHarness();
    currentActor = { id: 'admin1', isAdmin: true };
    await create(h, 'admin', linear);
    const ns = deriveToolNamespace('admin1', 'linear', 'linear');
    expect(
      (await putPerms(h, 'admin', 'linear', {
        verdicts: [{ toolKey: `mcp.${ns}.create_issue`, verdict: 'deny' }],
      })).status,
    ).toBe(200);

    inventoryThrows = true;
    const got = await getPerms(h, 'admin', 'linear');
    expect(got.status).toBe(200);
    expect(got.body).toEqual({
      status: 'unknown',
      checkedAt: null,
      tools: [],
      defaults: [{ toolKey: `mcp.${ns}.create_issue`, verdict: 'deny' }],
    });
  });

  it('without an inventory service the read says unknown, not an error', async () => {
    const h = await makeHarness({ inventory: false });
    currentActor = { id: 'admin1', isAdmin: true };
    await create(h, 'admin', linear);
    const got = await getPerms(h, 'admin', 'linear');
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ status: 'unknown', tools: [], defaults: [] });
  });

  it('503 when no permission store is loaded', async () => {
    const h = await makeHarness({ toolPolicy: false });
    currentActor = { id: 'admin1', isAdmin: true };
    await create(h, 'admin', linear);
    expect((await getPerms(h, 'admin', 'linear')).status).toBe(503);
    expect(
      (await putPerms(h, 'admin', 'linear', { verdicts: [] })).status,
    ).toBe(503);
  });
});

describe('tool-permissions routes — authz', () => {
  it('401 signed out', async () => {
    const h = await makeHarness();
    currentActor = null;
    expect((await getPerms(h, 'user', 'linear')).status).toBe(401);
    expect((await putPerms(h, 'user', 'linear', { verdicts: [] })).status).toBe(401);
  });

  it('403 on the admin surface for a non-admin', async () => {
    const h = await makeHarness();
    currentActor = { id: 'u1', isAdmin: false };
    expect((await getPerms(h, 'admin', 'linear')).status).toBe(403);
    expect((await putPerms(h, 'admin', 'linear', { verdicts: [] })).status).toBe(403);
  });

  it('403 read-only for someone who can see a shared connector but not edit it — and nothing is written', async () => {
    const h = await makeHarness();
    currentActor = { id: 'admin1', isAdmin: true };
    await create(h, 'admin', linear);
    const ns = deriveToolNamespace('admin1', 'linear', 'linear');

    currentActor = { id: 'u2', isAdmin: false };
    const read = await getPerms(h, 'user', 'linear');
    expect(read.status).toBe(403);
    expect(read.body).toEqual({ error: 'read-only' });
    const write = await putPerms(h, 'user', 'linear', {
      verdicts: [{ toolKey: `mcp.${ns}.create_issue`, verdict: 'allow' }],
    });
    expect(write.status).toBe(403);
    expect(inventoryCalls).toEqual([]);

    currentActor = { id: 'admin1', isAdmin: true };
    expect((await getPerms(h, 'admin', 'linear')).body).toMatchObject({ defaults: [] });
  });

  it('403 for an admin who is not the connector owner (canEdit is owner-only)', async () => {
    const h = await makeHarness();
    currentActor = { id: 'admin1', isAdmin: true };
    await create(h, 'admin', linear);
    currentActor = { id: 'admin2', isAdmin: true };
    expect((await getPerms(h, 'admin', 'linear')).status).toBe(403);
  });

  it('404 for a private connector someone else owns', async () => {
    const h = await makeHarness();
    currentActor = { id: 'author', isAdmin: false };
    await create(h, 'user', { ...linear, visibility: 'private' });
    currentActor = { id: 'u2', isAdmin: false };
    expect((await getPerms(h, 'user', 'linear')).status).toBe(404);
  });

  it('a private connector author may set and read its defaults on the settings surface', async () => {
    const h = await makeHarness();
    currentActor = { id: 'author', isAdmin: false };
    await create(h, 'user', { ...linear, visibility: 'private' });
    const ns = deriveToolNamespace('author', 'linear', 'linear');
    const put = await putPerms(h, 'user', 'linear', {
      verdicts: [
        { toolKey: `mcp.${ns}.search_issues`, verdict: 'allow' },
        { toolKey: `mcp.${ns}.create_issue`, verdict: 'hold' },
      ],
    });
    expect(put).toEqual({ status: 200, body: { ok: true } });
    const got = await getPerms(h, 'user', 'linear');
    expect((got.body as { defaults: unknown[] }).defaults).toEqual([
      { toolKey: `mcp.${ns}.create_issue`, verdict: 'hold' },
      { toolKey: `mcp.${ns}.search_issues`, verdict: 'allow' },
    ]);
  });
});

describe('tool-permissions routes — validation', () => {
  async function seeded() {
    const h = await makeHarness();
    currentActor = { id: 'admin1', isAdmin: true };
    await create(h, 'admin', linear);
    await create(h, 'admin', { ...linear, connectorId: 'other', name: 'Other' });
    return {
      h,
      ns: deriveToolNamespace('admin1', 'linear', 'linear'),
      otherNs: deriveToolNamespace('admin1', 'other', 'linear'),
    };
  }

  it("refuses another connector's tool key — the other connector's defaults stay untouched", async () => {
    const { h, ns, otherNs } = await seeded();
    expect(
      (await putPerms(h, 'admin', 'other', {
        verdicts: [{ toolKey: `mcp.${otherNs}.create_issue`, verdict: 'deny' }],
      })).status,
    ).toBe(200);

    const sneaky = await putPerms(h, 'admin', 'linear', {
      verdicts: [
        { toolKey: `mcp.${ns}.search_issues`, verdict: 'allow' },
        { toolKey: `mcp.${otherNs}.create_issue`, verdict: 'allow' },
      ],
    });
    expect(sneaky.status).toBe(400);
    expect(sneaky.body).toEqual({
      error: 'not-this-connectors-tool',
      toolKey: `mcp.${otherNs}.create_issue`,
    });
    // All-or-nothing: the valid row was not written either.
    expect((await getPerms(h, 'admin', 'linear')).body).toMatchObject({ defaults: [] });
    expect((await getPerms(h, 'admin', 'other')).body).toMatchObject({
      defaults: [{ toolKey: `mcp.${otherNs}.create_issue`, verdict: 'deny' }],
    });
  });

  it.each([
    ['not json', 'nope', 'invalid-json'],
    ['no verdicts array', { verdicts: 'allow' }, 'verdicts must be an array'],
    ['a non-mcp key', { verdicts: [{ toolKey: 'Bash', verdict: 'allow' }] }, 'not-this-connectors-tool'],
  ])('400 for %s', async (_label, body, error) => {
    const { h } = await seeded();
    const out = await putPerms(h, 'admin', 'linear', body);
    expect(out.status).toBe(400);
    expect((out.body as { error: string }).error).toBe(error);
  });

  it('400 for an unknown verdict word', async () => {
    const { h, ns } = await seeded();
    const out = await putPerms(h, 'admin', 'linear', {
      verdicts: [{ toolKey: `mcp.${ns}.create_issue`, verdict: 'sure' }],
    });
    expect(out).toEqual({
      status: 400,
      body: { error: 'invalid-verdict', toolKey: `mcp.${ns}.create_issue` },
    });
  });

  it('400 for too many rows', async () => {
    const { h, ns } = await seeded();
    const verdicts = Array.from({ length: 501 }, (_, i) => ({
      toolKey: `mcp.${ns}.t${i}`,
      verdict: 'hold',
    }));
    const out = await putPerms(h, 'admin', 'linear', { verdicts });
    expect(out).toEqual({ status: 400, body: { error: 'too-many-verdicts' } });
  });

  it('null clears a saved default', async () => {
    const { h, ns } = await seeded();
    await putPerms(h, 'admin', 'linear', {
      verdicts: [{ toolKey: `mcp.${ns}.create_issue`, verdict: 'deny' }],
    });
    await putPerms(h, 'admin', 'linear', {
      verdicts: [{ toolKey: `mcp.${ns}.create_issue`, verdict: null }],
    });
    expect((await getPerms(h, 'admin', 'linear')).body).toMatchObject({ defaults: [] });
  });
});
