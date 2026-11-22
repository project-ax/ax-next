import { createHmac } from 'node:crypto';
import { crc32 } from 'node:zlib';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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
  SYSTEM_PROMPT_AUGMENT_OPTIONAL_PREFIX,
} from '@ax/core';
import type { CreateOutput as AgentCreateOutput } from '@ax/agents';
import { startTestContainer, stopPostgresContainer } from '@ax/test-harness';

import { createK8sPlugins, type K8sPresetConfig } from '../index.js';

// ---------------------------------------------------------------------------
// TASK-1093 -- @ax/channel-slack composition canary (Invariant 3: no
// half-wired plugins).
//
// One flow through the preset's OWN plugins: the real @ax/channel-slack (its
// admin routes, OAuth callback and events route, and a team agent's own bot, the
// only way a channel reaches an agent), the real @ax/agents (the personal agents
// a Slack DM reaches, and the team agents a channel's own bot answers as), the real @ax/teams
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
// TASK-1095: a call held in a DM or an attended thread gets an Allow/Deny
// prompt in the thread. The click comes back on the interactions route, signed
// like a real one, and the real @ax/decisions answers it.
//
// TASK-1095 (permission cards): a host the sandbox was refused, and a catalog skill the
// agent asked to use, fire `chat:permission-request` on the bus as the orchestrator and
// the skill broker would; a DM or attended turn asks in the thread after its reply, an
// outsider's turn asks nothing, and Allow reaches `proxy:add-host` and
// `agent:apply-capability-grant` only for the person who asked. A website's Allow also
// lands in the real @ax/host-grants store, filed under the person who clicked and the
// channel's agent (TASK-1208).
//
// Stubbed: `http:register-route` (records the routes so the test can call a
// handler directly), `auth:require-user` (the test picks the actor),
// `auth:get-user`, `auth:find-user-by-email` (the people in AX_USERS and
// nobody else), `auth:is-approved-email` (APPROVED_DOMAINS), `auth:list-admins`
// (nobody: no bot request here DMs anyone, TASK-1170), `agent:invoke`
// (records the turn, then streams one line and ends it on the bus, the way
// the orchestrator does), `branding:get`, and the two services a permission
// prompt's Allow calls (`proxy:add-host`, `agent:apply-capability-grant`: they
// need a sandbox, so they record the call and say yes). A website's Allow then keeps the
// host through the REAL @ax/host-grants (it only needs the database).
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
  '@ax/host-grants',
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

// A team agent's own bot (TASK-1167) is a second Slack app: its own ids, secrets and bot user.
const OWN_BOT_NAME = 'Support Helper';
const OWN_APP_ID = 'A07COMPOSE2';
const OWN_CLIENT_ID = '7000000001.7000000009';
const OWN_BOT_USER_ID = 'U07OWNBOT001';
const OWN_BOT_HANDLE = 'support-helper';
const OWN_SIGNING_SECRET = 'composition-own-signing-secret-not-real';
const OWN_CLIENT_SECRET = 'composition-own-client-secret-not-real';

// Slack-shaped fixture tokens, built from pieces so no token-shaped literal
// sits in source (GitHub push protection flags even fake ones). Same
// construction as packages/channel-slack/src/__tests__/fake-slack-tokens.ts,
// which a preset test can't import.
const join = (...parts: string[]): string => parts.join('');
const BOT_TOKEN = join('xo', 'xb-', '1111-2222-', 'COMPOSITIONBOT');
const OWN_BOT_TOKEN = join('xo', 'xb-', '3333-4444-', 'COMPOSITIONOWNBOT');
const CONFIG_ACCESS_TOKEN = join('xo', 'xe.', 'xo', 'xp-', '1-', 'COMPOSITIONACCESS');
const CONFIG_REFRESH_TOKEN = join('xo', 'xe-', '1-', 'COMPOSITIONREFRESH');
const SECOND_CONFIG_REFRESH_TOKEN = join('xo', 'xe-', '1-', 'COMPOSITIONSECONDREFRESH');
const ROTATED_ACCESS_TOKEN = join('xo', 'xe.', 'xo', 'xp-', '1-', 'COMPOSITIONROTATED');
// Slack mints a NEW refresh token on every rotate and retires the old one some time
// after the rotate (minutes to hours), so the fake numbers them: a test can tell which one it holds.
const rotatedRefreshToken = (n: number): string => join('xo', 'xe-', '1-', 'COMPOSITIONROTATEDREFRESH', String(n));

/** One PNG chunk: its data's length, its type, the data, and a CRC over type and data. */
function pngChunk(type: string, data: Buffer): Buffer {
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/**
 * The bot's picture the admin's browser would send (TASK-1133): the start of
 * a 512 x 512 PNG (signature, IHDR, IEND), which is all channel-slack reads
 * before it hands the bytes to Slack. Built here, like channel-slack's own
 * `fake-png.ts`, which a preset test can't import.
 */
const ICON_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  // 512 x 512, then bit depth 8, colour type 6 (RGBA), compression, filter and interlace 0.
  pngChunk('IHDR', Buffer.from([0, 0, 2, 0, 0, 0, 2, 0, 0x08, 0x06, 0x00, 0x00, 0x00])),
  pngChunk('IEND', Buffer.alloc(0)),
]);

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
/** channel-slack's system-prompt contribution (TASK-1131): what a Slack spawn's agent is told about who is writing. */
const SLACK_NOTE = 'system-prompt:augment:optional:slack';
const invokes: Array<{ ctx: AgentContext; input: unknown; note: unknown }> = [];
/** When set, a turn runs this in place of the stub's one line of text; it ends the turn itself. */
let invokeScript: ((ctx: AgentContext) => Promise<void>) | null = null;
let theBus: HookBus | null = null;
/** What the two permission-card actions (TASK-1095) were called with: the ctx's user, and the input. */
const addHostCalls: Array<{ userId: string | undefined; input: unknown }> = [];
const grantCalls: Array<{ userId: string | undefined; input: unknown }> = [];

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
        'auth:list-admins',
        'agent:invoke',
        'branding:get',
        // Two of the services a permission prompt's Allow calls. Their real producers (the egress
        // proxy, the orchestrator) need a sandbox, so these record the call and say yes. The
        // keep step (`host-grants:grant`) is NOT stubbed: the real @ax/host-grants runs.
        'proxy:add-host',
        'agent:apply-capability-grant',
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
      // A bot request's DMs (TASK-1170): no AX admin here has a verified email, so nobody is DMed.
      bus.registerService<Record<string, never>, { admins: Array<{ userId: string; email: string }> }>(
        'auth:list-admins',
        name,
        async () => ({ admins: [] }),
      );
      // The orchestrator's: a turn streams on the bus for its own reqId and
      // ends with chat:turn-end carrying the turn's conversation. No deadline,
      // like the real one (AGENT_INVOKE_TIMEOUT_MS), so a slow turn isn't cut.
      bus.registerService<unknown, unknown>(
        'agent:invoke',
        name,
        async (ctx, input) => {
          // What the orchestrator does at a fresh spawn: ask the provider with the turn's own ctx
          // (the turn's sink is registered before agent:invoke).
          const note = bus.listServices().includes(SLACK_NOTE) ? await bus.call(SLACK_NOTE, ctx, {}) : null;
          invokes.push({ ctx, input, note });
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
      bus.registerService<unknown, unknown>('proxy:add-host', name, async (ctx, input) => {
        addHostCalls.push({ userId: ctx.userId, input });
        return { added: true };
      });
      bus.registerService<unknown, unknown>('agent:apply-capability-grant', name, async (ctx, input) => {
        grantCalls.push({ userId: ctx.userId, input });
        return { attached: true };
      });
    },
  };
}

// ── Slack, behind channel-slack's own client ────────────────────────────────

interface SlackCall {
  method: string;
  auth: string | null;
  /** The form, JSON or multipart fields; a multipart file stays a File. */
  body: Record<string, unknown>;
  /** The `ts` Slack's answer gave a posted message. */
  replyTs?: string;
}

const slackCalls: SlackCall[] = [];
let streamSeq = 0;
let rotateSeq = 0;
let promptSeq = 0;

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
  // An upload (the bot's picture, `apps.icon.set`) arrives as FormData.
  const body: Record<string, unknown> =
    init?.body instanceof FormData
      ? Object.fromEntries(init.body)
      : (headers.get('content-type') ?? '').startsWith('application/json')
        ? (JSON.parse(raw) as Record<string, unknown>)
        : Object.fromEntries(new URLSearchParams(raw));
  const call: SlackCall = { method, auth: headers.get('authorization'), body };
  slackCalls.push(call);

  let answer: Record<string, unknown>;
  switch (method) {
    case 'apps.manifest.create':
      // A team agent's own bot's manifest sends Slack back to its own callback.
      answer = String(body['manifest'] ?? '').includes('/slack/bots/oauth/callback')
        ? {
            ok: true,
            app_id: OWN_APP_ID,
            credentials: { client_id: OWN_CLIENT_ID, client_secret: OWN_CLIENT_SECRET, signing_secret: OWN_SIGNING_SECRET },
          }
        : {
            ok: true,
            app_id: APP_ID,
            credentials: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, signing_secret: SIGNING_SECRET },
          };
      break;
    case 'oauth.v2.access': {
      // The app authenticates with HTTP Basic: its client id says which app's Allow this is.
      const own = Buffer.from((call.auth ?? '').replace(/^Basic /, ''), 'base64').toString().startsWith(`${OWN_CLIENT_ID}:`);
      answer = {
        ok: true,
        token_type: 'bot',
        access_token: own ? OWN_BOT_TOKEN : BOT_TOKEN,
        bot_user_id: own ? OWN_BOT_USER_ID : BOT_USER_ID,
        app_id: own ? OWN_APP_ID : APP_ID,
        team: { id: TEAM_ID, name: 'Canopy Works' },
        is_enterprise_install: false,
      };
      break;
    }
    case 'users.info': {
      if (body['user'] === OWN_BOT_USER_ID) {
        answer = { ok: true, user: { id: OWN_BOT_USER_ID, team_id: TEAM_ID, name: OWN_BOT_HANDLE, is_bot: true } };
        break;
      }
      const person = PEOPLE.find((p) => p.slackId === body['user']);
      answer = person !== undefined ? { ok: true, user: slackUser(person) } : { ok: false, error: 'user_not_found' };
      break;
    }
    case 'conversations.info':
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
    case 'tooling.tokens.rotate':
      rotateSeq += 1;
      answer = {
        ok: true,
        token: ROTATED_ACCESS_TOKEN,
        refresh_token: rotatedRefreshToken(rotateSeq),
        exp: 4_102_444_800,
      };
      break;
    case 'chat.startStream':
      streamSeq += 1;
      answer = { ok: true, ts: `1763040000.${String(streamSeq).padStart(6, '0')}` };
      break;
    case 'chat.postMessage':
      // An approval prompt (TASK-1095) is a message with blocks: Slack answers its `ts`,
      // which the bot keeps to redraw the prompt when it is answered.
      if (Array.isArray(body['blocks'])) {
        promptSeq += 1;
        answer = { ok: true, ts: `1763050000.${String(promptSeq).padStart(6, '0')}` };
      } else {
        answer = { ok: true };
      }
      break;
    case 'apps.manifest.update':
      // TASK-1096: the rename. Slack answers the app id, and whether the new
      // manifest's scopes need the workspace to Allow again (a name doesn't).
      answer = { ok: true, app_id: APP_ID, permissions_updated: false };
      break;
    case 'apps.icon.set':
    case 'apps.manifest.delete':
    case 'chat.appendStream':
    case 'chat.stopStream':
    case 'chat.update':
    case 'chat.postEphemeral':
    case 'reactions.add':
    case 'reactions.remove':
      answer = { ok: true };
      break;
    default:
      answer = { ok: false, error: 'unknown_method' };
  }
  if (typeof answer['ts'] === 'string') call.replyTs = answer['ts'];
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

function signedHeaders(body: Buffer, secret: string = SIGNING_SECRET): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000));
  const digest = createHmac('sha256', secret).update(`v0:${ts}:`).update(body).digest('hex');
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

/** A signed delivery to a team agent's own bot: its own app id, its own signing secret, on its own install's route. */
async function deliverToOwnBot(installId: string, event: Record<string, unknown>): Promise<Captured> {
  eventSeq += 1;
  const body = jsonBody({
    type: 'event_callback',
    team_id: TEAM_ID,
    api_app_id: OWN_APP_ID,
    event_id: `Ev07COMPOSE${String(eventSeq).padStart(4, '0')}`,
    event,
  });
  return callRoute('POST', '/slack/events/:installId', {
    params: { installId },
    rawPath: `/slack/events/${installId}`,
    headers: signedHeaders(body, OWN_SIGNING_SECRET),
    body,
  });
}

/** A prompt the bot posted: where it is, and the id its buttons carry (read from the blocks it sent). */
interface PostedPrompt {
  channel: string;
  messageTs: string;
  threadTs: string;
  promptId: string;
  blocks: Array<Record<string, unknown>>;
}

/** The prompts (chat.postMessage with blocks) in `calls`; `messageTs` is the `ts` Slack's answer gave. */
function promptsIn(calls: SlackCall[]): PostedPrompt[] {
  return calls
    .filter((c) => c.method === 'chat.postMessage' && Array.isArray(c.body['blocks']))
    .map((c) => {
      const blocks = c.body['blocks'] as Array<Record<string, unknown>>;
      const actions = blocks.find((b) => b['type'] === 'actions');
      const elements = (actions?.['elements'] ?? []) as Array<{ value: string }>;
      return {
        channel: String(c.body['channel']),
        messageTs: c.replyTs!,
        threadTs: String(c.body['thread_ts']),
        promptId: elements[0]!.value,
        blocks,
      };
    });
}

/**
 * A signed click on a prompt's button, as Slack posts it to a team agent's own bot: a form whose one
 * `payload` is the interaction's JSON, signed over its raw bytes. `signWith` is the secret the
 * signature uses.
 */
async function click(
  installId: string,
  from: SlackPerson,
  prompt: PostedPrompt,
  action: 'allow' | 'deny' = 'allow',
  signWith: string = OWN_SIGNING_SECRET,
): Promise<Captured> {
  const messageTs = prompt.messageTs;
  const payload = {
    type: 'block_actions',
    api_app_id: OWN_APP_ID,
    team: { id: TEAM_ID },
    user: { id: from.slackId },
    channel: { id: prompt.channel },
    container: { type: 'message', message_ts: messageTs, channel_id: prompt.channel },
    message: { ts: messageTs, thread_ts: prompt.threadTs },
    actions: [{ type: 'button', action_id: `ax_prompt_${action}`, value: prompt.promptId }],
  };
  const body = Buffer.from(new URLSearchParams({ payload: JSON.stringify(payload) }).toString());
  const ts = String(Math.floor(Date.now() / 1000));
  const digest = createHmac('sha256', signWith).update(`v0:${ts}:`).update(body).digest('hex');
  return callRoute('POST', '/slack/interactions/:installId', {
    params: { installId },
    rawPath: `/slack/interactions/${installId}`,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-slack-request-timestamp': ts,
      'x-slack-signature': `v0=${digest}`,
    },
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

  /** What a team agent's deletion must clear: the channels it was bound to, and its own bot. */
  async function botsAndBindings(): Promise<unknown[]> {
    return [
      ...(await bindings()),
      ...(await query("SELECT install_id FROM channel_slack_v1_installs WHERE kind = 'bot'")),
    ];
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

  /**
   * A person's configuration refresh token (TASK-1175): one per AX user,
   * shared by every Slack app they made through AX, read as them.
   */
  async function readConfigToken(userId: string): Promise<string> {
    try {
      return await theBus!.call<unknown, string>(
        'credentials:get',
        makeAgentContext({ sessionId: 'test', agentId: '', userId }),
        { ref: `slack:person:${userId}:config-refresh-token`, userId, scope: 'global' },
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

  // Every channel test makes a team agent with its own bot and frees them at its end. One that
  // fails first must not leave the bot behind: the next test's supportBot() would be refused the
  // bot's name (taken) and fail for a reason that is not its own. So whatever a test left, a bound
  // channel or a bot, goes here, by a site admin (a team's own admin may have left it), the way
  // dropAgent frees it.
  afterEach(async () => {
    invokeScript = null;
    actor = null;
    if (theBus === null || pgContainer === null) return;
    const left = await bindings();
    const bots = await query("SELECT agent_id FROM channel_slack_v1_installs WHERE kind = 'bot'");
    const leftAgents = new Set([...left.map((b) => b.agentId), ...bots.map((b) => b['agent_id'] as string)]);
    for (const agentId of leftAgents) {
      await theBus.call('agents:delete', makeAgentContext({ sessionId: 'test', agentId: '', userId: ADMIN }), {
        actor: { userId: ADMIN, isAdmin: true },
        agentId,
      });
    }
    if (leftAgents.size > 0) await vi.waitFor(async () => expect(await botsAndBindings()).toEqual([]), { timeout: 10_000 });
  });

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

    // The body carries the bot's picture the admin's browser drew (TASK-1133).
    const connectMark = slackCalls.length;
    const connect = await callRoute('POST', '/admin/slack/connect', {
      body: jsonBody({
        accessToken: CONFIG_ACCESS_TOKEN,
        refreshToken: CONFIG_REFRESH_TOKEN,
        iconPng: ICON_PNG.toString('base64'),
      }),
    });
    expect(connect).toMatchObject({ status: 200, body: { iconSet: true } });
    // Right after Slack makes the app, Connect tries the pasted refresh token once (TASK-1159).
    const connectCalls = slackCalls.slice(connectMark).slice(0, 2);
    expect(connectCalls.map((c) => c.method)).toEqual(['apps.manifest.create', 'tooling.tokens.rotate']);
    expect(connectCalls[1]!.body).toEqual({ refresh_token: CONFIG_REFRESH_TOKEN });
    // Uploaded through the real client, with the pasted access token, for the app just made.
    const iconCalls = slackCalls.slice(connectMark).filter((c) => c.method === 'apps.icon.set');
    expect(iconCalls).toHaveLength(1);
    const iconCall = iconCalls[0]!;
    expect(iconCall.auth).toBe(`Bearer ${CONFIG_ACCESS_TOKEN}`);
    expect(Object.keys(iconCall.body).sort()).toEqual(['app_id', 'file']);
    expect(iconCall.body['app_id']).toBe(APP_ID);
    const iconFile = iconCall.body['file'];
    if (!(iconFile instanceof File)) throw new Error('apps.icon.set got no file');
    expect(Buffer.from(await iconFile.arrayBuffer()).equals(ICON_PNG)).toBe(true);
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
    // The refresh token kept is the one Slack minted at Connect, never the
    // pasted one, as the admin's own token (TASK-1175).
    const atConnect = await readConfigToken(ADMIN);
    expect(atConnect).toBe(rotatedRefreshToken(rotateSeq));
    expect(atConnect).not.toBe(CONFIG_REFRESH_TOKEN);
    actor = null;

    // 2b. The admin renames the bot (TASK-1096). The route rotates the
    //     configuration token Connect kept, then sends Slack the WHOLE manifest
    //     (Slack replaces it on update) with only the two name fields changed.
    //     The row shows the new name only after Slack said yes. Nothing else in
    //     the scenario reads the name, and Disconnect at step 6 cleans the
    //     install up.
    const renameMark = slackCalls.length;
    actor = { id: ADMIN, isAdmin: true };
    const rename = await callRoute('POST', '/admin/slack/rename', { body: jsonBody({ botName: 'Canopy Helper' }) });
    expect(rename).toMatchObject({ status: 200, body: { botName: 'Canopy Helper' } });
    const renameCalls = slackCalls.slice(renameMark);
    expect(renameCalls.map((c) => c.method)).toEqual(['tooling.tokens.rotate', 'apps.manifest.update']);
    expect(renameCalls[0]!.body).toEqual({ refresh_token: atConnect });
    const update = renameCalls[1]!;
    expect(update.auth).toBe(`Bearer ${ROTATED_ACCESS_TOKEN}`);
    expect(update.body['app_id']).toBe(APP_ID);
    const renamedManifest = JSON.parse(String(created.body['manifest'])) as {
      display_information: { name: string };
      features: { bot_user: { display_name: string } };
    };
    renamedManifest.display_information.name = 'Canopy Helper';
    renamedManifest.features.bot_user.display_name = 'Canopy Helper';
    expect(JSON.parse(String(update.body['manifest']))).toEqual(renamedManifest);
    expect(await query('SELECT bot_name FROM channel_slack_v1_installs')).toEqual([{ bot_name: 'Canopy Helper' }]);
    // The route stored the refresh token Slack minted (before it sent the
    // update), because Slack retires the one it just rotated.
    const kept = await readConfigToken(ADMIN);
    expect(kept).toBe(rotatedRefreshToken(rotateSeq));
    expect(kept).not.toBe(CONFIG_REFRESH_TOKEN);
    expect(kept).not.toBe(atConnect);
    expect(await callRoute('GET', '/admin/slack')).toMatchObject({
      status: 200,
      body: { state: 'connected', botName: 'Canopy Helper' },
    });
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
    // TASK-1131: the spawn's system prompt says whose DM this is, and that they can approve.
    expect(SLACK_NOTE.startsWith(SYSTEM_PROMPT_AUGMENT_OPTIONAL_PREFIX)).toBe(true);
    expect(aliceTurn.note).toEqual({ context: expect.stringContaining('This is a private Slack DM with your owner.') });
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

    // The shared bot mentioned in a channel: one private line, to the member
    // alone, and no turn (a team agent answers a channel through its own bot).
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
    //    token, then the row and all four secrets are gone. It rotates the
    //    token the rename stored, because Slack retires a rotated one.
    actor = { id: ADMIN, isAdmin: true };
    mark = slackCalls.length;
    const disconnect = await callRoute('POST', '/admin/slack/disconnect', { body: jsonBody({}) });
    expect(disconnect).toMatchObject({ status: 200, body: { appDeleted: true, tokenKept: false } });
    expect(slackCalls.slice(mark).map((c) => c.method)).toEqual(['tooling.tokens.rotate', 'apps.manifest.delete']);
    expect(slackCalls.slice(mark)[0]!.body).toEqual({ refresh_token: kept });
    expect(slackCalls.slice(mark)[1]!.auth).toBe(`Bearer ${ROTATED_ACCESS_TOKEN}`);
    expect(await query('SELECT install_id FROM channel_slack_v1_installs')).toEqual([]);
    for (const name of ['bot-token', 'signing-secret', 'client-secret', 'config-refresh-token']) {
      expect(await readSecret(installId, name), name).toMatch(/^error:/);
    }
    // And the admin's own token: Slack deleted the app, and nothing else names them (TASK-1175).
    expect(await readConfigToken(ADMIN)).toMatch(/^error:/);
    expect(await callRoute('GET', '/admin/slack')).toMatchObject({ body: { state: 'not-connected' } });
  });

  // ── Channel turns (TASK-1094) ──────────────────────────────────────────────

  /** A signed `app_mention` of the agent's own bot in the support channel, the way Slack writes it: the bot's own `<@…>` first. */
  function botMention(from: SlackPerson, ts: string, text: string, threadTs?: string): Record<string, unknown> {
    return {
      type: 'app_mention',
      user: from.slackId,
      channel: SUPPORT_CHANNEL,
      ts,
      text: `<@${OWN_BOT_USER_ID}> ${text}`,
      ...(threadTs !== undefined ? { thread_ts: threadTs } : {}),
    };
  }

  /**
   * The workspace connected, a support team (Ada its admin, Mel a member) with a team agent, and the
   * agent's own bot: Ada asks for it, Allow comes back to its callback. `installId` is the shared
   * install; `botId` is the bot's own. The bot binds #support-desk at its first mention there.
   */
  async function supportBot(): Promise<{ installId: string; botId: string; teamId: string; agentId: string }> {
    const installId = await connectWorkspace();
    const { teamId, agentId } = await teamWithAgent('usr_ada', 'usr_mel');
    actor = { id: 'usr_ada', isAdmin: false };
    const requested = await callRoute('POST', '/settings/slack/:agentId/bot', {
      params: { agentId },
      rawPath: `/settings/slack/${agentId}/bot`,
      body: jsonBody({ botName: OWN_BOT_NAME, refreshToken: CONFIG_REFRESH_TOKEN }),
    });
    expect(requested.status).toBe(200);
    const state = new URL((requested.body as { installUrl: string }).installUrl).searchParams.get('state')!;
    const callback = await callRoute('GET', '/slack/bots/oauth/callback', { query: { code: OAUTH_CODE, state } });
    actor = null;
    expect(callback.status).toBe(302);
    const botRows = await query("SELECT install_id FROM channel_slack_v1_installs WHERE kind = 'bot'");
    expect(botRows).toHaveLength(1);
    return { installId, botId: botRows[0]!['install_id'] as string, teamId, agentId };
  }

  /** Delete the team agent: its bot and its channel go (agents:deleted), so the next test starts clean. */
  async function dropAgent(agentId: string, byAdmin = 'usr_ada'): Promise<void> {
    await theBus!.call('agents:delete', makeAgentContext({ sessionId: 'test', agentId: '', userId: byAdmin }), {
      actor: { userId: byAdmin, isAdmin: false },
      agentId,
    });
    await vi.waitFor(async () => expect(await botsAndBindings()).toEqual([]), { timeout: 10_000 });
  }

  /** A channel turn's Slack calls, once its reply is closed and 👀 is off. */
  const channelTurnCalls = (from: number): Promise<SlackCall[]> =>
    slackCallsUntil(from, 'chat.startStream', 'chat.stopStream', 'reactions.remove');

  /** Wait for `n` turns to have reached agent:invoke; the latest one. */
  async function invokedTurn(n: number): Promise<{ ctx: AgentContext; input: unknown; note: unknown }> {
    await vi.waitFor(() => expect(invokes).toHaveLength(n), { timeout: 10_000 });
    return invokes[n - 1]!;
  }

  /** TASK-1131: a member's spawn is told the writer can approve. The copy is channel-slack's; matched by substring. */
  function expectMemberNote(note: unknown): void {
    expect(note).toEqual({ context: expect.stringContaining('the person writing is one of your people') });
    expect((note as { context: string }).context).not.toContain("can't approve");
  }

  /** TASK-1131: an outsider's spawn is told nobody writing can approve, and never sees their name. */
  function expectOutsiderNote(note: unknown, name: string): void {
    expect(note).toEqual({ context: expect.stringContaining("They can't approve anything.") });
    const context = (note as { context: string }).context;
    expect(context).toContain('waits for your owner, the team admin who set you up in Slack');
    expect(context).not.toContain(name);
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
    const { botId, teamId, agentId } = await supportBot();
    invokes.length = 0;
    const keyOf = (thread: string, suffix = ''): string => `slack:${botId}:${SUPPORT_CHANNEL}:${thread}${suffix}`;

    // A: Mel is on the team. Attended, as herself, in a conversation of her own.
    const melTs = nextTs();
    let mark = slackCalls.length;
    expect((await deliverToOwnBot(botId, botMention(MEL, melTs, 'what is the status?'))).status).toBe(200);
    const melTurn = await invokedTurn(1);
    expect(melTurn.ctx).toMatchObject({ userId: 'usr_mel', agentId, source: 'user', audience: 'shared' });
    expect(JSON.stringify(melTurn.input)).toContain(`[Slack · #support-desk · Mel (${MEL.slackId})]`);
    expect(JSON.stringify(melTurn.input)).toContain('what is the status?');
    expect(await conversationRow(melTurn.ctx.conversationId!)).toEqual({ owner: 'usr_mel', key: keyOf(melTs) });
    expectMemberNote(melTurn.note);
    let calls = await channelTurnCalls(mark);
    expect(callOf(calls, 'chat.startStream').body).toMatchObject({
      channel: SUPPORT_CHANNEL,
      thread_ts: melTs,
      recipient_user_id: MEL.slackId,
    });

    // B: Bob has an AX account but isn't on the team. External, as Ada, who connected the channel.
    const bobTs = nextTs();
    mark = slackCalls.length;
    expect((await deliverToOwnBot(botId, botMention(BOB, bobTs, 'can you help me?'))).status).toBe(200);
    const bobTurn = await invokedTurn(2);
    expect(bobTurn.ctx).toMatchObject({ userId: 'usr_ada', agentId, source: 'external', audience: 'shared' });
    expect(JSON.stringify(bobTurn.input)).toContain(`[Slack · #support-desk · Bob (${BOB.slackId})]`);
    expect(await conversationRow(bobTurn.ctx.conversationId!)).toEqual({ owner: 'usr_ada', key: keyOf(bobTs, ':external') });
    expectOutsiderNote(bobTurn.note, 'Bob');
    await channelTurnCalls(mark);

    // C: Carol has no AX account, on an approved domain. External too, and in Mel's own thread
    // she gets a conversation of her own, not Mel's.
    mark = slackCalls.length;
    expect((await deliverToOwnBot(botId, botMention(CAROL, nextTs(), 'me too, please', melTs))).status).toBe(200);
    const carolTurn = await invokedTurn(3);
    expect(carolTurn.ctx).toMatchObject({ userId: 'usr_ada', agentId, source: 'external', audience: 'shared' });
    expect(carolTurn.ctx.conversationId).not.toBe(melTurn.ctx.conversationId);
    expect(await conversationRow(carolTurn.ctx.conversationId!)).toEqual({ owner: 'usr_ada', key: keyOf(melTs, ':external') });
    expectOutsiderNote(carolTurn.note, 'Carol');
    expect(JSON.stringify(melTurn.input)).not.toContain('me too');
    await channelTurnCalls(mark);

    // D: Eve has no AX account and her address is on no approved domain: silence, no turn.
    const eveTs = nextTs();
    const eveMark = slackCalls.length;
    expect((await deliverToOwnBot(botId, botMention(EVE, eveTs, 'let me in'))).status).toBe(200);
    await slackCallsUntil(eveMark, 'users.info');

    // E: Ada leaves the team (Zoe becomes its second admin first: a team keeps one). The bot's
    // requester is no longer an admin, so she can't lend her access: outsiders hear one private
    // line and nothing runs.
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
      expect((await deliverToOwnBot(botId, botMention(outsider, nextTs(), 'anyone there?'))).status).toBe(200);
      calls = await slackCallsUntil(mark, 'chat.postEphemeral');
      expect(callOf(calls, 'chat.postEphemeral').body).toMatchObject({ channel: SUPPORT_CHANNEL, user: outsider.slackId });
      expect(typeof callOf(calls, 'chat.postEphemeral').body['text']).toBe('string');
      expect(calls.map((c) => c.method)).not.toContain('chat.startStream');
    }
    expect(invokes).toHaveLength(3);
    // Members keep working: Mel doesn't depend on the connector.
    mark = slackCalls.length;
    expect((await deliverToOwnBot(botId, botMention(MEL, nextTs(), 'still me'))).status).toBe(200);
    const melAgain = await invokedTurn(4);
    expect(melAgain.ctx).toMatchObject({ userId: 'usr_mel', agentId, source: 'user', audience: 'shared' });
    expectMemberNote(melAgain.note);
    await channelTurnCalls(mark);

    // Eve's mention went nowhere: nothing said to her or in her thread, no turn for her.
    for (const c of slackCalls.slice(eveMark).filter((x) => x.method !== 'users.info')) {
      expect(c.body['thread_ts']).not.toBe(eveTs);
      expect(c.body['user']).not.toBe(EVE.slackId);
      expect(c.body['recipient_user_id']).not.toBe(EVE.slackId);
    }
    expect(invokes.map((i) => JSON.stringify(i.input)).join('')).not.toContain('let me in');

    // A spawn channel-slack didn't start (a web chat) gets nothing, even on Mel's own conversation.
    expect(
      await theBus!.call(
        SLACK_NOTE,
        makeAgentContext({ sessionId: 'web', agentId, userId: 'usr_mel', conversationId: melTurn.ctx.conversationId! }),
        {},
      ),
    ).toEqual({});

    // Ada is gone from the team: Zoe, its admin now, deletes the agent.
    await dropAgent(agentId, 'usr_zoe');
  });

  it('a held call: the outsider thread says its owner was asked and the row waits in the connector\'s Today; a member\'s waits in their own (TASK-1094)', async () => {
    const { botId, agentId } = await supportBot();
    invokes.length = 0;
    const holds: unknown[] = [];
    // The `n`th turn's pre-call answer, once it has one. A turn reaches agent:invoke (what
    // invokedTurn waits for) BEFORE its pre-call returns — the real gate reads Postgres — so
    // reading holds[n-1] straight after invokedTurn races it: under load it is still undefined.
    const holdOf = async (n: number): Promise<unknown> => {
      await vi.waitFor(() => expect(holds).toHaveLength(n), { timeout: 10_000 });
      return holds[n - 1];
    };
    invokeScript = async (ctx) => {
      // The runner's pre-call, on the real policy: connector_propose is held for whoever is there
      // (an attended request_capability no longer is: its own card asks, TASK-1135). Then the held
      // result and the turn's end, the way the runners send them.
      const call = { id: `toolu_held_${invokes.length}`, name: 'connector_propose', input: { connectorId: 'calendar' } };
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
      expect((await deliverToOwnBot(botId, botMention(CAROL, nextTs(), 'please book it'))).status).toBe(200);
      const external = await invokedTurn(1);
      expect(external.ctx).toMatchObject({ userId: 'usr_ada', source: 'external' });
      expect(isHold(await holdOf(1))).toBe(true);
      let calls = await channelTurnCalls(mark);
      let said = sentText(calls);
      expect(said).toContain("I need my owner's OK before I can do part of this");
      expect(said).not.toContain('/workspace');
      // No buttons for an outsider's turn: it runs as Ada, and only she could answer it, in Today.
      const externalMark = mark;
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

      // Attended: Mel's turn runs as Mel. The reply ends with the ask, a prompt with Allow and Deny
      // follows it in her thread (TASK-1095), and the row is hers.
      mark = slackCalls.length;
      const melTs = nextTs();
      expect((await deliverToOwnBot(botId, botMention(MEL, melTs, 'please book it'))).status).toBe(200);
      const attended = await invokedTurn(2);
      expect(attended.ctx).toMatchObject({ userId: 'usr_mel', source: 'user' });
      expect(isHold(await holdOf(2))).toBe(true);
      calls = await slackCallsUntil(mark, 'chat.stopStream', 'reactions.remove', 'chat.postMessage');
      said = sentText(calls);
      expect(said).toContain('I need your OK before I can do part of this.');
      expect(said).not.toContain("my owner's OK");
      const asked = promptsIn(calls);
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatchObject({ channel: SUPPORT_CHANNEL, threadTs: melTs });
      // After the reply, not before it.
      const methods = calls.map((c) => c.method);
      expect(methods.indexOf('chat.postMessage')).toBeGreaterThan(methods.indexOf('chat.stopStream'));
      // Nothing was posted with blocks for Carol, then or since: Mel's is the only prompt.
      expect(promptsIn(slackCalls.slice(externalMark))).toHaveLength(1);
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

  it("an attended held call: the prompt in the thread is answered only by the person who asked, with the real decisions behind it; an outsider's turn gets none (TASK-1095)", async () => {
    const { botId, agentId } = await supportBot();
    invokes.length = 0;
    invokeScript = async (ctx) => {
      // connector_propose and not request_capability: an attended request_capability is no
      // longer held, since its own card asks (TASK-1135).
      const call = { id: `toolu_held_${invokes.length}`, name: 'connector_propose', input: { connectorId: invokes.length > 1 ? 'drive' : 'calendar' } };
      await theBus!.fire('tool:pre-call', ctx, call);
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
      // Mel's mention holds a call: her reply ends with the ask, then the prompt.
      const melTs = nextTs();
      let mark = slackCalls.length;
      expect((await deliverToOwnBot(botId, botMention(MEL, melTs, 'please book it'))).status).toBe(200);
      await invokedTurn(1);
      let calls = await slackCallsUntil(mark, 'chat.stopStream', 'reactions.remove', 'chat.postMessage');
      expect(sentText(calls)).toContain('I need your OK before I can do part of this.');
      const [prompt] = promptsIn(calls);
      expect(prompt).toMatchObject({ channel: SUPPORT_CHANNEL, threadTs: melTs });
      const melRows = await listDecisions('usr_mel');
      expect(melRows).toHaveLength(1);
      expect(melRows[0]).toMatchObject({ agentId, status: 'pending', ownerUserId: 'usr_mel' });
      const row = melRows[0]!;
      // `decisions:list` shows what waits; the row itself says where it went.
      const statusOf = async (id: unknown = row['id']): Promise<unknown> =>
        (
          await theBus!.call<unknown, { decision: { status: string } }>(
            'decisions:get',
            makeAgentContext({ sessionId: 'test', agentId: '', userId: 'usr_mel' }),
            { decisionId: id, userId: 'usr_mel' },
          )
        ).decision.status;

      // Ada, a team admin, is not who asked: Slack gets its 200, she is told privately, nothing else moves.
      mark = slackCalls.length;
      expect((await click(botId, ADA, prompt!, 'allow')).status).toBe(200);
      calls = await slackCallsUntil(mark, 'chat.postEphemeral');
      expect(calls.map((c) => c.method)).toEqual(['chat.postEphemeral']);
      expect(calls[0]!.body).toMatchObject({ channel: SUPPORT_CHANNEL, user: ADA.slackId, thread_ts: melTs });
      expect(String(calls[0]!.body['text'])).toBe('Only the person who asked can answer this.');
      expect(await statusOf()).toBe('pending');

      // A click Slack didn't sign is refused outright: no handler runs, no call goes out, nothing moves.
      mark = slackCalls.length;
      expect((await click(botId, MEL, prompt!, 'allow', 'not-the-signing-secret')).status).toBe(401);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(slackCalls.slice(mark)).toEqual([]);
      expect(await statusOf()).toBe('pending');

      // Mel answers Allow: the real decisions:approve runs as her, and the prompt is redrawn without its buttons.
      mark = slackCalls.length;
      expect((await click(botId, MEL, prompt!, 'allow')).status).toBe(200);
      calls = await slackCallsUntil(mark, 'chat.update');
      const update = callOf(calls, 'chat.update');
      expect(update.body).toMatchObject({ channel: SUPPORT_CHANNEL, ts: prompt!.messageTs });
      expect(String(update.body['text'])).toBe("Allowed. Ask me again and I'll do it.");
      const redrawn = update.body['blocks'] as Array<{ type: string }>;
      expect(redrawn.map((b) => b.type)).toEqual(['section', 'context']);
      expect(await statusOf()).not.toBe('pending');
      expect(await statusOf()).toBe('approved-pending-agent');

      // A second ask, answered Deny: the real decisions:dismiss runs as her.
      const secondTs = nextTs();
      mark = slackCalls.length;
      expect((await deliverToOwnBot(botId, botMention(MEL, secondTs, 'and my files'))).status).toBe(200);
      await invokedTurn(2);
      calls = await slackCallsUntil(mark, 'chat.stopStream', 'reactions.remove', 'chat.postMessage');
      const [second] = promptsIn(calls);
      expect(second).toMatchObject({ channel: SUPPORT_CHANNEL, threadTs: secondTs });
      expect(second!.promptId).not.toBe(prompt!.promptId);
      const pendingRows = await listDecisions('usr_mel');
      expect(pendingRows).toHaveLength(1);
      expect(pendingRows[0]).toMatchObject({ status: 'pending' });
      mark = slackCalls.length;
      expect((await click(botId, MEL, second!, 'deny')).status).toBe(200);
      calls = await slackCallsUntil(mark, 'chat.update');
      expect(String(callOf(calls, 'chat.update').body['text'])).toBe("Denied. I won't do it.");
      expect(await listDecisions('usr_mel')).toEqual([]);
      expect(await statusOf(pendingRows[0]!['id'])).toBe('dismissed');

      // Carol is no member: her turn runs as Ada, and gets no buttons. Ada's row waits in her Today.
      mark = slackCalls.length;
      expect((await deliverToOwnBot(botId, botMention(CAROL, nextTs(), 'please book it'))).status).toBe(200);
      const external = await invokedTurn(3);
      expect(external.ctx).toMatchObject({ userId: 'usr_ada', source: 'external' });
      calls = await channelTurnCalls(mark);
      expect(sentText(calls)).toContain("I need my owner's OK before I can do part of this");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(promptsIn(slackCalls.slice(mark))).toEqual([]);
      const adaRows = await listDecisions('usr_ada');
      expect(adaRows).toHaveLength(1);
      expect(adaRows[0]).toMatchObject({ status: 'pending', ownerUserId: 'usr_ada' });
    } finally {
      invokeScript = null;
      await dropAgent(agentId);
    }
  });

  // ── Permission cards (TASK-1095) ───────────────────────────────────────────

  /** A turn that ends after firing `cards` on the bus, as the orchestrator (host) or the skill broker (skill) does. */
  const turnFiring =
    (cards: (ctx: AgentContext) => Array<Record<string, unknown>>) =>
    async (ctx: AgentContext): Promise<void> => {
      await theBus!.fire('chat:stream-chunk', ctx, { reqId: ctx.reqId, kind: 'text', text: 'Working on it.' });
      for (const card of cards(ctx)) await theBus!.fire('chat:permission-request', ctx, card);
      await theBus!.fire('chat:turn-end', ctx, { reqId: ctx.reqId, reason: 'user-message-wait' });
    };

  it("a blocked website: the prompt is answered only by the person whose turn it was, and Allow lets it through and keeps it for her on the agent; an outsider's turn gets none (TASK-1095, TASK-1208)", async () => {
    const { botId, agentId } = await supportBot();
    invokes.length = 0;
    addHostCalls.length = 0;
    grantCalls.length = 0;
    invokeScript = turnFiring((ctx) => [
      { kind: 'host', reqId: ctx.reqId, host: 'api.example.com', sessionId: 'sess_compose_host' },
    ]);
    try {
      // Mel's mention: the reply, then the prompt, in her thread.
      const melTs = nextTs();
      let mark = slackCalls.length;
      expect((await deliverToOwnBot(botId, botMention(MEL, melTs, 'fetch it'))).status).toBe(200);
      await invokedTurn(1);
      let calls = await slackCallsUntil(mark, 'chat.stopStream', 'reactions.remove', 'chat.postMessage');
      const [prompt] = promptsIn(calls);
      expect(prompt).toMatchObject({ channel: SUPPORT_CHANNEL, threadTs: melTs });
      const methods = calls.map((c) => c.method);
      expect(methods.indexOf('chat.postMessage')).toBeGreaterThan(methods.indexOf('chat.stopStream'));
      expect(JSON.stringify(prompt!.blocks)).toContain('Wants to connect to api.example.com');
      expect(JSON.stringify(prompt!.blocks)).toContain('Once allowed, it stays allowed.');
      expect(promptsIn(calls)).toHaveLength(1);

      // The real allowed-sites list of a person and this agent, read the way the orchestrator reads it.
      const keptFor = async (userId: string): Promise<string[]> =>
        (
          await theBus!.call<unknown, { hosts: Array<{ host: string }> }>(
            'host-grants:list',
            makeAgentContext({ sessionId: 'test', agentId: '', userId }),
            { ownerUserId: userId, agentId },
          )
        ).hosts.map((h) => h.host);
      expect(await keptFor('usr_mel')).toEqual([]);

      // Ada, a team admin, is not who asked: told privately, and the proxy is never called.
      mark = slackCalls.length;
      expect((await click(botId, ADA, prompt!, 'allow')).status).toBe(200);
      calls = await slackCallsUntil(mark, 'chat.postEphemeral');
      expect(String(callOf(calls, 'chat.postEphemeral').body['text'])).toBe('Only the person who asked can answer this.');
      expect(addHostCalls).toEqual([]);
      expect(await keptFor('usr_mel')).toEqual([]);

      // Mel's Allow: the proxy hears exactly this session and host, as her, and the host is kept for her.
      mark = slackCalls.length;
      expect((await click(botId, MEL, prompt!, 'allow')).status).toBe(200);
      calls = await slackCallsUntil(mark, 'chat.update');
      expect(String(callOf(calls, 'chat.update').body['text'])).toBe("Allowed from now on. Ask me again and I'll try it.");
      expect(addHostCalls).toEqual([
        { userId: 'usr_mel', input: { sessionId: 'sess_compose_host', host: 'api.example.com' } },
      ]);
      // C1: filed under Mel and the channel's agent; Ada, who did not click, has nothing.
      expect(await keptFor('usr_mel')).toEqual(['api.example.com']);
      expect(await keptFor('usr_ada')).toEqual([]);

      // A second click on the settled prompt does nothing more.
      mark = slackCalls.length;
      expect((await click(botId, MEL, prompt!, 'allow')).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(addHostCalls).toHaveLength(1);

      // Carol is no member: her turn runs as Ada and gets no prompt, whatever the card says.
      mark = slackCalls.length;
      expect((await deliverToOwnBot(botId, botMention(CAROL, nextTs(), 'fetch it'))).status).toBe(200);
      const external = await invokedTurn(2);
      expect(external.ctx).toMatchObject({ userId: 'usr_ada', source: 'external' });
      await channelTurnCalls(mark);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(promptsIn(slackCalls.slice(mark))).toEqual([]);
      expect(addHostCalls).toHaveLength(1);
      // C2: the outsider's turn (run as Ada) kept nothing for Ada, and Mel's list is unchanged.
      expect(await keptFor('usr_ada')).toEqual([]);
      expect(await keptFor('usr_mel')).toEqual(['api.example.com']);
    } finally {
      invokeScript = null;
      await dropAgent(agentId);
    }
  });

  it("a skill that needs only a yes: the prompt follows the reply, a bystander's click is refused, and Mel's Allow attaches it after the real conversation agrees; an outsider's turn gets none (TASK-1095)", async () => {
    const { botId, agentId } = await supportBot();
    invokes.length = 0;
    addHostCalls.length = 0;
    grantCalls.length = 0;
    // `request_capability`'s card, fired from inside the turn with the turn's own ctx, in the broker's
    // shape: without `hosts` and `packages` Slack can't name its reach, and sends Mel to the web app (TASK-1135).
    invokeScript = turnFiring(() => [
      {
        kind: 'skill',
        skillId: 'calendar-booking',
        description: 'Books meetings for you.',
        hosts: [],
        slots: [],
        packages: { npm: [], pypi: [] },
      },
    ]);
    try {
      const melTs = nextTs();
      let mark = slackCalls.length;
      expect((await deliverToOwnBot(botId, botMention(MEL, melTs, 'book it'))).status).toBe(200);
      const attended = await invokedTurn(1);
      let calls = await slackCallsUntil(mark, 'chat.stopStream', 'reactions.remove', 'chat.postMessage');
      const [prompt] = promptsIn(calls);
      expect(prompt).toMatchObject({ channel: SUPPORT_CHANNEL, threadTs: melTs });
      expect(promptsIn(calls)).toHaveLength(1);
      expect(JSON.stringify(prompt!.blocks)).toContain('Books meetings for you.');
      const methods = calls.map((c) => c.method);
      expect(methods.indexOf('chat.postMessage')).toBeGreaterThan(methods.indexOf('chat.stopStream'));

      // Ada is not who asked: refused, nothing attached.
      mark = slackCalls.length;
      expect((await click(botId, ADA, prompt!, 'allow')).status).toBe(200);
      calls = await slackCallsUntil(mark, 'chat.postEphemeral');
      expect(String(callOf(calls, 'chat.postEphemeral').body['text'])).toBe('Only the person who asked can answer this.');
      expect(grantCalls).toEqual([]);

      // Mel's Allow: the real conversations:get agreed the conversation is hers on this agent,
      // then the grant hears the prompt's four ids, as her.
      mark = slackCalls.length;
      expect((await click(botId, MEL, prompt!, 'allow')).status).toBe(200);
      calls = await slackCallsUntil(mark, 'chat.update');
      expect(String(callOf(calls, 'chat.update').body['text'])).toBe("Connected. Send your message again and I'll use it.");
      expect(grantCalls).toEqual([
        {
          userId: 'usr_mel',
          input: {
            conversationId: attended.ctx.conversationId,
            userId: 'usr_mel',
            agentId,
            skillId: 'calendar-booking',
          },
        },
      ]);

      // Carol's turn runs as Ada: no prompt, no grant.
      mark = slackCalls.length;
      expect((await deliverToOwnBot(botId, botMention(CAROL, nextTs(), 'book it'))).status).toBe(200);
      await invokedTurn(2);
      await channelTurnCalls(mark);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(promptsIn(slackCalls.slice(mark))).toEqual([]);
      expect(grantCalls).toHaveLength(1);
    } finally {
      invokeScript = null;
      await dropAgent(agentId);
    }
  });

  it("a skill that reaches a connector: a member's request isn't held, its card is the one prompt and names the host, and Allow attaches it; an outsider's is still held for the owner's Today (TASK-1135)", async () => {
    const { botId, agentId } = await supportBot();
    invokes.length = 0;
    grantCalls.length = 0;
    const verdicts: unknown[] = [];
    // The `n`th turn's pre-call verdict, once it has one (the turn reaches agent:invoke before the
    // real gate, which reads Postgres, has answered).
    const verdictOf = async (n: number): Promise<unknown> => {
      await vi.waitFor(() => expect(verdicts).toHaveLength(n), { timeout: 10_000 });
      return verdicts[n - 1];
    };
    // `request_capability` on the real tool-policy and decisions. The broker isn't in this preset's
    // KEEP, so the script fires its card the way the broker does, once the call wasn't held.
    invokeScript = async (ctx) => {
      const call = { id: `toolu_skill_${invokes.length}`, name: 'request_capability', input: { skillId: 'walk-weather-report' } };
      const verdict = await theBus!.fire('tool:pre-call', ctx, call);
      verdicts.push(verdict);
      if (isHold(verdict)) {
        await theBus!.fire('chat:stream-chunk', ctx, {
          reqId: ctx.reqId,
          kind: 'tool-result',
          held: true,
          toolCallId: call.id,
          output: 'held',
        });
      } else {
        await theBus!.fire('chat:stream-chunk', ctx, { reqId: ctx.reqId, kind: 'text', text: 'Working on it.' });
        await theBus!.fire('chat:permission-request', ctx, {
          kind: 'skill',
          skillId: 'walk-weather-report',
          description: 'Gets the current weather for a city.',
          hosts: ['api.open-meteo.com'],
          slots: [],
          packages: { npm: [], pypi: [] },
        });
      }
      await theBus!.fire('chat:turn-end', ctx, { reqId: ctx.reqId, reason: 'user-message-wait' });
    };
    try {
      // Mel is there to answer: the call runs, nothing is held, and the card is the one question.
      const melTs = nextTs();
      let mark = slackCalls.length;
      expect((await deliverToOwnBot(botId, botMention(MEL, melTs, 'use the weather skill'))).status).toBe(200);
      const attended = await invokedTurn(1);
      expect(attended.ctx).toMatchObject({ userId: 'usr_mel', source: 'user' });
      expect(isHold(await verdictOf(1))).toBe(false);
      let calls = await slackCallsUntil(mark, 'chat.stopStream', 'reactions.remove', 'chat.postMessage');
      expect(await listDecisions('usr_mel')).toEqual([]);
      const asked = promptsIn(calls);
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatchObject({ channel: SUPPORT_CHANNEL, threadTs: melTs });
      expect(JSON.stringify(asked[0]!.blocks)).toContain('api.open-meteo.com');
      expect(sentText(calls)).not.toContain('I need your OK');

      // Mel's Allow attaches it: one grant, as her.
      mark = slackCalls.length;
      expect((await click(botId, MEL, asked[0]!, 'allow')).status).toBe(200);
      calls = await slackCallsUntil(mark, 'chat.update');
      expect(String(callOf(calls, 'chat.update').body['text'])).toBe("Connected. Send your message again and I'll use it.");
      expect(grantCalls).toHaveLength(1);
      expect(grantCalls[0]).toMatchObject({
        userId: 'usr_mel',
        input: { conversationId: attended.ctx.conversationId, userId: 'usr_mel', agentId, skillId: 'walk-weather-report' },
      });

      // Carol is no member: her turn runs as Ada with nobody there, so the call is still held, the
      // row waits in Ada's Today, and no prompt goes into the thread.
      mark = slackCalls.length;
      expect((await deliverToOwnBot(botId, botMention(CAROL, nextTs(), 'use the weather skill'))).status).toBe(200);
      const external = await invokedTurn(2);
      expect(external.ctx).toMatchObject({ userId: 'usr_ada', source: 'external' });
      expect(isHold(await verdictOf(2))).toBe(true);
      await channelTurnCalls(mark);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const adaRows = await listDecisions('usr_ada');
      expect(adaRows).toHaveLength(1);
      expect(adaRows[0]).toMatchObject({ ruleId: 'skills.request-capability', status: 'pending', ownerUserId: 'usr_ada' });
      expect(promptsIn(slackCalls.slice(mark))).toEqual([]);
      expect(grantCalls).toHaveLength(1);
    } finally {
      invokeScript = null;
      await dropAgent(agentId);
    }
  });

  it("memory and a bot's channel: a member's thread is captured, an outsider's never is, and nothing the channel said once it is disconnected; no route switches a channel off (TASK-1094, TASK-1202)", async () => {
    const { botId, agentId } = await supportBot();
    invokes.length = 0;
    const preCapture = (conversationId: string) =>
      theBus!.fire(
        'memory:pre-capture',
        makeAgentContext({ sessionId: 'test', agentId, userId: 'usr_ada', conversationId }),
        { conversationId },
      );
    const refused = { rejected: true, reason: 'channel-not-remembered' };
    const outsiders = { rejected: true, reason: 'channel-external-turn' };

    // TASK-1202 (design §4c): a team agent's memory is shared with its team, so
    // no route switches a channel to "not remembered" any more.
    expect(routes.filter((r) => r.path.endsWith('/remember'))).toEqual([]);

    // A member's thread is captured like any other.
    const t1 = nextTs();
    let mark = slackCalls.length;
    expect((await deliverToOwnBot(botId, botMention(MEL, t1, 'first question'))).status).toBe(200);
    const first = (await invokedTurn(1)).ctx;
    expect(first).toMatchObject({ userId: 'usr_mel', source: 'user' });
    const conv1 = first.conversationId!;
    await channelTurnCalls(mark);
    // TASK-1146: the answer carries the names the thread's label shows (the display name the
    // Slack fake serves, and the member id), so memory can tell who is speaking.
    const melNames = ['Mel', 'U07MEL00001'];
    expect(await preCapture(conv1)).toEqual({
      rejected: false,
      payload: { conversationId: conv1, speakerNames: melNames },
    });
    // A conversation this plugin never recorded (a web chat) isn't its to refuse, or to name.
    expect(await preCapture('cnv_a_web_chat')).toEqual({
      rejected: false,
      payload: { conversationId: 'cnv_a_web_chat' },
    });

    // An outsider's thread is never captured: Carol runs as Ada, and what she says would
    // otherwise be recalled as fact in the agent's later turns, members' included.
    mark = slackCalls.length;
    expect((await deliverToOwnBot(botId, botMention(CAROL, nextTs(), 'the refund window is 90 days'))).status).toBe(200);
    const outsider = (await invokedTurn(2)).ctx;
    expect(outsider).toMatchObject({ userId: 'usr_ada', source: 'external' });
    await channelTurnCalls(mark);
    expect(await preCapture(outsider.conversationId!)).toMatchObject(outsiders);

    // A second turn in the member's thread: the same conversation, still captured.
    mark = slackCalls.length;
    expect((await deliverToOwnBot(botId, botMention(MEL, nextTs(), 'second question', t1))).status).toBe(200);
    expect((await invokedTurn(3)).ctx.conversationId).toBe(conv1);
    await channelTurnCalls(mark);
    expect(await preCapture(conv1)).toEqual({
      rejected: false,
      payload: { conversationId: conv1, speakerNames: melNames },
    });

    // Disconnected: nothing the channel said is captured anymore.
    actor = { id: 'usr_ada', isAdmin: false };
    const disconnected = await callRoute('POST', '/settings/slack/:agentId/bot/disconnect', {
      params: { agentId },
      rawPath: `/settings/slack/${agentId}/bot/disconnect`,
      body: jsonBody({ installId: botId }),
    });
    actor = null;
    expect(disconnected).toMatchObject({ status: 200 });
    expect(await preCapture(conv1)).toMatchObject(refused);
    expect(await preCapture(outsider.conversationId!)).toMatchObject(outsiders);
    await dropAgent(agentId);
  });

  it('an admin replaces the configuration token: the install and every secret stay, the plugin still reads them as the admin whose token it is, and Rename then rotates the new token (TASK-1128, TASK-1175)', async () => {
    const installId = await connectWorkspace();
    await personalAgent('usr_alice');
    invokes.length = 0;
    const rowOf = async (): Promise<Record<string, unknown>> => {
      const rows = await query(
        'SELECT install_id, status, connected_by_user_id, config_token_added_at FROM channel_slack_v1_installs',
      );
      expect(rows).toHaveLength(1);
      return rows[0]!;
    };
    const rowBefore = await rowOf();
    expect(rowBefore['connected_by_user_id']).toBe(ADMIN);

    // Another admin pastes a new refresh token.
    actor = { id: 'usr_grace', isAdmin: true };
    const mark = slackCalls.length;
    const replaced = await callRoute('POST', '/admin/slack/replace-token', {
      body: jsonBody({ refreshToken: SECOND_CONFIG_REFRESH_TOKEN }),
    });
    expect(replaced).toEqual({ status: 200, body: {} });
    // Slack was asked twice: the pasted token tried once, then the app's manifest
    // sent with the access token that rotate minted, before anything was stored.
    const calls = slackCalls.slice(mark);
    expect(calls.map((c) => c.method)).toEqual(['tooling.tokens.rotate', 'apps.manifest.update']);
    expect(calls[0]!.body).toEqual({ refresh_token: SECOND_CONFIG_REFRESH_TOKEN });
    expect(calls[1]!.auth).toBe(`Bearer ${ROTATED_ACCESS_TOKEN}`);
    expect(calls[1]!.body['app_id']).toBe(APP_ID);

    // The vault holds the token Slack minted, as the token of the admin whose
    // app it is, whoever pasted it (TASK-1175); the other secrets did not move.
    const kept = await readConfigToken(ADMIN);
    expect(kept).toBe(rotatedRefreshToken(rotateSeq));
    expect(kept).not.toBe(SECOND_CONFIG_REFRESH_TOKEN);
    expect(await readConfigToken('usr_grace')).toMatch(/^error:/);
    expect(await readSecret(installId, 'bot-token')).toBe(BOT_TOKEN);
    expect(await readSecret(installId, 'signing-secret')).toBe(SIGNING_SECRET);

    // The same install, still the first admin's: only the date moved.
    const rowAfter = await rowOf();
    expect(rowAfter['install_id']).toBe(installId);
    expect(rowAfter['status']).toBe('active');
    expect(rowAfter['connected_by_user_id']).toBe(ADMIN);
    expect(rowAfter['config_token_added_at']).not.toEqual(rowBefore['config_token_added_at']);
    // `created_at` is the database's clock and the replace uses the host's, so compare to the row itself.
    const status = await callRoute('GET', '/admin/slack');
    expect(status).toMatchObject({
      status: 200,
      body: {
        state: 'connected',
        connectedBy: 'Ada Admin',
        connectedAt: (rowAfter['config_token_added_at'] as Date).toISOString(),
      },
    });

    // The plugin still reads the signing secret and the bot token, naming the first admin: a DM
    // is verified with the one and answered with the other.
    actor = null;
    const turnMark = slackCalls.length;
    expect((await deliver(installId, dm(ALICE, 'D07ALICEDM1', nextTs(), 'still there?'))).status).toBe(200);
    await invokedTurn(1);
    const turnCalls = await dmTurnCalls(turnMark);
    expect(callOf(turnCalls, 'chat.startStream').auth).toBe(`Bearer ${BOT_TOKEN}`);

    // Rename rotates the replaced token, not the one Connect kept.
    actor = { id: 'usr_grace', isAdmin: true };
    const renameMark = slackCalls.length;
    const rename = await callRoute('POST', '/admin/slack/rename', { body: jsonBody({ botName: 'Canopy Helper' }) });
    expect(rename).toMatchObject({ status: 200, body: { botName: 'Canopy Helper' } });
    expect(slackCalls[renameMark]!.method).toBe('tooling.tokens.rotate');
    expect(slackCalls[renameMark]!.body).toEqual({ refresh_token: kept });

    actor = null;
  });
  // Last on purpose: the raw SQL above assumes one install row. This test ends with none (it
  // disconnects the shared workspace itself, and the agent's deletion takes the bot).
  it("a team agent's own bot: requested, allowed, mentioned, a shared-bot mention in the channel runs no turn, Disconnect leaves it and keeps its approver's token, deleting the agent deletes it (TASK-1167)", async () => {
    const sharedId = await connectWorkspace();
    const { agentId } = await teamWithAgent('usr_ada', 'usr_mel');
    invokes.length = 0;
    const sharedToken = await readConfigToken(ADMIN);
    const sharedRefs = {
      bot: await readSecret(sharedId, 'bot-token'),
      signing: await readSecret(sharedId, 'signing-secret'),
    };
    expect(sharedRefs).toEqual({ bot: BOT_TOKEN, signing: SIGNING_SECRET });
    expect(sharedToken).toMatch(/^xoxe-/);
    const adaToken = await readConfigToken('usr_ada');
    expect(adaToken).toMatch(/^error:/);

    // 1. Ada, a team admin with no stored token, asks for the agent's own bot and pastes one.
    actor = { id: 'usr_ada', isAdmin: false };
    const requestMark = slackCalls.length;
    const requested = await callRoute('POST', '/settings/slack/:agentId/bot', {
      params: { agentId },
      rawPath: `/settings/slack/${agentId}/bot`,
      body: jsonBody({ botName: OWN_BOT_NAME, refreshToken: CONFIG_REFRESH_TOKEN, iconPng: ICON_PNG.toString('base64') }),
    });
    expect(requested).toMatchObject({ status: 200, body: { iconSet: true } });
    const requestCalls = slackCalls.slice(requestMark);
    expect(requestCalls.map((c) => c.method)).toEqual(['tooling.tokens.rotate', 'apps.manifest.create', 'apps.icon.set']);
    expect(requestCalls[0]!.body).toEqual({ refresh_token: CONFIG_REFRESH_TOKEN });
    expect(requestCalls[1]!.auth).toBe(`Bearer ${ROTATED_ACCESS_TOKEN}`);
    expect(requestCalls[2]!.body['app_id']).toBe(OWN_APP_ID);
    let adaSuccessor = rotatedRefreshToken(rotateSeq);

    // 2. Allow comes back to the bot's own callback, for the person who asked.
    const installUrl = new URL((requested.body as { installUrl: string }).installUrl);
    expect(installUrl.searchParams.get('client_id')).toBe(OWN_CLIENT_ID);
    expect(installUrl.searchParams.get('redirect_uri')).toBe(`${PUBLIC_ORIGIN}/slack/bots/oauth/callback`);
    const callbackMark = slackCalls.length;
    const callback = await callRoute('GET', '/slack/bots/oauth/callback', {
      query: { code: OAUTH_CODE, state: installUrl.searchParams.get('state')! },
    });
    expect(callback).toMatchObject({
      status: 302,
      location: `${PUBLIC_ORIGIN}/?slack-bot=connected&agentId=${agentId}`,
    });
    actor = null;
    expect(slackCalls.slice(callbackMark).map((c) => c.method)).toEqual(['oauth.v2.access', 'users.info']);

    // 3. The vault and the row.
    const botRows = await query("SELECT * FROM channel_slack_v1_installs WHERE kind = 'bot'");
    expect(botRows).toHaveLength(1);
    const ownId = botRows[0]!['install_id'] as string;
    expect(ownId).not.toBe(sharedId);
    expect(botRows[0]).toMatchObject({
      status: 'active',
      agent_id: agentId,
      requested_by_user_id: 'usr_ada',
      connected_by_user_id: 'usr_ada',
      bot_user_id: OWN_BOT_USER_ID,
      bot_handle: OWN_BOT_HANDLE,
      bot_name: OWN_BOT_NAME,
      app_id: OWN_APP_ID,
    });
    expect(await readSecret(ownId, 'bot-token')).toBe(OWN_BOT_TOKEN);
    expect(await readSecret(ownId, 'signing-secret')).toBe(OWN_SIGNING_SECRET);
    expect(await readSecret(ownId, 'client-secret')).toBe(OWN_CLIENT_SECRET);
    // A bot has no configuration token of its own: its approver's is the person's one.
    expect(await readSecret(ownId, 'config-refresh-token')).toMatch(/^error:/);
    expect(await readConfigToken('usr_ada')).toBe(adaSuccessor);
    expect(adaSuccessor).not.toBe(CONFIG_REFRESH_TOKEN);
    // The shared install's refs and its person's token did not move.
    expect(await readSecret(sharedId, 'bot-token')).toBe(sharedRefs.bot);
    expect(await readSecret(sharedId, 'signing-secret')).toBe(sharedRefs.signing);
    expect(await readConfigToken(ADMIN)).toBe(sharedToken);
    expect(await query("SELECT install_id FROM channel_slack_v1_installs WHERE kind = 'shared'")).toEqual([
      { install_id: sharedId },
    ]);

    // 4. A member mentions the bot: its first mention in the channel writes the binding, and the
    // turn is the agent's, as Mel, under a key that names the bot's install.
    const melTs = nextTs();
    let mark = slackCalls.length;
    expect((await deliverToOwnBot(ownId, botMention(MEL, melTs, 'who owns this bot?'))).status).toBe(200);
    const melTurn = await invokedTurn(1);
    expect(melTurn.ctx).toMatchObject({ userId: 'usr_mel', agentId, source: 'user', audience: 'shared' });
    expect(await conversationRow(melTurn.ctx.conversationId!)).toEqual({
      owner: 'usr_mel',
      key: `slack:${ownId}:${SUPPORT_CHANNEL}:${melTs}`,
    });
    const calls = await channelTurnCalls(mark);
    expect(callOf(calls, 'chat.startStream').auth).toBe(`Bearer ${OWN_BOT_TOKEN}`);
    expect(
      await query('SELECT agent_id, connected_by_user_id FROM channel_slack_v1_channels WHERE install_id = $1 AND channel_id = $2', [
        ownId,
        SUPPORT_CHANNEL,
      ]),
    ).toEqual([{ agent_id: agentId, connected_by_user_id: 'usr_ada' }]);

    // An outsider on the same bot runs as its requester, Ada, who is still a team admin.
    const bobTs = nextTs();
    mark = slackCalls.length;
    expect((await deliverToOwnBot(ownId, botMention(BOB, bobTs, 'can you help me?'))).status).toBe(200);
    const bobTurn = await invokedTurn(2);
    expect(bobTurn.ctx).toMatchObject({ userId: 'usr_ada', agentId, source: 'external', audience: 'shared' });
    expect((await conversationRow(bobTurn.ctx.conversationId!)).key).toBe(
      `slack:${ownId}:${SUPPORT_CHANNEL}:${bobTs}:external`,
    );
    await channelTurnCalls(mark);

    // 5. The shared bot, mentioned in the same channel by Mel, runs no turn: one private line to
    // her, in that channel, after the one lookup of who she is. The line's text is not pinned here.
    mark = slackCalls.length;
    expect(
      (
        await deliver(sharedId, {
          type: 'app_mention',
          user: MEL.slackId,
          channel: SUPPORT_CHANNEL,
          ts: nextTs(),
          text: `<@${BOT_USER_ID}> hello shared bot`,
        })
      ).status,
    ).toBe(200);
    const aside = await slackCallsUntil(mark, 'chat.postEphemeral');
    expect(aside.map((c) => c.method)).toEqual(['users.info', 'chat.postEphemeral']);
    expect(aside[1]!.body).toMatchObject({ channel: SUPPORT_CHANNEL, user: MEL.slackId });
    expect(invokes).toHaveLength(2);

    // 5b. Ada renames the live bot (TASK-1171). Her own token rotates, Slack gets the WHOLE
    // manifest the request sent with only the two name fields changed, and the row shows the
    // new name once Slack said yes. Slack's users.info keeps the handle (the fake's does).
    actor = { id: 'usr_ada', isAdmin: false };
    const ownRenameMark = slackCalls.length;
    expect(
      await callRoute('POST', '/settings/slack/:agentId/bot/rename', {
        params: { agentId },
        rawPath: `/settings/slack/${agentId}/bot/rename`,
        body: jsonBody({ botName: 'Support Desk' }),
      }),
    ).toMatchObject({ status: 200, body: { botName: 'Support Desk' } });
    const ownRenameCalls = slackCalls.slice(ownRenameMark);
    expect(ownRenameCalls.map((c) => c.method)).toEqual(['tooling.tokens.rotate', 'apps.manifest.update', 'users.info']);
    expect(ownRenameCalls[0]!.body).toEqual({ refresh_token: adaSuccessor });
    const ownUpdate = ownRenameCalls[1]!;
    expect(ownUpdate.auth).toBe(`Bearer ${ROTATED_ACCESS_TOKEN}`);
    expect(ownUpdate.body['app_id']).toBe(OWN_APP_ID);
    const ownRenamedManifest = JSON.parse(String(requestCalls[1]!.body['manifest'])) as {
      display_information: { name: string };
      features: { bot_user: { display_name: string } };
    };
    ownRenamedManifest.display_information.name = 'Support Desk';
    ownRenamedManifest.features.bot_user.display_name = 'Support Desk';
    expect(JSON.parse(String(ownUpdate.body['manifest']))).toEqual(ownRenamedManifest);
    expect(await query("SELECT bot_name, bot_handle FROM channel_slack_v1_installs WHERE kind = 'bot'")).toEqual([
      { bot_name: 'Support Desk', bot_handle: OWN_BOT_HANDLE },
    ]);
    // Slack retired the token it just rotated: the route kept the new one.
    expect(await readConfigToken('usr_ada')).toBe(rotatedRefreshToken(rotateSeq));
    expect(rotatedRefreshToken(rotateSeq)).not.toBe(adaSuccessor);
    adaSuccessor = rotatedRefreshToken(rotateSeq);

    // 5c. Ada changes its picture: her token rotates, the PNG goes up for the bot's own app, and
    // the row does not move.
    const iconMark = slackCalls.length;
    expect(
      await callRoute('POST', '/settings/slack/:agentId/bot/icon', {
        params: { agentId },
        rawPath: `/settings/slack/${agentId}/bot/icon`,
        body: jsonBody({ iconPng: ICON_PNG.toString('base64') }),
      }),
    ).toMatchObject({ status: 200, body: {} });
    actor = null;
    const picCalls = slackCalls.slice(iconMark);
    expect(picCalls.map((c) => c.method)).toEqual(['tooling.tokens.rotate', 'apps.icon.set']);
    expect(picCalls[0]!.body).toEqual({ refresh_token: adaSuccessor });
    expect(picCalls[1]!.auth).toBe(`Bearer ${ROTATED_ACCESS_TOKEN}`);
    expect(picCalls[1]!.body['app_id']).toBe(OWN_APP_ID);
    const picFile = picCalls[1]!.body['file'];
    if (!(picFile instanceof File)) throw new Error('apps.icon.set got no file');
    expect(Buffer.from(await picFile.arrayBuffer()).equals(ICON_PNG)).toBe(true);
    expect(await query("SELECT bot_name, bot_handle FROM channel_slack_v1_installs WHERE kind = 'bot'")).toEqual([
      { bot_name: 'Support Desk', bot_handle: OWN_BOT_HANDLE },
    ]);
    adaSuccessor = rotatedRefreshToken(rotateSeq);
    expect(await readConfigToken('usr_ada')).toBe(adaSuccessor);

    // 6. Admin > Slack's Disconnect takes the shared app and leaves the bot, its refs and Ada's
    // token. The shared install's person (ADMIN) approved no bot, so their token goes.
    actor = { id: ADMIN, isAdmin: true };
    const disconnectMark = slackCalls.length;
    expect(await callRoute('POST', '/admin/slack/disconnect')).toEqual({
      status: 200,
      body: { appDeleted: true, tokenKept: false },
    });
    actor = null;
    expect(slackCalls.slice(disconnectMark).map((c) => c.method)).toEqual(['tooling.tokens.rotate', 'apps.manifest.delete']);
    expect(slackCalls[disconnectMark + 1]!.body['app_id']).toBe(APP_ID);
    expect(await readConfigToken(ADMIN)).toMatch(/^error:/);
    expect(await readSecret(sharedId, 'bot-token')).toMatch(/^error:/);
    const stillThere = await query('SELECT install_id, status FROM channel_slack_v1_installs');
    expect(stillThere).toEqual([{ install_id: ownId, status: 'active' }]);
    expect(await readSecret(ownId, 'bot-token')).toBe(OWN_BOT_TOKEN);
    expect(await readSecret(ownId, 'signing-secret')).toBe(OWN_SIGNING_SECRET);
    expect(await readSecret(ownId, 'client-secret')).toBe(OWN_CLIENT_SECRET);
    expect(await readConfigToken('usr_ada')).toBe(adaSuccessor);

    // 7. Deleting the agent deletes its bot: the app, the row, the three refs, then Ada's token.
    const dropMark = slackCalls.length;
    await dropAgent(agentId);
    await vi.waitFor(
      async () => expect(await query('SELECT install_id FROM channel_slack_v1_installs')).toEqual([]),
      { timeout: 10_000 },
    );
    const dropCalls = slackCalls.slice(dropMark).filter((c) => c.method === 'tooling.tokens.rotate' || c.method === 'apps.manifest.delete');
    expect(dropCalls.map((c) => c.method)).toEqual(['tooling.tokens.rotate', 'apps.manifest.delete']);
    expect(dropCalls[0]!.body).toEqual({ refresh_token: adaSuccessor });
    expect(dropCalls[1]!.auth).toBe(`Bearer ${ROTATED_ACCESS_TOKEN}`);
    expect(dropCalls[1]!.body['app_id']).toBe(OWN_APP_ID);
    for (const name of ['bot-token', 'signing-secret', 'client-secret']) {
      expect(await readSecret(ownId, name)).toMatch(/^error:/);
    }
    expect(await readConfigToken('usr_ada')).toMatch(/^error:/);
    expect(await query('SELECT channel_id FROM channel_slack_v1_channels')).toEqual([]);
  });
});
