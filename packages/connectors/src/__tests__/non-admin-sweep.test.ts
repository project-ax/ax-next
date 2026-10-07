import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Plugin } from '@ax/core';
import {
  createTestHarness,
  type TestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createConnectorsPlugin } from '../plugin.js';
import { deriveToolNamespaces } from '../tool-namespace.js';
import type { ConnectorDeletedEvent } from '../types.js';

// Slice 2b, Task 4 — connectors made by non-admins are removed once, at boot,
// with the same cleanup a real admin delete has. The sweep runs inside
// connectors' init, so the capture + auth plugins must init BEFORE it:
// registering optionalCalls of @ax/connectors (`credentials:*`, `auth:get-user`)
// puts them ahead in topological order.

type Purge = { scope: string; ownerId: string | null; ref: string };

function capturePlugin(
  events: ConnectorDeletedEvent[],
  purged: Purge[],
  accountPurges: unknown[],
): Plugin {
  return {
    manifest: {
      name: 'test/capture',
      version: '0.0.0',
      registers: ['credentials:delete', 'credentials:purge-account'],
      calls: [],
      subscribes: ['connectors:deleted'],
    },
    init({ bus }) {
      bus.registerService('credentials:delete', 'test/capture', async (_ctx, input) => {
        purged.push(input as Purge);
        return undefined;
      });
      bus.registerService('credentials:purge-account', 'test/capture', async (_ctx, input) => {
        accountPurges.push(input);
        return { purged: 0 };
      });
      bus.subscribe<ConnectorDeletedEvent>('connectors:deleted', 'test/capture', async (_ctx, e) => {
        events.push(e);
        return undefined;
      });
    },
  };
}

/** `auth:get-user` stub: 'admin' → isAdmin true, 'user' → false, 'gone' → null, 'throw' → throws. */
function authPlugin(users: Record<string, 'admin' | 'user' | 'gone' | 'throw'>): Plugin {
  return {
    manifest: { name: 'test/auth', version: '0.0.0', registers: ['auth:get-user'], calls: [], subscribes: [] },
    init({ bus }) {
      bus.registerService('auth:get-user', 'test/auth', async (_ctx, input) => {
        const { userId } = input as { userId: string };
        const kind = users[userId] ?? 'gone';
        if (kind === 'throw') throw new Error('auth backend down');
        if (kind === 'gone') return null;
        return { id: userId, isAdmin: kind === 'admin' };
      });
    },
  };
}

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

async function boot(extra: Plugin[] = []): Promise<TestHarness> {
  const h = await createTestHarness({
    plugins: [createDatabasePostgresPlugin({ connectionString }), ...extra, createConnectorsPlugin()],
  });
  harnesses.push(h);
  return h;
}

async function bootAndClose(extra: Plugin[] = []): Promise<void> {
  await (await boot(extra)).close({ onError: () => {} });
  harnesses.pop();
}

async function sql(text: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
  const c = new (await import('pg')).default.Client({ connectionString });
  await c.connect();
  try {
    return (await c.query(text, params)).rows;
  } finally {
    await c.end().catch(() => {});
  }
}

async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: Array<Record<string, unknown>> }> {
  const logs: Array<Record<string, unknown>> = [];
  const original = process.stdout.write.bind(process.stdout);
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
    const text = typeof chunk === 'string' ? chunk : String(chunk);
    for (const line of text.split('\n')) {
      if (!line.startsWith('{')) continue;
      try {
        logs.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // not a log line
      }
    }
    return (original as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write);
  try {
    return { result: await fn(), logs };
  } finally {
    spy.mockRestore();
  }
}

const httpServer = { name: 'remote', transport: 'http', url: 'https://mcp.example.com', allowedHosts: [], credentials: [] };
const tokenSlot = [{ slot: 'TOKEN', kind: 'api-key' }];
const caps = (credentials: unknown[] = tokenSlot) =>
  JSON.stringify({ allowedHosts: [], credentials, mcpServers: [httpServer], packages: { npm: [], pypi: [] } });

async function insertConnector(owner: string, id: string, opts: { keyMode?: string; visibility?: string } = {}) {
  await sql(
    `INSERT INTO connectors_v1_connectors (owner_user_id, connector_id, name, key_mode, visibility, capabilities)
     VALUES ($1, $2, $2, $3, $4, $5::jsonb)`,
    [owner, id, opts.keyMode ?? 'personal', opts.visibility ?? 'private', caps()],
  );
}

/** (owner, id, live?) for every row, ordered. Tombstones are kept (soft delete). */
async function rows(): Promise<Array<[unknown, unknown, boolean]>> {
  const out = await sql('SELECT owner_user_id, connector_id, deleted_at FROM connectors_v1_connectors ORDER BY owner_user_id, connector_id');
  return out.map((r) => [r['owner_user_id'], r['connector_id'], r['deleted_at'] === null]);
}

const ns = (owner: string, id: string) =>
  deriveToolNamespaces(owner, { id, capabilities: { mcpServers: [httpServer as never] } });

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} });
  await sql('DROP TABLE IF EXISTS connectors_v1_connectors');
  await sql('DROP TABLE IF EXISTS connectors_v1_authored');
  await sql('DROP TABLE IF EXISTS connectors_v1_boot_steps');
});

const doneMarkers = async () =>
  (await sql('SELECT name FROM connectors_v1_boot_steps')).map((r) => r['name']);

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('@ax/connectors boot removal of non-admin connectors', () => {
  it("keeps an admin's connectors; soft-deletes a non-admin's private and shared ones with full cleanup", async () => {
    await bootAndClose();
    await insertConnector('admin1', 'admintool', { keyMode: 'workspace', visibility: 'shared' });
    await insertConnector('userB', 'mytool');
    await insertConnector('userB', 'teamtool', { keyMode: 'workspace', visibility: 'shared' });

    const events: ConnectorDeletedEvent[] = [];
    const purged: Purge[] = [];
    const accountPurges: unknown[] = [];
    const { logs } = await captureLogs(() =>
      boot([authPlugin({ admin1: 'admin', userB: 'user' }), capturePlugin(events, purged, accountPurges)]),
    );

    expect(await rows()).toEqual([
      ['admin1', 'admintool', true],
      ['userB', 'mytool', false],
      ['userB', 'teamtool', false],
    ]);
    // Purge with full authority: the shared workspace key at GLOBAL scope too.
    expect(purged).toEqual([
      { scope: 'user', ownerId: 'userB', ref: 'account:mytool' },
      { scope: 'global', ownerId: null, ref: 'account:teamtool' },
    ]);
    // Only the SHARED connector's agents' sign-ins (and people's keys: no id survives).
    expect(accountPurges).toEqual([{ connectorId: 'teamtool', scopes: ['agent', 'user'] }]);
    expect(events).toEqual([
      { connectorId: 'mytool', toolNamespaces: ns('userB', 'mytool'), idStillLive: false },
      { connectorId: 'teamtool', toolNamespaces: ns('userB', 'teamtool'), idStillLive: false },
    ]);
    // Every removal is logged with its owner.
    expect(logs.filter((l) => l['msg'] === 'connectors_non_admin_connector_removed')).toEqual([
      expect.objectContaining({ connectorId: 'mytool', ownerUserId: 'userB' }),
      expect.objectContaining({ connectorId: 'teamtool', ownerUserId: 'userB' }),
    ]);
  });

  it('treats an owner whose account is gone (null user) as a non-admin', async () => {
    await bootAndClose();
    await insertConnector('ghost', 'oldtool');
    const events: ConnectorDeletedEvent[] = [];
    await boot([authPlugin({ ghost: 'gone' }), capturePlugin(events, [], [])]);
    expect(await rows()).toEqual([['ghost', 'oldtool', false]]);
    expect(events.map((e) => e.connectorId)).toEqual(['oldtool']);
  });

  it("keeps an owner's connectors when auth:get-user throws for them", async () => {
    await bootAndClose();
    await insertConnector('flaky', 'keepme');
    await insertConnector('userB', 'goes');
    const events: ConnectorDeletedEvent[] = [];
    const purged: Purge[] = [];
    const { logs } = await captureLogs(() =>
      boot([authPlugin({ flaky: 'throw', userB: 'user' }), capturePlugin(events, purged, [])]),
    );
    expect(await rows()).toEqual([
      ['flaky', 'keepme', true],
      ['userB', 'goes', false],
    ]);
    expect(purged.map((p) => p.ref)).toEqual(['account:goes']);
    expect(logs.filter((l) => l['msg'] === 'connectors_non_admin_sweep_owner_check_failed')).toEqual([
      expect.objectContaining({ ownerUserId: 'flaky' }),
    ]);
  });

  it('removes nothing without an auth:get-user provider, and logs why once', async () => {
    await bootAndClose();
    await insertConnector('userB', 'mytool');
    const events: ConnectorDeletedEvent[] = [];
    const purged: Purge[] = [];
    const { logs } = await captureLogs(() => boot([capturePlugin(events, purged, [])]));
    expect(await rows()).toEqual([['userB', 'mytool', true]]);
    expect(events).toEqual([]);
    expect(purged).toEqual([]);
    expect(logs.filter((l) => l['msg'] === 'connectors_non_admin_sweep_skipped')).toEqual([
      expect.objectContaining({ reason: 'no-auth-provider' }),
    ]);
  });

  it("keeps the GLOBAL key and agents' sign-ins when an admin's live shared connector keeps the id", async () => {
    await bootAndClose();
    await insertConnector('admin1', 'teamtool', { keyMode: 'workspace', visibility: 'shared' });
    await insertConnector('userB', 'teamtool', { keyMode: 'workspace', visibility: 'shared' });
    const events: ConnectorDeletedEvent[] = [];
    const purged: Purge[] = [];
    const accountPurges: unknown[] = [];
    await boot([authPlugin({ admin1: 'admin', userB: 'user' }), capturePlugin(events, purged, accountPurges)]);
    expect(await rows()).toEqual([
      ['admin1', 'teamtool', true],
      ['userB', 'teamtool', false],
    ]);
    expect(purged.filter((p) => p.scope === 'global')).toEqual([]);
    expect(accountPurges).toEqual([]);
    expect(events.map((e) => [e.connectorId, e.idStillLive])).toEqual([['teamtool', true]]);
  });

  it('two non-admins with the same shared id: the last one removed purges, once', async () => {
    await bootAndClose();
    await insertConnector('userB', 'teamtool', { keyMode: 'workspace', visibility: 'shared' });
    await insertConnector('userC', 'teamtool', { keyMode: 'workspace', visibility: 'shared' });
    const events: ConnectorDeletedEvent[] = [];
    const accountPurges: unknown[] = [];
    await boot([authPlugin({ userB: 'user', userC: 'user' }), capturePlugin(events, [], accountPurges)]);
    expect(await rows()).toEqual([
      ['userB', 'teamtool', false],
      ['userC', 'teamtool', false],
    ]);
    expect(accountPurges).toEqual([{ connectorId: 'teamtool', scopes: ['agent', 'user'] }]);
    expect(events.map((e) => [e.connectorId, e.idStillLive])).toEqual([
      ['teamtool', true],
      ['teamtool', false],
    ]);
  });

  it("a private same-id survivor keeps people's keys (agent sign-ins only)", async () => {
    await bootAndClose();
    await insertConnector('admin1', 'teamtool');
    await insertConnector('userB', 'teamtool', { visibility: 'shared' });
    const events: ConnectorDeletedEvent[] = [];
    const accountPurges: unknown[] = [];
    await boot([authPlugin({ admin1: 'admin', userB: 'user' }), capturePlugin(events, [], accountPurges)]);
    expect(accountPurges).toEqual([{ connectorId: 'teamtool', scopes: ['agent'] }]);
    expect(events.map((e) => [e.connectorId, e.idStillLive])).toEqual([['teamtool', true]]);
  });

  it('is idempotent: a second boot removes, purges and announces nothing', async () => {
    await bootAndClose();
    await insertConnector('userB', 'mytool');
    const auth = { userB: 'user' as const };
    const first: ConnectorDeletedEvent[] = [];
    await bootAndClose([authPlugin(auth), capturePlugin(first, [], [])]);
    expect(first.map((e) => e.connectorId)).toEqual(['mytool']);

    const events: ConnectorDeletedEvent[] = [];
    const purged: Purge[] = [];
    await boot([authPlugin(auth), capturePlugin(events, purged, [])]);
    expect(events).toEqual([]);
    expect(purged).toEqual([]);
    expect(await rows()).toEqual([['userB', 'mytool', false]]);
  });

  it('runs ONCE: after a complete pass, a new non-admin connector survives later boots', async () => {
    await bootAndClose();
    await insertConnector('userB', 'mytool');
    const auth = { userB: 'user' as const, userC: 'user' as const };
    await bootAndClose([authPlugin(auth), capturePlugin([], [], [])]);
    expect(await doneMarkers()).toEqual(['non-admin-connector-removal']);

    // Not a standing rule: a connector a non-admin makes afterwards stays.
    await insertConnector('userC', 'newtool');
    const events: ConnectorDeletedEvent[] = [];
    const { logs } = await captureLogs(() => boot([authPlugin(auth), capturePlugin(events, [], [])]));
    expect(events).toEqual([]);
    expect(await rows()).toEqual([
      ['userB', 'mytool', false],
      ['userC', 'newtool', true],
    ]);
    expect(logs.filter((l) => l['msg'] === 'connectors_non_admin_sweep_skipped')).toEqual([
      expect.objectContaining({ reason: 'already-done' }),
    ]);
  });

  it('an owner-lookup failure leaves no marker, and the next boot retries', async () => {
    await bootAndClose();
    await insertConnector('flaky', 'keepme');
    await bootAndClose([authPlugin({ flaky: 'throw' }), capturePlugin([], [], [])]);
    expect(await doneMarkers()).toEqual([]);
    expect(await rows()).toEqual([['flaky', 'keepme', true]]);

    // Auth recovers: the retry removes it and only now records the step.
    await bootAndClose([authPlugin({ flaky: 'user' }), capturePlugin([], [], [])]);
    expect(await rows()).toEqual([['flaky', 'keepme', false]]);
    expect(await doneMarkers()).toEqual(['non-admin-connector-removal']);
  });

  it('a pass skipped for no auth provider leaves no marker', async () => {
    await bootAndClose();
    await insertConnector('userB', 'mytool');
    await bootAndClose([capturePlugin([], [], [])]);
    expect(await doneMarkers()).toEqual([]);
    await bootAndClose([authPlugin({ userB: 'user' }), capturePlugin([], [], [])]);
    expect(await rows()).toEqual([['userB', 'mytool', false]]);
  });
});
