import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
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
  if (container) await container.stop();
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
