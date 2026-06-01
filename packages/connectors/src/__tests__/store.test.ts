import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { stopPostgresContainer } from '@ax/test-harness';
import { Kysely, PostgresDialect } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import {
  runConnectorsMigration,
  type ConnectorDatabase,
} from '../migrations.js';
import {
  createConnectorStore,
  validateCapabilities,
  validateConnectorId,
  validateKeyMode,
  validateVisibility,
} from '../store.js';
import { scopedConnectors } from '../scope.js';
import type { Capabilities } from '../types.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const opened: Kysely<ConnectorDatabase>[] = [];

function makeKysely(): Kysely<ConnectorDatabase> {
  const k = new Kysely<ConnectorDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: 4 }),
    }),
  });
  opened.push(k);
  return k;
}

function caps(): Capabilities {
  return {
    allowedHosts: ['api.example.com'],
    credentials: [{ slot: 's', kind: 'api-key' }],
    mcpServers: [],
    packages: { npm: [], pypi: [] },
  };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (opened.length > 0) {
    const k = opened.pop()!;
    try {
      await k.schema
        .dropTable('connectors_v1_connectors')
        .ifExists()
        .execute();
    } catch {
      /* drained pool */
    }
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('runConnectorsMigration', () => {
  it('is idempotent — runs twice without error', async () => {
    const db = makeKysely();
    await runConnectorsMigration(db);
    await runConnectorsMigration(db);
    const store = createConnectorStore(db);
    // The table exists and is queryable.
    expect(await store.listForUser('nobody')).toEqual([]);
  });

  it('enforces the key_mode / visibility CHECK constraints at the DB level', async () => {
    const db = makeKysely();
    await runConnectorsMigration(db);
    // Bypass the store's boundary validators to prove the DB CHECK is the
    // backstop (defense in depth).
    await expect(
      db
        .insertInto('connectors_v1_connectors')
        .values({
          owner_user_id: 'u',
          connector_id: 'c',
          name: 'n',
          description: '',
          usage_note: '',
          key_mode: 'nope',
          visibility: 'private',
          capabilities: JSON.stringify(caps()) as unknown as object,
          deleted_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute(),
    ).rejects.toThrow();
  });
});

describe('createConnectorStore', () => {
  it('upsert → get → softDelete lifecycle', async () => {
    const db = makeKysely();
    await runConnectorsMigration(db);
    const store = createConnectorStore(db);

    const { connector, created } = await store.upsert({
      userId: 'u',
      connectorId: 'c',
      name: 'C',
      description: 'd',
      usageNote: 'u',
      keyMode: 'personal',
      visibility: 'private',
      capabilities: caps(),
    });
    expect(created).toBe(true);
    expect(connector.capabilities).toEqual(caps());

    const got = await store.getByIdNotDeleted('u', 'c');
    expect(got?.name).toBe('C');

    expect(await store.softDelete('u', 'c')).toBe(true);
    expect(await store.getByIdNotDeleted('u', 'c')).toBeNull();
    expect(await store.softDelete('u', 'c')).toBe(false);
  });

  it('defaultAttached round-trips; upsert preserves it on a content-only update, clears on explicit false', async () => {
    const db = makeKysely();
    await runConnectorsMigration(db);
    const store = createConnectorStore(db);

    // Fresh connector — absent flag defaults to false.
    const fresh = await store.upsert({
      userId: 'u',
      connectorId: 'c',
      name: 'C',
      description: '',
      usageNote: '',
      keyMode: 'personal',
      visibility: 'private',
      capabilities: caps(),
    });
    expect(fresh.connector.defaultAttached).toBe(false);

    // Flip it default-on.
    const flagged = await store.upsert({
      userId: 'u',
      connectorId: 'c',
      name: 'C',
      description: '',
      usageNote: '',
      keyMode: 'personal',
      visibility: 'private',
      capabilities: caps(),
      defaultAttached: true,
    });
    expect(flagged.connector.defaultAttached).toBe(true);

    // A content-only re-upsert (flag ABSENT) must PRESERVE default-on.
    const preserved = await store.upsert({
      userId: 'u',
      connectorId: 'c',
      name: 'C renamed',
      description: 'd',
      usageNote: '',
      keyMode: 'personal',
      visibility: 'private',
      capabilities: caps(),
    });
    expect(preserved.connector.name).toBe('C renamed');
    expect(preserved.connector.defaultAttached).toBe(true);

    // Explicit false clears it.
    const cleared = await store.upsert({
      userId: 'u',
      connectorId: 'c',
      name: 'C renamed',
      description: 'd',
      usageNote: '',
      keyMode: 'personal',
      visibility: 'private',
      capabilities: caps(),
      defaultAttached: false,
    });
    expect(cleared.connector.defaultAttached).toBe(false);
  });

  it('listDefaults returns only default-flagged, non-tombstoned, owner-scoped FULL connectors sorted by id', async () => {
    const db = makeKysely();
    await runConnectorsMigration(db);
    const store = createConnectorStore(db);

    const base = (over: {
      userId: string;
      connectorId: string;
      defaultAttached?: boolean;
    }) => ({
      name: over.connectorId.toUpperCase(),
      description: '',
      usageNote: '',
      keyMode: 'personal' as const,
      visibility: 'private' as const,
      capabilities: caps(),
      ...over,
    });

    // u1: two defaults ('b','a') + one non-default ('z').
    await store.upsert(base({ userId: 'u1', connectorId: 'b', defaultAttached: true }));
    await store.upsert(base({ userId: 'u1', connectorId: 'a', defaultAttached: true }));
    await store.upsert(base({ userId: 'u1', connectorId: 'z', defaultAttached: false }));
    // u1: a default that gets tombstoned — must NOT appear.
    await store.upsert(base({ userId: 'u1', connectorId: 'gone', defaultAttached: true }));
    await store.softDelete('u1', 'gone');
    // u2: a default owned by another user — must NOT appear for u1.
    await store.upsert(base({ userId: 'u2', connectorId: 'other', defaultAttached: true }));

    const defaults = await store.listDefaults('u1');
    // Sorted by id asc; only u1's live defaults; full connectors (capabilities present).
    expect(defaults.map((c) => c.id)).toEqual(['a', 'b']);
    expect(defaults[0]!.capabilities).toEqual(caps());
    expect(defaults.every((c) => c.defaultAttached)).toBe(true);

    expect((await store.listDefaults('u2')).map((c) => c.id)).toEqual(['other']);
    expect(await store.listDefaults('nobody')).toEqual([]);
  });

  it('scopedConnectors filters to owner + non-tombstoned rows', async () => {
    const db = makeKysely();
    await runConnectorsMigration(db);
    const store = createConnectorStore(db);
    await store.upsert({
      userId: 'u1',
      connectorId: 'a',
      name: 'A',
      description: '',
      usageNote: '',
      keyMode: 'personal',
      visibility: 'private',
      capabilities: caps(),
    });
    await store.upsert({
      userId: 'u2',
      connectorId: 'b',
      name: 'B',
      description: '',
      usageNote: '',
      keyMode: 'personal',
      visibility: 'private',
      capabilities: caps(),
    });
    await store.softDelete('u1', 'a');
    await store.upsert({
      userId: 'u1',
      connectorId: 'c',
      name: 'C',
      description: '',
      usageNote: '',
      keyMode: 'personal',
      visibility: 'private',
      capabilities: caps(),
    });

    const rows = await scopedConnectors(db, { userId: 'u1' }).execute();
    // u1 sees only its live row 'c' — not the tombstoned 'a', not u2's 'b'.
    expect(rows.map((r) => r.connector_id)).toEqual(['c']);
  });
});

describe('boundary validators', () => {
  it('validateConnectorId accepts slugs, rejects spaces / uppercase / empty', () => {
    expect(validateConnectorId('g-drive_1')).toBe('g-drive_1');
    expect(() => validateConnectorId('Has Space')).toThrow();
    expect(() => validateConnectorId('UPPER')).toThrow();
    expect(() => validateConnectorId('')).toThrow();
  });

  it('validateKeyMode / validateVisibility reject out-of-enum', () => {
    expect(validateKeyMode('workspace')).toBe('workspace');
    expect(() => validateKeyMode('admin')).toThrow();
    expect(validateVisibility('shared')).toBe('shared');
    expect(() => validateVisibility('public')).toThrow();
  });

  it('validateCapabilities round-trips a valid spec and rejects garbage', () => {
    expect(validateCapabilities(caps())).toEqual(caps());
    expect(() => validateCapabilities({ allowedHosts: 'no' })).toThrow();
  });
});
