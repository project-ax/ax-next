import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PluginError } from '@ax/core';
import { startTestContainer, stopPostgresContainer } from '@ax/test-harness';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { DirectorySearchOutput } from '../contract.js';
import { runConnectorDirectoryMigration, type ConnectorDirectoryDatabase } from '../migrations.js';
import type { DirectoryRow } from '../normalize.js';
import { searchDirectory } from '../search.js';
import { createDirectoryStore, type DirectoryStore } from '../store.js';

const SYNCED_AT = new Date('2026-11-09T12:00:00.000Z');

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Kysely<ConnectorDirectoryDatabase>;
let store: DirectoryStore;

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 5 });
  db = new Kysely<ConnectorDirectoryDatabase>({ dialect: new PostgresDialect({ pool }) });
  await runConnectorDirectoryMigration(db);
  store = createDirectoryStore(db);
}, 120_000);

beforeEach(async () => {
  await sql`TRUNCATE connector_directory_v1_entries, connector_directory_v1_sync_state`.execute(db);
});

afterAll(async () => {
  await db?.destroy().catch(() => {});
  if (container) await stopPostgresContainer(container);
});

function row(id: string, o: Partial<DirectoryRow> = {}): DirectoryRow {
  return {
    id,
    title: id,
    description: '',
    publisher: 'example.com',
    publisherProof: 'domain',
    url: 'https://mcp.example.com/mcp',
    auth: 'none',
    keyHeader: null,
    version: '1.0.0',
    updatedAt: new Date('2026-11-01T00:00:00Z'),
    deprecated: false,
    ...o,
  };
}

/** Store rows the way one sync would; `synced: false` stops before the sync completes. */
async function seed(rows: DirectoryRow[], o: { synced?: boolean } = {}): Promise<void> {
  await store.useSource('https://registry.test/');
  await store.applyPage({ upserts: rows, deletes: [] }, 100_000);
  if (o.synced !== false) await store.recordSuccess({ watermark: SYNCED_AT, syncedAt: SYNCED_AT });
}

function search(input: unknown, verifiedOnly = false): Promise<DirectorySearchOutput> {
  return searchDirectory(db, input, { verifiedOnly });
}

async function ids(input: unknown, verifiedOnly = false): Promise<string[]> {
  return (await search(input, verifiedOnly)).entries.map((e) => e.id);
}

/** The PluginError a search rejects with; fails the test on anything else. */
async function refusal(input: unknown): Promise<PluginError> {
  try {
    await search(input);
  } catch (err) {
    expect(err).toBeInstanceOf(PluginError);
    return err as PluginError;
  }
  throw new Error('expected the search to reject');
}

describe('searchDirectory', () => {
  it('an empty or whitespace query returns no entries but still reports freshness', async () => {
    await seed([row('com.example/acme', { title: 'Acme' })]);
    for (const query of ['', '   ', '​\n']) {
      expect(await search({ query })).toEqual({
        enabled: true,
        entries: [],
        syncedAt: SYNCED_AT.toISOString(),
        stale: false,
        verifiedOnly: false,
      });
    }
  });

  it('never synced: no entries even when rows exist', async () => {
    await seed([row('com.example/acme', { title: 'Acme' })], { synced: false });
    expect(await search({ query: 'acme' })).toEqual({
      enabled: true,
      entries: [],
      syncedAt: null,
      stale: false,
      verifiedOnly: false,
    });
    // And with no state row at all.
    await sql`TRUNCATE connector_directory_v1_sync_state`.execute(db);
    expect(await search({ query: 'acme' })).toMatchObject({ entries: [], syncedAt: null });
  });

  it('matches title, description, publisher and id, case-insensitively', async () => {
    await seed([
      row('com.example/one', { title: 'ACME Tools' }),
      row('com.example/two', { title: 'Two', description: 'Built by Acme' }),
      row('com.other/three', { title: 'Three', publisher: 'acme.example' }),
      row('com.acmecorp/four', { title: 'Four', publisher: 'four.com' }),
      row('com.example/five', { title: 'Unrelated', description: 'nothing here' }),
    ]);
    const expected = ['com.acmecorp/four', 'com.example/one', 'com.example/two', 'com.other/three'];
    expect((await ids({ query: 'acme' })).sort()).toEqual(expected);
    expect((await ids({ query: 'ACME' })).sort()).toEqual(expected);
  });

  it('domain listings outrank account listings whatever the match', async () => {
    await seed([
      row('io.github.someone/notion', {
        title: 'Notion',
        publisher: 'someone',
        publisherProof: 'account',
      }),
      row('com.example/workspace', { title: 'Workspace', description: 'Syncs with notion' }),
    ]);
    expect(await ids({ query: 'notion' })).toEqual([
      'com.example/workspace',
      'io.github.someone/notion',
    ]);
  });

  it('within a tier: publisher label, exact title, title prefix, title contains, id or publisher, description', async () => {
    // Titles chosen so alphabetical order is NOT the expected order.
    await seed([
      row('com.five/e', { title: 'Alpha', description: 'Works with zeta', publisher: 'five.com' }),
      row('com.four/zetabot', { title: 'Bot', publisher: 'four.com' }),
      row('com.zetamail/x', { title: 'Mail', publisher: 'zetamail.com' }),
      row('com.three/d', { title: 'The Zeta Server', publisher: 'three.com' }),
      row('com.two/c', { title: 'Zetaflow', publisher: 'two.com' }),
      row('com.one/b', { title: 'Zeta', publisher: 'one.com' }),
      row('io.zeta/a', { title: 'Yonder', publisher: 'zeta.io' }),
    ]);
    expect(await ids({ query: 'zeta' })).toEqual([
      'io.zeta/a', // 0: `zeta` is a whole label of the publisher
      'com.one/b', // 1: title equals
      'com.two/c', // 2: title starts with
      'com.three/d', // 3: title contains
      'com.four/zetabot', // 4: id contains
      'com.zetamail/x', // 4: publisher contains, but not as a whole label
      'com.five/e', // 5: description only
    ]);
  });

  it('the official listing outranks a third party titled with the brand', async () => {
    // Notion's own listing has no title, so its title is its id.
    await seed([
      row('com.insightfulpipe/notion', { title: 'Notion', publisher: 'insightfulpipe.com' }),
      row('io.notion-tasks/x', { title: 'Tasks', publisher: 'notion-tasks.io' }),
      row('com.notion/mcp', { publisher: 'notion.com' }),
    ]);
    expect(await ids({ query: 'notion' })).toEqual([
      'com.notion/mcp',
      'com.insightfulpipe/notion',
      'io.notion-tasks/x',
    ]);
  });

  it('ties break by title then id, the same every time', async () => {
    await seed([
      row('com.b/x', { title: 'A tie' }),
      row('com.c/x', { title: 'B tie' }),
      row('com.a/x', { title: 'A tie' }),
    ]);
    for (let i = 0; i < 3; i += 1) {
      expect(await ids({ query: 'tie' })).toEqual(['com.a/x', 'com.b/x', 'com.c/x']);
    }
  });

  it('verifiedOnly drops account listings and says so', async () => {
    await seed([
      row('com.acme/a', { title: 'Acme', publisher: 'acme.com' }),
      row('io.github.acme-fan/acme', {
        title: 'Acme fan',
        publisher: 'acme-fan',
        publisherProof: 'account',
      }),
    ]);
    const verified = await search({ query: 'acme' }, true);
    expect(verified.entries.map((e) => e.id)).toEqual(['com.acme/a']);
    expect(verified.verifiedOnly).toBe(true);
    expect(await ids({ query: 'acme' })).toEqual(['com.acme/a', 'io.github.acme-fan/acme']);
  });

  it('stale only when the last attempt failed and a copy exists', async () => {
    await seed([row('com.example/acme', { title: 'Acme' })]);
    expect(await search({ query: 'acme' })).toMatchObject({ stale: false });

    await store.recordFailure(new Date('2026-11-09T13:00:00Z'));
    expect(await search({ query: 'acme' })).toMatchObject({
      stale: true,
      syncedAt: SYNCED_AT.toISOString(),
      entries: [{ id: 'com.example/acme' }],
    });

    // Failing before any complete copy is not stale: there is nothing to be stale.
    await sql`TRUNCATE connector_directory_v1_entries, connector_directory_v1_sync_state`.execute(db);
    await seed([], { synced: false });
    await store.recordFailure(new Date('2026-11-09T13:00:00Z'));
    expect(await search({ query: 'acme' })).toMatchObject({ stale: false, syncedAt: null });
  });

  it('limit is clamped to 1..50 and pages with our cursor', async () => {
    await seed(
      Array.from({ length: 60 }, (_, i) => {
        const n = String(i).padStart(2, '0');
        return row(`com.example/item-${n}`, { title: `Item ${n}` });
      }),
    );
    const id = (n: number) => `com.example/item-${String(n).padStart(2, '0')}`;
    const range = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) => id(from + i));

    const big = await search({ query: 'item', limit: 500 });
    expect(big.entries.map((e) => e.id)).toEqual(range(0, 50));
    expect(big.nextCursor).toEqual(expect.any(String));
    const rest = await search({ query: 'item', limit: 500, cursor: big.nextCursor });
    expect(rest.entries.map((e) => e.id)).toEqual(range(50, 60));
    expect('nextCursor' in rest).toBe(false);

    for (const limit of [0, -5]) {
      const one = await search({ query: 'item', limit });
      expect(one.entries.map((e) => e.id)).toEqual([id(0)]);
      expect(one.nextCursor).toEqual(expect.any(String));
    }

    // The default page is 20; the last page carries no cursor.
    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const out = await search({ query: 'item', ...(cursor === undefined ? {} : { cursor }) });
      pages.push(out.entries.map((e) => e.id));
      cursor = out.nextCursor;
    } while (cursor !== undefined && pages.length < 10);
    expect(pages).toEqual([range(0, 20), range(20, 40), range(40, 60)]);

    // An empty cursor is no cursor.
    expect(await ids({ query: 'item', cursor: '', limit: 1 })).toEqual([id(0)]);
  });

  it('LIKE metacharacters and quotes match literally', async () => {
    await seed([
      row('com.example/percent', { title: '100% uptime' }),
      row('com.example/under', { title: 'snake_case tools' }),
      row('com.example/quote', { title: "O'Brien's server" }),
      row('com.example/slash', { title: 'back\\slash tools' }),
      row('com.example/plain', { title: 'plain tools', description: 'nothing special' }),
    ]);
    expect(await ids({ query: '%' })).toEqual(['com.example/percent']);
    expect(await ids({ query: '_' })).toEqual(['com.example/under']);
    expect(await ids({ query: "o'brien" })).toEqual(['com.example/quote']);
    expect(await ids({ query: "'" })).toEqual(['com.example/quote']);
    expect(await ids({ query: '\\' })).toEqual(['com.example/slash']);
    expect(await ids({ query: '%%' })).toEqual([]);
  });

  it('a query is cleaned the way stored text was, so a NUL or bidi character never errors', async () => {
    // Stored text was cleaned at sync: controls, bidi and zero-width became spaces.
    await seed([row('com.example/bad', { title: 'Bad Title' })]);
    for (const query of ['Bad\u0000Title', 'bad‮title', '  bad   title ', 'Bad​Title']) {
      expect(await ids({ query })).toEqual(['com.example/bad']);
    }
  });

  it('bad input is invalid-payload with fixed text', async () => {
    await seed([row('com.example/acme', { title: 'Acme' })]);
    const long = 'q'.repeat(201);
    for (const input of [
      { query: long },
      { query: 1 },
      { query: 'acme', extra: 1 },
      { query: 'acme', limit: 2.5 },
      { query: 'acme', cursor: 'c'.repeat(65) },
      null,
      'acme',
    ]) {
      const err = await refusal(input);
      expect(err.code).toBe('invalid-payload');
      expect(err.message).toBe('invalid directory search input');
    }
    const junk = await refusal({ query: 'acme', cursor: 'SECRET-JUNK' });
    expect(junk.code).toBe('invalid-payload');
    expect(junk.message).toBe('invalid cursor');
  });

  it('keyHeader and deprecated appear only when set', async () => {
    await seed([
      row('com.example/open', { title: 'Open tools' }),
      row('com.example/keyed', {
        title: 'Keyed tools',
        description: 'Needs a key',
        auth: 'key',
        keyHeader: 'X-API-Key',
        version: '2.0.0',
        deprecated: true,
      }),
    ]);
    const { entries } = await search({ query: 'tools' });
    expect(entries).toStrictEqual([
      {
        id: 'com.example/keyed',
        title: 'Keyed tools',
        description: 'Needs a key',
        publisher: 'example.com',
        publisherProof: 'domain',
        url: 'https://mcp.example.com/mcp',
        auth: 'key',
        keyHeader: 'X-API-Key',
        version: '2.0.0',
        updatedAt: '2026-11-01T00:00:00.000Z',
        deprecated: true,
      },
      {
        id: 'com.example/open',
        title: 'Open tools',
        description: '',
        publisher: 'example.com',
        publisherProof: 'domain',
        url: 'https://mcp.example.com/mcp',
        auth: 'none',
        version: '1.0.0',
        updatedAt: '2026-11-01T00:00:00.000Z',
      },
    ]);
    expect('keyHeader' in entries[1]!).toBe(false);
    expect('deprecated' in entries[1]!).toBe(false);
  });
});
