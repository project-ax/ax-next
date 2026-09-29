import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { PluginError, type HookBus, type Plugin } from '@ax/core';
import {
  createTestHarness,
  type TestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createCredentialsPlugin } from '@ax/credentials';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createConnectorsPlugin } from '../plugin.js';
import type { RouteRequest, RouteResponse } from '../admin-routes.js';
import type {
  Capabilities,
  KeyMode,
  ResolveInput,
  ResolveOutput,
  UpsertInput,
  UpsertOutput,
} from '../types.js';

// ---------------------------------------------------------------------------
// TASK-697 regression: a user-authored connector must not read a company key.
//
// THE BUG. A connector's vault ref is `account:<connectorId>` and the id is chosen
// by whoever authors the connector. `credentials:get` walked user -> agent ->
// global for every ref without asking which connector the ref came from, so a
// signed-in non-admin who named a connector `zendesk` was handed the company's
// `account:zendesk` key (global scope) -- with keyMode 'personal' through the
// locked-down /settings/connectors route, or keyMode 'workspace' through a row the
// un-gated admin route or the model-authored approve path had let in.
//
// REAL PIECES: postgres connectors store, the real route handlers (captured off a
// stub `http:register-route`), the real credentials vault and its DB-backed blob
// store (over an in-memory `storage:*` stub). STUBS: `auth:require-user` (the
// current actor) and `auth:get-user` (a mutable users map, so a test can demote an
// admin). Denials are read the way the credential proxy reads them: `credentials:get`
// with `{ ref, userId }`, rejecting with `credential-not-found`.
// ---------------------------------------------------------------------------

const COMPANY_KEY = 'COMPANY-ZENDESK-KEY';
const VICTIM_KEY = 'VICTIM-OWN-ZENDESK-KEY';

type Actor = { id: string; isAdmin: boolean };
const ROOT: Actor = { id: 'root', isAdmin: true };
const MALLORY: Actor = { id: 'mallory', isAdmin: false }; // signed-in NON-admin
const VICTIM: Actor = { id: 'victim', isAdmin: false };

let container: StartedPostgreSqlContainer;
let connectionString: string;
let savedCredentialsKey: string | undefined;
const harnesses: TestHarness[] = [];

/** The session the stubbed `auth:require-user` returns; null = signed out. */
let currentActor: Actor | null = null;
/** What the stubbed `auth:get-user` knows about; mutate to demote an admin. */
let users = new Map<string, Actor>();

type Handler = (req: RouteRequest, res: RouteResponse) => Promise<void>;
const routes = new Map<string, Handler>();

function authStub(): Plugin {
  return {
    manifest: {
      name: 'auth-stub',
      version: '0.0.0',
      registers: ['auth:require-user', 'auth:get-user'],
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
      bus.registerService(
        'auth:get-user',
        'auth-stub',
        async (_ctx, input: { userId: string }) => users.get(input.userId) ?? null,
      );
    },
  };
}

// Captures exactly what the connector plugin hands @ax/http-server: the handler
// with no wrapper in front of it.
function httpCaptureStub(): Plugin {
  return {
    manifest: {
      name: 'http-capture',
      version: '0.0.0',
      registers: ['http:register-route'],
      calls: [],
      subscribes: [],
    },
    async init({ bus }) {
      bus.registerService(
        'http:register-route',
        'http-capture',
        async (_ctx, r: { method: string; path: string; handler: Handler }) => {
          routes.set(`${r.method} ${r.path}`, r.handler);
          return { unregister: () => routes.delete(`${r.method} ${r.path}`) };
        },
      );
    },
  };
}

// The KV surface @ax/credentials-store-db sits on (postgres-backed in production).
function memStorage(): Plugin {
  const store = new Map<string, Uint8Array>();
  return {
    manifest: {
      name: 'mem-storage',
      version: '0.0.0',
      registers: ['storage:get', 'storage:set', 'storage:list-prefix', 'storage:delete-prefix'],
      calls: [],
      subscribes: [],
    },
    async init({ bus }: { bus: HookBus }) {
      bus.registerService(
        'storage:get',
        'mem-storage',
        async (_c, { key }: { key: string }) => ({ value: store.get(key) }),
      );
      bus.registerService(
        'storage:set',
        'mem-storage',
        async (_c, { key, value }: { key: string; value: Uint8Array }) => {
          store.set(key, value);
        },
      );
      bus.registerService(
        'storage:list-prefix',
        'mem-storage',
        async (_c, { prefix }: { prefix: string }) => {
          const entries: Array<{ key: string; value: Uint8Array }> = [];
          for (const [key, value] of store) {
            if (key.startsWith(prefix)) entries.push({ key, value });
          }
          return { entries };
        },
      );
      bus.registerService(
        'storage:delete-prefix',
        'mem-storage',
        async (_c, { prefix }: { prefix: string }) => {
          let deleted = 0;
          for (const key of [...store.keys()]) {
            if (key.startsWith(prefix)) {
              store.delete(key);
              deleted++;
            }
          }
          return { deleted };
        },
      );
    },
  };
}

async function makeHarness(): Promise<TestHarness> {
  routes.clear();
  users = new Map([
    [ROOT.id, { ...ROOT }],
    [MALLORY.id, { ...MALLORY }],
    [VICTIM.id, { ...VICTIM }],
  ]);
  const h = await createTestHarness({
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      authStub(),
      httpCaptureStub(),
      memStorage(),
      createCredentialsStoreDbPlugin(),
      createCredentialsPlugin(),
      createConnectorsPlugin({ mountAdminRoutes: true }),
    ],
  });
  harnesses.push(h);
  return h;
}

beforeAll(async () => {
  savedCredentialsKey = process.env.AX_CREDENTIALS_KEY;
  process.env.AX_CREDENTIALS_KEY = '42'.repeat(32);
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  currentActor = null;
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    await h.close({ onError: () => {} });
  }
  // Every test starts from an empty connectors table (the vault is per-harness).
  const cleanup = new (await import('pg')).default.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS connectors_v1_connectors');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (savedCredentialsKey === undefined) delete process.env.AX_CREDENTIALS_KEY;
  else process.env.AX_CREDENTIALS_KEY = savedCredentialsKey;
  if (container) await stopPostgresContainer(container);
});

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function caps(host: string, ...slots: string[]): Capabilities {
  return {
    allowedHosts: [host],
    credentials: slots.map((slot) => ({ slot, kind: 'api-key' as const })),
    mcpServers: [],
    packages: { npm: [], pypi: [] },
    services: [],
  };
}

/**
 * Put a connector row in a user's registry through the `connectors:upsert` HOOK.
 *
 * Tests that need a NON-ADMIN's workspace-keyed connector seed it here on purpose,
 * not through `/admin/connectors`: that is however such a row can get in (today the
 * admin route has no role gate, the model-authored approve path promotes a draft
 * straight through this hook, and legacy data may already hold one). Seeding at the
 * hook keeps these tests valid whether or not the admin route is later gated.
 */
async function seedConnector(
  h: TestHarness,
  userId: string,
  connectorId: string,
  keyMode: KeyMode,
  host: string,
  ...slots: string[]
): Promise<void> {
  await h.bus.call<UpsertInput, UpsertOutput>('connectors:upsert', h.ctx({ userId }), {
    userId,
    connectorId,
    name: connectorId,
    keyMode,
    visibility: 'private',
    capabilities: caps(host, ...slots),
  });
}

/** Store a key the way the connect flow / credential prompt does. */
async function setKey(
  h: TestHarness,
  scope: 'global' | 'user',
  ownerId: string | null,
  ref: string,
  value: string,
): Promise<void> {
  await h.bus.call('credentials:set', h.ctx({ userId: ownerId ?? 'root' }), {
    scope,
    ownerId,
    ref,
    kind: 'api-key',
    payload: new TextEncoder().encode(value),
  });
}

/** The company key exactly as the admin connect flow stores it. */
function setCompanyKey(h: TestHarness, ref: string, value: string): Promise<void> {
  return setKey(h, 'global', null, ref, value);
}

/** What the credential proxy does per plan entry: `credentials:get({ ref, userId })`. */
function getKey(h: TestHarness, userId: string, ref: string): Promise<string> {
  return h.bus.call<{ ref: string; userId: string }, string>(
    'credentials:get',
    h.ctx({ userId }),
    { ref, userId },
  );
}

async function expectNotFound(pending: Promise<string>): Promise<void> {
  await expect(pending).rejects.toSatisfy(
    (err: unknown) => err instanceof PluginError && err.code === 'credential-not-found',
  );
}

async function call(
  method: string,
  path: string,
  actor: Actor | null,
  opts: { params?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const handler = routes.get(`${method} ${path}`);
  if (!handler) throw new Error(`route not registered: ${method} ${path}`);
  currentActor = actor;
  const cap = { status: 0, body: undefined as unknown };
  const res: RouteResponse = {
    status(n) {
      cap.status = n;
      return res;
    },
    json(v) {
      cap.body = v;
    },
    text(s) {
      cap.body = s;
    },
    end() {
      /* 204 */
    },
  };
  const req: RouteRequest = {
    headers: {},
    cookies: {},
    query: {},
    params: opts.params ?? {},
    body: opts.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(opts.body)),
    signedCookie: () => null,
  };
  await handler(req, res);
  return cap;
}

// ---------------------------------------------------------------------------
// The regression.
// ---------------------------------------------------------------------------

describe('TASK-697: connector-authored refs vs the company-wide credential', () => {
  it('1) a non-admin workspace-keyed connector named like the company one gets nothing', async () => {
    // UNFIXED: FAILS. credentials:get(account:zendesk, mallory) resolves COMPANY_KEY (the probe's exact case).
    const h = await makeHarness();
    await setCompanyKey(h, 'account:zendesk', COMPANY_KEY);
    await seedConnector(h, 'mallory', 'zendesk', 'workspace', 'attacker.example', 'ZENDESK_API_KEY');

    await expectNotFound(getKey(h, 'mallory', 'account:zendesk'));

    // Two slots -> per-slot refs; the same holds for each of them.
    await setCompanyKey(h, 'account:zendesk2:TOKEN', 'TOKEN-VALUE');
    await setCompanyKey(h, 'account:zendesk2:EMAIL', 'EMAIL-VALUE');
    await seedConnector(h, 'mallory', 'zendesk2', 'workspace', 'attacker.example', 'TOKEN', 'EMAIL');
    await expectNotFound(getKey(h, 'mallory', 'account:zendesk2:TOKEN'));
    await expectNotFound(getKey(h, 'mallory', 'account:zendesk2:EMAIL'));

    // A user with no connector at all asking for the ref directly: same answer.
    await expectNotFound(getKey(h, 'victim', 'account:zendesk'));
  });

  it('2) a personal connector named like the company one, made through the locked-down user route, gets nothing until its owner stores their own key', async () => {
    // UNFIXED: FAILS at the first check (victim would resolve COMPANY_KEY); the own-key half is unchanged behaviour.
    const h = await makeHarness();
    await setCompanyKey(h, 'account:zendesk', COMPANY_KEY);
    await seedConnector(h, 'mallory', 'zendesk', 'workspace', 'attacker.example', 'ZENDESK_API_KEY');

    const created = await call('POST', '/settings/connectors', VICTIM, {
      body: {
        connectorId: 'zendesk',
        name: 'Mine',
        keyMode: 'personal',
        visibility: 'private',
        capabilities: caps('attacker.example', 'ZENDESK_API_KEY'),
      },
    });
    expect(created.status).toBe(201);

    await expectNotFound(getKey(h, 'victim', 'account:zendesk'));

    // Their own key, at user scope, is what resolves for them...
    await setKey(h, 'user', 'victim', 'account:zendesk', VICTIM_KEY);
    expect(await getKey(h, 'victim', 'account:zendesk')).toBe(VICTIM_KEY);

    // ...and it is theirs alone: mallory still gets neither key.
    await expectNotFound(getKey(h, 'mallory', 'account:zendesk'));
  });

  it("3) an admin's own workspace connector still resolves the company key", async () => {
    // UNFIXED: passes (unchanged-behaviour pin; proves the guard is not a blanket deny).
    const h = await makeHarness();
    await setCompanyKey(h, 'account:zendesk', COMPANY_KEY);
    // The real admin route, as the connect flow uses it.
    const created = await call('POST', '/admin/connectors', ROOT, {
      body: {
        connectorId: 'zendesk',
        name: 'Zendesk',
        keyMode: 'workspace',
        visibility: 'private',
        capabilities: caps('acme.zendesk.com', 'ZENDESK_API_KEY'),
      },
    });
    expect(created.status).toBe(201);

    expect(await getKey(h, 'root', 'account:zendesk')).toBe(COMPANY_KEY);

    // Multi-slot variant: one global row per slot, each resolves under its own ref.
    await setCompanyKey(h, 'account:zendesk2:TOKEN', 'TOKEN-VALUE');
    await setCompanyKey(h, 'account:zendesk2:EMAIL', 'EMAIL-VALUE');
    await seedConnector(h, 'root', 'zendesk2', 'workspace', 'acme.zendesk.com', 'TOKEN', 'EMAIL');
    expect(await getKey(h, 'root', 'account:zendesk2:TOKEN')).toBe('TOKEN-VALUE');
    expect(await getKey(h, 'root', 'account:zendesk2:EMAIL')).toBe('EMAIL-VALUE');
  });

  it('4) demoting the admin closes the company key at once (the role is read at request time)', async () => {
    // UNFIXED: FAILS at the last line (root would still resolve COMPANY_KEY after the demotion).
    const h = await makeHarness();
    await setCompanyKey(h, 'account:zendesk', COMPANY_KEY);
    await seedConnector(h, 'root', 'zendesk', 'workspace', 'acme.zendesk.com', 'ZENDESK_API_KEY');
    expect(await getKey(h, 'root', 'account:zendesk')).toBe(COMPANY_KEY);

    users.set('root', { id: 'root', isAdmin: false });

    await expectNotFound(getKey(h, 'root', 'account:zendesk'));
  });

  it("5) deleting a non-admin's copy through the user route leaves the company key alone", async () => {
    // UNFIXED: passes (unchanged-behaviour pin; the delete purges the global row only for an admin caller).
    const h = await makeHarness();
    await setCompanyKey(h, 'account:zendesk', COMPANY_KEY);
    await seedConnector(h, 'root', 'zendesk', 'workspace', 'acme.zendesk.com', 'ZENDESK_API_KEY');
    await seedConnector(h, 'mallory', 'zendesk', 'workspace', 'attacker.example', 'ZENDESK_API_KEY');

    const del = await call('DELETE', '/settings/connectors/:id', MALLORY, {
      params: { id: 'zendesk' },
    });
    expect(del.status).toBe(204);

    expect(await getKey(h, 'root', 'account:zendesk')).toBe(COMPANY_KEY);
  });

  it("6) the connector plan's ref is the ref the vault is asked for", async () => {
    // UNFIXED: FAILS at the credentials:get line (the plan assertions before it hold either way).
    const h = await makeHarness();
    await setCompanyKey(h, 'account:zendesk', COMPANY_KEY);
    await seedConnector(h, 'mallory', 'zendesk', 'workspace', 'attacker.example', 'ZENDESK_API_KEY');

    // The orchestrator's fold turns this plan into the refs the credential proxy
    // resolves (that fold is pinned by @ax/chat-orchestrator's own tests); asking
    // the vault for exactly plan[0].ref keeps this file on the same ref.
    const resolved = await h.bus.call<ResolveInput, ResolveOutput>(
      'connectors:resolve',
      h.ctx({ userId: 'mallory' }),
      { userId: 'mallory', connectorId: 'zendesk' },
    );
    expect(resolved.credentialPlan).toHaveLength(1);
    const entry = resolved.credentialPlan[0]!;
    expect(entry.ref).toBe('account:zendesk');
    expect(entry.scope).toBe('global');

    await expectNotFound(getKey(h, 'mallory', entry.ref));
  });

  it('7) refs outside the account: namespace still resolve from global for everyone', async () => {
    // UNFIXED: passes (unchanged-behaviour pin; the guard must not touch provider:/skill:/mcp: refs).
    const h = await makeHarness();
    const platformRefs: Array<[string, string]> = [
      ['provider:anthropic', 'PROVIDER-KEY'],
      ['skill:my-skill:API_KEY', 'SKILL-KEY'],
      ['mcp:linear:env:LINEAR_TOKEN', 'MCP-KEY'],
    ];
    for (const [ref, value] of platformRefs) await setCompanyKey(h, ref, value);
    // Give mallory a hostile workspace connector too, so "everyone" includes her.
    await seedConnector(h, 'mallory', 'zendesk', 'workspace', 'attacker.example', 'ZENDESK_API_KEY');

    for (const userId of ['root', 'mallory', 'victim', 'stranger']) {
      for (const [ref, value] of platformRefs) {
        expect(await getKey(h, userId, ref)).toBe(value);
      }
    }
  });
});
