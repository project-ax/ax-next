/**
 * Tests for POST /admin/agents/:id/authored-skills/promote (Phase E step 2).
 *
 * Uses the same multi-plugin harness as authored-skills.test.ts. The mock
 * workspace plugin is a SINGLE shared store — ctx only affects delta.author
 * metadata, not routing. Each test uses a fresh harness for isolation.
 *
 * Key invariant under test: admin-supplied capability grants REPLACE the
 * authored file's declared capabilities (half-trust). A skill authored with
 * `allowedHosts: [evil.com]` promoted with `grants.allowedHosts: ['api.foo.com']`
 * MUST result in `allowedHosts: ['api.foo.com']` — not 'evil.com'.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  createTestHarness,
  createMockWorkspacePlugin,
  mockBlobStoreServices,
  type TestHarness,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { makeAgentContext } from '@ax/core';
import { createSkillsPlugin } from '@ax/skills';
import { createAgentsPlugin } from '../plugin.js';
import { createAdminAgentRouteHandlers } from '../admin-routes.js';
import type { RouteRequest, RouteResponse } from '../admin-routes.js';
import type { CreateInput, CreateOutput } from '../types.js';

// ---------------------------------------------------------------------------
// Testcontainer setup
// ---------------------------------------------------------------------------

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
  const closeErrors: unknown[] = [];
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    await h.close({ onError: (_pluginName, e) => { closeErrors.push(e); } });
  }
  const cleanup = new (await import('pg')).default.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS agents_v1_agents');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_user_skills');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_skills');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_authored');
    await cleanup.query('DROP TABLE IF EXISTS agents_v1_skill_attachments');
  } finally {
    await cleanup.end();
  }
  if (closeErrors.length > 0) throw new AggregateError(closeErrors, 'Harness teardown failed');
});

// ---------------------------------------------------------------------------
// Harness factory
// ---------------------------------------------------------------------------

/** Actor to return from auth:require-user. Overridden per test. */
type AuthActor = { id: string; isAdmin: boolean };

async function makeHarness(authActor: AuthActor): Promise<TestHarness> {
  const h = await createTestHarness({
    services: {
      ...mockBlobStoreServices(),
      'http:register-route': async () => ({ unregister: () => {} }),
      'auth:require-user': async () => ({ user: authActor }),
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

// ---------------------------------------------------------------------------
// mkReq / mkRes helpers (same pattern as skills' admin-routes.test.ts)
// ---------------------------------------------------------------------------

function mkRes(): {
  res: RouteResponse;
  statusOf: () => number;
  bodyOf: () => unknown;
} {
  let _status = 200;
  let _body: unknown = undefined;
  const res: RouteResponse = {
    status(n: number) {
      _status = n;
      return res;
    },
    json(v: unknown) {
      _body = v;
    },
    text(s: string) {
      _body = s;
    },
    end() {},
  };
  return { res, statusOf: () => _status, bodyOf: () => _body };
}

function mkReq(opts: {
  body?: unknown;
  params?: Record<string, string>;
}): RouteRequest {
  return {
    headers: {},
    body:
      opts.body === undefined
        ? Buffer.alloc(0)
        : Buffer.from(JSON.stringify(opts.body)),
    cookies: {},
    query: {},
    params: opts.params ?? {},
    signedCookie: () => null,
  };
}

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------

async function createPersonalAgent(
  h: TestHarness,
  userId: string,
): Promise<string> {
  const out = await h.bus.call<CreateInput, CreateOutput>(
    'agents:create',
    h.ctx({ userId }),
    {
      actor: { userId, isAdmin: false },
      input: {
        displayName: 'Test Agent',
        systemPrompt: 'You are helpful.',
        allowedTools: [],
        mcpConfigIds: [],
        model: 'claude-opus-4-7',
        visibility: 'personal',
      },
    },
  );
  return out.agent.id;
}

/**
 * Seed an authored skill the TASK-74 way: propose it through `skills:propose`,
 * which writes the `skills_v1_authored` row that `agents:list-authored-skills`
 * (the admin promote reader) now reads. (The retired `seedFile` wrote a
 * `.ax/draft-skills` git file that the workspace scan used to pick up.) `caps`
 * (a frontmatter capabilities block, e.g. `allowedHosts`) sends the proposal to
 * `pending`, but the promote reader surfaces every non-deleted status — and the
 * promote route replaces the file's caps with admin grants anyway.
 */
async function seedAuthored(
  h: TestHarness,
  id: string,
  ownerUserId: string,
  agentId: string,
  opts: { allowedHosts?: string[] } = {},
): Promise<void> {
  const capBlock =
    opts.allowedHosts && opts.allowedHosts.length > 0
      ? `\ncapabilities:\n  allowedHosts:\n${opts.allowedHosts.map((host) => `    - ${host}`).join('\n')}`
      : '';
  const manifestYaml = `name: ${id}\ndescription: A skill called ${id}\nversion: 1${capBlock}`;
  const ctx = makeAgentContext({ userId: ownerUserId, agentId, sessionId: 'test-seed' });
  await h.bus.call('skills:propose', ctx, {
    ownerUserId,
    agentId,
    manifestYaml,
    bodyMd: `# ${id}\nThis is the skill body.`,
    files: [],
    capabilityProposal: {
      allowedHosts: [],
      credentials: [],
      mcpServers: [],
      packages: { npm: [], pypi: [] },
    },
    origin: 'authored',
  });
}

/** GET the installed skill from the skills plugin. */
async function getInstalledSkill(
  h: TestHarness,
  skillId: string,
  scope: 'global' | 'user',
  ownerUserId?: string,
): Promise<unknown> {
  return h.bus.call<
    { skillId: string; scope: 'global' | 'user'; ownerUserId?: string },
    unknown
  >('skills:get', h.ctx(), { skillId, scope, ownerUserId });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /admin/agents/:id/authored-skills/promote', () => {
  it('non-admin actor → 403 forbidden', async () => {
    // Non-admin user trying to promote.
    const h = await makeHarness({ id: 'alice', isAdmin: false });
    const handlers = createAdminAgentRouteHandlers({ bus: h.bus });
    const agentId = await createPersonalAgent(h, 'alice');

    const { res, statusOf, bodyOf } = mkRes();
    await handlers.promoteAuthoredSkill(
      mkReq({
        params: { id: agentId },
        body: {
          skillId: 'foo',
          targetScope: 'global',
          grants: { allowedHosts: [], credentials: [], mcpServers: [] },
        },
      }),
      res,
    );

    expect(statusOf()).toBe(403);
    expect((bodyOf() as { error: string }).error).toBe('forbidden');
  });

  it('promote clean authored skill to global scope → 200; skills:get returns it with admin grants', async () => {
    const h = await makeHarness({ id: 'admin', isAdmin: true });
    const handlers = createAdminAgentRouteHandlers({ bus: h.bus });
    const agentId = await createPersonalAgent(h, 'alice');

    // Seed the authored skill (no capabilities in the file).
    await seedAuthored(h, 'foo', 'alice', agentId);

    const { res, statusOf, bodyOf } = mkRes();
    await handlers.promoteAuthoredSkill(
      mkReq({
        params: { id: agentId },
        body: {
          skillId: 'foo',
          targetScope: 'global',
          grants: {
            allowedHosts: ['api.foo.com'],
            credentials: [],
            mcpServers: [],
          },
        },
      }),
      res,
    );

    expect(statusOf()).toBe(200);
    expect(bodyOf()).toMatchObject({
      promoted: true,
      skillId: 'foo',
      targetScope: 'global',
    });

    // Verify the skill landed in the global store with admin-supplied hosts.
    const skill = (await getInstalledSkill(h, 'foo', 'global')) as {
      capabilities: { allowedHosts: string[] };
    };
    expect(skill.capabilities.allowedHosts).toEqual(['api.foo.com']);
  });

  it('authored file WITH capabilities → promote with different grants → resulting skill uses admin grants, NOT authored file caps', async () => {
    const h = await makeHarness({ id: 'admin', isAdmin: true });
    const handlers = createAdminAgentRouteHandlers({ bus: h.bus });
    const agentId = await createPersonalAgent(h, 'alice');

    // Authored file declares allowedHosts: [evil.com].
    await seedAuthored(h, 'foo', 'alice', agentId, { allowedHosts: ['api.evil.com'] });

    const { res, statusOf } = mkRes();
    await handlers.promoteAuthoredSkill(
      mkReq({
        params: { id: agentId },
        body: {
          skillId: 'foo',
          targetScope: 'global',
          grants: {
            allowedHosts: ['api.foo.com'],
            credentials: [],
            mcpServers: [],
          },
        },
      }),
      res,
    );

    expect(statusOf()).toBe(200);

    // Admin grants must win — 'api.evil.com' must NOT appear.
    const skill = (await getInstalledSkill(h, 'foo', 'global')) as {
      capabilities: { allowedHosts: string[] };
    };
    expect(skill.capabilities.allowedHosts).toEqual(['api.foo.com']);
    expect(skill.capabilities.allowedHosts).not.toContain('api.evil.com');
  });

  it('missing authored skill id → 404 authored-skill-not-found', async () => {
    const h = await makeHarness({ id: 'admin', isAdmin: true });
    const handlers = createAdminAgentRouteHandlers({ bus: h.bus });
    const agentId = await createPersonalAgent(h, 'alice');

    // No SKILL.md seeded.
    const { res, statusOf, bodyOf } = mkRes();
    await handlers.promoteAuthoredSkill(
      mkReq({
        params: { id: agentId },
        body: {
          skillId: 'nonexistent',
          targetScope: 'global',
          grants: { allowedHosts: [], credentials: [], mcpServers: [] },
        },
      }),
      res,
    );

    expect(statusOf()).toBe(404);
    expect((bodyOf() as { error: string }).error).toBe('authored-skill-not-found');
  });

  it('targetScope:user on personal agent → skill lands in user scope under agent owner', async () => {
    const h = await makeHarness({ id: 'admin', isAdmin: true });
    const handlers = createAdminAgentRouteHandlers({ bus: h.bus });
    const agentId = await createPersonalAgent(h, 'alice');

    await seedAuthored(h, 'foo', 'alice', agentId);

    const { res, statusOf, bodyOf } = mkRes();
    await handlers.promoteAuthoredSkill(
      mkReq({
        params: { id: agentId },
        body: {
          skillId: 'foo',
          targetScope: 'user',
          grants: {
            allowedHosts: ['api.foo.com'],
            credentials: [],
            mcpServers: [],
          },
        },
      }),
      res,
    );

    expect(statusOf()).toBe(200);
    expect((bodyOf() as { targetScope: string }).targetScope).toBe('user');

    // Skill must be in user scope under alice, NOT global.
    const userSkill = (await getInstalledSkill(h, 'foo', 'user', 'alice')) as {
      capabilities: { allowedHosts: string[] };
      scope: string;
    };
    expect(userSkill.scope).toBe('user');
    expect(userSkill.capabilities.allowedHosts).toEqual(['api.foo.com']);
  });

  it('targetScope:user on team agent → 400 team-agent-user-scope-unsupported', async () => {
    // Use teams:is-member stub to create a team agent.
    const h = await createTestHarness({
      services: {
        ...mockBlobStoreServices(),
        'http:register-route': async () => ({ unregister: () => {} }),
        'auth:require-user': async () => ({ user: { id: 'admin', isAdmin: true } }),
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

    const handlers = createAdminAgentRouteHandlers({ bus: h.bus });

    const { res, statusOf, bodyOf } = mkRes();
    await handlers.promoteAuthoredSkill(
      mkReq({
        params: { id: teamAgentId },
        body: {
          skillId: 'foo',
          targetScope: 'user',
          grants: { allowedHosts: [], credentials: [], mcpServers: [] },
        },
      }),
      res,
    );

    expect(statusOf()).toBe(400);
    expect((bodyOf() as { error: string }).error).toBe('team-agent-user-scope-unsupported');
  });

  it('GET /admin/agents/:id/authored-skills non-admin → 403', async () => {
    const h = await makeHarness({ id: 'alice', isAdmin: false });
    const handlers = createAdminAgentRouteHandlers({ bus: h.bus });
    const agentId = await createPersonalAgent(h, 'alice');

    const { res, statusOf } = mkRes();
    await handlers.listAuthoredSkills(
      mkReq({ params: { id: agentId } }),
      res,
    );

    expect(statusOf()).toBe(403);
  });

  it('GET /admin/agents/:id/authored-skills admin → 200 with skills list', async () => {
    const h = await makeHarness({ id: 'admin', isAdmin: true });
    const handlers = createAdminAgentRouteHandlers({ bus: h.bus });
    const agentId = await createPersonalAgent(h, 'alice');

    await seedAuthored(h, 'bar', 'alice', agentId);

    const { res, statusOf, bodyOf } = mkRes();
    await handlers.listAuthoredSkills(
      mkReq({ params: { id: agentId } }),
      res,
    );

    expect(statusOf()).toBe(200);
    const body = bodyOf() as { skills: Array<{ id: string }> };
    expect(body.skills).toHaveLength(1);
    expect(body.skills[0]!.id).toBe('bar');
  });
});
