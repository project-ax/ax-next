import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { PluginError } from '@ax/core';
import {
  createTestHarness,
  type TestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createConnectorsPlugin } from '../plugin.js';
import {
  ClearLegacyDefaultOutputSchema,
  ListLegacyDefaultsOutputSchema,
  ResolveOutputSchema,
  ToolLabelsOutputSchema,
} from '../types.js';
import {
  deriveToolNamespace,
  deriveToolNamespaces,
  TOOL_NAMESPACE_RE,
} from '../tool-namespace.js';
import type {
  Capabilities,
  ConnectorDeletedEvent,
  ConnectorToolNamespacesChangedEvent,
  DeleteInput,
  DeleteOutput,
  GetInput,
  GetOutput,
  ClearLegacyDefaultInput,
  ClearLegacyDefaultOutput,
  ListLegacyDefaultsInput,
  ListLegacyDefaultsOutput,
  ListInput,
  ListOutput,
  ResolveInput,
  ResolveOutput,
  ToolLabelsInput,
  ToolLabelsOutput,
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

/** An MCP-backed connector spec (Google-Drive-shaped). No share-by-service
 *  `account` tag — each connector owns its own key, keyed by the connector id. */
function mcpCaps(): Capabilities {
  return {
    allowedHosts: ['drive.googleapis.com'],
    credentials: [{ slot: 'gdrive', kind: 'api-key' }],
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
    // TASK-150 — the store's CapabilitiesSchema defaults services to [] on
    // parse, so a stored→read round-trip carries services: []. Set it here so
    // the .toEqual round-trip assertions stay exact.
    services: [],
  };
}

/** A CLI/package-backed connector spec (Salesforce-shaped, zero mcpServers). */
function cliCaps(): Capabilities {
  return {
    allowedHosts: ['login.salesforce.com'],
    credentials: [{ slot: 'sf', kind: 'api-key' }],
    mcpServers: [],
    packages: { npm: ['@salesforce/cli'], pypi: [] },
    services: [],
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

/** The `default_attached` column is no longer written by any hook (TASK-808),
 *  so a legacy default is simulated the way it exists in the wild: a row whose
 *  flag was set before this change. Direct SQL, like list-effective's markLegacy. */
async function flagLegacyDefault(ownerUserId: string, connectorId: string): Promise<void> {
  const client = new (await import('pg')).default.Client({ connectionString });
  await client.connect();
  try {
    await client.query(
      'UPDATE connectors_v1_connectors SET default_attached = true WHERE owner_user_id = $1 AND connector_id = $2',
      [ownerUserId, connectorId],
    );
  } finally {
    await client.end().catch(() => {});
  }
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
    // TASK-808 — negative space: "Set default" is gone, so no summary carries a
    // workspace-default flag (a stale reader that keyed off it must see nothing).
    expect(list.connectors[0]).not.toHaveProperty('defaultAttached');

    // ...even for a row that still has the legacy column set in the database
    // (it is only read by the transitional conversion hooks).
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'userA' }),
      upsertInput({ connectorId: 'org-github', name: 'Org GitHub' }),
    );
    await flagLegacyDefault('userA', 'org-github');
    const list2 = await h.bus.call<ListInput, ListOutput>(
      'connectors:list',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA' },
    );
    expect(list2.connectors.map((c) => c.id)).toContain('org-github');
    for (const summary of list2.connectors) {
      expect(summary).not.toHaveProperty('defaultAttached');
    }
    const flaggedGet = await h.bus.call<GetInput, GetOutput>(
      'connectors:get',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', connectorId: 'org-github' },
    );
    expect(flaggedGet.connector).not.toHaveProperty('defaultAttached');
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

  it('strips a legacy share-by-service `account` tag from a stored slot on read', async () => {
    const h = await makeHarness();
    // A connector authored before the share-by-service removal could carry an
    // `account` tag on its slot. The store re-validates capabilities on write AND
    // read against a schema that no longer declares `account`, so the tag is
    // dropped — the read path can never resurrect the old shared-key behaviour.
    const up = await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'userA' }),
      upsertInput({
        connectorId: 'legacy',
        capabilities: {
          allowedHosts: [],
          credentials: [{ slot: 'TOKEN', kind: 'api-key', account: 'shared-svc' }],
          mcpServers: [],
          packages: { npm: [], pypi: [] },
        },
      }),
    );
    expect(up.connector.capabilities.credentials).toEqual([
      { slot: 'TOKEN', kind: 'api-key' },
    ]);
    // And the derived plan keys the ref by the connector id, NOT the legacy tag.
    const resolved = await h.bus.call<ResolveInput, ResolveOutput>(
      'connectors:resolve',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', connectorId: 'legacy' },
    );
    expect(resolved.credentialPlan).toEqual([
      { slot: 'TOKEN', scope: 'user', ref: 'account:legacy', service: 'legacy' },
    ]);
  });
});

describe('@ax/connectors hooks — resolve', () => {
  it('resolves a shared definition with personal credentials without automatically attaching it', async () => {
    const h = await makeHarness();
    await h.bus.call<UpsertInput, UpsertOutput>('connectors:upsert', h.ctx({ userId: 'userA' }), upsertInput({ visibility: 'shared' }));
    const resolved = await h.bus.call<ResolveInput, ResolveOutput>('connectors:resolve', h.ctx({ userId: 'userB' }), { userId: 'userB', connectorId: 'gdrive' });
    expect(resolved.credentialPlan).toMatchObject([{ scope: 'user', ref: 'account:gdrive' }]);
    expect(resolved.capabilities).toEqual(mcpCaps());
    // A shared definition is not an attachment: it is not effective for a user
    // who never attached it (TASK-808 — there is no default path left either).
    const effective = await h.bus.call('connectors:list-effective', h.ctx({ userId: 'userB' }), { userId: 'userB' });
    expect(effective).toEqual({ connectors: [] });
  });

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

  it('resolve returns the connector usageNote (regression: it was dropped, so an owner-owned connector surfaced the generic fallback SKILL.md instead of its instructions)', async () => {
    const h = await makeHarness();
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'userA' }),
      upsertInput({
        connectorId: 'linear',
        usageNote: 'Run `npx -y @schpet/linear-cli` to query Linear.',
        capabilities: cliCaps(),
      }),
    );
    const resolved = await h.bus.call<ResolveInput, ResolveOutput>(
      'connectors:resolve',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', connectorId: 'linear' },
    );
    // The orchestrator folds `resolved.usageNote` into the connector's SKILL.md
    // body; dropping it here forced the generic "...MCP servers wired..."
    // fallback for every owner-owned (non-default) connector.
    expect(resolved.usageNote).toBe('Run `npx -y @schpet/linear-cli` to query Linear.');
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
      // Single-slot connector keeps the collapsed ref + carries the structured
      // `service` tag (no slotTag). The key is keyed by the CONNECTOR ID ('sf') —
      // the slot's legacy `account: 'salesforce'` tag is stripped on read + ignored.
      { slot: 'SF_TOKEN', scope: 'global', ref: 'account:sf', service: 'sf' },
    ]);
    expect(resolved.requiresSharedKeyConsent).toBe(true);
  });

  it('personal keyMode resolves every slot to scope=user (per-user JIT vault) + no consent when private', async () => {
    const h = await makeHarness();
    // A personal, private Google Drive connector — the my-data case. The key is
    // keyed by the connector id ('gdrive'); keyMode binds it per-user.
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
      // Single-slot connector keeps the collapsed ref + `service` tag. Keyed by
      // the connector id 'gdrive' — the slot's legacy `account: 'google'` tag is
      // stripped on read + ignored (each connector owns its own key).
      { slot: 'gdrive', scope: 'user', ref: 'account:gdrive', service: 'gdrive' },
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

// ---------------------------------------------------------------------------
// Purge-on-delete: deleting a connector also purges its stored key(s) so a
// secret can never linger with no UI home. credentials:delete is an optionalCall
// (soft-dep) — a credentials:delete spy stands in for @ax/credentials here. Each
// purge targets the connector's OWN derived refs, at the scope the connector
// declares (personal → user/ownerId:userId, workspace → global/ownerId:null).
// ---------------------------------------------------------------------------
interface CredDeleteCall {
  scope: string;
  ownerId: string | null;
  ref: string;
}

async function makeHarnessWithCredSpy(): Promise<{
  h: TestHarness;
  calls: CredDeleteCall[];
}> {
  const calls: CredDeleteCall[] = [];
  const h = await createTestHarness({
    services: {
      // Matches @ax/credentials' real handler shape (async, returns void).
      'credentials:delete': async (_ctx, input) => {
        calls.push(input as CredDeleteCall);
      },
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createConnectorsPlugin(),
    ],
  });
  harnesses.push(h);
  return { h, calls };
}

describe('@ax/connectors hooks — delete purges the connector\'s credentials', () => {
  it('a personal connector purges its slot at scope:user / ownerId:userId', async () => {
    const { h, calls } = await makeHarnessWithCredSpy();
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
    // mcpCaps() is single-slot → collapsed ref account:<connectorId>.
    expect(calls).toEqual([
      { scope: 'user', ownerId: 'userA', ref: 'account:gdrive' },
    ]);
  });

  it('a workspace connector purges its GLOBAL key only when purgeGlobal is authorized (admin)', async () => {
    const { h, calls } = await makeHarnessWithCredSpy();
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'admin' }),
      upsertInput({
        userId: 'admin',
        connectorId: 'sf',
        keyMode: 'workspace',
        visibility: 'shared',
        capabilities: cliCaps(),
      }),
    );
    // purgeGlobal:true (the route passes actor.isAdmin) → the shared company key
    // at scope:global / ownerId:null is purged.
    const del = await h.bus.call<DeleteInput, DeleteOutput>(
      'connectors:delete',
      h.ctx({ userId: 'admin' }),
      { userId: 'admin', connectorId: 'sf', purgeGlobal: true },
    );
    expect(del.deleted).toBe(true);
    expect(calls).toEqual([{ scope: 'global', ownerId: null, ref: 'account:sf' }]);
  });

  it('SECURITY: a workspace connector delete WITHOUT purgeGlobal leaves the shared global key intact', async () => {
    // The authority gate that closes the cross-tenant DoS: a non-admin's delete
    // (purgeGlobal omitted/false) must NEVER tombstone a global (company) key,
    // however the non-admin came to own the workspace connector (incl. the
    // authored-connector approve path that bypasses the HTTP keyMode gate).
    const { h, calls } = await makeHarnessWithCredSpy();
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'mallory' }),
      upsertInput({
        userId: 'mallory',
        connectorId: 'sf',
        keyMode: 'workspace',
        visibility: 'private',
        capabilities: cliCaps(),
      }),
    );
    const del = await h.bus.call<DeleteInput, DeleteOutput>(
      'connectors:delete',
      h.ctx({ userId: 'mallory' }),
      { userId: 'mallory', connectorId: 'sf' }, // no purgeGlobal → not authorized
    );
    // The connector row is still soft-deleted, but NO global credential is purged.
    expect(del.deleted).toBe(true);
    expect(calls).toEqual([]);
  });

  it('a multi-slot connector purges every per-slot ref (no key left behind)', async () => {
    const { h, calls } = await makeHarnessWithCredSpy();
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'userA' }),
      upsertInput({
        connectorId: 'oauthsvc',
        capabilities: {
          allowedHosts: ['api.example.com'],
          credentials: [
            { slot: 'CLIENT_ID', kind: 'api-key' },
            { slot: 'CLIENT_SECRET', kind: 'api-key' },
          ],
          mcpServers: [],
          packages: { npm: [], pypi: [] },
        },
      }),
    );
    await h.bus.call<DeleteInput, DeleteOutput>(
      'connectors:delete',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', connectorId: 'oauthsvc' },
    );
    expect(calls).toEqual([
      { scope: 'user', ownerId: 'userA', ref: 'account:oauthsvc:CLIENT_ID' },
      { scope: 'user', ownerId: 'userA', ref: 'account:oauthsvc:CLIENT_SECRET' },
    ]);
  });

  // TASK-797 — a custom-client OAuth connector's client secret is the
  // connector's own key too: user copy always, global copy (an admin's shared
  // connector) only under purgeGlobal, and only for a SHARED connector.
  function customClientCaps(id: string) {
    return {
      allowedHosts: ['mcp.example.com'],
      credentials: [
        {
          slot: 'TOKEN',
          kind: 'oauth' as const,
          server: id,
          clientId: 'pinned-client',
          clientRegistration: 'custom' as const,
          clientSecretRef: `account:${id}:OAUTH_CLIENT_SECRET`,
        },
      ],
      mcpServers: [
        { name: id, transport: 'http' as const, url: 'https://mcp.example.com/mcp', allowedHosts: [], credentials: [] },
      ],
      packages: { npm: [], pypi: [] },
    };
  }

  it('an admin deleting a shared custom-client connector purges its client secret at user AND global scope', async () => {
    const { h, calls } = await makeHarnessWithCredSpy();
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'admin' }),
      upsertInput({
        userId: 'admin',
        connectorId: 'gmail',
        visibility: 'shared',
        capabilities: customClientCaps('gmail') as unknown as UpsertInput['capabilities'],
      }),
    );
    await h.bus.call<DeleteInput, DeleteOutput>(
      'connectors:delete',
      h.ctx({ userId: 'admin' }),
      { userId: 'admin', connectorId: 'gmail', purgeGlobal: true },
    );
    expect(calls).toEqual([
      { scope: 'user', ownerId: 'admin', ref: 'account:gmail' },
      { scope: 'user', ownerId: 'admin', ref: 'account:gmail:OAUTH_CLIENT_SECRET' },
      { scope: 'global', ownerId: null, ref: 'account:gmail:OAUTH_CLIENT_SECRET' },
    ]);
  });

  it('SECURITY: without purgeGlobal, or for a PRIVATE connector, the global client secret is left intact', async () => {
    const { h, calls } = await makeHarnessWithCredSpy();
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'mallory' }),
      upsertInput({
        userId: 'mallory',
        connectorId: 'gmail',
        visibility: 'shared',
        capabilities: customClientCaps('gmail') as unknown as UpsertInput['capabilities'],
      }),
    );
    await h.bus.call<DeleteInput, DeleteOutput>(
      'connectors:delete',
      h.ctx({ userId: 'mallory' }),
      { userId: 'mallory', connectorId: 'gmail' },
    );
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'admin2' }),
      upsertInput({
        userId: 'admin2',
        connectorId: 'gmail',
        visibility: 'private',
        capabilities: customClientCaps('gmail') as unknown as UpsertInput['capabilities'],
      }),
    );
    await h.bus.call<DeleteInput, DeleteOutput>(
      'connectors:delete',
      h.ctx({ userId: 'admin2' }),
      { userId: 'admin2', connectorId: 'gmail', purgeGlobal: true },
    );
    expect(calls.filter((c) => c.scope === 'global')).toEqual([]);
    expect(calls).toContainEqual({
      scope: 'user',
      ownerId: 'mallory',
      ref: 'account:gmail:OAUTH_CLIENT_SECRET',
    });
    expect(calls).toContainEqual({
      scope: 'user',
      ownerId: 'admin2',
      ref: 'account:gmail:OAUTH_CLIENT_SECRET',
    });
  });

  it('deleting an absent connector purges nothing', async () => {
    const { h, calls } = await makeHarnessWithCredSpy();
    const del = await h.bus.call<DeleteInput, DeleteOutput>(
      'connectors:delete',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', connectorId: 'gdrive' },
    );
    expect(del.deleted).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('@ax/connectors hooks — delete degrades without credentials:delete', () => {
  it('still soft-deletes the connector when credentials:delete is absent (no throw)', async () => {
    const h = await makeHarness(); // no credentials:delete provider in this stack
    expect(h.bus.hasService('credentials:delete')).toBe(false);
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
  });
});

describe('@ax/connectors hooks — delete fires connectors:deleted', () => {
  it('fires once with the connectorId + the owner-derived toolNamespaces after a live delete', async () => {
    const h = await makeHarness();
    const events: ConnectorDeletedEvent[] = [];
    h.bus.subscribe<ConnectorDeletedEvent>('connectors:deleted', 'test/capture', async (_ctx, payload) => {
      events.push(payload);
      return undefined;
    });
    const up = await h.bus.call<UpsertInput, UpsertOutput>(
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
    const expected = deriveToolNamespaces('userA', up.connector);
    expect(expected).toHaveLength(1);
    expect(events).toEqual([{ connectorId: 'gdrive', toolNamespaces: expected }]);
    // Storage-agnostic: no owner field rides the payload.
    expect(Object.keys(events[0]!).sort()).toEqual(['connectorId', 'toolNamespaces']);
  });

  it('fires nothing when the connector is absent or already deleted', async () => {
    const h = await makeHarness();
    const events: ConnectorDeletedEvent[] = [];
    h.bus.subscribe<ConnectorDeletedEvent>('connectors:deleted', 'test/capture', async (_ctx, payload) => {
      events.push(payload);
      return undefined;
    });
    const absent = await h.bus.call<DeleteInput, DeleteOutput>(
      'connectors:delete',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', connectorId: 'gdrive' },
    );
    expect(absent.deleted).toBe(false);

    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'userA' }),
      upsertInput(),
    );
    await h.bus.call<DeleteInput, DeleteOutput>(
      'connectors:delete',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', connectorId: 'gdrive' },
    );
    expect(events).toHaveLength(1);
    // A second delete of the tombstoned row announces nothing more.
    const again = await h.bus.call<DeleteInput, DeleteOutput>(
      'connectors:delete',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', connectorId: 'gdrive' },
    );
    expect(again.deleted).toBe(false);
    expect(events).toHaveLength(1);
  });

  it('does not announce another owner\'s same-id connector (delete is owner-scoped)', async () => {
    const h = await makeHarness();
    const events: ConnectorDeletedEvent[] = [];
    h.bus.subscribe<ConnectorDeletedEvent>('connectors:deleted', 'test/capture', async (_ctx, payload) => {
      events.push(payload);
      return undefined;
    });
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'userA' }),
      upsertInput(),
    );
    const del = await h.bus.call<DeleteInput, DeleteOutput>(
      'connectors:delete',
      h.ctx({ userId: 'userB' }),
      { userId: 'userB', connectorId: 'gdrive' },
    );
    expect(del.deleted).toBe(false);
    expect(events).toEqual([]);
  });

  it('a throwing subscriber never fails the delete', async () => {
    const h = await makeHarness();
    h.bus.subscribe<ConnectorDeletedEvent>('connectors:deleted', 'test/boom', async () => {
      throw new Error('subscriber exploded');
    });
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
    // The row really is gone.
    await expect(
      h.bus.call<GetInput, GetOutput>(
        'connectors:get',
        h.ctx({ userId: 'userA' }),
        { userId: 'userA', connectorId: 'gdrive' },
      ),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('fires with an empty toolNamespaces for a connector with no MCP servers', async () => {
    const h = await makeHarness();
    const events: ConnectorDeletedEvent[] = [];
    h.bus.subscribe<ConnectorDeletedEvent>('connectors:deleted', 'test/capture', async (_ctx, payload) => {
      events.push(payload);
      return undefined;
    });
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'userA' }),
      upsertInput({ connectorId: 'sf', capabilities: cliCaps() }),
    );
    await h.bus.call<DeleteInput, DeleteOutput>(
      'connectors:delete',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', connectorId: 'sf' },
    );
    expect(events).toEqual([{ connectorId: 'sf', toolNamespaces: [] }]);
  });
});

describe('@ax/connectors hooks — upsert fires connectors:tool-namespaces-changed (TASK-752)', () => {
  function capture(h: TestHarness): ConnectorToolNamespacesChangedEvent[] {
    const events: ConnectorToolNamespacesChangedEvent[] = [];
    h.bus.subscribe<ConnectorToolNamespacesChangedEvent>(
      'connectors:tool-namespaces-changed',
      'test/capture',
      async (_ctx, payload) => {
        events.push(payload);
        return undefined;
      },
    );
    return events;
  }

  function withServers(...servers: Array<{ name: string; url: string }>): Capabilities {
    const base = mcpCaps();
    return {
      ...base,
      mcpServers: servers.map((s) => ({ ...base.mcpServers[0]!, name: s.name, url: s.url })),
    };
  }

  it('renaming a server announces old -> new namespace, derived from the row owner', async () => {
    const h = await makeHarness();
    const events = capture(h);
    const url = 'https://mcp.example.com/gdrive';
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'userA' }),
      upsertInput({ capabilities: withServers({ name: 'gdrive', url }) }),
    );
    expect(events).toEqual([]); // a create moves nothing
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'userA' }),
      upsertInput({ capabilities: withServers({ name: 'drive', url }) }),
    );
    expect(events).toEqual([
      {
        connectorId: 'gdrive',
        renamed: [
          {
            from: { server: 'gdrive', toolNamespace: deriveToolNamespace('userA', 'gdrive', 'gdrive') },
            to: { server: 'drive', toolNamespace: deriveToolNamespace('userA', 'gdrive', 'drive') },
          },
        ],
        removed: [],
      },
    ]);
    expect(Object.keys(events[0]!).sort()).toEqual(['connectorId', 'removed', 'renamed']);
  });

  it('removing a server announces it as removed; an unchanged edit announces nothing', async () => {
    const h = await makeHarness();
    const events = capture(h);
    const a = { name: 'a', url: 'https://mcp.example.com/a' };
    const b = { name: 'b', url: 'https://mcp.example.com/b' };
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'userA' }),
      upsertInput({ capabilities: withServers(a, b) }),
    );
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'userA' }),
      upsertInput({ capabilities: withServers(a, b), description: 'just a description edit' }),
    );
    expect(events).toEqual([]);
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'userA' }),
      upsertInput({ capabilities: withServers(a) }),
    );
    expect(events).toEqual([
      {
        connectorId: 'gdrive',
        renamed: [],
        removed: [{ server: 'b', toolNamespace: deriveToolNamespace('userA', 'gdrive', 'b') }],
      },
    ]);
  });

  it('TASK-755: same server name + new endpoint announces it as removed; same endpoint announces nothing', async () => {
    const h = await makeHarness();
    const events = capture(h);
    const at = (url: string) => withServers({ name: 'gdrive', url });
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'userA' }),
      upsertInput({ capabilities: at('https://mcp.example.com/gdrive') }),
    );
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'userA' }),
      upsertInput({ capabilities: at('https://mcp.example.com/gdrive'), name: 'Drive (renamed)' }),
    );
    expect(events).toEqual([]);
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'userA' }),
      upsertInput({ capabilities: at('https://elsewhere.example.com/mcp') }),
    );
    expect(events).toEqual([
      {
        connectorId: 'gdrive',
        renamed: [],
        removed: [{ server: 'gdrive', toolNamespace: deriveToolNamespace('userA', 'gdrive', 'gdrive') }],
      },
    ]);
  });

  it('a throwing subscriber never fails the upsert', async () => {
    const h = await makeHarness();
    h.bus.subscribe('connectors:tool-namespaces-changed', 'test/boom', async () => {
      throw new Error('subscriber exploded');
    });
    const url = 'https://mcp.example.com/gdrive';
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'userA' }),
      upsertInput({ capabilities: withServers({ name: 'gdrive', url }) }),
    );
    const out = await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'userA' }),
      upsertInput({ capabilities: withServers({ name: 'drive', url }) }),
    );
    expect(out.connector.capabilities.mcpServers.map((s) => s.name)).toEqual(['drive']);
  });

  describe('an endpoint change is reset BEFORE it commits (TASK-758)', () => {
    const at = (url: string) => withServers({ name: 'gdrive', url });
    const OLD = 'https://mcp.example.com/gdrive';
    const NEW = 'https://elsewhere.example.com/mcp';
    const NS = deriveToolNamespace('userA', 'gdrive', 'gdrive');

    async function seeded() {
      const h = await makeHarness();
      await h.bus.call<UpsertInput, UpsertOutput>(
        'connectors:upsert',
        h.ctx({ userId: 'userA' }),
        upsertInput({ capabilities: at(OLD) }),
      );
      return h;
    }

    const savedUrl = async (h: TestHarness) =>
      (
        await h.bus.call<GetInput, GetOutput>('connectors:get', h.ctx({ userId: 'userA' }), {
          userId: 'userA',
          connectorId: 'gdrive',
        })
      ).connector.capabilities.mcpServers[0]?.url;

    it('resets exactly the moved server’s namespace, and does so before the row changes', async () => {
      const h = await seeded();
      const calls: Array<{ toolNamespaces: string[]; urlAtCall: string | undefined }> = [];
      h.bus.registerService<{ toolNamespaces: string[] }, { toolNamespaces: string[] }>(
        'tool-policy:reset-tool-namespaces',
        'test/reset',
        async (_ctx, input) => {
          calls.push({ toolNamespaces: input.toolNamespaces, urlAtCall: await savedUrl(h) });
          return { toolNamespaces: input.toolNamespaces };
        },
      );
      await h.bus.call<UpsertInput, UpsertOutput>(
        'connectors:upsert',
        h.ctx({ userId: 'userA' }),
        upsertInput({ capabilities: at(NEW) }),
      );
      expect(calls).toEqual([{ toolNamespaces: [NS], urlAtCall: OLD }]);
      expect(await savedUrl(h)).toBe(NEW);
    });

    it('a failed reset refuses the edit with tool-permissions-reset-failed and writes nothing', async () => {
      const h = await seeded();
      const events = capture(h);
      h.bus.registerService('tool-policy:reset-tool-namespaces', 'test/reset', async () => {
        throw new Error('verdict store is down');
      });
      await expect(
        h.bus.call<UpsertInput, UpsertOutput>(
          'connectors:upsert',
          h.ctx({ userId: 'userA' }),
          upsertInput({ capabilities: at(NEW) }),
        ),
      ).rejects.toMatchObject({ code: 'tool-permissions-reset-failed' });
      expect(await savedUrl(h)).toBe(OLD);
      expect(events).toEqual([]);
    });

    it('renames, removed servers and unchanged endpoints never call the reset', async () => {
      const h = await makeHarness();
      let calls = 0;
      h.bus.registerService('tool-policy:reset-tool-namespaces', 'test/reset', async () => {
        calls += 1;
        throw new Error('must not be called');
      });
      const a = { name: 'a', url: 'https://mcp.example.com/a' };
      const b = { name: 'b', url: 'https://mcp.example.com/b' };
      const up = (capabilities: Capabilities, extra: Partial<UpsertInput> = {}) =>
        h.bus.call<UpsertInput, UpsertOutput>(
          'connectors:upsert',
          h.ctx({ userId: 'userA' }),
          upsertInput({ capabilities, ...extra }),
        );
      await up(withServers(a, b)); // create
      await up(withServers(a, b), { description: 'just a description edit' });
      await up(withServers({ ...a, name: 'a2' }, b)); // rename
      await up(withServers({ ...a, name: 'a2' })); // remove b
      expect(calls).toBe(0);
    });

    it('with no reset provider loaded the endpoint change saves (there are no stored choices)', async () => {
      const h = await seeded();
      await h.bus.call<UpsertInput, UpsertOutput>(
        'connectors:upsert',
        h.ctx({ userId: 'userA' }),
        upsertInput({ capabilities: at(NEW) }),
      );
      expect(await savedUrl(h)).toBe(NEW);
    });
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

// ---------------------------------------------------------------------------
// TASK-808 — the two TRANSITIONAL hooks that let @ax/agents convert the old
// owner-scoped "Set default" flag into explicit attachments at boot. The flag is
// no longer written by anything; these are its only readers.
// ---------------------------------------------------------------------------
describe('@ax/connectors hooks — legacy default conversion (TASK-808)', () => {
  async function listLegacy(h: TestHarness): Promise<ListLegacyDefaultsOutput> {
    return h.bus.call<ListLegacyDefaultsInput, ListLegacyDefaultsOutput>(
      'connectors:list-legacy-defaults',
      h.ctx({ userId: 'system' }),
      {},
    );
  }
  async function clearLegacy(h: TestHarness, ownerUserId: string, connectorId: string): Promise<ClearLegacyDefaultOutput> {
    return h.bus.call<ClearLegacyDefaultInput, ClearLegacyDefaultOutput>(
      'connectors:clear-legacy-default',
      h.ctx({ userId: 'system' }),
      { ownerUserId, connectorId },
    );
  }
  async function seedConnector(h: TestHarness, userId: string, connectorId: string): Promise<void> {
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId }),
      upsertInput({ userId, connectorId }),
    );
  }

  it('lists every LIVE flagged row across ALL owners, ordered by (owner, connector id), as bare {ownerUserId, connectorId}', async () => {
    const h = await makeHarness();
    await seedConnector(h, 'userB', 'zeta');
    await seedConnector(h, 'userA', 'beta');
    await seedConnector(h, 'userA', 'alpha');
    await seedConnector(h, 'userA', 'plain'); // never flagged
    await seedConnector(h, 'userB', 'alpha');
    for (const [owner, id] of [['userB', 'zeta'], ['userA', 'beta'], ['userA', 'alpha'], ['userB', 'alpha']] as const) {
      await flagLegacyDefault(owner, id);
    }
    expect(await listLegacy(h)).toEqual({
      connectors: [
        { ownerUserId: 'userA', connectorId: 'alpha' },
        { ownerUserId: 'userA', connectorId: 'beta' },
        { ownerUserId: 'userB', connectorId: 'alpha' },
        { ownerUserId: 'userB', connectorId: 'zeta' },
      ],
    });
  });

  it('skips tombstoned rows and unflagged rows; an empty database lists nothing', async () => {
    const h = await makeHarness();
    expect(await listLegacy(h)).toEqual({ connectors: [] });
    await seedConnector(h, 'userA', 'live');
    await seedConnector(h, 'userA', 'gone');
    await seedConnector(h, 'userA', 'unflagged');
    await flagLegacyDefault('userA', 'live');
    await flagLegacyDefault('userA', 'gone');
    await h.bus.call<DeleteInput, DeleteOutput>('connectors:delete', h.ctx({ userId: 'userA' }), { userId: 'userA', connectorId: 'gone' });
    expect(await listLegacy(h)).toEqual({ connectors: [{ ownerUserId: 'userA', connectorId: 'live' }] });
  });

  it('carries no capabilities / mechanism detail — only the two identity fields', async () => {
    const h = await makeHarness();
    await seedConnector(h, 'userA', 'live');
    await flagLegacyDefault('userA', 'live');
    const out = await listLegacy(h);
    expect(Object.keys(out.connectors[0]!).sort()).toEqual(['connectorId', 'ownerUserId']);
  });

  it('clear flips the flag off, is idempotent (second call cleared:false) and never touches updated_at', async () => {
    const h = await makeHarness();
    await seedConnector(h, 'userA', 'live');
    await seedConnector(h, 'userA', 'other');
    await flagLegacyDefault('userA', 'live');
    await flagLegacyDefault('userA', 'other');
    const before = await h.bus.call<GetInput, GetOutput>('connectors:get', h.ctx({ userId: 'userA' }), { userId: 'userA', connectorId: 'live' });

    expect(await clearLegacy(h, 'userA', 'live')).toEqual({ cleared: true });
    // The sibling's flag is untouched; the cleared row has left the list.
    expect(await listLegacy(h)).toEqual({ connectors: [{ ownerUserId: 'userA', connectorId: 'other' }] });
    expect(await clearLegacy(h, 'userA', 'live')).toEqual({ cleared: false });
    expect(await clearLegacy(h, 'userA', 'live')).toEqual({ cleared: false });

    // Not a user edit: updated_at did not move.
    const after = await h.bus.call<GetInput, GetOutput>('connectors:get', h.ctx({ userId: 'userA' }), { userId: 'userA', connectorId: 'live' });
    expect(after.connector.updatedAt).toBe(before.connector.updatedAt);
  });

  it('clear on a row that does not exist, or belongs to another owner, is cleared:false and changes nothing', async () => {
    const h = await makeHarness();
    await seedConnector(h, 'userA', 'live');
    await flagLegacyDefault('userA', 'live');
    expect(await clearLegacy(h, 'nobody', 'live')).toEqual({ cleared: false });
    expect(await clearLegacy(h, 'userA', 'missing')).toEqual({ cleared: false });
    expect(await listLegacy(h)).toEqual({ connectors: [{ ownerUserId: 'userA', connectorId: 'live' }] });
  });

  it('clear validates both inputs (non-empty owner, a valid connector id)', async () => {
    const h = await makeHarness();
    const call = (input: unknown) => h.bus.call('connectors:clear-legacy-default', h.ctx({ userId: 'system' }), input);
    await expect(call({ ownerUserId: '', connectorId: 'live' })).rejects.toMatchObject({ code: 'invalid-payload' });
    await expect(call({ connectorId: 'live' })).rejects.toMatchObject({ code: 'invalid-payload' });
    await expect(call({ ownerUserId: 7, connectorId: 'live' })).rejects.toMatchObject({ code: 'invalid-payload' });
    await expect(call({ ownerUserId: 'userA', connectorId: '' })).rejects.toMatchObject({ code: 'invalid-payload' });
    await expect(call({ ownerUserId: 'userA', connectorId: 'Bad Id!' })).rejects.toMatchObject({ code: 'invalid-payload' });
    await expect(call({ ownerUserId: 'userA' })).rejects.toMatchObject({ code: 'invalid-payload' });
  });

  it('an edit does not set the flag, and re-creating a tombstoned flagged id starts clean', async () => {
    const h = await makeHarness();
    await seedConnector(h, 'userA', 'live');
    // A plain re-upsert (an edit) of an unflagged row stays unflagged.
    await seedConnector(h, 'userA', 'live');
    expect(await listLegacy(h)).toEqual({ connectors: [] });

    // A flagged row that is tombstoned and later re-created under the same id is
    // a NEW connector: the stale flag must not come back with it.
    await flagLegacyDefault('userA', 'live');
    await h.bus.call<DeleteInput, DeleteOutput>('connectors:delete', h.ctx({ userId: 'userA' }), { userId: 'userA', connectorId: 'live' });
    await seedConnector(h, 'userA', 'live');
    expect(await listLegacy(h)).toEqual({ connectors: [] });
  });

  it('a flagged row is NOT effective on its own any more — only an attachment reaches an agent (list-effective has no default source)', async () => {
    const h = await makeHarness();
    await seedConnector(h, 'userA', 'live');
    await flagLegacyDefault('userA', 'live');
    const none = await h.bus.call<{ userId: string }, { connectors: unknown[] }>('connectors:list-effective', h.ctx({ userId: 'userA' }), { userId: 'userA' });
    expect(none.connectors).toEqual([]);
  });

  it('the old hook is gone; the two conversion hooks are registered; upsert ignores a stale defaultAttached input and never writes the flag', async () => {
    const h = await makeHarness();
    expect(h.bus.hasService('connectors:list-defaults')).toBe(false);
    expect(h.bus.hasService('connectors:list-legacy-defaults')).toBe(true);
    expect(h.bus.hasService('connectors:clear-legacy-default')).toBe(true);
    // The HTTP surface is what rejects the field loudly; the hook just ignores it.
    await h.bus.call('connectors:upsert', h.ctx({ userId: 'userA' }), {
      ...upsertInput(),
      defaultAttached: true,
    });
    expect(await listLegacy(h)).toEqual({ connectors: [] });
  });

  it('the return schemas accept the documented shapes and reject malformed ones', () => {
    expect(ListLegacyDefaultsOutputSchema.parse({ connectors: [{ ownerUserId: 'u', connectorId: 'c' }] }))
      .toEqual({ connectors: [{ ownerUserId: 'u', connectorId: 'c' }] });
    expect(ClearLegacyDefaultOutputSchema.parse({ cleared: true })).toEqual({ cleared: true });
    expect(() => ListLegacyDefaultsOutputSchema.parse({ connectors: [{ ownerUserId: 'u' }] })).toThrow();
    expect(() => ClearLegacyDefaultOutputSchema.parse({})).toThrow();
  });
});

describe('@ax/connectors hooks — toolNamespaces (TASK-734)', () => {
  /** A connector with two MCP servers so ordering + per-server derivation show. */
  function twoServerCaps(): Capabilities {
    return {
      allowedHosts: [],
      credentials: [],
      mcpServers: [
        { name: 'alpha', transport: 'http', url: 'https://mcp.example.com/a', allowedHosts: ['mcp.example.com'], credentials: [] },
        { name: 'beta', transport: 'http', url: 'https://mcp.example.com/b', allowedHosts: ['mcp.example.com'], credentials: [] },
      ],
      packages: { npm: [], pypi: [] },
      services: [],
    };
  }

  async function resolve(h: TestHarness, userId: string, connectorId: string): Promise<ResolveOutput> {
    return h.bus.call<ResolveInput, ResolveOutput>('connectors:resolve', h.ctx({ userId }), { userId, connectorId });
  }

  it('resolve returns one toolNamespace per mcpServers entry, in order, derived from (owner, id, server)', async () => {
    const h = await makeHarness();
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'userA' }),
      upsertInput({ connectorId: 'duo', capabilities: twoServerCaps() }),
    );
    const resolved = await resolve(h, 'userA', 'duo');
    expect(resolved.toolNamespaces).toEqual([
      { server: 'alpha', toolNamespace: deriveToolNamespace('userA', 'duo', 'alpha') },
      { server: 'beta', toolNamespace: deriveToolNamespace('userA', 'duo', 'beta') },
    ]);
    for (const entry of resolved.toolNamespaces) {
      expect(entry.toolNamespace).toMatch(TOOL_NAMESPACE_RE);
    }
    expect(resolved.toolNamespaces[0]!.toolNamespace).not.toBe(resolved.toolNamespaces[1]!.toolNamespace);
  });

  it('a shared connector resolved by a NON-owner gets the SAME namespace as the owner (row owner, not requester)', async () => {
    const h = await makeHarness();
    await h.bus.call<UpsertInput, UpsertOutput>(
      'connectors:upsert',
      h.ctx({ userId: 'userA' }),
      upsertInput({ connectorId: 'shared-mcp', visibility: 'shared' }),
    );
    const asOwner = await resolve(h, 'userA', 'shared-mcp');
    const asReader = await resolve(h, 'userB', 'shared-mcp');
    expect(asOwner.toolNamespaces).toHaveLength(1);
    expect(asReader.toolNamespaces).toEqual(asOwner.toolNamespaces);
    // ...and it is the OWNER's derivation, not one keyed off the requesting user.
    expect(asReader.toolNamespaces[0]!.toolNamespace).toBe(deriveToolNamespace('userA', 'shared-mcp', 'gdrive'));
    expect(asReader.toolNamespaces[0]!.toolNamespace).not.toBe(deriveToolNamespace('userB', 'shared-mcp', 'gdrive'));
  });

  it('two distinct records (two owners, same connector id, same server name) get different namespaces', async () => {
    const h = await makeHarness();
    await h.bus.call<UpsertInput, UpsertOutput>('connectors:upsert', h.ctx({ userId: 'userA' }), upsertInput({ userId: 'userA', connectorId: 'linear' }));
    await h.bus.call<UpsertInput, UpsertOutput>('connectors:upsert', h.ctx({ userId: 'userB' }), upsertInput({ userId: 'userB', connectorId: 'linear' }));
    const a = await resolve(h, 'userA', 'linear');
    const b = await resolve(h, 'userB', 'linear');
    expect(a.toolNamespaces[0]!.server).toBe(b.toolNamespaces[0]!.server);
    expect(a.toolNamespaces[0]!.toolNamespace).not.toBe(b.toolNamespaces[0]!.toolNamespace);
  });

  it('the namespace is stable across resolves and independent of unrelated edits to the record', async () => {
    const h = await makeHarness();
    await h.bus.call<UpsertInput, UpsertOutput>('connectors:upsert', h.ctx({ userId: 'userA' }), upsertInput());
    const first = await resolve(h, 'userA', 'gdrive');
    await h.bus.call<UpsertInput, UpsertOutput>('connectors:upsert', h.ctx({ userId: 'userA' }), upsertInput({ name: 'Renamed', usageNote: 'changed' }));
    const second = await resolve(h, 'userA', 'gdrive');
    expect(second.toolNamespaces).toEqual(first.toolNamespaces);
  });

  it('a connector with no mcpServers resolves toolNamespaces: []', async () => {
    const h = await makeHarness();
    await h.bus.call<UpsertInput, UpsertOutput>('connectors:upsert', h.ctx({ userId: 'userA' }), upsertInput({ connectorId: 'sf', capabilities: cliCaps() }));
    const resolved = await resolve(h, 'userA', 'sf');
    expect(resolved.toolNamespaces).toEqual([]);
  });

  it('list-effective returns toolNamespaces on each connector, equal to resolve for the same record', async () => {
    const h = await makeHarness();
    await h.bus.call<UpsertInput, UpsertOutput>('connectors:upsert', h.ctx({ userId: 'userA' }), upsertInput({ connectorId: 'duo', capabilities: twoServerCaps() }));
    await h.bus.call<UpsertInput, UpsertOutput>('connectors:upsert', h.ctx({ userId: 'userA' }), upsertInput({ connectorId: 'sf', capabilities: cliCaps() }));
    const effective = await h.bus.call<
      { userId: string; attachmentIds: string[] },
      { connectors: Array<{ summary: { id: string }; capabilities: Capabilities; toolNamespaces: unknown[] }> }
    >('connectors:list-effective', h.ctx({ userId: 'userA' }), { userId: 'userA', attachmentIds: ['duo', 'sf'] });
    expect(effective.connectors.map((c) => c.summary.id)).toEqual(['duo', 'sf']);
    const duo = effective.connectors[0]!;
    const sf = effective.connectors[1]!;
    expect(duo.toolNamespaces).toEqual((await resolve(h, 'userA', 'duo')).toolNamespaces);
    expect(duo.toolNamespaces).toHaveLength(2);
    expect(sf.toolNamespaces).toEqual([]);
    // The rest of the full connector is still there.
    expect(duo.capabilities).toEqual(twoServerCaps());
  });

  it('the return schemas keep toolNamespaces (a round-trip must not strip the field)', () => {
    const toolNamespaces = [{ server: 'gdrive', toolNamespace: 'c0123456789' }];
    const resolveOut = ResolveOutputSchema.parse({
      id: 'gdrive',
      keyMode: 'personal',
      usageNote: '',
      capabilities: mcpCaps(),
      credentialPlan: [],
      requiresSharedKeyConsent: false,
      toolNamespaces,
    });
    expect(resolveOut.toolNamespaces).toEqual(toolNamespaces);
  });

  it('the return schemas reject a payload that omits toolNamespaces (so a producer cannot silently drop it)', () => {
    expect(() =>
      ResolveOutputSchema.parse({
        id: 'gdrive',
        keyMode: 'personal',
        usageNote: '',
        capabilities: mcpCaps(),
        credentialPlan: [],
        requiresSharedKeyConsent: false,
      }),
    ).toThrow();
  });
});

describe('@ax/connectors hooks — tool-labels (TASK-744)', () => {
  async function labels(h: TestHarness, userId: string): Promise<ToolLabelsOutput> {
    return h.bus.call<ToolLabelsInput, ToolLabelsOutput>(
      'connectors:tool-labels',
      h.ctx({ userId }),
      { userId },
    );
  }

  it('names every namespace the caller can resolve, keyed exactly as connectors:resolve derives it', async () => {
    const h = await makeHarness();
    await h.bus.call<UpsertInput, UpsertOutput>('connectors:upsert', h.ctx({ userId: 'userA' }), upsertInput({ connectorId: 'linear', name: 'Linear' }));
    await h.bus.call<UpsertInput, UpsertOutput>('connectors:upsert', h.ctx({ userId: 'userA' }), upsertInput({ connectorId: 'sf', name: 'Salesforce', capabilities: cliCaps() }));
    const resolved = await h.bus.call<ResolveInput, ResolveOutput>('connectors:resolve', h.ctx({ userId: 'userA' }), { userId: 'userA', connectorId: 'linear' });
    const out = await labels(h, 'userA');
    // A connector with no MCP servers has no tools to name.
    expect(out.connectors).toEqual([
      { toolNamespace: resolved.toolNamespaces[0]!.toolNamespace, connectorId: 'linear', name: 'Linear' },
    ]);
  });

  it('a shared connector is named for a non-owner under the OWNER-derived namespace', async () => {
    const h = await makeHarness();
    await h.bus.call<UpsertInput, UpsertOutput>('connectors:upsert', h.ctx({ userId: 'userA' }), upsertInput({ connectorId: 'shared-mcp', name: 'Team Drive', visibility: 'shared' }));
    const out = await labels(h, 'userB');
    expect(out.connectors).toEqual([
      { toolNamespace: deriveToolNamespace('userA', 'shared-mcp', 'gdrive'), connectorId: 'shared-mcp', name: 'Team Drive' },
    ]);
  });

  it('SECURITY: another owner\'s PRIVATE connector is never named, and a deleted one drops out', async () => {
    const h = await makeHarness();
    await h.bus.call<UpsertInput, UpsertOutput>('connectors:upsert', h.ctx({ userId: 'userA' }), upsertInput({ connectorId: 'secret', name: 'A private thing' }));
    expect((await labels(h, 'userB')).connectors).toEqual([]);
    expect((await labels(h, 'userA')).connectors).toHaveLength(1);
    await h.bus.call<DeleteInput, DeleteOutput>('connectors:delete', h.ctx({ userId: 'userA' }), { userId: 'userA', connectorId: 'secret' });
    expect((await labels(h, 'userA')).connectors).toEqual([]);
  });

  it('a multi-server connector gets one entry per server, all carrying its name', async () => {
    const h = await makeHarness();
    await h.bus.call<UpsertInput, UpsertOutput>('connectors:upsert', h.ctx({ userId: 'userA' }), upsertInput({
      connectorId: 'duo',
      name: 'Duo',
      capabilities: {
        ...mcpCaps(),
        mcpServers: [
          { name: 'alpha', transport: 'http', url: 'https://mcp.example.com/a', allowedHosts: ['mcp.example.com'], credentials: [] },
          { name: 'beta', transport: 'http', url: 'https://mcp.example.com/b', allowedHosts: ['mcp.example.com'], credentials: [] },
        ],
      },
    }));
    const out = await labels(h, 'userA');
    expect(out.connectors).toEqual([
      { toolNamespace: deriveToolNamespace('userA', 'duo', 'alpha'), connectorId: 'duo', name: 'Duo' },
      { toolNamespace: deriveToolNamespace('userA', 'duo', 'beta'), connectorId: 'duo', name: 'Duo' },
    ]);
  });

  it('rejects a missing userId', async () => {
    const h = await makeHarness();
    await expect(
      h.bus.call<ToolLabelsInput, ToolLabelsOutput>('connectors:tool-labels', h.ctx({ userId: 'userA' }), { userId: '' }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });

  it('the return schema keeps every field (a round-trip must not strip one)', () => {
    const row = { toolNamespace: 'c0123456789', connectorId: 'linear', name: 'Linear' };
    expect(ToolLabelsOutputSchema.parse({ connectors: [row] })).toEqual({ connectors: [row] });
    // TASK-753: z.object strips unknown keys silently, so `tools` is pinned too.
    const titled = { ...row, tools: [{ name: 'create_issue', title: 'Open a ticket' }] };
    expect(ToolLabelsOutputSchema.parse({ connectors: [titled] })).toEqual({ connectors: [titled] });
  });

  describe('cached server tool titles (TASK-753)', () => {
    type TitlesCall = { userId: string; connectorIds: string[] };
    async function harnessWithTitles(
      titles: (input: TitlesCall) => Promise<unknown>,
    ): Promise<{ h: TestHarness; calls: TitlesCall[] }> {
      const calls: TitlesCall[] = [];
      const h = await createTestHarness({
        services: {
          'connectors:inventory-tool-titles': async (_ctx, input) => {
            calls.push(input as TitlesCall);
            return titles(input as TitlesCall);
          },
        },
        plugins: [createDatabasePostgresPlugin({ connectionString }), createConnectorsPlugin()],
      });
      harnesses.push(h);
      return { h, calls };
    }

    it('attaches each cached title under the namespace its toolKey names', async () => {
      let ns = '';
      const { h, calls } = await harnessWithTitles(async () => ({
        titles: [
          { connectorId: 'linear', toolKey: `mcp.${ns}.create_issue`, title: 'Open a ticket' },
          // A toolKey under another namespace is never attached here…
          { connectorId: 'linear', toolKey: 'mcp.c0000000000.create_issue', title: 'Wrong namespace' },
          // …nor a title cached for another connector, even under this namespace.
          { connectorId: 'other', toolKey: `mcp.${ns}.list_issues`, title: 'Wrong connector' },
          { connectorId: 'linear', toolKey: `mcp.${ns}.`, title: 'No tool part' },
          { connectorId: 'linear', toolKey: 7, title: 'malformed' },
        ],
      }));
      await h.bus.call<UpsertInput, UpsertOutput>('connectors:upsert', h.ctx({ userId: 'userA' }), upsertInput({ connectorId: 'linear', name: 'Linear' }));
      ns = deriveToolNamespace('userA', 'linear', 'gdrive');
      const out = await labels(h, 'userA');
      expect(out.connectors).toEqual([
        {
          toolNamespace: ns,
          connectorId: 'linear',
          name: 'Linear',
          tools: [{ name: 'create_issue', title: 'Open a ticket' }],
        },
      ]);
      // Asked as the caller, for exactly the connectors the caller can name.
      expect(calls).toEqual([{ userId: 'userA', connectorIds: ['linear'] }]);
    });

    it('a failing or malformed titles read costs the titles, never the labels', async () => {
      const { h } = await harnessWithTitles(async () => {
        throw new Error('db down');
      });
      await h.bus.call<UpsertInput, UpsertOutput>('connectors:upsert', h.ctx({ userId: 'userA' }), upsertInput({ connectorId: 'linear', name: 'Linear' }));
      expect((await labels(h, 'userA')).connectors).toEqual([
        { toolNamespace: deriveToolNamespace('userA', 'linear', 'gdrive'), connectorId: 'linear', name: 'Linear' },
      ]);
      const bad = await harnessWithTitles(async () => ({ titles: 'nope' }));
      await bad.h.bus.call<UpsertInput, UpsertOutput>('connectors:upsert', bad.h.ctx({ userId: 'userA' }), upsertInput({ connectorId: 'linear', name: 'Linear' }));
      expect((await labels(bad.h, 'userA')).connectors[0]).not.toHaveProperty('tools');
    });

    it('does not ask for titles when the caller can name no connector', async () => {
      const { h, calls } = await harnessWithTitles(async () => ({ titles: [] }));
      expect((await labels(h, 'userB')).connectors).toEqual([]);
      expect(calls).toEqual([]);
    });
  });
});
