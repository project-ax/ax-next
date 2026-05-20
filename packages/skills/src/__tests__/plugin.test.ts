import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { PluginError } from '@ax/core';
import { createSkillsPlugin } from '../plugin.js';
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
} = {}): Promise<TestHarness> {
  const h = await createTestHarness({
    services: {
      'http:register-route': httpRegisterRouteStub,
      'auth:require-user': authRequireUserStub,
      ...opts.services,
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createSkillsPlugin(),
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
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_skills');
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
