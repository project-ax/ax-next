import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createTestHarness,
  stopPostgresContainer,
  type TestHarness,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createLogger, type ServiceHandler } from '@ax/core';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { createMcpOAuthPlugin } from '../plugin.js';
import { createMcpOAuthStore } from '../store.js';
import { encodeTokenBlob } from '../types.js';
import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { McpOAuthDatabase } from '../migrations.js';

// ---------------------------------------------------------------------------
// @ax/mcp-oauth plugin factory: migration + resolver service + (optional)
// begin/callback HTTP routes. Driven through the bus against a real postgres
// testcontainer (mirrors @ax/connectors hooks.test.ts).
//
// The resolver service is registered ALWAYS (harmless even when @ax/credentials
// isn't loaded — nothing calls it then). The routes are mounted only when
// `mountRoutes:true`, which additionally requires `publicOrigin`.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

/** Stubs for every required `calls` hook the routes declare. The route handlers
 *  aren't invoked in these tests — the stubs only need to EXIST so bootstrap's
 *  post-init `verifyCalls` doesn't fail the boot on a missing producer. */
type RouteRecord = { method: string; path: string };

function routeStubServices(recorded: RouteRecord[]): Record<string, ServiceHandler> {
  return {
    // Records the {method, path} so we can assert the routes were registered.
    'http:register-route': (async (_ctx, input) => {
      const { method, path } = input as RouteRecord;
      recorded.push({ method, path });
      return { unregister: () => {} };
    }) as ServiceHandler,
    'auth:require-user': (async () => ({
      user: { id: 'u', isAdmin: false },
    })) as ServiceHandler,
    'connectors:get': (async () => ({ connector: {} })) as ServiceHandler,
    'agents:resolve': (async () => ({ agent: {} })) as ServiceHandler,
    'credentials:get': (async () => '') as ServiceHandler,
    'credentials:set': (async () => undefined) as ServiceHandler,
    'credentials:delete': (async () => undefined) as ServiceHandler,
  };
}

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    await h.close({ onError: () => {} });
  }
  const cleanup = new (await import('pg')).default.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS mcp_oauth_v1_clients');
    await cleanup.query('DROP TABLE IF EXISTS mcp_oauth_v1_pending');
    await cleanup.query('DROP TABLE IF EXISTS mcp_oauth_v1_needs_reconnect');
    await cleanup.query('DROP TABLE IF EXISTS mcp_oauth_v1_needs_reconnect_agent');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('@ax/mcp-oauth plugin manifest', () => {
  it('registers credentials:resolve:mcp-oauth and hard-calls database:get-instance; mountRoutes extends calls', () => {
    const off = createMcpOAuthPlugin();
    expect(off.manifest.name).toBe('@ax/mcp-oauth');
    expect(off.manifest.registers).toContain('credentials:resolve:mcp-oauth');
    expect(off.manifest.registers).toContain('mcp-oauth:status-batch');
    // TASK-858 — removing a team sign-in deletes a vault row, so it needs the
    // routes' `credentials:delete` dependency; without the routes it is absent.
    expect(off.manifest.registers).not.toContain('mcp-oauth:remove-shared-sign-in');
    expect(off.manifest.calls).toEqual(['database:get-instance']);
    // TASK-718: a deleted agent's in-flight handshakes go with it. Subscribed
    // whether or not the routes are mounted — the table exists either way.
    expect(off.manifest.subscribes).toEqual(['agents:deleted']);

    const on = createMcpOAuthPlugin({
      mountRoutes: true,
      publicOrigin: 'https://example.com',
    });
    // Always registers the resolver sub-service.
    expect(on.manifest.registers).toEqual([
      'credentials:resolve:mcp-oauth',
      'mcp-oauth:status-batch',
      'mcp-oauth:remove-shared-sign-in',
    ]);
    expect(on.manifest.subscribes).toEqual(['agents:deleted']);
    // The route handlers call these; mountRoutes pushes them onto `calls`.
    expect(on.manifest.calls).toEqual([
      'database:get-instance',
      'http:register-route',
      'auth:require-user',
      'connectors:get',
      'agents:resolve',
      'credentials:get',
      'credentials:set',
      'credentials:delete',
    ]);
    // TASK-813 — the team-admin check is declared (optional: without
    // @ax/agents nobody may start a sign-in on a team agent), and the wider
    // manage-connectors question (workspace-admin bypass) is no longer asked.
    const optional = on.manifest.optionalCalls?.map((c) => c.hook);
    expect(optional).toContain('agents:can-set-shared-credential');
    expect(optional).not.toContain('agents:can-manage-connectors');
  });
});

describe('@ax/mcp-oauth plugin init (mountRoutes:false)', () => {
  it('registers the resolver service and runs its migration (both tables exist)', async () => {
    const h = await createTestHarness({
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        createMcpOAuthPlugin(),
      ],
    });
    harnesses.push(h);

    expect(h.bus.hasService('credentials:resolve:mcp-oauth')).toBe(true);

    // The migration ran: both owned tables exist AND are usable. We exercise
    // them through the store (a write + read round-trip) rather than peeking at
    // information_schema — that proves the migrated columns line up with what
    // the store expects, not merely that a table of the right name exists.
    const { db } = await h.bus.call<unknown, { db: Kysely<McpOAuthDatabase> }>(
      'database:get-instance',
      h.ctx(),
      {},
    );
    const store = createMcpOAuthStore(db);

    // mcp_oauth_v1_clients — a READ-ONLY legacy fallback: the store can no longer
    // write it, so seed a row directly (as the pre-TASK-696 code would have) and
    // prove the migrated table lines up with what `getClient` reads.
    await db
      .insertInto('mcp_oauth_v1_clients')
      .values({
        client_key: 'c|https://auth.example.com',
        client_id: 'cid',
        client_secret: null,
        dynamic: true,
        created_at: new Date(),
      })
      .execute();
    const client = await store.getClient('c|https://auth.example.com');
    expect(client?.clientId).toBe('cid');

    // mcp_oauth_v1_pending — including the client_id / client_secret columns the
    // migration adds (a token is redeemed as the client its authorization started with).
    await store.putPending({
      state: 'st1',
      userId: 'u',
      agentId: 'a',
      connectorId: 'conn',
      slot: 'gdrive',
      codeVerifier: 'cv',
      authServerUrl: 'https://auth.example.com',
      clientKey: 'c|https://auth.example.com',
      clientId: 'pending-cid',
      clientSecret: 'pending-secret',
      resource: 'https://mcp.example.com',
      scope: 'read',
      credScope: 'agent',
      createdAt: Date.now(),
    });
    const pending = await store.getPending('st1');
    expect(pending?.userId).toBe('u');
    expect(pending?.clientId).toBe('pending-cid');
    expect(pending?.clientSecret).toBe('pending-secret');
  });
});

describe('@ax/mcp-oauth needs-reconnect marker + status-batch (TASK-741)', () => {
  const expiredBlob = () =>
    encodeTokenBlob({
      accessToken: 'old',
      refreshToken: 'rt1',
      tokenType: 'Bearer',
      expiresAt: 0,
      resource: 'https://mcp.example.com',
      authServerUrl: 'https://auth.example.com',
      tokenEndpoint: 'https://auth.example.com/token',
      clientKey: 'gmail|https://auth.example.com',
      clientId: 'cid',
    });

  it('a rejected refresh marks the connector, status-batch reports it without refreshing, a good refresh clears it', async () => {
    let reject = true;
    const refresh = vi.fn(async () => {
      if (reject) throw new InvalidGrantError('revoked');
      return { access_token: 'new', refresh_token: 'rt2', expires_in: 3600 };
    });
    const h = await createTestHarness({
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        createMcpOAuthPlugin({ testOverrides: { refresh } }),
      ],
    });
    harnesses.push(h);
    const batch = async (connectorIds: string[], userId = 'u1') =>
      (
        await h.bus.call<unknown, { needsReconnect: string[] }>('mcp-oauth:status-batch', h.ctx(), {
          userId,
          connectorIds,
        })
      ).needsReconnect;

    expect(await batch(['gmail', 'slack'])).toEqual([]);

    await expect(
      h.bus.call('credentials:resolve:mcp-oauth', h.ctx(), {
        payload: expiredBlob(),
        userId: 'u1',
        ref: 'account:gmail',
      }),
    ).rejects.toThrow();
    expect(refresh).toHaveBeenCalledTimes(1);

    // The batch read is store-only: it never reaches the refresh.
    expect(await batch(['gmail', 'slack'])).toEqual(['gmail']);
    // Keyed on the user: someone else's sign-in is not reported.
    expect(await batch(['gmail'], 'u2')).toEqual([]);
    expect(refresh).toHaveBeenCalledTimes(1);

    reject = false;
    await h.bus.call('credentials:resolve:mcp-oauth', h.ctx(), {
      payload: expiredBlob(),
      userId: 'u1',
      ref: 'account:gmail',
    });
    expect(await batch(['gmail', 'slack'])).toEqual([]);
  });

  // TASK-817 — the provider refused an UNEXPIRED token (revoked on its side).
  // The caller says so (`rejected`), the renewal is refused too, and from then
  // on the same unexpired token is no longer handed out: the rail reads the
  // marker, and the next ordinary resolve (a chat turn's proxy open) fails as
  // "reconnect" instead of opening a session that silently lacks the tools.
  it('a refused unexpired token: rejected resolve marks it, and later ordinary resolves stop answering it until a renewal works', async () => {
    let reject = true;
    const refresh = vi.fn(async () => {
      if (reject) throw new InvalidGrantError('revoked');
      return { access_token: 'new', refresh_token: 'rt2', expires_in: 3600 };
    });
    const h = await createTestHarness({
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        createMcpOAuthPlugin({ testOverrides: { refresh } }),
      ],
    });
    harnesses.push(h);
    const unexpired = encodeTokenBlob({
      accessToken: 'refused',
      refreshToken: 'rt1',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 60 * 60_000,
      resource: 'https://mcp.example.com',
      authServerUrl: 'https://auth.example.com',
      tokenEndpoint: 'https://auth.example.com/token',
      clientKey: 'gmail|https://auth.example.com',
      clientId: 'cid',
    });
    const resolve = (extra: Record<string, unknown> = {}) =>
      h.bus.call<unknown, { value: string }>('credentials:resolve:mcp-oauth', h.ctx(), {
        payload: unexpired,
        userId: 'u1',
        ref: 'account:gmail',
        ...extra,
      });
    const batch = async () =>
      (
        await h.bus.call<unknown, { needsReconnect: string[] }>('mcp-oauth:status-batch', h.ctx(), {
          userId: 'u1',
          connectorIds: ['gmail'],
        })
      ).needsReconnect;

    // Before anyone saw the refusal: the clock says valid, nothing is asked.
    expect((await resolve()).value).toBe('refused');
    expect(refresh).not.toHaveBeenCalled();

    await expect(resolve({ rejected: true })).rejects.toThrow();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await batch()).toEqual(['gmail']);

    // The same unexpired token is no longer answered while the marker stands.
    await expect(resolve()).rejects.toThrow(/reconnect/i);

    // The provider recovers: the next resolve renews, clears the marker.
    reject = false;
    expect((await resolve()).value).toBe('new');
    expect(await batch()).toEqual([]);
  });

  // TASK-756 — a team agent's token is the agent's (vault scope `agent`): one
  // member's rejected refresh shows for every member, as SHARED, and one
  // member's good refresh clears it for all of them.
  it('an agent-scope rejection is shared across members; a personal one stays per user', async () => {
    let reject = true;
    const refresh = vi.fn(async () => {
      if (reject) throw new InvalidGrantError('revoked');
      return { access_token: 'new', refresh_token: 'rt2', expires_in: 3600 };
    });
    const h = await createTestHarness({
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        createMcpOAuthPlugin({ testOverrides: { refresh } }),
      ],
    });
    harnesses.push(h);
    const batch = (userId: string, agentId: string | undefined, connectorIds: string[]) =>
      h.bus.call<unknown, { needsReconnect: string[]; shared: string[] }>('mcp-oauth:status-batch', h.ctx(), {
        userId,
        ...(agentId !== undefined ? { agentId } : {}),
        connectorIds,
      });
    const resolveAs = (userId: string, scope: 'user' | 'agent', ownerId: string, ref: string) =>
      h.bus.call('credentials:resolve:mcp-oauth', h.ctx(), {
        payload: expiredBlob(),
        userId,
        ref,
        scope,
        ownerId,
      });

    await expect(resolveAs('u1', 'agent', 'team-1', 'account:gmail')).rejects.toThrow();
    await expect(resolveAs('u1', 'user', 'u1', 'account:slack')).rejects.toThrow();

    expect(await batch('u1', 'team-1', ['gmail', 'slack'])).toEqual({
      needsReconnect: ['slack', 'gmail'],
      shared: ['gmail'],
    });
    // Another member sees the shared one, and not u1's personal one.
    expect(await batch('u2', 'team-1', ['gmail', 'slack'])).toEqual({
      needsReconnect: ['gmail'],
      shared: ['gmail'],
    });

    // u2's good refresh of the SHARED token clears it for u1 too.
    reject = false;
    await resolveAs('u2', 'agent', 'team-1', 'account:gmail');
    expect(await batch('u1', 'team-1', ['gmail', 'slack'])).toEqual({
      needsReconnect: ['slack'],
      shared: [],
    });
    // ...and u2's success says nothing about u1's personal sign-in.
    await resolveAs('u2', 'user', 'u2', 'account:slack');
    expect((await batch('u1', 'team-1', ['slack'])).needsReconnect).toEqual(['slack']);
  });

  it('a connector whose own AND shared sign-in were rejected reads as the caller\'s own', async () => {
    const refresh = vi.fn(async () => {
      throw new InvalidGrantError('revoked');
    });
    const h = await createTestHarness({
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        createMcpOAuthPlugin({ testOverrides: { refresh } }),
      ],
    });
    harnesses.push(h);
    for (const [scope, ownerId] of [['agent', 'team-1'], ['user', 'u1']] as const) {
      await expect(
        h.bus.call('credentials:resolve:mcp-oauth', h.ctx(), {
          payload: expiredBlob(), userId: 'u1', ref: 'account:gmail', scope, ownerId,
        }),
      ).rejects.toThrow();
    }
    expect(
      await h.bus.call('mcp-oauth:status-batch', h.ctx(), { userId: 'u1', agentId: 'team-1', connectorIds: ['gmail'] }),
    ).toEqual({ needsReconnect: ['gmail'], shared: [] });
  });

  it('status-batch refuses a malformed request', async () => {
    const h = await createTestHarness({
      plugins: [createDatabasePostgresPlugin({ connectionString }), createMcpOAuthPlugin()],
    });
    harnesses.push(h);
    await expect(
      h.bus.call('mcp-oauth:status-batch', h.ctx(), { userId: '', connectorIds: [] }),
    ).rejects.toThrow();
    await expect(
      h.bus.call('mcp-oauth:status-batch', h.ctx(), {
        userId: 'u1',
        connectorIds: Array.from({ length: 501 }, (_, i) => `c${i}`),
      }),
    ).rejects.toThrow();
  });
});

// TASK-858 — a team admin removes the agent's shared sign-in. The hook deletes
// the vault row THEN clears the agent's needs-reconnect marker, so a removed
// sign-in reads "needs sign-in", not a stale "expired". Driven through the bus
// with the real marker store; only the vault's `credentials:delete` is a stub.
describe('@ax/mcp-oauth mcp-oauth:remove-shared-sign-in (TASK-858)', () => {
  const HOOK = 'mcp-oauth:remove-shared-sign-in';

  type DeleteInput = { scope: string; ownerId: string | null; ref: string };

  async function boot(
    del: (input: DeleteInput) => unknown = () => undefined,
  ): Promise<{ h: TestHarness; store: ReturnType<typeof createMcpOAuthStore>; deletes: DeleteInput[] }> {
    const deletes: DeleteInput[] = [];
    const services = routeStubServices([]);
    services['credentials:delete'] = (async (_ctx, input) => {
      deletes.push(input as DeleteInput);
      return del(input as DeleteInput);
    }) as ServiceHandler;
    const h = await createTestHarness({
      services,
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        createMcpOAuthPlugin({ mountRoutes: true, publicOrigin: 'https://example.com' }),
      ],
    });
    harnesses.push(h);
    const { db } = await h.bus.call<unknown, { db: Kysely<McpOAuthDatabase> }>(
      'database:get-instance',
      h.ctx(),
      {},
    );
    return { h, store: createMcpOAuthStore(db), deletes };
  }

  const batch = (h: TestHarness, userId: string, agentId: string | undefined, connectorIds: string[]) =>
    h.bus.call<unknown, { needsReconnect: string[]; shared: string[] }>('mcp-oauth:status-batch', h.ctx(), {
      userId,
      ...(agentId !== undefined ? { agentId } : {}),
      connectorIds,
    });

  it('deletes the agent-scope sign-in row for that connector and answers { removed: true }', async () => {
    const { h, deletes } = await boot();

    const out = await h.bus.call(HOOK, h.ctx(), { agentId: 'team-1', connectorId: 'gmail' });

    expect(out).toEqual({ removed: true });
    // Exactly the row the OAuth callback wrote for a team agent: scope agent,
    // owned by the agent, ref `account:<connector>`. Never a user-scope row.
    expect(deletes).toEqual([{ scope: 'agent', ownerId: 'team-1', ref: 'account:gmail' }]);
  });

  it("clears the agent's needs-reconnect marker, so the rail stops saying the team sign-in expired", async () => {
    const { h, store } = await boot();
    await store.markNeedsReconnect({ kind: 'agent', agentId: 'team-1' }, 'gmail');
    expect(await batch(h, 'u1', 'team-1', ['gmail'])).toEqual({
      needsReconnect: ['gmail'],
      shared: ['gmail'],
    });

    await h.bus.call(HOOK, h.ctx(), { agentId: 'team-1', connectorId: 'gmail' });

    expect(await batch(h, 'u1', 'team-1', ['gmail'])).toEqual({ needsReconnect: [], shared: [] });
  });

  it('leaves other connectors, other agents and every user-scope marker alone', async () => {
    const { h, store } = await boot();
    await store.markNeedsReconnect({ kind: 'agent', agentId: 'team-1' }, 'gmail');
    await store.markNeedsReconnect({ kind: 'agent', agentId: 'team-1' }, 'slack');
    await store.markNeedsReconnect({ kind: 'agent', agentId: 'team-2' }, 'gmail');
    // u1's OWN sign-in to the same connector is theirs, not the team's.
    await store.markNeedsReconnect({ kind: 'user', userId: 'u1' }, 'gmail');

    await h.bus.call(HOOK, h.ctx(), { agentId: 'team-1', connectorId: 'gmail' });

    expect(await store.hasNeedsReconnect({ kind: 'agent', agentId: 'team-1' }, 'gmail')).toBe(false);
    expect(await store.hasNeedsReconnect({ kind: 'agent', agentId: 'team-1' }, 'slack')).toBe(true);
    expect(await store.hasNeedsReconnect({ kind: 'agent', agentId: 'team-2' }, 'gmail')).toBe(true);
    expect(await store.hasNeedsReconnect({ kind: 'user', userId: 'u1' }, 'gmail')).toBe(true);
    // The same view the rail reads: u1's own marker still wins for the connector.
    expect(await batch(h, 'u1', 'team-1', ['gmail', 'slack'])).toEqual({
      needsReconnect: ['gmail', 'slack'],
      shared: ['slack'],
    });
  });

  it('is idempotent: removing a sign-in that is already gone (no marker, no row) still succeeds', async () => {
    const { h, deletes } = await boot();
    const input = { agentId: 'team-1', connectorId: 'gmail' };
    expect(await h.bus.call(HOOK, h.ctx(), input)).toEqual({ removed: true });
    expect(await h.bus.call(HOOK, h.ctx(), input)).toEqual({ removed: true });
    expect(deletes).toHaveLength(2);
  });

  // The order is the point: clearing the marker FIRST would re-trust a marked,
  // still-unexpired token (TASK-817) if the delete then failed. A failed delete
  // must leave the marker exactly where it was and tell the caller.
  it('deletes BEFORE clearing: a failing delete leaves the marker in place and the error reaches the caller', async () => {
    const { h, store } = await boot(() => {
      throw new Error('vault down');
    });
    await store.markNeedsReconnect({ kind: 'agent', agentId: 'team-1' }, 'gmail');

    await expect(
      h.bus.call(HOOK, h.ctx(), { agentId: 'team-1', connectorId: 'gmail' }),
    ).rejects.toThrow(/vault down/);

    expect(await store.hasNeedsReconnect({ kind: 'agent', agentId: 'team-1' }, 'gmail')).toBe(true);
  });

  it('a marker that cannot be cleared is logged by error name and swallowed — the sign-in is already gone', async () => {
    const { h } = await boot();
    // Break the marker store out from under the hook: the DELETE now fails with
    // "relation does not exist".
    const c = new pg.Client({ connectionString });
    await c.connect();
    try {
      await c.query('DROP TABLE mcp_oauth_v1_needs_reconnect_agent');
    } finally {
      await c.end().catch(() => {});
    }
    const lines: string[] = [];
    const ctx = h.ctx({ logger: createLogger({ reqId: 'req-rm', writer: (l) => lines.push(l) }) });

    const out = await h.bus.call(HOOK, ctx, { agentId: 'team-1', connectorId: 'gmail' });

    expect(out).toEqual({ removed: true });
    const warn = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((e) => e.msg === 'mcp_oauth_needs_reconnect_clear_failed');
    expect(warn).toMatchObject({ level: 'warn', connectorId: 'gmail' });
    expect(typeof warn?.name).toBe('string');
    // Name only: the raw error (SQL, table names) is not logged.
    expect(JSON.stringify(warn)).not.toMatch(/relation|mcp_oauth_v1/);
  });

  it.each([
    ['no agentId', { connectorId: 'gmail' }],
    ['no connectorId', { agentId: 'team-1' }],
    ['an empty agentId', { agentId: '', connectorId: 'gmail' }],
    ['an empty connectorId', { agentId: 'team-1', connectorId: '' }],
    ['a non-string agentId', { agentId: 42, connectorId: 'gmail' }],
    ['an oversized connectorId', { agentId: 'team-1', connectorId: 'c'.repeat(129) }],
    ['an unknown field (e.g. a caller trying to pick the scope)', { agentId: 'team-1', connectorId: 'gmail', scope: 'user' }],
    ['null', null],
  ])('refuses %s with invalid-payload, and touches neither the vault nor the marker', async (_case, bad) => {
    const { h, store, deletes } = await boot();
    await store.markNeedsReconnect({ kind: 'agent', agentId: 'team-1' }, 'gmail');

    await expect(h.bus.call(HOOK, h.ctx(), bad)).rejects.toMatchObject({ code: 'invalid-payload' });

    expect(deletes).toEqual([]);
    expect(await store.hasNeedsReconnect({ kind: 'agent', agentId: 'team-1' }, 'gmail')).toBe(true);
  });

  it('is not registered when the routes are not mounted (it needs credentials:delete)', async () => {
    const h = await createTestHarness({
      plugins: [createDatabasePostgresPlugin({ connectionString }), createMcpOAuthPlugin()],
    });
    harnesses.push(h);
    expect(h.bus.hasService(HOOK)).toBe(false);
    expect(h.bus.hasService('mcp-oauth:status-batch')).toBe(true);
  });
});

describe('@ax/mcp-oauth plugin init (mountRoutes:true)', () => {
  it('registers the begin (POST) + callback (GET) routes', async () => {
    const recorded: RouteRecord[] = [];
    const h = await createTestHarness({
      services: routeStubServices(recorded),
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        createMcpOAuthPlugin({
          mountRoutes: true,
          publicOrigin: 'https://example.com',
        }),
      ],
    });
    harnesses.push(h);

    expect(recorded).toContainEqual({
      method: 'POST',
      path: '/api/connectors/oauth/discover-hosts',
    });
    expect(recorded).toContainEqual({
      method: 'POST',
      path: '/api/connectors/oauth/begin',
    });
    expect(recorded).toContainEqual({
      method: 'GET',
      path: '/api/connectors/oauth/callback',
    });
  });

  it('wires the authenticated host preview through the running plugin', async () => {
    const services = routeStubServices([]);
    let previewHandler!: (req: unknown, res: unknown) => Promise<void>;
    services['http:register-route'] = (async (_ctx, input) => {
      const route = input as { path: string; handler: typeof previewHandler };
      if (route.path === '/api/connectors/oauth/discover-hosts') previewHandler = route.handler;
      return { unregister: () => {} };
    }) as ServiceHandler;
    const preview = vi.fn(async () => ({ hosts: ['accounts.google.com', 'gmailmcp.googleapis.com', 'oauth2.googleapis.com'] }));
    const h = await createTestHarness({
      services,
      plugins: [createDatabasePostgresPlugin({ connectionString }), createMcpOAuthPlugin({
        mountRoutes: true, publicOrigin: 'https://example.com', testOverrides: { discoverHosts: preview },
      })],
    });
    harnesses.push(h);
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await previewHandler({ body: Buffer.from(JSON.stringify({ url: 'https://gmailmcp.googleapis.com/mcp/v1' })) }, response);
    expect(preview).toHaveBeenCalledWith({ resourceUrl: 'https://gmailmcp.googleapis.com/mcp/v1' });
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(await preview.mock.results[0]!.value);
  });

  it.each([
    ['a branding plugin is loaded', { name: '  Canopy\u202e AI ' }, 'Canopy AI'],
    ['branding has no name set', { name: null }, 'AX'],
    ['the branding read fails', new Error('storage down'), 'AX'],
    ['no branding plugin is loaded', undefined, 'AX'],
  ] as const)('names the published OAuth client when %s', async (_case, branding, expected) => {
    const services = routeStubServices([]);
    let metadataHandler!: (req: unknown, res: unknown) => Promise<void>;
    services['http:register-route'] = (async (_ctx, input) => {
      const route = input as { path: string; handler: typeof metadataHandler };
      if (route.path === '/api/connectors/oauth/client-metadata') metadataHandler = route.handler;
      return { unregister: () => {} };
    }) as ServiceHandler;
    if (branding !== undefined) {
      services['branding:get'] = (async () => {
        if (branding instanceof Error) throw branding;
        return branding;
      }) as ServiceHandler;
    }
    const h = await createTestHarness({
      services,
      plugins: [createDatabasePostgresPlugin({ connectionString }), createMcpOAuthPlugin({
        mountRoutes: true, publicOrigin: 'https://example.com',
      })],
    });
    harnesses.push(h);
    const response = { status: vi.fn().mockReturnThis(), header: vi.fn().mockReturnThis(), json: vi.fn() };
    await metadataHandler({}, response);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ client_name: expected }));
  });

  it('throws a clear error when mountRoutes is set without publicOrigin', async () => {
    await expect(
      createTestHarness({
        services: routeStubServices([]),
        plugins: [
          createDatabasePostgresPlugin({ connectionString }),
          createMcpOAuthPlugin({ mountRoutes: true }),
        ],
      }),
    ).rejects.toThrow(/publicOrigin/);
  });
});

// TASK-718 — `@ax/agents` fires `agents:deleted` AFTER the agent row is gone.
// `mcp_oauth_v1_pending` carries `agent_id` with no FK to the agents table
// (deliberately), so nothing but this subscriber ever removes an in-flight
// handshake for a deleted agent. Tokens live in the credentials store and are
// purged there; `mcp_oauth_v1_clients` has no `agent_id` and is left alone.
describe('@ax/mcp-oauth agents:deleted subscriber (TASK-718)', () => {
  async function boot(): Promise<TestHarness> {
    const h = await createTestHarness({
      plugins: [createDatabasePostgresPlugin({ connectionString }), createMcpOAuthPlugin()],
    });
    harnesses.push(h);
    return h;
  }

  function pendingFor(state: string, agentId: string, userId: string, over: Record<string, unknown> = {}) {
    return {
      state,
      userId,
      agentId,
      connectorId: 'my-connector',
      slot: 'default',
      codeVerifier: 'verifier',
      authServerUrl: 'https://auth.example.com',
      clientKey: 'my-connector|https://auth.example.com',
      resource: 'https://api.example.com',
      scope: 'read',
      credScope: 'agent' as const,
      createdAt: Date.now(),
      ...over,
    };
  }

  async function seed(h: TestHarness): Promise<void> {
    const { db } = await h.bus.call<unknown, { db: Kysely<McpOAuthDatabase> }>(
      'database:get-instance',
      h.ctx(),
      {},
    );
    const store = createMcpOAuthStore(db);
    // agt_del: handshakes started by three different people, both cred scopes,
    // one with a confidential client's secret in the row.
    await store.putPending(pendingFor('d1', 'agt_del', 'u1'));
    await store.putPending(pendingFor('d2', 'agt_del', 'u2', { credScope: 'user' }));
    await store.putPending(
      pendingFor('d3', 'agt_del', 'u3', { clientId: 'cid', clientSecret: 'plaintext-secret' }),
    );
    await store.putPending(pendingFor('k1', 'agt_keep', 'u1'));
    await store.putPending(pendingFor('k2', 'agt_keep', 'u2', { credScope: 'user' }));
    // The legacy shared client row is not agent-keyed; it must survive.
    await db
      .insertInto('mcp_oauth_v1_clients')
      .values({ client_key: 'k|a', client_id: 'cid', client_secret: null, dynamic: true, created_at: new Date(0) })
      .execute();
  }

  async function countPending(agentId: string): Promise<number> {
    const c = new pg.Client({ connectionString });
    await c.connect();
    try {
      const r = await c.query(
        'SELECT COUNT(*)::int AS n FROM mcp_oauth_v1_pending WHERE agent_id = $1',
        [agentId],
      );
      return r.rows[0].n as number;
    } finally {
      await c.end().catch(() => {});
    }
  }

  async function countClients(): Promise<number> {
    const c = new pg.Client({ connectionString });
    await c.connect();
    try {
      const r = await c.query('SELECT COUNT(*)::int AS n FROM mcp_oauth_v1_clients');
      return r.rows[0].n as number;
    } finally {
      await c.end().catch(() => {});
    }
  }

  /** A ctx whose logger writes into `lines`, so a test can read what was logged. */
  function loggedCtx(h: TestHarness, lines: string[]) {
    return h.ctx({ logger: createLogger({ reqId: 'req-del', writer: (l) => lines.push(l) }) });
  }

  const parse = (lines: string[]): Array<Record<string, unknown>> =>
    lines.map((l) => JSON.parse(l) as Record<string, unknown>);

  const deleted = (agentId: unknown) => ({ agentId, ownerId: 'u1', ownerType: 'user' });

  it('removes every pending handshake for the deleted agent, and only those', async () => {
    const h = await boot();
    await seed(h);
    expect(await countPending('agt_del')).toBe(3);
    const lines: string[] = [];

    const res = await h.bus.fire('agents:deleted', loggedCtx(h, lines), deleted('agt_del'));

    expect(res.rejected).toBe(false);
    expect(await countPending('agt_del')).toBe(0);
    expect(await countPending('agt_keep')).toBe(2);
    // No `agent_id` column on the legacy clients table: not this plugin's to purge.
    expect(await countClients()).toBe(1);
    expect(
      parse(lines).find((e) => e.msg === 'mcp_oauth_purged_for_deleted_agent'),
    ).toMatchObject({ level: 'info', agentId: 'agt_del', deleted: 3 });
  });

  it('firing again for the same agent is a no-op that neither throws nor touches other agents', async () => {
    const h = await boot();
    await seed(h);
    await h.bus.fire('agents:deleted', loggedCtx(h, []), deleted('agt_del'));
    const lines: string[] = [];

    const res = await h.bus.fire('agents:deleted', loggedCtx(h, lines), deleted('agt_del'));

    expect(res.rejected).toBe(false);
    expect(await countPending('agt_del')).toBe(0);
    expect(await countPending('agt_keep')).toBe(2);
    const events = parse(lines);
    expect(events.find((e) => e.msg === 'mcp_oauth_purged_for_deleted_agent')).toMatchObject({
      deleted: 0,
    });
    expect(events.some((e) => e.level === 'error')).toBe(false);
  });

  it('a malformed payload deletes nothing, warns, and does not throw', async () => {
    const h = await boot();
    await seed(h);
    for (const bad of [{}, { agentId: '' }, { agentId: 42 }, { agentId: null }, null, 'agt_del']) {
      const lines: string[] = [];
      const res = await h.bus.fire('agents:deleted', loggedCtx(h, lines), bad);
      expect(res.rejected).toBe(false);
      const events = parse(lines);
      expect(events.filter((e) => e.level === 'warn').map((e) => e.msg)).toEqual([
        'mcp_oauth_purge_for_deleted_agent_skipped',
      ]);
      // The subscriber handled it itself: the bus never had to catch a throw.
      expect(events.some((e) => e.msg === 'hook_subscriber_failed')).toBe(false);
    }
    expect(await countPending('agt_del')).toBe(3);
    expect(await countPending('agt_keep')).toBe(2);
  });

  it('a failing store is logged at error and swallowed — the subscriber never throws', async () => {
    const h = await boot();
    await seed(h);
    // Break the store out from under the subscriber: the DELETE now fails with
    // "relation does not exist".
    const c = new pg.Client({ connectionString });
    await c.connect();
    try {
      await c.query('DROP TABLE mcp_oauth_v1_pending');
    } finally {
      await c.end().catch(() => {});
    }
    const lines: string[] = [];

    const res = await h.bus.fire('agents:deleted', loggedCtx(h, lines), deleted('agt_del'));

    expect(res.rejected).toBe(false);
    const events = parse(lines);
    expect(events.filter((e) => e.level === 'error').map((e) => e.msg)).toEqual([
      'mcp_oauth_purge_for_deleted_agent_failed',
    ]);
    expect(events.find((e) => e.level === 'error')).toMatchObject({ agentId: 'agt_del' });
    // The bus's own isolation did NOT have to catch anything: we swallowed it.
    expect(events.some((e) => e.msg === 'hook_subscriber_failed')).toBe(false);
  });
});
