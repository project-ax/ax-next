import {
  AgentAppsReadSchema,
  APPS_SETTINGS_ROUTES,
  ApprovalPromptSchema,
  LINK_CODE_RE,
  LinkCodeResponseSchema,
  SaveGrantResponseSchema,
  SETTINGS_BODY_MAX_BYTES,
} from '@ax/apps-bridge-contract';
import { HookBus, PluginError, type AgentContext, type Logger } from '@ax/core';
import { describe, expect, it, vi } from 'vitest';
import type { RouteRequest, RouteResponse, RouteSpec } from '../http-types.js';
import { LINK_CODE_TTL_MS, hashLinkCode } from '../link-codes.js';
import { registerSettingsRoutes } from '../settings-routes.js';
import { createFakeStore, type FakeStore } from './support/fake-store.js';

/*
  The Apps settings and approve routes, called straight through the handlers
  a stubbed `http:register-route` captured. A real HookBus carries fakes for
  the person (`auth:require-user`), the agents and the connectors; the store
  is the in-memory fake. Each refusal is checked for its status and
  `{ error }` key, and the writes it must not make.
*/

const P = 'canopy';
const APP = 'app_01JDZ8M5Q4X7RT3VKF0N2C9H6B';
const APP2 = 'app_02OTHER';
const AGENT = 'agt_support';
const OTHER_AGENT = 'agt_sales';
const VIC_AGENT = 'agt_vic';
const VIC_AGENT_2 = 'agt_vic_github';
const ADA = 'usr_ada'; // manages AGENT and OTHER_AGENT
const BOB = 'usr_bob'; // sees AGENT, manages nothing
const VIC = 'usr_vic'; // a viewer with two personal agents
const EVE = 'usr_eve'; // sees nothing
const ZED = 'usr_zed'; // another viewer
const CONN = 'linear';
const NS = 'c0123456789';
const NS_2 = 'c0123456780'; // linear's second server
const NS_GITHUB = 'cabcdefabcd';
const TOOL = 'list_issues';
const KEY = `mcp.${NS}.${TOOL}`;
const KEY_CREATE = `mcp.${NS}.create_issue`;
const KEY_GITHUB = `mcp.${NS_GITHUB}.search`;
const NOW = Date.parse('2026-11-21T12:00:00.000Z');

type Handler = (ctx: AgentContext, input: never) => unknown;
interface Line { level: string; msg: string; bindings: Record<string, unknown> | undefined }

function capturingLogger(lines: Line[]): Logger {
  const at = (level: string) => (msg: string, bindings?: Record<string, unknown>) => {
    lines.push({ level, msg, bindings });
  };
  const logger: Logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: () => logger };
  return logger;
}

const pluginError = (code: string) => new PluginError({ code, plugin: 'fake', message: `fake ${code}: SECRET-MESSAGE` });

interface AgentRow {
  id: string;
  ownerId: string;
  ownerType: 'user' | 'team';
  visibility: 'personal' | 'team';
  displayName: string;
  connectorAttachments: string[];
  connectorExclusions: string[];
}
function agentRow(id: string, ownerId: string, ownerType: 'user' | 'team', attachments: string[]): AgentRow {
  return {
    id,
    ownerId,
    ownerType,
    visibility: ownerType === 'user' ? 'personal' : 'team',
    displayName: `Agent ${id}`,
    connectorAttachments: attachments,
    connectorExclusions: [],
  };
}
const AGENTS: Record<string, AgentRow> = {
  [AGENT]: agentRow(AGENT, 'team_eng', 'team', [CONN, 'github']),
  [OTHER_AGENT]: agentRow(OTHER_AGENT, 'team_eng', 'team', [CONN]),
  [VIC_AGENT]: agentRow(VIC_AGENT, VIC, 'user', [CONN]),
  [VIC_AGENT_2]: agentRow(VIC_AGENT_2, VIC, 'user', ['github']),
};
/** Who may see each agent. */
const SEES: Record<string, string[]> = {
  [AGENT]: [ADA, BOB],
  [OTHER_AGENT]: [ADA],
  [VIC_AGENT]: [VIC],
  [VIC_AGENT_2]: [VIC],
};
const CONNECTORS: Record<string, { name: string; namespaces: string[] }> = {
  [CONN]: { name: 'Linear', namespaces: [NS, NS_2] },
  github: { name: 'GitHub', namespaces: [NS_GITHUB] },
};

interface Recorded { hook: string; input: unknown }

function defaultHandlers(state: { user: string | null }): Record<string, Handler> {
  return {
    'auth:require-user': () => {
      if (state.user === null) throw pluginError('unauthenticated');
      // Everyone here is a workspace admin: the routes must never read it.
      return { user: { id: state.user, isAdmin: true, email: `${state.user}@example.test` } };
    },
    'agents:resolve': (_ctx, input: { agentId: string; userId: string }) => {
      const agent = AGENTS[input.agentId];
      if (agent === undefined) throw pluginError('not-found');
      if (!(SEES[input.agentId] ?? []).includes(input.userId)) throw pluginError('forbidden');
      return { agent };
    },
    'agents:can-manage-connectors': (_ctx, input: { agentId: string; actor: { userId: string; isAdmin: boolean } }) => ({
      // A workspace admin is let in here (as the real hook does), so asking
      // as one would be visible.
      allowed: input.actor.isAdmin || (input.actor.userId === ADA && [AGENT, OTHER_AGENT].includes(input.agentId)),
    }),
    'connectors:list-effective': (_ctx, input: { attachmentIds: string[]; exclusions: string[] }) => ({
      connectors: input.attachmentIds
        .filter((id) => !input.exclusions.includes(id) && CONNECTORS[id] !== undefined)
        .map((id) => ({
          summary: { id, name: CONNECTORS[id]!.name },
          source: 'attached',
          toolNamespaces: CONNECTORS[id]!.namespaces.map((toolNamespace) => ({ toolNamespace, server: 'main' })),
        })),
    }),
    'connectors:list': () => ({
      connectors: [
        { id: 'github', name: 'GitHub', description: '' },
        { id: CONN, name: 'Linear', description: '' },
      ],
    }),
    'agents:list-for-user': (_ctx, input: { userId: string }) => ({
      agents: [
        ...Object.values(AGENTS).filter((a) => a.ownerType === 'user' && a.ownerId === input.userId),
        // Neither of these is the caller's personal agent, whatever the answer says.
        agentRow('agt_team_with_linear', 'team_eng', 'team', [CONN]),
        agentRow('agt_someone_else', 'usr_other', 'user', [CONN]),
      ],
    }),
  };
}

interface Reply { status: number; body: unknown; headers: Record<string, string> }

function harness(opts: { platformId?: string | null; handlers?: Record<string, Handler> } = {}) {
  const state = { user: ADA as string | null };
  const store: FakeStore = createFakeStore();
  const lines: Line[] = [];
  const calls: Recorded[] = [];
  const specs: RouteSpec[] = [];
  const unregisters: Array<ReturnType<typeof vi.fn>> = [];
  const bus = new HookBus();
  const handlers = { ...defaultHandlers(state), ...opts.handlers };
  for (const [hook, handler] of Object.entries(handlers)) {
    bus.registerService(hook, 'fake', async (ctx: AgentContext, input: unknown) => {
      calls.push({ hook, input });
      return handler(ctx, input as never);
    });
  }
  bus.registerService('http:register-route', 'fake', async (_ctx: AgentContext, spec: RouteSpec) => {
    specs.push(spec);
    const unregister = vi.fn();
    unregisters.push(unregister);
    return { unregister };
  });
  const platformId = opts.platformId === null ? undefined : (opts.platformId ?? P);
  const deps = { store, platformId, logger: capturingLogger(lines), now: () => NOW };

  async function send(
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, string>,
    body?: unknown,
    as: string | null = state.user,
  ): Promise<Reply> {
    const spec = specs.find((s) => s.method === method && s.path === path);
    if (spec === undefined) throw new Error(`no route ${method} ${path}`);
    const prev = state.user;
    state.user = as;
    const out: Reply = { status: 0, body: undefined, headers: {} };
    const raw = body === undefined ? (method === 'POST' ? '{}' : '') : typeof body === 'string' ? body : JSON.stringify(body);
    const req: RouteRequest = {
      method,
      path,
      rawPath: path,
      params,
      query: {},
      headers: {},
      body: Buffer.from(raw, 'utf8'),
    };
    const res: RouteResponse = {
      status(code) {
        out.status = code;
        return res;
      },
      header(name, value) {
        out.headers[name.toLowerCase()] = value;
        return res;
      },
      json(b) {
        out.body = b;
      },
      text() {
        throw new Error('text not expected');
      },
      end() {
        throw new Error('end not expected');
      },
      redirect() {
        throw new Error('redirect not expected');
      },
    };
    try {
      await spec.handler(req, res);
    } finally {
      state.user = prev;
    }
    return out;
  }

  const R = APPS_SETTINGS_ROUTES;
  const agentParams = (agentId: string) => ({ agentId });
  const approvalParams = (o: { platformId?: string; appId?: string; connectorId?: string } = {}) => ({
    platformId: o.platformId ?? P,
    appId: o.appId ?? APP,
    connectorId: o.connectorId ?? CONN,
  });

  return {
    state,
    store,
    lines,
    calls,
    specs,
    unregisters,
    start: () => registerSettingsRoutes(bus, deps),
    read: (agentId = AGENT, as?: string | null) => send('GET', R.read, agentParams(agentId), undefined, as === undefined ? state.user : as),
    post: (route: 'linkCode' | 'unlink' | 'grant' | 'ungrant' | 'revoke', body: unknown, agentId = AGENT, as?: string | null) =>
      send('POST', R[route], agentParams(agentId), body, as === undefined ? state.user : as),
    approvalGet: (o: Parameters<typeof approvalParams>[0] = {}, as?: string | null) =>
      send('GET', R.approval, approvalParams(o), undefined, as === undefined ? state.user : as),
    approvalPost: (body: unknown, o: Parameters<typeof approvalParams>[0] = {}, as?: string | null) =>
      send('POST', R.approval, approvalParams(o), body, as === undefined ? state.user : as),
  };
}
type H = ReturnType<typeof harness>;

async function started(opts?: Parameters<typeof harness>[0]): Promise<H> {
  const h = harness(opts);
  await h.start();
  return h;
}

let codeN = 0;
async function link(h: H, appId = APP, agentId = AGENT, appName = 'Support desk'): Promise<void> {
  const codeHash = hashLinkCode(`axl_${String(++codeN).padStart(32, 'a')}`);
  await h.store.mintLinkCode({ codeHash, userId: ADA, agentId, expiresAt: new Date(NOW + LINK_CODE_TTL_MS), now: new Date(NOW) });
  const r = await h.store.claimLinkCode({ codeHash, platformId: P, appId, appName, now: new Date(NOW) });
  expect(r.result).toBe('linked');
}

async function grant(h: H, mode: 'builder' | 'viewer', toolKeys: string[] = [KEY, KEY_CREATE], appId = APP, connectorId = CONN): Promise<void> {
  expect(await h.store.putGrant({ platformId: P, appId, connectorId, mode, toolKeys })).not.toBe('no-link');
}

async function approve(h: H, viewer = VIC, agentId = VIC_AGENT, appId = APP, connectorId = CONN): Promise<void> {
  expect(await h.store.putApproval({ viewerUserId: viewer, platformId: P, appId, connectorId, agentId, toolKeys: [KEY] })).toBe('saved');
}

const AGENT_ROUTES = [
  ['GET', 'read'],
  ['POST', 'linkCode'],
  ['POST', 'unlink'],
  ['POST', 'grant'],
  ['POST', 'ungrant'],
  ['POST', 'revoke'],
] as const;

const goodBody: Record<(typeof AGENT_ROUTES)[number][1], unknown> = {
  read: undefined,
  linkCode: {},
  unlink: { appId: APP },
  grant: { appId: APP, connectorId: CONN, mode: 'builder', toolKeys: [KEY] },
  ungrant: { appId: APP, connectorId: CONN },
  revoke: { appId: APP, connectorId: CONN },
};

function callAgentRoute(h: H, route: (typeof AGENT_ROUTES)[number][1], agentId: string, as: string | null, body?: unknown) {
  return route === 'read' ? h.read(agentId, as) : h.post(route, body ?? goodBody[route], agentId, as);
}

function allLogText(h: H): string {
  return JSON.stringify(h.lines);
}

describe('apps settings routes', () => {
  it('every agent route: 401 signed out; one 404 for unknown, invisible and malformed agents', async () => {
    const h = await started();
    await link(h);
    for (const [, route] of AGENT_ROUTES) {
      // Signed out comes first, even for an id no agent could have.
      for (const agentId of [AGENT, 'bad id!']) {
        const out = await callAgentRoute(h, route, agentId, null);
        expect(out, `${route} signed out`).toMatchObject({ status: 401, body: { error: 'unauthenticated' } });
      }
      const answers = [
        await callAgentRoute(h, route, AGENT, EVE), // exists, not theirs
        await callAgentRoute(h, route, 'agt_nope', ADA), // doesn't exist
        await callAgentRoute(h, route, 'bad id!', ADA), // malformed
        await callAgentRoute(h, route, 'a'.repeat(257), ADA), // too long
        await callAgentRoute(h, route, '', ADA),
      ];
      for (const out of answers) expect(out, route).toMatchObject({ status: 404, body: { error: 'agent-not-found' } });
      // One answer for all of them, byte for byte.
      expect(new Set(answers.map((a) => JSON.stringify(a.body))).size).toBe(1);
    }
    // Nothing was written by any of it.
    expect(h.store.linkCount()).toBe(1);
    expect(await h.store.listGrants(P, APP)).toEqual([]);
    // A malformed id never reaches agents:resolve.
    expect(h.calls.filter((c) => c.hook === 'agents:resolve').map((c) => (c.input as { agentId: string }).agentId)).not.toContain('bad id!');
  });

  it("a fault in auth:require-user is a 500, logged code-only", async () => {
    const h = await started({
      handlers: {
        'auth:require-user': () => {
          throw pluginError('session-store-down');
        },
      },
    });
    expect(await h.read(AGENT)).toMatchObject({ status: 500, body: { error: 'internal' } });
    expect(await h.approvalGet()).toMatchObject({ status: 500, body: { error: 'internal' } });
    expect(allLogText(h)).toContain('session-store-down');
    expect(allLogText(h)).not.toContain('SECRET-MESSAGE');
  });

  it('GET: enabled false with the bridge off; POSTs answer 409 bridge-off', async () => {
    const h = await started({ platformId: null });
    const mint = vi.spyOn(h.store, 'mintLinkCode');
    expect(await h.read(AGENT)).toMatchObject({ status: 200, body: { enabled: false } });
    expect(AgentAppsReadSchema.parse((await h.read(AGENT)).body)).toEqual({ enabled: false });
    for (const [method, route] of AGENT_ROUTES) {
      if (method !== 'POST') continue;
      expect(await h.post(route, goodBody[route]), route).toMatchObject({ status: 409, body: { error: 'bridge-off' } });
    }
    expect(await h.approvalPost({ agentId: VIC_AGENT, tools: [TOOL] }, {}, VIC)).toMatchObject({ status: 409, body: { error: 'bridge-off' } });
    // No platform is configured, so no approve link names it.
    expect(await h.approvalGet({}, VIC)).toMatchObject({ status: 404, body: { error: 'not-found' } });
    // Still: signed out is 401 and an unknown agent is 404 before the bridge's state is told.
    expect(await h.read(AGENT, null)).toMatchObject({ status: 401 });
    expect(await h.read('agt_nope')).toMatchObject({ status: 404, body: { error: 'agent-not-found' } });
    expect(mint).not.toHaveBeenCalled();
  });

  it("GET: links with names and grants, and only the caller's own approvals on this agent", async () => {
    const h = await started();
    await link(h, APP, AGENT, 'Support desk');
    await link(h, APP2, OTHER_AGENT, 'Sales board');
    await grant(h, 'builder', [KEY, KEY_CREATE]);
    await grant(h, 'viewer', [KEY_GITHUB], APP, 'github');
    await grant(h, 'viewer', [KEY], APP2);
    await approve(h, VIC, VIC_AGENT, APP2); // Vic's, borrowing this agent: shown to Vic on agt_vic
    await approve(h, VIC, VIC_AGENT_2, APP, 'github'); // Vic's, borrowing another agent: not shown
    await approve(h, ZED, VIC_AGENT, APP2); // someone else's: never shown

    const ada = await h.read(AGENT);
    expect(ada.status).toBe(200);
    expect(ada.headers['cache-control']).toBe('no-store');
    const parsed = AgentAppsReadSchema.parse(ada.body);
    expect(parsed).toEqual({
      enabled: true,
      canManage: true,
      links: [
        {
          appId: APP,
          appName: 'Support desk',
          createdAt: new Date(NOW).toISOString(),
          grants: [
            { connectorId: 'github', connectorName: 'GitHub', mode: 'viewer', tools: [{ toolKey: KEY_GITHUB, name: 'search' }] },
            {
              connectorId: CONN,
              connectorName: 'Linear',
              mode: 'builder',
              tools: [
                { toolKey: KEY, name: TOOL },
                { toolKey: KEY_CREATE, name: 'create_issue' },
              ],
            },
          ],
        },
      ],
      approvals: [],
    });

    const bob = AgentAppsReadSchema.parse((await h.read(AGENT, BOB)).body);
    expect(bob).toMatchObject({ enabled: true, canManage: false });
    if (!bob.enabled) throw new Error('unreachable');
    expect(bob.links.map((l) => l.appId)).toEqual([APP]);

    const vic = AgentAppsReadSchema.parse((await h.read(VIC_AGENT, VIC)).body);
    expect(vic).toEqual({
      enabled: true,
      canManage: false,
      links: [],
      approvals: [
        { appId: APP2, appName: 'Sales board', connectorId: CONN, connectorName: 'Linear', createdAt: expect.any(String) },
      ],
    });
  });

  it('rights come from agents:can-manage-connectors asked as a non-admin', async () => {
    const h = await started();
    await link(h);
    // Bob is a workspace admin per auth:require-user (every fake person is), but doesn't manage the agent.
    expect(await h.post('linkCode', {}, AGENT, BOB)).toMatchObject({ status: 403, body: { error: 'forbidden' } });
    expect(await h.post('linkCode', {}, AGENT, ADA)).toMatchObject({ status: 200 });
    const read = AgentAppsReadSchema.parse((await h.read(AGENT, BOB)).body);
    expect(read).toMatchObject({ canManage: false });
    const asked = h.calls.filter((c) => c.hook === 'agents:can-manage-connectors').map((c) => c.input as { agentId: string; actor: { userId: string; isAdmin: unknown } });
    expect(asked.length).toBeGreaterThanOrEqual(3);
    for (const a of asked) {
      expect(a.actor.isAdmin).toBe(false);
      expect(a.agentId).toBe(AGENT);
    }
    expect(asked.map((a) => a.actor.userId)).toEqual(expect.arrayContaining([ADA, BOB]));
  });

  it('link code: managers only; answers an axl_ code that expires in 15 minutes; only its hash is stored; it is never logged', async () => {
    const h = await started();
    const mint = vi.spyOn(h.store, 'mintLinkCode');
    expect(await h.post('linkCode', {}, AGENT, BOB)).toMatchObject({ status: 403, body: { error: 'forbidden' } });
    expect(mint).not.toHaveBeenCalled();

    const out = await h.post('linkCode', {}, AGENT, ADA);
    expect(out.status).toBe(200);
    expect(out.headers['cache-control']).toBe('no-store');
    const { code, expiresAt } = LinkCodeResponseSchema.parse(out.body);
    expect(code).toMatch(LINK_CODE_RE);
    expect(expiresAt).toBe(new Date(NOW + 15 * 60_000).toISOString());

    expect(mint).toHaveBeenCalledTimes(1);
    expect(mint).toHaveBeenCalledWith({
      codeHash: hashLinkCode(code),
      userId: ADA,
      agentId: AGENT,
      expiresAt: new Date(NOW + 15 * 60_000),
      now: new Date(NOW),
    });
    expect(JSON.stringify(mint.mock.calls)).not.toContain(code);
    expect(await h.store.peekLinkCode(hashLinkCode(code), new Date(NOW))).toEqual({ userId: ADA, agentId: AGENT });

    // Two mints are two codes.
    const again = LinkCodeResponseSchema.parse((await h.post('linkCode', {}, AGENT, ADA)).body);
    expect(again.code).not.toBe(code);

    // A store fault is 503, and its log line carries no code either.
    mint.mockRejectedValueOnce(pluginError('db-down'));
    expect(await h.post('linkCode', {}, AGENT, ADA)).toMatchObject({ status: 503, body: { error: 'unavailable' } });
    expect(h.lines.length).toBeGreaterThan(0);
    const logged = allLogText(h);
    expect(logged).not.toContain(code);
    expect(logged).not.toContain(again.code);
    expect(logged).not.toMatch(/axl_/);
  });

  it('link code: a body key is 400 invalid-body', async () => {
    const h = await started();
    const mint = vi.spyOn(h.store, 'mintLinkCode');
    for (const body of [{ agentId: OTHER_AGENT }, { userId: BOB }, '[]', 'null', 'not json', '', '{"__proto__":{}}']) {
      expect(await h.post('linkCode', body), JSON.stringify(body)).toMatchObject({ status: 400, body: { error: 'invalid-body' } });
    }
    // Rights come before the body: a non-manager with a bad body is still 403.
    expect(await h.post('linkCode', { x: 1 }, AGENT, BOB)).toMatchObject({ status: 403 });
    expect(mint).not.toHaveBeenCalled();
  });

  it('grant: refuses a connector off the agent, a key under another connector, duplicate names, an app linked elsewhere', async () => {
    const h = await started();
    await link(h, APP, AGENT);
    await link(h, APP2, OTHER_AGENT);
    const put = vi.spyOn(h.store, 'putGrant');
    const body = (over: Record<string, unknown> = {}) => ({ appId: APP, connectorId: CONN, mode: 'builder', toolKeys: [KEY], ...over });

    expect(await h.post('grant', body(), AGENT, BOB)).toMatchObject({ status: 403, body: { error: 'forbidden' } });
    expect(await h.post('grant', body({ connectorId: 'asana' }))).toMatchObject({ status: 400, body: { error: 'connector-not-on-agent' } });
    // github is linked to the other agent only... and linear is on OTHER_AGENT but not github:
    expect(await h.post('grant', body({ appId: APP2, connectorId: 'github', toolKeys: [KEY_GITHUB] }), OTHER_AGENT)).toMatchObject({
      status: 400,
      body: { error: 'connector-not-on-agent' },
    });
    expect(await h.post('grant', body({ toolKeys: [KEY, KEY_GITHUB] }))).toMatchObject({ status: 400, body: { error: 'tool-not-on-connector' } });
    expect(await h.post('grant', body({ toolKeys: ['mcp.c9999999999.list_issues'] }))).toMatchObject({
      status: 400,
      body: { error: 'tool-not-on-connector' },
    });
    expect(await h.post('grant', body({ toolKeys: [KEY, `mcp.${NS_2}.${TOOL}`] }))).toMatchObject({
      status: 400,
      body: { error: 'duplicate-tool-name' },
    });
    expect(await h.post('grant', body({ toolKeys: [KEY, KEY] }))).toMatchObject({ status: 400, body: { error: 'duplicate-tool-name' } });
    expect(await h.post('grant', body({ appId: APP2 }))).toMatchObject({ status: 404, body: { error: 'not-linked' } });
    expect(await h.post('grant', body({ appId: 'app_never_linked' }))).toMatchObject({ status: 404, body: { error: 'not-linked' } });
    for (const bad of [
      body({ mode: 'admin' }),
      body({ toolKeys: [] }),
      body({ toolKeys: ['not-a-key'] }),
      body({ agentId: OTHER_AGENT }),
      body({ appId: 'bad id!' }),
      { appId: APP, connectorId: CONN, mode: 'builder' },
    ]) {
      expect(await h.post('grant', bad), JSON.stringify(bad)).toMatchObject({ status: 400, body: { error: 'invalid-body' } });
    }
    expect(put).not.toHaveBeenCalled();

    const ok = await h.post('grant', body({ mode: 'viewer', toolKeys: [KEY_CREATE, KEY] }));
    expect(ok.status).toBe(200);
    expect(SaveGrantResponseSchema.parse(ok.body)).toEqual({
      grant: {
        connectorId: CONN,
        connectorName: 'Linear',
        mode: 'viewer',
        tools: [
          { toolKey: KEY_CREATE, name: 'create_issue' },
          { toolKey: KEY, name: TOOL },
        ],
      },
    });
    expect(put).toHaveBeenCalledWith({ platformId: P, appId: APP, connectorId: CONN, mode: 'viewer', toolKeys: [KEY_CREATE, KEY], agentId: AGENT });
    expect(await h.store.getGrant(P, APP, CONN)).toMatchObject({ mode: 'viewer', toolKeys: [KEY_CREATE, KEY] });

    // The link went (or moved) between the check and the write: no-link.
    put.mockResolvedValueOnce('no-link');
    expect(await h.post('grant', body())).toMatchObject({ status: 404, body: { error: 'not-linked' } });
  });

  it("grant: changing a grant's mode clears its viewer approvals, so old consent can't come back", async () => {
    const h = await started();
    await link(h);
    const save = (mode: string, toolKeys = [KEY]) => h.post('grant', { appId: APP, connectorId: CONN, mode, toolKeys });
    expect((await save('viewer')).status).toBe(200);
    await approve(h);
    expect((await save('viewer', [KEY, KEY_CREATE])).status).toBe(200);
    expect(await h.store.getApproval(VIC, P, APP, CONN)).not.toBeNull();
    expect((await save('builder')).status).toBe(200);
    expect(await h.store.getApproval(VIC, P, APP, CONN)).toBeNull();
    expect((await save('viewer')).status).toBe(200);
    expect(await h.store.getApproval(VIC, P, APP, CONN)).toBeNull();
  });

  it('unlink and ungrant: managers only; an app linked to another agent is 404 not-linked', async () => {
    const h = await started();
    await link(h, APP, AGENT);
    await link(h, APP2, OTHER_AGENT);
    await grant(h, 'builder');
    await grant(h, 'builder', [KEY], APP2);

    expect(await h.post('unlink', { appId: APP }, AGENT, BOB)).toMatchObject({ status: 403, body: { error: 'forbidden' } });
    expect(await h.post('ungrant', { appId: APP, connectorId: CONN }, AGENT, BOB)).toMatchObject({ status: 403, body: { error: 'forbidden' } });

    expect(await h.post('unlink', { appId: APP2 })).toMatchObject({ status: 404, body: { error: 'not-linked' } });
    expect(await h.post('ungrant', { appId: APP2, connectorId: CONN })).toMatchObject({ status: 404, body: { error: 'not-linked' } });
    expect(await h.store.getLink(P, APP2)).not.toBeNull();
    expect(await h.store.getGrant(P, APP2, CONN)).not.toBeNull();

    expect(await h.post('unlink', { appId: APP, extra: 1 })).toMatchObject({ status: 400, body: { error: 'invalid-body' } });
    expect(await h.post('ungrant', { appId: APP })).toMatchObject({ status: 400, body: { error: 'invalid-body' } });

    expect(await h.post('ungrant', { appId: APP, connectorId: 'github' })).toMatchObject({ status: 404, body: { error: 'not-found' } });
    // The link moved to another agent between the check and the delete: that agent's grant stays.
    const del = vi.spyOn(h.store, 'deleteGrant');
    expect(await h.post('ungrant', { appId: APP, connectorId: CONN })).toMatchObject({ status: 200 });
    expect(del).toHaveBeenLastCalledWith(P, APP, CONN, AGENT);
    await grant(h, 'builder');
    del.mockClear();
    expect(await h.post('ungrant', { appId: APP, connectorId: CONN })).toMatchObject({ status: 200, body: {} });
    expect(await h.store.getGrant(P, APP, CONN)).toBeNull();
    expect(await h.post('ungrant', { appId: APP, connectorId: CONN })).toMatchObject({ status: 404, body: { error: 'not-found' } });

    expect(await h.post('unlink', { appId: APP })).toMatchObject({ status: 200, body: {} });
    expect(await h.store.getLink(P, APP)).toBeNull();
    expect(await h.post('unlink', { appId: APP })).toMatchObject({ status: 404, body: { error: 'not-linked' } });
    expect(await h.store.getLink(P, APP2)).not.toBeNull();
  });

  it("revoke: removes only the caller's own approval on this agent", async () => {
    const h = await started();
    await link(h);
    await grant(h, 'viewer');
    await approve(h, VIC, VIC_AGENT);
    await approve(h, ZED, VIC_AGENT); // the fake doesn't check whose agent: only the route decides

    // The manager of the linked agent can't revoke a viewer's consent.
    expect(await h.post('revoke', { appId: APP, connectorId: CONN }, AGENT, ADA)).toMatchObject({ status: 404, body: { error: 'not-found' } });
    // Vic's approval borrows agt_vic, not this other agent of Vic's.
    expect(await h.post('revoke', { appId: APP, connectorId: CONN }, VIC_AGENT_2, VIC)).toMatchObject({ status: 404, body: { error: 'not-found' } });
    expect(await h.store.getApproval(VIC, P, APP, CONN)).not.toBeNull();

    expect(await h.post('revoke', { appId: APP, connectorId: CONN, viewerUserId: ZED }, VIC_AGENT, VIC)).toMatchObject({
      status: 400,
      body: { error: 'invalid-body' },
    });
    expect(await h.post('revoke', { appId: APP, connectorId: CONN }, VIC_AGENT, VIC)).toMatchObject({ status: 200, body: {} });
    expect(await h.store.getApproval(VIC, P, APP, CONN)).toBeNull();
    expect(await h.store.getApproval(ZED, P, APP, CONN)).not.toBeNull();
    expect(await h.post('revoke', { appId: APP, connectorId: CONN }, VIC_AGENT, VIC)).toMatchObject({ status: 404, body: { error: 'not-found' } });
  });

  it("approval GET: 404 unless linked and granted in viewer mode; lists only the caller's personal agents that have the connector, with the app's name", async () => {
    const h = await started();
    const notFound = { status: 404, body: { error: 'not-found' } };
    expect(await h.approvalGet({}, null)).toMatchObject({ status: 401, body: { error: 'unauthenticated' } });
    expect(await h.approvalGet({}, VIC)).toMatchObject(notFound); // not linked
    await link(h, APP, AGENT, 'Support desk');
    expect(await h.approvalGet({}, VIC)).toMatchObject(notFound); // no grant
    await grant(h, 'builder');
    expect(await h.approvalGet({}, VIC)).toMatchObject(notFound); // builder mode
    await grant(h, 'viewer', [KEY, KEY_CREATE]);
    expect(await h.approvalGet({ platformId: 'other-platform' }, VIC)).toMatchObject(notFound);
    expect(await h.approvalGet({ appId: 'bad id!' }, VIC)).toMatchObject(notFound);
    expect(await h.approvalGet({ connectorId: 'Bad' }, VIC)).toMatchObject(notFound);
    expect(await h.approvalGet({ connectorId: 'github' }, VIC)).toMatchObject(notFound);

    const out = await h.approvalGet({}, VIC);
    expect(out.status).toBe(200);
    expect(ApprovalPromptSchema.parse(out.body)).toEqual({
      platformId: P,
      appId: APP,
      appName: 'Support desk',
      connectorId: CONN,
      connectorName: 'Linear',
      tools: [TOOL, 'create_issue'],
      agents: [{ agentId: VIC_AGENT, displayName: `Agent ${VIC_AGENT}` }],
      approvedAgentId: null,
    });
    // Personal agents only: no teamIds is asked for.
    const listed = h.calls.filter((c) => c.hook === 'agents:list-for-user').map((c) => c.input);
    expect(listed).toEqual([{ userId: VIC }]);

    await approve(h, VIC, VIC_AGENT);
    expect(ApprovalPromptSchema.parse((await h.approvalGet({}, VIC)).body).approvedAgentId).toBe(VIC_AGENT);
    // Someone with no personal agent that has the connector sees the prompt with no choice.
    expect(ApprovalPromptSchema.parse((await h.approvalGet({}, ADA)).body)).toMatchObject({ agents: [], approvedAgentId: null });
  });

  it("an agent shared with the caller is not offered as a candidate and can't be approved (TASK-1246)", async () => {
    // agents:list-for-user now also lists a personal agent merely shared with the viewer: ownerType
    // 'user', ownerId someone else's, isOwner false. It has the connector, so only whose it is rules it out.
    const SHARED = 'agt_ada_shared';
    const h = await started({
      handlers: {
        'agents:list-for-user': (_ctx, input: { userId: string }) => ({
          agents: [
            { ...AGENTS[VIC_AGENT]!, isOwner: input.userId === VIC },
            { ...agentRow(SHARED, ADA, 'user', [CONN]), isOwner: false },
          ],
        }),
      },
    });
    await link(h);
    await grant(h, 'viewer', [KEY, KEY_CREATE]);
    const put = vi.spyOn(h.store, 'putApproval');

    // The page offers Vic's own agent and not the shared one.
    const out = await h.approvalGet({}, VIC);
    expect(ApprovalPromptSchema.parse(out.body).agents).toEqual([{ agentId: VIC_AGENT, displayName: `Agent ${VIC_AGENT}` }]);
    // Someone whose only listed agent is the shared one is offered nothing.
    const noOwn = await started({
      handlers: { 'agents:list-for-user': () => ({ agents: [{ ...agentRow(SHARED, ADA, 'user', [CONN]), isOwner: false }] }) },
    });
    await link(noOwn);
    await grant(noOwn, 'viewer', [KEY, KEY_CREATE]);
    expect(ApprovalPromptSchema.parse((await noOwn.approvalGet({}, VIC)).body).agents).toEqual([]);

    // And it can't be approved, even by id.
    const noPut = vi.spyOn(noOwn.store, 'putApproval');
    expect(await noOwn.approvalPost({ agentId: SHARED, tools: [TOOL, 'create_issue'] }, {}, VIC)).toMatchObject({
      status: 400,
      body: { error: 'agent-not-eligible' },
    });
    expect(await h.approvalPost({ agentId: SHARED, tools: [TOOL, 'create_issue'] }, {}, VIC)).toMatchObject({
      status: 400,
      body: { error: 'agent-not-eligible' },
    });
    expect(put).not.toHaveBeenCalled();
    expect(noPut).not.toHaveBeenCalled();
    expect(await noOwn.store.getApproval(VIC, P, APP, CONN)).toBeNull();
  });

  it("approval POST: an ineligible agent is 400 agent-not-eligible; a good choice stores the grant's tool keys", async () => {
    const h = await started();
    await link(h);
    await grant(h, 'viewer', [KEY_CREATE, KEY]);
    const put = vi.spyOn(h.store, 'putApproval');
    const shown = ['create_issue', TOOL];
    for (const agentId of [VIC_AGENT_2, 'agt_team_with_linear', 'agt_someone_else', AGENT, 'agt_nope']) {
      expect(await h.approvalPost({ agentId, tools: shown }, {}, VIC), agentId).toMatchObject({ status: 400, body: { error: 'agent-not-eligible' } });
    }
    for (const bad of [
      { agentId: VIC_AGENT, tools: shown, toolKeys: [KEY] },
      { agentId: VIC_AGENT }, // the tools the page showed are required
      { agentId: VIC_AGENT, tools: ['not a name'] },
      {},
      { agentId: '', tools: shown },
      'nope',
    ]) {
      expect(await h.approvalPost(bad, {}, VIC), JSON.stringify(bad)).toMatchObject({ status: 400, body: { error: 'invalid-body' } });
    }
    expect(await h.approvalPost({ agentId: VIC_AGENT, tools: shown }, {}, null)).toMatchObject({ status: 401 });
    expect(await h.approvalPost({ agentId: VIC_AGENT, tools: shown }, { platformId: 'other-platform' }, VIC)).toMatchObject({
      status: 404,
      body: { error: 'not-found' },
    });
    expect(put).not.toHaveBeenCalled();

    expect(await h.approvalPost({ agentId: VIC_AGENT, tools: shown }, {}, VIC)).toMatchObject({ status: 200, body: {} });
    expect(put).toHaveBeenCalledWith({
      viewerUserId: VIC,
      platformId: P,
      appId: APP,
      connectorId: CONN,
      agentId: VIC_AGENT,
      toolKeys: [KEY_CREATE, KEY],
    });
    expect(await h.store.getApproval(VIC, P, APP, CONN)).toMatchObject({ agentId: VIC_AGENT, toolKeys: [KEY_CREATE, KEY] });

    // The grant went (or left viewer mode) between the check and the write.
    put.mockResolvedValueOnce('no-grant');
    expect(await h.approvalPost({ agentId: VIC_AGENT, tools: shown }, {}, VIC)).toMatchObject({ status: 404, body: { error: 'not-found' } });

    // A builder-mode grant takes no approvals.
    await grant(h, 'builder');
    expect(await h.approvalPost({ agentId: VIC_AGENT, tools: shown }, {}, VIC)).toMatchObject({ status: 404, body: { error: 'not-found' } });
  });

  it('approval POST: only the tools the page showed are approved; a tool added since needs approval again', async () => {
    const h = await started();
    await link(h);
    await grant(h, 'viewer', [KEY]);
    const prompt = ApprovalPromptSchema.parse((await h.approvalGet({}, VIC)).body);
    expect(prompt.tools).toEqual([TOOL]);

    // A manager widens the grant while the page is open.
    await grant(h, 'viewer', [KEY, KEY_CREATE]);
    expect(await h.approvalPost({ agentId: VIC_AGENT, tools: prompt.tools }, {}, VIC)).toMatchObject({ status: 200, body: {} });
    expect(await h.store.getApproval(VIC, P, APP, CONN)).toMatchObject({ toolKeys: [KEY] });

    // A name the grant doesn't hold adds nothing; the grant's own order is kept.
    expect(await h.approvalPost({ agentId: VIC_AGENT, tools: ['create_issue', 'delete_everything', TOOL] }, {}, VIC)).toMatchObject({
      status: 200,
    });
    expect(await h.store.getApproval(VIC, P, APP, CONN)).toMatchObject({ toolKeys: [KEY, KEY_CREATE] });

    // Nothing the page showed is still granted (a stale page): 404, and the approval is left as it was.
    const put = vi.spyOn(h.store, 'putApproval');
    for (const tools of [['delete_everything'], []]) {
      expect(await h.approvalPost({ agentId: VIC_AGENT, tools }, {}, VIC)).toMatchObject({ status: 404, body: { error: 'not-found' } });
    }
    expect(put).not.toHaveBeenCalled();
    expect(await h.store.getApproval(VIC, P, APP, CONN)).toMatchObject({ toolKeys: [KEY, KEY_CREATE] });
  });

  it('a hook fault answers 503 unavailable, logged code-only', async () => {
    const h = await started({
      handlers: {
        'connectors:list-effective': () => {
          throw pluginError('inventory-down');
        },
      },
    });
    await link(h);
    expect(await h.post('grant', { appId: APP, connectorId: CONN, mode: 'builder', toolKeys: [KEY] })).toMatchObject({
      status: 503,
      body: { error: 'unavailable' },
    });
    const line = h.lines.find((l) => l.msg === 'apps_settings_route_failed');
    expect(line?.bindings).toMatchObject({ stage: 'grant', code: 'inventory-down' });
    expect(allLogText(h)).not.toContain('SECRET-MESSAGE');
  });

  it('no settings route bypasses CSRF, and every POST is capped at 16 KiB', async () => {
    const h = harness();
    const undo = await h.start();
    const R = APPS_SETTINGS_ROUTES;
    expect(h.specs.map((s) => `${s.method} ${s.path}`).sort()).toEqual(
      [
        `GET ${R.read}`,
        `POST ${R.linkCode}`,
        `POST ${R.unlink}`,
        `POST ${R.grant}`,
        `POST ${R.ungrant}`,
        `POST ${R.revoke}`,
        `GET ${R.approval}`,
        `POST ${R.approval}`,
      ].sort(),
    );
    expect(SETTINGS_BODY_MAX_BYTES).toBe(16_384);
    for (const s of h.specs) {
      expect(s.bypassCsrf, s.path).toBeUndefined();
      if (s.method === 'POST') expect(s.maxBodyBytes, s.path).toBe(SETTINGS_BODY_MAX_BYTES);
      else expect(s.maxBodyBytes, s.path).toBeUndefined();
    }
    // A body past the cap that still reached the handler is refused (the server's cap is first).
    expect(await h.post('linkCode', `{${' '.repeat(SETTINGS_BODY_MAX_BYTES)}}`)).toMatchObject({ status: 400, body: { error: 'invalid-body' } });
    // Every route comes back undone.
    expect(undo).toHaveLength(h.specs.length);
    for (const u of undo) u();
    for (const u of h.unregisters) expect(u).toHaveBeenCalledTimes(1);
  });

  it('a route that fails to register undoes the ones before it', async () => {
    const h = harness();
    let n = 0;
    const bus = new HookBus();
    const unregister = vi.fn();
    bus.registerService('http:register-route', 'fake', async () => {
      if (++n === 3) throw pluginError('route-taken');
      return { unregister };
    });
    await expect(registerSettingsRoutes(bus, { store: h.store, platformId: P, logger: capturingLogger([]), now: () => NOW })).rejects.toThrow();
    expect(unregister).toHaveBeenCalledTimes(2);
  });
});
