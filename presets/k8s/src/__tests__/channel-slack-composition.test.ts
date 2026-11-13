import { createHmac } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

import pg from 'pg';

import { HookBus, PluginError, bootstrap, makeAgentContext, type AgentContext, type Plugin } from '@ax/core';
import type { CreateOutput as AgentCreateOutput } from '@ax/agents';
import { startTestContainer, stopPostgresContainer } from '@ax/test-harness';

import { createK8sPlugins, type K8sPresetConfig } from '../index.js';

// ---------------------------------------------------------------------------
// TASK-1093 -- @ax/channel-slack composition canary (Invariant 3: no
// half-wired plugins).
//
// One flow through the preset's OWN plugins: the real @ax/channel-slack (its
// admin routes, OAuth callback and events route), the real @ax/agents (the
// personal agents a Slack DM reaches), the real @ax/conversations (the
// thread's conversation, origin 'slack'), and the real credentials vault
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
// `auth:get-user`, `auth:find-user-by-email` (two mapped people and nobody
// else), `agent:invoke` (records the turn, then streams one line and ends it
// on the bus, the way the orchestrator does) and `branding:get`.
// ---------------------------------------------------------------------------

const SLACK_PLUGIN = '@ax/channel-slack';
const KEEP = new Set<string>([
  '@ax/database-postgres',
  '@ax/storage-postgres',
  '@ax/credentials',
  '@ax/credentials-store-db',
  '@ax/agents',
  '@ax/conversations',
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
const PEOPLE = [ALICE, BOB, CAROL];

/** auth's answer: Alice and Bob have AX accounts, Carol doesn't. */
const AX_USERS: Record<string, string> = {
  [ALICE.email]: 'usr_alice',
  [BOB.email]: 'usr_bob',
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
      // The orchestrator's: a turn streams on the bus for its own reqId and
      // ends with chat:turn-end carrying the turn's conversation. No deadline,
      // like the real one (AGENT_INVOKE_TIMEOUT_MS), so a slow turn isn't cut.
      bus.registerService<unknown, unknown>(
        'agent:invoke',
        name,
        async (ctx, input) => {
          invokes.push({ ctx, input });
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

    // A mention in a channel from a member gets one ephemeral refusal, to
    // them alone, and no turn.
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
});
