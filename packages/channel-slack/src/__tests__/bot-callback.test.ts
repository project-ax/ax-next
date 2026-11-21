import { createHash, randomBytes } from 'node:crypto';
import { HookBus, PluginError, makeAgentContext, type Logger } from '@ax/core';
import { describe, expect, it } from 'vitest';
import { createBotCallbackRoute } from '../bot-callback.js';
import type { BotRequestDms } from '../bot-request-dms.js';
import { createBots } from '../bots.js';
import type { RouteRequest, RouteResponse } from '../http-types.js';
import { OAUTH_STATE_BYTES, OAUTH_STATE_TTL_MS, SLACK_TOKEN_MAX } from '../limits.js';
import { botUrls } from '../manifest.js';
import { createMutex, type Mutex } from '../mutex.js';
import { configTokenRef, createSecretStore, secretRef } from '../secrets.js';
import { SlackApiError } from '../slack-api.js';
import { fakeAgents, type FakeAgent } from './fake-agents.js';
import {
  APP,
  BOT_TOKEN,
  BOT_USER,
  CLIENT_SECRET,
  GRANT,
  MINTED_ACCESS,
  NOW_MS,
  SIGNING_SECRET,
  fakeSlack,
  mintedRefresh,
  type SlackBehaviour,
} from './fake-slack-config.js';
import {
  BOT_PREFIX,
  CONFIG_ACCESS_PREFIX,
  CONFIG_REFRESH_PREFIX,
  fakeBotToken,
  fakeConfigRefreshToken,
} from './fake-slack-tokens.js';
import { busVault } from './fake-vault.js';
import { memoryStore, type Row } from './memory-install-store.js';

/*
  The bot's OAuth callback (TASK-1167): where Slack sends a team agent's bot's
  approver after they click Allow, or Cancel, on its install page. The route
  (bot-callback.ts) in front of the real domain (bots.ts: `finish`, and the
  `request` and `installUrl` that make the pending bot and its state), on the
  in-memory install store, the real secret store over a fake vault, @ax/agents'
  answers and a fake Slack.

  What it pins:
    - the state binds one signed-in person (login CSRF): anyone else's browser
      is refused WITHOUT spending it, and learns no agent;
    - only a bot's state is read here, and each works once;
    - the bot goes live only for its approver, while they still manage its
      agent, and only in the workspace the shared bot is live in;
    - its @handle is kept only when a copy line can show it;
    - every answer is a redirect to the app's root, naming the bot's agent
      (read from its row) only for the person the state was minted for;
    - an AX admin who approved a team admin's request in Admin › Slack
      (TASK-1169) finishes it while still an AX admin, and lands back in
      Admin › Slack (`from=admin`), never on the agent's settings;
    - a connected Allow tells the bot request's DMs (TASK-1170,
      bot-request-dms.ts, a recording fake here) the bot is live, once, only
      once the app lock is free, and never waits for them;
    - no redirect or log line carries a code, a state, a token or a Slack id.
*/

// ── Fixtures ────────────────────────────────────────────────────────────────

const ORIGIN = 'https://ax.example';
/** The bot's own callback: the redirect_uri in its manifest and install link. */
const CALLBACK = '/slack/bots/oauth/callback';
const BOT_CALLBACK = 'https://ax.example/slack/bots/oauth/callback';
const CODE = '7512345678901.7598765432109.0123456789abcdef';

/** The shared app (Admin › Slack), live in the Canopy Works workspace, connected by Ada. */
const SHARED_INSTALL = 'q3VtZ0xH4kTn9Wb2LmPa1A';
const SHARED_APP = 'A07SHAREDAPP';
const SHARED_BOT_USER = 'U07SHAREDBOT';
const SHARED_TEAM = 'T07ABCDEF12';
const SHARED_BOT_TOKEN = fakeBotToken('SHAREDBOTSECRET');

const SUPPORT_TEAM = 'team_support';
const SUPPORT: FakeAgent = {
  id: 'agt_support',
  displayName: 'Support',
  visibility: 'team',
  ownerType: 'team',
  ownerId: SUPPORT_TEAM,
};

/** Connected the shared app; a team admin of the support team. */
const ADA = 'usr_ada';
/** A team admin of the support team: she asks for its bot, so she approves it. */
const GRACE = 'usr_grace';
/** A plain member of the support team. */
const MEL = 'usr_mel';
/** An AX admin on no team: she approves Grace's request in Admin › Slack (TASK-1169). */
const HEDY = 'usr_hedy';

/** Each person's own configuration token (TASK-1175). */
const ADA_STORED = fakeConfigRefreshToken('ADASTOREDSECRET');
const GRACE_STORED = fakeConfigRefreshToken('GRACESTOREDSECRET');
const HEDY_STORED = fakeConfigRefreshToken('HEDYSTOREDSECRET');
/** Grace's open request for the support agent's bot (TASK-1169). */
const REQUEST = 'U3VwcG9ydEJvdEFzazAwMQ';

const BOT_NAME = 'Support Helper';
/** The new bot user's @handle: its display name, the name it was asked for (fake-slack-config.ts BOT_USER). */
const HANDLE = BOT_USER.real_name;
/** Text a failure's message carries, which no log line may repeat. */
const FAILURE_CANARY = 'failure-text-canary-5be2';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
/** A database or vault fault, as pg throws one: an errno code (logged) and a message (never logged). */
const connectionReset = (): Error => Object.assign(new Error(`connection reset ${FAILURE_CANARY}`), { code: 'ECONNRESET' });

/** The app's root, with the outcome alone: what a browser the state wasn't minted for is sent. */
const home = (outcome: 'connected' | 'cancelled' | 'failed'): string => `${ORIGIN}/?slack-bot=${outcome}`;
/** The app's root, with the outcome and the bot's agent: only for the person the state was minted for. */
const toAgent = (outcome: 'connected' | 'cancelled' | 'failed'): string =>
  `${ORIGIN}/?slack-bot=${outcome}&agentId=agt_support`;
/** The app's root, back to Admin › Slack: an AX admin who approved a team admin's request (TASK-1169). */
const toAdmin = (outcome: 'connected' | 'cancelled' | 'failed'): string => `${ORIGIN}/?slack-bot=${outcome}&from=admin`;

// ── A request and response shaped like @ax/http-server's ───────────────────

interface Answered {
  status: number;
  /** Which terminator finished the response, or null while it is open. */
  how: 'json' | 'text' | 'end' | 'redirect' | null;
  body: unknown;
  location: string | null;
}

/** The whole of a redirect, as the route must answer every request. */
const redirect = (location: string): Answered => ({ status: 302, how: 'redirect', body: undefined, location });

function fakeResponse(): { res: RouteResponse; answer: Answered } {
  const answer: Answered = { status: 200, how: null, body: undefined, location: null };
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
    header() {
      return res;
    },
    json(v) {
      finish('json', v);
    },
    text(s) {
      finish('text', s);
    },
    end() {
      finish('end');
    },
    redirect(url, status) {
      // Like http-server: 302 by default, and only a 3xx.
      const code = status ?? 302;
      if (code < 300 || code > 399) throw new Error(`redirect status must be 3xx: got ${code}`);
      answer.status = code;
      answer.location = url;
      finish('redirect');
    },
  };
  return { res, answer };
}

/** A browser's GET, signed in as `as` (the session the fake auth reads), or signed out. */
function request(query: Record<string, string>, as: string | null): RouteRequest {
  return {
    method: 'GET',
    path: CALLBACK,
    rawPath: CALLBACK,
    params: {},
    query,
    headers: as === null ? {} : { 'x-test-user': as },
    body: Buffer.alloc(0),
  };
}

// ── The world ───────────────────────────────────────────────────────────────

interface Line {
  level: string;
  msg: string;
  fields: Record<string, unknown> | undefined;
}

/**
 * `lock`, and whether a step is running under it right now: what a call made
 * from inside a locked step would see, and one made after it never does.
 */
function watchLock(lock: Mutex): Mutex & { held: () => boolean } {
  let running = 0;
  return {
    run: (fn) =>
      lock.run(async () => {
        running += 1;
        try {
          return await fn();
        } finally {
          running -= 1;
        }
      }),
    held: () => running > 0,
  };
}

/**
 * The shared app live, with its secrets and Ada's token; Grace's token stored;
 * Ada and Grace team admins of the support agent's team, Mel a member.
 */
function world(o: { publicOrigin?: string; lock?: Mutex; agent?: FakeAgent } = {}) {
  let nowMs = NOW_MS;
  /** Every vault, store and Slack call, in order. */
  const trail: string[] = [];
  const lines: Line[] = [];
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, fields });
  };
  const logger: Logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: () => logger };

  const bus = new HookBus();
  const { vault, vaultCalls, vaultFailures } = busVault(bus, trail);
  const agent = o.agent ?? SUPPORT;
  const people = fakeAgents(bus);
  people.addAgent(agent);
  for (const admin of [ADA, GRACE]) people.setRole(SUPPORT_TEAM, admin, 'admin');
  people.setRole(SUPPORT_TEAM, MEL, 'member');

  /** auth:require-user: the browser's session, named by its header. `fault` makes it throw. */
  const auth: { fault?: unknown } = {};
  bus.registerService('auth:require-user', '@ax/auth-better', async (_ctx, raw) => {
    if (auth.fault !== undefined) throw auth.fault;
    const id = (raw as { req: RouteRequest }).req.headers['x-test-user'];
    if (id === undefined) {
      throw new PluginError({ code: 'unauthenticated', plugin: '@ax/auth-better', message: 'no session' });
    }
    return { user: { id, isAdmin: false } };
  });
  /** auth:get-user: auth's own accounts, which `finish` asks about an AX admin approver (TASK-1169). */
  const users = new Map([
    [ADA, { id: ADA, displayName: 'Ada Admin', email: 'ada@canopyworks.example', isAdmin: true }],
    [GRACE, { id: GRACE, displayName: 'Grace Hopper', email: 'grace@canopyworks.example', isAdmin: false }],
    [MEL, { id: MEL, displayName: 'Mel Member', email: 'mel@canopyworks.example', isAdmin: false }],
    [HEDY, { id: HEDY, displayName: 'Hedy Lamarr', email: 'hedy@canopyworks.example', isAdmin: true }],
  ]);
  bus.registerService('auth:get-user', '@ax/auth-better', async (_ctx, raw) => {
    const user = users.get((raw as { userId: string }).userId);
    return user === undefined ? null : { ...user };
  });

  const memory = memoryStore(() => nowMs, trail);
  const slack = fakeSlack(trail);
  const lock = watchLock(o.lock ?? createMutex());
  /**
   * bot-request-dms.ts, recorded: each bot it was told went live, and whether
   * the app lock was held then. Its promise settles at once, or never when
   * `never` is set: a Slack that never answers.
   */
  const dms = { calls: [] as Array<{ installId: string; lockHeld: boolean }>, never: false };
  const notices: Pick<BotRequestDms, 'live'> = {
    live: (i) => {
      dms.calls.push({ installId: i.installId, lockHeld: lock.held() });
      return dms.never ? new Promise<void>(() => {}) : Promise.resolve();
    },
  };
  const publicOrigin = o.publicOrigin ?? ORIGIN;
  const bots = createBots({
    bus,
    installs: memory.store,
    secrets: createSecretStore(bus, { logger }),
    api: slack.api,
    lock,
    publicOrigin,
    logger,
    now: () => nowMs,
    randomBytes: (n) => randomBytes(n),
  });
  const route = createBotCallbackRoute({
    bus,
    installs: memory.store,
    lock,
    bots,
    dms: notices,
    publicOrigin,
    logger,
    now: () => nowMs,
  });

  const answers: Answered[] = [];
  const ctxOf = (userId: string) => makeAgentContext({ sessionId: 'channel-slack', agentId: '', userId, logger });

  return {
    bus,
    auth,
    users,
    people,
    agent,
    vault,
    vaultCalls,
    vaultFailures,
    memory,
    slack,
    trail,
    lines,
    answers,
    route,
    bots,
    dms,
    ctxOf,
    advance(ms: number): void {
      nowMs += ms;
    },
    /** The browser's visit to the callback, as `as` (Grace unless told otherwise; null: signed out). */
    async callback(query: Record<string, string>, as: string | null = GRACE): Promise<Answered> {
      const { res, answer } = fakeResponse();
      await route.handler(request(query, as), res);
      answers.push(answer);
      return answer;
    },
    /** Grace asks for the agent's bot with her stored token: Task 7's request, unchanged. */
    async request(): Promise<{ status: number; body: unknown }> {
      return bots.request({
        ctx: ctxOf(GRACE),
        actorUserId: GRACE,
        agentId: agent.id,
        botName: BOT_NAME,
        refreshToken: null,
        icon: null,
      });
    },
    /**
     * Grace asked an AX admin, and Hedy (an AX admin on no team) approves her
     * open request with her stored token: the one create path, under the app
     * lock, as Admin › Slack's approve runs it (TASK-1169).
     */
    async approve(): Promise<{ status: number; body: unknown }> {
      await memory.store.insertBotRequest({
        requestId: REQUEST,
        agentId: agent.id,
        requestedByUserId: GRACE,
        botName: BOT_NAME,
      });
      return lock.run(() =>
        bots.create({
          agentId: agent.id,
          approverUserId: HEDY,
          requesterUserId: GRACE,
          botName: BOT_NAME,
          refreshToken: null,
          icon: null,
          requestId: REQUEST,
        }),
      );
    },
    /** Continue in Slack, as Grace (or `as`): a fresh state for the pending bot (the earlier one stops matching). */
    async continueInSlack(as: string = GRACE): Promise<string> {
      const reply = await bots.installUrl({ actorUserId: as, agentId: agent.id });
      expect(reply.status).toBe(200);
      return stateIn(reply.body);
    },
    row(installId: string): Row {
      const r = memory.rows.get(installId);
      if (r === undefined) throw new Error(`no row ${installId}`);
      return r;
    },
  };
}

type World = ReturnType<typeof world>;

function stateIn(body: unknown): string {
  const state = new URL((body as { installUrl: string }).installUrl).searchParams.get('state');
  if (state === null) throw new Error('no state in the install link');
  return state;
}

/** Start watching from here: the calls so far were the test's own seeding. */
function forget(w: World): void {
  w.trail.length = 0;
  w.memory.calls.length = 0;
  w.slack.calls.length = 0;
  w.vaultCalls.length = 0;
  w.people.calls.length = 0;
  w.lines.length = 0;
  w.dms.calls.length = 0;
}

/** The shared app live in SHARED_TEAM, with its secrets and Ada's token; Grace's own token stored. */
async function seed(w: World): Promise<void> {
  await w.memory.store.insertPending({
    installId: SHARED_INSTALL,
    appId: SHARED_APP,
    clientId: '7512345678901.7500000000001',
    botName: 'canopy-works',
    connectedByUserId: ADA,
  });
  await w.memory.store.activate(SHARED_INSTALL, {
    teamId: SHARED_TEAM,
    teamName: 'Canopy Works',
    botUserId: SHARED_BOT_USER,
    installedAt: new Date(NOW_MS),
  });
  w.vault.set(secretRef(SHARED_INSTALL, 'bot-token'), SHARED_BOT_TOKEN);
  w.vault.set(secretRef(SHARED_INSTALL, 'signing-secret'), 'SHAREDSIGNINGSECRET0a1b2c3d');
  w.vault.set(secretRef(SHARED_INSTALL, 'client-secret'), 'SHAREDCLIENTSECRET9f8e7d6c5');
  w.vault.set(configTokenRef(ADA), ADA_STORED);
  w.vault.set(configTokenRef(GRACE), GRACE_STORED);
  forget(w);
}

/** A world where Grace has asked for the agent's bot: its install id and the state her install link carries. */
async function requested(o: Parameters<typeof world>[0] = {}): Promise<{ w: World; installId: string; state: string }> {
  const w = world(o);
  await seed(w);
  const reply = await w.request();
  expect(reply.status).toBe(200);
  const bot = [...w.memory.rows.values()].find((r) => r.kind === 'bot');
  if (bot === undefined) throw new Error('the request made no bot');
  forget(w);
  return { w, installId: bot.installId, state: stateIn(reply.body) };
}

/**
 * A world where Hedy, an AX admin on no team, approved Grace's request for
 * the agent's bot (TASK-1169): its install id and the state her link carries.
 */
async function approved(o: Parameters<typeof world>[0] = {}): Promise<{ w: World; installId: string; state: string }> {
  const w = world(o);
  await seed(w);
  w.vault.set(configTokenRef(HEDY), HEDY_STORED);
  const reply = await w.approve();
  expect(reply.status).toBe(200);
  const bot = [...w.memory.rows.values()].find((r) => r.kind === 'bot');
  if (bot === undefined) throw new Error('the approve made no bot');
  forget(w);
  return { w, installId: bot.installId, state: stateIn(reply.body) };
}

function methods(w: World): string[] {
  return w.slack.calls.map((c) => c.method);
}

/**
 * Hold the app lock, as another Slack-app step would, from the moment this
 * resolves until `free()`. `done` settles once the lock is let go.
 */
async function holdLock(lock: Mutex): Promise<{ free: () => void; done: Promise<void> }> {
  let free!: () => void;
  let held!: () => void;
  const holding = new Promise<void>((resolve) => {
    held = resolve;
  });
  const done = lock.run(
    () =>
      new Promise<void>((resolve) => {
        free = resolve;
        held();
      }),
  );
  await holding;
  return { free, done };
}

const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

/** What `p` answers, or 'still waiting' when it hasn't once every step that can run has run. */
async function soon<T>(p: Promise<T>): Promise<T | 'still waiting'> {
  const waited = (async () => {
    for (let i = 0; i < 10; i += 1) await settle();
    return 'still waiting' as const;
  })();
  return Promise.race([p, waited]);
}

// ── The route ───────────────────────────────────────────────────────────────

describe('GET /slack/bots/oauth/callback', () => {
  it('is one GET at the redirect_uri every bot registers with Slack, CSRF-checked like any signed-in route, reading no body', () => {
    const { route } = world();
    expect(route.method).toBe('GET');
    expect(route.path).toBe(CALLBACK);
    expect(route.bypassCsrf).toBeUndefined();
    expect(route.maxBodyBytes).toBeUndefined();
    // Slack sends the approver back to exactly this URL, or refuses the code.
    expect(botUrls(ORIGIN, 'AAAAAAAAAAAAAAAAAAAAAA').redirectUrl).toBe(BOT_CALLBACK);
  });

  it("the approver's Allow activates the bot, stores its token, reads its handle and lands on its agent", async () => {
    const { w, installId, state } = await requested();
    w.advance(30_000);

    expect(await w.callback({ code: CODE, state })).toStrictEqual(redirect(toAgent('connected')));

    expect(w.trail).toEqual([
      // The state: read as a bot's, its person checked, then spent; then the bot it names.
      'store:peekOAuthState',
      'store:consumeOAuthState',
      'store:get',
      // The workspace the shared bot is live in, before Slack is asked anything.
      'store:current',
      // The code traded with the bot's own client secret, the bot token kept, THEN the row live.
      'vault:get client-secret',
      'slack:oauthAccess',
      'vault:set bot-token',
      'store:activate',
      // Last, best-effort: the handle Slack gave the bot user.
      'slack:usersInfo',
      'store:setBotHandle',
    ]);
    // Only a bot's state is read and spent here.
    expect(w.memory.calls.filter((c) => c.method === 'peekOAuthState' || c.method === 'consumeOAuthState').map((c) => c.args)).toEqual([
      [sha256(state), 'bot'],
      [sha256(state), 'bot'],
    ]);
    // The redirect_uri Slack checks the code against is the bot's own callback, never Admin › Slack's.
    expect(w.slack.calls.find((c) => c.method === 'oauthAccess')!.args).toEqual([
      { clientId: APP.clientId, clientSecret: CLIENT_SECRET, code: CODE, redirectUri: BOT_CALLBACK },
    ]);
    expect(w.slack.calls.find((c) => c.method === 'usersInfo')!.args).toEqual([BOT_TOKEN, 'U07BOTUSER1']);
    expect(w.vault.get(secretRef(installId, 'bot-token'))).toBe(BOT_TOKEN);
    // Rights asked as Grace, a non-admin: workspace-admin status never counts.
    expect(w.people.inputs('agents:can-set-shared-credential')).toEqual([
      { agentId: SUPPORT.id, actor: { userId: GRACE, isAdmin: false } },
    ]);
    expect(w.row(installId)).toMatchObject({
      kind: 'bot',
      status: 'active',
      agentId: SUPPORT.id,
      teamId: SHARED_TEAM,
      teamName: 'Canopy Works',
      botUserId: 'U07BOTUSER1',
      botHandle: HANDLE,
      installedAt: new Date(NOW_MS + 30_000),
      stateHash: null,
    });
    expect(w.lines).toEqual([{ level: 'info', msg: 'slack_bot_connected', fields: { installId } }]);
    // The shared app is untouched.
    expect(w.row(SHARED_INSTALL)).toMatchObject({ status: 'active', botUserId: SHARED_BOT_USER, botHandle: null });
    expect(w.vault.get(secretRef(SHARED_INSTALL, 'bot-token'))).toBe(SHARED_BOT_TOKEN);
  });

  it("another signed-in user's browser is refused without spending the state, with no agent id; the approver's visit then works", async () => {
    const { w, installId, state } = await requested();

    // Another team admin, and a plain member: each is someone the state wasn't minted for.
    for (const as of [ADA, MEL]) {
      expect(await w.callback({ code: CODE, state }, as), as).toStrictEqual(redirect(home('failed')));
    }
    // Only the peek: nothing spent, no bot read, Slack never asked.
    expect(w.trail).toEqual(['store:peekOAuthState', 'store:peekOAuthState']);
    expect(w.row(installId)).toMatchObject({ status: 'pending', stateHash: sha256(state) });
    expect(w.lines).toEqual([
      { level: 'warn', msg: 'slack_bot_install_refused', fields: { installId, reason: 'state-user-mismatch' } },
      { level: 'warn', msg: 'slack_bot_install_refused', fields: { installId, reason: 'state-user-mismatch' } },
    ]);

    expect(await w.callback({ code: CODE, state })).toStrictEqual(redirect(toAgent('connected')));
    expect(w.row(installId).status).toBe('active');
  });

  it('signed out: failed, state not spent', async () => {
    const { w, installId, state } = await requested();

    expect(await w.callback({ code: CODE, state }, null)).toStrictEqual(redirect(home('failed')));
    // Nothing read: the state was never even looked at.
    expect(w.trail).toEqual([]);
    expect(w.lines).toEqual([{ level: 'info', msg: 'slack_bot_install_refused', fields: { reason: 'unauthenticated' } }]);

    // Auth itself failing: the same, logged by the gate code-only.
    w.lines.length = 0;
    w.auth.fault = new PluginError({ code: 'session-store-down', plugin: '@ax/auth-better', message: `down ${FAILURE_CANARY}` });
    expect(await w.callback({ code: CODE, state })).toStrictEqual(redirect(home('failed')));
    expect(w.trail).toEqual([]);
    expect(w.lines).toEqual([
      { level: 'error', msg: 'slack_channel_route_failed', fields: { stage: 'auth', code: 'session-store-down' } },
    ]);

    delete w.auth.fault;
    expect(w.row(installId).stateHash).toBe(sha256(state));
    expect(await w.callback({ code: CODE, state })).toStrictEqual(redirect(toAgent('connected')));
  });

  it('a missing or malformed state, or not exactly one of a usable code and an error: failed, nothing read, the state still good', async () => {
    const { w, state } = await requested();
    const refusals: Array<[Record<string, string>, string]> = [
      [{ code: CODE }, 'invalid-state'],
      [{ code: CODE, state: 'not-a-state' }, 'invalid-state'],
      [{ code: CODE, state: state.toUpperCase() }, 'invalid-state'],
      [{ code: CODE, state: `${state}0` }, 'invalid-state'],
      // Slack sends a code after Allow and an error after Cancel: never neither, never both.
      [{ state }, 'invalid-request'],
      [{ state, code: CODE, error: 'access_denied' }, 'invalid-request'],
      [{ state, code: '' }, 'invalid-request'],
      [{ state, code: 'has space' }, 'invalid-request'],
      [{ state, code: 'x'.repeat(SLACK_TOKEN_MAX + 1) }, 'invalid-request'],
    ];
    for (const [query] of refusals) {
      expect(await w.callback(query), JSON.stringify(query)).toStrictEqual(redirect(home('failed')));
    }
    expect(w.trail).toEqual([]);
    expect(w.lines).toEqual(
      refusals.map(([, reason]) => ({ level: 'info', msg: 'slack_bot_install_refused', fields: { reason } })),
    );
    expect(await w.callback({ code: CODE, state })).toStrictEqual(redirect(toAgent('connected')));
  });

  it("a shared install's state is unknown here, and so is one nobody minted: neither is spent", async () => {
    const w = world();
    await seed(w);
    // Admin › Slack's own install, waiting for its Allow, its state minted for Grace herself: only its kind tells it apart.
    const shared = w.row(SHARED_INSTALL);
    shared.status = 'pending';
    const sharedState = randomBytes(OAUTH_STATE_BYTES).toString('hex');
    const expiresAt = new Date(NOW_MS + OAUTH_STATE_TTL_MS);
    await w.memory.store.setOAuthState(SHARED_INSTALL, { stateHash: sha256(sharedState), userId: GRACE, expiresAt });
    forget(w);

    expect(await w.callback({ code: CODE, state: sharedState })).toStrictEqual(redirect(home('failed')));
    expect(await w.callback({ code: CODE, state: 'f'.repeat(64) })).toStrictEqual(redirect(home('failed')));

    expect(w.trail).toEqual(['store:peekOAuthState', 'store:peekOAuthState']);
    expect(w.memory.calls.map((c) => c.args)).toEqual([
      [sha256(sharedState), 'bot'],
      [sha256('f'.repeat(64)), 'bot'],
    ]);
    expect(w.lines).toEqual([
      { level: 'info', msg: 'slack_bot_install_refused', fields: { reason: 'invalid-state' } },
      { level: 'info', msg: 'slack_bot_install_refused', fields: { reason: 'invalid-state' } },
    ]);
    // Still there, unspent, for Admin › Slack's own callback.
    expect(await w.memory.store.peekOAuthState(sha256(sharedState), 'shared')).toEqual({
      installId: SHARED_INSTALL,
      userId: GRACE,
      expiresAt,
    });
  });

  it('expired → failed; access_denied → cancelled; another error → failed: each spends the state and asks Slack nothing', async () => {
    const { w, installId, state } = await requested();

    w.advance(OAUTH_STATE_TTL_MS);
    expect(await w.callback({ code: CODE, state })).toStrictEqual(redirect(toAgent('failed')));
    expect(w.row(installId).stateHash).toBeNull();

    const denied = await w.continueInSlack();
    expect(await w.callback({ error: 'access_denied', state: denied })).toStrictEqual(redirect(toAgent('cancelled')));
    expect(w.row(installId).stateHash).toBeNull();

    // Any other error Slack reports is a failure, not a cancel, and its text goes nowhere.
    const other = await w.continueInSlack();
    expect(await w.callback({ error: 'invalid_team_for_non_distributed_app', state: other })).toStrictEqual(
      redirect(toAgent('failed')),
    );
    expect(w.row(installId).stateHash).toBeNull();

    expect(methods(w)).not.toContain('oauthAccess');
    expect(w.row(installId).status).toBe('pending');
    expect(w.lines).toEqual([
      { level: 'warn', msg: 'slack_bot_install_refused', fields: { installId, reason: 'expired' } },
      { level: 'info', msg: 'slack_bot_install_refused', fields: { installId, reason: 'cancelled' } },
      { level: 'warn', msg: 'slack_bot_install_refused', fields: { installId, reason: 'slack-error' } },
    ]);

    // One millisecond short of its expiry, a state still works.
    const last = await w.continueInSlack();
    w.advance(OAUTH_STATE_TTL_MS - 1);
    expect(await w.callback({ code: CODE, state: last })).toStrictEqual(redirect(toAgent('connected')));
  });

  it("an app-id mismatch, an enterprise install, another workspace's team, or no active shared install: failed, still pending, no bot token stored", async () => {
    const cases: Array<[reason: string, arrange: (w: World) => void, slackAsked: boolean]> = [
      [
        'app-mismatch',
        (w) => {
          w.slack.on.oauthAccess = async () => ({ ...GRANT, appId: 'A07OTHERAPP1' });
        },
        true,
      ],
      [
        'enterprise-install',
        (w) => {
          w.slack.on.oauthAccess = async () => ({ ...GRANT, enterpriseInstall: true });
        },
        true,
      ],
      // The approver's configuration token was another workspace's: Slack made and installed the app there.
      [
        'team-mismatch',
        (w) => {
          w.slack.on.oauthAccess = async () => ({ ...GRANT, teamId: 'T07OTHERTEAM' });
        },
        true,
      ],
      // Admin › Slack disconnected the shared bot meanwhile.
      [
        'no-workspace',
        (w) => {
          w.memory.rows.delete(SHARED_INSTALL);
        },
        false,
      ],
      // …or connected it again, not yet allowed.
      [
        'no-workspace',
        (w) => {
          w.row(SHARED_INSTALL).status = 'pending';
        },
        false,
      ],
    ];
    for (const [reason, arrange, slackAsked] of cases) {
      const { w, installId, state } = await requested();
      arrange(w);

      expect(await w.callback({ code: CODE, state }), reason).toStrictEqual(redirect(toAgent('failed')));
      expect(w.row(installId).status, reason).toBe('pending');
      expect(w.row(installId).teamId, reason).toBeNull();
      expect(w.vault.has(secretRef(installId, 'bot-token')), reason).toBe(false);
      expect(w.vaultCalls.map((c) => c.ref), reason).not.toContain(secretRef(installId, 'bot-token'));
      expect(methods(w).includes('oauthAccess'), reason).toBe(slackAsked);
      expect(methods(w), reason).not.toContain('usersInfo');
      expect(w.lines, reason).toEqual([
        { level: 'warn', msg: 'slack_bot_install_refused', fields: { installId, reason } },
      ]);
    }
  });

  it('an approver who no longer manages the agent: failed, nothing stored', async () => {
    // Demoted to a member (forbidden), or off the team altogether (the agent is no longer theirs to see).
    for (const [reason, role] of [
      ['forbidden', 'member'],
      ['not-found', null],
    ] as const) {
      const { w, installId, state } = await requested();
      w.people.setRole(SUPPORT_TEAM, GRACE, role);

      expect(await w.callback({ code: CODE, state }), reason).toStrictEqual(redirect(toAgent('failed')));
      // Asked before Slack: no code is traded for a token nobody may hold.
      expect(methods(w), reason).toEqual([]);
      expect(w.row(installId).status, reason).toBe('pending');
      expect(w.vault.has(secretRef(installId, 'bot-token')), reason).toBe(false);
      expect(w.lines, reason).toEqual([
        { level: 'warn', msg: 'slack_bot_install_refused', fields: { installId, reason } },
      ]);
    }
  });

  it("a state minted for someone who isn't the bot's approver: failed, and Slack is asked nothing", async () => {
    const { w, installId } = await requested();
    // Only Continue in Slack mints a bot's state, and only for its approver: one for Ada can only be planted.
    const planted = randomBytes(OAUTH_STATE_BYTES).toString('hex');
    await w.memory.store.setOAuthState(installId, {
      stateHash: sha256(planted),
      userId: ADA,
      expiresAt: new Date(NOW_MS + OAUTH_STATE_TTL_MS),
    });
    forget(w);

    expect(await w.callback({ code: CODE, state: planted }, ADA)).toStrictEqual(redirect(toAgent('failed')));
    expect(methods(w)).toEqual([]);
    expect(w.row(installId).status).toBe('pending');
    expect(w.lines).toEqual([
      { level: 'warn', msg: 'slack_bot_install_refused', fields: { installId, reason: 'not-approver' } },
    ]);
  });

  it('a bot that is no longer pending, or has lost its client secret: failed, and Slack is asked nothing', async () => {
    const active = await requested();
    active.w.row(active.installId).status = 'active';
    expect(await active.w.callback({ code: CODE, state: active.state })).toStrictEqual(redirect(toAgent('failed')));

    const noSecret = await requested();
    noSecret.w.vault.delete(secretRef(noSecret.installId, 'client-secret'));
    expect(await noSecret.w.callback({ code: CODE, state: noSecret.state })).toStrictEqual(redirect(toAgent('failed')));

    for (const [{ w, installId }, reason] of [
      [active, 'not-pending'],
      [noSecret, 'no-client-secret'],
    ] as const) {
      expect(methods(w), reason).toEqual([]);
      expect(w.lines, reason).toEqual([
        { level: 'warn', msg: 'slack_bot_install_refused', fields: { installId, reason } },
      ]);
    }
  });

  it("Slack refusing the code, or a bot token that won't store: failed, logged once by the step, still pending; Continue in Slack then finishes it", async () => {
    const refused = await requested();
    refused.w.slack.on.oauthAccess = async () => {
      throw new SlackApiError('oauth.v2.access', 'invalid_code');
    };
    expect(await refused.w.callback({ code: CODE, state: refused.state })).toStrictEqual(redirect(toAgent('failed')));
    expect(refused.w.lines).toEqual([
      {
        level: 'warn',
        msg: 'slack_bot_failed',
        fields: { installId: refused.installId, stage: 'oauth-access', code: 'invalid_code' },
      },
    ]);

    const unstored = await requested();
    unstored.w.vaultFailures.set('credentials:set bot-token', connectionReset());
    expect(await unstored.w.callback({ code: CODE, state: unstored.state })).toStrictEqual(redirect(toAgent('failed')));
    expect(unstored.w.lines).toEqual([
      {
        level: 'error',
        msg: 'slack_bot_failed',
        fields: { installId: unstored.installId, stage: 'bot-token', code: 'ECONNRESET' },
      },
    ]);
    expect(unstored.w.vault.has(secretRef(unstored.installId, 'bot-token'))).toBe(false);

    for (const { w, installId } of [refused, unstored]) {
      expect(w.row(installId).status).toBe('pending');
      expect(methods(w)).not.toContain('usersInfo');
    }

    refused.w.slack.on.oauthAccess = async () => ({ ...GRANT });
    unstored.w.vaultFailures.delete('credentials:set bot-token');
    for (const { w, installId } of [refused, unstored]) {
      expect(await w.callback({ code: CODE, state: await w.continueInSlack() })).toStrictEqual(
        redirect(toAgent('connected')),
      );
      expect(w.row(installId)).toMatchObject({ status: 'active', botHandle: HANDLE });
    }
  });

  it('users.info failing, or no display name and a legacy name outside the handle pattern or reserved (channel, here, everyone): active with a null handle', async () => {
    // No display name anywhere, unless `fields` says one: only the legacy `name` is left.
    const answer = (fields: Record<string, unknown>): SlackBehaviour['usersInfo'] => async () => ({
      ...structuredClone(BOT_USER),
      real_name: '',
      profile: { ...structuredClone(BOT_USER.profile), display_name: '', real_name: '' },
      ...fields,
    });
    // Every display field says `shown`, and the legacy name is unusable too.
    const allShownAs = (shown: unknown): Record<string, unknown> => ({
      name: '',
      real_name: shown,
      profile: { ...structuredClone(BOT_USER.profile), display_name: shown, real_name: shown },
    });
    const cases: Array<[label: string, usersInfo: SlackBehaviour['usersInfo'], line: Line]> = [];
    const unusable = (label: string, fields: Record<string, unknown>, code = 'unusable-handle'): void => {
      cases.push([label, answer(fields), { level: 'warn', msg: 'slack_bot_failed', fields: { stage: 'bot-handle', code } }]);
    };
    cases.push([
      'users.info failing',
      async () => {
        throw new SlackApiError('users.info', 'ratelimited');
      },
      { level: 'warn', msg: 'slack_bot_failed', fields: { stage: 'bot-handle', code: 'ratelimited' } },
    ]);
    // Slack's broadcast words, and its own bot's name: a copy line would show them as `@<handle>`.
    for (const reserved of ['channel', 'here', 'everyone', 'slackbot']) unusable(reserved, { name: reserved });
    unusable('upper case and a space', { name: 'Support Helper' });
    unusable('a leading separator', { name: '-support' });
    unusable('a mention', { name: '<!channel>' });
    unusable('empty', { name: '' });
    unusable('81 characters', { name: 'a'.repeat(81) });
    unusable('not a string', { name: 42 });
    unusable('no name at all', { name: undefined });
    // A display name a copy line can't show, or one Slack would never take as a bot name, is no handle either.
    for (const reserved of ['here', 'Channel', 'EVERYONE', 'slack-bot', 'slack_bot']) {
      unusable(`a reserved display name: ${reserved}`, allShownAs(reserved));
    }
    unusable('a display name that mentions', allShownAs('<!channel>'));
    unusable('a display name with an @', allShownAs('@fern'));
    unusable('a display name with an accent', allShownAs('Café'));
    unusable('a display name with untidy spaces', allShownAs(' fern  walk '));
    unusable('a display name of 36 characters', allShownAs('a'.repeat(36)));
    unusable('a display name with no letter or digit', allShownAs('-._'));
    unusable('a display name not a string', allShownAs(42));
    unusable('a profile not an object', { name: '', profile: 'fern-walk' });
    // An answer about some other user is no answer about the bot.
    unusable('another user', { id: 'U07SOMEONE1' }, 'user-mismatch');

    for (const [label, usersInfo, line] of cases) {
      const { w, installId, state } = await requested();
      w.slack.on.usersInfo = usersInfo;

      expect(await w.callback({ code: CODE, state }), label).toStrictEqual(redirect(toAgent('connected')));
      expect(w.row(installId), label).toMatchObject({ status: 'active', botHandle: null });
      expect(w.trail, label).not.toContain('store:setBotHandle');
      expect(w.lines, label).toEqual([
        { ...line, fields: { installId, ...line.fields } },
        { level: 'info', msg: 'slack_bot_connected', fields: { installId } },
      ]);
    }

    // The store refusing the handle: still live, logged as our own fault.
    const { w, installId, state } = await requested();
    w.memory.failures.set('setBotHandle', connectionReset());
    expect(await w.callback({ code: CODE, state })).toStrictEqual(redirect(toAgent('connected')));
    expect(w.row(installId)).toMatchObject({ status: 'active', botHandle: null });
    expect(w.lines).toEqual([
      { level: 'error', msg: 'slack_bot_failed', fields: { installId, stage: 'bot-handle', code: 'ECONNRESET' } },
      { level: 'info', msg: 'slack_bot_connected', fields: { installId } },
    ]);
  });

  it('keeps the display name people type (@fern-walk), never the legacy username Slack derived from it (fernwalk) (TASK-1185)', async () => {
    // Measured on real Slack (TASK-1174 walk): asking for `fern-walk` gave
    // users.info `name` = `fernwalk`, while the @-mention, the autocomplete and
    // `/invite` all use `fern-walk`.
    const fern = (profile: Record<string, unknown>, realName = 'fern-walk'): SlackBehaviour['usersInfo'] =>
      async () => ({
        ...structuredClone(BOT_USER),
        name: 'fernwalk',
        real_name: realName,
        profile: { ...structuredClone(BOT_USER.profile), ...profile },
      });
    const cases: Array<[label: string, usersInfo: SlackBehaviour['usersInfo'], handle: string]> = [
      ['the profile display name', fern({ display_name: 'fern-walk', real_name: 'fern-walk' }), 'fern-walk'],
      // In order: the display name, then the profile's real name, then the top-level one.
      ['the display name first', fern({ display_name: 'fern-walk', real_name: 'Fern Profile' }, 'Fern Top'), 'fern-walk'],
      ['then the profile real name', fern({ display_name: '', real_name: 'Fern Profile' }, 'Fern Top'), 'Fern Profile'],
      // A bot user's display_name may be empty: its real_name carries the name.
      ['no display name: the profile real name', fern({ display_name: '', real_name: 'fern-walk' }), 'fern-walk'],
      ['only the top-level real name', fern({ display_name: '', real_name: '' }), 'fern-walk'],
      // Upper case and a space are a bot name Slack takes, so they are a handle too.
      ['a name with a space', fern({ display_name: '', real_name: 'Fern Walk' }, 'Fern Walk'), 'Fern Walk'],
      // A display name a copy line can't show falls through to the next field, never cleaned.
      ['an unusable display name', fern({ display_name: '@here', real_name: 'fern-walk' }), 'fern-walk'],
      // Nothing but the legacy username: the last resort.
      ['no display name anywhere', fern({ display_name: '', real_name: '' }, ''), 'fernwalk'],
      ['every display name unusable', fern({ display_name: 'here', real_name: '<!here>' }, 'slack-bot'), 'fernwalk'],
    ];
    for (const [label, usersInfo, handle] of cases) {
      const { w, installId, state } = await requested();
      w.slack.on.usersInfo = usersInfo;

      expect(await w.callback({ code: CODE, state }), label).toStrictEqual(redirect(toAgent('connected')));
      expect(w.row(installId).botHandle, label).toBe(handle);
    }
  });

  it('with no display name, a legacy name inside the pattern is kept as Slack gave it', async () => {
    for (const name of ['a', '0bot', 'support.helper_2-x', 'a'.repeat(80)]) {
      const { w, installId, state } = await requested();
      w.slack.on.usersInfo = async () => ({
        ...structuredClone(BOT_USER),
        name,
        real_name: '',
        profile: { ...structuredClone(BOT_USER.profile), display_name: '', real_name: '' },
      });

      expect(await w.callback({ code: CODE, state }), name).toStrictEqual(redirect(toAgent('connected')));
      expect(w.row(installId).botHandle, name).toBe(name);
    }
  });

  it('a state works once, even for two visits at once', async () => {
    const { w, installId, state } = await requested();

    expect(await w.callback({ code: CODE, state })).toStrictEqual(redirect(toAgent('connected')));
    w.lines.length = 0;
    // The replay: the state is spent, so nothing here knows it, and no agent is named.
    expect(await w.callback({ code: CODE, state })).toStrictEqual(redirect(home('failed')));
    expect(methods(w).filter((m) => m === 'oauthAccess')).toHaveLength(1);
    expect(w.row(installId).status).toBe('active');
    expect(w.lines).toEqual([{ level: 'info', msg: 'slack_bot_install_refused', fields: { reason: 'invalid-state' } }]);

    const twice = await requested();
    const both = await Promise.all([
      twice.w.callback({ code: CODE, state: twice.state }),
      twice.w.callback({ code: CODE, state: twice.state }),
    ]);
    expect(both).toStrictEqual([redirect(toAgent('connected')), redirect(home('failed'))]);
    expect(methods(twice.w).filter((m) => m === 'oauthAccess')).toHaveLength(1);
  });

  it('the callback waits for the one app lock: nothing is read, and Slack asked nothing, while another Slack-app step holds it', async () => {
    const lock = createMutex();
    const { w, state } = await requested({ lock });
    const held = await holdLock(lock);

    const answered = w.callback({ code: CODE, state });
    for (let i = 0; i < 5; i += 1) await settle();
    expect(w.trail).toEqual([]);
    expect(w.answers).toEqual([]);

    held.free();
    await held.done;
    expect(await answered).toStrictEqual(redirect(toAgent('connected')));
  });

  it('a store or rights fault mid-callback: failed, logged code-only, with the install once it is known', async () => {
    const early = await requested();
    early.w.memory.failures.set('consumeOAuthState', Object.assign(new Error(`deadlock ${FAILURE_CANARY}`), { code: '40P01' }));
    // The bot was never read, so no agent is named.
    expect(await early.w.callback({ code: CODE, state: early.state })).toStrictEqual(redirect(home('failed')));
    expect(early.w.lines).toEqual([
      { level: 'error', msg: 'slack_bot_failed', fields: { installId: early.installId, stage: 'callback', code: '40P01' } },
    ]);

    const late = await requested();
    late.w.people.faults.set(
      'agents:resolve',
      new PluginError({ code: 'agents-down', plugin: '@ax/agents', message: `down ${FAILURE_CANARY}` }),
    );
    expect(await late.w.callback({ code: CODE, state: late.state })).toStrictEqual(redirect(toAgent('failed')));
    expect(late.w.lines).toEqual([
      { level: 'error', msg: 'slack_bot_failed', fields: { installId: late.installId, stage: 'callback', code: 'agents-down' } },
    ]);
    expect(methods(late.w)).toEqual([]);
    expect(late.w.row(late.installId).status).toBe('pending');
  });

  it('the redirect names only the outcome, and the agent from the bot row, whatever the request carries', async () => {
    const { w, state } = await requested({ publicOrigin: `${ORIGIN}/` });
    const res = await w.callback({
      code: CODE,
      state,
      agentId: 'agt_elsewhere',
      'slack-bot': 'cancelled',
      redirect_uri: 'https://evil.example/',
      next: '//evil.example',
    });
    expect(res).toStrictEqual(redirect(toAgent('connected')));

    // An agent id that needs escaping stays one parameter.
    const odd: FakeAgent = { ...SUPPORT, id: 'agt odd&next=//evil.example#x' };
    const other = await requested({ agent: odd });
    const location = (await other.w.callback({ code: CODE, state: other.state })).location!;
    const url = new URL(location);
    expect(`${url.origin}${url.pathname}`).toBe(`${ORIGIN}/`);
    expect([...url.searchParams]).toEqual([
      ['slack-bot', 'connected'],
      ['agentId', 'agt odd&next=//evil.example#x'],
    ]);
    expect(url.hash).toBe('');
  });

  it('sends an AX admin who approved back to Admin › Slack: the bot goes live, and the address never names the agent', async () => {
    const { w, installId, state } = await approved();

    const res = await w.callback({ code: CODE, state }, HEDY);

    expect(res).toStrictEqual(redirect(toAdmin('connected')));
    expect(res.location).toBe('https://ax.example/?slack-bot=connected&from=admin');
    expect(w.row(installId)).toMatchObject({
      status: 'active',
      connectedByUserId: HEDY,
      requestedByUserId: GRACE,
      botHandle: HANDLE,
    });
    // Her own rights were never asked of @ax/agents: the requester's were, as a non-admin.
    for (const input of w.people.inputs('agents:resolve')) expect(input).toEqual({ agentId: SUPPORT.id, userId: GRACE });
    expect(w.people.inputs('agents:can-set-shared-credential')).toEqual([
      { agentId: SUPPORT.id, actor: { userId: GRACE, isAdmin: false } },
    ]);
    expect(w.lines).toEqual([{ level: 'info', msg: 'slack_bot_connected', fields: { installId } }]);
  });

  it("an AX admin's cancel, expiry or refusal lands in Admin › Slack too; a refusal is logged by its reason", async () => {
    const cancelled = await approved();
    expect(await cancelled.w.callback({ error: 'access_denied', state: cancelled.state }, HEDY)).toStrictEqual(
      redirect(toAdmin('cancelled')),
    );

    const expired = await approved();
    expired.w.advance(OAUTH_STATE_TTL_MS);
    expect(await expired.w.callback({ code: CODE, state: expired.state }, HEDY)).toStrictEqual(redirect(toAdmin('failed')));

    // No longer an AX admin by the time she clicks Allow.
    const demoted = await approved();
    demoted.w.users.get(HEDY)!.isAdmin = false;
    expect(await demoted.w.callback({ code: CODE, state: demoted.state }, HEDY)).toStrictEqual(redirect(toAdmin('failed')));
    expect(demoted.w.lines).toEqual([
      { level: 'warn', msg: 'slack_bot_install_refused', fields: { installId: demoted.installId, reason: 'not-admin' } },
    ]);

    // The requester is no longer a team admin of the agent's team.
    const unclaimed = await approved();
    unclaimed.w.people.setRole(SUPPORT_TEAM, GRACE, 'member');
    expect(await unclaimed.w.callback({ code: CODE, state: unclaimed.state }, HEDY)).toStrictEqual(
      redirect(toAdmin('failed')),
    );
    expect(unclaimed.w.lines).toEqual([
      {
        level: 'warn',
        msg: 'slack_bot_install_refused',
        fields: { installId: unclaimed.installId, reason: 'requester-not-admin' },
      },
    ]);

    for (const { w, installId } of [cancelled, expired, demoted, unclaimed]) {
      expect(methods(w)).not.toContain('oauthAccess');
      expect(w.row(installId).status).toBe('pending');
    }

    // A fault once the bot is known still lands her in Admin › Slack.
    const faulted = await approved();
    faulted.w.people.faults.set(
      'agents:resolve',
      new PluginError({ code: 'agents-down', plugin: '@ax/agents', message: `down ${FAILURE_CANARY}` }),
    );
    expect(await faulted.w.callback({ code: CODE, state: faulted.state }, HEDY)).toStrictEqual(redirect(toAdmin('failed')));
    expect(faulted.w.lines).toEqual([
      { level: 'error', msg: 'slack_bot_failed', fields: { installId: faulted.installId, stage: 'callback', code: 'agents-down' } },
    ]);
  });

  it("anyone else's browser with an AX admin's state learns nothing: no from=admin, the state unspent", async () => {
    const { w, installId, state } = await approved();

    // The requester herself, and the team admin who connected the shared app: neither is whom the state binds.
    for (const as of [GRACE, ADA]) {
      expect(await w.callback({ code: CODE, state }, as), as).toStrictEqual(redirect(home('failed')));
    }
    expect(w.row(installId)).toMatchObject({ status: 'pending', stateHash: sha256(state) });

    expect(await w.callback({ code: CODE, state }, HEDY)).toStrictEqual(redirect(toAdmin('connected')));
  });

  it('a team admin who asked for the bot herself still lands on its agent, even when she is an AX admin too', async () => {
    // Ada is an AX admin and a team admin of the support team: on the self path she is both approver and requester.
    const w = world();
    await seed(w);
    const reply = await w.bots.request({
      ctx: w.ctxOf(ADA),
      actorUserId: ADA,
      agentId: SUPPORT.id,
      botName: BOT_NAME,
      refreshToken: null,
      icon: null,
    });
    expect(reply.status).toBe(200);
    forget(w);

    expect(await w.callback({ code: CODE, state: stateIn(reply.body) }, ADA)).toStrictEqual(redirect(toAgent('connected')));
  });

  it("a connected Allow tells the DMs the bot is live, once, after the lock; a refused, cancelled, expired, mismatched or failed one doesn't", async () => {
    // Hedy's Allow on the bot she approved for Grace (TASK-1169): it goes live.
    const { w, installId, state } = await approved();
    expect(await w.callback({ code: CODE, state }, HEDY)).toStrictEqual(redirect(toAdmin('connected')));
    // Never under the app lock: a slow Slack must not hold up the next approve, connect or Allow.
    expect(w.dms.calls).toEqual([{ installId, lockHeld: false }]);
    // Once: the state is spent, so a replay tells nothing more.
    expect(await w.callback({ code: CODE, state }, HEDY)).toStrictEqual(redirect(home('failed')));
    expect(w.dms.calls).toHaveLength(1);

    // The self path is told too: whether anyone hears is bot-request-dms.ts's to decide, not the callback's.
    const self = await requested();
    expect(await self.w.callback({ code: CODE, state: self.state })).toStrictEqual(redirect(toAgent('connected')));
    expect(self.w.dms.calls).toEqual([{ installId: self.installId, lockHeld: false }]);

    // None of these went live, so nothing is said.
    const visits: Array<[string, (x: World, state: string) => Promise<Answered>]> = [
      ['signed out', (x, s) => x.callback({ code: CODE, state: s }, null)],
      ["someone else's browser", (x, s) => x.callback({ code: CODE, state: s }, GRACE)],
      ['a garbled state', (x) => x.callback({ code: CODE, state: 'not-a-state' }, HEDY)],
      ['cancelled', (x, s) => x.callback({ error: 'access_denied', state: s }, HEDY)],
      [
        'expired',
        (x, s) => {
          x.advance(OAUTH_STATE_TTL_MS);
          return x.callback({ code: CODE, state: s }, HEDY);
        },
      ],
      [
        'another workspace',
        (x, s) => {
          x.slack.on.oauthAccess = async () => ({ ...GRANT, teamId: 'T07OTHERTEAM' });
          return x.callback({ code: CODE, state: s }, HEDY);
        },
      ],
      [
        'Slack refusing the code',
        (x, s) => {
          x.slack.on.oauthAccess = async () => {
            throw new SlackApiError('oauth.v2.access', 'invalid_code');
          };
          return x.callback({ code: CODE, state: s }, HEDY);
        },
      ],
      [
        'no longer an AX admin',
        (x, s) => {
          x.users.get(HEDY)!.isAdmin = false;
          return x.callback({ code: CODE, state: s }, HEDY);
        },
      ],
      [
        'a store fault mid-callback',
        (x, s) => {
          x.memory.failures.set('consumeOAuthState', connectionReset());
          return x.callback({ code: CODE, state: s }, HEDY);
        },
      ],
    ];
    for (const [what, visit] of visits) {
      const x = await approved();
      const answered = await visit(x.w, x.state);
      expect(answered.location, what).not.toContain('connected');
      expect(x.w.row(x.installId).status, what).toBe('pending');
      expect(x.w.dms.calls, what).toEqual([]);
    }
  });

  it("a live notice that never settles doesn't hold the redirect, or the next visit that takes the lock", async () => {
    const { w, state } = await approved();
    // Slack never answers, so neither does the notice.
    w.dms.never = true;

    expect(await soon(w.callback({ code: CODE, state }, HEDY))).toStrictEqual(redirect(toAdmin('connected')));
    // The lock is free: the next visit takes it, and answers.
    expect(await soon(w.callback({ code: CODE, state }, HEDY))).toStrictEqual(redirect(home('failed')));
    expect(w.dms.calls).toHaveLength(1);
  });

  it('no redirect or log line carries the code, the state, a token or a Slack id', async () => {
    const { w, state } = await requested();
    const states = [state];
    // Signed out; someone else's browser; a garbled code.
    await w.callback({ code: CODE, state }, null);
    await w.callback({ code: CODE, state }, ADA);
    await w.callback({ code: `${CODE} ${FAILURE_CANARY}`, state });
    // Expired.
    w.advance(OAUTH_STATE_TTL_MS);
    await w.callback({ code: CODE, state });
    // Cancelled, and an error with text of Slack's own.
    for (const error of ['access_denied', `server_error ${FAILURE_CANARY}`]) {
      const s = await w.continueInSlack();
      states.push(s);
      await w.callback({ error, state: s });
    }
    // Another workspace.
    w.slack.on.oauthAccess = async () => ({ ...GRANT, teamId: 'T07OTHERTEAM' });
    const s1 = await w.continueInSlack();
    states.push(s1);
    await w.callback({ code: CODE, state: s1 });
    // Allowed, with users.info failing in words; then a replay.
    w.slack.on.oauthAccess = async () => ({ ...GRANT });
    w.slack.on.usersInfo = async () => {
      throw Object.assign(new Error(`users.info said ${FAILURE_CANARY} ${BOT_TOKEN}`), { code: 'ECONNRESET' });
    };
    const s2 = await w.continueInSlack();
    states.push(s2);
    expect((await w.callback({ code: CODE, state: s2 })).location).toBe(toAgent('connected'));
    await w.callback({ code: CODE, state: s2 });

    const locations = JSON.stringify(w.answers.map((a) => a.location));
    const logged = JSON.stringify(w.lines);
    const never = [
      CODE,
      ...states,
      ...states.map(sha256),
      // Every token: the approvers', the minted pair, the app's secrets, both bots'.
      GRACE_STORED,
      ADA_STORED,
      MINTED_ACCESS,
      mintedRefresh(1),
      CLIENT_SECRET,
      SIGNING_SECRET,
      BOT_TOKEN,
      SHARED_BOT_TOKEN,
      BOT_PREFIX,
      CONFIG_ACCESS_PREFIX,
      CONFIG_REFRESH_PREFIX,
      // Slack's ids: the workspaces, the bot users, the apps.
      SHARED_TEAM,
      'T07OTHERTEAM',
      GRANT.botUserId,
      SHARED_BOT_USER,
      APP.appId,
      APP.clientId,
      SHARED_APP,
      // People, the bot's names, and the failures' own words.
      ADA,
      GRACE,
      HANDLE,
      BOT_NAME,
      FAILURE_CANARY,
      'server_error',
    ];
    for (const text of never) {
      expect(locations, text).not.toContain(text);
      expect(logged, text).not.toContain(text);
    }
    // The agent is named to the approver's browser, never in a log line.
    expect(logged).not.toContain(SUPPORT.id);
    for (const a of w.answers) {
      const url = new URL(a.location!);
      expect(a.status).toBe(302);
      expect(`${url.origin}${url.pathname}`).toBe(`${ORIGIN}/`);
      expect([...url.searchParams.keys()].every((k) => k === 'slack-bot' || k === 'agentId')).toBe(true);
    }
    // Every line names the plugin's own words: an install, a reason, a stage, a code.
    for (const l of w.lines) {
      expect(l.msg).toMatch(/^slack_/);
      for (const key of Object.keys(l.fields ?? {})) expect(['installId', 'reason', 'stage', 'code']).toContain(key);
    }
  });
});
