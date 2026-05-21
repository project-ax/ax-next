/**
 * E2E skill-install canary (Phase F1).
 *
 * Boots a REAL Postgres testcontainer with the REAL @ax/skills, @ax/agents,
 * and @ax/chat-orchestrator plugins and walks the install → attach → invoke
 * path end-to-end. The sandbox + proxy layers are CAPTURING fakes (push their
 * input into arrays) so we can assert exactly what the orchestrator hands the
 * boundary that a real runner would consume:
 *
 *   - `proxy:open-session` receives the UNIONED allowlist + credential map
 *     (agent defaults ∪ each attached skill's declared hosts/slots).
 *   - `sandbox:open-session` receives the installed SKILL.md as
 *     `installedSkills: [{ id, skillMd, mcpServers }]`.
 *
 * This replaces the manual skill-install acceptance walk for the install path:
 * a regression in the resolve→union→materialize chain now fails CI instead of
 * waiting for a human to drive the cluster.
 *
 * Why these are TEST-only imports of @ax/agents + @ax/chat-orchestrator:
 * they're devDependencies, imported only in this file. eslint's
 * no-restricted-imports cross-plugin guard does not apply under __tests__/
 * (the @ax/agents promote-authored-skills test imports @ax/skills the same
 * way). We are NOT establishing a runtime cross-plugin dep — the production
 * coupling is the hook bus, exercised here through real plugins.
 *
 * Stub set required to reach proxy:open-session (discovered by walking the
 * orchestrator in order — chat:start → agents:resolve(real) → [no
 * conversation: ctx omits conversationId] → skills:resolve(real) +
 * skills:list-defaults(real) → proxy:open-session → sandbox:open-session →
 * session:queue-work):
 *   - http:register-route   (agents + skills mount admin routes at init)
 *   - auth:require-user      (agents + skills declare it a hard `calls` dep)
 *   - proxy:open-session     CAPTURING fake (allowlist + credentials)
 *   - proxy:close-session    no-op (orchestrator closes in finally)
 *   - sandbox:open-session   CAPTURING fake (installedSkills) + fires chat:end
 *   - session:queue-work     no-op (orchestrator queues the user message)
 *   - session:terminate      no-op (defensive cleanup paths)
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  vi,
} from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import {
  makeAgentContext,
  createLogger,
  type AgentContext,
  type AgentOutcome,
  type ServiceHandler,
  HookBus,
} from '@ax/core';
import { createAgentsPlugin } from '@ax/agents';
import { createChatOrchestratorPlugin } from '@ax/chat-orchestrator';
import { createSkillsPlugin } from '../../plugin.js';
import { createAdminSkillsHandlers } from '../../admin-routes.js';
import type { RouteRequest, RouteResponse } from '../../admin-routes.js';
import type {
  SkillsUpsertInput,
  SkillsUpsertOutput,
  SkillsListInput,
  SkillsListOutput,
  SkillsGetInput,
  SkillsGetOutput,
} from '../../types.js';

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
  vi.restoreAllMocks();
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    await h.close({ onError: () => {} });
  }
  const cleanup = new (await import('pg')).default.Client({ connectionString });
  await cleanup.connect();
  try {
    // Drop every table the three plugins create so rows don't bleed between
    // tests. (Each test boots a fresh harness, but the Postgres instance is
    // shared across the whole file.)
    await cleanup.query('DROP TABLE IF EXISTS agents_v1_skill_attachments');
    await cleanup.query('DROP TABLE IF EXISTS agents_v1_agents');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_user_skills');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_skills');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Shared stubs
// ---------------------------------------------------------------------------

// Both @ax/skills and @ax/agents declare http:register-route + auth:require-user
// as hard `calls` deps (they mount admin routes at init). We don't boot
// @ax/http-server or @ax/auth here, so we stub both.
const httpRegisterRouteStub: ServiceHandler = async () => ({
  unregister: () => {},
});
const authRequireUserStub: ServiceHandler = async () => ({
  user: { id: 'admin', isAdmin: true },
});

/** Build an AgentContext whose owner triple resolves the given agent. */
function ctxFor(agentId: string, userId: string, sessionId: string): AgentContext {
  return makeAgentContext({
    sessionId,
    agentId,
    userId,
    logger: createLogger({ reqId: `canary-${sessionId}`, writer: () => undefined }),
  });
}

// ---------------------------------------------------------------------------
// Capturing-fake bundle
// ---------------------------------------------------------------------------

interface CaptureBundle {
  proxyOpenInputs: Array<{
    sessionId: string;
    userId: string;
    agentId: string;
    allowlist: string[];
    credentials: Record<string, { ref: string; kind: string }>;
  }>;
  sandboxOpenInputs: Array<{
    sessionId: string;
    installedSkills?: Array<{ id: string; skillMd: string; mcpServers: unknown[] }>;
  }>;
  services: Record<string, ServiceHandler>;
}

/**
 * Build the capturing proxy + sandbox fakes plus the no-op session stubs the
 * orchestrator needs to reach (and pass) proxy:open-session. The sandbox fake
 * fires chat:end (keyed by the originating ctx.reqId, exactly like a real
 * runner posting /event.chat-end → the IPC server) so agent:invoke resolves
 * with a `complete` outcome.
 */
function buildCaptureFakes(busRef: { current: HookBus | null }): CaptureBundle {
  const proxyOpenInputs: CaptureBundle['proxyOpenInputs'] = [];
  const sandboxOpenInputs: CaptureBundle['sandboxOpenInputs'] = [];

  const services: Record<string, ServiceHandler> = {
    'http:register-route': httpRegisterRouteStub,
    'auth:require-user': authRequireUserStub,

    // CAPTURING — allowlist + credentials land here.
    'proxy:open-session': async (_ctx, input: unknown) => {
      proxyOpenInputs.push(input as CaptureBundle['proxyOpenInputs'][number]);
      return {
        proxyEndpoint: 'tcp://127.0.0.1:54321',
        caCertPem: 'TEST-CA-PEM',
        envMap: {},
      };
    },
    'proxy:close-session': async () => ({}),

    // CAPTURING — installedSkills (SKILL.md) lands here. Also fires chat:end
    // so the orchestrator's waiter resolves.
    'sandbox:open-session': async (ctx, input: unknown) => {
      sandboxOpenInputs.push(input as CaptureBundle['sandboxOpenInputs'][number]);
      const sessionId = (input as { sessionId: string }).sessionId;
      const originatingReqId = ctx.reqId;
      setImmediate(() => {
        void busRef.current!.fire(
          'chat:end',
          makeAgentContext({
            sessionId,
            agentId: 'a',
            userId: 'u',
            reqId: originatingReqId,
            logger: createLogger({ reqId: originatingReqId, writer: () => undefined }),
          }),
          { outcome: { kind: 'complete', messages: [] } },
        );
      });
      return {
        runnerEndpoint: 'unix:///tmp/canary.sock',
        handle: {
          kill: async () => undefined,
          exited: new Promise(() => undefined),
        },
      };
    },
    'session:queue-work': async () => ({ cursor: 0 }),
    'session:terminate': async () => ({}),
  };

  return { proxyOpenInputs, sandboxOpenInputs, services };
}

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------

/** Create a personal agent owned by `userId`; return its id. */
async function createPersonalAgent(h: TestHarness, userId: string): Promise<string> {
  const out = await h.bus.call<
    { actor: { userId: string; isAdmin: boolean }; input: Record<string, unknown> },
    { agent: { id: string } }
  >('agents:create', h.ctx({ userId }), {
    actor: { userId, isAdmin: false },
    input: {
      displayName: 'Canary Agent',
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
 * Attach an installed skill to an agent via the REAL agents:set-skill-
 * attachments hook. (Attachments are written exclusively through this hook /
 * the PATCH route — never agents:create, per the @ax/agents type docs.)
 */
async function attachSkill(
  h: TestHarness,
  agentId: string,
  userId: string,
  skillId: string,
  credentialBindings: Record<string, string>,
): Promise<void> {
  await h.bus.call<
    {
      actor: { userId: string; isAdmin: boolean };
      agentId: string;
      attachments: Array<{ skillId: string; credentialBindings: Record<string, string> }>;
    },
    unknown
  >('agents:set-skill-attachments', h.ctx({ userId }), {
    actor: { userId, isAdmin: true },
    agentId,
    attachments: [{ skillId, credentialBindings }],
  });
}

// mkReq / mkRes for the refresh admin handler (Case 3). Same pattern as
// skills' admin-routes.test.ts.
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

function mkReq(opts: { body?: unknown; params?: Record<string, string> }): RouteRequest {
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

// A GitHub skill manifest declaring one credentialed host + one slot. The
// orchestrator must union api.github.com into the allowlist and
// GITHUB_TOKEN into the credentials map.
const GITHUB_MANIFEST = `name: github
description: GitHub
version: 1
capabilities:
  allowedHosts:
    - api.github.com
  credentials:
    - slot: GITHUB_TOKEN
      kind: api-key
`;

// ---------------------------------------------------------------------------
// Case 1 — the core install → attach → invoke walk (full orchestrator)
// ---------------------------------------------------------------------------

describe('skill-install canary: install → attach → invoke (real plugins)', () => {
  it('unioned allowlist + credentials reach proxy:open-session, SKILL.md reaches sandbox:open-session', async () => {
    const busRef: { current: HookBus | null } = { current: null };
    const fakes = buildCaptureFakes(busRef);

    const h = await createTestHarness({
      services: fakes.services,
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        createAgentsPlugin(),
        createSkillsPlugin(),
        createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant',
          oneShot: true,
          chatTimeoutMs: 5_000,
        }),
      ],
    });
    harnesses.push(h);
    busRef.current = h.bus;

    // 1. Install the GitHub skill (global scope; default).
    const upsert = await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>(
      'skills:upsert',
      h.ctx(),
      { manifestYaml: GITHUB_MANIFEST, bodyMd: 'Body.' },
    );
    expect(upsert.skillId).toBe('github');
    expect(upsert.created).toBe(true);

    // 2. Create alice's agent and attach the installed skill with a binding.
    const agentId = await createPersonalAgent(h, 'alice');
    await attachSkill(h, agentId, 'alice', 'github', {
      GITHUB_TOKEN: 'cred-ref-alice-gh',
    });

    // 3. Invoke the agent through the REAL orchestrator. ctx carries alice's
    //    owner triple so the real agents:resolve ACL gate passes, and OMITS
    //    conversationId so the orchestrator doesn't touch conversations:*.
    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      ctxFor(agentId, 'alice', 'canary-walk'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');

    // 4. proxy:open-session received the UNIONED allowlist + credentials.
    expect(fakes.proxyOpenInputs).toHaveLength(1);
    const proxyIn = fakes.proxyOpenInputs[0]!;
    expect(proxyIn.allowlist).toContain('api.github.com');
    expect(proxyIn.credentials.GITHUB_TOKEN).toEqual({
      ref: 'cred-ref-alice-gh',
      kind: 'api-key',
    });

    // 5. sandbox:open-session received the installed SKILL.md.
    expect(fakes.sandboxOpenInputs).toHaveLength(1);
    const installed = fakes.sandboxOpenInputs[0]!.installedSkills ?? [];
    expect(installed.length).toBeGreaterThanOrEqual(1);
    expect(installed.some((s) => s.skillMd.includes('name: github'))).toBe(true);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Case 2 — user-scope isolation through the real store (no orchestrator)
// ---------------------------------------------------------------------------

describe('skill-install canary: user-scope isolation (real store)', () => {
  it('alice user-scope skill is visible to alice, invisible to bob', async () => {
    // No orchestrator here — Case 2 exercises only the real skills store on
    // Postgres. (The orchestrator declares session:queue-work as a hard
    // `calls` dep, which only Case 1's capture harness stubs.)
    const h = await createTestHarness({
      services: {
        'http:register-route': httpRegisterRouteStub,
        'auth:require-user': authRequireUserStub,
      },
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        createAgentsPlugin(),
        createSkillsPlugin(),
      ],
    });
    harnesses.push(h);

    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      scope: 'user',
      ownerUserId: 'alice',
      manifestYaml: 'name: secret\ndescription: alice secret\nversion: 1\n',
      bodyMd: 'b',
    });

    const aliceList = await h.bus.call<SkillsListInput, SkillsListOutput>(
      'skills:list',
      h.ctx(),
      { scope: 'user', ownerUserId: 'alice' },
    );
    expect(aliceList.skills.map((s) => s.id)).toContain('secret');

    const bobList = await h.bus.call<SkillsListInput, SkillsListOutput>(
      'skills:list',
      h.ctx(),
      { scope: 'user', ownerUserId: 'bob' },
    );
    expect(bobList.skills.map((s) => s.id)).not.toContain('secret');
  });
});

// ---------------------------------------------------------------------------
// Case 3 — refresh-from-source through the real plugin (mocked fetch)
//
// Mocked the remote with `vi.spyOn(globalThis, 'fetch')` (no msw): the spy
// returns a higher-version SKILL.md for the skill's sourceUrl. We exercise the
// THROUGH-THE-PLUGIN path — createAdminSkillsHandlers({ bus }).refresh, which
// calls skills:check-for-updates (→ checkForUpdates with the real
// globalThis.fetch the spy now owns) and then the implied skills:upsert.
// Asserts the stored row's version + body updated to the remote's.
// ---------------------------------------------------------------------------

describe('skill-install canary: refresh-from-source (mocked fetch, through the plugin)', () => {
  it('a higher-version remote manifest updates the stored skill via /refresh-from-source', async () => {
    // No orchestrator here — Case 3 exercises only the real skills refresh
    // path (admin handler → skills:check-for-updates → skills:upsert).
    const h = await createTestHarness({
      services: {
        'http:register-route': httpRegisterRouteStub,
        'auth:require-user': authRequireUserStub,
      },
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        createAgentsPlugin(),
        createSkillsPlugin(),
      ],
    });
    harnesses.push(h);

    const SOURCE_URL = 'https://example.com/github.md';

    // 1. Install version 1 with a sourceUrl (https — the parser accepts it).
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: `name: refreshable
description: refreshable skill
version: 1
sourceUrl: ${SOURCE_URL}
`,
      bodyMd: 'old body\n',
    });

    // 2. Mock the remote: return a v2 SKILL.md (frontmatter fence + body) for
    //    the sourceUrl. check-for-updates calls globalThis.fetch(detail.sourceUrl).
    const REMOTE_SKILL_MD = `---
name: refreshable
description: refreshable skill
version: 2
sourceUrl: ${SOURCE_URL}
---
new body from remote
`;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input: unknown) => {
        const url = typeof input === 'string' ? input : String(input);
        expect(url).toBe(SOURCE_URL);
        return {
          ok: true,
          status: 200,
          text: async () => REMOTE_SKILL_MD,
        } as unknown as Response;
      },
    );

    // 3. Drive the real refresh admin handler.
    const handlers = createAdminSkillsHandlers({ bus: h.bus });
    const { res, statusOf, bodyOf } = mkRes();
    await handlers.refresh(mkReq({ params: { id: 'refreshable' } }), res);

    expect(fetchSpy).toHaveBeenCalled();
    expect(statusOf()).toBe(200);
    expect(bodyOf()).toMatchObject({ updated: true, newVersion: 2 });

    // 4. The stored row now reflects the remote: version 2 + new body.
    const detail = await h.bus.call<SkillsGetInput, SkillsGetOutput>(
      'skills:get',
      h.ctx(),
      { skillId: 'refreshable' },
    );
    expect(detail.version).toBe(2);
    expect(detail.bodyMd).toContain('new body from remote');
  });
});
