/**
 * Tests for agents:list-authored-skills (Phase E step 1b).
 *
 * The mock workspace plugin is a SINGLE shared store — it does NOT key
 * workspaces by ctx (userId/agentId). All workspace:apply / workspace:read /
 * workspace:list calls within one harness share the same `latest` snapshot
 * pointer. This means:
 *   1. Each test case must use a fresh harness to get an isolated workspace.
 *   2. The ctx we pass to workspace:apply for seeding only affects the
 *      delta.author metadata — it does NOT route to a per-agent shard.
 *
 * In PRODUCTION, workspace:list/read ARE ctx-routed (hashed to a per-agent
 * workspace id). The mock faithfully tests the parsing + flagging logic while
 * the ctx-routing correctness is verified by inspecting authored-skills.ts
 * (where makeAgentContext is called with the owner userId + agentId).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  createTestHarness,
  createMockWorkspacePlugin,
  type TestHarness,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { makeAgentContext } from '@ax/core';
import { createAgentsPlugin } from '../plugin.js';
import { readAuthoredBundle, listAuthoredBundles } from '../authored-skills.js';
import type { CreateInput, CreateOutput } from '../types.js';
import type {
  AgentsListAuthoredSkillsInput,
  AgentsListAuthoredSkillsOutput,
  AgentsResolveAuthoredSkillsInput,
  AgentsResolveAuthoredSkillsOutput,
} from '../types.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

// Minimal valid SKILL.md (no capabilities).
function makeSkillMd(
  id: string,
  opts: { withCapabilities?: boolean; withPackages?: boolean } = {},
): string {
  let capBlock = '';
  if (opts.withCapabilities) {
    capBlock = `capabilities:\n  allowedHosts:\n    - api.evil.com\n`;
  } else if (opts.withPackages) {
    capBlock = `capabilities:\n  packages:\n    npm:\n      - x\n`;
  }
  return [
    '---',
    `name: ${id}`,
    `description: A skill called ${id}`,
    'version: 1',
    capBlock,
    '---',
    '',
    `# ${id}`,
    'This is the skill body.',
  ].join('\n');
}

async function makeHarness(withWorkspace = true): Promise<TestHarness> {
  const plugins = [
    createDatabasePostgresPlugin({ connectionString }),
    createAgentsPlugin(),
    ...(withWorkspace ? [createMockWorkspacePlugin()] : []),
  ];
  const h = await createTestHarness({
    services: {
      'http:register-route': async () => ({ unregister: () => {} }),
      'auth:require-user': async () => {
        throw new Error('auth:require-user not configured in authored-skills.test.ts');
      },
    },
    plugins,
  });
  harnesses.push(h);
  return h;
}

async function createPersonalAgent(h: TestHarness, userId: string): Promise<string> {
  const out = await h.bus.call<CreateInput, CreateOutput>('agents:create', h.ctx({ userId }), {
    actor: { userId, isAdmin: false },
    input: {
      displayName: 'Test Agent',
      systemPrompt: 'You are helpful.',
      allowedTools: [],
      mcpConfigIds: [],
      model: 'claude-opus-4-7',
      visibility: 'personal',
    },
  });
  return out.agent.id;
}

/**
 * Seed a file into the mock workspace. The mock workspace is a single shared
 * store, so the ctx here only sets delta.author metadata — it does NOT route
 * to a per-agent shard. We still pass an agent-matching ctx so that if the
 * implementation is swapped to a real workspace backend in future, the seeding
 * ctx will route correctly.
 *
 * Each call must pass the CURRENT parent (null for first apply).
 */
async function seedFile(
  h: TestHarness,
  path: string,
  content: string,
  ownerUserId: string,
  agentId: string,
  parent: string | null,
): Promise<string> {
  const ctx = makeAgentContext({ userId: ownerUserId, agentId, sessionId: 'test-seed' });
  const r = await h.bus.call<
    { changes: Array<{ path: string; kind: 'put'; content: Uint8Array }>; parent: string | null },
    { version: string }
  >('workspace:apply', ctx, {
    changes: [{ path, kind: 'put', content: new TextEncoder().encode(content) }],
    parent,
  });
  return r.version;
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
    await cleanup.query('DROP TABLE IF EXISTS agents_v1_agents');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await container.stop();
});

describe('agents:list-authored-skills', () => {
  it('returns empty list when workspace is empty', async () => {
    const h = await makeHarness();
    const agentId = await createPersonalAgent(h, 'u1');

    const result = await h.bus.call<
      AgentsListAuthoredSkillsInput,
      AgentsListAuthoredSkillsOutput
    >('agents:list-authored-skills', h.ctx(), { agentId });

    expect(result.skills).toEqual([]);
  });

  it('returns both skills sorted by id with hasForbiddenCapabilities:false for clean skills', async () => {
    const h = await makeHarness();
    const userId = 'u1';
    const agentId = await createPersonalAgent(h, userId);

    // Seed two SKILL.md files with no capabilities (alphabetical order: bar, foo)
    // but seed them in reverse order to verify sorting works.
    const v1 = await seedFile(
      h, '.ax/draft-skills/foo/SKILL.md', makeSkillMd('foo'), userId, agentId, null,
    );
    await seedFile(
      h, '.ax/draft-skills/bar/SKILL.md', makeSkillMd('bar'), userId, agentId, v1,
    );

    const result = await h.bus.call<
      AgentsListAuthoredSkillsInput,
      AgentsListAuthoredSkillsOutput
    >('agents:list-authored-skills', h.ctx(), { agentId });

    // Should be sorted: bar before foo.
    expect(result.skills).toHaveLength(2);
    expect(result.skills[0]!.id).toBe('bar');
    expect(result.skills[0]!.hasForbiddenCapabilities).toBe(false);
    expect(result.skills[0]!.description).toBe('A skill called bar');
    expect(result.skills[0]!.version).toBe(1);
    expect(result.skills[1]!.id).toBe('foo');
    expect(result.skills[1]!.hasForbiddenCapabilities).toBe(false);
  });

  it('flags skills that declare capabilities as hasForbiddenCapabilities:true', async () => {
    const h = await makeHarness();
    const userId = 'u1';
    const agentId = await createPersonalAgent(h, userId);

    const v1 = await seedFile(
      h,
      '.ax/draft-skills/dangerous/SKILL.md',
      makeSkillMd('dangerous', { withCapabilities: true }),
      userId,
      agentId,
      null,
    );
    await seedFile(
      h, '.ax/draft-skills/safe/SKILL.md', makeSkillMd('safe'), userId, agentId, v1,
    );

    const result = await h.bus.call<
      AgentsListAuthoredSkillsInput,
      AgentsListAuthoredSkillsOutput
    >('agents:list-authored-skills', h.ctx(), { agentId });

    expect(result.skills).toHaveLength(2);
    const dangerous = result.skills.find((s) => s.id === 'dangerous')!;
    const safe = result.skills.find((s) => s.id === 'safe')!;
    expect(dangerous.hasForbiddenCapabilities).toBe(true);
    expect(safe.hasForbiddenCapabilities).toBe(false);
  });

  it('returns empty list when no workspace plugin is loaded', async () => {
    // withWorkspace=false omits createMockWorkspacePlugin from the harness.
    const h = await makeHarness(false);
    const agentId = await createPersonalAgent(h, 'u1');

    const result = await h.bus.call<
      AgentsListAuthoredSkillsInput,
      AgentsListAuthoredSkillsOutput
    >('agents:list-authored-skills', h.ctx(), { agentId });

    expect(result.skills).toEqual([]);
  });

  it('returns empty list for a team agent (deferred path)', async () => {
    // teams:is-member stub lets us create a team agent without @ax/teams.
    const h = await createTestHarness({
      services: {
        'http:register-route': async () => ({ unregister: () => {} }),
        'auth:require-user': async () => {
          throw new Error('not configured');
        },
        'teams:is-member': async () => ({ member: true }),
      },
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        createAgentsPlugin(),
        createMockWorkspacePlugin(),
      ],
    });
    harnesses.push(h);

    const out = await h.bus.call<CreateInput, CreateOutput>('agents:create', h.ctx(), {
      actor: { userId: 'u1', isAdmin: false },
      input: {
        displayName: 'Team Agent',
        systemPrompt: 'You are helpful.',
        allowedTools: [],
        mcpConfigIds: [],
        model: 'claude-opus-4-7',
        visibility: 'team',
        teamId: 't1',
      },
    });
    const teamAgentId = out.agent.id;

    const result = await h.bus.call<
      AgentsListAuthoredSkillsInput,
      AgentsListAuthoredSkillsOutput
    >('agents:list-authored-skills', h.ctx(), { agentId: teamAgentId });

    expect(result.skills).toEqual([]);
  });

  it('returns empty list for a non-existent agent', async () => {
    const h = await makeHarness();

    const result = await h.bus.call<
      AgentsListAuthoredSkillsInput,
      AgentsListAuthoredSkillsOutput
    >('agents:list-authored-skills', h.ctx(), { agentId: 'agt_does_not_exist' });

    expect(result.skills).toEqual([]);
  });

  it('propagates workspace:list backend errors instead of swallowing them', async () => {
    // Build a harness where workspace:list THROWS (simulates a real backend
    // outage, not a missing/empty workspace — the latter returns {paths:[]}).
    // agents:list-authored-skills must REJECT, not return [].
    const h = await createTestHarness({
      services: {
        'http:register-route': async () => ({ unregister: () => {} }),
        'auth:require-user': async () => {
          throw new Error('not configured');
        },
        // workspace:list throws to simulate a backend outage.
        'workspace:list': async () => {
          throw new Error('workspace-backend-unavailable');
        },
        // workspace:read is provided so the hasService guard passes for both.
        'workspace:read': async () => ({ found: false }),
      },
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        createAgentsPlugin(),
      ],
    });
    harnesses.push(h);

    const agentId = await createPersonalAgent(h, 'u1');

    await expect(
      h.bus.call<AgentsListAuthoredSkillsInput, AgentsListAuthoredSkillsOutput>(
        'agents:list-authored-skills',
        h.ctx(),
        { agentId },
      ),
    ).rejects.toThrow('workspace-backend-unavailable');
  });

  it('skips malformed SKILL.md files silently', async () => {
    const h = await makeHarness();
    const userId = 'u1';
    const agentId = await createPersonalAgent(h, userId);

    const v1 = await seedFile(
      h,
      '.ax/draft-skills/broken/SKILL.md',
      'this is not valid SKILL.md format at all',
      userId,
      agentId,
      null,
    );
    await seedFile(
      h, '.ax/draft-skills/valid/SKILL.md', makeSkillMd('valid'), userId, agentId, v1,
    );

    const result = await h.bus.call<
      AgentsListAuthoredSkillsInput,
      AgentsListAuthoredSkillsOutput
    >('agents:list-authored-skills', h.ctx(), { agentId });

    // Only the valid one should appear.
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.id).toBe('valid');
  });

  // FIX C: a frontmatter declaring only capabilities.packages must also be
  // flagged as hasForbiddenCapabilities:true (consistency with allowedHosts /
  // credentials / mcpServers).
  it('flags skills with only packages capability as hasForbiddenCapabilities:true (FIX C)', async () => {
    const h = await makeHarness();
    const userId = 'u1';
    const agentId = await createPersonalAgent(h, userId);

    await seedFile(
      h,
      '.ax/draft-skills/pkg-only/SKILL.md',
      makeSkillMd('pkg-only', { withPackages: true }),
      userId,
      agentId,
      null,
    );

    const result = await h.bus.call<
      AgentsListAuthoredSkillsInput,
      AgentsListAuthoredSkillsOutput
    >('agents:list-authored-skills', h.ctx(), { agentId });

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.id).toBe('pkg-only');
    expect(result.skills[0]!.hasForbiddenCapabilities).toBe(true);
  });

  // Agents frequently author a skill as a flat `.ax/draft-skills/<id>.md` file rather
  // than the directory form. The promote/list reader must surface those too, or
  // they're invisible to the admin promote flow.
  it('surfaces a flat-file skill (.ax/draft-skills/<id>.md) alongside directory-form skills', async () => {
    const h = await makeHarness();
    const userId = 'u1';
    const agentId = await createPersonalAgent(h, userId);
    const v1 = await seedFile(
      h, '.ax/draft-skills/dirskill/SKILL.md', makeSkillMd('dirskill'), userId, agentId, null,
    );
    await seedFile(
      h, '.ax/draft-skills/flatskill.md', makeSkillMd('flatskill'), userId, agentId, v1,
    );

    const result = await h.bus.call<
      AgentsListAuthoredSkillsInput,
      AgentsListAuthoredSkillsOutput
    >('agents:list-authored-skills', h.ctx(), { agentId });

    expect(result.skills.map((s) => s.id).sort()).toEqual(['dirskill', 'flatskill']);
  });
});

// ---------------------------------------------------------------------------
// readAuthoredBundle (TASK-39) — read the FULL bundle (SKILL.md + helper files)
// ---------------------------------------------------------------------------

describe('readAuthoredBundle', () => {
  it('returns the manifest body + extra files (paths relative to the skill dir)', async () => {
    const h = await makeHarness();
    const userId = 'u1';
    const agentId = await createPersonalAgent(h, userId);

    // Seed a multi-file draft under .ax/draft-skills/notes/ (note the mock workspace
    // is a single shared store — chain the parent through each seed).
    const v1 = await seedFile(
      h,
      '.ax/draft-skills/notes/SKILL.md',
      '---\nname: notes\ndescription: Take notes\nversion: 2\n---\nBody here',
      userId,
      agentId,
      null,
    );
    const v2 = await seedFile(
      h, '.ax/draft-skills/notes/scripts/run.py', 'print(1)', userId, agentId, v1,
    );
    await seedFile(
      h, '.ax/draft-skills/notes/data/x.json', '{}', userId, agentId, v2,
    );

    const bundle = await readAuthoredBundle(h.bus, userId, agentId, 'notes');
    expect(bundle).not.toBeNull();
    expect(bundle!.description).toBe('Take notes');
    expect(bundle!.version).toBe(2);
    expect(bundle!.bodyMd).toBe('Body here');
    // SKILL.md is excluded from files[] (it becomes manifest+body); helper
    // files are sorted by path.
    expect(bundle!.files).toEqual([
      { path: 'data/x.json', contents: '{}' },
      { path: 'scripts/run.py', contents: 'print(1)' },
    ]);
  });

  it('returns null when there is no SKILL.md for the id', async () => {
    const h = await makeHarness();
    const userId = 'u1';
    const agentId = await createPersonalAgent(h, userId);
    await seedFile(
      h, '.ax/draft-skills/empty/notes.txt', 'x', userId, agentId, null,
    );

    expect(await readAuthoredBundle(h.bus, userId, agentId, 'empty')).toBeNull();
  });

  // BUG-W2 follow-up: a SKILL.md that IS present but invalid must THROW
  // authored-skill-invalid with the reason (not return null → the misleading
  // "authored-skill-not-found"), so the agent learns what to fix.
  it('throws authored-skill-invalid when the SKILL.md has no frontmatter', async () => {
    const h = await makeHarness();
    const userId = 'u1';
    const agentId = await createPersonalAgent(h, userId);
    await seedFile(
      h, '.ax/draft-skills/broken/SKILL.md', 'not a valid skill md', userId, agentId, null,
    );

    await expect(
      readAuthoredBundle(h.bus, userId, agentId, 'broken'),
    ).rejects.toMatchObject({ code: 'authored-skill-invalid' });
  });

  it('throws authored-skill-invalid (with the reason) when the description is too long', async () => {
    const h = await makeHarness();
    const userId = 'u1';
    const agentId = await createPersonalAgent(h, userId);
    const longDesc = 'x'.repeat(300); // > 240-char limit
    const md = ['---', 'name: toolong', `description: ${longDesc}`, 'version: 1', '---', '', '# body'].join('\n');
    await seedFile(h, '.ax/draft-skills/toolong/SKILL.md', md, userId, agentId, null);

    await expect(
      readAuthoredBundle(h.bus, userId, agentId, 'toolong'),
    ).rejects.toThrow(/240|description/i);
  });

  it('returns null when no workspace backend is loaded', async () => {
    const h = await makeHarness(false); // omits createMockWorkspacePlugin
    const agentId = await createPersonalAgent(h, 'u1');
    expect(await readAuthoredBundle(h.bus, 'u1', agentId, 'notes')).toBeNull();
  });

  it('rejects a traversal-shaped skill id (never interpolated into a glob)', async () => {
    const h = await makeHarness();
    const agentId = await createPersonalAgent(h, 'u1');
    await expect(
      readAuthoredBundle(h.bus, 'u1', agentId, '../evil'),
    ).rejects.toThrow(/invalid/i);
  });

  // BUG-W2 sibling: the agent wrote the skill as a single flat file
  // `.ax/draft-skills/<id>.md` instead of `.ax/draft-skills/<id>/SKILL.md`. The dir glob
  // could never match it → null → misleading authored-skill-not-found. We now
  // fall back to the flat form (no helper files), and record its draftPath.
  it('reads the flat-file form (.ax/draft-skills/<id>.md) when the directory form is absent', async () => {
    const h = await makeHarness();
    const userId = 'u1';
    const agentId = await createPersonalAgent(h, userId);
    await seedFile(
      h,
      '.ax/draft-skills/flat.md',
      '---\nname: flat\ndescription: Flat skill\nversion: 3\n---\nFlat body',
      userId,
      agentId,
      null,
    );

    const bundle = await readAuthoredBundle(h.bus, userId, agentId, 'flat');
    expect(bundle).not.toBeNull();
    expect(bundle!.description).toBe('Flat skill');
    expect(bundle!.version).toBe(3);
    expect(bundle!.bodyMd).toBe('Flat body');
    expect(bundle!.files).toEqual([]);
    expect(bundle!.draftPaths).toEqual(['.ax/draft-skills/flat.md']);
  });

  // The flat form gets the same "found but invalid → surface the reason" handling
  // as the directory form (so the agent learns what to fix instead of seeing the
  // misleading not-found).
  it('throws authored-skill-invalid when the flat-file form has no frontmatter', async () => {
    const h = await makeHarness();
    const agentId = await createPersonalAgent(h, 'u1');
    await seedFile(h, '.ax/draft-skills/flatbad.md', 'no frontmatter here', 'u1', agentId, null);

    await expect(
      readAuthoredBundle(h.bus, 'u1', agentId, 'flatbad'),
    ).rejects.toMatchObject({ code: 'authored-skill-invalid' });
  });

  it('records the directory-form draftPaths (SKILL.md + helper files) for retirement', async () => {
    const h = await makeHarness();
    const userId = 'u1';
    const agentId = await createPersonalAgent(h, userId);
    const v1 = await seedFile(
      h, '.ax/draft-skills/multi/SKILL.md',
      '---\nname: multi\ndescription: Multi\nversion: 1\n---\nBody', userId, agentId, null,
    );
    await seedFile(h, '.ax/draft-skills/multi/ref.md', 'ref', userId, agentId, v1);

    const bundle = await readAuthoredBundle(h.bus, userId, agentId, 'multi');
    expect(bundle).not.toBeNull();
    expect([...bundle!.draftPaths].sort()).toEqual([
      '.ax/draft-skills/multi/SKILL.md',
      '.ax/draft-skills/multi/ref.md',
    ]);
  });
});

// ---------------------------------------------------------------------------
// listAuthoredBundles — projection source for all parseable self-authored drafts
// ---------------------------------------------------------------------------

describe('listAuthoredBundles', () => {
  it('returns each parseable draft as a projection bundle with raw manifestYaml, bodyMd, and helper files, sorted by id, skipping malformed drafts', async () => {
    const h = await makeHarness();
    const userId = 'u1';
    const agentId = await createPersonalAgent(h, userId);

    // Seed two parseable drafts (directory form) + one malformed (no frontmatter)
    // + one with a helper file. Seed in non-alphabetical order to verify sorting.
    const v1 = await seedFile(
      h,
      '.ax/draft-skills/zoo/SKILL.md',
      '---\nname: zoo\ndescription: Zoo skill\nversion: 1\n---\nZoo body',
      userId,
      agentId,
      null,
    );
    const v2 = await seedFile(
      h,
      '.ax/draft-skills/alpha/SKILL.md',
      '---\nname: alpha\ndescription: Alpha skill\nversion: 2\n---\nAlpha body',
      userId,
      agentId,
      v1,
    );
    const v3 = await seedFile(
      h,
      '.ax/draft-skills/alpha/scripts/run.sh',
      '#!/bin/bash\necho hello',
      userId,
      agentId,
      v2,
    );
    // Malformed draft: no frontmatter fence — must be SKIPPED, not thrown.
    await seedFile(
      h,
      '.ax/draft-skills/broken/SKILL.md',
      'not a valid skill md at all',
      userId,
      agentId,
      v3,
    );

    const bundles = await listAuthoredBundles(h.bus, userId, agentId);

    // 'broken' is silently skipped; 'alpha' and 'zoo' are returned sorted by id.
    expect(bundles).toHaveLength(2);
    expect(bundles[0]!.id).toBe('alpha');
    expect(bundles[0]!.manifestYaml).toContain('name: alpha');
    expect(bundles[0]!.bodyMd).toBe('Alpha body');
    expect(bundles[0]!.files).toEqual([{ path: 'scripts/run.sh', contents: '#!/bin/bash\necho hello' }]);
    expect(bundles[1]!.id).toBe('zoo');
    expect(bundles[1]!.manifestYaml).toContain('name: zoo');
    expect(bundles[1]!.bodyMd).toBe('Zoo body');
    expect(bundles[1]!.files).toEqual([]);
  });

  // C1 (review): the discovery projection must surface ONLY the directory form,
  // because that is the exact shape @ax/validator-skill's commit scanner covers
  // (its SKILL_PATH matches `.ax/draft-skills/<id>/SKILL.md` only). A flat
  // `.ax/draft-skills/<id>.md` is NEVER scanned, so projecting it would be a
  // quarantine-scan bypass — an agent could write a hostile flat draft that the
  // SDK then discovers unfiltered. (listAuthoredSkills, the human-reviewed
  // promote reader, keeps flat-form support — only auto-discovery drops it.)
  it('OMITS flat-file drafts (.ax/draft-skills/<id>.md) because the commit scanner only covers the directory form', async () => {
    const h = await makeHarness();
    const userId = 'u1';
    const agentId = await createPersonalAgent(h, userId);

    const v1 = await seedFile(
      h,
      '.ax/draft-skills/dirskill/SKILL.md',
      '---\nname: dirskill\ndescription: Dir skill\nversion: 1\n---\nDir body',
      userId,
      agentId,
      null,
    );
    await seedFile(
      h,
      '.ax/draft-skills/flatskill.md',
      '---\nname: flatskill\ndescription: Flat skill\nversion: 1\n---\nFlat body',
      userId,
      agentId,
      v1,
    );

    const bundles = await listAuthoredBundles(h.bus, userId, agentId);

    // Only the directory-form draft is projected; the flat-form one is omitted.
    expect(bundles.map((b) => b.id).sort()).toEqual(['dirskill']);
    expect(bundles.some((b) => b.id === 'flatskill')).toBe(false);
  });

  // I2 (review): a draft DIRECTORY whose name is outside the strict sandbox
  // installed-skill id grammar (/^[a-z][a-z0-9-]{0,63}$/) must be SKIPPED, not
  // projected. The permissive AUTHORED_SKILL_ID_RE would pass `My_Skill`, but
  // the sandbox's InstalledSkillSchema would reject it → invalid-payload →
  // the WHOLE installedSkills batch fails → generic sandbox-open-failed. Skip
  // it (like a malformed manifest) so one bad id can't break discovery for the
  // rest. A sibling clean `good` dir IS still returned.
  it('OMITS a draft dir whose name is outside the strict sandbox id grammar; a clean sibling IS returned', async () => {
    const h = await makeHarness();
    const userId = 'u1';
    const agentId = await createPersonalAgent(h, userId);

    // `My_Skill`: valid SKILL.md, but the dir name has an uppercase + underscore
    // → fails the strict installed-skill grammar.
    const v1 = await seedFile(
      h,
      '.ax/draft-skills/My_Skill/SKILL.md',
      '---\nname: my-skill\ndescription: Bad id skill\nversion: 1\n---\nBad id body',
      userId,
      agentId,
      null,
    );
    await seedFile(
      h,
      '.ax/draft-skills/good/SKILL.md',
      '---\nname: good\ndescription: Good skill\nversion: 1\n---\nGood body',
      userId,
      agentId,
      v1,
    );

    const bundles = await listAuthoredBundles(h.bus, userId, agentId);

    // The bad-id dir is skipped; only the clean one is projected.
    expect(bundles.map((b) => b.id)).toEqual(['good']);
    expect(bundles.some((b) => b.id === 'My_Skill')).toBe(false);
  });

  it('returns [] when no workspace backend is loaded (soft-dep)', async () => {
    // withWorkspace=false omits createMockWorkspacePlugin — bare HookBus with
    // no workspace:list / workspace:read.
    const h = await makeHarness(false);
    const agentId = await createPersonalAgent(h, 'u1');

    const bundles = await listAuthoredBundles(h.bus, 'u1', agentId);

    expect(bundles).toEqual([]);
  });

  it('returns [] when the workspace is empty', async () => {
    const h = await makeHarness();
    const agentId = await createPersonalAgent(h, 'u1');

    const bundles = await listAuthoredBundles(h.bus, 'u1', agentId);

    expect(bundles).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// agents:resolve-authored-skills (Phase 3, Task A2)
// Returns the agent's self-authored drafts in the resolved-skill projection
// shape with empty capabilities. Quarantined drafts are omitted via the
// skills:quarantine-get soft-dep (absent → project everything).
// ---------------------------------------------------------------------------

describe('agents:resolve-authored-skills', () => {
  it('returns non-quarantined drafts with empty capabilities; omits quarantined ones', async () => {
    const h = await makeHarness();
    const userId = 'u1';
    const agentId = await createPersonalAgent(h, userId);

    // Seed two valid drafts.
    const v1 = await seedFile(
      h,
      '.ax/draft-skills/clean/SKILL.md',
      '---\nname: clean\ndescription: Clean skill\nversion: 1\n---\nClean body',
      userId,
      agentId,
      null,
    );
    await seedFile(
      h,
      '.ax/draft-skills/evil/SKILL.md',
      '---\nname: evil\ndescription: Evil skill\nversion: 1\n---\nEvil body',
      userId,
      agentId,
      v1,
    );

    // Register a quarantine stub that marks 'evil' as quarantined.
    h.bus.registerService(
      'skills:quarantine-get',
      '@ax/test',
      async (_c: unknown, i: { skillId: string }) => ({
        quarantined: i.skillId === 'evil',
        ...(i.skillId === 'evil' ? { reason: 'injection' } : {}),
      }),
    );

    const result = await h.bus.call<
      AgentsResolveAuthoredSkillsInput,
      AgentsResolveAuthoredSkillsOutput
    >('agents:resolve-authored-skills', h.ctx({ userId }), {
      ownerUserId: userId,
      agentId,
    });

    // Only 'clean' should appear.
    expect(result.skills).toHaveLength(1);
    const clean = result.skills[0]!;
    expect(clean.id).toBe('clean');
    expect(clean.bodyMd).toBe('Clean body');
    expect(clean.manifestYaml).toContain('name: clean');
    // Phase 3: capabilities are ALWAYS empty — no parsing.
    expect(clean.capabilities).toEqual({
      allowedHosts: [],
      credentials: [],
      mcpServers: [],
      packages: { npm: [], pypi: [] },
    });
  });

  it('returns all drafts when skills:quarantine-get is NOT registered (soft-dep)', async () => {
    // Build a harness WITHOUT registering skills:quarantine-get — the service
    // must project all parseable drafts rather than throwing or returning [].
    const h = await makeHarness();
    const userId = 'u2';
    const agentId = await createPersonalAgent(h, userId);

    const v1 = await seedFile(
      h,
      '.ax/draft-skills/skilla/SKILL.md',
      '---\nname: skilla\ndescription: Skill A\nversion: 1\n---\nBody A',
      userId,
      agentId,
      null,
    );
    await seedFile(
      h,
      '.ax/draft-skills/skillb/SKILL.md',
      '---\nname: skillb\ndescription: Skill B\nversion: 1\n---\nBody B',
      userId,
      agentId,
      v1,
    );

    // Verify quarantine-get is NOT registered in this harness.
    expect(h.bus.hasService('skills:quarantine-get')).toBe(false);

    const result = await h.bus.call<
      AgentsResolveAuthoredSkillsInput,
      AgentsResolveAuthoredSkillsOutput
    >('agents:resolve-authored-skills', h.ctx({ userId }), {
      ownerUserId: userId,
      agentId,
    });

    expect(result.skills).toHaveLength(2);
    expect(result.skills.map((s) => s.id).sort()).toEqual(['skilla', 'skillb']);
    // All capabilities must still be empty.
    for (const skill of result.skills) {
      expect(skill.capabilities).toEqual({
        allowedHosts: [],
        credentials: [],
        mcpServers: [],
        packages: { npm: [], pypi: [] },
      });
    }
  });
});
