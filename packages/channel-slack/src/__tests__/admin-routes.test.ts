import { createHash, randomBytes } from 'node:crypto';
import { HookBus, PluginError, type Logger } from '@ax/core';
import { describe, expect, it } from 'vitest';
import { createAdminRoutes } from '../admin-routes.js';
import type { RouteRequest, RouteResponse } from '../http-types.js';
import {
  ADMIN_BODY_MAX_BYTES,
  ADMIN_CONNECT_BODY_MAX_BYTES,
  LEFTOVER_APPS_MAX,
  OAUTH_STATE_TTL_MS,
  SLACK_ICON_MAX_BYTES,
  SLACK_TOKEN_MAX,
} from '../limits.js';
import { BOT_SCOPES, buildAppManifest, slackUrls } from '../manifest.js';
import { pngBase64, pngHeader } from './fake-png.js';
import {
  BOT_PREFIX,
  CONFIG_ACCESS_PREFIX,
  CONFIG_REFRESH_PREFIX,
  fakeBotToken,
  fakeConfigAccessToken,
  fakeConfigRefreshToken,
} from './fake-slack-tokens.js';
import { createMutex } from '../mutex.js';
import { SECRET_NAMES, configTokenRef, createSecretStore, secretRef } from '../secrets.js';
import {
  SlackApiError,
  type CreatedApp,
  type OAuthInstall,
  type RotatedConfigToken,
  type SlackApi,
} from '../slack-api.js';
import { InstallStoreError, type InstallRow, type InstallStore, type LeftoverApp } from '../store.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const ORIGIN = 'https://ax.example';
const HTTP_ORIGIN = 'http://ax.internal:8080';
/** The bot's picture the admin's browser drew: a 512 px PNG (its header, which is all Connect reads). */
const ICON = pngHeader(512, 512);
const CALLBACK = '/admin/slack/oauth/callback';
/** "I deleted it": the admin deleted a leftover app on Slack's page themselves (TASK-1132). */
const FORGET = '/admin/slack/forget-leftover-app';
const REDIRECT_URI = `${ORIGIN}${CALLBACK}`;
const NOW_MS = Date.parse('2026-11-13T12:00:00.000Z');

// Distinctive, so a leak is easy to spot. Shaped like Slack's, but short
// enough that a secret scanner won't take them for real ones.
const ACCESS = fakeConfigAccessToken();
const REFRESH = fakeConfigRefreshToken();
const MINTED_ACCESS = fakeConfigAccessToken('MINTEDACCESSSECRET');
/** The refresh token the fake Slack mints with its nth rotate, counting from 1. */
const mintedRefresh = (n: number): string => fakeConfigRefreshToken(`MINTEDREFRESH${n}SECRET`);
const SECOND_ACCESS = fakeConfigAccessToken('SECONDACCESSSECRET');
const SECOND_REFRESH = fakeConfigRefreshToken('SECONDREFRESHSECRET');
/** A person's own configuration token (TASK-1175), kept in their slot since an earlier Connect of theirs. */
const ADA_STORED = fakeConfigRefreshToken('ADASTOREDSECRET');
const EVE_STORED = fakeConfigRefreshToken('EVESTOREDSECRET');
const CLIENT_SECRET = 'CLIENTSECRET0123456789abcdef';
const SIGNING_SECRET = 'SIGNINGSECRET3f1c2b9a8e7d6c5b';
const BOT_TOKEN = fakeBotToken();
const SECRETS = [
  ACCESS,
  REFRESH,
  SECOND_ACCESS,
  SECOND_REFRESH,
  MINTED_ACCESS,
  mintedRefresh(1),
  mintedRefresh(2),
  ADA_STORED,
  EVE_STORED,
  CLIENT_SECRET,
  SIGNING_SECRET,
  BOT_TOKEN,
];

const APP: CreatedApp = {
  appId: 'A07QF9ZK2MN',
  clientId: '7512345678901.7598765432109',
  clientSecret: CLIENT_SECRET,
  signingSecret: SIGNING_SECRET,
};
const GRANT: OAuthInstall = {
  botToken: BOT_TOKEN,
  botUserId: 'U07BOTUSER1',
  appId: APP.appId,
  teamId: 'T07ABCDEF12',
  teamName: 'Canopy Works',
  enterpriseInstall: false,
};
const CODE = '7512345678901.7598765432109.0123456789abcdef';
const CONNECT_BODY = {
  accessToken: ACCESS,
  refreshToken: REFRESH,
  botName: 'Canopy Bot',
  iconPng: ICON.toString('base64'),
};
/** A new pair, as an admin pastes after a Cancel: the strict fake retires REFRESH as soon as a Connect rotates it. */
const SECOND_PAIR = { ...CONNECT_BODY, accessToken: SECOND_ACCESS, refreshToken: SECOND_REFRESH };
/** The app a second Connect makes, when a test needs it told apart from the first. */
const SECOND_APP_ID = 'A07SECONDAPP';
/** Slack apps an earlier Disconnect couldn't delete, by the removed install's id (TASK-1132). */
const LEFT_1 = { installId: 'inst_left_1', appId: 'A07LEFTAPP01' } as const;
const LEFT_2 = { installId: 'inst_left_2', appId: 'A07LEFTAPP02' } as const;
const LEFT_3 = { installId: 'inst_left_3', appId: 'A07LEFTAPP03' } as const;

interface TestUser {
  id: string;
  displayName: string | null;
  email: string | null;
  isAdmin: boolean;
}
const ADA: TestUser = { id: 'usr_ada', displayName: 'Ada Admin', email: 'ada@example.com', isAdmin: true };
const GRACE: TestUser = { id: 'usr_grace', displayName: 'Grace Hopper', email: 'grace@example.com', isAdmin: true };
const BOB: TestUser = { id: 'usr_bob', displayName: 'Bob', email: 'bob@example.com', isAdmin: false };
const EMAIL_ONLY: TestUser = { id: 'usr_eve', displayName: '  ', email: 'eve@example.com', isAdmin: true };
const NAMELESS: TestUser = { id: 'usr_boot', displayName: null, email: null, isAdmin: true };
const USERS = [ADA, GRACE, BOB, EMAIL_ONLY, NAMELESS];

const back = (outcome: 'connected' | 'cancelled' | 'failed'): string => `${ORIGIN}/?slack=${outcome}`;
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
/** The callback's whole answer to anything it refuses: home, with `failed`, and nothing else. */
const FAILED = { status: 302, how: 'redirect', body: undefined, location: back('failed'), headers: {} };

// ── A request and response shaped like @ax/http-server's ───────────────────

interface Answered {
  status: number;
  /** Which terminator finished the response, or null while it is open. */
  how: 'json' | 'text' | 'end' | 'redirect' | null;
  body: unknown;
  location: string | null;
  headers: Record<string, string>;
}

function fakeResponse(): { res: RouteResponse; answer: Answered } {
  const answer: Answered = { status: 200, how: null, body: undefined, location: null, headers: {} };
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

function request(
  method: 'GET' | 'POST',
  path: string,
  r: { as: TestUser | null; body?: unknown; query?: Record<string, string> },
): RouteRequest {
  const body =
    r.body === undefined
      ? Buffer.alloc(0)
      : Buffer.isBuffer(r.body)
        ? r.body
        : Buffer.from(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
  return {
    method,
    path,
    rawPath: path,
    params: {},
    query: r.query ?? {},
    headers: {
      'content-type': 'application/json',
      ...(r.as !== null ? { 'x-test-user': r.as.id } : {}),
    },
    body,
  };
}

// ── An in-memory InstallStore, with the real one's rules ────────────────────

interface Row extends InstallRow {
  stateHash: string | null;
  stateUserId: string | null;
  stateExpiresAt: Date | null;
}
type StoreMethod = keyof InstallStore;

function memoryStore(clock: () => number, trail: string[]) {
  const rows = new Map<string, Row>();
  /** The Slack apps Disconnect couldn't delete, by the removed install's id. */
  const leftovers = new Map<string, LeftoverApp>();
  const calls: Array<{ method: StoreMethod; args: unknown[] }> = [];
  /** A method listed here throws this, every time, until it is deleted. */
  const failures = new Map<StoreMethod, unknown>();

  async function enter(method: StoreMethod, args: unknown[]): Promise<void> {
    calls.push({ method, args });
    trail.push(`store:${method}`);
    await Promise.resolve(); // a real store answers later
    if (failures.has(method)) throw failures.get(method);
  }
  function view(r: Row): InstallRow {
    return {
      installId: r.installId,
      status: r.status,
      appId: r.appId,
      clientId: r.clientId,
      botName: r.botName,
      teamId: r.teamId,
      teamName: r.teamName,
      botUserId: r.botUserId,
      connectedByUserId: r.connectedByUserId,
      createdAt: r.createdAt,
      configTokenAddedAt: r.configTokenAddedAt,
      installedAt: r.installedAt,
    };
  }
  function holding(stateHash: string): Row | undefined {
    for (const r of rows.values()) if (r.stateHash === stateHash) return r;
    return undefined;
  }

  const store: InstallStore = {
    async current() {
      await enter('current', []);
      const oldest = [...rows.values()].sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() || a.installId.localeCompare(b.installId),
      )[0];
      return oldest === undefined ? null : view(oldest);
    },
    async get(installId) {
      await enter('get', [installId]);
      const r = rows.get(installId);
      return r === undefined ? null : view(r);
    },
    async insertPending(r) {
      await enter('insertPending', [r]);
      if (rows.has(r.installId)) throw new Error('duplicate key value violates unique constraint');
      // One INSERT in the real store: both dates are its now().
      const at = clock();
      rows.set(r.installId, {
        ...r,
        status: 'pending',
        teamId: null,
        teamName: null,
        botUserId: null,
        createdAt: new Date(at),
        configTokenAddedAt: new Date(at),
        installedAt: null,
        stateHash: null,
        stateUserId: null,
        stateExpiresAt: null,
      });
    },
    async setOAuthState(installId, s) {
      await enter('setOAuthState', [installId, s]);
      const r = rows.get(installId);
      if (r === undefined || r.status !== 'pending') throw new InstallStoreError('install-not-pending');
      r.stateHash = s.stateHash;
      r.stateUserId = s.userId;
      r.stateExpiresAt = s.expiresAt;
    },
    async peekOAuthState(stateHash) {
      await enter('peekOAuthState', [stateHash]);
      const r = holding(stateHash);
      if (r === undefined || r.stateUserId === null || r.stateExpiresAt === null) return null;
      return { installId: r.installId, userId: r.stateUserId, expiresAt: r.stateExpiresAt };
    },
    async consumeOAuthState(stateHash) {
      await enter('consumeOAuthState', [stateHash]);
      const r = holding(stateHash);
      if (r === undefined || r.stateUserId === null || r.stateExpiresAt === null) return null;
      const spent = { installId: r.installId, userId: r.stateUserId, expiresAt: r.stateExpiresAt };
      r.stateHash = null;
      r.stateUserId = null;
      r.stateExpiresAt = null;
      return spent;
    },
    async activate(installId, a) {
      await enter('activate', [installId, a]);
      const r = rows.get(installId);
      if (r === undefined || r.status !== 'pending') throw new InstallStoreError('install-not-pending');
      r.status = 'active';
      r.teamId = a.teamId;
      r.teamName = a.teamName;
      r.botUserId = a.botUserId;
      r.installedAt = a.installedAt;
    },
    async setBotName(installId, botName) {
      await enter('setBotName', [installId, botName]);
      const r = rows.get(installId);
      if (r === undefined || r.status !== 'active') throw new InstallStoreError('install-not-active');
      r.botName = botName;
    },
    async setConfigTokenAddedAt(installId, addedAt) {
      await enter('setConfigTokenAddedAt', [installId, addedAt]);
      const r = rows.get(installId);
      if (r === undefined || r.status !== 'active') throw new InstallStoreError('install-not-active');
      // Only the date: the row's person never moves (TASK-1175).
      r.configTokenAddedAt = new Date(addedAt.getTime());
    },
    async remove(installId, o) {
      await enter('remove', [installId, o]);
      // One statement in the real store: the app is remembered only with its
      // row's own delete, with the row's own person (TASK-1175), and an id
      // already remembered keeps its first app.
      const r = rows.get(installId);
      if (r !== undefined && o?.appLeft === true && !leftovers.has(installId)) {
        leftovers.set(installId, {
          installId,
          appId: r.appId,
          botName: r.botName,
          leftAt: new Date(clock()),
          connectedByUserId: r.connectedByUserId,
        });
      }
      rows.delete(installId);
    },
    async removeAll() {
      await enter('removeAll', []);
      const removed = [...rows.values()].map((r) => ({
        installId: r.installId,
        appId: r.appId,
        teamId: r.teamId,
        connectedByUserId: r.connectedByUserId,
      }));
      rows.clear();
      return removed;
    },
    async list() {
      await enter('list', []);
      return [...rows.values()]
        .sort(
          (a, b) =>
            b.configTokenAddedAt.getTime() - a.configTokenAddedAt.getTime() ||
            a.installId.localeCompare(b.installId),
        )
        .map(view);
    },
    async personHasApps(userId) {
      await enter('personHasApps', [userId]);
      return (
        [...rows.values()].some((r) => r.connectedByUserId === userId) ||
        [...leftovers.values()].some((l) => l.connectedByUserId === userId)
      );
    },
    async leftoverApps() {
      await enter('leftoverApps', []);
      return [...leftovers.values()]
        .sort((a, b) => a.leftAt.getTime() - b.leftAt.getTime() || a.installId.localeCompare(b.installId))
        .slice(0, LEFTOVER_APPS_MAX)
        .map((l) => ({ ...l }));
    },
    async rememberLeftoverApp(a) {
      await enter('rememberLeftoverApp', [a]);
      if (!leftovers.has(a.installId)) {
        leftovers.set(a.installId, {
          installId: a.installId,
          appId: a.appId,
          botName: a.botName,
          leftAt: new Date(clock()),
          connectedByUserId: a.connectedByUserId,
        });
      }
    },
    async forgetLeftoverApp(installId) {
      await enter('forgetLeftoverApp', [installId]);
      leftovers.delete(installId);
    },
  };
  return { store, rows, leftovers, calls, failures };
}

// ── A fake Slack: the six calls the admin routes make ───────────────────────

interface SlackBehaviour {
  rotateConfigToken(refreshToken: string): Promise<RotatedConfigToken>;
  createApp(token: string, manifest: Record<string, unknown>): Promise<CreatedApp>;
  updateApp(token: string, appId: string, manifest: Record<string, unknown>): Promise<void>;
  deleteApp(token: string, appId: string): Promise<void>;
  setAppIcon(token: string, appId: string, png: Uint8Array): Promise<void>;
  oauthAccess(i: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
  }): Promise<OAuthInstall>;
}

function fakeSlack(trail: string[]) {
  const calls: Array<{ method: keyof SlackBehaviour; args: unknown[] }> = [];
  /** Every refresh token a rotate was sent, and how many refresh tokens the rotates minted. */
  const rotated = new Set<string>();
  let mints = 0;
  /** The apps that exist on this Slack: each create that succeeded, less each delete that did. */
  const live = new Set<string>();
  /** What each call does; a test swaps one out. */
  const on: SlackBehaviour = {
    /**
     * Slack retires a rotated refresh token within minutes to hours (MEASURED,
     * TASK-1097 walk; slack-api.ts). This fake retires it at once, so any path
     * that rotates one token twice fails. `rotatedStillWork` stands in for the
     * time before Slack retires it.
     */
    rotateConfigToken: async (refreshToken) => {
      if (rotated.has(refreshToken) && !slack.rotatedStillWork) {
        throw new SlackApiError('tooling.tokens.rotate', 'invalid_refresh_token');
      }
      rotated.add(refreshToken);
      mints += 1;
      return { accessToken: MINTED_ACCESS, refreshToken: mintedRefresh(mints), expiresAt: NOW_MS + 43_200_000 };
    },
    createApp: async () => ({ ...APP }),
    updateApp: async () => {},
    deleteApp: async () => {},
    setAppIcon: async () => {},
    oauthAccess: async () => ({ ...GRANT }),
  };
  const record = (method: keyof SlackBehaviour, args: unknown[]): void => {
    calls.push({ method, args });
    trail.push(`slack:${method}`);
  };
  const notHere = async (): Promise<never> => {
    throw new Error('the admin routes never make this call');
  };
  const api: SlackApi = {
    rotateConfigToken: async (refreshToken) => {
      record('rotateConfigToken', [refreshToken]);
      return on.rotateConfigToken(refreshToken);
    },
    createApp: async (token, manifest) => {
      record('createApp', [token, manifest]);
      const app = await on.createApp(token, manifest);
      live.add(app.appId);
      return app;
    },
    updateApp: async (token, appId, manifest) => {
      record('updateApp', [token, appId, manifest]);
      return on.updateApp(token, appId, manifest);
    },
    deleteApp: async (token, appId) => {
      record('deleteApp', [token, appId]);
      await on.deleteApp(token, appId);
      live.delete(appId);
    },
    setAppIcon: async (token, appId, png) => {
      record('setAppIcon', [token, appId, png]);
      return on.setAppIcon(token, appId, png);
    },
    oauthAccess: async (i) => {
      record('oauthAccess', [i]);
      return on.oauthAccess(i);
    },
    usersInfo: notHere,
    postMessage: notHere,
    postBlocks: notHere,
    updateMessage: notHere,
    postEphemeral: notHere,
    startStream: notHere,
    appendStream: notHere,
    stopStream: notHere,
  };
  const slack = {
    api,
    calls,
    on,
    live,
    /** A rotated refresh token still works, as it does on Slack for a while after its rotate. */
    rotatedStillWork: false,
  };
  return slack;
}

// ── The routes' surroundings ────────────────────────────────────────────────

interface Line {
  level: string;
  msg: string;
  fields: Record<string, unknown> | undefined;
}

function world(
  o: {
    publicOrigin?: string;
    /** 'absent': no branding plugin; an Error: branding:get throws it. */
    branding?: { name: string | null } | 'absent' | Error;
    /** auth:require-user throws this for everyone. */
    authFault?: Error;
    /** auth:get-user throws this for everyone. */
    getUserFault?: Error;
    /** Every logger call records its line, then throws this. */
    logFault?: Error;
  } = {},
) {
  let nowMs = NOW_MS;
  /** Every vault, store and Slack call, in order. */
  const trail: string[] = [];
  const lines: Line[] = [];
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, fields });
    if (o.logFault !== undefined) throw o.logFault;
  };
  const logger: Logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  };

  // The real bus, with a fake vault, auth and branding behind it.
  const bus = new HookBus();
  const vault = new Map<string, string>();
  const vaultCalls: Array<{ hook: string; ref: string }> = [];
  /**
   * Whom each vault call names (TASK-1128): a read's `userId`, a write's or
   * delete's ctx user. Apart from vaultCalls, whose entries tests compare whole.
   */
  const vaultAs: Array<{ hook: string; name: string; userId: string }> = [];
  /**
   * `<hook> <secret name>` → what that call throws. `<hook> <ref>` names one
   * ref only, so one person's configuration token can fail while another's
   * doesn't (both end in `config-refresh-token`); it wins over the name.
   */
  const vaultFailures = new Map<string, unknown>();
  const nameOf = (ref: string): string => ref.slice(ref.lastIndexOf(':') + 1);
  const vaultHook = (hook: string, run: (input: Record<string, unknown>) => unknown): void => {
    bus.registerService(hook, '@ax/credentials', async (ctx, raw) => {
      const input = raw as Record<string, unknown>;
      const ref = String(input['ref']);
      vaultCalls.push({ hook, ref });
      vaultAs.push({
        hook,
        name: nameOf(ref),
        userId: hook === 'credentials:get' ? String(input['userId']) : ctx.userId,
      });
      trail.push(`vault:${hook.slice('credentials:'.length)} ${nameOf(ref)}`);
      const failure = vaultFailures.get(`${hook} ${ref}`) ?? vaultFailures.get(`${hook} ${nameOf(ref)}`);
      if (failure !== undefined) throw failure;
      return run(input);
    });
  };
  vaultHook('credentials:set', (i) => {
    vault.set(String(i['ref']), new TextDecoder().decode(i['payload'] as Uint8Array));
  });
  vaultHook('credentials:get', (i) => {
    const value = vault.get(String(i['ref']));
    if (value === undefined) {
      throw new PluginError({ code: 'credential-not-found', plugin: '@ax/credentials', message: 'none' });
    }
    return value;
  });
  vaultHook('credentials:delete', (i) => {
    vault.delete(String(i['ref']));
  });

  // Auth's own accounts, by id: a test may rename or delete one.
  const users = new Map(USERS.map((u) => [u.id, { ...u }]));
  /** Every auth:get-user lookup, by userId. */
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

  const branding = o.branding ?? { name: 'Canopy Works' };
  if (branding !== 'absent') {
    bus.registerService('branding:get', '@ax/branding', async () => {
      if (branding instanceof Error) throw branding;
      return branding;
    });
  }

  const memory = memoryStore(() => nowMs, trail);
  const slack = fakeSlack(trail);
  const routes = createAdminRoutes({
    bus,
    store: memory.store,
    secrets: createSecretStore(bus, { logger }),
    api: slack.api,
    lock: createMutex(),
    publicOrigin: o.publicOrigin ?? ORIGIN,
    logger,
    now: () => nowMs,
    randomBytes: (n) => randomBytes(n),
  });

  const answers: Answered[] = [];
  async function call(
    method: 'GET' | 'POST',
    path: string,
    r: { as?: TestUser | null; body?: unknown; query?: Record<string, string> } = {},
  ): Promise<Answered> {
    const route = routes.find((x) => x.method === method && x.path === path);
    if (route === undefined) throw new Error(`no route ${method} ${path}`);
    const { res, answer } = fakeResponse();
    await route.handler(request(method, path, { ...r, as: r.as === undefined ? ADA : r.as }), res);
    answers.push(answer);
    return answer;
  }

  return {
    bus,
    users,
    userLookups,
    vault,
    vaultCalls,
    vaultAs,
    vaultFailures,
    memory,
    slack,
    trail,
    lines,
    routes,
    answers,
    call,
    advance(ms: number): void {
      nowMs += ms;
    },
    status: (as: TestUser | null = ADA) => call('GET', '/admin/slack', { as }),
    connect: (body: unknown = CONNECT_BODY, as: TestUser | null = ADA) =>
      call('POST', '/admin/slack/connect', { as, body }),
    installUrl: (as: TestUser | null = ADA) => call('POST', '/admin/slack/install-url', { as }),
    rename: (body: unknown = { botName: 'Ada Helper' }, as: TestUser | null = ADA) =>
      call('POST', '/admin/slack/rename', { as, body }),
    replace: (body: unknown = { refreshToken: SECOND_REFRESH }, as: TestUser | null = ADA) =>
      call('POST', '/admin/slack/replace-token', { as, body }),
    callback: (query: Record<string, string>, as: TestUser | null = ADA) =>
      call('GET', CALLBACK, { as, query }),
    disconnect: (as: TestUser | null = ADA) => call('POST', '/admin/slack/disconnect', { as }),
    forget: (body: unknown = { appId: LEFT_1.appId }, as: TestUser | null = ADA) =>
      call('POST', FORGET, { as, body }),
  };
}

type World = ReturnType<typeof world>;

function installUrlOf(a: Answered): URL {
  return new URL((a.body as { installUrl: string }).installUrl);
}
function stateOf(a: Answered): string {
  const state = installUrlOf(a).searchParams.get('state');
  if (state === null) throw new Error('no state in the install URL');
  return state;
}
function onlyRow(w: World): Row {
  expect(w.memory.rows.size).toBe(1);
  return [...w.memory.rows.values()][0]!;
}
/** The id Connect minted: the last segment of the events URL in the manifest it sent Slack. */
function mintedInstallId(w: World): string {
  const create = w.slack.calls.find((c) => c.method === 'createApp');
  if (create === undefined) throw new Error('createApp was never called');
  const manifest = create.args[1] as { settings: { event_subscriptions: { request_url: string } } };
  return manifest.settings.event_subscriptions.request_url.split('/').pop()!;
}
function slackMethods(w: World): string[] {
  return w.slack.calls.map((c) => c.method);
}
/**
 * An app an earlier Disconnect couldn't delete, remembered as the store would
 * have. `connectedByUserId` is whose token made it (TASK-1175); null, the
 * default, is an app left before anyone was recorded.
 */
function leaveApp(
  w: World,
  l: { installId: string; appId: string },
  botName = 'Canopy Bot',
  leftAtMs = NOW_MS - 60_000,
  connectedByUserId: string | null = null,
): void {
  w.memory.leftovers.set(l.installId, {
    installId: l.installId,
    appId: l.appId,
    botName,
    leftAt: new Date(leftAtMs),
    connectedByUserId,
  });
}
/** Every rotate throws `err`. A test that needs the strict default back saves `w.slack.on.rotateConfigToken` first. */
function failRotate(w: World, err: unknown): void {
  w.slack.on.rotateConfigToken = async () => {
    throw err;
  };
}
/** A rotate of `refreshToken` alone throws `err`; every other rotate goes on as it did. */
function failRotateOf(w: World, refreshToken: string, err: unknown): void {
  const rotateAsBefore = w.slack.on.rotateConfigToken;
  w.slack.on.rotateConfigToken = async (sent) => {
    if (sent === refreshToken) throw err;
    return rotateAsBefore(sent);
  };
}
/** A database fault, as pg throws one: an errno code (logged) and a message (never logged). */
const connectionReset = (): Error => Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
async function connectedWorld(o: Parameters<typeof world>[0] = {}) {
  const w = world(o);
  const state = stateOf(await w.connect());
  expect((await w.callback({ code: CODE, state })).location).toBe(back('connected'));
  const installId = mintedInstallId(w);
  // A clean Connect and Allow log exactly this line (TASK-1139). Cleared, so each test sees only its own.
  expect(w.lines).toEqual([{ level: 'info', msg: 'slack_connected', fields: { installId } }]);
  w.lines.length = 0;
  return { w, state, installId };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

// ── The routes ──────────────────────────────────────────────────────────────

describe('the route table', () => {
  it("is exactly the eight admin routes; none bypasses CSRF; the POSTs cap their bodies, Connect's with room for the bot's picture", () => {
    const { routes } = world();
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'GET /admin/slack',
      'GET /admin/slack/oauth/callback',
      'POST /admin/slack/connect',
      'POST /admin/slack/disconnect',
      'POST /admin/slack/forget-leftover-app',
      'POST /admin/slack/install-url',
      'POST /admin/slack/rename',
      'POST /admin/slack/replace-token',
    ]);
    for (const r of routes) {
      expect(r.bypassCsrf, r.path).not.toBe(true);
      if (r.method === 'POST') {
        expect(r.maxBodyBytes, r.path).toBe(
          r.path === '/admin/slack/connect' ? ADMIN_CONNECT_BODY_MAX_BYTES : ADMIN_BODY_MAX_BYTES,
        );
      }
    }
    // The callback serves the redirect_uri the manifest registers with Slack.
    expect(slackUrls(ORIGIN, 'AAAAAAAAAAAAAAAAAAAAAA').redirectUrl).toBe(REDIRECT_URI);
  });

  it('every JSON route: non-admin → 403, unauthenticated → 401, before touching anything', async () => {
    const w = world();
    for (const route of w.routes.filter((r) => r.path !== CALLBACK)) {
      const r = { body: CONNECT_BODY, query: { code: CODE, state: 'f'.repeat(64) } };
      const anon = await w.call(route.method, route.path, { ...r, as: null });
      expect(anon, `${route.method} ${route.path}`).toMatchObject({
        status: 401,
        body: { error: 'unauthenticated' },
      });
      const member = await w.call(route.method, route.path, { ...r, as: BOB });
      expect(member, `${route.method} ${route.path}`).toMatchObject({
        status: 403,
        body: { error: 'forbidden' },
      });
    }
    expect(w.trail).toEqual([]);
    expect(w.lines).toEqual([]);
  });

  it('an auth:require-user fault → 500, logged with a code only', async () => {
    const w = world({
      authFault: new PluginError({ code: 'session-store-down', plugin: '@ax/auth-better', message: `db at 10.0.0.7 ${ACCESS}` }),
    });
    expect(await w.status()).toMatchObject({ status: 500, body: { error: 'internal' } });
    expect(w.lines).toEqual([
      { level: 'error', msg: 'slack_admin_failed', fields: { stage: 'auth', code: 'session-store-down' } },
    ]);
  });

  it('the OAuth callback sends a browser the gate refuses home with failed, and spends nothing', async () => {
    const w = world();
    const state = stateOf(await w.connect());
    const before = w.trail.length;
    for (const as of [null, BOB]) {
      expect(await w.callback({ code: CODE, state }, as), String(as?.id)).toStrictEqual(FAILED);
    }
    expect(w.trail.slice(before)).toEqual([]);
    // Logged like the callback's other refusals: the reason only, at info.
    expect(w.lines).toEqual([
      { level: 'info', msg: 'slack_install_refused', fields: { reason: 'unauthenticated' } },
      { level: 'info', msg: 'slack_install_refused', fields: { reason: 'forbidden' } },
    ]);
    // The state was never looked at, so the admin it was minted for can still use it.
    expect((await w.callback({ code: CODE, state })).location).toBe(back('connected'));

    const faulty = world({
      authFault: new PluginError({ code: 'session-store-down', plugin: '@ax/auth-better', message: 'down' }),
    });
    expect(await faulty.callback({ code: CODE, state: 'f'.repeat(64) })).toStrictEqual(FAILED);
    expect(faulty.trail).toEqual([]);
    expect(faulty.lines).toEqual([
      { level: 'error', msg: 'slack_admin_failed', fields: { stage: 'auth', code: 'session-store-down' } },
    ]);
  });
});

describe('GET /admin/slack', () => {
  it("not-connected with the branding default name; 'ax' when branding:get is absent or throws; canConnect false for an http origin", async () => {
    expect((await world({ branding: { name: 'Canopy Works' } }).status()).body).toEqual({
      state: 'not-connected',
      defaultBotName: 'canopy-works',
      canConnect: true,
      leftoverApps: [],
    });
    expect((await world({ branding: { name: null } }).status()).body).toEqual({
      state: 'not-connected',
      defaultBotName: 'ax',
      canConnect: true,
      leftoverApps: [],
    });
    expect((await world({ branding: 'absent' }).status()).body).toEqual({
      state: 'not-connected',
      defaultBotName: 'ax',
      canConnect: true,
      leftoverApps: [],
    });

    const throwing = world({ branding: new Error(`branding store down ${REFRESH}`) });
    const res = await throwing.status();
    expect(res).toMatchObject({ status: 200, body: { state: 'not-connected', defaultBotName: 'ax' } });
    expect(throwing.lines).toEqual([
      { level: 'warn', msg: 'slack_admin_failed', fields: { stage: 'branding', code: 'unknown' } },
    ]);

    expect((await world({ publicOrigin: HTTP_ORIGIN }).status()).body).toEqual({
      state: 'not-connected',
      defaultBotName: 'canopy-works',
      canConnect: false,
      leftoverApps: [],
    });
  });

  it("every state lists the apps Disconnect couldn't delete, oldest first, by name and app id only", async () => {
    const w = world();
    leaveApp(w, LEFT_2, 'Second Bot', NOW_MS - 60_000);
    leaveApp(w, LEFT_1, 'First Bot', NOW_MS - 120_000);
    // Exact: no install id and no date reach the admin's browser.
    expect((await w.status()).body).toEqual({
      state: 'not-connected',
      defaultBotName: 'canopy-works',
      canConnect: true,
      leftoverApps: [
        { botName: 'First Bot', appId: LEFT_1.appId },
        { botName: 'Second Bot', appId: LEFT_2.appId },
      ],
    });

    // Pending lists them too, while an app is still left over: a failed delete would otherwise vanish
    // from the tab the moment Connect went ahead. Exact, like the case above.
    w.slack.on.deleteApp = async () => {
      throw new SlackApiError('apps.manifest.delete', 'no_permission');
    };
    const connected = await w.connect();
    expect(connected.status).toBe(200);
    expect(w.memory.leftovers.size).toBe(2);
    expect((await w.status()).body).toEqual({
      state: 'pending',
      botName: 'Canopy Bot',
      connectedBy: 'Ada Admin',
      connectedAt: new Date(NOW_MS).toISOString(),
      leftoverApps: [
        { botName: 'First Bot', appId: LEFT_1.appId },
        { botName: 'Second Bot', appId: LEFT_2.appId },
      ],
    });

    // Connected lists them too. Allow lands the admin here straight after a
    // Connect whose delete failed, so a list missing here would read as "deleted".
    w.advance(90_000);
    expect((await w.callback({ code: CODE, state: stateOf(connected) })).location).toBe(back('connected'));
    expect((await w.status()).body).toEqual({
      state: 'connected',
      botName: 'Canopy Bot',
      workspaceName: 'Canopy Works',
      connectedBy: 'Ada Admin',
      connectedAt: new Date(NOW_MS).toISOString(),
      leftoverApps: [
        { botName: 'First Bot', appId: LEFT_1.appId },
        { botName: 'Second Bot', appId: LEFT_2.appId },
      ],
    });
  });

  it('pending and connected carry botName, connectedBy and connectedAt (and workspaceName when connected)', async () => {
    const w = world();
    const state = stateOf(await w.connect());
    // Any admin sees it, not only the one who connected.
    expect((await w.status(GRACE)).body).toEqual({
      state: 'pending',
      botName: 'Canopy Bot',
      connectedBy: 'Ada Admin',
      connectedAt: new Date(NOW_MS).toISOString(),
      leftoverApps: [],
    });

    w.advance(90_000);
    expect((await w.callback({ code: CODE, state })).location).toBe(back('connected'));
    // connectedAt stays the day the configuration token was added.
    expect((await w.status()).body).toEqual({
      state: 'connected',
      botName: 'Canopy Bot',
      workspaceName: 'Canopy Works',
      connectedBy: 'Ada Admin',
      connectedAt: new Date(NOW_MS).toISOString(),
      leftoverApps: [],
    });
  });

  it("connectedAt is when the configuration token was added, which a replace moves; the row's createdAt does not", async () => {
    const { w } = await connectedWorld();
    const replacedAt = new Date(NOW_MS + 86_400_000);
    onlyRow(w).configTokenAddedAt = replacedAt;

    expect((await w.status()).body).toMatchObject({ state: 'connected', connectedAt: replacedAt.toISOString() });
    expect(onlyRow(w).createdAt).toEqual(new Date(NOW_MS));
  });

  it('connectedBy falls back to the email, then "Administrator", when the admin has no display name', async () => {
    const emailOnly = world();
    await emailOnly.connect(CONNECT_BODY, EMAIL_ONLY);
    expect((await emailOnly.status()).body).toMatchObject({ connectedBy: 'eve@example.com' });

    const nameless = world();
    await nameless.connect(CONNECT_BODY, NAMELESS);
    expect((await nameless.status()).body).toMatchObject({ connectedBy: 'Administrator' });
  });

  it('connectedBy is who auth says the admin is NOW: a rename shows up, a deleted account reads "Administrator"', async () => {
    const w = world();
    await w.connect();
    expect((await w.status(GRACE)).body).toMatchObject({ connectedBy: 'Ada Admin' });
    // Asked of auth by id, as the status is read.
    expect(w.userLookups).toEqual([ADA.id]);

    w.users.get(ADA.id)!.displayName = 'Ada Lovelace';
    expect((await w.status(GRACE)).body).toMatchObject({ connectedBy: 'Ada Lovelace' });

    w.users.delete(ADA.id);
    expect((await w.status(GRACE)).body).toMatchObject({ state: 'pending', connectedBy: 'Administrator' });
    expect(w.lines).toEqual([]);
  });

  it('an auth:get-user fault still answers, with "Administrator", logged code-only', async () => {
    const w = world({
      getUserFault: new PluginError({ code: 'db-down', plugin: '@ax/auth-better', message: 'ada@example.com' }),
    });
    await w.connect();
    const installId = onlyRow(w).installId;
    expect(await w.status()).toMatchObject({ status: 200, body: { state: 'pending', connectedBy: 'Administrator' } });
    expect(w.lines).toEqual([
      { level: 'warn', msg: 'slack_admin_failed', fields: { installId, stage: 'connected-by', code: 'db-down' } },
    ]);
  });

  it("the name auth gives is made fit to show on one line: no bidi, control or invisible characters, at most 120", async () => {
    const w = world();
    await w.connect();
    w.users.get(ADA.id)!.displayName = `  Ada\u202E\u0000 Admin\uD800 ${'x'.repeat(300)}`;
    const shown = ((await w.status()).body as { connectedBy: string }).connectedBy;
    expect(shown.startsWith('Ada Admin� x')).toBe(true);
    expect(shown.length).toBeLessThanOrEqual(120);
    expect(shown).not.toMatch(/[\u0000\u202E\uD800]/);

    // Nothing left once it's cleaned: the email stands in.
    w.users.get(ADA.id)!.displayName = '\u202E\u200B';
    expect((await w.status()).body).toMatchObject({ connectedBy: 'ada@example.com' });
  });

  it('a store fault → 500, logged with a code only', async () => {
    const w = world();
    w.memory.failures.set('current', Object.assign(new Error(`relation gone ${CLIENT_SECRET}`), { code: '42P01' }));
    expect(await w.status()).toMatchObject({ status: 500, body: { error: 'internal' } });
    expect(w.lines).toEqual([
      { level: 'error', msg: 'slack_admin_failed', fields: { stage: 'status', code: '42P01' } },
    ]);
  });
});

describe('POST /admin/slack/connect', () => {
  it('creates the app with the pasted access token and a manifest whose request_url holds the new installId', async () => {
    const w = world();
    expect((await w.connect()).status).toBe(200);
    const create = w.slack.calls.find((c) => c.method === 'createApp')!;
    expect(create.args[0]).toBe(ACCESS);
    const installId = onlyRow(w).installId;
    expect(installId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(create.args[1]).toStrictEqual(buildAppManifest('Canopy Bot', slackUrls(ORIGIN, installId)));
    expect(mintedInstallId(w)).toBe(installId);
    expect(`${ORIGIN}/slack/events/${installId}`).toBe(slackUrls(ORIGIN, installId).eventsUrl);
    // The pasted access token makes exactly two calls: create the app, set its icon.
    expect(w.slack.calls.filter((c) => c.args.includes(ACCESS)).map((c) => c.method)).toEqual([
      'createApp',
      'setAppIcon',
    ]);
    // The picture the browser sent, byte for byte, for the app just made.
    const icon = w.slack.calls.find((c) => c.method === 'setAppIcon')!;
    expect(icon.args).toHaveLength(3);
    expect(icon.args.slice(0, 2)).toEqual([ACCESS, APP.appId]);
    expect(Buffer.from(icon.args[2] as Uint8Array).equals(ICON)).toBe(true);
  });

  it('stores the refresh token Slack minted from the pasted one first, then client-secret and signing-secret, then a pending row', async () => {
    const w = world();
    await w.connect();
    const installId = onlyRow(w).installId;
    expect(w.vault).toEqual(
      new Map([
        [secretRef(installId, 'client-secret'), CLIENT_SECRET],
        [secretRef(installId, 'signing-secret'), SIGNING_SECRET],
        // The connecting admin's own configuration token (TASK-1175).
        [configTokenRef(ADA.id), mintedRefresh(1)],
      ]),
    );
    // The pasted refresh token is tried once, right after Slack makes the app and before anything is stored.
    expect(w.trail.slice(0, 5)).toEqual([
      'store:current',
      'store:leftoverApps',
      'slack:createApp',
      'slack:rotateConfigToken',
      'vault:set config-refresh-token',
    ]);
    expect(w.slack.calls.filter((c) => c.args.includes(REFRESH)).map((c) => c.method)).toEqual(['rotateConfigToken']);
    // The access token that rotate minted is never used.
    expect(w.slack.calls.filter((c) => c.args.includes(MINTED_ACCESS))).toEqual([]);
    expect(w.trail.filter((t) => t.startsWith('vault:') || t === 'store:insertPending')).toEqual([
      'vault:set config-refresh-token',
      'vault:set client-secret',
      'vault:set signing-secret',
      'store:insertPending',
    ]);
    expect(onlyRow(w)).toMatchObject({
      installId,
      status: 'pending',
      appId: APP.appId,
      clientId: APP.clientId,
      botName: 'Canopy Bot',
      connectedByUserId: ADA.id,
      teamId: null,
      botUserId: null,
    });
    // Who connected it is an id; the name is auth's, read when it is shown.
    expect(onlyRow(w)).not.toHaveProperty('connectedByName');
  });

  it('returns an installUrl with client_id, scope, redirect_uri and state; the row holds sha256(state), never the raw state', async () => {
    const w = world();
    const res = await w.connect();
    expect(res).toMatchObject({ status: 200, body: { installUrl: expect.any(String), iconSet: true } });
    expect(Object.keys(res.body as object).sort()).toEqual(['iconSet', 'installUrl']);
    const url = installUrlOf(res);
    expect(`${url.origin}${url.pathname}`).toBe('https://slack.com/oauth/v2/authorize');
    const state = stateOf(res);
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: APP.clientId,
      scope: BOT_SCOPES.join(','),
      redirect_uri: REDIRECT_URI,
      state,
    });
    const row = onlyRow(w);
    expect(row.stateHash).toBe(sha256(state));
    expect(row.stateUserId).toBe(ADA.id);
    expect(row.stateExpiresAt).toEqual(new Date(NOW_MS + OAUTH_STATE_TTL_MS));
    expect(JSON.stringify(w.memory.calls)).not.toContain(state);
  });

  it('without a botName, uses the default made from the branding name', async () => {
    const w = world({ branding: { name: 'Canopy Works' } });
    expect((await w.connect({ accessToken: ACCESS, refreshToken: REFRESH })).status).toBe(200);
    expect(onlyRow(w).botName).toBe('canopy-works');
    const nulled = world({ branding: 'absent' });
    expect((await nulled.connect({ accessToken: ACCESS, refreshToken: REFRESH, botName: null })).status).toBe(200);
    expect(onlyRow(nulled).botName).toBe('ax');
  });

  it('refuses swapped tokens (400 invalid-access-token / invalid-refresh-token) before calling Slack', async () => {
    const w = world();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ accessToken: REFRESH, refreshToken: ACCESS }, 'invalid-access-token'],
      [{ accessToken: ACCESS, refreshToken: ACCESS }, 'invalid-refresh-token'],
      [{ refreshToken: REFRESH }, 'invalid-access-token'],
      [{ accessToken: ACCESS }, 'invalid-refresh-token'],
      [{ accessToken: 42, refreshToken: REFRESH }, 'invalid-access-token'],
      [{ accessToken: CONFIG_ACCESS_PREFIX, refreshToken: REFRESH }, 'invalid-access-token'],
      [{ accessToken: ` ${ACCESS}`, refreshToken: REFRESH }, 'invalid-access-token'],
      [{ accessToken: `${CONFIG_ACCESS_PREFIX}${'a'.repeat(SLACK_TOKEN_MAX)}`, refreshToken: REFRESH }, 'invalid-access-token'],
      [{ accessToken: ACCESS, refreshToken: `${CONFIG_REFRESH_PREFIX}1-a/b` }, 'invalid-refresh-token'],
      [{ accessToken: ACCESS, refreshToken: `${BOT_PREFIX}1-a` }, 'invalid-refresh-token'],
    ];
    for (const [body, error] of cases) {
      const res = await w.connect({ ...body, botName: 'Canopy Bot' });
      expect(res, JSON.stringify(body)).toMatchObject({ status: 400, body: { error } });
      expect(Object.keys(res.body as object)).toEqual(['error']);
    }
    // A full-length token is fine.
    const longest = `${CONFIG_ACCESS_PREFIX}${'a'.repeat(SLACK_TOKEN_MAX - CONFIG_ACCESS_PREFIX.length)}`;
    expect((await world().connect({ ...CONNECT_BODY, accessToken: longest })).status).toBe(200);
    expect(w.trail).toEqual([]);
  });

  it("refuses a bad name with { error: 'invalid-bot-name', reason }, before calling Slack", async () => {
    const w = world();
    const cases: Array<[unknown, string]> = [
      ['slack-bot', 'reserved'],
      ['Here', 'reserved'],
      ['', 'empty'],
      ['x'.repeat(36), 'too-long'],
      ['Café', 'bad-characters'],
      [7, 'bad-characters'],
    ];
    for (const [botName, reason] of cases) {
      const res = await w.connect({ accessToken: ACCESS, refreshToken: REFRESH, botName });
      expect(res, String(botName)).toMatchObject({ status: 400, body: { error: 'invalid-bot-name', reason } });
    }
    expect(w.trail).toEqual([]);
  });

  it('a body that is not a JSON object → 400 invalid-body; one over the cap → 413', async () => {
    const w = world();
    for (const body of ['', 'not json', '[1,2]', '"text"', Buffer.from([0xff, 0xfe, 0x7b, 0x7d])]) {
      expect(await w.connect(body), String(body)).toMatchObject({ status: 400, body: { error: 'invalid-body' } });
    }
    const huge = JSON.stringify({ ...CONNECT_BODY, pad: 'x'.repeat(ADMIN_CONNECT_BODY_MAX_BYTES) });
    expect(await w.connect(huge)).toMatchObject({ status: 413, body: { error: 'body-too-large' } });
    expect(w.trail).toEqual([]);
  });

  it('a picture of exactly SLACK_ICON_MAX_BYTES gets through the body check and reaches Slack whole', async () => {
    const w = world();
    const body = { ...CONNECT_BODY, iconPng: pngBase64(512, 512, SLACK_ICON_MAX_BYTES) };
    // Far past the 16 KiB every other admin route takes.
    expect(JSON.stringify(body).length).toBeGreaterThan(1_000_000);
    expect(await w.connect(body)).toMatchObject({ status: 200, body: { iconSet: true } });
    const icon = w.slack.calls.find((c) => c.method === 'setAppIcon')!;
    expect(icon.args[2] as Uint8Array).toHaveLength(1_048_576);
    expect(w.lines).toEqual([]);
  });

  it('→ 409 already-connected / public-origin-not-https', async () => {
    const w = world();
    expect((await w.connect()).status).toBe(200);
    expect(await w.connect(CONNECT_BODY, GRACE)).toMatchObject({ status: 409, body: { error: 'already-connected' } });
    expect(slackMethods(w).filter((m) => m === 'createApp')).toHaveLength(1);

    const http = world({ publicOrigin: HTTP_ORIGIN });
    expect(await http.connect()).toMatchObject({ status: 409, body: { error: 'public-origin-not-https' } });
    expect(http.slack.calls).toEqual([]);
    expect(http.vaultCalls).toEqual([]);
  });

  it('createApp: a bad token → 502 slack-token, a refused name → slack-name, no answer we could read → slack-unconfirmed, anything else → slack-error; nothing stored', async () => {
    const create = (code: string): SlackApiError => new SlackApiError('apps.manifest.create', code);
    const cases: Array<[unknown, string]> = [
      ...['invalid_auth', 'not_authed', 'token_expired', 'token_revoked', 'account_inactive'].map(
        (code): [unknown, string] => [create(code), 'slack-token'],
      ),
      [create('invalid_manifest'), 'slack-name'],
      // The request may have reached Slack and made the app: we never got,
      // or couldn't read, Slack's answer.
      ...['timeout', 'network', 'bad-response', 'too-large', 'http-500', 'http-502', 'http-503', 'http-504'].map(
        (code): [unknown, string] => [create(code), 'slack-unconfirmed'],
      ),
      // Slack answered, and the answer was no.
      [new SlackApiError('apps.manifest.create', 'ratelimited', 60_000), 'slack-error'],
      [create('redirect'), 'slack-error'],
      [create('http-400'), 'slack-error'],
      [create('http-404'), 'slack-error'],
      [create('slack-error'), 'slack-error'],
      [create('team_not_found'), 'slack-error'],
      [new TypeError('not a Slack answer'), 'slack-error'],
    ];
    for (const [err, error] of cases) {
      const w = world();
      w.slack.on.createApp = async () => {
        throw err;
      };
      const res = await w.connect();
      expect(res, String(err)).toMatchObject({ status: 502, body: { error } });
      // No rotate: a failed create never spends the pasted pair (TASK-1159).
      expect(slackMethods(w)).toEqual(['createApp']);
      expect(w.vaultCalls).toEqual([]);
      expect(w.memory.rows.size).toBe(0);
      expect(w.lines).toHaveLength(1);
      expect(w.lines[0]).toMatchObject({ msg: 'slack_admin_failed', fields: { stage: 'create-app' } });
    }
  });

  it('a store or vault failure after createApp deletes the app, the row and the secrets, then 500', async () => {
    const breakers: Array<[string, (w: World) => void]> = [
      ['vault set signing-secret', (w) => w.vaultFailures.set('credentials:set signing-secret', new Error('vault down'))],
      ['vault set refresh token', (w) => w.vaultFailures.set('credentials:set config-refresh-token', new Error('vault down'))],
      ['insertPending', (w) => w.memory.failures.set('insertPending', new Error(`insert failed near ${CLIENT_SECRET}`))],
      ['setOAuthState', (w) => w.memory.failures.set('setOAuthState', new Error('connection reset'))],
    ];
    for (const [label, breakIt] of breakers) {
      const w = world();
      breakIt(w);
      const res = await w.connect();
      expect(res, label).toMatchObject({ status: 500, body: { error: 'internal' } });
      const installId = mintedInstallId(w);
      // Deleting needs a configuration access token: the pasted one is still in hand.
      expect(w.slack.calls.filter((c) => c.method === 'deleteApp').map((c) => c.args), label).toEqual([
        [ACCESS, APP.appId],
      ]);
      expect(w.memory.rows.size, label).toBe(0);
      expect(w.vault.size, label).toBe(0);
      // Then Ada's own token, once nothing names her (TASK-1175).
      expect(
        w.vaultCalls.filter((c) => c.hook === 'credentials:delete').map((c) => c.ref),
        label,
      ).toEqual([...SECRET_NAMES.map((name) => secretRef(installId, name)), configTokenRef(ADA.id)]);
      expect(w.lines[0], label).toMatchObject({
        level: 'error',
        msg: 'slack_admin_failed',
        fields: { installId, stage: 'connect' },
      });
      expect((await w.status()).body, label).toMatchObject({ state: 'not-connected' });
    }
  });

  it('undo keeps going when deleting the app fails, says so code-only, and lists the app as left over, so its maker keeps the token that can delete it (TASK-1175)', async () => {
    const w = world();
    w.memory.failures.set('insertPending', new Error('insert failed'));
    w.slack.on.deleteApp = async () => {
      throw new SlackApiError('apps.manifest.delete', 'ratelimited', 60_000);
    };
    expect((await w.connect()).status).toBe(500);
    const installId = mintedInstallId(w);
    expect(w.lines).toContainEqual({
      level: 'warn',
      msg: 'slack_admin_failed',
      fields: { installId, stage: 'undo-delete-app', code: 'ratelimited' },
    });
    // The app is still live on Slack: the tab names it, and the next Connect or Replace deletes it.
    expect([...w.memory.leftovers.values()]).toEqual([
      { installId, appId: APP.appId, botName: 'Canopy Bot', leftAt: expect.any(Date), connectedByUserId: ADA.id },
    ]);
    expect(w.memory.rows.size).toBe(0);
    // The install's own secrets go; Ada's token stays, because the leftover still names her.
    expect(w.vault).toEqual(new Map([[configTokenRef(ADA.id), mintedRefresh(1)]]));
  });

  it("undo after the pending row was stored moves the app Slack won't delete to the leftover list with the row, as Disconnect does (TASK-1175)", async () => {
    const w = world();
    w.memory.failures.set('setOAuthState', new Error('connection reset'));
    // Only the row's own delete can remember it: a separate remember would fail here.
    w.memory.failures.set('rememberLeftoverApp', new Error('connection reset'));
    w.slack.on.deleteApp = async () => {
      throw new SlackApiError('apps.manifest.delete', 'ratelimited', 60_000);
    };
    expect((await w.connect()).status).toBe(500);
    const installId = mintedInstallId(w);
    expect(w.memory.rows.size).toBe(0);
    expect([...w.memory.leftovers.values()]).toEqual([
      { installId, appId: APP.appId, botName: 'Canopy Bot', leftAt: expect.any(Date), connectedByUserId: ADA.id },
    ]);
    expect(w.vault).toEqual(new Map([[configTokenRef(ADA.id), mintedRefresh(1)]]));
    expect((await w.status()).body).toMatchObject({
      state: 'not-connected',
      leftoverApps: [{ botName: 'Canopy Bot', appId: APP.appId }],
    });
  });

  it("undo whose pending row won't go remembers nothing: the row still names the app, never both tables, and Ada keeps her token", async () => {
    const w = world();
    w.memory.failures.set('setOAuthState', new Error('connection reset'));
    w.memory.failures.set('remove', new Error('connection reset'));
    w.slack.on.deleteApp = async () => {
      throw new SlackApiError('apps.manifest.delete', 'ratelimited', 60_000);
    };
    expect((await w.connect()).status).toBe(500);
    const installId = mintedInstallId(w);
    expect(w.memory.leftovers.size).toBe(0);
    expect(onlyRow(w)).toMatchObject({ installId, appId: APP.appId, connectedByUserId: ADA.id });
    expect(w.vault.get(configTokenRef(ADA.id))).toBe(mintedRefresh(1));
    expect(w.lines).toContainEqual({
      level: 'error',
      msg: 'slack_admin_failed',
      fields: { installId, stage: 'undo-remove', code: expect.any(String) },
    });
  });

  it('undo after an insert that committed but answered with an error still removes the row, whatever Slack said to the delete', async () => {
    const outcomes: Array<[string, (() => Promise<void>) | null, boolean]> = [
      ['Slack deleted the app', null, false],
      [
        'Slack says the app is already gone',
        async () => {
          throw new SlackApiError('apps.manifest.delete', 'app_not_found');
        },
        false,
      ],
      [
        "Slack won't delete it",
        async () => {
          throw new SlackApiError('apps.manifest.delete', 'ratelimited', 60_000);
        },
        true,
      ],
    ];
    for (const [label, deleteApp, appLeft] of outcomes) {
      const w = world();
      const insert = w.memory.store.insertPending.bind(w.memory.store);
      w.memory.store.insertPending = async (r) => {
        await insert(r);
        throw Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });
      };
      if (deleteApp !== null) w.slack.on.deleteApp = deleteApp;
      expect((await w.connect()).status, label).toBe(500);
      const installId = mintedInstallId(w);
      expect(w.memory.rows.size, label).toBe(0);
      expect((await w.status()).body, label).toMatchObject({ state: 'not-connected' });
      if (appLeft) {
        expect([...w.memory.leftovers.values()], label).toEqual([
          { installId, appId: APP.appId, botName: 'Canopy Bot', leftAt: expect.any(Date), connectedByUserId: ADA.id },
        ]);
        // The app still on Slack names Ada, so her token stays.
        expect(w.vault, label).toEqual(new Map([[configTokenRef(ADA.id), mintedRefresh(1)]]));
      } else {
        // Nothing names Ada any more: no row, no leftover, so her token goes too.
        expect(w.memory.leftovers.size, label).toBe(0);
        expect(w.vault.size, label).toBe(0);
      }
    }
  });

  it("undo doesn't list an app Slack says is already gone", async () => {
    const w = world();
    w.memory.failures.set('insertPending', new Error('insert failed'));
    w.slack.on.deleteApp = async () => {
      throw new SlackApiError('apps.manifest.delete', 'app_not_found');
    };
    expect((await w.connect()).status).toBe(500);
    expect(w.memory.leftovers.size).toBe(0);
    expect(w.vault.size).toBe(0);
    expect(w.lines.filter((l) => (l.fields as { stage?: string } | undefined)?.stage === 'undo-delete-app')).toEqual([]);
  });

  it('the picture is best-effort: Slack refusing it, none sent, or an unusable one never fails Connect', async () => {
    /** Connect went ahead without the picture: 200, `iconSet: false`, the install pending. */
    const connectedWithout = async (w: World, body: unknown, label: string): Promise<void> => {
      const res = await w.connect(body);
      expect(res, label).toMatchObject({ status: 200, body: { installUrl: expect.any(String), iconSet: false } });
      expect(onlyRow(w).status, label).toBe('pending');
    };

    // (i) Slack refuses it: one code-only warning.
    const refused = world();
    refused.slack.on.setAppIcon = async () => {
      throw new SlackApiError('apps.icon.set', 'error_bad_format');
    };
    await connectedWithout(refused, CONNECT_BODY, 'Slack refused it');
    expect(refused.lines).toEqual([
      {
        level: 'warn',
        msg: 'slack_admin_failed',
        fields: { installId: mintedInstallId(refused), stage: 'icon', code: 'error_bad_format' },
      },
    ]);

    // (ii) None sent (a browser that couldn't draw one): Slack isn't asked, and that's not a failure.
    const none = world();
    await connectedWithout(none, { accessToken: ACCESS, refreshToken: REFRESH, botName: 'Canopy Bot' }, 'none sent');
    expect(slackMethods(none)).toEqual(['createApp', 'rotateConfigToken']);
    expect(none.lines).toEqual([]);

    // (iii) One icon.ts refuses: never sent to Slack, one warning naming why.
    const unusable: Array<[unknown, string]> = [
      [pngBase64(511, 511), 'icon-bad-size'],
      [42, 'icon-not-base64'],
    ];
    for (const [iconPng, code] of unusable) {
      const w = world();
      await connectedWithout(w, { ...CONNECT_BODY, iconPng }, code);
      expect(slackMethods(w), code).toEqual(['createApp', 'rotateConfigToken']);
      expect(w.lines, code).toEqual([
        { level: 'warn', msg: 'slack_admin_failed', fields: { installId: mintedInstallId(w), stage: 'icon', code } },
      ]);
    }
  });

  it('two concurrent connects → one 200, one 409', async () => {
    const w = world();
    leaveApp(w, LEFT_1);
    const gate = deferred();
    w.slack.on.createApp = async () => {
      await gate.promise;
      return { ...APP };
    };
    const first = w.connect(CONNECT_BODY, ADA);
    const second = w.connect(CONNECT_BODY, GRACE);
    await settle();
    gate.resolve();
    const answers = await Promise.all([first, second]);
    expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
    expect(slackMethods(w).filter((m) => m === 'createApp')).toHaveLength(1);
    expect(w.memory.rows.size).toBe(1);
    // The leftover is deleted once, by the Connect that went ahead (TASK-1132).
    expect(w.slack.calls.filter((c) => c.method === 'deleteApp').map((c) => c.args)).toEqual([
      [ACCESS, LEFT_1.appId],
    ]);
    expect(w.memory.leftovers.size).toBe(0);
  });
});

describe('Connect tries the pasted refresh token once (TASK-1159)', () => {
  it('a pasted refresh token Slack refuses: the new app is deleted again with the pasted access token, nothing is stored, and the admin is asked for a new pair', async () => {
    const w = world();
    failRotate(w, new SlackApiError('tooling.tokens.rotate', 'invalid_refresh_token'));
    const res = await w.connect();
    expect(res.status).toBe(502);
    expect(res.body).toStrictEqual({ error: 'slack-refresh-token' });
    // Tried right after Slack made the app, before anything was stored, so the undo is one Slack call.
    expect(w.trail).toEqual([
      'store:current',
      'store:leftoverApps',
      'slack:createApp',
      'slack:rotateConfigToken',
      'slack:deleteApp',
    ]);
    expect(w.slack.calls.find((c) => c.method === 'rotateConfigToken')!.args).toEqual([REFRESH]);
    expect(w.slack.calls.filter((c) => c.method === 'deleteApp').map((c) => c.args)).toEqual([[ACCESS, APP.appId]]);
    expect([...w.slack.live]).toEqual([]);
    expect(w.vaultCalls).toEqual([]);
    expect(w.memory.rows.size).toBe(0);
    expect(w.memory.leftovers.size).toBe(0);
    expect(w.lines).toEqual([
      {
        level: 'warn',
        msg: 'slack_admin_failed',
        fields: { installId: mintedInstallId(w), stage: 'try-refresh-token', code: 'invalid_refresh_token' },
      },
    ]);
    expect((await w.status()).body).toEqual({
      state: 'not-connected',
      defaultBotName: 'canopy-works',
      canConnect: true,
      leftoverApps: [],
    });
  });

  it('a refused token → slack-refresh-token; any other rotate failure → slack-error; the new app goes either way and nothing is stored', async () => {
    const rotate = (code: string, retryAfterMs?: number): SlackApiError =>
      new SlackApiError('tooling.tokens.rotate', code, retryAfterMs);
    const cases: Array<[unknown, string]> = [
      // Slack refusing the token itself: only a new pair helps.
      ...['invalid_refresh_token', 'invalid_auth', 'not_authed', 'token_expired', 'token_revoked', 'account_inactive'].map(
        (code): [unknown, string] => [rotate(code), 'slack-refresh-token'],
      ),
      // Anything else: Slack may or may not have spent it, and a retry soon after may work.
      ...['timeout', 'network', 'bad-response', 'too-large', 'http-503', 'redirect', 'slack-error'].map(
        (code): [unknown, string] => [rotate(code), 'slack-error'],
      ),
      [rotate('ratelimited', 60_000), 'slack-error'],
      [new TypeError('not a Slack answer'), 'slack-error'],
    ];
    for (const [err, error] of cases) {
      const w = world();
      failRotate(w, err);
      const res = await w.connect();
      const label = String(err);
      expect(res.status, label).toBe(502);
      expect(res.body, label).toStrictEqual({ error });
      expect(w.slack.calls.filter((c) => c.method === 'deleteApp').map((c) => c.args), label).toEqual([
        [ACCESS, APP.appId],
      ]);
      expect(w.vaultCalls, label).toEqual([]);
      expect(w.memory.rows.size, label).toBe(0);
      expect(w.memory.leftovers.size, label).toBe(0);
      expect(w.lines, label).toEqual([
        {
          level: err instanceof SlackApiError ? 'warn' : 'error',
          msg: 'slack_admin_failed',
          fields: {
            installId: mintedInstallId(w),
            stage: 'try-refresh-token',
            code: err instanceof SlackApiError ? err.code : 'unknown',
          },
        },
      ]);
    }
  });

  it("Slack won't delete the new app either: it is remembered under the install id Connect minted, the status names it, and the next Connect deletes it", async () => {
    const w = world();
    const rotateAsSlack = w.slack.on.rotateConfigToken;
    failRotate(w, new SlackApiError('tooling.tokens.rotate', 'timeout'));
    w.slack.on.deleteApp = async () => {
      throw new SlackApiError('apps.manifest.delete', 'timeout');
    };
    const res = await w.connect();
    expect(res.status).toBe(502);
    expect(res.body).toStrictEqual({ error: 'slack-error' });
    expect(w.trail.slice(-2)).toEqual(['slack:deleteApp', 'store:rememberLeftoverApp']);
    const leftInstallId = mintedInstallId(w);
    // Made with the token of the admin who connected (TASK-1175).
    expect([...w.memory.leftovers.values()]).toEqual([
      {
        installId: leftInstallId,
        appId: APP.appId,
        botName: 'Canopy Bot',
        leftAt: expect.any(Date),
        connectedByUserId: ADA.id,
      },
    ]);
    expect(w.memory.rows.size).toBe(0);
    expect(w.vaultCalls).toEqual([]);
    expect(w.lines).toEqual([
      {
        level: 'warn',
        msg: 'slack_admin_failed',
        fields: { installId: leftInstallId, stage: 'try-refresh-token', code: 'timeout' },
      },
      {
        level: 'warn',
        msg: 'slack_admin_failed',
        fields: { installId: leftInstallId, stage: 'undo-delete-app', code: 'timeout' },
      },
    ]);
    expect((await w.status()).body).toEqual({
      state: 'not-connected',
      defaultBotName: 'canopy-works',
      canConnect: true,
      leftoverApps: [{ botName: 'Canopy Bot', appId: APP.appId }],
    });

    // Slack recovers. The same pair: the timed-out rotate never reached the
    // fake's ledger, and on Slack a spent token still works for a while.
    w.slack.on.rotateConfigToken = rotateAsSlack;
    w.slack.on.deleteApp = async () => {};
    w.slack.on.createApp = async () => ({ ...APP, appId: SECOND_APP_ID });
    const mark = w.trail.length;
    expect((await w.connect()).status).toBe(200);
    expect(w.trail.slice(mark, mark + 6)).toEqual([
      'store:current',
      'store:leftoverApps',
      'slack:deleteApp',
      'store:forgetLeftoverApp',
      'slack:createApp',
      'slack:rotateConfigToken',
    ]);
    expect(w.slack.calls.filter((c) => c.method === 'deleteApp').map((c) => c.args)).toEqual([
      [ACCESS, APP.appId],
      [ACCESS, APP.appId],
    ]);
    expect(w.memory.leftovers.size).toBe(0);
    expect([...w.slack.live]).toEqual([SECOND_APP_ID]);
    expect(w.vault.get(configTokenRef(ADA.id))).toBe(mintedRefresh(1));
  });

  it('remembering it failing too is logged code-only, and the answer is the same', async () => {
    const w = world();
    failRotate(w, new SlackApiError('tooling.tokens.rotate', 'invalid_refresh_token'));
    w.slack.on.deleteApp = async () => {
      throw new SlackApiError('apps.manifest.delete', 'ratelimited', 60_000);
    };
    w.memory.failures.set('rememberLeftoverApp', connectionReset());
    const res = await w.connect();
    expect(res.status).toBe(502);
    expect(res.body).toStrictEqual({ error: 'slack-refresh-token' });
    expect(w.memory.rows.size).toBe(0);
    expect(w.memory.leftovers.size).toBe(0);
    expect(w.vaultCalls).toEqual([]);
    const installId = mintedInstallId(w);
    expect(w.lines).toEqual([
      { level: 'warn', msg: 'slack_admin_failed', fields: { installId, stage: 'try-refresh-token', code: 'invalid_refresh_token' } },
      { level: 'warn', msg: 'slack_admin_failed', fields: { installId, stage: 'undo-delete-app', code: 'ratelimited' } },
      { level: 'error', msg: 'slack_admin_failed', fields: { installId, stage: 'remember-leftover-app', code: 'ECONNRESET' } },
    ]);
  });

  it('an app Slack says is already gone when Connect takes it back is not remembered, and not reported', async () => {
    const w = world();
    failRotate(w, new SlackApiError('tooling.tokens.rotate', 'invalid_refresh_token'));
    w.slack.on.deleteApp = async () => {
      throw new SlackApiError('apps.manifest.delete', 'app_not_found');
    };
    const res = await w.connect();
    expect(res.status).toBe(502);
    expect(res.body).toStrictEqual({ error: 'slack-refresh-token' });
    expect(w.trail.at(-1)).toBe('slack:deleteApp');
    expect(w.memory.leftovers.size).toBe(0);
    expect(w.lines).toEqual([
      {
        level: 'warn',
        msg: 'slack_admin_failed',
        fields: { installId: mintedInstallId(w), stage: 'try-refresh-token', code: 'invalid_refresh_token' },
      },
    ]);
  });

  it('a store fault after the rotate spends the pasted refresh token: a retry while Slack still honours it connects; once Slack has retired it, the admin is asked for a new pair', async () => {
    // While Slack still honours the spent token.
    const honoured = world();
    honoured.memory.failures.set('insertPending', connectionReset());
    expect(await honoured.connect()).toMatchObject({ status: 500, body: { error: 'internal' } });
    expect(honoured.vault.size).toBe(0);
    honoured.memory.failures.delete('insertPending');
    honoured.slack.rotatedStillWork = true;
    expect((await honoured.connect()).status).toBe(200);
    expect(honoured.vault.get(configTokenRef(ADA.id))).toBe(mintedRefresh(2));

    // Once Slack has retired it: the strict fake does at once.
    const retired = world();
    retired.memory.failures.set('insertPending', connectionReset());
    expect(await retired.connect()).toMatchObject({ status: 500, body: { error: 'internal' } });
    retired.memory.failures.delete('insertPending');
    const res = await retired.connect();
    expect(res.status).toBe(502);
    expect(res.body).toStrictEqual({ error: 'slack-refresh-token' });
    expect(retired.memory.rows.size).toBe(0);
    expect(retired.vault.size).toBe(0);
  });
});

describe('POST /admin/slack/install-url', () => {
  it('while pending, replaces the state (the old state no longer matches); otherwise 409 not-pending', async () => {
    const w = world();
    expect(await w.installUrl()).toMatchObject({ status: 409, body: { error: 'not-pending' } });

    const first = stateOf(await w.connect());
    const callsBefore = w.slack.calls.length;
    // Any admin may pick it up; the new state is bound to them.
    const res = await w.installUrl(GRACE);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body as object)).toEqual(['installUrl']);
    const second = stateOf(res);
    expect(second).not.toBe(first);
    expect(Object.fromEntries(installUrlOf(res).searchParams)).toEqual({
      client_id: APP.clientId,
      scope: BOT_SCOPES.join(','),
      redirect_uri: REDIRECT_URI,
      state: second,
    });
    expect(w.slack.calls.length).toBe(callsBefore);

    expect(await w.callback({ code: CODE, state: first })).toStrictEqual(FAILED);
    expect(await w.callback({ code: CODE, state: second }, ADA)).toStrictEqual(FAILED);
    expect((await w.callback({ code: CODE, state: second }, GRACE)).location).toBe(back('connected'));

    expect(await w.installUrl()).toMatchObject({ status: 409, body: { error: 'not-pending' } });
  });
});

describe('GET /admin/slack/oauth/callback', () => {
  it('a missing, malformed or unknown state, or no usable code, sends the browser home with failed', async () => {
    const w = world();
    const state = stateOf(await w.connect());
    const refusals: Array<[Record<string, string>, string]> = [
      [{ code: CODE, state: 'f'.repeat(64) }, 'invalid-state'],
      [{ code: CODE, state: 'not-a-state' }, 'invalid-state'],
      [{ code: CODE, state: state.toUpperCase() }, 'invalid-state'],
      [{ code: CODE }, 'invalid-state'],
      // Neither a code nor an error: not a callback Slack sends.
      [{ state }, 'invalid-request'],
      [{ state, code: 'has space' }, 'invalid-request'],
    ];
    for (const [query] of refusals) {
      expect(await w.callback(query), JSON.stringify(query)).toStrictEqual(FAILED);
    }
    // Code-only, and none of them knew which install: no installId.
    expect(w.lines).toEqual(
      refusals.map(([, reason]) => ({ level: 'info', msg: 'slack_install_refused', fields: { reason } })),
    );
    expect(slackMethods(w)).not.toContain('oauthAccess');
    // None of them spent the real state.
    expect(onlyRow(w).stateHash).toBe(sha256(state));
    expect((await w.callback({ code: CODE, state })).location).toBe(back('connected'));
  });

  it("another admin's state → failed WITHOUT spending it, so it still works for the admin it was minted for", async () => {
    const w = world();
    const state = stateOf(await w.connect());
    expect(await w.callback({ code: CODE, state }, GRACE)).toStrictEqual(FAILED);
    expect(slackMethods(w)).not.toContain('oauthAccess');
    expect(onlyRow(w).stateHash).toBe(sha256(state));
    expect(w.lines).toEqual([
      {
        level: 'warn',
        msg: 'slack_install_refused',
        fields: { installId: mintedInstallId(w), reason: 'state-user-mismatch' },
      },
    ]);

    expect(await w.callback({ code: CODE, state }, ADA)).toMatchObject({
      status: 302,
      how: 'redirect',
      location: back('connected'),
    });
  });

  it('a state another callback spent in between → failed', async () => {
    const w = world();
    const state = stateOf(await w.connect());
    // The peek finds it, then a concurrent callback spends it before this one can.
    const consume = w.memory.store.consumeOAuthState.bind(w.memory.store);
    w.memory.store.consumeOAuthState = async (hash) => {
      await consume(hash);
      return consume(hash);
    };
    expect(await w.callback({ code: CODE, state })).toStrictEqual(FAILED);
    expect(slackMethods(w)).not.toContain('oauthAccess');
    expect(w.lines).toEqual([{ level: 'info', msg: 'slack_install_refused', fields: { reason: 'invalid-state' } }]);
  });

  it('expired → failed; error=access_denied → cancelled; both consume the state', async () => {
    const w = world();
    const state = stateOf(await w.connect());
    w.advance(OAUTH_STATE_TTL_MS);
    expect(await w.callback({ code: CODE, state })).toMatchObject({ status: 302, location: back('failed') });
    expect(onlyRow(w).stateHash).toBeNull();
    expect(await w.callback({ code: CODE, state })).toStrictEqual(FAILED);

    const denied = stateOf(await w.installUrl());
    expect(await w.callback({ error: 'access_denied', state: denied })).toMatchObject({
      status: 302,
      location: back('cancelled'),
    });
    expect(onlyRow(w).stateHash).toBeNull();
    expect(await w.callback({ error: 'access_denied', state: denied })).toStrictEqual(FAILED);

    // Any other error Slack reports is a failure, not a cancel.
    const other = stateOf(await w.installUrl());
    expect((await w.callback({ error: 'invalid_team_for_non_distributed_app', state: other })).location).toBe(
      back('failed'),
    );

    expect(slackMethods(w)).not.toContain('oauthAccess');
    expect(onlyRow(w).status).toBe('pending');
    const refusals = w.lines.filter((l) => l.msg === 'slack_install_refused').map((l) => [l.level, l.fields]);
    const installId = mintedInstallId(w);
    expect(refusals).toEqual([
      ['warn', { installId, reason: 'expired' }],
      // The replay: the state is spent, so nothing knows it any more.
      ['info', { reason: 'invalid-state' }],
      ['info', { installId, reason: 'cancelled' }],
      ['info', { reason: 'invalid-state' }],
      ['warn', { installId, reason: 'slack-error' }],
    ]);
  });

  it('a state is still good one millisecond before it expires', async () => {
    const w = world();
    const state = stateOf(await w.connect());
    w.advance(OAUTH_STATE_TTL_MS - 1);
    expect((await w.callback({ code: CODE, state })).location).toBe(back('connected'));
  });

  it('success: oauthAccess uses the stored client secret and the exact redirect_uri; the bot token is stored; the row is active with the team; redirect connected', async () => {
    const w = world();
    const state = stateOf(await w.connect());
    w.advance(30_000);
    const res = await w.callback({ code: CODE, state });
    expect(res).toMatchObject({ status: 302, how: 'redirect', location: back('connected') });

    const exchange = w.slack.calls.find((c) => c.method === 'oauthAccess')!;
    expect(exchange.args).toEqual([
      { clientId: APP.clientId, clientSecret: CLIENT_SECRET, code: CODE, redirectUri: REDIRECT_URI },
    ]);
    const installId = mintedInstallId(w);
    expect(w.vault.get(secretRef(installId, 'bot-token'))).toBe(BOT_TOKEN);
    expect(onlyRow(w)).toMatchObject({
      status: 'active',
      teamId: GRANT.teamId,
      teamName: GRANT.teamName,
      botUserId: GRANT.botUserId,
      installedAt: new Date(NOW_MS + 30_000),
    });
    // The token is stored before the row says "active".
    const tail = w.trail.slice(w.trail.indexOf('slack:oauthAccess'));
    expect(tail.indexOf('vault:set bot-token')).toBeLessThan(tail.indexOf('store:activate'));
    expect(w.lines).toEqual([{ level: 'info', msg: 'slack_connected', fields: { installId } }]);
  });

  it('the TASK-1134 walk: two callbacks the admin gate refuses, then one from the signed-in admin; the log shows both refusals, then slack_connected (TASK-1139)', async () => {
    const w = world();
    const state = stateOf(await w.connect());
    const installId = mintedInstallId(w);
    expect(await w.callback({ code: CODE, state }, null)).toStrictEqual(FAILED);
    expect(await w.callback({ code: CODE, state }, null)).toStrictEqual(FAILED);
    expect((await w.callback({ code: CODE, state })).location).toBe(back('connected'));
    expect(w.lines).toEqual([
      { level: 'info', msg: 'slack_install_refused', fields: { reason: 'unauthenticated' } },
      { level: 'info', msg: 'slack_install_refused', fields: { reason: 'unauthenticated' } },
      { level: 'info', msg: 'slack_connected', fields: { installId } },
    ]);
  });

  it('the redirect never leaves the public origin, whatever the request carries', async () => {
    const w = world({ publicOrigin: `${ORIGIN}/` });
    const state = stateOf(await w.connect());
    const res = await w.callback({
      code: CODE,
      state,
      redirect_uri: 'https://evil.example/',
      next: '//evil.example',
      return_to: 'https://evil.example/',
    });
    expect(res.location).toBe(back('connected'));
  });

  it('wrong app_id or an enterprise install → failed, no bot token stored', async () => {
    for (const [reason, grant] of [
      ['app-mismatch', { ...GRANT, appId: 'A0OTHERAPP1' }],
      ['enterprise-install', { ...GRANT, enterpriseInstall: true }],
    ] as const) {
      const w = world();
      w.slack.on.oauthAccess = async () => grant;
      const state = stateOf(await w.connect());
      expect((await w.callback({ code: CODE, state })).location, reason).toBe(back('failed'));
      const installId = mintedInstallId(w);
      expect(w.vault.has(secretRef(installId, 'bot-token')), reason).toBe(false);
      expect(w.vaultCalls.map((c) => c.ref)).not.toContain(secretRef(installId, 'bot-token'));
      expect(onlyRow(w).status, reason).toBe('pending');
      expect(w.lines).toContainEqual({
        level: 'warn',
        msg: 'slack_install_refused',
        fields: { installId, reason },
      });
    }
  });

  it('Slack refusing the code → failed, logged code-only; the install stays pending', async () => {
    const w = world();
    w.slack.on.oauthAccess = async () => {
      throw new SlackApiError('oauth.v2.access', 'invalid_code');
    };
    const state = stateOf(await w.connect());
    expect((await w.callback({ code: CODE, state })).location).toBe(back('failed'));
    const installId = mintedInstallId(w);
    expect(w.lines).toEqual([
      { level: 'warn', msg: 'slack_admin_failed', fields: { installId, stage: 'oauth-access', code: 'invalid_code' } },
    ]);
    expect(onlyRow(w).status).toBe('pending');
    expect(w.vault.has(secretRef(installId, 'bot-token'))).toBe(false);
  });

  it('activate throwing → failed, and the bot token it just stored is removed', async () => {
    const w = world();
    const state = stateOf(await w.connect());
    w.memory.failures.set('activate', new InstallStoreError('install-not-pending'));
    expect((await w.callback({ code: CODE, state })).location).toBe(back('failed'));
    const installId = mintedInstallId(w);
    expect(w.vault.has(secretRef(installId, 'bot-token'))).toBe(false);
    // The other three stay, so the admin can still Continue in Slack.
    expect([...w.vault.keys()].sort()).toEqual(
      [
        secretRef(installId, 'client-secret'),
        secretRef(installId, 'signing-secret'),
        configTokenRef(ADA.id),
      ].sort(),
    );
    expect(w.lines).toContainEqual({
      level: 'error',
      msg: 'slack_admin_failed',
      fields: { installId, stage: 'activate', code: 'install-not-pending' },
    });

    w.memory.failures.delete('activate');
    expect((await w.callback({ code: CODE, state: stateOf(await w.installUrl()) })).location).toBe(
      back('connected'),
    );
    // One line, from the retry.
    expect(w.lines.filter((l) => l.msg === 'slack_connected')).toEqual([
      { level: 'info', msg: 'slack_connected', fields: { installId } },
    ]);
  });

  it('storing the bot token failing → failed, the token removed, the install still pending', async () => {
    const w = world();
    const state = stateOf(await w.connect());
    w.vaultFailures.set('credentials:set bot-token', new Error('vault down'));
    expect((await w.callback({ code: CODE, state })).location).toBe(back('failed'));
    const installId = mintedInstallId(w);
    expect(w.vaultCalls).toContainEqual({ hook: 'credentials:delete', ref: secretRef(installId, 'bot-token') });
    expect(slackMethods(w)).toContain('oauthAccess');
    expect(onlyRow(w).status).toBe('pending');
  });

  it('an install that is gone, active or missing its client secret → failed, without asking Slack', async () => {
    const active = world();
    const s1 = stateOf(await active.connect());
    onlyRow(active).status = 'active';
    expect((await active.callback({ code: CODE, state: s1 })).location).toBe(back('failed'));

    const noSecret = world();
    const s2 = stateOf(await noSecret.connect());
    noSecret.vault.delete(secretRef(mintedInstallId(noSecret), 'client-secret'));
    expect((await noSecret.callback({ code: CODE, state: s2 })).location).toBe(back('failed'));

    for (const [w, reason] of [
      [active, 'not-pending'],
      [noSecret, 'no-client-secret'],
    ] as const) {
      expect(slackMethods(w)).not.toContain('oauthAccess');
      expect(w.lines).toContainEqual({
        level: 'warn',
        msg: 'slack_install_refused',
        fields: { installId: mintedInstallId(w), reason },
      });
    }
  });

  it('a replayed callback after success → failed, and Slack is not asked again', async () => {
    const { w, state } = await connectedWorld();
    expect(await w.callback({ code: CODE, state })).toStrictEqual(FAILED);
    expect(slackMethods(w).filter((m) => m === 'oauthAccess')).toHaveLength(1);
    expect(onlyRow(w).status).toBe('active');
    expect(w.lines).toEqual([{ level: 'info', msg: 'slack_install_refused', fields: { reason: 'invalid-state' } }]);
  });

  it('a store fault mid-callback → failed, logged code-only', async () => {
    const w = world();
    const state = stateOf(await w.connect());
    w.memory.failures.set('consumeOAuthState', Object.assign(new Error('deadlock'), { code: '40P01' }));
    expect((await w.callback({ code: CODE, state })).location).toBe(back('failed'));
    expect(w.lines).toEqual([
      { level: 'error', msg: 'slack_admin_failed', fields: { stage: 'callback', code: '40P01' } },
    ]);
  });
});

describe('POST /admin/slack/disconnect', () => {
  it('rotate + deleteApp succeed → { appDeleted: true }, row and four secrets removed', async () => {
    const { w, installId } = await connectedWorld();
    const mark = w.trail.length;
    const res = await w.disconnect(GRACE);
    expect(res).toMatchObject({ status: 200, body: { appDeleted: true } });
    expect(Object.keys(res.body as object)).toEqual(['appDeleted']);
    // The refresh token Slack minted is stored before the app is deleted. Last,
    // nothing names Ada any more, so her token goes too (TASK-1175).
    expect(w.trail.slice(mark)).toEqual([
      'store:current',
      'vault:get config-refresh-token',
      'slack:rotateConfigToken',
      'vault:set config-refresh-token',
      'slack:deleteApp',
      'store:remove',
      ...SECRET_NAMES.map((n) => `vault:delete ${n}`),
      'store:personHasApps',
      'vault:delete config-refresh-token',
    ]);
    expect(
      w.slack.calls
        .filter((c) => c.method === 'rotateConfigToken' || c.method === 'deleteApp')
        .map((c) => [c.method, ...c.args]),
    ).toEqual([
      ['rotateConfigToken', REFRESH],
      ['rotateConfigToken', mintedRefresh(1)],
      ['deleteApp', MINTED_ACCESS, APP.appId],
    ]);
    expect(w.memory.rows.size).toBe(0);
    expect(w.vault.size).toBe(0);
    expect(w.vaultCalls.filter((c) => c.hook === 'credentials:delete').map((c) => c.ref)).toEqual([
      ...SECRET_NAMES.map((name) => secretRef(installId, name)),
      configTokenRef(ADA.id),
    ]);
    // Slack deleted it: nothing to remember.
    expect(w.memory.leftovers.size).toBe(0);
    expect((await w.status()).body).toMatchObject({ state: 'not-connected' });
    expect(w.lines).toEqual([{ level: 'info', msg: 'slack_disconnected', fields: { installId, appDeleted: true } }]);
  });

  it('rotate fails, deleteApp fails or the token is gone → { appDeleted: false }, row and secrets still removed, and the app remembered', async () => {
    // The last value is Ada's token as Disconnect leaves it: the app left over
    // names her, so it stays for it (TASK-1175), as whatever was last stored.
    const breakers: Array<[string, string, (w: World) => void, string | null]> = [
      [
        'rotate',
        'invalid_refresh_token',
        (w) => {
          w.slack.on.rotateConfigToken = async () => {
            throw new SlackApiError('tooling.tokens.rotate', 'invalid_refresh_token');
          };
        },
        mintedRefresh(1),
      ],
      [
        'delete-app',
        'ratelimited',
        (w) => {
          w.slack.on.deleteApp = async () => {
            throw new SlackApiError('apps.manifest.delete', 'ratelimited', 60_000);
          };
        },
        // The rotate's successor, stored before the delete failed.
        mintedRefresh(2),
      ],
      [
        'config-token',
        'missing',
        (w) => {
          w.vault.delete(configTokenRef(ADA.id));
        },
        // Already gone: nothing to keep.
        null,
      ],
    ];
    for (const [stage, code, breakIt, kept] of breakers) {
      const { w, installId } = await connectedWorld();
      breakIt(w);
      expect(await w.disconnect(), stage).toMatchObject({ status: 200, body: { appDeleted: false } });
      expect(w.memory.rows.size, stage).toBe(0);
      expect(w.vault, stage).toEqual(kept === null ? new Map() : new Map([[configTokenRef(ADA.id), kept]]));
      expect(w.lines, stage).toEqual([
        { level: 'warn', msg: 'slack_admin_failed', fields: { installId, stage, code } },
        { level: 'info', msg: 'slack_disconnected', fields: { installId, appDeleted: false } },
      ]);
      // The app may still be on Slack: its id and name outlive the row (TASK-1132), with whose token made it (TASK-1175).
      expect([...w.memory.leftovers.values()], stage).toEqual([
        { installId, appId: APP.appId, botName: 'Canopy Bot', leftAt: expect.any(Date), connectedByUserId: ADA.id },
      ]);
      expect((await w.status()).body, stage).toMatchObject({
        state: 'not-connected',
        leftoverApps: [{ botName: 'Canopy Bot', appId: APP.appId }],
      });
    }
  });

  it('an app Slack says is already gone (app_not_found) counts as deleted: { appDeleted: true }, no failure logged', async () => {
    const { w, installId } = await connectedWorld();
    // Someone deleted it on api.slack.com/apps first.
    w.slack.on.deleteApp = async () => {
      throw new SlackApiError('apps.manifest.delete', 'app_not_found');
    };
    expect(await w.disconnect()).toMatchObject({ status: 200, body: { appDeleted: true } });
    expect(slackMethods(w).filter((m) => m === 'deleteApp')).toHaveLength(1);
    expect(w.memory.rows.size).toBe(0);
    expect(w.vault.size).toBe(0);
    expect(w.lines).toEqual([{ level: 'info', msg: 'slack_disconnected', fields: { installId, appDeleted: true } }]);
    // Gone already: nothing to remember.
    expect(w.memory.leftovers.size).toBe(0);
    expect((await w.status()).body).toMatchObject({ state: 'not-connected' });
  });

  it('cancels a pending install too', async () => {
    const w = world();
    await w.connect();
    expect(await w.disconnect()).toMatchObject({ status: 200, body: { appDeleted: true } });
    expect(w.memory.rows.size).toBe(0);
    expect(w.vault.size).toBe(0);
    expect(w.memory.leftovers.size).toBe(0);
    expect(w.lines).toEqual([
      { level: 'info', msg: 'slack_disconnected', fields: { installId: mintedInstallId(w), appDeleted: true } },
    ]);
  });

  it('with nothing connected → 409 not-connected', async () => {
    const w = world();
    expect(await w.disconnect()).toMatchObject({ status: 409, body: { error: 'not-connected' } });
    expect(w.slack.calls).toEqual([]);
    expect(w.lines).toEqual([]);
  });

  it('writes only the refresh token Slack minted, before deleting the app; the minted access token goes nowhere but deleteApp', async () => {
    const { w } = await connectedWorld();
    const before = w.vaultCalls.length;
    await w.disconnect();
    expect(w.vaultCalls.slice(before).map((c) => c.hook)).toEqual([
      'credentials:get',
      'credentials:set',
      'credentials:delete',
      'credentials:delete',
      'credentials:delete',
      'credentials:delete',
      // Ada's own token, once nothing names her (TASK-1175).
      'credentials:delete',
    ]);
    expect(w.vaultCalls.slice(before).filter((c) => c.hook === 'credentials:set')).toEqual([
      { hook: 'credentials:set', ref: configTokenRef(ADA.id) },
    ]);
    expect(w.slack.calls.filter((c) => c.args.includes(MINTED_ACCESS)).map((c) => c.method)).toEqual([
      'deleteApp',
    ]);
  });

  it('storing the new refresh token failing still deletes the app with the token in hand; the row and secrets go; one error line, then slack_disconnected', async () => {
    const { w, installId } = await connectedWorld();
    w.vaultFailures.set(
      'credentials:set config-refresh-token',
      Object.assign(new Error(`vault down ${REFRESH}`), { code: 'ECONNRESET' }),
    );
    expect(await w.disconnect()).toMatchObject({ status: 200, body: { appDeleted: true } });
    expect(w.slack.calls.filter((c) => c.method === 'deleteApp').map((c) => c.args)).toEqual([
      [MINTED_ACCESS, APP.appId],
    ]);
    expect(w.memory.rows.size).toBe(0);
    expect(w.vault.size).toBe(0);
    expect(w.lines).toEqual([
      {
        level: 'error',
        msg: 'slack_admin_failed',
        fields: { installId, stage: 'save-config-token', code: 'ECONNRESET' },
      },
      { level: 'info', msg: 'slack_disconnected', fields: { installId, appDeleted: true } },
    ]);
    expect(w.memory.leftovers.size).toBe(0);
  });

  it('a row that will not delete → 500, and the secrets stay for a retry', async () => {
    const { w, installId } = await connectedWorld();
    w.memory.failures.set('remove', new Error('connection reset'));
    expect(await w.disconnect()).toMatchObject({ status: 500, body: { error: 'internal' } });
    expect(w.lines.map((l) => l.msg)).not.toContain('slack_disconnected');
    expect(w.vault.has(secretRef(installId, 'bot-token'))).toBe(true);
    // The token the retry needs: the one Slack minted, not the one it retired.
    expect(w.vault.get(configTokenRef(ADA.id))).toBe(mintedRefresh(2));
    expect(w.memory.leftovers.size).toBe(0);
    w.memory.failures.delete('remove');
    expect(await w.disconnect()).toMatchObject({ status: 200, body: { appDeleted: true } });
    expect(w.lines.filter((l) => l.msg === 'slack_disconnected')).toEqual([{ level: 'info', msg: 'slack_disconnected', fields: { installId, appDeleted: true } }]);
    expect(w.slack.calls.filter((c) => c.method === 'rotateConfigToken').at(-1)!.args).toEqual([
      mintedRefresh(2),
    ]);
    expect(w.vault.size).toBe(0);
  });

  it('Slack refusing the delete and the row refusing to go → 500 and nothing remembered; the retry remembers the app once', async () => {
    const { w, installId } = await connectedWorld();
    w.slack.on.rotateConfigToken = async () => {
      throw new SlackApiError('tooling.tokens.rotate', 'invalid_refresh_token');
    };
    w.memory.failures.set('remove', connectionReset());
    expect(await w.disconnect()).toMatchObject({ status: 500, body: { error: 'internal' } });
    expect(w.lines.map((l) => l.msg)).not.toContain('slack_disconnected');
    // One statement: the row stayed, so the app was not remembered, and the secrets stay too.
    expect(w.memory.rows.has(installId)).toBe(true);
    expect(w.memory.leftovers.size).toBe(0);
    expect(w.vault.has(configTokenRef(ADA.id))).toBe(true);

    w.memory.failures.delete('remove');
    expect(await w.disconnect()).toMatchObject({ status: 200, body: { appDeleted: false } });
    expect(w.lines.filter((l) => l.msg === 'slack_disconnected')).toEqual([{ level: 'info', msg: 'slack_disconnected', fields: { installId, appDeleted: false } }]);
    expect([...w.memory.leftovers.values()]).toEqual([
      { installId, appId: APP.appId, botName: 'Canopy Bot', leftAt: expect.any(Date), connectedByUserId: ADA.id },
    ]);
    expect(w.memory.rows.size).toBe(0);
    // The app left over names Ada, so her token stays for it (TASK-1175): the one stored at Connect, as both rotates failed.
    expect(w.vault).toEqual(new Map([[configTokenRef(ADA.id), mintedRefresh(1)]]));
  });
});

describe('a log line never changes an answer (TASK-1139)', () => {
  it('with a log sink that throws, Connect (deleting a leftover), Allow and Disconnect still succeed, and each line was attempted', async () => {
    const w = world({ logFault: new Error('log sink is down') });
    leaveApp(w, LEFT_1);
    const state = stateOf(await w.connect());
    expect(w.memory.leftovers.size).toBe(0);
    expect((await w.callback({ code: CODE, state })).location).toBe(back('connected'));
    expect(onlyRow(w).status).toBe('active');
    expect(await w.disconnect()).toMatchObject({ status: 200, body: { appDeleted: true } });
    expect(w.memory.rows.size).toBe(0);
    expect(w.vault.size).toBe(0);
    expect(w.lines.map((l) => l.msg)).toEqual(['slack_leftover_app_deleted', 'slack_connected', 'slack_disconnected']);
  });
});

describe("a Slack app Disconnect couldn't delete: remembered, and the next Connect deletes it (TASK-1132)", () => {
  it('a refused install, Cancel with a configuration token Slack no longer takes, then Connect again: the first app is deleted with the new access token, so exactly one Slack app is left (TASK-1132)', async () => {
    const w = world();
    const state = stateOf(await w.connect());
    const firstInstallId = mintedInstallId(w);
    // Signed out on the public address: the admin gate refuses the callback
    // (the walk's `unauthenticated`), and the install stays pending.
    expect(await w.callback({ code: CODE, state }, null)).toStrictEqual(FAILED);
    expect((await w.status()).body).toMatchObject({ state: 'pending' });

    // Cancel, with a stored configuration token Slack no longer takes.
    const rotateAsSlack = w.slack.on.rotateConfigToken;
    w.slack.on.rotateConfigToken = async () => {
      throw new SlackApiError('tooling.tokens.rotate', 'invalid_refresh_token');
    };
    expect(await w.disconnect()).toMatchObject({ status: 200, body: { appDeleted: false } });
    expect((await w.status()).body).toEqual({
      state: 'not-connected',
      defaultBotName: 'canopy-works',
      canConnect: true,
      leftoverApps: [{ botName: 'Canopy Bot', appId: APP.appId }],
    });

    // Connect again, with a new pair: the first app goes before the second is made.
    w.slack.on.rotateConfigToken = rotateAsSlack;
    w.slack.on.createApp = async () => ({ ...APP, appId: SECOND_APP_ID });
    const mark = w.trail.length;
    expect((await w.connect(SECOND_PAIR)).status).toBe(200);
    expect(w.trail.slice(mark, mark + 5)).toEqual([
      'store:current',
      'store:leftoverApps',
      'slack:deleteApp',
      'store:forgetLeftoverApp',
      'slack:createApp',
    ]);
    expect(w.slack.calls.filter((c) => c.method === 'deleteApp').map((c) => c.args)).toEqual([
      [SECOND_ACCESS, APP.appId],
    ]);
    expect([...w.slack.live]).toEqual([SECOND_APP_ID]);
    expect(w.memory.leftovers.size).toBe(0);
    expect(w.lines).toEqual([
      { level: 'info', msg: 'slack_install_refused', fields: { reason: 'unauthenticated' } },
      { level: 'warn', msg: 'slack_admin_failed', fields: { installId: firstInstallId, stage: 'rotate', code: 'invalid_refresh_token' } },
      { level: 'info', msg: 'slack_disconnected', fields: { installId: firstInstallId, appDeleted: false } },
      { level: 'info', msg: 'slack_leftover_app_deleted', fields: { installId: firstInstallId } },
    ]);
  });

  it('Connect deletes every leftover app with the pasted access token before it creates the new one, and forgets each one Slack deleted or no longer has', async () => {
    const w = world();
    leaveApp(w, LEFT_1, 'First Bot', NOW_MS - 120_000);
    leaveApp(w, LEFT_2, 'Second Bot');
    // The admin already deleted the first one on api.slack.com/apps. It comes
    // first so a deleted app after it must not inherit its `already-gone`.
    w.slack.on.deleteApp = async (_token, appId) => {
      if (appId === LEFT_1.appId) throw new SlackApiError('apps.manifest.delete', 'app_not_found');
    };
    expect((await w.connect()).status).toBe(200);
    expect(w.slack.calls.filter((c) => c.method === 'deleteApp').map((c) => c.args)).toEqual([
      [ACCESS, LEFT_1.appId],
      [ACCESS, LEFT_2.appId],
    ]);
    expect(w.trail.slice(0, 7)).toEqual([
      'store:current',
      'store:leftoverApps',
      'slack:deleteApp',
      'store:forgetLeftoverApp',
      'slack:deleteApp',
      'store:forgetLeftoverApp',
      'slack:createApp',
    ]);
    expect(w.memory.leftovers.size).toBe(0);
    // Gone already is what Connect wanted: not a failure.
    expect(w.lines.filter((l) => l.msg === 'slack_admin_failed')).toEqual([]);
    // Everything the pasted access token did, in order.
    expect(w.slack.calls.filter((c) => c.args.includes(ACCESS)).map((c) => c.method)).toEqual([
      'deleteApp',
      'deleteApp',
      'createApp',
      'setAppIcon',
    ]);
    expect(w.lines).toEqual([
      { level: 'info', msg: 'slack_leftover_app_deleted', fields: { installId: LEFT_1.installId, reason: 'already-gone' } },
      { level: 'info', msg: 'slack_leftover_app_deleted', fields: { installId: LEFT_2.installId } },
    ]);
  });

  it("a leftover app Slack won't delete stays listed in every state after, logged code-only under its own install id; Connect still goes ahead", async () => {
    const w = world();
    leaveApp(w, LEFT_1);
    // Say the new token's owner can't manage it.
    w.slack.on.deleteApp = async (_token, appId) => {
      if (appId === LEFT_1.appId) throw new SlackApiError('apps.manifest.delete', 'no_permission');
    };
    const connected = await w.connect();
    expect(connected.status).toBe(200);
    expect(slackMethods(w).filter((m) => m === 'createApp')).toHaveLength(1);
    expect(w.lines).toEqual([
      {
        level: 'warn',
        msg: 'slack_admin_failed',
        fields: { installId: LEFT_1.installId, stage: 'delete-leftover-app', code: 'no_permission' },
      },
    ]);
    expect([...w.memory.leftovers.keys()]).toEqual([LEFT_1.installId]);
    // The unfinished install still names it, so the admin can go and delete it by hand.
    expect((await w.status()).body).toMatchObject({
      state: 'pending',
      leftoverApps: [{ botName: 'Canopy Bot', appId: LEFT_1.appId }],
    });

    // The normal flow never stops on that page: Connect goes straight to Slack,
    // and Allow lands the admin on the connected card. It still names the app.
    expect((await w.callback({ code: CODE, state: stateOf(connected) })).location).toBe(back('connected'));
    expect((await w.status()).body).toMatchObject({
      state: 'connected',
      leftoverApps: [{ botName: 'Canopy Bot', appId: LEFT_1.appId }],
    });

    // Disconnect deletes the new app; the one Slack wouldn't delete is still named.
    expect(await w.disconnect()).toMatchObject({ status: 200, body: { appDeleted: true } });
    expect((await w.status()).body).toMatchObject({
      state: 'not-connected',
      leftoverApps: [{ botName: 'Canopy Bot', appId: LEFT_1.appId }],
    });
  });

  it.each(['no_permission', 'app_not_owned_by_manager_app'])(
    "a %s refusal is about that one app: the pass moves on, so an app the token can't manage never blocks the ones after it",
    async (code) => {
      const w = world();
      leaveApp(w, LEFT_1, 'First Bot', NOW_MS - 120_000);
      leaveApp(w, LEFT_2, 'Second Bot', NOW_MS - 60_000);
      w.slack.on.deleteApp = async (_token, appId) => {
        if (appId === LEFT_1.appId) throw new SlackApiError('apps.manifest.delete', code);
      };
      expect((await w.connect()).status).toBe(200);
      expect(w.slack.calls.filter((c) => c.method === 'deleteApp').map((c) => c.args)).toEqual([
        [ACCESS, LEFT_1.appId],
        [ACCESS, LEFT_2.appId],
      ]);
      expect([...w.memory.leftovers.keys()]).toEqual([LEFT_1.installId]);
      expect(w.lines).toEqual([
        { level: 'warn', msg: 'slack_admin_failed', fields: { installId: LEFT_1.installId, stage: 'delete-leftover-app', code } },
        { level: 'info', msg: 'slack_leftover_app_deleted', fields: { installId: LEFT_2.installId } },
      ]);
    },
  );

  it.each([
    ['timeout', 'warn'],
    ['network', 'warn'],
    ['ratelimited', 'warn'],
    ['http-503', 'warn'],
    ['invalid_auth', 'warn'],
  ] as const)(
    'a %s answer is about Slack or the token, not that one app: the pass stops after it, so the admin lock is not held for every leftover; Connect still goes ahead',
    async (code, level) => {
      const w = world();
      leaveApp(w, LEFT_1, 'First Bot', NOW_MS - 180_000);
      leaveApp(w, LEFT_2, 'Second Bot', NOW_MS - 120_000);
      leaveApp(w, { installId: 'inst_left_3', appId: 'A07LEFTAPP03' }, 'Third Bot', NOW_MS - 60_000);
      w.slack.on.deleteApp = async () => {
        throw new SlackApiError('apps.manifest.delete', code);
      };
      expect((await w.connect()).status).toBe(200);
      // One try, not three.
      expect(slackMethods(w).filter((m) => m === 'deleteApp')).toHaveLength(1);
      expect(slackMethods(w).filter((m) => m === 'createApp')).toHaveLength(1);
      expect(w.lines).toEqual([
        { level, msg: 'slack_admin_failed', fields: { installId: LEFT_1.installId, stage: 'delete-leftover-app', code } },
      ]);
      // All three are still remembered, for the next Connect.
      expect(w.memory.leftovers.size).toBe(3);
    },
  );

  it('a Connect refused before Slack never touches a leftover', async () => {
    // A body it can't use: refused before the store is read.
    const badBody = world();
    leaveApp(badBody, LEFT_1);
    expect(await badBody.connect({})).toMatchObject({ status: 400 });
    expect(badBody.trail).toEqual([]);

    // No https address: refused after the one read that decides it.
    const http = world({ publicOrigin: HTTP_ORIGIN });
    leaveApp(http, LEFT_1);
    expect(await http.connect()).toMatchObject({ status: 409, body: { error: 'public-origin-not-https' } });
    expect(http.slack.calls).toEqual([]);
    expect(http.trail).toEqual(['store:current']);

    // Something is connected already (a leftover can't exist then; this one is planted).
    const { w: connected } = await connectedWorld();
    leaveApp(connected, LEFT_1);
    const mark = connected.trail.length;
    expect(await connected.connect(CONNECT_BODY, GRACE)).toMatchObject({
      status: 409,
      body: { error: 'already-connected' },
    });
    expect(connected.trail.slice(mark)).toEqual(['store:current']);

    for (const w of [badBody, http, connected]) {
      expect(slackMethods(w)).not.toContain('deleteApp');
      expect([...w.memory.leftovers.keys()]).toEqual([LEFT_1.installId]);
    }
  });

  it('reading the leftover list failing → 500 before Slack is asked anything, logged code-only', async () => {
    const w = world();
    w.memory.failures.set('leftoverApps', connectionReset());
    expect(await w.connect()).toMatchObject({ status: 500, body: { error: 'internal' } });
    expect(w.slack.calls).toEqual([]);
    expect(w.vaultCalls).toEqual([]);
    expect(w.memory.rows.size).toBe(0);
    expect(w.lines).toEqual([
      { level: 'error', msg: 'slack_admin_failed', fields: { stage: 'connect', code: 'ECONNRESET' } },
    ]);

    // The status reads it too, while nothing is connected.
    expect(await w.status()).toMatchObject({ status: 500, body: { error: 'internal' } });
    expect(w.lines.slice(1)).toEqual([
      { level: 'error', msg: 'slack_admin_failed', fields: { stage: 'status', code: 'ECONNRESET' } },
    ]);
  });

  it('forgetting a deleted leftover failing is logged; Connect goes on, and the next Connect forgets it', async () => {
    const w = world();
    leaveApp(w, LEFT_1);
    w.memory.failures.set('forgetLeftoverApp', connectionReset());
    expect((await w.connect()).status).toBe(200);
    expect(w.lines).toEqual([
      {
        level: 'error',
        msg: 'slack_admin_failed',
        fields: { installId: LEFT_1.installId, stage: 'forget-leftover-app', code: 'ECONNRESET' },
      },
    ]);
    expect([...w.memory.leftovers.keys()]).toEqual([LEFT_1.installId]);

    w.memory.failures.delete('forgetLeftoverApp');
    expect(await w.disconnect()).toMatchObject({ status: 200, body: { appDeleted: true } });
    // Slack deleted it at the first Connect, so now it says the app is gone.
    w.slack.on.deleteApp = async (_token, appId) => {
      if (appId === LEFT_1.appId) throw new SlackApiError('apps.manifest.delete', 'app_not_found');
    };
    expect((await w.connect(SECOND_PAIR)).status).toBe(200);
    expect(
      w.slack.calls.filter((c) => c.method === 'deleteApp' && c.args[1] === LEFT_1.appId).map((c) => c.args),
    ).toEqual([
      [ACCESS, LEFT_1.appId],
      [SECOND_ACCESS, LEFT_1.appId],
    ]);
    expect(w.memory.leftovers.size).toBe(0);
    // Only the first forget's failure was logged.
    expect(w.lines.filter((l) => l.msg === 'slack_admin_failed')).toHaveLength(1);
    expect(w.lines.filter((l) => l.msg === 'slack_leftover_app_deleted')).toEqual([
      { level: 'info', msg: 'slack_leftover_app_deleted', fields: { installId: LEFT_1.installId, reason: 'already-gone' } },
    ]);
  });
});

describe('POST /admin/slack/forget-leftover-app: "I deleted it" (TASK-1132)', () => {
  it('on a connected install, forgets the app the admin deleted by hand and answers {}; Slack and the vault are never asked', async () => {
    // A note on a connected card can't wait for a Connect to clear it.
    const { w } = await connectedWorld();
    leaveApp(w, LEFT_1, 'First Bot', NOW_MS - 120_000);
    leaveApp(w, LEFT_2, 'Second Bot');
    const slackMark = w.slack.calls.length;
    const vaultMark = w.vaultCalls.length;
    const mark = w.trail.length;
    const res = await w.forget({ appId: LEFT_1.appId });
    expect(res).toStrictEqual({ status: 200, how: 'json', body: {}, location: null, headers: {} });
    expect(w.trail.slice(mark)).toEqual(['store:leftoverApps', 'store:forgetLeftoverApp']);
    expect(w.memory.calls.filter((c) => c.method === 'forgetLeftoverApp').map((c) => c.args)).toEqual([
      [LEFT_1.installId],
    ]);
    expect(w.slack.calls.slice(slackMark)).toEqual([]);
    expect(w.vaultCalls.slice(vaultMark)).toEqual([]);
    expect([...w.memory.leftovers.keys()]).toEqual([LEFT_2.installId]);
    expect((await w.status()).body).toMatchObject({
      state: 'connected',
      leftoverApps: [{ botName: 'Second Bot', appId: LEFT_2.appId }],
    });
    // The install itself is untouched.
    expect(onlyRow(w)).toMatchObject({ status: 'active', appId: APP.appId });
    expect(w.lines).toEqual([]);
  });

  it('forgets every entry with that app id (two removed installs can name one app), and nothing else', async () => {
    const w = world();
    leaveApp(w, LEFT_1, 'First Bot', NOW_MS - 180_000);
    leaveApp(w, LEFT_2, 'Second Bot', NOW_MS - 120_000);
    leaveApp(w, { installId: 'inst_left_again', appId: LEFT_1.appId }, 'First Bot');
    expect(await w.forget({ appId: LEFT_1.appId })).toMatchObject({ status: 200, body: {} });
    expect(w.memory.calls.filter((c) => c.method === 'forgetLeftoverApp').map((c) => c.args)).toEqual([
      [LEFT_1.installId],
      ['inst_left_again'],
    ]);
    expect([...w.memory.leftovers.keys()]).toEqual([LEFT_2.installId]);
    expect((await w.status()).body).toMatchObject({
      state: 'not-connected',
      leftoverApps: [{ botName: 'Second Bot', appId: LEFT_2.appId }],
    });
  });

  it('an app id it no longer lists, or never did → 200 and nothing changes, so a double click is harmless', async () => {
    const w = world();
    leaveApp(w, LEFT_1);
    expect(await w.forget({ appId: 'A07NEVERLEFT' })).toMatchObject({ status: 200, body: {} });
    expect([...w.memory.leftovers.keys()]).toEqual([LEFT_1.installId]);
    expect(await w.forget({ appId: LEFT_1.appId })).toMatchObject({ status: 200, body: {} });
    expect(await w.forget({ appId: LEFT_1.appId })).toMatchObject({ status: 200, body: {} });
    expect(w.memory.leftovers.size).toBe(0);
    expect(w.memory.calls.filter((c) => c.method === 'forgetLeftoverApp')).toHaveLength(1);
    expect(w.slack.calls).toEqual([]);
    expect(w.lines).toEqual([]);
  });

  it('an appId that is not a Slack id → 400 invalid-app-id, before the store is read', async () => {
    const w = world();
    leaveApp(w, LEFT_1);
    for (const body of [
      {},
      { appId: null },
      { appId: 5 },
      { appId: [LEFT_1.appId] },
      { appId: '' },
      { appId: 'A'.repeat(65) },
      { appId: 'A0/../x' },
      { appId: 'javascript:alert(1)' },
      { appId: `${LEFT_1.appId} ` },
      { app_id: LEFT_1.appId },
    ]) {
      expect(await w.forget(body), JSON.stringify(body)).toMatchObject({
        status: 400,
        body: { error: 'invalid-app-id' },
      });
    }
    expect(w.trail).toEqual([]);
    expect([...w.memory.leftovers.keys()]).toEqual([LEFT_1.installId]);
  });

  it('a body that is not a JSON object → 400 invalid-body; one over the cap → 413', async () => {
    const w = world();
    leaveApp(w, LEFT_1);
    for (const body of ['', 'not json', '[1,2]', '"text"', 'null', Buffer.from([0xff, 0xfe, 0x7b, 0x7d])]) {
      expect(await w.forget(body), String(body)).toMatchObject({ status: 400, body: { error: 'invalid-body' } });
    }
    const huge = JSON.stringify({ appId: LEFT_1.appId, pad: 'x'.repeat(ADMIN_BODY_MAX_BYTES) });
    expect(await w.forget(huge)).toMatchObject({ status: 413, body: { error: 'body-too-large' } });
    expect(w.trail).toEqual([]);
    expect([...w.memory.leftovers.keys()]).toEqual([LEFT_1.installId]);
  });

  it('a store fault reading or forgetting → 500, logged with a code only', async () => {
    for (const method of ['leftoverApps', 'forgetLeftoverApp'] as const) {
      const w = world();
      leaveApp(w, LEFT_1);
      w.memory.failures.set(method, Object.assign(new Error(`relation gone ${CLIENT_SECRET}`), { code: '42P01' }));
      expect(await w.forget({ appId: LEFT_1.appId }), method).toMatchObject({
        status: 500,
        body: { error: 'internal' },
      });
      expect(w.lines, method).toEqual([
        { level: 'error', msg: 'slack_admin_failed', fields: { stage: 'forget-leftover-app', code: '42P01' } },
      ]);
      expect([...w.memory.leftovers.keys()], method).toEqual([LEFT_1.installId]);
    }
  });

  it("takes the admin lock: during a Connect's leftover pass it waits, then forgets the app", async () => {
    const w = world();
    leaveApp(w, LEFT_1);
    const gate = deferred();
    w.slack.on.deleteApp = async (_token, appId) => {
      if (appId !== LEFT_1.appId) return;
      await gate.promise;
      throw new SlackApiError('apps.manifest.delete', 'no_permission');
    };
    const connecting = w.connect();
    await settle();
    const held = ['store:current', 'store:leftoverApps', 'slack:deleteApp'];
    expect(w.trail).toEqual(held);
    const forgetting = w.forget({ appId: LEFT_1.appId });
    await settle();
    // The Connect holds the lock while Slack answers: the forget hasn't read anything.
    expect(w.trail).toEqual(held);
    gate.resolve();
    expect((await connecting).status).toBe(200);
    expect(await forgetting).toMatchObject({ status: 200, body: {} });
    expect(w.trail.slice(-2)).toEqual(['store:leftoverApps', 'store:forgetLeftoverApp']);
    expect(w.trail.indexOf('slack:createApp')).toBeLessThan(w.trail.lastIndexOf('store:leftoverApps'));
    expect(w.memory.leftovers.size).toBe(0);
  });
});

describe('POST /admin/slack/rename', () => {
  /**
   * Everything one rename touches, in order: the row, the vault, a rotate,
   * the vault again (the refresh token the rotate minted, stored before the
   * access token is used), the update, and the row last.
   */
  const ONE_RENAME = [
    'store:current',
    'vault:get config-refresh-token',
    'slack:rotateConfigToken',
    'vault:set config-refresh-token',
    'slack:updateApp',
    'store:setBotName',
  ];
  /** How far into ONE_RENAME a rename gets before a step fails. */
  const STOPS_AFTER = { 'config-token': 2, rotate: 3, 'save-config-token': 4, 'update-app': 5 } as const;
  /** The two fields a rename changes, as a test reads them out of a manifest. */
  type ManifestNames = { display_information: { name: string }; features: { bot_user: { display_name: string } } };
  const updates = (w: World) => w.slack.calls.filter((c) => c.method === 'updateApp');

  it('rotates the stored refresh token and sends Slack the whole manifest with only the name changed; the row and the status show the new name', async () => {
    const { w, installId } = await connectedWorld();
    const mark = w.slack.calls.length;
    const trailMark = w.trail.length;
    const res = await w.rename({ botName: '  Ada   Helper ' });
    // Slack first, the row last: the row only ever shows a name Slack took.
    expect(w.trail.slice(trailMark)).toEqual(ONE_RENAME);
    expect(res).toMatchObject({ status: 200, how: 'json' });
    // The tidied name, as stored, and nothing else.
    expect(res.body).toStrictEqual({ botName: 'Ada Helper' });
    expect(w.slack.calls.slice(mark)).toEqual([
      { method: 'rotateConfigToken', args: [mintedRefresh(1)] },
      {
        method: 'updateApp',
        args: [MINTED_ACCESS, APP.appId, buildAppManifest('Ada Helper', slackUrls(ORIGIN, installId))],
      },
    ]);

    // Slack keeps nothing it isn't sent. The update is what Connect created,
    // with only the two name fields changed...
    const created = w.slack.calls.find((c) => c.method === 'createApp')!.args[1] as ManifestNames;
    const renamed = structuredClone(created);
    renamed.display_information.name = 'Ada Helper';
    renamed.features.bot_user.display_name = 'Ada Helper';
    const sent = w.slack.calls[mark + 1]!.args[2];
    expect(sent).toEqual(renamed);
    // ...so the approval buttons, /ax, the events and every scope survive it.
    expect(sent).toMatchObject({
      features: { slash_commands: [{ command: '/ax', url: `${ORIGIN}/slack/commands/${installId}` }] },
      oauth_config: { redirect_urls: [REDIRECT_URI], scopes: { bot: [...BOT_SCOPES] } },
      settings: {
        event_subscriptions: {
          request_url: `${ORIGIN}/slack/events/${installId}`,
          bot_events: ['app_mention', 'message.im'],
        },
        interactivity: { is_enabled: true, request_url: `${ORIGIN}/slack/interactions/${installId}` },
      },
    });

    expect(onlyRow(w).botName).toBe('Ada Helper');
    expect((await w.status()).body).toMatchObject({ state: 'connected', botName: 'Ada Helper' });
    // The refresh token the rotate minted replaced the one Connect stored.
    expect(w.vault.get(configTokenRef(ADA.id))).toBe(mintedRefresh(2));
    expect(w.lines).toEqual([]);
  });

  it('two renames in a row, then Disconnect: each rotate spends the token the one before it stored, so all three work (TASK-1129)', async () => {
    const { w, installId } = await connectedWorld();
    expect(await w.rename({ botName: 'First Name' })).toMatchObject({ status: 200, body: { botName: 'First Name' } });
    expect(await w.rename({ botName: 'Second Name' })).toMatchObject({
      status: 200,
      body: { botName: 'Second Name' },
    });
    expect(await w.disconnect()).toMatchObject({ status: 200, body: { appDeleted: true } });
    expect(w.slack.calls.filter((c) => c.method === 'rotateConfigToken').map((c) => c.args[0])).toEqual([
      REFRESH,
      mintedRefresh(1),
      mintedRefresh(2),
      mintedRefresh(3),
    ]);
    expect(w.lines).toEqual([{ level: 'info', msg: 'slack_disconnected', fields: { installId, appDeleted: true } }]);
    expect(w.vault.size).toBe(0);
  });

  it('the new refresh token is stored before Slack is asked to update: an update Slack refuses still leaves it stored, and the next rename works', async () => {
    const { w, installId } = await connectedWorld();
    w.slack.on.updateApp = async () => {
      throw new SlackApiError('apps.manifest.update', 'ratelimited', 60_000);
    };
    expect(await w.rename()).toMatchObject({ status: 502, body: { error: 'slack-error' } });
    expect(w.vault.get(configTokenRef(ADA.id))).toBe(mintedRefresh(2));
    expect(w.lines).toEqual([
      { level: 'warn', msg: 'slack_admin_failed', fields: { installId, stage: 'update-app', code: 'ratelimited' } },
    ]);

    w.slack.on.updateApp = async () => {};
    expect(await w.rename()).toMatchObject({ status: 200, body: { botName: 'Ada Helper' } });
    expect(w.slack.calls.filter((c) => c.method === 'rotateConfigToken').map((c) => c.args[0])).toEqual([
      REFRESH,
      mintedRefresh(1),
      mintedRefresh(2),
    ]);
  });

  it('storing the new refresh token failing → 500; Slack is never asked to update and the old token stays; a retry while Slack still honours it lands', async () => {
    const { w, installId } = await connectedWorld();
    const ref = configTokenRef(ADA.id);
    w.vaultFailures.set(
      'credentials:set config-refresh-token',
      Object.assign(new Error(`vault down ${REFRESH}`), { code: 'ECONNRESET' }),
    );
    const mark = w.trail.length;
    expect(await w.rename()).toMatchObject({ status: 500, body: { error: 'internal' } });
    expect(w.trail.slice(mark)).toEqual(ONE_RENAME.slice(0, STOPS_AFTER['save-config-token']));
    expect(updates(w)).toEqual([]);
    expect(w.vault.get(ref)).toBe(mintedRefresh(1));
    expect(onlyRow(w).botName).toBe('Canopy Bot');
    expect(w.lines).toEqual([
      { level: 'error', msg: 'slack_admin_failed', fields: { installId, stage: 'save-config-token', code: 'ECONNRESET' } },
    ]);

    // While Slack still honours the old token, trying again rotates it again and keeps what that mints.
    w.vaultFailures.delete('credentials:set config-refresh-token');
    w.slack.rotatedStillWork = true;
    expect(await w.rename()).toMatchObject({ status: 200, body: { botName: 'Ada Helper' } });
    expect(w.vault.get(ref)).toBe(mintedRefresh(3));
  });

  it('refuses a bad name with { error: "invalid-bot-name", reason } before reading the vault or calling Slack', async () => {
    const { w } = await connectedWorld();
    const mark = w.trail.length;
    // Each fails exactly one rule. A missing or non-string name reads as bad characters, like Connect.
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ botName: '' }, 'empty'],
      [{ botName: 'a'.repeat(36) }, 'too-long'],
      [{ botName: 'Café' }, 'bad-characters'],
      [{ botName: 'slack-bot' }, 'reserved'],
      [{ botName: 42 }, 'bad-characters'],
      [{ botName: null }, 'bad-characters'],
      [{}, 'bad-characters'],
    ];
    for (const [body, reason] of cases) {
      const res = await w.rename(body);
      expect(res, JSON.stringify(body)).toMatchObject({ status: 400 });
      expect(res.body, JSON.stringify(body)).toStrictEqual({ error: 'invalid-bot-name', reason });
    }
    // Not the store, not the vault, not Slack.
    expect(w.trail.slice(mark)).toEqual([]);
    expect(onlyRow(w).botName).toBe('Canopy Bot');
  });

  it('a body that is not a JSON object → 400 invalid-body; one over the cap → 413', async () => {
    const { w } = await connectedWorld();
    const mark = w.trail.length;
    for (const body of ['', 'not json', '[1,2]', '"text"', 'null', Buffer.from([0xff, 0xfe, 0x7b, 0x7d])]) {
      expect(await w.rename(body), String(body)).toMatchObject({ status: 400, body: { error: 'invalid-body' } });
    }
    const huge = JSON.stringify({ botName: 'Ada Helper', pad: 'x'.repeat(ADMIN_BODY_MAX_BYTES) });
    expect(await w.rename(huge)).toMatchObject({ status: 413, body: { error: 'body-too-large' } });
    expect(w.trail.slice(mark)).toEqual([]);
  });

  it('→ 409 not-connected with nothing connected or an unfinished install; → 409 public-origin-not-https on an http origin; neither touches the vault or Slack', async () => {
    const w = world();
    expect(await w.rename()).toMatchObject({ status: 409, body: { error: 'not-connected' } });
    expect(w.trail).toEqual(['store:current']);

    // Pending: Cancel and Connect again instead.
    expect((await w.connect()).status).toBe(200);
    const slackMark = w.slack.calls.length;
    const vaultMark = w.vaultCalls.length;
    expect(await w.rename()).toMatchObject({ status: 409, body: { error: 'not-connected' } });
    expect(w.slack.calls.slice(slackMark)).toEqual([]);
    expect(w.vaultCalls.slice(vaultMark)).toEqual([]);
    expect(onlyRow(w)).toMatchObject({ status: 'pending', botName: 'Canopy Bot' });

    // An active install with a refresh token that would work: only the origin stops it.
    const http = world({ publicOrigin: HTTP_ORIGIN });
    const installId = 'AAAAAAAAAAAAAAAAAAAAAA';
    http.memory.rows.set(installId, {
      installId,
      status: 'active',
      appId: APP.appId,
      clientId: APP.clientId,
      botName: 'Canopy Bot',
      teamId: GRANT.teamId,
      teamName: GRANT.teamName,
      botUserId: GRANT.botUserId,
      connectedByUserId: ADA.id,
      createdAt: new Date(NOW_MS),
      configTokenAddedAt: new Date(NOW_MS),
      installedAt: new Date(NOW_MS),
      stateHash: null,
      stateUserId: null,
      stateExpiresAt: null,
    });
    http.vault.set(configTokenRef(ADA.id), REFRESH);
    expect(await http.rename()).toMatchObject({ status: 409, body: { error: 'public-origin-not-https' } });
    expect(http.slack.calls).toEqual([]);
    expect(http.vaultCalls).toEqual([]);
    expect(onlyRow(http).botName).toBe('Canopy Bot');
    expect([...w.lines, ...http.lines]).toEqual([]);
  });

  it('a configuration token Slack no longer accepts → 502 slack-config-token; the row keeps its name', async () => {
    const rotateRefuses =
      (code: string) =>
      (w: World): void => {
        w.slack.on.rotateConfigToken = async () => {
          throw new SlackApiError('tooling.tokens.rotate', code);
        };
      };
    const updateRefuses =
      (code: string) =>
      (w: World): void => {
        w.slack.on.updateApp = async () => {
          throw new SlackApiError('apps.manifest.update', code);
        };
      };
    const cases: Array<[keyof typeof STOPS_AFTER, string, (w: World) => void]> = [
      [
        'config-token',
        'missing',
        (w) => {
          w.vault.delete(configTokenRef(ADA.id));
        },
      ],
      // What rotate says once the token was revoked on Slack's page (MEASURED, TASK-1093).
      ['rotate', 'invalid_refresh_token', rotateRefuses('invalid_refresh_token')],
      ...['invalid_auth', 'not_authed', 'token_expired', 'token_revoked', 'account_inactive'].map(
        (code): ['update-app', string, (w: World) => void] => ['update-app', code, updateRefuses(code)],
      ),
      // Alive, but its owner can't manage this app (both are listed for
      // apps.manifest.update). Trying again can't fix these either.
      ...['no_permission', 'app_not_owned_by_manager_app'].map(
        (code): ['update-app', string, (w: World) => void] => ['update-app', code, updateRefuses(code)],
      ),
    ];
    for (const [stage, code, breakIt] of cases) {
      const { w, installId } = await connectedWorld();
      breakIt(w);
      const mark = w.trail.length;
      const res = await w.rename();
      expect(res, code).toMatchObject({ status: 502 });
      expect(res.body, code).toStrictEqual({ error: 'slack-config-token' });
      // Stopped at the step that failed: no store:setBotName.
      expect(w.trail.slice(mark), code).toEqual(ONE_RENAME.slice(0, STOPS_AFTER[stage]));
      expect(onlyRow(w).botName, code).toBe('Canopy Bot');
      expect(w.lines, code).toEqual([{ level: 'warn', msg: 'slack_admin_failed', fields: { installId, stage, code } }]);
    }
  });

  it('Slack refusing the manifest → 502 slack-name; anything else Slack says → 502 slack-error; nothing stored', async () => {
    const update = (code: string, retryAfterMs?: number): SlackApiError =>
      new SlackApiError('apps.manifest.update', code, retryAfterMs);
    const rotate = (code: string): SlackApiError => new SlackApiError('tooling.tokens.rotate', code);
    const cases: Array<['rotate' | 'update-app', unknown, string]> = [
      ['update-app', update('invalid_manifest'), 'slack-name'],
      ['update-app', update('ratelimited', 60_000), 'slack-error'],
      ['update-app', update('timeout'), 'slack-error'],
      ['update-app', update('http-503'), 'slack-error'],
      ['update-app', update('bad-response'), 'slack-error'],
      ['update-app', new TypeError('not a Slack answer'), 'slack-error'],
      // The name never reaches rotate, so only the update can mean slack-name.
      ['rotate', rotate('invalid_manifest'), 'slack-error'],
      ['rotate', rotate('network'), 'slack-error'],
      // Rotate names no app, so an app that's gone can only be news from the update.
      ['rotate', rotate('app_not_found'), 'slack-error'],
    ];
    for (const [stage, err, error] of cases) {
      const { w, installId } = await connectedWorld();
      const fail = async (): Promise<never> => {
        throw err;
      };
      if (stage === 'rotate') w.slack.on.rotateConfigToken = fail;
      else w.slack.on.updateApp = fail;
      const mark = w.trail.length;
      const res = await w.rename();
      const label = `${stage} ${String(err)}`;
      expect(res, label).toMatchObject({ status: 502 });
      expect(res.body, label).toStrictEqual({ error });
      expect(w.trail.slice(mark), label).toEqual(ONE_RENAME.slice(0, STOPS_AFTER[stage]));
      expect(onlyRow(w).botName, label).toBe('Canopy Bot');
      expect(w.lines, label).toEqual([
        {
          level: err instanceof SlackApiError ? 'warn' : 'error',
          msg: 'slack_admin_failed',
          fields: { installId, stage, code: err instanceof SlackApiError ? err.code : 'unknown' },
        },
      ]);
    }
  });

  it('Slack saying the app is gone (app_not_found at the update) → 502 slack-app-gone, not "try again"; nothing stored', async () => {
    const { w, installId } = await connectedWorld();
    w.slack.on.updateApp = async () => {
      throw new SlackApiError('apps.manifest.update', 'app_not_found');
    };
    const mark = w.trail.length;
    const res = await w.rename();
    expect(res).toMatchObject({ status: 502 });
    expect(res.body).toStrictEqual({ error: 'slack-app-gone' });
    expect(w.trail.slice(mark)).toEqual(ONE_RENAME.slice(0, STOPS_AFTER['update-app']));
    expect(onlyRow(w).botName).toBe('Canopy Bot');
    expect(w.lines).toEqual([
      { level: 'warn', msg: 'slack_admin_failed', fields: { installId, stage: 'update-app', code: 'app_not_found' } },
    ]);
  });

  it('a vault fault reading the token → 500, logged code-only, and Slack is never called', async () => {
    const { w } = await connectedWorld();
    w.vaultFailures.set(
      'credentials:get config-refresh-token',
      Object.assign(new Error(`vault down ${REFRESH}`), { code: 'ECONNRESET' }),
    );
    const mark = w.slack.calls.length;
    expect(await w.rename()).toMatchObject({ status: 500, body: { error: 'internal' } });
    expect(w.slack.calls.slice(mark)).toEqual([]);
    expect(onlyRow(w).botName).toBe('Canopy Bot');
    expect(w.lines).toEqual([
      { level: 'error', msg: 'slack_admin_failed', fields: { stage: 'rename', code: 'ECONNRESET' } },
    ]);
  });

  it('the row write failing after Slack said yes → 500; a retry sends the same manifest and lands', async () => {
    const { w } = await connectedWorld();
    w.memory.failures.set('setBotName', Object.assign(new Error('connection reset'), { code: '08006' }));
    expect(await w.rename()).toMatchObject({ status: 500, body: { error: 'internal' } });
    expect(updates(w)).toHaveLength(1);
    // Slack has the new name; AX's row doesn't, yet.
    expect(onlyRow(w).botName).toBe('Canopy Bot');
    expect(w.lines).toEqual([
      { level: 'error', msg: 'slack_admin_failed', fields: { stage: 'rename', code: '08006' } },
    ]);

    w.memory.failures.delete('setBotName');
    expect(await w.rename()).toMatchObject({ status: 200, body: { botName: 'Ada Helper' } });
    expect(updates(w)).toHaveLength(2);
    const [first, retry] = updates(w);
    expect(retry!.args).toEqual(first!.args);
    expect(onlyRow(w).botName).toBe('Ada Helper');
  });

  it('R7 the install removed while Slack was renaming it (a reset takes no admin lock) → 409 not-connected; the token it just stored goes, unless a leftover app still names the person', async () => {
    const { w, installId } = await connectedWorld();
    w.slack.on.updateApp = async () => {
      await w.memory.store.removeAll();
    };
    expect(await w.rename()).toMatchObject({ status: 409, body: { error: 'not-connected' } });
    // setBotName found the row gone; then the rename asked whether anything still names Ada.
    expect(w.memory.calls.slice(-2)).toEqual([
      { method: 'setBotName', args: [installId, 'Ada Helper'] },
      { method: 'personHasApps', args: [ADA.id] },
    ]);
    expect(w.memory.rows.size).toBe(0);
    // Nothing does, so the token it had just stored goes too. The rename takes
    // it back itself: a reset's own sweep (plugin.ts) only catches one stored
    // before the sweep ran.
    expect(w.vault.has(configTokenRef(ADA.id))).toBe(false);
    expect(w.trail.slice(-2)).toEqual(['store:personHasApps', 'vault:delete config-refresh-token']);
    expect(w.lines).toEqual([]);

    // An app Ada made is still left over: it names her, so her token stays, for it.
    const kept = await connectedWorld();
    leaveApp(kept.w, LEFT_1, 'Canopy Bot', NOW_MS - 60_000, ADA.id);
    kept.w.slack.on.updateApp = async () => {
      await kept.w.memory.store.removeAll();
    };
    expect(await kept.w.rename()).toMatchObject({ status: 409, body: { error: 'not-connected' } });
    expect(kept.w.trail.at(-1)).toBe('store:personHasApps');
    expect(kept.w.vault.get(configTokenRef(ADA.id))).toBe(mintedRefresh(2));
    expect(kept.w.lines).toEqual([]);
  });

  it('a rename and a disconnect never interleave', async () => {
    // The rename first: it finishes, Slack then the row, before the disconnect reads anything.
    const { w } = await connectedWorld();
    const gate = deferred();
    w.slack.on.updateApp = async () => {
      await gate.promise;
    };
    const mark = w.trail.length;
    const renaming = w.rename();
    const disconnecting = w.disconnect(GRACE);
    await settle();
    gate.resolve();
    expect(await renaming).toMatchObject({ status: 200, body: { botName: 'Ada Helper' } });
    expect(await disconnecting).toMatchObject({ status: 200, body: { appDeleted: true } });
    const tail = w.trail.slice(mark);
    expect(tail.slice(0, ONE_RENAME.length)).toEqual(ONE_RENAME);
    expect(tail.slice(ONE_RENAME.length, ONE_RENAME.length + 5)).toEqual([
      'store:current',
      'vault:get config-refresh-token',
      'slack:rotateConfigToken',
      'vault:set config-refresh-token',
      'slack:deleteApp',
    ]);
    // The disconnect rotates the token the rename stored, not the one Slack retired.
    expect(w.slack.calls.filter((c) => c.method === 'rotateConfigToken').map((c) => c.args[0])).toEqual([
      REFRESH,
      mintedRefresh(1),
      mintedRefresh(2),
    ]);
    expect(w.memory.rows.size).toBe(0);
    expect(w.vault.size).toBe(0);

    // The disconnect first: the rename then finds nothing to rename.
    const reverse = (await connectedWorld()).w;
    const deleting = deferred();
    reverse.slack.on.deleteApp = async () => {
      await deleting.promise;
    };
    const reverseMark = reverse.trail.length;
    const disconnected = reverse.disconnect(GRACE);
    const renamed = reverse.rename();
    await settle();
    deleting.resolve();
    expect(await disconnected).toMatchObject({ status: 200, body: { appDeleted: true } });
    expect(await renamed).toMatchObject({ status: 409, body: { error: 'not-connected' } });
    expect(slackMethods(reverse)).not.toContain('updateApp');
    // The rename's one step: a store read, after the disconnect had finished.
    expect(reverse.trail.slice(reverseMark).at(-1)).toBe('store:current');
    expect(reverse.trail.slice(reverseMark).filter((t) => t === 'slack:rotateConfigToken')).toHaveLength(1);
    expect(reverse.memory.rows.size).toBe(0);
  });

  it('two renames at once (a double click, or two admins) take turns, each whole; the later name stays', async () => {
    const { w } = await connectedWorld();
    const gate = deferred();
    let held = false;
    w.slack.on.updateApp = async () => {
      if (held) return;
      held = true;
      await gate.promise;
    };
    const mark = w.trail.length;
    const one = w.rename({ botName: 'Ada Helper' });
    const two = w.rename({ botName: 'Grace Helper' }, GRACE);
    await settle();
    gate.resolve();
    expect(await one).toMatchObject({ status: 200, body: { botName: 'Ada Helper' } });
    expect(await two).toMatchObject({ status: 200, body: { botName: 'Grace Helper' } });
    expect(w.trail.slice(mark)).toEqual([...ONE_RENAME, ...ONE_RENAME]);
    expect(updates(w).map((c) => (c.args[2] as ManifestNames).display_information.name)).toEqual([
      'Ada Helper',
      'Grace Helper',
    ]);
    expect(onlyRow(w).botName).toBe('Grace Helper');
  });

  it('saving the name it already has sends the manifest again and answers 200', async () => {
    const { w, installId } = await connectedWorld();
    expect(await w.rename({ botName: 'Canopy Bot' })).toMatchObject({
      status: 200,
      body: { botName: 'Canopy Bot' },
    });
    expect(updates(w).map((c) => c.args)).toEqual([
      [MINTED_ACCESS, APP.appId, buildAppManifest('Canopy Bot', slackUrls(ORIGIN, installId))],
    ]);
    expect(onlyRow(w).botName).toBe('Canopy Bot');
  });

  it('writes the vault once, with the refresh token Slack minted; the minted access token goes nowhere but updateApp, the refresh token it minted nowhere but the vault', async () => {
    const { w } = await connectedWorld();
    const ref = configTokenRef(ADA.id);
    const before = w.vaultCalls.length;
    await w.rename();
    // Two vault calls: reading the refresh token, then replacing it with the one Slack minted.
    expect(w.vaultCalls.slice(before)).toEqual([
      { hook: 'credentials:get', ref },
      { hook: 'credentials:set', ref },
    ]);
    expect(w.vault.get(ref)).toBe(mintedRefresh(2));
    expect(w.slack.calls.filter((c) => c.args.includes(MINTED_ACCESS)).map((c) => c.method)).toEqual([
      'updateApp',
    ]);
    expect(w.slack.calls.filter((c) => JSON.stringify(c.args).includes(mintedRefresh(2)))).toEqual([]);
  });
});

describe('POST /admin/slack/replace-token (TASK-1128)', () => {
  /**
   * Everything one replace touches, in order: the row, a rotate of the pasted
   * token, the check (the app's whole manifest, sent with the access token
   * that rotate minted), the vault (the refresh token it minted, stored as the
   * install's person's), the row's date, and last the leftover list. The
   * stored token is never read.
   */
  const ONE_REPLACE = [
    'store:current',
    'slack:rotateConfigToken',
    'slack:updateApp',
    'vault:set config-refresh-token',
    'store:setConfigTokenAddedAt',
    'store:leftoverApps',
  ];
  /** How far into ONE_REPLACE a replace gets before the step its log line names fails. */
  const STOPS_AFTER = { 'try-refresh-token': 2, 'check-app': 3, 'save-config-token': 4, 'save-added-at': 5 } as const;
  /** A day after Connect, when Grace replaces the token. */
  const REPLACED_AT = NOW_MS + 86_400_000;
  const rotatedTokens = (w: World): unknown[] =>
    w.slack.calls.filter((c) => c.method === 'rotateConfigToken').map((c) => c.args[0]);
  const otherSecrets = (w: World, installId: string): Array<string | undefined> =>
    (['bot-token', 'signing-secret', 'client-secret'] as const).map((n) => w.vault.get(secretRef(installId, n)));

  it("R1 Grace pastes the token Ada generated: it is stored as Ada's, the row keeps Ada and only the date moves; Grace's own token is untouched", async () => {
    const { w, installId } = await connectedWorld();
    // Grace made Slack apps of her own through AX, so she has a token of her own.
    const graceOwn = fakeConfigRefreshToken('GRACEOWNSECRET');
    w.vault.set(configTokenRef(GRACE.id), graceOwn);
    const before = { ...onlyRow(w) };
    expect(otherSecrets(w, installId)).toEqual([BOT_TOKEN, SIGNING_SECRET, CLIENT_SECRET]);
    w.advance(86_400_000);
    const slackMark = w.slack.calls.length;
    const mark = w.trail.length;

    const res = await w.replace({ refreshToken: SECOND_REFRESH }, GRACE);
    expect(res).toMatchObject({ status: 200, how: 'json' });
    expect(res.body).toStrictEqual({});
    // No vault read or delete and no store:remove*: the install and its other secrets are never touched.
    expect(w.trail.slice(mark)).toEqual(ONE_REPLACE);
    expect(w.slack.calls.slice(slackMark)).toEqual([
      { method: 'rotateConfigToken', args: [SECOND_REFRESH] },
      {
        method: 'updateApp',
        args: [MINTED_ACCESS, APP.appId, buildAppManifest('Canopy Bot', slackUrls(ORIGIN, installId))],
      },
    ]);
    // The whole manifest, exactly as Connect made the app: nothing on it is dropped.
    const created = w.slack.calls.find((c) => c.method === 'createApp')!.args[1];
    expect(w.slack.calls[slackMark + 1]!.args[2]).toEqual(created);

    // Stored as the token of the person whose app it is (Slack took it for her
    // app, so it is her chain), whoever pasted it.
    expect(w.vault.get(configTokenRef(ADA.id))).toBe(mintedRefresh(2));
    expect(w.vault.get(configTokenRef(GRACE.id))).toBe(graceOwn);
    expect(otherSecrets(w, installId)).toEqual([BOT_TOKEN, SIGNING_SECRET, CLIENT_SECRET]);
    expect(w.vault.size).toBe(5);
    // Only the date moves: the app stays Ada's.
    expect(onlyRow(w)).toEqual({ ...before, configTokenAddedAt: new Date(REPLACED_AT) });
    expect(onlyRow(w)).toMatchObject({
      installId,
      status: 'active',
      botName: 'Canopy Bot',
      connectedByUserId: ADA.id,
      createdAt: new Date(NOW_MS),
    });
    expect(w.lines).toEqual([{ level: 'info', msg: 'slack_config_token_replaced', fields: { installId } }]);
  });

  it('R2 after a replace by another admin, every token read and write still names Ada, and Rename then Disconnect use the replaced token', async () => {
    const { w } = await connectedWorld();
    // Until now, every vault call named Ada, who connected.
    expect(new Set(w.vaultAs.map((v) => v.userId))).toEqual(new Set([ADA.id]));
    w.advance(86_400_000);
    let mark = w.vaultAs.length;
    expect(await w.replace({ refreshToken: SECOND_REFRESH }, GRACE)).toMatchObject({ status: 200, body: {} });
    expect(w.vaultAs.slice(mark)).toEqual([{ hook: 'credentials:set', name: 'config-refresh-token', userId: ADA.id }]);
    // Still Ada's token: "Added by" keeps her, with the day of the replace.
    expect((await w.status()).body).toMatchObject({
      state: 'connected',
      connectedBy: 'Ada Admin',
      connectedAt: new Date(REPLACED_AT).toISOString(),
    });

    // Grace renames: the rotate spends the token her replace stored, read and kept as Ada's.
    mark = w.vaultAs.length;
    expect(await w.rename(undefined, GRACE)).toMatchObject({ status: 200, body: { botName: 'Ada Helper' } });
    expect(rotatedTokens(w)).toEqual([REFRESH, SECOND_REFRESH, mintedRefresh(2)]);
    expect(w.vaultAs.slice(mark)).toEqual([
      { hook: 'credentials:get', name: 'config-refresh-token', userId: ADA.id },
      { hook: 'credentials:set', name: 'config-refresh-token', userId: ADA.id },
    ]);

    mark = w.vaultAs.length;
    expect(await w.disconnect(GRACE)).toMatchObject({ status: 200, body: { appDeleted: true } });
    expect(rotatedTokens(w)).toEqual([REFRESH, SECOND_REFRESH, mintedRefresh(2), mintedRefresh(3)]);
    // Nothing names Ada after it, so her token goes too, deleted as her.
    expect(w.vaultAs.slice(mark).filter((v) => v.hook === 'credentials:delete' && v.userId !== 'system')).toEqual([
      { hook: 'credentials:delete', name: 'config-refresh-token', userId: ADA.id },
    ]);
    expect(w.vaultAs.slice(mark).filter((v) => v.hook !== 'credentials:delete')).toEqual([
      { hook: 'credentials:get', name: 'config-refresh-token', userId: ADA.id },
      { hook: 'credentials:set', name: 'config-refresh-token', userId: ADA.id },
    ]);
    expect(w.vault.size).toBe(0);
    expect(w.lines.filter((l) => l.msg === 'slack_admin_failed')).toEqual([]);
  });

  it('checked before the lock: not a JSON object → 400 invalid-body; no usable refresh token → 400 invalid-refresh-token; neither touches anything', async () => {
    const { w } = await connectedWorld();
    const mark = w.trail.length;
    for (const body of ['', 'not json', '[1,2]', '"text"', 'null', Buffer.from([0xff, 0xfe, 0x7b, 0x7d])]) {
      const res = await w.replace(body, GRACE);
      expect(res, String(body)).toMatchObject({ status: 400 });
      expect(res.body, String(body)).toStrictEqual({ error: 'invalid-body' });
    }
    const tooLong = `${CONFIG_REFRESH_PREFIX}${'a'.repeat(SLACK_TOKEN_MAX + 1 - CONFIG_REFRESH_PREFIX.length)}`;
    expect(tooLong).toHaveLength(513);
    const cases: Array<[string, Record<string, unknown>]> = [
      ['no refresh token', {}],
      ['an access token in the refresh box', { refreshToken: ACCESS }],
      ['the prefix alone', { refreshToken: CONFIG_REFRESH_PREFIX }],
      ['513 characters', { refreshToken: tooLong }],
      ['an embedded space', { refreshToken: `${CONFIG_REFRESH_PREFIX}1-SECOND REFRESH` }],
    ];
    for (const [label, body] of cases) {
      const res = await w.replace(body, GRACE);
      expect(res, label).toMatchObject({ status: 400 });
      expect(res.body, label).toStrictEqual({ error: 'invalid-refresh-token' });
    }
    const huge = JSON.stringify({ refreshToken: SECOND_REFRESH, pad: 'x'.repeat(ADMIN_BODY_MAX_BYTES) });
    expect(await w.replace(huge, GRACE)).toMatchObject({ status: 413, body: { error: 'body-too-large' } });
    // Not the store, not the vault, not Slack, and nothing logged.
    expect(w.trail.slice(mark)).toEqual([]);
    expect(w.lines).toEqual([]);
    expect(onlyRow(w).connectedByUserId).toBe(ADA.id);

    // A full-length one is fine.
    const longest = tooLong.slice(0, SLACK_TOKEN_MAX);
    expect(await w.replace({ refreshToken: longest }, GRACE)).toMatchObject({ status: 200, body: {} });
    expect(rotatedTokens(w).at(-1)).toBe(longest);
  });

  it('→ 409 not-connected with nothing connected or an unfinished install; → 409 public-origin-not-https on an http origin; none touches the vault or Slack', async () => {
    const w = world();
    expect(await w.replace()).toMatchObject({ status: 409, body: { error: 'not-connected' } });
    expect(w.trail).toEqual(['store:current']);

    // Pending: Cancel and Connect again instead (no channels yet).
    expect((await w.connect()).status).toBe(200);
    const slackMark = w.slack.calls.length;
    const vaultMark = w.vaultCalls.length;
    expect(await w.replace(undefined, GRACE)).toMatchObject({ status: 409, body: { error: 'not-connected' } });
    expect(w.slack.calls.slice(slackMark)).toEqual([]);
    expect(w.vaultCalls.slice(vaultMark)).toEqual([]);
    expect(onlyRow(w)).toMatchObject({ status: 'pending', connectedByUserId: ADA.id });

    // An active install with a refresh token that would work: only the origin stops it.
    const http = world({ publicOrigin: HTTP_ORIGIN });
    const installId = 'AAAAAAAAAAAAAAAAAAAAAA';
    http.memory.rows.set(installId, {
      installId,
      status: 'active',
      appId: APP.appId,
      clientId: APP.clientId,
      botName: 'Canopy Bot',
      teamId: GRANT.teamId,
      teamName: GRANT.teamName,
      botUserId: GRANT.botUserId,
      connectedByUserId: ADA.id,
      createdAt: new Date(NOW_MS),
      configTokenAddedAt: new Date(NOW_MS),
      installedAt: new Date(NOW_MS),
      stateHash: null,
      stateUserId: null,
      stateExpiresAt: null,
    });
    http.vault.set(configTokenRef(ADA.id), REFRESH);
    expect(await http.replace(undefined, GRACE)).toMatchObject({
      status: 409,
      body: { error: 'public-origin-not-https' },
    });
    expect(http.trail).toEqual(['store:current']);
    expect(http.slack.calls).toEqual([]);
    expect(http.vaultCalls).toEqual([]);
    expect(onlyRow(http).connectedByUserId).toBe(ADA.id);
    expect([...w.lines, ...http.lines]).toEqual([]);
  });

  it('Slack refusing the pasted token → 502 slack-refresh-token; anything else at the try → 502 slack-error; nothing is stored, the row is unchanged, and the old token still renames', async () => {
    const rotate = (code: string, retryAfterMs?: number): SlackApiError =>
      new SlackApiError('tooling.tokens.rotate', code, retryAfterMs);
    const cases: Array<[unknown, string]> = [
      // Slack refusing the pasted token itself: only a new one helps.
      ...['invalid_refresh_token', 'invalid_auth', 'token_revoked', 'account_inactive'].map(
        (code): [unknown, string] => [rotate(code), 'slack-refresh-token'],
      ),
      // Anything else: Slack may or may not have spent it, and a retry soon after may work.
      ...['timeout', 'network', 'http-503', 'bad-response'].map((code): [unknown, string] => [rotate(code), 'slack-error']),
      [rotate('ratelimited', 60_000), 'slack-error'],
      [new Error('not a Slack answer'), 'slack-error'],
    ];
    for (const [err, error] of cases) {
      const { w, installId } = await connectedWorld();
      const before = { ...onlyRow(w) };
      const rotateAsSlack = w.slack.on.rotateConfigToken;
      failRotate(w, err);
      const mark = w.trail.length;
      const res = await w.replace(undefined, GRACE);
      const label = String(err);
      expect(res.status, label).toBe(502);
      expect(res.body, label).toStrictEqual({ error });
      expect(w.trail.slice(mark), label).toEqual(ONE_REPLACE.slice(0, STOPS_AFTER['try-refresh-token']));
      expect(w.vault.get(configTokenRef(ADA.id)), label).toBe(mintedRefresh(1));
      expect(onlyRow(w), label).toEqual(before);
      expect(w.lines, label).toEqual([
        {
          level: err instanceof SlackApiError ? 'warn' : 'error',
          msg: 'slack_admin_failed',
          fields: { installId, stage: 'try-refresh-token', code: err instanceof SlackApiError ? err.code : 'unknown' },
        },
      ]);

      // The token Ada added still works: the replace never read or rotated it.
      w.slack.on.rotateConfigToken = rotateAsSlack;
      expect(await w.rename(), label).toMatchObject({ status: 200, body: { botName: 'Ada Helper' } });
      expect(rotatedTokens(w), label).toEqual([REFRESH, SECOND_REFRESH, mintedRefresh(1)]);
    }
  });

  it("Slack refusing the check: a token that can't manage or can't see this app → 502 slack-not-app-manager, never slack-app-gone; a dead token → slack-refresh-token; anything else → slack-error; nothing is stored and the old token still renames", async () => {
    const update = (code: string, retryAfterMs?: number): SlackApiError =>
      new SlackApiError('apps.manifest.update', code, retryAfterMs);
    const cases: Array<[unknown, string]> = [
      // Alive, but its owner can't manage this app, or can't see it (another
      // workspace, or gone: a new token can't tell those apart).
      ...['no_permission', 'app_not_owned_by_manager_app', 'app_not_found'].map(
        (code): [unknown, string] => [update(code), 'slack-not-app-manager'],
      ),
      // The access token the pasted one minted is no good.
      ...['invalid_auth', 'token_revoked'].map((code): [unknown, string] => [update(code), 'slack-refresh-token']),
      ...['invalid_manifest', 'timeout', 'http-500'].map((code): [unknown, string] => [update(code), 'slack-error']),
      [update('ratelimited', 60_000), 'slack-error'],
      [new Error('not a Slack answer'), 'slack-error'],
    ];
    for (const [err, error] of cases) {
      const { w, installId } = await connectedWorld();
      const before = { ...onlyRow(w) };
      w.slack.on.updateApp = async () => {
        throw err;
      };
      const mark = w.trail.length;
      const res = await w.replace(undefined, GRACE);
      const label = String(err);
      expect(res.status, label).toBe(502);
      expect(res.body, label).toStrictEqual({ error });
      expect(w.trail.slice(mark), label).toEqual(ONE_REPLACE.slice(0, STOPS_AFTER['check-app']));
      // Slack refused the new token for this app, so the one Ada added stays.
      expect(w.vault.get(configTokenRef(ADA.id)), label).toBe(mintedRefresh(1));
      expect(onlyRow(w), label).toEqual(before);
      expect(w.lines, label).toEqual([
        {
          level: err instanceof SlackApiError ? 'warn' : 'error',
          msg: 'slack_admin_failed',
          fields: { installId, stage: 'check-app', code: err instanceof SlackApiError ? err.code : 'unknown' },
        },
      ]);

      w.slack.on.updateApp = async () => {};
      expect(await w.rename(), label).toMatchObject({ status: 200, body: { botName: 'Ada Helper' } });
      expect(rotatedTokens(w), label).toEqual([REFRESH, SECOND_REFRESH, mintedRefresh(1)]);
      expect(w.vault.get(configTokenRef(ADA.id)), label).toBe(mintedRefresh(3));
    }
  });

  it('storing the minted token failing → 500 internal: the old token and the row stay, one error line; a retry while Slack still honours the pasted token lands', async () => {
    const { w, installId } = await connectedWorld();
    const before = { ...onlyRow(w) };
    w.vaultFailures.set('credentials:set config-refresh-token', connectionReset());
    const mark = w.trail.length;
    expect(await w.replace(undefined, GRACE)).toMatchObject({ status: 500, body: { error: 'internal' } });
    expect(w.trail.slice(mark)).toEqual(ONE_REPLACE.slice(0, STOPS_AFTER['save-config-token']));
    expect(w.vault.get(configTokenRef(ADA.id))).toBe(mintedRefresh(1));
    expect(onlyRow(w)).toEqual(before);
    expect(w.lines).toEqual([
      { level: 'error', msg: 'slack_admin_failed', fields: { installId, stage: 'save-config-token', code: 'ECONNRESET' } },
    ]);

    // While Slack still honours the pasted token, pasting it again lands.
    w.vaultFailures.delete('credentials:set config-refresh-token');
    w.slack.rotatedStillWork = true;
    w.advance(60_000);
    expect(await w.replace(undefined, GRACE)).toMatchObject({ status: 200, body: {} });
    expect(w.vault.get(configTokenRef(ADA.id))).toBe(mintedRefresh(3));
    // Still Ada's app (TASK-1175): only the date moves.
    expect(onlyRow(w)).toMatchObject({ connectedByUserId: ADA.id, configTokenAddedAt: new Date(NOW_MS + 60_000) });
  });

  it('the row write failing after the store → 500 internal; the vault holds the new token (Slack took it for this app) and the row still names Ada', async () => {
    const { w, installId } = await connectedWorld();
    const before = { ...onlyRow(w) };
    w.memory.failures.set('setConfigTokenAddedAt', connectionReset());
    const mark = w.trail.length;
    expect(await w.replace(undefined, GRACE)).toMatchObject({ status: 500, body: { error: 'internal' } });
    // Not taken back: Slack just accepted it for this app, and the token it was minted from is spent.
    expect(w.trail.slice(mark)).toEqual(ONE_REPLACE.slice(0, STOPS_AFTER['save-added-at']));
    expect(w.vault.get(configTokenRef(ADA.id))).toBe(mintedRefresh(2));
    expect(onlyRow(w)).toEqual(before);
    expect(w.lines).toEqual([
      { level: 'error', msg: 'slack_admin_failed', fields: { installId, stage: 'save-added-at', code: 'ECONNRESET' } },
    ]);

    // The install keeps a working token: only the date "Added by" shows is stale.
    w.memory.failures.delete('setConfigTokenAddedAt');
    expect(await w.rename()).toMatchObject({ status: 200, body: { botName: 'Ada Helper' } });
    expect(rotatedTokens(w).at(-1)).toBe(mintedRefresh(2));
  });

  it('R7 the install removed meanwhile (a reset takes no admin lock) → 409 not-connected; the token just stored goes, unless a leftover app still names the person', async () => {
    // Removed just before the date is written.
    const { w, installId } = await connectedWorld();
    const setAddedAt = w.memory.store.setConfigTokenAddedAt.bind(w.memory.store);
    w.memory.store.setConfigTokenAddedAt = async (id, addedAt) => {
      w.memory.rows.clear();
      return setAddedAt(id, addedAt);
    };
    const mark = w.trail.length;
    expect(await w.replace(undefined, GRACE)).toMatchObject({ status: 409, body: { error: 'not-connected' } });
    // Nothing names Ada any more: her token goes.
    expect(w.trail.slice(mark)).toEqual([
      ...ONE_REPLACE.slice(0, STOPS_AFTER['save-added-at']),
      'store:personHasApps',
      'vault:delete config-refresh-token',
    ]);
    expect(w.memory.calls.slice(-2)).toEqual([
      { method: 'setConfigTokenAddedAt', args: [installId, new Date(NOW_MS)] },
      { method: 'personHasApps', args: [ADA.id] },
    ]);
    expect(w.vault.has(configTokenRef(ADA.id))).toBe(false);
    expect(w.lines).toEqual([]);

    // The same race for real: a reset removes the install while Slack checks the token.
    const { w: raced, installId: racedId } = await connectedWorld();
    raced.slack.on.updateApp = async () => {
      await raced.memory.store.removeAll();
    };
    expect(await raced.replace(undefined, GRACE)).toMatchObject({ status: 409, body: { error: 'not-connected' } });
    expect(raced.memory.calls.slice(-2)).toEqual([
      { method: 'setConfigTokenAddedAt', args: [racedId, new Date(NOW_MS)] },
      { method: 'personHasApps', args: [ADA.id] },
    ]);
    expect(raced.trail.at(-1)).toBe('vault:delete config-refresh-token');
    expect(raced.vault.has(configTokenRef(ADA.id))).toBe(false);
    expect(raced.lines).toEqual([]);

    // An app Ada made is still left over: it names her, so her token stays, for it.
    const kept = await connectedWorld();
    leaveApp(kept.w, LEFT_1, 'Canopy Bot', NOW_MS - 60_000, ADA.id);
    kept.w.slack.on.updateApp = async () => {
      await kept.w.memory.store.removeAll();
    };
    expect(await kept.w.replace(undefined, GRACE)).toMatchObject({ status: 409, body: { error: 'not-connected' } });
    expect(kept.w.trail.at(-1)).toBe('store:personHasApps');
    expect(kept.w.vault.get(configTokenRef(ADA.id))).toBe(mintedRefresh(2));
    // The 409 comes before the leftover pass: the app is still listed.
    expect([...kept.w.memory.leftovers.keys()]).toEqual([LEFT_1.installId]);
    expect(kept.w.lines).toEqual([]);
  });

  it('leftover apps go with the minted access token after the replace, and are forgotten; a refusal keeps one and a list fault is logged, and neither changes the 200', async () => {
    // Both deleted with the access token the replace's rotate minted, once the replace is done.
    const { w, installId } = await connectedWorld();
    leaveApp(w, LEFT_1, 'First Bot', NOW_MS - 120_000);
    leaveApp(w, LEFT_2, 'Second Bot');
    const mark = w.trail.length;
    expect(await w.replace(undefined, GRACE)).toMatchObject({ status: 200, body: {} });
    expect(w.trail.slice(mark)).toEqual([
      ...ONE_REPLACE,
      'slack:deleteApp',
      'store:forgetLeftoverApp',
      'slack:deleteApp',
      'store:forgetLeftoverApp',
    ]);
    expect(w.slack.calls.filter((c) => c.method === 'deleteApp').map((c) => c.args)).toEqual([
      [MINTED_ACCESS, LEFT_1.appId],
      [MINTED_ACCESS, LEFT_2.appId],
    ]);
    expect(w.memory.leftovers.size).toBe(0);
    expect(w.lines).toEqual([
      { level: 'info', msg: 'slack_config_token_replaced', fields: { installId } },
      { level: 'info', msg: 'slack_leftover_app_deleted', fields: { installId: LEFT_1.installId } },
      { level: 'info', msg: 'slack_leftover_app_deleted', fields: { installId: LEFT_2.installId } },
    ]);

    // Slack refusing one: it stays listed, logged under its own install id, and the next one still goes.
    const refused = await connectedWorld();
    leaveApp(refused.w, LEFT_1, 'First Bot', NOW_MS - 120_000);
    leaveApp(refused.w, LEFT_2, 'Second Bot');
    refused.w.slack.on.deleteApp = async (_token, appId) => {
      if (appId === LEFT_1.appId) throw new SlackApiError('apps.manifest.delete', 'no_permission');
    };
    expect(await refused.w.replace(undefined, GRACE)).toMatchObject({ status: 200, body: {} });
    expect([...refused.w.memory.leftovers.keys()]).toEqual([LEFT_1.installId]);
    expect(refused.w.vault.get(configTokenRef(ADA.id))).toBe(mintedRefresh(2));
    expect(onlyRow(refused.w).connectedByUserId).toBe(ADA.id);
    expect(refused.w.lines).toEqual([
      { level: 'info', msg: 'slack_config_token_replaced', fields: { installId: refused.installId } },
      {
        level: 'warn',
        msg: 'slack_admin_failed',
        fields: { installId: LEFT_1.installId, stage: 'delete-leftover-app', code: 'no_permission' },
      },
      { level: 'info', msg: 'slack_leftover_app_deleted', fields: { installId: LEFT_2.installId } },
    ]);

    // Reading the list failing: logged, and the replace stands.
    const listFault = await connectedWorld();
    leaveApp(listFault.w, LEFT_1);
    listFault.w.memory.failures.set('leftoverApps', connectionReset());
    expect(await listFault.w.replace(undefined, GRACE)).toMatchObject({ status: 200, body: {} });
    expect(slackMethods(listFault.w)).not.toContain('deleteApp');
    expect(listFault.w.vault.get(configTokenRef(ADA.id))).toBe(mintedRefresh(2));
    expect(onlyRow(listFault.w)).toMatchObject({ connectedByUserId: ADA.id, configTokenAddedAt: new Date(NOW_MS) });
    expect(listFault.w.lines).toEqual([
      { level: 'info', msg: 'slack_config_token_replaced', fields: { installId: listFault.installId } },
      {
        level: 'error',
        msg: 'slack_admin_failed',
        fields: { installId: listFault.installId, stage: 'leftover-apps', code: 'ECONNRESET' },
      },
    ]);
  });

  it("two replaces at once take turns: the second finds the pasted token spent and answers 502 slack-refresh-token; the first one's token stays", async () => {
    const { w, installId } = await connectedWorld();
    const gate = deferred();
    w.slack.on.updateApp = async () => {
      await gate.promise;
    };
    const mark = w.trail.length;
    const one = w.replace(undefined, GRACE);
    const two = w.replace(undefined, ADA);
    await settle();
    gate.resolve();
    expect(await one).toMatchObject({ status: 200, body: {} });
    expect(await two).toMatchObject({ status: 502, body: { error: 'slack-refresh-token' } });
    // One at a time: the second read the row only once the first was done, then Slack refused the spent token.
    expect(w.trail.slice(mark)).toEqual([...ONE_REPLACE, 'store:current', 'slack:rotateConfigToken']);
    expect(w.vault.get(configTokenRef(ADA.id))).toBe(mintedRefresh(2));
    expect(onlyRow(w).connectedByUserId).toBe(ADA.id);
    expect(w.lines).toEqual([
      { level: 'info', msg: 'slack_config_token_replaced', fields: { installId } },
      {
        level: 'warn',
        msg: 'slack_admin_failed',
        fields: { installId, stage: 'try-refresh-token', code: 'invalid_refresh_token' },
      },
    ]);
  });

  it('a replace started while a Disconnect is in flight waits for it, then answers 409 not-connected and stores nothing', async () => {
    const { w } = await connectedWorld();
    const deleting = deferred();
    w.slack.on.deleteApp = async () => {
      await deleting.promise;
    };
    const mark = w.trail.length;
    const disconnected = w.disconnect();
    const replaced = w.replace(undefined, GRACE);
    await settle();
    deleting.resolve();
    expect(await disconnected).toMatchObject({ status: 200, body: { appDeleted: true } });
    expect(await replaced).toMatchObject({ status: 409, body: { error: 'not-connected' } });
    // The whole Disconnect, then the replace's one step: a store read.
    expect(w.trail.slice(mark)).toEqual([
      'store:current',
      'vault:get config-refresh-token',
      'slack:rotateConfigToken',
      'vault:set config-refresh-token',
      'slack:deleteApp',
      'store:remove',
      ...SECRET_NAMES.map((n) => `vault:delete ${n}`),
      'store:personHasApps',
      'vault:delete config-refresh-token',
      'store:current',
    ]);
    expect(rotatedTokens(w)).not.toContain(SECOND_REFRESH);
    expect(w.vaultAs.filter((v) => v.userId === GRACE.id)).toEqual([]);
    expect(w.memory.rows.size).toBe(0);
    expect(w.vault.size).toBe(0);
    expect(w.lines.filter((l) => l.msg === 'slack_admin_failed')).toEqual([]);
  });
});

describe('every configuration-token use goes through its person (TASK-1175)', () => {
  it("R3 every configuration-token vault call names the person in its ref, and none goes to an install's own ref", async () => {
    // Ada's Connect and Allow, her Rename, Grace's Replace, Grace's Rename, Grace's Disconnect.
    const { w, installId } = await connectedWorld();
    expect((await w.rename()).status).toBe(200);
    expect((await w.replace({ refreshToken: SECOND_REFRESH }, GRACE)).status).toBe(200);
    expect((await w.rename({ botName: 'Grace Helper' }, GRACE)).status).toBe(200);
    expect((await w.disconnect(GRACE)).body).toEqual({ appDeleted: true });

    const personal = w.vaultCalls.flatMap((c, i) =>
      c.ref.startsWith('slack:person:') ? [{ ...c, as: w.vaultAs[i]!.userId }] : [],
    );
    // Every kind of use, so the check below can't pass by finding none.
    expect(personal.map((c) => c.hook)).toEqual([
      'credentials:set', // Connect
      'credentials:get', // Ada's Rename
      'credentials:set',
      'credentials:set', // Grace's Replace
      'credentials:get', // Grace's Rename
      'credentials:set',
      'credentials:get', // Disconnect
      'credentials:set',
      'credentials:delete', // nothing names Ada any more
    ]);
    for (const c of personal) {
      const named = c.ref.slice('slack:person:'.length, c.ref.length - ':config-refresh-token'.length);
      expect(c.as, `${c.hook} ${c.ref}`).toBe(named);
    }
    // All of it Ada's: her app, whoever acted.
    expect(new Set(personal.map((c) => c.ref))).toEqual(new Set(['slack:person:usr_ada:config-refresh-token']));
    // The install's own ref is never read or written: only Disconnect's sweep deletes it (an old row's).
    const own = secretRef(installId, 'config-refresh-token');
    expect(w.vaultCalls.filter((c) => c.ref === own)).toEqual([{ hook: 'credentials:delete', ref: own }]);
  });

  it("R4 Disconnect keeps the person's token while a leftover or another install names them, and drops it when nothing does", async () => {
    // A dead stored token: Slack can't delete the app, so it is left over,
    // naming Ada, whoever disconnects. Her token stays, for it.
    const { w: dead, installId: deadId } = await connectedWorld();
    failRotate(dead, new SlackApiError('tooling.tokens.rotate', 'invalid_refresh_token'));
    expect(await dead.disconnect(GRACE)).toMatchObject({ status: 200, body: { appDeleted: false } });
    expect([...dead.memory.leftovers.values()]).toEqual([
      { installId: deadId, appId: APP.appId, botName: 'Canopy Bot', leftAt: expect.any(Date), connectedByUserId: ADA.id },
    ]);
    expect(dead.vault).toEqual(new Map([[configTokenRef(ADA.id), mintedRefresh(1)]]));

    // Another install of Ada's (a second, unfinished one) names her: her token stays.
    const { w: two } = await connectedWorld();
    const otherId = 'BBBBBBBBBBBBBBBBBBBBBB';
    two.memory.rows.set(otherId, {
      ...onlyRow(two),
      installId: otherId,
      status: 'pending',
      appId: SECOND_APP_ID,
      teamId: null,
      teamName: null,
      botUserId: null,
      installedAt: null,
      createdAt: new Date(NOW_MS + 60_000),
      configTokenAddedAt: new Date(NOW_MS + 60_000),
    });
    let mark = two.trail.length;
    expect(await two.disconnect()).toMatchObject({ status: 200, body: { appDeleted: true } });
    // The check, and no delete after it.
    expect(two.trail.slice(mark)).toEqual([
      'store:current',
      'vault:get config-refresh-token',
      'slack:rotateConfigToken',
      'vault:set config-refresh-token',
      'slack:deleteApp',
      'store:remove',
      ...SECRET_NAMES.map((n) => `vault:delete ${n}`),
      'store:personHasApps',
    ]);
    expect([...two.memory.rows.keys()]).toEqual([otherId]);
    // The successor of the token Disconnect rotated.
    expect(two.vault).toEqual(new Map([[configTokenRef(ADA.id), mintedRefresh(2)]]));

    // Nothing names Ada any more (a leftover from before TASK-1175 names no
    // one): her token goes, after the row and the install's own secrets.
    const { w: last } = await connectedWorld();
    leaveApp(last, LEFT_1);
    mark = last.trail.length;
    expect(await last.disconnect()).toMatchObject({ status: 200, body: { appDeleted: true } });
    expect(last.trail.slice(mark)).toEqual([
      'store:current',
      'vault:get config-refresh-token',
      'slack:rotateConfigToken',
      'vault:set config-refresh-token',
      'slack:deleteApp',
      'store:remove',
      ...SECRET_NAMES.map((n) => `vault:delete ${n}`),
      'store:personHasApps',
      'vault:delete config-refresh-token',
    ]);
    expect(last.vault.size).toBe(0);
  });

  it("R4 a check that fails keeps the person's token: Disconnect still answers, and says so in one line, code-only", async () => {
    const { w, installId } = await connectedWorld();
    w.memory.failures.set('personHasApps', Object.assign(new Error(`relation gone ${REFRESH}`), { code: '42P01' }));
    expect(await w.disconnect()).toMatchObject({ status: 200, body: { appDeleted: true } });
    // Unknown whether anything still needs it, so it stays.
    expect(w.vault).toEqual(new Map([[configTokenRef(ADA.id), mintedRefresh(2)]]));
    expect(w.lines).toEqual([
      { level: 'error', msg: 'slack_admin_failed', fields: { installId, stage: 'release-config-token', code: '42P01' } },
      { level: 'info', msg: 'slack_disconnected', fields: { installId, appDeleted: true } },
    ]);
  });

  it('R5 Connect by an admin whose id cannot name a secret: 500 before Slack is asked anything, so no app is made and the pasted pair is never spent', async () => {
    const w = world();
    // `@` is fine in a vault user id but not in a ref. No AX id looks like this; only a hand-made one could.
    const odd: TestUser = { id: 'ada@example.com', displayName: 'Ada', email: 'ada@example.com', isAdmin: true };
    w.users.set(odd.id, { ...odd });
    // An app of theirs left over: not even it is tried with their pasted token.
    leaveApp(w, LEFT_1, 'Canopy Bot', NOW_MS - 60_000, odd.id);
    expect(await w.connect(CONNECT_BODY, odd)).toMatchObject({ status: 500, body: { error: 'internal' } });
    expect(w.slack.calls).toEqual([]);
    expect(w.vaultCalls).toEqual([]);
    expect(w.trail).toEqual(['store:current']);
    expect(w.memory.rows.size).toBe(0);
    expect([...w.memory.leftovers.keys()]).toEqual([LEFT_1.installId]);
    // Code-only, and never the id: there is no install to name yet.
    expect(w.lines).toEqual([
      { level: 'error', msg: 'slack_admin_failed', fields: { stage: 'connect', code: 'invalid-person-id' } },
    ]);
    // Anyone else can still connect.
    expect((await w.connect(CONNECT_BODY, GRACE)).status).toBe(200);
  });

  it("R6 Connect's undo after the token was stored drops it when nothing else names the person, keeps it when a leftover does", async () => {
    // Nothing else names Ada: her token goes with the rest.
    const drops = world();
    drops.memory.failures.set('setOAuthState', connectionReset());
    expect(await drops.connect()).toMatchObject({ status: 500, body: { error: 'internal' } });
    expect(drops.trail.slice(-2)).toEqual(['store:personHasApps', 'vault:delete config-refresh-token']);
    expect(drops.memory.rows.size).toBe(0);
    expect(drops.vault.size).toBe(0);

    // An app Ada made earlier is still left over (Slack wouldn't delete it at
    // this Connect's pass): it names her, so her token stays, for it.
    const keeps = world();
    leaveApp(keeps, LEFT_1, 'Canopy Bot', NOW_MS - 60_000, ADA.id);
    keeps.slack.on.deleteApp = async (_token, appId) => {
      if (appId === LEFT_1.appId) throw new SlackApiError('apps.manifest.delete', 'no_permission');
    };
    keeps.memory.failures.set('setOAuthState', connectionReset());
    expect(await keeps.connect()).toMatchObject({ status: 500, body: { error: 'internal' } });
    // The new app was still taken back.
    expect(keeps.slack.calls.filter((c) => c.method === 'deleteApp').map((c) => c.args)).toEqual([
      [ACCESS, LEFT_1.appId],
      [ACCESS, APP.appId],
    ]);
    expect([...keeps.slack.live]).toEqual([]);
    expect(keeps.memory.rows.size).toBe(0);
    expect(keeps.trail.at(-1)).toBe('store:personHasApps');
    expect(keeps.vault).toEqual(new Map([[configTokenRef(ADA.id), mintedRefresh(1)]]));
    expect([...keeps.memory.leftovers.keys()]).toEqual([LEFT_1.installId]);
  });

  it("R7 Connect stores the person's token straight after the rotate: a client or signing secret that won't store never strands it", async () => {
    for (const name of ['client-secret', 'signing-secret'] as const) {
      // A leftover of Ada's still names her (Slack wouldn't delete it at this
      // Connect's pass), and her slot holds the token the rotate's paste
      // replaced: the minted one is now her only live token, so it must be there.
      const keeps = world();
      keeps.vault.set(configTokenRef(ADA.id), ADA_STORED);
      leaveApp(keeps, LEFT_1, 'Canopy Bot', NOW_MS - 60_000, ADA.id);
      keeps.slack.on.deleteApp = async (_token, appId) => {
        if (appId === LEFT_1.appId) throw new SlackApiError('apps.manifest.delete', 'no_permission');
      };
      keeps.vaultFailures.set(`credentials:set ${name}`, connectionReset());
      expect(await keeps.connect(), name).toMatchObject({ status: 500, body: { error: 'internal' } });
      const at = keeps.trail.indexOf('slack:rotateConfigToken');
      expect(keeps.trail.slice(at, at + 2), name).toEqual(['slack:rotateConfigToken', 'vault:set config-refresh-token']);
      expect(keeps.vault.get(configTokenRef(ADA.id)), name).toBe(mintedRefresh(1));
      // The new app was still taken back; her leftover still names her.
      expect([...keeps.slack.live], name).toEqual([]);
      expect([...keeps.memory.leftovers.keys()], name).toEqual([LEFT_1.installId]);
      expect(keeps.memory.rows.size, name).toBe(0);

      // Nothing else names her: the undo's release drops it, as it does for any later failure.
      const drops = world();
      drops.vaultFailures.set(`credentials:set ${name}`, connectionReset());
      expect(await drops.connect(), name).toMatchObject({ status: 500, body: { error: 'internal' } });
      expect(drops.trail.slice(-2), name).toEqual(['store:personHasApps', 'vault:delete config-refresh-token']);
      expect(drops.vault.size, name).toBe(0);
    }
  });
});

describe('leftover apps go with the token of whoever made them (TASK-1175)', () => {
  const rotatedTokens = (w: World): unknown[] =>
    w.slack.calls.filter((c) => c.method === 'rotateConfigToken').map((c) => c.args[0]);
  const deletes = (w: World): unknown[][] => w.slack.calls.filter((c) => c.method === 'deleteApp').map((c) => c.args);
  /** Whom each release asked about, in order: one `personHasApps` each. */
  const releaseChecks = (w: World): unknown[][] =>
    w.memory.calls.filter((c) => c.method === 'personHasApps').map((c) => c.args);
  /** Eve, a third admin with apps of her own. */
  const EVE = EMAIL_ONLY;

  it("L1 Grace's Connect deletes Ada's leftover with Ada's stored token: one rotate, the successor stored before the delete, then Ada's token goes", async () => {
    const w = world();
    w.vault.set(configTokenRef(ADA.id), ADA_STORED);
    leaveApp(w, LEFT_1, 'Canopy Bot', NOW_MS - 60_000, ADA.id);
    let adaAtDelete: string | undefined;
    w.slack.on.deleteApp = async () => {
      adaAtDelete = w.vault.get(configTokenRef(ADA.id));
    };
    expect((await w.connect(SECOND_PAIR, GRACE)).status).toBe(200);
    expect(w.trail.slice(0, 10)).toEqual([
      'store:current',
      'store:leftoverApps',
      'vault:get config-refresh-token',
      'slack:rotateConfigToken',
      'vault:set config-refresh-token',
      'slack:deleteApp',
      'store:forgetLeftoverApp',
      'store:personHasApps',
      'vault:delete config-refresh-token',
      'slack:createApp',
    ]);
    // Ada's token, rotated once; then the refresh token Grace pasted, tried by her own Connect.
    expect(rotatedTokens(w)).toEqual([ADA_STORED, SECOND_REFRESH]);
    expect(deletes(w)).toEqual([[MINTED_ACCESS, LEFT_1.appId]]);
    // The rotate retired the one it was sent: its successor was already in Ada's slot when the delete went.
    expect(adaAtDelete).toBe(mintedRefresh(1));
    // Every call on her token was in her own slot, as her: the read, the successor, then
    // (nothing names her any more) the delete.
    expect(w.vaultCalls.slice(0, 3)).toEqual([
      { hook: 'credentials:get', ref: configTokenRef(ADA.id) },
      { hook: 'credentials:set', ref: configTokenRef(ADA.id) },
      { hook: 'credentials:delete', ref: configTokenRef(ADA.id) },
    ]);
    expect(w.vaultAs.slice(0, 3).map((v) => v.userId)).toEqual([ADA.id, ADA.id, ADA.id]);
    expect(releaseChecks(w)).toEqual([[ADA.id]]);
    expect(w.vault.has(configTokenRef(ADA.id))).toBe(false);
    // Grace's own slot holds what her Connect minted from her paste.
    expect(w.vault.get(configTokenRef(GRACE.id))).toBe(mintedRefresh(2));
    expect(w.memory.leftovers.size).toBe(0);
    expect(w.lines).toEqual([
      { level: 'info', msg: 'slack_leftover_app_deleted', fields: { installId: LEFT_1.installId } },
    ]);
  });

  it("L2 two of Ada's leftovers share one rotate", async () => {
    const w = world();
    w.vault.set(configTokenRef(ADA.id), ADA_STORED);
    leaveApp(w, LEFT_1, 'First Bot', NOW_MS - 120_000, ADA.id);
    leaveApp(w, LEFT_2, 'Second Bot', NOW_MS - 60_000, ADA.id);
    expect((await w.connect(SECOND_PAIR, GRACE)).status).toBe(200);
    expect(w.trail.slice(0, 12)).toEqual([
      'store:current',
      'store:leftoverApps',
      'vault:get config-refresh-token',
      'slack:rotateConfigToken',
      'vault:set config-refresh-token',
      'slack:deleteApp',
      'store:forgetLeftoverApp',
      'slack:deleteApp',
      'store:forgetLeftoverApp',
      // Released once, after both.
      'store:personHasApps',
      'vault:delete config-refresh-token',
      'slack:createApp',
    ]);
    expect(rotatedTokens(w)).toEqual([ADA_STORED, SECOND_REFRESH]);
    expect(deletes(w)).toEqual([
      [MINTED_ACCESS, LEFT_1.appId],
      [MINTED_ACCESS, LEFT_2.appId],
    ]);
    expect(releaseChecks(w)).toEqual([[ADA.id]]);
    expect(w.memory.leftovers.size).toBe(0);
    expect(w.vault.has(configTokenRef(ADA.id))).toBe(false);
    expect(w.lines).toEqual([
      { level: 'info', msg: 'slack_leftover_app_deleted', fields: { installId: LEFT_1.installId } },
      { level: 'info', msg: 'slack_leftover_app_deleted', fields: { installId: LEFT_2.installId } },
    ]);
  });

  it("L3 an app left before TASK-1175 names no one: the token in hand tries it, as before; Ada's in the same pass gets Ada's, and Grace's own gets the one she pasted", async () => {
    const w = world();
    w.vault.set(configTokenRef(ADA.id), ADA_STORED);
    // Grace's slot holds the token her new paste ended (one per person): never read or rotated.
    w.vault.set(configTokenRef(GRACE.id), fakeConfigRefreshToken('GRACEOLDSECRET'));
    leaveApp(w, LEFT_1, 'First Bot', NOW_MS - 180_000);
    leaveApp(w, LEFT_2, 'Second Bot', NOW_MS - 120_000, ADA.id);
    leaveApp(w, LEFT_3, 'Third Bot', NOW_MS - 60_000, GRACE.id);
    expect((await w.connect(SECOND_PAIR, GRACE)).status).toBe(200);
    expect(deletes(w)).toEqual([
      [SECOND_ACCESS, LEFT_1.appId],
      [MINTED_ACCESS, LEFT_2.appId],
      [SECOND_ACCESS, LEFT_3.appId],
    ]);
    // Only Ada's token was read, and only it and Grace's paste were rotated.
    expect(w.vaultCalls.filter((c) => c.hook === 'credentials:get')).toEqual([
      { hook: 'credentials:get', ref: configTokenRef(ADA.id) },
    ]);
    expect(rotatedTokens(w)).toEqual([ADA_STORED, SECOND_REFRESH]);
    // Only Ada is released: the first app names no one, and Grace's slot is her Connect's to overwrite.
    expect(releaseChecks(w)).toEqual([[ADA.id]]);
    expect(w.vault.has(configTokenRef(ADA.id))).toBe(false);
    expect(w.vault.get(configTokenRef(GRACE.id))).toBe(mintedRefresh(2));
    expect(w.memory.leftovers.size).toBe(0);
  });

  it("L4 another person's token missing or unreadable: their apps are skipped and logged, the rest still go", async () => {
    // Missing: one read for Ada and one line, not one per app of hers.
    const missing = world();
    leaveApp(missing, LEFT_1, 'First Bot', NOW_MS - 180_000, ADA.id);
    leaveApp(missing, LEFT_2, 'Second Bot', NOW_MS - 120_000);
    leaveApp(missing, LEFT_3, 'Third Bot', NOW_MS - 60_000, ADA.id);
    expect((await missing.connect(SECOND_PAIR, GRACE)).status).toBe(200);
    expect(deletes(missing)).toEqual([[SECOND_ACCESS, LEFT_2.appId]]);
    expect(rotatedTokens(missing)).toEqual([SECOND_REFRESH]);
    expect(missing.vaultCalls.filter((c) => c.hook === 'credentials:get')).toEqual([
      { hook: 'credentials:get', ref: configTokenRef(ADA.id) },
    ]);
    expect([...missing.memory.leftovers.keys()]).toEqual([LEFT_1.installId, LEFT_3.installId]);
    // Nothing of hers went, so nothing is released.
    expect(releaseChecks(missing)).toEqual([]);
    expect(missing.lines).toEqual([
      {
        level: 'warn',
        msg: 'slack_admin_failed',
        fields: { installId: LEFT_1.installId, stage: 'leftover-config-token', code: 'missing' },
      },
      { level: 'info', msg: 'slack_leftover_app_deleted', fields: { installId: LEFT_2.installId } },
    ]);

    // Unreadable: the vault faulting. Her token stays as it was, unrotated.
    const fault = world();
    fault.vault.set(configTokenRef(ADA.id), ADA_STORED);
    leaveApp(fault, LEFT_1, 'First Bot', NOW_MS - 120_000, ADA.id);
    leaveApp(fault, LEFT_2, 'Second Bot', NOW_MS - 60_000);
    fault.vaultFailures.set('credentials:get config-refresh-token', connectionReset());
    expect((await fault.connect(SECOND_PAIR, GRACE)).status).toBe(200);
    expect(deletes(fault)).toEqual([[SECOND_ACCESS, LEFT_2.appId]]);
    expect(rotatedTokens(fault)).toEqual([SECOND_REFRESH]);
    expect(fault.vault.get(configTokenRef(ADA.id))).toBe(ADA_STORED);
    expect([...fault.memory.leftovers.keys()]).toEqual([LEFT_1.installId]);
    expect(fault.lines).toEqual([
      {
        level: 'error',
        msg: 'slack_admin_failed',
        fields: { installId: LEFT_1.installId, stage: 'leftover-config-token', code: 'ECONNRESET' },
      },
      { level: 'info', msg: 'slack_leftover_app_deleted', fields: { installId: LEFT_2.installId } },
    ]);

    // A person id that can't name a ref (no AX id looks like this; only a
    // hand-made row could): refused before the vault is asked anything.
    const odd = world();
    leaveApp(odd, LEFT_1, 'First Bot', NOW_MS - 120_000, 'ada@example.com');
    leaveApp(odd, LEFT_2, 'Second Bot', NOW_MS - 60_000);
    expect((await odd.connect(SECOND_PAIR, GRACE)).status).toBe(200);
    expect(deletes(odd)).toEqual([[SECOND_ACCESS, LEFT_2.appId]]);
    // Not one vault call before Grace's own Connect stores her secrets.
    const beforeCreate = odd.trail.slice(0, odd.trail.indexOf('slack:createApp'));
    expect(beforeCreate.filter((t) => t.startsWith('vault:'))).toEqual([]);
    expect([...odd.memory.leftovers.keys()]).toEqual([LEFT_1.installId]);
    expect(odd.lines).toEqual([
      {
        level: 'error',
        msg: 'slack_admin_failed',
        fields: { installId: LEFT_1.installId, stage: 'leftover-config-token', code: 'invalid-person-id' },
      },
      { level: 'info', msg: 'slack_leftover_app_deleted', fields: { installId: LEFT_2.installId } },
    ]);
  });

  it("L5 another person's token refused at the rotate skips only their apps; Slack not answering (timeout) ends the pass, and Connect still creates its app", async () => {
    // Refused (say Ada revoked it on Slack's page): tried once, her apps stay, the rest still go.
    const refused = world();
    refused.vault.set(configTokenRef(ADA.id), ADA_STORED);
    leaveApp(refused, LEFT_1, 'First Bot', NOW_MS - 180_000, ADA.id);
    leaveApp(refused, LEFT_2, 'Second Bot', NOW_MS - 120_000);
    leaveApp(refused, LEFT_3, 'Third Bot', NOW_MS - 60_000, ADA.id);
    failRotateOf(refused, ADA_STORED, new SlackApiError('tooling.tokens.rotate', 'invalid_refresh_token'));
    expect((await refused.connect(SECOND_PAIR, GRACE)).status).toBe(200);
    expect(rotatedTokens(refused)).toEqual([ADA_STORED, SECOND_REFRESH]);
    expect(deletes(refused)).toEqual([[SECOND_ACCESS, LEFT_2.appId]]);
    expect([...refused.memory.leftovers.keys()]).toEqual([LEFT_1.installId, LEFT_3.installId]);
    // Nothing replaced it and her apps still name her: her slot is as it was.
    expect(refused.vault.get(configTokenRef(ADA.id))).toBe(ADA_STORED);
    expect(releaseChecks(refused)).toEqual([]);
    expect(refused.lines).toEqual([
      {
        level: 'warn',
        msg: 'slack_admin_failed',
        fields: { installId: LEFT_1.installId, stage: 'leftover-rotate', code: 'invalid_refresh_token' },
      },
      { level: 'info', msg: 'slack_leftover_app_deleted', fields: { installId: LEFT_2.installId } },
    ]);

    // Slack not answering: every later call would wait out the same deadline
    // under the admin lock, so the pass ends there. Ada's app, already gone,
    // still releases her token; Eve's stays, for hers.
    const slow = world();
    slow.vault.set(configTokenRef(ADA.id), ADA_STORED);
    slow.vault.set(configTokenRef(EVE.id), EVE_STORED);
    leaveApp(slow, LEFT_1, 'First Bot', NOW_MS - 180_000, ADA.id);
    leaveApp(slow, LEFT_2, 'Second Bot', NOW_MS - 120_000, EVE.id);
    leaveApp(slow, LEFT_3, 'Third Bot', NOW_MS - 60_000);
    failRotateOf(slow, EVE_STORED, new SlackApiError('tooling.tokens.rotate', 'timeout'));
    expect((await slow.connect(SECOND_PAIR, GRACE)).status).toBe(200);
    expect(slow.trail.slice(0, 12)).toEqual([
      'store:current',
      'store:leftoverApps',
      'vault:get config-refresh-token',
      'slack:rotateConfigToken',
      'vault:set config-refresh-token',
      'slack:deleteApp',
      'store:forgetLeftoverApp',
      'vault:get config-refresh-token',
      'slack:rotateConfigToken',
      'store:personHasApps',
      'vault:delete config-refresh-token',
      'slack:createApp',
    ]);
    // The app that names no one was never tried.
    expect(deletes(slow)).toEqual([[MINTED_ACCESS, LEFT_1.appId]]);
    expect(slackMethods(slow).filter((m) => m === 'createApp')).toHaveLength(1);
    expect([...slow.memory.leftovers.keys()]).toEqual([LEFT_2.installId, LEFT_3.installId]);
    expect(releaseChecks(slow)).toEqual([[ADA.id]]);
    expect(slow.vault.has(configTokenRef(ADA.id))).toBe(false);
    expect(slow.vault.get(configTokenRef(EVE.id))).toBe(EVE_STORED);
    expect(slow.lines).toEqual([
      { level: 'info', msg: 'slack_leftover_app_deleted', fields: { installId: LEFT_1.installId } },
      {
        level: 'warn',
        msg: 'slack_admin_failed',
        fields: { installId: LEFT_2.installId, stage: 'leftover-rotate', code: 'timeout' },
      },
    ]);
  });

  it("L6 the token in hand refused (invalid_auth) skips only its own apps; another person's still go; and the other way round", async () => {
    const w = world();
    w.vault.set(configTokenRef(ADA.id), ADA_STORED);
    leaveApp(w, LEFT_1, 'First Bot', NOW_MS - 180_000);
    leaveApp(w, LEFT_2, 'Second Bot', NOW_MS - 120_000, ADA.id);
    leaveApp(w, LEFT_3, 'Third Bot', NOW_MS - 60_000);
    w.slack.on.deleteApp = async (token) => {
      if (token === SECOND_ACCESS) throw new SlackApiError('apps.manifest.delete', 'invalid_auth');
    };
    expect((await w.connect(SECOND_PAIR, GRACE)).status).toBe(200);
    // The pasted token is refused at its first app, so its other one isn't tried. Ada's goes with hers.
    expect(deletes(w)).toEqual([
      [SECOND_ACCESS, LEFT_1.appId],
      [MINTED_ACCESS, LEFT_2.appId],
    ]);
    expect([...w.memory.leftovers.keys()]).toEqual([LEFT_1.installId, LEFT_3.installId]);
    expect(w.vault.has(configTokenRef(ADA.id))).toBe(false);
    expect(w.lines).toEqual([
      {
        level: 'warn',
        msg: 'slack_admin_failed',
        fields: { installId: LEFT_1.installId, stage: 'delete-leftover-app', code: 'invalid_auth' },
      },
      { level: 'info', msg: 'slack_leftover_app_deleted', fields: { installId: LEFT_2.installId } },
    ]);

    // The access token minted from Ada's refused at her first app: her second
    // isn't tried, and the one that names no one still goes with the token in hand.
    const theirs = world();
    theirs.vault.set(configTokenRef(ADA.id), ADA_STORED);
    leaveApp(theirs, LEFT_1, 'First Bot', NOW_MS - 180_000, ADA.id);
    leaveApp(theirs, LEFT_2, 'Second Bot', NOW_MS - 120_000);
    leaveApp(theirs, LEFT_3, 'Third Bot', NOW_MS - 60_000, ADA.id);
    theirs.slack.on.deleteApp = async (token) => {
      if (token === MINTED_ACCESS) throw new SlackApiError('apps.manifest.delete', 'token_revoked');
    };
    expect((await theirs.connect(SECOND_PAIR, GRACE)).status).toBe(200);
    expect(deletes(theirs)).toEqual([
      [MINTED_ACCESS, LEFT_1.appId],
      [SECOND_ACCESS, LEFT_2.appId],
    ]);
    expect(rotatedTokens(theirs)).toEqual([ADA_STORED, SECOND_REFRESH]);
    expect([...theirs.memory.leftovers.keys()]).toEqual([LEFT_1.installId, LEFT_3.installId]);
    // Her apps still name her: the successor stays in her slot.
    expect(theirs.vault.get(configTokenRef(ADA.id))).toBe(mintedRefresh(1));
    expect(releaseChecks(theirs)).toEqual([]);
    expect(theirs.lines).toEqual([
      {
        level: 'warn',
        msg: 'slack_admin_failed',
        fields: { installId: LEFT_1.installId, stage: 'delete-leftover-app', code: 'token_revoked' },
      },
      { level: 'info', msg: 'slack_leftover_app_deleted', fields: { installId: LEFT_2.installId } },
    ]);
  });

  it("L7 saving another person's successor failing still deletes with the minted token: one error line, and no throw", async () => {
    const w = world();
    w.vault.set(configTokenRef(ADA.id), ADA_STORED);
    leaveApp(w, LEFT_1, 'Canopy Bot', NOW_MS - 60_000, ADA.id);
    // Ada's slot only: Grace's own Connect still stores hers.
    w.vaultFailures.set(`credentials:set ${configTokenRef(ADA.id)}`, connectionReset());
    expect((await w.connect(SECOND_PAIR, GRACE)).status).toBe(200);
    expect(deletes(w)).toEqual([[MINTED_ACCESS, LEFT_1.appId]]);
    expect(w.memory.leftovers.size).toBe(0);
    expect(w.lines).toEqual([
      {
        level: 'error',
        msg: 'slack_admin_failed',
        fields: { installId: LEFT_1.installId, stage: 'save-config-token', code: 'ECONNRESET' },
      },
      { level: 'info', msg: 'slack_leftover_app_deleted', fields: { installId: LEFT_1.installId } },
    ]);
    // Nothing names Ada any more: what her slot still held (the token the rotate retired) goes too.
    expect(releaseChecks(w)).toEqual([[ADA.id]]);
    expect(w.vault.has(configTokenRef(ADA.id))).toBe(false);
    expect(w.vault.get(configTokenRef(GRACE.id))).toBe(mintedRefresh(2));
    expect(onlyRow(w)).toMatchObject({ status: 'pending', connectedByUserId: GRACE.id });
  });

  it('L8 "I deleted it" drops the maker\'s token once nothing names them; keeps it while their install or another leftover does', async () => {
    // Nothing else names Ada: her token goes, deleted as her, whoever says so.
    const gone = world();
    gone.vault.set(configTokenRef(ADA.id), ADA_STORED);
    leaveApp(gone, LEFT_1, 'Canopy Bot', NOW_MS - 60_000, ADA.id);
    expect(await gone.forget({ appId: LEFT_1.appId }, GRACE)).toMatchObject({ status: 200, body: {} });
    expect(gone.trail).toEqual([
      'store:leftoverApps',
      'store:forgetLeftoverApp',
      'store:personHasApps',
      'vault:delete config-refresh-token',
    ]);
    expect(gone.vaultAs).toEqual([{ hook: 'credentials:delete', name: 'config-refresh-token', userId: ADA.id }]);
    expect(gone.vault.size).toBe(0);
    expect(gone.slack.calls).toEqual([]);
    expect(gone.lines).toEqual([]);

    // Her install still names her: kept.
    const { w: installed } = await connectedWorld();
    leaveApp(installed, LEFT_1, 'Old Bot', NOW_MS - 60_000, ADA.id);
    const mark = installed.trail.length;
    expect(await installed.forget({ appId: LEFT_1.appId })).toMatchObject({ status: 200, body: {} });
    expect(installed.trail.slice(mark)).toEqual([
      'store:leftoverApps',
      'store:forgetLeftoverApp',
      'store:personHasApps',
    ]);
    expect(installed.vault.get(configTokenRef(ADA.id))).toBe(mintedRefresh(1));

    // Another leftover still names her: kept, until that one goes too.
    const two = world();
    two.vault.set(configTokenRef(ADA.id), ADA_STORED);
    leaveApp(two, LEFT_1, 'First Bot', NOW_MS - 120_000, ADA.id);
    leaveApp(two, LEFT_2, 'Second Bot', NOW_MS - 60_000, ADA.id);
    expect(await two.forget({ appId: LEFT_1.appId })).toMatchObject({ status: 200, body: {} });
    expect(two.vault.get(configTokenRef(ADA.id))).toBe(ADA_STORED);
    expect(await two.forget({ appId: LEFT_2.appId })).toMatchObject({ status: 200, body: {} });
    expect(releaseChecks(two)).toEqual([[ADA.id], [ADA.id]]);
    expect(two.vault.size).toBe(0);

    // A forget failing after an earlier one went (two entries can name one
    // app): the 500 still releases the maker whose entry went, and no one else.
    const broken = world();
    broken.vault.set(configTokenRef(ADA.id), ADA_STORED);
    broken.vault.set(configTokenRef(EVE.id), EVE_STORED);
    leaveApp(broken, LEFT_1, 'First Bot', NOW_MS - 120_000, ADA.id);
    leaveApp(broken, { installId: 'inst_left_again', appId: LEFT_1.appId }, 'First Bot', NOW_MS - 60_000, EVE.id);
    const forgetAsBefore = broken.memory.store.forgetLeftoverApp.bind(broken.memory.store);
    broken.memory.store.forgetLeftoverApp = async (installId) => {
      if (installId === 'inst_left_again') throw connectionReset();
      return forgetAsBefore(installId);
    };
    expect(await broken.forget({ appId: LEFT_1.appId })).toMatchObject({ status: 500, body: { error: 'internal' } });
    expect(releaseChecks(broken)).toEqual([[ADA.id]]);
    expect(broken.vault.has(configTokenRef(ADA.id))).toBe(false);
    expect(broken.vault.get(configTokenRef(EVE.id))).toBe(EVE_STORED);
    expect([...broken.memory.leftovers.keys()]).toEqual(['inst_left_again']);
    expect(broken.lines).toEqual([
      { level: 'error', msg: 'slack_admin_failed', fields: { stage: 'forget-leftover-app', code: 'ECONNRESET' } },
    ]);
  });

  it("L9 one token, two apps (the card's acceptance): Ada's Rename and Disconnect keep her token alive for the app Slack wouldn't delete, and Grace's Connect deletes it with that token", async () => {
    // Ada connects; an app she made earlier is still left over.
    const { w } = await connectedWorld();
    leaveApp(w, LEFT_1, 'Old Bot', NOW_MS - 60_000, ADA.id);
    expect(await w.rename()).toMatchObject({ status: 200, body: { botName: 'Ada Helper' } });
    expect(w.vault.get(configTokenRef(ADA.id))).toBe(mintedRefresh(2));
    // Disconnect deletes her install's app; the leftover still names her, so her token stays, as its successor.
    expect(await w.disconnect()).toMatchObject({ status: 200, body: { appDeleted: true } });
    expect(w.vault).toEqual(new Map([[configTokenRef(ADA.id), mintedRefresh(3)]]));

    const mark = w.slack.calls.length;
    expect((await w.connect(SECOND_PAIR, GRACE)).status).toBe(200);
    // Each use read the token the one before it saved, so the pass rotates exactly the one Disconnect kept.
    expect(rotatedTokens(w)).toEqual([REFRESH, mintedRefresh(1), mintedRefresh(2), mintedRefresh(3), SECOND_REFRESH]);
    expect(
      w.slack.calls
        .slice(mark)
        .filter((c) => c.method === 'deleteApp')
        .map((c) => c.args),
    ).toEqual([[MINTED_ACCESS, LEFT_1.appId]]);
    expect(w.memory.leftovers.size).toBe(0);
    expect(w.vault.has(configTokenRef(ADA.id))).toBe(false);
    expect(w.vault.get(configTokenRef(GRACE.id))).toBe(mintedRefresh(5));
    expect(w.lines.filter((l) => l.msg === 'slack_admin_failed')).toEqual([]);
  });

  it('L10 Replace fixes both: a token Slack refuses, replaced, renames the install again and has already deleted the app it made earlier', async () => {
    const { w } = await connectedWorld();
    leaveApp(w, LEFT_1, 'Old Bot', NOW_MS - 60_000, ADA.id);
    // Slack now refuses the token AX holds for Ada.
    failRotateOf(w, mintedRefresh(1), new SlackApiError('tooling.tokens.rotate', 'invalid_refresh_token'));
    expect(await w.rename()).toMatchObject({ status: 502, body: { error: 'slack-config-token' } });

    // Grace pastes the new token Ada generated (a hand-off): the token in hand is still Ada's.
    expect(await w.replace({ refreshToken: SECOND_REFRESH }, GRACE)).toMatchObject({ status: 200, body: {} });
    expect(deletes(w)).toEqual([[MINTED_ACCESS, LEFT_1.appId]]);
    expect(w.memory.leftovers.size).toBe(0);
    // The pass neither read nor rotated what the replace had just stored in her slot.
    expect(w.vault.get(configTokenRef(ADA.id))).toBe(mintedRefresh(2));
    expect(releaseChecks(w)).toEqual([]);

    expect(await w.rename()).toMatchObject({ status: 200, body: { botName: 'Ada Helper' } });
    expect(rotatedTokens(w)).toEqual([REFRESH, mintedRefresh(1), SECOND_REFRESH, mintedRefresh(2)]);
  });
});

describe('secrets never leave', () => {
  it('no response body or log line contains any of the four secrets, either pasted token or a token a rotate minted', async () => {
    const leak = (where: string): Error => new Error(`${where} failed: ${SECRETS.join(' ')}`);
    const worlds: World[] = [];
    const track = (w: World): World => {
      worlds.push(w);
      return w;
    };

    // The whole happy path, and every read of it.
    const happy = track((await connectedWorld()).w);
    leaveApp(happy, LEFT_1);
    await happy.status();
    await happy.installUrl();
    await happy.replace();
    await happy.rename();
    await happy.forget();
    await happy.disconnect();
    await happy.status();
    leaveApp(happy, LEFT_2);
    await happy.connect();

    // Slack refusing Connect with every secret in its error.
    const refused = track(world());
    refused.slack.on.createApp = async () => {
      throw leak('createApp');
    };
    await refused.connect();

    // A vault write failing halfway, then the undo's delete failing too.
    const halfway = track(world());
    halfway.vaultFailures.set('credentials:set config-refresh-token', leak('vault'));
    halfway.slack.on.deleteApp = async () => {
      throw leak('deleteApp');
    };
    await halfway.connect();

    // The icon refused.
    const icon = track(world());
    icon.slack.on.setAppIcon = async () => {
      throw leak('setAppIcon');
    };
    await icon.connect();

    // The callback: Slack refusing the code, then storing, then activating failing.
    const exchange = track(world());
    exchange.slack.on.oauthAccess = async () => {
      throw leak('oauthAccess');
    };
    await exchange.callback({ code: CODE, state: stateOf(await exchange.connect()) });
    exchange.slack.on.oauthAccess = async () => ({ ...GRANT });
    exchange.vaultFailures.set('credentials:set bot-token', leak('vault'));
    await exchange.callback({ code: CODE, state: stateOf(await exchange.installUrl()) });
    exchange.vaultFailures.clear();
    exchange.memory.failures.set('activate', leak('activate'));
    await exchange.callback({ code: CODE, state: stateOf(await exchange.installUrl()) });

    // Disconnect: rotate failing, then deleting failing, then the vault failing.
    const rotate = track((await connectedWorld()).w);
    rotate.slack.on.rotateConfigToken = async () => {
      throw leak('rotate');
    };
    await rotate.disconnect();
    const del = track((await connectedWorld()).w);
    del.slack.on.deleteApp = async () => {
      throw leak('deleteApp');
    };
    del.vaultFailures.set('credentials:delete bot-token', leak('vault'));
    await del.disconnect();

    // Connect's pass over the apps an earlier Disconnect couldn't delete (TASK-1132):
    // the delete failing, then the forget, then reading the list (for the status too).
    const leftoverDelete = track(world());
    leaveApp(leftoverDelete, LEFT_1);
    leftoverDelete.slack.on.deleteApp = async () => {
      throw leak('deleteApp');
    };
    await leftoverDelete.connect();
    const leftoverForget = track(world());
    leaveApp(leftoverForget, LEFT_1);
    leftoverForget.memory.failures.set('forgetLeftoverApp', leak('forget'));
    await leftoverForget.connect();
    const leftoverList = track(world());
    leftoverList.memory.failures.set('leftoverApps', leak('list'));
    await leftoverList.connect();
    await leftoverList.status();
    await leftoverList.forget();
    // "I deleted it" (TASK-1132): the forget failing.
    const forgetRoute = track(world());
    leaveApp(forgetRoute, LEFT_1);
    forgetRoute.memory.failures.set('forgetLeftoverApp', leak('forget'));
    await forgetRoute.forget();

    // Connect trying the pasted refresh token (TASK-1159): the rotate failing,
    // then taking the new app back failing, then remembering it failing.
    const connectRotate = track(world());
    failRotate(connectRotate, leak('rotate'));
    await connectRotate.connect();
    const connectUndo = track(world());
    failRotate(connectUndo, leak('rotate'));
    connectUndo.slack.on.deleteApp = async () => {
      throw leak('deleteApp');
    };
    connectUndo.memory.failures.set('rememberLeftoverApp', leak('remember'));
    await connectUndo.connect();

    // Rename: rotate failing, the update failing, the row write failing, the vault failing.
    const renameRotate = track((await connectedWorld()).w);
    renameRotate.slack.on.rotateConfigToken = async () => {
      throw leak('rotate');
    };
    await renameRotate.rename();
    const renameUpdate = track((await connectedWorld()).w);
    renameUpdate.slack.on.updateApp = async () => {
      throw leak('updateApp');
    };
    await renameUpdate.rename();
    const renameRow = track((await connectedWorld()).w);
    renameRow.memory.failures.set('setBotName', leak('setBotName'));
    await renameRow.rename();
    const renameVault = track((await connectedWorld()).w);
    renameVault.vaultFailures.set('credentials:get config-refresh-token', leak('vault'));
    await renameVault.rename();

    // Storing the refresh token a rotate minted failing: Rename stops, Disconnect deletes the app anyway.
    const renameSave = track((await connectedWorld()).w);
    renameSave.vaultFailures.set('credentials:set config-refresh-token', leak('vault'));
    await renameSave.rename();
    const disconnectSave = track((await connectedWorld()).w);
    disconnectSave.vaultFailures.set('credentials:set config-refresh-token', leak('vault'));
    await disconnectSave.disconnect();

    // Replace (TASK-1128): trying the pasted token failing, the check failing,
    // the vault failing, the row write failing, a leftover delete failing.
    const replaceRotate = track((await connectedWorld()).w);
    failRotate(replaceRotate, leak('rotate'));
    await replaceRotate.replace();
    const replaceCheck = track((await connectedWorld()).w);
    replaceCheck.slack.on.updateApp = async () => {
      throw leak('updateApp');
    };
    await replaceCheck.replace();
    const replaceSave = track((await connectedWorld()).w);
    replaceSave.vaultFailures.set('credentials:set config-refresh-token', leak('vault'));
    await replaceSave.replace();
    const replaceRow = track((await connectedWorld()).w);
    replaceRow.memory.failures.set('setConfigTokenAddedAt', leak('setConfigTokenAddedAt'));
    await replaceRow.replace();
    const replaceLeftover = track((await connectedWorld()).w);
    leaveApp(replaceLeftover, LEFT_1);
    replaceLeftover.slack.on.deleteApp = async () => {
      throw leak('deleteApp');
    };
    await replaceLeftover.replace();

    // The pass deleting Ada's leftover with her stored token, at Grace's
    // Connect (TASK-1175): all of it; then reading her token failing, the
    // rotate failing, and saving its successor failing. Last, "I deleted it"
    // whose release check fails.
    const adaLeftWorld = (): World => {
      const w = track(world());
      w.vault.set(configTokenRef(ADA.id), ADA_STORED);
      leaveApp(w, LEFT_1, 'Canopy Bot', NOW_MS - 60_000, ADA.id);
      return w;
    };
    await adaLeftWorld().connect(SECOND_PAIR, GRACE);
    const passRead = adaLeftWorld();
    passRead.vaultFailures.set('credentials:get config-refresh-token', leak('vault'));
    await passRead.connect(SECOND_PAIR, GRACE);
    const passRotate = adaLeftWorld();
    failRotateOf(passRotate, ADA_STORED, leak('rotate'));
    await passRotate.connect(SECOND_PAIR, GRACE);
    const passSave = adaLeftWorld();
    passSave.vaultFailures.set(`credentials:set ${configTokenRef(ADA.id)}`, leak('vault'));
    await passSave.connect(SECOND_PAIR, GRACE);
    const forgetRelease = adaLeftWorld();
    forgetRelease.memory.failures.set('personHasApps', leak('personHasApps'));
    await forgetRelease.forget();

    // Auth and branding faults.
    await track(world({ authFault: leak('auth') })).status();
    await track(world({ branding: leak('branding') })).status();

    const seen = JSON.stringify(worlds.map((w) => ({ answers: w.answers, lines: w.lines })));
    // Every failure world really failed somewhere and said so.
    expect(worlds.every((w) => w === happy || (w.answers.length > 0 && w.lines.length > 0))).toBe(true);
    for (const secret of SECRETS) expect(seen).not.toContain(secret);
    // Nor the bot's picture: it goes to Slack and nowhere else.
    expect(seen).not.toContain(CONNECT_BODY.iconPng);
    expect(seen).not.toContain('failed:');
    const lines = worlds.flatMap((w) => w.lines);
    // The new lines are in the scan (TASK-1139), so the allowlist is tested on them.
    expect(lines.map((l) => l.msg)).toEqual(
      expect.arrayContaining(['slack_disconnected', 'slack_leftover_app_deleted']),
    );
    for (const line of lines) {
      expect(line.msg, JSON.stringify(line)).toMatch(/^slack_/);
      for (const key of Object.keys(line.fields ?? {})) {
        expect(['installId', 'reason', 'stage', 'code', 'appDeleted'], JSON.stringify(line)).toContain(key);
      }
      // The one field that isn't a code or an id: a yes or a no, never a value.
      if (line.fields !== undefined && 'appDeleted' in line.fields) {
        expect(typeof line.fields['appDeleted'], JSON.stringify(line)).toBe('boolean');
      }
    }
    // Every refresh token the fake Slack minted, whichever rotate minted it.
    expect(seen).not.toContain('MINTEDREFRESH');
    // Nor whose token anything is (TASK-1175): a person's id never leaves either.
    for (const user of USERS) expect(seen).not.toContain(user.id);
  });
});
