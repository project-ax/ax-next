import { createHash, randomBytes } from 'node:crypto';
import { HookBus, PluginError, makeAgentContext, type Logger } from '@ax/core';
import { describe, expect, it } from 'vitest';
import { createBots } from '../bots.js';
import { parseIconPng, type ParsedIcon } from '../icon.js';
import { OAUTH_STATE_TTL_MS } from '../limits.js';
import { botUrls, buildBotManifest } from '../manifest.js';
import { createMutex, type Mutex } from '../mutex.js';
import { SECRET_NAMES, configTokenRef, createSecretStore, secretRef } from '../secrets.js';
import { SlackApiError } from '../slack-api.js';
import { fakeAgents, type FakeAgent } from './fake-agents.js';
import { pngBase64 } from './fake-png.js';
import { APP, CLIENT_SECRET, MINTED_ACCESS, NOW_MS, SIGNING_SECRET, fakeSlack, mintedRefresh } from './fake-slack-config.js';
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
const USERS = [
  { id: ADA, displayName: 'Ada Admin' as string | null, email: 'ada@canopyworks.example' },
  { id: GRACE, displayName: 'Grace Hopper' as string | null, email: 'grace@canopyworks.example' },
  { id: MEL, displayName: 'Mel Member' as string | null, email: 'mel@canopyworks.example' },
  { id: SAM, displayName: 'Sam Sales' as string | null, email: 'sam@canopyworks.example' },
];

/** Each person's own configuration token (TASK-1175), as their last use of it left it. */
const ADA_STORED = fakeConfigRefreshToken('ADASTOREDSECRET');
const GRACE_STORED = fakeConfigRefreshToken('GRACESTOREDSECRET');
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

function world(o: { publicOrigin?: string; lock?: Mutex } = {}) {
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

  // Auth's own accounts, by id: a test may rename one.
  const users = new Map(USERS.map((u) => [u.id, { ...u }]));
  bus.registerService('auth:get-user', '@ax/auth-better', async (_ctx, raw) => {
    const user = users.get((raw as { userId: string }).userId);
    return user === undefined ? null : { ...user };
  });

  const memory = memoryStore(() => NOW_MS, trail);
  const slack = fakeSlack(trail);
  const bots = createBots({
    bus,
    installs: memory.store,
    secrets: createSecretStore(bus, { logger }),
    api: slack.api,
    lock: o.lock ?? createMutex(),
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
    vault,
    vaultCalls,
    vaultAs,
    vaultFailures,
    memory,
    slack,
    trail,
    lines,
    replies,
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
  w.lines.length = 0;
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
 * agent's, Sam's, unless told otherwise. Live when `live` or a `handle` is given.
 */
async function addBot(
  w: World,
  o: { agentId?: string; approver?: string; botName?: string; live?: boolean; handle?: string } = {},
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
    requestedByUserId: approver,
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
      // Every refusal that needs no Slack call: the shared app, the agent's bot, the names in use.
      'store:current',
      'store:botForAgent',
      'store:current',
      'store:listBots',
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
      'store:current',
      'store:listBots',
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
    forget(w);
    const pending = (canContinue: boolean) => ({ state: 'pending', botName: BOT_NAME, approver: 'Grace Hopper', canContinue });

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
    const live = (o: { approver?: string; needsClaim?: boolean } = {}) => ({
      state: 'live',
      botName: BOT_NAME,
      handle: 'supporthelper',
      approver: o.approver ?? 'Grace Hopper',
      needsClaim: o.needsClaim ?? false,
    });

    for (const [as, manages] of [
      [GRACE, true],
      [ADA, true],
      [MEL, false],
    ] as const) {
      expect(await w.status({ as, manages, sharedActive: true }), as).toEqual(live());
    }
    // A live bot outlives the shared install (Disconnect leaves it alone).
    expect(await w.status({ as: MEL, manages: false, sharedActive: false })).toEqual(live());

    // No display name: "A teammate", never the email.
    w.users.get(GRACE)!.displayName = null;
    const nameless = await w.status({ as: MEL, manages: false, sharedActive: true });
    expect(nameless).toEqual(live({ approver: 'A teammate' }));
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
    expect(await plain.status({ as: MEL, manages: false, sharedActive: true })).toEqual({ ...live(), handle: null });
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
    const people = [ADA, GRACE, MEL, SAM, IVY, 'usr_'];
    for (const x of worlds) {
      const replies = JSON.stringify(x.replies);
      for (const text of [...tokens, ...people]) expect(replies, text).not.toContain(text);
      // Log lines are code-only: not the agent either, nor a failure's own text.
      const logged = JSON.stringify(x.lines);
      for (const text of [...tokens, ...people, SUPPORT.id, BOT_NAME, APP.appId, FAILURE_CANARY]) {
        expect(logged, text).not.toContain(text);
      }
    }
  });
});
