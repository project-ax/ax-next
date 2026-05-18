import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { PluginError } from '@ax/core';
import { createSkillsPlugin } from '../plugin.js';
import { createAdminSkillsHandlers } from '../admin-routes.js';
import type { RouteRequest, RouteResponse } from '../admin-routes.js';

// ---------------------------------------------------------------------------
// /admin/skills* CRUD handler tests.
//
// We boot the skills plugin against a real postgres testcontainer (same
// pattern as plugin.test.ts — @ax/skills uses postgres-style DDL) and stub
// `auth:require-user` so we can drive the actor identity per case.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

// A well-formed SKILL.md (frontmatter fence + body).
const SAMPLE_SKILL_MD = `---
name: github
description: Access the GitHub REST API with a personal access token.
version: 1
capabilities:
  allowedHosts:
    - api.github.com
  credentials:
    - slot: GITHUB_TOKEN
      kind: api-key
      description: GitHub PAT.
---
# GitHub

GitHub skill body.
`;

// Same manifest but with an inline secret — should trigger inline-secret-forbidden.
const SECRET_SKILL_MD = `---
name: github
description: Access the GitHub REST API.
version: 1
apiKey: should-not-be-here
---
# GitHub
`;

// Manifest with mcpServers — should trigger capability-deferred.
const MCP_SKILL_MD = `---
name: github
description: Access the GitHub REST API.
version: 1
capabilities:
  mcpServers:
    - url: https://example.com
---
# GitHub
`;

// Malformed YAML — keys with duplicate colon.
const BAD_YAML_SKILL_MD = `---
name: github
description: : bad colon
---
# GitHub
`;

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

// Stub http:register-route — @ax/skills now declares this as a `calls` dep.
// In tests we don't boot http-server, so we provide a no-op that returns the
// unregister callback shape the plugin expects.
const httpRegisterRouteStub = async () => ({ unregister: () => {} });

async function makeHarness(opts: {
  authedUser?: { id: string; isAdmin: boolean };
  services?: Record<string, (ctx: unknown, input: unknown) => Promise<unknown>>;
} = {}): Promise<TestHarness> {
  const authedUser = opts.authedUser ?? { id: 'admin', isAdmin: true };
  const h = await createTestHarness({
    services: {
      'http:register-route': httpRegisterRouteStub,
      'auth:require-user': async () => ({ user: authedUser }),
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

describe('/admin/skills handlers', () => {
  // 1. POST with valid manifest → 201
  it('POST /admin/skills with valid manifest returns 201 + skillId', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus });
    const { res, statusOf, bodyOf } = mkRes();
    await handlers.create(mkReq({ body: { skillMd: SAMPLE_SKILL_MD } }), res);
    expect(statusOf()).toBe(201);
    expect(bodyOf()).toMatchObject({ skillId: 'github', created: true });
  });

  // 2. POST with malformed YAML body → 400
  it('POST /admin/skills with malformed YAML returns 400', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus });
    const { res, statusOf, bodyOf } = mkRes();
    await handlers.create(mkReq({ body: { skillMd: BAD_YAML_SKILL_MD } }), res);
    expect(statusOf()).toBe(400);
    expect((bodyOf() as { error: string }).error).toBeTruthy();
  });

  // 3. POST with inline secret → 400 inline-secret-forbidden
  it('POST /admin/skills with inline apiKey returns 400 inline-secret-forbidden', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus });
    const { res, statusOf, bodyOf } = mkRes();
    await handlers.create(mkReq({ body: { skillMd: SECRET_SKILL_MD } }), res);
    expect(statusOf()).toBe(400);
    const body = bodyOf() as { code: string };
    expect(body.code).toBe('inline-secret-forbidden');
  });

  // 4. POST with mcpServers → 400 capability-deferred
  it('POST /admin/skills with capabilities.mcpServers returns 400 capability-deferred', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus });
    const { res, statusOf, bodyOf } = mkRes();
    await handlers.create(mkReq({ body: { skillMd: MCP_SKILL_MD } }), res);
    expect(statusOf()).toBe(400);
    const body = bodyOf() as { code: string };
    expect(body.code).toBe('capability-deferred');
  });

  // 5. PUT with new body → 200, created: false, GET returns new body
  it('PUT /admin/skills/:id updates and returns 200 + created: false', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus });

    // Create first
    const { res: r1, statusOf: s1 } = mkRes();
    await handlers.create(mkReq({ body: { skillMd: SAMPLE_SKILL_MD } }), r1);
    expect(s1()).toBe(201);

    // Update
    const updatedSkillMd = SAMPLE_SKILL_MD.replace(
      '# GitHub\n\nGitHub skill body.\n',
      '# GitHub\n\nUpdated body.\n',
    );
    const { res: r2, statusOf: s2, bodyOf: b2 } = mkRes();
    await handlers.update(
      mkReq({ body: { skillMd: updatedSkillMd }, params: { id: 'github' } }),
      r2,
    );
    expect(s2()).toBe(200);
    expect((b2() as { created: boolean }).created).toBe(false);

    // Verify GET shows new body
    const { res: r3, statusOf: s3, bodyOf: b3 } = mkRes();
    await handlers.get(mkReq({ params: { id: 'github' } }), r3);
    expect(s3()).toBe(200);
    expect((b3() as { bodyMd: string }).bodyMd).toContain('Updated body.');
  });

  // 6. PUT where path id != manifest name → 400
  it('PUT /admin/skills/:id where path id != manifest name returns 400', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus });
    const { res, statusOf, bodyOf } = mkRes();
    await handlers.update(
      mkReq({ body: { skillMd: SAMPLE_SKILL_MD }, params: { id: 'wrong-id' } }),
      res,
    );
    expect(statusOf()).toBe(400);
    expect((bodyOf() as { error: string }).error).toMatch(/does not match manifest name/);
  });

  // 7. GET /admin/skills → returns { skills: [...] }
  it('GET /admin/skills returns skills array', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus });

    // Seed one skill
    const { res: r1 } = mkRes();
    await handlers.create(mkReq({ body: { skillMd: SAMPLE_SKILL_MD } }), r1);

    const { res, statusOf, bodyOf } = mkRes();
    await handlers.list(mkReq({}), res);
    expect(statusOf()).toBe(200);
    const body = bodyOf() as { skills: unknown[] };
    expect(Array.isArray(body.skills)).toBe(true);
    expect(body.skills).toHaveLength(1);
  });

  // 8. GET /admin/skills/:id → returns full detail
  it('GET /admin/skills/:id returns full detail with bodyMd and manifestYaml', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus });

    const { res: r1 } = mkRes();
    await handlers.create(mkReq({ body: { skillMd: SAMPLE_SKILL_MD } }), r1);

    const { res, statusOf, bodyOf } = mkRes();
    await handlers.get(mkReq({ params: { id: 'github' } }), res);
    expect(statusOf()).toBe(200);
    const body = bodyOf() as { id: string; bodyMd: string; manifestYaml: string };
    expect(body.id).toBe('github');
    expect(body.bodyMd).toContain('GitHub skill body');
    expect(body.manifestYaml).toContain('api.github.com');
  });

  // 9. GET /admin/skills/nonexistent → 404
  it('GET /admin/skills/nonexistent returns 404', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus });
    const { res, statusOf } = mkRes();
    await handlers.get(mkReq({ params: { id: 'nonexistent' } }), res);
    expect(statusOf()).toBe(404);
  });

  // 10. DELETE /admin/skills/:id (no attachments) → 204
  it('DELETE /admin/skills/:id with no attachments returns 204', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus });

    const { res: r1 } = mkRes();
    await handlers.create(mkReq({ body: { skillMd: SAMPLE_SKILL_MD } }), r1);

    const { res, statusOf } = mkRes();
    await handlers.destroy(mkReq({ params: { id: 'github' } }), res);
    expect(statusOf()).toBe(204);
  });

  // 11. DELETE with agents:any-attached-to-skill returning attached: true → 409
  it('DELETE /admin/skills/:id with attached agents returns 409 skill-in-use', async () => {
    const h = await createTestHarness({
      services: {
        'http:register-route': httpRegisterRouteStub,
        'auth:require-user': async () => ({ user: { id: 'admin', isAdmin: true } }),
        'agents:any-attached-to-skill': async () => ({ attached: true }),
      },
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        createSkillsPlugin(),
      ],
    });
    harnesses.push(h);

    const handlers = createAdminSkillsHandlers({ bus: h.bus });

    // Seed the skill
    const { res: r1 } = mkRes();
    await handlers.create(mkReq({ body: { skillMd: SAMPLE_SKILL_MD } }), r1);

    const { res, statusOf, bodyOf } = mkRes();
    await handlers.destroy(mkReq({ params: { id: 'github' } }), res);
    expect(statusOf()).toBe(409);
    expect((bodyOf() as { code: string }).code).toBe('skill-in-use');
  });

  // 12. Body over 64 KiB → 413
  it('POST /admin/skills with body > 64 KiB returns 413', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus });
    const { res, statusOf } = mkRes();
    const req = mkReq({});
    (req as { body: Buffer }).body = Buffer.alloc(65 * 1024);
    await handlers.create(req, res);
    expect(statusOf()).toBe(413);
  });

  // 13. Non-admin session → 403
  it('POST /admin/skills with non-admin user returns 403', async () => {
    const h = await makeHarness({ authedUser: { id: 'alice', isAdmin: false } });
    const handlers = createAdminSkillsHandlers({ bus: h.bus });
    const { res, statusOf } = mkRes();
    await handlers.create(mkReq({ body: { skillMd: SAMPLE_SKILL_MD } }), res);
    expect(statusOf()).toBe(403);
  });

  it('GET /admin/skills with non-admin user returns 403', async () => {
    const h = await makeHarness({ authedUser: { id: 'alice', isAdmin: false } });
    const handlers = createAdminSkillsHandlers({ bus: h.bus });
    const { res, statusOf } = mkRes();
    await handlers.list(mkReq({}), res);
    expect(statusOf()).toBe(403);
  });

  it('DELETE /admin/skills/:id with non-admin user returns 403', async () => {
    const h = await makeHarness({ authedUser: { id: 'alice', isAdmin: false } });
    const handlers = createAdminSkillsHandlers({ bus: h.bus });
    const { res, statusOf } = mkRes();
    await handlers.destroy(mkReq({ params: { id: 'github' } }), res);
    expect(statusOf()).toBe(403);
  });

  // 14. Missing auth → 401
  it('GET /admin/skills returns 401 when auth:require-user throws unauthenticated', async () => {
    const h = await createTestHarness({
      services: {
        'http:register-route': httpRegisterRouteStub,
        'auth:require-user': async () => {
          throw new PluginError({
            code: 'unauthenticated',
            plugin: 'test',
            message: 'no cookie',
          });
        },
      },
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        createSkillsPlugin(),
      ],
    });
    harnesses.push(h);
    const handlers = createAdminSkillsHandlers({ bus: h.bus });
    const { res, statusOf } = mkRes();
    await handlers.list(mkReq({}), res);
    expect(statusOf()).toBe(401);
  });

  // 15. POST body missing skillMd → 400
  it('POST /admin/skills with body missing skillMd returns 400', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus });
    const { res, statusOf } = mkRes();
    await handlers.create(mkReq({ body: {} }), res);
    expect(statusOf()).toBe(400);
  });

  // 16. POST body with extra fields → 400 (zod .strict())
  it('POST /admin/skills with extra unknown fields returns 400', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus });
    const { res, statusOf } = mkRes();
    await handlers.create(
      mkReq({ body: { skillMd: SAMPLE_SKILL_MD, extraField: 'oops' } }),
      res,
    );
    expect(statusOf()).toBe(400);
  });

  // 17. POST body where skillMd lacks frontmatter fence → 400 missing frontmatter fence
  it('POST /admin/skills with skillMd lacking frontmatter fence returns 400', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus });
    const { res, statusOf, bodyOf } = mkRes();
    await handlers.create(
      mkReq({ body: { skillMd: '# No frontmatter here\n\nJust a body.\n' } }),
      res,
    );
    expect(statusOf()).toBe(400);
    expect((bodyOf() as { error: string }).error).toBe('missing frontmatter fence');
  });
});
