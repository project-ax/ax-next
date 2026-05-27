import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { PluginError } from '@ax/core';
import type { Kysely } from 'kysely';
import { createSkillsPlugin } from '../plugin.js';
import { createAdminSkillsHandlers, writeServiceError } from '../admin-routes.js';
import type { RouteRequest, RouteResponse } from '../admin-routes.js';
import { createSkillsStore, type SkillsStore } from '../store.js';
import type { SkillsDatabase } from '../migrations.js';

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
  query?: Record<string, string>;
}): RouteRequest {
  return {
    headers: {},
    body:
      opts.body === undefined
        ? Buffer.alloc(0)
        : Buffer.from(JSON.stringify(opts.body)),
    cookies: {},
    query: opts.query ?? {},
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

// Build a real global store backed by the SAME db the booted plugin uses, so
// the store-injected PATCH path (TASK-57) can be exercised at the route layer.
// The store shares the plugin's tables (just a different ephemeral bundle repo,
// which is irrelevant for the flag-only toggle).
async function storeFor(h: TestHarness): Promise<SkillsStore> {
  const { db } = await h.bus.call<unknown, { db: Kysely<SkillsDatabase> }>(
    'database:get-instance',
    h.ctx(),
    {},
  );
  return createSkillsStore(db);
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

  // 4. POST with mcpServers → persists and round-trips through GET
  it('POST /admin/skills with capabilities.mcpServers persists and returns it on GET', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus });

    // Create
    const skillMd = `---\nname: ghub\ndescription: GitHub\ncapabilities:\n  mcpServers:\n    - name: github\n      transport: stdio\n      command: npx\n      args: ['-y', '@modelcontextprotocol/server-github']\n---\nbody`;
    const { res: r1, statusOf: s1 } = mkRes();
    await handlers.create(mkReq({ body: { skillMd } }), r1);
    expect(s1()).toBe(201);

    // GET
    const { res: r2, statusOf: s2, bodyOf: b2 } = mkRes();
    await handlers.get(mkReq({ params: { id: 'ghub' } }), r2);
    expect(s2()).toBe(200);
    const detail = b2() as { capabilities: { mcpServers: Array<{ name: string }> } };
    expect(detail.capabilities.mcpServers).toHaveLength(1);
    expect(detail.capabilities.mcpServers[0]?.name).toBe('github');
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

  // 9b. GET /admin/skills/nonexistent?missingOk=1 → 200 { skill: null }
  // The Admit-queue diff probe asks "is there a current catalog version?" for a
  // net-new share request. Without ?missingOk=1 the route 404s (correct REST),
  // and the browser auto-logs that expected 404 as a console error. With the
  // opt-in param the missing case is a clean 200 so the probe makes no noise.
  it('GET /admin/skills/nonexistent?missingOk=1 returns 200 { skill: null }', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus });
    const { res, statusOf, bodyOf } = mkRes();
    await handlers.get(
      mkReq({ params: { id: 'nonexistent' }, query: { missingok: '1' } }),
      res,
    );
    expect(statusOf()).toBe(200);
    expect(bodyOf()).toEqual({ skill: null });
  });

  // 9c. GET /admin/skills/:id?missingOk=1 on an EXISTING skill → 200 { skill: <detail> }
  it('GET /admin/skills/:id?missingOk=1 wraps an existing skill as { skill: detail }', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus });

    const { res: r1 } = mkRes();
    await handlers.create(mkReq({ body: { skillMd: SAMPLE_SKILL_MD } }), r1);

    const { res, statusOf, bodyOf } = mkRes();
    await handlers.get(
      mkReq({ params: { id: 'github' }, query: { missingok: '1' } }),
      res,
    );
    expect(statusOf()).toBe(200);
    const body = bodyOf() as { skill: { id: string; bodyMd: string } | null };
    expect(body.skill).not.toBeNull();
    expect(body.skill?.id).toBe('github');
    expect(body.skill?.bodyMd).toContain('GitHub skill body');
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

  // 18. POST with defaultAttached: true on credential-free manifest persists the flag
  it('POST /admin/skills with defaultAttached: true persists the flag', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus });
    const INSTRUCTION_ONLY = `---
name: greeter
description: Greets every agent at session start.
version: 1
---
# Greeter

When asked, say hi.
`;
    const { res, statusOf, bodyOf } = mkRes();
    await handlers.create(
      mkReq({ body: { skillMd: INSTRUCTION_ONLY, defaultAttached: true } }),
      res,
    );
    expect(statusOf()).toBe(201);
    expect(bodyOf()).toMatchObject({ skillId: 'greeter', created: true });

    // Confirm via the list-defaults hook that the flag is persisted.
    const { skills } = await h.bus.call<
      Record<string, never>,
      { skills: Array<{ id: string }> }
    >('skills:list-defaults', h.ctx(), {});
    expect(skills.map((s) => s.id)).toEqual(['greeter']);
  });

  // 19. POST with defaultAttached: true on a credentialed manifest → 400
  it('POST /admin/skills with defaultAttached: true on a credentialed manifest returns 400', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus });
    const { res, statusOf, bodyOf } = mkRes();
    await handlers.create(
      mkReq({ body: { skillMd: SAMPLE_SKILL_MD, defaultAttached: true } }),
      res,
    );
    expect(statusOf()).toBe(400);
    expect((bodyOf() as { code?: string }).code).toBe('default-attached-requires-no-credentials');
  });

  it('PUT /admin/skills/:id with defaultAttached: true persists the flag', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus });
    const INSTRUCTION_ONLY = `---
name: greeter
description: Greets every agent at session start.
version: 1
---
# Greeter
`;

    // Seed: create the skill first (no default flag).
    const { res: createRes, statusOf: createStatus } = mkRes();
    await handlers.create(mkReq({ body: { skillMd: INSTRUCTION_ONLY } }), createRes);
    expect(createStatus()).toBe(201);

    // Update with defaultAttached: true.
    const { res: updateRes, statusOf: updateStatus } = mkRes();
    await handlers.update(
      mkReq({
        params: { id: 'greeter' },
        body: { skillMd: INSTRUCTION_ONLY, defaultAttached: true },
      }),
      updateRes,
    );
    expect(updateStatus()).toBe(200);

    // skills:list-defaults should now report the skill.
    const out = await h.bus.call<
      Record<string, never>,
      { skills: Array<{ id: string }> }
    >('skills:list-defaults', h.ctx(), {});
    expect(out.skills.map((s) => s.id)).toEqual(['greeter']);
  });

  it('POST /admin/skills with sourceUrl persists it and reflects it on GET', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus });

    const skillMd = `---\nname: src\ndescription: src\nsourceUrl: https://example.com/src.md\n---\nbody`;
    const { res: r1, statusOf: s1 } = mkRes();
    await handlers.create(mkReq({ body: { skillMd } }), r1);
    expect(s1()).toBe(201);

    const { res: r2, statusOf: s2, bodyOf: b2 } = mkRes();
    await handlers.get(mkReq({ params: { id: 'src' } }), r2);
    expect(s2()).toBe(200);
    const detail = b2() as { sourceUrl?: string };
    expect(detail.sourceUrl).toBe('https://example.com/src.md');
  });

  it('PUT /admin/skills/:id clears sourceUrl when re-upserted without one', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus });

    // Create with sourceUrl
    await handlers.create(mkReq({ body: { skillMd: `---\nname: src2\ndescription: d\nsourceUrl: https://example.com/x.md\n---\nbody` } }), mkRes().res);

    // PUT without sourceUrl
    const { res: r2, statusOf: s2 } = mkRes();
    await handlers.update(mkReq({ body: { skillMd: `---\nname: src2\ndescription: d\n---\nupdated body` }, params: { id: 'src2' } }), r2);
    expect(s2()).toBe(200);

    const { res: r3, bodyOf: b3 } = mkRes();
    await handlers.get(mkReq({ params: { id: 'src2' } }), r3);
    const detail = b3() as { sourceUrl?: string };
    expect(detail.sourceUrl).toBeUndefined();
  });

  it('PUT /admin/skills/:id with defaultAttached: true on a credentialed manifest returns 400', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus });

    // Seed first (without the default flag).
    const { res: createRes, statusOf: createStatus } = mkRes();
    await handlers.create(mkReq({ body: { skillMd: SAMPLE_SKILL_MD } }), createRes);
    expect(createStatus()).toBe(201);

    // Update with defaultAttached: true on the credentialed manifest — should 400.
    const { res: updateRes, statusOf: updateStatus, bodyOf: updateBody } = mkRes();
    await handlers.update(
      mkReq({
        params: { id: 'github' },
        body: { skillMd: SAMPLE_SKILL_MD, defaultAttached: true },
      }),
      updateRes,
    );
    expect(updateStatus()).toBe(400);
    expect((updateBody() as { code?: string }).code).toBe(
      'default-attached-requires-no-credentials',
    );
  });

  it('POST /admin/skills/:id/check-update returns the hook output (no sourceUrl → available:false)', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus });

    // Create a skill with NO sourceUrl
    const skillMd = `---\nname: nosrc\ndescription: nosrc\nversion: 1\n---\nbody`;
    await handlers.create(mkReq({ body: { skillMd } }), mkRes().res);

    const { res, statusOf, bodyOf } = mkRes();
    await handlers.checkUpdate(mkReq({ params: { id: 'nosrc' } }), res);
    expect(statusOf()).toBe(200);
    const body = bodyOf() as { available: boolean; currentVersion: number };
    expect(body.available).toBe(false);
    expect(body.currentVersion).toBe(1);
  });

  it('POST /admin/skills/:id/check-update returns 404 when skill does not exist', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus });
    const { res, statusOf } = mkRes();
    await handlers.checkUpdate(mkReq({ params: { id: 'missing' } }), res);
    expect(statusOf()).toBe(404);
  });

  it('POST /admin/skills/:id/refresh-from-source returns updated:false when sourceUrl is not set', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus });

    const skillMd = `---\nname: nosrc2\ndescription: nosrc\nversion: 1\n---\nbody`;
    await handlers.create(mkReq({ body: { skillMd } }), mkRes().res);

    const { res, statusOf, bodyOf } = mkRes();
    await handlers.refresh(mkReq({ params: { id: 'nosrc2' } }), res);
    expect(statusOf()).toBe(200);
    const body = bodyOf() as { updated: boolean; currentVersion: number };
    expect(body.updated).toBe(false);
    expect(body.currentVersion).toBe(1);
  });

  it('POST /admin/skills/:id/check-update reports an upgrade when remote version > current', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus });

    // Create a skill with a sourceUrl
    const skillMd = `---\nname: src3\ndescription: d\nversion: 1\nsourceUrl: https://example.com/src3.md\n---\nbody`;
    await handlers.create(mkReq({ body: { skillMd } }), mkRes().res);

    const remoteBody = `---\nname: src3\ndescription: d\nversion: 5\n---\nnew body`;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(remoteBody, { status: 200 }),
    );
    try {
      const { res, statusOf, bodyOf } = mkRes();
      await handlers.checkUpdate(mkReq({ params: { id: 'src3' } }), res);
      expect(statusOf()).toBe(200);
      const body = bodyOf() as { available: boolean; latestVersion?: number };
      expect(body.available).toBe(true);
      expect(body.latestVersion).toBe(5);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('POST /admin/skills/:id/refresh-from-source upserts when available', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus });

    const skillMd = `---\nname: src4\ndescription: d\nversion: 1\nsourceUrl: https://example.com/src4.md\n---\nbody v1`;
    await handlers.create(mkReq({ body: { skillMd } }), mkRes().res);

    const remoteBody = `---\nname: src4\ndescription: d\nversion: 2\nsourceUrl: https://example.com/src4.md\n---\nbody v2`;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(remoteBody, { status: 200 }),
    );
    try {
      const { res, statusOf, bodyOf } = mkRes();
      await handlers.refresh(mkReq({ params: { id: 'src4' } }), res);
      expect(statusOf()).toBe(200);
      expect((bodyOf() as { updated: boolean }).updated).toBe(true);

      // GET reflects the new body + version
      const { res: r2, bodyOf: b2 } = mkRes();
      await handlers.get(mkReq({ params: { id: 'src4' } }), r2);
      const detail = b2() as { version: number; bodyMd: string };
      expect(detail.version).toBe(2);
      expect(detail.bodyMd).toContain('body v2');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // -------------------------------------------------------------------------
  // TASK-45: derived tier, bundle-preserving PATCH, PUT file preservation.
  // -------------------------------------------------------------------------

  it('list annotates each skill with a derived tier', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus });

    // A 'bounded' skill (declares an allowed host, no packages).
    await h.bus.call('skills:upsert', h.ctx(), {
      manifestYaml:
        'name: gh\ndescription: GitHub.\nversion: 1\ncapabilities:\n  allowedHosts:\n    - api.github.com\n',
      bodyMd: '# gh\n',
      scope: 'global',
    });

    const { res, statusOf, bodyOf } = mkRes();
    await handlers.list(mkReq({}), res);
    expect(statusOf()).toBe(200);
    const body = bodyOf() as { skills: Array<{ id: string; tier: string }> };
    expect(body.skills.find((s) => s.id === 'gh')?.tier).toBe('bounded');
  });

  it('PATCH flips defaultAttached and preserves the bundle extra files', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus });

    // Seed a bundled skill (extra file) with defaultAttached false. Bundles
    // can't be created via the POST route (SKILL.md-only), so seed via the bus.
    await h.bus.call('skills:upsert', h.ctx(), {
      manifestYaml: 'name: helper\ndescription: A helper.\nversion: 1\n',
      bodyMd: '# helper\n',
      files: [{ path: 'scripts/run.py', contents: 'print(1)' }],
      scope: 'global',
    });

    const { res, statusOf } = mkRes();
    await handlers.setDefaultAttached(
      mkReq({ params: { id: 'helper' }, body: { defaultAttached: true } }),
      res,
    );
    expect(statusOf()).toBe(200);

    const detail = await h.bus.call<
      { skillId: string; scope: 'global' },
      { defaultAttached: boolean; files: Array<{ path: string; contents: string }> }
    >('skills:get', h.ctx(), { skillId: 'helper', scope: 'global' });
    expect(detail.defaultAttached).toBe(true);
    expect(detail.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]);
  });

  it('PATCH on a credential-bearing skill is rejected 400 (cannot be default)', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus });
    await h.bus.call('skills:upsert', h.ctx(), {
      manifestYaml:
        'name: gh\ndescription: GitHub.\nversion: 1\ncapabilities:\n  credentials:\n    - slot: GITHUB_TOKEN\n      kind: api-key\n',
      bodyMd: '# gh\n',
      scope: 'global',
    });
    const { res, statusOf, bodyOf } = mkRes();
    await handlers.setDefaultAttached(
      mkReq({ params: { id: 'gh' }, body: { defaultAttached: true } }),
      res,
    );
    expect(statusOf()).toBe(400);
    expect((bodyOf() as { code?: string }).code).toBe('default-attached-requires-no-credentials');
  });

  it('PATCH on an unknown id is 404', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus });
    const { res, statusOf } = mkRes();
    await handlers.setDefaultAttached(
      mkReq({ params: { id: 'nope' }, body: { defaultAttached: true } }),
      res,
    );
    expect(statusOf()).toBe(404);
  });

  // -------------------------------------------------------------------------
  // TASK-57: PATCH via the injected store's ATOMIC partial-update.
  // -------------------------------------------------------------------------
  it('PATCH (store path) flips defaultAttached and preserves the bundle extra files', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus, store: await storeFor(h) });

    await h.bus.call('skills:upsert', h.ctx(), {
      manifestYaml: 'name: helper\ndescription: A helper.\nversion: 1\n',
      bodyMd: '# helper\n',
      files: [{ path: 'scripts/run.py', contents: 'print(1)' }],
      scope: 'global',
    });

    const { res, statusOf, bodyOf } = mkRes();
    await handlers.setDefaultAttached(
      mkReq({ params: { id: 'helper' }, body: { defaultAttached: true } }),
      res,
    );
    expect(statusOf()).toBe(200);
    expect(bodyOf()).toMatchObject({ skillId: 'helper', defaultAttached: true });

    const detail = await h.bus.call<
      { skillId: string; scope: 'global' },
      { defaultAttached: boolean; files: Array<{ path: string; contents: string }> }
    >('skills:get', h.ctx(), { skillId: 'helper', scope: 'global' });
    expect(detail.defaultAttached).toBe(true);
    expect(detail.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]);
  });

  it('PATCH (store path) does not clobber a concurrent SKILL.md edit (the race the card fixes)', async () => {
    const h = await makeHarness();
    const store = await storeFor(h);
    const handlers = createAdminSkillsHandlers({ bus: h.bus, store });

    // Seed an instruction-only skill.
    await h.bus.call('skills:upsert', h.ctx(), {
      manifestYaml: 'name: helper\ndescription: original.\nversion: 1\n',
      bodyMd: '# original body\n',
      scope: 'global',
    });

    // A SKILL.md edit lands (new body + bumped version). The OLD read-then-write
    // PATCH path would, on a stale read, re-write the body back to the original.
    await h.bus.call('skills:upsert', h.ctx(), {
      manifestYaml: 'name: helper\ndescription: edited.\nversion: 2\n',
      bodyMd: '# EDITED body\n',
      scope: 'global',
    });

    // Now flip the default flag. The atomic primitive touches only the flag.
    const { res, statusOf } = mkRes();
    await handlers.setDefaultAttached(
      mkReq({ params: { id: 'helper' }, body: { defaultAttached: true } }),
      res,
    );
    expect(statusOf()).toBe(200);

    const detail = await h.bus.call<
      { skillId: string; scope: 'global' },
      { defaultAttached: boolean; bodyMd: string; version: number }
    >('skills:get', h.ctx(), { skillId: 'helper', scope: 'global' });
    expect(detail.defaultAttached).toBe(true);
    expect(detail.bodyMd).toBe('# EDITED body\n'); // edit survived
    expect(detail.version).toBe(2);
  });

  it('PATCH (store path) on a credential-bearing skill is rejected 400', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus, store: await storeFor(h) });
    await h.bus.call('skills:upsert', h.ctx(), {
      manifestYaml:
        'name: gh\ndescription: GitHub.\nversion: 1\ncapabilities:\n  credentials:\n    - slot: GITHUB_TOKEN\n      kind: api-key\n',
      bodyMd: '# gh\n',
      scope: 'global',
    });
    const { res, statusOf, bodyOf } = mkRes();
    await handlers.setDefaultAttached(
      mkReq({ params: { id: 'gh' }, body: { defaultAttached: true } }),
      res,
    );
    expect(statusOf()).toBe(400);
    expect((bodyOf() as { code?: string }).code).toBe('default-attached-requires-no-credentials');
  });

  it('PATCH (store path) on an unknown id is 404', async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus, store: await storeFor(h) });
    const { res, statusOf } = mkRes();
    await handlers.setDefaultAttached(
      mkReq({ params: { id: 'nope' }, body: { defaultAttached: true } }),
      res,
    );
    expect(statusOf()).toBe(404);
  });

  it('PATCH (store path) via the booted plugin route uses the atomic primitive end to end', async () => {
    // The production wiring (plugin.ts → registerAdminSkillsRoutes(bus, ctx,
    // store)) injects the store. Capture the handler the route registers and
    // confirm it flips the flag without a body round-trip clobber.
    const captured: Array<{
      handler: (req: RouteRequest, res: RouteResponse) => Promise<void>;
      method: string;
      path: string;
    }> = [];
    const h = await createTestHarness({
      services: {
        'http:register-route': async (_ctx, input) => {
          const route = input as {
            method: string;
            path: string;
            handler: (req: RouteRequest, res: RouteResponse) => Promise<void>;
          };
          captured.push(route);
          return { unregister: () => {} };
        },
        'auth:require-user': async () => ({ user: { id: 'admin', isAdmin: true } }),
      },
      plugins: [createDatabasePostgresPlugin({ connectionString }), createSkillsPlugin()],
    });
    harnesses.push(h);

    await h.bus.call('skills:upsert', h.ctx(), {
      manifestYaml: 'name: helper\ndescription: d.\nversion: 1\n',
      bodyMd: '# body\n',
      scope: 'global',
    });

    const patch = captured.find((r) => r.method === 'PATCH' && r.path === '/admin/skills/:id');
    expect(patch).toBeDefined();

    const { res, statusOf } = mkRes();
    await patch!.handler(
      mkReq({ params: { id: 'helper' }, body: { defaultAttached: true } }),
      res,
    );
    expect(statusOf()).toBe(200);

    const detail = await h.bus.call<
      { skillId: string; scope: 'global' },
      { defaultAttached: boolean }
    >('skills:get', h.ctx(), { skillId: 'helper', scope: 'global' });
    expect(detail.defaultAttached).toBe(true);
  });

  it("PUT preserves a bundle's extra files when only SKILL.md is edited", async () => {
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus });

    await h.bus.call('skills:upsert', h.ctx(), {
      manifestYaml: 'name: helper\ndescription: A helper.\nversion: 1\n',
      bodyMd: '# helper\n',
      files: [{ path: 'scripts/run.py', contents: 'print(1)' }],
      scope: 'global',
    });

    const editedSkillMd =
      '---\nname: helper\ndescription: A helper (edited).\nversion: 2\n---\n# helper edited\n';
    const { res, statusOf } = mkRes();
    await handlers.update(mkReq({ params: { id: 'helper' }, body: { skillMd: editedSkillMd } }), res);
    expect(statusOf()).toBe(200);

    const detail = await h.bus.call<
      { skillId: string; scope: 'global' },
      { description: string; files: Array<{ path: string; contents: string }> }
    >('skills:get', h.ctx(), { skillId: 'helper', scope: 'global' });
    expect(detail.description).toBe('A helper (edited).');
    expect(detail.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]); // NOT wiped
  });

  it('PUT with a name not matching the path id is 400 and copies no files', async () => {
    // A manifest whose `name` differs from the path id must be rejected and
    // must NOT promote/copy the path id's bundle onto the parsed id. (Regression
    // for the metadata-only-save / name-mismatch file-copy edge.)
    const h = await makeHarness();
    const handlers = createAdminSkillsHandlers({ bus: h.bus });
    await h.bus.call('skills:upsert', h.ctx(), {
      manifestYaml: 'name: helper\ndescription: A helper.\nversion: 1\n',
      bodyMd: '# helper\n',
      files: [{ path: 'scripts/run.py', contents: 'print(1)' }],
      scope: 'global',
    });

    const { res, statusOf, bodyOf } = mkRes();
    const mismatched = '---\nname: somethingelse\ndescription: x\nversion: 2\n---\n# x\n';
    await handlers.update(mkReq({ params: { id: 'helper' }, body: { skillMd: mismatched } }), res);
    expect(statusOf()).toBe(400);
    expect((bodyOf() as { error?: string }).error).toMatch(/does not match/i);
    // The would-be target id must not have been created (no file copy).
    await expect(
      h.bus.call('skills:get', h.ctx(), { skillId: 'somethingelse', scope: 'global' }),
    ).rejects.toThrow();
  });

  it('maps catalog admit error codes to HTTP statuses', () => {
    const cases: Array<[string, number]> = [
      ['request-not-found', 404],
      ['request-already-decided', 409],
      ['cold-start-not-promotable', 400],
      ['invalid-bundle-file', 400],
    ];
    for (const [code, status] of cases) {
      const { res, statusOf } = mkRes();
      const handled = writeServiceError(
        res,
        new PluginError({ code, plugin: '@ax/skills', message: 'x' }),
      );
      expect(handled).toBe(true);
      expect(statusOf()).toBe(status);
    }
  });
});
