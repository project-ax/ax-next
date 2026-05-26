/**
 * Tests for agents:install-authored-skill (TASK-39, open-mode flow C).
 *
 * The hook is the in-chat, user-approved analog of the admin
 * promoteAuthoredSkill flow: it reads the agent-authored draft under
 * `.ax/skills/<id>/` (capability-free — the validator strips caps at write
 * time), upserts a USER-scoped skill carrying the user-REQUESTED capabilities
 * (the tool args) WITH the bundle's helper files[], then retires the draft.
 *
 * Same multi-plugin testcontainer harness as promote-authored-skills.test.ts /
 * authored-skills.test.ts (real Postgres + createMockWorkspacePlugin). The mock
 * workspace is a SINGLE shared store keyed only on optimistic-concurrency
 * `parent`, so each test seeds + retires by chaining the version.
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

describe('agents:install-authored-skill', () => {
  it('upserts a user-scoped skill with the bundle files + requested caps, then retires the draft', async () => {
    const h = await makeHarness();
    const agentId = await createPersonalAgent(h, 'user-1');
    const v1 = await seedFile(
      h,
      '.ax/skills/notes/SKILL.md',
      '---\nname: notes\ndescription: Take notes\nversion: 1\n---\nBody',
      'user-1',
      agentId,
      null,
    );
    await seedFile(h, '.ax/skills/notes/scripts/run.py', 'print(1)', 'user-1', agentId, v1);

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

    // Draft retired: every .ax/skills/notes/* path is gone from the workspace.
    const paths = await listWorkspace(h, 'user-1', agentId);
    expect(paths.some((p) => p.startsWith('.ax/skills/notes/'))).toBe(false);
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
      '.ax/skills/solo/SKILL.md',
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
    expect(paths.some((p) => p.startsWith('.ax/skills/solo/'))).toBe(false);
  });
});
