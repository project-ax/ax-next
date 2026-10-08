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
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { ConnectorDatabase } from '../migrations.js';
import { NON_ADMIN_SWEEP_STEP, sweepNonAdminConnectors } from '../non-admin-sweep.js';
import { createConnectorsPlugin } from '../plugin.js';
import { createConnectorStore } from '../store.js';
import { deriveToolNamespaces } from '../tool-namespace.js';
import type { ConnectorDeletedEvent } from '../types.js';

// Slice 2b, Task 4 — connectors made by non-admins are removed once, at boot,
// with the same cleanup a real admin delete has. The sweep runs inside
// connectors' init, so the capture + auth plugins must init BEFORE it:
// registering optionalCalls of @ax/connectors (`credentials:*`, `auth:get-user`)
// puts them ahead in topological order.

type Purge = { scope: string; ownerId: string | null; ref: string };

interface CaptureOpts {
  /** `credentials:delete` throws (after recording the call). */
  failDelete?: boolean;
  /** `credentials:purge-account` throws (after recording the call). */
  failPurgeAccount?: boolean;
  /** Runs inside each purge call, before it answers (ordering probes). */
  onPurge?: (connectorId: string) => Promise<void>;
}

const idOfRef = (ref: string) => ref.replace(/^account:/, '').split(':')[0]!;

function capturePlugin(
  events: ConnectorDeletedEvent[],
  purged: Purge[],
  accountPurges: unknown[],
  opts: CaptureOpts = {},
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
        await opts.onPurge?.(idOfRef((input as Purge).ref));
        if (opts.failDelete) throw new Error('credential store down');
        return undefined;
      });
      bus.registerService('credentials:purge-account', 'test/capture', async (_ctx, input) => {
        accountPurges.push(input);
        await opts.onPurge?.((input as { connectorId: string }).connectorId);
        if (opts.failPurgeAccount) throw new Error('credential store down');
        return { purged: 0 };
      });
      bus.subscribe<ConnectorDeletedEvent>('connectors:deleted', 'test/capture', async (_ctx, e) => {
        events.push(e);
        return undefined;
      });
    },
  };
}

type AuthKind = 'admin' | 'user' | 'gone' | 'throw' | 'odd' | 'undef' | 'string';

/**
 * `auth:get-user` stub: 'admin' → isAdmin true, 'user' → false, 'gone' → null,
 * 'throw' → throws, 'odd' → a user whose isAdmin is not a boolean,
 * 'undef' → undefined, 'string' → a non-object answer.
 */
function authHandler(users: Record<string, AuthKind>) {
  return async (_ctx: unknown, input: unknown) => {
    const { userId } = input as { userId: string };
    const kind = users[userId] ?? 'gone';
    if (kind === 'throw') throw new Error('auth backend down');
    if (kind === 'gone') return null;
    if (kind === 'undef') return undefined;
    if (kind === 'string') return 'admin';
    if (kind === 'odd') return { id: userId, isAdmin: 'yes' };
    return { id: userId, isAdmin: kind === 'admin' };
  };
}

function authPlugin(users: Record<string, AuthKind>): Plugin {
  return {
    manifest: { name: 'test/auth', version: '0.0.0', registers: ['auth:get-user'], calls: [], subscribes: [] },
    init({ bus }) {
      bus.registerService('auth:get-user', 'test/auth', authHandler(users));
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

async function insertConnector(owner: string, id: string, opts: { keyMode?: string; capsJson?: string } = {}) {
  await sql(
    `INSERT INTO connectors_v1_connectors (owner_user_id, connector_id, name, key_mode, capabilities)
     VALUES ($1, $2, $2, $3, $4::jsonb)`,
    [owner, id, opts.keyMode ?? 'personal', opts.capsJson ?? caps()],
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

const opened: Kysely<ConnectorDatabase>[] = [];
function makeKysely(): Kysely<ConnectorDatabase> {
  const k = new Kysely<ConnectorDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 2 }) }),
  });
  opened.push(k);
  return k;
}

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} });
  while (opened.length > 0) await opened.pop()!.destroy();
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
  it("keeps an admin's connectors; soft-deletes a non-admin's with full cleanup", async () => {
    await bootAndClose();
    await insertConnector('admin1', 'admintool', { keyMode: 'workspace' });
    await insertConnector('userB', 'mytool');
    await insertConnector('userB', 'teamtool', { keyMode: 'workspace' });

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
    // Purge with full authority: the workspace key at GLOBAL scope. The
    // personal `mytool` has no global row to delete (nothing per person).
    expect(purged).toEqual([
      { scope: 'global', ownerId: null, ref: 'account:teamtool' },
    ]);
    // Every connector is shared (SIGNINS-9): each one's agents' sign-ins go —
    // agent scope, never user.
    expect(accountPurges).toEqual([
      { connectorId: 'mytool', scopes: ['agent'] },
      { connectorId: 'teamtool', scopes: ['agent'] },
    ]);
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
    await insertConnector('userB', 'goes', { keyMode: 'workspace' });
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

  it("keeps the GLOBAL key but purges agents' sign-ins when an admin's live connector keeps the id", async () => {
    await bootAndClose();
    await insertConnector('admin1', 'teamtool', { keyMode: 'workspace' });
    await insertConnector('userB', 'teamtool', { keyMode: 'workspace' });
    const events: ConnectorDeletedEvent[] = [];
    const purged: Purge[] = [];
    const accountPurges: unknown[] = [];
    await boot([authPlugin({ admin1: 'admin', userB: 'user' }), capturePlugin(events, purged, accountPurges)]);
    expect(await rows()).toEqual([
      ['admin1', 'teamtool', true],
      ['userB', 'teamtool', false],
    ]);
    expect(purged.filter((p) => p.scope === 'global')).toEqual([]);
    // Keyed by id alone: the survivor must not read a token minted for the removed one.
    expect(accountPurges).toEqual([{ connectorId: 'teamtool', scopes: ['agent'] }]);
    expect(events.map((e) => [e.connectorId, e.idStillLive])).toEqual([['teamtool', true]]);
  });

  it('two non-admins with the same id: each removal purges agent sign-ins (idempotent)', async () => {
    await bootAndClose();
    await insertConnector('userB', 'teamtool', { keyMode: 'workspace' });
    await insertConnector('userC', 'teamtool', { keyMode: 'workspace' });
    const events: ConnectorDeletedEvent[] = [];
    const accountPurges: unknown[] = [];
    await boot([authPlugin({ userB: 'user', userC: 'user' }), capturePlugin(events, [], accountPurges)]);
    expect(await rows()).toEqual([
      ['userB', 'teamtool', false],
      ['userC', 'teamtool', false],
    ]);
    expect(accountPurges).toEqual([
      { connectorId: 'teamtool', scopes: ['agent'] },
      { connectorId: 'teamtool', scopes: ['agent'] },
    ]);
    expect(events.map((e) => [e.connectorId, e.idStillLive])).toEqual([
      ['teamtool', true],
      ['teamtool', false],
    ]);
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

  it('keeps an unparseable non-admin row but still completes, so the sweep stays one-time', async () => {
    await bootAndClose();
    await insertConnector('userB', 'broken', { capsJson: JSON.stringify({ credentials: 'nope' }) });
    await insertConnector('userB', 'good');
    const auth = { userB: 'user' as const, userC: 'user' as const };
    const { logs } = await captureLogs(() => bootAndClose([authPlugin(auth), capturePlugin([], [], [])]));
    expect(await rows()).toEqual([
      ['userB', 'broken', true],
      ['userB', 'good', false],
    ]);
    expect(await doneMarkers()).toEqual(['non-admin-connector-removal']);
    expect(logs.filter((l) => l['msg'] === 'connectors_non_admin_swept')).toEqual([
      expect.objectContaining({ count: 1, unparseable: 1, complete: true }),
    ]);

    await insertConnector('userC', 'newtool');
    await boot([authPlugin(auth), capturePlugin([], [], [])]);
    expect(await rows()).toEqual([
      ['userB', 'broken', true],
      ['userB', 'good', false],
      ['userC', 'newtool', true],
    ]);
  });

  it("removes the platform 'system' owner's connectors too (owner decision 2026-10-07) and completes", async () => {
    await bootAndClose();
    await insertConnector('system', 'skilltool');
    const events: ConnectorDeletedEvent[] = [];
    const accountPurges: unknown[] = [];
    // No auth user named 'system' (null) → non-admin, removed with full cleanup.
    await boot([authPlugin({ system: 'gone' }), capturePlugin(events, [], accountPurges)]);
    expect(await rows()).toEqual([['system', 'skilltool', false]]);
    expect(events.map((e) => [e.connectorId, e.idStillLive])).toEqual([['skilltool', false]]);
    expect(accountPurges).toEqual([{ connectorId: 'skilltool', scopes: ['agent'] }]);
    expect(await doneMarkers()).toEqual(['non-admin-connector-removal']);
  });

  it('a non-boolean isAdmin is a lookup failure: keeps the rows, writes no marker', async () => {
    await bootAndClose();
    await insertConnector('weird', 'keepme');
    const { logs } = await captureLogs(() => bootAndClose([authPlugin({ weird: 'odd' }), capturePlugin([], [], [])]));
    expect(await rows()).toEqual([['weird', 'keepme', true]]);
    expect(await doneMarkers()).toEqual([]);
    expect(logs.filter((l) => l['msg'] === 'connectors_non_admin_sweep_owner_check_failed')).toEqual([
      expect.objectContaining({ ownerUserId: 'weird' }),
    ]);
    expect(logs.filter((l) => l['msg'] === 'connectors_non_admin_swept')).toEqual([
      expect.objectContaining({ complete: false, ownerChecksFailed: 1 }),
    ]);
  });
  it('an undefined auth:get-user answer is a lookup failure, not a deleted account', async () => {
    await bootAndClose();
    await insertConnector('undef', 'keepme');
    await insertConnector('str', 'keeptoo');
    const events: ConnectorDeletedEvent[] = [];
    const { logs } = await captureLogs(() =>
      bootAndClose([authPlugin({ undef: 'undef', str: 'string' }), capturePlugin(events, [], [])]),
    );
    expect(await rows()).toEqual([
      ['str', 'keeptoo', true],
      ['undef', 'keepme', true],
    ]);
    expect(events).toEqual([]);
    expect(await doneMarkers()).toEqual([]);
    expect(
      logs.filter((l) => l['msg'] === 'connectors_non_admin_sweep_owner_check_failed').map((l) => l['ownerUserId']).sort(),
    ).toEqual(['str', 'undef']);
    expect(logs.filter((l) => l['msg'] === 'connectors_non_admin_swept')).toEqual([
      expect.objectContaining({ complete: false, ownerChecksFailed: 2 }),
    ]);
  });

  it('a failed credentials:purge-account keeps the row and the marker unwritten; the next boot finishes', async () => {
    await bootAndClose();
    await insertConnector('userB', 'teamtool', { keyMode: 'workspace' });
    const auth = { userB: 'user' as const };

    // Pin the ordering: the purge runs while the row is still live.
    const liveDuringPurge: boolean[] = [];
    const onPurge = async (id: string) => {
      const r = await sql(
        'SELECT deleted_at FROM connectors_v1_connectors WHERE owner_user_id = $1 AND connector_id = $2',
        ['userB', id],
      );
      liveDuringPurge.push(r.length === 1 && r[0]!['deleted_at'] === null);
    };

    const events: ConnectorDeletedEvent[] = [];
    const accountPurges: unknown[] = [];
    const { logs } = await captureLogs(() =>
      bootAndClose([
        authPlugin(auth),
        capturePlugin(events, [], accountPurges, { failPurgeAccount: true, onPurge }),
      ]),
    );
    expect(accountPurges).toEqual([{ connectorId: 'teamtool', scopes: ['agent'] }]);
    expect(liveDuringPurge.length).toBeGreaterThan(0);
    expect(liveDuringPurge.every(Boolean)).toBe(true);
    expect(await rows()).toEqual([['userB', 'teamtool', true]]);
    expect(events).toEqual([]);
    expect(await doneMarkers()).toEqual([]);
    expect(logs.filter((l) => l['msg'] === 'connectors_delete_agent_signins_purge_failed')).toEqual([
      expect.objectContaining({ connectorId: 'teamtool', scopes: ['agent'] }),
    ]);
    expect(logs.filter((l) => l['msg'] === 'connectors_non_admin_sweep_row_failed')).toEqual([
      expect.objectContaining({
        connectorId: 'teamtool',
        ownerUserId: 'userB',
        reason: 'purge-failed',
        failed: ['credentials:purge-account'],
      }),
    ]);
    expect(logs.filter((l) => l['msg'] === 'connectors_non_admin_swept')).toEqual([
      expect.objectContaining({ count: 0, complete: false }),
    ]);

    // Credentials recover: the retry removes it, announces it, and records the step.
    const retryEvents: ConnectorDeletedEvent[] = [];
    await bootAndClose([authPlugin(auth), capturePlugin(retryEvents, [], [])]);
    expect(await rows()).toEqual([['userB', 'teamtool', false]]);
    expect(retryEvents.map((e) => [e.connectorId, e.idStillLive])).toEqual([['teamtool', false]]);
    expect(await doneMarkers()).toEqual([NON_ADMIN_SWEEP_STEP]);
  });

  it('a failed credentials:delete keeps the row and the marker unwritten; the next boot finishes', async () => {
    await bootAndClose();
    await insertConnector('userB', 'mytool', { keyMode: 'workspace' });
    const auth = { userB: 'user' as const };
    const liveDuringPurge: boolean[] = [];
    const onPurge = async (id: string) => {
      const r = await sql(
        'SELECT deleted_at FROM connectors_v1_connectors WHERE owner_user_id = $1 AND connector_id = $2',
        ['userB', id],
      );
      liveDuringPurge.push(r.length === 1 && r[0]!['deleted_at'] === null);
    };

    const events: ConnectorDeletedEvent[] = [];
    const purged: Purge[] = [];
    const { logs } = await captureLogs(() =>
      bootAndClose([authPlugin(auth), capturePlugin(events, purged, [], { failDelete: true, onPurge })]),
    );
    expect(purged).toEqual([{ scope: 'global', ownerId: null, ref: 'account:mytool' }]);
    // Both purges (the global key, then the agents' sign-ins) run while the row is live.
    expect(liveDuringPurge).toEqual([true, true]);
    expect(await rows()).toEqual([['userB', 'mytool', true]]);
    expect(events).toEqual([]);
    expect(await doneMarkers()).toEqual([]);
    expect(logs.filter((l) => l['msg'] === 'connectors_non_admin_sweep_row_failed')).toEqual([
      expect.objectContaining({
        connectorId: 'mytool',
        reason: 'purge-failed',
        failed: ['credentials:delete:global:account:mytool'],
      }),
    ]);

    const retryEvents: ConnectorDeletedEvent[] = [];
    await bootAndClose([authPlugin(auth), capturePlugin(retryEvents, [], [])]);
    expect(await rows()).toEqual([['userB', 'mytool', false]]);
    expect(retryEvents.map((e) => e.connectorId)).toEqual(['mytool']);
    expect(await doneMarkers()).toEqual([NON_ADMIN_SWEEP_STEP]);
  });

  // The two paths below need a store that misbehaves, so they call the sweep
  // directly (it takes its db/store/bus/ctx as arguments) against a booted
  // harness whose own init-time sweep was skipped (no auth provider yet).
  async function bootForDirectSweep(events: ConnectorDeletedEvent[]): Promise<TestHarness> {
    const h = await boot([capturePlugin(events, [], [])]);
    h.bus.registerService('auth:get-user', 'test/auth', authHandler({ userB: 'user' }));
    return h;
  }

  it('a row-processing throw keeps the row live, writes no marker, and the next boot retries', async () => {
    await bootAndClose();
    await insertConnector('userB', 'mytool');
    const events: ConnectorDeletedEvent[] = [];
    const h = await bootForDirectSweep(events);
    const db = makeKysely();
    const real = createConnectorStore(db);
    const store = {
      softDelete: async () => {
        throw new Error('db blip');
      },
      hasLiveById: real.hasLiveById.bind(real),
    };
    const { result, logs } = await captureLogs(() => sweepNonAdminConnectors(db, store, h.bus, h.ctx()));
    expect(result).toEqual({ removed: 0, complete: false });
    expect(events).toEqual([]);
    expect(await rows()).toEqual([['userB', 'mytool', true]]);
    expect(await doneMarkers()).toEqual([]);
    expect(logs.filter((l) => l['msg'] === 'connectors_non_admin_sweep_row_failed')).toEqual([
      expect.objectContaining({ connectorId: 'mytool', ownerUserId: 'userB', err: 'db blip' }),
    ]);

    // A real boot retries and finishes.
    await bootAndClose([authPlugin({ userB: 'user' }), capturePlugin([], [], [])]);
    expect(await rows()).toEqual([['userB', 'mytool', false]]);
    expect(await doneMarkers()).toEqual([NON_ADMIN_SWEEP_STEP]);
  });

  it('a softDelete another replica won (false) fires no event, and the pass still completes', async () => {
    await bootAndClose();
    await insertConnector('userB', 'mytool');
    const events: ConnectorDeletedEvent[] = [];
    const h = await bootForDirectSweep(events);
    const db = makeKysely();
    const real = createConnectorStore(db);
    const store = {
      softDelete: async () => false,
      hasLiveById: real.hasLiveById.bind(real),
    };
    const result = await sweepNonAdminConnectors(db, store, h.bus, h.ctx());
    expect(result).toEqual({ removed: 0, complete: true });
    expect(events).toEqual([]);
    expect(await doneMarkers()).toEqual([NON_ADMIN_SWEEP_STEP]);
  });
});
