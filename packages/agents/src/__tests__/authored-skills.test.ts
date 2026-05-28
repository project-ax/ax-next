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
import { readAuthoredBundle } from '../authored-skills.js';
import type { CreateInput, CreateOutput } from '../types.js';
import type { AgentsListAuthoredSkillsInput, AgentsListAuthoredSkillsOutput } from '../types.js';

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
      h, '.ax/skills/foo/SKILL.md', makeSkillMd('foo'), userId, agentId, null,
    );
    await seedFile(
      h, '.ax/skills/bar/SKILL.md', makeSkillMd('bar'), userId, agentId, v1,
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
      '.ax/skills/dangerous/SKILL.md',
      makeSkillMd('dangerous', { withCapabilities: true }),
      userId,
      agentId,
      null,
    );
    await seedFile(
      h, '.ax/skills/safe/SKILL.md', makeSkillMd('safe'), userId, agentId, v1,
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
      '.ax/skills/broken/SKILL.md',
      'this is not valid SKILL.md format at all',
      userId,
      agentId,
      null,
    );
    await seedFile(
      h, '.ax/skills/valid/SKILL.md', makeSkillMd('valid'), userId, agentId, v1,
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
      '.ax/skills/pkg-only/SKILL.md',
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
});

// ---------------------------------------------------------------------------
// readAuthoredBundle (TASK-39) — read the FULL bundle (SKILL.md + helper files)
// ---------------------------------------------------------------------------

describe('readAuthoredBundle', () => {
  it('returns the manifest body + extra files (paths relative to the skill dir)', async () => {
    const h = await makeHarness();
    const userId = 'u1';
    const agentId = await createPersonalAgent(h, userId);

    // Seed a multi-file draft under .ax/skills/notes/ (note the mock workspace
    // is a single shared store — chain the parent through each seed).
    const v1 = await seedFile(
      h,
      '.ax/skills/notes/SKILL.md',
      '---\nname: notes\ndescription: Take notes\nversion: 2\n---\nBody here',
      userId,
      agentId,
      null,
    );
    const v2 = await seedFile(
      h, '.ax/skills/notes/scripts/run.py', 'print(1)', userId, agentId, v1,
    );
    await seedFile(
      h, '.ax/skills/notes/data/x.json', '{}', userId, agentId, v2,
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
      h, '.ax/skills/empty/notes.txt', 'x', userId, agentId, null,
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
      h, '.ax/skills/broken/SKILL.md', 'not a valid skill md', userId, agentId, null,
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
    await seedFile(h, '.ax/skills/toolong/SKILL.md', md, userId, agentId, null);

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
});
