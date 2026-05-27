import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createSkillsPlugin } from '../plugin.js';
import { createCatalogHandlers } from '../catalog-routes.js';
import type { RouteRequest, RouteResponse } from '../catalog-routes.js';
import type { CatalogSubmitInput, CatalogSubmitOutput } from '../types.js';

// ---------------------------------------------------------------------------
// /admin/catalog/* admit-queue route tests.
//
// Boots the skills plugin against a real postgres testcontainer (same pattern
// as admin-routes.test.ts) and stubs `auth:require-user` via the harness's
// authedUser option so we can drive the actor identity per case.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

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

const httpRegisterRouteStub = async () => ({ unregister: () => {} });

async function makeHarness(opts: {
  authedUser?: { id: string; isAdmin: boolean };
} = {}): Promise<TestHarness> {
  const authedUser = opts.authedUser ?? { id: 'admin', isAdmin: true };
  const h = await createTestHarness({
    services: {
      'http:register-route': httpRegisterRouteStub,
      'auth:require-user': async () => ({ user: authedUser }),
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
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_catalog_requests');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_user_attachments');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_skill_files');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_user_skills');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_skills');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await container.stop();
});

describe('/admin/catalog/* handlers', () => {
  it('GET /admin/catalog/requests returns pending requests (admin-gated)', async () => {
    const h = await makeHarness();
    const handlers = createCatalogHandlers({ bus: h.bus });

    // Seed: a user authors a skill, then files a share request.
    await h.bus.call('skills:upsert', h.ctx(), {
      manifestYaml: 'name: linear\ndescription: Linear.\nversion: 1\n',
      bodyMd: '# linear\n',
      scope: 'user',
      ownerUserId: 'u-author',
    });
    await h.bus.call<CatalogSubmitInput, CatalogSubmitOutput>('catalog:submit', h.ctx(), {
      kind: 'share',
      skillId: 'linear',
      requestedByUserId: 'u-author',
    });

    const { res, statusOf, bodyOf } = mkRes();
    await handlers.listRequests(mkReq({}), res);
    expect(statusOf()).toBe(200);
    const body = bodyOf() as { requests: Array<{ skillId: string; kind: string }> };
    expect(body.requests.find((r) => r.skillId === 'linear')?.kind).toBe('share');
  });

  it('GET /admin/catalog/requests is 403 for a non-admin', async () => {
    const h = await makeHarness({ authedUser: { id: 'u-author', isAdmin: false } });
    const handlers = createCatalogHandlers({ bus: h.bus });
    const { res, statusOf } = mkRes();
    await handlers.listRequests(mkReq({}), res);
    expect(statusOf()).toBe(403);
  });

  it('POST decision admits a share and ignores any client-supplied decider', async () => {
    const h = await makeHarness(); // actor.id === 'admin'
    const handlers = createCatalogHandlers({ bus: h.bus });

    await h.bus.call('skills:upsert', h.ctx(), {
      manifestYaml: 'name: linear\ndescription: Linear.\nversion: 1\n',
      bodyMd: '# linear\n',
      scope: 'user',
      ownerUserId: 'u-author',
    });
    const submitted = await h.bus.call<CatalogSubmitInput, CatalogSubmitOutput>(
      'catalog:submit',
      h.ctx(),
      { kind: 'share', skillId: 'linear', requestedByUserId: 'u-author' },
    );

    const { res, statusOf, bodyOf } = mkRes();
    await handlers.decide(
      mkReq({
        params: { id: submitted.requestId },
        // attacker tries to spoof the decider — must be ignored.
        body: { decision: 'admit', decidedByUserId: 'u-evil' },
      }),
      res,
    );
    expect(statusOf()).toBe(200);
    expect((bodyOf() as { admitted: boolean }).admitted).toBe(true);

    // The skill is now in the GLOBAL catalog; the author's working copy retired.
    const global = await h.bus.call<{ skillId: string; scope: 'global' }, { id: string }>(
      'skills:get',
      h.ctx(),
      { skillId: 'linear', scope: 'global' },
    );
    expect(global.id).toBe('linear');
  });

  it('POST decision rejects a request', async () => {
    const h = await makeHarness();
    const handlers = createCatalogHandlers({ bus: h.bus });
    await h.bus.call('skills:upsert', h.ctx(), {
      manifestYaml: 'name: linear\ndescription: Linear.\nversion: 1\n',
      bodyMd: '# linear\n',
      scope: 'user',
      ownerUserId: 'u-author',
    });
    const submitted = await h.bus.call<CatalogSubmitInput, CatalogSubmitOutput>(
      'catalog:submit',
      h.ctx(),
      { kind: 'share', skillId: 'linear', requestedByUserId: 'u-author' },
    );
    const { res, statusOf, bodyOf } = mkRes();
    await handlers.decide(
      mkReq({ params: { id: submitted.requestId }, body: { decision: 'reject' } }),
      res,
    );
    expect(statusOf()).toBe(200);
    expect((bodyOf() as { admitted: boolean }).admitted).toBe(false);
  });

  it('POST decision is 403 for a non-admin', async () => {
    const h = await makeHarness({ authedUser: { id: 'u-author', isAdmin: false } });
    const handlers = createCatalogHandlers({ bus: h.bus });
    const { res, statusOf } = mkRes();
    await handlers.decide(
      mkReq({ params: { id: 'r-anything' }, body: { decision: 'admit' } }),
      res,
    );
    expect(statusOf()).toBe(403);
  });
});
