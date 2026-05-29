/**
 * Tests for agents:install-authored-skill (TASK-39, open-mode flow C).
 *
 * The hook is the in-chat, user-approved analog of the admin
 * promoteAuthoredSkill flow: it reads the agent-authored draft under
 * `.ax/draft-skills/<id>/` (capability-free — the validator strips caps at write
 * time), upserts a USER-scoped skill carrying the user-REQUESTED capabilities
 * (the tool args) WITH the bundle's helper files[], then retires the draft.
 *
 * Same multi-plugin testcontainer harness as promote-authored-skills.test.ts /
 * authored-skills.test.ts (real Postgres + createMockWorkspacePlugin). The mock
 * workspace is a SINGLE shared store keyed only on optimistic-concurrency
 * `parent`, so each test seeds + retires by chaining the version.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
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
import { createSkillsPlugin } from '@ax/skills';
import { createAgentsPlugin } from '../plugin.js';
import type { CreateInput, CreateOutput } from '../types.js';
import type {
  AgentsInstallAuthoredSkillInput,
  AgentsInstallAuthoredSkillOutput,
} from '../types.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);

afterAll(async () => {
  if (container) await container.stop();
});

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    await h.close({ onError: () => {} });
  }
  const cleanup = new (await import('pg')).default.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS agents_v1_skill_attachments');
    await cleanup.query('DROP TABLE IF EXISTS agents_v1_agents');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_user_attachments');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_skill_files');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_user_skills');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_skills');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_quarantine');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

async function makeHarness(): Promise<TestHarness> {
  const h = await createTestHarness({
    services: {
      'http:register-route': async () => ({ unregister: () => {} }),
      'auth:require-user': async () => ({ user: { id: 'admin', isAdmin: true } }),
      // Lets us create a team agent without booting @ax/teams (for the
      // "team agent is rejected" case).
      'teams:is-member': async () => ({ member: true }),
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createAgentsPlugin(),
      createSkillsPlugin(),
      createMockWorkspacePlugin(),
    ],
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

async function createTeamAgent(h: TestHarness, userId: string, teamId: string): Promise<string> {
  const out = await h.bus.call<CreateInput, CreateOutput>('agents:create', h.ctx({ userId }), {
    actor: { userId, isAdmin: false },
    input: {
      displayName: 'Team Agent',
      systemPrompt: 'You are helpful.',
      allowedTools: [],
      mcpConfigIds: [],
      model: 'claude-opus-4-7',
      visibility: 'team',
      teamId,
    },
  });
  return out.agent.id;
}

/** Seed a file into the mock workspace; returns the new version. */
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

/** List the agent's workspace paths (mock store is shared, ctx is cosmetic). */
async function listWorkspace(h: TestHarness, ownerUserId: string, agentId: string): Promise<string[]> {
  const ctx = makeAgentContext({ userId: ownerUserId, agentId, sessionId: 'test-list' });
  const r = await h.bus.call<{ pathGlob?: string }, { paths: string[] }>(
    'workspace:list',
    ctx,
    {},
  );
  return r.paths;
}

function ctx(agentId: string) {
  return makeAgentContext({ sessionId: 's', agentId, userId: 'user-1', conversationId: 'cnv-1' });
}

/**
 * Spy on `bus.call` to capture the `manifestYaml` passed to `skills:upsert`,
 * while still delegating every call (including the upsert) to the real
 * implementation. Returns the captured YAML getter + a restore() to undo the spy.
 */
function captureSkillsUpsertYaml(h: TestHarness): {
  getYaml: () => string | undefined;
  restore: () => void;
} {
  const originalCall = h.bus.call.bind(h.bus);
  let captured: string | undefined;
  const spy = vi
    .spyOn(h.bus, 'call')
    .mockImplementation(async (hookName: string, ctx2: unknown, input: unknown) => {
      if (hookName === 'skills:upsert') {
        captured = (input as { manifestYaml: string }).manifestYaml;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return originalCall(hookName as any, ctx2 as any, input as any);
    });
  return { getYaml: () => captured, restore: () => spy.mockRestore() };
}

describe('agents:install-authored-skill', () => {
  it('upserts a user-scoped skill with the bundle files + requested caps, then retires the draft', async () => {
    const h = await makeHarness();
    const agentId = await createPersonalAgent(h, 'user-1');
    const v1 = await seedFile(
      h,
      '.ax/draft-skills/notes/SKILL.md',
      '---\nname: notes\ndescription: Take notes\nversion: 1\n---\nBody',
      'user-1',
      agentId,
      null,
    );
    await seedFile(h, '.ax/draft-skills/notes/scripts/run.py', 'print(1)', 'user-1', agentId, v1);

    const out = await h.bus.call<
      AgentsInstallAuthoredSkillInput,
      AgentsInstallAuthoredSkillOutput
    >('agents:install-authored-skill', ctx(agentId), {
      agentId,
      skillId: 'notes',
      hosts: ['api.example.com'],
      // SCREAMING_SNAKE — the downstream parseSkillManifest authority requires
      // slots match /^[A-Z][A-Z0-9_]{0,63}$/.
      slots: ['API_KEY'],
    });

    expect(out).toEqual({
      description: 'Take notes',
      hosts: ['api.example.com'],
      slots: [{ slot: 'API_KEY', kind: 'api-key' }],
      packages: { npm: [], pypi: [] },
    });

    // The user-scoped skill now exists WITH the helper file + the requested caps.
    const got = await h.bus.call<
      { skillId: string; scope: 'user'; ownerUserId: string },
      {
        capabilities: { allowedHosts: string[]; credentials: Array<{ slot: string }> };
        files: Array<{ path: string; contents: string }>;
      }
    >('skills:get', ctx(agentId), { skillId: 'notes', scope: 'user', ownerUserId: 'user-1' });
    expect(got.capabilities.allowedHosts).toEqual(['api.example.com']);
    expect(got.capabilities.credentials.map((c) => c.slot)).toEqual(['API_KEY']);
    expect(got.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]);

    // Draft retired: every .ax/draft-skills/notes/* path is gone from the workspace.
    const paths = await listWorkspace(h, 'user-1', agentId);
    expect(paths.some((p) => p.startsWith('.ax/draft-skills/notes/'))).toBe(false);
  });

  it('throws authored-skill-not-found when no SKILL.md exists for the id', async () => {
    const h = await makeHarness();
    const agentId = await createPersonalAgent(h, 'user-1');
    await expect(
      h.bus.call<AgentsInstallAuthoredSkillInput, AgentsInstallAuthoredSkillOutput>(
        'agents:install-authored-skill',
        ctx(agentId),
        { agentId, skillId: 'ghost', hosts: [], slots: [] },
      ),
    ).rejects.toThrow(/authored-skill-not-found|no authored skill/i);
  });

  it('sharpens not-found: names both accepted paths and any nearby files', async () => {
    const h = await makeHarness();
    const agentId = await createPersonalAgent(h, 'user-1');
    // Wrong-case directory: the agent wrote .ax/draft-skills/Linear/SKILL.md but
    // installs 'linear'. The case-sensitive dir glob misses it → not-found.
    await seedFile(
      h,
      '.ax/draft-skills/Linear/SKILL.md',
      '---\nname: linear\ndescription: X\nversion: 1\n---\nBody',
      'user-1',
      agentId,
      null,
    );
    await expect(
      h.bus.call<AgentsInstallAuthoredSkillInput, AgentsInstallAuthoredSkillOutput>(
        'agents:install-authored-skill',
        ctx(agentId),
        { agentId, skillId: 'linear', hosts: [], slots: [] },
      ),
      // Message names the directory form, the flat form, AND the nearby file.
    ).rejects.toThrow(
      /\.ax\/draft-skills\/linear\/SKILL\.md[\s\S]*\.ax\/draft-skills\/linear\.md[\s\S]*Linear\/SKILL\.md/,
    );
  });

  it('rejects authoring on a team agent (no single-owner workspace)', async () => {
    const h = await makeHarness();
    const teamAgentId = await createTeamAgent(h, 'user-1', 't1');
    await expect(
      h.bus.call<AgentsInstallAuthoredSkillInput, AgentsInstallAuthoredSkillOutput>(
        'agents:install-authored-skill',
        ctx(teamAgentId),
        { agentId: teamAgentId, skillId: 'notes', hosts: [], slots: [] },
      ),
    ).rejects.toThrow(/unsupported|personal/i);
  });

  it('retires a single-file draft (no helper files)', async () => {
    const h = await makeHarness();
    const agentId = await createPersonalAgent(h, 'user-1');
    await seedFile(
      h,
      '.ax/draft-skills/solo/SKILL.md',
      '---\nname: solo\ndescription: Solo skill\nversion: 1\n---\nBody',
      'user-1',
      agentId,
      null,
    );

    const out = await h.bus.call<
      AgentsInstallAuthoredSkillInput,
      AgentsInstallAuthoredSkillOutput
    >('agents:install-authored-skill', ctx(agentId), {
      agentId,
      skillId: 'solo',
      hosts: [],
      slots: [],
    });
    expect(out.description).toBe('Solo skill');

    const got = await h.bus.call<
      { skillId: string; scope: 'user'; ownerUserId: string },
      { files: Array<{ path: string }> }
    >('skills:get', ctx(agentId), { skillId: 'solo', scope: 'user', ownerUserId: 'user-1' });
    expect(got.files).toEqual([]);

    const paths = await listWorkspace(h, 'user-1', agentId);
    expect(paths.some((p) => p.startsWith('.ax/draft-skills/solo/'))).toBe(false);
  });

  it('threads requested packages into the promoted manifest; mcpServers stays empty', async () => {
    const h = await makeHarness();
    const agentId = await createPersonalAgent(h, 'user-1');
    await seedFile(
      h,
      '.ax/draft-skills/pkgskill/SKILL.md',
      '---\nname: pkgskill\ndescription: Package skill\nversion: 1\n---\nBody',
      'user-1',
      agentId,
      null,
    );

    const capture = captureSkillsUpsertYaml(h);

    const out = await h.bus.call<
      AgentsInstallAuthoredSkillInput,
      AgentsInstallAuthoredSkillOutput
    >('agents:install-authored-skill', ctx(agentId), {
      agentId,
      skillId: 'pkgskill',
      hosts: [],
      slots: [],
      packages: { npm: ['cowsay'], pypi: [] },
    });

    capture.restore();
    const capturedManifestYaml = capture.getYaml() ?? '';
    expect(out.packages).toEqual({ npm: ['cowsay'], pypi: [] });
    expect(capturedManifestYaml).toMatch(/^\s*packages:/m);
    expect(capturedManifestYaml).toContain('cowsay');
    expect(capturedManifestYaml).not.toMatch(/^\s*mcpServers:/m);
  });

  it('omits packages from the manifest when none requested (back-compat)', async () => {
    const h = await makeHarness();
    const agentId = await createPersonalAgent(h, 'user-1');
    await seedFile(
      h,
      '.ax/draft-skills/nopkg/SKILL.md',
      '---\nname: nopkg\ndescription: No packages skill\nversion: 1\n---\nBody',
      'user-1',
      agentId,
      null,
    );

    const capture = captureSkillsUpsertYaml(h);

    const out = await h.bus.call<
      AgentsInstallAuthoredSkillInput,
      AgentsInstallAuthoredSkillOutput
    >('agents:install-authored-skill', ctx(agentId), {
      agentId,
      skillId: 'nopkg',
      hosts: [],
      slots: [],
      // No packages field — tests back-compat with callers that don't pass it.
    });

    capture.restore();
    const capturedManifestYaml = capture.getYaml() ?? '';
    expect(out.packages).toEqual({ npm: [], pypi: [] });
    // The YAML key 'packages:' must be absent (the description may contain the word "packages").
    expect(capturedManifestYaml).not.toMatch(/^\s*packages:/m);
    expect(capturedManifestYaml).not.toMatch(/^\s*mcpServers:/m);
  });

  // BUG: agents frequently author a skill as a single FLAT FILE
  // `.ax/draft-skills/<id>.md` instead of the directory form `.ax/draft-skills/<id>/SKILL.md`.
  // The installer globbed only `.ax/draft-skills/<id>/**`, which can never match the
  // flat sibling — so install dead-ended on the misleading `authored-skill-not-
  // found` ("no authored skill 'linear' in the workspace") even though the agent
  // HAD authored it. We now accept the flat form as a fallback.
  it('accepts a flat-file draft (.ax/draft-skills/<id>.md) and retires it', async () => {
    const h = await makeHarness();
    const agentId = await createPersonalAgent(h, 'user-1');
    await seedFile(
      h,
      '.ax/draft-skills/flatlinear.md',
      '---\nname: flatlinear\ndescription: Flat linear skill\nversion: 1\n---\nBody',
      'user-1',
      agentId,
      null,
    );

    const out = await h.bus.call<
      AgentsInstallAuthoredSkillInput,
      AgentsInstallAuthoredSkillOutput
    >('agents:install-authored-skill', ctx(agentId), {
      agentId,
      skillId: 'flatlinear',
      hosts: ['api.linear.app'],
      slots: ['LINEAR_API_KEY'],
    });
    expect(out.description).toBe('Flat linear skill');

    // Upserted to the user store with no helper files (a flat skill has none).
    const got = await h.bus.call<
      { skillId: string; scope: 'user'; ownerUserId: string },
      { files: Array<{ path: string }> }
    >('skills:get', ctx(agentId), {
      skillId: 'flatlinear',
      scope: 'user',
      ownerUserId: 'user-1',
    });
    expect(got.files).toEqual([]);

    // The flat draft file is retired (the canonical copy is now the user store).
    const paths = await listWorkspace(h, 'user-1', agentId);
    expect(paths).not.toContain('.ax/draft-skills/flatlinear.md');
  });

  it('prefers the directory form when both <id>/SKILL.md and <id>.md exist', async () => {
    const h = await makeHarness();
    const agentId = await createPersonalAgent(h, 'user-1');
    const v1 = await seedFile(
      h,
      '.ax/draft-skills/dup/SKILL.md',
      '---\nname: dup\ndescription: Dir form\nversion: 1\n---\nDir body',
      'user-1',
      agentId,
      null,
    );
    await seedFile(
      h,
      '.ax/draft-skills/dup.md',
      '---\nname: dup\ndescription: Flat form\nversion: 1\n---\nFlat body',
      'user-1',
      agentId,
      v1,
    );

    const out = await h.bus.call<
      AgentsInstallAuthoredSkillInput,
      AgentsInstallAuthoredSkillOutput
    >('agents:install-authored-skill', ctx(agentId), {
      agentId,
      skillId: 'dup',
      hosts: [],
      slots: [],
    });
    // The directory form is canonical; it wins over the flat sibling.
    expect(out.description).toBe('Dir form');
  });

  it('refuses to promote a quarantined draft, surfacing the scan reason', async () => {
    const h = await makeHarness();
    const agentId = await createPersonalAgent(h, 'user-1');
    const SKILL_ID = 'quarskill';
    await seedFile(
      h,
      `.ax/draft-skills/${SKILL_ID}/SKILL.md`,
      `---\nname: ${SKILL_ID}\ndescription: Quarantined skill\nversion: 1\n---\nBody`,
      'user-1',
      agentId,
      null,
    );

    const REASON =
      'flagged by content safety scan (instruction-override): suspicious prompt detected';
    // Quarantine the skill via the real skills:quarantine-set service
    // (@ax/skills is loaded in the harness and registers this).
    await h.bus.call<
      { ownerUserId: string; agentId: string; skillId: string; reason: string },
      Record<string, never>
    >('skills:quarantine-set', ctx(agentId), {
      ownerUserId: 'user-1',
      agentId,
      skillId: SKILL_ID,
      reason: REASON,
    });

    const promise = h.bus.call<
      AgentsInstallAuthoredSkillInput,
      AgentsInstallAuthoredSkillOutput
    >('agents:install-authored-skill', ctx(agentId), {
      agentId,
      skillId: SKILL_ID,
      hosts: [],
      slots: [],
    });
    await expect(promise).rejects.toMatchObject({ code: 'skill-quarantined' });
    // End-to-end: the seeded scan reason (set → get → handler message) AND the
    // revise-and-retry guidance both reach the thrown message — the agent must
    // learn WHY so it can fix the SKILL.md body in place and re-run.
    await expect(promise).rejects.toThrow(/instruction-override/);
    await expect(promise).rejects.toThrow(/call install_authored_skill again/i);
  });
});
