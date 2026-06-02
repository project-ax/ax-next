import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { createTestHarness, type TestHarness, stopPostgresContainer } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { PluginError } from '@ax/core';
import { createSkillsPlugin } from '../plugin.js';
import { blobStoreFakeServices } from './_blob-fake.js';
import { createSettingsSkillsHandlers } from '../settings-routes.js';
import type { RouteRequest, RouteResponse } from '../admin-routes.js';
import type {
  CatalogListRequestsInput,
  CatalogListRequestsOutput,
  SkillsProposeInput,
  SkillsProposeOutput,
  SettingsAuthoredSkillsOutput,
} from '../types.js';
import type { SkillCapabilities } from '@ax/skills-parser';

const EMPTY_CAPS: SkillCapabilities = {
  allowedHosts: [],
  credentials: [],
  mcpServers: [],
  packages: { npm: [], pypi: [] },
};

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
connectors:
  - github
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

/** One agent row as `agents:list-for-user` returns it (only the fields the
 * authored-listing route reads). */
interface StubAgent {
  id: string;
  ownerId: string;
  ownerType: 'user' | 'team';
}

async function makeHarness(opts: {
  authedUser?: { id: string; isAdmin: boolean } | null;
  /** When provided, registers an `agents:list-for-user` stub returning these
   * agents. Omit to simulate a preset WITHOUT @ax/agents (soft dep absent). */
  agents?: StubAgent[];
} = {}): Promise<TestHarness> {
  const authedUser = opts.authedUser === undefined
    ? { id: 'alice', isAdmin: false }
    : opts.authedUser;

  const services: Record<
    string,
    (ctx: unknown, input: unknown) => Promise<unknown>
  > = {
    ...blobStoreFakeServices(),
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
  };
  if (opts.agents !== undefined) {
    const agents = opts.agents;
    services['agents:list-for-user'] = async () => ({ agents });
  }

  const h = await createTestHarness({
    services,
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
    // Order matters: catalog_requests / skill_files reference (logically) the
    // skill rows. The share tests insert into skills_v1_catalog_requests, so it
    // must be dropped alongside the skill tables for per-test isolation.
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_catalog_requests');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_skill_files');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_user_attachments');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_user_skills');
    // TASK-85: the authored-skills route seeds skills_v1_authored via skills:propose.
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_authored');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_skills');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
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

  // -------------------------------------------------------------------------
  // Share to catalog (TASK-60) — POST /settings/skills/:id/share fires the
  // existing catalog:submit hook with kind:'share', requestedByUserId = actor.
  // -------------------------------------------------------------------------

  it('POST /settings/skills/:id/share returns 401 when anonymous', async () => {
    const h = await makeHarness({ authedUser: null });
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });
    const { res, statusOf } = mkRes();
    await handlers.share(mkReq({ params: { id: 'my-github' } }), res);
    expect(statusOf()).toBe(401);
  });

  it('POST /settings/skills/:id/share submits the caller\'s own skill (200, created:true) and a pending request appears', async () => {
    const h = await makeHarness({ authedUser: { id: 'alice', isAdmin: false } });
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });

    // Alice authors a skill, then shares it.
    const { res: r1 } = mkRes();
    await handlers.create(mkReq({ body: { skillMd: ALICE_SKILL_MD } }), r1);

    const { res, statusOf, bodyOf } = mkRes();
    await handlers.share(mkReq({ params: { id: 'my-github' } }), res);
    expect(statusOf()).toBe(200);
    const body = bodyOf() as { requestId: string; created: boolean; status: string };
    expect(body.created).toBe(true);
    expect(body.status).toBe('pending');
    expect(typeof body.requestId).toBe('string');

    // A pending share request for 'my-github' now exists in the admit queue,
    // sourced from alice.
    const queue = await h.bus.call<CatalogListRequestsInput, CatalogListRequestsOutput>(
      'catalog:list-requests',
      h.ctx(),
      { status: 'pending' },
    );
    const reqRow = queue.requests.find((r) => r.skillId === 'my-github');
    expect(reqRow?.kind).toBe('share');
    expect(reqRow?.requestedByUserId).toBe('alice');
    expect(reqRow?.sourceOwnerUserId).toBe('alice');
  });

  it('POST /settings/skills/:id/share is idempotent — a second submit dedups (created:false)', async () => {
    const h = await makeHarness({ authedUser: { id: 'alice', isAdmin: false } });
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });
    const { res: r1 } = mkRes();
    await handlers.create(mkReq({ body: { skillMd: ALICE_SKILL_MD } }), r1);

    const { res: rA, bodyOf: bA } = mkRes();
    await handlers.share(mkReq({ params: { id: 'my-github' } }), rA);
    expect((bA() as { created: boolean }).created).toBe(true);

    const { res: rB, statusOf: sB, bodyOf: bB } = mkRes();
    await handlers.share(mkReq({ params: { id: 'my-github' } }), rB);
    expect(sB()).toBe(200);
    expect((bB() as { created: boolean }).created).toBe(false);
  });

  it('POST /settings/skills/:id/share on a skill the caller does NOT own returns 404', async () => {
    // Alice authors a skill; Bob (different session) tries to share alice's id.
    const hAlice = await makeHarness({ authedUser: { id: 'alice', isAdmin: false } });
    const handlersAlice = createSettingsSkillsHandlers({ bus: hAlice.bus });
    const { res: r1 } = mkRes();
    await handlersAlice.create(mkReq({ body: { skillMd: ALICE_SKILL_MD } }), r1);

    const hBob = await makeHarness({ authedUser: { id: 'bob', isAdmin: false } });
    const handlersBob = createSettingsSkillsHandlers({ bus: hBob.bus });
    const { res, statusOf } = mkRes();
    await handlersBob.share(mkReq({ params: { id: 'my-github' } }), res);
    expect(statusOf()).toBe(404);
  });

  it('POST /settings/skills/:id/share ignores a spoofed requestedByUserId in the body (I5)', async () => {
    const h = await makeHarness({ authedUser: { id: 'alice', isAdmin: false } });
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });
    const { res: r1 } = mkRes();
    await handlers.create(mkReq({ body: { skillMd: ALICE_SKILL_MD } }), r1);

    // Attacker appends a spoofed requestedByUserId — must be ignored; the share
    // lands under the authenticated actor (alice), not 'u-evil'.
    const { res, statusOf } = mkRes();
    await handlers.share(
      mkReq({ params: { id: 'my-github' }, body: { requestedByUserId: 'u-evil' } }),
      res,
    );
    expect(statusOf()).toBe(200);

    const queue = await h.bus.call<CatalogListRequestsInput, CatalogListRequestsOutput>(
      'catalog:list-requests',
      h.ctx(),
      { status: 'pending' },
    );
    const reqRow = queue.requests.find((r) => r.skillId === 'my-github');
    expect(reqRow?.requestedByUserId).toBe('alice');
    expect(reqRow?.requestedByUserId).not.toBe('u-evil');
  });

  // -------------------------------------------------------------------------
  // Authored skills (TASK-85) — GET /settings/skills/authored aggregates the
  // caller's agent-authored skills across THEIR personal agents. The "My
  // Skills" panel surfaces these alongside catalog skills.
  // -------------------------------------------------------------------------

  /** Seed one authored skill via skills:propose (the single write chokepoint).
   * The host RE-PARSES the manifest for the capability proposal — the manifest
   * YAML decides the gate verdict (zero-cap authored → active; caps → pending;
   * scan hit → quarantined). */
  async function propose(
    h: TestHarness,
    input: {
      ownerUserId: string;
      agentId: string;
      manifestYaml: string;
      bodyMd: string;
      origin?: 'authored' | 'imported' | 'attached';
    },
  ): Promise<SkillsProposeOutput> {
    return h.bus.call<SkillsProposeInput, SkillsProposeOutput>(
      'skills:propose',
      h.ctx(),
      {
        ownerUserId: input.ownerUserId,
        agentId: input.agentId,
        manifestYaml: input.manifestYaml,
        bodyMd: input.bodyMd,
        files: [],
        capabilityProposal: EMPTY_CAPS, // host re-parses the manifest; ignored (TASK-100)
        // TASK-100 — a skill declares no caps, so a non-authored origin is the
        // only way to land `pending` (a self-authored skill is always active).
        origin: input.origin ?? 'authored',
      },
    );
  }

  it('GET /settings/skills/authored returns 401 when anonymous', async () => {
    const h = await makeHarness({ authedUser: null });
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });
    const { res, statusOf } = mkRes();
    await handlers.listAuthored(mkReq({}), res);
    expect(statusOf()).toBe(401);
  });

  it('GET /settings/skills/authored lists the caller\'s ACTIVE + PENDING authored skills', async () => {
    // This is the Bug-Fix-Policy test: before TASK-85, authored skills had no
    // user-facing read at all, so the panel showed "No skills installed".
    const h = await makeHarness({
      authedUser: { id: 'alice', isAdmin: false },
      agents: [{ id: 'agt_a', ownerId: 'alice', ownerType: 'user' }],
    });
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });

    const a = await propose(h, {
      ownerUserId: 'alice',
      agentId: 'agt_a',
      manifestYaml: 'name: my-authored\ndescription: An agent-authored helper.\nversion: 1',
      bodyMd: 'Authored body.',
    });
    expect(a.status).toBe('active');
    const p = await propose(h, {
      ownerUserId: 'alice',
      agentId: 'agt_a',
      manifestYaml:
        'name: needs-approval\ndescription: Imported skill awaiting approval.\nversion: 1\nconnectors:\n  - example-connector',
      bodyMd: 'Wants reach.',
      origin: 'imported', // a non-authored origin lands pending (TASK-100)
    });
    expect(p.status).toBe('pending');

    const { res, statusOf, bodyOf } = mkRes();
    await handlers.listAuthored(mkReq({}), res);
    expect(statusOf()).toBe(200);
    const body = bodyOf() as SettingsAuthoredSkillsOutput;
    const ids = body.skills.map((s) => s.skillId);
    expect(ids).toContain('my-authored');
    expect(ids).toContain('needs-approval');
    const active = body.skills.find((s) => s.skillId === 'my-authored');
    expect(active).toMatchObject({
      agentId: 'agt_a',
      status: 'active',
      description: 'An agent-authored helper.',
    });
    const pending = body.skills.find((s) => s.skillId === 'needs-approval');
    expect(pending?.status).toBe('pending');
  });

  it('GET /settings/skills/authored never carries pendingCapabilities (TASK-100 — a skill declares no caps)', async () => {
    // TASK-100 — a skill manifest declares no capabilities (its reach is the
    // connectors it references), so a skill has nothing of its own to approve:
    // the listing never carries `pendingCapabilities`. A connector's reach is
    // approved via the connector approval card, not the skill listing.
    const h = await makeHarness({
      authedUser: { id: 'alice', isAdmin: false },
      agents: [{ id: 'agt_a', ownerId: 'alice', ownerType: 'user' }],
    });
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });

    // A self-authored skill is always active (zero reach of its own).
    const active = await propose(h, {
      ownerUserId: 'alice',
      agentId: 'agt_a',
      manifestYaml: 'name: inert-pending\ndescription: Authored skill.\nversion: 1',
      bodyMd: 'No caps.',
    });
    expect(active.status).toBe('active');

    // A pending skill (imported origin) — still no pendingCapabilities.
    const pendingProp = await propose(h, {
      ownerUserId: 'alice',
      agentId: 'agt_a',
      manifestYaml: 'name: needs-key\ndescription: Imported skill.\nversion: 1\nconnectors:\n  - linear',
      bodyMd: 'References a connector.',
      origin: 'imported',
    });
    expect(pendingProp.status).toBe('pending');

    const { res, statusOf, bodyOf } = mkRes();
    await handlers.listAuthored(mkReq({}), res);
    expect(statusOf()).toBe(200);
    const body = bodyOf() as SettingsAuthoredSkillsOutput;

    const pending = body.skills.find((s) => s.skillId === 'needs-key');
    expect(pending?.status).toBe('pending');
    expect(pending?.pendingCapabilities).toBeUndefined();

    const activeListing = body.skills.find((s) => s.skillId === 'inert-pending');
    expect(activeListing?.pendingCapabilities).toBeUndefined();
  });

  it('GET /settings/skills/authored EXCLUDES quarantined drafts', async () => {
    const h = await makeHarness({
      authedUser: { id: 'alice', isAdmin: false },
      agents: [{ id: 'agt_a', ownerId: 'alice', ownerType: 'user' }],
    });
    // Register a scan that flags this one bundle → quarantined.
    h.bus.registerService(
      'skills:scan',
      'test',
      async () => ({ verdict: 'hit' as const, reason: 'nope' }),
    );
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });

    const q = await propose(h, {
      ownerUserId: 'alice',
      agentId: 'agt_a',
      manifestYaml: 'name: flagged\ndescription: Authored skill the scanner dislikes.\nversion: 1',
      bodyMd: 'Suspicious body.',
    });
    expect(q.status).toBe('quarantined');

    const { res, statusOf, bodyOf } = mkRes();
    await handlers.listAuthored(mkReq({}), res);
    expect(statusOf()).toBe(200);
    const body = bodyOf() as SettingsAuthoredSkillsOutput;
    expect(body.skills.find((s) => s.skillId === 'flagged')).toBeUndefined();
  });

  it('GET /settings/skills/authored only reads the caller\'s OWN personal agents (I5)', async () => {
    // alice authors a skill on agt_a; the route is given a TEAM agent and an
    // agent owned by someone else — both must be ignored.
    const h = await makeHarness({
      authedUser: { id: 'alice', isAdmin: false },
      agents: [
        { id: 'agt_a', ownerId: 'alice', ownerType: 'user' },
        { id: 'agt_team', ownerId: 'team-1', ownerType: 'team' },
        { id: 'agt_bob', ownerId: 'bob', ownerType: 'user' },
      ],
    });
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });

    await propose(h, {
      ownerUserId: 'alice',
      agentId: 'agt_a',
      manifestYaml: 'name: my-authored\ndescription: An agent-authored helper.\nversion: 1',
      bodyMd: 'Authored body.',
    });
    // Seed a skill under bob's agent owned by bob — alice must never see it,
    // even though agt_bob appears in the (stubbed) agent list.
    await propose(h, {
      ownerUserId: 'bob',
      agentId: 'agt_bob',
      manifestYaml: 'name: bob-skill\ndescription: Bob authored this.\nversion: 1',
      bodyMd: 'Bob body.',
    });

    const { res, bodyOf } = mkRes();
    await handlers.listAuthored(mkReq({}), res);
    const body = bodyOf() as SettingsAuthoredSkillsOutput;
    const ids = body.skills.map((s) => s.skillId);
    expect(ids).toEqual(['my-authored']);
    // Every listing belongs to alice's own personal agent.
    for (const s of body.skills) expect(s.agentId).toBe('agt_a');
  });

  it('GET /settings/skills/authored returns [] when @ax/agents is absent (soft dep)', async () => {
    const h = await makeHarness({ authedUser: { id: 'alice', isAdmin: false } });
    // No `agents` option → no agents:list-for-user service registered.
    expect(h.bus.hasService('agents:list-for-user')).toBe(false);
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });
    const { res, statusOf, bodyOf } = mkRes();
    await handlers.listAuthored(mkReq({}), res);
    expect(statusOf()).toBe(200);
    expect((bodyOf() as SettingsAuthoredSkillsOutput).skills).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Adopt-&-edit (TASK-134) — POST /settings/skills/authored/:agentId/:skillId/
  // adopt copies an agent-authored draft into the caller's OWN editable
  // user-scoped skill (manifest + body + files), then marks the draft adopted
  // so it drops off the authored listing.
  // -------------------------------------------------------------------------

  /** Seed one authored skill WITH extra bundle files via skills:propose. */
  async function proposeWithFiles(
    h: TestHarness,
    input: {
      ownerUserId: string;
      agentId: string;
      manifestYaml: string;
      bodyMd: string;
      files: Array<{ path: string; contents: string }>;
      origin?: 'authored' | 'imported' | 'attached';
    },
  ): Promise<SkillsProposeOutput> {
    return h.bus.call<SkillsProposeInput, SkillsProposeOutput>(
      'skills:propose',
      h.ctx(),
      {
        ownerUserId: input.ownerUserId,
        agentId: input.agentId,
        manifestYaml: input.manifestYaml,
        bodyMd: input.bodyMd,
        files: input.files,
        capabilityProposal: EMPTY_CAPS,
        origin: input.origin ?? 'authored',
      },
    );
  }

  it('POST adopt returns 401 when anonymous', async () => {
    const h = await makeHarness({ authedUser: null });
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });
    const { res, statusOf } = mkRes();
    await handlers.adoptAuthored(
      mkReq({ params: { agentId: 'agt_a', skillId: 'x' } }),
      res,
    );
    expect(statusOf()).toBe(401);
  });

  it('POST adopt copies the draft (manifest + body + FILES) into a user skill and marks the draft adopted', async () => {
    // The Bug-Fix-Policy / acceptance test: the copy carries additional files AND
    // the draft is removed from the authored listing once adopted.
    const h = await makeHarness({
      authedUser: { id: 'alice', isAdmin: false },
      agents: [{ id: 'agt_a', ownerId: 'alice', ownerType: 'user' }],
    });
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });

    const seeded = await proposeWithFiles(h, {
      ownerUserId: 'alice',
      agentId: 'agt_a',
      manifestYaml:
        'name: drafted\ndescription: An agent-authored draft.\nversion: 1\nconnectors:\n  - github',
      bodyMd: 'Drafted body.\n',
      files: [
        { path: 'notes.md', contents: 'reference notes\n' },
        { path: 'scripts/run.py', contents: 'print("hi")\n' },
      ],
    });
    expect(seeded.status).toBe('active');

    // Adopt it.
    const { res, statusOf, bodyOf } = mkRes();
    await handlers.adoptAuthored(
      mkReq({ params: { agentId: 'agt_a', skillId: 'drafted' } }),
      res,
    );
    expect(statusOf()).toBe(200);
    expect(bodyOf()).toMatchObject({ skillId: 'drafted', created: true, adopted: true });

    // The user-scoped copy now exists with the SAME body + files.
    const detail = await h.bus.call<
      { skillId: string; scope: 'user'; ownerUserId: string },
      { id: string; scope: string; ownerUserId: string; bodyMd: string; files: { path: string; contents: string }[] }
    >('skills:get', h.ctx(), { skillId: 'drafted', scope: 'user', ownerUserId: 'alice' });
    expect(detail.id).toBe('drafted');
    expect(detail.scope).toBe('user');
    expect(detail.ownerUserId).toBe('alice');
    expect(detail.bodyMd).toContain('Drafted body.');
    // Files round-trip faithfully (sorted by path for a stable compare).
    const sorted = [...detail.files].sort((a, b) => a.path.localeCompare(b.path));
    expect(sorted).toEqual([
      { path: 'notes.md', contents: 'reference notes\n' },
      { path: 'scripts/run.py', contents: 'print("hi")\n' },
    ]);

    // The draft is now adopted → it drops off the authored listing.
    const { res: r2, bodyOf: b2 } = mkRes();
    await handlers.listAuthored(mkReq({}), r2);
    const listing = b2() as SettingsAuthoredSkillsOutput;
    expect(listing.skills.find((s) => s.skillId === 'drafted')).toBeUndefined();
  });

  it('POST adopt is idempotent — a second adopt re-copies but reports adopted:false', async () => {
    const h = await makeHarness({
      authedUser: { id: 'alice', isAdmin: false },
      agents: [{ id: 'agt_a', ownerId: 'alice', ownerType: 'user' }],
    });
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });

    await proposeWithFiles(h, {
      ownerUserId: 'alice',
      agentId: 'agt_a',
      manifestYaml: 'name: drafted\ndescription: A draft.\nversion: 1',
      bodyMd: 'Body.\n',
      files: [],
    });

    const { res: rA, bodyOf: bA } = mkRes();
    await handlers.adoptAuthored(mkReq({ params: { agentId: 'agt_a', skillId: 'drafted' } }), rA);
    expect((bA() as { adopted: boolean }).adopted).toBe(true);

    // Second adopt: the draft is already adopted (not user-facing) → 409.
    const { res: rB, statusOf: sB, bodyOf: bB } = mkRes();
    await handlers.adoptAuthored(mkReq({ params: { agentId: 'agt_a', skillId: 'drafted' } }), rB);
    expect(sB()).toBe(409);
    expect((bB() as { code?: string }).code).toBe('not-adoptable');
  });

  it('POST adopt of an unknown draft id returns 404 (not-authored)', async () => {
    const h = await makeHarness({
      authedUser: { id: 'alice', isAdmin: false },
      agents: [{ id: 'agt_a', ownerId: 'alice', ownerType: 'user' }],
    });
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });
    const { res, statusOf, bodyOf } = mkRes();
    await handlers.adoptAuthored(
      mkReq({ params: { agentId: 'agt_a', skillId: 'no-such-draft' } }),
      res,
    );
    expect(statusOf()).toBe(404);
    expect((bodyOf() as { code?: string }).code).toBe('not-authored');
  });

  it('POST adopt of a draft on an agent the caller does NOT own returns 404 (I5 ACL)', async () => {
    // alice authors a draft on agt_a. bob — even with agt_a appearing in his
    // (spoofed) agent list under someone else's ownership — cannot adopt it.
    const hAlice = await makeHarness({
      authedUser: { id: 'alice', isAdmin: false },
      agents: [{ id: 'agt_a', ownerId: 'alice', ownerType: 'user' }],
    });
    await proposeWithFiles(hAlice, {
      ownerUserId: 'alice',
      agentId: 'agt_a',
      manifestYaml: 'name: drafted\ndescription: A draft.\nversion: 1',
      bodyMd: 'Body.\n',
      files: [],
    });

    // bob's session: agt_a is presented but owned by alice, not bob.
    const hBob = await makeHarness({
      authedUser: { id: 'bob', isAdmin: false },
      agents: [{ id: 'agt_a', ownerId: 'alice', ownerType: 'user' }],
    });
    const handlersBob = createSettingsSkillsHandlers({ bus: hBob.bus });
    const { res, statusOf } = mkRes();
    await handlersBob.adoptAuthored(
      mkReq({ params: { agentId: 'agt_a', skillId: 'drafted' } }),
      res,
    );
    expect(statusOf()).toBe(404);

    // bob got no user-scoped copy.
    const { res: rGet, statusOf: sGet } = mkRes();
    await handlersBob.get(mkReq({ params: { id: 'drafted' } }), rGet);
    expect(sGet()).toBe(404);
  });

  it('POST adopt returns 404 when @ax/agents is absent (no ownable agent)', async () => {
    const h = await makeHarness({ authedUser: { id: 'alice', isAdmin: false } });
    expect(h.bus.hasService('agents:list-for-user')).toBe(false);
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });
    const { res, statusOf } = mkRes();
    await handlers.adoptAuthored(
      mkReq({ params: { agentId: 'agt_a', skillId: 'drafted' } }),
      res,
    );
    expect(statusOf()).toBe(404);
  });

  // -------------------------------------------------------------------------
  // DELETE /settings/skills/authored/:agentId/:skillId — hard-delete an
  // agent-authored draft (the authored shelf's Delete button). Before this
  // existed, an authored draft had NO deletion path (only "adopt"), so a stale
  // draft was un-removable through the UI. These are the Bug-Fix-Policy tests.
  // -------------------------------------------------------------------------

  it('DELETE authored returns 401 when anonymous', async () => {
    const h = await makeHarness({ authedUser: null });
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });
    const { res, statusOf } = mkRes();
    await handlers.destroyAuthored(
      mkReq({ params: { agentId: 'agt_a', skillId: 'x' } }),
      res,
    );
    expect(statusOf()).toBe(401);
  });

  it('DELETE authored returns 400 when ids are missing', async () => {
    const h = await makeHarness({
      authedUser: { id: 'alice', isAdmin: false },
      agents: [{ id: 'agt_a', ownerId: 'alice', ownerType: 'user' }],
    });
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });
    const { res, statusOf } = mkRes();
    await handlers.destroyAuthored(mkReq({ params: { agentId: 'agt_a' } }), res);
    expect(statusOf()).toBe(400);
  });

  it('DELETE authored removes the draft and drops it from the authored listing (204)', async () => {
    // The acceptance / Bug-Fix-Policy test: a draft with no other deletion path
    // is removed outright and stops showing in the authored listing.
    const h = await makeHarness({
      authedUser: { id: 'alice', isAdmin: false },
      agents: [{ id: 'agt_a', ownerId: 'alice', ownerType: 'user' }],
    });
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });

    await proposeWithFiles(h, {
      ownerUserId: 'alice',
      agentId: 'agt_a',
      manifestYaml: 'name: drafted\ndescription: A draft.\nversion: 1',
      bodyMd: 'Body.\n',
      files: [{ path: 'notes.md', contents: 'n\n' }],
    });

    // It shows in the authored listing first.
    const { res: rBefore, bodyOf: bBefore } = mkRes();
    await handlers.listAuthored(mkReq({}), rBefore);
    expect(
      (bBefore() as SettingsAuthoredSkillsOutput).skills.some((s) => s.skillId === 'drafted'),
    ).toBe(true);

    // Delete it.
    const { res, statusOf } = mkRes();
    await handlers.destroyAuthored(
      mkReq({ params: { agentId: 'agt_a', skillId: 'drafted' } }),
      res,
    );
    expect(statusOf()).toBe(204);

    // It's gone from the listing — and no user-scoped copy was created (delete,
    // not adopt).
    const { res: rAfter, bodyOf: bAfter } = mkRes();
    await handlers.listAuthored(mkReq({}), rAfter);
    expect(
      (bAfter() as SettingsAuthoredSkillsOutput).skills.find((s) => s.skillId === 'drafted'),
    ).toBeUndefined();

    const { res: rGet, statusOf: sGet } = mkRes();
    await handlers.get(mkReq({ params: { id: 'drafted' } }), rGet);
    expect(sGet()).toBe(404);
  });

  it('DELETE authored is idempotent — deleting an already-gone draft still returns 204', async () => {
    const h = await makeHarness({
      authedUser: { id: 'alice', isAdmin: false },
      agents: [{ id: 'agt_a', ownerId: 'alice', ownerType: 'user' }],
    });
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });

    await proposeWithFiles(h, {
      ownerUserId: 'alice',
      agentId: 'agt_a',
      manifestYaml: 'name: drafted\ndescription: A draft.\nversion: 1',
      bodyMd: 'Body.\n',
      files: [],
    });

    const { res: r1, statusOf: s1 } = mkRes();
    await handlers.destroyAuthored(mkReq({ params: { agentId: 'agt_a', skillId: 'drafted' } }), r1);
    expect(s1()).toBe(204);

    // Second delete: the row is already gone — still a success (204), not a 404.
    const { res: r2, statusOf: s2 } = mkRes();
    await handlers.destroyAuthored(mkReq({ params: { agentId: 'agt_a', skillId: 'drafted' } }), r2);
    expect(s2()).toBe(204);
  });

  it('DELETE authored of a draft on an agent the caller does NOT own returns 404 and leaves it intact (I5 ACL)', async () => {
    // alice authors a draft on agt_a. bob — even with agt_a presented in his
    // (spoofed) agent list under alice's ownership — cannot delete it.
    const hAlice = await makeHarness({
      authedUser: { id: 'alice', isAdmin: false },
      agents: [{ id: 'agt_a', ownerId: 'alice', ownerType: 'user' }],
    });
    const handlersAlice = createSettingsSkillsHandlers({ bus: hAlice.bus });
    await proposeWithFiles(hAlice, {
      ownerUserId: 'alice',
      agentId: 'agt_a',
      manifestYaml: 'name: drafted\ndescription: A draft.\nversion: 1',
      bodyMd: 'Body.\n',
      files: [],
    });

    const hBob = await makeHarness({
      authedUser: { id: 'bob', isAdmin: false },
      agents: [{ id: 'agt_a', ownerId: 'alice', ownerType: 'user' }],
    });
    const handlersBob = createSettingsSkillsHandlers({ bus: hBob.bus });
    const { res, statusOf } = mkRes();
    await handlersBob.destroyAuthored(
      mkReq({ params: { agentId: 'agt_a', skillId: 'drafted' } }),
      res,
    );
    expect(statusOf()).toBe(404);

    // alice's draft survives bob's attempt.
    const { res: rList, bodyOf: bList } = mkRes();
    await handlersAlice.listAuthored(mkReq({}), rList);
    expect(
      (bList() as SettingsAuthoredSkillsOutput).skills.some((s) => s.skillId === 'drafted'),
    ).toBe(true);
  });

  it('DELETE authored returns 404 when @ax/agents is absent (no ownable agent)', async () => {
    const h = await makeHarness({ authedUser: { id: 'alice', isAdmin: false } });
    expect(h.bus.hasService('agents:list-for-user')).toBe(false);
    const handlers = createSettingsSkillsHandlers({ bus: h.bus });
    const { res, statusOf } = mkRes();
    await handlers.destroyAuthored(
      mkReq({ params: { agentId: 'agt_a', skillId: 'drafted' } }),
      res,
    );
    expect(statusOf()).toBe(404);
  });
});
