import { HookBus, PluginError, type Logger } from '@ax/core';
import { describe, expect, it } from 'vitest';
import { createAgentSlackRoutes } from '../agent-routes.js';
import type { ChannelDeps } from '../channels.js';
import type { RouteRequest, RouteResponse } from '../http-types.js';
import { ADMIN_BODY_MAX_BYTES } from '../limits.js';
import { createSlackApi } from '../slack-api.js';
import type { InstallRow } from '../store.js';
import { fakeAgents, type FakeAgent } from './fake-agents.js';
import { fakeBotToken } from './fake-slack-tokens.js';
import { memoryChannelStore } from './memory-channel-store.js';

/*
  The agent-settings Slack section, through its route handlers, the real
  Slack client and a fake Slack Web API. Who may do what is the point:
  signed out → 401; anyone who can't see the agent → the same 404 a missing
  agent gets; a team member reads without managing (403 on writes); a team
  admin of the agent's team manages; workspace-admin status never counts;
  a personal agent is refused before Slack is asked anything.
*/

// ── Fixtures ────────────────────────────────────────────────────────────────

const INSTALL_ID = 'q3VtZ0xH4kTn9Wb2LmPa1A';
const TEAM_ID = 'T07ABCDEF12';
const BOT_TOKEN = fakeBotToken('ROUTESTESTSECRET');
const INSTALL: InstallRow = {
  installId: INSTALL_ID,
  status: 'active',
  appId: 'A07QF9ZK2MN',
  clientId: '7512345678901.7598765432109',
  botName: 'canopy-works',
  teamId: TEAM_ID,
  teamName: 'Canopy Works',
  botUserId: 'U07BOTUSER1',
  connectedByUserId: 'usr_installer',
  createdAt: new Date('2026-11-13T10:00:00Z'),
  installedAt: new Date('2026-11-13T10:05:00Z'),
};

const SUPPORT_TEAM = 'team_support';
const SALES_TEAM = 'team_sales';
const SUPPORT: FakeAgent = {
  id: 'agt_support',
  displayName: 'Support',
  visibility: 'team',
  ownerType: 'team',
  ownerId: SUPPORT_TEAM,
};
const SALES: FakeAgent = { id: 'agt_sales', displayName: 'Sales', visibility: 'team', ownerType: 'team', ownerId: SALES_TEAM };
const PATS: FakeAgent = { id: 'agt_pat', displayName: "Pat's agent", visibility: 'personal', ownerType: 'user', ownerId: 'usr_pat' };

interface TestUser {
  id: string;
  displayName: string | null;
  email: string | null;
  isAdmin: boolean;
}
const person = (id: string, displayName: string | null, isAdmin = false): TestUser => ({
  id,
  displayName,
  email: `${id.slice(4)}@canopyworks.example`,
  isAdmin,
});
const ADA = person('usr_ada', 'Ada Admin'); // a team admin of the support team
const GRACE = person('usr_grace', 'Grace Hopper'); // another team admin of the support team
const NONAME = person('usr_noname', null); // a team admin of the support team with no display name
const MEL = person('usr_mel', 'Mel Member'); // a plain member of the support team
const WILL = person('usr_will', 'Will Wsadmin', true); // a workspace admin, and a plain member of the support team
const WANDA = person('usr_wanda', 'Wanda Wsadmin', true); // a workspace admin in no team
const OTTO = person('usr_otto', 'Otto Outsider'); // in no team
const PAT = person('usr_pat', 'Pat Personal'); // owns a personal agent
const SAM = person('usr_sam', 'Sam Sales'); // a team admin of the sales team
const USERS = [ADA, GRACE, NONAME, MEL, WILL, WANDA, OTTO, PAT, SAM];

const SUPPORT_CH = 'C07SUPPORT1';
const SALES_CH = 'C07SALES002';
const PRIVATE_CH = 'C07PRIVATE1';
const ARCHIVED_CH = 'C07ARCHIVE1';
const SHARED_CH = 'C07SHARED01';
const PENDING_CH = 'C07PENDING1';
const NAMES: Record<string, string> = {
  [SUPPORT_CH]: 'support-desk',
  [SALES_CH]: 'sales-floor',
  [PRIVATE_CH]: 'secret-plans',
  [ARCHIVED_CH]: 'old-news',
  [SHARED_CH]: 'partner-room',
  [PENDING_CH]: 'soon-partners',
};

/**
 * A channel as conversations.info and conversations.list describe it
 * (Slack's documented example's fields), with no `is_member`: Slack's
 * documented answer often leaves it out, which reads as "not a member".
 */
function rawChannel(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const name = NAMES[id] ?? id.toLowerCase();
  return {
    id,
    name,
    is_channel: true,
    is_group: false,
    is_im: false,
    is_mpim: false,
    is_private: false,
    created: 1654868334,
    is_archived: false,
    is_general: false,
    unlinked: 0,
    name_normalized: name,
    is_shared: false,
    is_frozen: false,
    is_org_shared: false,
    is_ext_shared: false,
    is_pending_ext_shared: false,
    pending_shared: [],
    context_team_id: TEAM_ID,
    parent_conversation: null,
    creator: 'U07CREATOR1',
    shared_team_ids: [TEAM_ID],
    pending_connected_team_ids: [],
    topic: { value: '', creator: '', last_set: 0 },
    purpose: { value: '', creator: '', last_set: 0 },
    previous_names: [],
    ...over,
  };
}

// ── A fake Slack Web API behind the real client's fetchImpl ─────────────────

function fakeSlackWeb() {
  const channels = new Map<string, Record<string, unknown>>();
  /** The channels the bot is in. */
  const joined = new Set<string>();
  const sent: Array<{ method: string; form: Record<string, string>; authorization: string | null }> = [];
  /** A method listed here answers this instead. */
  const overrides = new Map<string, () => Response>();
  /** conversations.list: channels per page, whatever `limit` asks for. */
  let pageSize = 1000;

  const answer = (body: Record<string, unknown>): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const ok = (fields: Record<string, unknown> = {}): Response => answer({ ok: true, ...fields });
  const refuse = (error: string): Response => answer({ ok: false, error });

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = url.pathname.replace(/^\/api\//, '');
    const form = Object.fromEntries(new URLSearchParams(typeof init?.body === 'string' ? init.body : ''));
    sent.push({ method, form, authorization: new Headers(init?.headers).get('authorization') });
    const custom = overrides.get(method);
    if (custom !== undefined) return custom();
    const id = form['channel'] ?? '';
    switch (method) {
      case 'conversations.info': {
        const found = channels.get(id);
        return found === undefined ? refuse('channel_not_found') : ok({ channel: found });
      }
      case 'conversations.list': {
        const all = [...channels.values()];
        const start = form['cursor'] === undefined ? 0 : Number(form['cursor'].slice(1));
        const end = start + pageSize;
        return ok({
          channels: all.slice(start, end),
          response_metadata: { next_cursor: end < all.length ? `p${end}` : '' },
        });
      }
      case 'conversations.join': {
        const found = channels.get(id);
        if (found === undefined) return refuse('channel_not_found');
        if (found['is_archived'] === true) return refuse('is_archived');
        if (found['is_private'] === true) return refuse('method_not_supported_for_channel_type');
        const already = joined.has(id);
        joined.add(id);
        return ok({
          channel: found,
          ...(already ? { warning: 'already_in_channel', response_metadata: { warnings: ['already_in_channel'] } } : {}),
        });
      }
      default:
        return refuse('unknown_method');
    }
  }) as typeof fetch;

  return {
    fetchImpl,
    channels,
    joined,
    sent,
    overrides,
    refuse,
    setPageSize(n: number): void {
      pageSize = n;
    },
    methods: (): string[] => sent.map((s) => s.method),
  };
}

// ── A request and response shaped like @ax/http-server's ───────────────────

interface Answered {
  status: number;
  how: 'json' | 'text' | 'end' | 'redirect' | null;
  body: unknown;
  headers: Record<string, string>;
}

function fakeResponse(): { res: RouteResponse; answer: Answered } {
  const answer: Answered = { status: 200, how: null, body: undefined, headers: {} };
  const finish = (how: NonNullable<Answered['how']>, body?: unknown): void => {
    if (answer.how !== null) throw new Error('response already finished');
    answer.how = how;
    answer.body = body;
  };
  const res: RouteResponse = {
    status(n) {
      answer.status = n;
      return res;
    },
    header(name, value) {
      answer.headers[name.toLowerCase()] = value;
      return res;
    },
    json: (v) => finish('json', v),
    text: (s) => finish('text', s),
    end: () => finish('end'),
    redirect: () => finish('redirect'),
  };
  return { res, answer };
}

type Suffix = '' | '/available' | '/connect' | '/disconnect' | '/remember';

/** Every route, with a body each write would accept. */
const EVERY_ROUTE: Array<{ method: 'GET' | 'POST'; suffix: Suffix; body?: unknown }> = [
  { method: 'GET', suffix: '' },
  { method: 'GET', suffix: '/available' },
  { method: 'POST', suffix: '/connect', body: { channelId: SUPPORT_CH } },
  { method: 'POST', suffix: '/disconnect', body: { channelId: SUPPORT_CH } },
  { method: 'POST', suffix: '/remember', body: { channelId: SUPPORT_CH, remember: false } },
];
const WRITES = EVERY_ROUTE.filter((r) => r.suffix !== '');

// ── The routes' surroundings ────────────────────────────────────────────────

interface Line {
  level: string;
  msg: string;
  fields: Record<string, unknown> | undefined;
}

function world(o: { workspaceAdminsMayManage?: boolean; authFault?: Error; getUserFault?: Error } = {}) {
  const bus = new HookBus();
  const people = fakeAgents(bus, o.workspaceAdminsMayManage === true ? { workspaceAdminsMayManage: true } : {});
  for (const agent of [SUPPORT, SALES, PATS]) people.addAgent(agent);
  for (const admin of [ADA, GRACE, NONAME]) people.setRole(SUPPORT_TEAM, admin.id, 'admin');
  for (const member of [MEL, WILL]) people.setRole(SUPPORT_TEAM, member.id, 'member');
  people.setRole(SALES_TEAM, SAM.id, 'admin');

  // Auth's accounts, by id: a test may rename or delete one.
  const users = new Map(USERS.map((u) => [u.id, { ...u }]));
  const userLookups: string[] = [];
  bus.registerService('auth:require-user', '@ax/auth-better', async (_ctx, raw) => {
    if (o.authFault !== undefined) throw o.authFault;
    const { req } = raw as { req: RouteRequest };
    const user = users.get(String(req.headers['x-test-user']));
    if (user === undefined) {
      throw new PluginError({ code: 'unauthenticated', plugin: '@ax/auth-better', message: 'no session' });
    }
    return { user: { ...user } };
  });
  bus.registerService('auth:get-user', '@ax/auth-better', async (_ctx, raw) => {
    const { userId } = raw as { userId: string };
    userLookups.push(userId);
    if (o.getUserFault !== undefined) throw o.getUserFault;
    const user = users.get(userId);
    return user === undefined ? null : { ...user };
  });

  const lines: Line[] = [];
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, fields });
  };
  const logger: Logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: () => logger };

  const slack = fakeSlackWeb();
  for (const id of [SUPPORT_CH, SALES_CH]) slack.channels.set(id, rawChannel(id));
  slack.channels.set(PRIVATE_CH, rawChannel(PRIVATE_CH, { is_channel: false, is_group: true, is_private: true }));
  slack.channels.set(ARCHIVED_CH, rawChannel(ARCHIVED_CH, { is_archived: true }));
  slack.channels.set(SHARED_CH, rawChannel(SHARED_CH, { is_shared: true, is_ext_shared: true }));
  slack.channels.set(PENDING_CH, rawChannel(PENDING_CH, { is_pending_ext_shared: true }));

  const memory = memoryChannelStore();
  const state = { install: { ...INSTALL } as InstallRow | null };
  const deps: ChannelDeps = {
    bus,
    installs: { current: async () => (state.install === null ? null : { ...state.install }) },
    channels: memory.store,
    secrets: { get: async (_owner, name) => (name === 'bot-token' ? BOT_TOKEN : null) },
    api: createSlackApi({ fetchImpl: slack.fetchImpl }),
    logger,
  };
  const routes = createAgentSlackRoutes(deps);

  async function call(
    method: 'GET' | 'POST',
    suffix: Suffix,
    agentId: string,
    as: TestUser | null,
    body?: unknown,
  ): Promise<Answered> {
    const pattern = `/settings/slack/:agentId${suffix}`;
    const spec = routes.find((r) => r.method === method && r.path === pattern);
    if (spec === undefined) throw new Error(`no route ${method} ${pattern}`);
    const path = `/settings/slack/${encodeURIComponent(agentId)}${suffix}`;
    const raw =
      body === undefined
        ? Buffer.alloc(0)
        : Buffer.isBuffer(body)
          ? body
          : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req: RouteRequest = {
      method,
      path,
      rawPath: path,
      params: { agentId },
      query: {},
      headers: { 'content-type': 'application/json', ...(as !== null ? { 'x-test-user': as.id } : {}) },
      body: raw,
    };
    const { res, answer } = fakeResponse();
    await spec.handler(req, res);
    if (answer.how === null) throw new Error(`${method} ${path} never answered`);
    return answer;
  }

  /** Status and body only. */
  const reply = async (p: Promise<Answered>): Promise<{ status: number; body: unknown }> => {
    const a = await p;
    return { status: a.status, body: a.body };
  };

  return {
    bus,
    people,
    users,
    userLookups,
    slack,
    memory,
    state,
    lines,
    routes,
    call,
    status: (agentId: string, as: TestUser | null = ADA) => reply(call('GET', '', agentId, as)),
    available: (agentId: string, as: TestUser | null = ADA) => reply(call('GET', '/available', agentId, as)),
    connect: (agentId: string, channelId: string, as: TestUser | null = ADA) =>
      reply(call('POST', '/connect', agentId, as, { channelId })),
    disconnect: (agentId: string, channelId: string, as: TestUser | null = ADA) =>
      reply(call('POST', '/disconnect', agentId, as, { channelId })),
    remember: (agentId: string, channelId: string, remember: unknown, as: TestUser | null = ADA) =>
      reply(call('POST', '/remember', agentId, as, { channelId, remember })),
  };
}

const NOT_FOUND = { status: 404, body: { error: 'not-found' } };
const FORBIDDEN = { status: 403, body: { error: 'forbidden' } };

// ── The routes themselves ───────────────────────────────────────────────────

describe('the routes', () => {
  it('serves the section under /settings/slack/:agentId; the writes cap their bodies and keep the CSRF check', () => {
    const w = world();
    expect(
      w.routes.map((r) => ({ method: r.method, path: r.path, bypassCsrf: r.bypassCsrf, maxBodyBytes: r.maxBodyBytes })),
    ).toEqual([
      { method: 'GET', path: '/settings/slack/:agentId', bypassCsrf: undefined, maxBodyBytes: undefined },
      { method: 'GET', path: '/settings/slack/:agentId/available', bypassCsrf: undefined, maxBodyBytes: undefined },
      {
        method: 'POST',
        path: '/settings/slack/:agentId/connect',
        bypassCsrf: undefined,
        maxBodyBytes: ADMIN_BODY_MAX_BYTES,
      },
      {
        method: 'POST',
        path: '/settings/slack/:agentId/disconnect',
        bypassCsrf: undefined,
        maxBodyBytes: ADMIN_BODY_MAX_BYTES,
      },
      {
        method: 'POST',
        path: '/settings/slack/:agentId/remember',
        bypassCsrf: undefined,
        maxBodyBytes: ADMIN_BODY_MAX_BYTES,
      },
    ]);
    for (const r of w.routes) expect(r).not.toHaveProperty('bypassCsrf');
  });
});

// ── Who may do what ─────────────────────────────────────────────────────────

describe('rights', () => {
  it('refuses a signed-out request with 401 on every route, before anything else is asked', async () => {
    const w = world();
    for (const r of EVERY_ROUTE) {
      const a = await w.call(r.method, r.suffix, SUPPORT.id, null, r.body);
      expect({ status: a.status, body: a.body }, `${r.method} ${r.suffix}`).toEqual({
        status: 401,
        body: { error: 'unauthenticated' },
      });
    }
    expect(w.people.calls).toEqual([]);
    expect(w.slack.sent).toEqual([]);
    expect(w.memory.calls).toEqual([]);
    expect(w.lines).toEqual([]);
  });

  it('answers an auth fault with 500 on every route, logged by code alone', async () => {
    const w = world({
      authFault: new PluginError({ code: 'session-store-down', plugin: '@ax/auth-better', message: 'ada@x' }),
    });
    for (const r of EVERY_ROUTE) {
      const a = await w.call(r.method, r.suffix, SUPPORT.id, ADA, r.body);
      expect({ status: a.status, body: a.body }).toEqual({ status: 500, body: { error: 'internal' } });
    }
    expect(w.lines).toHaveLength(EVERY_ROUTE.length);
    for (const line of w.lines) {
      expect(line).toEqual({
        level: 'error',
        msg: 'slack_channel_route_failed',
        fields: { stage: 'auth', code: 'session-store-down' },
      });
    }
    expect(w.people.calls).toEqual([]);
  });

  it('gives someone outside the team, a workspace admin outside it, and a missing agent the same 404 everywhere', async () => {
    const w = world();
    for (const r of EVERY_ROUTE) {
      const missing = await w.call(r.method, r.suffix, 'agt_gone', ADA, r.body);
      expect({ status: missing.status, body: missing.body }).toEqual(NOT_FOUND);
      // The whole answer, headers too: nothing tells "exists" from "doesn't".
      expect(await w.call(r.method, r.suffix, SUPPORT.id, OTTO, r.body), `${r.suffix} outsider`).toEqual(missing);
      expect(await w.call(r.method, r.suffix, SUPPORT.id, WANDA, r.body), `${r.suffix} workspace admin`).toEqual(
        missing,
      );
      expect(await w.call(r.method, r.suffix, SUPPORT.id, SAM, r.body), `${r.suffix} other team's admin`).toEqual(
        missing,
      );
    }
    expect(w.slack.sent).toEqual([]);
    expect(w.memory.calls).toEqual([]);
  });

  it('lets a team member read the section without the manage controls, and refuses every write with 403', async () => {
    const w = world();
    expect(await w.connect(SUPPORT.id, SUPPORT_CH, ADA)).toMatchObject({ status: 200 });
    const sent = w.slack.sent.length;
    const before = w.memory.row(INSTALL_ID, SUPPORT_CH);

    expect(await w.status(SUPPORT.id, MEL)).toMatchObject({ status: 200, body: { state: 'ready', canManage: false } });
    for (const r of WRITES) {
      const a = await w.call(r.method, r.suffix, SUPPORT.id, MEL, r.body);
      expect({ status: a.status, body: a.body }, r.suffix).toEqual(FORBIDDEN);
    }
    expect(w.slack.sent).toHaveLength(sent);
    expect(w.memory.row(INSTALL_ID, SUPPORT_CH)).toEqual(before);
  });

  it.each([
    ['an empty object', {}],
    ['allowed as a string', { allowed: 'true' }],
    ['null', null],
  ])('answers 403 on every write, and Slack is asked nothing, when agents answers the manage question with %s', async (_what, answer) => {
    const w = world();
    w.people.answers.set('agents:can-set-shared-credential', answer);
    for (const r of WRITES) {
      const a = await w.call(r.method, r.suffix, SUPPORT.id, ADA, r.body);
      expect({ status: a.status, body: a.body }, r.suffix).toEqual(FORBIDDEN);
    }
    const a = await w.call('GET', '/available', SUPPORT.id, ADA);
    expect({ status: a.status, body: a.body }).toEqual(FORBIDDEN);
    expect(w.slack.sent).toEqual([]);
    expect(w.memory.calls).toEqual([]);
    // The section itself still reads, without the manage controls.
    expect(await w.status(SUPPORT.id, ADA)).toMatchObject({ status: 200, body: { state: 'ready', canManage: false } });
  });

  it('never reads a body for someone without rights: a bad or oversized body is the rights answer, not a 400 or 413', async () => {
    const w = world();
    const garbage = 'garbage';
    const oversized = Buffer.from(JSON.stringify({ channelId: SUPPORT_CH, pad: 'x'.repeat(ADMIN_BODY_MAX_BYTES) }));
    const arrayBody = JSON.stringify([SUPPORT_CH]);
    const extraKey = JSON.stringify({ channelId: SUPPORT_CH, agentId: SALES.id });
    for (const suffix of ['/connect', '/disconnect', '/remember'] as const) {
      for (const body of [garbage, oversized, arrayBody, extraKey]) {
        const label = `${suffix} ${typeof body === 'string' ? body : 'oversized'}`;
        // Not a member of the team (or a workspace admin outside it): as unknown as a missing agent.
        for (const outsider of [OTTO, WANDA]) {
          const a = await w.call('POST', suffix, SUPPORT.id, outsider, body);
          expect({ status: a.status, body: a.body }, `${label} ${outsider.id}`).toEqual(NOT_FOUND);
        }
        // A plain team member can see the agent but not manage it.
        const m = await w.call('POST', suffix, SUPPORT.id, MEL, body);
        expect({ status: m.status, body: m.body }, `${label} member`).toEqual(FORBIDDEN);
        // A personal agent's owner learns it is one, not that the body is bad.
        const p = await w.call('POST', suffix, PATS.id, PAT, body);
        expect({ status: p.status, body: p.body }, `${label} personal`).toEqual({
          status: 409,
          body: { error: 'personal-agent' },
        });
      }
    }
    expect(w.slack.sent).toEqual([]);
    expect(w.memory.calls).toEqual([]);
  });

  it('treats a workspace admin who is a plain member of the team as a member: asked as a non-admin, 403 on writes', async () => {
    // Even under an agents rule that WOULD let a workspace admin through.
    const w = world({ workspaceAdminsMayManage: true });
    expect(await w.status(SUPPORT.id, WILL)).toMatchObject({ status: 200, body: { canManage: false } });
    for (const r of WRITES) {
      const a = await w.call(r.method, r.suffix, SUPPORT.id, WILL, r.body);
      expect({ status: a.status, body: a.body }, r.suffix).toEqual(FORBIDDEN);
    }
    const asked = w.people.inputs('agents:can-set-shared-credential');
    expect(asked.length).toBeGreaterThan(0);
    for (const input of asked) expect(input).toEqual({ agentId: SUPPORT.id, actor: { userId: WILL.id, isAdmin: false } });
    expect(w.slack.sent).toEqual([]);
  });

  it("lets a team admin of the agent's team manage it", async () => {
    const w = world();
    expect(await w.status(SUPPORT.id, ADA)).toMatchObject({ status: 200, body: { state: 'ready', canManage: true } });
    expect(await w.available(SUPPORT.id, ADA)).toMatchObject({ status: 200 });
    expect(await w.connect(SUPPORT.id, SUPPORT_CH, ADA)).toMatchObject({ status: 200 });
    expect(await w.remember(SUPPORT.id, SUPPORT_CH, false, ADA)).toEqual({ status: 200, body: {} });
    expect(await w.disconnect(SUPPORT.id, SUPPORT_CH, ADA)).toEqual({ status: 200, body: { removed: true } });
  });

  it('says a personal agent is one, and refuses every write with 409 personal-agent before Slack is asked anything', async () => {
    const w = world();
    expect(await w.status(PATS.id, PAT)).toEqual({
      status: 200,
      body: { state: 'personal-agent', botName: 'canopy-works' },
    });
    for (const r of WRITES) {
      const a = await w.call(r.method, r.suffix, PATS.id, PAT, r.body);
      expect({ status: a.status, body: a.body }, r.suffix).toEqual({ status: 409, body: { error: 'personal-agent' } });
    }
    expect(w.slack.sent).toEqual([]);
    expect(w.memory.calls).toEqual([]);
    expect(w.people.inputs('agents:can-set-shared-credential')).toEqual([]);
    // Someone else's personal agent is as unknown as a missing one.
    expect(await w.status(PATS.id, ADA)).toEqual(NOT_FOUND);
  });

  it('answers an agent id no agent could have with 404, without asking agents', async () => {
    const w = world();
    for (const agentId of ['x'.repeat(129), 'agt support', 'agt\nsupport', `agt${String.fromCharCode(0x202e)}x`]) {
      for (const r of EVERY_ROUTE) {
        const a = await w.call(r.method, r.suffix, agentId, ADA, r.body);
        expect({ status: a.status, body: a.body }, JSON.stringify(agentId)).toEqual(NOT_FOUND);
      }
    }
    expect(w.people.calls).toEqual([]);
  });
});

// ── GET /settings/slack/:agentId ────────────────────────────────────────────

describe('the section', () => {
  it('says no-workspace to anyone who can see the agent while Slack is not connected (or not finished)', async () => {
    for (const install of [null, { ...INSTALL, status: 'pending' as const, teamId: null, teamName: null }]) {
      const w = world();
      w.state.install = install;
      for (const [agentId, as] of [
        [SUPPORT.id, ADA],
        [SUPPORT.id, MEL],
        [PATS.id, PAT],
      ] as const) {
        expect(await w.status(agentId, as)).toEqual({ status: 200, body: { state: 'no-workspace' } });
      }
      // Still nothing for someone who can't see it.
      expect(await w.status(SUPPORT.id, OTTO)).toEqual(NOT_FOUND);
    }
  });

  it("lists the agent's channels, oldest first, with who connected each and its memory switch", async () => {
    const w = world();
    await w.connect(SUPPORT.id, SUPPORT_CH, ADA);
    await w.connect(SUPPORT.id, SALES_CH, GRACE);
    await w.remember(SUPPORT.id, SALES_CH, false, GRACE);
    // Another agent's channel is not this agent's business.
    w.slack.channels.set('C07OTHER001', rawChannel('C07OTHER001'));
    await w.connect(SALES.id, 'C07OTHER001', SAM);

    expect(await w.status(SUPPORT.id, MEL)).toEqual({
      status: 200,
      body: {
        state: 'ready',
        botName: 'canopy-works',
        workspaceName: 'Canopy Works',
        canManage: false,
        channels: [
          { channelId: SUPPORT_CH, name: 'support-desk', remember: true, connectedBy: 'Ada Admin', needsReconnect: false },
          { channelId: SALES_CH, name: 'sales-floor', remember: false, connectedBy: 'Grace Hopper', needsReconnect: false },
        ],
      },
    });
  });

  it('never shows the connector\'s email: no display name, a deleted account or an auth fault all read "A teammate"', async () => {
    const w = world();
    await w.connect(SUPPORT.id, SUPPORT_CH, NONAME);
    expect(await w.status(SUPPORT.id, MEL)).toMatchObject({ body: { channels: [{ connectedBy: 'A teammate' }] } });

    // Only invisible characters left once cleaned.
    w.users.get(NONAME.id)!.displayName = `${String.fromCharCode(0x202e)}${String.fromCharCode(0x200b)}`;
    expect(await w.status(SUPPORT.id, MEL)).toMatchObject({ body: { channels: [{ connectedBy: 'A teammate' }] } });

    w.users.delete(NONAME.id);
    expect(await w.status(SUPPORT.id, MEL)).toMatchObject({ body: { channels: [{ connectedBy: 'A teammate' }] } });
    expect(w.lines.filter((l) => l.msg === 'slack_channel_route_failed')).toEqual([]);

    const faulty = world({
      getUserFault: new PluginError({ code: 'db-down', plugin: '@ax/auth-better', message: NONAME.email! }),
    });
    await faulty.connect(SUPPORT.id, SUPPORT_CH, ADA);
    const shown = await faulty.status(SUPPORT.id, MEL);
    expect(shown).toMatchObject({ status: 200, body: { channels: [{ connectedBy: 'A teammate' }] } });
    expect(faulty.lines.filter((l) => l.msg === 'slack_channel_route_failed')).toContainEqual({
      level: 'warn',
      msg: 'slack_channel_route_failed',
      fields: { stage: 'connected-by', code: 'db-down' },
    });
    expect(JSON.stringify([shown, faulty.lines])).not.toMatch(/@canopyworks\.example/);
  });

  it('marks a channel needsReconnect once the person who connected it loses the agent', async () => {
    const w = world();
    await w.connect(SUPPORT.id, SUPPORT_CH, ADA);
    await w.connect(SUPPORT.id, SALES_CH, GRACE);
    // Ada leaves the support team; Grace stays.
    w.people.setRole(SUPPORT_TEAM, ADA.id, null);

    expect(await w.status(SUPPORT.id, GRACE)).toMatchObject({
      status: 200,
      body: {
        channels: [
          { channelId: SUPPORT_CH, connectedBy: 'Ada Admin', needsReconnect: true },
          { channelId: SALES_CH, connectedBy: 'Grace Hopper', needsReconnect: false },
        ],
      },
    });
    // Asked about the connector, not about whoever is reading the page.
    expect(w.people.inputs('agents:resolve')).toContainEqual({ agentId: SUPPORT.id, userId: ADA.id });
  });

  it('answers 500, logged by code alone, when the store fails', async () => {
    const w = world();
    w.memory.store.listForAgent = async () => {
      throw Object.assign(new Error(`relation gone ${SUPPORT_CH}`), { code: '42P01' });
    };
    expect(await w.status(SUPPORT.id, ADA)).toEqual({ status: 500, body: { error: 'internal' } });
    expect(w.lines).toEqual([
      { level: 'error', msg: 'slack_channel_route_failed', fields: { stage: 'status', code: '42P01' } },
    ]);
  });
});

// ── POST …/connect ──────────────────────────────────────────────────────────

describe('connect', () => {
  it('connects a channel for a team admin: Slack is asked about it, the bot joins, and the row comes back', async () => {
    const w = world();
    expect(await w.connect(SUPPORT.id, SUPPORT_CH, ADA)).toEqual({
      status: 200,
      body: {
        channel: { channelId: SUPPORT_CH, name: 'support-desk', remember: true, connectedBy: 'Ada Admin', needsReconnect: false },
        reconnected: false,
      },
    });
    expect(w.slack.sent).toEqual([
      { method: 'conversations.info', form: { channel: SUPPORT_CH }, authorization: `Bearer ${BOT_TOKEN}` },
      { method: 'conversations.join', form: { channel: SUPPORT_CH }, authorization: `Bearer ${BOT_TOKEN}` },
    ]);
    expect(w.memory.row(INSTALL_ID, SUPPORT_CH)).toMatchObject({ agentId: SUPPORT.id, connectedByUserId: ADA.id });
  });

  it("takes Slack's already_in_channel as a success (its info answer left is_member out)", async () => {
    const w = world();
    w.slack.joined.add(SUPPORT_CH);
    expect(await w.connect(SUPPORT.id, SUPPORT_CH, ADA)).toMatchObject({ status: 200, body: { reconnected: false } });
    expect(w.slack.methods()).toEqual(['conversations.info', 'conversations.join']);
  });

  it('does not join a channel Slack says the bot is in', async () => {
    const w = world();
    w.slack.channels.set(SUPPORT_CH, rawChannel(SUPPORT_CH, { is_member: true }));
    expect(await w.connect(SUPPORT.id, SUPPORT_CH, ADA)).toMatchObject({ status: 200 });
    expect(w.slack.methods()).toEqual(['conversations.info']);
  });

  it.each([
    ['a private channel', PRIVATE_CH, 'not-public'],
    ['an archived channel', ARCHIVED_CH, 'archived'],
    ['a Slack Connect channel', SHARED_CH, 'shared'],
    ['a channel being shared with another workspace', PENDING_CH, 'shared'],
    ['a channel Slack does not show the bot', 'C07UNKNOWN1', 'not-public'],
  ])('refuses %s with 422, and the bot never joins it', async (_what, channelId, reason) => {
    const w = world();
    expect(await w.connect(SUPPORT.id, channelId, ADA)).toEqual({
      status: 422,
      body: { error: 'channel-not-allowed', reason },
    });
    expect(w.slack.methods()).toEqual(['conversations.info']);
    expect(w.memory.rows.size).toBe(0);
  });

  it.each(['conversations.info', 'conversations.join'])(
    'answers an install made before channels (missing_scope from %s) with 409 needs-reconnect',
    async (method) => {
      const w = world();
      w.slack.overrides.set(method, () => w.slack.refuse('missing_scope'));
      expect(await w.connect(SUPPORT.id, SUPPORT_CH, ADA)).toEqual({ status: 409, body: { error: 'needs-reconnect' } });
      expect(w.memory.rows.size).toBe(0);
    },
  );

  it("refuses another agent's channel with 409 channel-taken and leaves its binding alone", async () => {
    const w = world();
    expect(await w.connect(SALES.id, SUPPORT_CH, SAM)).toMatchObject({ status: 200 });
    const before = w.memory.row(INSTALL_ID, SUPPORT_CH);
    expect(await w.connect(SUPPORT.id, SUPPORT_CH, ADA)).toEqual({ status: 409, body: { error: 'channel-taken' } });
    expect(w.memory.row(INSTALL_ID, SUPPORT_CH)).toEqual(before);
  });

  it('lets a second team admin reconnect a channel: they become its connector, its memory switch stays', async () => {
    const w = world();
    await w.connect(SUPPORT.id, SUPPORT_CH, ADA);
    await w.remember(SUPPORT.id, SUPPORT_CH, false, ADA);
    expect(await w.connect(SUPPORT.id, SUPPORT_CH, GRACE)).toEqual({
      status: 200,
      body: {
        channel: { channelId: SUPPORT_CH, name: 'support-desk', remember: false, connectedBy: 'Grace Hopper', needsReconnect: false },
        reconnected: true,
      },
    });
    expect(await w.status(SUPPORT.id, MEL)).toMatchObject({
      body: { channels: [{ channelId: SUPPORT_CH, connectedBy: 'Grace Hopper', remember: false }] },
    });
  });

  it('answers 409 no-workspace when Slack is not connected, asking Slack nothing', async () => {
    const w = world();
    w.state.install = null;
    expect(await w.connect(SUPPORT.id, SUPPORT_CH, ADA)).toEqual({ status: 409, body: { error: 'no-workspace' } });
    expect(w.slack.sent).toEqual([]);
  });

  it('answers 502 slack-error when Slack fails, and binds nothing', async () => {
    const w = world();
    w.slack.overrides.set('conversations.join', () => new Response('', { status: 503 }));
    expect(await w.connect(SUPPORT.id, SUPPORT_CH, ADA)).toEqual({ status: 502, body: { error: 'slack-error' } });
    expect(w.memory.rows.size).toBe(0);
  });

  it.each([
    ['not JSON', 'channel please'],
    ['an array', [SUPPORT_CH]],
    ['null', null],
    ['no channelId', {}],
    ['a number for channelId', { channelId: 7 }],
    ['an empty channelId', { channelId: '' }],
    ['a channelId with a space', { channelId: 'C07 SUPPORT' }],
    ['a channel reference, not an id', { channelId: `<#${SUPPORT_CH}>` }],
    ['a channelId past 64 characters', { channelId: `C${'7'.repeat(64)}` }],
    ['an unknown key, even one naming another agent', { channelId: SUPPORT_CH, agentId: SALES.id }],
  ])('refuses a connect body that is %s with 400, asking Slack nothing', async (_what, body) => {
    const w = world();
    const a = await w.call('POST', '/connect', SUPPORT.id, ADA, typeof body === 'string' ? body : JSON.stringify(body));
    expect({ status: a.status, body: a.body }).toEqual({ status: 400, body: { error: 'invalid-body' } });
    expect(w.slack.sent).toEqual([]);
    expect(w.memory.calls).toEqual([]);
  });

  it('refuses a body past the cap with 413 (the route cap is the first line; this is the backstop)', async () => {
    const w = world();
    const big = Buffer.from(JSON.stringify({ channelId: SUPPORT_CH, pad: 'x'.repeat(ADMIN_BODY_MAX_BYTES) }));
    for (const suffix of ['/connect', '/disconnect', '/remember'] as const) {
      const a = await w.call('POST', suffix, SUPPORT.id, ADA, big);
      expect({ status: a.status, body: a.body }, suffix).toEqual({ status: 413, body: { error: 'body-too-large' } });
    }
    expect(w.slack.sent).toEqual([]);
  });
});

// ── GET …/available ─────────────────────────────────────────────────────────

describe('available', () => {
  it('lists five pages at most, then says truncated; drops Slack Connect, archived and private; marks bound ones', async () => {
    const w = world();
    await w.connect(SUPPORT.id, SUPPORT_CH, ADA);
    await w.connect(SALES.id, SALES_CH, SAM);
    for (let i = 10; i < 20; i += 1) w.slack.channels.set(`C07CHAN00${i}`, rawChannel(`C07CHAN00${i}`));
    // 16 channels, 3 a page: the sixth page is never read.
    w.slack.setPageSize(3);
    w.slack.sent.length = 0;

    const listed = await w.available(SUPPORT.id, ADA);
    expect(listed).toEqual({
      status: 200,
      body: {
        truncated: true,
        channels: [
          { channelId: 'C07CHAN0010', name: 'c07chan0010', connected: null },
          { channelId: 'C07CHAN0011', name: 'c07chan0011', connected: null },
          { channelId: 'C07CHAN0012', name: 'c07chan0012', connected: null },
          { channelId: 'C07CHAN0013', name: 'c07chan0013', connected: null },
          { channelId: 'C07CHAN0014', name: 'c07chan0014', connected: null },
          { channelId: 'C07CHAN0015', name: 'c07chan0015', connected: null },
          { channelId: 'C07CHAN0016', name: 'c07chan0016', connected: null },
          { channelId: 'C07CHAN0017', name: 'c07chan0017', connected: null },
          { channelId: 'C07CHAN0018', name: 'c07chan0018', connected: null },
          { channelId: SALES_CH, name: 'sales-floor', connected: 'other-agent' },
          { channelId: SUPPORT_CH, name: 'support-desk', connected: 'this-agent' },
        ],
      },
    });
    expect(w.slack.sent.map((s) => s.form)).toEqual([
      { types: 'public_channel', exclude_archived: 'true', limit: '200' },
      { types: 'public_channel', exclude_archived: 'true', limit: '200', cursor: 'p3' },
      { types: 'public_channel', exclude_archived: 'true', limit: '200', cursor: 'p6' },
      { types: 'public_channel', exclude_archived: 'true', limit: '200', cursor: 'p9' },
      { types: 'public_channel', exclude_archived: 'true', limit: '200', cursor: 'p12' },
    ]);
  });

  it('answers 409 needs-reconnect (missing_scope), 409 no-workspace, and 502 slack-error', async () => {
    const old = world();
    old.slack.overrides.set('conversations.list', () => old.slack.refuse('missing_scope'));
    expect(await old.available(SUPPORT.id, ADA)).toEqual({ status: 409, body: { error: 'needs-reconnect' } });

    const none = world();
    none.state.install = null;
    expect(await none.available(SUPPORT.id, ADA)).toEqual({ status: 409, body: { error: 'no-workspace' } });

    const down = world();
    down.slack.overrides.set('conversations.list', () => new Response('', { status: 500 }));
    expect(await down.available(SUPPORT.id, ADA)).toEqual({ status: 502, body: { error: 'slack-error' } });
  });
});

// ── POST …/disconnect and …/remember ────────────────────────────────────────

describe('disconnect and remember', () => {
  it("disconnect removes this agent's channel, and never another agent's", async () => {
    const w = world();
    await w.connect(SUPPORT.id, SUPPORT_CH, ADA);
    await w.connect(SALES.id, SALES_CH, SAM);
    const theirs = w.memory.row(INSTALL_ID, SALES_CH);

    // Ada manages the support agent; the sales channel is not its to remove.
    expect(await w.disconnect(SUPPORT.id, SALES_CH, ADA)).toEqual({ status: 200, body: { removed: false } });
    expect(w.memory.row(INSTALL_ID, SALES_CH)).toEqual(theirs);

    expect(await w.disconnect(SUPPORT.id, SUPPORT_CH, ADA)).toEqual({ status: 200, body: { removed: true } });
    expect(w.memory.row(INSTALL_ID, SUPPORT_CH)).toBeUndefined();
    expect(await w.disconnect(SUPPORT.id, SUPPORT_CH, ADA)).toEqual({ status: 200, body: { removed: false } });
  });

  it("remember flips this agent's switch, and answers 404 not-connected for any other channel", async () => {
    const w = world();
    await w.connect(SUPPORT.id, SUPPORT_CH, ADA);
    await w.connect(SALES.id, SALES_CH, SAM);
    const theirs = w.memory.row(INSTALL_ID, SALES_CH);

    expect(await w.remember(SUPPORT.id, SUPPORT_CH, false, ADA)).toEqual({ status: 200, body: {} });
    expect(w.memory.row(INSTALL_ID, SUPPORT_CH)?.remember).toBe(false);
    expect(await w.remember(SUPPORT.id, SUPPORT_CH, true, ADA)).toEqual({ status: 200, body: {} });
    expect(w.memory.row(INSTALL_ID, SUPPORT_CH)?.remember).toBe(true);

    expect(await w.remember(SUPPORT.id, SALES_CH, false, ADA)).toEqual({ status: 404, body: { error: 'not-connected' } });
    expect(w.memory.row(INSTALL_ID, SALES_CH)).toEqual(theirs);
    expect(await w.remember(SUPPORT.id, 'C07NOWHERE1', false, ADA)).toEqual({
      status: 404,
      body: { error: 'not-connected' },
    });
  });

  it('disconnect and remember take no key but their own: an extra one, even naming another agent, is a 400 and changes nothing', async () => {
    const w = world();
    await w.connect(SUPPORT.id, SUPPORT_CH, ADA);
    await w.connect(SALES.id, SALES_CH, SAM);
    const mine = w.memory.row(INSTALL_ID, SUPPORT_CH);
    const theirs = w.memory.row(INSTALL_ID, SALES_CH);
    const writes = w.memory.calls.length;
    const cases: Array<{ suffix: '/disconnect' | '/remember'; body: Record<string, unknown> }> = [
      { suffix: '/disconnect', body: { channelId: SUPPORT_CH, agentId: 'agt_other' } },
      { suffix: '/disconnect', body: { channelId: SALES_CH, agentId: SALES.id } },
      { suffix: '/disconnect', body: { channelId: SUPPORT_CH, remember: false } },
      { suffix: '/remember', body: { channelId: SUPPORT_CH, remember: false, agentId: 'agt_other' } },
      { suffix: '/remember', body: { channelId: SALES_CH, remember: false, agentId: SALES.id } },
    ];
    for (const c of cases) {
      const a = await w.call('POST', c.suffix, SUPPORT.id, ADA, JSON.stringify(c.body));
      expect({ status: a.status, body: a.body }, `${c.suffix} ${JSON.stringify(c.body)}`).toEqual({
        status: 400,
        body: { error: 'invalid-body' },
      });
    }
    expect(w.memory.row(INSTALL_ID, SUPPORT_CH)).toEqual(mine);
    expect(w.memory.row(INSTALL_ID, SALES_CH)).toEqual(theirs);
    expect(w.memory.calls).toHaveLength(writes);
  });

  it('remember takes only a boolean', async () => {
    const w = world();
    await w.connect(SUPPORT.id, SUPPORT_CH, ADA);
    for (const remember of ['false', 0, null, undefined]) {
      expect(await w.remember(SUPPORT.id, SUPPORT_CH, remember, ADA), String(remember)).toEqual({
        status: 400,
        body: { error: 'invalid-body' },
      });
    }
    expect(w.memory.row(INSTALL_ID, SUPPORT_CH)?.remember).toBe(true);
  });

  it('with Slack not connected, there is nothing to disconnect or remember', async () => {
    const w = world();
    w.state.install = null;
    expect(await w.disconnect(SUPPORT.id, SUPPORT_CH, ADA)).toEqual({ status: 200, body: { removed: false } });
    expect(await w.remember(SUPPORT.id, SUPPORT_CH, false, ADA)).toEqual({
      status: 404,
      body: { error: 'not-connected' },
    });
  });
});

// ── Logs ────────────────────────────────────────────────────────────────────

describe('logs', () => {
  it('say what happened by code alone: never a channel id or name, an email or a person', async () => {
    const w = world({
      getUserFault: new PluginError({ code: 'db-down', plugin: '@ax/auth-better', message: 'down' }),
    });
    await w.connect(SUPPORT.id, SUPPORT_CH, ADA);
    await w.connect(SUPPORT.id, SUPPORT_CH, GRACE);
    await w.connect(SUPPORT.id, ARCHIVED_CH, ADA);
    await w.connect(SALES.id, SUPPORT_CH, SAM);
    await w.status(SUPPORT.id, MEL);
    await w.available(SUPPORT.id, ADA);
    await w.remember(SUPPORT.id, SUPPORT_CH, false, ADA);
    await w.disconnect(SUPPORT.id, SUPPORT_CH, ADA);
    w.slack.overrides.set('conversations.info', () => w.slack.refuse('missing_scope'));
    await w.connect(SUPPORT.id, SALES_CH, ADA);

    expect(w.lines.map((l) => l.msg)).toEqual(
      expect.arrayContaining([
        'slack_channel_connected',
        'slack_channel_refused',
        'slack_channel_disconnected',
        'slack_channel_route_failed',
      ]),
    );
    expect(w.lines).toContainEqual({
      level: 'info',
      msg: 'slack_channel_disconnected',
      fields: { installId: INSTALL_ID },
    });
    const logged = JSON.stringify(w.lines);
    for (const secret of [
      ...Object.keys(NAMES),
      ...Object.values(NAMES),
      ...USERS.flatMap((u) => [u.email!, ...(u.displayName === null ? [] : [u.displayName])]),
      SUPPORT.displayName,
      BOT_TOKEN,
    ]) {
      expect(logged, secret).not.toContain(secret);
    }
  });
});
