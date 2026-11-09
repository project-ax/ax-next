import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@ax/core';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import {
  createTestHarness,
  startTestContainer,
  stopPostgresContainer,
  type TestHarness,
} from '@ax/test-harness';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
// The package's public surface: this also proves index.ts re-exports the hooks.
import {
  DIRECTORY_PROVENANCE_MARK_EDITED_HOOK,
  DIRECTORY_PROVENANCE_RECORD_HOOK,
  type ConnectorDirectoryConfig,
  type ConnectorDirectoryPlugin,
} from '../index.js';
import { createConnectorDirectoryPlugin } from '../plugin.js';
import { onConnectorDeleted, type ProvenanceStore } from '../provenance.js';
import { createFakeRegistry, page } from './support/fake-registry.js';
import { listing, remote } from './support/listing.js';

const ID = 'linear-0a1b2c3d';
const OTHER_ID = 'other-22222222';
const LINEAR_URL = 'https://mcp.linear.app/mcp';
const valid = {
  connectorId: ID,
  directoryId: 'app.linear/linear',
  version: '1.0.0',
  serverUrl: LINEAR_URL,
};
const REFUSED = { code: 'invalid-payload', message: 'invalid provenance input' };

let container: StartedPostgreSqlContainer;
let connectionString: string;
const booted: TestHarness[] = [];
let harness: TestHarness;
let plugin: ConnectorDirectoryPlugin;

/** The registry as the mirror copies it: Linear, plus one other listing. */
const registry = () =>
  createFakeRegistry(() =>
    page([
      listing({
        name: 'app.linear/linear',
        title: 'Linear',
        remotes: [remote(LINEAR_URL)],
      }),
      listing({ name: 'com.example/other', title: 'Other' }),
    ]),
  );

async function boot(
  config: ConnectorDirectoryConfig = {},
): Promise<{ harness: TestHarness; plugin: ConnectorDirectoryPlugin }> {
  const p = createConnectorDirectoryPlugin({
    syncIntervalMs: 0,
    fetchImpl: registry().fetchImpl,
    ...config,
  });
  const h = await createTestHarness({
    plugins: [createDatabasePostgresPlugin({ connectionString }), p],
  });
  booted.push(h);
  return { harness: h, plugin: p };
}

async function query(text: string, values: unknown[] = []): Promise<Record<string, unknown>[]> {
  const c = new pg.Client({ connectionString });
  await c.connect();
  try {
    return (await c.query(text, values)).rows as Record<string, unknown>[];
  } finally {
    await c.end().catch(() => {});
  }
}

const COLUMNS = 'connector_id, directory_id, version, edited';

async function row(connectorId: string): Promise<Record<string, unknown> | undefined> {
  const rows = await query(
    `SELECT ${COLUMNS} FROM connector_directory_v1_provenance WHERE connector_id = $1`,
    [connectorId],
  );
  return rows[0];
}

const allRows = () =>
  query(`SELECT ${COLUMNS} FROM connector_directory_v1_provenance ORDER BY connector_id`);

interface Line {
  level: string;
  msg: string;
  fields?: Record<string, unknown>;
}

/** A logger that keeps every line, for a ctx handed to the bus. */
function recorder(): { logger: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, ...(fields === undefined ? {} : { fields }) });
  };
  const logger: Logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  };
  return { logger, lines };
}

const record = (input: unknown, ctx = harness.ctx()) =>
  harness.bus.call<unknown, { recorded: boolean }>(DIRECTORY_PROVENANCE_RECORD_HOOK, ctx, input);

const markEdited = (input: unknown) =>
  harness.bus.call<unknown, { marked: boolean }>(
    DIRECTORY_PROVENANCE_MARK_EDITED_HOOK,
    harness.ctx(),
    input,
  );

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

beforeEach(async () => {
  vi.stubGlobal('fetch', () => {
    throw new Error('network is off in tests');
  });
  ({ harness, plugin } = await boot());
  expect(await plugin.sync()).toMatchObject({ outcome: 'ok' });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  while (booted.length > 0) await booted.pop()!.close({ onError: () => {} });
  const c = new pg.Client({ connectionString });
  await c.connect();
  try {
    await c.query(
      'TRUNCATE connector_directory_v1_entries, connector_directory_v1_sync_state, connector_directory_v1_provenance',
    );
  } catch {
    // Not created yet.
  } finally {
    await c.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('@ax/connector-directory: provenance', () => {
  it('records a known listing saved with its own address as unedited', async () => {
    expect(await record(valid)).toEqual({ recorded: true });
    expect(await row(ID)).toEqual({
      connector_id: ID,
      directory_id: 'app.linear/linear',
      version: '1.0.0',
      edited: false,
    });
  });

  it('an address changed before the first save is recorded as edited', async () => {
    expect(await record({ ...valid, serverUrl: 'https://mcp.linear.app/other' })).toEqual({
      recorded: true,
    });
    expect(await row(ID)).toMatchObject({ edited: true });

    // No single server address (none, or several): it cannot be the listing's.
    expect(await record({ ...valid, connectorId: 'linear-11111111', serverUrl: null })).toEqual({
      recorded: true,
    });
    expect(await row('linear-11111111')).toMatchObject({ edited: true });

    // A raw compare: a respelling reads as edited (over-claims, never under-claims).
    expect(
      await record({ ...valid, connectorId: 'linear-22222222', serverUrl: 'https://MCP.linear.app/mcp' }),
    ).toEqual({ recorded: true });
    expect(await row('linear-22222222')).toMatchObject({ edited: true });
  });

  it('keeps the prefilled version even when the listing has moved on', async () => {
    // The mirror holds 1.0.0 now; the editor was filled from 0.9.0.
    expect(await record({ ...valid, version: '0.9.0' })).toEqual({ recorded: true });
    expect(await row(ID)).toEqual({
      connector_id: ID,
      directory_id: 'app.linear/linear',
      version: '0.9.0',
      edited: false,
    });
  });

  it('an unknown listing, or a version the sync would refuse, records nothing', async () => {
    const { logger, lines } = recorder();
    const ctx = harness.ctx({ logger });
    expect(await record({ ...valid, directoryId: 'com.example/nope' }, ctx)).toEqual({
      recorded: false,
    });
    // A right-to-left override: the sync drops a listing whose version has one.
    expect(await record({ ...valid, version: '1.0.0‮' }, ctx)).toEqual({ recorded: false });
    // No listing id can hold a NUL (Postgres text cannot): a miss, not a failed lookup.
    expect(await record({ ...valid, directoryId: 'app.linear/linear\u0000' }, ctx)).toEqual({
      recorded: false,
    });
    expect(await row(ID)).toBeUndefined();

    // The server-derived id and a fixed reason: never the client's strings.
    const ignored = (reason: string): Line => ({
      level: 'info',
      msg: 'connector_directory_provenance_ignored',
      fields: { connectorId: ID, reason },
    });
    expect(lines).toEqual([
      ignored('unknown-listing'),
      ignored('unusable-version'),
      ignored('unknown-listing'),
    ]);
  });

  it('input outside the contract is refused', async () => {
    const inputs: unknown[] = [
      null,
      { ...valid, edited: false },
      { ...valid, directoryId: `app.linear/${'x'.repeat(190)}` }, // 201
      { ...valid, version: '1'.repeat(256) },
      { ...valid, connectorId: '' },
      { ...valid, connectorId: 'c'.repeat(129) },
      { connectorId: ID, directoryId: 'app.linear/linear', version: '1.0.0' },
      { ...valid, serverUrl: 1 },
      { ...valid, serverUrl: `https://mcp.linear.app/${'p'.repeat(65_537 - 23)}` }, // 65,537
    ];
    for (const input of inputs) {
      await expect(record(input)).rejects.toMatchObject(REFUSED);
    }
    expect(await allRows()).toEqual([]);
  });

  it('saving again replaces the row, edited included', async () => {
    expect(
      await record({
        connectorId: ID,
        directoryId: 'com.example/other',
        version: '0.9.0',
        serverUrl: 'https://x.example/mcp',
      }),
    ).toEqual({ recorded: true });
    expect(await row(ID)).toEqual({
      connector_id: ID,
      directory_id: 'com.example/other',
      version: '0.9.0',
      edited: true,
    });

    expect(await record(valid)).toEqual({ recorded: true });
    expect(await allRows()).toEqual([
      { connector_id: ID, directory_id: 'app.linear/linear', version: '1.0.0', edited: false },
    ]);
  });

  it('mark-edited flips an existing row and creates none', async () => {
    expect(await record(valid)).toEqual({ recorded: true });
    expect(await markEdited({ connectorId: ID })).toEqual({ marked: true });
    expect(await row(ID)).toMatchObject({ edited: true });
    // Already edited: still a match.
    expect(await markEdited({ connectorId: ID })).toEqual({ marked: true });

    expect(await markEdited({ connectorId: 'missing-00000000' })).toEqual({ marked: false });
    expect(await row('missing-00000000')).toBeUndefined();

    await expect(markEdited({ connectorId: 1 })).rejects.toMatchObject(REFUSED);
    await expect(markEdited({ connectorId: ID, edited: false })).rejects.toMatchObject(REFUSED);
    expect(await allRows()).toEqual([
      { connector_id: ID, directory_id: 'app.linear/linear', version: '1.0.0', edited: true },
    ]);
  });

  it('connectors:deleted drops the row only when no live connector keeps the id', async () => {
    expect(await record(valid)).toEqual({ recorded: true });
    expect(await record({ ...valid, connectorId: OTHER_ID })).toEqual({ recorded: true });
    const { logger, lines } = recorder();
    const ctx = harness.ctx({ logger });
    const fire = (payload: unknown) => harness.bus.fire('connectors:deleted', ctx, payload);

    // Another owner's connector still carries the id.
    const live = { connectorId: ID, toolNamespaces: [], idStillLive: true };
    expect(await fire(live)).toEqual({ rejected: false, payload: live });
    expect(await row(ID)).toBeDefined();

    // Unsure is keep: no id, or an idStillLive that is not exactly false.
    for (const junk of [null, { idStillLive: false }, { connectorId: ID, idStillLive: 'false' }]) {
      expect(await fire(junk)).toEqual({ rejected: false, payload: junk });
    }
    expect(await row(ID)).toBeDefined();

    const gone = { connectorId: ID, toolNamespaces: [], idStillLive: false };
    expect(await fire(gone)).toEqual({ rejected: false, payload: gone });
    expect(await row(ID)).toBeUndefined();
    expect(await row(OTHER_ID)).toBeDefined();
    // Nothing left to remove: it still resolves, and says nothing.
    expect(await fire(gone)).toEqual({ rejected: false, payload: gone });

    // Exactly these lines: a subscriber that threw would add the bus's own.
    const skipped: Line = {
      level: 'warn',
      msg: 'connector_directory_provenance_delete_event_skipped',
      fields: { reason: 'no-connector-id' },
    };
    expect(lines).toEqual([
      skipped,
      skipped,
      { level: 'info', msg: 'connector_directory_provenance_removed', fields: { connectorId: ID } },
    ]);
  });

  it('a failed delete is logged by its codes, never thrown', async () => {
    const down = Object.assign(new Error(`row ${ID} could not be read`), { code: '57P01' });
    const store: ProvenanceStore = {
      listingUrl: () => Promise.reject(new Error('unused')),
      upsert: () => Promise.reject(new Error('unused')),
      markEdited: () => Promise.reject(new Error('unused')),
      remove: () => Promise.reject(down),
    };
    const { logger, lines } = recorder();
    const payload = { connectorId: ID, toolNamespaces: [], idStillLive: false };
    await expect(onConnectorDeleted(store)(harness.ctx({ logger }), payload)).resolves.toBeUndefined();
    // The codes only: a database message can quote the data.
    expect(lines).toEqual([
      {
        level: 'error',
        msg: 'connector_directory_provenance_remove_failed',
        fields: { connectorId: ID, code: '57P01', name: 'Error' },
      },
    ]);
  });

  it('a registry change, which clears the mirror, leaves provenance alone', async () => {
    expect(await record(valid)).toEqual({ recorded: true });
    // Pointed at another registry that does not list Linear: the sync clears
    // the mirror (the same reset a full crawl starts with) and copies afresh.
    const moved = await boot({
      registryUrl: 'https://registry.example',
      fetchImpl: createFakeRegistry(() => page([listing({ name: 'com.example/other' })])).fetchImpl,
    });
    expect(await moved.plugin.sync()).toMatchObject({ outcome: 'ok', full: true });
    expect(await query('SELECT id FROM connector_directory_v1_entries')).toEqual([
      { id: 'com.example/other' },
    ]);
    expect(await allRows()).toEqual([
      { connector_id: ID, directory_id: 'app.linear/linear', version: '1.0.0', edited: false },
    ]);
  });
});
