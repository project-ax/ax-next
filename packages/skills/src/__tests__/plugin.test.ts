import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { PluginError } from '@ax/core';
import { createSkillsPlugin, type SkillsPluginConfig } from '../plugin.js';
import type {
  SkillsDeleteInput,
  SkillsDeleteOutput,
  SkillsGetInput,
  SkillsGetOutput,
  SkillsListDefaultsInput,
  SkillsListDefaultsOutput,
  SkillsListInput,
  SkillsListOutput,
  SkillsResolveInput,
  SkillsResolveOutput,
  SkillsUpsertInput,
  SkillsUpsertOutput,
  SkillsAttachForUserInput,
  SkillsAttachForUserOutput,
  SkillsListUserAttachmentsInput,
  SkillsListUserAttachmentsOutput,
  SkillsDetachForUserInput,
  SkillsDetachForUserOutput,
  SkillsSearchCatalogInput,
  SkillsSearchCatalogOutput,
  CatalogSubmitInput,
  CatalogSubmitOutput,
  CatalogListRequestsInput,
  CatalogListRequestsOutput,
  CatalogAdmitInput,
  CatalogAdmitOutput,
  SkillsQuarantineSetInput,
  SkillsQuarantineSetOutput,
  SkillsQuarantineClearInput,
  SkillsQuarantineClearOutput,
  SkillsQuarantineGetInput,
  SkillsQuarantineGetOutput,
  SkillsQuarantineListInput,
  SkillsQuarantineListOutput,
} from '../types.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

// Sample manifest matching the one in manifest.test.ts.
const SAMPLE_MANIFEST = `name: github
description: Access the GitHub REST API with a personal access token.
version: 1
capabilities:
  allowedHosts:
    - api.github.com
  credentials:
    - slot: GITHUB_TOKEN
      kind: api-key
      description: GitHub PAT.
`;

const SAMPLE_BODY = '# GitHub\n\nGitHub skill body.\n';

// Stub for http:register-route — @ax/skills now declares this as a `calls`
// dep (for the admin HTTP routes). In tests we don't boot http-server, so we
// provide a no-op that returns the unregister callback shape the plugin expects.
const httpRegisterRouteStub = async () => ({ unregister: () => {} });

// Stub for auth:require-user — similarly declared as a `calls` dep.
const authRequireUserStub = async () => ({ user: { id: 'admin', isAdmin: true } });

async function makeHarness(opts: {
  services?: Record<string, (ctx: unknown, input: unknown) => Promise<unknown>>;
  skillsConfig?: SkillsPluginConfig;
} = {}): Promise<TestHarness> {
  const h = await createTestHarness({
    services: {
      'http:register-route': httpRegisterRouteStub,
      'auth:require-user': authRequireUserStub,
      ...opts.services,
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createSkillsPlugin(opts.skillsConfig),
    ],
  });
  harnesses.push(h);
  return h;
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
    // Truncate every table so rows don't bleed between tests.
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_catalog_requests');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_user_attachments');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_skill_files');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_user_skills');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_skills');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_quarantine');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_approved_caps');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await container.stop();
});

describe('@ax/skills plugin manifest + lifecycle', () => {
  it('manifest matches the documented surface', () => {
    const plugin = createSkillsPlugin();
    expect(plugin.manifest).toEqual({
      name: '@ax/skills',
      version: '0.0.0',
      registers: [
        'skills:list',
        'skills:get',
        'skills:upsert',
        'skills:delete',
        'skills:resolve',
        'skills:list-defaults',
        'skills:check-for-updates',
        'skills:attach-for-user',
        'skills:list-user-attachments',
        'skills:detach-for-user',
        'skills:search-catalog',
        'catalog:submit',
        'catalog:list-requests',
        'catalog:admit',
        'skills:quarantine-set',
        'skills:quarantine-clear',
        'skills:quarantine-get',
        'skills:quarantine-list',
        'skills:approved-caps-list',
        'skills:approved-caps-set',
        'skills:approved-caps-revoke',
      ],
      calls: ['database:get-instance', 'http:register-route', 'auth:require-user'],
      subscribes: [],
    });
  });
});

describe('@ax/skills service hooks (round-trip)', () => {
  it('skills:upsert of well-formed manifest returns { skillId, created: true }', async () => {
    const h = await makeHarness();
    const result = await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>(
      'skills:upsert',
      h.ctx(),
      { manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY },
    );
    expect(result.skillId).toBe('github');
    expect(result.created).toBe(true);
  });

  it('second skills:upsert with same name returns { created: false } and updates body', async () => {
    const h = await makeHarness();
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>(
      'skills:upsert',
      h.ctx(),
      { manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY },
    );

    const updatedBody = '# Updated GitHub\n';
    const result = await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>(
      'skills:upsert',
      h.ctx(),
      { manifestYaml: SAMPLE_MANIFEST, bodyMd: updatedBody },
    );
    expect(result.created).toBe(false);

    const detail = await h.bus.call<SkillsGetInput, SkillsGetOutput>(
      'skills:get',
      h.ctx(),
      { skillId: 'github' },
    );
    expect(detail.bodyMd).toBe(updatedBody);
  });

  it('skills:upsert + skills:resolve round-trip a bundle via a durable repoRoot', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'ax-skills-plugin-bundle-'));
    const h = await makeHarness({ skillsConfig: { bundleStore: { repoRoot } } });
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: SAMPLE_MANIFEST,
      bodyMd: SAMPLE_BODY,
      files: [{ path: 'scripts/run.py', contents: 'print(1)' }],
    });
    const out = await h.bus.call<SkillsResolveInput, SkillsResolveOutput>(
      'skills:resolve',
      h.ctx(),
      { skillIds: ['github'] },
    );
    expect(out.skills[0]?.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]);
  });

  it('a fresh plugin on the SAME durable repoRoot reads a previously-written tree', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'ax-skills-plugin-durable-'));
    // First plugin instance writes the bundle.
    const h1 = await makeHarness({ skillsConfig: { bundleStore: { repoRoot } } });
    await h1.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h1.ctx(), {
      manifestYaml: SAMPLE_MANIFEST,
      bodyMd: SAMPLE_BODY,
      files: [{ path: 'data/x.json', contents: '{"k":1}' }],
    });
    await h1.close({ onError: () => {} });
    // Drop it from the cleanup stack so afterEach doesn't double-close.
    const idx = harnesses.indexOf(h1);
    if (idx >= 0) harnesses.splice(idx, 1);

    // A SECOND plugin instance pointed at the SAME repoRoot (the row's
    // bundle_tree_sha survives in the shared DB) reconstructs the bytes from
    // the durable bundle repo — proves the bytes aren't held in process memory.
    const h2 = await makeHarness({ skillsConfig: { bundleStore: { repoRoot } } });
    const got = await h2.bus.call<SkillsGetInput, SkillsGetOutput>('skills:get', h2.ctx(), {
      skillId: 'github',
    });
    expect(got.files).toEqual([{ path: 'data/x.json', contents: '{"k":1}' }]);
  });

  it('skills:upsert of malformed manifest throws PluginError with manifest code', async () => {
    const h = await makeHarness();
    let caught: unknown;
    try {
      await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>(
        'skills:upsert',
        h.ctx(),
        // name starts with uppercase — invalid-name
        { manifestYaml: 'name: GitHub\ndescription: Bad name.\n', bodyMd: '' },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('invalid-name');
  });

  it('skills:list returns the upserted skill with parsed capabilities', async () => {
    const h = await makeHarness();
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>(
      'skills:upsert',
      h.ctx(),
      { manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY },
    );

    const { skills } = await h.bus.call<SkillsListInput, SkillsListOutput>(
      'skills:list',
      h.ctx(),
      {},
    );
    expect(skills).toHaveLength(1);
    const skill = skills[0]!;
    expect(skill.id).toBe('github');
    expect(skill.capabilities.allowedHosts).toEqual(['api.github.com']);
    expect(skill.capabilities.credentials[0]?.slot).toBe('GITHUB_TOKEN');
  });

  it('skills:get returns full detail (bodyMd + manifestYaml)', async () => {
    const h = await makeHarness();
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>(
      'skills:upsert',
      h.ctx(),
      { manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY },
    );

    const detail = await h.bus.call<SkillsGetInput, SkillsGetOutput>(
      'skills:get',
      h.ctx(),
      { skillId: 'github' },
    );
    expect(detail.id).toBe('github');
    expect(detail.bodyMd).toBe(SAMPLE_BODY);
    expect(detail.manifestYaml).toBe(SAMPLE_MANIFEST);
    expect(detail.capabilities.allowedHosts).toEqual(['api.github.com']);
  });

  it('skills:get of nonexistent id throws PluginError with code skill-not-found', async () => {
    const h = await makeHarness();
    let caught: unknown;
    try {
      await h.bus.call<SkillsGetInput, SkillsGetOutput>('skills:get', h.ctx(), {
        skillId: 'nonexistent',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('skill-not-found');
  });

  it('skills:resolve with [missing, github] returns only github', async () => {
    const h = await makeHarness();
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>(
      'skills:upsert',
      h.ctx(),
      { manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY },
    );

    const { skills } = await h.bus.call<SkillsResolveInput, SkillsResolveOutput>(
      'skills:resolve',
      h.ctx(),
      { skillIds: ['missing', 'github'] },
    );
    expect(skills).toHaveLength(1);
    expect(skills[0]?.id).toBe('github');
    expect(skills[0]?.capabilities.allowedHosts).toEqual(['api.github.com']);
  });

  it('skills:delete removes the skill; subsequent :get throws skill-not-found', async () => {
    const h = await makeHarness();
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>(
      'skills:upsert',
      h.ctx(),
      { manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY },
    );

    await h.bus.call<SkillsDeleteInput, SkillsDeleteOutput>(
      'skills:delete',
      h.ctx(),
      { skillId: 'github' },
    );

    let caught: unknown;
    try {
      await h.bus.call<SkillsGetInput, SkillsGetOutput>('skills:get', h.ctx(), {
        skillId: 'github',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('skill-not-found');
  });

  it('skills:list-defaults returns default-attached skills only', async () => {
    const h = await makeHarness();
    // Two skills, only one default-attached.
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>(
      'skills:upsert',
      h.ctx(),
      {
        manifestYaml: 'name: heartbeat\ndescription: Daily check-in.\nversion: 1\n',
        bodyMd: '# heartbeat\n',
        defaultAttached: true,
      },
    );
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>(
      'skills:upsert',
      h.ctx(),
      { manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY },
    );

    const out = await h.bus.call<
      SkillsListDefaultsInput,
      SkillsListDefaultsOutput
    >('skills:list-defaults', h.ctx(), {});

    expect(out.skills.map((s) => s.id)).toEqual(['heartbeat']);
    expect(out.skills[0]?.bodyMd).toBe('# heartbeat\n');
  });

  it('skills:upsert rejects defaultAttached=true when the manifest declares credential slots', async () => {
    const h = await makeHarness();
    let caught: unknown;
    try {
      await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>(
        'skills:upsert',
        h.ctx(),
        {
          // SAMPLE_MANIFEST has a GITHUB_TOKEN slot — not allowed as default.
          manifestYaml: SAMPLE_MANIFEST,
          bodyMd: SAMPLE_BODY,
          defaultAttached: true,
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('default-attached-requires-no-credentials');
  });

  it('skills:delete is blocked when agents:any-attached-to-skill returns { attached: true }', async () => {
    // Bootstrap a harness with a stub agents:any-attached-to-skill that
    // reports the skill is in use. The stub is registered BEFORE the
    // skills plugin boots so bus.hasService returns true during init and
    // the delete path checks it.
    const h = await createTestHarness({
      services: {
        'http:register-route': httpRegisterRouteStub,
        'auth:require-user': authRequireUserStub,
        'agents:any-attached-to-skill': async () => ({ attached: true }),
      },
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        createSkillsPlugin(),
      ],
    });
    harnesses.push(h);

    // Install the skill first.
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>(
      'skills:upsert',
      h.ctx(),
      { manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY },
    );

    let caught: unknown;
    try {
      await h.bus.call<SkillsDeleteInput, SkillsDeleteOutput>(
        'skills:delete',
        h.ctx(),
        { skillId: 'github' },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('skill-in-use');
  });
});

// ---------------------------------------------------------------------------
// Helpers for credential-purge tests
// ---------------------------------------------------------------------------

/** Build a minimal valid manifest YAML for the given skill name and slots. */
function yamlForSkill(
  name: string,
  slots: Array<{ slot: string; kind: 'api-key' }>,
): string {
  const credLines =
    slots.length === 0
      ? ''
      : [
          '  credentials:',
          ...slots.map((s) => `    - slot: ${s.slot}\n      kind: ${s.kind}`),
        ].join('\n') + '\n';
  return [
    `name: ${name}`,
    `description: test skill for ${name}`,
    'version: 1',
    'capabilities:',
    '  allowedHosts: []',
    credLines.trimEnd(),
  ]
    .filter(Boolean)
    .join('\n') + '\n';
}

interface CredentialRow {
  scope: 'global' | 'user' | 'agent';
  ownerId: string | null;
  ref: string;
}

describe('@ax/skills credential purge on delete / slot removal', () => {
  it('skills:delete fires credentials:delete for every (scope, ownerId) row at skill:<id>:*', async () => {
    // Track which credentials:delete calls were made.
    const deletedRefs: Array<{ scope: string; ownerId: string | null; ref: string }> = [];
    // In-memory credential store keyed by "scope:ownerId:ref".
    const credStore: CredentialRow[] = [];

    const credListStub = async (_ctx: unknown, input: unknown) => {
      const inp = input as { scope?: string; ownerId?: string | null };
      if (inp.ownerId !== undefined && inp.scope === undefined) {
        throw new PluginError({ code: 'invalid-payload', plugin: 'stub', message: 'ownerId requires scope' });
      }
      let rows = [...credStore];
      if (inp.scope !== undefined) rows = rows.filter((r) => r.scope === inp.scope);
      if (inp.ownerId !== undefined) rows = rows.filter((r) => r.ownerId === inp.ownerId);
      return { credentials: rows };
    };

    const credDeleteStub = vi.fn(async (_ctx: unknown, input: unknown) => {
      const inp = input as CredentialRow;
      deletedRefs.push({ scope: inp.scope, ownerId: inp.ownerId, ref: inp.ref });
      const idx = credStore.findIndex(
        (r) => r.scope === inp.scope && r.ownerId === inp.ownerId && r.ref === inp.ref,
      );
      if (idx !== -1) credStore.splice(idx, 1);
    });

    const h = await makeHarness({
      services: {
        'credentials:list': credListStub,
        'credentials:delete': credDeleteStub,
      },
    });

    // 1. Seed the skill with one credential slot.
    const manifest = yamlForSkill('linear-tracker', [{ slot: 'LINEAR_TOKEN', kind: 'api-key' }]);
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>(
      'skills:upsert',
      h.ctx(),
      { manifestYaml: manifest, bodyMd: '# linear-tracker\n' },
    );

    // 2. Seed credentials at global scope and user scope for the slot ref.
    credStore.push({ scope: 'global', ownerId: null, ref: 'skill:linear-tracker:LINEAR_TOKEN' });
    credStore.push({ scope: 'user', ownerId: 'alice', ref: 'skill:linear-tracker:LINEAR_TOKEN' });

    // 3. Delete the skill.
    await h.bus.call<SkillsDeleteInput, SkillsDeleteOutput>(
      'skills:delete',
      h.ctx(),
      { skillId: 'linear-tracker' },
    );

    // 4. Both credential rows should have been deleted.
    expect(credDeleteStub).toHaveBeenCalledTimes(2);
    expect(deletedRefs.map((d) => `${d.scope}:${d.ownerId}:${d.ref}`).sort()).toEqual([
      'global:null:skill:linear-tracker:LINEAR_TOKEN',
      'user:alice:skill:linear-tracker:LINEAR_TOKEN',
    ]);
    // Credential store should now be empty.
    expect(credStore).toHaveLength(0);
  });

  it('skills:upsert fires credentials:delete for slots dropped in a manifest edit', async () => {
    const credStore: CredentialRow[] = [];

    const credListStub = async (_ctx: unknown, _input: unknown) => ({
      credentials: [...credStore],
    });

    const credDeleteStub = vi.fn(async (_ctx: unknown, input: unknown) => {
      const inp = input as CredentialRow;
      const idx = credStore.findIndex(
        (r) => r.scope === inp.scope && r.ownerId === inp.ownerId && r.ref === inp.ref,
      );
      if (idx !== -1) credStore.splice(idx, 1);
    });

    const h = await makeHarness({
      services: {
        'credentials:list': credListStub,
        'credentials:delete': credDeleteStub,
      },
    });

    // 1. Upsert skill with two slots.
    const manifest1 = yamlForSkill('gh-tool', [
      { slot: 'OLD_SLOT', kind: 'api-key' },
      { slot: 'KEEPER', kind: 'api-key' },
    ]);
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>(
      'skills:upsert',
      h.ctx(),
      { manifestYaml: manifest1, bodyMd: '# gh-tool\n' },
    );

    // 2. Seed credentials for both slots.
    credStore.push({ scope: 'global', ownerId: null, ref: 'skill:gh-tool:OLD_SLOT' });
    credStore.push({ scope: 'user', ownerId: 'bob', ref: 'skill:gh-tool:KEEPER' });

    // 3. Upsert again with only KEEPER (OLD_SLOT dropped).
    const manifest2 = yamlForSkill('gh-tool', [{ slot: 'KEEPER', kind: 'api-key' }]);
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>(
      'skills:upsert',
      h.ctx(),
      { manifestYaml: manifest2, bodyMd: '# gh-tool updated\n' },
    );

    // 4. Only KEEPER's credential should survive; OLD_SLOT's should be gone.
    expect(credDeleteStub).toHaveBeenCalledTimes(1);
    expect(credStore).toHaveLength(1);
    expect(credStore[0]?.ref).toBe('skill:gh-tool:KEEPER');
  });

  it('skills:delete continues purging remaining rows when one delete fails (per-row try/catch)', async () => {
    // Seed 3 credential rows for 3 slots.  The middle delete throws; the
    // first and last must still be deleted.
    const credStore: CredentialRow[] = [
      { scope: 'global', ownerId: null, ref: 'skill:multi-slot:SLOT_A' },
      { scope: 'global', ownerId: null, ref: 'skill:multi-slot:SLOT_B' },
      { scope: 'global', ownerId: null, ref: 'skill:multi-slot:SLOT_C' },
    ];

    let callCount = 0;
    const credDeleteStub = vi.fn(async (_ctx: unknown, input: unknown) => {
      callCount++;
      const inp = input as CredentialRow;
      if (inp.ref === 'skill:multi-slot:SLOT_B') {
        throw new Error('middle delete exploded');
      }
      const idx = credStore.findIndex(
        (r) => r.scope === inp.scope && r.ownerId === inp.ownerId && r.ref === inp.ref,
      );
      if (idx !== -1) credStore.splice(idx, 1);
    });

    const h = await makeHarness({
      services: {
        'credentials:list': async () => ({ credentials: [...credStore] }),
        'credentials:delete': credDeleteStub,
      },
    });

    const manifest = yamlForSkill('multi-slot', [
      { slot: 'SLOT_A', kind: 'api-key' },
      { slot: 'SLOT_B', kind: 'api-key' },
      { slot: 'SLOT_C', kind: 'api-key' },
    ]);
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>(
      'skills:upsert',
      h.ctx(),
      { manifestYaml: manifest, bodyMd: '# multi-slot\n' },
    );

    // Delete must succeed even though SLOT_B's delete threw.
    await expect(
      h.bus.call<SkillsDeleteInput, SkillsDeleteOutput>(
        'skills:delete',
        h.ctx(),
        { skillId: 'multi-slot' },
      ),
    ).resolves.toEqual({});

    // All 3 deletes were attempted.
    expect(callCount).toBe(3);
    // SLOT_A and SLOT_C were removed; SLOT_B (which threw) remains.
    expect(credStore.map((r) => r.ref)).toEqual(['skill:multi-slot:SLOT_B']);
  });

  it('skills:delete credential purge failure does not abort the skill deletion', async () => {
    const credListStub = async () => ({
      credentials: [{ scope: 'global' as const, ownerId: null, ref: 'skill:bad-skill:TOKEN' }],
    });
    const credDeleteStub = async () => {
      throw new Error('storage exploded');
    };

    const h = await makeHarness({
      services: {
        'credentials:list': credListStub,
        'credentials:delete': credDeleteStub,
      },
    });

    const manifest = yamlForSkill('bad-skill', [{ slot: 'TOKEN', kind: 'api-key' }]);
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>(
      'skills:upsert',
      h.ctx(),
      { manifestYaml: manifest, bodyMd: '# bad-skill\n' },
    );

    // Delete should succeed even though the credential purge throws.
    await expect(
      h.bus.call<SkillsDeleteInput, SkillsDeleteOutput>(
        'skills:delete',
        h.ctx(),
        { skillId: 'bad-skill' },
      ),
    ).resolves.toEqual({});

    // Skill should be gone.
    let caught: unknown;
    try {
      await h.bus.call<SkillsGetInput, SkillsGetOutput>('skills:get', h.ctx(), {
        skillId: 'bad-skill',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('skill-not-found');
  });
});

// ---------------------------------------------------------------------------
// User-scope tests (Phase D — scope-aware hooks)
// ---------------------------------------------------------------------------

// A minimal manifest without credential slots (safe for defaultAttached).
const DEFAULT_MANIFEST = `name: github
description: Access the GitHub REST API.
version: 1
capabilities:
  allowedHosts:
    - api.github.com
`;

const DEFAULT_MANIFEST_BODY = '# GitHub skill (no creds)\n';

// A second distinct skill for default-merge tests.
const LINEAR_MANIFEST = `name: linear
description: Linear issue tracker.
version: 1
capabilities:
  allowedHosts:
    - linear.app
`;
const LINEAR_BODY = '# Linear\n';

describe('@ax/skills user-scope hooks (Phase D)', () => {
  // -------------------------------------------------------------------------
  // skills:list scope behaviour
  // -------------------------------------------------------------------------

  it('skills:list scope=all unions global+user, user wins on id collision', async () => {
    const h = await makeHarness();

    // Upsert 'github' globally.
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: SAMPLE_MANIFEST,
      bodyMd: 'global body',
    });

    // Upsert 'github' for user alice (no credential slots so no upsert rejection).
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: DEFAULT_MANIFEST,
      bodyMd: 'user body',
      scope: 'user',
      ownerUserId: 'alice',
    });

    const { skills } = await h.bus.call<SkillsListInput, SkillsListOutput>(
      'skills:list',
      h.ctx(),
      { scope: 'all', ownerUserId: 'alice' },
    );

    // Only one 'github' row — the user row wins.
    expect(skills.filter((s) => s.id === 'github')).toHaveLength(1);
    const github = skills.find((s) => s.id === 'github')!;
    expect(github.scope).toBe('user');
    expect(github.ownerUserId).toBe('alice');
  });

  it('skills:list scope=global ignores user rows even when ownerUserId is provided', async () => {
    const h = await makeHarness();

    // Upsert 'github' globally.
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: SAMPLE_MANIFEST,
      bodyMd: SAMPLE_BODY,
    });

    // Upsert 'github' for user alice.
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: DEFAULT_MANIFEST,
      bodyMd: 'user body',
      scope: 'user',
      ownerUserId: 'alice',
    });

    const { skills } = await h.bus.call<SkillsListInput, SkillsListOutput>(
      'skills:list',
      h.ctx(),
      { scope: 'global', ownerUserId: 'alice' },
    );

    // Should only see the global row.
    expect(skills).toHaveLength(1);
    expect(skills[0]!.scope).toBe('global');
  });

  it('skills:list scope=user without ownerUserId throws missing-owner', async () => {
    const h = await makeHarness();
    let caught: unknown;
    try {
      await h.bus.call<SkillsListInput, SkillsListOutput>('skills:list', h.ctx(), {
        scope: 'user',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('missing-owner');
  });

  // -------------------------------------------------------------------------
  // User isolation: alice can't see bob's rows
  // -------------------------------------------------------------------------

  it('skills:list user-scope isolation: alice skills invisible to bob', async () => {
    const h = await makeHarness();

    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: DEFAULT_MANIFEST,
      bodyMd: 'alice body',
      scope: 'user',
      ownerUserId: 'alice',
    });

    const { skills } = await h.bus.call<SkillsListInput, SkillsListOutput>(
      'skills:list',
      h.ctx(),
      { scope: 'user', ownerUserId: 'bob' },
    );

    expect(skills).toHaveLength(0);
  });

  it('skills:get user-scope isolation: alice skill not found for bob', async () => {
    const h = await makeHarness();

    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: DEFAULT_MANIFEST,
      bodyMd: 'alice body',
      scope: 'user',
      ownerUserId: 'alice',
    });

    let caught: unknown;
    try {
      await h.bus.call<SkillsGetInput, SkillsGetOutput>('skills:get', h.ctx(), {
        skillId: 'github',
        scope: 'user',
        ownerUserId: 'bob',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('skill-not-found');
  });

  // -------------------------------------------------------------------------
  // skills:get scope behaviour
  // -------------------------------------------------------------------------

  it('skills:get scope=user returns the user row', async () => {
    const h = await makeHarness();

    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: DEFAULT_MANIFEST,
      bodyMd: 'user-only body',
      scope: 'user',
      ownerUserId: 'alice',
    });

    const detail = await h.bus.call<SkillsGetInput, SkillsGetOutput>('skills:get', h.ctx(), {
      skillId: 'github',
      scope: 'user',
      ownerUserId: 'alice',
    });
    expect(detail.scope).toBe('user');
    expect(detail.ownerUserId).toBe('alice');
    expect(detail.bodyMd).toBe('user-only body');
  });

  it('skills:get user-wins when scope unset + ownerUserId given', async () => {
    const h = await makeHarness();

    // Global 'github'.
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: DEFAULT_MANIFEST,
      bodyMd: 'global body',
    });

    // User 'github' for alice.
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: DEFAULT_MANIFEST,
      bodyMd: 'alice body',
      scope: 'user',
      ownerUserId: 'alice',
    });

    // No scope specified, ownerUserId provided → user wins.
    const detail = await h.bus.call<SkillsGetInput, SkillsGetOutput>('skills:get', h.ctx(), {
      skillId: 'github',
      ownerUserId: 'alice',
    });
    expect(detail.scope).toBe('user');
    expect(detail.bodyMd).toBe('alice body');
  });

  // -------------------------------------------------------------------------
  // skills:upsert scope behaviour
  // -------------------------------------------------------------------------

  it('skills:upsert scope=user lands in skills_v1_user_skills; global unaffected', async () => {
    const h = await makeHarness();

    // Global upsert.
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: DEFAULT_MANIFEST,
      bodyMd: 'global body',
    });

    // User upsert for alice — same skill id.
    const result = await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>(
      'skills:upsert',
      h.ctx(),
      {
        manifestYaml: DEFAULT_MANIFEST,
        bodyMd: 'alice body',
        scope: 'user',
        ownerUserId: 'alice',
      },
    );
    expect(result.created).toBe(true);

    // User row has alice's body.
    const userDetail = await h.bus.call<SkillsGetInput, SkillsGetOutput>('skills:get', h.ctx(), {
      skillId: 'github',
      scope: 'user',
      ownerUserId: 'alice',
    });
    expect(userDetail.bodyMd).toBe('alice body');

    // Global row still has global body.
    const globalDetail = await h.bus.call<SkillsGetInput, SkillsGetOutput>('skills:get', h.ctx(), {
      skillId: 'github',
      scope: 'global',
    });
    expect(globalDetail.bodyMd).toBe('global body');
  });

  // -------------------------------------------------------------------------
  // skills:resolve user-wins
  // -------------------------------------------------------------------------

  it('skills:resolve with ownerUserId prefers user row over same-id global', async () => {
    const h = await makeHarness();

    // Global 'github'.
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: DEFAULT_MANIFEST,
      bodyMd: 'global resolved body',
    });

    // User 'github' for alice.
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: DEFAULT_MANIFEST,
      bodyMd: 'alice resolved body',
      scope: 'user',
      ownerUserId: 'alice',
    });

    const { skills } = await h.bus.call<SkillsResolveInput, SkillsResolveOutput>(
      'skills:resolve',
      h.ctx(),
      { skillIds: ['github'], ownerUserId: 'alice' },
    );
    expect(skills).toHaveLength(1);
    expect(skills[0]!.bodyMd).toBe('alice resolved body');
  });

  // -------------------------------------------------------------------------
  // skills:list-defaults user-wins
  // -------------------------------------------------------------------------

  it('skills:list-defaults unions user default skills with globals (user wins on collision)', async () => {
    const h = await makeHarness();

    // Global default: linear.
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: LINEAR_MANIFEST,
      bodyMd: LINEAR_BODY,
      defaultAttached: true,
    });

    // Global non-default: github.
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: DEFAULT_MANIFEST,
      bodyMd: DEFAULT_MANIFEST_BODY,
      defaultAttached: false,
    });

    // User default: github (same id as global non-default — plus default).
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: DEFAULT_MANIFEST,
      bodyMd: 'user github default body',
      defaultAttached: true,
      scope: 'user',
      ownerUserId: 'alice',
    });

    const { skills } = await h.bus.call<SkillsListDefaultsInput, SkillsListDefaultsOutput>(
      'skills:list-defaults',
      h.ctx(),
      { ownerUserId: 'alice' },
    );

    // Should include: global 'linear' + user 'github'.
    const ids = skills.map((s) => s.id).sort();
    expect(ids).toEqual(['github', 'linear']);

    // github comes from user store.
    const githubSkill = skills.find((s) => s.id === 'github')!;
    expect(githubSkill.bodyMd).toBe('user github default body');
  });

  // -------------------------------------------------------------------------
  // I-2 (scope-blind in-use guard regression): a user-scope delete must NOT
  // be refused by agents:any-attached-to-skill, because attachments match
  // purely on skillId (no scope) — a same-id GLOBAL skill being in-use would
  // otherwise produce a cross-scope false-positive denial. A GLOBAL-scope
  // delete of an in-use skill must STILL throw skill-in-use.
  // -------------------------------------------------------------------------

  it('user-scope delete succeeds even when a same-id global skill is reported in-use', async () => {
    // Bootstrap a harness whose agents:any-attached-to-skill stub always
    // reports the skill as in-use (registered BEFORE skills boots so
    // bus.hasService is true during init).
    const h = await createTestHarness({
      services: {
        'http:register-route': httpRegisterRouteStub,
        'auth:require-user': authRequireUserStub,
        'agents:any-attached-to-skill': async () => ({ attached: true }),
      },
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        createSkillsPlugin(),
      ],
    });
    harnesses.push(h);

    // Install a user-scope skill for alice.
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: DEFAULT_MANIFEST,
      bodyMd: 'alice body',
      scope: 'user',
      ownerUserId: 'alice',
    });

    // User-scope delete must SUCCEED despite the in-use stub (cross-scope
    // false-positive avoided — guard is global-only now).
    await expect(
      h.bus.call<SkillsDeleteInput, SkillsDeleteOutput>('skills:delete', h.ctx(), {
        skillId: 'github',
        scope: 'user',
        ownerUserId: 'alice',
      }),
    ).resolves.toEqual({});

    // The user row is gone.
    let caught: unknown;
    try {
      await h.bus.call<SkillsGetInput, SkillsGetOutput>('skills:get', h.ctx(), {
        skillId: 'github',
        scope: 'user',
        ownerUserId: 'alice',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('skill-not-found');
  });

  it('global-scope delete still throws skill-in-use when reported in-use', async () => {
    const h = await createTestHarness({
      services: {
        'http:register-route': httpRegisterRouteStub,
        'auth:require-user': authRequireUserStub,
        'agents:any-attached-to-skill': async () => ({ attached: true }),
      },
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        createSkillsPlugin(),
      ],
    });
    harnesses.push(h);

    // Install a GLOBAL skill.
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: DEFAULT_MANIFEST,
      bodyMd: 'global body',
    });

    let caught: unknown;
    try {
      await h.bus.call<SkillsDeleteInput, SkillsDeleteOutput>('skills:delete', h.ctx(), {
        skillId: 'github',
        scope: 'global',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('skill-in-use');
  });
});

describe('@ax/skills per-user attachments', () => {
  const HOSTED_SKILL = `name: github
description: GitHub.
version: 1
capabilities:
  allowedHosts:
    - api.github.com
  credentials:
    - slot: GITHUB_TOKEN
      kind: api-key
`;

  it('attach-for-user stores a binding; list-user-attachments returns it scoped', async () => {
    const h = await makeHarness();
    // The skill must exist (global) for the attach hook to resolve its slots.
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: HOSTED_SKILL,
      bodyMd: '# gh\n',
    });

    const r = await h.bus.call<SkillsAttachForUserInput, SkillsAttachForUserOutput>(
      'skills:attach-for-user',
      h.ctx(),
      { userId: 'u1', agentId: 'a1', skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'ref1' } },
    );
    expect(r).toEqual({ created: true });

    const list = await h.bus.call<SkillsListUserAttachmentsInput, SkillsListUserAttachmentsOutput>(
      'skills:list-user-attachments',
      h.ctx(),
      { userId: 'u1', agentId: 'a1' },
    );
    expect(list.attachments).toEqual([
      { skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'ref1' } },
    ]);

    // A different user sees nothing.
    const other = await h.bus.call<SkillsListUserAttachmentsInput, SkillsListUserAttachmentsOutput>(
      'skills:list-user-attachments',
      h.ctx(),
      { userId: 'u2', agentId: 'a1' },
    );
    expect(other.attachments).toEqual([]);
  });

  it('attach-for-user is idempotent — re-attach replaces bindings (created:false)', async () => {
    const h = await makeHarness();
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: HOSTED_SKILL,
      bodyMd: '# gh\n',
    });

    const first = await h.bus.call<SkillsAttachForUserInput, SkillsAttachForUserOutput>(
      'skills:attach-for-user',
      h.ctx(),
      { userId: 'u1', agentId: 'a1', skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'ref1' } },
    );
    expect(first.created).toBe(true);

    const again = await h.bus.call<SkillsAttachForUserInput, SkillsAttachForUserOutput>(
      'skills:attach-for-user',
      h.ctx(),
      { userId: 'u1', agentId: 'a1', skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'ref2' } },
    );
    expect(again.created).toBe(false);

    const list = await h.bus.call<SkillsListUserAttachmentsInput, SkillsListUserAttachmentsOutput>(
      'skills:list-user-attachments',
      h.ctx(),
      { userId: 'u1', agentId: 'a1' },
    );
    expect(list.attachments).toEqual([
      { skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'ref2' } },
    ]);
  });

  it('attach-for-user rejects an unknown skill', async () => {
    const h = await makeHarness();
    await expect(
      h.bus.call<SkillsAttachForUserInput, SkillsAttachForUserOutput>('skills:attach-for-user', h.ctx(), {
        userId: 'u1', agentId: 'a1', skillId: 'nope', credentialBindings: {},
      }),
    ).rejects.toThrow(/not installed|not-found/i);
  });

  it('attach-for-user rejects a binding for an undeclared slot (orphan)', async () => {
    const h = await makeHarness();
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: HOSTED_SKILL,
      bodyMd: '# gh\n',
    });
    await expect(
      h.bus.call<SkillsAttachForUserInput, SkillsAttachForUserOutput>('skills:attach-for-user', h.ctx(), {
        userId: 'u1', agentId: 'a1', skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'ref', BOGUS: 'x' },
      }),
    ).rejects.toThrow(/binding-orphan|does not declare/i);
  });

  it('attach-for-user rejects a missing required slot binding', async () => {
    const h = await makeHarness();
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: HOSTED_SKILL,
      bodyMd: '# gh\n',
    });
    await expect(
      h.bus.call<SkillsAttachForUserInput, SkillsAttachForUserOutput>('skills:attach-for-user', h.ctx(), {
        userId: 'u1', agentId: 'a1', skillId: 'github', credentialBindings: {},
      }),
    ).rejects.toThrow(/binding-missing|missing binding/i);
  });

  it('skills:detach-for-user removes a per-user attachment and is idempotent', async () => {
    const h = await makeHarness();
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: HOSTED_SKILL,
      bodyMd: '# gh\n',
    });
    await h.bus.call<SkillsAttachForUserInput, SkillsAttachForUserOutput>(
      'skills:attach-for-user',
      h.ctx(),
      { userId: 'u1', agentId: 'a1', skillId: 'github', credentialBindings: { GITHUB_TOKEN: 'ref1' } },
    );

    const before = await h.bus.call<SkillsListUserAttachmentsInput, SkillsListUserAttachmentsOutput>(
      'skills:list-user-attachments',
      h.ctx(),
      { userId: 'u1', agentId: 'a1' },
    );
    expect(before.attachments.map((a) => a.skillId)).toEqual(['github']);

    const out = await h.bus.call<SkillsDetachForUserInput, SkillsDetachForUserOutput>(
      'skills:detach-for-user',
      h.ctx(),
      { userId: 'u1', agentId: 'a1', skillId: 'github' },
    );
    expect(out).toEqual({ removed: true });

    const after = await h.bus.call<SkillsListUserAttachmentsInput, SkillsListUserAttachmentsOutput>(
      'skills:list-user-attachments',
      h.ctx(),
      { userId: 'u1', agentId: 'a1' },
    );
    expect(after.attachments).toEqual([]);

    // Idempotent — removing again is not an error.
    expect(
      await h.bus.call<SkillsDetachForUserInput, SkillsDetachForUserOutput>(
        'skills:detach-for-user',
        h.ctx(),
        { userId: 'u1', agentId: 'a1', skillId: 'github' },
      ),
    ).toEqual({ removed: false });
  });
});

describe('@ax/skills bundle extra files (JIT Phase 1a)', () => {
  it('skills:upsert rejects a bundle file that escapes the dir', async () => {
    const h = await makeHarness();
    await expect(
      h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
        manifestYaml: SAMPLE_MANIFEST,
        bodyMd: SAMPLE_BODY,
        files: [{ path: '../evil.txt', contents: 'x' }],
      }),
    ).rejects.toThrow(/invalid path/i);
  });

  it('skills:upsert rejects a reserved bundle path (.mcp.json)', async () => {
    const h = await makeHarness();
    await expect(
      h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
        manifestYaml: SAMPLE_MANIFEST,
        bodyMd: SAMPLE_BODY,
        files: [{ path: '.mcp.json', contents: '{}' }],
      }),
    ).rejects.toThrow(/reserved/i);
  });

  it('skills:resolve returns bundle files for a multi-file skill', async () => {
    const h = await makeHarness();
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: SAMPLE_MANIFEST,
      bodyMd: SAMPLE_BODY,
      files: [{ path: 'scripts/run.py', contents: 'print(1)' }],
    });
    const out = await h.bus.call<SkillsResolveInput, SkillsResolveOutput>(
      'skills:resolve',
      h.ctx(),
      { skillIds: ['github'] },
    );
    expect(out.skills[0]?.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]);
  });

  it('skills:get returns bundle files; a single-file skill reports files: []', async () => {
    const h = await makeHarness();
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: SAMPLE_MANIFEST,
      bodyMd: SAMPLE_BODY,
    });
    const detail = await h.bus.call<SkillsGetInput, SkillsGetOutput>('skills:get', h.ctx(), {
      skillId: 'github',
      scope: 'global',
    });
    expect(detail.files).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// skills:search-catalog (TASK-34) — read-only intent→candidate matcher.
//
// NOTE: the YAML manifest's top-level identifier field is `name:` (parsed into
// SkillSummary.id), NOT `id:` — see packages/skills-parser/src/manifest.ts.
// ---------------------------------------------------------------------------
const CATALOG_LINEAR_MANIFEST = [
  'name: linear',
  'description: Read and update your Linear issues',
  'version: 1',
  'capabilities:',
  '  allowedHosts: [api.linear.app]',
  '  credentials:',
  '    - slot: API_KEY',
  '      kind: api-key',
].join('\n');

const CATALOG_INERT_MANIFEST = [
  'name: notes',
  'description: Help structure meeting notes',
  'version: 1',
].join('\n');

describe('@ax/skills service hooks — skills:search-catalog', () => {
  it('matches intent, derives tier, and returns hosts/slots', async () => {
    const h = await makeHarness();
    // A bounded Linear skill (host + key) and an inert note-taking skill.
    await h.bus.call('skills:upsert', h.ctx(), { manifestYaml: CATALOG_LINEAR_MANIFEST, bodyMd: 'b' });
    await h.bus.call('skills:upsert', h.ctx(), { manifestYaml: CATALOG_INERT_MANIFEST, bodyMd: 'b' });

    const out = await h.bus.call<SkillsSearchCatalogInput, SkillsSearchCatalogOutput>(
      'skills:search-catalog',
      h.ctx(),
      { intent: 'check my linear issues' },
    );

    const linear = out.skills.find((s) => s.id === 'linear');
    expect(linear).toMatchObject({
      id: 'linear',
      tier: 'bounded',
      hosts: ['api.linear.app'],
      slots: ['API_KEY'],
    });
    // The inert note skill does not match "linear".
    expect(out.skills.some((s) => s.id === 'notes')).toBe(false);
  });

  it('returns [] for blank intent and never errors', async () => {
    const h = await makeHarness();
    const out = await h.bus.call<SkillsSearchCatalogInput, SkillsSearchCatalogOutput>(
      'skills:search-catalog',
      h.ctx(),
      { intent: '   ' },
    );
    expect(out.skills).toEqual([]);
  });

  it('treats SQL-injection-shaped intent as a plain no-match string', async () => {
    const h = await makeHarness();
    await h.bus.call('skills:upsert', h.ctx(), { manifestYaml: CATALOG_LINEAR_MANIFEST, bodyMd: 'b' });
    const out = await h.bus.call<SkillsSearchCatalogInput, SkillsSearchCatalogOutput>(
      'skills:search-catalog',
      h.ctx(),
      { intent: "'; DROP TABLE skills_v1_skills; --" },
    );
    // The catalog is intact (the upsert above still resolves) and the
    // injection text simply doesn't tokenize into a match.
    expect(out.skills.some((s) => s.id === 'linear')).toBe(false);
    const still = await h.bus.call<SkillsListInput, SkillsListOutput>('skills:list', h.ctx(), {});
    expect(still.skills.some((s) => s.id === 'linear')).toBe(true);
  });

  it('caps results at the requested limit', async () => {
    const h = await makeHarness();
    await h.bus.call('skills:upsert', h.ctx(), { manifestYaml: CATALOG_LINEAR_MANIFEST, bodyMd: 'b' });
    const out = await h.bus.call<SkillsSearchCatalogInput, SkillsSearchCatalogOutput>(
      'skills:search-catalog',
      h.ctx(),
      { intent: 'linear', limit: 0 },
    );
    // limit clamps to >= 1, so a single match still returns.
    expect(out.skills.length).toBeLessThanOrEqual(1);
  });
});

describe('@ax/skills catalog admit-queue hooks (TASK-41)', () => {
  it("catalog:submit (share) snapshots the author's user-scoped skill", async () => {
    const h = await makeHarness();
    // Author a user-scoped multi-file skill (the post-TASK-39 "draft to share").
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: SAMPLE_MANIFEST,
      bodyMd: SAMPLE_BODY,
      files: [{ path: 'scripts/run.py', contents: 'print(1)' }],
      scope: 'user',
      ownerUserId: 'alice',
    });

    const out = await h.bus.call<CatalogSubmitInput, CatalogSubmitOutput>('catalog:submit', h.ctx(), {
      kind: 'share',
      skillId: 'github',
      requestedByUserId: 'alice',
      description: 'share my github skill',
    });
    expect(out.created).toBe(true);
    expect(out.status).toBe('pending');

    const list = await h.bus.call<CatalogListRequestsInput, CatalogListRequestsOutput>(
      'catalog:list-requests',
      h.ctx(),
      {},
    );
    const req = list.requests.find((r) => r.skillId === 'github')!;
    expect(req.kind).toBe('share');
    expect(req.sourceOwnerUserId).toBe('alice');
    expect(req.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]);
    expect(req.manifestYaml).toContain('name: github');
  });

  it('catalog:submit (share) of a skill the user does not own throws skill-not-found', async () => {
    const h = await makeHarness();
    await expect(
      h.bus.call<CatalogSubmitInput, CatalogSubmitOutput>('catalog:submit', h.ctx(), {
        kind: 'share',
        skillId: 'nope',
        requestedByUserId: 'alice',
        description: 'd',
      }),
    ).rejects.toMatchObject({ code: 'skill-not-found' });
  });

  it('catalog:submit (cold-start) files a bundle-less request; second dedups', async () => {
    const h = await makeHarness();
    const first = await h.bus.call<CatalogSubmitInput, CatalogSubmitOutput>('catalog:submit', h.ctx(), {
      kind: 'cold-start',
      skillId: 'jira',
      requestedByUserId: 'alice',
      description: 'I need Jira',
    });
    expect(first.created).toBe(true);
    const second = await h.bus.call<CatalogSubmitInput, CatalogSubmitOutput>('catalog:submit', h.ctx(), {
      kind: 'cold-start',
      skillId: 'jira',
      requestedByUserId: 'bob',
      description: 'me too',
    });
    expect(second.created).toBe(false);
    expect(second.requestId).toBe(first.requestId);
  });

  it('catalog:list-requests returns pending requests with reconstructed files, no tree sha', async () => {
    const h = await makeHarness();
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: SAMPLE_MANIFEST,
      bodyMd: SAMPLE_BODY,
      files: [{ path: 'scripts/run.py', contents: 'print(1)' }],
      scope: 'user',
      ownerUserId: 'alice',
    });
    await h.bus.call<CatalogSubmitInput, CatalogSubmitOutput>('catalog:submit', h.ctx(), {
      kind: 'share',
      skillId: 'github',
      requestedByUserId: 'alice',
      description: 'share',
    });
    await h.bus.call<CatalogSubmitInput, CatalogSubmitOutput>('catalog:submit', h.ctx(), {
      kind: 'cold-start',
      skillId: 'jira',
      requestedByUserId: 'bob',
      description: 'need jira',
    });

    const { requests } = await h.bus.call<CatalogListRequestsInput, CatalogListRequestsOutput>(
      'catalog:list-requests',
      h.ctx(),
      {},
    );
    expect(requests.map((r) => r.skillId).sort()).toEqual(['github', 'jira']);
    const share = requests.find((r) => r.skillId === 'github')!;
    expect(share.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]);
    expect(share).not.toHaveProperty('bundle_tree_sha'); // storage detail must not leak
    const cold = requests.find((r) => r.skillId === 'jira')!;
    expect(cold.kind).toBe('cold-start');
    expect(cold.files).toEqual([]);
    expect(cold.manifestYaml).toBeNull();
  });

  it('catalog:admit promotes the share to the global catalog and retires the user copy', async () => {
    const h = await makeHarness();
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: SAMPLE_MANIFEST,
      bodyMd: SAMPLE_BODY,
      files: [{ path: 'scripts/run.py', contents: 'print(1)' }],
      scope: 'user',
      ownerUserId: 'alice',
    });
    const sub = await h.bus.call<CatalogSubmitInput, CatalogSubmitOutput>('catalog:submit', h.ctx(), {
      kind: 'share',
      skillId: 'github',
      requestedByUserId: 'alice',
      description: 'share',
    });

    // The user-scoped copy exists; the global one does not — yet.
    const userBefore = await h.bus.call<SkillsGetInput, SkillsGetOutput>('skills:get', h.ctx(), {
      skillId: 'github',
      scope: 'user',
      ownerUserId: 'alice',
    });
    expect(userBefore.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]);
    await expect(
      h.bus.call<SkillsGetInput, SkillsGetOutput>('skills:get', h.ctx(), {
        skillId: 'github',
        scope: 'global',
      }),
    ).rejects.toMatchObject({ code: 'skill-not-found' });

    const admit = await h.bus.call<CatalogAdmitInput, CatalogAdmitOutput>('catalog:admit', h.ctx(), {
      requestId: sub.requestId,
      decision: 'admit',
      decidedByUserId: 'admin',
    });
    expect(admit).toEqual({ skillId: 'github', admitted: true });

    // Promoted into the GLOBAL catalog with the bundle intact (shipped == reviewed).
    const global = await h.bus.call<SkillsGetInput, SkillsGetOutput>('skills:get', h.ctx(), {
      skillId: 'github',
      scope: 'global',
    });
    expect(global.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]);
    expect(global.manifestYaml).toContain('name: github');

    // The author's editable working copy is RETIRED.
    await expect(
      h.bus.call<SkillsGetInput, SkillsGetOutput>('skills:get', h.ctx(), {
        skillId: 'github',
        scope: 'user',
        ownerUserId: 'alice',
      }),
    ).rejects.toMatchObject({ code: 'skill-not-found' });

    // Request marked admitted; queue empty.
    const { requests } = await h.bus.call<CatalogListRequestsInput, CatalogListRequestsOutput>(
      'catalog:list-requests',
      h.ctx(),
      {},
    );
    expect(requests.length).toBe(0);
  });

  it('catalog:admit reject closes the request without promoting', async () => {
    const h = await makeHarness();
    const sub = await h.bus.call<CatalogSubmitInput, CatalogSubmitOutput>('catalog:submit', h.ctx(), {
      kind: 'cold-start',
      skillId: 'jira',
      requestedByUserId: 'alice',
      description: 'need jira',
    });
    const out = await h.bus.call<CatalogAdmitInput, CatalogAdmitOutput>('catalog:admit', h.ctx(), {
      requestId: sub.requestId,
      decision: 'reject',
      decidedByUserId: 'admin',
    });
    expect(out.admitted).toBe(false);
    await expect(
      h.bus.call<SkillsGetInput, SkillsGetOutput>('skills:get', h.ctx(), {
        skillId: 'jira',
        scope: 'global',
      }),
    ).rejects.toMatchObject({ code: 'skill-not-found' });
  });

  it('catalog:admit of a cold-start request is not promotable', async () => {
    const h = await makeHarness();
    const sub = await h.bus.call<CatalogSubmitInput, CatalogSubmitOutput>('catalog:submit', h.ctx(), {
      kind: 'cold-start',
      skillId: 'jira',
      requestedByUserId: 'alice',
      description: 'need jira',
    });
    await expect(
      h.bus.call<CatalogAdmitInput, CatalogAdmitOutput>('catalog:admit', h.ctx(), {
        requestId: sub.requestId,
        decision: 'admit',
        decidedByUserId: 'admin',
      }),
    ).rejects.toMatchObject({ code: 'cold-start-not-promotable' });
  });
});

// ---------------------------------------------------------------------------
// skills quarantine services (Phase 2)
// ---------------------------------------------------------------------------

describe('skills quarantine services', () => {
  it('set → get → list → clear round-trips through the bus', async () => {
    const h = await makeHarness();

    await h.bus.call<SkillsQuarantineSetInput, SkillsQuarantineSetOutput>(
      'skills:quarantine-set',
      h.ctx(),
      { ownerUserId: 'u1', agentId: 'a1', skillId: 'linear', reason: 'flagged: prompt-injection' },
    );

    expect(
      await h.bus.call<SkillsQuarantineGetInput, SkillsQuarantineGetOutput>(
        'skills:quarantine-get',
        h.ctx(),
        { ownerUserId: 'u1', agentId: 'a1', skillId: 'linear' },
      ),
    ).toEqual({ quarantined: true, reason: 'flagged: prompt-injection' });

    const listed = await h.bus.call<SkillsQuarantineListInput, SkillsQuarantineListOutput>(
      'skills:quarantine-list',
      h.ctx(),
      { ownerUserId: 'u1', agentId: 'a1' },
    );
    expect(listed.items.map((i) => i.skillId)).toEqual(['linear']);
    expect(listed.items[0]).toMatchObject({ skillId: 'linear', reason: 'flagged: prompt-injection' });
    expect(typeof (listed.items[0] as { lastFlaggedAt?: unknown }).lastFlaggedAt).toBe('string');

    expect(
      await h.bus.call<SkillsQuarantineClearInput, SkillsQuarantineClearOutput>(
        'skills:quarantine-clear',
        h.ctx(),
        { ownerUserId: 'u1', agentId: 'a1', skillId: 'linear' },
      ),
    ).toEqual({ cleared: true });

    expect(
      await h.bus.call<SkillsQuarantineGetInput, SkillsQuarantineGetOutput>(
        'skills:quarantine-get',
        h.ctx(),
        { ownerUserId: 'u1', agentId: 'a1', skillId: 'linear' },
      ),
    ).toEqual({ quarantined: false });
  });
});

// ---------------------------------------------------------------------------
// FIX 3 — skills:approved-caps-set rejects kind:'mcp'; host/slot/npm/pypi succeed
// ---------------------------------------------------------------------------
describe('@ax/skills skills:approved-caps-set FIX 3 (mcp rejection)', () => {
  const key = { ownerUserId: 'u1', agentId: 'a1', skillId: 'test-skill' };

  it('kind:mcp is rejected with not-supported PluginError', async () => {
    const h = await makeHarness();
    await expect(
      h.bus.call(
        'skills:approved-caps-set',
        h.ctx(),
        { ...key, kind: 'mcp', value: 'some-mcp-server' },
      ),
    ).rejects.toMatchObject({
      code: 'not-supported',
      message: expect.stringContaining("kind 'mcp' is not yet supported"),
    });
  });

  it('kind:host still succeeds after the mcp guard', async () => {
    const h = await makeHarness();
    const result = await h.bus.call(
      'skills:approved-caps-set',
      h.ctx(),
      { ...key, kind: 'host', value: 'api.example.com' },
    );
    expect(result).toEqual({ created: true });
  });

  it('kind:slot still succeeds after the mcp guard', async () => {
    const h = await makeHarness();
    const result = await h.bus.call(
      'skills:approved-caps-set',
      h.ctx(),
      { ...key, kind: 'slot', value: 'MY_API_KEY', detail: { kind: 'api-key' } },
    );
    expect(result).toEqual({ created: true });
  });

  it('kind:npm still succeeds after the mcp guard', async () => {
    const h = await makeHarness();
    const result = await h.bus.call(
      'skills:approved-caps-set',
      h.ctx(),
      { ...key, kind: 'npm', value: 'left-pad' },
    );
    expect(result).toEqual({ created: true });
  });

  it('kind:pypi still succeeds after the mcp guard', async () => {
    const h = await makeHarness();
    const result = await h.bus.call(
      'skills:approved-caps-set',
      h.ctx(),
      { ...key, kind: 'pypi', value: 'requests' },
    );
    expect(result).toEqual({ created: true });
  });
});
