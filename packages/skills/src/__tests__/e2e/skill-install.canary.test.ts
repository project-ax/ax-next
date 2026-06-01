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
 *   - `sandbox:open-session` receives the installed bundle as a file tree:
 *     `installedSkills: [{ id, files: [{ path, contents }], mcpServers }]`
 *     (SKILL.md reconstructed from the manifest columns + any extra files).
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
import {
  createTestHarness,
  mockBlobStoreServices as blobStoreFakeServices,
  type TestHarness, stopPostgresContainer } from '@ax/test-harness';
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
import { createToolDispatcherPlugin } from '@ax/mcp-client';
import { createSkillBrokerPlugin } from '@ax/skill-broker';
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
  SkillsAttachForUserInput,
  SkillsAttachForUserOutput,
  CatalogSubmitInput,
  CatalogSubmitOutput,
  CatalogAdmitInput,
  CatalogAdmitOutput,
  CatalogListRequestsInput,
  CatalogListRequestsOutput,
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
  if (container) await stopPostgresContainer(container);
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
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_catalog_requests');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_user_attachments');
    await cleanup.query('DROP TABLE IF EXISTS skills_v1_skill_files');
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
    installedSkills?: Array<{
      id: string;
      files: Array<{ path: string; contents: string }>;
      mcpServers: unknown[];
    }>;
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
// out-of-git Part D2: @ax/skills now stores bundle EXTRA files in the shared
// blob store (hard-deps blob:put/blob:get). The shared content-addressed
// in-process fake is `mockBlobStoreServices` (imported as blobStoreFakeServices).

function buildCaptureFakes(busRef: { current: HookBus | null }): CaptureBundle {
  const proxyOpenInputs: CaptureBundle['proxyOpenInputs'] = [];
  const sandboxOpenInputs: CaptureBundle['sandboxOpenInputs'] = [];

  const services: Record<string, ServiceHandler> = {
    'http:register-route': httpRegisterRouteStub,
    'auth:require-user': authRequireUserStub,

    // out-of-git Part D2: @ax/skills now stores bundle EXTRA files in the shared
    // blob store (hard-deps blob:put/blob:get). Provide a content-addressed
    // in-process fake (the canary asserts reachability, not the fs backend).
    ...blobStoreFakeServices(),

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

// A GitHub skill manifest. TASK-100 — a skill declares NO capabilities; its
// reach is the connector it references. The orchestrator materializes its
// SKILL.md body but contributes NO skill host/credential to the proxy (caps flow
// via the connector path, covered by connector-union.test.ts).
const GITHUB_MANIFEST = `name: github
description: GitHub
version: 1
connectors:
  - github
`;

// ---------------------------------------------------------------------------
// Case 1 — the core install → attach → invoke walk (full orchestrator)
// ---------------------------------------------------------------------------

describe('skill-install canary: install → attach → invoke (real plugins)', () => {
  it('SKILL.md reaches sandbox:open-session; a cap-free skill contributes no host/credential to proxy:open-session', async () => {
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

    // 2. Create alice's agent and attach the installed skill (no bindings — a
    //    skill declares no credential slots, TASK-100).
    const agentId = await createPersonalAgent(h, 'alice');
    await attachSkill(h, agentId, 'alice', 'github', {});

    // 3. Invoke the agent through the REAL orchestrator. ctx carries alice's
    //    owner triple so the real agents:resolve ACL gate passes, and OMITS
    //    conversationId so the orchestrator doesn't touch conversations:*.
    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      ctxFor(agentId, 'alice', 'canary-walk'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');

    // 4. proxy:open-session received NO skill-derived host or credential — a
    //    skill carries no caps now (its reach is its connector, folded via the
    //    connector path, which is covered by connector-union.test.ts).
    expect(fakes.proxyOpenInputs).toHaveLength(1);
    const proxyIn = fakes.proxyOpenInputs[0]!;
    expect(proxyIn.allowlist).not.toContain('api.github.com');
    expect(proxyIn.credentials['skill:github:GITHUB_TOKEN']).toBeUndefined();

    // 5. sandbox:open-session received the installed bundle as a file tree
    //    whose SKILL.md (reconstructed from the manifest columns) carries the
    //    manifest. The legacy single `skillMd` string field is gone.
    expect(fakes.sandboxOpenInputs).toHaveLength(1);
    const installed = fakes.sandboxOpenInputs[0]!.installedSkills ?? [];
    expect(installed.length).toBeGreaterThanOrEqual(1);
    const gh = installed.find((s) => s.id === 'github')!;
    expect('skillMd' in gh).toBe(false);
    const skillMd = gh.files.find((f) => f.path === 'SKILL.md');
    expect(skillMd?.contents).toContain('name: github');
    // Single-file (SKILL.md-only) skill materializes EXACTLY one file — the
    // byte-identical-behavior guarantee for pre-bundle skills.
    expect(gh.files.map((f) => f.path)).toEqual(['SKILL.md']);
  }, 60_000);

  it('a multi-file bundle threads SKILL.md + extra files through to sandbox:open-session', async () => {
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

    // Install a bundle skill carrying an EXTRA file alongside SKILL.md.
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: GITHUB_MANIFEST,
      bodyMd: 'Body.',
      files: [{ path: 'scripts/run.py', contents: 'print("hi")' }],
    });

    const agentId = await createPersonalAgent(h, 'alice');
    await attachSkill(h, agentId, 'alice', 'github', {});

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      ctxFor(agentId, 'alice', 'canary-bundle-walk'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');

    expect(fakes.sandboxOpenInputs).toHaveLength(1);
    const installed = fakes.sandboxOpenInputs[0]!.installedSkills ?? [];
    const gh = installed.find((s) => s.id === 'github')!;
    // SKILL.md (reconstructed) + the resolved extra file, both present.
    expect(gh.files.find((f) => f.path === 'SKILL.md')?.contents).toContain('name: github');
    expect(gh.files.find((f) => f.path === 'scripts/run.py')?.contents).toBe('print("hi")');

    // TASK-40: the extra file is backed by the content-addressed git bundle
    // store — the catalog row carries a 40-hex tree SHA, proving the internal
    // swap actually went through the git store (not the legacy files table).
    const probe = new (await import('pg')).default.Client({ connectionString });
    await probe.connect();
    try {
      const treeRow = await probe.query(
        "SELECT bundle_tree_sha FROM skills_v1_skills WHERE skill_id = 'github'",
      );
      expect(treeRow.rows[0]?.bundle_tree_sha).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await probe.end().catch(() => {});
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Case 1b (TASK-33) — per-user attachment unions through the real orchestrator
//
// A user activates a catalog skill on THEIR agent via skills:attach-for-user
// (host-side, no agent path). The orchestrator's skills:list-user-attachments
// fetch unions the per-user host + binding into proxy:open-session, and the
// per-user binding WINS over an agent-global binding for the same skill id.
// ---------------------------------------------------------------------------

const LINEAR_MANIFEST = `name: linear
description: Linear
version: 1
connectors:
  - linear
`;

describe('skill-install canary: per-user attachment union (TASK-33, real plugins)', () => {
  function buildRealHarness(busRef: { current: HookBus | null }) {
    const fakes = buildCaptureFakes(busRef);
    return createTestHarness({
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
    }).then((h) => ({ h, fakes }));
  }

  it('a per-user attached skill materializes its body but contributes NO skill caps to proxy (TASK-100)', async () => {
    const busRef: { current: HookBus | null } = { current: null };
    const { h, fakes } = await buildRealHarness(busRef);
    harnesses.push(h);
    busRef.current = h.bus;

    // 1. Install the linear skill (global catalog).
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: LINEAR_MANIFEST,
      bodyMd: 'Body.',
    });

    // 2. Create alice's agent. NO agent-global attachment — purely per-user.
    const agentId = await createPersonalAgent(h, 'alice');

    // 3. Alice self-serve activates linear on HER agent (no bindings — a skill
    //    declares no credential slots).
    const attached = await h.bus.call<SkillsAttachForUserInput, SkillsAttachForUserOutput>(
      'skills:attach-for-user',
      h.ctx({ userId: 'alice' }),
      { userId: 'alice', agentId, skillId: 'linear', credentialBindings: {} },
    );
    expect(attached.created).toBe(true);

    // 4. Invoke through the REAL orchestrator (alice's owner triple).
    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      ctxFor(agentId, 'alice', 'per-user-walk'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');

    // 5. The skill's SKILL.md materialized, but it contributed NO host/credential
    //    to the proxy — a skill's reach is its connector (folded via the connector
    //    path, covered by connector-union.test.ts).
    expect(fakes.sandboxOpenInputs[0]!.installedSkills?.some((s) => s.id === 'linear')).toBe(true);
    const proxyIn = fakes.proxyOpenInputs[0]!;
    expect(proxyIn.allowlist).not.toContain('api.linear.app');
    expect(proxyIn.credentials['skill:linear:LINEAR_TOKEN']).toBeUndefined();
  }, 60_000);

  it('a user-scoped skill of the same id overrides the global content (skills:resolve ownerUserId)', async () => {
    const busRef: { current: HookBus | null } = { current: null };
    const { h, fakes } = await buildRealHarness(busRef);
    harnesses.push(h);
    busRef.current = h.bus;

    // Global `gh` (one body) AND a user-scoped `gh` for alice (different body).
    // The user-scoped content must win at session open. TASK-100 — manifests are
    // cap-free; this asserts the BODY override (the surviving precedence behavior).
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: 'name: gh\ndescription: global gh\nversion: 1\nconnectors:\n  - global-connector\n',
      bodyMd: 'GLOBAL BODY',
    });
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      scope: 'user',
      ownerUserId: 'alice',
      manifestYaml: 'name: gh\ndescription: alice gh\nversion: 1\nconnectors:\n  - user-connector\n',
      bodyMd: 'USER BODY',
    });

    const agentId = await createPersonalAgent(h, 'alice');
    await h.bus.call<SkillsAttachForUserInput, SkillsAttachForUserOutput>(
      'skills:attach-for-user',
      h.ctx({ userId: 'alice' }),
      { userId: 'alice', agentId, skillId: 'gh', credentialBindings: {} },
    );

    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      ctxFor(agentId, 'alice', 'content-override-walk'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');

    // The sandbox got the USER-scoped body, not the global one.
    const installed = fakes.sandboxOpenInputs[0]!.installedSkills ?? [];
    const gh = installed.find((s) => s.id === 'gh');
    expect(gh).toBeDefined();
    const ghSkillMd = gh!.files.find((f) => f.path === 'SKILL.md')?.contents ?? '';
    expect(ghSkillMd).toContain('name: gh');
    expect(ghSkillMd).toContain('USER BODY');
    expect(ghSkillMd).not.toContain('GLOBAL BODY');
    // The user-scoped manifest references user-connector (the precedence winner).
    expect(ghSkillMd).toContain('user-connector');
    expect(ghSkillMd).not.toContain('global-connector');
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
        ...blobStoreFakeServices(),
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
        ...blobStoreFakeServices(),
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

// ---------------------------------------------------------------------------
// Case 3 (TASK-34) — the model-brokered surfacing spine reaches the real
// catalog end-to-end. Boots the REAL @ax/skills (Postgres), the real
// tool-dispatcher (tool:register), and the real @ax/skill-broker, then walks
// the model→host-tool→hook path: search_catalog → skills:search-catalog and
// request_capability → skills:get. Closes invariant #3 (no half-wired plugin)
// for the search_catalog path: the broker is reachable from the canary.
// ---------------------------------------------------------------------------
describe('skill-broker canary: search_catalog + request_capability reach the real catalog', () => {
  it('search_catalog returns the candidate (inert, no hosts/slots) and request_capability validates against the catalog', async () => {
    const h = await createTestHarness({
      services: {
        // @ax/skills mounts admin + settings HTTP routes at init; we don't boot
        // http-server/auth here, so stub the two calls it declares.
        'http:register-route': httpRegisterRouteStub,
        'auth:require-user': authRequireUserStub,
        ...blobStoreFakeServices(),
      },
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        createToolDispatcherPlugin(),
        createSkillsPlugin(),
        createSkillBrokerPlugin(),
      ],
    });
    harnesses.push(h);

    // Install a GitHub skill into the global catalog. TASK-100 — a skill declares
    // no caps, so its tier is 'inert' and it surfaces no hosts/slots of its own.
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: GITHUB_MANIFEST,
      bodyMd: 'Body.',
    });

    // search_catalog (model → host tool → skills:search-catalog).
    const search = await h.bus.call('tool:execute:search_catalog', h.ctx(), {
      name: 'search_catalog',
      input: { intent: 'work with my github issues' },
    });
    const hit = (search as { skills: Array<{ id: string; tier: string; hosts: string[]; slots: string[] }> }).skills.find(
      (s) => s.id === 'github',
    );
    expect(hit?.tier).toBe('inert');
    expect(hit?.hosts).toEqual([]);
    expect(hit?.slots).toEqual([]);

    // request_capability for a real catalog skill → structured ack (the skill
    // references a connector that isn't resolvable here, so no card fires, but
    // the ack is still 'requested').
    const ok = await h.bus.call('tool:execute:request_capability', h.ctx(), {
      name: 'request_capability',
      input: { skillId: 'github' },
    });
    expect(ok).toEqual({ status: 'requested', skillId: 'github' });

    // request_capability for an unknown skill → not-found (not an error).
    const miss = await h.bus.call('tool:execute:request_capability', h.ctx(), {
      name: 'request_capability',
      input: { skillId: 'does-not-exist' },
    });
    expect(miss).toEqual({ status: 'not-found', skillId: 'does-not-exist' });

    // TASK-53 (design §13) — the miss filed a cold-start admit-queue request to
    // the REAL @ax/skills catalog so the unmet need reaches the admin. Closes
    // invariant #3 (no half-wired): the broker's cold-start trigger is reachable
    // from the canary, end-to-end over the real queue.
    const pending = await h.bus.call<CatalogListRequestsInput, CatalogListRequestsOutput>(
      'catalog:list-requests',
      h.ctx(),
      {},
    );
    const coldStart = pending.requests.find((r) => r.skillId === 'does-not-exist');
    expect(coldStart).toBeDefined();
    expect(coldStart?.kind).toBe('cold-start');
    expect(coldStart?.status).toBe('pending');
    // requestedByUserId is the authenticated caller (harness default), never
    // model input; a cold-start carries no bundle snapshot.
    expect(coldStart?.requestedByUserId).toBe('test-user');
    expect(coldStart?.manifestYaml).toBeNull();
    expect(coldStart?.files).toEqual([]);
  }, 60_000);

  it('request_capability fires NO card for a skill whose referenced connector is not resolvable (TASK-100)', async () => {
    // TASK-100 — a skill's approval card is built ENTIRELY from the connectors it
    // references (resolved via connectors:resolve). Here @ax/connectors is NOT
    // loaded, so the referenced connector resolves to no reach → the card surface
    // is empty → NO card fires (request_capability is a no-op approval surface).
    // The connector-derived card is exercised in the @ax/connectors + broker
    // tests where connectors:resolve is live.
    const h = await createTestHarness({
      services: {
        'http:register-route': httpRegisterRouteStub,
        'auth:require-user': authRequireUserStub,
        ...blobStoreFakeServices(),
      },
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        createToolDispatcherPlugin(),
        createSkillsPlugin(),
        createSkillBrokerPlugin(),
      ],
    });
    harnesses.push(h);

    // A skill referencing the github connector (no caps of its own).
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: GITHUB_MANIFEST,
      bodyMd: 'Body.',
    });

    const cards: unknown[] = [];
    h.bus.subscribe('chat:permission-request', 'canary/card-capture', async (_c, p) => {
      cards.push(p);
      return undefined;
    });

    const convCtx = h.ctx({ conversationId: 'cnv_canary' });
    const ack = await h.bus.call('tool:execute:request_capability', convCtx, {
      name: 'request_capability',
      input: { skillId: 'github' },
    });
    // The ack is 'requested' (the skill exists), but no card fires (no reach).
    expect(ack).toEqual({ status: 'requested', skillId: 'github' });
    expect(cards).toHaveLength(0);

    // A not-found request also raises no card.
    const noCard = await h.bus.call('tool:execute:request_capability', convCtx, {
      name: 'request_capability',
      input: { skillId: 'does-not-exist' },
    });
    expect(noCard).toEqual({ status: 'not-found', skillId: 'does-not-exist' });
    expect(cards).toHaveLength(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// TASK-36 — the JIT happy path's last seam, end-to-end over the real catalog:
// request_capability (broker) raises the card → agent:apply-capability-grant
// (orchestrator) attaches the catalog skill for the user over the real
// per-user attach store + retires the warm session → a FRESH agent:invoke
// re-spawns and its sandbox:open-session carries the now-attached skill in
// installedSkills. This proves the re-spawn picks up the just-granted skill.
// Closes invariant #3 (no half-wired plugin) for the grant→re-spawn path.
// ---------------------------------------------------------------------------
describe('skill-install canary: approve → apply-capability-grant → fresh re-spawn includes the skill', () => {
  function buildGrantHarness(busRef: { current: HookBus | null }) {
    const fakes = buildCaptureFakes(busRef);
    return createTestHarness({
      services: fakes.services,
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        createAgentsPlugin(),
        createSkillsPlugin(),
        createToolDispatcherPlugin(),
        createSkillBrokerPlugin(),
        createChatOrchestratorPlugin({
          runnerBinary: '/irrelevant',
          oneShot: true,
          chatTimeoutMs: 5_000,
        }),
      ],
    }).then((h) => ({ h, fakes }));
  }

  it('request_capability raises the card; grant attaches over the real store; a fresh open includes the skill', async () => {
    const busRef: { current: HookBus | null } = { current: null };
    const { h, fakes } = await buildGrantHarness(busRef);
    harnesses.push(h);
    busRef.current = h.bus;

    // 1. Install the bounded linear skill into the global catalog (host + slot).
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: LINEAR_MANIFEST,
      bodyMd: 'Body.',
    });

    // 2. alice's agent. No agent-global attachment — the grant is purely
    //    per-user (the self-serve JIT path).
    const agentId = await createPersonalAgent(h, 'alice');
    const convCtx = ctxFor(agentId, 'alice', 'jit-walk');

    // 3. (TASK-34/35) request_capability validates the id + acks. TASK-100 — the
    //    skill references a connector that isn't resolvable in this harness (no
    //    @ax/connectors), so NO card fires (the connector-derived card is tested
    //    where connectors:resolve is live).
    const cards: Array<{ skillId: string; hosts: string[]; slots: unknown[] }> = [];
    h.bus.subscribe('chat:permission-request', 'canary/grant-card', async (_c, p) => {
      cards.push(p as never);
      return undefined;
    });
    const ack = await h.bus.call('tool:execute:request_capability', convCtx, {
      name: 'request_capability',
      input: { skillId: 'linear' },
    });
    expect(ack).toEqual({ status: 'requested', skillId: 'linear' });
    expect(cards).toHaveLength(0);

    // 4. (TASK-36) apply the grant over the REAL per-user attach store. TASK-100
    //    — a skill declares no credential slots, so the attachment carries no
    //    bindings ("granting" a skill = attaching its instruction body).
    const grant = await h.bus.call('agent:apply-capability-grant', convCtx, {
      conversationId: 'jit-walk',
      userId: 'alice',
      agentId,
      skillId: 'linear',
    });
    expect(grant).toEqual({ attached: true });

    const after = await h.bus.call('skills:list-user-attachments', convCtx, {
      userId: 'alice',
      agentId,
    });
    expect(
      (after as { attachments: Array<{ skillId: string; credentialBindings: Record<string, string> }> })
        .attachments,
    ).toContainEqual({
      skillId: 'linear',
      credentialBindings: {},
    });

    // 5. A FRESH agent:invoke for alice/agent re-spawns and MUST carry the
    //    now-attached skill body in sandbox:open-session.installedSkills.
    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      ctxFor(agentId, 'alice', 'jit-walk-respawn'),
      { message: { role: 'user', content: 'check my linear issues' } },
    );
    expect(outcome.kind).toBe('complete');

    expect(fakes.sandboxOpenInputs).toHaveLength(1);
    const installed = fakes.sandboxOpenInputs[0]!.installedSkills ?? [];
    expect(installed.map((s) => s.id)).toContain('linear');

    // The skill contributes NO host/credential of its own (its reach is the
    // connector it references, folded via the connector path).
    expect(fakes.proxyOpenInputs).toHaveLength(1);
    const proxyIn = fakes.proxyOpenInputs[0]!;
    expect(proxyIn.allowlist).not.toContain('api.linear.app');
    expect(proxyIn.credentials['skill:linear:LINEAR_TOKEN']).toBeUndefined();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Case (TASK-41) — share-to-catalog promotion + working-copy retirement (§6D)
//
// An author's user-scoped bundle skill is SHARED → an admin ADMITS it
// (promote to the global catalog + retire the author's editable user copy) →
// a fresh invoke re-resolves the author's attachment to the now-GLOBAL skill
// and materializes it read-only into the sandbox. Proves: shipped == reviewed
// (the bundle tree SHA registers in the global row), the user copy is retired,
// and there is no duplicate-id collision (exactly one materialized 'github').
// ---------------------------------------------------------------------------

describe('skill-install canary: share-to-catalog promotion (§6D, real plugins)', () => {
  it('admit promotes the author bundle to global, retires the user copy, and re-invoke materializes it', async () => {
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

    // 1. Alice authors a user-scoped bundle skill and attaches it on her agent.
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: GITHUB_MANIFEST,
      bodyMd: 'Body.',
      files: [{ path: 'scripts/run.py', contents: 'print("hi")' }],
      scope: 'user',
      ownerUserId: 'alice',
    });
    const agentId = await createPersonalAgent(h, 'alice');
    await attachSkill(h, agentId, 'alice', 'github', {});

    // 2. Share → admit.
    const sub = await h.bus.call<CatalogSubmitInput, CatalogSubmitOutput>('catalog:submit', h.ctx(), {
      kind: 'share',
      skillId: 'github',
      requestedByUserId: 'alice',
      description: 'share',
    });
    const admit = await h.bus.call<CatalogAdmitInput, CatalogAdmitOutput>('catalog:admit', h.ctx(), {
      requestId: sub.requestId,
      decision: 'admit',
      decidedByUserId: 'admin',
    });
    expect(admit).toEqual({ skillId: 'github', admitted: true });

    // 3. The user copy is gone; the global catalog row carries the bundle tree SHA.
    const probe = new (await import('pg')).default.Client({ connectionString });
    await probe.connect();
    try {
      const userRows = await probe.query(
        "SELECT skill_id FROM skills_v1_user_skills WHERE owner_user_id = 'alice' AND skill_id = 'github'",
      );
      expect(userRows.rows.length).toBe(0);
      const globalRow = await probe.query(
        "SELECT bundle_tree_sha FROM skills_v1_skills WHERE skill_id = 'github'",
      );
      expect(globalRow.rows[0]?.bundle_tree_sha).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await probe.end().catch(() => {});
    }

    // 4. Fresh invoke: the author's attachment re-resolves to the GLOBAL skill,
    //    materialized read-only — incl. the author. No duplicate-id collision.
    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      ctxFor(agentId, 'alice', 'canary-admit-walk'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');
    const installed = fakes.sandboxOpenInputs.at(-1)!.installedSkills ?? [];
    const gh = installed.filter((s) => s.id === 'github');
    expect(gh.length).toBe(1); // exactly one — no project/user duplicate-id collision
    expect(gh[0]!.files.find((f) => f.path === 'SKILL.md')?.contents).toContain('name: github');
    expect(gh[0]!.files.find((f) => f.path === 'scripts/run.py')?.contents).toBe('print("hi")');
  }, 60_000);
});

// TASK-100 — the account-tagged credential-slot canary block (TASK-43) was
// removed: a skill manifest no longer declares credential slots (its reach is
// the connectors it references), so per-skill account-tagged slot binding no
// longer exists at the skill layer. A connector's account-tagged credential
// binding is covered by the @ax/connectors connect-flow + connector-union tests.
