import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
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
  assertConnectorIdCreatable,
  createConnectorStore,
  validateCapabilities,
  validateConnectorId,
  validateKeyMode,
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
    // TASK-150 — services defaults to [] through the schema; set it explicitly
    // here so the round-trip assertion below stays an exact deep-equal.
    services: [],
  };
}

const PINNED_IMAGE = 'docker.io/library/postgres@sha256:' + 'a'.repeat(64);

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
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

  it('enforces the key_mode CHECK constraint at the DB level', async () => {
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

  describe('requireUniqueId', () => {
    const base = {
      connectorId: 'gmail',
      name: 'Gmail',
      description: '',
      usageNote: '',
      keyMode: 'personal' as const,
      capabilities: caps(),
    };

    it('rejects a new row when another owner holds a live row with the id', async () => {
      const db = makeKysely();
      await runConnectorsMigration(db);
      const store = createConnectorStore(db);
      await store.upsert({ ...base, userId: 'idA' });
      await expect(
        store.upsert({ ...base, userId: 'idB', requireUniqueId: true }),
      ).rejects.toMatchObject({ code: 'connector-id-taken' });
      expect(await store.getByIdNotDeleted('idB', 'gmail')).toBeNull();
    });

    it('is opt-in: without the flag a second owner may reuse the id', async () => {
      const db = makeKysely();
      await runConnectorsMigration(db);
      const store = createConnectorStore(db);
      await store.upsert({ ...base, userId: 'idA' });
      const out = await store.upsert({ ...base, userId: 'idB' });
      expect(out.created).toBe(true);
    });

    it('a tombstoned row never blocks', async () => {
      const db = makeKysely();
      await runConnectorsMigration(db);
      const store = createConnectorStore(db);
      await store.upsert({ ...base, userId: 'idA' });
      await store.softDelete('idA', 'gmail');
      const out = await store.upsert({ ...base, userId: 'idB', requireUniqueId: true });
      expect(out.created).toBe(true);
    });

    it('re-upserting your own live row with the flag succeeds', async () => {
      const db = makeKysely();
      await runConnectorsMigration(db);
      const store = createConnectorStore(db);
      await store.upsert({ ...base, userId: 'idA' });
      const out = await store.upsert({ ...base, userId: 'idA', requireUniqueId: true });
      expect(out.created).toBe(false);
    });
  });

  describe('createOnly', () => {
    const base = {
      userId: 'idA',
      connectorId: 'gmail',
      name: 'Gmail',
      description: '',
      usageNote: '',
      keyMode: 'personal' as const,
      capabilities: caps(),
    };

    it('refuses a same-owner live row with connector-id-taken and leaves the row unchanged', async () => {
      const db = makeKysely();
      await runConnectorsMigration(db);
      const store = createConnectorStore(db);
      await store.upsert(base);
      const before = await store.getByIdNotDeleted('idA', 'gmail');
      await expect(
        store.upsert({ ...base, name: 'Overwritten', createOnly: true }),
      ).rejects.toMatchObject({ code: 'connector-id-taken' });
      const after = await store.getByIdNotDeleted('idA', 'gmail');
      expect(after).toEqual(before);
      expect(after?.name).toBe('Gmail');
    });

    it('still resurrects a tombstone (created: true)', async () => {
      const db = makeKysely();
      await runConnectorsMigration(db);
      const store = createConnectorStore(db);
      await store.upsert(base);
      await store.softDelete('idA', 'gmail');
      const out = await store.upsert({ ...base, name: 'Gmail again', createOnly: true });
      expect(out.created).toBe(true);
      expect((await store.getByIdNotDeleted('idA', 'gmail'))?.name).toBe('Gmail again');
    });

    it('creates a fresh row', async () => {
      const db = makeKysely();
      await runConnectorsMigration(db);
      const store = createConnectorStore(db);
      const out = await store.upsert({ ...base, createOnly: true });
      expect(out.created).toBe(true);
    });
  });

  it('every live connector is readable by others, without granting writes (SIGNINS-9)', async () => {
    const db = makeKysely();
    await runConnectorsMigration(db);
    const store = createConnectorStore(db);
    const base = { userId: 'author', name: 'Connector', description: '', usageNote: '', keyMode: 'personal' as const, capabilities: caps() };
    await store.upsert({ ...base, connectorId: 'shared' });
    expect(await store.listForUser('reader')).toMatchObject([{ id: 'shared', canEdit: false }]);
    expect(await store.getAvailableById('reader', 'shared')).toMatchObject({ ownerUserId: 'author', connector: { id: 'shared', canEdit: false } });
    // No visibility on either shape.
    expect((await store.listForUser('reader'))[0]).not.toHaveProperty('visibility');
    expect((await store.getAvailableById('reader', 'shared'))!.connector).not.toHaveProperty('visibility');
    expect(await store.getByIdNotDeleted('reader', 'shared')).toBeNull();
    expect(await store.softDelete('reader', 'shared')).toBe(false);
    await store.softDelete('author', 'shared');
    expect(await store.getAvailableById('reader', 'shared')).toBeNull();
    expect(await store.listForUser('reader')).toEqual([]);
  });

  it('migration and edits preserve legacy attachment while new and recreated definitions require attachment', async () => {
    const db = makeKysely();
    await runConnectorsMigration(db);
    await db.schema.alterTable('connectors_v1_connectors').dropColumn('requires_attachment').execute();
    const base = { userId: 'author', name: 'Connector', description: '', usageNote: '', keyMode: 'personal' as const, capabilities: caps() };
    await db.insertInto('connectors_v1_connectors').values({
      owner_user_id: 'author', connector_id: 'legacy', name: 'Legacy', description: '', usage_note: '',
      key_mode: 'workspace', default_attached: true,
      capabilities: JSON.stringify(caps()) as unknown as object, deleted_at: null,
      created_at: new Date(), updated_at: new Date(),
    }).execute();
    await runConnectorsMigration(db);
    await runConnectorsMigration(db);
    const store = createConnectorStore(db);
    expect(await store.getByIdNotDeleted('author', 'legacy')).toMatchObject({ requiresAttachment: false, keyMode: 'workspace' });
    // The legacy default flag survives the migration and an edit — only the
    // conversion hooks read it (TASK-808) — but never reaches the domain shape.
    expect(await store.listLegacyDefaults()).toEqual([{ ownerUserId: 'author', connectorId: 'legacy' }]);
    expect(await store.getByIdNotDeleted('author', 'legacy')).not.toHaveProperty('defaultAttached');
    await store.upsert({ ...base, connectorId: 'legacy', keyMode: 'workspace' });
    expect(await store.getByIdNotDeleted('author', 'legacy')).toMatchObject({ requiresAttachment: false });
    expect(await store.listLegacyDefaults()).toEqual([{ ownerUserId: 'author', connectorId: 'legacy' }]);
    await store.upsert({ ...base, connectorId: 'new' });
    expect(await store.getByIdNotDeleted('author', 'new')).toMatchObject({ requiresAttachment: true });
    await store.softDelete('author', 'legacy');
    await store.upsert({ ...base, connectorId: 'legacy' });
    expect(await store.getByIdNotDeleted('author', 'legacy')).toMatchObject({ requiresAttachment: true });
    // Re-creating a tombstoned flagged id starts clean: the stale flag is reset.
    expect(await store.listLegacyDefaults()).toEqual([]);
  });

  it('prefers owned ids and denies ambiguous ids (a legacy duplicate) consistently', async () => {
    const db = makeKysely();
    await runConnectorsMigration(db);
    const store = createConnectorStore(db);
    const base = { connectorId: 'duplicate', name: 'Connector', description: '', usageNote: '', keyMode: 'personal' as const, capabilities: caps() };
    await store.upsert({ ...base, userId: 'alice', name: 'Alice' });
    await store.upsert({ ...base, userId: 'bob', name: 'Bob' });
    expect(await store.getAvailableById('reader', 'duplicate')).toBeNull();
    expect(await store.listForUser('reader')).toEqual([]);
    expect(await store.getAvailableById('alice', 'duplicate')).toMatchObject({ ownerUserId: 'alice', connector: { name: 'Alice', canEdit: true } });
    await store.upsert({ ...base, userId: 'reader', name: 'Own' });
    expect(await store.listForUser('reader')).toMatchObject([{ id: 'duplicate', name: 'Own', canEdit: true }]);
    expect(await store.getAvailableById('reader', 'duplicate')).toMatchObject({ ownerUserId: 'reader', connector: { name: 'Own' } });
  });

  it('getSoleLiveById (TASK-711, SIGNINS-9): only the one live definition, never an ambiguous id', async () => {
    const db = makeKysely();
    await runConnectorsMigration(db);
    const store = createConnectorStore(db);
    const base = { connectorId: 'linear', name: 'Team Linear', description: '', usageNote: '', keyMode: 'personal' as const, capabilities: caps() };
    // No definition yet: nobody gets one.
    expect(await store.getSoleLiveById('owner', 'linear')).toBeNull();
    // One definition: the owner and every member see the same row.
    await store.upsert({ ...base, userId: 'owner' });
    expect(await store.getSoleLiveById('owner', 'linear')).toMatchObject({ ownerUserId: 'owner', connector: { canEdit: true } });
    expect(await store.getSoleLiveById('member', 'linear')).toMatchObject({ ownerUserId: 'owner', connector: { canEdit: false } });
    // The attack shape: a second live definition with the same id (only a
    // legacy duplicate can still produce one). Mallory resolves her own, the
    // others resolve nothing — so the id is ambiguous for EVERYONE.
    await store.upsert({ ...base, userId: 'mallory', name: 'Mine' });
    expect(await store.getAvailableById('mallory', 'linear')).toMatchObject({ ownerUserId: 'mallory' });
    expect(await store.getSoleLiveById('mallory', 'linear')).toBeNull();
    expect(await store.getSoleLiveById('owner', 'linear')).toBeNull();
    expect(await store.getSoleLiveById('member', 'linear')).toBeNull();
    // A deleted definition does not count.
    await store.softDelete('mallory', 'linear');
    expect(await store.getSoleLiveById('member', 'linear')).toMatchObject({ ownerUserId: 'owner' });
    expect(await store.getSoleLiveById('mallory', 'linear')).toMatchObject({ ownerUserId: 'owner' });
  });

  it('connector and summary shapes carry no defaultAttached key (TASK-808 negative space)', async () => {
    const db = makeKysely();
    await runConnectorsMigration(db);
    const store = createConnectorStore(db);
    const base = {
      userId: 'u',
      name: 'C',
      description: '',
      usageNote: '',
      keyMode: 'personal' as const,
      capabilities: caps(),
    };
    const { connector } = await store.upsert({ ...base, connectorId: 'c' });
    expect(connector).not.toHaveProperty('defaultAttached');
    // ...even when the legacy column is set on the row.
    await db.updateTable('connectors_v1_connectors').set({ default_attached: true }).where('connector_id', '=', 'c').execute();
    for (const summary of await store.listForUser('u')) {
      expect(summary).not.toHaveProperty('defaultAttached');
      // The summary still omits the capabilities spec (mechanism behind Advanced).
      expect(summary).not.toHaveProperty('capabilities');
    }
    expect(await store.getByIdNotDeleted('u', 'c')).not.toHaveProperty('defaultAttached');
    for (const entry of await store.listAvailable('u')) {
      expect(entry.connector).not.toHaveProperty('defaultAttached');
    }
    expect(await store.getAvailableById('u', 'c')).not.toHaveProperty('connector.defaultAttached');
  });

  it('upsert never writes the legacy flag: a fresh row is unflagged and an edit leaves an existing flag exactly as it was', async () => {
    const db = makeKysely();
    await runConnectorsMigration(db);
    const store = createConnectorStore(db);
    const base = {
      userId: 'u',
      connectorId: 'c',
      name: 'C',
      description: '',
      usageNote: '',
      keyMode: 'personal' as const,
      capabilities: caps(),
    };
    await store.upsert(base);
    expect(await store.listLegacyDefaults()).toEqual([]);
    await db.updateTable('connectors_v1_connectors').set({ default_attached: true }).execute();
    await store.upsert({ ...base, name: 'C renamed' });
    expect(await store.listLegacyDefaults()).toEqual([{ ownerUserId: 'u', connectorId: 'c' }]);
  });

  it('listLegacyDefaults returns only flagged, non-tombstoned rows across ALL owners, ordered by (owner, id), as bare identities', async () => {
    const db = makeKysely();
    await runConnectorsMigration(db);
    const store = createConnectorStore(db);
    const base = (userId: string, connectorId: string) => ({
      userId,
      connectorId,
      name: connectorId.toUpperCase(),
      description: '',
      usageNote: '',
      keyMode: 'personal' as const,
      capabilities: caps(),
    });
    const flag = (userId: string, connectorId: string) =>
      db.updateTable('connectors_v1_connectors').set({ default_attached: true })
        .where('owner_user_id', '=', userId).where('connector_id', '=', connectorId).execute();

    await store.upsert(base('u2', 'other'));
    await store.upsert(base('u1', 'b'));
    await store.upsert(base('u1', 'a'));
    await store.upsert(base('u1', 'z')); // not flagged
    await store.upsert(base('u1', 'gone'));
    for (const [u, c] of [['u2', 'other'], ['u1', 'b'], ['u1', 'a'], ['u1', 'gone']] as const) await flag(u, c);
    await store.softDelete('u1', 'gone');

    expect(await store.listLegacyDefaults()).toEqual([
      { ownerUserId: 'u1', connectorId: 'a' },
      { ownerUserId: 'u1', connectorId: 'b' },
      { ownerUserId: 'u2', connectorId: 'other' },
    ]);
  });

  it('clearLegacyDefault flips one (owner, id) flag off without bumping updated_at; idempotent; missing row is false', async () => {
    const db = makeKysely();
    await runConnectorsMigration(db);
    const store = createConnectorStore(db);
    const base = (userId: string, connectorId: string) => ({
      userId,
      connectorId,
      name: connectorId,
      description: '',
      usageNote: '',
      keyMode: 'personal' as const,
      capabilities: caps(),
    });
    await store.upsert(base('u1', 'a'));
    await store.upsert(base('u2', 'a'));
    await db.updateTable('connectors_v1_connectors').set({ default_attached: true }).execute();
    const before = await store.getByIdNotDeleted('u1', 'a');

    expect(await store.clearLegacyDefault('u1', 'a')).toBe(true);
    expect(await store.listLegacyDefaults()).toEqual([{ ownerUserId: 'u2', connectorId: 'a' }]);
    expect(await store.clearLegacyDefault('u1', 'a')).toBe(false);
    expect(await store.clearLegacyDefault('u1', 'missing')).toBe(false);
    expect(await store.clearLegacyDefault('nobody', 'a')).toBe(false);
    expect((await store.getByIdNotDeleted('u1', 'a'))?.updatedAt).toBe(before?.updatedAt);
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
      capabilities: caps(),
    });
    await store.upsert({
      userId: 'u2',
      connectorId: 'b',
      name: 'B',
      description: '',
      usageNote: '',
      keyMode: 'personal',
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

  it('validateConnectorId accepts `authored` (reserved only on create), assertConnectorIdCreatable refuses it', () => {
    expect(validateConnectorId('authored')).toBe('authored');
    expect(() => assertConnectorIdCreatable('authored')).toThrow(/reserved/);
    expect(() => assertConnectorIdCreatable('linear')).not.toThrow();
  });

  it('validateKeyMode rejects out-of-enum', () => {
    expect(validateKeyMode('workspace')).toBe('workspace');
    expect(() => validateKeyMode('admin')).toThrow();
  });

  it('validateCapabilities round-trips a valid spec and rejects garbage', () => {
    expect(validateCapabilities(caps())).toEqual(caps());
    expect(() => validateCapabilities({ allowedHosts: 'no' })).toThrow();
  });

  it('validateCapabilities round-trips a spec carrying services (TASK-150)', () => {
    const withServices = {
      ...caps(),
      services: [
        {
          name: 'postgres',
          image: PINNED_IMAGE,
          ports: [5432],
          env: { POSTGRES_PASSWORD: 'x' },
          writablePaths: ['/var/lib/postgresql/data'],
        },
      ],
    };
    const parsed = validateCapabilities(withServices);
    expect(parsed.services).toHaveLength(1);
    expect(parsed.services?.[0]?.image).toBe(PINNED_IMAGE);
  });

  it('validateCapabilities defaults services to [] when omitted', () => {
    const { services: _drop, ...noServices } = caps();
    expect(validateCapabilities(noServices).services).toEqual([]);
  });

  it('validateCapabilities rejects a service with a non-digest image (I8)', () => {
    expect(() =>
      validateCapabilities({
        ...caps(),
        services: [
          { name: 'redis', image: 'redis:7', ports: [6379], env: {}, writablePaths: [] },
        ],
      }),
    ).toThrow();
  });

  it('validateCapabilities rejects a service carrying smuggled backend vocab (I2)', () => {
    expect(() =>
      validateCapabilities({
        ...caps(),
        services: [
          {
            name: 'pg',
            image: PINNED_IMAGE,
            ports: [5432],
            env: {},
            writablePaths: [],
            securityContext: { privileged: true },
          },
        ],
      }),
    ).toThrow();
  });
});

describe('validateCapabilities — stdio removed', () => {
  const base = { allowedHosts: [], credentials: [], packages: { npm: [], pypi: [] } };
  it('rejects a stdio MCP server with the remote-URL hint', () => {
    expect(() =>
      validateCapabilities({
        ...base,
        mcpServers: [
          { name: 'local', transport: 'stdio', command: 'npx', allowedHosts: [], credentials: [] },
        ],
      }),
    ).toThrow('Local (stdio) MCP servers are no longer supported. Use a remote MCP server URL.');
  });
  it('still accepts an http MCP server', () => {
    expect(() =>
      validateCapabilities({
        ...base,
        mcpServers: [
          {
            name: 'remote',
            transport: 'http',
            url: 'https://mcp.example.com',
            allowedHosts: [],
            credentials: [],
          },
        ],
      }),
    ).not.toThrow();
  });
});

// Fix round 1 (SIGNINS-9) — every upsert path writes visibility 'shared', so a
// rolled-back image never reads a resurrected or edited row as private.
describe('createConnectorStore — upserts write the vestigial visibility as shared', () => {
  async function insertPrivate(db: ReturnType<typeof makeKysely>, deleted: boolean): Promise<void> {
    await db.insertInto('connectors_v1_connectors').values({
      owner_user_id: 'owner', connector_id: 'crm', name: 'CRM', description: '', usage_note: '',
      key_mode: 'personal', visibility: 'private',
      capabilities: JSON.stringify(caps()) as unknown as object,
      deleted_at: deleted ? new Date() : null, created_at: new Date(), updated_at: new Date(),
    }).execute();
  }
  const column = async (db: ReturnType<typeof makeKysely>) =>
    (await db.selectFrom('connectors_v1_connectors').select('visibility')
      .where('owner_user_id', '=', 'owner').where('connector_id', '=', 'crm').executeTakeFirstOrThrow()).visibility;
  const base = { userId: 'owner', connectorId: 'crm', name: 'CRM again', description: '', usageNote: '', keyMode: 'personal' as const, capabilities: caps() };

  it('resurrecting a private tombstone stores shared', async () => {
    const db = makeKysely();
    await runConnectorsMigration(db);
    await insertPrivate(db, true);
    const out = await createConnectorStore(db).upsert(base);
    expect(out.created).toBe(true);
    expect(await column(db)).toBe('shared');
  });

  it('an updateOnly edit of a live private row (a failed boot step) stores shared', async () => {
    const db = makeKysely();
    await runConnectorsMigration(db);
    await insertPrivate(db, false);
    await createConnectorStore(db).upsert({ ...base, updateOnly: true });
    expect(await column(db)).toBe('shared');
  });

  it('a plain upsert over a live private row stores shared', async () => {
    const db = makeKysely();
    await runConnectorsMigration(db);
    await insertPrivate(db, false);
    await createConnectorStore(db).upsert(base);
    expect(await column(db)).toBe('shared');
  });
});

describe('createConnectorStore — id liveness across owners (slice 2b)', () => {
  it('hasLiveById counts any owner, never a tombstone', async () => {
    const db = makeKysely();
    await runConnectorsMigration(db);
    const store = createConnectorStore(db);
    const base = { name: 'CRM', description: '', usageNote: '', keyMode: 'personal' as const, capabilities: caps() };
    expect(await store.hasLiveById('crm')).toBe(false);
    await store.upsert({ ...base, userId: 'a', connectorId: 'crm' });
    await store.upsert({ ...base, userId: 'b', connectorId: 'crm' });
    expect(await store.hasLiveById('crm')).toBe(true);
    await store.softDelete('b', 'crm');
    // Another owner's row still keeps the id live.
    expect(await store.hasLiveById('crm')).toBe(true);
    await store.softDelete('a', 'crm');
    expect(await store.hasLiveById('crm')).toBe(false);
  });

  it('liveIds returns the live subset (any owner), deduped, and nothing for an empty list', async () => {
    const db = makeKysely();
    await runConnectorsMigration(db);
    const store = createConnectorStore(db);
    const base = { name: 'X', description: '', usageNote: '', keyMode: 'personal' as const, capabilities: caps() };
    await store.upsert({ ...base, userId: 'a', connectorId: 'crm' });
    await store.upsert({ ...base, userId: 'b', connectorId: 'crm' });
    await store.upsert({ ...base, userId: 'b', connectorId: 'gone' });
    await store.softDelete('b', 'gone');
    expect((await store.liveIds(['crm', 'gone', 'never', 'crm'])).sort()).toEqual(['crm']);
    expect(await store.liveIds([])).toEqual([]);
  });
});
