import { createHmac } from 'node:crypto';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { HookBus, PluginError, makeAgentContext, type AgentContext, type Plugin } from '@ax/core';
import { createHttpServerPlugin } from '@ax/http-server';
import {
  createTestHarness,
  startTestContainer,
  stopPostgresContainer,
  type TestHarness,
} from '@ax/test-harness';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RouteRequest, RouteResponse, RouteSpec } from '../http-types.js';
import { ADMIN_BODY_MAX_BYTES, EVENTS_MAX_BODY_BYTES } from '../limits.js';
import type { ChannelSlackDatabase } from '../migrations.js';
import {
  PLUGIN_NAME,
  TURN_EVENTS_KEY,
  createChannelSlackPlugin,
  type ChannelSlackConfig,
} from '../plugin.js';
import { secretRef } from '../secrets.js';
import { createInstallStore } from '../store.js';
import { TURN_EVENT_HOOKS } from '../turn-registry.js';
import { fakeBotToken } from './fake-slack-tokens.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW_MS = Date.parse('2026-11-13T12:00:00.000Z');
const HTTPS_ORIGIN = 'https://ax.example';
const HTTP_ORIGIN = 'http://ax.internal:8080';
const INSTALL_ID = 'q3VtZ0xH4kTn9Wb2LmPa1A';
const UNKNOWN_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const SIGNING_SECRET = 'test-signing-secret-not-real-01';
const APP_ID = 'A07QF9ZK2MN';
const TEAM_ID = 'T07ABCDEF12';
const ADMIN = { id: 'usr_ada', displayName: 'Ada Admin', isAdmin: true };
const BOT_TOKEN = fakeBotToken('PLUGINTESTSECRET');
const ALICE = 'U07ALICE001';
const DM_CHANNEL = 'D07DMCHANNEL';
const DM_TS = '1763035200.000100';

// ── Fakes for the hooks channel-slack calls, other than the database ───────

interface Services {
  routes: Array<RouteSpec & { unregister: ReturnType<typeof vi.fn> }>;
  /** The vault, by ref. */
  vault: Map<string, string>;
  credentialSets: number;
  /** Every credentials:get, by ref. */
  credentialGets: string[];
  /** Every agent:invoke's ctx and input. */
  invokes?: Array<{ ctx: AgentContext; input: unknown }>;
  /** The booted bus, so the fake orchestrator can fire the turn's events. */
  bus?: HookBus;
  /** When set, every agent:invoke waits for it before its turn says anything. */
  invokeGate?: Promise<void>;
  /** How many conversations:find-or-create calls arrived: the last step before a turn is queued. */
  found?: number;
}

const newServices = (): Services => ({ routes: [], vault: new Map(), credentialSets: 0, credentialGets: [], invokes: [] });

function fakeServices(s: Services) {
  return {
    'http:register-route': async (_ctx: unknown, input: unknown) => {
      const unregister = vi.fn();
      s.routes.push({ ...(input as RouteSpec), unregister });
      return { unregister };
    },
    'auth:require-user': async (_ctx: unknown, input: unknown) => {
      const id = (input as { req: RouteRequest }).req.headers['x-test-user'];
      if (id === undefined) {
        throw new PluginError({ code: 'unauthenticated', plugin: 'mock', message: 'nobody' });
      }
      return { user: id === ADMIN.id ? ADMIN : { id, displayName: id, isAdmin: false } };
    },
    'auth:get-user': async (_ctx: unknown, input: unknown) => {
      const { userId } = input as { userId: string };
      return userId === ADMIN.id ? { ...ADMIN, email: 'ada@example.com' } : null;
    },
    'credentials:get': async (_ctx: unknown, input: unknown) => {
      const { ref } = input as { ref: string };
      s.credentialGets.push(ref);
      const value = s.vault.get(ref);
      if (value === undefined) {
        throw new PluginError({ code: 'credential-not-found', plugin: 'mock', message: 'none' });
      }
      return value;
    },
    'credentials:set': async (_ctx: unknown, input: unknown) => {
      const { ref, payload } = input as { ref: string; payload: Uint8Array };
      s.credentialSets += 1;
      s.vault.set(ref, new TextDecoder().decode(payload));
    },
    'credentials:delete': async (_ctx: unknown, input: unknown) => {
      s.vault.delete((input as { ref: string }).ref);
    },
    // The DM path. Only Alice's verified email maps, to one personal agent.
    'auth:find-user-by-email': async (_ctx: unknown, input: unknown) =>
      (input as { email: string }).email === 'alice@canopyworks.com' ? { userId: 'usr_alice' } : null,
    'agents:list-for-user': async (_ctx: unknown, input: unknown) => ({
      agents:
        (input as { userId: string }).userId === 'usr_alice'
          ? [
              {
                id: 'agt_alice',
                ownerId: 'usr_alice',
                ownerType: 'user',
                visibility: 'personal',
                createdAt: new Date('2026-01-01T00:00:00Z'),
              },
            ]
          : [],
    }),
    'conversations:find-or-create': async (_ctx: unknown, input: unknown) => {
      s.found = (s.found ?? 0) + 1;
      return {
        conversation: { conversationId: `conv:${(input as { externalKey: string }).externalKey}` },
        created: true,
      };
    },
    // A turn that streams one line and ends, on the booted bus, for its own reqId.
    'agent:invoke': async (ctx: AgentContext, input: unknown) => {
      s.invokes?.push({ ctx, input });
      if (s.invokeGate !== undefined) await s.invokeGate;
      const bus = s.bus;
      if (bus !== undefined) {
        await bus.fire('chat:stream-chunk', ctx, { reqId: ctx.reqId, kind: 'text', text: 'Hi Alice.' });
        await bus.fire('chat:turn-end', ctx, { reqId: ctx.reqId, reason: 'user-message-wait' });
      }
      return { kind: 'complete', messages: [] };
    },
  };
}

/**
 * Slack, behind the plugin's own client: answers users.info for Alice and
 * every chat.* call, and records each method with its auth header and body.
 */
function fakeSlackFetch() {
  const calls: Array<{ method: string; auth: string | null; body: Record<string, unknown> }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const method = String(input).replace('https://slack.com/api/', '');
    const headers = new Headers(init?.headers);
    const raw = typeof init?.body === 'string' ? init.body : '';
    const body: Record<string, unknown> = (headers.get('content-type') ?? '').startsWith('application/json')
      ? (JSON.parse(raw) as Record<string, unknown>)
      : Object.fromEntries(new URLSearchParams(raw));
    calls.push({ method, auth: headers.get('authorization'), body });
    let answer: Record<string, unknown> = { ok: true };
    if (method === 'users.info') {
      answer =
        body['user'] === ALICE
          ? {
              ok: true,
              user: {
                id: ALICE,
                team_id: TEAM_ID,
                is_email_confirmed: true,
                profile: { email: 'alice@canopyworks.com', real_name: 'Alice' },
              },
            }
          : { ok: false, error: 'user_not_found' };
    }
    if (method === 'chat.startStream') answer = { ok: true, ts: '1763039999.000001' };
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls };
}

// ── A request and response shaped like @ax/http-server's ───────────────────

interface Answer {
  status: number;
  body: unknown;
  done: boolean;
}

function fakeResponse(): { res: RouteResponse; answer: Answer } {
  const answer: Answer = { status: 200, body: undefined, done: false };
  const res: RouteResponse = {
    status(n) {
      answer.status = n;
      return res;
    },
    header() {
      return res;
    },
    json(v) {
      answer.body = v;
      answer.done = true;
    },
    text(t) {
      answer.body = t;
      answer.done = true;
    },
    end() {
      answer.done = true;
    },
    redirect(url, status) {
      answer.status = status ?? 302;
      answer.body = url;
      answer.done = true;
    },
  };
  return { res, answer };
}

function request(
  method: 'GET' | 'POST',
  path: string,
  o: { as?: string; body?: Buffer; params?: Record<string, string>; headers?: Record<string, string> } = {},
): RouteRequest {
  return {
    method,
    path,
    rawPath: path,
    params: o.params ?? {},
    query: {},
    headers: { ...(o.as !== undefined ? { 'x-test-user': o.as } : {}), ...o.headers },
    body: o.body ?? Buffer.alloc(0),
  };
}

function signed(body: Buffer, nowMs = NOW_MS, secret = SIGNING_SECRET): Record<string, string> {
  const ts = String(Math.floor(nowMs / 1000));
  const digest = createHmac('sha256', secret).update(`v0:${ts}:`).update(body).digest('hex');
  return {
    'content-type': 'application/json',
    'x-slack-request-timestamp': ts,
    'x-slack-signature': `v0=${digest}`,
  };
}

// ── Postgres, and the plugin booted on it ──────────────────────────────────

let container: StartedPostgreSqlContainer;
let connectionString: string;
let probePool: pg.Pool;
let probe: Kysely<ChannelSlackDatabase>;
const booted: TestHarness[] = [];

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
  probePool = new pg.Pool({ connectionString, max: 2 });
  probe = new Kysely<ChannelSlackDatabase>({ dialect: new PostgresDialect({ pool: probePool }) });
}, 120_000);

afterEach(async () => {
  vi.restoreAllMocks();
  while (booted.length > 0) await booted.pop()!.close({ onError: () => {} });
  try {
    await sql`TRUNCATE channel_slack_v1_installs`.execute(probe);
  } catch {
    // Not created yet.
  }
});

afterAll(async () => {
  await probe?.destroy().catch(() => {});
  if (container) await stopPostgresContainer(container);
});

async function boot(config: Partial<ChannelSlackConfig> = {}) {
  const s = newServices();
  const plugin = createChannelSlackPlugin({
    publicOrigin: HTTPS_ORIGIN,
    now: () => NOW_MS,
    fetchImpl: () => Promise.reject(new Error('network is off in tests')),
    ...config,
  });
  const harness = await createTestHarness({
    services: fakeServices(s),
    plugins: [createDatabasePostgresPlugin({ connectionString }), plugin],
  });
  booted.push(harness);
  s.bus = harness.bus;
  const route = (method: 'GET' | 'POST', path: string) => {
    const found = s.routes.find((r) => r.method === method && r.path === path);
    if (found === undefined) throw new Error(`no route ${method} ${path}`);
    return found;
  };
  const call = async (method: 'GET' | 'POST', path: string, req: RouteRequest): Promise<Answer> => {
    const { res, answer } = fakeResponse();
    await route(method, path).handler(req, res);
    return answer;
  };
  return { s, plugin, harness, route, call };
}

async function insertActiveInstall(): Promise<void> {
  const store = createInstallStore(probe);
  await store.insertPending({
    installId: INSTALL_ID,
    appId: APP_ID,
    clientId: '7512345678901.7598765432109',
    botName: 'canopy-works',
    connectedByUserId: ADMIN.id,
  });
  await store.activate(INSTALL_ID, {
    teamId: TEAM_ID,
    teamName: 'Canopy Works',
    botUserId: 'U07BOTUSER1',
    installedAt: new Date(NOW_MS),
  });
}

async function installCount(): Promise<number> {
  const r = await sql<{ n: string }>`SELECT count(*)::text AS n FROM channel_slack_v1_installs`.execute(probe);
  return Number(r.rows[0]?.n ?? '0');
}

/** Text a failing delete's message carries, which no log line may repeat. */
const FAILURE_CANARY = 'failure-text-canary-7c1e';

/**
 * Run `fn` with a BEFORE DELETE row trigger on the installs table whose
 * plpgsql body is `body`, then drop it whatever happens. TRUNCATE (the
 * afterEach cleanup) never fires it.
 */
async function withDeleteTrigger(body: string, fn: () => Promise<void>): Promise<void> {
  await sql
    .raw(
      `CREATE FUNCTION channel_slack_test_on_delete() RETURNS trigger LANGUAGE plpgsql AS $fn$
         BEGIN ${body} END
       $fn$;
       CREATE TRIGGER channel_slack_test_on_delete BEFORE DELETE ON channel_slack_v1_installs
         FOR EACH ROW EXECUTE FUNCTION channel_slack_test_on_delete();`,
    )
    .execute(probe);
  try {
    await fn();
  } finally {
    await sql
      .raw(
        `DROP TRIGGER IF EXISTS channel_slack_test_on_delete ON channel_slack_v1_installs;
         DROP FUNCTION IF EXISTS channel_slack_test_on_delete();`,
      )
      .execute(probe);
  }
}

function eventBody(type = 'message', text?: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      type: 'event_callback',
      team_id: TEAM_ID,
      api_app_id: APP_ID,
      event_id: 'Ev07ABCDEF12',
      event: {
        type,
        user: ALICE,
        channel: DM_CHANNEL,
        channel_type: 'im',
        ts: DM_TS,
        ...(text !== undefined ? { text } : {}),
      },
    }),
  );
}

/** A second DM in the first one's thread (DM_TS), with its own event id. */
function threadReplyBody(eventId: string, ts: string, text: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      type: 'event_callback',
      team_id: TEAM_ID,
      api_app_id: APP_ID,
      event_id: eventId,
      event: { type: 'message', user: ALICE, channel: DM_CHANNEL, channel_type: 'im', ts, thread_ts: DM_TS, text },
    }),
  );
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Log lines the plugin's own logger writes (it writes JSON lines to stdout). */
function captureLogs(): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim() === '') continue;
      try {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Not a log line.
      }
    }
    return true;
  });
  return lines;
}

// ── The tests ───────────────────────────────────────────────────────────────

describe('@ax/channel-slack plugin', () => {
  it('manifest pins: registers nothing, calls exactly what it uses, branding and the cap interrupt are optional', () => {
    const plugin = createChannelSlackPlugin({ publicOrigin: HTTPS_ORIGIN });
    expect(PLUGIN_NAME).toBe('@ax/channel-slack');
    expect(plugin.manifest).toEqual({
      name: '@ax/channel-slack',
      version: '0.0.0',
      registers: [],
      calls: [
        'http:register-route',
        'auth:require-user',
        'auth:get-user',
        'database:get-instance',
        'credentials:get',
        'credentials:set',
        'credentials:delete',
        'auth:find-user-by-email',
        'agents:list-for-user',
        'conversations:find-or-create',
        'agent:invoke',
      ],
      optionalCalls: [
        { hook: 'branding:get', degradation: 'the default bot name is "ax"' },
        {
          hook: 'agent:interrupt',
          degradation: 'a DM turn that reaches the 15-minute cap ends its Slack reply but runs on until it finishes',
        },
      ],
      subscribes: ['bootstrap:reset-cleanup', 'chat:stream-chunk', 'chat:turn-end', 'chat:turn-error'],
    });
  });

  it('an unparseable publicOrigin, or one that is not http(s), fails construction', () => {
    for (const publicOrigin of ['', 'not a url', 'ax.example', 'ftp://ax.example', 'javascript:alert(1)']) {
      expect(() => createChannelSlackPlugin({ publicOrigin }), publicOrigin).toThrow(
        expect.objectContaining({ name: 'PluginError', code: 'invalid-config', plugin: PLUGIN_NAME }),
      );
    }
  });

  it('init registers the six routes, and only the events route bypasses CSRF', async () => {
    const { s } = await boot();
    const shapes = s.routes.map((r) => ({
      method: r.method,
      path: r.path,
      bypassCsrf: r.bypassCsrf === true,
      maxBodyBytes: r.maxBodyBytes,
    }));
    expect(shapes).toEqual([
      { method: 'GET', path: '/admin/slack', bypassCsrf: false, maxBodyBytes: undefined },
      { method: 'POST', path: '/admin/slack/connect', bypassCsrf: false, maxBodyBytes: ADMIN_BODY_MAX_BYTES },
      { method: 'POST', path: '/admin/slack/install-url', bypassCsrf: false, maxBodyBytes: ADMIN_BODY_MAX_BYTES },
      { method: 'POST', path: '/admin/slack/disconnect', bypassCsrf: false, maxBodyBytes: ADMIN_BODY_MAX_BYTES },
      { method: 'GET', path: '/admin/slack/oauth/callback', bypassCsrf: false, maxBodyBytes: undefined },
      { method: 'POST', path: '/slack/events/:installId', bypassCsrf: true, maxBodyBytes: EVENTS_MAX_BODY_BYTES },
    ]);
    // Nothing is written to the vault just by booting.
    expect(s.credentialSets).toBe(0);
  });

  it('an http publicOrigin boots, and status reports canConnect:false (default name "ax" without branding)', async () => {
    const { call } = await boot({ publicOrigin: HTTP_ORIGIN });
    const answer = await call('GET', '/admin/slack', request('GET', '/admin/slack', { as: ADMIN.id }));
    expect(answer).toEqual({
      status: 200,
      body: { state: 'not-connected', defaultBotName: 'ax', canConnect: false },
      done: true,
    });
  });

  it('status names who connected the install as auth knows them, from the row on Postgres', async () => {
    const { call } = await boot();
    await insertActiveInstall();
    const answer = await call('GET', '/admin/slack', request('GET', '/admin/slack', { as: ADMIN.id }));
    expect(answer).toEqual({
      status: 200,
      body: {
        state: 'connected',
        botName: 'canopy-works',
        workspaceName: 'Canopy Works',
        connectedBy: 'Ada Admin',
        connectedAt: expect.any(String),
      },
      done: true,
    });
  });

  it('the admin routes are gated: 401 signed out, 403 for a non-admin', async () => {
    const { call } = await boot();
    expect((await call('GET', '/admin/slack', request('GET', '/admin/slack'))).status).toBe(401);
    expect((await call('GET', '/admin/slack', request('GET', '/admin/slack', { as: 'usr_bob' }))).status).toBe(403);
  });

  it("an unknown, malformed or secretless install gets exactly the real router's 404 for a path nothing serves", async () => {
    // The real @ax/http-server in front, so the 404 to match is fetched, not written down here.
    const http = createHttpServerPlugin({
      host: '127.0.0.1',
      port: 0,
      cookieKey: Buffer.alloc(32, 1),
      allowedOrigins: ['http://localhost'],
    });
    const s: Services = { routes: [], vault: new Map(), credentialSets: 0, credentialGets: [] };
    const { 'http:register-route': _captured, ...services } = fakeServices(s);
    const harness = await createTestHarness({
      services,
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        http,
        createChannelSlackPlugin({ publicOrigin: HTTPS_ORIGIN, now: () => NOW_MS }),
      ],
    });
    booted.push(harness);
    // An install that exists but whose signing secret doesn't.
    await insertActiveInstall();

    const answer = async (path: string, headers: Record<string, string> = {}) => {
      const body = eventBody();
      const res = await fetch(`http://127.0.0.1:${http.boundPort()}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...signed(body), ...headers },
        body,
      });
      const { date: _date, ...rest } = Object.fromEntries(res.headers);
      return { status: res.status, headers: rest, body: await res.text() };
    };
    // No route serves this path; the admin header only gets it past CSRF to the router.
    const unserved = await answer('/slack/no-such-route', { 'x-requested-with': 'ax-admin' });
    expect(unserved.status).toBe(404);
    for (const id of [UNKNOWN_ID, INSTALL_ID.slice(1), INSTALL_ID]) {
      expect(await answer(`/slack/events/${id}`), id).toEqual(unserved);
    }
  });

  it('a signed DM from the owner is acknowledged, then answered in its thread through the plugin wiring', async () => {
    const slack = fakeSlackFetch();
    const { s, call } = await boot({ fetchImpl: slack.fetchImpl });
    await insertActiveInstall();
    s.vault.set(secretRef(INSTALL_ID, 'signing-secret'), SIGNING_SECRET);
    s.vault.set(secretRef(INSTALL_ID, 'bot-token'), BOT_TOKEN);
    const logs = captureLogs();

    const body = eventBody('message', 'Hello there');
    const answer = await call(
      'POST',
      '/slack/events/:installId',
      request('POST', `/slack/events/${INSTALL_ID}`, {
        params: { installId: INSTALL_ID },
        body,
        headers: signed(body),
      }),
    );
    expect(answer).toEqual({ status: 200, body: undefined, done: true });

    // The reply goes out after the 200: admission, the turn, then the stream.
    await vi.waitFor(() => expect(slack.calls.map((c) => c.method)).toContain('chat.stopStream'));
    expect(slack.calls.map((c) => [c.method, c.auth])).toEqual([
      ['users.info', `Bearer ${BOT_TOKEN}`],
      ['chat.startStream', `Bearer ${BOT_TOKEN}`],
      ['chat.stopStream', `Bearer ${BOT_TOKEN}`],
    ]);
    expect(slack.calls[0]!.body).toEqual({ user: ALICE });
    expect(slack.calls[1]!.body).toEqual({
      channel: DM_CHANNEL,
      thread_ts: DM_TS,
      recipient_user_id: ALICE,
      recipient_team_id: TEAM_ID,
      chunks: [{ type: 'markdown_text', text: 'Hi Alice.' }],
    });

    expect(s.invokes).toHaveLength(1);
    const { ctx, input } = s.invokes![0]!;
    expect(ctx).toMatchObject({
      userId: 'usr_alice',
      agentId: 'agt_alice',
      conversationId: `conv:slack:${INSTALL_ID}:${DM_CHANNEL}:${DM_TS}`,
      source: 'user',
      audience: 'private',
    });
    expect(input).toEqual({ message: { role: 'user', content: `[Slack \u00b7 DM \u00b7 Alice (${ALICE})]: Hello there` } });
    // Nothing went wrong, and nothing from the event was logged.
    expect(logs.filter((l) => String(l['msg']).startsWith('slack_'))).toEqual([]);
  });

  /**
   * Two DMs in one thread, the first turn held at agent:invoke: the second is
   * queued behind it. Resolves once the second has reached the queue.
   */
  async function oneRunningOneWaiting() {
    const slack = fakeSlackFetch();
    const b = await boot({ fetchImpl: slack.fetchImpl });
    const { s, call } = b;
    await insertActiveInstall();
    s.vault.set(secretRef(INSTALL_ID, 'signing-secret'), SIGNING_SECRET);
    s.vault.set(secretRef(INSTALL_ID, 'bot-token'), BOT_TOKEN);
    const gate = deferred();
    s.invokeGate = gate.promise;
    const post = (body: Buffer) =>
      call(
        'POST',
        '/slack/events/:installId',
        request('POST', `/slack/events/${INSTALL_ID}`, { params: { installId: INSTALL_ID }, body, headers: signed(body) }),
      );
    expect((await post(eventBody('message', 'first'))).status).toBe(200);
    expect((await post(threadReplyBody('Ev07ABCDEF13', '1763035201.000200', 'second'))).status).toBe(200);
    await vi.waitFor(() => {
      expect(s.invokes).toHaveLength(1);
      expect(s.found).toBe(2);
    });
    // The second dispatch queues its turn right after find-or-create answers.
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { ...b, slack, gate };
  }

  it('a turn still waiting at shutdown is dropped, and the log says whose and how many', async () => {
    const { s, plugin, gate } = await oneRunningOneWaiting();
    const logs = captureLogs();
    await plugin.shutdown?.();
    expect(logs.filter((l) => l['msg'] === 'slack_turns_dropped')).toEqual([
      expect.objectContaining({ level: 'warn', installId: INSTALL_ID, reason: 'shutting-down', count: 1 }),
    ]);
    gate.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.invokes).toHaveLength(1);
  });

  it('a turn still waiting when the admin disconnects never reaches the agent', async () => {
    const { s, call, gate } = await oneRunningOneWaiting();
    const logs = captureLogs();
    const off = await call('POST', '/admin/slack/disconnect', request('POST', '/admin/slack/disconnect', { as: ADMIN.id }));
    expect(off.status).toBe(200);
    expect(await installCount()).toBe(0);

    gate.release();
    await vi.waitFor(() => expect(logs.some((l) => l['msg'] === 'slack_turns_dropped')).toBe(true));
    expect(s.invokes).toHaveLength(1);
    expect(logs.filter((l) => l['msg'] === 'slack_turns_dropped')).toEqual([
      expect.objectContaining({ level: 'info', installId: INSTALL_ID, reason: 'disconnected', count: 1 }),
    ]);
  });

  it('a bad signature is refused with 401 and nothing is dispatched', async () => {
    const { s, call, harness } = await boot();
    await insertActiveInstall();
    s.vault.set(secretRef(INSTALL_ID, 'signing-secret'), SIGNING_SECRET);
    const logs = captureLogs();

    const body = eventBody();
    // Signed 301 s ago: outside the replay window, by the plugin's own clock.
    const answer = await call(
      'POST',
      '/slack/events/:installId',
      request('POST', `/slack/events/${INSTALL_ID}`, {
        params: { installId: INSTALL_ID },
        body,
        headers: signed(body, NOW_MS - 301_000),
      }),
    );
    expect(answer.status).toBe(401);
    await harness.close({ onError: () => {} });
    expect(logs.filter((l) => l['msg'] === 'slack_event_refused')).toHaveLength(1);
    expect(s.invokes).toEqual([]);
  });

  it('unsigned requests to a known install read its signing secret once, and a disconnect or reset is seen at once', async () => {
    const { s, call, harness } = await boot();
    await insertActiveInstall();
    s.vault.set(secretRef(INSTALL_ID, 'signing-secret'), SIGNING_SECRET);
    const signingReads = (): number =>
      s.credentialGets.filter((ref) => ref === secretRef(INSTALL_ID, 'signing-secret')).length;
    const post = (headers: Record<string, string>, body = eventBody()) =>
      call(
        'POST',
        '/slack/events/:installId',
        request('POST', `/slack/events/${INSTALL_ID}`, { params: { installId: INSTALL_ID }, body, headers }),
      );

    for (let i = 0; i < 5; i += 1) expect((await post({ 'content-type': 'application/json' })).status).toBe(401);
    expect(signingReads()).toBe(1);

    // Disconnect drops the install's secrets, and the remembered one with them.
    const disconnected = await call(
      'POST',
      '/admin/slack/disconnect',
      request('POST', '/admin/slack/disconnect', { as: ADMIN.id }),
    );
    expect(disconnected.status).toBe(200);
    // The same id back with a new secret (only a test re-uses an id): the new one is used.
    await insertActiveInstall();
    const replaced = 'test-signing-secret-not-real-02';
    s.vault.set(secretRef(INSTALL_ID, 'signing-secret'), replaced);
    const body = eventBody();
    expect((await post(signed(body, NOW_MS, replaced), body)).status).toBe(200);
    expect(signingReads()).toBe(2);

    // A reset fired on THIS bus forgets it too. (`ax admin reset-bootstrap`
    // fires it on the CLI's own bus, so the host relies on the TTL; plugin.ts.)
    await harness.bus.fire('bootstrap:reset-cleanup', harness.ctx(), {});
    await insertActiveInstall();
    expect((await post({ 'content-type': 'application/json' })).status).toBe(401);
    expect(signingReads()).toBe(3);
  });

  it('stopAdmission makes the events route answer 503 before any lookup', async () => {
    const { plugin, call } = await boot();
    await plugin.stopAdmission?.();
    const answer = await call(
      'POST',
      '/slack/events/:installId',
      request('POST', `/slack/events/${INSTALL_ID}`, { params: { installId: INSTALL_ID }, body: eventBody() }),
    );
    expect(answer).toEqual({ status: 503, body: undefined, done: true });
  });

  it('bootstrap:reset-cleanup empties the installs table', async () => {
    const { harness } = await boot();
    await insertActiveInstall();
    expect(await installCount()).toBe(1);

    await harness.bus.fire('bootstrap:reset-cleanup', harness.ctx(), {});
    expect(await installCount()).toBe(0);
  });

  it('a reset says which Slack apps it left behind, by id and workspace, with no secret', async () => {
    const { harness, s } = await boot();
    await insertActiveInstall();
    // A pending install too: its app exists in Slack just the same.
    await createInstallStore(probe).insertPending({
      installId: UNKNOWN_ID,
      appId: 'A07PENDING01',
      clientId: '7512345678901.7500000000000',
      botName: 'pending-bot',
      connectedByUserId: ADMIN.id,
    });
    s.vault.set('slack:' + INSTALL_ID + ':signing-secret', SIGNING_SECRET);
    const logs = captureLogs();

    const fired = await harness.bus.fire('bootstrap:reset-cleanup', harness.ctx(), {});
    expect(fired.rejected).toBe(false);
    expect(await installCount()).toBe(0);

    const removed = logs.filter((l) => l['msg'] === 'slack_install_removed_by_reset');
    expect(removed).toHaveLength(2);
    const byId = new Map(removed.map((l) => [l['installId'], l]));
    expect(byId.get(INSTALL_ID)).toMatchObject({
      level: 'warn',
      appId: APP_ID,
      teamId: TEAM_ID,
      hint: expect.stringContaining('api.slack.com/apps'),
    });
    expect(byId.get(UNKNOWN_ID)).toMatchObject({ appId: 'A07PENDING01', teamId: null });
    for (const l of removed) {
      expect(String(l['hint'])).toContain('configuration token');
      expect(Object.keys(l).sort()).toEqual(
        ['appId', 'hint', 'installId', 'level', 'msg', 'reqId', 'teamId', 'ts'],
      );
    }
    const all = JSON.stringify(logs);
    expect(all).not.toContain(SIGNING_SECRET);
    expect(all).not.toContain('7512345678901'); // client ids stay out too
  });

  it('a reset whose delete fails says nothing was removed, logs by code only, and does not fail the reset', async () => {
    const { harness } = await boot();
    await insertActiveInstall();
    // The rows are there and readable; only deleting them fails.
    await withDeleteTrigger(
      `RAISE EXCEPTION 'refused in test: ${FAILURE_CANARY}'; RETURN OLD;`,
      async () => {
        const logs = captureLogs();
        const fired = await harness.bus.fire('bootstrap:reset-cleanup', harness.ctx(), {});
        expect(fired.rejected).toBe(false);

        // Nothing was deleted, so nothing may be reported as removed.
        expect(await installCount()).toBe(1);
        expect(logs.filter((l) => l['msg'] === 'slack_install_removed_by_reset')).toEqual([]);
        const failed = logs.filter((l) => l['msg'] === 'slack_reset_cleanup_failed');
        expect(failed).toHaveLength(1);
        // plpgsql's RAISE EXCEPTION: Postgres's code, never its message.
        expect(failed[0]).toMatchObject({ level: 'error', code: 'P0001' });
        expect(Object.keys(failed[0]!).sort()).toEqual(['code', 'level', 'msg', 'reqId', 'ts']);
        expect(JSON.stringify(logs)).not.toContain(FAILURE_CANARY);
      },
    );
  });

  it('a reset logs exactly the installs its delete removed, not the ones it could read', async () => {
    const { harness } = await boot();
    await insertActiveInstall();
    await createInstallStore(probe).insertPending({
      installId: UNKNOWN_ID,
      appId: 'A07PENDING01',
      clientId: '7512345678901.7500000000000',
      botName: 'pending-bot',
      connectedByUserId: ADMIN.id,
    });
    // The delete skips the active install (a row trigger returning NULL), so
    // what a read sees and what the delete removes differ, as with a connect
    // that lands between a read and a delete.
    await withDeleteTrigger(
      `IF OLD.install_id = '${INSTALL_ID}' THEN RETURN NULL; END IF; RETURN OLD;`,
      async () => {
        const logs = captureLogs();
        const fired = await harness.bus.fire('bootstrap:reset-cleanup', harness.ctx(), {});
        expect(fired.rejected).toBe(false);

        expect(await installCount()).toBe(1);
        const removed = logs.filter((l) => l['msg'] === 'slack_install_removed_by_reset');
        expect(removed.map((l) => l['installId'])).toEqual([UNKNOWN_ID]);
        expect(removed[0]).toMatchObject({ level: 'warn', appId: 'A07PENDING01', teamId: null });
        expect(logs.filter((l) => l['msg'] === 'slack_reset_cleanup_failed')).toEqual([]);
      },
    );
  });

  it('shutdown unregisters every route, the reset and chat subscribers, and is safe to call twice', async () => {
    const { s, plugin, harness } = await boot();
    await plugin.shutdown?.();
    expect(s.routes).toHaveLength(6);
    for (const r of s.routes) expect(r.unregister, `${r.method} ${r.path}`).toHaveBeenCalledTimes(1);
    for (const hook of TURN_EVENT_HOOKS) expect(harness.bus.unsubscribe(hook, TURN_EVENTS_KEY), hook).toBe(0);

    await insertActiveInstall();
    await harness.bus.fire('bootstrap:reset-cleanup', harness.ctx(), {});
    expect(await installCount()).toBe(1);

    await plugin.shutdown?.();
    for (const r of s.routes) expect(r.unregister).toHaveBeenCalledTimes(1);
  });

  it('a failed route registration unwinds the routes already registered', async () => {
    const plugin = createChannelSlackPlugin({ publicOrigin: HTTPS_ORIGIN });
    const s: Services = { routes: [], vault: new Map(), credentialSets: 0, credentialGets: [] };
    const services = fakeServices(s);
    const bus = new HookBus();
    let registered = 0;
    bus.registerService('http:register-route', 'mock', async (ctx, input) => {
      registered += 1;
      if (registered === 3) throw new Error('duplicate route');
      return services['http:register-route'](ctx, input);
    });
    for (const hook of ['auth:require-user', 'credentials:get', 'credentials:set', 'credentials:delete'] as const) {
      bus.registerService<unknown, unknown>(hook, 'mock', services[hook]);
    }
    const db: Plugin = createDatabasePostgresPlugin({ connectionString });
    await db.init({ bus, config: {} });
    try {
      await expect(plugin.init({ bus, config: {} })).rejects.toThrow();
      expect(s.routes).toHaveLength(2);
      for (const r of s.routes) expect(r.unregister).toHaveBeenCalledTimes(1);
      // No reset or chat subscriber is left behind either.
      for (const hook of TURN_EVENT_HOOKS) expect(bus.unsubscribe(hook, TURN_EVENTS_KEY), hook).toBe(0);
      await insertActiveInstall();
      await bus.fire('bootstrap:reset-cleanup', makeAgentContext({ sessionId: 't', agentId: 't', userId: 't' }), {});
      expect(await installCount()).toBe(1);
    } finally {
      await db.shutdown?.();
    }
  });
});
