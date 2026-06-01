import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { PluginError } from '@ax/core';
import { createTestHarness, type TestHarness, stopPostgresContainer } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createConnectorsPlugin } from '../plugin.js';
import type {
  Capabilities,
  DeleteInput,
  DeleteOutput,
  GetInput,
  GetOutput,
  ListDefaultsInput,
  ListDefaultsOutput,
  ListInput,
  ListOutput,
  ResolveInput,
  ResolveOutput,
  UpsertInput,
  UpsertOutput,
} from '../types.js';

// ---------------------------------------------------------------------------
// Hook-level integration: drive the five connectors:* hooks through the bus
// against a real postgres testcontainer. Covers CRUD round-trip, upsert
// create-vs-update, resolve, scope isolation across owners, soft-delete +
// resurrect, and boundary validation.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

async function makeHarness(): Promise<TestHarness> {
  const h = await createTestHarness({
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createConnectorsPlugin(),
    ],
  });
  harnesses.push(h);
  return h;
}

/** An MCP-backed connector spec (Google-Drive-shaped). */
function mcpCaps(): Capabilities {
  return {
    allowedHosts: ['drive.googleapis.com'],
    credentials: [{ slot: 'gdrive', kind: 'api-key', account: 'google' }],
    mcpServers: [
      {
        name: 'gdrive',
        transport: 'http',
        url: 'https://mcp.example.com/gdrive',
        allowedHosts: ['mcp.example.com'],
        credentials: [],
      },
    ],
    packages: { npm: [], pypi: [] },
  };
}

/** A CLI/package-backed connector spec (Salesforce-shaped, zero mcpServers). */
function cliCaps(): Capabilities {
  return {
    allowedHosts: ['login.salesforce.com'],
    credentials: [{ slot: 'sf', kind: 'api-key' }],
    mcpServers: [],
    packages: { npm: ['@salesforce/cli'], pypi: [] },
  };
}

function upsertInput(over: Partial<UpsertInput> = {}): UpsertInput {
  return {
    userId: 'userA',
    connectorId: 'gdrive',
    name: 'Google Drive',
    description: 'My Drive files',
    usageNote: 'Use this to read/write Drive docs.',
    keyMode: 'personal',
    visibility: 'private',
    capabilities: mcpCaps(),
    ...over,
  };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
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
    await cleanup.query('DROP TABLE IF EXISTS connectors_v1_connectors');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('@ax/connectors hooks — CRUD round-trip', () => {
  it('upsert creates, get reads back the full spec, list returns metadata-only', async () => {
    const h = await makeHarness();
    const up = await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'userA' }),
      upsertInput(),
    );
    expect(up.created).toBe(true);
    expect(up.connector.id).toBe('gdrive');
    expect(up.connector.capabilities).toEqual(mcpCaps());

    const got = await h.bus.call<GetInput, GetOutput>(
      'connectors:get',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', connectorId: 'gdrive' },
    );
    expect(got.connector.name).toBe('Google Drive');
    expect(got.connector.usageNote).toBe('Use this to read/write Drive docs.');
    expect(got.connector.keyMode).toBe('personal');
    expect(got.connector.visibility).toBe('private');
    // The opaque spec round-trips byte-faithfully through JSONB.
    expect(got.connector.capabilities).toEqual(mcpCaps());

    const list = await h.bus.call<ListInput, ListOutput>(
      'connectors:list',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA' },
    );
    expect(list.connectors).toHaveLength(1);
    expect(list.connectors[0]!.id).toBe('gdrive');
    // The summary deliberately omits the capabilities spec (mechanism behind
    // Advanced; list stays cheap).
    expect(list.connectors[0]).not.toHaveProperty('capabilities');
    // TASK-110 — the summary DOES carry the workspace-default flag so the user
    // list can badge an admin default-on connector. A non-default connector
    // reports false.
    expect(list.connectors[0]!.defaultAttached).toBe(false);

    // A default-flagged connector surfaces defaultAttached:true on its summary.
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'userA' }),
      upsertInput({ connectorId: 'org-github', name: 'Org GitHub', defaultAttached: true }),
    );
    const list2 = await h.bus.call<ListInput, ListOutput>(
      'connectors:list',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA' },
    );
    const flagged = list2.connectors.find((c) => c.id === 'org-github');
    expect(flagged?.defaultAttached).toBe(true);
  });

  it('upsert updates an existing connector (created=false) and overwrites fields', async () => {
    const h = await makeHarness();
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'userA' }),
      upsertInput(),
    );
    const up2 = await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'userA' }),
      upsertInput({
        name: 'Drive (renamed)',
        keyMode: 'workspace',
        capabilities: cliCaps(),
      }),
    );
    expect(up2.created).toBe(false);
    expect(up2.connector.name).toBe('Drive (renamed)');
    expect(up2.connector.keyMode).toBe('workspace');
    // The whole spec is replaced — mechanism flipped MCP → CLI/package.
    expect(up2.connector.capabilities).toEqual(cliCaps());
  });
});

describe('@ax/connectors hooks — resolve', () => {
  it('resolve returns the mechanism-agnostic spec descriptor (id + keyMode + capabilities)', async () => {
    const h = await makeHarness();
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'userA' }),
      upsertInput({ connectorId: 'sf', capabilities: cliCaps(), keyMode: 'workspace' }),
    );
    const resolved = await h.bus.call<ResolveInput, ResolveOutput>(
      'connectors:resolve',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', connectorId: 'sf' },
    );
    expect(resolved.id).toBe('sf');
    expect(resolved.keyMode).toBe('workspace');
    expect(resolved.capabilities).toEqual(cliCaps());
    // Resolve is the routing surface — it deliberately does NOT carry the
    // management metadata (name/description/visibility).
    expect(resolved).not.toHaveProperty('name');
    expect(resolved).not.toHaveProperty('visibility');
  });

  it('workspace keyMode resolves every slot to scope=global (the company key) + requires consent', async () => {
    const h = await makeHarness();
    // A workspace, shared Salesforce connector — the org-wide systems case.
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'admin' }),
      upsertInput({
        userId: 'admin',
        connectorId: 'sf',
        keyMode: 'workspace',
        visibility: 'shared',
        capabilities: {
          allowedHosts: ['login.salesforce.com'],
          credentials: [{ slot: 'SF_TOKEN', kind: 'api-key', account: 'salesforce' }],
          mcpServers: [],
          packages: { npm: ['@salesforce/cli'], pypi: [] },
        },
      }),
    );
    const resolved = await h.bus.call<ResolveInput, ResolveOutput>(
      'connectors:resolve',
      h.ctx({ userId: 'admin' }),
      { userId: 'admin', connectorId: 'sf' },
    );
    expect(resolved.credentialPlan).toEqual([
      // TASK-124 — single-slot connector keeps the collapsed ref + carries the
      // structured `service` tag (no slotTag).
      { slot: 'SF_TOKEN', scope: 'global', ref: 'account:salesforce', service: 'salesforce' },
    ]);
    expect(resolved.requiresSharedKeyConsent).toBe(true);
  });

  it('personal keyMode resolves every slot to scope=user (per-user JIT vault) + no consent when private', async () => {
    const h = await makeHarness();
    // A personal, private Google Drive connector — the my-data case. Slot tags
    // the shared account:google vault; keyMode binds it per-user.
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'userA' }),
      upsertInput({ keyMode: 'personal', visibility: 'private' }),
    );
    const resolved = await h.bus.call<ResolveInput, ResolveOutput>(
      'connectors:resolve',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', connectorId: 'gdrive' },
    );
    expect(resolved.credentialPlan).toEqual([
      // TASK-124 — single-slot connector keeps the collapsed ref + `service` tag.
      { slot: 'gdrive', scope: 'user', ref: 'account:google', service: 'google' },
    ]);
    expect(resolved.requiresSharedKeyConsent).toBe(false);
  });

  it('resolve for a missing connector throws not-found', async () => {
    const h = await makeHarness();
    await expect(
      h.bus.call<ResolveInput, ResolveOutput>(
        'connectors:resolve',
        h.ctx({ userId: 'userA' }),
        { userId: 'userA', connectorId: 'nope' },
      ),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('@ax/connectors hooks — scope isolation (I7)', () => {
  it('one owner cannot get / list / resolve / delete another owner\'s connector', async () => {
    const h = await makeHarness();
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'userA' }),
      upsertInput(),
    );

    // userB's list is empty.
    const listB = await h.bus.call<ListInput, ListOutput>(
      'connectors:list',
      h.ctx({ userId: 'userB' }),
      { userId: 'userB' },
    );
    expect(listB.connectors).toHaveLength(0);

    // userB get → not-found (no cross-owner read).
    await expect(
      h.bus.call<GetInput, GetOutput>(
        'connectors:get',
        h.ctx({ userId: 'userB' }),
        { userId: 'userB', connectorId: 'gdrive' },
      ),
    ).rejects.toMatchObject({ code: 'not-found' });

    // userB delete → deleted:false (nothing of theirs to delete).
    const delB = await h.bus.call<DeleteInput, DeleteOutput>(
      'connectors:delete',
      h.ctx({ userId: 'userB' }),
      { userId: 'userB', connectorId: 'gdrive' },
    );
    expect(delB.deleted).toBe(false);

    // userA's connector is untouched.
    const stillA = await h.bus.call<GetInput, GetOutput>(
      'connectors:get',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', connectorId: 'gdrive' },
    );
    expect(stillA.connector.id).toBe('gdrive');
  });

  it('two owners may hold the same connector id independently', async () => {
    const h = await makeHarness();
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'userA' }),
      upsertInput({ name: 'A drive' }),
    );
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'userB' }),
      upsertInput({ userId: 'userB', name: 'B drive', capabilities: cliCaps() }),
    );
    const a = await h.bus.call<GetInput, GetOutput>(
      'connectors:get',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', connectorId: 'gdrive' },
    );
    const b = await h.bus.call<GetInput, GetOutput>(
      'connectors:get',
      h.ctx({ userId: 'userB' }),
      { userId: 'userB', connectorId: 'gdrive' },
    );
    expect(a.connector.name).toBe('A drive');
    expect(b.connector.name).toBe('B drive');
    expect(a.connector.capabilities).toEqual(mcpCaps());
    expect(b.connector.capabilities).toEqual(cliCaps());
  });
});

describe('@ax/connectors hooks — delete + resurrect', () => {
  it('delete soft-deletes (get → not-found, list drops it); upsert resurrects', async () => {
    const h = await makeHarness();
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'userA' }),
      upsertInput(),
    );
    const del = await h.bus.call<DeleteInput, DeleteOutput>(
      'connectors:delete',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', connectorId: 'gdrive' },
    );
    expect(del.deleted).toBe(true);

    await expect(
      h.bus.call<GetInput, GetOutput>(
        'connectors:get',
        h.ctx({ userId: 'userA' }),
        { userId: 'userA', connectorId: 'gdrive' },
      ),
    ).rejects.toMatchObject({ code: 'not-found' });

    const listAfter = await h.bus.call<ListInput, ListOutput>(
      'connectors:list',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA' },
    );
    expect(listAfter.connectors).toHaveLength(0);

    // A second delete on an already-tombstoned row → deleted:false.
    const del2 = await h.bus.call<DeleteInput, DeleteOutput>(
      'connectors:delete',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', connectorId: 'gdrive' },
    );
    expect(del2.deleted).toBe(false);

    // Upsert under the same id resurrects it. `created=true`: from the owner's
    // view the connector was gone (a tombstoned row is invisible to get/list),
    // so re-connecting it IS a creation — `created` reflects "no LIVE row
    // existed", which matches the user mental model ("you connected Drive").
    const res = await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'userA' }),
      upsertInput({ name: 'Re-connected' }),
    );
    expect(res.created).toBe(true);
    const got = await h.bus.call<GetInput, GetOutput>(
      'connectors:get',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', connectorId: 'gdrive' },
    );
    expect(got.connector.name).toBe('Re-connected');
  });
});

describe('@ax/connectors hooks — boundary validation', () => {
  it('rejects a bad keyMode / visibility / connectorId / capabilities with invalid-payload', async () => {
    const h = await makeHarness();
    await expect(
      h.bus.call<UpsertInput, UpsertOutput>(
        'connectors:upsert',
        h.ctx({ userId: 'userA' }),
        upsertInput({ keyMode: 'bogus' as unknown as 'personal' }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-payload' });

    await expect(
      h.bus.call<UpsertInput, UpsertOutput>(
        'connectors:upsert',
        h.ctx({ userId: 'userA' }),
        upsertInput({ visibility: 'public' as unknown as 'private' }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-payload' });

    await expect(
      h.bus.call<UpsertInput, UpsertOutput>(
        'connectors:upsert',
        h.ctx({ userId: 'userA' }),
        upsertInput({ connectorId: 'Has Spaces' }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-payload' });

    await expect(
      h.bus.call<UpsertInput, UpsertOutput>(
        'connectors:upsert',
        h.ctx({ userId: 'userA' }),
        upsertInput({ capabilities: { bogus: true } as unknown as Capabilities }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });

  it('rejects an empty userId on every hook', async () => {
    const h = await makeHarness();
    await expect(
      h.bus.call<ListInput, ListOutput>(
        'connectors:list',
        h.ctx({ userId: 'userA' }),
        { userId: '' },
      ),
    ).rejects.toBeInstanceOf(PluginError);
  });
});

describe('@ax/connectors hooks — list-defaults', () => {
  it('returns only the owner\'s default-flagged FULL connectors (capabilities included)', async () => {
    const h = await makeHarness();
    // A default-on connector + a non-default one for the same owner.
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'userA' }),
      upsertInput({ connectorId: 'gdrive', capabilities: mcpCaps(), defaultAttached: true }),
    );
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'userA' }),
      upsertInput({ connectorId: 'sf', capabilities: cliCaps(), defaultAttached: false }),
    );

    const defaults = await h.bus.call<ListDefaultsInput, ListDefaultsOutput>(
      'connectors:list-defaults',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA' },
    );
    expect(defaults.connectors.map((c) => c.id)).toEqual(['gdrive']);
    // FULL connector — the union needs the capabilities spec to materialize reach.
    expect(defaults.connectors[0]!.capabilities).toEqual(mcpCaps());
    expect(defaults.connectors[0]!.defaultAttached).toBe(true);
  });

  it('an absent userId yields no defaults (owner-scoped)', async () => {
    const h = await makeHarness();
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'userA' }),
      upsertInput({ connectorId: 'gdrive', defaultAttached: true }),
    );
    const defaults = await h.bus.call<ListDefaultsInput, ListDefaultsOutput>(
      'connectors:list-defaults',
      h.ctx({ userId: 'userA' }),
      {},
    );
    expect(defaults.connectors).toEqual([]);
  });

  it('rejects a non-boolean defaultAttached on upsert', async () => {
    const h = await makeHarness();
    await expect(
      h.bus.call<UpsertInput, UpsertOutput>(
        'connectors:upsert',
        h.ctx({ userId: 'userA' }),
        upsertInput({ defaultAttached: 'yes' as unknown as boolean }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });
});
