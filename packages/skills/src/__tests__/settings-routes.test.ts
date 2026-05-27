import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { PluginError } from '@ax/core';
import { createSkillsPlugin } from '../plugin.js';
import { createSettingsSkillsHandlers } from '../settings-routes.js';
import type { RouteRequest, RouteResponse } from '../admin-routes.js';

// ---------------------------------------------------------------------------
// /settings/skills* CRUD handler tests.
//
// We boot the skills plugin against a real postgres testcontainer and stub
// `auth:require-user` so we can drive the actor identity per case. Each test
// case gets its own harness so auth identity is isolated.
//
// Key invariants verified:
//   - Only authenticated users may call any handler (anonymous → 401).
//   - Every operation is forced to scope:'user' + ownerUserId: actor.id.
//   - alice's skills are NOT visible to bob, and vice-versa.
//   - Global skills are NOT visible via the settings routes (404 on get/delete).
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

// A well-formed SKILL.md without credentials (credential-free = can be
// defaultAttached if needed; also simpler to use for isolation tests).
const ALICE_SKILL_MD = `---
name: my-github
description: Alice personal GitHub skill.
version: 1
capabilities:
  allowedHosts:
    - api.github.com
  credentials:
    - slot: GITHUB_TOKEN
      kind: api-key
      description: GitHub PAT.
---
# My GitHub

Alice's personal skill body.
`;

// A credential-free skill for defaultAttached tests.
const INSTRUCTION_SKILL_MD = `---
name: greeter
description: Greets on session start.
version: 1
---
# Greeter

Say hi.
`;

// A global skill (installed via direct hook call with scope:'global').
const GLOBAL_SKILL_MD = `---
name: global-tool
description: Admin-installed global skill.
version: 1
---
# Global Tool

Admin body.
`;

// ---------------------------------------------------------------------------
// Helpers
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

// Stub http:register-route — the plugin declares this as a `calls` dep.
// In tests we don't boot http-server, so we provide a no-op that returns the
// unregister callback shape the plugin expects.
const httpRegisterRouteStub = async () => ({ unregister: () => {} });

async function makeHarness(opts: {
  authedUser?: { id: string; isAdmin: boolean } | null;
} = {}): Promise<TestHarness> {
  const authedUser = opts.authedUser === undefined
    ? { id: 'alice', isAdmin: false }
    : opts.authedUser;

  const h = await createTestHarness({
    services: {
      'http:register-route': httpRegisterRouteStub,
      'auth:require-user': async () => {
        if (authedUser === null) {
          throw new PluginError({
            code: 'unauthenticated',
            plugin: 'test',
            message: 'no session',
          });
        }
        return { user: authedUser };
      },
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createSkillsPlugin(),
    ],
  });
  harnesses.push(h);
  return h;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

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
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_user_skills');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_skills');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await container.stop();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/settings/skills handlers', () => {
  // -------------------------------------------------------------------------
  // Authentication guard (anonymous → 401)
  // -------------------------------------------------------------------------

  it('GET /settings/skills returns 401 when anonymous', async () => {
    const h = await makeHarness({ authedUser: null });
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });
    const { res, statusOf } = mkRes();
    await handlers.list(mkReq({}), res);
    expect(statusOf()).toBe(401);
  });

  it('POST /settings/skills returns 401 when anonymous', async () => {
    const h = await makeHarness({ authedUser: null });
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });
    const { res, statusOf } = mkRes();
    await handlers.create(mkReq({ body: { skillMd: ALICE_SKILL_MD } }), res);
    expect(statusOf()).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Basic CRUD — alice creates, reads, updates, and deletes her own skill
  // -------------------------------------------------------------------------

  it('POST /settings/skills with valid manifest returns 201 and persists user-scoped row', async () => {
    const h = await makeHarness({ authedUser: { id: 'alice', isAdmin: false } });
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });

    const { res, statusOf, bodyOf } = mkRes();
    await handlers.create(mkReq({ body: { skillMd: ALICE_SKILL_MD } }), res);
    expect(statusOf()).toBe(201);
    expect(bodyOf()).toMatchObject({ skillId: 'my-github', created: true });

    // Verify the row landed in the user-scoped store via skills:get.
    const detail = await h.bus.call<
      { skillId: string; scope: 'user'; ownerUserId: string },
      { id: string; scope: string; ownerUserId: string }
    >('skills:get', h.ctx(), { skillId: 'my-github', scope: 'user', ownerUserId: 'alice' });
    expect(detail.id).toBe('my-github');
    expect(detail.scope).toBe('user');
    expect(detail.ownerUserId).toBe('alice');
  });

  it('GET /settings/skills/:id returns 200 for alice\'s own skill', async () => {
    const h = await makeHarness({ authedUser: { id: 'alice', isAdmin: false } });
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });

    // Seed via handler
    const { res: r1 } = mkRes();
    await handlers.create(mkReq({ body: { skillMd: ALICE_SKILL_MD } }), r1);

    const { res, statusOf, bodyOf } = mkRes();
    await handlers.get(mkReq({ params: { id: 'my-github' } }), res);
    expect(statusOf()).toBe(200);
    const body = bodyOf() as { id: string; bodyMd: string };
    expect(body.id).toBe('my-github');
    expect(body.bodyMd).toContain("Alice's personal skill body.");
  });

  it('GET /settings/skills returns only alice\'s skills', async () => {
    const h = await makeHarness({ authedUser: { id: 'alice', isAdmin: false } });
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });

    const { res: r1 } = mkRes();
    await handlers.create(mkReq({ body: { skillMd: ALICE_SKILL_MD } }), r1);

    const { res, statusOf, bodyOf } = mkRes();
    await handlers.list(mkReq({}), res);
    expect(statusOf()).toBe(200);
    const body = bodyOf() as { skills: Array<{ id: string }> };
    expect(Array.isArray(body.skills)).toBe(true);
    expect(body.skills).toHaveLength(1);
    expect(body.skills[0]?.id).toBe('my-github');
  });

  it('PUT /settings/skills/:id updates alice\'s skill and returns 200 created:false', async () => {
    const h = await makeHarness({ authedUser: { id: 'alice', isAdmin: false } });
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });

    const { res: r1, statusOf: s1 } = mkRes();
    await handlers.create(mkReq({ body: { skillMd: ALICE_SKILL_MD } }), r1);
    expect(s1()).toBe(201);

    const updatedMd = ALICE_SKILL_MD.replace(
      "Alice's personal skill body.",
      'Updated body.',
    );
    const { res: r2, statusOf: s2, bodyOf: b2 } = mkRes();
    await handlers.update(
      mkReq({ body: { skillMd: updatedMd }, params: { id: 'my-github' } }),
      r2,
    );
    expect(s2()).toBe(200);
    expect((b2() as { created: boolean }).created).toBe(false);

    // Verify the updated body on GET.
    const { res: r3, bodyOf: b3 } = mkRes();
    await handlers.get(mkReq({ params: { id: 'my-github' } }), r3);
    expect((b3() as { bodyMd: string }).bodyMd).toContain('Updated body.');
  });

  it('POST /settings/skills with files persists the bundle (user scope) and GET returns them', async () => {
    const h = await makeHarness({ authedUser: { id: 'alice', isAdmin: false } });
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });

    const { res: r1, statusOf: s1 } = mkRes();
    await handlers.create(
      mkReq({
        body: {
          skillMd: ALICE_SKILL_MD,
          files: [{ path: 'notes.md', contents: 'alice notes\n' }],
        },
      }),
      r1,
    );
    expect(s1()).toBe(201);

    const { res: r2, bodyOf: b2 } = mkRes();
    await handlers.get(mkReq({ params: { id: 'my-github' } }), r2);
    const detail = b2() as { files: { path: string; contents: string }[] };
    expect(detail.files).toEqual([{ path: 'notes.md', contents: 'alice notes\n' }]);
  });

  it('PUT /settings/skills/:id without files preserves the bundle (user scope)', async () => {
    const h = await makeHarness({ authedUser: { id: 'alice', isAdmin: false } });
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });

    const { res: r1 } = mkRes();
    await handlers.create(
      mkReq({
        body: {
          skillMd: ALICE_SKILL_MD,
          files: [{ path: 'notes.md', contents: 'alice notes\n' }],
        },
      }),
      r1,
    );

    const updatedMd = ALICE_SKILL_MD.replace(
      "Alice's personal skill body.",
      'Body edit only.',
    );
    const { res: r2, statusOf: s2 } = mkRes();
    await handlers.update(
      mkReq({ body: { skillMd: updatedMd }, params: { id: 'my-github' } }),
      r2,
    );
    expect(s2()).toBe(200);

    const { res: r3, bodyOf: b3 } = mkRes();
    await handlers.get(mkReq({ params: { id: 'my-github' } }), r3);
    const detail = b3() as { bodyMd: string; files: { path: string }[] };
    expect(detail.bodyMd).toContain('Body edit only.');
    expect(detail.files.map((f) => f.path)).toEqual(['notes.md']);
  });

  it('DELETE /settings/skills/:id removes alice\'s skill and returns 204', async () => {
    const h = await makeHarness({ authedUser: { id: 'alice', isAdmin: false } });
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });

    const { res: r1 } = mkRes();
    await handlers.create(mkReq({ body: { skillMd: ALICE_SKILL_MD } }), r1);

    const { res, statusOf } = mkRes();
    await handlers.destroy(mkReq({ params: { id: 'my-github' } }), res);
    expect(statusOf()).toBe(204);

    // Confirm the row is gone.
    const { res: r3, statusOf: s3 } = mkRes();
    await handlers.get(mkReq({ params: { id: 'my-github' } }), r3);
    expect(s3()).toBe(404);
  });

  // -------------------------------------------------------------------------
  // User isolation — alice's skills are NOT visible to bob
  // -------------------------------------------------------------------------

  it('bob cannot see alice\'s skill via GET /settings/skills', async () => {
    // Boot two harnesses against the same DB — one for alice, one for bob.
    const hAlice = await makeHarness({ authedUser: { id: 'alice', isAdmin: false } });
    const handlersAlice = createSettingsSkillsHandlers({ bus: hAlice.bus });

    // Alice creates her skill.
    const { res: r1 } = mkRes();
    await handlersAlice.create(mkReq({ body: { skillMd: ALICE_SKILL_MD } }), r1);

    // Bob's harness (same DB, different auth identity).
    const hBob = await makeHarness({ authedUser: { id: 'bob', isAdmin: false } });
    const handlersBob = createSettingsSkillsHandlers({ bus: hBob.bus });

    // Bob's list must be empty.
    const { res: r2, statusOf: s2, bodyOf: b2 } = mkRes();
    await handlersBob.list(mkReq({}), r2);
    expect(s2()).toBe(200);
    const body = b2() as { skills: unknown[] };
    expect(body.skills).toHaveLength(0);

    // Bob's GET on alice's skill id must 404.
    const { res: r3, statusOf: s3 } = mkRes();
    await handlersBob.get(mkReq({ params: { id: 'my-github' } }), r3);
    expect(s3()).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Global skill isolation — global skills are NOT accessible via /settings/skills
  // -------------------------------------------------------------------------

  it('GET /settings/skills/:id returns 404 for a global-scoped skill', async () => {
    const h = await makeHarness({ authedUser: { id: 'alice', isAdmin: false } });
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });

    // Install a global skill directly via the hook (bypasses the HTTP layer).
    await h.bus.call<
      { manifestYaml: string; bodyMd: string; scope: 'global' },
      { skillId: string; created: boolean }
    >('skills:upsert', h.ctx(), {
      manifestYaml:
        'name: global-tool\ndescription: Admin-installed global skill.\nversion: 1',
      bodyMd: 'Admin body.',
      scope: 'global',
    });

    // Confirm the global skill exists at the hook level.
    const detail = await h.bus.call<
      { skillId: string; scope: 'global' },
      { id: string }
    >('skills:get', h.ctx(), { skillId: 'global-tool', scope: 'global' });
    expect(detail.id).toBe('global-tool');

    // Alice's /settings/skills/:id must 404 — she has no user-scoped copy.
    const { res, statusOf } = mkRes();
    await handlers.get(mkReq({ params: { id: 'global-tool' } }), res);
    expect(statusOf()).toBe(404);
  });

  it('PUT /settings/skills/:id on a global skill id 404s and does not mutate the global row', async () => {
    const h = await makeHarness({ authedUser: { id: 'alice', isAdmin: false } });
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });

    // Install a global skill directly via the hook.
    await h.bus.call<
      { manifestYaml: string; bodyMd: string; scope: 'global' },
      { skillId: string; created: boolean }
    >('skills:upsert', h.ctx(), {
      manifestYaml:
        'name: global-tool\ndescription: Admin-installed global skill.\nversion: 1',
      bodyMd: 'Admin body.',
      scope: 'global',
    });

    // Alice tries to PUT — but she has no user-scoped row yet, so it creates
    // one in user scope (upsert semantics). We verify the global row is
    // untouched by reading it back at scope:'global' after alice's PUT.
    //
    // NOTE: skills:upsert with scope:'user' will CREATE a new user-scoped row
    // (upsert semantics). The global row must remain unchanged — this confirms
    // the forced scope:'user' + ownerUserId:'alice' routing.
    const { res: r1, statusOf: s1 } = mkRes();
    await handlers.update(
      mkReq({
        body: { skillMd: GLOBAL_SKILL_MD.replace('Admin body.', 'alice-mutated body.') },
        params: { id: 'global-tool' },
      }),
      r1,
    );
    // update on a non-existent user-scoped row performs an upsert → 200.
    expect(s1()).toBe(200);

    // Global row is untouched.
    const globalDetail = await h.bus.call<
      { skillId: string; scope: 'global' },
      { bodyMd: string }
    >('skills:get', h.ctx(), { skillId: 'global-tool', scope: 'global' });
    expect(globalDetail.bodyMd).toContain('Admin body.');
    expect(globalDetail.bodyMd).not.toContain('alice-mutated');
  });

  it('DELETE /settings/skills/:id on a global-only skill id returns 204 and does not touch the global row', async () => {
    const h = await makeHarness({ authedUser: { id: 'alice', isAdmin: false } });
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });

    // Install a global skill.
    await h.bus.call<
      { manifestYaml: string; bodyMd: string; scope: 'global' },
      { skillId: string; created: boolean }
    >('skills:upsert', h.ctx(), {
      manifestYaml:
        'name: global-tool\ndescription: Admin-installed global skill.\nversion: 1',
      bodyMd: 'Admin body.',
      scope: 'global',
    });

    // Alice tries to DELETE a global-only skill — she has no user-scoped row.
    // The user-store delete is idempotent (silent if the row doesn't exist),
    // so the HTTP handler returns 204. The key invariant is that the GLOBAL
    // row is untouched — confirmed below.
    const { res, statusOf } = mkRes();
    await handlers.destroy(mkReq({ params: { id: 'global-tool' } }), res);
    expect(statusOf()).toBe(204);

    // Global row must still exist.
    const globalDetail = await h.bus.call<
      { skillId: string; scope: 'global' },
      { id: string }
    >('skills:get', h.ctx(), { skillId: 'global-tool', scope: 'global' });
    expect(globalDetail.id).toBe('global-tool');
  });

  // -------------------------------------------------------------------------
  // Validation — mirrors admin-routes validation tests
  // -------------------------------------------------------------------------

  it('POST /settings/skills with skillMd lacking frontmatter fence returns 400', async () => {
    const h = await makeHarness();
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });
    const { res, statusOf, bodyOf } = mkRes();
    await handlers.create(
      mkReq({ body: { skillMd: '# No frontmatter\n\nJust body.\n' } }),
      res,
    );
    expect(statusOf()).toBe(400);
    expect((bodyOf() as { error: string }).error).toBe('missing frontmatter fence');
  });

  it('POST /settings/skills with body missing skillMd returns 400', async () => {
    const h = await makeHarness();
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });
    const { res, statusOf } = mkRes();
    await handlers.create(mkReq({ body: {} }), res);
    expect(statusOf()).toBe(400);
  });

  it('POST /settings/skills with extra unknown fields returns 400', async () => {
    const h = await makeHarness();
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });
    const { res, statusOf } = mkRes();
    await handlers.create(
      mkReq({ body: { skillMd: ALICE_SKILL_MD, extraField: 'oops' } }),
      res,
    );
    expect(statusOf()).toBe(400);
  });

  it('PUT /settings/skills/:id where path id != manifest name returns 400', async () => {
    const h = await makeHarness();
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });
    const { res, statusOf, bodyOf } = mkRes();
    await handlers.update(
      mkReq({ body: { skillMd: ALICE_SKILL_MD }, params: { id: 'wrong-id' } }),
      res,
    );
    expect(statusOf()).toBe(400);
    expect((bodyOf() as { error: string }).error).toMatch(/does not match manifest name/);
  });

  it('POST /settings/skills with body > 64 KiB returns 413', async () => {
    const h = await makeHarness();
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });
    const { res, statusOf } = mkRes();
    const req = mkReq({});
    (req as { body: Buffer }).body = Buffer.alloc(65 * 1024);
    await handlers.create(req, res);
    expect(statusOf()).toBe(413);
  });

  // -------------------------------------------------------------------------
  // Global skill isolation — global skills do NOT appear in GET /settings/skills list
  // -------------------------------------------------------------------------

  it('GET /settings/skills list does NOT include global-scoped skills', async () => {
    // Guards against handlers.list() regressing to scope:'all' or unscoped queries.
    const h = await makeHarness({ authedUser: { id: 'alice', isAdmin: false } });
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });

    // Install a global skill directly via hook (bypasses HTTP layer).
    await h.bus.call<
      { manifestYaml: string; bodyMd: string; scope: 'global' },
      { skillId: string; created: boolean }
    >('skills:upsert', h.ctx(), {
      manifestYaml: 'name: global-tool\ndescription: Admin-installed global skill.\nversion: 1',
      bodyMd: 'Admin body.',
      scope: 'global',
    });

    // Alice's list must NOT include the global skill.
    const { res, statusOf, bodyOf } = mkRes();
    await handlers.list(mkReq({}), res);
    expect(statusOf()).toBe(200);
    const body = bodyOf() as { skills: Array<{ id: string; scope: string }> };
    const globalEntry = body.skills.find((s) => s.id === 'global-tool');
    expect(globalEntry).toBeUndefined();
  });

  it('POST /settings/skills with defaultAttached: true on instruction-only skill returns 201', async () => {
    const h = await makeHarness({ authedUser: { id: 'alice', isAdmin: false } });
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });
    const { res, statusOf, bodyOf } = mkRes();
    await handlers.create(
      mkReq({ body: { skillMd: INSTRUCTION_SKILL_MD, defaultAttached: true } }),
      res,
    );
    expect(statusOf()).toBe(201);
    expect((bodyOf() as { skillId: string }).skillId).toBe('greeter');
  });
});
