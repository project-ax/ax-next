import { createHash, randomBytes } from 'node:crypto';
import { HookBus, makeAgentContext, type Logger } from '@ax/core';
import { describe, expect, it } from 'vitest';
import { createBotRequests, type AdminBotRequestList } from '../bot-requests.js';
import { createBots } from '../bots.js';
import { parseIconPng, type ParsedIcon } from '../icon.js';
import { BOT_REQUESTS_MAX, OAUTH_STATE_TTL_MS } from '../limits.js';
import { createMutex, type Mutex } from '../mutex.js';
import { configTokenRef, createSecretStore } from '../secrets.js';
import { SlackApiError } from '../slack-api.js';
import { InstallStoreError } from '../store.js';
import { fakeAgents, type FakeAgent } from './fake-agents.js';
import { pngBase64 } from './fake-png.js';
import { APP, CLIENT_SECRET, MINTED_ACCESS, NOW_MS, SIGNING_SECRET, fakeSlack, mintedRefresh } from './fake-slack-config.js';
import { BOT_PREFIX, CONFIG_ACCESS_PREFIX, CONFIG_REFRESH_PREFIX, fakeConfigRefreshToken } from './fake-slack-tokens.js';
import { busVault } from './fake-vault.js';
import { memoryStore, type Row } from './memory-install-store.js';

/*
  Asking an AX admin for a team agent's own Slack bot (TASK-1169): a team admin
  asks without a token, cancels, and an AX admin lists, approves or declines
  in Admin › Slack. The domain (bot-requests.ts) over the real bots domain
  (bots.ts: its one create path), the in-memory install store
  (memory-install-store.ts), the real secret store over a fake vault on the
  bus (fake-vault.ts), @ax/agents' answers (fake-agents.ts), auth's and
  @ax/teams' answers, and a fake Slack that retires a rotated refresh token at
  once (fake-slack-config.ts). The routes in front of it are agent-routes.test.ts
  and bot-request-routes.test.ts.

  What is pinned here: every step that changes a request or makes an app takes
  the one app lock, so two approves of one request make one app, and a cancel
  or a decline waits for an approve in flight. An approve uses the approving AX
  admin's own configuration token (stored, or pasted), and leaves the request
  open whenever it makes nothing. Admin › Slack's list names each request as its
  requester sees it, and carries no id but the request's own; no log line
  carries a name, an id or a token.
*/

// ── Fixtures ────────────────────────────────────────────────────────────────

const ORIGIN = 'https://ax.example';
const HTTP_ORIGIN = 'http://ax.internal:8080';

/** The shared app (Admin › Slack), connected by Kay. */
const SHARED_INSTALL = 'q3VtZ0xH4kTn9Wb2LmPa1A';
const SHARED_BOT_NAME = 'canopy-works';

const CARE_TEAM = 'team_care';
const SALES_TEAM = 'team_sales';
const TEAM_NAMES: ReadonlyArray<[string, string]> = [
  [CARE_TEAM, 'Customer Care'],
  [SALES_TEAM, 'Sales Team'],
];

/** A team admin of the care team: she asks for the support agent's bot. */
const ADA = 'usr_ada';
/** A plain member of the care team. */
const BOB = 'usr_bob';
/** A team admin of the sales team. */
const SAM = 'usr_sam';
/** An AX admin on no team at all: she approves in Admin › Slack. */
const GRACE = 'usr_grace';
/** Another AX admin on no team: she connected the shared app. */
const KAY = 'usr_kay';
const USERS = [
  { id: ADA, displayName: 'Ada Lovelace' as string | null, email: 'ada@canopyworks.example', isAdmin: false },
  { id: BOB, displayName: 'Bob Member' as string | null, email: 'bob@canopyworks.example', isAdmin: false },
  { id: SAM, displayName: 'Sam Sales' as string | null, email: 'sam@canopyworks.example', isAdmin: false },
  { id: GRACE, displayName: 'Grace Hopper' as string | null, email: 'grace@canopyworks.example', isAdmin: true },
  { id: KAY, displayName: 'Kay McNulty' as string | null, email: 'kay@canopyworks.example', isAdmin: true },
];

const SUPPORT: FakeAgent = {
  id: 'agt_support',
  displayName: 'Support',
  visibility: 'team',
  ownerType: 'team',
  ownerId: CARE_TEAM,
};
const SALES: FakeAgent = { id: 'agt_sales', displayName: 'Sales', visibility: 'team', ownerType: 'team', ownerId: SALES_TEAM };
/** Ada's own agent: no bot of its own. */
const PERSONAL: FakeAgent = { id: 'agt_ada_own', displayName: 'Ada Own', visibility: 'personal', ownerType: 'user', ownerId: ADA };

/** Each person's own configuration token (TASK-1175), as their last use of it left it. */
const ADA_STORED = fakeConfigRefreshToken('ADASTOREDSECRET');
const GRACE_STORED = fakeConfigRefreshToken('GRACESTOREDSECRET');
const KAY_STORED = fakeConfigRefreshToken('KAYSTOREDSECRET');
/** A refresh token an AX admin pastes into the Approve dialog. */
const PASTED = fakeConfigRefreshToken('PASTEDAPPROVESECRET');

/** Ada's open request for the support agent's bot: our own 22-character id. */
const REQUEST = 'U3VwcG9ydEJvdEFzazAwMQ';
/** Sam's open request for the sales agent's bot. */
const SALES_REQUEST = 'U2FsZXNCb3RBc2swMDAwMg';

const BOT_NAME = 'Support Helper';
/** The bot's picture the approving admin's browser drew: a 512 px PNG's header, all icon.ts reads. */
const ICON = parseIconPng(pngBase64(512, 512));
/** Text a failure's message carries, which no log line may repeat. */
const FAILURE_CANARY = 'failure-text-canary-5e7a';

// Built from code points, never typed (source-hygiene.test.ts).
const RLO = String.fromCharCode(0x202e);
const NEWLINE = String.fromCharCode(0x0a);

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
/** A database or vault fault, as pg throws one: an errno code (logged) and a message (never logged). */
const connectionReset = (): Error => Object.assign(new Error(`connection reset ${FAILURE_CANARY}`), { code: 'ECONNRESET' });

// ── The world ───────────────────────────────────────────────────────────────

interface Line {
  level: string;
  msg: string;
  fields: Record<string, unknown> | undefined;
}

interface Reply {
  status: number;
  body: unknown;
}

function world(o: { publicOrigin?: string; lock?: Mutex; teams?: boolean } = {}) {
  /** Every vault, store and Slack call, in order. */
  const trail: string[] = [];
  const lines: Line[] = [];
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, fields });
  };
  const logger: Logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: () => logger };

  const bus = new HookBus();
  const { vault, vaultCalls, vaultAs, vaultFailures } = busVault(bus, trail);
  const people = fakeAgents(bus);
  for (const agent of [SUPPORT, SALES, PERSONAL]) people.addAgent(agent);
  people.setRole(CARE_TEAM, ADA, 'admin');
  people.setRole(CARE_TEAM, BOB, 'member');
  people.setRole(SALES_TEAM, SAM, 'admin');

  // Auth's own accounts, by id: a test may rename one or delete one.
  const users = new Map(USERS.map((u) => [u.id, { ...u }]));
  const auth: { asked: string[]; fault?: unknown } = { asked: [] };
  bus.registerService('auth:get-user', '@ax/auth-better', async (_ctx, raw) => {
    const userId = (raw as { userId: string }).userId;
    auth.asked.push(userId);
    if (auth.fault !== undefined) throw auth.fault;
    const user = users.get(userId);
    return user === undefined ? null : { ...user };
  });

  // @ax/teams, unless the world has none: the teams a person has a role on, by name.
  const teams: { asked: string[]; fault?: unknown; names: Map<string, string> } = {
    asked: [],
    names: new Map(TEAM_NAMES),
  };
  if (o.teams !== false) {
    bus.registerService('teams:list-for-user', '@ax/teams', async (_ctx, raw) => {
      const userId = (raw as { userId: string }).userId;
      teams.asked.push(userId);
      if (teams.fault !== undefined) throw teams.fault;
      return {
        teams: people.teamsOf(userId).map((id) => ({
          id,
          displayName: teams.names.get(id) ?? id,
          createdBy: KAY,
          createdAt: new Date(NOW_MS),
        })),
      };
    });
  }

  /** When the store says a request was made: a test may move it. */
  const clock = { ms: NOW_MS };
  const memory = memoryStore(() => clock.ms, trail);
  const slack = fakeSlack(trail);
  const lock = o.lock ?? createMutex();
  const secrets = createSecretStore(bus, { logger });
  const publicOrigin = o.publicOrigin ?? ORIGIN;
  const bots = createBots({
    bus,
    installs: memory.store,
    secrets,
    api: slack.api,
    lock,
    publicOrigin,
    logger,
    now: () => NOW_MS,
    randomBytes: (n) => randomBytes(n),
  });
  const requests = createBotRequests({
    bus,
    installs: memory.store,
    secrets,
    bots,
    lock,
    publicOrigin,
    logger,
    randomBytes: (n) => randomBytes(n),
  });

  /** Every answer the domain gave, for the leak scan. */
  const replies: unknown[] = [];
  const keep = <T>(reply: T): T => {
    replies.push(reply);
    return reply;
  };
  /** The ctx a route hands the domain: no agent, the person asking. */
  const ctxOf = (userId: string) => makeAgentContext({ sessionId: 'channel-slack', agentId: '', userId, logger });

  return {
    bus,
    people,
    users,
    auth,
    teams,
    clock,
    vault,
    vaultCalls,
    vaultAs,
    vaultFailures,
    memory,
    slack,
    trail,
    lines,
    replies,
    lock,
    bots,
    ctxOf,
    /** A team admin asks: Ada, for the support agent, under BOT_NAME, unless told otherwise. */
    ask: async (a: { as: string; agentId?: string | undefined; botName?: string | undefined }): Promise<Reply> =>
      keep(
        await requests.ask({
          ctx: ctxOf(a.as),
          actorUserId: a.as,
          agentId: a.agentId ?? SUPPORT.id,
          botName: a.botName ?? BOT_NAME,
        }),
      ),
    cancel: async (agentId: string = SUPPORT.id): Promise<Reply> => keep(await requests.cancel({ agentId })),
    list: async (as: string): Promise<AdminBotRequestList> =>
      keep(await requests.list({ ctx: ctxOf(as), viewerUserId: as })),
    /** An AX admin approves REQUEST, with her stored token and the picture, unless told otherwise. */
    approve: async (a: {
      as: string;
      requestId?: string;
      refreshToken?: string | null;
      icon?: ParsedIcon | null;
    }): Promise<Reply> =>
      keep(
        await requests.approve({
          ctx: ctxOf(a.as),
          actorUserId: a.as,
          requestId: a.requestId ?? REQUEST,
          refreshToken: a.refreshToken ?? null,
          icon: a.icon === undefined ? ICON : a.icon,
        }),
      ),
    decline: async (requestId: string = REQUEST): Promise<Reply> => keep(await requests.decline({ requestId })),
  };
}

type World = ReturnType<typeof world>;

/** Start watching from here: the calls so far were the test's own seeding. */
function forget(w: World): void {
  w.trail.length = 0;
  w.memory.calls.length = 0;
  w.slack.calls.length = 0;
  w.vaultCalls.length = 0;
  w.vaultAs.length = 0;
  w.people.calls.length = 0;
  w.auth.asked.length = 0;
  w.teams.asked.length = 0;
  w.lines.length = 0;
}

/** The shared app, connected by Kay: live unless told otherwise. */
async function seedShared(w: World, o: { active?: boolean } = {}): Promise<void> {
  await w.memory.store.insertPending({
    installId: SHARED_INSTALL,
    appId: 'A07SHAREDAPP',
    clientId: '7512345678901.7500000000001',
    botName: SHARED_BOT_NAME,
    connectedByUserId: KAY,
  });
  if (o.active !== false) {
    await w.memory.store.activate(SHARED_INSTALL, {
      teamId: 'T07ABCDEF12',
      teamName: 'Canopy Works',
      botUserId: 'U07BOTUSER1',
      installedAt: new Date(NOW_MS),
    });
  }
  forget(w);
}

/** An open request: Ada's, for the support agent, under BOT_NAME, unless told otherwise. Returns its id. */
async function seedRequest(
  w: World,
  o: { requestId?: string; agentId?: string; by?: string; botName?: string } = {},
): Promise<string> {
  const requestId = o.requestId ?? REQUEST;
  await w.memory.store.insertBotRequest({
    requestId,
    agentId: o.agentId ?? SUPPORT.id,
    requestedByUserId: o.by ?? ADA,
    botName: o.botName ?? BOT_NAME,
  });
  forget(w);
  return requestId;
}

/** A bot already in the store: the sales agent's, Sam's, pending, unless told otherwise. */
async function addBot(
  w: World,
  o: { agentId?: string; approver?: string; requester?: string; botName?: string; live?: boolean; handle?: string } = {},
): Promise<string> {
  const installId = 'U2FsZXNCb3RJbnN0YWxsMQ';
  const approver = o.approver ?? SAM;
  await w.memory.store.insertPendingBot({
    installId,
    appId: 'A07OTHERBOT1',
    clientId: '7512345678901.7533333333333',
    botName: o.botName ?? 'Sales Desk',
    connectedByUserId: approver,
    agentId: o.agentId ?? SALES.id,
    requestedByUserId: o.requester ?? approver,
  });
  if (o.live === true || o.handle !== undefined) {
    await w.memory.store.activate(installId, {
      teamId: 'T07ABCDEF12',
      teamName: 'Canopy Works',
      botUserId: 'U07OTHERBOT',
      installedAt: new Date(NOW_MS),
    });
  }
  if (o.handle !== undefined) await w.memory.store.setBotHandle(installId, o.handle);
  forget(w);
  return installId;
}

function supportBot(w: World): Row | undefined {
  return [...w.memory.rows.values()].find((r) => r.kind === 'bot' && r.agentId === SUPPORT.id);
}

function bots(w: World): Row[] {
  return [...w.memory.rows.values()].filter((r) => r.kind === 'bot');
}

function methods(w: World): string[] {
  return w.slack.calls.map((c) => c.method);
}

function stateOf(reply: Reply): string {
  const state = new URL((reply.body as { installUrl: string }).installUrl).searchParams.get('state');
  if (state === null) throw new Error('no state in the install link');
  return state;
}

/** Every rotate throws `err`. */
function failRotate(w: World, err: unknown): void {
  w.slack.on.rotateConfigToken = async () => {
    throw err;
  };
}

/** Let every queued step that can run, run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
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

/**
 * Slack is making the app, under the lock, until `release()`: `reached`
 * settles once a create is waiting on it.
 */
function holdCreateApp(w: World): { reached: Promise<void>; release: () => void } {
  let release!: () => void;
  let arrived!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const make = w.slack.on.createApp;
  w.slack.on.createApp = async (token, manifest) => {
    arrived();
    await gate;
    return make(token, manifest);
  };
  return { reached, release };
}

const NOT_FOUND = { status: 404, body: { error: 'not-found' } };
const NOT_REQUESTED = { status: 409, body: { error: 'not-requested' } };
const INSTALL_LINK = { status: 200, body: { installUrl: expect.any(String), iconSet: true } };

// ── ask ─────────────────────────────────────────────────────────────────────

describe('ask', () => {
  it('opens a request: one row naming the agent, its requester and the name, logged by its own id alone; no token, no Slack', async () => {
    const w = world();
    await seedShared(w);

    expect(await w.ask({ as: ADA })).toEqual({ status: 200, body: {} });

    const [request, ...more] = [...w.memory.requests.values()];
    expect(more).toEqual([]);
    expect(request).toEqual({
      requestId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      agentId: SUPPORT.id,
      requestedByUserId: ADA,
      botName: BOT_NAME,
      createdAt: new Date(NOW_MS),
    });
    expect(w.trail).toEqual([
      // Nothing is asked that couldn't be approved: the shared bot is live.
      'store:current',
      // An agent has an open request or a bot, never both.
      'store:botForAgent',
      'store:botRequestForAgent',
      // The name against every bot's, the shared bot's and every open request's.
      'store:current',
      'store:listBots',
      'store:listBotRequests',
      'store:insertBotRequest',
    ]);
    // Her rights, asked as a non-admin: a team admin of the agent's team.
    expect(w.people.inputs('agents:can-set-shared-credential')).toEqual([
      { agentId: SUPPORT.id, actor: { userId: ADA, isAdmin: false } },
    ]);
    // No token is involved until an AX admin approves.
    expect(w.vaultCalls).toEqual([]);
    expect(w.slack.calls).toEqual([]);
    expect(w.lines).toEqual([{ level: 'info', msg: 'slack_bot_request_opened', fields: { requestId: request!.requestId } }]);
  });

  it('refusals: rights, then nothing that could not be approved, then one per agent, then the name; none opens a request or asks Slack', async () => {
    const taken = { status: 409, body: { error: 'bot-name-taken' } };
    const cases: Array<{
      what: string;
      o?: Parameters<typeof world>[0];
      shared?: 'none' | 'pending';
      arrange?: (w: World) => Promise<unknown>;
      as?: string;
      agentId?: string;
      botName?: string;
      want: Reply;
    }> = [
      { what: 'a personal agent', agentId: PERSONAL.id, want: { status: 409, body: { error: 'personal-agent' } } },
      { what: 'a member who is not a team admin', as: BOB, want: { status: 403, body: { error: 'forbidden' } } },
      { what: 'someone not on the team', as: SAM, want: NOT_FOUND },
      { what: 'an agent that does not exist', agentId: 'agt_nobody', want: NOT_FOUND },
      { what: 'no shared bot', shared: 'none', want: { status: 409, body: { error: 'no-workspace' } } },
      { what: 'a shared bot not yet allowed', shared: 'pending', want: { status: 409, body: { error: 'no-workspace' } } },
      {
        what: 'an http origin',
        o: { publicOrigin: HTTP_ORIGIN },
        want: { status: 409, body: { error: 'public-origin-not-https' } },
      },
      {
        what: 'a pending bot',
        arrange: (w) => addBot(w, { agentId: SUPPORT.id, approver: ADA, botName: 'Care Desk' }),
        want: { status: 409, body: { error: 'bot-exists' } },
      },
      {
        what: 'a live bot',
        arrange: (w) => addBot(w, { agentId: SUPPORT.id, approver: GRACE, requester: ADA, botName: 'Care Desk', live: true }),
        want: { status: 409, body: { error: 'bot-exists' } },
      },
      {
        what: 'a second ask',
        arrange: (w) => seedRequest(w, { botName: 'Care Desk' }),
        want: { status: 409, body: { error: 'bot-requested' } },
      },
      {
        // Told it already asked, not that its own name is taken.
        what: 'a second ask under the same name',
        arrange: (w) => seedRequest(w),
        want: { status: 409, body: { error: 'bot-requested' } },
      },
      { what: "the shared bot's name", botName: 'Canopy Works', want: taken },
      { what: "another agent's bot's name", arrange: (w) => addBot(w), botName: 'sales-desk', want: taken },
      { what: "another agent's bot's handle", arrange: (w) => addBot(w, { handle: 'deals' }), botName: 'Deals', want: taken },
      {
        what: "another agent's open request's name",
        arrange: (w) => seedRequest(w, { requestId: SALES_REQUEST, agentId: SALES.id, by: SAM, botName: 'support helper' }),
        want: taken,
      },
      {
        what: 'another ask for the agent getting in first (the unique index)',
        arrange: async (w) => {
          w.memory.failures.set('insertBotRequest', new InstallStoreError('request-exists'));
        },
        want: { status: 409, body: { error: 'bot-requested' } },
      },
    ];
    for (const c of cases) {
      const w = world(c.o);
      if (c.shared !== 'none') await seedShared(w, { active: c.shared !== 'pending' });
      await c.arrange?.(w);
      const before = [...w.memory.requests.values()];

      expect(await w.ask({ as: c.as ?? ADA, agentId: c.agentId, botName: c.botName }), c.what).toEqual(c.want);

      expect([...w.memory.requests.values()], c.what).toEqual(before);
      expect(w.slack.calls, c.what).toEqual([]);
      expect(w.vaultCalls, c.what).toEqual([]);
      expect(w.lines, c.what).toEqual([]);
    }
  });

  it('asks the rights again inside the lock: an agent deleted, or an admin demoted, while it waited opens nothing', async () => {
    const cases: Array<[string, (w: World) => void, Reply]> = [
      [
        'deleted',
        (w) => {
          w.people.agents.delete(SUPPORT.id);
        },
        NOT_FOUND,
      ],
      ['demoted', (w) => w.people.setRole(CARE_TEAM, ADA, 'member'), { status: 403, body: { error: 'forbidden' } }],
    ];
    for (const [what, change, want] of cases) {
      const lock = createMutex();
      const w = world({ lock });
      await seedShared(w);
      // Another Slack-app step holds the lock as the ask arrives.
      const hold = await holdLock(lock);
      const asked = w.ask({ as: ADA });
      await settle();
      // Nothing is read until the lock is free.
      expect(w.people.calls, what).toEqual([]);
      expect(w.trail, what).toEqual([]);

      change(w);
      hold.free();
      await hold.done;

      expect(await asked, what).toEqual(want);
      expect(w.memory.requests.size, what).toBe(0);
    }
  });

  it("a store fault throws (the route's 500), and opens nothing", async () => {
    const w = world();
    await seedShared(w);
    w.memory.failures.set('insertBotRequest', connectionReset());

    await expect(w.ask({ as: ADA })).rejects.toThrow();

    expect(w.memory.requests.size).toBe(0);
    expect(w.lines).toEqual([]);
  });
});

// ── cancel ──────────────────────────────────────────────────────────────────

describe('cancel', () => {
  it('removes the open request, and says so by its id alone', async () => {
    const w = world();
    await seedShared(w);
    await seedRequest(w);
    await seedRequest(w, { requestId: SALES_REQUEST, agentId: SALES.id, by: SAM, botName: 'Sales Desk' });

    expect(await w.cancel()).toEqual({ status: 200, body: {} });

    expect([...w.memory.requests.keys()]).toEqual([SALES_REQUEST]);
    expect(w.trail).toEqual(['store:removeBotRequestForAgent']);
    expect(w.slack.calls).toEqual([]);
    expect(w.vaultCalls).toEqual([]);
    expect(w.lines).toEqual([{ level: 'info', msg: 'slack_bot_request_cancelled', fields: { requestId: REQUEST } }]);
  });

  it('with no open request is 409 not-requested: a pending bot is no request, and stays', async () => {
    const w = world();
    await seedShared(w);
    expect(await w.cancel()).toEqual(NOT_REQUESTED);

    const installId = await addBot(w, { agentId: SUPPORT.id, approver: GRACE, requester: ADA, botName: BOT_NAME });
    expect(await w.cancel()).toEqual(NOT_REQUESTED);

    expect(w.memory.rows.get(installId)).toMatchObject({ status: 'pending' });
    expect(w.slack.calls).toEqual([]);
    expect(w.lines).toEqual([]);
  });

  it('waits for an approve in flight: the approve makes the bot, then the cancel finds no request (409 not-requested), and the agent shows the pending bot', async () => {
    const w = world();
    await seedShared(w);
    await seedRequest(w);
    w.vault.set(configTokenRef(GRACE), GRACE_STORED);
    const create = holdCreateApp(w);

    const approving = w.approve({ as: GRACE });
    await create.reached;
    const cancelling = w.cancel();
    await settle();
    // Slack is making the app under the lock: the cancel waits its turn.
    expect(w.memory.requests.has(REQUEST)).toBe(true);
    expect(w.trail).not.toContain('store:removeBotRequestForAgent');

    create.release();

    expect(await approving).toEqual(INSTALL_LINK);
    expect(await cancelling).toEqual(NOT_REQUESTED);
    expect(w.memory.requests.size).toBe(0);
    expect(supportBot(w)).toMatchObject({ status: 'pending', connectedByUserId: GRACE, requestedByUserId: ADA });
    // What the team sees in the agent's settings: the bot an AX admin is finishing.
    expect(
      await w.bots.status({ ctx: w.ctxOf(ADA), viewerUserId: ADA, agentId: SUPPORT.id, manages: true, sharedActive: true }),
    ).toEqual({
      state: 'pending',
      botName: BOT_NAME,
      approver: 'Grace Hopper',
      canContinue: false,
      // The team admin manages the agent, so its Disconnect key reaches them (TASK-1172).
      installId: supportBot(w)!.installId,
    });
  });
});

// ── list ────────────────────────────────────────────────────────────────────

describe('list', () => {
  it('names each agent, its team and its requester as the requester sees them, oldest first, with when each was asked', async () => {
    const w = world();
    await seedShared(w);
    w.vault.set(configTokenRef(GRACE), GRACE_STORED);
    await seedRequest(w);
    w.clock.ms = NOW_MS + 60_000;
    await seedRequest(w, { requestId: SALES_REQUEST, agentId: SALES.id, by: SAM, botName: 'Sales Desk' });

    expect(await w.list(GRACE)).toEqual({
      requests: [
        {
          requestId: REQUEST,
          botName: BOT_NAME,
          agentName: 'Support',
          teamName: 'Customer Care',
          requestedBy: 'Ada Lovelace',
          requestedAt: '2026-11-13T12:00:00.000Z',
        },
        {
          requestId: SALES_REQUEST,
          botName: 'Sales Desk',
          agentName: 'Sales',
          teamName: 'Sales Team',
          requestedBy: 'Sam Sales',
          requestedAt: '2026-11-13T12:01:00.000Z',
        },
      ],
      configTokenStored: true,
      truncated: false,
    });
    // Each agent as its requester sees it: Grace is on neither team, and her own view is never asked.
    expect(w.people.inputs('agents:resolve')).toEqual([
      { agentId: SUPPORT.id, userId: ADA },
      { agentId: SALES.id, userId: SAM },
    ]);
    // No rights are worked out per row: Approve checks the requester inside the lock.
    expect(w.people.inputs('agents:can-set-shared-credential')).toEqual([]);
    expect(w.teams.asked).toEqual([ADA, SAM]);
    expect(w.auth.asked).toEqual([ADA, SAM]);
    // The one vault read: whether Grace's own token is there. Nothing rotated, Slack asked nothing.
    expect(w.vaultAs).toEqual([{ hook: 'credentials:get', name: 'config-refresh-token', userId: GRACE }]);
    expect(w.vault.get(configTokenRef(GRACE))).toBe(GRACE_STORED);
    expect(w.slack.calls).toEqual([]);
    expect(w.lines).toEqual([]);
  });

  it('asks about each requester once however many requests they made, and cleans every name to one line', async () => {
    const w = world();
    await seedShared(w);
    w.people.addAgent({ ...SUPPORT, id: 'agt_care_two', displayName: `Care${RLO} Two${NEWLINE}` });
    w.teams.names.set(CARE_TEAM, `  Customer${NEWLINE}Care `);
    w.users.get(ADA)!.displayName = `Ada${RLO}Lovelace`;
    await seedRequest(w);
    w.clock.ms = NOW_MS + 1_000;
    await seedRequest(w, { requestId: SALES_REQUEST, agentId: 'agt_care_two', botName: 'Care Two' });

    const listed = await w.list(GRACE);

    expect(listed.requests.map((r) => [r.agentName, r.teamName, r.requestedBy])).toEqual([
      ['Support', 'Customer Care', 'Ada Lovelace'],
      ['Care Two', 'Customer Care', 'Ada Lovelace'],
    ]);
    expect(w.teams.asked).toEqual([ADA]);
    expect(w.auth.asked).toEqual([ADA]);
  });

  it("the requester shows by email when auth has no display name (AX admins read this), else as 'A team admin'", async () => {
    const w = world();
    await seedShared(w);
    await seedRequest(w);

    w.users.get(ADA)!.displayName = null;
    expect((await w.list(GRACE)).requests[0]!.requestedBy).toBe('ada@canopyworks.example');
    // Her account gone.
    w.users.delete(ADA);
    expect((await w.list(GRACE)).requests[0]!.requestedBy).toBe('A team admin');
    expect(w.lines).toEqual([]);
  });

  it('a requester who left the team, or an agent that is gone, gets the fallbacks, quietly; Approve then refuses', async () => {
    const w = world();
    await seedShared(w);
    w.vault.set(configTokenRef(GRACE), GRACE_STORED);
    await seedRequest(w);
    w.people.setRole(CARE_TEAM, ADA, null);

    expect((await w.list(GRACE)).requests).toEqual([
      {
        requestId: REQUEST,
        botName: BOT_NAME,
        agentName: 'A team agent',
        teamName: null,
        requestedBy: 'Ada Lovelace',
        requestedAt: '2026-11-13T12:00:00.000Z',
      },
    ]);
    // No agent to name, so no team is asked for.
    expect(w.teams.asked).toEqual([]);
    expect(w.lines).toEqual([]);
    expect(await w.approve({ as: GRACE })).toEqual({ status: 409, body: { error: 'requester-not-admin' } });

    const gone = world();
    await seedShared(gone);
    await seedRequest(gone);
    gone.people.agents.delete(SUPPORT.id);
    expect((await gone.list(GRACE)).requests[0]).toMatchObject({ agentName: 'A team agent', teamName: null });
    expect(gone.lines).toEqual([]);
    expect(await gone.approve({ as: GRACE })).toEqual({ status: 409, body: { error: 'agent-gone' } });
  });

  it('only an answer about this agent, as a team agent, names it', async () => {
    // An answer about another agent.
    const other = world();
    await seedShared(other);
    await seedRequest(other);
    other.people.agents.set(SUPPORT.id, { ...SUPPORT, id: 'agt_someone_else', displayName: 'Someone Else' });
    expect((await other.list(GRACE)).requests[0]).toMatchObject({ agentName: 'A team agent', teamName: null });

    // A personal agent (Ada's own), which no ask could have opened.
    const personal = world();
    await seedShared(personal);
    await seedRequest(personal, { agentId: PERSONAL.id });
    expect((await personal.list(GRACE)).requests[0]).toMatchObject({ agentName: 'A team agent', teamName: null });
    expect(personal.teams.asked).toEqual([]);
  });

  it('without @ax/teams, teamName is null and nothing else changes', async () => {
    const w = world({ teams: false });
    await seedShared(w);
    await seedRequest(w);

    expect((await w.list(GRACE)).requests).toEqual([
      {
        requestId: REQUEST,
        botName: BOT_NAME,
        agentName: 'Support',
        teamName: null,
        requestedBy: 'Ada Lovelace',
        requestedAt: '2026-11-13T12:00:00.000Z',
      },
    ]);
    expect(w.lines).toEqual([]);
  });

  it('a lookup that fails reads as its fallback, logged code-only by request and stage; the list still answers', async () => {
    const agents = world();
    await seedShared(agents);
    await seedRequest(agents);
    agents.people.faults.set('agents:resolve', connectionReset());
    expect((await agents.list(GRACE)).requests[0]).toMatchObject({
      agentName: 'A team agent',
      teamName: null,
      requestedBy: 'Ada Lovelace',
    });
    expect(agents.lines).toEqual([
      { level: 'warn', msg: 'slack_bot_request_failed', fields: { requestId: REQUEST, stage: 'agent', code: 'ECONNRESET' } },
    ]);

    const teams = world();
    await seedShared(teams);
    await seedRequest(teams);
    teams.teams.fault = connectionReset();
    expect((await teams.list(GRACE)).requests[0]).toMatchObject({
      agentName: 'Support',
      teamName: null,
      requestedBy: 'Ada Lovelace',
    });
    expect(teams.lines).toEqual([
      { level: 'warn', msg: 'slack_bot_request_failed', fields: { requestId: REQUEST, stage: 'team', code: 'ECONNRESET' } },
    ]);

    const auth = world();
    await seedShared(auth);
    await seedRequest(auth);
    auth.auth.fault = connectionReset();
    expect((await auth.list(GRACE)).requests[0]).toMatchObject({
      agentName: 'Support',
      teamName: 'Customer Care',
      requestedBy: 'A team admin',
    });
    expect(auth.lines).toEqual([
      {
        level: 'warn',
        msg: 'slack_bot_request_failed',
        fields: { requestId: REQUEST, stage: 'requested-by', code: 'ECONNRESET' },
      },
    ]);
  });

  it(`lists at most ${BOT_REQUESTS_MAX}, oldest first, and reads only those`, async () => {
    const w = world();
    await seedShared(w);
    const total = BOT_REQUESTS_MAX + 2;
    // Asked newest first, so the store's order isn't the order they were written in.
    for (let n = 0; n < total; n += 1) {
      const agentId = `agt_care_${n}`;
      w.people.addAgent({ ...SUPPORT, id: agentId, displayName: `Care ${n}` });
      w.clock.ms = NOW_MS + (total - n) * 1_000;
      await seedRequest(w, { requestId: `CareBotAsk${String(n).padStart(2, '0')}AAAAAAAAAA`, agentId, botName: `Care ${n}` });
    }

    const listed = await w.list(GRACE);

    const oldestFirst = Array.from({ length: total }, (_, i) => `Care ${total - 1 - i}`);
    expect(listed.requests.map((r) => r.agentName)).toEqual(oldestFirst.slice(0, BOT_REQUESTS_MAX));
    expect(w.people.inputs('agents:resolve')).toHaveLength(BOT_REQUESTS_MAX);
    // Said, so the page can tell the admin there are more waiting.
    expect(listed.truncated).toBe(true);
  });

  it(`says nothing is cut off at exactly ${BOT_REQUESTS_MAX} requests, and with none`, async () => {
    const w = world();
    await seedShared(w);
    expect(await w.list(GRACE)).toMatchObject({ requests: [], truncated: false });
    for (let n = 0; n < BOT_REQUESTS_MAX; n += 1) {
      const agentId = `agt_care_${n}`;
      w.people.addAgent({ ...SUPPORT, id: agentId, displayName: `Care ${n}` });
      w.clock.ms = NOW_MS + n * 1_000;
      await seedRequest(w, { requestId: `CareBotAsk${String(n).padStart(2, '0')}AAAAAAAAAA`, agentId, botName: `Care ${n}` });
    }

    const listed = await w.list(GRACE);

    expect(listed.requests).toHaveLength(BOT_REQUESTS_MAX);
    expect(listed.truncated).toBe(false);
  });

  it("configTokenStored is whether AX holds the VIEWING admin's own token, never the requester's; presence only; a fault reads false", async () => {
    const w = world();
    await seedShared(w);
    await seedRequest(w);
    // Ada, who asked, has a token of her own; Grace has one; Kay has none.
    w.vault.set(configTokenRef(ADA), ADA_STORED);
    w.vault.set(configTokenRef(GRACE), GRACE_STORED);

    expect((await w.list(GRACE)).configTokenStored).toBe(true);
    expect((await w.list(KAY)).configTokenStored).toBe(false);

    // Read as each viewer, once per list, and never rotated.
    expect(w.vaultAs).toEqual([
      { hook: 'credentials:get', name: 'config-refresh-token', userId: GRACE },
      { hook: 'credentials:get', name: 'config-refresh-token', userId: KAY },
    ]);
    expect(w.slack.calls).toEqual([]);
    expect(w.vault.get(configTokenRef(GRACE))).toBe(GRACE_STORED);

    // A vault fault reads false (the dialog then asks for a paste), logged code-only.
    forget(w);
    w.vaultFailures.set(`credentials:get ${configTokenRef(GRACE)}`, connectionReset());
    expect((await w.list(GRACE)).configTokenStored).toBe(false);
    expect(w.lines).toEqual([
      { level: 'warn', msg: 'slack_bot_request_failed', fields: { stage: 'status-config-token', code: 'ECONNRESET' } },
    ]);
  });

  it('with no open request: an empty list, configTokenStored false, and nothing else read', async () => {
    const w = world();
    await seedShared(w);
    w.vault.set(configTokenRef(GRACE), GRACE_STORED);

    expect(await w.list(GRACE)).toEqual({ requests: [], configTokenStored: false, truncated: false });

    expect(w.trail).toEqual(['store:listBotRequests']);
    expect(w.people.calls).toEqual([]);
  });

  it('takes no lock: it answers while another Slack-app step holds it, and asks Slack nothing', async () => {
    const lock = createMutex();
    const w = world({ lock });
    await seedShared(w);
    await seedRequest(w);
    w.vault.set(configTokenRef(GRACE), GRACE_STORED);
    const hold = await holdLock(lock);

    expect((await w.list(GRACE)).requests.map((r) => r.requestId)).toEqual([REQUEST]);

    expect(w.slack.calls).toEqual([]);
    hold.free();
    await hold.done;
  });
});

// ── approve ─────────────────────────────────────────────────────────────────

describe('approve', () => {
  it("with the AX admin's stored token, no paste: her token makes the bot, she is its approver, the team admin who asked its requester, and the request goes", async () => {
    const w = world();
    await seedShared(w);
    await seedRequest(w);
    w.vault.set(configTokenRef(GRACE), GRACE_STORED);

    const reply = await w.approve({ as: GRACE });

    expect(reply).toEqual(INSTALL_LINK);
    expect(w.trail).toEqual([
      // The request, read under the lock.
      'store:getBotRequest',
      // Then the one create path (bots.ts): its refusals…
      'store:current',
      'store:botForAgent',
      'store:botRequestForAgent',
      'store:current',
      'store:listBots',
      'store:listBotRequests',
      // …Grace's own token, its successor saved before the minted access token is used…
      'vault:get config-refresh-token',
      'slack:rotateConfigToken',
      'vault:set config-refresh-token',
      // …the app, its secrets, the pending row, its picture and the install link…
      'slack:createApp',
      'vault:set client-secret',
      'vault:set signing-secret',
      'store:insertPendingBot',
      'slack:setAppIcon',
      'store:setOAuthState',
      // …and last, the request.
      'store:removeBotRequest',
    ]);
    // The requester's standing, asked as her; Grace's own rights over the agent never are.
    expect(w.people.inputs('agents:resolve')).toEqual([{ agentId: SUPPORT.id, userId: ADA }]);
    expect(w.people.inputs('agents:can-set-shared-credential')).toEqual([
      { agentId: SUPPORT.id, actor: { userId: ADA, isAdmin: false } },
    ]);
    // Grace's token, read and written as hers.
    expect(w.slack.calls.filter((c) => c.method === 'rotateConfigToken').map((c) => c.args)).toEqual([[GRACE_STORED]]);
    expect(w.vaultAs.filter((v) => v.name === 'config-refresh-token')).toEqual([
      { hook: 'credentials:get', name: 'config-refresh-token', userId: GRACE },
      { hook: 'credentials:set', name: 'config-refresh-token', userId: GRACE },
    ]);
    expect(w.vault.get(configTokenRef(GRACE))).toBe(mintedRefresh(1));
    expect(w.vaultCalls.map((c) => c.ref)).not.toContain(configTokenRef(ADA));

    const bot = supportBot(w);
    expect(bot).toMatchObject({
      kind: 'bot',
      status: 'pending',
      agentId: SUPPORT.id,
      connectedByUserId: GRACE,
      requestedByUserId: ADA,
      botName: BOT_NAME,
    });
    // Only Grace's Allow can finish what her token made.
    expect(await w.memory.store.peekOAuthState(sha256(stateOf(reply)), 'bot')).toEqual({
      installId: bot!.installId,
      userId: GRACE,
      expiresAt: new Date(NOW_MS + OAUTH_STATE_TTL_MS),
    });
    expect(w.memory.requests.size).toBe(0);
    expect(w.lines).toEqual([
      { level: 'info', msg: 'slack_bot_approved', fields: { installId: bot!.installId, requestId: REQUEST } },
    ]);
  });

  it("a pasted token wins over a stored one: it is rotated once, and its successor kept as the AX admin's own; the paste is never stored", async () => {
    const w = world();
    await seedShared(w);
    await seedRequest(w);
    w.vault.set(configTokenRef(GRACE), GRACE_STORED);

    expect(await w.approve({ as: GRACE, refreshToken: PASTED })).toEqual(INSTALL_LINK);

    expect(w.slack.calls.filter((c) => c.args.includes(PASTED)).map((c) => c.method)).toEqual(['rotateConfigToken']);
    expect(w.vaultCalls.filter((c) => c.ref === configTokenRef(GRACE)).map((c) => c.hook)).toEqual(['credentials:set']);
    expect(w.vault.get(configTokenRef(GRACE))).toBe(mintedRefresh(1));
    expect([...w.vault.values()]).not.toContain(PASTED);
    expect(supportBot(w)).toMatchObject({ connectedByUserId: GRACE, requestedByUserId: ADA });
    expect(w.memory.requests.size).toBe(0);
  });

  it('none stored and no paste: 409 config-token-needed; nothing made, and the request stays listed', async () => {
    const w = world();
    await seedShared(w);
    await seedRequest(w);

    expect(await w.approve({ as: GRACE })).toEqual({ status: 409, body: { error: 'config-token-needed' } });

    expect(w.slack.calls).toEqual([]);
    expect(bots(w)).toEqual([]);
    expect(await w.list(GRACE)).toMatchObject({ requests: [{ requestId: REQUEST }], configTokenStored: false });
  });

  it('a dead stored token makes nothing and keeps the request: 502 slack-config-token, no app, the token left as it was', async () => {
    const w = world();
    await seedShared(w);
    await seedRequest(w);
    w.vault.set(configTokenRef(GRACE), GRACE_STORED);
    const rotate = w.slack.on.rotateConfigToken;
    failRotate(w, new SlackApiError('tooling.tokens.rotate', 'invalid_refresh_token'));

    expect(await w.approve({ as: GRACE })).toEqual({ status: 502, body: { error: 'slack-config-token' } });

    expect(methods(w)).toEqual(['rotateConfigToken']);
    expect(bots(w)).toEqual([]);
    expect(w.vault.get(configTokenRef(GRACE))).toBe(GRACE_STORED);
    expect(w.trail).not.toContain('store:removeBotRequest');
    expect((await w.list(GRACE)).requests.map((r) => r.requestId)).toEqual([REQUEST]);

    // A fresh paste then approves it.
    w.slack.on.rotateConfigToken = rotate;
    expect(await w.approve({ as: GRACE, refreshToken: PASTED })).toEqual(INSTALL_LINK);
    expect(w.memory.requests.size).toBe(0);
  });

  it("a requester who is no longer a team admin of the agent's team: 409 requester-not-admin, before any token; the request stays", async () => {
    const cases: Array<[string, (w: World) => void]> = [
      ['demoted to a member', (w) => w.people.setRole(CARE_TEAM, ADA, 'member')],
      ['off the team', (w) => w.people.setRole(CARE_TEAM, ADA, null)],
      [
        'the agent is no longer a team agent',
        (w) => {
          w.people.agents.set(SUPPORT.id, { ...SUPPORT, visibility: 'personal', ownerType: 'user', ownerId: ADA });
        },
      ],
    ];
    for (const [what, change] of cases) {
      const w = world();
      await seedShared(w);
      await seedRequest(w);
      w.vault.set(configTokenRef(GRACE), GRACE_STORED);
      change(w);

      expect(await w.approve({ as: GRACE }), what).toEqual({ status: 409, body: { error: 'requester-not-admin' } });

      expect(w.slack.calls, what).toEqual([]);
      expect(w.vaultCalls, what).toEqual([]);
      expect(bots(w), what).toEqual([]);
      expect(w.memory.requests.has(REQUEST), what).toBe(true);
    }
  });

  it('an agent that is gone: 409 agent-gone, before any token; the request stays for a Decline', async () => {
    const w = world();
    await seedShared(w);
    await seedRequest(w);
    w.vault.set(configTokenRef(GRACE), GRACE_STORED);
    w.people.agents.delete(SUPPORT.id);

    expect(await w.approve({ as: GRACE })).toEqual({ status: 409, body: { error: 'agent-gone' } });

    expect(w.slack.calls).toEqual([]);
    expect(w.vaultCalls).toEqual([]);
    expect(w.memory.requests.has(REQUEST)).toBe(true);
  });

  it('an unknown request: 404 not-found, and nothing else is read', async () => {
    const w = world();
    await seedShared(w);
    await seedRequest(w);

    expect(await w.approve({ as: GRACE, requestId: SALES_REQUEST })).toEqual(NOT_FOUND);

    expect(w.trail).toEqual(['store:getBotRequest']);
    expect(w.people.calls).toEqual([]);
    expect(w.slack.calls).toEqual([]);
  });

  it('asks about the requester inside the lock: one demoted while it waited makes nothing', async () => {
    const lock = createMutex();
    const w = world({ lock });
    await seedShared(w);
    await seedRequest(w);
    w.vault.set(configTokenRef(GRACE), GRACE_STORED);
    const hold = await holdLock(lock);
    const approving = w.approve({ as: GRACE });
    await settle();
    expect(w.trail).toEqual([]);
    expect(w.people.calls).toEqual([]);

    w.people.setRole(CARE_TEAM, ADA, 'member');
    hold.free();
    await hold.done;

    expect(await approving).toEqual({ status: 409, body: { error: 'requester-not-admin' } });
    expect(w.slack.calls).toEqual([]);
  });

  it('asks whether the AX admin still is one inside the lock: one demoted (or deleted) while it waited makes nothing, and the request stays', async () => {
    for (const [what, demote] of [
      ['demoted', (w: World) => (w.users.get(GRACE)!.isAdmin = false)],
      ['deleted', (w: World) => w.users.delete(GRACE)],
    ] as const) {
      const lock = createMutex();
      const w = world({ lock });
      await seedShared(w);
      await seedRequest(w);
      w.vault.set(configTokenRef(GRACE), GRACE_STORED);
      const hold = await holdLock(lock);
      const approving = w.approve({ as: GRACE });
      await settle();
      expect(w.auth.asked, what).toEqual([]);

      demote(w);
      hold.free();
      await hold.done;

      expect(await approving, what).toEqual({ status: 403, body: { error: 'forbidden' } });
      // Asked first: the request isn't even read for an actor who is no longer an AX admin.
      expect(w.trail, what).toEqual([]);
      expect(w.slack.calls, what).toEqual([]);
      expect(w.vaultCalls, what).toEqual([]);
      expect(w.memory.requests.has(REQUEST), what).toBe(true);
    }
  });

  it("an auth fault asking whether she is an AX admin throws (the route's 500), before any token", async () => {
    const w = world();
    await seedShared(w);
    await seedRequest(w);
    w.vault.set(configTokenRef(GRACE), GRACE_STORED);
    w.auth.fault = connectionReset();

    await expect(w.approve({ as: GRACE })).rejects.toThrow();

    expect(w.slack.calls).toEqual([]);
    expect(w.vaultCalls).toEqual([]);
    expect(w.memory.requests.has(REQUEST)).toBe(true);
  });

  it("a fault asking @ax/agents throws (the route's 500), before any token; the request stays", async () => {
    const w = world();
    await seedShared(w);
    await seedRequest(w);
    w.vault.set(configTokenRef(GRACE), GRACE_STORED);
    w.people.faults.set('agents:can-set-shared-credential', connectionReset());

    await expect(w.approve({ as: GRACE })).rejects.toThrow();

    expect(w.slack.calls).toEqual([]);
    expect(w.vaultCalls).toEqual([]);
    expect(w.memory.requests.has(REQUEST)).toBe(true);
  });

  it('two at once make one app: two AX admins, or a double click; the second finds the request gone (404 not-found)', async () => {
    const w = world();
    await seedShared(w);
    await seedRequest(w);
    w.vault.set(configTokenRef(GRACE), GRACE_STORED);
    w.vault.set(configTokenRef(KAY), KAY_STORED);

    const both = await Promise.all([w.approve({ as: GRACE }), w.approve({ as: KAY })]);

    expect(both).toEqual([INSTALL_LINK, NOT_FOUND]);
    expect(methods(w).filter((m) => m === 'createApp')).toHaveLength(1);
    expect(w.slack.calls.filter((c) => c.method === 'rotateConfigToken').map((c) => c.args)).toEqual([[GRACE_STORED]]);
    // The second stopped before any token: Kay's was never read.
    expect(w.vaultCalls.filter((c) => c.ref === configTokenRef(KAY))).toEqual([]);
    expect(w.vault.get(configTokenRef(KAY))).toBe(KAY_STORED);
    expect(bots(w)).toHaveLength(1);
    expect(supportBot(w)).toMatchObject({ connectedByUserId: GRACE });

    // A double click.
    const d = world();
    await seedShared(d);
    await seedRequest(d);
    d.vault.set(configTokenRef(GRACE), GRACE_STORED);
    expect(await Promise.all([d.approve({ as: GRACE }), d.approve({ as: GRACE })])).toEqual([INSTALL_LINK, NOT_FOUND]);
    expect(methods(d).filter((m) => m === 'createApp')).toHaveLength(1);
    expect(methods(d).filter((m) => m === 'rotateConfigToken')).toHaveLength(1);
    expect(bots(d)).toHaveLength(1);
  });

  it('the agent deleted while Slack makes the app leaves no orphan: its deletion waits for the lock, then takes the new bot and its app', async () => {
    const w = world();
    await seedShared(w);
    await seedRequest(w);
    w.vault.set(configTokenRef(GRACE), GRACE_STORED);
    const create = holdCreateApp(w);

    const approving = w.approve({ as: GRACE });
    await create.reached;
    // The agent is deleted: agents:deleted reaches the bots domain, which waits for the lock.
    w.people.agents.delete(SUPPORT.id);
    const removing = w.bots.removeForAgent(SUPPORT.id);
    await settle();
    expect(w.trail).not.toContain('store:removeBotRequestForAgent');

    create.release();
    expect(await approving).toEqual(INSTALL_LINK);
    await removing;

    expect(bots(w)).toEqual([]);
    expect(w.memory.requests.size).toBe(0);
    expect(w.slack.calls.filter((c) => c.method === 'deleteApp').map((c) => c.args)).toEqual([[MINTED_ACCESS, APP.appId]]);
    expect(w.slack.live.size).toBe(0);
    expect(w.memory.leftovers.size).toBe(0);
    // Nothing names Grace any more, so her token went with the app.
    expect(w.vault.has(configTokenRef(GRACE))).toBe(false);
  });
});

// ── decline ─────────────────────────────────────────────────────────────────

describe('decline', () => {
  it('removes it, and says so by its id alone; no token, no Slack', async () => {
    const w = world();
    await seedShared(w);
    await seedRequest(w);
    await seedRequest(w, { requestId: SALES_REQUEST, agentId: SALES.id, by: SAM, botName: 'Sales Desk' });

    expect(await w.decline()).toEqual({ status: 200, body: {} });

    expect([...w.memory.requests.keys()]).toEqual([SALES_REQUEST]);
    expect(w.trail).toEqual(['store:removeBotRequest']);
    expect(w.people.calls).toEqual([]);
    expect(w.slack.calls).toEqual([]);
    expect(w.lines).toEqual([{ level: 'info', msg: 'slack_bot_request_declined', fields: { requestId: REQUEST } }]);
  });

  it('an unknown request is 404 not-found, and logs nothing', async () => {
    const w = world();
    await seedShared(w);
    await seedRequest(w);

    expect(await w.decline(SALES_REQUEST)).toEqual(NOT_FOUND);

    expect(w.memory.requests.has(REQUEST)).toBe(true);
    expect(w.lines).toEqual([]);
  });

  it('waits for an approve in flight, then finds the request gone: 404 not-found, and the bot stays', async () => {
    const w = world();
    await seedShared(w);
    await seedRequest(w);
    w.vault.set(configTokenRef(GRACE), GRACE_STORED);
    const create = holdCreateApp(w);

    const approving = w.approve({ as: GRACE });
    await create.reached;
    const declining = w.decline();
    await settle();
    expect(w.memory.requests.has(REQUEST)).toBe(true);

    create.release();

    expect(await approving).toEqual(INSTALL_LINK);
    expect(await declining).toEqual(NOT_FOUND);
    expect(supportBot(w)).toMatchObject({ status: 'pending', connectedByUserId: GRACE });
  });
});

// ── What leaves the domain ──────────────────────────────────────────────────

describe('answers and logs', () => {
  it("no answer carries a token or an id but the request's own; no log line carries a token, an id or a name", async () => {
    const worlds: World[] = [];
    const add = (w: World): World => {
      worlds.push(w);
      return w;
    };

    // Everything going well: two asks, the list, an approve, a decline, a cancel, and refusals.
    const w = add(world());
    await seedShared(w);
    w.vault.set(configTokenRef(GRACE), GRACE_STORED);
    await w.ask({ as: ADA });
    await w.ask({ as: SAM, agentId: SALES.id, botName: 'Sales Desk' });
    await w.ask({ as: BOB });
    await w.list(GRACE);
    const askFor = (agentId: string): string => [...w.memory.requests.values()].find((r) => r.agentId === agentId)!.requestId;
    const supportAsk = askFor(SUPPORT.id);
    const salesAsk = askFor(SALES.id);
    await w.approve({ as: GRACE, requestId: supportAsk });
    await w.approve({ as: GRACE, requestId: supportAsk });
    await w.decline(salesAsk);
    await w.decline(salesAsk);
    await w.ask({ as: SAM, agentId: SALES.id, botName: 'Sales Desk' });
    await w.cancel(SALES.id);
    await w.cancel(SALES.id);

    // Every lookup the list makes failing at once, and the viewer's token unreadable.
    const faults = add(world());
    await seedShared(faults);
    await seedRequest(faults);
    await seedRequest(faults, { requestId: SALES_REQUEST, agentId: SALES.id, by: SAM, botName: 'Sales Desk' });
    faults.people.faults.set('agents:resolve', connectionReset());
    faults.auth.fault = connectionReset();
    faults.vaultFailures.set(`credentials:get ${configTokenRef(GRACE)}`, connectionReset());
    await faults.list(GRACE);
    faults.people.faults.delete('agents:resolve');
    faults.teams.fault = connectionReset();
    await faults.list(GRACE);

    // A dead stored token, then a refused paste.
    const dead = add(world());
    await seedShared(dead);
    await seedRequest(dead);
    dead.vault.set(configTokenRef(GRACE), GRACE_STORED);
    failRotate(dead, new SlackApiError('tooling.tokens.rotate', 'invalid_refresh_token'));
    await dead.approve({ as: GRACE });
    await dead.approve({ as: GRACE, refreshToken: PASTED });

    // An approve that fails after Slack made the app, so the app is taken back.
    const undone = add(world());
    await seedShared(undone);
    await seedRequest(undone);
    undone.vault.set(configTokenRef(GRACE), GRACE_STORED);
    undone.memory.failures.set('removeBotRequest', connectionReset());
    await undone.approve({ as: GRACE });
    await undone.list(GRACE);

    // Every world said something, so the scan below reads real output.
    for (const x of worlds) {
      expect(x.replies.length).toBeGreaterThan(0);
      expect(x.lines.length).toBeGreaterThan(0);
    }
    const tokens = [CONFIG_ACCESS_PREFIX, CONFIG_REFRESH_PREFIX, BOT_PREFIX, CLIENT_SECRET, SIGNING_SECRET];
    const ids = [ADA, BOB, SAM, GRACE, KAY, 'usr_', SUPPORT.id, SALES.id, 'agt_', CARE_TEAM, SALES_TEAM, 'team_'];
    const names = [
      ...USERS.flatMap((u) => [u.displayName!, u.email]),
      SUPPORT.displayName,
      SALES.displayName,
      ...TEAM_NAMES.map(([, name]) => name),
      BOT_NAME,
      'Sales Desk',
    ];
    for (const x of worlds) {
      // Answers: names for AX admins to read, never a token or an id.
      const replies = JSON.stringify(x.replies);
      for (const text of [...tokens, ...ids]) expect(replies, text).not.toContain(text);
      // Log lines are code-only: no name either, nor a failure's own text.
      const logged = JSON.stringify(x.lines);
      for (const text of [...tokens, ...ids, ...names, FAILURE_CANARY]) expect(logged, text).not.toContain(text);
    }
  });
});
