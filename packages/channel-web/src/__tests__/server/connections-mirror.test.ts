// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  createTestHarness,
  mockBlobStoreServices,
  type TestHarness, stopPostgresContainer } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createSkillsPlugin } from '@ax/skills';
import { makeAgentContext, type AgentContext } from '@ax/core';
import { makeConnectionsHandlers } from '../../server/routes-connections.js';
import type { RouteRequest, RouteResponse } from '../../server/routes-chat.js';

// ---------------------------------------------------------------------------
// Mirror property (design P6, decision #11) at the BFF + domain level:
// a per-user attachment created out-of-band (the card grant path) appears in
// the Settings "Connections" read, and detaching there propagates back to the
// @ax/skills source of truth (the one store). Real @ax/skills +
// @ax/database-postgres; a stubbed agents:resolve / auth:require-user supply
// the ACL + identity the BFF composes around.
//
// The full browser walk (connect in chat → see under Connections → revoke →
// next turn lacks it) is TASK-49's manual-acceptance walk; this is the server
// bar.
// ---------------------------------------------------------------------------

// TASK-100 — a skill carries no capability block; it references a connector.
const SAMPLE_MANIFEST = `name: github
description: Know-how for driving the GitHub connector.
version: 1
connectors:
  - github
`;
const SAMPLE_BODY = '# GitHub\n\nGitHub skill body.\n';

const initCtx: AgentContext = makeAgentContext({
  sessionId: 'init',
  agentId: '@ax/channel-web',
  userId: 'system',
});

function mkReq(params: Record<string, string>): RouteRequest {
  return {
    headers: {},
    body: Buffer.alloc(0),
    cookies: {},
    query: {},
    params,
    signedCookie: () => null,
  };
}
interface CapturedRes {
  statusCode: number;
  body: unknown;
}
function mkRes(): { res: RouteResponse; captured: CapturedRes } {
  const captured: CapturedRes = { statusCode: 0, body: undefined };
  const res: RouteResponse = {
    status(n: number) {
      captured.statusCode = n;
      return res;
    },
    json(v: unknown) {
      captured.body = v;
    },
    text() {},
    end() {},
  };
  return { res, captured };
}

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

async function makeHarness(): Promise<TestHarness> {
  const h = await createTestHarness({
    services: {
      // out-of-git Part D2: @ax/skills now hard-deps the blob store for bundle
      // bytes — supply a content-addressed in-process backend.
      ...mockBlobStoreServices(),
      // @ax/skills registers its admin/settings HTTP routes at init — stub the
      // route registrar so bootstrap completes (this suite drives the handlers
      // directly, not over HTTP).
      'http:register-route': async () => ({ unregister: () => {} }),
      // The BFF gates on these two — supply a fixed authenticated user + an
      // ACL that allows agent 'a1' (with no agent-global skills).
      'auth:require-user': async () => ({ user: { id: 'u1', isAdmin: false } }),
      'agents:resolve': async (_ctx, input) => {
        const i = input as { agentId: string };
        if (i.agentId !== 'a1') {
          const { PluginError } = await import('@ax/core');
          throw new PluginError({ code: 'not-found', plugin: 'test', message: 'nf' });
        }
        return { agent: { id: 'a1', skillAttachments: [] } };
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
  if (container) await stopPostgresContainer(container);
});

describe('Connections mirror property (TASK-42)', () => {
  it('a per-user attachment appears in Connections, and detaching there removes it', async () => {
    const h = await makeHarness();
    const sys = h.ctx();

    // 1) Simulate the card grant (host-side): install the skill, attach for u1.
    await h.bus.call('skills:upsert', sys, {
      manifestYaml: SAMPLE_MANIFEST,
      bodyMd: SAMPLE_BODY,
    });
    await h.bus.call('skills:attach-for-user', sys, {
      userId: 'u1',
      agentId: 'a1',
      skillId: 'github',
      credentialBindings: {},
    });

    const handlers = makeConnectionsHandlers({ bus: h.bus, initCtx });

    // 2) GET connections shows it as removable (source: user).
    const get = mkRes();
    await handlers.get(mkReq({ agentId: 'a1' }), get.res);
    expect(get.captured.statusCode).toBe(200);
    const skills = (get.captured.body as { skills: unknown[] }).skills;
    expect(skills).toContainEqual(
      expect.objectContaining({ skillId: 'github', source: 'user', removable: true }),
    );

    // 3) DELETE there → 204; the per-user attachment is gone (mirror propagates
    //    back to the @ax/skills source of truth).
    const del = mkRes();
    await handlers.detach(mkReq({ agentId: 'a1', skillId: 'github' }), del.res);
    expect(del.captured.statusCode).toBe(204);

    const after = await h.bus.call<
      { userId: string; agentId: string },
      { attachments: unknown[] }
    >('skills:list-user-attachments', sys, { userId: 'u1', agentId: 'a1' });
    expect(after.attachments).toEqual([]);
  });
});
