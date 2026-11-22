import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

import {
  HookBus,
  PluginError,
  bootstrap,
  makeAgentContext,
  type AgentContext,
  type Plugin,
} from '@ax/core';
import type { CreateOutput as AgentCreateOutput } from '@ax/agents';
import type { ResolveOutput, UpsertInput } from '@ax/connectors';
import { createMcpClientPlugin, type CreateMcpClientPluginOptions } from '@ax/mcp-client';
import {
  startFakeOidcIssuer,
  startTestContainer,
  stopPostgresContainer,
  type FakeOidcIssuer,
} from '@ax/test-harness';

import { createK8sPlugins, type K8sPresetConfig } from '../index.js';

// ---------------------------------------------------------------------------
// @ax/apps-bridge composition (Invariant 3: no half-wired plugins).
//
// One flow through the preset's OWN plugins, on one Postgres: the real
// @ax/apps-bridge (its own listener, bound on a free loopback port, and its
// settings and approve routes), the real @ax/agents (the builder's and the
// viewer's personal agents), @ax/teams, @ax/connectors (the `linear`
// connector, its tool namespace, the effective set), @ax/tool-policy (the
// Allow and Ask-first verdicts), and the real credentials vault
// (@ax/credentials over @ax/credentials-store-db over @ax/storage-postgres,
// holding one key per agent). A platform calls the bridge over HTTP with
// tokens from two loopback OIDC issuers (`startFakeOidcIssuer`): one for the
// platform itself, one for the viewer's assertion. Their JWKS are fetched by
// jose with the global `fetch`, so the guard below lets loopback through.
//
// The preset's @ax/mcp-client is replaced by one built with the same
// `connectorToolInventory: true` and exactly two seams, both on the network
// side: `connectorInventoryListTools` (the server's tools/list: `fakeList`)
// and `connectorCallServerToolWithContent` (the one guarded tools/call:
// `fakeCall`, which records what would have gone over the wire and answers
// what each case sets). Everything before them (the access checks, the
// connector's resolve, the vault read of the agent's key, the header
// binding) runs as production. `fakeCall` hands back the case's own outcome
// object, never a copy: mcp-client marks an unexpected failure by object
// identity (connector-call.ts).
//
// Stubbed (no real producer in this KEEP set): `http:register-route` (records
// each route so a test calls its handler directly, the way a signed-in
// browser's request would reach it), `auth:require-user` (the test picks who
// is signed in), `auth:get-user` (ADMIN is the one admin), and
// `auth:find-user-by-email` (viewer@example.com is VIEWER; nobody else).
// ---------------------------------------------------------------------------

const KEEP = new Set<string>([
  '@ax/database-postgres',
  '@ax/storage-postgres',
  '@ax/credentials',
  '@ax/credentials-store-db',
  '@ax/agents',
  '@ax/teams',
  '@ax/connectors',
  '@ax/tool-policy',
  '@ax/apps-bridge',
]);

const PUBLIC_ORIGIN = 'https://ax.test';
const PLATFORM_ID = 'canopy-apps';
const CALLER_AUDIENCE = 'ax-apps-bridge';
const CALLER_SUBJECT = 'canopy-apps-platform';
const VIEWER_AUDIENCE = 'ax-apps-bridge-viewer';

const ADMIN = 'usr_admin';
const BUILDER = 'usr_builder';
const VIEWER = 'usr_viewer';
const VIEWER_EMAIL = 'viewer@example.com';

const APP_ID = 'app_01JDZ8M5Q4X7RT3VKF0N2C9H6B';
const APP_NAME = 'Issue board';
const CONNECTOR_ID = 'linear';
const MCP_HOST = 'mcp.linear.test';
const MCP_URL = `https://${MCP_HOST}/mcp`;
const BUILDER_KEY = 'lin_api_builder_composition_not_real';
const VIEWER_KEY = 'lin_api_viewer_composition_not_real';

const LIST_ISSUES_SCHEMA = {
  type: 'object',
  properties: { team: { type: 'string' }, limit: { type: 'number' } },
  required: ['team'],
};

// ── The two network seams ───────────────────────────────────────────────────

type ListTools = NonNullable<CreateMcpClientPluginOptions['connectorInventoryListTools']>;
type CallWithContent = NonNullable<CreateMcpClientPluginOptions['connectorCallServerToolWithContent']>;
type CallOutcome = Awaited<ReturnType<CallWithContent>>;

/** What the server's tools/list answers: two tools, the first with a schema. */
const fakeList: ListTools = async () => ({
  kind: 'ok',
  dropped: 0,
  tools: [
    {
      name: 'list_issues',
      title: 'List issues',
      description: 'List the issues in a team',
      readOnly: true,
      outward: false,
      inputSchema: LIST_ISSUES_SCHEMA,
    },
    {
      name: 'create_issue',
      title: 'Create issue',
      description: 'Open a new issue',
      readOnly: false,
      outward: true,
      inputSchema: null,
    },
  ],
});

const sent: Array<{ url: string; headers: Record<string, string>; tool: string; input: Record<string, unknown> }> = [];
/** The outcome the next calls answer; each case sets its own. */
let answer: CallOutcome = { outcome: 'succeeded', content: [] };

const fakeCall: CallWithContent = async (opts) => {
  sent.push({ url: opts.url, headers: { ...opts.headers }, tool: opts.tool, input: opts.input });
  // The case's own object, uncopied (see the header).
  return answer;
};

// ── Stubs ───────────────────────────────────────────────────────────────────

interface RouteRequest {
  method: string;
  path: string;
  rawPath: string;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: Buffer;
}

interface CapturedRoute {
  method: string;
  path: string;
  handler: (req: RouteRequest, res: unknown) => Promise<void>;
  bypassCsrf?: boolean;
  maxBodyBytes?: number;
}

const routes: CapturedRoute[] = [];
let actor: string | null = null;

function createStubsPlugin(): Plugin {
  const name = '@ax/preset-k8s/test/apps-bridge-stubs';
  return {
    manifest: {
      name,
      version: '0.0.0',
      registers: ['http:register-route', 'auth:require-user', 'auth:get-user', 'auth:find-user-by-email'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService<CapturedRoute, { unregister(): void }>('http:register-route', name, async (_ctx, route) => {
        routes.push(route);
        return { unregister() {} };
      });
      bus.registerService('auth:require-user', name, async () => {
        if (actor === null) throw new PluginError({ code: 'unauthenticated', plugin: name, message: 'no session' });
        return { user: { id: actor, isAdmin: actor === ADMIN } };
      });
      bus.registerService<{ userId: string }, unknown>('auth:get-user', name, async (_ctx, { userId }) => ({
        id: userId,
        displayName: userId,
        email: `${userId}@example.com`,
        isAdmin: userId === ADMIN,
      }));
      bus.registerService<{ email: string }, { userId: string } | null>(
        'auth:find-user-by-email',
        name,
        async (_ctx, { email }) => (email === VIEWER_EMAIL ? { userId: VIEWER } : null),
      );
    },
  };
}

// ── Calling a captured settings route, as a signed-in browser ───────────────

async function settings(
  as: string | null,
  method: 'GET' | 'POST',
  path: string,
  params: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (route === undefined) throw new Error(`route ${method} ${path} was not registered`);
  const captured = { status: 200, body: undefined as unknown };
  const res = {
    status(n: number) {
      captured.status = n;
      return res;
    },
    header() {
      return res;
    },
    json(v: unknown) {
      captured.body = v;
    },
    text(s: string) {
      captured.body = s;
    },
    end() {},
    redirect() {
      throw new Error('a settings route never redirects');
    },
  };
  actor = as;
  try {
    await route.handler(
      {
        method,
        path,
        rawPath: path,
        params,
        query: {},
        headers: { 'x-requested-with': 'ax-admin', 'content-type': 'application/json' },
        body: body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)),
      },
      res,
    );
  } finally {
    actor = null;
  }
  return captured;
}

const R = {
  read: '/settings/apps/:agentId',
  linkCode: '/settings/apps/:agentId/link-code',
  unlink: '/settings/apps/:agentId/unlink',
  grant: '/settings/apps/:agentId/grant',
  approval: '/settings/app-approval/:platformId/:appId/:connectorId',
} as const;

// ── The platform, over the bridge's own listener ────────────────────────────

let callerIssuer: FakeOidcIssuer;
let viewerIssuer: FakeOidcIssuer;
let bridgePort = 0;

function platformToken(): string {
  const now = Math.floor(Date.now() / 1000);
  return callerIssuer.mint({ iss: callerIssuer.issuer, aud: CALLER_AUDIENCE, sub: CALLER_SUBJECT, iat: now, exp: now + 300 });
}

function viewerAssertion(email = VIEWER_EMAIL): string {
  const now = Math.floor(Date.now() / 1000);
  return viewerIssuer.mint({
    iss: viewerIssuer.issuer,
    aud: VIEWER_AUDIENCE,
    sub: 'viewer-subject',
    email,
    email_verified: true,
    iat: now,
    exp: now + 300,
  });
}

async function platform(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`http://127.0.0.1:${bridgePort}/api/apps-bridge/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${platformToken()}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json() };
}

const claim = (code: string) => platform('POST', '/links/claim', { appId: APP_ID, appName: APP_NAME, code });

function builderCall(tool: string, input: Record<string, unknown>) {
  return platform('POST', '/call', { appId: APP_ID, connectorId: CONNECTOR_ID, tool, mode: 'builder', input });
}

function viewerCall(tool: string, input: Record<string, unknown>) {
  return platform('POST', '/call', {
    appId: APP_ID,
    connectorId: CONNECTOR_ID,
    tool,
    mode: 'viewer',
    input,
    viewerAssertion: viewerAssertion(),
  });
}

/** The fetch the network guard lets through: loopback only (the bridge and the issuers' JWKS). */
const realFetch = globalThis.fetch;

describe('apps bridge composition: link, grant and call through the real preset', () => {
  let pgContainer: StartedPostgreSqlContainer | null = null;
  let shutdown: (() => Promise<void>) | null = null;
  let bus: HookBus;
  let savedCredentialsKey: string | undefined;

  let builderAgent = '';
  let viewerAgent = '';
  let listKey = '';
  let createKey = '';

  const ctxFor = (userId: string, agentId = ''): AgentContext =>
    makeAgentContext({ sessionId: 'apps-bridge-composition', agentId, userId });

  function presetConfig(connectionString: string): K8sPresetConfig {
    return {
      database: { connectionString },
      eventbus: { connectionString: 'postgres://stub:5432/stub' },
      session: { connectionString: 'postgres://stub:5432/stub' },
      blob: { backend: 'fs', root: '/tmp/ax-apps-bridge-composition-unused' },
      sandbox: { namespace: 'ax-next', image: 'ax-next/agent:stub' },
      ipc: { hostIpcUrl: 'http://ax-next-host.ax-next.svc.cluster.local:80' },
      chat: { runnerBinaries: {}, chatTimeoutMs: 60_000 },
      http: { host: '127.0.0.1', port: 0, cookieKey: '0'.repeat(64), allowedOrigins: [] },
      // Approve links are built on this origin.
      auth: { baseURL: PUBLIC_ORIGIN },
      appsBridge: {
        platformId: PLATFORM_ID,
        host: '127.0.0.1',
        port: 0,
        caller: {
          issuer: callerIssuer.issuer,
          jwksUrl: callerIssuer.jwksUrl,
          audience: CALLER_AUDIENCE,
          subject: CALLER_SUBJECT,
        },
        viewer: { issuer: viewerIssuer.issuer, jwksUrl: viewerIssuer.jwksUrl, audience: VIEWER_AUDIENCE, maxAgeSeconds: 600 },
      },
    };
  }

  async function personalAgent(userId: string): Promise<string> {
    const out = await bus.call<unknown, AgentCreateOutput>('agents:create', ctxFor(userId), {
      actor: { userId, isAdmin: false },
      input: {
        displayName: `${userId} agent`,
        allowedTools: [],
        mcpConfigIds: [],
        model: 'anthropic/claude-opus-4-7',
        visibility: 'personal',
      },
    });
    return out.agent.id;
  }

  /** Attach `linear` to the owner's agent and store that agent's own key at agent scope. */
  async function attachWithKey(userId: string, agentId: string, resolved: ResolveOutput, key: string): Promise<void> {
    await bus.call('agents:attach-connector', ctxFor(userId, agentId), {
      actor: { userId, isAdmin: false },
      agentId,
      connectorId: CONNECTOR_ID,
    });
    const plan = resolved.credentialPlan.find((p) => p.slot === 'key');
    expect(plan).toMatchObject({ scope: 'agent' });
    await bus.call('credentials:set', ctxFor(userId, agentId), {
      scope: 'agent',
      ownerId: agentId,
      ref: plan!.ref,
      kind: 'api-key',
      payload: new TextEncoder().encode(key),
    });
  }

  async function allowListIssues(agentId: string, userId: string): Promise<void> {
    expect(
      await bus.call('tool-policy:set-agent-override', ctxFor(userId, agentId), {
        agentId,
        toolKey: listKey,
        verdict: 'allow',
      }),
    ).toEqual({ ok: true });
  }

  async function mintCode(): Promise<string> {
    const minted = await settings(BUILDER, 'POST', R.linkCode, { agentId: builderAgent }, {});
    expect(minted.status).toBe(200);
    const code = (minted.body as { code: string }).code;
    expect(code).toMatch(/^axl_[a-z2-7]{32}$/);
    return code;
  }

  async function grant(mode: 'builder' | 'viewer', toolKeys: string[]): Promise<void> {
    const saved = await settings(BUILDER, 'POST', R.grant, { agentId: builderAgent }, {
      appId: APP_ID,
      connectorId: CONNECTOR_ID,
      mode,
      toolKeys,
    });
    expect(saved.status).toBe(200);
  }

  const approvalParams = { platformId: PLATFORM_ID, appId: APP_ID, connectorId: CONNECTOR_ID };

  beforeAll(async () => {
    savedCredentialsKey = process.env.AX_CREDENTIALS_KEY;
    process.env.AX_CREDENTIALS_KEY = '42'.repeat(32);
    // Nothing reaches the network by accident: only loopback (the bridge's
    // listener and the issuers' JWKS, which jose fetches) goes through.
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!target.startsWith('http://127.0.0.1:')) throw new Error(`network is off in tests: ${target}`);
      return realFetch(input, init);
    });
    callerIssuer = await startFakeOidcIssuer();
    viewerIssuer = await startFakeOidcIssuer();
    pgContainer = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));

    const presetPlugins = createK8sPlugins(presetConfig(pgContainer.getConnectionUri()));
    const kept = presetPlugins.filter((p) => KEEP.has(p.manifest.name));
    expect(kept.map((p) => p.manifest.name).sort()).toEqual([...KEEP].sort());
    // The preset's own @ax/mcp-client, rebuilt with the two network seams.
    expect(presetPlugins.some((p) => p.manifest.name === '@ax/mcp-client')).toBe(true);
    const mcpClient = createMcpClientPlugin({
      connectorToolInventory: true,
      connectorInventoryListTools: fakeList,
      connectorCallServerToolWithContent: fakeCall,
    });

    bus = new HookBus();
    const handle = await bootstrap({ bus, plugins: [...kept, mcpClient, createStubsPlugin()], config: {} });
    shutdown = () => handle.shutdown();
    const bridgePlugin = kept.find((p) => p.manifest.name === '@ax/apps-bridge') as Plugin & {
      bridgeBoundPort(): number | undefined;
    };
    bridgePort = bridgePlugin.bridgeBoundPort() ?? 0;
    expect(bridgePort).toBeGreaterThan(0);

    // ---- Seed: one admin connector, two personal agents with their own keys.
    const upsert: UpsertInput = {
      userId: ADMIN,
      connectorId: CONNECTOR_ID,
      name: 'Linear',
      keyMode: 'personal',
      capabilities: {
        allowedHosts: [MCP_HOST],
        credentials: [{ slot: 'key', kind: 'api-key', headerName: 'Authorization', server: 'linear' }],
        mcpServers: [{ name: 'linear', transport: 'http', url: MCP_URL, allowedHosts: [MCP_HOST], credentials: [] }],
        packages: { npm: [], pypi: [] },
        services: [],
      },
    };
    await bus.call('connectors:upsert', ctxFor(ADMIN), upsert);
    const resolved = await bus.call<{ userId: string; connectorId: string }, ResolveOutput>(
      'connectors:resolve',
      ctxFor(ADMIN),
      { userId: ADMIN, connectorId: CONNECTOR_ID },
    );
    expect(resolved.toolNamespaces).toHaveLength(1);
    const ns = resolved.toolNamespaces[0]!.toolNamespace;
    listKey = `mcp.${ns}.list_issues`;
    createKey = `mcp.${ns}.create_issue`;

    builderAgent = await personalAgent(BUILDER);
    viewerAgent = await personalAgent(VIEWER);
    await attachWithKey(BUILDER, builderAgent, resolved, BUILDER_KEY);
    await attachWithKey(VIEWER, viewerAgent, resolved, VIEWER_KEY);

    // Allow for list_issues: the admin's default, then each agent's own choice.
    // create_issue keeps the Ask-first floor (no default).
    expect(
      await bus.call('tool-policy:set-connector-defaults', ctxFor(ADMIN), {
        connectorId: CONNECTOR_ID,
        verdicts: [{ toolKey: listKey, verdict: 'allow' }],
      }),
    ).toEqual({ ok: true });
    await allowListIssues(builderAgent, BUILDER);
    await allowListIssues(viewerAgent, VIEWER);
  }, 180_000);

  afterAll(async () => {
    if (shutdown !== null) await shutdown();
    vi.unstubAllGlobals();
    await callerIssuer?.close();
    await viewerIssuer?.close();
    if (savedCredentialsKey === undefined) delete process.env.AX_CREDENTIALS_KEY;
    else process.env.AX_CREDENTIALS_KEY = savedCredentialsKey;
    if (pgContainer !== null) await stopPostgresContainer(pgContainer);
  }, 60_000);

  it('link: the builder mints a code in Apps settings, the platform claims it with an app id and a name, and a retry answers 200', async () => {
    // No link yet: the platform's app is unknown.
    expect(await platform('GET', `/apps/${APP_ID}/grants`)).toEqual({ status: 404, body: { code: 'app_not_linked' } });

    const code = await mintCode();
    expect(await claim(code)).toEqual({ status: 200, body: { appId: APP_ID } });
    // A retry after a lost response: the same code, the same app, 200 again.
    expect(await claim(code)).toEqual({ status: 200, body: { appId: APP_ID } });
    // The code is spent: no other app can take it.
    expect(
      await platform('POST', '/links/claim', { appId: 'app_someone_else', appName: 'Other', code }),
    ).toEqual({ status: 403, body: { code: 'link_code_invalid' } });

    const read = await settings(BUILDER, 'GET', R.read, { agentId: builderAgent });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      enabled: true,
      canManage: true,
      links: [{ appId: APP_ID, appName: APP_NAME, grants: [] }],
      approvals: [],
    });
    // Linked, but nothing granted yet.
    expect(await builderCall('list_issues', { team: 'ENG' })).toEqual({ status: 403, body: { code: 'not_granted' } });
    expect(sent).toEqual([]);
  });

  it('builder: grant, call — the connector gets the builder agent\'s key and the exact input, and the platform gets the content', async () => {
    await grant('builder', [listKey, createKey]);
    const content = [
      { type: 'text', text: '[{"id":"ENG-1","title":"Fix the login page"}]' },
      { type: 'resource_link', uri: 'https://linear.app/eng/issue/ENG-1', name: 'ENG-1' },
    ];
    answer = { outcome: 'succeeded', content };
    // Keys a prototype would swallow ride through as plain data.
    const input = JSON.parse('{"team":"ENG","limit":5,"filter":{"state":["Todo","In Progress"]},"__proto__":{"admin":true}}') as Record<
      string,
      unknown
    >;

    expect(await builderCall('list_issues', input)).toEqual({ status: 200, body: { outcome: 'succeeded', content } });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(MCP_URL);
    expect(sent[0]!.tool).toBe('list_issues');
    expect(sent[0]!.headers['Authorization']).toBe(BUILDER_KEY);
    expect(JSON.stringify(sent[0]!.input)).toBe(JSON.stringify(input));
    expect(Object.hasOwn(sent[0]!.input, '__proto__')).toBe(true);
  });

  it('a tool error comes back with its content', async () => {
    const content = [{ type: 'text', text: 'Issue not found' }];
    answer = { outcome: 'failed', reason: 'tool-error', content };
    expect(await builderCall('list_issues', { team: 'ENG', id: 'ENG-404' })).toEqual({
      status: 200,
      body: { outcome: 'failed', reason: 'tool-error', content },
    });
    expect(sent).toHaveLength(2);
    expect(sent[1]!.headers['Authorization']).toBe(BUILDER_KEY);
  });

  it('a tool the agent asks first about is approval_required, and nothing is sent', async () => {
    expect(await builderCall('create_issue', { team: 'ENG', title: 'New' })).toEqual({
      status: 403,
      body: { code: 'approval_required' },
    });
    // A tool outside the grant is refused before policy is asked.
    expect(await builderCall('delete_issue', { id: 'ENG-1' })).toEqual({ status: 403, body: { code: 'tool_not_allowed' } });
    expect(sent).toHaveLength(2);
  });

  it('viewer: approval required with the approve link; the viewer approves; the call uses the viewer agent\'s key', async () => {
    await grant('viewer', [listKey]);
    // The grant is viewer mode now: a builder call is not granted.
    expect(await builderCall('list_issues', { team: 'ENG' })).toEqual({ status: 403, body: { code: 'not_granted' } });

    const approveUrl = `${PUBLIC_ORIGIN}/apps/approve/${PLATFORM_ID}/${APP_ID}/${CONNECTOR_ID}`;
    expect(await viewerCall('list_issues', { team: 'DESIGN' })).toEqual({
      status: 403,
      body: { code: 'viewer_approval_required', approveUrl },
    });
    // An assertion for someone with no account is no viewer at all.
    expect(
      await platform('POST', '/call', {
        appId: APP_ID,
        connectorId: CONNECTOR_ID,
        tool: 'list_issues',
        mode: 'viewer',
        input: {},
        viewerAssertion: viewerAssertion('stranger@example.com'),
      }),
    ).toEqual({ status: 403, body: { code: 'viewer_invalid' } });
    expect(sent).toHaveLength(2);

    // The approve page, as the viewer: only their own personal agent is offered.
    const prompt = await settings(VIEWER, 'GET', R.approval, approvalParams);
    expect(prompt).toEqual({
      status: 200,
      body: {
        platformId: PLATFORM_ID,
        appId: APP_ID,
        appName: APP_NAME,
        connectorId: CONNECTOR_ID,
        connectorName: 'Linear',
        tools: ['list_issues'],
        agents: [{ agentId: viewerAgent, displayName: `${VIEWER} agent` }],
        approvedAgentId: null,
      },
    });
    // The builder's agent isn't the viewer's to lend.
    expect(
      await settings(VIEWER, 'POST', R.approval, approvalParams, { agentId: builderAgent, tools: ['list_issues'] }),
    ).toEqual({ status: 400, body: { error: 'agent-not-eligible' } });
    expect(
      await settings(VIEWER, 'POST', R.approval, approvalParams, { agentId: viewerAgent, tools: ['list_issues'] }),
    ).toEqual({ status: 200, body: {} });

    const content = [{ type: 'text', text: '[{"id":"DES-7"}]' }];
    answer = { outcome: 'succeeded', content };
    expect(await viewerCall('list_issues', { team: 'DESIGN' })).toEqual({ status: 200, body: { outcome: 'succeeded', content } });
    expect(sent).toHaveLength(3);
    expect(sent[2]).toEqual({
      url: MCP_URL,
      headers: expect.objectContaining({ Authorization: VIEWER_KEY }),
      tool: 'list_issues',
      input: { team: 'DESIGN' },
    });

    // The viewer sees their approval on their own agent's Apps section.
    const read = await settings(VIEWER, 'GET', R.read, { agentId: viewerAgent });
    expect(read.body).toMatchObject({ approvals: [{ appId: APP_ID, appName: APP_NAME, connectorId: CONNECTOR_ID, connectorName: 'Linear' }] });
  });

  it('GET grants lists the connector by display name, its mode, and each tool\'s description and inputSchema', async () => {
    expect(await platform('GET', `/apps/${APP_ID}/grants`)).toEqual({
      status: 200,
      body: {
        grants: [
          {
            connectorId: CONNECTOR_ID,
            displayName: 'Linear',
            mode: 'viewer',
            tools: [{ name: 'list_issues', description: 'List the issues in a team', inputSchema: LIST_ISSUES_SCHEMA }],
          },
        ],
      },
    });
    // Back to builder mode with both tools: the schema-less tool reads null.
    await grant('builder', [listKey, createKey]);
    expect(await platform('GET', `/apps/${APP_ID}/grants`)).toEqual({
      status: 200,
      body: {
        grants: [
          {
            connectorId: CONNECTOR_ID,
            displayName: 'Linear',
            mode: 'builder',
            tools: [
              { name: 'list_issues', description: 'List the issues in a team', inputSchema: LIST_ISSUES_SCHEMA },
              { name: 'create_issue', description: 'Open a new issue', inputSchema: null },
            ],
          },
        ],
      },
    });
    // A mode change cleared the viewer's approval.
    expect((await settings(VIEWER, 'GET', R.approval, approvalParams)).body).toEqual({ error: 'not-found' });
  });

  it('unlink makes the app app_not_linked; a second claim then links it again; deleting the viewer\'s agent removes their approval', async () => {
    expect(await settings(BUILDER, 'POST', R.unlink, { agentId: builderAgent }, { appId: APP_ID })).toEqual({
      status: 200,
      body: {},
    });
    expect(await platform('GET', `/apps/${APP_ID}/grants`)).toEqual({ status: 404, body: { code: 'app_not_linked' } });
    expect(await builderCall('list_issues', { team: 'ENG' })).toEqual({ status: 404, body: { code: 'app_not_linked' } });

    // A fresh code links it again, with nothing granted: the old grants went with the link.
    expect(await claim(await mintCode())).toEqual({ status: 200, body: { appId: APP_ID } });
    expect(await platform('GET', `/apps/${APP_ID}/grants`)).toEqual({ status: 200, body: { grants: [] } });

    // Viewer mode again, and the viewer approves.
    await grant('viewer', [listKey]);
    expect(
      await settings(VIEWER, 'POST', R.approval, approvalParams, { agentId: viewerAgent, tools: ['list_issues'] }),
    ).toEqual({ status: 200, body: {} });
    answer = { outcome: 'succeeded', content: [] };
    expect(await viewerCall('list_issues', { team: 'OPS' })).toEqual({ status: 200, body: { outcome: 'succeeded', content: [] } });
    const before = sent.length;

    // The viewer deletes the agent their approval borrows: the approval goes with it.
    await bus.call('agents:delete', ctxFor(VIEWER), { actor: { userId: VIEWER, isAdmin: false }, agentId: viewerAgent });
    await vi.waitFor(
      async () =>
        expect((await settings(VIEWER, 'GET', R.approval, approvalParams)).body).toMatchObject({
          agents: [],
          approvedAgentId: null,
        }),
      { timeout: 10_000 },
    );
    expect(await viewerCall('list_issues', { team: 'OPS' })).toEqual({
      status: 403,
      body: {
        code: 'viewer_approval_required',
        approveUrl: `${PUBLIC_ORIGIN}/apps/approve/${PLATFORM_ID}/${APP_ID}/${CONNECTOR_ID}`,
      },
    });
    expect(sent).toHaveLength(before);
  });
});
