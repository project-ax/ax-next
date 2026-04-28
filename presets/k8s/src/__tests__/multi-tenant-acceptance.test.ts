import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  HookBus,
  bootstrap,
  makeAgentContext,
  type AgentContext,
  type AgentOutcome,
  type KernelHandle,
  type Plugin,
  type ToolDescriptor,
} from '@ax/core';
import { llmMockPlugin } from '@ax/llm-mock';
import { signCookieValue } from '@ax/http-server';
import { createK8sPlugins, type K8sPresetConfig } from '../index.js';

// ---------------------------------------------------------------------------
// Multi-tenant canary acceptance test (Week 9.5, Task 17).
//
// 10 scenarios end-to-end through the @ax/preset-k8s plugin set + a real
// postgres testcontainer. Two patches off the production preset:
//
//   - `@ax/sandbox-k8s` is REPLACED with a stub plugin (`@ax/sandbox-stub-acc`)
//     that fulfils `sandbox:open-session` by minting the session via the real
//     `session:create` (so `session_postgres_v2_session_agent` gets the owner
//     row Task 6a writes), then fires `chat:end` on a microtask so the
//     orchestrator's queue-work + waiter both flow through the real bus.
//
//   - `@ax/llm-anthropic` is REPLACED with `@ax/llm-mock` so we never call
//     the real API. The acceptance test never invokes `llm:call`, but the
//     anthropic plugin's init throws without `ANTHROPIC_API_KEY` so the
//     swap keeps the stack bootable in CI.
//
// Coverage map vs handoff §"Acceptance test for Week 9.5":
//
//   1.  /auth/dev-bootstrap mints initial admin (User A).
//   2.  Two distinct users present: User A from #1; User B inserted directly
//       into auth_v1_users + auth_v1_sessions, signed with the same cookie
//       key the http-server uses (sidesteps OIDC).
//   3.  User A POST /admin/agents → 201; agent:invoke with that agentId →
//       outcome.kind === 'complete'.
//   4.  GET /admin/agents as User B → empty list (User A's agent invisible).
//   5.  agent:invoke as User B with User A's agentId →
//       'terminated' / 'agent-resolve:forbidden'. Sandbox NOT opened.
//   6.  Team agent: User A creates team, adds User B, creates a team-agent.
//       agent:invoke as User B with the team agent id → 'complete'.
//   7.  Per-agent MCP scoping: tool:list against User A's session (with
//       mcpConfigIds:['fs']) sees the fixture mcp.fs.* tools; tool:list
//       against User B's session (with mcpConfigIds:[]) does not.
//   8.  GET /admin/agents anonymous → 401.
//
// Hardening (handoff §8):
//   A.  Foreign Origin POST without `X-Requested-With` → 403 (CSRF).
//   B.  Tampered cookie HMAC → 401.
//   C.  Cookie reuse after sign-out → 401.
//
// Runtime: dominated by the postgres testcontainer cold-start (~10-15s).
// Subsequent assertions run against the same container so the full file
// finishes well under 30s on a warm docker cache.
// ---------------------------------------------------------------------------

const COOKIE_KEY = randomBytes(32);
const DEV_TOKEN = 'multi-tenant-acceptance-bootstrap-token';
const CREDENTIALS_KEY_HEX = '42'.repeat(32);

// MCP-style tool descriptors registered by `mcpFixturePlugin` BEFORE the
// catalog seals. Names match the format mcp-client would have produced for
// a configured server with id='fs' (`mcp.<id>.<tool>`), so the agent ACL
// gate's `mcpConfigIds:['fs']` filter recognises them.
const MCP_FS_TOOL_NAMES = ['mcp.fs.read_file', 'mcp.fs.list'];

interface SerializedAgent {
  id: string;
  ownerId: string;
  ownerType: 'user' | 'team';
  visibility: 'personal' | 'team';
  displayName: string;
  systemPrompt: string;
  allowedTools: string[];
  mcpConfigIds: string[];
  model: string;
  workspaceRef: string | null;
}

interface SerializedTeam {
  id: string;
  displayName: string;
  createdBy: string;
  createdAt: string;
}

interface JsonResponse {
  status: number;
  body: Record<string, unknown> | null;
  setCookies: string[];
}

let container: StartedPostgreSqlContainer;
let connectionString: string;
let workspaceRoot: string;
let kernelHandle: KernelHandle;
let bus: HookBus;
let httpPort: number;
let userAId: string;
let userACookie: string;
let userASignedValue: string;
let userBId: string;
let userBCookie: string;

// Shared parsed sessionId for User A's signed cookie (only the HMAC payload
// is needed; we re-derive the inner value via splitting on '.' is unsafe
// because the cookie format isn't '<value>.<sig>' — http-server's signed
// cookie is opaque). We don't read the inner value anywhere; tests just
// reuse the full Cookie header for both User A and User B.

// ---------------------------------------------------------------------------
// Stub sandbox plugin. Replaces @ax/sandbox-k8s for this acceptance run.
// Mint the session via the real session-postgres `session:create` (so
// session:get-config + agents:resolved subscribers see a real owner row),
// then fire chat:end after the orchestrator's queue-work returns.
// ---------------------------------------------------------------------------

interface OpenSessionInput {
  sessionId: string;
  workspaceRoot: string;
  runnerBinary: string;
  owner?: {
    userId: string;
    agentId: string;
    agentConfig: {
      systemPrompt: string;
      allowedTools: string[];
      mcpConfigIds: string[];
      model: string;
    };
  };
}
interface SessionCreateInput {
  sessionId: string;
  workspaceRoot: string;
  owner?: OpenSessionInput['owner'];
}
interface SessionCreateOutput {
  sessionId: string;
  token: string;
}

function sandboxStubPlugin(): Plugin {
  return {
    manifest: {
      name: '@ax/sandbox-stub-acc',
      version: '0.0.0',
      registers: ['sandbox:open-session'],
      // We need to call session:create from within open-session so the
      // real v1+v2 rows land before queue-work runs.
      calls: ['session:create'],
      subscribes: [],
    },
    async init(deps): Promise<void> {
      deps.bus.registerService<OpenSessionInput, {
        runnerEndpoint: string;
        handle: { kill: () => Promise<void>; exited: Promise<unknown> };
      }>(
        'sandbox:open-session',
        '@ax/sandbox-stub-acc',
        async (ctx, input) => {
          // 1. Mint the session row (with owner triple → v2 row written
          //    atomically per Task 6a).
          await deps.bus.call<SessionCreateInput, SessionCreateOutput>(
            'session:create',
            ctx,
            {
              sessionId: input.sessionId,
              workspaceRoot: input.workspaceRoot,
              ...(input.owner !== undefined ? { owner: input.owner } : {}),
            },
          );

          // 2. Schedule the chat:end fire AFTER the orchestrator's
          //    session:queue-work has run. setImmediate gives the
          //    orchestrator's awaited queue-work a turn before we resolve
          //    the deferred via the chat:end subscriber.
          setImmediate(() => {
            void deps.bus
              .fire('chat:end', ctx, {
                outcome: {
                  kind: 'complete',
                  messages: [
                    { role: 'user', content: 'hi' },
                    { role: 'assistant', content: 'ok' },
                  ],
                },
              })
              .catch(() => {
                // best-effort
              });
          });

          return {
            runnerEndpoint: 'stub://acceptance',
            handle: {
              kill: async () => {
                // No-op; nothing to terminate.
              },
              // Never resolves on its own — chat:end resolves the deferred
              // first. The orchestrator's `handle.exited.then(...)` only
              // fires if chat:end didn't.
              exited: new Promise(() => undefined),
            },
          };
        },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// MCP fixture plugin. Pre-registers two `mcp.fs.*` tool descriptors at init
// (BEFORE the catalog seals on first tool:list call) so per-agent scoping
// has something concrete to filter on. Names mirror what @ax/mcp-client
// would produce for a configured server with id='fs'.
// ---------------------------------------------------------------------------

function mcpFixturePlugin(): Plugin {
  return {
    manifest: {
      name: '@ax/mcp-fixture-acc',
      version: '0.0.0',
      registers: [],
      calls: ['tool:register'],
      subscribes: [],
    },
    async init(deps): Promise<void> {
      const initCtx = makeAgentContext({
        sessionId: 'mcp-fixture-init',
        agentId: '@ax/mcp-fixture-acc',
        userId: 'init',
      });
      for (const name of MCP_FS_TOOL_NAMES) {
        const descriptor: ToolDescriptor = {
          name,
          inputSchema: { type: 'object' },
          executesIn: 'host',
        };
        await deps.bus.call('tool:register', initCtx, descriptor);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Postgres helpers
// ---------------------------------------------------------------------------

async function dropAllTables(): Promise<void> {
  const pgmod = await import('pg');
  const c = new pgmod.default.Client({ connectionString });
  await c.connect();
  try {
    // Drop in dependency-order. None of these have FKs across plugin
    // boundaries (Invariant I4) so the order only matters where we share
    // a plugin's own surface.
    await c.query('DROP TABLE IF EXISTS agents_v1_agents');
    await c.query('DROP TABLE IF EXISTS teams_v1_memberships');
    await c.query('DROP TABLE IF EXISTS teams_v1_teams');
    await c.query('DROP TABLE IF EXISTS auth_v1_sessions');
    await c.query('DROP TABLE IF EXISTS auth_v1_users');
  } finally {
    await c.end().catch(() => {});
  }
}

async function insertSecondUser(): Promise<{ userId: string; cookie: string }> {
  const pgmod = await import('pg');
  const c = new pgmod.default.Client({ connectionString });
  await c.connect();
  try {
    const userId = `usr_b_${randomBytes(4).toString('hex')}`;
    const subjectId = `bootstrap-test-b-${randomBytes(4).toString('hex')}`;
    await c.query(
      `INSERT INTO auth_v1_users (user_id, auth_subject_id, auth_provider, email, display_name, is_admin)
       VALUES ($1, $2, 'dev-bootstrap', NULL, 'User B', false)
       ON CONFLICT (auth_provider, auth_subject_id) DO NOTHING`,
      [userId, subjectId],
    );
    const sessionId = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await c.query(
      `INSERT INTO auth_v1_sessions (session_id, user_id, expires_at)
       VALUES ($1, $2, $3)`,
      [sessionId, userId, expiresAt],
    );
    const wire = signCookieValue(COOKIE_KEY, sessionId);
    return { userId, cookie: `ax_auth_session=${wire}` };
  } finally {
    await c.end().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// HTTP helper — tracks Set-Cookie so sign-in scenarios can extract the
// cookie value the http-server stamped onto the response.
// ---------------------------------------------------------------------------

async function httpRequest(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  init: {
    cookie?: string;
    body?: unknown;
    origin?: string;
    skipCsrfHeader?: boolean;
  } = {},
): Promise<JsonResponse> {
  const headers: Record<string, string> = {};
  if (init.skipCsrfHeader !== true) {
    headers['x-requested-with'] = 'ax-admin';
  }
  if (init.cookie !== undefined) headers['cookie'] = init.cookie;
  if (init.origin !== undefined) headers['origin'] = init.origin;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`http://127.0.0.1:${httpPort}${path}`, {
    method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await r.text();
  let parsed: Record<string, unknown> | null = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }
  const setCookies =
    r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie') ?? ''];
  return { status: r.status, body: parsed, setCookies };
}

// ---------------------------------------------------------------------------
// Bootstrap the kernel once.
// ---------------------------------------------------------------------------

beforeAll(async () => {
  process.env.AX_HTTP_ALLOW_NO_ORIGINS = '1';
  process.env.AX_CREDENTIALS_KEY = CREDENTIALS_KEY_HEX;

  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();

  await dropAllTables();

  workspaceRoot = mkdtempSync(join(tmpdir(), 'ax-mt-acc-'));

  const presetConfig: K8sPresetConfig = {
    database: { connectionString },
    eventbus: { connectionString },
    session: { connectionString },
    workspace: { backend: 'local', repoRoot: workspaceRoot },
    sandbox: { namespace: 'ax-mt-acc' },
    ipc: {
      host: '127.0.0.1',
      port: 0,
      hostIpcUrl: 'http://test-host.test.svc.cluster.local:80',
    },
    anthropic: { model: 'claude-sonnet-4-6' },
    chat: { runnerBinary: '/tmp/stub-runner.js', chatTimeoutMs: 5_000 },
    http: {
      host: '127.0.0.1',
      port: 0,
      cookieKey: COOKIE_KEY.toString('hex'),
      allowedOrigins: [],
    },
    auth: {
      devBootstrap: { token: DEV_TOKEN },
    },
  };

  const built = createK8sPlugins(presetConfig);
  // Two surgical replacements + one fixture insert. Order doesn't matter for
  // bootstrap (kernel topo-sorts on calls/registers); we keep the original
  // order otherwise so a reader's mental model of "preset = list" stays
  // intact.
  const plugins: Plugin[] = built
    .filter((p) => p.manifest.name !== '@ax/llm-anthropic')
    .filter((p) => p.manifest.name !== '@ax/sandbox-k8s');
  plugins.push(llmMockPlugin());
  plugins.push(sandboxStubPlugin());
  plugins.push(mcpFixturePlugin());

  bus = new HookBus();
  kernelHandle = await bootstrap({ bus, plugins, config: {} });

  // Discover the http-server's bound port. The plugin doesn't expose a
  // public hook for it — but the preset's `createHttpServerPlugin` returns
  // an instance whose `.boundPort()` we can read. Since createK8sPlugins
  // hides the instance, we recover the port from the listening socket via
  // a probe: every admin/auth route is mounted on the same listener, so
  // hitting /auth/dev-bootstrap with the right headers must succeed
  // independent of port discovery — but we still need a port. Instead,
  // grab the http-server plugin we kept by reference.
  //
  // Pattern: walk the kept `built` list (before our filter) for the
  // plugin instance. createHttpServerPlugin's returned object includes
  // boundPort(); mark the cast explicitly so a future preset change makes
  // this break loudly.
  const httpInstance = built.find(
    (p) => p.manifest.name === '@ax/http-server',
  ) as unknown as { boundPort?: () => number } | undefined;
  if (
    httpInstance === undefined ||
    typeof httpInstance.boundPort !== 'function'
  ) {
    throw new Error(
      'failed to find @ax/http-server in preset plugin list — preset shape changed?',
    );
  }
  httpPort = httpInstance.boundPort();
  if (typeof httpPort !== 'number' || httpPort <= 0) {
    throw new Error(`@ax/http-server bound an invalid port: ${httpPort}`);
  }

  // Bootstrap admin user via /auth/dev-bootstrap. This is what
  // `runAdminBootstrapCommand` calls under the hood; we drive the wire
  // directly since the CLI's job (arg parsing, output formatting) isn't
  // load-bearing for this acceptance test.
  const r = await httpRequest('POST', '/auth/dev-bootstrap', {
    body: {
      token: DEV_TOKEN,
      displayName: 'User A (admin)',
      email: 'admin-a@example.com',
    },
  });
  if (r.status !== 200) {
    throw new Error(
      `/auth/dev-bootstrap failed: ${r.status} ${JSON.stringify(r.body)}`,
    );
  }
  const aBody = r.body as { user: { id: string }; isNew: boolean };
  userAId = aBody.user.id;
  const sessionCookie = r.setCookies.find((c) =>
    c.startsWith('ax_auth_session='),
  );
  if (sessionCookie === undefined) {
    throw new Error('expected ax_auth_session in Set-Cookie');
  }
  userACookie = sessionCookie.split(';')[0]!;
  userASignedValue = userACookie.slice('ax_auth_session='.length);

  const second = await insertSecondUser();
  userBId = second.userId;
  userBCookie = second.cookie;
}, 120_000);

afterAll(async () => {
  await kernelHandle?.shutdown().catch(() => {});
  if (container) await container.stop();
  if (workspaceRoot) {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
  delete process.env.AX_HTTP_ALLOW_NO_ORIGINS;
  delete process.env.AX_CREDENTIALS_KEY;
}, 60_000);

// ---------------------------------------------------------------------------
// Helpers used inside it() bodies.
// ---------------------------------------------------------------------------

function ctxFor(opts: {
  sessionId: string;
  agentId: string;
  userId: string;
}): AgentContext {
  return makeAgentContext({
    sessionId: opts.sessionId,
    agentId: opts.agentId,
    userId: opts.userId,
    workspace: { rootPath: workspaceRoot },
  });
}

async function createPersonalAgent(
  cookie: string,
  overrides: Partial<{
    displayName: string;
    allowedTools: string[];
    mcpConfigIds: string[];
  }> = {},
): Promise<SerializedAgent> {
  const r = await httpRequest('POST', '/admin/agents', {
    cookie,
    body: {
      displayName: overrides.displayName ?? 'A Personal Agent',
      systemPrompt: 'You are helpful.',
      allowedTools: overrides.allowedTools ?? ['bash.run'],
      mcpConfigIds: overrides.mcpConfigIds ?? [],
      model: 'claude-opus-4-7',
      visibility: 'personal',
    },
  });
  expect(r.status).toBe(201);
  return (r.body as { agent: SerializedAgent }).agent;
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('multi-tenant acceptance (Week 9.5 — preset-k8s)', () => {
  // --- Acceptance scenarios 1-8 -------------------------------------------

  it('1. /auth/dev-bootstrap mints initial admin (User A); admin endpoints accept the cookie', async () => {
    expect(userAId).toMatch(/^usr_/);
    expect(userACookie).toMatch(/^ax_auth_session=/);
    const me = await httpRequest('GET', '/admin/me', { cookie: userACookie });
    expect(me.status).toBe(200);
    const meBody = me.body as { user: { id: string; isAdmin: boolean } };
    expect(meBody.user.id).toBe(userAId);
    expect(meBody.user.isAdmin).toBe(true);
  });

  it('2. Two distinct users authenticate (User A + direct-DB-insert User B)', async () => {
    // Sanity-check that we have two distinct user ids and that User B's
    // forged cookie also resolves through /admin/me.
    expect(userAId).not.toBe(userBId);
    const meB = await httpRequest('GET', '/admin/me', { cookie: userBCookie });
    expect(meB.status).toBe(200);
    const meBBody = meB.body as { user: { id: string; isAdmin: boolean } };
    expect(meBBody.user.id).toBe(userBId);
    expect(meBBody.user.isAdmin).toBe(false);
  });

  it('3. User A creates personal agent → 201; agent:invoke with that agentId completes', async () => {
    const agent = await createPersonalAgent(userACookie, {
      displayName: 'A Chat Agent',
      // Pin to a single allowedTool so the catalog filter has something
      // to allow; non-empty list avoids the wildcard-bypass reject.
      allowedTools: ['bash.run'],
      mcpConfigIds: [],
    });
    expect(agent.ownerId).toBe(userAId);
    expect(agent.visibility).toBe('personal');

    // Drive agent:invoke end-to-end. The sandbox stub mints the session and
    // fires chat:end with kind:'complete'; the orchestrator's queue-work
    // hits the real session-postgres in between.
    const sessionId = `s-acc-3-${randomBytes(4).toString('hex')}`;
    const outcome = await bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      ctxFor({ sessionId, agentId: agent.id, userId: userAId }),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');
    if (outcome.kind === 'complete') {
      expect(outcome.messages.length).toBeGreaterThan(0);
    }
  });

  it("4. User B GET /admin/agents returns User B's agents only (User A's invisible)", async () => {
    // User A already has at least one agent (created in scenario 3).
    // User B has none yet — list MUST be empty.
    const r = await httpRequest('GET', '/admin/agents', { cookie: userBCookie });
    expect(r.status).toBe(200);
    expect((r.body as { agents: SerializedAgent[] }).agents).toEqual([]);

    // Sanity: User A still sees their own agent(s).
    const rA = await httpRequest('GET', '/admin/agents', { cookie: userACookie });
    expect(rA.status).toBe(200);
    const aList = (rA.body as { agents: SerializedAgent[] }).agents;
    expect(aList.length).toBeGreaterThan(0);
    for (const a of aList) {
      expect(a.ownerId).toBe(userAId);
    }
  });

  it("5. User B agent:invoke with User A's agentId → terminated/agent-resolve:forbidden, sandbox NOT opened", async () => {
    // Pull one of User A's agents back so we have a real agentId.
    const list = await httpRequest('GET', '/admin/agents', {
      cookie: userACookie,
    });
    const aAgent = (list.body as { agents: SerializedAgent[] }).agents[0]!;
    expect(aAgent).toBeDefined();

    // Track session:create — if agents:resolve denies, sandbox:open-session
    // must NOT be reached, and so session:create must NOT fire either.
    let sandboxOpens = 0;
    bus.subscribe(
      'agents:resolved',
      'acc-test-watcher',
      async () => {
        sandboxOpens += 1;
        return undefined;
      },
    );

    const sessionId = `s-acc-5-${randomBytes(4).toString('hex')}`;
    const outcome = await bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      ctxFor({ sessionId, agentId: aAgent.id, userId: userBId }),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('terminated');
    if (outcome.kind === 'terminated') {
      expect(outcome.reason).toBe('agent-resolve:forbidden');
    }
    // agents:resolved fires only on success; on the forbidden path the
    // orchestrator throws before fire(). So sandboxOpens MUST be 0.
    expect(sandboxOpens).toBe(0);
  });

  it('6. Team agent: User A creates team, adds User B, creates team-agent; User B agent:invoke on team-agent → complete', async () => {
    // 6a. Create team.
    const tCreate = await httpRequest('POST', '/admin/teams', {
      cookie: userACookie,
      body: { displayName: 'Acceptance Team' },
    });
    expect(tCreate.status).toBe(201);
    const team = (tCreate.body as { team: SerializedTeam }).team;
    expect(team.createdBy).toBe(userAId);

    // 6b. Add User B as member.
    const addB = await httpRequest(
      'POST',
      `/admin/teams/${team.id}/members`,
      {
        cookie: userACookie,
        body: { userId: userBId, role: 'member' },
      },
    );
    expect(addB.status).toBe(201);

    // 6c. Create a team-agent owned by the team.
    const teamAgentCreate = await httpRequest('POST', '/admin/agents', {
      cookie: userACookie,
      body: {
        displayName: 'Team Shared Agent',
        systemPrompt: 'team helpful',
        allowedTools: ['bash.run'],
        mcpConfigIds: [],
        model: 'claude-opus-4-7',
        visibility: 'team',
        teamId: team.id,
      },
    });
    expect(teamAgentCreate.status).toBe(201);
    const teamAgent = (teamAgentCreate.body as { agent: SerializedAgent })
      .agent;
    expect(teamAgent.visibility).toBe('team');
    expect(teamAgent.ownerType).toBe('team');
    expect(teamAgent.ownerId).toBe(team.id);

    // 6d. NOTE: GET /admin/agents currently does NOT thread teamIds into
    //     `agents:list-for-user` — see admin-routes.ts:382 (Task 14 TODO
    //     left intentionally so the route's helper only ever sees the
    //     actor's userId). So team agents do NOT show up in User B's
    //     /admin/agents list. The headline of handoff scenario 6 is
    //     "User B can CHAT against the team agent", which is what the
    //     ACL gate (agents:resolve) decides — list visibility is a
    //     follow-up. We pin the chat path below and call out the list
    //     gap so a future fix knows to update both.

    // 6e. User B drives agent:invoke against the team agent → complete.
    const sessionId = `s-acc-6-${randomBytes(4).toString('hex')}`;
    const outcome = await bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      ctxFor({ sessionId, agentId: teamAgent.id, userId: userBId }),
      { message: { role: 'user', content: 'hi from B' } },
    );
    expect(outcome.kind).toBe('complete');
  });

  it("7. Per-agent MCP scoping: User A's session sees mcp.fs.* tools; User B's doesn't", async () => {
    // Create two personal agents:
    //   - User A's agent → mcpConfigIds: ['fs'] → tool:list keeps mcp.fs.*
    //   - User B's agent → mcpConfigIds: []     → tool:list drops mcp.fs.*
    //
    // We mint sessions via session:create with the matching agentConfig
    // snapshot, then call tool:list against that session's ctx. Same
    // signal as Task 7's list-with-agent-scope.test.ts but driven through
    // the real session-postgres + tool-dispatcher wiring.
    const aAgent = await createPersonalAgent(userACookie, {
      displayName: 'A MCP-scoped',
      allowedTools: ['bash.run'],
      mcpConfigIds: ['fs'],
    });
    const bList = await httpRequest('GET', '/admin/agents', {
      cookie: userBCookie,
    });
    let bAgent = (bList.body as { agents: SerializedAgent[] }).agents.find(
      (a) => a.visibility === 'personal' && a.ownerId === userBId,
    );
    if (bAgent === undefined) {
      // User B has no personal agent yet — mint one.
      const create = await httpRequest('POST', '/admin/agents', {
        cookie: userBCookie,
        body: {
          displayName: 'B No-MCP',
          systemPrompt: 'b is helpful',
          allowedTools: ['bash.run'],
          mcpConfigIds: [],
          model: 'claude-opus-4-7',
          visibility: 'personal',
        },
      });
      expect(create.status).toBe(201);
      bAgent = (create.body as { agent: SerializedAgent }).agent;
    }

    // Mint a session for each user with the agent's frozen config. The
    // mt-acceptance sandbox stub does this on agent:invoke; here we drive
    // session:create directly so we can poke at tool:list with a stable
    // sessionId.
    const aSessionId = `s-acc-7a-${randomBytes(4).toString('hex')}`;
    await bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      ctxFor({ sessionId: aSessionId, agentId: aAgent.id, userId: userAId }),
      {
        sessionId: aSessionId,
        workspaceRoot,
        owner: {
          userId: userAId,
          agentId: aAgent.id,
          agentConfig: {
            systemPrompt: aAgent.systemPrompt,
            allowedTools: aAgent.allowedTools,
            mcpConfigIds: aAgent.mcpConfigIds,
            model: aAgent.model,
          },
        },
      },
    );
    const bSessionId = `s-acc-7b-${randomBytes(4).toString('hex')}`;
    await bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      ctxFor({ sessionId: bSessionId, agentId: bAgent.id, userId: userBId }),
      {
        sessionId: bSessionId,
        workspaceRoot,
        owner: {
          userId: userBId,
          agentId: bAgent.id,
          agentConfig: {
            systemPrompt: bAgent.systemPrompt,
            allowedTools: bAgent.allowedTools,
            mcpConfigIds: bAgent.mcpConfigIds,
            model: bAgent.model,
          },
        },
      },
    );

    const aTools = await bus.call<
      Record<string, never>,
      { tools: ToolDescriptor[] }
    >(
      'tool:list',
      ctxFor({ sessionId: aSessionId, agentId: aAgent.id, userId: userAId }),
      {},
    );
    const aNames = aTools.tools.map((t) => t.name);
    for (const mcpName of MCP_FS_TOOL_NAMES) {
      expect(aNames).toContain(mcpName);
    }

    const bTools = await bus.call<
      Record<string, never>,
      { tools: ToolDescriptor[] }
    >(
      'tool:list',
      ctxFor({ sessionId: bSessionId, agentId: bAgent.id, userId: userBId }),
      {},
    );
    const bNames = bTools.tools.map((t) => t.name);
    for (const mcpName of MCP_FS_TOOL_NAMES) {
      expect(bNames).not.toContain(mcpName);
    }
  });

  it('8. Anonymous request to /admin/agents → 401', async () => {
    const r = await httpRequest('GET', '/admin/agents');
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'unauthenticated' });
  });

  // --- Hardening A/B/C ----------------------------------------------------

  it('A. CSRF: POST /admin/agents from a foreign Origin without X-Requested-With → 403', async () => {
    // Send a same-shape body but pin Origin to an attacker domain and
    // strip the CSRF bypass header. Empty allow-list means the request
    // can't pass either gate — the http-server returns 403.
    const r = await httpRequest('POST', '/admin/agents', {
      cookie: userACookie,
      origin: 'https://evil.example.com',
      skipCsrfHeader: true,
      body: {
        displayName: 'CSRF probe',
        systemPrompt: 'no',
        allowedTools: ['bash.run'],
        mcpConfigIds: [],
        model: 'claude-opus-4-7',
        visibility: 'personal',
      },
    });
    expect(r.status).toBe(403);
  });

  it('B. Cookie tamper: flipping one base64url char in the HMAC segment → 401', async () => {
    // Flip the last character. The base64url alphabet only matters in
    // that we stay legal; both 'A' and 'B' are valid, so the swap
    // doesn't trip the parser before the HMAC check runs.
    const last = userASignedValue.slice(-1);
    const swapped = last === 'A' ? 'B' : 'A';
    const tampered = userASignedValue.slice(0, -1) + swapped;
    const r = await httpRequest('GET', '/admin/me', {
      cookie: `ax_auth_session=${tampered}`,
    });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'unauthenticated' });
  });

  it('C. Token reuse after sign-out: cookie no longer authenticates', async () => {
    // Mint a fresh sign-in so the existing User A cookie isn't burnt for
    // the rest of the file — sign-out invalidates the row server-side.
    const r0 = await httpRequest('POST', '/auth/dev-bootstrap', {
      body: {
        token: DEV_TOKEN,
        displayName: 'User A (admin)',
      },
    });
    expect(r0.status).toBe(200);
    const setCookie = r0.setCookies.find((c) =>
      c.startsWith('ax_auth_session='),
    );
    if (setCookie === undefined) throw new Error('no fresh cookie');
    const freshCookie = setCookie.split(';')[0]!;

    // Confirm it works.
    const probe1 = await httpRequest('GET', '/admin/me', {
      cookie: freshCookie,
    });
    expect(probe1.status).toBe(200);

    // Sign out using the fresh cookie.
    const out = await httpRequest('POST', '/admin/sign-out', {
      cookie: freshCookie,
    });
    expect(out.status).toBe(200);

    // Reusing the same cookie now → 401.
    const probe2 = await httpRequest('GET', '/admin/me', {
      cookie: freshCookie,
    });
    expect(probe2.status).toBe(401);
  });
});
