import { createHash, randomBytes } from 'node:crypto';
import { HookBus, PluginError, makeAgentContext, type Logger } from '@ax/core';
import { describe, expect, it } from 'vitest';
import { createBots, type BotFinish } from '../bots.js';
import { parseIconPng, type ParsedIcon } from '../icon.js';
import { OAUTH_STATE_TTL_MS } from '../limits.js';
import { logCode } from '../log-code.js';
import { botUrls, buildBotManifest } from '../manifest.js';
import { createMutex, type Mutex } from '../mutex.js';
import { SECRET_NAMES, configTokenRef, createSecretStore, secretRef } from '../secrets.js';
import { SlackApiError } from '../slack-api.js';
import { namesInUse } from '../slack-apps.js';
import { fakeAgents, type FakeAgent } from './fake-agents.js';
import { pngBase64 } from './fake-png.js';
import {
  APP,
  BOT_TOKEN,
  CLIENT_SECRET,
  MINTED_ACCESS,
  NOW_MS,
  SIGNING_SECRET,
  fakeSlack,
  mintedRefresh,
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
  A team agent's own Slack bot (TASK-1167): a team admin asks for it, picks it
  back up in Slack, cancels it, and the agent's settings show it. The domain
  (bots.ts) on the in-memory install store (memory-install-store.ts), the real
  secret store over a fake vault on the bus (fake-vault.ts), @ax/agents' answers
  (fake-agents.ts), and a fake Slack that retires a rotated refresh token at once
  (fake-slack-config.ts). The routes in front of it are agent-routes.test.ts.

  The rules pinned here are about one credential: the approver's own
  configuration token (TASK-1175: one per person, shared by every Slack app they
  made through AX). A pasted refresh token wins over a stored one and is never
  stored itself; whichever is used is rotated under the one app lock, and its
  successor is saved as the approver's token BEFORE the access token minted with
  it is used. Every refusal that needs no Slack call comes first, rights included,
  re-checked inside the lock. A request that fails after Slack made the app takes
  all of it back, and the approver's token goes only once nothing names them.

  And the one create path both ways share (TASK-1169): a team admin's own
  request, and an AX admin approving a team admin's open request in Admin ›
  Slack, where the AX admin is the approver and the team admin stays the
  requester. The approved request goes only once everything else worked, and
  the bot goes live for such an approver while they are still an AX admin and
  its requester still a team admin of the agent's team.
*/

// ── Fixtures ────────────────────────────────────────────────────────────────

const ORIGIN = 'https://ax.example';
const HTTP_ORIGIN = 'http://ax.internal:8080';
/** Where Slack sends the approver back after Allow: the bot's own callback, never Admin › Slack's. */
const BOT_CALLBACK = 'https://ax.example/slack/bots/oauth/callback';
/** The six scopes a team agent's own bot asks for, as its install link carries them. */
const SIX_SCOPES = 'app_mentions:read,chat:write,reactions:write,users:read,users:read.email,channels:read';

/** The shared app (Admin › Slack), connected by Ada with her own configuration token. */
const SHARED_INSTALL = 'q3VtZ0xH4kTn9Wb2LmPa1A';
const SHARED_APP = 'A07SHAREDAPP';
const SHARED_BOT_TOKEN = fakeBotToken('SHAREDBOTSECRET');
const SHARED_SIGNING_SECRET = 'SHAREDSIGNINGSECRET0a1b2c3d';
const SHARED_CLIENT_SECRET = 'SHAREDCLIENTSECRET9f8e7d6c5';

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

/** Connected the shared app; a team admin of the support team. */
const ADA = 'usr_ada';
/** A team admin of the support team. */
const GRACE = 'usr_grace';
/** A plain member of the support team. */
const MEL = 'usr_mel';
/** A team admin of the sales team. */
const SAM = 'usr_sam';
/** A team admin of the support team whose id can't name a vault ref (secrets.ts PERSON_ID_RE). */
const IVY = 'usr@ivy';
/** An AX admin on no team at all: she approves a team admin's request in Admin › Slack (TASK-1169). */
const HEDY = 'usr_hedy';
const USERS = [
  // Ada connected the shared app in Admin › Slack, so she is an AX admin too.
  { id: ADA, displayName: 'Ada Admin' as string | null, email: 'ada@canopyworks.example', isAdmin: true },
  { id: GRACE, displayName: 'Grace Hopper' as string | null, email: 'grace@canopyworks.example', isAdmin: false },
  { id: MEL, displayName: 'Mel Member' as string | null, email: 'mel@canopyworks.example', isAdmin: false },
  { id: SAM, displayName: 'Sam Sales' as string | null, email: 'sam@canopyworks.example', isAdmin: false },
  { id: HEDY, displayName: 'Hedy Lamarr' as string | null, email: 'hedy@canopyworks.example', isAdmin: true },
];

/** Each person's own configuration token (TASK-1175), as their last use of it left it. */
const ADA_STORED = fakeConfigRefreshToken('ADASTOREDSECRET');
const GRACE_STORED = fakeConfigRefreshToken('GRACESTOREDSECRET');
const HEDY_STORED = fakeConfigRefreshToken('HEDYSTOREDSECRET');

/** Grace's open request for the support agent's bot, waiting for an AX admin (TASK-1169): our own 22-character id. */
const REQUEST = 'U3VwcG9ydEJvdEFzazAwMQ';
/** An open request for the sales agent's bot. */
const SALES_REQUEST = 'U2FsZXNCb3RBc2swMDAwMg';
/** The code Slack sends back with an approver's Allow. */
const CODE = '7512345678901.7598765432109.0123456789abcdef';
/** A refresh token a team admin pastes into the form. */
const PASTED = fakeConfigRefreshToken('PASTEDBOTREFRESHSECRET');

const BOT_NAME = 'Support Helper';
/** The bot's picture the browser drew: a 512 px PNG's header, all icon.ts reads. */
const ICON = parseIconPng(pngBase64(512, 512));
/** Text a failure's message carries, which no log line may repeat. */
const FAILURE_CANARY = 'failure-text-canary-91c3';

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

function world(o: { publicOrigin?: string; lock?: Mutex; getUserFault?: unknown } = {}) {
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
  for (const agent of [SUPPORT, SALES]) people.addAgent(agent);
  for (const admin of [ADA, GRACE, IVY]) people.setRole(SUPPORT_TEAM, admin, 'admin');
  people.setRole(SUPPORT_TEAM, MEL, 'member');
  people.setRole(SALES_TEAM, SAM, 'admin');

  // Auth's own accounts, by id: a test may rename one, demote one, or delete one.
  // Auth answers null for an id it doesn't know. `asked` (also `authAsked`) is
  // whom each lookup named, in order; `fault` (from the start when
  // `getUserFault` is given) makes every lookup throw (an outage), and
  // `answer` makes every lookup return its value as it is.
  const users = new Map(USERS.map((u) => [u.id, { ...u }]));
  const auth: { asked: string[]; fault?: unknown; answer?: { value: unknown } } = { asked: [] };
  if (o.getUserFault !== undefined) auth.fault = o.getUserFault;
  const authAsked = auth.asked;
  bus.registerService('auth:get-user', '@ax/auth-better', async (_ctx, raw) => {
    const userId = (raw as { userId: string }).userId;
    auth.asked.push(userId);
    if (auth.fault !== undefined) throw auth.fault;
    if (auth.answer !== undefined) return auth.answer.value;
    const user = users.get(userId);
    return user === undefined ? null : { ...user };
  });

  const memory = memoryStore(() => NOW_MS, trail);
  const slack = fakeSlack(trail);
  const lock = o.lock ?? createMutex();
  const bots = createBots({
    bus,
    installs: memory.store,
    secrets: createSecretStore(bus, { logger }),
    api: slack.api,
    lock,
    publicOrigin: o.publicOrigin ?? ORIGIN,
    logger,
    now: () => NOW_MS,
    randomBytes: (n) => randomBytes(n),
  });

  /** Every answer the domain gave, for the leak scan. */
  const replies: unknown[] = [];
  const keep = <T>(reply: T): T => {
    replies.push(reply);
    return reply;
  };
  /** The ctx a settings route hands the domain: no agent, the person asking. */
  const ctxOf = (userId: string) => makeAgentContext({ sessionId: 'channel-slack', agentId: '', userId, logger });

  return {
    bus,
    people,
    users,
    auth,
    authAsked,
    vault,
    vaultCalls,
    vaultAs,
    vaultFailures,
    memory,
    slack,
    trail,
    lines,
    replies,
    /**
     * The one create path (TASK-1169), under the app lock as every caller
     * holds it: an AX admin approving a team admin's open request unless
     * `requestId` is null. The support agent, its name and picture unless
     * told otherwise; the approver's stored token unless one is pasted.
     */
    create: async (c: {
      approver: string;
      requester: string;
      requestId: string | null;
      agentId?: string;
      botName?: string;
      refreshToken?: string | null;
      icon?: ParsedIcon | null;
    }): Promise<Reply> =>
      keep(
        await lock.run(() =>
          bots.create({
            agentId: c.agentId ?? SUPPORT.id,
            approverUserId: c.approver,
            requesterUserId: c.requester,
            botName: c.botName ?? BOT_NAME,
            refreshToken: c.refreshToken ?? null,
            icon: c.icon === undefined ? ICON : c.icon,
            requestId: c.requestId,
          }),
        ),
      ),
    /**
     * The approver's Allow, as bot-callback.ts hands it over once the OAuth
     * state proved the visit is `as`'s: the row as it stands, under the app lock.
     */
    finish: async (as: string, installId: string): Promise<BotFinish> => {
      const row = memory.rows.get(installId);
      if (row === undefined) throw new Error(`no install ${installId}`);
      return lock.run(() => bots.finish({ actorUserId: as, ctx: ctxOf(as), install: { ...row }, code: CODE }));
    },
    /** The agent was deleted (agents-deleted.ts). */
    removeForAgent: (agentId: string = SUPPORT.id): Promise<void> => bots.removeForAgent(agentId),
    request: async (r: {
      as: string;
      agentId?: string;
      botName?: string;
      refreshToken?: string | null;
      icon?: ParsedIcon | null;
    }): Promise<Reply> =>
      keep(
        await bots.request({
          ctx: ctxOf(r.as),
          actorUserId: r.as,
          agentId: r.agentId ?? SUPPORT.id,
          botName: r.botName ?? BOT_NAME,
          refreshToken: r.refreshToken ?? null,
          icon: r.icon === undefined ? ICON : r.icon,
        }),
      ),
    installUrl: async (as: string, agentId: string = SUPPORT.id): Promise<Reply> =>
      keep(await bots.installUrl({ actorUserId: as, agentId })),
    cancel: async (agentId: string = SUPPORT.id): Promise<Reply> => keep(await bots.cancel({ agentId })),
    /**
     * A team admin's Disconnect, from the agent's settings (TASK-1172), naming
     * the bot the page showed by its install id.
     */
    disconnect: async (as: string, installId: string, agentId: string = SUPPORT.id): Promise<Reply> =>
      keep(await bots.disconnect({ ctx: ctxOf(as), actorUserId: as, agentId, installId })),
    /** An AX admin's Disconnect, from Admin › Slack, by the bot's install id (TASK-1172). */
    disconnectForAdmin: async (installId: string): Promise<Reply> => keep(await bots.disconnectForAdmin({ installId })),
    /** Admin › Slack's list of every team bot, read as an AX admin (TASK-1172). */
    listForAdmin: async (as: string = ADA) => keep(await bots.listForAdmin({ ctx: ctxOf(as) })),
    status: async (s: { as: string; manages: boolean; sharedActive: boolean; agentId?: string }) =>
      keep(
        await bots.status({
          ctx: ctxOf(s.as),
          viewerUserId: s.as,
          agentId: s.agentId ?? SUPPORT.id,
          manages: s.manages,
          sharedActive: s.sharedActive,
        }),
      ),
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
  // `authAsked` is the same array.
  w.auth.asked.length = 0;
  w.lines.length = 0;
}

/**
 * A team admin's open request for an agent's own bot, waiting for an AX admin
 * (TASK-1169): Grace's, for the support agent, under BOT_NAME, unless told
 * otherwise. Returns its id.
 */
async function seedRequest(
  w: World,
  o: { requestId?: string; agentId?: string; by?: string; botName?: string } = {},
): Promise<string> {
  const requestId = o.requestId ?? REQUEST;
  await w.memory.store.insertBotRequest({
    requestId,
    agentId: o.agentId ?? SUPPORT.id,
    requestedByUserId: o.by ?? GRACE,
    botName: o.botName ?? BOT_NAME,
  });
  forget(w);
  return requestId;
}

/**
 * Hedy (an AX admin on no team) approving Grace's open request for the
 * support agent with her stored token: the pending bot it makes, and the
 * state its install link carries.
 */
async function approvedBot(w: World): Promise<{ installId: string; state: string }> {
  await seedRequest(w);
  w.vault.set(configTokenRef(HEDY), HEDY_STORED);
  const reply = await w.create({ approver: HEDY, requester: GRACE, requestId: REQUEST });
  expect(reply.status).toBe(200);
  const bot = supportBot(w);
  if (bot === undefined) throw new Error('the approve made no bot');
  forget(w);
  return { installId: bot.installId, state: stateOf(reply) };
}

/** What seedShared stores: the shared app's three secrets, and Ada's own token. */
function sharedVault(): Array<[string, string]> {
  return [
    [secretRef(SHARED_INSTALL, 'bot-token'), SHARED_BOT_TOKEN],
    [secretRef(SHARED_INSTALL, 'signing-secret'), SHARED_SIGNING_SECRET],
    [secretRef(SHARED_INSTALL, 'client-secret'), SHARED_CLIENT_SECRET],
    [configTokenRef(ADA), ADA_STORED],
  ];
}

/** The shared app, connected by Ada: live unless told otherwise, with its secrets and her token. */
async function seedShared(w: World, o: { active?: boolean } = {}): Promise<void> {
  await w.memory.store.insertPending({
    installId: SHARED_INSTALL,
    appId: SHARED_APP,
    clientId: '7512345678901.7500000000001',
    botName: 'canopy-works',
    connectedByUserId: ADA,
  });
  if (o.active !== false) {
    await w.memory.store.activate(SHARED_INSTALL, {
      teamId: 'T07ABCDEF12',
      teamName: 'Canopy Works',
      botUserId: 'U07BOTUSER1',
      installedAt: new Date(NOW_MS),
    });
  }
  for (const [ref, value] of sharedVault()) w.vault.set(ref, value);
  forget(w);
}

/**
 * A bot already in the store, not made by the request under test: the sales
 * agent's, Sam's, unless told otherwise. Its requester is its approver unless
 * one is given (an AX admin approved it, TASK-1169). Live when `live` or a
 * `handle` is given.
 */
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

/** The Slack app addBot's row names. */
const ADDED_BOT_APP = 'A07OTHERBOT1';
/** The support agent's own bot's secrets, as its request and its Allow stored them. */
const SUPPORT_BOT_TOKEN = fakeBotToken('SUPPORTBOTSECRET');
/** Each approver's own configuration token, as seedSupportBot stores it. */
const STORED_TOKEN: Readonly<Record<string, string>> = { [ADA]: ADA_STORED, [GRACE]: GRACE_STORED };

/**
 * The support agent's own bot, as its request (and, when live, its Allow)
 * left it: its row through addBot, its own secrets (the bot token only once
 * live), and its approver's stored configuration token. Grace's and live
 * unless told otherwise. The vault writes are the test's own: not watched.
 */
async function seedSupportBot(
  w: World,
  o: { approver?: string; live?: boolean; handle?: string } = {},
): Promise<string> {
  const approver = o.approver ?? GRACE;
  const live = o.live ?? true;
  const installId = await addBot(w, {
    agentId: SUPPORT.id,
    approver,
    botName: BOT_NAME,
    live,
    ...(o.handle !== undefined ? { handle: o.handle } : {}),
  });
  w.vault.set(secretRef(installId, 'client-secret'), CLIENT_SECRET);
  w.vault.set(secretRef(installId, 'signing-secret'), SIGNING_SECRET);
  if (live) w.vault.set(secretRef(installId, 'bot-token'), SUPPORT_BOT_TOKEN);
  const stored = STORED_TOKEN[approver];
  if (stored === undefined) throw new Error(`no stored token for ${approver}`);
  w.vault.set(configTokenRef(approver), stored);
  forget(w);
  return installId;
}

/** Let every queued microtask run: whatever can proceed, does. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** The support agent's bot, if it has one. */
function supportBot(w: World): Row | undefined {
  return [...w.memory.rows.values()].find((r) => r.kind === 'bot' && r.agentId === SUPPORT.id);
}

function bots(w: World): Row[] {
  return [...w.memory.rows.values()].filter((r) => r.kind === 'bot');
}

/** The install id the request minted: the last segment of the events URL in the manifest it sent Slack. */
function createdInstallId(w: World): string {
  const create = w.slack.calls.find((c) => c.method === 'createApp');
  if (create === undefined) throw new Error('createApp was never called');
  const manifest = create.args[1] as { settings: { event_subscriptions: { request_url: string } } };
  return manifest.settings.event_subscriptions.request_url.split('/').pop()!;
}

function linkOf(reply: Reply): URL {
  return new URL((reply.body as { installUrl: string }).installUrl);
}

function stateOf(reply: Reply): string {
  const state = linkOf(reply).searchParams.get('state');
  if (state === null) throw new Error('no state in the install link');
  return state;
}

/** Every rotate throws `err`. */
function failRotate(w: World, err: unknown): void {
  w.slack.on.rotateConfigToken = async () => {
    throw err;
  };
}

function methods(w: World): string[] {
  return w.slack.calls.map((c) => c.method);
}

/** Nothing of the install `installId` is left in the vault. */
function expectNoSecretsOf(w: World, installId: string): void {
  for (const name of SECRET_NAMES) expect(w.vault.has(secretRef(installId, name)), name).toBe(false);
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

// ── request ─────────────────────────────────────────────────────────────────

describe('request', () => {
  it('an approver with a stored token pastes nothing: it is rotated under the lock, its successor saved first, then the bot app is created with the minted access token', async () => {
    const w = world();
    await seedShared(w);
    w.vault.set(configTokenRef(GRACE), GRACE_STORED);

    const reply = await w.request({ as: GRACE });

    expect(reply).toEqual({ status: 200, body: { installUrl: expect.any(String), iconSet: true } });
    expect(w.trail).toEqual([
      // Every refusal that needs no Slack call: the shared app, the agent's
      // bot, its open request (TASK-1169), the names in use (requests' too).
      'store:current',
      'store:botForAgent',
      'store:botRequestForAgent',
      'store:current',
      'store:listBots',
      'store:listBotRequests',
      // Grace's own token: read, rotated, and its successor saved BEFORE the minted access token is used.
      'vault:get config-refresh-token',
      'slack:rotateConfigToken',
      'vault:set config-refresh-token',
      'slack:createApp',
      'vault:set client-secret',
      'vault:set signing-secret',
      'store:insertPendingBot',
      'slack:setAppIcon',
      'store:setOAuthState',
    ]);
    // The stored token is the one rotated; the person read and written is Grace, as herself.
    expect(w.slack.calls.filter((c) => c.method === 'rotateConfigToken').map((c) => c.args)).toEqual([[GRACE_STORED]]);
    expect(w.vaultAs.filter((v) => v.name === 'config-refresh-token')).toEqual([
      { hook: 'credentials:get', name: 'config-refresh-token', userId: GRACE },
      { hook: 'credentials:set', name: 'config-refresh-token', userId: GRACE },
    ]);
    expect(w.vault.get(configTokenRef(GRACE))).toBe(mintedRefresh(1));

    const installId = createdInstallId(w);
    expect(installId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // The bot's own manifest, made with the access token that rotate minted, and its picture with the same one.
    const create = w.slack.calls.find((c) => c.method === 'createApp')!;
    expect(create.args[0]).toBe(MINTED_ACCESS);
    expect(create.args[1]).toStrictEqual(buildBotManifest(BOT_NAME, botUrls(ORIGIN, installId)));
    expect(create.args[1]).toMatchObject({
      oauth_config: { redirect_urls: [BOT_CALLBACK], scopes: { bot: SIX_SCOPES.split(',') } },
      settings: { event_subscriptions: { request_url: `${ORIGIN}/slack/events/${installId}` } },
    });
    expect(w.slack.calls.find((c) => c.method === 'setAppIcon')!.args.slice(0, 2)).toEqual([MINTED_ACCESS, APP.appId]);
    // Grace's token, then the bot's own two secrets: never a configuration token under the bot's install.
    expect(w.vaultCalls.filter((c) => c.hook === 'credentials:set').map((c) => c.ref)).toEqual([
      configTokenRef(GRACE),
      secretRef(installId, 'client-secret'),
      secretRef(installId, 'signing-secret'),
    ]);
    expect(w.vault.get(secretRef(installId, 'client-secret'))).toBe(CLIENT_SECRET);
    expect(w.vault.get(secretRef(installId, 'signing-secret'))).toBe(SIGNING_SECRET);

    // A pending bot for this agent, asked for and approved by Grace.
    expect(supportBot(w)).toMatchObject({
      installId,
      kind: 'bot',
      status: 'pending',
      agentId: SUPPORT.id,
      requestedByUserId: GRACE,
      connectedByUserId: GRACE,
      appId: APP.appId,
      clientId: APP.clientId,
      botName: BOT_NAME,
      teamId: null,
      botHandle: null,
    });

    // Slack's authorize page, for the six scopes, back to the bot's own callback, with a state bound to Grace.
    const link = linkOf(reply);
    expect(`${link.origin}${link.pathname}`).toBe('https://slack.com/oauth/v2/authorize');
    const state = stateOf(reply);
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.fromEntries(link.searchParams)).toEqual({
      client_id: APP.clientId,
      scope: SIX_SCOPES,
      redirect_uri: BOT_CALLBACK,
      state,
    });
    expect(await w.memory.store.peekOAuthState(sha256(state), 'bot')).toEqual({
      installId,
      userId: GRACE,
      expiresAt: new Date(NOW_MS + OAUTH_STATE_TTL_MS),
    });

    // The shared app's secrets and Ada's own token are as they were.
    for (const [ref, value] of sharedVault()) expect(w.vault.get(ref), ref).toBe(value);
    expect(w.lines).toEqual([{ level: 'info', msg: 'slack_bot_requested', fields: { installId } }]);
  });

  it("a pasted refresh token is rotated once and its successor stored as the approver's token before Slack makes the app; the pasted one is never stored", async () => {
    const w = world();
    await seedShared(w);

    expect(await w.request({ as: GRACE, refreshToken: PASTED })).toMatchObject({ status: 200 });

    expect(w.trail).toEqual([
      'store:current',
      'store:botForAgent',
      'store:botRequestForAgent',
      'store:current',
      'store:listBots',
      'store:listBotRequests',
      // Nothing stored is read: the paste is the token.
      'slack:rotateConfigToken',
      'vault:set config-refresh-token',
      'slack:createApp',
      'vault:set client-secret',
      'vault:set signing-secret',
      'store:insertPendingBot',
      'slack:setAppIcon',
      'store:setOAuthState',
    ]);
    // The pasted token goes to Slack once, to be rotated, and nowhere else.
    expect(w.slack.calls.filter((c) => c.args.includes(PASTED)).map((c) => c.method)).toEqual(['rotateConfigToken']);
    expect(w.slack.calls.find((c) => c.method === 'createApp')!.args[0]).toBe(MINTED_ACCESS);
    expect(w.vault.get(configTokenRef(GRACE))).toBe(mintedRefresh(1));
    expect([...w.vault.values()]).not.toContain(PASTED);
    expect(w.vaultAs.filter((v) => v.name === 'config-refresh-token')).toEqual([
      { hook: 'credentials:set', name: 'config-refresh-token', userId: GRACE },
    ]);
    expect(supportBot(w)).toMatchObject({ status: 'pending', connectedByUserId: GRACE, requestedByUserId: GRACE });
  });

  it("a paste wins over a stored token: the stored one is not read or rotated, and the slot ends with the paste's successor", async () => {
    const w = world();
    await seedShared(w);
    w.vault.set(configTokenRef(GRACE), GRACE_STORED);

    expect(await w.request({ as: GRACE, refreshToken: PASTED })).toMatchObject({ status: 200 });

    expect(w.vaultCalls.filter((c) => c.ref === configTokenRef(GRACE)).map((c) => c.hook)).toEqual(['credentials:set']);
    expect(w.slack.calls.filter((c) => c.method === 'rotateConfigToken').map((c) => c.args)).toEqual([[PASTED]]);
    expect(w.vault.get(configTokenRef(GRACE))).toBe(mintedRefresh(1));
  });

  it('no paste and no stored token: 409 config-token-needed, no Slack call', async () => {
    const w = world();
    await seedShared(w);

    expect(await w.request({ as: GRACE })).toEqual({ status: 409, body: { error: 'config-token-needed' } });

    expect(w.slack.calls).toEqual([]);
    expect(w.vaultCalls).toEqual([{ hook: 'credentials:get', ref: configTokenRef(GRACE) }]);
    expect(bots(w)).toEqual([]);
  });

  it('a stored token Slack refuses (invalid_refresh_token, token_revoked): 502 slack-config-token; no app; the stored token left as it was', async () => {
    for (const code of ['invalid_refresh_token', 'token_revoked']) {
      const w = world();
      await seedShared(w);
      w.vault.set(configTokenRef(GRACE), GRACE_STORED);
      failRotate(w, new SlackApiError('tooling.tokens.rotate', code));

      expect(await w.request({ as: GRACE }), code).toEqual({ status: 502, body: { error: 'slack-config-token' } });

      expect(methods(w), code).toEqual(['rotateConfigToken']);
      // Nothing written, nothing deleted: other apps of hers still name her, and her next paste fixes them all.
      expect(w.vaultCalls.filter((c) => c.hook !== 'credentials:get'), code).toEqual([]);
      expect(w.vault.get(configTokenRef(GRACE)), code).toBe(GRACE_STORED);
      expect(bots(w), code).toEqual([]);
      expect(w.lines, code).toEqual([
        { level: 'warn', msg: 'slack_bot_failed', fields: { installId: expect.any(String), stage: 'rotate', code } },
      ]);
    }

    // A rotate that simply failed is no verdict on the token: try again.
    const w = world();
    await seedShared(w);
    w.vault.set(configTokenRef(GRACE), GRACE_STORED);
    failRotate(w, new SlackApiError('tooling.tokens.rotate', 'timeout'));
    expect(await w.request({ as: GRACE })).toEqual({ status: 502, body: { error: 'slack-error' } });
    expect(methods(w)).toEqual(['rotateConfigToken']);
    expect(w.vault.get(configTokenRef(GRACE))).toBe(GRACE_STORED);
  });

  it('a refused pasted token: 502 slack-refresh-token, no app, nothing stored', async () => {
    for (const code of ['invalid_refresh_token', 'invalid_auth', 'token_revoked']) {
      const w = world();
      await seedShared(w);
      failRotate(w, new SlackApiError('tooling.tokens.rotate', code));

      expect(await w.request({ as: GRACE, refreshToken: PASTED }), code).toEqual({
        status: 502,
        body: { error: 'slack-refresh-token' },
      });

      expect(methods(w), code).toEqual(['rotateConfigToken']);
      expect(w.vaultCalls, code).toEqual([]);
      expect(bots(w), code).toEqual([]);
      expect(w.lines, code).toEqual([
        { level: 'warn', msg: 'slack_bot_failed', fields: { installId: expect.any(String), stage: 'try-refresh-token', code } },
      ]);
    }

    const w = world();
    await seedShared(w);
    failRotate(w, new SlackApiError('tooling.tokens.rotate', 'timeout'));
    expect(await w.request({ as: GRACE, refreshToken: PASTED })).toEqual({ status: 502, body: { error: 'slack-error' } });
    expect(methods(w)).toEqual(['rotateConfigToken']);
    expect(w.vaultCalls).toEqual([]);
  });

  it("a successor that won't save: 500 and no app made", async () => {
    // The stored path: the rotate retired the stored token, so nothing may use its access token unsaved.
    const w = world();
    await seedShared(w);
    w.vault.set(configTokenRef(GRACE), GRACE_STORED);
    w.vaultFailures.set(`credentials:set ${configTokenRef(GRACE)}`, connectionReset());

    expect(await w.request({ as: GRACE })).toEqual({ status: 500, body: { error: 'internal' } });

    expect(methods(w)).toEqual(['rotateConfigToken']);
    expect(bots(w)).toEqual([]);
    expect(w.lines).toEqual([
      {
        level: 'error',
        msg: 'slack_bot_failed',
        fields: { installId: expect.any(String), stage: 'save-config-token', code: 'ECONNRESET' },
      },
    ]);

    // The paste path the same: no app is made with a token nobody kept.
    const p = world();
    await seedShared(p);
    p.vaultFailures.set(`credentials:set ${configTokenRef(GRACE)}`, connectionReset());
    expect(await p.request({ as: GRACE, refreshToken: PASTED })).toEqual({ status: 500, body: { error: 'internal' } });
    expect(methods(p)).toEqual(['rotateConfigToken']);
    expect(bots(p)).toEqual([]);
  });

  it("create fails: 502 by createAppError; a first-time approver's token is released, while one whose other app still names them is kept", async () => {
    // Grace's first app: the successor of her paste goes again.
    const w = world();
    await seedShared(w);
    w.slack.on.createApp = async () => {
      throw new SlackApiError('apps.manifest.create', 'invalid_manifest');
    };
    expect(await w.request({ as: GRACE, refreshToken: PASTED })).toEqual({ status: 502, body: { error: 'slack-name' } });
    expect(w.trail.slice(-3)).toEqual(['slack:createApp', 'store:personHasApps', 'vault:delete config-refresh-token']);
    expect(w.vault.has(configTokenRef(GRACE))).toBe(false);
    expect(bots(w)).toEqual([]);
    expect(w.memory.leftovers.size).toBe(0);
    expect(w.lines).toEqual([
      { level: 'warn', msg: 'slack_bot_failed', fields: { installId: expect.any(String), stage: 'create-app', code: 'invalid_manifest' } },
    ]);

    // Ada's shared app still names her, so her token (the rotate's successor) stays.
    const a = world();
    await seedShared(a);
    a.slack.on.createApp = async () => {
      throw new SlackApiError('apps.manifest.create', 'invalid_auth');
    };
    expect(await a.request({ as: ADA })).toEqual({ status: 502, body: { error: 'slack-token' } });
    expect(a.trail.slice(-2)).toEqual(['slack:createApp', 'store:personHasApps']);
    expect(a.vault.get(configTokenRef(ADA))).toBe(mintedRefresh(1));

    // Slack may have made the app without saying so: the person is told to check before retrying.
    for (const [code, error] of [
      ['timeout', 'slack-unconfirmed'],
      ['http-503', 'slack-unconfirmed'],
      ['ratelimited', 'slack-error'],
    ] as const) {
      const x = world();
      await seedShared(x);
      x.slack.on.createApp = async () => {
        throw new SlackApiError('apps.manifest.create', code);
      };
      expect(await x.request({ as: GRACE, refreshToken: PASTED }), code).toEqual({ status: 502, body: { error } });
    }
  });

  it('a failure after the app exists deletes it, or lists it as left over naming the approver; row and per-install secrets gone; the token released unless something names them', async () => {
    // The vault fails on the signing secret, before the row: Slack deletes the app, and Grace's first token goes.
    const w = world();
    await seedShared(w);
    w.vaultFailures.set('credentials:set signing-secret', connectionReset());

    expect(await w.request({ as: GRACE, refreshToken: PASTED })).toEqual({ status: 500, body: { error: 'internal' } });

    const id = createdInstallId(w);
    // Deleted with the access token the request already held: no second rotate.
    expect(w.slack.calls.map((c) => [c.method, c.args[0]])).toEqual([
      ['rotateConfigToken', PASTED],
      ['createApp', MINTED_ACCESS],
      ['deleteApp', MINTED_ACCESS],
    ]);
    expect(w.slack.calls.at(-1)!.args).toEqual([MINTED_ACCESS, APP.appId]);
    expect(bots(w)).toEqual([]);
    expect(w.memory.leftovers.size).toBe(0);
    expectNoSecretsOf(w, id);
    expect(w.vault.has(configTokenRef(GRACE))).toBe(false);
    expect(w.lines).toEqual([
      { level: 'error', msg: 'slack_bot_failed', fields: { installId: id, stage: 'request', code: 'ECONNRESET' } },
    ]);

    // Slack won't delete it: it goes onto the leftover list naming Grace, and her token stays for it.
    const left = world();
    await seedShared(left);
    left.vaultFailures.set('credentials:set signing-secret', connectionReset());
    left.slack.on.deleteApp = async () => {
      throw new SlackApiError('apps.manifest.delete', 'internal_error');
    };
    expect(await left.request({ as: GRACE, refreshToken: PASTED })).toEqual({ status: 500, body: { error: 'internal' } });
    const leftId = createdInstallId(left);
    expect([...left.memory.leftovers.values()]).toEqual([
      { installId: leftId, appId: APP.appId, botName: BOT_NAME, leftAt: new Date(NOW_MS), connectedByUserId: GRACE },
    ]);
    expect(bots(left)).toEqual([]);
    expectNoSecretsOf(left, leftId);
    expect(left.vault.get(configTokenRef(GRACE))).toBe(mintedRefresh(1));

    // After the row exists (the state's write fails): the row goes too. Ada's shared app still names her: her token stays.
    const late = world();
    await seedShared(late);
    late.memory.failures.set('setOAuthState', connectionReset());
    expect(await late.request({ as: ADA })).toEqual({ status: 500, body: { error: 'internal' } });
    const lateId = createdInstallId(late);
    expect(methods(late)).toEqual(['rotateConfigToken', 'createApp', 'setAppIcon', 'deleteApp']);
    expect(late.trail).toContain('store:insertPendingBot');
    expect(late.memory.rows.has(lateId)).toBe(false);
    expect(late.memory.leftovers.size).toBe(0);
    expectNoSecretsOf(late, lateId);
    expect(late.vault.get(configTokenRef(ADA))).toBe(mintedRefresh(1));
  });

  it('no active shared install, or an http origin: 409 before Slack', async () => {
    const none = world();
    expect(await none.request({ as: GRACE, refreshToken: PASTED })).toEqual({ status: 409, body: { error: 'no-workspace' } });

    const pending = world();
    await seedShared(pending, { active: false });
    expect(await pending.request({ as: GRACE, refreshToken: PASTED })).toEqual({
      status: 409,
      body: { error: 'no-workspace' },
    });

    // Slack refuses plain-http URLs in a manifest.
    const http = world({ publicOrigin: HTTP_ORIGIN });
    await seedShared(http);
    expect(await http.request({ as: GRACE, refreshToken: PASTED })).toEqual({
      status: 409,
      body: { error: 'public-origin-not-https' },
    });

    for (const w of [none, pending, http]) {
      expect(w.slack.calls).toEqual([]);
      expect(w.vaultCalls).toEqual([]);
      expect(bots(w)).toEqual([]);
    }
  });

  it('the agent already has a bot, pending or live: 409 bot-exists before Slack', async () => {
    for (const live of [false, true]) {
      const w = world();
      await seedShared(w);
      await addBot(w, { agentId: SUPPORT.id, approver: ADA, botName: 'Old Helper', live });

      expect(await w.request({ as: GRACE, refreshToken: PASTED }), `live ${live}`).toEqual({
        status: 409,
        body: { error: 'bot-exists' },
      });

      expect(w.slack.calls).toEqual([]);
      expect(w.vaultCalls).toEqual([]);
      expect(bots(w)).toHaveLength(1);
    }
  });

  it("a name the shared bot, a bot or a bot's handle has (by key): 409 bot-name-taken before Slack", async () => {
    for (const [what, botName] of [
      ["the shared bot's name", 'Canopy Works'],
      ["another bot's name", 'SALES_DESK'],
      ["another bot's handle", 'Sales Desk 2'],
    ] as const) {
      const w = world();
      await seedShared(w);
      // The sales agent's bot: named "Sales Desk", and Slack called its bot user @salesdesk2.
      await addBot(w, { botName: 'Sales Desk', handle: 'salesdesk2' });

      expect(await w.request({ as: GRACE, refreshToken: PASTED, botName }), what).toEqual({
        status: 409,
        body: { error: 'bot-name-taken' },
      });

      expect(w.slack.calls, what).toEqual([]);
      expect(w.vaultCalls, what).toEqual([]);
      expect(supportBot(w), what).toBeUndefined();
    }
  });

  it('two requests at once make one app; the other gets 409 bot-exists', async () => {
    // Two team admins at once.
    const w = world();
    await seedShared(w);
    w.vault.set(configTokenRef(GRACE), GRACE_STORED);
    const both = await Promise.all([w.request({ as: GRACE }), w.request({ as: ADA })]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(both.find((r) => r.status === 409)).toEqual({ status: 409, body: { error: 'bot-exists' } });
    expect(w.slack.calls.filter((c) => c.method === 'createApp')).toHaveLength(1);
    expect(w.slack.calls.filter((c) => c.method === 'rotateConfigToken').map((c) => c.args)).toEqual([[GRACE_STORED]]);
    // The second stopped before any token: Ada's was never read.
    expect(w.vaultCalls.filter((c) => c.ref === configTokenRef(ADA))).toEqual([]);
    expect(w.vault.get(configTokenRef(ADA))).toBe(ADA_STORED);
    expect(bots(w)).toHaveLength(1);

    // A double click.
    const d = world();
    await seedShared(d);
    const clicks = await Promise.all([
      d.request({ as: GRACE, refreshToken: PASTED }),
      d.request({ as: GRACE, refreshToken: PASTED }),
    ]);
    expect(clicks.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(d.slack.calls.filter((c) => c.method === 'createApp')).toHaveLength(1);
    // The paste was rotated once: the second never reached it (the strict fake would refuse a second rotate).
    expect(d.slack.calls.filter((c) => c.method === 'rotateConfigToken')).toHaveLength(1);
    expect(bots(d)).toHaveLength(1);
  });

  it("an agent deleted after the route's rights check is refused inside the lock, with no Slack call", async () => {
    const lock = createMutex();
    const w = world({ lock });
    await seedShared(w);
    w.vault.set(configTokenRef(GRACE), GRACE_STORED);
    // Another Slack-app step holds the one app lock as the request arrives.
    const hold = await holdLock(lock);
    const asked = w.request({ as: GRACE });
    // The route's own check passed; the agent is deleted before the lock frees.
    w.people.agents.delete(SUPPORT.id);
    hold.free();
    await hold.done;

    expect(await asked).toEqual({ status: 404, body: { error: 'not-found' } });
    expect(w.slack.calls).toEqual([]);
    expect(w.vaultCalls).toEqual([]);
    expect(w.trail).toEqual([]);
    expect(bots(w)).toEqual([]);
  });

  it('a team admin who is only a member by the time the lock frees is refused inside it (403), with no Slack call', async () => {
    const lock = createMutex();
    const w = world({ lock });
    await seedShared(w);
    const hold = await holdLock(lock);
    const asked = w.request({ as: GRACE, refreshToken: PASTED });
    w.people.setRole(SUPPORT_TEAM, GRACE, 'member');
    hold.free();
    await hold.done;

    expect(await asked).toEqual({ status: 403, body: { error: 'forbidden' } });
    expect(w.slack.calls).toEqual([]);
    expect(w.vaultCalls).toEqual([]);
    // Asked as a non-admin, as every manage question is.
    expect(w.people.inputs('agents:can-set-shared-credential')).toEqual([
      { agentId: SUPPORT.id, actor: { userId: GRACE, isAdmin: false } },
    ]);
  });

  it("a requester whose id can't name a vault ref: 500 before Slack", async () => {
    const w = world();
    await seedShared(w);

    expect(await w.request({ as: IVY, refreshToken: PASTED })).toEqual({ status: 500, body: { error: 'internal' } });

    expect(w.slack.calls).toEqual([]);
    expect(w.vaultCalls).toEqual([]);
    expect(bots(w)).toEqual([]);
    // The error's fixed code, never the id.
    expect(w.lines).toEqual([
      { level: 'error', msg: 'slack_bot_failed', fields: { stage: 'request', code: 'invalid-person-id' } },
    ]);
  });

  it('refuses while the agent has an open request waiting for an AX admin: 409 bot-requested, no token, no Slack call', async () => {
    const w = world();
    await seedShared(w);
    w.vault.set(configTokenRef(GRACE), GRACE_STORED);
    // Ada asked an AX admin for it, under another name.
    await seedRequest(w, { by: ADA, botName: 'Support Desk' });

    expect(await w.request({ as: GRACE })).toEqual({ status: 409, body: { error: 'bot-requested' } });

    expect(w.slack.calls).toEqual([]);
    expect(w.vaultCalls).toEqual([]);
    expect(bots(w)).toEqual([]);
    // The request is left as it was, for the AX admin to approve or decline.
    expect([...w.memory.requests.keys()]).toEqual([REQUEST]);
  });

  it("refuses a name an open request holds (by key), for any agent: 409 bot-name-taken, no token, no Slack call", async () => {
    const w = world();
    await seedShared(w);
    w.vault.set(configTokenRef(GRACE), GRACE_STORED);
    // Sam's request for the sales agent's bot holds "Support Helper" until it is approved or taken back.
    await seedRequest(w, { requestId: SALES_REQUEST, agentId: SALES.id, by: SAM, botName: BOT_NAME });

    for (const botName of [BOT_NAME, 'support-helper', 'SUPPORT_HELPER']) {
      expect(await w.request({ as: GRACE, botName }), botName).toEqual({ status: 409, body: { error: 'bot-name-taken' } });
    }

    expect(w.slack.calls).toEqual([]);
    expect(w.vaultCalls).toEqual([]);
    expect(supportBot(w)).toBeUndefined();
  });
});

// ── create: the one create path, and an AX admin's approve (TASK-1169) ───────

describe('create', () => {
  it("makes the bot with the approving AX admin's token, the admin as approver and the requester as requester, and takes the request last", async () => {
    const w = world();
    await seedShared(w);
    await seedRequest(w);
    w.vault.set(configTokenRef(HEDY), HEDY_STORED);

    const reply = await w.create({ approver: HEDY, requester: GRACE, requestId: REQUEST });

    expect(reply).toEqual({ status: 200, body: { installUrl: expect.any(String), iconSet: true } });
    expect(w.trail).toEqual([
      // The same refusals the self path makes: the request being approved is
      // the agent's own open one, and its own name doesn't count against it.
      'store:current',
      'store:botForAgent',
      'store:botRequestForAgent',
      'store:current',
      'store:listBots',
      'store:listBotRequests',
      // Hedy's own token: read, rotated, its successor saved BEFORE the minted access token is used.
      'vault:get config-refresh-token',
      'slack:rotateConfigToken',
      'vault:set config-refresh-token',
      'slack:createApp',
      'vault:set client-secret',
      'vault:set signing-secret',
      'store:insertPendingBot',
      'slack:setAppIcon',
      'store:setOAuthState',
      // Last, once everything else worked: the request goes.
      'store:removeBotRequest',
    ]);
    expect(w.memory.calls.find((c) => c.method === 'removeBotRequest')!.args).toEqual([REQUEST]);
    // Her token, as herself: never the requester's.
    expect(w.slack.calls.filter((c) => c.method === 'rotateConfigToken').map((c) => c.args)).toEqual([[HEDY_STORED]]);
    expect(w.vaultAs.filter((v) => v.name === 'config-refresh-token')).toEqual([
      { hook: 'credentials:get', name: 'config-refresh-token', userId: HEDY },
      { hook: 'credentials:set', name: 'config-refresh-token', userId: HEDY },
    ]);
    expect(w.vault.get(configTokenRef(HEDY))).toBe(mintedRefresh(1));
    expect(w.slack.calls.find((c) => c.method === 'createApp')!.args[0]).toBe(MINTED_ACCESS);

    const installId = createdInstallId(w);
    // Approved by Hedy (her token made it, so she manages it); asked for by Grace (its outsiders run as her).
    expect(supportBot(w)).toMatchObject({
      installId,
      kind: 'bot',
      status: 'pending',
      agentId: SUPPORT.id,
      connectedByUserId: HEDY,
      requestedByUserId: GRACE,
      botName: BOT_NAME,
    });
    // Only Hedy's Allow can finish what her token made.
    expect(await w.memory.store.peekOAuthState(sha256(stateOf(reply)), 'bot')).toEqual({
      installId,
      userId: HEDY,
      expiresAt: new Date(NOW_MS + OAUTH_STATE_TTL_MS),
    });
    expect(w.memory.requests.size).toBe(0);
    // Nothing of Grace's was read or written: no token of hers is involved.
    expect(w.vaultCalls.map((c) => c.ref)).not.toContain(configTokenRef(GRACE));
    expect(w.lines).toEqual([
      { level: 'info', msg: 'slack_bot_approved', fields: { installId, requestId: REQUEST } },
    ]);
  });

  it("a pasted token wins over the stored one, and its successor is kept as the approver's", async () => {
    const w = world();
    await seedShared(w);
    await seedRequest(w);
    w.vault.set(configTokenRef(HEDY), HEDY_STORED);

    expect(await w.create({ approver: HEDY, requester: GRACE, requestId: REQUEST, refreshToken: PASTED })).toMatchObject({
      status: 200,
    });

    expect(w.slack.calls.filter((c) => c.method === 'rotateConfigToken').map((c) => c.args)).toEqual([[PASTED]]);
    expect(w.vault.get(configTokenRef(HEDY))).toBe(mintedRefresh(1));
    expect([...w.vault.values()]).not.toContain(PASTED);
    expect(supportBot(w)).toMatchObject({ connectedByUserId: HEDY, requestedByUserId: GRACE });
  });

  it("leaves the request open when its last step fails: the app is taken back, no bot row is left, and the approver's token goes only once nothing names her", async () => {
    // Hedy approved the sales agent's bot before, so her token stays for it.
    const w = world();
    await seedShared(w);
    await addBot(w, { approver: HEDY, requester: SAM });
    await seedRequest(w);
    w.vault.set(configTokenRef(HEDY), HEDY_STORED);
    w.memory.failures.set('removeBotRequest', connectionReset());

    expect(await w.create({ approver: HEDY, requester: GRACE, requestId: REQUEST })).toEqual({
      status: 500,
      body: { error: 'internal' },
    });

    const id = createdInstallId(w);
    // Everything else had worked: the row, the picture and the install link.
    expect(w.trail).toContain('store:setOAuthState');
    // Deleted with the access token the create already held.
    expect(w.slack.calls.map((c) => [c.method, c.args[0]])).toEqual([
      ['rotateConfigToken', HEDY_STORED],
      ['createApp', MINTED_ACCESS],
      ['setAppIcon', MINTED_ACCESS],
      ['deleteApp', MINTED_ACCESS],
    ]);
    expect(supportBot(w)).toBeUndefined();
    expect(w.memory.leftovers.size).toBe(0);
    expectNoSecretsOf(w, id);
    // Still open, as the AX admin saw it: they can approve it again, or decline it.
    expect(w.memory.requests.get(REQUEST)).toMatchObject({ agentId: SUPPORT.id, requestedByUserId: GRACE, botName: BOT_NAME });
    expect(w.vault.get(configTokenRef(HEDY))).toBe(mintedRefresh(1));
    expect(w.lines).toEqual([
      { level: 'error', msg: 'slack_bot_failed', fields: { installId: id, stage: 'request', code: 'ECONNRESET' } },
    ]);

    // Her first app: nothing else names her, so the rotate's successor goes with the undo.
    const first = world();
    await seedShared(first);
    await seedRequest(first);
    first.vault.set(configTokenRef(HEDY), HEDY_STORED);
    first.memory.failures.set('removeBotRequest', connectionReset());
    expect((await first.create({ approver: HEDY, requester: GRACE, requestId: REQUEST })).status).toBe(500);
    expect(first.memory.requests.has(REQUEST)).toBe(true);
    expect(first.vault.has(configTokenRef(HEDY))).toBe(false);
  });

  it('an approve whose request vanished before its last step is not a success: the app is taken back and nothing says approved', async () => {
    // Only the unlocked CLI reset can delete a request under the lock: the store says no row went.
    const w = world();
    await seedShared(w);
    await seedRequest(w);
    w.vault.set(configTokenRef(HEDY), HEDY_STORED);
    const remove = w.memory.store.removeBotRequest;
    w.memory.store.removeBotRequest = async (requestId) => {
      w.memory.requests.delete(requestId);
      return remove(requestId);
    };

    const reply = await w.create({ approver: HEDY, requester: GRACE, requestId: REQUEST });

    expect(reply.status).not.toBe(200);
    expect(reply).toEqual({ status: 500, body: { error: 'internal' } });
    // Taken back with the access token the create already held.
    expect(w.slack.calls.map((c) => c.method)).toContain('deleteApp');
    expect(supportBot(w)).toBeUndefined();
    expect(w.memory.leftovers.size).toBe(0);
    expect(w.lines.map((l) => l.msg)).not.toContain('slack_bot_approved');
    // Codes only: the one line names our own install id, the stage and the code.
    expect(w.lines).toEqual([
      { level: 'error', msg: 'slack_bot_failed', fields: { installId: createdInstallId(w), stage: 'request', code: 'request-gone' } },
    ]);
  });

  it('an approve that fails at any earlier step leaves the request open too, and any app Slack made is taken back', async () => {
    const cases: Array<[step: string, arrange: (w: World) => void, status: number, appMade: boolean]> = [
      ['the rotate', (w) => failRotate(w, new SlackApiError('tooling.tokens.rotate', 'invalid_refresh_token')), 502, false],
      [
        'the create',
        (w) => {
          w.slack.on.createApp = async () => {
            throw new SlackApiError('apps.manifest.create', 'invalid_manifest');
          };
        },
        502,
        false,
      ],
      ['the signing secret', (w) => w.vaultFailures.set('credentials:set signing-secret', connectionReset()), 500, true],
      ['the bot row', (w) => w.memory.failures.set('insertPendingBot', connectionReset()), 500, true],
      // The step right before the request's delete: the install link's state.
      ['the install link', (w) => w.memory.failures.set('setOAuthState', connectionReset()), 500, true],
    ];
    for (const [step, arrange, status, appMade] of cases) {
      const w = world();
      await seedShared(w);
      await seedRequest(w);
      w.vault.set(configTokenRef(HEDY), HEDY_STORED);
      arrange(w);

      expect((await w.create({ approver: HEDY, requester: GRACE, requestId: REQUEST })).status, step).toBe(status);

      expect(w.memory.requests.get(REQUEST), step).toMatchObject({ agentId: SUPPORT.id, botName: BOT_NAME });
      expect(w.trail, step).not.toContain('store:removeBotRequest');
      expect(supportBot(w), step).toBeUndefined();
      expect(methods(w).includes('deleteApp'), step).toBe(appMade);
      expect(w.lines.map((l) => l.msg), step).not.toContain('slack_bot_approved');
    }
  });

  it("leaves out the request's own name, and no other: another open request with a name of the same key is 409 bot-name-taken, before any token", async () => {
    // Approving the request under its own name passes.
    const own = world();
    await seedShared(own);
    await seedRequest(own);
    own.vault.set(configTokenRef(HEDY), HEDY_STORED);
    expect((await own.create({ approver: HEDY, requester: GRACE, requestId: REQUEST })).status).toBe(200);

    // Sam's open request for the sales agent holds a name with the same key.
    const w = world();
    await seedShared(w);
    await seedRequest(w);
    await seedRequest(w, { requestId: SALES_REQUEST, agentId: SALES.id, by: SAM, botName: 'support-helper' });
    w.vault.set(configTokenRef(HEDY), HEDY_STORED);

    expect(await w.create({ approver: HEDY, requester: GRACE, requestId: REQUEST })).toEqual({
      status: 409,
      body: { error: 'bot-name-taken' },
    });

    expect(w.slack.calls).toEqual([]);
    expect(w.vaultCalls).toEqual([]);
    expect(supportBot(w)).toBeUndefined();
    expect([...w.memory.requests.keys()].sort()).toEqual([REQUEST, SALES_REQUEST].sort());
  });

  it("an approve for a request that is no longer the agent's open one makes nothing: gone is 404 not-found, another is 409 bot-requested", async () => {
    // Gone: taken back between the approve's own read and this create.
    const gone = world();
    await seedShared(gone);
    gone.vault.set(configTokenRef(HEDY), HEDY_STORED);
    expect(await gone.create({ approver: HEDY, requester: GRACE, requestId: REQUEST })).toEqual({
      status: 404,
      body: { error: 'not-found' },
    });

    // Another agent's request: the support agent's own open request isn't it.
    const other = world();
    await seedShared(other);
    await seedRequest(other);
    await seedRequest(other, { requestId: SALES_REQUEST, agentId: SALES.id, by: SAM, botName: 'Sales Desk' });
    other.vault.set(configTokenRef(HEDY), HEDY_STORED);
    expect(await other.create({ approver: HEDY, requester: GRACE, requestId: SALES_REQUEST })).toEqual({
      status: 409,
      body: { error: 'bot-requested' },
    });
    expect(other.memory.requests.size).toBe(2);

    for (const w of [gone, other]) {
      expect(w.slack.calls).toEqual([]);
      expect(w.vaultCalls).toEqual([]);
      expect(bots(w)).toEqual([]);
    }
  });

  it('the agent already has a bot: 409 bot-exists before any token, and the request stays', async () => {
    const w = world();
    await seedShared(w);
    await addBot(w, { agentId: SUPPORT.id, approver: GRACE, botName: 'Old Helper' });
    await seedRequest(w);
    w.vault.set(configTokenRef(HEDY), HEDY_STORED);

    expect(await w.create({ approver: HEDY, requester: GRACE, requestId: REQUEST })).toEqual({
      status: 409,
      body: { error: 'bot-exists' },
    });
    expect(w.slack.calls).toEqual([]);
    expect(w.vaultCalls).toEqual([]);
    expect(w.memory.requests.has(REQUEST)).toBe(true);
  });

  it('an approver with no stored token and no paste: 409 config-token-needed, and the request stays', async () => {
    const w = world();
    await seedShared(w);
    await seedRequest(w);

    expect(await w.create({ approver: HEDY, requester: GRACE, requestId: REQUEST })).toEqual({
      status: 409,
      body: { error: 'config-token-needed' },
    });
    expect(w.slack.calls).toEqual([]);
    expect(w.vaultCalls).toEqual([{ hook: 'credentials:get', ref: configTokenRef(HEDY) }]);
    expect(w.memory.requests.has(REQUEST)).toBe(true);
  });
});

// ── finish ──────────────────────────────────────────────────────────────────

describe('finish', () => {
  it("goes live for an AX admin who is not on the agent's team: she is still an AX admin, and the requester still a team admin", async () => {
    const w = world();
    await seedShared(w);
    const { installId } = await approvedBot(w);

    expect(await w.finish(HEDY, installId)).toEqual({ outcome: 'connected' });

    expect(supportBot(w)).toMatchObject({ status: 'active', connectedByUserId: HEDY, requestedByUserId: GRACE });
    expect(w.vault.get(secretRef(installId, 'bot-token'))).toBe(BOT_TOKEN);
    // Asked of auth about Hedy, and of @ax/agents about Grace only, as a non-admin.
    expect(w.auth.asked).toEqual([HEDY]);
    expect(w.people.inputs('agents:resolve')).toEqual([{ agentId: SUPPORT.id, userId: GRACE }]);
    expect(w.people.inputs('agents:can-set-shared-credential')).toEqual([
      { agentId: SUPPORT.id, actor: { userId: GRACE, isAdmin: false } },
    ]);
  });

  it('refuses an approver who is no longer an AX admin, or no longer exists: not-admin, and Slack is asked nothing', async () => {
    for (const change of ['demoted', 'deleted'] as const) {
      const w = world();
      await seedShared(w);
      const { installId } = await approvedBot(w);
      if (change === 'demoted') w.users.get(HEDY)!.isAdmin = false;
      else w.users.delete(HEDY);

      expect(await w.finish(HEDY, installId), change).toEqual({ outcome: 'failed', reason: 'not-admin' });

      expect(w.slack.calls, change).toEqual([]);
      expect(supportBot(w), change).toMatchObject({ status: 'pending' });
      // Refused before the requester is even asked about.
      expect(w.people.calls, change).toEqual([]);
    }
  });

  it('only an isAdmin of exactly true counts, and only in an answer about the approver', async () => {
    const answers: unknown[] = [
      { id: HEDY, displayName: 'Hedy Lamarr', isAdmin: 'true' },
      { id: HEDY, displayName: 'Hedy Lamarr', isAdmin: 1 },
      { id: HEDY, displayName: 'Hedy Lamarr' },
      // An answer about someone else is no answer about her.
      { id: GRACE, displayName: 'Grace Hopper', isAdmin: true },
      [{ id: HEDY, isAdmin: true }],
      'admin',
      null,
    ];
    for (const value of answers) {
      const w = world();
      await seedShared(w);
      const { installId } = await approvedBot(w);
      w.auth.answer = { value };

      expect(await w.finish(HEDY, installId), JSON.stringify(value)).toEqual({ outcome: 'failed', reason: 'not-admin' });
      expect(w.slack.calls, JSON.stringify(value)).toEqual([]);
      expect(supportBot(w), JSON.stringify(value)).toMatchObject({ status: 'pending' });
    }
  });

  it('refuses when the requester is no longer a team admin: requester-not-admin, and Slack is asked nothing', async () => {
    for (const role of ['member', null] as const) {
      const w = world();
      await seedShared(w);
      const { installId } = await approvedBot(w);
      w.people.setRole(SUPPORT_TEAM, GRACE, role);

      expect(await w.finish(HEDY, installId), String(role)).toEqual({ outcome: 'failed', reason: 'requester-not-admin' });
      expect(w.slack.calls, String(role)).toEqual([]);
      expect(supportBot(w), String(role)).toMatchObject({ status: 'pending' });
    }
  });

  it('refuses when the agent is gone (not-found) or no longer a team agent (personal-agent)', async () => {
    const gone = world();
    await seedShared(gone);
    const g = await approvedBot(gone);
    gone.people.agents.delete(SUPPORT.id);
    expect(await gone.finish(HEDY, g.installId)).toEqual({ outcome: 'failed', reason: 'not-found' });

    const personal = world();
    await seedShared(personal);
    const p = await approvedBot(personal);
    personal.people.agents.set(SUPPORT.id, { ...SUPPORT, visibility: 'personal', ownerType: 'user', ownerId: GRACE });
    expect(await personal.finish(HEDY, p.installId)).toEqual({ outcome: 'failed', reason: 'personal-agent' });

    for (const w of [gone, personal]) expect(w.slack.calls).toEqual([]);
  });

  it("a fault asking auth or @ax/agents throws, as the self path's rights check does, before Slack is asked anything", async () => {
    const authDown = world();
    await seedShared(authDown);
    const a = await approvedBot(authDown);
    authDown.auth.fault = new PluginError({ code: 'session-store-down', plugin: '@ax/auth-better', message: `down ${FAILURE_CANARY}` });
    await expect(authDown.finish(HEDY, a.installId)).rejects.toMatchObject({ code: 'session-store-down' });

    const agentsDown = world();
    await seedShared(agentsDown);
    const b = await approvedBot(agentsDown);
    agentsDown.people.faults.set(
      'agents:resolve',
      new PluginError({ code: 'agents-down', plugin: '@ax/agents', message: `down ${FAILURE_CANARY}` }),
    );
    await expect(agentsDown.finish(HEDY, b.installId)).rejects.toMatchObject({ code: 'agents-down' });

    for (const w of [authDown, agentsDown]) {
      expect(w.slack.calls).toEqual([]);
      expect(supportBot(w)).toMatchObject({ status: 'pending' });
    }
  });

  it('the self path still asks only whether the approver manages the agent, never auth', async () => {
    const w = world();
    await seedShared(w);
    w.vault.set(configTokenRef(GRACE), GRACE_STORED);
    await w.request({ as: GRACE });
    const installId = supportBot(w)!.installId;
    forget(w);

    expect(await w.finish(GRACE, installId)).toEqual({ outcome: 'connected' });
    expect(w.auth.asked).toEqual([]);

    // A team admin who asked for it herself and is an AX admin too is still on the self path: demoted, she is refused.
    const a = world();
    await seedShared(a);
    await a.request({ as: ADA });
    const adaBot = supportBot(a)!.installId;
    a.people.setRole(SUPPORT_TEAM, ADA, 'member');
    forget(a);
    expect(await a.finish(ADA, adaBot)).toEqual({ outcome: 'failed', reason: 'forbidden' });
    expect(a.auth.asked).toEqual([]);
  });
});

// ── installUrl ──────────────────────────────────────────────────────────────

describe('installUrl', () => {
  it('the approver gets a fresh link and the old state stops matching; another team admin gets 403 not-approver; none or live gets 409 not-pending', async () => {
    const w = world();
    await seedShared(w);
    expect(await w.installUrl(GRACE)).toEqual({ status: 409, body: { error: 'not-pending' } });

    const first = await w.request({ as: GRACE, refreshToken: PASTED });
    const oldState = stateOf(first);
    const installId = supportBot(w)!.installId;
    forget(w);

    const again = await w.installUrl(GRACE);
    expect(again).toEqual({ status: 200, body: { installUrl: expect.any(String) } });
    const newState = stateOf(again);
    expect(newState).not.toBe(oldState);
    expect(Object.fromEntries(linkOf(again).searchParams)).toEqual({
      client_id: APP.clientId,
      scope: SIX_SCOPES,
      redirect_uri: BOT_CALLBACK,
      state: newState,
    });
    expect(await w.memory.store.peekOAuthState(sha256(oldState), 'bot')).toBeNull();
    expect(await w.memory.store.peekOAuthState(sha256(newState), 'bot')).toMatchObject({ installId, userId: GRACE });
    // A new link costs no token and no Slack call.
    expect(w.slack.calls).toEqual([]);
    expect(w.vaultCalls).toEqual([]);

    // Another team admin: the state would bind them, and only Grace's Allow can finish what her token made.
    forget(w);
    expect(await w.installUrl(ADA)).toEqual({ status: 403, body: { error: 'not-approver' } });
    expect(w.trail).toEqual(['store:botForAgent']);
    expect(await w.memory.store.peekOAuthState(sha256(newState), 'bot')).toMatchObject({ userId: GRACE });

    // Live: nothing to continue.
    await w.memory.store.activate(installId, {
      teamId: 'T07ABCDEF12',
      teamName: 'Canopy Works',
      botUserId: 'U07HELPERBOT',
      installedAt: new Date(NOW_MS),
    });
    expect(await w.installUrl(GRACE)).toEqual({ status: 409, body: { error: 'not-pending' } });
  });
});

// ── cancel ──────────────────────────────────────────────────────────────────

describe('cancel', () => {
  it("a pending bot's app is deleted with the approver's token (rotate, save, delete); row and secrets go; the token released unless named", async () => {
    const w = world();
    await seedShared(w);
    await w.request({ as: GRACE, refreshToken: PASTED });
    const installId = supportBot(w)!.installId;
    forget(w);

    expect(await w.cancel()).toEqual({ status: 200, body: { appDeleted: true } });

    expect(w.trail).toEqual([
      'store:botForAgent',
      // Grace's token: read, rotated, the successor saved, then the delete with the minted access token.
      'vault:get config-refresh-token',
      'slack:rotateConfigToken',
      'vault:set config-refresh-token',
      'slack:deleteApp',
      'store:remove',
      'vault:delete bot-token',
      'vault:delete signing-secret',
      'vault:delete client-secret',
      'vault:delete config-refresh-token',
      // Last, her token: nothing names her any more.
      'store:personHasApps',
      'vault:delete config-refresh-token',
    ]);
    expect(w.slack.calls.map((c) => [c.method, c.args])).toEqual([
      ['rotateConfigToken', [mintedRefresh(1)]],
      ['deleteApp', [MINTED_ACCESS, APP.appId]],
    ]);
    expect(w.vaultCalls.at(-1)).toEqual({ hook: 'credentials:delete', ref: configTokenRef(GRACE) });
    expect(w.memory.rows.has(installId)).toBe(false);
    expect(w.memory.leftovers.size).toBe(0);
    expectNoSecretsOf(w, installId);
    expect(w.vault.has(configTokenRef(GRACE))).toBe(false);
    for (const [ref, value] of sharedVault()) expect(w.vault.get(ref), ref).toBe(value);
    expect(w.lines).toEqual([{ level: 'info', msg: 'slack_bot_cancelled', fields: { installId, appDeleted: true } }]);

    // Ada's request: her shared app still names her, so her token (the delete's successor) stays.
    const a = world();
    await seedShared(a);
    await a.request({ as: ADA });
    forget(a);
    expect(await a.cancel()).toEqual({ status: 200, body: { appDeleted: true } });
    expect(a.vault.get(configTokenRef(ADA))).toBe(mintedRefresh(2));
    expect(a.trail.at(-1)).toBe('store:personHasApps');
  });

  it('a dead token lists it as left over, token kept', async () => {
    const w = world();
    await seedShared(w);
    await w.request({ as: GRACE, refreshToken: PASTED });
    const installId = supportBot(w)!.installId;
    forget(w);
    failRotate(w, new SlackApiError('tooling.tokens.rotate', 'invalid_refresh_token'));

    expect(await w.cancel()).toEqual({ status: 200, body: { appDeleted: false } });

    expect(w.memory.rows.has(installId)).toBe(false);
    expect([...w.memory.leftovers.values()]).toEqual([
      { installId, appId: APP.appId, botName: BOT_NAME, leftAt: new Date(NOW_MS), connectedByUserId: GRACE },
    ]);
    expectNoSecretsOf(w, installId);
    expect(w.vault.get(configTokenRef(GRACE))).toBe(mintedRefresh(1));
    expect(w.lines).toEqual([
      { level: 'warn', msg: 'slack_bot_failed', fields: { installId, stage: 'rotate', code: 'invalid_refresh_token' } },
      { level: 'info', msg: 'slack_bot_cancelled', fields: { installId, appDeleted: false } },
    ]);
  });

  it('a live bot gets 409 not-pending', async () => {
    const w = world();
    await seedShared(w);
    await addBot(w, { agentId: SUPPORT.id, approver: GRACE, botName: BOT_NAME, live: true });

    expect(await w.cancel()).toEqual({ status: 409, body: { error: 'not-pending' } });

    expect(w.slack.calls).toEqual([]);
    expect(w.vaultCalls).toEqual([]);
    expect(supportBot(w)).toMatchObject({ status: 'active' });

    // Nor is there anything to cancel for an agent with no bot.
    const none = world();
    expect(await none.cancel()).toEqual({ status: 409, body: { error: 'not-pending' } });
  });
});

// ── disconnect (TASK-1172) ──────────────────────────────────────────────────

/**
 * A bot's removal (`removeBot`), after its lookup: what Cancel and agent
 * deletion do too.
 */
const REMOVAL_TRAIL = [
  // The approver's token: read, rotated, the successor saved, then the delete with the minted access token.
  'vault:get config-refresh-token',
  'slack:rotateConfigToken',
  'vault:set config-refresh-token',
  'slack:deleteApp',
  // One statement: the row and its bindings (and, had Slack refused, the app onto the leftover list).
  'store:remove',
  'vault:delete bot-token',
  'vault:delete signing-secret',
  'vault:delete client-secret',
  'vault:delete config-refresh-token',
  // Last, the approver's token: nothing names them any more.
  'store:personHasApps',
  'vault:delete config-refresh-token',
];

describe('disconnect', () => {
  it("disconnect: a live bot's app is deleted with its approver's token (rotate, save, delete); its row and three secrets go; the token is released once nothing names its person", async () => {
    const w = world();
    await seedShared(w);
    const installId = await seedSupportBot(w);

    expect(await w.disconnect(GRACE, installId)).toEqual({ status: 200, body: { appDeleted: true } });

    expect(w.trail).toEqual(['store:botForAgent', ...REMOVAL_TRAIL]);
    // Grace's own stored token is the one rotated, and the app deleted is the bot's.
    expect(w.slack.calls.map((c) => [c.method, c.args])).toEqual([
      ['rotateConfigToken', [GRACE_STORED]],
      ['deleteApp', [MINTED_ACCESS, ADDED_BOT_APP]],
    ]);
    expect(w.vaultCalls.at(-1)).toEqual({ hook: 'credentials:delete', ref: configTokenRef(GRACE) });
    expect(w.memory.rows.has(installId)).toBe(false);
    expect(w.memory.leftovers.size).toBe(0);
    expectNoSecretsOf(w, installId);
    expect(w.vault.has(configTokenRef(GRACE))).toBe(false);
    // The shared app, its secrets and Ada's own token are as they were.
    expect(w.memory.rows.get(SHARED_INSTALL)).toMatchObject({ kind: 'shared', status: 'active' });
    for (const [ref, value] of sharedVault()) expect(w.vault.get(ref), ref).toBe(value);
    expect(w.lines).toEqual([
      { level: 'info', msg: 'slack_bot_disconnected', fields: { installId, appDeleted: true, by: 'team-admin' } },
    ]);
  });

  it('disconnect: with no shared install at all (Admin › Slack disconnected it), the bot still goes', async () => {
    const w = world();
    const installId = await seedSupportBot(w);

    expect(await w.disconnect(GRACE, installId)).toEqual({ status: 200, body: { appDeleted: true } });

    expect(w.trail).toEqual(['store:botForAgent', ...REMOVAL_TRAIL]);
    expect(w.memory.rows.size).toBe(0);
    expect(w.memory.leftovers.size).toBe(0);
    expectNoSecretsOf(w, installId);
    expect(w.vault.has(configTokenRef(GRACE))).toBe(false);
    expect(w.lines).toEqual([
      { level: 'info', msg: 'slack_bot_disconnected', fields: { installId, appDeleted: true, by: 'team-admin' } },
    ]);
  });

  it('disconnect: a pending bot goes the same way', async () => {
    const w = world();
    await seedShared(w);
    const installId = await seedSupportBot(w, { live: false });

    expect(await w.disconnect(GRACE, installId)).toEqual({ status: 200, body: { appDeleted: true } });

    expect(w.trail).toEqual(['store:botForAgent', ...REMOVAL_TRAIL]);
    expect(supportBot(w)).toBeUndefined();
    expectNoSecretsOf(w, installId);
    expect(w.vault.has(configTokenRef(GRACE))).toBe(false);
    expect(w.lines).toEqual([
      { level: 'info', msg: 'slack_bot_disconnected', fields: { installId, appDeleted: true, by: 'team-admin' } },
    ]);
  });

  it("disconnect: Slack won't delete the app: it is listed as left over naming the approver, the install still goes, the approver's token stays", async () => {
    // Slack refuses Grace's token at the rotate.
    const w = world();
    await seedShared(w);
    const installId = await seedSupportBot(w);
    failRotate(w, new SlackApiError('tooling.tokens.rotate', 'invalid_refresh_token'));

    expect(await w.disconnect(GRACE, installId)).toEqual({ status: 200, body: { appDeleted: false } });

    expect([...w.memory.leftovers.values()]).toEqual([
      { installId, appId: ADDED_BOT_APP, botName: BOT_NAME, leftAt: new Date(NOW_MS), connectedByUserId: GRACE },
    ]);
    expect(supportBot(w)).toBeUndefined();
    expectNoSecretsOf(w, installId);
    // The leftover names her, so her token stays: only it can delete that app later.
    expect(w.vault.get(configTokenRef(GRACE))).toBe(GRACE_STORED);
    expect(w.lines).toEqual([
      { level: 'warn', msg: 'slack_bot_failed', fields: { installId, stage: 'rotate', code: 'invalid_refresh_token' } },
      { level: 'info', msg: 'slack_bot_disconnected', fields: { installId, appDeleted: false, by: 'team-admin' } },
    ]);

    // Slack refuses the delete itself: the rotate's successor is the token that stays.
    const d = world();
    await seedShared(d);
    const dId = await seedSupportBot(d);
    d.slack.on.deleteApp = async () => {
      throw new SlackApiError('apps.manifest.delete', 'no_permission');
    };

    expect(await d.disconnect(GRACE, dId)).toEqual({ status: 200, body: { appDeleted: false } });

    expect([...d.memory.leftovers.values()]).toEqual([
      { installId: dId, appId: ADDED_BOT_APP, botName: BOT_NAME, leftAt: new Date(NOW_MS), connectedByUserId: GRACE },
    ]);
    expect(supportBot(d)).toBeUndefined();
    expectNoSecretsOf(d, dId);
    expect(d.vault.get(configTokenRef(GRACE))).toBe(mintedRefresh(1));
    expect(d.lines).toEqual([
      { level: 'warn', msg: 'slack_bot_failed', fields: { installId: dId, stage: 'delete-app', code: 'no_permission' } },
      { level: 'info', msg: 'slack_bot_disconnected', fields: { installId: dId, appDeleted: false, by: 'team-admin' } },
    ]);
  });

  it('disconnect: an approver whose shared app still names them keeps their token', async () => {
    const w = world();
    await seedShared(w);
    const installId = await seedSupportBot(w, { approver: ADA });

    // Grace disconnects it: the delete still uses Ada's token, whose app it is on Slack.
    expect(await w.disconnect(GRACE, installId)).toEqual({ status: 200, body: { appDeleted: true } });

    expect(w.slack.calls.filter((c) => c.method === 'rotateConfigToken').map((c) => c.args)).toEqual([[ADA_STORED]]);
    // The delete's successor, kept for the shared app that still names her.
    expect(w.vault.get(configTokenRef(ADA))).toBe(mintedRefresh(1));
    expect(w.trail.at(-1)).toBe('store:personHasApps');
    expect(w.vault.has(configTokenRef(GRACE))).toBe(false);
  });

  it('disconnect: rights are asked again inside the lock: a team admin demoted while it was held gets 403, an agent deleted meanwhile 404, and nothing is touched', async () => {
    // Demoted to member while another Slack-app step held the one app lock.
    const lock = createMutex();
    const w = world({ lock });
    await seedShared(w);
    const installId = await seedSupportBot(w);
    const hold = await holdLock(lock);
    const asked = w.disconnect(GRACE, installId);
    w.people.setRole(SUPPORT_TEAM, GRACE, 'member');
    hold.free();
    await hold.done;

    expect(await asked).toEqual({ status: 403, body: { error: 'forbidden' } });
    expect(w.trail).toEqual([]);
    expect(w.slack.calls).toEqual([]);
    expect(w.vaultCalls).toEqual([]);
    expect(supportBot(w)).toMatchObject({ status: 'active' });
    // Asked as a non-admin, as every manage question is.
    expect(w.people.inputs('agents:can-set-shared-credential')).toEqual([
      { agentId: SUPPORT.id, actor: { userId: GRACE, isAdmin: false } },
    ]);

    // The agent deleted while it waited.
    const lock2 = createMutex();
    const g = world({ lock: lock2 });
    await seedShared(g);
    const gId = await seedSupportBot(g);
    const held = await holdLock(lock2);
    const gone = g.disconnect(GRACE, gId);
    g.people.agents.delete(SUPPORT.id);
    held.free();
    await held.done;

    expect(await gone).toEqual({ status: 404, body: { error: 'not-found' } });
    expect(g.trail).toEqual([]);
    expect(g.slack.calls).toEqual([]);
    expect(g.vaultCalls).toEqual([]);
    expect(supportBot(g)).toMatchObject({ status: 'active' });
  });

  it('disconnect: rights that cannot be answered throw before anything is read', async () => {
    const w = world();
    await seedShared(w);
    const installId = await seedSupportBot(w);
    w.people.faults.set(
      'agents:resolve',
      new PluginError({ code: 'unavailable', plugin: '@ax/agents', message: `db down ${FAILURE_CANARY}` }),
    );

    // An outage is no refusal: the route's 500.
    await expect(w.disconnect(GRACE, installId)).rejects.toMatchObject({ code: 'unavailable' });

    expect(w.trail).toEqual([]);
    expect(w.slack.calls).toEqual([]);
    expect(w.vaultCalls).toEqual([]);
    expect(supportBot(w)).toMatchObject({ status: 'active' });
  });

  it('disconnect: an agent with no bot is 409 no-bot, with no vault or Slack call', async () => {
    const w = world();
    await seedShared(w);
    // Another agent's bot is no business of this one's, even named by its own install id.
    const salesBot = await addBot(w);

    expect(await w.disconnect(GRACE, salesBot)).toEqual({ status: 409, body: { error: 'no-bot' } });

    expect(w.trail).toEqual(['store:botForAgent']);
    expect(w.slack.calls).toEqual([]);
    expect(w.vaultCalls).toEqual([]);
    expect(w.lines).toEqual([]);
    expect(bots(w)).toEqual([expect.objectContaining({ agentId: SALES.id })]);
  });

  it("disconnect: a row that won't go throws; the bot's secrets and its approver's token stay for a retry", async () => {
    const w = world();
    await seedShared(w);
    const installId = await seedSupportBot(w);
    w.memory.failures.set('remove', connectionReset());

    await expect(w.disconnect(GRACE, installId)).rejects.toMatchObject({ code: 'ECONNRESET' });

    // The app went first; nothing after the row's delete ran.
    expect(w.trail.slice(-2)).toEqual(['slack:deleteApp', 'store:remove']);
    expect(w.memory.rows.has(installId)).toBe(true);
    expect(w.vault.get(secretRef(installId, 'bot-token'))).toBe(SUPPORT_BOT_TOKEN);
    expect(w.vault.get(secretRef(installId, 'signing-secret'))).toBe(SIGNING_SECRET);
    expect(w.vault.get(secretRef(installId, 'client-secret'))).toBe(CLIENT_SECRET);
    // Grace's token as the delete's rotate left it: its successor, saved before the delete.
    expect(w.vault.get(configTokenRef(GRACE))).toBe(mintedRefresh(1));
    expect(w.memory.leftovers.size).toBe(0);
    expect(w.lines).toEqual([]);

    // Once the store is back, a retry finishes it: Slack already deleted the app, which counts as deleted.
    w.memory.failures.delete('remove');
    w.slack.on.deleteApp = async () => {
      throw new SlackApiError('apps.manifest.delete', 'app_not_found');
    };
    forget(w);
    expect(await w.disconnect(GRACE, installId)).toEqual({ status: 200, body: { appDeleted: true } });
    expect(w.memory.rows.has(installId)).toBe(false);
    expect(w.memory.leftovers.size).toBe(0);
    expectNoSecretsOf(w, installId);
    expect(w.vault.has(configTokenRef(GRACE))).toBe(false);
  });

  it("disconnectForAdmin: removes a bot by its install id the same way, without asking anyone's rights, and logs by: 'admin'", async () => {
    const w = world();
    await seedShared(w);
    const installId = await seedSupportBot(w);

    expect(await w.disconnectForAdmin(installId)).toEqual({ status: 200, body: { appDeleted: true } });

    expect(w.trail).toEqual(['store:get', ...REMOVAL_TRAIL]);
    // No agents hook at all: Admin › Slack's own gate let the AX admin through.
    expect(w.people.calls).toEqual([]);
    expect(w.slack.calls.map((c) => [c.method, c.args])).toEqual([
      ['rotateConfigToken', [GRACE_STORED]],
      ['deleteApp', [MINTED_ACCESS, ADDED_BOT_APP]],
    ]);
    expect(w.memory.rows.has(installId)).toBe(false);
    expect(w.memory.leftovers.size).toBe(0);
    expectNoSecretsOf(w, installId);
    expect(w.vault.has(configTokenRef(GRACE))).toBe(false);
    expect(w.memory.rows.get(SHARED_INSTALL)).toMatchObject({ kind: 'shared', status: 'active' });
    for (const [ref, value] of sharedVault()) expect(w.vault.get(ref), ref).toBe(value);
    expect(w.lines).toEqual([
      { level: 'info', msg: 'slack_bot_disconnected', fields: { installId, appDeleted: true, by: 'admin' } },
    ]);

    // Admin › Slack lists pending bots too, so its Disconnect takes them.
    const p = world();
    await seedShared(p);
    const pendingId = await seedSupportBot(p, { live: false });
    expect(await p.disconnectForAdmin(pendingId)).toEqual({ status: 200, body: { appDeleted: true } });
    expect(supportBot(p)).toBeUndefined();
    expect(p.lines).toEqual([
      { level: 'info', msg: 'slack_bot_disconnected', fields: { installId: pendingId, appDeleted: true, by: 'admin' } },
    ]);
  });

  it("disconnectForAdmin: the shared install's id, an id no install has, or an old bot's id after a new request is 409 no-bot, and nothing is touched", async () => {
    const w = world();
    await seedShared(w);

    // The shared app has its own Disconnect, with its own rules: never this one.
    expect(await w.disconnectForAdmin(SHARED_INSTALL)).toEqual({ status: 409, body: { error: 'no-bot' } });
    expect(w.trail).toEqual(['store:get']);
    expect(w.memory.rows.get(SHARED_INSTALL)).toMatchObject({ kind: 'shared', status: 'active' });
    for (const [ref, value] of sharedVault()) expect(w.vault.get(ref), ref).toBe(value);

    // An id no install has.
    forget(w);
    expect(await w.disconnectForAdmin('A'.repeat(22))).toEqual({ status: 409, body: { error: 'no-bot' } });
    expect(w.trail).toEqual(['store:get']);

    // A stale tab: the bot it listed was disconnected, and the agent asked for a new one since.
    const oldId = await seedSupportBot(w);
    expect(await w.disconnect(GRACE, oldId)).toEqual({ status: 200, body: { appDeleted: true } });
    expect(await w.request({ as: GRACE, refreshToken: PASTED })).toMatchObject({ status: 200 });
    const fresh = { ...supportBot(w)! };
    expect(fresh).toMatchObject({ kind: 'bot', status: 'pending', agentId: SUPPORT.id });
    expect(fresh.installId).not.toBe(oldId);
    const vaultBefore = new Map(w.vault);
    forget(w);

    expect(await w.disconnectForAdmin(oldId)).toEqual({ status: 409, body: { error: 'no-bot' } });

    expect(w.trail).toEqual(['store:get']);
    expect(supportBot(w)).toEqual(fresh);
    expect(w.vault).toEqual(vaultBefore);
    expect(w.slack.calls).toEqual([]);
    expect(w.vaultCalls).toEqual([]);
    expect(w.lines).toEqual([]);
  });

  it("disconnect: a stale settings page's bot (disconnected since, and a new one asked for and live) is 409 no-bot, and the new bot is left alone", async () => {
    // Grace's tab shows the old bot. It was disconnected elsewhere, Ada asked
    // for a new one and it went live, and only then does Grace confirm.
    const w = world();
    await seedShared(w);
    const oldId = await seedSupportBot(w);
    expect(await w.disconnect(ADA, oldId)).toEqual({ status: 200, body: { appDeleted: true } });
    expect(await w.request({ as: ADA, refreshToken: PASTED })).toMatchObject({ status: 200 });
    const newId = supportBot(w)!.installId;
    expect(newId).not.toBe(oldId);
    await w.memory.store.activate(newId, {
      teamId: 'T07ABCDEF12',
      teamName: 'Canopy Works',
      botUserId: 'U07NEWBOT01',
      installedAt: new Date(NOW_MS),
    });
    const fresh = { ...supportBot(w)! };
    expect(fresh).toMatchObject({ kind: 'bot', status: 'active', agentId: SUPPORT.id });
    const vaultBefore = new Map(w.vault);
    forget(w);

    expect(await w.disconnect(GRACE, oldId)).toEqual({ status: 409, body: { error: 'no-bot' } });

    // Her rights, then the one read that shows the agent's bot is another one: nothing else.
    expect(w.trail).toEqual(['store:botForAgent']);
    expect(supportBot(w)).toEqual(fresh);
    expect(w.vault).toEqual(vaultBefore);
    expect(w.slack.calls).toEqual([]);
    expect(w.vaultCalls).toEqual([]);
    expect(w.lines).toEqual([]);

    // The page read again names the new bot, and that Disconnect takes it.
    expect(await w.disconnect(GRACE, newId)).toEqual({ status: 200, body: { appDeleted: true } });
    expect(supportBot(w)).toBeUndefined();
  });

  it('two disconnects at once remove the bot once: the other is 409 no-bot', async () => {
    // A team admin and an AX admin together.
    const w = world();
    await seedShared(w);
    const installId = await seedSupportBot(w);

    const both = await Promise.all([w.disconnect(GRACE, installId), w.disconnectForAdmin(installId)]);

    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(both.find((r) => r.status === 200)).toEqual({ status: 200, body: { appDeleted: true } });
    expect(both.find((r) => r.status === 409)).toEqual({ status: 409, body: { error: 'no-bot' } });
    expect(w.slack.calls.filter((c) => c.method === 'deleteApp')).toHaveLength(1);
    // Her token was rotated once: a second rotate of a retired token would have left the app behind.
    expect(w.slack.calls.filter((c) => c.method === 'rotateConfigToken')).toHaveLength(1);
    expect(w.memory.leftovers.size).toBe(0);
    expect(bots(w)).toEqual([]);
    expect(w.lines.filter((l) => l.msg === 'slack_bot_disconnected')).toHaveLength(1);

    // A double click.
    const d = world();
    await seedShared(d);
    const dId = await seedSupportBot(d);
    const clicks = await Promise.all([d.disconnect(GRACE, dId), d.disconnect(GRACE, dId)]);
    expect(clicks.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(clicks.find((r) => r.status === 409)).toEqual({ status: 409, body: { error: 'no-bot' } });
    expect(d.slack.calls.filter((c) => c.method === 'deleteApp')).toHaveLength(1);
    expect(d.memory.leftovers.size).toBe(0);
    expect(bots(d)).toEqual([]);
  });

  it('both wait for the one app lock: nothing is read, rotated or deleted until the step holding it lets go', async () => {
    const lock = createMutex();
    const w = world({ lock });
    await seedShared(w);
    const installId = await seedSupportBot(w);
    const hold = await holdLock(lock);

    const byTeamAdmin = w.disconnect(GRACE, installId);
    const byAdmin = w.disconnectForAdmin(installId);
    await settle();

    // Not a store read, a rights question, a vault read or a Slack call while another step holds it.
    expect(w.trail).toEqual([]);
    expect(w.people.calls).toEqual([]);
    expect(w.slack.calls).toEqual([]);
    expect(w.vaultCalls).toEqual([]);

    hold.free();
    await hold.done;
    // In the order they arrived: the first removes it, the second finds nothing.
    expect(await byTeamAdmin).toEqual({ status: 200, body: { appDeleted: true } });
    expect(await byAdmin).toEqual({ status: 409, body: { error: 'no-bot' } });
    expect(w.slack.calls.filter((c) => c.method === 'deleteApp')).toHaveLength(1);
  });
});

// ── listForAdmin (TASK-1172) ────────────────────────────────────────────────

describe('listForAdmin', () => {
  it('listForAdmin: every bot, pending and live, never the shared app: name, handle, approver, state and when it was asked for', async () => {
    const w = world();
    await seedShared(w);
    await w.request({ as: GRACE, refreshToken: PASTED });
    const supportId = supportBot(w)!.installId;
    // Sam's live bot for the sales agent, whose bot user Slack called @salesdesk.
    await addBot(w, { handle: 'salesdesk' });

    const listed = await w.listForAdmin();

    // Both rows share the fake clock, so their order is the store's tie-break (store.test.ts).
    expect(listed).toHaveLength(2);
    expect(listed).toEqual(
      expect.arrayContaining([
        {
          installId: supportId,
          botName: BOT_NAME,
          handle: null,
          approver: 'Grace Hopper',
          state: 'pending',
          addedAt: new Date(NOW_MS).toISOString(),
        },
        {
          installId: 'U2FsZXNCb3RJbnN0YWxsMQ',
          botName: 'Sales Desk',
          handle: 'salesdesk',
          approver: 'Sam Sales',
          state: 'live',
          addedAt: new Date(NOW_MS).toISOString(),
        },
      ]),
    );
    // One read of the bots; no vault read, no Slack call; auth asked about each approver, never the shared app's.
    expect(w.trail).toEqual(['store:listBots']);
    expect(w.vaultCalls).toEqual([]);
    expect(w.slack.calls).toEqual([]);
    expect([...w.authAsked].sort()).toEqual([GRACE, SAM].sort());
    // In the order the store lists them.
    expect(listed.map((b) => b.installId)).toEqual((await w.memory.store.listBots()).map((r) => r.installId));
  });

  it('listForAdmin: an approver without a display name reads as their email (only admins read this list)', async () => {
    const w = world();
    await seedShared(w);
    await addBot(w, { handle: 'salesdesk' });
    w.users.get(SAM)!.displayName = null;

    expect(await w.listForAdmin()).toEqual([expect.objectContaining({ approver: 'sam@canopyworks.example' })]);

    // The agent's settings, which members read too, still never show it.
    expect(await w.status({ as: SAM, manages: true, sharedActive: true, agentId: SALES.id })).toMatchObject({
      state: 'live',
      approver: 'A teammate',
    });
  });

  it('listForAdmin: an approver auth no longer has is null; an auth fault fails the whole list, never a name that hides who has left', async () => {
    const w = world();
    await seedShared(w);
    const installId = await addBot(w, { handle: 'salesdesk' });
    w.users.delete(SAM);

    expect(await w.listForAdmin()).toEqual([expect.objectContaining({ installId, approver: null })]);
    // An account that's gone is an answer, not a fault.
    expect(w.lines).toEqual([]);

    // Auth is down. Read as "A teammate", every "A former member" mark would
    // go, and an offboarding admin would read the list as nobody having left.
    // It throws instead: the route's 500, which the page shows with Try again.
    const fault = connectionReset();
    const f = world({ getUserFault: fault });
    await seedShared(f);
    await f.request({ as: GRACE, refreshToken: PASTED });
    await addBot(f, { handle: 'salesdesk' });
    const answered = f.replies.length;

    const err = await f.listForAdmin().then(
      (listed) => ({ listed }),
      (e: unknown) => e,
    );

    // The bus's wrap, with auth's fault as its cause: the route logs its code.
    expect(err).toBeInstanceOf(PluginError);
    expect((err as Error).cause).toBe(fault);
    expect(logCode(err)).toBe('ECONNRESET');
    // No list at all, not even part of one; and nothing logged here (the route's line has the code).
    expect(f.replies).toHaveLength(answered);
    expect(f.lines).toEqual([]);
  });

  it('listForAdmin: no bots is [] and asks auth nothing', async () => {
    const w = world();
    await seedShared(w);

    expect(await w.listForAdmin()).toEqual([]);

    expect(w.trail).toEqual(['store:listBots']);
    expect(w.authAsked).toEqual([]);

    // Nor with no shared app at all.
    const none = world();
    expect(await none.listForAdmin()).toEqual([]);
    expect(none.authAsked).toEqual([]);
  });

  it('listForAdmin: a store fault throws, never an empty list', async () => {
    const w = world();
    await seedShared(w);
    await addBot(w, { handle: 'salesdesk' });
    w.memory.failures.set('listBots', connectionReset());

    // An offboarding admin reads "no bots" as "nothing to rebuild": a broken read must be the route's 500.
    await expect(w.listForAdmin()).rejects.toMatchObject({ code: 'ECONNRESET' });
    expect(w.authAsked).toEqual([]);
  });

  it('listForAdmin: each item holds exactly the six fields, and no person id, token, app id or agent id', async () => {
    const w = world();
    await seedShared(w);
    await w.request({ as: GRACE, refreshToken: PASTED });
    await addBot(w, { handle: 'salesdesk' });

    const answer = await w.listForAdmin();

    expect(answer).toHaveLength(2);
    for (const item of answer) {
      expect(Object.keys(item).sort()).toEqual(['addedAt', 'approver', 'botName', 'handle', 'installId', 'state']);
    }
    const text = JSON.stringify(answer);
    for (const leak of [GRACE, SAM, ADA, 'usr_', SUPPORT.id, SALES.id, ADDED_BOT_APP, APP.appId, SHARED_APP, SHARED_INSTALL]) {
      expect(text, leak).not.toContain(leak);
    }
    // The vault holds tokens and secrets enough to make the scan mean something.
    expect(w.vault.size).toBeGreaterThan(4);
    for (const [ref, value] of w.vault) expect(text, ref).not.toContain(value);
  });

  it('listForAdmin: takes no lock, reads no vault and asks Slack nothing', async () => {
    const lock = createMutex();
    const w = world({ lock });
    await seedShared(w);
    await addBot(w, { handle: 'salesdesk' });
    const hold = await holdLock(lock);

    let listed: unknown = 'still waiting for the lock';
    void w.listForAdmin().then(
      (answer) => {
        listed = answer;
      },
      (err: unknown) => {
        listed = err;
      },
    );
    await settle();

    // Answered while another Slack-app step still holds the one app lock.
    expect(listed).toEqual([expect.objectContaining({ botName: 'Sales Desk', state: 'live' })]);
    expect(w.vaultCalls).toEqual([]);
    expect(w.slack.calls).toEqual([]);
    hold.free();
    await hold.done;
  });
});

// ── status ──────────────────────────────────────────────────────────────────

describe('status', () => {
  it('none: a manager learns whether their own token is stored; a non-manager, or no live shared bot, reads false without asking the vault; a fault reads false', async () => {
    const w = world();
    await seedShared(w);
    w.vault.set(configTokenRef(GRACE), GRACE_STORED);

    expect(await w.status({ as: GRACE, manages: true, sharedActive: true })).toEqual({ state: 'none', configTokenStored: true });
    // Her own token, read as her; never rotated, so Slack is asked nothing.
    expect(w.vaultAs).toEqual([{ hook: 'credentials:get', name: 'config-refresh-token', userId: GRACE }]);
    expect(w.vaultCalls).toEqual([{ hook: 'credentials:get', ref: configTokenRef(GRACE) }]);
    expect(w.slack.calls).toEqual([]);

    w.vault.delete(configTokenRef(GRACE));
    expect(await w.status({ as: GRACE, manages: true, sharedActive: true })).toEqual({ state: 'none', configTokenStored: false });

    w.vault.set(configTokenRef(GRACE), GRACE_STORED);
    forget(w);
    expect(await w.status({ as: GRACE, manages: false, sharedActive: true })).toEqual({ state: 'none', configTokenStored: false });
    expect(await w.status({ as: GRACE, manages: true, sharedActive: false })).toEqual({ state: 'none', configTokenStored: false });
    expect(w.vaultCalls).toEqual([]);

    // A vault fault, or an id that can't name a ref, reads false: the form then shows the token field.
    w.vaultFailures.set(`credentials:get ${configTokenRef(GRACE)}`, connectionReset());
    expect(await w.status({ as: GRACE, manages: true, sharedActive: true })).toEqual({ state: 'none', configTokenStored: false });
    expect(await w.status({ as: IVY, manages: true, sharedActive: true })).toEqual({ state: 'none', configTokenStored: false });
    expect(w.lines).toEqual([
      { level: 'warn', msg: 'slack_bot_failed', fields: { stage: 'status-config-token', code: 'ECONNRESET' } },
      { level: 'warn', msg: 'slack_bot_failed', fields: { stage: 'status-config-token', code: 'invalid-person-id' } },
    ]);
  });

  it('pending: canContinue only for the approver, and only while the shared install is active; a non-manager sees none', async () => {
    const w = world();
    await seedShared(w);
    await w.request({ as: GRACE, refreshToken: PASTED });
    const installId = supportBot(w)!.installId;
    forget(w);
    const pending = (canContinue: boolean) => ({
      state: 'pending',
      botName: BOT_NAME,
      approver: 'Grace Hopper',
      canContinue,
      installId,
    });

    expect(await w.status({ as: GRACE, manages: true, sharedActive: true })).toEqual(pending(true));
    expect(await w.status({ as: ADA, manages: true, sharedActive: true })).toEqual(pending(false));
    expect(await w.status({ as: GRACE, manages: true, sharedActive: false })).toEqual(pending(false));
    // A member who doesn't manage the agent learns nothing of a request, not even that one exists.
    expect(await w.status({ as: MEL, manages: false, sharedActive: true })).toEqual({ state: 'none', configTokenStored: false });
    // Reading never writes, rotates or asks Slack.
    expect(w.slack.calls).toEqual([]);
    expect(w.vaultCalls).toEqual([]);
  });

  it('live: the handle and the approver are shown to everyone, never an email; needsClaim once the requester is no longer a team admin; a fault reads false', async () => {
    const w = world();
    await seedShared(w);
    await addBot(w, { agentId: SUPPORT.id, approver: GRACE, botName: BOT_NAME, handle: 'supporthelper' });
    const installId = supportBot(w)!.installId;
    // The install id only for those who manage the agent: the key its Disconnect takes.
    const live = (o: { approver?: string; needsClaim?: boolean; manages?: boolean } = {}) => ({
      state: 'live',
      botName: BOT_NAME,
      handle: 'supporthelper',
      approver: o.approver ?? 'Grace Hopper',
      needsClaim: o.needsClaim ?? false,
      installId: (o.manages ?? true) ? installId : null,
    });

    for (const [as, manages] of [
      [GRACE, true],
      [ADA, true],
      [MEL, false],
    ] as const) {
      expect(await w.status({ as, manages, sharedActive: true }), as).toEqual(live({ manages }));
    }
    // A live bot outlives the shared install (Disconnect leaves it alone).
    expect(await w.status({ as: MEL, manages: false, sharedActive: false })).toEqual(live({ manages: false }));

    // No display name: "A teammate", never the email.
    w.users.get(GRACE)!.displayName = null;
    const nameless = await w.status({ as: MEL, manages: false, sharedActive: true });
    expect(nameless).toEqual(live({ approver: 'A teammate', manages: false }));
    expect(JSON.stringify(nameless)).not.toContain('@');
    w.users.get(GRACE)!.displayName = 'Grace Hopper';

    // The requester is only a member now, or off the team (a deleted account reads the same): outsiders need a claim.
    w.people.setRole(SUPPORT_TEAM, GRACE, 'member');
    expect(await w.status({ as: ADA, manages: true, sharedActive: true })).toEqual(live({ needsClaim: true }));
    w.people.setRole(SUPPORT_TEAM, GRACE, null);
    expect(await w.status({ as: ADA, manages: true, sharedActive: true })).toEqual(live({ needsClaim: true }));
    // Asked about the requester, as a non-admin, whoever is reading.
    for (const input of w.people.inputs('agents:resolve')) expect(input).toEqual({ agentId: SUPPORT.id, userId: GRACE });
    for (const input of w.people.inputs('agents:can-set-shared-credential')) {
      expect(input).toEqual({ agentId: SUPPORT.id, actor: { userId: GRACE, isAdmin: false } });
    }

    // An outage reads false: the router asks on every mention, so the page need not alarm anyone.
    w.people.setRole(SUPPORT_TEAM, GRACE, 'admin');
    forget(w);
    w.people.faults.set(
      'agents:resolve',
      new PluginError({ code: 'unavailable', plugin: '@ax/agents', message: `db down ${FAILURE_CANARY}` }),
    );
    expect(await w.status({ as: ADA, manages: true, sharedActive: true })).toEqual(live());
    expect(w.lines).toEqual([
      { level: 'warn', msg: 'slack_bot_failed', fields: { installId, stage: 'status-claim', code: 'unavailable' } },
    ]);

    // A handle Slack never gave us reads as null.
    const plain = world();
    await seedShared(plain);
    await addBot(plain, { agentId: SUPPORT.id, approver: GRACE, botName: BOT_NAME, live: true });
    expect(await plain.status({ as: MEL, manages: false, sharedActive: true })).toEqual({
      ...live({ manages: false }),
      handle: null,
    });
  });

  it("the bot's install id, the key its Disconnect takes, reaches only those who manage the agent: pending (which only they see) and live, with or without the shared app; anyone else reads null", async () => {
    const w = world();
    await seedShared(w);
    await w.request({ as: GRACE, refreshToken: PASTED });
    const pendingId = supportBot(w)!.installId;
    for (const as of [GRACE, ADA]) {
      for (const sharedActive of [true, false]) {
        expect(await w.status({ as, manages: true, sharedActive }), `${as} ${sharedActive}`).toMatchObject({
          state: 'pending',
          installId: pendingId,
        });
      }
    }

    const l = world();
    await seedShared(l);
    const liveId = await seedSupportBot(l);
    for (const sharedActive of [true, false]) {
      expect(await l.status({ as: ADA, manages: true, sharedActive })).toMatchObject({ state: 'live', installId: liveId });
      expect(await l.status({ as: MEL, manages: false, sharedActive })).toMatchObject({ state: 'live', installId: null });
    }
    // Reading it never writes, rotates or asks Slack.
    expect(l.slack.calls).toEqual([]);
    expect(l.vaultCalls).toEqual([]);
  });

  it('requested: a manager sees an open request, its name and when it was asked, with or without a live shared bot', async () => {
    const w = world();
    await seedShared(w);
    await seedRequest(w);
    const requested = { state: 'requested', botName: BOT_NAME, requestedAt: new Date(NOW_MS).toISOString() };

    // Whoever asked, any team admin of the agent's team sees it.
    for (const as of [GRACE, ADA]) {
      expect(await w.status({ as, manages: true, sharedActive: true }), as).toEqual(requested);
      expect(await w.status({ as, manages: true, sharedActive: false }), as).toEqual(requested);
    }
    // Reading never writes, rotates or asks Slack; no token is involved until an AX admin approves.
    expect(w.slack.calls).toEqual([]);
    expect(w.vaultCalls).toEqual([]);
  });

  it("requested: anyone who doesn't manage the agent sees none, and the request isn't read for them", async () => {
    const w = world();
    await seedShared(w);
    await seedRequest(w);

    expect(await w.status({ as: MEL, manages: false, sharedActive: true })).toEqual({ state: 'none', configTokenStored: false });
    expect(w.trail).toEqual(['store:botForAgent']);
  });

  it('a bot row wins over a request: mid-approve, the pending bot shows', async () => {
    // An approve inserts the bot, then takes the request last: a status that
    // takes no lock can read the two at once.
    const w = world();
    await seedShared(w);
    await addBot(w, { agentId: SUPPORT.id, approver: HEDY, requester: GRACE, botName: BOT_NAME });
    await seedRequest(w);

    expect(await w.status({ as: GRACE, manages: true, sharedActive: true })).toEqual({
      state: 'pending',
      botName: BOT_NAME,
      approver: 'Hedy Lamarr',
      canContinue: false,
    });
    expect(w.trail).not.toContain('store:botRequestForAgent');
  });
});

// ── removeForAgent ──────────────────────────────────────────────────────────

describe('removeForAgent', () => {
  it("removes the agent's open request, under the app lock, and says so by its id alone", async () => {
    const lock = createMutex();
    const w = world({ lock });
    await seedShared(w);
    await seedRequest(w);
    await seedRequest(w, { requestId: SALES_REQUEST, agentId: SALES.id, by: SAM, botName: 'Sales Desk' });
    // Another Slack-app step holds the lock: an approve of this very request, say.
    const hold = await holdLock(lock);
    const removing = w.removeForAgent();
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
    expect(w.trail).toEqual([]);

    hold.free();
    await hold.done;
    await removing;

    expect([...w.memory.requests.keys()]).toEqual([SALES_REQUEST]);
    // No bot: one read, no vault or Slack call.
    expect(w.trail).toEqual(['store:removeBotRequestForAgent', 'store:botForAgent']);
    expect(w.vaultCalls).toEqual([]);
    expect(w.slack.calls).toEqual([]);
    expect(w.lines).toEqual([
      { level: 'info', msg: 'slack_agent_bot_request_removed', fields: { requestId: REQUEST } },
    ]);

    // An agent with neither costs two reads and says nothing.
    forget(w);
    await w.removeForAgent();
    expect(w.trail).toEqual(['store:removeBotRequestForAgent', 'store:botForAgent']);
    expect(w.lines).toEqual([]);
  });

  it("a fault taking the request doesn't stop the bot's removal: logged code-only, then the bot goes", async () => {
    const w = world();
    await seedShared(w);
    const installId = await addBot(w, { agentId: SUPPORT.id, approver: GRACE, botName: BOT_NAME, live: true });
    w.vault.set(configTokenRef(GRACE), GRACE_STORED);
    w.memory.failures.set('removeBotRequestForAgent', connectionReset());

    await w.removeForAgent();

    expect(supportBot(w)).toBeUndefined();
    expect(methods(w)).toEqual(['rotateConfigToken', 'deleteApp']);
    expect(w.lines).toEqual([
      { level: 'error', msg: 'slack_bot_failed', fields: { stage: 'agent-deleted-request', code: 'ECONNRESET' } },
      { level: 'info', msg: 'slack_agent_bot_removed', fields: { installId, appDeleted: true } },
    ]);
  });
});

// ── namesInUse ──────────────────────────────────────────────────────────────

describe('namesInUse', () => {
  it('reads the shared bot, every bot and its handle, and every open request; except leaves out one install or one request', async () => {
    const w = world();
    await seedShared(w);
    const salesBot = await addBot(w, { botName: 'Sales Desk', handle: 'salesdesk2' });
    await seedRequest(w);
    await seedRequest(w, { requestId: SALES_REQUEST, agentId: 'agt_ops', by: SAM, botName: 'Ops Helper' });

    // Requests come as the store lists them: oldest first, then by id (both were asked at NOW_MS).
    expect(await namesInUse(w.memory.store)).toEqual(['canopy-works', 'Sales Desk', 'salesdesk2', 'Ops Helper', BOT_NAME]);
    expect(w.trail).toEqual(['store:current', 'store:listBots', 'store:listBotRequests']);

    // One install out (a rename keeps or varies its own name)…
    expect(await namesInUse(w.memory.store, { except: SHARED_INSTALL })).toEqual([
      'Sales Desk',
      'salesdesk2',
      'Ops Helper',
      BOT_NAME,
    ]);
    expect(await namesInUse(w.memory.store, { except: salesBot })).toEqual(['canopy-works', 'Ops Helper', BOT_NAME]);
    // …or one request (an approve keeps its own name), and only that one.
    expect(await namesInUse(w.memory.store, { except: REQUEST })).toEqual([
      'canopy-works',
      'Sales Desk',
      'salesdesk2',
      'Ops Helper',
    ]);
  });
});

// ── What leaves the domain ──────────────────────────────────────────────────

describe('answers and logs', () => {
  it('no reply body or log line carries a token or a person id', async () => {
    const worlds: World[] = [];
    const add = (w: World): World => {
      worlds.push(w);
      return w;
    };

    // Everything going well: a request from a stored token, its link again, every view of it, a refusal, a cancel.
    const w = add(world());
    await seedShared(w);
    w.vault.set(configTokenRef(GRACE), GRACE_STORED);
    await w.request({ as: GRACE });
    await w.installUrl(GRACE);
    await w.installUrl(ADA);
    await w.status({ as: GRACE, manages: true, sharedActive: true });
    await w.status({ as: ADA, manages: true, sharedActive: true });
    await w.status({ as: MEL, manages: false, sharedActive: true });
    await w.request({ as: ADA, refreshToken: PASTED });
    await w.cancel();
    await w.status({ as: ADA, manages: true, sharedActive: true });

    // Each failure in its own world.
    const refusedStored = add(world());
    await seedShared(refusedStored);
    refusedStored.vault.set(configTokenRef(GRACE), GRACE_STORED);
    failRotate(refusedStored, new SlackApiError('tooling.tokens.rotate', 'invalid_refresh_token'));
    await refusedStored.request({ as: GRACE });

    const refusedPaste = add(world());
    await seedShared(refusedPaste);
    failRotate(refusedPaste, new SlackApiError('tooling.tokens.rotate', 'invalid_auth'));
    await refusedPaste.request({ as: GRACE, refreshToken: PASTED });

    const unsaved = add(world());
    await seedShared(unsaved);
    unsaved.vaultFailures.set(`credentials:set ${configTokenRef(GRACE)}`, connectionReset());
    await unsaved.request({ as: GRACE, refreshToken: PASTED });

    const uncreated = add(world());
    await seedShared(uncreated);
    uncreated.slack.on.createApp = async () => {
      throw new SlackApiError('apps.manifest.create', 'timeout');
    };
    await uncreated.request({ as: GRACE, refreshToken: PASTED });

    const undone = add(world());
    await seedShared(undone);
    undone.vaultFailures.set('credentials:set signing-secret', connectionReset());
    undone.slack.on.deleteApp = async () => {
      throw new SlackApiError('apps.manifest.delete', 'internal_error');
    };
    await undone.request({ as: GRACE, refreshToken: PASTED });

    const badId = add(world());
    await seedShared(badId);
    await badId.request({ as: IVY, refreshToken: PASTED });
    await badId.status({ as: IVY, manages: true, sharedActive: true });

    const deadCancel = add(world());
    await seedShared(deadCancel);
    await deadCancel.request({ as: GRACE, refreshToken: PASTED });
    failRotate(deadCancel, new SlackApiError('tooling.tokens.rotate', 'token_revoked'));
    await deadCancel.cancel();

    // TASK-1169: an open request as its managers see it, an AX admin's
    // approve and her Allow, a refused self request, and the agent's deletion.
    const approved = add(world());
    await seedShared(approved);
    await seedRequest(approved);
    approved.vault.set(configTokenRef(HEDY), HEDY_STORED);
    await approved.status({ as: GRACE, manages: true, sharedActive: true });
    await approved.request({ as: GRACE, refreshToken: PASTED });
    await approved.create({ approver: HEDY, requester: GRACE, requestId: REQUEST });
    await approved.finish(HEDY, supportBot(approved)!.installId);
    await approved.status({ as: MEL, manages: false, sharedActive: true });
    await approved.removeForAgent();

    // An approve whose last step fails, and the agent's deletion taking its request.
    const unremoved = add(world());
    await seedShared(unremoved);
    await seedRequest(unremoved);
    unremoved.vault.set(configTokenRef(HEDY), HEDY_STORED);
    unremoved.memory.failures.set('removeBotRequest', connectionReset());
    await unremoved.create({ approver: HEDY, requester: GRACE, requestId: REQUEST });
    unremoved.memory.failures.set('removeBotRequestForAgent', connectionReset());
    await unremoved.removeForAgent();
    unremoved.memory.failures.delete('removeBotRequestForAgent');
    await unremoved.removeForAgent();

    // TASK-1172: Admin › Slack's list, a team admin's Disconnect, then one with nothing left to take.
    const disconnected = add(world());
    await seedShared(disconnected);
    const disconnectedId = await seedSupportBot(disconnected);
    await disconnected.listForAdmin();
    await disconnected.disconnect(GRACE, disconnectedId);
    await disconnected.disconnect(GRACE, disconnectedId);

    // An AX admin's, then one naming the shared app.
    const adminDisconnected = add(world());
    await seedShared(adminDisconnected);
    await adminDisconnected.disconnectForAdmin(await seedSupportBot(adminDisconnected));
    await adminDisconnected.disconnectForAdmin(SHARED_INSTALL);

    // One Slack won't delete: the leftover names its approver, and no line does.
    const deadDisconnect = add(world());
    await seedShared(deadDisconnect);
    const deadId = await seedSupportBot(deadDisconnect);
    failRotate(deadDisconnect, new SlackApiError('tooling.tokens.rotate', 'token_revoked'));
    await deadDisconnect.disconnect(GRACE, deadId);

    // Every world said something, so the scan below reads real output.
    for (const x of worlds) {
      expect(x.replies.length).toBeGreaterThan(0);
      expect(x.lines.length).toBeGreaterThan(0);
    }
    const tokens = [
      CONFIG_ACCESS_PREFIX,
      CONFIG_REFRESH_PREFIX,
      BOT_PREFIX,
      CLIENT_SECRET,
      SIGNING_SECRET,
      SHARED_CLIENT_SECRET,
      SHARED_SIGNING_SECRET,
    ];
    const people = [ADA, GRACE, MEL, SAM, IVY, HEDY, 'usr_'];
    for (const x of worlds) {
      const replies = JSON.stringify(x.replies);
      for (const text of [...tokens, ...people]) expect(replies, text).not.toContain(text);
      // Log lines are code-only: not the agent either, nor a failure's own text.
      const logged = JSON.stringify(x.lines);
      for (const text of [...tokens, ...people, SUPPORT.id, BOT_NAME, APP.appId, ADDED_BOT_APP, FAILURE_CANARY]) {
        expect(logged, text).not.toContain(text);
      }
    }
  });
});
