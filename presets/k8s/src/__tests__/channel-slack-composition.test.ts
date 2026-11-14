import { createHmac } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

import pg from 'pg';

import {
  HookBus,
  PluginError,
  bootstrap,
  isHold,
  makeAgentContext,
  type AgentContext,
  type Plugin,
} from '@ax/core';
import type { CreateOutput as AgentCreateOutput } from '@ax/agents';
import { startTestContainer, stopPostgresContainer } from '@ax/test-harness';

import { createK8sPlugins, type K8sPresetConfig } from '../index.js';

// ---------------------------------------------------------------------------
// TASK-1093 -- @ax/channel-slack composition canary (Invariant 3: no
// half-wired plugins).
//
// One flow through the preset's OWN plugins: the real @ax/channel-slack (its
// admin routes, OAuth callback, events route, and the TASK-1094 channel routes
// and `/ax` command), the real @ax/agents (the personal agents a Slack DM
// reaches, and the team agents a channel connects to), the real @ax/teams
// (who is a team admin), the real @ax/conversations (the
// thread's conversation, origin 'slack'), the real @ax/decisions over the
// real @ax/tool-policy (a held call becomes a pending row in somebody's
// Today), and the real credentials vault
// (@ax/credentials over @ax/credentials-store-db over @ax/storage-postgres),
// all on one Postgres. Slack is a fake behind the preset's
// `channelSlack.fetchImpl`, and the global `fetch` throws, so nothing can
// reach the network by accident.
//
// channel-slack's own tests fake every hook it calls; this one proves the
// real services agree with it: the vault takes and gives back its `slack:`
// refs under `scope: 'global'`, agents:list-for-user answers in the shape
// the router picks from, and conversations accepts origin 'slack' through
// find-or-create and reads it back.
//
// Stubbed: `http:register-route` (records the routes so the test can call a
// handler directly), `auth:require-user` (the test picks the actor),
// `auth:get-user`, `auth:find-user-by-email` (the people in AX_USERS and
// nobody else), `auth:is-approved-email` (APPROVED_DOMAINS), `agent:invoke`
// (records the turn, then streams one line and ends it on the bus, the way
// the orchestrator does) and `branding:get`.
// ---------------------------------------------------------------------------

const SLACK_PLUGIN = '@ax/channel-slack';
const KEEP = new Set<string>([
  '@ax/database-postgres',
  '@ax/storage-postgres',
  '@ax/credentials',
  '@ax/credentials-store-db',
  '@ax/agents',
  '@ax/teams',
  '@ax/conversations',
  '@ax/decisions',
  '@ax/tool-policy',
  SLACK_PLUGIN,
]);

const PUBLIC_ORIGIN = 'https://ax.test';
const ADMIN = 'usr_admin';
const APP_ID = 'A07COMPOSE1';
const CLIENT_ID = '7000000001.7000000002';
const TEAM_ID = 'T07COMPOSE1';
const BOT_USER_ID = 'U07AXBOT001';
const SIGNING_SECRET = 'composition-signing-secret-not-real';
const CLIENT_SECRET = 'composition-client-secret-not-real';
const OAUTH_CODE = '7000000001.7000000003.abcdef';

// Slack-shaped fixture tokens, built from pieces so no token-shaped literal
// sits in source (GitHub push protection flags even fake ones). Same
// construction as packages/channel-slack/src/__tests__/fake-slack-tokens.ts,
// which a preset test can't import.
const join = (...parts: string[]): string => parts.join('');
const BOT_TOKEN = join('xo', 'xb-', '1111-2222-', 'COMPOSITIONBOT');
const CONFIG_ACCESS_TOKEN = join('xo', 'xe.', 'xo', 'xp-', '1-', 'COMPOSITIONACCESS');
const CONFIG_REFRESH_TOKEN = join('xo', 'xe-', '1-', 'COMPOSITIONREFRESH');
const ROTATED_ACCESS_TOKEN = join('xo', 'xe.', 'xo', 'xp-', '1-', 'COMPOSITIONROTATED');

interface SlackPerson {
  slackId: string;
  name: string;
  email: string;
}

const ALICE: SlackPerson = { slackId: 'U07ALICE001', name: 'Alice', email: 'alice@canopyworks.com' };
const BOB: SlackPerson = { slackId: 'U07BOB00001', name: 'Bob', email: 'bob@canopyworks.com' };
/** A confirmed full member of the workspace with no AX account. */
const CAROL: SlackPerson = { slackId: 'U07CAROL001', name: 'Carol', email: 'carol@canopyworks.com' };
/** A team admin of the support team, and a plain member of it. Both have AX accounts. */
const ADA: SlackPerson = { slackId: 'U07ADA00001', name: 'Ada', email: 'ada@canopyworks.com' };
const MEL: SlackPerson = { slackId: 'U07MEL00001', name: 'Mel', email: 'mel@canopyworks.com' };
/** A full member with no AX account and an address off every approved domain. */
const EVE: SlackPerson = { slackId: 'U07EVE00001', name: 'Eve', email: 'eve@evil.example' };
const PEOPLE = [ALICE, BOB, CAROL, ADA, MEL, EVE];
const SUPPORT_CHANNEL = 'C07SUPPORT1';

/** The install's approved sign-in domains, as auth:is-approved-email answers for them. */
const APPROVED_DOMAINS = new Set(['canopyworks.com']);

/** auth's answer: Alice and Bob have AX accounts, Carol doesn't. */
const AX_USERS: Record<string, string> = {
  [ALICE.email]: 'usr_alice',
  [BOB.email]: 'usr_bob',
  [ADA.email]: 'usr_ada',
  [MEL.email]: 'usr_mel',
};

// ── Captured routes, the actor, and the turns agent:invoke saw ──────────────

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
}

const routes: CapturedRoute[] = [];
let actor: { id: string; isAdmin: boolean } | null = null;
const invokes: Array<{ ctx: AgentContext; input: unknown }> = [];
/** When set, a turn runs this in place of the stub's one line of text; it ends the turn itself. */
let invokeScript: ((ctx: AgentContext) => Promise<void>) | null = null;
let theBus: HookBus | null = null;

function createStubsPlugin(): Plugin {
  const name = '@ax/preset-k8s/test/channel-slack-stubs';
  return {
    manifest: {
      name,
      version: '0.0.0',
      registers: [
        'http:register-route',
        'auth:require-user',
        'auth:get-user',
        'auth:find-user-by-email',
        'auth:is-approved-email',
        'agent:invoke',
        'branding:get',
      ],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService<CapturedRoute, { unregister(): void }>(
        'http:register-route',
        name,
        async (_ctx, route) => {
          routes.push(route);
          return { unregister() {} };
        },
      );
      bus.registerService('auth:require-user', name, async () => {
        if (actor === null) {
          throw new PluginError({ code: 'unauthenticated', plugin: name, message: 'no session' });
        }
        return { user: actor };
      });
      bus.registerService<{ userId: string }, unknown>('auth:get-user', name, async (_ctx, { userId }) => ({
        id: userId,
        displayName: userId === ADMIN ? 'Ada Admin' : userId,
        email: `${userId}@canopyworks.com`,
        isAdmin: userId === ADMIN,
      }));
      bus.registerService<{ email: string }, { userId: string } | null>(
        'auth:find-user-by-email',
        name,
        async (_ctx, { email }) => (AX_USERS[email] !== undefined ? { userId: AX_USERS[email] } : null),
      );
      // On an approved domain: the part after the last @, any ASCII case.
      bus.registerService<{ email: string }, { approved: boolean }>(
        'auth:is-approved-email',
        name,
        async (_ctx, { email }) => ({ approved: APPROVED_DOMAINS.has(email.slice(email.lastIndexOf('@') + 1).toLowerCase()) }),
      );
      // The orchestrator's: a turn streams on the bus for its own reqId and
      // ends with chat:turn-end carrying the turn's conversation. No deadline,
      // like the real one (AGENT_INVOKE_TIMEOUT_MS), so a slow turn isn't cut.
      bus.registerService<unknown, unknown>(
        'agent:invoke',
        name,
        async (ctx, input) => {
          invokes.push({ ctx, input });
          if (invokeScript !== null) {
            await invokeScript(ctx);
            return { kind: 'complete', messages: [] };
          }
          await bus.fire('chat:stream-chunk', ctx, {
            reqId: ctx.reqId,
            kind: 'text',
            text: `Hello from ${ctx.agentId}.`,
          });
          await bus.fire('chat:turn-end', ctx, { reqId: ctx.reqId, reason: 'user-message-wait' });
          return { kind: 'complete', messages: [] };
        },
        { timeoutMs: Number.POSITIVE_INFINITY },
      );
      bus.registerService('branding:get', name, async () => ({ name: 'Canopy' }));
    },
  };
}

// ── Slack, behind channel-slack's own client ────────────────────────────────

interface SlackCall {
  method: string;
  auth: string | null;
  body: Record<string, unknown>;
}

const slackCalls: SlackCall[] = [];
let streamSeq = 0;

function slackUser(p: SlackPerson): Record<string, unknown> {
  return {
    id: p.slackId,
    team_id: TEAM_ID,
    is_email_confirmed: true,
    profile: { email: p.email, display_name: p.name, real_name: p.name },
  };
}

const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const method = url.replace('https://slack.com/api/', '');
  const headers = new Headers(init?.headers);
  const raw = typeof init?.body === 'string' ? init.body : '';
  const body: Record<string, unknown> = (headers.get('content-type') ?? '').startsWith('application/json')
    ? (JSON.parse(raw) as Record<string, unknown>)
    : Object.fromEntries(new URLSearchParams(raw));
  slackCalls.push({ method, auth: headers.get('authorization'), body });

  let answer: Record<string, unknown>;
  switch (method) {
    case 'apps.manifest.create':
      answer = {
        ok: true,
        app_id: APP_ID,
        credentials: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, signing_secret: SIGNING_SECRET },
      };
      break;
    case 'oauth.v2.access':
      answer = {
        ok: true,
        token_type: 'bot',
        access_token: BOT_TOKEN,
        bot_user_id: BOT_USER_ID,
        app_id: APP_ID,
        team: { id: TEAM_ID, name: 'Canopy Works' },
        is_enterprise_install: false,
      };
      break;
    case 'users.info': {
      const person = PEOPLE.find((p) => p.slackId === body['user']);
      answer = person !== undefined ? { ok: true, user: slackUser(person) } : { ok: false, error: 'user_not_found' };
      break;
    }
    case 'conversations.info':
    case 'conversations.join':
      answer =
        body['channel'] === SUPPORT_CHANNEL
          ? {
              ok: true,
              channel: {
                id: SUPPORT_CHANNEL,
                name: 'support-desk',
                is_channel: true,
                is_private: false,
                is_archived: false,
                is_ext_shared: false,
                is_pending_ext_shared: false,
              },
            }
          : { ok: false, error: 'channel_not_found' };
      break;
    case 'conversations.list':
      answer = {
        ok: true,
        channels: [
          {
            id: SUPPORT_CHANNEL,
            name: 'support-desk',
            is_channel: true,
            is_private: false,
            is_archived: false,
            is_ext_shared: false,
            is_pending_ext_shared: false,
          },
        ],
        response_metadata: { next_cursor: '' },
      };
      break;
    case 'tooling.tokens.rotate':
      answer = { ok: true, token: ROTATED_ACCESS_TOKEN, exp: 4_102_444_800 };
      break;
    case 'chat.startStream':
      streamSeq += 1;
      answer = { ok: true, ts: `1763040000.${String(streamSeq).padStart(6, '0')}` };
      break;
    case 'apps.icon.set':
    case 'apps.manifest.delete':
    case 'chat.appendStream':
    case 'chat.stopStream':
    case 'chat.postMessage':
    case 'chat.postEphemeral':
    case 'reactions.add':
    case 'reactions.remove':
      answer = { ok: true };
      break;
    default:
      answer = { ok: false, error: 'unknown_method' };
  }
  return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

// ── Calling a captured route ────────────────────────────────────────────────

interface Captured {
  status: number;
  body: unknown;
  location?: string;
}

interface RouteArgs {
  query?: Record<string, string>;
  params?: Record<string, string>;
  rawPath?: string;
  headers?: Record<string, string>;
  body?: Buffer;
}

async function callRoute(method: string, path: string, args: RouteArgs = {}): Promise<Captured> {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (route === undefined) throw new Error(`route ${method} ${path} was not registered`);
  const captured: Captured = { status: 200, body: undefined };
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
    redirect(url: string, status?: number) {
      captured.status = status ?? 302;
      captured.location = url;
    },
  };
  await route.handler(
    {
      method,
      path: args.rawPath ?? path,
      rawPath: args.rawPath ?? path,
      params: args.params ?? {},
      query: args.query ?? {},
      headers: args.headers ?? {},
      body: args.body ?? Buffer.alloc(0),
    },
    res,
  );
  return captured;
}

const jsonBody = (v: unknown): Buffer => Buffer.from(JSON.stringify(v));

// ── Signed Slack deliveries ─────────────────────────────────────────────────

let eventSeq = 0;
let tsSeq = 0;

function nextTs(): string {
  tsSeq += 1;
  return `1763035200.${String(tsSeq).padStart(6, '0')}`;
}

function signedHeaders(body: Buffer): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000));
  const digest = createHmac('sha256', SIGNING_SECRET).update(`v0:${ts}:`).update(body).digest('hex');
  return {
    'content-type': 'application/json',
    'x-slack-request-timestamp': ts,
    'x-slack-signature': `v0=${digest}`,
  };
}

async function deliver(installId: string, event: Record<string, unknown>): Promise<Captured> {
  eventSeq += 1;
  const body = jsonBody({
    type: 'event_callback',
    team_id: TEAM_ID,
    api_app_id: APP_ID,
    event_id: `Ev07COMPOSE${String(eventSeq).padStart(4, '0')}`,
    event,
  });
  return callRoute('POST', '/slack/events/:installId', {
    params: { installId },
    rawPath: `/slack/events/${installId}`,
    headers: signedHeaders(body),
    body,
  });
}

/** A signed `/ax` slash command, as Slack posts it: a form, signed over its raw bytes. */
async function slash(installId: string, from: SlackPerson, channel: string, text: string): Promise<Captured> {
  const body = Buffer.from(
    new URLSearchParams({
      command: '/ax',
      text,
      team_id: TEAM_ID,
      api_app_id: APP_ID,
      user_id: from.slackId,
      channel_id: channel,
    }).toString(),
  );
  return callRoute('POST', '/slack/commands/:installId', {
    params: { installId },
    rawPath: `/slack/commands/${installId}`,
    headers: { ...signedHeaders(body), 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
}

function dm(from: SlackPerson, channel: string, ts: string, text: string): Record<string, unknown> {
  return { type: 'message', channel_type: 'im', user: from.slackId, channel, ts, text };
}

/** The Slack calls made after `from`, once one of them is `method`. */
async function slackCallsUntil(from: number, ...methods: string[]): Promise<SlackCall[]> {
  await vi.waitFor(
    () => expect(slackCalls.slice(from).map((c) => c.method)).toEqual(expect.arrayContaining(methods)),
    { timeout: 10_000 },
  );
  return slackCalls.slice(from);
}

/**
 * A DM turn's calls: its reply, and 👀 on and off the owner's message. 👀 runs
 * on a queue of its own, so it is waited for too (else its removal lands in
 * the next step's calls), and only its order against the reply's start is fixed.
 */
async function dmTurnCalls(from: number): Promise<SlackCall[]> {
  const calls = await slackCallsUntil(from, 'chat.stopStream', 'reactions.remove');
  const methods = calls.map((c) => c.method);
  expect(methods.filter((m) => !m.startsWith('reactions.'))).toEqual(['users.info', 'chat.startStream', 'chat.stopStream']);
  expect(methods.filter((m) => m.startsWith('reactions.'))).toEqual(['reactions.add', 'reactions.remove']);
  expect(methods.indexOf('reactions.remove')).toBeGreaterThan(methods.indexOf('chat.startStream'));
  return calls;
}

const callOf = (calls: SlackCall[], method: string): SlackCall => calls.find((c) => c.method === method)!;

// ── The test ────────────────────────────────────────────────────────────────

describe('@ax/preset-k8s channel-slack composition (TASK-1093)', () => {
  let pgContainer: StartedPostgreSqlContainer | null = null;
  let shutdown: (() => Promise<void>) | null = null;
  let savedCredentialsKey: string | undefined;

  async function query(text: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
    const client = new pg.Client({ connectionString: pgContainer!.getConnectionUri() });
    await client.connect();
    try {
      return (await client.query(text, params)).rows;
    } finally {
      await client.end().catch(() => {});
    }
  }

  function presetConfig(connectionString: string): K8sPresetConfig {
    return {
      database: { connectionString },
      eventbus: { connectionString: 'postgres://stub:5432/stub' },
      session: { connectionString: 'postgres://stub:5432/stub' },
      blob: { backend: 'fs', root: '/tmp/ax-channel-slack-composition-unused' },
      sandbox: { namespace: 'ax-next', image: 'ax-next/agent:stub' },
      ipc: { hostIpcUrl: 'http://ax-next-host.ax-next.svc.cluster.local:80' },
      chat: { runnerBinaries: {}, chatTimeoutMs: 60_000 },
      http: { host: '127.0.0.1', port: 0, cookieKey: '0'.repeat(64), allowedOrigins: [] },
      // Only an https public origin can connect a workspace.
      auth: { baseURL: PUBLIC_ORIGIN },
      channelSlack: { fetchImpl },
    };
  }

  async function personalAgent(userId: string): Promise<string> {
    const out = await theBus!.call<unknown, AgentCreateOutput>(
      'agents:create',
      makeAgentContext({ sessionId: 'test', agentId: '', userId }),
      {
        actor: { userId, isAdmin: false },
        input: {
          displayName: `${userId} agent`,
          allowedTools: [],
          mcpConfigIds: [],
          model: 'anthropic/claude-opus-4-7',
          visibility: 'personal',
        },
      },
    );
    return out.agent.id;
  }

  /** A team whose creator `adminId` is its admin, with `memberId` a plain member, and one team agent. */
  async function teamWithAgent(adminId: string, memberId: string): Promise<{ teamId: string; agentId: string }> {
    const ctxFor = (userId: string) => makeAgentContext({ sessionId: 'test', agentId: '', userId });
    const { team } = await theBus!.call<unknown, { team: { id: string } }>('teams:create', ctxFor(adminId), {
      actor: { userId: adminId },
      displayName: 'Support',
    });
    await theBus!.call('teams:add-member', ctxFor(adminId), {
      actor: { userId: adminId },
      teamId: team.id,
      userId: memberId,
      role: 'member',
    });
    const out = await theBus!.call<unknown, AgentCreateOutput>('agents:create', ctxFor(adminId), {
      actor: { userId: adminId, isAdmin: false },
      input: {
        displayName: 'Support',
        allowedTools: [],
        mcpConfigIds: [],
        model: 'anthropic/claude-opus-4-7',
        visibility: 'team',
        teamId: team.id,
      },
    });
    return { teamId: team.id, agentId: out.agent.id };
  }

  /** Connect the workspace as an admin: Slack makes the app, then Allow comes back to the callback. */
  async function connectWorkspace(): Promise<string> {
    // One workspace per deployment: a test that finds it connected uses it.
    const existing = await query("SELECT install_id FROM channel_slack_v1_installs WHERE status = 'active'");
    if (existing.length > 0) return existing[0]!['install_id'] as string;
    actor = { id: ADMIN, isAdmin: true };
    const connect = await callRoute('POST', '/admin/slack/connect', {
      body: jsonBody({ accessToken: CONFIG_ACCESS_TOKEN, refreshToken: CONFIG_REFRESH_TOKEN }),
    });
    expect(connect.status).toBe(200);
    const state = new URL((connect.body as { installUrl: string }).installUrl).searchParams.get('state')!;
    const callback = await callRoute('GET', '/admin/slack/oauth/callback', { query: { code: OAUTH_CODE, state } });
    expect(callback.status).toBe(302);
    actor = null;
    const installs = await query("SELECT install_id FROM channel_slack_v1_installs WHERE status = 'active'");
    expect(installs).toHaveLength(1);
    return installs[0]!['install_id'] as string;
  }

  async function bindings(): Promise<Array<{ channelId: string; agentId: string; by: string }>> {
    const rows = await query(
      'SELECT channel_id, agent_id, connected_by_user_id FROM channel_slack_v1_channels ORDER BY channel_id',
    );
    return rows.map((r) => ({
      channelId: r['channel_id'] as string,
      agentId: r['agent_id'] as string,
      by: r['connected_by_user_id'] as string,
    }));
  }

  async function readSecret(installId: string, name: string): Promise<string> {
    try {
      return await theBus!.call<unknown, string>(
        'credentials:get',
        makeAgentContext({ sessionId: 'test', agentId: '', userId: ADMIN }),
        { ref: `slack:${installId}:${name}`, userId: ADMIN, scope: 'global' },
      );
    } catch (err) {
      return `error:${(err as { code?: string }).code ?? 'unknown'}`;
    }
  }

  beforeAll(async () => {
    savedCredentialsKey = process.env.AX_CREDENTIALS_KEY;
    process.env.AX_CREDENTIALS_KEY = '42'.repeat(32);
    vi.stubGlobal('fetch', () => {
      throw new Error('network is off in tests');
    });
    pgContainer = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
    const presetPlugins = createK8sPlugins(presetConfig(pgContainer.getConnectionUri()));
    const kept = presetPlugins.filter((p) => KEEP.has(p.manifest.name));
    expect(kept.map((p) => p.manifest.name).sort()).toEqual([...KEEP].sort());

    const bus = new HookBus();
    theBus = bus;
    const handle = await bootstrap({
      bus,
      plugins: [...kept, createStubsPlugin()],
      config: {},
    });
    shutdown = () => handle.shutdown();
  }, 180_000);

  afterAll(async () => {
    if (shutdown !== null) await shutdown();
    vi.unstubAllGlobals();
    if (savedCredentialsKey === undefined) delete process.env.AX_CREDENTIALS_KEY;
    else process.env.AX_CREDENTIALS_KEY = savedCredentialsKey;
    await stopPostgresContainer(pgContainer);
  }, 60_000);

  it('connect, then DMs reach each sender\'s own agent, then disconnect clears the vault', async () => {
    // 1. Two people, each with a personal agent. Alice's second, newer agent
    //    is never picked: a DM goes to the oldest.
    const aliceAgent = await personalAgent('usr_alice');
    const bobAgent = await personalAgent('usr_bob');
    // A later millisecond, so "oldest" is decided by the date, not the id.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const aliceNewer = await personalAgent('usr_alice');
    // The router picks by `createdAt`, and reads anything that isn't a Date
    // as undated (then the random id decides). Pin the real answer's shape.
    const listed = await theBus!.call<unknown, { agents: Array<{ id: string; createdAt: unknown }> }>(
      'agents:list-for-user',
      makeAgentContext({ sessionId: 'test', agentId: '', userId: 'usr_alice' }),
      { userId: 'usr_alice', teamIds: [] },
    );
    expect(listed.agents.map((a) => a.id).sort()).toEqual([aliceAgent, aliceNewer].sort());
    for (const a of listed.agents) expect(a.createdAt).toBeInstanceOf(Date);

    // 2. An admin connects: Slack makes the app, then Allow brings the browser
    //    back to the callback with the state Connect minted.
    actor = { id: ADMIN, isAdmin: true };
    const before = await callRoute('GET', '/admin/slack');
    expect(before).toMatchObject({ status: 200, body: { state: 'not-connected', canConnect: true } });

    const connect = await callRoute('POST', '/admin/slack/connect', {
      body: jsonBody({ accessToken: CONFIG_ACCESS_TOKEN, refreshToken: CONFIG_REFRESH_TOKEN }),
    });
    expect(connect.status).toBe(200);
    const installUrl = new URL((connect.body as { installUrl: string }).installUrl);
    expect(installUrl.origin + installUrl.pathname).toBe('https://slack.com/oauth/v2/authorize');
    const state = installUrl.searchParams.get('state')!;
    const redirect = new URL(installUrl.searchParams.get('redirect_uri')!);
    expect(redirect.origin).toBe(PUBLIC_ORIGIN);

    const installs = await query('SELECT install_id, status FROM channel_slack_v1_installs');
    expect(installs).toHaveLength(1);
    const installId = installs[0]!['install_id'] as string;
    expect(installs[0]!['status']).toBe('pending');
    // The app's events URL is this install's route on the public origin.
    const created = slackCalls.find((c) => c.method === 'apps.manifest.create')!;
    const manifest = JSON.parse(String(created.body['manifest'])) as {
      settings: { event_subscriptions: { request_url: string } };
    };
    expect(manifest.settings.event_subscriptions.request_url).toBe(`${PUBLIC_ORIGIN}/slack/events/${installId}`);

    const callback = await callRoute('GET', '/admin/slack/oauth/callback', {
      query: { code: OAUTH_CODE, state },
    });
    expect(callback).toMatchObject({ status: 302, location: `${PUBLIC_ORIGIN}/?slack=connected` });

    const after = await callRoute('GET', '/admin/slack');
    expect(after).toMatchObject({
      status: 200,
      body: { state: 'connected', workspaceName: 'Canopy Works', connectedBy: 'Ada Admin' },
    });
    // The four secrets went into the real vault, globally.
    expect(await readSecret(installId, 'bot-token')).toBe(BOT_TOKEN);
    expect(await readSecret(installId, 'signing-secret')).toBe(SIGNING_SECRET);
    actor = null;

    // 3. Alice DMs the bot. The reply streams into her thread, from her own
    //    oldest personal agent, in a conversation whose origin is 'slack'.
    const aliceTs = nextTs();
    let mark = slackCalls.length;
    expect((await deliver(installId, dm(ALICE, 'D07ALICEDM1', aliceTs, 'What is on today?'))).status).toBe(200);
    let calls = await dmTurnCalls(mark);
    for (const c of calls) expect(c.auth).toBe(`Bearer ${BOT_TOKEN}`);
    // 👀 on Alice's own message while her agent works.
    expect(callOf(calls, 'reactions.add').body).toEqual({ channel: 'D07ALICEDM1', timestamp: aliceTs, name: 'eyes' });
    expect(callOf(calls, 'chat.startStream').body).toEqual({
      channel: 'D07ALICEDM1',
      thread_ts: aliceTs,
      recipient_user_id: ALICE.slackId,
      recipient_team_id: TEAM_ID,
      chunks: [{ type: 'markdown_text', text: `Hello from ${aliceAgent}.` }],
    });

    expect(invokes).toHaveLength(1);
    const aliceTurn = invokes[0]!;
    expect(aliceTurn.ctx).toMatchObject({
      userId: 'usr_alice',
      agentId: aliceAgent,
      source: 'user',
      audience: 'private',
    });
    expect(aliceTurn.input).toEqual({
      message: {
        role: 'user',
        content: `[Slack · DM · Alice (${ALICE.slackId})]: What is on today?`,
      },
    });
    const aliceConversation = aliceTurn.ctx.conversationId!;
    const metadata = await theBus!.call<unknown, { origin: string; agentId: string; userId: string }>(
      'conversations:get-metadata',
      makeAgentContext({ sessionId: 'test', agentId: '', userId: 'usr_alice' }),
      { conversationId: aliceConversation, userId: 'usr_alice' },
    );
    expect(metadata).toMatchObject({ origin: 'slack', agentId: aliceAgent, userId: 'usr_alice' });

    // A second DM in the same thread lands in the same conversation.
    mark = slackCalls.length;
    expect(
      (await deliver(installId, { ...dm(ALICE, 'D07ALICEDM1', nextTs(), 'And tomorrow?'), thread_ts: aliceTs }))
        .status,
    ).toBe(200);
    await dmTurnCalls(mark);
    expect(invokes).toHaveLength(2);
    expect(invokes[1]!.ctx.conversationId).toBe(aliceConversation);

    // 4. Bob's DM reaches Bob's agent and a conversation of his own.
    const bobTs = nextTs();
    mark = slackCalls.length;
    expect((await deliver(installId, dm(BOB, 'D07BOBDM001', bobTs, 'Hi'))).status).toBe(200);
    calls = await dmTurnCalls(mark);
    expect(callOf(calls, 'chat.startStream').body).toMatchObject({
      channel: 'D07BOBDM001',
      thread_ts: bobTs,
      recipient_user_id: BOB.slackId,
      chunks: [{ type: 'markdown_text', text: `Hello from ${bobAgent}.` }],
    });
    expect(invokes).toHaveLength(3);
    const bobTurn = invokes[2]!;
    expect(bobTurn.ctx).toMatchObject({ userId: 'usr_bob', agentId: bobAgent });
    expect(bobTurn.ctx.conversationId).not.toBe(aliceConversation);
    await expect(
      theBus!.call(
        'conversations:get-metadata',
        makeAgentContext({ sessionId: 'test', agentId: '', userId: 'usr_bob' }),
        { conversationId: aliceConversation, userId: 'usr_bob' },
      ),
    ).rejects.toMatchObject({ code: 'not-found' });

    // 5. Carol is a confirmed member with no AX account: the not-mapped reply
    //    in her thread, and no turn.
    const carolTs = nextTs();
    mark = slackCalls.length;
    expect((await deliver(installId, dm(CAROL, 'D07CAROLDM1', carolTs, 'Hello?'))).status).toBe(200);
    calls = await slackCallsUntil(mark, 'chat.postMessage');
    expect(calls.map((c) => c.method)).toEqual(['users.info', 'chat.postMessage']);
    expect(calls[1]!.body).toMatchObject({
      channel: 'D07CAROLDM1',
      thread_ts: carolTs,
      unfurl_links: false,
      unfurl_media: false,
    });
    expect(String(calls[1]!.body['markdown_text'])).toContain(`](${PUBLIC_ORIGIN})`);
    expect(invokes).toHaveLength(3);

    // A mention in a channel nothing is connected to: one private line, to
    // the member alone, and no turn.
    const mentionTs = nextTs();
    mark = slackCalls.length;
    expect(
      (
        await deliver(installId, {
          type: 'app_mention',
          user: ALICE.slackId,
          channel: 'C07CHANNEL1',
          ts: mentionTs,
          text: `<@${BOT_USER_ID}> summarize this`,
        })
      ).status,
    ).toBe(200);
    calls = await slackCallsUntil(mark, 'chat.postEphemeral');
    expect(calls.map((c) => c.method)).toEqual(['users.info', 'chat.postEphemeral']);
    expect(calls[1]!.body).toMatchObject({ channel: 'C07CHANNEL1', user: ALICE.slackId });
    expect(typeof calls[1]!.body['text']).toBe('string');
    expect(invokes).toHaveLength(3);

    // 6. Disconnect deletes the Slack app with a freshly rotated access
    //    token, then the row and all four secrets are gone.
    actor = { id: ADMIN, isAdmin: true };
    mark = slackCalls.length;
    const disconnect = await callRoute('POST', '/admin/slack/disconnect', { body: jsonBody({}) });
    expect(disconnect).toMatchObject({ status: 200, body: { appDeleted: true } });
    expect(slackCalls.slice(mark).map((c) => c.method)).toEqual(['tooling.tokens.rotate', 'apps.manifest.delete']);
    expect(slackCalls.slice(mark)[0]!.body).toEqual({ refresh_token: CONFIG_REFRESH_TOKEN });
    expect(slackCalls.slice(mark)[1]!.auth).toBe(`Bearer ${ROTATED_ACCESS_TOKEN}`);
    expect(await query('SELECT install_id FROM channel_slack_v1_installs')).toEqual([]);
    for (const name of ['bot-token', 'signing-secret', 'client-secret', 'config-refresh-token']) {
      expect(await readSecret(installId, name), name).toMatch(/^error:/);
    }
    expect(await callRoute('GET', '/admin/slack')).toMatchObject({ body: { state: 'not-connected' } });
  });

  it('a team admin connects a channel to a team agent, from settings and from /ax; members and personal agents cannot; deleting the agent frees it (TASK-1094)', async () => {
    const installId = await connectWorkspace();
    const { agentId } = await teamWithAgent('usr_ada', 'usr_mel');
    const personal = await personalAgent('usr_alice');
    const settings = (suffix: string) => ({ params: { agentId }, rawPath: `/settings/slack/${agentId}${suffix}` });
    const connectBody = { body: jsonBody({ channelId: SUPPORT_CHANNEL }) };

    // The settings routes, over the real agents and teams. A member reads the
    // section and may not write; a personal agent is refused before Slack is asked.
    actor = { id: 'usr_mel', isAdmin: false };
    let mark = slackCalls.length;
    expect(await callRoute('GET', '/settings/slack/:agentId', settings(''))).toMatchObject({
      status: 200,
      body: { state: 'ready', canManage: false, channels: [] },
    });
    expect(await callRoute('POST', '/settings/slack/:agentId/connect', { ...settings('/connect'), ...connectBody })).toMatchObject({
      status: 403,
    });
    actor = { id: 'usr_alice', isAdmin: false };
    expect(
      await callRoute('POST', '/settings/slack/:agentId/connect', {
        params: { agentId: personal },
        rawPath: `/settings/slack/${personal}/connect`,
        ...connectBody,
      }),
    ).toMatchObject({ status: 409, body: { error: 'personal-agent' } });
    expect(slackCalls.slice(mark)).toEqual([]);
    expect(await bindings()).toEqual([]);

    // The team admin connects #support: Slack is asked about it, then the bot joins, then the row.
    actor = { id: 'usr_ada', isAdmin: false };
    mark = slackCalls.length;
    const connected = await callRoute('POST', '/settings/slack/:agentId/connect', {
      ...settings('/connect'),
      ...connectBody,
    });
    expect(connected).toMatchObject({
      status: 200,
      body: { channel: { channelId: SUPPORT_CHANNEL, name: 'support-desk', connectedBy: 'usr_ada' }, reconnected: false },
    });
    expect(slackCalls.slice(mark).map((c) => c.method)).toEqual(['conversations.info', 'conversations.join']);
    expect(await bindings()).toEqual([{ channelId: SUPPORT_CHANNEL, agentId, by: 'usr_ada' }]);
    actor = null;

    // /ax: the member is told it is a team admin's to do; the admin can disconnect, and connect again by name.
    const memberTries = await slash(installId, MEL, SUPPORT_CHANNEL, 'disconnect');
    expect(memberTries.status).toBe(200);
    expect(String((memberTries.body as { text: string }).text)).toContain('Only a team admin');
    expect(await bindings()).toHaveLength(1);

    const memberConnects = await slash(installId, MEL, SUPPORT_CHANNEL, 'connect Support');
    expect(String((memberConnects.body as { text: string }).text)).toContain('Only a team admin');

    const disconnected = await slash(installId, ADA, SUPPORT_CHANNEL, 'disconnect');
    expect(String((disconnected.body as { text: string }).text)).toContain('Disconnected');
    expect(await bindings()).toEqual([]);

    const slashConnected = await slash(installId, ADA, SUPPORT_CHANNEL, 'connect Support');
    expect(slashConnected.status).toBe(200);
    expect(String((slashConnected.body as { text: string }).text)).toContain('Connected *Support* to #support-desk');
    expect(await bindings()).toEqual([{ channelId: SUPPORT_CHANNEL, agentId, by: 'usr_ada' }]);

    // Deleting the agent frees its channel (agents:deleted → channel-slack).
    await theBus!.call(
      'agents:delete',
      makeAgentContext({ sessionId: 'test', agentId: '', userId: 'usr_ada' }),
      { actor: { userId: 'usr_ada', isAdmin: false }, agentId },
    );
    await vi.waitFor(async () => expect(await bindings()).toEqual([]), { timeout: 10_000 });
  });

  // ── Channel turns (TASK-1094) ──────────────────────────────────────────────

  /** A signed `app_mention` in the support channel, the way Slack writes it: the bot's own `<@…>` first. */
  function mention(from: SlackPerson, ts: string, text: string, threadTs?: string): Record<string, unknown> {
    return {
      type: 'app_mention',
      user: from.slackId,
      channel: SUPPORT_CHANNEL,
      ts,
      text: `<@${BOT_USER_ID}> ${text}`,
      ...(threadTs !== undefined ? { thread_ts: threadTs } : {}),
    };
  }

  /** The workspace connected, a support team (Ada its admin, Mel a member) with a team agent, and #support-desk connected to it by Ada. */
  async function supportChannel(): Promise<{ installId: string; teamId: string; agentId: string }> {
    const installId = await connectWorkspace();
    const { teamId, agentId } = await teamWithAgent('usr_ada', 'usr_mel');
    actor = { id: 'usr_ada', isAdmin: false };
    const connected = await callRoute('POST', '/settings/slack/:agentId/connect', {
      params: { agentId },
      rawPath: `/settings/slack/${agentId}/connect`,
      body: jsonBody({ channelId: SUPPORT_CHANNEL }),
    });
    actor = null;
    expect(connected.status).toBe(200);
    expect(await bindings()).toEqual([{ channelId: SUPPORT_CHANNEL, agentId, by: 'usr_ada' }]);
    return { installId, teamId, agentId };
  }

  /** Delete the team agent: its channel is freed (agents:deleted), so the next test starts clean. */
  async function dropAgent(agentId: string, byAdmin = 'usr_ada'): Promise<void> {
    await theBus!.call('agents:delete', makeAgentContext({ sessionId: 'test', agentId: '', userId: byAdmin }), {
      actor: { userId: byAdmin, isAdmin: false },
      agentId,
    });
    await vi.waitFor(async () => expect(await bindings()).toEqual([]), { timeout: 10_000 });
  }

  /** A channel turn's Slack calls, once its reply is closed and 👀 is off. */
  const channelTurnCalls = (from: number): Promise<SlackCall[]> =>
    slackCallsUntil(from, 'chat.startStream', 'chat.stopStream', 'reactions.remove');

  /** Wait for `n` turns to have reached agent:invoke; the latest one. */
  async function invokedTurn(n: number): Promise<{ ctx: AgentContext; input: unknown }> {
    await vi.waitFor(() => expect(invokes).toHaveLength(n), { timeout: 10_000 });
    return invokes[n - 1]!;
  }

  /** Every word the thread was sent: the stream's chunks and any plain post. */
  function sentText(calls: SlackCall[]): string {
    const parts: string[] = [];
    for (const c of calls) {
      const chunks = c.body['chunks'];
      if (Array.isArray(chunks)) {
        for (const chunk of chunks as Array<{ text?: unknown }>) if (typeof chunk.text === 'string') parts.push(chunk.text);
      }
      if (typeof c.body['markdown_text'] === 'string') parts.push(c.body['markdown_text']);
    }
    return parts.join('');
  }

  async function conversationRow(conversationId: string): Promise<{ owner: string; key: string }> {
    const rows = await query(
      'SELECT user_id, external_key FROM conversations_v1_conversations WHERE conversation_id = $1',
      [conversationId],
    );
    expect(rows).toHaveLength(1);
    return { owner: rows[0]!['user_id'] as string, key: rows[0]!['external_key'] as string };
  }

  const listDecisions = async (userId: string): Promise<Array<Record<string, unknown>>> =>
    (
      await theBus!.call<unknown, { decisions: Array<Record<string, unknown>> }>(
        'decisions:list',
        makeAgentContext({ sessionId: 'test', agentId: '', userId }),
        { userId },
      )
    ).decisions;

  it('a mention in a connected channel runs as the sender, or as whoever connected it; the rest get nothing (tiers A-E, TASK-1094)', async () => {
    const { installId, teamId, agentId } = await supportChannel();
    invokes.length = 0;
    const keyOf = (thread: string, suffix = ''): string => `slack:${installId}:${SUPPORT_CHANNEL}:${thread}${suffix}`;

    // A: Mel is on the team. Attended, as herself, in a conversation of her own.
    const melTs = nextTs();
    let mark = slackCalls.length;
    expect((await deliver(installId, mention(MEL, melTs, 'what is the status?'))).status).toBe(200);
    const melTurn = await invokedTurn(1);
    expect(melTurn.ctx).toMatchObject({ userId: 'usr_mel', agentId, source: 'user', audience: 'shared' });
    expect(JSON.stringify(melTurn.input)).toContain(`[Slack · #support-desk · Mel (${MEL.slackId})]`);
    expect(JSON.stringify(melTurn.input)).toContain('what is the status?');
    expect(await conversationRow(melTurn.ctx.conversationId!)).toEqual({ owner: 'usr_mel', key: keyOf(melTs) });
    let calls = await channelTurnCalls(mark);
    expect(callOf(calls, 'chat.startStream').body).toMatchObject({
      channel: SUPPORT_CHANNEL,
      thread_ts: melTs,
      recipient_user_id: MEL.slackId,
    });

    // B: Bob has an AX account but isn't on the team. External, as Ada, who connected the channel.
    const bobTs = nextTs();
    mark = slackCalls.length;
    expect((await deliver(installId, mention(BOB, bobTs, 'can you help me?'))).status).toBe(200);
    const bobTurn = await invokedTurn(2);
    expect(bobTurn.ctx).toMatchObject({ userId: 'usr_ada', agentId, source: 'external', audience: 'shared' });
    expect(JSON.stringify(bobTurn.input)).toContain(`[Slack · #support-desk · Bob (${BOB.slackId})]`);
    expect(await conversationRow(bobTurn.ctx.conversationId!)).toEqual({ owner: 'usr_ada', key: keyOf(bobTs, ':external') });
    await channelTurnCalls(mark);

    // C: Carol has no AX account, on an approved domain. External too, and in Mel's own thread
    // she gets a conversation of her own, not Mel's.
    mark = slackCalls.length;
    expect((await deliver(installId, mention(CAROL, nextTs(), 'me too, please', melTs))).status).toBe(200);
    const carolTurn = await invokedTurn(3);
    expect(carolTurn.ctx).toMatchObject({ userId: 'usr_ada', agentId, source: 'external', audience: 'shared' });
    expect(carolTurn.ctx.conversationId).not.toBe(melTurn.ctx.conversationId);
    expect(await conversationRow(carolTurn.ctx.conversationId!)).toEqual({ owner: 'usr_ada', key: keyOf(melTs, ':external') });
    expect(JSON.stringify(melTurn.input)).not.toContain('me too');
    await channelTurnCalls(mark);

    // D: Eve has no AX account and her address is on no approved domain: silence, no turn.
    const eveTs = nextTs();
    const eveMark = slackCalls.length;
    expect((await deliver(installId, mention(EVE, eveTs, 'let me in'))).status).toBe(200);
    await slackCallsUntil(eveMark, 'users.info');

    // E: Ada leaves the team (Zoe becomes its second admin first: a team keeps one). Her channel
    // can no longer lend her access, so outsiders hear that privately and nothing runs.
    const ctxFor = (userId: string) => makeAgentContext({ sessionId: 'test', agentId: '', userId });
    await theBus!.call('teams:add-member', ctxFor('usr_ada'), {
      actor: { userId: 'usr_ada' },
      teamId,
      userId: 'usr_zoe',
      role: 'admin',
    });
    await theBus!.call('teams:remove-member', ctxFor('usr_zoe'), {
      actor: { userId: 'usr_zoe' },
      teamId,
      userId: 'usr_ada',
    });
    for (const outsider of [BOB, CAROL]) {
      mark = slackCalls.length;
      expect((await deliver(installId, mention(outsider, nextTs(), 'anyone there?'))).status).toBe(200);
      calls = await slackCallsUntil(mark, 'chat.postEphemeral');
      expect(callOf(calls, 'chat.postEphemeral').body).toMatchObject({ channel: SUPPORT_CHANNEL, user: outsider.slackId });
      expect(String(callOf(calls, 'chat.postEphemeral').body['text'])).toContain(
        'A team admin needs to connect me to this channel again',
      );
      expect(calls.map((c) => c.method)).not.toContain('chat.startStream');
    }
    expect(invokes).toHaveLength(3);
    // Members keep working: Mel doesn't depend on the connector.
    mark = slackCalls.length;
    expect((await deliver(installId, mention(MEL, nextTs(), 'still me'))).status).toBe(200);
    const melAgain = await invokedTurn(4);
    expect(melAgain.ctx).toMatchObject({ userId: 'usr_mel', agentId, source: 'user', audience: 'shared' });
    await channelTurnCalls(mark);

    // Eve's mention went nowhere: nothing said to her or in her thread, no turn for her.
    for (const c of slackCalls.slice(eveMark).filter((x) => x.method !== 'users.info')) {
      expect(c.body['thread_ts']).not.toBe(eveTs);
      expect(c.body['user']).not.toBe(EVE.slackId);
      expect(c.body['recipient_user_id']).not.toBe(EVE.slackId);
    }
    expect(invokes.map((i) => JSON.stringify(i.input)).join('')).not.toContain('let me in');

    // Ada is gone from the team: Zoe, its admin now, deletes the agent.
    await dropAgent(agentId, 'usr_zoe');
  });

  it('a held call: the outsider thread says its owner was asked and the row waits in the connector\'s Today; a member\'s waits in their own (TASK-1094)', async () => {
    const { installId, agentId } = await supportChannel();
    invokes.length = 0;
    const holds: unknown[] = [];
    invokeScript = async (ctx) => {
      // The runner's pre-call, on the real policy: request_capability is held. Then the held
      // result and the turn's end, the way the runners send them.
      const call = { id: `toolu_held_${invokes.length}`, name: 'request_capability', input: { capability: 'calendar' } };
      holds.push(await theBus!.fire('tool:pre-call', ctx, call));
      await theBus!.fire('chat:stream-chunk', ctx, {
        reqId: ctx.reqId,
        kind: 'tool-result',
        held: true,
        toolCallId: call.id,
        output: 'held',
      });
      await theBus!.fire('chat:turn-end', ctx, { reqId: ctx.reqId, reason: 'user-message-wait' });
    };
    try {
      // External: Carol's turn runs as Ada. The thread says her owner was asked and links nowhere;
      // the row waits in Ada's Today, for this agent and Carol's external conversation.
      let mark = slackCalls.length;
      expect((await deliver(installId, mention(CAROL, nextTs(), 'please book it'))).status).toBe(200);
      const external = await invokedTurn(1);
      expect(external.ctx).toMatchObject({ userId: 'usr_ada', source: 'external' });
      expect(isHold(holds[0])).toBe(true);
      let calls = await channelTurnCalls(mark);
      let said = sentText(calls);
      expect(said).toContain("I need my owner's OK before I can do part of this");
      expect(said).not.toContain('/workspace');
      const externalRows = await listDecisions('usr_ada');
      expect(externalRows).toHaveLength(1);
      expect(externalRows[0]).toMatchObject({
        agentId,
        conversationId: external.ctx.conversationId,
        status: 'pending',
        ownerUserId: 'usr_ada',
      });
      expect((await conversationRow(external.ctx.conversationId!)).key).toMatch(/:external$/);
      expect(await listDecisions('usr_mel')).toEqual([]);

      // Attended: Mel's turn runs as Mel. The thread links her own Today and the row is hers.
      mark = slackCalls.length;
      expect((await deliver(installId, mention(MEL, nextTs(), 'please book it'))).status).toBe(200);
      const attended = await invokedTurn(2);
      expect(attended.ctx).toMatchObject({ userId: 'usr_mel', source: 'user' });
      expect(isHold(holds[1])).toBe(true);
      calls = await channelTurnCalls(mark);
      said = sentText(calls);
      expect(said).toContain(`Approve it in [Today](${PUBLIC_ORIGIN}/workspace)`);
      expect(said).not.toContain("my owner's OK");
      const attendedRows = await listDecisions('usr_mel');
      expect(attendedRows).toHaveLength(1);
      expect(attendedRows[0]).toMatchObject({
        agentId,
        conversationId: attended.ctx.conversationId,
        status: 'pending',
        ownerUserId: 'usr_mel',
      });
      // Ada's Today still holds only the outsider's.
      expect(await listDecisions('usr_ada')).toHaveLength(1);
    } finally {
      invokeScript = null;
    }
    await dropAgent(agentId);
  });

  it('the channel\'s memory switch: a member\'s thread is refused while it is off, for good once a turn ran then; an outsider\'s never is remembered (TASK-1094)', async () => {
    const { installId, agentId } = await supportChannel();
    invokes.length = 0;
    const preCapture = (conversationId: string) =>
      theBus!.fire(
        'memory:pre-capture',
        makeAgentContext({ sessionId: 'test', agentId, userId: 'usr_ada', conversationId }),
        { conversationId },
      );
    const switchTo = async (remember: boolean): Promise<void> => {
      actor = { id: 'usr_ada', isAdmin: false };
      const out = await callRoute('POST', '/settings/slack/:agentId/remember', {
        params: { agentId },
        rawPath: `/settings/slack/${agentId}/remember`,
        body: jsonBody({ channelId: SUPPORT_CHANNEL, remember }),
      });
      actor = null;
      expect(out.status).toBe(200);
    };
    const refused = { rejected: true, reason: 'channel-not-remembered' };
    const outsiders = { rejected: true, reason: 'channel-external-turn' };

    // On (the default): a member's thread is captured like any other.
    const t1 = nextTs();
    let mark = slackCalls.length;
    expect((await deliver(installId, mention(MEL, t1, 'first question'))).status).toBe(200);
    const first = (await invokedTurn(1)).ctx;
    expect(first).toMatchObject({ userId: 'usr_mel', source: 'user' });
    const conv1 = first.conversationId!;
    await channelTurnCalls(mark);
    expect((await preCapture(conv1)).rejected).toBe(false);
    // A conversation this plugin never recorded (a web chat) isn't its to refuse.
    expect((await preCapture('cnv_a_web_chat')).rejected).toBe(false);

    // An outsider's thread is never captured, with the switch on: Carol runs as Ada, and what
    // she says would otherwise be recalled as fact in the agent's later turns, members' included.
    mark = slackCalls.length;
    expect((await deliver(installId, mention(CAROL, nextTs(), 'the refund window is 90 days'))).status).toBe(200);
    const outsider = (await invokedTurn(2)).ctx;
    expect(outsider).toMatchObject({ userId: 'usr_ada', source: 'external' });
    await channelTurnCalls(mark);
    expect(await preCapture(outsider.conversationId!)).toMatchObject(outsiders);

    // Off: the member's thread is refused at once.
    await switchTo(false);
    expect(await preCapture(conv1)).toMatchObject(refused);

    // A turn while it is off, in the same thread. Still the same conversation.
    mark = slackCalls.length;
    expect((await deliver(installId, mention(MEL, nextTs(), 'second question', t1))).status).toBe(200);
    expect((await invokedTurn(3)).ctx.conversationId).toBe(conv1);
    await channelTurnCalls(mark);

    // On again: the thread that had a turn while it was off stays out, for good. A new thread is captured.
    await switchTo(true);
    expect(await preCapture(conv1)).toMatchObject(refused);
    mark = slackCalls.length;
    expect((await deliver(installId, mention(MEL, nextTs(), 'a new question'))).status).toBe(200);
    const conv3 = (await invokedTurn(4)).ctx.conversationId!;
    await channelTurnCalls(mark);
    expect(conv3).not.toBe(conv1);
    expect((await preCapture(conv3)).rejected).toBe(false);
    // The outsider's thread is still out, the switch on or not.
    expect(await preCapture(outsider.conversationId!)).toMatchObject(outsiders);

    // Disconnected: nothing the channel said is captured anymore.
    actor = { id: 'usr_ada', isAdmin: false };
    const disconnected = await callRoute('POST', '/settings/slack/:agentId/disconnect', {
      params: { agentId },
      rawPath: `/settings/slack/${agentId}/disconnect`,
      body: jsonBody({ channelId: SUPPORT_CHANNEL }),
    });
    actor = null;
    expect(disconnected).toMatchObject({ status: 200, body: { removed: true } });
    expect(await preCapture(conv3)).toMatchObject(refused);
    await dropAgent(agentId);
  });
});
