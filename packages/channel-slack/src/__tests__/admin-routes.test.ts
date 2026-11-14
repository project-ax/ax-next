import { createHash, randomBytes } from 'node:crypto';
import { HookBus, PluginError, type Logger } from '@ax/core';
import { describe, expect, it } from 'vitest';
import { createAdminRoutes } from '../admin-routes.js';
import type { RouteRequest, RouteResponse } from '../http-types.js';
import { ADMIN_BODY_MAX_BYTES, OAUTH_STATE_TTL_MS, SLACK_TOKEN_MAX } from '../limits.js';
import { BOT_SCOPES, buildAppManifest, slackUrls } from '../manifest.js';
import {
  BOT_PREFIX,
  CONFIG_ACCESS_PREFIX,
  CONFIG_REFRESH_PREFIX,
  fakeBotToken,
  fakeConfigAccessToken,
  fakeConfigRefreshToken,
} from './fake-slack-tokens.js';
import { createMutex } from '../mutex.js';
import { SECRET_NAMES, createSecretStore, secretRef } from '../secrets.js';
import {
  SlackApiError,
  type CreatedApp,
  type OAuthInstall,
  type RotatedConfigToken,
  type SlackApi,
} from '../slack-api.js';
import { InstallStoreError, type InstallRow, type InstallStore } from '../store.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const ORIGIN = 'https://ax.example';
const HTTP_ORIGIN = 'http://ax.internal:8080';
const ICON_URL = `${ORIGIN}/api/branding/logo/light`;
const CALLBACK = '/admin/slack/oauth/callback';
const REDIRECT_URI = `${ORIGIN}${CALLBACK}`;
const NOW_MS = Date.parse('2026-11-13T12:00:00.000Z');

// Distinctive, so a leak is easy to spot. Shaped like Slack's, but short
// enough that a secret scanner won't take them for real ones.
const ACCESS = fakeConfigAccessToken();
const REFRESH = fakeConfigRefreshToken();
const MINTED_ACCESS = fakeConfigAccessToken('MINTEDACCESSSECRET');
const CLIENT_SECRET = 'CLIENTSECRET0123456789abcdef';
const SIGNING_SECRET = 'SIGNINGSECRET3f1c2b9a8e7d6c5b';
const BOT_TOKEN = fakeBotToken();
const SECRETS = [ACCESS, REFRESH, MINTED_ACCESS, CLIENT_SECRET, SIGNING_SECRET, BOT_TOKEN];

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
const CONNECT_BODY = { accessToken: ACCESS, refreshToken: REFRESH, botName: 'Canopy Bot' };

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
      rows.set(r.installId, {
        ...r,
        status: 'pending',
        teamId: null,
        teamName: null,
        botUserId: null,
        createdAt: new Date(clock()),
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
    async remove(installId) {
      await enter('remove', [installId]);
      rows.delete(installId);
    },
    async removeAll() {
      await enter('removeAll', []);
      const removed = [...rows.values()].map((r) => ({
        installId: r.installId,
        appId: r.appId,
        teamId: r.teamId,
      }));
      rows.clear();
      return removed;
    },
  };
  return { store, rows, calls, failures };
}

// ── A fake Slack: the five calls the admin routes make ──────────────────────

interface SlackBehaviour {
  rotateConfigToken(refreshToken: string): Promise<RotatedConfigToken>;
  createApp(token: string, manifest: Record<string, unknown>): Promise<CreatedApp>;
  deleteApp(token: string, appId: string): Promise<void>;
  setAppIcon(token: string, appId: string, url: string): Promise<void>;
  oauthAccess(i: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
  }): Promise<OAuthInstall>;
}

function fakeSlack(trail: string[]) {
  const calls: Array<{ method: keyof SlackBehaviour; args: unknown[] }> = [];
  /** What each call does; a test swaps one out. */
  const on: SlackBehaviour = {
    rotateConfigToken: async () => ({ accessToken: MINTED_ACCESS, expiresAt: NOW_MS + 43_200_000 }),
    createApp: async () => ({ ...APP }),
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
      return on.createApp(token, manifest);
    },
    deleteApp: async (token, appId) => {
      record('deleteApp', [token, appId]);
      return on.deleteApp(token, appId);
    },
    setAppIcon: async (token, appId, url) => {
      record('setAppIcon', [token, appId, url]);
      return on.setAppIcon(token, appId, url);
    },
    oauthAccess: async (i) => {
      record('oauthAccess', [i]);
      return on.oauthAccess(i);
    },
    usersInfo: notHere,
    postMessage: notHere,
    postEphemeral: notHere,
    startStream: notHere,
    appendStream: notHere,
    stopStream: notHere,
  };
  return { api, calls, on };
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
    /** null: no icon URL configured. */
    iconUrl?: string | null;
    /** 'absent': no branding plugin; an Error: branding:get throws it. */
    branding?: { name: string | null } | 'absent' | Error;
    /** auth:require-user throws this for everyone. */
    authFault?: Error;
    /** auth:get-user throws this for everyone. */
    getUserFault?: Error;
  } = {},
) {
  let nowMs = NOW_MS;
  /** Every vault, store and Slack call, in order. */
  const trail: string[] = [];
  const lines: Line[] = [];
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, fields });
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
  /** `<hook> <secret name>` → what that call throws. */
  const vaultFailures = new Map<string, unknown>();
  const nameOf = (ref: string): string => ref.slice(ref.lastIndexOf(':') + 1);
  const vaultHook = (hook: string, run: (input: Record<string, unknown>) => unknown): void => {
    bus.registerService(hook, '@ax/credentials', async (_ctx, raw) => {
      const input = raw as Record<string, unknown>;
      const ref = String(input['ref']);
      vaultCalls.push({ hook, ref });
      trail.push(`vault:${hook.slice('credentials:'.length)} ${nameOf(ref)}`);
      const failure = vaultFailures.get(`${hook} ${nameOf(ref)}`);
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
  const iconUrl = o.iconUrl === undefined ? ICON_URL : o.iconUrl;
  const routes = createAdminRoutes({
    bus,
    store: memory.store,
    secrets: createSecretStore(bus, { logger }),
    api: slack.api,
    lock: createMutex(),
    publicOrigin: o.publicOrigin ?? ORIGIN,
    ...(iconUrl !== null ? { iconUrl } : {}),
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
    callback: (query: Record<string, string>, as: TestUser | null = ADA) =>
      call('GET', CALLBACK, { as, query }),
    disconnect: (as: TestUser | null = ADA) => call('POST', '/admin/slack/disconnect', { as }),
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
async function connectedWorld(o: Parameters<typeof world>[0] = {}) {
  const w = world(o);
  const state = stateOf(await w.connect());
  expect((await w.callback({ code: CODE, state })).location).toBe(back('connected'));
  return { w, state, installId: mintedInstallId(w) };
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
  it('is exactly the five admin routes; none bypasses CSRF; the POSTs cap their bodies', () => {
    const { routes } = world();
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'GET /admin/slack',
      'GET /admin/slack/oauth/callback',
      'POST /admin/slack/connect',
      'POST /admin/slack/disconnect',
      'POST /admin/slack/install-url',
    ]);
    for (const r of routes) {
      expect(r.bypassCsrf, r.path).not.toBe(true);
      if (r.method === 'POST') expect(r.maxBodyBytes, r.path).toBe(ADMIN_BODY_MAX_BYTES);
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
    });
    expect((await world({ branding: { name: null } }).status()).body).toEqual({
      state: 'not-connected',
      defaultBotName: 'ax',
      canConnect: true,
    });
    expect((await world({ branding: 'absent' }).status()).body).toEqual({
      state: 'not-connected',
      defaultBotName: 'ax',
      canConnect: true,
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
    });
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
    expect(w.slack.calls.find((c) => c.method === 'setAppIcon')!.args).toEqual([ACCESS, APP.appId, ICON_URL]);
  });

  it('stores client-secret, signing-secret and the PASTED refresh token, then a pending row', async () => {
    const w = world();
    await w.connect();
    const installId = onlyRow(w).installId;
    expect(w.vault).toEqual(
      new Map([
        [secretRef(installId, 'client-secret'), CLIENT_SECRET],
        [secretRef(installId, 'signing-secret'), SIGNING_SECRET],
        [secretRef(installId, 'config-refresh-token'), REFRESH],
      ]),
    );
    expect(w.trail.filter((t) => t.startsWith('vault:') || t === 'store:insertPending')).toEqual([
      'vault:set client-secret',
      'vault:set signing-secret',
      'vault:set config-refresh-token',
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
    const huge = JSON.stringify({ ...CONNECT_BODY, pad: 'x'.repeat(ADMIN_BODY_MAX_BYTES) });
    expect(await w.connect(huge)).toMatchObject({ status: 413, body: { error: 'body-too-large' } });
    expect(w.trail).toEqual([]);
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
      expect(
        w.vaultCalls.filter((c) => c.hook === 'credentials:delete').map((c) => c.ref),
        label,
      ).toEqual(SECRET_NAMES.map((name) => secretRef(installId, name)));
      expect(w.lines[0], label).toMatchObject({
        level: 'error',
        msg: 'slack_admin_failed',
        fields: { installId, stage: 'connect' },
      });
      expect((await w.status()).body, label).toMatchObject({ state: 'not-connected' });
    }
  });

  it('undo keeps going when deleting the app fails, and says so code-only', async () => {
    const w = world();
    w.memory.failures.set('insertPending', new Error('insert failed'));
    w.slack.on.deleteApp = async () => {
      throw new SlackApiError('apps.manifest.delete', 'ratelimited', 60_000);
    };
    expect((await w.connect()).status).toBe(500);
    const installId = mintedInstallId(w);
    expect(w.vault.size).toBe(0);
    expect(w.lines).toContainEqual({
      level: 'warn',
      msg: 'slack_admin_failed',
      fields: { installId, stage: 'undo-delete-app', code: 'ratelimited' },
    });
  });

  it('icon_not_accessible → iconSet false and no log; another icon error → iconSet false and one code-only log', async () => {
    const quiet = world();
    quiet.slack.on.setAppIcon = async () => {
      throw new SlackApiError('apps.icon.set', 'icon_not_accessible');
    };
    expect(await quiet.connect()).toMatchObject({ status: 200, body: { iconSet: false } });
    expect(quiet.lines).toEqual([]);
    expect(onlyRow(quiet).status).toBe('pending');

    const loud = world();
    loud.slack.on.setAppIcon = async () => {
      throw new SlackApiError('apps.icon.set', 'ratelimited', 60_000);
    };
    expect(await loud.connect()).toMatchObject({ status: 200, body: { iconSet: false } });
    expect(loud.lines).toEqual([
      {
        level: 'warn',
        msg: 'slack_admin_failed',
        fields: { installId: mintedInstallId(loud), stage: 'icon', code: 'ratelimited' },
      },
    ]);
    expect(onlyRow(loud).status).toBe('pending');

    const noIcon = world({ iconUrl: null });
    expect(await noIcon.connect()).toMatchObject({ status: 200, body: { iconSet: false } });
    expect(slackMethods(noIcon)).toEqual(['createApp']);
  });

  it('two concurrent connects → one 200, one 409', async () => {
    const w = world();
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
      (['client-secret', 'config-refresh-token', 'signing-secret'] as const).map((n) => secretRef(installId, n)),
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
    const res = await w.disconnect(GRACE);
    expect(res).toMatchObject({ status: 200, body: { appDeleted: true } });
    expect(Object.keys(res.body as object)).toEqual(['appDeleted']);
    expect(
      w.slack.calls
        .filter((c) => c.method === 'rotateConfigToken' || c.method === 'deleteApp')
        .map((c) => [c.method, ...c.args]),
    ).toEqual([
      ['rotateConfigToken', REFRESH],
      ['deleteApp', MINTED_ACCESS, APP.appId],
    ]);
    expect(w.memory.rows.size).toBe(0);
    expect(w.vault.size).toBe(0);
    expect(w.vaultCalls.filter((c) => c.hook === 'credentials:delete').map((c) => c.ref)).toEqual(
      SECRET_NAMES.map((name) => secretRef(installId, name)),
    );
    expect((await w.status()).body).toMatchObject({ state: 'not-connected' });
  });

  it('rotate fails, deleteApp fails or the token is gone → { appDeleted: false }, row and secrets still removed', async () => {
    const breakers: Array<[string, string, (w: World, installId: string) => void]> = [
      [
        'rotate',
        'invalid_refresh_token',
        (w) => {
          w.slack.on.rotateConfigToken = async () => {
            throw new SlackApiError('tooling.tokens.rotate', 'invalid_refresh_token');
          };
        },
      ],
      [
        'delete-app',
        'ratelimited',
        (w) => {
          w.slack.on.deleteApp = async () => {
            throw new SlackApiError('apps.manifest.delete', 'ratelimited', 60_000);
          };
        },
      ],
      [
        'config-token',
        'missing',
        (w, installId) => {
          w.vault.delete(secretRef(installId, 'config-refresh-token'));
        },
      ],
    ];
    for (const [stage, code, breakIt] of breakers) {
      const { w, installId } = await connectedWorld();
      breakIt(w, installId);
      expect(await w.disconnect(), stage).toMatchObject({ status: 200, body: { appDeleted: false } });
      expect(w.memory.rows.size, stage).toBe(0);
      expect(w.vault.size, stage).toBe(0);
      expect(w.lines, stage).toContainEqual({
        level: 'warn',
        msg: 'slack_admin_failed',
        fields: { installId, stage, code },
      });
    }
  });

  it('an app Slack says is already gone (app_not_found) counts as deleted: { appDeleted: true }, no failure logged', async () => {
    const { w } = await connectedWorld();
    // Someone deleted it on api.slack.com/apps first.
    w.slack.on.deleteApp = async () => {
      throw new SlackApiError('apps.manifest.delete', 'app_not_found');
    };
    expect(await w.disconnect()).toMatchObject({ status: 200, body: { appDeleted: true } });
    expect(slackMethods(w).filter((m) => m === 'deleteApp')).toHaveLength(1);
    expect(w.memory.rows.size).toBe(0);
    expect(w.vault.size).toBe(0);
    expect(w.lines.filter((l) => l.msg === 'slack_admin_failed')).toEqual([]);
    expect((await w.status()).body).toMatchObject({ state: 'not-connected' });
  });

  it('cancels a pending install too', async () => {
    const w = world();
    await w.connect();
    expect(await w.disconnect()).toMatchObject({ status: 200, body: { appDeleted: true } });
    expect(w.memory.rows.size).toBe(0);
    expect(w.vault.size).toBe(0);
  });

  it('with nothing connected → 409 not-connected', async () => {
    const w = world();
    expect(await w.disconnect()).toMatchObject({ status: 409, body: { error: 'not-connected' } });
    expect(w.slack.calls).toEqual([]);
  });

  it('never calls credentials:set, and the minted access token goes nowhere but deleteApp', async () => {
    const { w } = await connectedWorld();
    const before = w.vaultCalls.length;
    await w.disconnect();
    expect(w.vaultCalls.slice(before).map((c) => c.hook)).not.toContain('credentials:set');
    expect(w.slack.calls.filter((c) => c.args.includes(MINTED_ACCESS)).map((c) => c.method)).toEqual([
      'deleteApp',
    ]);
  });

  it('a row that will not delete → 500, and the secrets stay for a retry', async () => {
    const { w, installId } = await connectedWorld();
    w.memory.failures.set('remove', new Error('connection reset'));
    expect(await w.disconnect()).toMatchObject({ status: 500, body: { error: 'internal' } });
    expect(w.vault.has(secretRef(installId, 'bot-token'))).toBe(true);
    w.memory.failures.delete('remove');
    expect((await w.disconnect()).status).toBe(200);
    expect(w.vault.size).toBe(0);
  });
});

describe('secrets never leave', () => {
  it('no response body or log line contains any of the four secrets or either pasted token', async () => {
    const leak = (where: string): Error => new Error(`${where} failed: ${SECRETS.join(' ')}`);
    const worlds: World[] = [];
    const track = (w: World): World => {
      worlds.push(w);
      return w;
    };

    // The whole happy path, and every read of it.
    const happy = track((await connectedWorld()).w);
    await happy.status();
    await happy.installUrl();
    await happy.disconnect();
    await happy.status();

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

    // Auth and branding faults.
    await track(world({ authFault: leak('auth') })).status();
    await track(world({ branding: leak('branding') })).status();

    const seen = JSON.stringify(worlds.map((w) => ({ answers: w.answers, lines: w.lines })));
    // Every failure world really failed somewhere and said so.
    expect(worlds.every((w) => w === happy || (w.answers.length > 0 && w.lines.length > 0))).toBe(true);
    for (const secret of SECRETS) expect(seen).not.toContain(secret);
    expect(seen).not.toContain('failed:');
    for (const line of worlds.flatMap((w) => w.lines)) {
      expect(line.msg, JSON.stringify(line)).toMatch(/^slack_/);
      for (const key of Object.keys(line.fields ?? {})) {
        expect(['installId', 'reason', 'stage', 'code'], JSON.stringify(line)).toContain(key);
      }
    }
  });
});
