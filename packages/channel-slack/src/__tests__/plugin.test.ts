import { createHmac } from 'node:crypto';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import {
  HookBus,
  MEMORY_PRE_CAPTURE_SUBSCRIBER_TIMEOUT_MS,
  PluginError,
  makeAgentContext,
  type AgentContext,
  type Plugin,
} from '@ax/core';
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
import { AGENTS_DELETED_KEY } from '../agents-deleted.js';
import { CAPTURE_VETO_KEY } from '../capture-veto.js';
import { createChannelStore } from '../channel-store.js';
import { COPY } from '../copy.js';
import type { RouteRequest, RouteResponse, RouteSpec } from '../http-types.js';
import {
  ADMIN_BODY_MAX_BYTES,
  ADMIN_CONNECT_BODY_MAX_BYTES,
  COMMANDS_MAX_BODY_BYTES,
  EVENTS_MAX_BODY_BYTES,
  INTERACTIONS_MAX_BODY_BYTES,
} from '../limits.js';
import { runMigrations, type ChannelSlackDatabase } from '../migrations.js';
import {
  PLUGIN_NAME,
  TURN_EVENTS_KEY,
  createChannelSlackPlugin,
  type ChannelSlackConfig,
} from '../plugin.js';
import { configTokenRef, secretRef } from '../secrets.js';
import { createInstallStore } from '../store.js';
import { slackTurnNote } from '../turn-note.js';
import { TURN_EVENT_HOOKS } from '../turn-registry.js';
import { fakeBotToken, fakeConfigAccessToken, fakeConfigRefreshToken } from './fake-slack-tokens.js';

/*
  The plugin's turn queue, watched rather than slept on: the real queue, with
  each accepted `enqueue` counted, so a test can wait for "the second turn is
  queued" as a fact instead of guessing how many milliseconds it takes.
*/
const turnQueue = vi.hoisted(() => ({ queued: 0 }));
vi.mock('../turn-queue.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../turn-queue.js')>();
  return {
    ...actual,
    createKeyedQueue: (o: { maxPerKey: number }) => {
      const inner = actual.createKeyedQueue(o);
      return {
        ...inner,
        enqueue: (...args: Parameters<typeof inner.enqueue>) => {
          const result = inner.enqueue(...args);
          if (result === 'queued') turnQueue.queued += 1;
          return result;
        },
      };
    },
  };
});

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
/** Another admin, whose configuration token is her own (TASK-1175). */
const GRACE = 'usr_grace';
const GRACE_INSTALL_ID = 'Gr4c3InstallIdNotReal1';
/** A Slack app an earlier Disconnect couldn't delete: its removed install's id. */
const LEFTOVER_ID = 'L3ftoverInstallId0001A';
/** A team agent's own bot (TASK-1167), Grace's: she asked for it and approved it. */
const BOT_INSTALL_ID = 'B0tInstallIdNotReal001';
const BOT_APP_ID = 'A07BOTAPP001';
const BOT_TOKEN = fakeBotToken('PLUGINTESTSECRET');
const ALICE = 'U07ALICE001';
/** Ada's Slack user: she connected #support, and is a team admin of its agent. */
const ADA_SLACK = 'U07ADA00001';
const DM_CHANNEL = 'D07DMCHANNEL';
const DM_TS = '1763035200.000100';
const TEAM_AGENT = { id: 'agt_support', displayName: 'Support', visibility: 'team', ownerType: 'team', ownerId: 'team_support' };
const SUPPORT_CH = 'C07SUPPORT1';

// ── Fakes for the hooks channel-slack calls, other than the database ───────

interface Services {
  routes: Array<RouteSpec & { unregister: ReturnType<typeof vi.fn> }>;
  /** The vault, by ref. */
  vault: Map<string, string>;
  credentialSets: number;
  /** Every credentials:get, by ref. */
  credentialGets: string[];
  /** Every credentials:delete, by ref. */
  credentialDeletes: string[];
  /** `<hook> <ref>` → what that credentials:get or credentials:delete throws instead. */
  vaultFailures: Map<string, Error>;
  /** Every agent:invoke's ctx and input. */
  invokes?: Array<{ ctx: AgentContext; input: unknown }>;
  /** The booted bus, so the fake orchestrator can fire the turn's events. */
  bus?: HookBus;
  /** When set, every agent:invoke waits for it before its turn says anything. */
  invokeGate?: Promise<void>;
  /** How many conversations:find-or-create calls arrived: the last step before a turn is queued. */
  found?: number;
  /** How many agent:invoke calls have returned (past `invokeGate`, their turn streamed). */
  invokesReturned?: number;
  /** When set, what each agent:invoke's turn says instead of "Hi Alice.". */
  turnScript?: (bus: HookBus, ctx: AgentContext) => Promise<void>;
  /** When set, called as each route registers, before it is recorded. */
  onRegisterRoute?: () => void;
}

const newServices = (): Services => ({
  routes: [],
  vault: new Map(),
  credentialSets: 0,
  credentialGets: [],
  credentialDeletes: [],
  vaultFailures: new Map(),
  invokes: [],
});

function fakeServices(s: Services) {
  return {
    'http:register-route': async (_ctx: unknown, input: unknown) => {
      s.onRegisterRoute?.();
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
      const failure = s.vaultFailures.get(`credentials:get ${ref}`);
      if (failure !== undefined) throw failure;
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
      const { ref } = input as { ref: string };
      s.credentialDeletes.push(ref);
      const failure = s.vaultFailures.get(`credentials:delete ${ref}`);
      if (failure !== undefined) throw failure;
      s.vault.delete(ref);
    },
    // The DM path: Alice's verified email maps, to one personal agent. Ada's maps to her
    // account, so her mention in #support runs attended.
    'auth:find-user-by-email': async (_ctx: unknown, input: unknown) => {
      const { email } = input as { email: string };
      return email === 'alice@canopyworks.com' ? { userId: 'usr_alice' } : email === 'ada@canopyworks.com' ? { userId: ADMIN.id } : null;
    },
    // A channel mention from someone with no account: canopyworks.com is the approved domain.
    'auth:is-approved-email': async (_ctx: unknown, input: unknown) => ({
      approved: (input as { email: string }).email.toLowerCase().endsWith('@canopyworks.com'),
    }),
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
    // The agent settings path. Ada is a team admin of the one team agent;
    // everyone else is outside it.
    'agents:resolve': async (_ctx: unknown, input: unknown) => {
      const { agentId, userId } = input as { agentId: string; userId: string };
      // Alice's own personal agent, as her DM turns use it (the click gate asks again).
      if (agentId === 'agt_alice' && userId === 'usr_alice') {
        return { agent: { id: 'agt_alice', displayName: 'Alice', visibility: 'personal', ownerType: 'user', ownerId: 'usr_alice' } };
      }
      if (agentId !== TEAM_AGENT.id) {
        throw new PluginError({ code: 'not-found', plugin: 'mock', message: 'no such agent' });
      }
      if (userId !== ADMIN.id) {
        throw new PluginError({ code: 'forbidden', plugin: 'mock', message: 'not yours' });
      }
      return { agent: TEAM_AGENT };
    },
    'agents:can-set-shared-credential': async (_ctx: unknown, input: unknown) => ({
      allowed: (input as { actor: { userId: string } }).actor.userId === ADMIN.id,
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
      if (bus !== undefined && s.turnScript !== undefined) {
        await s.turnScript(bus, ctx);
      } else if (bus !== undefined) {
        await bus.fire('chat:stream-chunk', ctx, { reqId: ctx.reqId, kind: 'text', text: 'Hi Alice.' });
        await bus.fire('chat:turn-end', ctx, { reqId: ctx.reqId, reason: 'user-message-wait' });
      }
      s.invokesReturned = (s.invokesReturned ?? 0) + 1;
      return { kind: 'complete', messages: [] };
    },
  };
}

/**
 * Slack, behind the plugin's own client: answers users.info for Alice and
 * Ada and every chat.* call, and records each method with its auth header
 * and body.
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
          : body['user'] === ADA_SLACK
            ? {
                ok: true,
                user: {
                  id: ADA_SLACK,
                  team_id: TEAM_ID,
                  is_email_confirmed: true,
                  profile: { email: 'ada@canopyworks.com', real_name: 'Ada' },
                },
              }
            : { ok: false, error: 'user_not_found' };
    }
    if (method === 'chat.startStream') answer = { ok: true, ts: '1763039999.000001' };
    if (method === 'chat.postMessage') answer = { ok: true, ts: '1763039999.000002' };
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
  o: {
    as?: string;
    body?: Buffer;
    params?: Record<string, string>;
    query?: Record<string, string>;
    headers?: Record<string, string>;
  } = {},
): RouteRequest {
  return {
    method,
    path,
    rawPath: path,
    params: o.params ?? {},
    query: o.query ?? {},
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
    await sql`TRUNCATE channel_slack_v1_installs, channel_slack_v1_channels, channel_slack_v1_threads, channel_slack_v1_leftover_apps`.execute(probe);
  } catch {
    // Not created yet.
  }
});

afterAll(async () => {
  await probe?.destroy().catch(() => {});
  if (container) await stopPostgresContainer(container);
});

/** `seed` runs before the plugin starts: what the vault holds, or what a test watches, at boot. */
async function boot(config: Partial<ChannelSlackConfig> = {}, o: { seed?: (s: Services) => void } = {}) {
  const s = newServices();
  o.seed?.(s);
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

/** An @mention of the bot in #support, from Alice unless told otherwise, with its own event id and ts. */
function mentionBody(eventId: string, ts: string, text: string, user = ALICE): Buffer {
  return Buffer.from(
    JSON.stringify({
      type: 'event_callback',
      team_id: TEAM_ID,
      api_app_id: APP_ID,
      event_id: eventId,
      event: { type: 'app_mention', user, channel: SUPPORT_CH, ts, text },
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

/** Memory's question before it learns from a conversation, as @ax/memory fires it. */
function askMemory(bus: HookBus, conversationId: string) {
  const ctx = makeAgentContext({ sessionId: 'memory-pass', agentId: TEAM_AGENT.id, userId: ADMIN.id, conversationId });
  return bus.fire('memory:pre-capture', ctx, { conversationId }, { subscriberTimeoutMs: MEMORY_PRE_CAPTURE_SUBSCRIBER_TIMEOUT_MS });
}

const NOT_REMEMBERED = { rejected: true, reason: 'channel-not-remembered', source: CAPTURE_VETO_KEY };
/** What memory hears about an outsider's thread: never remembered, whatever the switch says. */
const OUTSIDER_THREAD = { rejected: true, reason: 'channel-external-turn', source: CAPTURE_VETO_KEY };

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


/** A member's thread an earlier run kept out of memory, its binding long gone: written straight to the table. */
async function keptOutThread(conversationId: string): Promise<void> {
  await sql`
    INSERT INTO channel_slack_v1_threads (conversation_id, install_id, channel_id, agent_id, not_remembered, external)
    VALUES (${conversationId}, ${INSTALL_ID}, ${SUPPORT_CH}, ${TEAM_AGENT.id}, true, false)
  `.execute(probe);
}

describe('@ax/channel-slack plugin', () => {
  it('manifest pins: registers one system-prompt contribution, calls exactly what it uses, branding and the cap interrupt are optional', () => {
    const plugin = createChannelSlackPlugin({ publicOrigin: HTTPS_ORIGIN });
    expect(PLUGIN_NAME).toBe('@ax/channel-slack');
    expect(plugin.manifest).toEqual({
      name: '@ax/channel-slack',
      version: '0.0.0',
      registers: ['system-prompt:augment:optional:slack'],
      calls: [
        'http:register-route',
        'auth:require-user',
        'auth:get-user',
        'database:get-instance',
        'credentials:get',
        'credentials:set',
        'credentials:delete',
        'auth:find-user-by-email',
        'auth:is-approved-email',
        'agents:list-for-user',
        'agents:resolve',
        'agents:can-set-shared-credential',
        'conversations:find-or-create',
        'agent:invoke',
      ],
      optionalCalls: [
        { hook: 'branding:get', degradation: 'the default bot name is "ax"' },
        {
          hook: 'agent:interrupt',
          degradation: 'a Slack turn that reaches the 15-minute cap ends its Slack reply but runs on until it finishes',
        },
        {
          hook: 'teams:list-for-user',
          degradation: '/ax connect finds no team agents, so channels connect from agent settings only',
        },
        // The approval buttons (TASK-1095): optional, never hard.
        ...[
          'decisions:recent-for-conversation',
          'decisions:get',
          'decisions:approve',
          'decisions:dismiss',
        ].map((hook) => ({
          hook,
          degradation: 'a call held in a Slack turn links to Today instead of showing Allow and Deny buttons',
        })),
        // A host the sandbox was refused, allowed for the live session from Slack.
        { hook: 'proxy:add-host', degradation: 'a blocked host in a Slack turn is not offered for approval' },
        // A catalog skill the agent asked to use: attached from Slack once its conversation is read back.
        ...['agent:apply-capability-grant', 'conversations:get'].map((hook) => ({
          hook,
          degradation: 'a skill request in a Slack turn links to the web app instead of showing buttons',
        })),
        // A continuation an Allow woke is bound to its conversation, as the web app binds it (TASK-1150).
        {
          hook: 'conversations:bind-session',
          degradation: "an Allow's continuation isn't bound to its conversation, so a skill Allow or the idle reaper can end it, and the 15-minute cap can't stop it",
        },
      ],
      subscribes: [
        'bootstrap:reset-cleanup',
        'agents:deleted',
        'memory:pre-capture',
        'chat:stream-chunk',
        'chat:turn-end',
        'chat:turn-error',
        'chat:permission-request',
      ],
    });
  });

  it('registers its system-prompt contribution, which answers {} for anything that is not a Slack turn (TASK-1131)', async () => {
    const { harness } = await boot();
    expect(harness.bus.listServices()).toContain('system-prompt:augment:optional:slack');
    // A web chat's spawn, say: no Slack turn is registered under its reqId.
    expect(await harness.bus.call('system-prompt:augment:optional:slack', harness.ctx(), {})).toEqual({});
  });

  it("a DM turn's spawn gets the DM note: the provider reads the registry the turn registered in (TASK-1131)", async () => {
    const slack = fakeSlackFetch();
    const { s, call } = await boot({ fetchImpl: slack.fetchImpl });
    await insertActiveInstall();
    s.vault.set(secretRef(INSTALL_ID, 'signing-secret'), SIGNING_SECRET);
    s.vault.set(secretRef(INSTALL_ID, 'bot-token'), BOT_TOKEN);
    const notes: unknown[] = [];
    s.turnScript = async (b, ctx) => {
      // What the orchestrator does at a fresh spawn: every provider, with the invoke's own ctx.
      notes.push(await b.call('system-prompt:augment:optional:slack', ctx, {}));
      await b.fire('chat:stream-chunk', ctx, { reqId: ctx.reqId, kind: 'text', text: 'Hi Alice.' });
      await b.fire('chat:turn-end', ctx, { reqId: ctx.reqId, reason: 'user-message-wait' });
    };
    const body = eventBody('message', 'Hello there');
    const answer = await call(
      'POST',
      '/slack/events/:installId',
      request('POST', `/slack/events/${INSTALL_ID}`, { params: { installId: INSTALL_ID }, body, headers: signed(body) }),
    );
    expect(answer.status).toBe(200);
    await vi.waitFor(() => expect(s.invokesReturned).toBe(1));
    expect(notes).toEqual([{ context: slackTurnNote('dm') }]);
  });

  it('an unparseable publicOrigin, or one that is not http(s), fails construction', () => {
    for (const publicOrigin of ['', 'not a url', 'ax.example', 'ftp://ax.example', 'javascript:alert(1)']) {
      expect(() => createChannelSlackPlugin({ publicOrigin }), publicOrigin).toThrow(
        expect.objectContaining({ name: 'PluginError', code: 'invalid-config', plugin: PLUGIN_NAME }),
      );
    }
  });

  it('init registers the twenty-five routes, and only the events, commands and interactions routes bypass CSRF', async () => {
    const { s } = await boot();
    const shapes = s.routes.map((r) => ({
      method: r.method,
      path: r.path,
      bypassCsrf: r.bypassCsrf === true,
      maxBodyBytes: r.maxBodyBytes,
    }));
    expect(shapes).toEqual([
      { method: 'GET', path: '/admin/slack', bypassCsrf: false, maxBodyBytes: undefined },
      // Connect's body can carry the bot's picture (TASK-1133).
      { method: 'POST', path: '/admin/slack/connect', bypassCsrf: false, maxBodyBytes: ADMIN_CONNECT_BODY_MAX_BYTES },
      { method: 'POST', path: '/admin/slack/install-url', bypassCsrf: false, maxBodyBytes: ADMIN_BODY_MAX_BYTES },
      { method: 'POST', path: '/admin/slack/rename', bypassCsrf: false, maxBodyBytes: ADMIN_BODY_MAX_BYTES },
      { method: 'POST', path: '/admin/slack/replace-token', bypassCsrf: false, maxBodyBytes: ADMIN_BODY_MAX_BYTES },
      { method: 'POST', path: '/admin/slack/disconnect', bypassCsrf: false, maxBodyBytes: ADMIN_BODY_MAX_BYTES },
      {
        method: 'POST',
        path: '/admin/slack/forget-leftover-app',
        bypassCsrf: false,
        maxBodyBytes: ADMIN_BODY_MAX_BYTES,
      },
      { method: 'GET', path: '/admin/slack/oauth/callback', bypassCsrf: false, maxBodyBytes: undefined },
      // Admin › Slack's bot requests (TASK-1169): Approve's body can carry the bot's picture, as Connect's can.
      { method: 'GET', path: '/admin/slack/bot-requests', bypassCsrf: false, maxBodyBytes: undefined },
      {
        method: 'POST',
        path: '/admin/slack/bot-requests/:requestId/approve',
        bypassCsrf: false,
        maxBodyBytes: ADMIN_CONNECT_BODY_MAX_BYTES,
      },
      {
        method: 'POST',
        path: '/admin/slack/bot-requests/:requestId/decline',
        bypassCsrf: false,
        maxBodyBytes: ADMIN_BODY_MAX_BYTES,
      },
      { method: 'POST', path: '/slack/events/:installId', bypassCsrf: true, maxBodyBytes: EVENTS_MAX_BODY_BYTES },
      { method: 'POST', path: '/slack/commands/:installId', bypassCsrf: true, maxBodyBytes: COMMANDS_MAX_BODY_BYTES },
      {
        method: 'POST',
        path: '/slack/interactions/:installId',
        bypassCsrf: true,
        maxBodyBytes: INTERACTIONS_MAX_BODY_BYTES,
      },
      { method: 'GET', path: '/settings/slack/:agentId', bypassCsrf: false, maxBodyBytes: undefined },
      { method: 'GET', path: '/settings/slack/:agentId/available', bypassCsrf: false, maxBodyBytes: undefined },
      { method: 'POST', path: '/settings/slack/:agentId/connect', bypassCsrf: false, maxBodyBytes: ADMIN_BODY_MAX_BYTES },
      {
        method: 'POST',
        path: '/settings/slack/:agentId/disconnect',
        bypassCsrf: false,
        maxBodyBytes: ADMIN_BODY_MAX_BYTES,
      },
      { method: 'POST', path: '/settings/slack/:agentId/remember', bypassCsrf: false, maxBodyBytes: ADMIN_BODY_MAX_BYTES },
      // A team agent's own bot (TASK-1167): its request can carry the bot's picture, as Connect's can.
      { method: 'POST', path: '/settings/slack/:agentId/bot', bypassCsrf: false, maxBodyBytes: ADMIN_CONNECT_BODY_MAX_BYTES },
      {
        method: 'POST',
        path: '/settings/slack/:agentId/bot/install-url',
        bypassCsrf: false,
        maxBodyBytes: ADMIN_BODY_MAX_BYTES,
      },
      { method: 'POST', path: '/settings/slack/:agentId/bot/cancel', bypassCsrf: false, maxBodyBytes: ADMIN_BODY_MAX_BYTES },
      // Asking an AX admin for it instead (TASK-1169), and taking the ask back.
      { method: 'POST', path: '/settings/slack/:agentId/bot-request', bypassCsrf: false, maxBodyBytes: ADMIN_BODY_MAX_BYTES },
      {
        method: 'POST',
        path: '/settings/slack/:agentId/bot-request/cancel',
        bypassCsrf: false,
        maxBodyBytes: ADMIN_BODY_MAX_BYTES,
      },
      // Where Slack sends a bot's approver back after Allow: signed in, its OAuth state the proof.
      { method: 'GET', path: '/slack/bots/oauth/callback', bypassCsrf: false, maxBodyBytes: undefined },
    ]);
    // Nothing is written to the vault just by booting.
    expect(s.credentialSets).toBe(0);
  });

  it('an http publicOrigin boots, and status reports canConnect:false (default name "ax" without branding)', async () => {
    const { call } = await boot({ publicOrigin: HTTP_ORIGIN });
    const answer = await call('GET', '/admin/slack', request('GET', '/admin/slack', { as: ADMIN.id }));
    expect(answer).toEqual({
      status: 200,
      body: { state: 'not-connected', defaultBotName: 'ax', canConnect: false, leftoverApps: [] },
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
        leftoverApps: [],
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
    const s: Services = newServices();
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
      // The commands route answers an unknown or secretless install the same way.
      expect(await answer(`/slack/commands/${id}`), `commands ${id}`).toEqual(unserved);
      // And the interactions route (TASK-1095).
      expect(await answer(`/slack/interactions/${id}`), `interactions ${id}`).toEqual(unserved);
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

    // The reply goes out after the 200: admission, 👀 on, the turn, the stream,
    // and 👀 off once the stream is up (on its own queue, so its place relative
    // to the stop isn't fixed).
    await vi.waitFor(() =>
      expect(slack.calls.map((c) => c.method)).toEqual(expect.arrayContaining(['chat.stopStream', 'reactions.remove'])),
    );
    const methods = slack.calls.map((c) => c.method);
    for (const c of slack.calls) expect(c.auth).toBe(`Bearer ${BOT_TOKEN}`);
    expect(methods.filter((m) => !m.startsWith('reactions.'))).toEqual(['users.info', 'chat.startStream', 'chat.stopStream']);
    expect(methods.filter((m) => m.startsWith('reactions.'))).toEqual(['reactions.add', 'reactions.remove']);
    expect(methods.indexOf('reactions.add')).toBe(1);
    expect(methods.indexOf('reactions.remove')).toBeGreaterThan(methods.indexOf('chat.startStream'));
    const sentBody = (m: string) => slack.calls.find((c) => c.method === m)!.body;
    expect(sentBody('users.info')).toEqual({ user: ALICE });
    expect(sentBody('reactions.add')).toEqual({ channel: DM_CHANNEL, timestamp: DM_TS, name: 'eyes' });
    expect(sentBody('reactions.remove')).toEqual({ channel: DM_CHANNEL, timestamp: DM_TS, name: 'eyes' });
    expect(sentBody('chat.startStream')).toEqual({
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

  it("an Allow on a held call's prompt follows the woken agent's turn into the DM thread, through the plugin wiring (TASK-1095)", async () => {
    // The follow-up's wiring (`createDecisionAnswer`'s `follow`) is plugin.ts's
    // own: a no-op there leaves the Allow answered and the agent's reply nowhere.
    const slack = fakeSlackFetch();
    const { s, harness, call } = await boot({ fetchImpl: slack.fetchImpl });
    await insertActiveInstall();
    s.vault.set(secretRef(INSTALL_ID, 'signing-secret'), SIGNING_SECRET);
    s.vault.set(secretRef(INSTALL_ID, 'bot-token'), BOT_TOKEN);
    const bus = harness.bus;
    const CALL_ID = 'toolu_send';
    // Alice's turn holds a call; @ax/decisions has its pending row.
    s.turnScript = async (b, ctx) => {
      await b.fire('chat:stream-chunk', ctx, { reqId: ctx.reqId, kind: 'tool-result', toolCallId: CALL_ID, output: 'held', held: true });
      await b.fire('chat:turn-end', ctx, { reqId: ctx.reqId, reason: 'user-message-wait' });
    };
    bus.registerService('decisions:recent-for-conversation', 'fake-decisions', async (ctx) => ({
      decisions: [
        {
          id: 'dec_send',
          status: 'pending',
          summary: 'Wants to send an email',
          call: { id: CALL_ID, name: 'send_email', input: {} },
          ownerUserId: ctx.userId,
          agentId: ctx.agentId,
          conversationId: ctx.conversationId,
        },
      ],
    }));
    // decisions:approve hands the yes to the warm agent under the Allow's own continuation id.
    const approves: Array<Record<string, unknown>> = [];
    bus.registerService('decisions:approve', 'fake-decisions', async (ctx, input) => {
      const i = input as Record<string, unknown>;
      if (ctx.userId !== i['userId']) throw new Error('approve scope mismatch');
      approves.push(i);
      return {
        decision: { id: 'dec_send', status: 'executed' },
        executed: false,
        path: 'agent-executes',
        error: null,
        pendingUntil: new Date(Date.now()).toISOString(),
        streamReqId: i['continuationReqId'],
      };
    });

    const dmBody = eventBody('message', 'Email Bob');
    await call(
      'POST',
      '/slack/events/:installId',
      request('POST', `/slack/events/${INSTALL_ID}`, { params: { installId: INSTALL_ID }, body: dmBody, headers: signed(dmBody) }),
    );
    await vi.waitFor(() => expect(slack.calls.map((c) => c.method)).toContain('chat.postMessage'));
    const posted = slack.calls.find((c) => c.method === 'chat.postMessage')!;
    const actions = (posted.body['blocks'] as Array<Record<string, unknown>>).find((b) => b['type'] === 'actions')!;
    const promptId = (actions['elements'] as Array<{ value: string }>)[0]!.value;
    const promptTs = '1763039999.000002';

    // Alice clicks Allow, signed as Slack signs a click: a form with one `payload`.
    const payload = {
      type: 'block_actions',
      api_app_id: APP_ID,
      team: { id: TEAM_ID },
      user: { id: ALICE },
      channel: { id: DM_CHANNEL },
      container: { type: 'message', message_ts: promptTs, channel_id: DM_CHANNEL },
      message: { ts: promptTs, thread_ts: DM_TS },
      actions: [{ type: 'button', action_id: 'ax_prompt_allow', value: promptId }],
    };
    const clickBody = Buffer.from(new URLSearchParams({ payload: JSON.stringify(payload) }).toString());
    const mark = slack.calls.length;
    const clicked = await call(
      'POST',
      '/slack/interactions/:installId',
      request('POST', `/slack/interactions/${INSTALL_ID}`, {
        params: { installId: INSTALL_ID },
        body: clickBody,
        headers: { ...signed(clickBody), 'content-type': 'application/x-www-form-urlencoded' },
      }),
    );
    expect(clicked.status).toBe(200);
    await vi.waitFor(() => expect(slack.calls.slice(mark).map((c) => c.method)).toContain('chat.update'));
    expect(approves).toHaveLength(1);
    const continuation = approves[0]!['continuationReqId'];
    expect(typeof continuation).toBe('string');

    // The woken agent's turn, under that id, goes to Alice's DM thread.
    const woken = makeAgentContext({
      sessionId: 'sess_live',
      agentId: 'agt_alice',
      userId: 'usr_alice',
      conversationId: `conv:slack:${INSTALL_ID}:${DM_CHANNEL}:${DM_TS}`,
    });
    await bus.fire('chat:stream-chunk', woken, { reqId: continuation, kind: 'text', text: 'Sent it to Bob.' });
    await bus.fire('chat:turn-end', woken, { reqId: continuation, reason: 'user-message-wait' });
    await vi.waitFor(() => expect(slack.calls.slice(mark).map((c) => c.method)).toContain('chat.stopStream'));
    const started = slack.calls.slice(mark).find((c) => c.method === 'chat.startStream')!;
    expect(started.body).toEqual({
      channel: DM_CHANNEL,
      thread_ts: DM_TS,
      recipient_user_id: ALICE,
      recipient_team_id: TEAM_ID,
      chunks: [{ type: 'markdown_text', text: 'Sent it to Bob.' }],
    });
  });

  it("an Allow on a refused host's prompt lets it through for the turn's live session, as the asker, through the plugin wiring (TASK-1095)", async () => {
    // The host answer (`createHostAnswer`) is plugin.ts's to wire: without it
    // the click closes the prompt, and nothing is let through.
    const slack = fakeSlackFetch();
    const { s, harness, call } = await boot({ fetchImpl: slack.fetchImpl });
    await insertActiveInstall();
    s.vault.set(secretRef(INSTALL_ID, 'signing-secret'), SIGNING_SECRET);
    s.vault.set(secretRef(INSTALL_ID, 'bot-token'), BOT_TOKEN);
    const bus = harness.bus;
    // Alice's sandbox is refused a host mid-turn: chat-orchestrator fires the
    // egress wall's card under the egress proxy's ctx, naming her turn's reqId.
    s.turnScript = async (b, ctx) => {
      const egress = makeAgentContext({ sessionId: 'credential-proxy', agentId: '', userId: '' });
      await b.fire('chat:permission-request', egress, {
        kind: 'host',
        host: 'api.example.com',
        sessionId: 'sess_live',
        reqId: ctx.reqId,
      });
      await b.fire('chat:stream-chunk', ctx, { reqId: ctx.reqId, kind: 'text', text: 'I could not reach it.' });
      await b.fire('chat:turn-end', ctx, { reqId: ctx.reqId, reason: 'user-message-wait' });
    };
    const added: Array<{ userId: string; input: unknown }> = [];
    bus.registerService('proxy:add-host', 'fake-credential-proxy', async (ctx, input) => {
      added.push({ userId: ctx.userId, input });
      return { added: true, agentId: 'agt_alice' };
    });

    const dmBody = eventBody('message', 'Check the status page');
    await call(
      'POST',
      '/slack/events/:installId',
      request('POST', `/slack/events/${INSTALL_ID}`, { params: { installId: INSTALL_ID }, body: dmBody, headers: signed(dmBody) }),
    );
    await vi.waitFor(() => expect(slack.calls.map((c) => c.method)).toContain('chat.postMessage'));
    const posted = slack.calls.find((c) => c.method === 'chat.postMessage')!;
    const blocks = posted.body['blocks'] as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({ type: 'section', text: { type: 'plain_text', text: COPY.hostSubject('api.example.com'), emoji: false } });
    const actions = blocks.find((b) => b['type'] === 'actions')!;
    const promptId = (actions['elements'] as Array<{ value: string }>)[0]!.value;
    const promptTs = '1763039999.000002';
    // Asking let nothing through.
    expect(added).toEqual([]);

    // Alice clicks Allow, signed as Slack signs a click.
    const payload = {
      type: 'block_actions',
      api_app_id: APP_ID,
      team: { id: TEAM_ID },
      user: { id: ALICE },
      channel: { id: DM_CHANNEL },
      container: { type: 'message', message_ts: promptTs, channel_id: DM_CHANNEL },
      message: { ts: promptTs, thread_ts: DM_TS },
      actions: [{ type: 'button', action_id: 'ax_prompt_allow', value: promptId }],
    };
    const clickBody = Buffer.from(new URLSearchParams({ payload: JSON.stringify(payload) }).toString());
    const mark = slack.calls.length;
    const clicked = await call(
      'POST',
      '/slack/interactions/:installId',
      request('POST', `/slack/interactions/${INSTALL_ID}`, {
        params: { installId: INSTALL_ID },
        body: clickBody,
        headers: { ...signed(clickBody), 'content-type': 'application/x-www-form-urlencoded' },
      }),
    );
    expect(clicked.status).toBe(200);
    await vi.waitFor(() => expect(slack.calls.slice(mark).map((c) => c.method)).toContain('chat.update'));
    // Her own session, for exactly that host, as her.
    expect(added).toEqual([{ userId: 'usr_alice', input: { sessionId: 'sess_live', host: 'api.example.com' } }]);
    const update = slack.calls.slice(mark).find((c) => c.method === 'chat.update')!;
    expect(update.body['text']).toBe(COPY.hostAllowed);
  });

  it("an Allow on a skill prompt attaches the catalog skill for the asker, once her conversation is read back, through the plugin wiring (TASK-1095)", async () => {
    // The skill answer (`createSkillAnswer`) is plugin.ts's to wire: without it
    // the click closes the prompt, and nothing is attached.
    const slack = fakeSlackFetch();
    const { s, harness, call } = await boot({ fetchImpl: slack.fetchImpl });
    await insertActiveInstall();
    s.vault.set(secretRef(INSTALL_ID, 'signing-secret'), SIGNING_SECRET);
    s.vault.set(secretRef(INSTALL_ID, 'bot-token'), BOT_TOKEN);
    const bus = harness.bus;
    // Alice's agent asks for a catalog skill: @ax/skill-broker fires request_capability's
    // card under the runner's ctx, whose conversation is her turn's, and no reqId.
    let conversation = '';
    s.turnScript = async (b, ctx) => {
      conversation = ctx.conversationId ?? '';
      const runner = makeAgentContext({ sessionId: 'sess_live', agentId: ctx.agentId, userId: ctx.userId, conversationId: conversation });
      await b.fire('chat:stream-chunk', ctx, { reqId: ctx.reqId, kind: 'text', text: 'I need one more thing.' });
      await b.fire('chat:permission-request', runner, {
        kind: 'skill',
        skillId: 'gmail-sender',
        description: 'Reads and sends email.',
        hosts: ['gmail.googleapis.com'],
        slots: [],
        packages: { npm: [], pypi: [] },
      });
      await b.fire('chat:turn-end', ctx, { reqId: ctx.reqId, reason: 'user-message-wait' });
    };
    const called: Array<{ hook: string; userId: string; input: unknown }> = [];
    bus.registerService('conversations:get', 'fake-conversations', async (ctx, input) => {
      called.push({ hook: 'conversations:get', userId: ctx.userId, input });
      return { conversation: { conversationId: conversation, userId: 'usr_alice', agentId: 'agt_alice' }, turns: [] };
    });
    bus.registerService('agent:apply-capability-grant', 'fake-chat-orchestrator', async (ctx, input) => {
      called.push({ hook: 'agent:apply-capability-grant', userId: ctx.userId, input });
      return { attached: true };
    });

    const dmBody = eventBody('message', 'Email Bob the notes');
    await call(
      'POST',
      '/slack/events/:installId',
      request('POST', `/slack/events/${INSTALL_ID}`, { params: { installId: INSTALL_ID }, body: dmBody, headers: signed(dmBody) }),
    );
    await vi.waitFor(() => expect(slack.calls.map((c) => c.method)).toContain('chat.postMessage'));
    const posted = slack.calls.find((c) => c.method === 'chat.postMessage')!;
    const blocks = posted.body['blocks'] as Array<Record<string, unknown>>;
    // It names the host the card says the skill reaches, before the description (TASK-1135).
    expect(blocks[0]).toEqual({
      type: 'section',
      text: {
        type: 'plain_text',
        text: 'Wants to start using the gmail-sender skill, which needs to reach gmail.googleapis.com. Reads and sends email.',
        emoji: false,
      },
    });
    const actions = blocks.find((b) => b['type'] === 'actions')!;
    const promptId = (actions['elements'] as Array<{ value: string }>)[0]!.value;
    const promptTs = '1763039999.000002';
    // Asking attached nothing.
    expect(called).toEqual([]);

    // Alice clicks Allow, signed as Slack signs a click.
    const payload = {
      type: 'block_actions',
      api_app_id: APP_ID,
      team: { id: TEAM_ID },
      user: { id: ALICE },
      channel: { id: DM_CHANNEL },
      container: { type: 'message', message_ts: promptTs, channel_id: DM_CHANNEL },
      message: { ts: promptTs, thread_ts: DM_TS },
      actions: [{ type: 'button', action_id: 'ax_prompt_allow', value: promptId }],
    };
    const clickBody = Buffer.from(new URLSearchParams({ payload: JSON.stringify(payload) }).toString());
    const mark = slack.calls.length;
    const clicked = await call(
      'POST',
      '/slack/interactions/:installId',
      request('POST', `/slack/interactions/${INSTALL_ID}`, {
        params: { installId: INSTALL_ID },
        body: clickBody,
        headers: { ...signed(clickBody), 'content-type': 'application/x-www-form-urlencoded' },
      }),
    );
    expect(clicked.status).toBe(200);
    await vi.waitFor(() => expect(slack.calls.slice(mark).map((c) => c.method)).toContain('chat.update'));
    // Her own conversation read back first, then the skill attached for her, on her agent, in it.
    expect(conversation).not.toBe('');
    expect(called).toEqual([
      { hook: 'conversations:get', userId: 'usr_alice', input: { conversationId: conversation, userId: 'usr_alice' } },
      {
        hook: 'agent:apply-capability-grant',
        userId: 'usr_alice',
        input: { conversationId: conversation, userId: 'usr_alice', agentId: 'agt_alice', skillId: 'gmail-sender' },
      },
    ]);
    const update = slack.calls.slice(mark).find((c) => c.method === 'chat.update')!;
    expect(update.body['text']).toBe(COPY.skillAllowed);
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
    const queuedBefore = turnQueue.queued;
    const post = (body: Buffer) =>
      call(
        'POST',
        '/slack/events/:installId',
        request('POST', `/slack/events/${INSTALL_ID}`, { params: { installId: INSTALL_ID }, body, headers: signed(body) }),
      );
    expect((await post(eventBody('message', 'first'))).status).toBe(200);
    expect((await post(threadReplyBody('Ev07ABCDEF13', '1763035201.000200', 'second'))).status).toBe(200);
    // Both turns are in the queue (the second behind the first), and the first
    // is held at agent:invoke.
    await vi.waitFor(() => {
      expect(turnQueue.queued - queuedBefore).toBe(2);
      expect(s.invokes).toHaveLength(1);
    });
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
    // The running turn gets past agent:invoke and is done with the agent. (It
    // then waits out its turn-end grace: shutdown took its turn-end subscriber
    // with it.)
    //
    // No "only one turn reached the agent" assertion here: checked the moment
    // the first returns, it passes whether or not the dropped one would start
    // afterwards, so it proved nothing. `close()` above already said the
    // waiting one was dropped, and turn-queue.test.ts ("close drops waiting
    // jobs and refuses new ones; the running one finishes") pins that a closed
    // lane never starts it.
    await vi.waitFor(() => expect(s.invokesReturned).toBe(1));
  });

  /*
    Outsiders' turns wait in a lane of their own, one per channel. Shutdown
    drops what waits in both lanes, and says so once per install.
  */
  it("turns waiting in both lanes at shutdown are dropped, and the install's count is logged once", async () => {
    const slack = fakeSlackFetch();
    const { s, call, plugin } = await boot({ fetchImpl: slack.fetchImpl });
    await insertActiveInstall();
    s.vault.set(secretRef(INSTALL_ID, 'signing-secret'), SIGNING_SECRET);
    s.vault.set(secretRef(INSTALL_ID, 'bot-token'), BOT_TOKEN);
    // Ada, a team admin, connected #support. Alice isn't on its team, so a
    // mention from her runs as Ada.
    await createChannelStore(probe).upsert({
      installId: INSTALL_ID,
      channelId: SUPPORT_CH,
      agentId: TEAM_AGENT.id,
      connectedByUserId: ADMIN.id,
      channelName: 'support',
    });
    const gate = deferred();
    s.invokeGate = gate.promise;
    const queuedBefore = turnQueue.queued;
    const post = (body: Buffer) =>
      call(
        'POST',
        '/slack/events/:installId',
        request('POST', `/slack/events/${INSTALL_ID}`, { params: { installId: INSTALL_ID }, body, headers: signed(body) }),
      );
    // A DM and its follow-up; two mentions in #support, each starting a thread.
    expect((await post(eventBody('message', 'first'))).status).toBe(200);
    expect((await post(threadReplyBody('Ev07ABCDEF13', '1763035201.000200', 'second'))).status).toBe(200);
    expect((await post(mentionBody('Ev07ABCDEF14', '1763035300.000300', 'one'))).status).toBe(200);
    expect((await post(mentionBody('Ev07ABCDEF15', '1763035301.000301', 'two'))).status).toBe(200);
    // One running and one waiting in each lane.
    await vi.waitFor(() => {
      expect(turnQueue.queued - queuedBefore).toBe(4);
      expect(s.invokes).toHaveLength(2);
    });
    // The outsider's turn runs as the person who connected the channel, in
    // its thread's external conversation, read from the bindings on Postgres.
    // (Deliveries are dispatched side by side, so either mention may be the
    // one running.)
    const outsider = s.invokes!.find((i) => i.ctx.source === 'external');
    expect(outsider?.ctx).toMatchObject({
      userId: ADMIN.id,
      agentId: TEAM_AGENT.id,
      audience: 'shared',
      conversationId: expect.stringMatching(
        new RegExp(`^conv:slack:${INSTALL_ID}:${SUPPORT_CH}:1763035(?:300\\.000300|301\\.000301):external$`),
      ),
    });

    const logs = captureLogs();
    await plugin.shutdown?.();
    expect(logs.filter((l) => l['msg'] === 'slack_turns_dropped')).toEqual([
      expect.objectContaining({ level: 'warn', installId: INSTALL_ID, reason: 'shutting-down', count: 2 }),
    ]);
    gate.release();
    await vi.waitFor(() => expect(s.invokesReturned).toBe(2));
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

  it("a Disconnect that can't delete the Slack app keeps its id on Postgres, and the next Connect deletes it with the pasted access token: one app left (TASK-1132)", async () => {
    const calls: Array<{ method: string; auth: string | null; body: Record<string, unknown> }> = [];
    const live = new Set<string>();
    let created = 0;
    /** The refresh token Slack mints when Connect tries the pasted one (TASK-1159). */
    const minted = fakeConfigRefreshToken('E2EMINTEDREFRESH');
    const fetchImpl: typeof fetch = async (input, init) => {
      const method = String(input).replace('https://slack.com/api/', '');
      const headers = new Headers(init?.headers);
      const raw = typeof init?.body === 'string' ? init.body : '';
      const body: Record<string, unknown> = (headers.get('content-type') ?? '').startsWith('application/json')
        ? (JSON.parse(raw) as Record<string, unknown>)
        : Object.fromEntries(new URLSearchParams(raw));
      calls.push({ method, auth: headers.get('authorization'), body });
      let answer: Record<string, unknown> = { ok: true };
      if (method === 'apps.manifest.create') {
        created += 1;
        const appId = created === 1 ? 'A07FIRSTAPP1' : 'A07SECONDAP2';
        live.add(appId);
        answer = {
          ok: true,
          app_id: appId,
          credentials: {
            client_id: '7000000001.7000000002',
            client_secret: 'plugin-client-secret-not-real',
            signing_secret: SIGNING_SECRET,
          },
        };
      } else if (method === 'apps.manifest.delete') {
        live.delete(String(body['app_id']));
      } else if (method === 'tooling.tokens.rotate') {
        answer =
          body['refresh_token'] === minted
            ? // The token AX holds has since been revoked on Slack's page.
              { ok: false, error: 'invalid_refresh_token' }
            : {
                ok: true,
                token: fakeConfigAccessToken('E2EROTATEDACCESS'),
                refresh_token: minted,
                exp: 4_102_444_800,
              };
      }
      return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const { s, call } = await boot({ fetchImpl });
    const connect = () =>
      call(
        'POST',
        '/admin/slack/connect',
        request('POST', '/admin/slack/connect', {
          as: ADMIN.id,
          body: Buffer.from(
            JSON.stringify({
              accessToken: fakeConfigAccessToken(),
              refreshToken: fakeConfigRefreshToken(),
              botName: 'canopy-works',
            }),
          ),
        }),
      );

    expect((await connect()).status).toBe(200);
    expect(await installCount()).toBe(1);
    // Connect tried the pasted refresh token and kept the one Slack minted
    // (TASK-1159), as the connecting admin's own token (TASK-1175).
    const installs = await sql<{ install_id: string }>`
      SELECT install_id FROM channel_slack_v1_installs`.execute(probe);
    expect(installs.rows).toHaveLength(1);
    expect(s.vault.get(configTokenRef(ADMIN.id))).toBe(minted);

    // The stored refresh token is dead: Disconnect can't delete the app.
    const off = await call('POST', '/admin/slack/disconnect', request('POST', '/admin/slack/disconnect', { as: ADMIN.id }));
    expect(off).toMatchObject({ status: 200, body: { appDeleted: false, tokenKept: true } });
    expect(await installCount()).toBe(0);
    const left = await sql<{ install_id: string; app_id: string; bot_name: string }>`
      SELECT install_id, app_id, bot_name FROM channel_slack_v1_leftover_apps`.execute(probe);
    expect(left.rows).toHaveLength(1);
    expect(left.rows[0]).toMatchObject({ app_id: 'A07FIRSTAPP1', bot_name: 'canopy-works' });
    const status = await call('GET', '/admin/slack', request('GET', '/admin/slack', { as: ADMIN.id }));
    expect(status.body).toMatchObject({
      state: 'not-connected',
      leftoverApps: [{ botName: 'canopy-works', appId: 'A07FIRSTAPP1' }],
    });

    // The next Connect deletes it first, with the access token just pasted.
    expect((await connect()).status).toBe(200);
    const methods = calls.map((c) => c.method);
    const deleteAt = calls.findIndex(
      (c) =>
        c.method === 'apps.manifest.delete' &&
        c.auth === `Bearer ${fakeConfigAccessToken()}` &&
        c.body['app_id'] === 'A07FIRSTAPP1',
    );
    expect(deleteAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeLessThan(methods.lastIndexOf('apps.manifest.create'));
    const after = await sql`SELECT 1 FROM channel_slack_v1_leftover_apps`.execute(probe);
    expect(after.rows).toEqual([]);
    expect(await installCount()).toBe(1);
    expect([...live]).toEqual(['A07SECONDAP2']);
  });

  it("a Connect whose pasted refresh token Slack refuses keeps nothing on Postgres or in the vault; an app Slack then won't delete is remembered there, and the next Connect deletes it (TASK-1159)", async () => {
    const dead = fakeConfigRefreshToken('DEADREFRESHSECRET');
    const minted = fakeConfigRefreshToken('E2EMINTEDREFRESH2');
    let deleteRefuses = false;
    const calls: Array<{ method: string; auth: string | null; body: Record<string, unknown> }> = [];
    const live = new Set<string>();
    let created = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const method = String(input).replace('https://slack.com/api/', '');
      const headers = new Headers(init?.headers);
      const raw = typeof init?.body === 'string' ? init.body : '';
      const body: Record<string, unknown> = (headers.get('content-type') ?? '').startsWith('application/json')
        ? (JSON.parse(raw) as Record<string, unknown>)
        : Object.fromEntries(new URLSearchParams(raw));
      calls.push({ method, auth: headers.get('authorization'), body });
      let answer: Record<string, unknown> = { ok: true };
      if (method === 'apps.manifest.create') {
        created += 1;
        const appId = ['A07FIRSTAPP1', 'A07SECONDAP2', 'A07THIRDAPP3'][created - 1]!;
        live.add(appId);
        answer = {
          ok: true,
          app_id: appId,
          credentials: {
            client_id: '7000000001.7000000002',
            client_secret: 'plugin-client-secret-not-real',
            signing_secret: SIGNING_SECRET,
          },
        };
      } else if (method === 'apps.manifest.delete') {
        if (deleteRefuses) answer = { ok: false, error: 'internal_error' };
        else live.delete(String(body['app_id']));
      } else if (method === 'tooling.tokens.rotate') {
        answer =
          body['refresh_token'] === dead
            ? { ok: false, error: 'invalid_refresh_token' }
            : {
                ok: true,
                token: fakeConfigAccessToken('E2EROTATEDACCESS2'),
                refresh_token: minted,
                exp: 4_102_444_800,
              };
      }
      return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const { s, call } = await boot({ fetchImpl });
    const connect = (refreshToken: string) =>
      call(
        'POST',
        '/admin/slack/connect',
        request('POST', '/admin/slack/connect', {
          as: ADMIN.id,
          body: Buffer.from(
            JSON.stringify({ accessToken: fakeConfigAccessToken(), refreshToken, botName: 'canopy-works' }),
          ),
        }),
      );
    const leftover = () =>
      sql<{ install_id: string; app_id: string; bot_name: string }>`
        SELECT install_id, app_id, bot_name FROM channel_slack_v1_leftover_apps`.execute(probe);

    // Slack refuses the pasted refresh token and takes the new app back: nothing is kept.
    expect(await connect(dead)).toMatchObject({ status: 502, body: { error: 'slack-refresh-token' } });
    expect(await installCount()).toBe(0);
    expect((await leftover()).rows).toEqual([]);
    expect(s.vault.size).toBe(0);
    expect([...live]).toEqual([]);

    // Slack refuses that, and then won't take the app back either: the app is remembered.
    deleteRefuses = true;
    expect(await connect(dead)).toMatchObject({ status: 502, body: { error: 'slack-refresh-token' } });
    const left = await leftover();
    expect(left.rows).toHaveLength(1);
    expect(left.rows[0]).toMatchObject({ app_id: 'A07SECONDAP2', bot_name: 'canopy-works' });
    expect(left.rows[0]!.install_id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await installCount()).toBe(0);
    expect(s.vault.size).toBe(0);
    const status = await call('GET', '/admin/slack', request('GET', '/admin/slack', { as: ADMIN.id }));
    expect(status.body).toMatchObject({
      state: 'not-connected',
      leftoverApps: [{ botName: 'canopy-works', appId: 'A07SECONDAP2' }],
    });

    // A good pair: the next Connect deletes the remembered app first, then connects.
    deleteRefuses = false;
    expect((await connect(fakeConfigRefreshToken())).status).toBe(200);
    const deleteAt = calls.findIndex(
      (c) =>
        c.method === 'apps.manifest.delete' &&
        c.auth === `Bearer ${fakeConfigAccessToken()}` &&
        c.body['app_id'] === 'A07SECONDAP2',
    );
    expect(deleteAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeLessThan(calls.map((c) => c.method).lastIndexOf('apps.manifest.create'));
    expect((await leftover()).rows).toEqual([]);
    expect(await installCount()).toBe(1);
    const installs = await sql<{ install_id: string }>`
      SELECT install_id FROM channel_slack_v1_installs`.execute(probe);
    expect(installs.rows).toHaveLength(1);
    expect(s.vault.get(configTokenRef(ADMIN.id))).toBe(minted);
    expect([...live]).toEqual(['A07THIRDAPP3']);
  });

  it('"I deleted it" forgets that app on Postgres and nothing else, even while connected; the status stops naming it (TASK-1132)', async () => {
    const { call } = await boot();
    await insertActiveInstall();
    await sql`
      INSERT INTO channel_slack_v1_leftover_apps (install_id, app_id, bot_name)
      VALUES ('inst_left_1', 'A07LEFTAPP01', 'canopy'), ('inst_left_2', 'A07LEFTAPP02', 'canopy')`.execute(probe);
    const forget = await call(
      'POST',
      '/admin/slack/forget-leftover-app',
      request('POST', '/admin/slack/forget-leftover-app', {
        as: ADMIN.id,
        body: Buffer.from(JSON.stringify({ appId: 'A07LEFTAPP01' })),
      }),
    );
    expect(forget).toEqual({ status: 200, body: {}, done: true });
    const left = await sql<{ install_id: string }>`
      SELECT install_id FROM channel_slack_v1_leftover_apps`.execute(probe);
    expect(left.rows).toEqual([{ install_id: 'inst_left_2' }]);
    const status = await call('GET', '/admin/slack', request('GET', '/admin/slack', { as: ADMIN.id }));
    expect(status.body).toMatchObject({
      state: 'connected',
      leftoverApps: [{ botName: 'canopy', appId: 'A07LEFTAPP02' }],
    });
    expect(await installCount()).toBe(1);
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
    // The delete is made to skip the row (as in the next test group), so the
    // install and its secret both stay: only the reset's own `clear()` can make
    // the next request read the vault again, and the cache can't be emptied by
    // the sweep that reads and removes a removed install's secrets.
    const beforeReset = signingReads();
    await withDeleteTrigger(
      `IF OLD.install_id = '${INSTALL_ID}' THEN RETURN NULL; END IF; RETURN OLD;`,
      async () => {
        const fired = await harness.bus.fire('bootstrap:reset-cleanup', harness.ctx(), {});
        expect(fired.rejected).toBe(false);
      },
    );
    expect(await installCount()).toBe(1);
    expect(s.vault.has(secretRef(INSTALL_ID, 'signing-secret'))).toBe(true);
    expect((await post({ 'content-type': 'application/json' })).status).toBe(401);
    expect(signingReads()).toBe(beforeReset + 1);
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

  it('stopAdmission makes the interactions route answer 503 before any lookup (TASK-1095)', async () => {
    const { plugin, call } = await boot();
    await plugin.stopAdmission?.();
    const answer = await call(
      'POST',
      '/slack/interactions/:installId',
      request('POST', `/slack/interactions/${INSTALL_ID}`, { params: { installId: INSTALL_ID }, body: eventBody() }),
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
      kind: 'shared',
      hint: expect.stringContaining('api.slack.com/apps'),
    });
    expect(byId.get(UNKNOWN_ID)).toMatchObject({ appId: 'A07PENDING01', teamId: null, kind: 'shared' });
    for (const l of removed) {
      expect(String(l['hint'])).toContain('configuration token');
      expect(Object.keys(l).sort()).toEqual(
        ['appId', 'hint', 'installId', 'kind', 'level', 'msg', 'reqId', 'teamId', 'ts'],
      );
    }
    const all = JSON.stringify(logs);
    expect(all).not.toContain(SIGNING_SECRET);
    expect(all).not.toContain('7512345678901'); // client ids stay out too
  });

  /*
    A reset wipes every credential and TRUNCATEs every agent without
    announcing a delete, so a team agent's bot (TASK-1167) goes with the
    shared install: a row left behind would name a deleted agent and hold no
    secret. Its line says which kind it was, and its approver's token goes
    once nothing names them.
  */
  it("a reset removes bot installs too, logs their kind, deletes their leftover secrets and releases their approver's token", async () => {
    const { harness, s } = await boot();
    const store = createInstallStore(probe);
    // Ada's shared install, and Grace's bot for the team agent, live.
    await insertActiveInstall();
    await store.insertPendingBot({
      installId: BOT_INSTALL_ID,
      appId: BOT_APP_ID,
      clientId: '7512345678901.7522222222222',
      botName: 'support-helper',
      connectedByUserId: GRACE,
      agentId: TEAM_AGENT.id,
      requestedByUserId: GRACE,
    });
    await store.activate(BOT_INSTALL_ID, {
      teamId: TEAM_ID,
      teamName: 'Canopy Works',
      botUserId: 'U07HELPERBOT',
      installedAt: new Date(NOW_MS),
    });
    // All stored after the vault wipe, as a racing route or callback would.
    const adaRef = configTokenRef(ADMIN.id);
    const graceRef = configTokenRef(GRACE);
    const adas = fakeConfigRefreshToken('RESETBOTADASECRET');
    const graces = fakeConfigRefreshToken('RESETBOTGRACESECRET');
    const botToken = fakeBotToken('RESETBOTTOKENSECRET');
    s.vault.set(adaRef, adas);
    s.vault.set(graceRef, graces);
    s.vault.set(secretRef(BOT_INSTALL_ID, 'bot-token'), botToken);
    s.vault.set(secretRef(BOT_INSTALL_ID, 'signing-secret'), 'test-bot-signing-secret-01');
    s.vault.set(secretRef(BOT_INSTALL_ID, 'client-secret'), 'test-bot-client-secret-01');
    const logs = captureLogs();

    const fired = await harness.bus.fire('bootstrap:reset-cleanup', harness.ctx(), {});
    expect(fired.rejected).toBe(false);
    expect(await installCount()).toBe(0);

    const removed = logs.filter((l) => l['msg'] === 'slack_install_removed_by_reset');
    expect(removed.map((l) => `${String(l['installId'])}:${String(l['kind'])}`).sort()).toEqual(
      [`${INSTALL_ID}:shared`, `${BOT_INSTALL_ID}:bot`].sort(),
    );
    expect(removed.find((l) => l['installId'] === BOT_INSTALL_ID)).toMatchObject({
      level: 'warn',
      appId: BOT_APP_ID,
      teamId: TEAM_ID,
      kind: 'bot',
      hint: expect.stringContaining('api.slack.com/apps'),
    });
    for (const l of removed) {
      expect(Object.keys(l).sort()).toEqual(
        ['appId', 'hint', 'installId', 'kind', 'level', 'msg', 'reqId', 'teamId', 'ts'],
      );
    }
    // The bot's secrets go, and so does each person's token: nothing names Ada or Grace any more.
    expect([...s.vault.keys()]).toEqual([]);
    expect(s.credentialDeletes).toEqual(expect.arrayContaining([adaRef, graceRef, secretRef(BOT_INSTALL_ID, 'bot-token')]));
    // Code-only: no agent, no person, no secret.
    const all = JSON.stringify(logs);
    for (const text of [TEAM_AGENT.id, GRACE, ADMIN.id, adas, graces, botToken, 'test-bot-signing-secret-01', 'test-bot-client-secret-01']) {
      expect(all).not.toContain(text);
    }
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

  /*
    A reset takes no admin lock, and it isn't one step: credentials-store-db
    wipes the vault first, other plugins truncate their tables, and only then
    does channel-slack remove the install rows. A rename running in between
    can store the configuration refresh token Slack just minted AFTER the wipe
    and still find its row for setBotName (TASK-1129 review, F1).
  */
  it('P2 a rename that stores its new configuration token after the reset wiped the vault, but before the install row went, leaves no token behind (TASK-1129, TASK-1175)', async () => {
    // The person's own token (TASK-1175): the install's admin's. No install
    // and no leftover app names them once the reset has run.
    const ref = configTokenRef(ADMIN.id);
    const minted = fakeConfigRefreshToken('RESETRACEMINTEDSECRET');
    // Slack: the rotate waits for the test, then mints `minted`; the update is taken.
    const rotating = deferred();
    const answerRotate = deferred();
    const fetchImpl: typeof fetch = async (input) => {
      let answer: Record<string, unknown> = { ok: true };
      if (String(input) === 'https://slack.com/api/tooling.tokens.rotate') {
        rotating.release();
        await answerRotate.promise;
        answer = {
          ok: true,
          token: fakeConfigAccessToken('RESETRACEACCESSSECRET'),
          refresh_token: minted,
          exp: Math.floor(NOW_MS / 1000) + 43_200,
        };
      }
      return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const { s, call, harness } = await boot({ fetchImpl });
    await insertActiveInstall();
    s.vault.set(ref, fakeConfigRefreshToken());
    // The reset's first steps, as a real one runs them before channel-slack's
    // subscriber: the vault wipe, then a pause standing in for the TRUNCATEs.
    const wiped = deferred();
    const truncated = deferred();
    harness.bus.subscribe(
      'bootstrap:reset-cleanup',
      'test/credentials-wipe',
      async () => {
        s.vault.clear();
        wiped.release();
        await truncated.promise;
        return undefined;
      },
      { priority: -1 },
    );

    const renamed = call(
      'POST',
      '/admin/slack/rename',
      request('POST', '/admin/slack/rename', {
        as: ADMIN.id,
        body: Buffer.from(JSON.stringify({ botName: 'Raced Name' })),
      }),
    );
    await rotating.promise; // the stored token is read and sent to Slack
    const reset = harness.bus.fire('bootstrap:reset-cleanup', harness.ctx(), {});
    await wiped.promise; // the vault is empty; the install row is still there
    answerRotate.release();
    // The row was still there for setBotName, so the rename worked...
    expect(await renamed).toEqual({ status: 200, body: { botName: 'Raced Name' }, done: true });
    // ...and stored the token Slack minted after the wipe.
    expect(s.vault.get(ref)).toBe(minted);

    truncated.release();
    expect((await reset).rejected).toBe(false);
    expect(await installCount()).toBe(0);
    // It goes with the install's row: no route could ever reach it again.
    expect(s.vault.has(ref)).toBe(false);
    // Only what was still stored is deleted (see the next test).
    expect(s.credentialDeletes).toEqual([ref]);
  });

  it('a reset deletes none of the secrets the vault wipe already took, so it writes no tombstone rows (TASK-1129)', async () => {
    // The vault deletes by writing an empty row in a secret's place, and
    // `ax admin reset-bootstrap` must leave no credential rows behind.
    const { harness, s } = await boot();
    await insertActiveInstall();
    const fired = await harness.bus.fire('bootstrap:reset-cleanup', harness.ctx(), {});
    expect(fired.rejected).toBe(false);
    expect(await installCount()).toBe(0);
    expect(s.credentialDeletes).toEqual([]);
  });

  it('a secret the reset finds still stored but cannot delete never fails it: logged by install, name and code only (TASK-1129)', async () => {
    const { harness, s } = await boot();
    await insertActiveInstall();
    const configRef = secretRef(INSTALL_ID, 'config-refresh-token');
    const botRef = secretRef(INSTALL_ID, 'bot-token');
    // Both stored after the vault wipe, as a racing rename or OAuth callback would.
    const leftover = fakeConfigRefreshToken('RESETLEFTOVERSECRET');
    s.vault.set(configRef, leftover);
    s.vault.set(botRef, BOT_TOKEN);
    s.vaultFailures.set(
      `credentials:delete ${configRef}`,
      Object.assign(new Error(`vault down holding ${leftover}`), { code: 'ECONNRESET' }),
    );
    // A read that fails is no proof the secret is gone: it is deleted anyway.
    s.vaultFailures.set(
      `credentials:get ${botRef}`,
      Object.assign(new Error(`vault down holding ${BOT_TOKEN}`), { code: 'ECONNRESET' }),
    );
    const logs = captureLogs();

    const fired = await harness.bus.fire('bootstrap:reset-cleanup', harness.ctx(), {});
    expect(fired.rejected).toBe(false);
    expect(await installCount()).toBe(0);
    expect(logs.filter((l) => l['msg'] === 'slack_install_removed_by_reset').map((l) => l['installId'])).toEqual([
      INSTALL_ID,
    ]);
    expect(s.credentialDeletes).toEqual([botRef, configRef]);
    expect(s.vault.has(botRef)).toBe(false);

    const failed = logs.filter((l) => l['msg'] === 'slack_secret_remove_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      // An install's old per-install row (TASK-1175): a warning; a person's token's stage is its own.
      level: 'warn',
      installId: INSTALL_ID,
      stage: 'config-refresh-token',
      code: 'ECONNRESET',
    });
    expect(Object.keys(failed[0]!).sort()).toEqual(['code', 'installId', 'level', 'msg', 'reqId', 'stage', 'ts']);
    expect(logs.filter((l) => l['msg'] === 'slack_reset_cleanup_failed')).toEqual([]);
    const all = JSON.stringify(logs);
    for (const secret of [leftover, BOT_TOKEN, 'vault down']) expect(all).not.toContain(secret);
  });

  it('a log line that throws during a reset still leaves no secret behind (TASK-1129)', async () => {
    const { harness, s } = await boot();
    await insertActiveInstall();
    const configRef = secretRef(INSTALL_ID, 'config-refresh-token');
    s.vault.set(configRef, fakeConfigRefreshToken('RESETLOGTHROWSSECRET'));
    // The logger writes JSON lines to stdout: make the "removed" line throw.
    const write = process.stdout.write.bind(process.stdout);
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      if (String(chunk).includes('slack_install_removed_by_reset')) throw new Error('log sink is down');
      return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write);

    const fired = await harness.bus.fire('bootstrap:reset-cleanup', harness.ctx(), {});
    expect(fired.rejected).toBe(false);
    expect(await installCount()).toBe(0);
    expect(s.vault.has(configRef)).toBe(false);
    expect(s.credentialDeletes).toEqual([configRef]);
  });

  /*
    TASK-1175: one configuration token per person, under
    `slack:person:<userId>:config-refresh-token`. The vault wipe takes every
    person's token, and `removeAll` takes the installs but never the leftover
    apps (they are still on Slack, and only their maker's token can delete
    them). So the one person token a reset can find is one a racing route
    stored after the wipe: it goes unless an install or a leftover app still
    names its person. And at boot, before any route can use a token, each
    install's old per-install token moves to its person (config-tokens.ts).
  */
  it('P3 a reset takes a re-stored token whose person nothing names any more, and keeps one a leftover app still names (TASK-1175)', async () => {
    const { harness, s } = await boot();
    const store = createInstallStore(probe);
    // Ada's install, and an app of hers an earlier Disconnect couldn't delete.
    await insertActiveInstall();
    await store.rememberLeftoverApp({
      installId: LEFTOVER_ID,
      appId: 'A07LEFTOVER1',
      botName: 'old-bot',
      connectedByUserId: ADMIN.id,
    });
    // Grace's unfinished install, and nothing else of hers.
    await store.insertPending({
      installId: GRACE_INSTALL_ID,
      appId: 'A07GRACEAPP1',
      clientId: '7512345678901.7511111111111',
      botName: 'grace-bot',
      connectedByUserId: GRACE,
    });
    // Both stored after the vault wipe, as a racing rename would.
    const adaRef = configTokenRef(ADMIN.id);
    const graceRef = configTokenRef(GRACE);
    const adas = fakeConfigRefreshToken('RESETKEPTFORLEFTOVERSECRET');
    s.vault.set(adaRef, adas);
    s.vault.set(graceRef, fakeConfigRefreshToken('RESETNOONENAMESSECRET'));

    const fired = await harness.bus.fire('bootstrap:reset-cleanup', harness.ctx(), {});
    expect(fired.rejected).toBe(false);
    expect(await installCount()).toBe(0);
    // The leftover app is still listed, still Ada's: the reset never takes one.
    expect(await store.leftoverApps()).toEqual([
      expect.objectContaining({ installId: LEFTOVER_ID, appId: 'A07LEFTOVER1', connectedByUserId: ADMIN.id }),
    ]);
    // So Ada's token stays: it is how that app gets deleted. Grace's goes.
    expect(s.vault.get(adaRef)).toBe(adas);
    expect(s.vault.has(graceRef)).toBe(false);
    expect(s.credentialDeletes).toEqual([graceRef]);
  });

  it("P6 a reset whose check of who still names a person fails keeps that person's token, and logs only the install, the stage and a code (TASK-1175)", async () => {
    const { harness, s } = await boot();
    await insertActiveInstall();
    const personRef = configTokenRef(ADMIN.id);
    const kept = fakeConfigRefreshToken('RESETCHECKFAILSSECRET');
    s.vault.set(personRef, kept);
    // The check reads the leftover list, which deleting the installs never
    // touches: without that table, only the check fails.
    await sql`ALTER TABLE channel_slack_v1_leftover_apps RENAME TO channel_slack_test_hidden_leftovers`.execute(probe);
    try {
      const logs = captureLogs();
      const fired = await harness.bus.fire('bootstrap:reset-cleanup', harness.ctx(), {});
      expect(fired.rejected).toBe(false);
      expect(await installCount()).toBe(0);
      // Not knowing whether an app still needs it, the token stays (re-running the reset wipes it).
      expect(s.vault.get(personRef)).toBe(kept);
      expect(s.credentialDeletes).toEqual([]);
      const failed = logs.filter((l) => l['msg'] === 'slack_reset_cleanup_failed');
      expect(failed).toEqual([
        // Postgres's undefined_table: its code, never its message.
        expect.objectContaining({ level: 'error', installId: INSTALL_ID, stage: 'release-config-token', code: '42P01' }),
      ]);
      expect(Object.keys(failed[0]!).sort()).toEqual(['code', 'installId', 'level', 'msg', 'reqId', 'stage', 'ts']);
      const all = JSON.stringify(logs);
      for (const text of [kept, ADMIN.id, 'channel_slack_test_hidden_leftovers']) expect(all).not.toContain(text);
    } finally {
      await sql`ALTER TABLE channel_slack_test_hidden_leftovers RENAME TO channel_slack_v1_leftover_apps`.execute(probe);
    }
  });

  it("P7 a reset takes the token of every person it removed an install of, reading each person's once (TASK-1175)", async () => {
    const { harness, s } = await boot();
    const store = createInstallStore(probe);
    // Two installs of Ada's, one of Grace's.
    await insertActiveInstall();
    await store.insertPending({
      installId: UNKNOWN_ID,
      appId: 'A07PENDING01',
      clientId: '7512345678901.7500000000000',
      botName: 'pending-bot',
      connectedByUserId: ADMIN.id,
    });
    await store.insertPending({
      installId: GRACE_INSTALL_ID,
      appId: 'A07GRACEAPP1',
      clientId: '7512345678901.7511111111111',
      botName: 'grace-bot',
      connectedByUserId: GRACE,
    });
    const adaRef = configTokenRef(ADMIN.id);
    const graceRef = configTokenRef(GRACE);
    s.vault.set(adaRef, fakeConfigRefreshToken('RESETADASECRET'));
    s.vault.set(graceRef, fakeConfigRefreshToken('RESETGRACESECRET'));

    const fired = await harness.bus.fire('bootstrap:reset-cleanup', harness.ctx(), {});
    expect(fired.rejected).toBe(false);
    expect(await installCount()).toBe(0);
    expect(s.vault.has(adaRef)).toBe(false);
    expect(s.vault.has(graceRef)).toBe(false);
    expect([...s.credentialDeletes].sort()).toEqual([adaRef, graceRef].sort());
    expect(s.credentialGets.filter((ref) => ref === adaRef)).toHaveLength(1);
    expect(s.credentialGets.filter((ref) => ref === graceRef)).toHaveLength(1);
  });

  it("P1 the first boot moves an install's configuration token to its admin's own place; the next boot does nothing (TASK-1175)", async () => {
    await runMigrations(probe);
    await insertActiveInstall();
    const oldRef = secretRef(INSTALL_ID, 'config-refresh-token');
    const personRef = configTokenRef(ADMIN.id);
    const old = fakeConfigRefreshToken('BOOTMOVEOLDSECRET');
    const logs = captureLogs();

    const first = await boot({}, {
      seed: (s) => {
        s.vault.set(oldRef, old);
      },
    });
    expect(first.s.vault.get(personRef)).toBe(old);
    expect(first.s.vault.has(oldRef)).toBe(false);
    const moved = logs.filter((l) => l['msg'] === 'slack_config_tokens_moved');
    expect(moved).toEqual([expect.objectContaining({ level: 'info', moved: 1, dropped: 0 })]);
    // Counts only: never a token, never a person.
    expect(Object.keys(moved[0]!).sort()).toEqual(['dropped', 'level', 'moved', 'msg', 'reqId', 'ts']);
    for (const text of [old, ADMIN.id]) expect(JSON.stringify(logs)).not.toContain(text);

    // The next boot: the token is already the person's, and no old one is left.
    await first.harness.close({ onError: () => {} });
    const mark = logs.length;
    const second = await boot({}, {
      seed: (s) => {
        s.vault.set(personRef, old);
      },
    });
    expect(second.s.credentialSets).toBe(0);
    expect(second.s.credentialDeletes).toEqual([]);
    expect(second.s.vault.get(personRef)).toBe(old);
    expect(logs.slice(mark).filter((l) => l['msg'] === 'slack_config_tokens_moved')).toEqual([]);
  });

  it('P4 the boot move runs after the migrations and before any route is registered (TASK-1175)', async () => {
    // An installs table from before a column the move reads (TASK-1128's
    // config_token_added_at): until this boot's migrations add it back, no
    // install can be listed.
    await runMigrations(probe);
    await insertActiveInstall();
    await sql`ALTER TABLE channel_slack_v1_installs DROP COLUMN config_token_added_at`.execute(probe);
    const oldRef = secretRef(INSTALL_ID, 'config-refresh-token');
    const personRef = configTokenRef(ADMIN.id);
    const old = fakeConfigRefreshToken('BOOTORDEROLDSECRET');
    // The vault as the first route to register finds it: routes serve as soon as they register.
    let atFirstRoute: Map<string, string> | undefined;

    const { s } = await boot({}, {
      seed: (s) => {
        s.vault.set(oldRef, old);
        s.onRegisterRoute = () => {
          atFirstRoute ??= new Map(s.vault);
        };
      },
    });
    expect(s.routes).toHaveLength(25);
    expect(atFirstRoute?.get(personRef)).toBe(old);
    expect(atFirstRoute?.has(oldRef)).toBe(false);
  });

  it('P5 a vault fault in the boot move never fails the boot: every route registers, the old token waits for the next boot, and the line names only the install, the stage and a code (TASK-1175)', async () => {
    await runMigrations(probe);
    await insertActiveInstall();
    const oldRef = secretRef(INSTALL_ID, 'config-refresh-token');
    const personRef = configTokenRef(ADMIN.id);
    const old = fakeConfigRefreshToken('BOOTFAULTOLDSECRET');
    const logs = captureLogs();

    const { s } = await boot({}, {
      seed: (s) => {
        s.vault.set(oldRef, old);
        s.vaultFailures.set(
          `credentials:get ${personRef}`,
          Object.assign(new Error(`vault down holding ${old}`), { code: 'ECONNRESET' }),
        );
      },
    });
    expect(s.routes).toHaveLength(25);
    // Nothing stored and nothing deleted: the next boot tries again.
    expect(s.vault.get(oldRef)).toBe(old);
    expect(s.vault.has(personRef)).toBe(false);
    expect(s.credentialSets).toBe(0);
    expect(s.credentialDeletes).toEqual([]);
    const failed = logs.filter((l) => l['msg'] === 'slack_config_token_move_failed');
    expect(failed).toEqual([
      expect.objectContaining({ level: 'error', installId: INSTALL_ID, stage: 'read-person-token', code: 'ECONNRESET' }),
    ]);
    expect(Object.keys(failed[0]!).sort()).toEqual(['code', 'installId', 'level', 'msg', 'reqId', 'stage', 'ts']);
    expect(logs.filter((l) => l['msg'] === 'slack_config_tokens_moved')).toEqual([]);
    const all = JSON.stringify(logs);
    for (const text of [old, 'vault down', ADMIN.id]) expect(all).not.toContain(text);
  });

  it('P8 with moveConfigTokens: false (the CLI reset), the boot moves nothing: only the host does (TASK-1175)', async () => {
    await runMigrations(probe);
    await insertActiveInstall();
    const oldRef = secretRef(INSTALL_ID, 'config-refresh-token');
    const personRef = configTokenRef(ADMIN.id);
    const old = fakeConfigRefreshToken('BOOTNOMOVEOLDSECRET');
    const logs = captureLogs();

    const { s } = await boot({ moveConfigTokens: false }, {
      seed: (s) => {
        s.vault.set(oldRef, old);
      },
    });
    expect(s.routes).toHaveLength(25);
    // Not even read: the old row stays the install's, for the host's next boot.
    expect(s.credentialGets).toEqual([]);
    expect(s.credentialSets).toBe(0);
    expect(s.credentialDeletes).toEqual([]);
    expect(s.vault.get(oldRef)).toBe(old);
    expect(s.vault.has(personRef)).toBe(false);
    expect(logs.filter((l) => String(l['msg']).startsWith('slack_config_token'))).toEqual([]);
  });

  it("P9 a reset that can't read a person's token deletes it anyway, and says so in one warning: the install, the stage and a code (TASK-1175)", async () => {
    const { harness, s } = await boot();
    await insertActiveInstall();
    const personRef = configTokenRef(ADMIN.id);
    const kept = fakeConfigRefreshToken('RESETREADFAILSSECRET');
    s.vault.set(personRef, kept);
    s.vaultFailures.set(
      `credentials:get ${personRef}`,
      Object.assign(new Error(`vault down holding ${kept}`), { code: 'ECONNRESET' }),
    );
    const logs = captureLogs();

    const fired = await harness.bus.fire('bootstrap:reset-cleanup', harness.ctx(), {});
    expect(fired.rejected).toBe(false);
    expect(s.vault.has(personRef)).toBe(false);
    expect(s.credentialDeletes).toEqual([personRef]);
    const failed = logs.filter((l) => l['msg'] === 'slack_reset_cleanup_failed');
    expect(failed).toEqual([
      expect.objectContaining({ level: 'warn', installId: INSTALL_ID, stage: 'read-config-token', code: 'ECONNRESET' }),
    ]);
    expect(Object.keys(failed[0]!).sort()).toEqual(['code', 'installId', 'level', 'msg', 'reqId', 'stage', 'ts']);
    const all = JSON.stringify(logs);
    for (const text of [kept, 'vault down', ADMIN.id]) expect(all).not.toContain(text);
  });

  it('the settings routes are mounted behind the person and the agent: 401 signed out, 404 to an outsider, the section to a team admin', async () => {
    const { call } = await boot();
    const path = '/settings/slack/:agentId';
    const get = (as?: string, agentId: string = TEAM_AGENT.id) =>
      call('GET', path, request('GET', `/settings/slack/${agentId}`, { ...(as !== undefined ? { as } : {}), params: { agentId } }));
    expect((await get()).status).toBe(401);
    expect(await get('usr_bob')).toEqual({ status: 404, body: { error: 'not-found' }, done: true });
    expect(await get(ADMIN.id, 'agt_nobody')).toEqual({ status: 404, body: { error: 'not-found' }, done: true });
    // No workspace is connected yet.
    expect(await get(ADMIN.id)).toEqual({
      status: 200,
      body: { state: 'no-workspace', bot: { state: 'none', configTokenStored: false } },
      done: true,
    });
    await insertActiveInstall();
    expect(await get(ADMIN.id)).toMatchObject({
      status: 200,
      body: { state: 'ready', canManage: true, channels: [] },
    });
  });

  it('the bot callback is mounted: signed out it redirects to /?slack-bot=failed', async () => {
    const { call, s } = await boot();
    const path = '/slack/bots/oauth/callback';
    expect(await call('GET', path, request('GET', path, { query: { state: 'x' } }))).toEqual({
      status: 302,
      body: 'https://ax.example/?slack-bot=failed',
      done: true,
    });
    // Turned away before anything is read.
    expect(s.credentialGets).toEqual([]);
  });

  it('deleting an agent removes its channel bindings, through the real store on Postgres', async () => {
    const { harness } = await boot();
    await insertActiveInstall();
    const channels = createChannelStore(probe);
    const bound = { installId: INSTALL_ID, agentId: TEAM_AGENT.id, connectedByUserId: ADMIN.id, channelName: 'support-desk' };
    await channels.upsert({ ...bound, channelId: SUPPORT_CH });
    await channels.upsert({ ...bound, agentId: 'agt_other', channelId: 'C07OTHER002' });

    await harness.bus.fire('agents:deleted', harness.ctx(), {
      agentId: TEAM_AGENT.id,
      ownerId: 'team_support',
      ownerType: 'team',
    });

    expect((await channels.listAll(INSTALL_ID)).map((b) => b.channelId)).toEqual(['C07OTHER002']);
  });

  it("deleting a team agent deletes its own Slack bot through the wiring, after the Admin › Slack step that holds the one app lock (TASK-1167)", async () => {
    const adas = fakeConfigRefreshToken('ONELOCKADASECRET');
    const graces = fakeConfigRefreshToken('ONELOCKGRACESECRET');
    const calls: Array<{ method: string; auth: string | null; body: Record<string, string> }> = [];
    let rotates = 0;
    let releaseSharedDelete!: () => void;
    const sharedDelete = new Promise<void>((resolve) => {
      releaseSharedDelete = resolve;
    });
    const fetchImpl: typeof fetch = async (input, init) => {
      const method = String(input).replace('https://slack.com/api/', '');
      const body = Object.fromEntries(new URLSearchParams(typeof init?.body === 'string' ? init.body : ''));
      calls.push({ method, auth: new Headers(init?.headers).get('authorization'), body });
      let answer: Record<string, unknown> = { ok: true };
      if (method === 'tooling.tokens.rotate') {
        rotates += 1;
        answer = {
          ok: true,
          token: fakeConfigAccessToken(`ONELOCKACCESS${rotates}`),
          refresh_token: fakeConfigRefreshToken(`ONELOCKREFRESH${rotates}`),
          exp: 4_102_444_800,
        };
      }
      // Slack is slow to delete the shared app, so Ada's Disconnect holds the app lock until the test lets it go.
      if (method === 'apps.manifest.delete' && body['app_id'] === APP_ID) await sharedDelete;
      return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const { s, call, harness } = await boot({ fetchImpl });
    // Ada's shared app, and Grace's bot for the team agent, both live, each made with its person's own token.
    await insertActiveInstall();
    const store = createInstallStore(probe);
    await store.insertPendingBot({
      installId: BOT_INSTALL_ID,
      appId: BOT_APP_ID,
      clientId: '7512345678901.7522222222222',
      botName: 'support-helper',
      connectedByUserId: GRACE,
      agentId: TEAM_AGENT.id,
      requestedByUserId: GRACE,
    });
    await store.activate(BOT_INSTALL_ID, {
      teamId: TEAM_ID,
      teamName: 'Canopy Works',
      botUserId: 'U07HELPERBOT',
      installedAt: new Date(NOW_MS),
    });
    s.vault.set(configTokenRef(ADMIN.id), adas);
    s.vault.set(configTokenRef(GRACE), graces);
    s.vault.set(secretRef(BOT_INSTALL_ID, 'bot-token'), fakeBotToken('ONELOCKBOTSECRET'));
    s.vault.set(secretRef(BOT_INSTALL_ID, 'signing-secret'), 'test-bot-signing-secret-02');
    s.vault.set(secretRef(BOT_INSTALL_ID, 'client-secret'), 'test-bot-client-secret-02');
    // A channel of the agent's on the shared app: it goes as soon as the agent's cleanup starts.
    const channels = createChannelStore(probe);
    await channels.upsert({
      installId: INSTALL_ID,
      channelId: SUPPORT_CH,
      agentId: TEAM_AGENT.id,
      connectedByUserId: ADMIN.id,
      channelName: 'support',
    });

    const disconnecting = call('POST', '/admin/slack/disconnect', request('POST', '/admin/slack/disconnect', { as: ADMIN.id }));
    await vi.waitFor(() => expect(calls.map((c) => c.method)).toContain('apps.manifest.delete'));
    const deleting = harness.bus.fire('agents:deleted', harness.ctx(), {
      agentId: TEAM_AGENT.id,
      ownerId: 'team_support',
      ownerType: 'team',
    });
    // The agent's channel goes at once; its bot waits for the lock. The pause
    // only gives a removal that didn't wait time to show it: with the one
    // lock, nothing below depends on how long it is.
    await vi.waitFor(async () => expect(await channels.listAll(INSTALL_ID)).toEqual([]));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(s.credentialGets).not.toContain(configTokenRef(GRACE));
    expect(calls.map((c) => c.method)).toEqual(['tooling.tokens.rotate', 'apps.manifest.delete']);

    releaseSharedDelete();
    expect(await disconnecting).toMatchObject({ status: 200, body: { appDeleted: true, tokenKept: false } });
    expect((await deleting).rejected).toBe(false);
    // Then Grace's own token is rotated, and the access token minted with it deletes the bot's app.
    expect(calls.map((c) => [c.method, c.body['refresh_token'] ?? c.body['app_id']])).toEqual([
      ['tooling.tokens.rotate', adas],
      ['apps.manifest.delete', APP_ID],
      ['tooling.tokens.rotate', graces],
      ['apps.manifest.delete', BOT_APP_ID],
    ]);
    expect(calls[3]!.auth).toBe(`Bearer ${fakeConfigAccessToken('ONELOCKACCESS2')}`);
    // Both apps' rows, the bot's secrets and both people's tokens are gone.
    expect(await installCount()).toBe(0);
    expect([...s.vault.keys()]).toEqual([]);
  });

  it('the memory switch through the wiring: a turn while it is off keeps its thread out of memory for good; a new thread is remembered', async () => {
    const slack = fakeSlackFetch();
    const { s, call, harness } = await boot({ fetchImpl: slack.fetchImpl });
    await insertActiveInstall();
    s.vault.set(secretRef(INSTALL_ID, 'signing-secret'), SIGNING_SECRET);
    s.vault.set(secretRef(INSTALL_ID, 'bot-token'), BOT_TOKEN);
    const channels = createChannelStore(probe);
    await channels.upsert({
      installId: INSTALL_ID,
      channelId: SUPPORT_CH,
      agentId: TEAM_AGENT.id,
      connectedByUserId: ADMIN.id,
      channelName: 'support',
    });
    expect(await channels.setRemember(INSTALL_ID, SUPPORT_CH, TEAM_AGENT.id, false)).toBe(true);
    const post = (body: Buffer) =>
      call(
        'POST',
        '/slack/events/:installId',
        request('POST', `/slack/events/${INSTALL_ID}`, { params: { installId: INSTALL_ID }, body, headers: signed(body) }),
      );

    // Ada is on the agent's team: her mention runs attended, as her, in her own conversation for the thread.
    expect((await post(mentionBody('Ev07ABCDEF20', '1763035300.000300', 'remember my number is 4417', ADA_SLACK))).status).toBe(
      200,
    );
    await vi.waitFor(() => expect(s.invokesReturned).toBe(1));
    const offThread = `conv:slack:${INSTALL_ID}:${SUPPORT_CH}:1763035300.000300`;
    expect(s.invokes![0]!.ctx).toMatchObject({ conversationId: offThread, userId: ADMIN.id, source: 'user' });
    // Her label's names are kept with the thread (TASK-1146): users.info's name for her, then her Slack id.
    expect(await channels.getThread(offThread)).toEqual({
      installId: INSTALL_ID,
      channelId: SUPPORT_CH,
      agentId: TEAM_AGENT.id,
      notRemembered: true,
      external: false,
      speakerNames: ['Ada', ADA_SLACK],
    });
    expect(await askMemory(harness.bus, offThread)).toEqual(NOT_REMEMBERED);

    // On again: that thread stays out of memory; a conversation Slack never had gets no opinion.
    expect(await channels.setRemember(INSTALL_ID, SUPPORT_CH, TEAM_AGENT.id, true)).toBe(true);
    expect(await askMemory(harness.bus, offThread)).toEqual(NOT_REMEMBERED);
    expect(await askMemory(harness.bus, 'conv_web_chat')).toEqual({ rejected: false, payload: { conversationId: 'conv_web_chat' } });

    // A new thread, started while the switch is on, is remembered, and memory hears who speaks in it.
    expect((await post(mentionBody('Ev07ABCDEF21', '1763035400.000400', 'a new question', ADA_SLACK))).status).toBe(200);
    await vi.waitFor(() => expect(s.invokesReturned).toBe(2));
    const onThread = `conv:slack:${INSTALL_ID}:${SUPPORT_CH}:1763035400.000400`;
    expect(s.invokes![1]!.ctx.conversationId).toBe(onThread);
    expect(await askMemory(harness.bus, onThread)).toEqual({
      rejected: false,
      payload: { conversationId: onThread, speakerNames: ['Ada', ADA_SLACK] },
    });

    // Alice isn't on the team: her mention runs as Ada, in the thread's external conversation, and
    // what she says is never remembered, with the switch on.
    expect((await post(mentionBody('Ev07ABCDEF22', '1763035500.000500', 'the refund window is 90 days'))).status).toBe(200);
    await vi.waitFor(() => expect(s.invokesReturned).toBe(3));
    const outsiderThread = `conv:slack:${INSTALL_ID}:${SUPPORT_CH}:1763035500.000500:external`;
    expect(s.invokes![2]!.ctx).toMatchObject({ conversationId: outsiderThread, userId: ADMIN.id, source: 'external' });
    expect((await channels.getThread(outsiderThread))?.external).toBe(true);
    // Nothing of Alice's is kept: memory never learns from her thread, so it needs no names.
    expect((await channels.getThread(outsiderThread))?.speakerNames).toEqual([]);
    expect(await askMemory(harness.bus, outsiderThread)).toEqual(OUTSIDER_THREAD);
  });

  it('the memory veto is on the bus before the database: a pass while init waits for it is answered once the store is ready', async () => {
    // A thread kept out of memory before this restart.
    await runMigrations(probe);
    await keptOutThread('conv_kept_out');
    const s: Services = newServices();
    const services = fakeServices(s);
    const inner = new HookBus();
    const db: Plugin = createDatabasePostgresPlugin({ connectionString });
    await db.init({ bus: inner, config: {} });
    const bus = new HookBus();
    const gate = deferred();
    bus.registerService('database:get-instance', 'mock', async (ctx, input) => {
      await gate.promise;
      return inner.call('database:get-instance', ctx, input);
    });
    for (const hook of ['http:register-route', 'auth:require-user', 'credentials:get', 'credentials:set', 'credentials:delete'] as const) {
      bus.registerService<unknown, unknown>(hook, 'mock', services[hook]);
    }
    const plugin = createChannelSlackPlugin({ publicOrigin: HTTPS_ORIGIN });
    try {
      const starting = plugin.init({ bus, config: {} });
      // Memory asks while channel-slack is still waiting for its database.
      const asked = askMemory(bus, 'conv_kept_out');
      gate.release();
      await starting;
      expect(await asked).toEqual(NOT_REMEMBERED);
    } finally {
      await plugin.shutdown?.();
      await db.shutdown?.();
    }
  });

  it('shutdown leaves the memory veto answering: a turn that ends during shutdown can still start a memory pass', async () => {
    const { plugin, harness } = await boot();
    await keptOutThread('conv_kept_out');
    await plugin.shutdown?.();
    expect(await askMemory(harness.bus, 'conv_kept_out')).toEqual(NOT_REMEMBERED);
  });

  it('shutdown unregisters every route, the reset and chat subscribers, and is safe to call twice', async () => {
    const { s, plugin, harness } = await boot();
    await plugin.shutdown?.();
    expect(s.routes).toHaveLength(25);
    for (const r of s.routes) expect(r.unregister, `${r.method} ${r.path}`).toHaveBeenCalledTimes(1);
    for (const hook of TURN_EVENT_HOOKS) expect(harness.bus.unsubscribe(hook, TURN_EVENTS_KEY), hook).toBe(0);
    expect(harness.bus.unsubscribe('agents:deleted', AGENTS_DELETED_KEY)).toBe(0);
    // The bus can't take a service back: the system-prompt contribution stays, and with no turn it adds nothing.
    expect(harness.bus.hasService('system-prompt:augment:optional:slack')).toBe(true);
    expect(await harness.bus.call('system-prompt:augment:optional:slack', harness.ctx(), {})).toEqual({});

    await insertActiveInstall();
    await harness.bus.fire('bootstrap:reset-cleanup', harness.ctx(), {});
    expect(await installCount()).toBe(1);

    await plugin.shutdown?.();
    for (const r of s.routes) expect(r.unregister).toHaveBeenCalledTimes(1);
  });

  it('a failed route registration unwinds the routes already registered', async () => {
    const plugin = createChannelSlackPlugin({ publicOrigin: HTTPS_ORIGIN });
    const s: Services = newServices();
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
      // No reset, chat or memory subscriber is left behind either: a plugin that never started vetoes nothing.
      for (const hook of TURN_EVENT_HOOKS) expect(bus.unsubscribe(hook, TURN_EVENTS_KEY), hook).toBe(0);
      expect(bus.unsubscribe('agents:deleted', AGENTS_DELETED_KEY)).toBe(0);
      expect(bus.unsubscribe('memory:pre-capture', CAPTURE_VETO_KEY)).toBe(0);
      // Nor its system-prompt contribution, which the bus could never take back (TASK-1131).
      expect(bus.hasService('system-prompt:augment:optional:slack')).toBe(false);
      await insertActiveInstall();
      await bus.fire('bootstrap:reset-cleanup', makeAgentContext({ sessionId: 't', agentId: 't', userId: 't' }), {});
      expect(await installCount()).toBe(1);
    } finally {
      await db.shutdown?.();
    }
  });
});
