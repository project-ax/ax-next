import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HookBus, PluginError, type Logger } from '@ax/core';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_BOTS_PATH,
  ADMIN_BOT_DISCONNECT_PATH,
  ADMIN_BOT_REPLACE_TOKEN_PATH,
  createAdminBotRoutes,
} from '../admin-bot-routes.js';
import type { BotChanges } from '../bot-changes.js';
import type { AdminSlackBot, BotReply, Bots } from '../bots.js';
import type { RouteRequest, RouteResponse } from '../http-types.js';
import { ADMIN_BODY_MAX_BYTES } from '../limits.js';
import { CONFIG_REFRESH_PREFIX, fakeConfigAccessToken, fakeConfigRefreshToken } from './fake-slack-tokens.js';

/*
  Admin › Slack's list of the team agents' own bots and its Disconnect
  (TASK-1172), and the Replace of a bot's token by its approver (TASK-1173),
  through the route handlers, with a stub domain (bots.test.ts tests
  `listForAdmin` and `disconnectForAdmin` themselves, bot-changes.test.ts
  `replaceTokenForAdmin`). None of those asks anyone's manage rights, so these
  routes' admin gate is the only such gate they have (the Replace's domain
  then lets only the bot's approver through): who gets through, what the
  domain is handed, and what a fault says are the point.
*/

// ── Fixtures ────────────────────────────────────────────────────────────────

interface TestUser {
  id: string;
  isAdmin: boolean;
}
const ADA: TestUser = { id: 'usr_ada', isAdmin: true };
const GRACE: TestUser = { id: 'usr_grace', isAdmin: true };
const BOB: TestUser = { id: 'usr_bob', isAdmin: false };
const USERS = [ADA, GRACE, BOB];

/** A team agent's bot's install id: 22 base64url characters, as every install id is. */
const BOT_ID = 'B0tInstallIdNotReal001';
const LISTED: AdminSlackBot = {
  installId: BOT_ID,
  botName: 'Support Helper',
  handle: 'supporthelper',
  approver: 'Grace Hopper',
  state: 'live',
  addedAt: '2026-11-13T12:00:00.000Z',
  viewerIsApprover: false,
};
/** Text a fault's message carries, which no log line or answer may repeat. */
const FAILURE_CANARY = 'failure-text-canary-5b2d';
/** A refresh token the approver pasted into Admin › Slack's Replace, and a token of the wrong kind. */
const REFRESH = fakeConfigRefreshToken('ADMINBOTREPLACESECRET');
const ACCESS = fakeConfigAccessToken('ADMINBOTACCESSSECRET');

// ── A request and response shaped like @ax/http-server's ───────────────────

interface Answered {
  status: number;
  how: 'json' | 'text' | 'end' | 'redirect' | null;
  body: unknown;
}

function fakeResponse(): { res: RouteResponse; answer: Answered } {
  const answer: Answered = { status: 200, how: null, body: undefined };
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
    json: (v) => finish('json', v),
    text: (s) => finish('text', s),
    end: () => finish('end'),
    redirect: () => finish('redirect'),
  };
  return { res, answer };
}

// ── The domain, as a stub ───────────────────────────────────────────────────

/**
 * The two bots.ts methods behind the routes, and bot-changes.ts's Admin ›
 * Slack Replace (TASK-1173): each call recorded in the one `calls` list (its
 * ctx as the person it acts for), answering what the test set. `fail` makes
 * every call throw it.
 */
function stubBots() {
  const calls: Array<{
    method: 'listForAdmin' | 'disconnectForAdmin' | 'replaceTokenForAdmin';
    input: Record<string, unknown>;
  }> = [];
  const answers: { listForAdmin: AdminSlackBot[]; disconnectForAdmin: BotReply; replaceTokenForAdmin: BotReply } = {
    listForAdmin: [LISTED],
    disconnectForAdmin: { status: 200, body: { appDeleted: true } },
    replaceTokenForAdmin: { status: 200, body: {} },
  };
  const state: { fail: unknown } = { fail: undefined };
  const enter = (method: (typeof calls)[number]['method'], input: object): void => {
    const { ctx, ...rest } = input as { ctx?: { userId: string } } & Record<string, unknown>;
    calls.push({ method, input: ctx === undefined ? rest : { ctxUserId: ctx.userId, ...rest } });
    if (state.fail !== undefined) throw state.fail;
  };
  const bots: Pick<Bots, 'listForAdmin' | 'disconnectForAdmin'> = {
    listForAdmin: async (i) => {
      enter('listForAdmin', i);
      return answers.listForAdmin;
    },
    disconnectForAdmin: async (i) => {
      enter('disconnectForAdmin', i);
      return answers.disconnectForAdmin;
    },
  };
  // Into the same `calls`, so every "the domain was never asked" covers it too.
  const changes: Pick<BotChanges, 'replaceTokenForAdmin'> = {
    replaceTokenForAdmin: async (i) => {
      enter('replaceTokenForAdmin', i);
      return answers.replaceTokenForAdmin;
    },
  };
  return { bots, changes, calls, answers, state };
}

// ── The routes' surroundings ────────────────────────────────────────────────

interface Line {
  level: string;
  msg: string;
  fields: Record<string, unknown> | undefined;
}

function world(o: { authFault?: Error } = {}) {
  const bus = new HookBus();
  const users = new Map(USERS.map((u) => [u.id, { ...u }]));
  bus.registerService('auth:require-user', '@ax/auth-better', async (_ctx, raw) => {
    if (o.authFault !== undefined) throw o.authFault;
    const { req } = raw as { req: RouteRequest };
    const user = users.get(String(req.headers['x-test-user']));
    if (user === undefined) {
      throw new PluginError({ code: 'unauthenticated', plugin: '@ax/auth-better', message: 'no session' });
    }
    return { user: { ...user } };
  });

  const lines: Line[] = [];
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, fields });
  };
  const logger: Logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: () => logger };

  const bots = stubBots();
  const routes = createAdminBotRoutes({ bus, bots: bots.bots, changes: bots.changes, logger });

  async function call(method: 'GET' | 'POST', path: string, as: TestUser | null, body?: unknown): Promise<Answered> {
    const spec = routes.find((r) => r.method === method && r.path === path);
    if (spec === undefined) throw new Error(`no route ${method} ${path}`);
    const raw =
      body === undefined
        ? Buffer.alloc(0)
        : Buffer.isBuffer(body)
          ? body
          : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req: RouteRequest = {
      method,
      path,
      rawPath: path,
      params: {},
      query: {},
      headers: { 'content-type': 'application/json', ...(as !== null ? { 'x-test-user': as.id } : {}) },
      body: raw,
    };
    const { res, answer } = fakeResponse();
    await spec.handler(req, res);
    if (answer.how === null) throw new Error(`${method} ${path} never answered`);
    return answer;
  }

  /** Status and body only. */
  const reply = async (p: Promise<Answered>): Promise<{ status: number; body: unknown }> => {
    const a = await p;
    return { status: a.status, body: a.body };
  };

  return {
    bots,
    lines,
    routes,
    call,
    list: (as: TestUser | null = ADA) => reply(call('GET', ADMIN_BOTS_PATH, as)),
    disconnect: (body: unknown, as: TestUser | null = ADA) => reply(call('POST', ADMIN_BOT_DISCONNECT_PATH, as, body)),
    replace: (body: unknown, as: TestUser | null = ADA) => reply(call('POST', ADMIN_BOT_REPLACE_TOKEN_PATH, as, body)),
  };
}

// ── The routes ──────────────────────────────────────────────────────────────

describe('the admin bot routes', () => {
  it('the routes keep the CSRF check; the POSTs cap their bodies at ADMIN_BODY_MAX_BYTES', () => {
    const w = world();
    expect(ADMIN_BOTS_PATH).toBe('/admin/slack/bots');
    expect(ADMIN_BOT_DISCONNECT_PATH).toBe('/admin/slack/bots/disconnect');
    expect(ADMIN_BOT_REPLACE_TOKEN_PATH).toBe('/admin/slack/bots/replace-token');
    expect(
      w.routes.map((r) => ({ method: r.method, path: r.path, bypassCsrf: r.bypassCsrf, maxBodyBytes: r.maxBodyBytes })),
    ).toEqual([
      { method: 'GET', path: '/admin/slack/bots', bypassCsrf: undefined, maxBodyBytes: undefined },
      { method: 'POST', path: '/admin/slack/bots/disconnect', bypassCsrf: undefined, maxBodyBytes: ADMIN_BODY_MAX_BYTES },
      // A bot's approver replaces their token from here (TASK-1173).
      {
        method: 'POST',
        path: '/admin/slack/bots/replace-token',
        bypassCsrf: undefined,
        maxBodyBytes: ADMIN_BODY_MAX_BYTES,
      },
    ]);
    for (const r of w.routes) expect(r).not.toHaveProperty('bypassCsrf');
  });

  it('every route: 401 signed out, 403 for someone who isn\'t an admin, 500 logged by code when auth fails; the domain is never asked', async () => {
    const w = world();
    // A POST body the route would refuse: the gate answers first, so it is never read.
    const bad = 'not json';
    for (const [method, path, body] of [
      ['GET', ADMIN_BOTS_PATH, undefined],
      ['POST', ADMIN_BOT_DISCONNECT_PATH, { installId: BOT_ID }],
      ['POST', ADMIN_BOT_DISCONNECT_PATH, bad],
      ['POST', ADMIN_BOT_REPLACE_TOKEN_PATH, { installId: BOT_ID, refreshToken: REFRESH }],
      ['POST', ADMIN_BOT_REPLACE_TOKEN_PATH, bad],
      // Too big to read, and not even looked at: the gate's answer, not a 413.
      ['POST', ADMIN_BOT_REPLACE_TOKEN_PATH, Buffer.alloc(ADMIN_BODY_MAX_BYTES + 1, 0x41)],
    ] as const) {
      const anon = await w.call(method, path, null, body);
      expect({ status: anon.status, body: anon.body }, `${method} ${path} signed out`).toEqual({
        status: 401,
        body: { error: 'unauthenticated' },
      });
      const member = await w.call(method, path, BOB, body);
      expect({ status: member.status, body: member.body }, `${method} ${path} not an admin`).toEqual({
        status: 403,
        body: { error: 'forbidden' },
      });
    }
    expect(w.bots.calls).toEqual([]);
    expect(w.lines).toEqual([]);

    const faulty = world({
      authFault: new PluginError({ code: 'session-store-down', plugin: '@ax/auth-better', message: FAILURE_CANARY }),
    });
    expect(await faulty.list()).toEqual({ status: 500, body: { error: 'internal' } });
    expect(await faulty.disconnect({ installId: BOT_ID })).toEqual({ status: 500, body: { error: 'internal' } });
    expect(await faulty.replace({ installId: BOT_ID, refreshToken: REFRESH })).toEqual({
      status: 500,
      body: { error: 'internal' },
    });
    expect(faulty.bots.calls).toEqual([]);
    expect(faulty.lines).toEqual([
      { level: 'error', msg: 'slack_admin_failed', fields: { stage: 'auth', code: 'session-store-down' } },
      { level: 'error', msg: 'slack_admin_failed', fields: { stage: 'auth', code: 'session-store-down' } },
      { level: 'error', msg: 'slack_admin_failed', fields: { stage: 'auth', code: 'session-store-down' } },
    ]);
  });

  it('GET lists what the domain lists, asked as the admin', async () => {
    const w = world();
    expect(await w.list(ADA)).toEqual({ status: 200, body: { bots: [LISTED] } });
    // Another admin's read is asked as them, not as whoever read first.
    w.bots.answers.listForAdmin = [];
    expect(await w.list(GRACE)).toEqual({ status: 200, body: { bots: [] } });
    expect(w.bots.calls).toEqual([
      { method: 'listForAdmin', input: { ctxUserId: ADA.id, viewerUserId: ADA.id } },
      { method: 'listForAdmin', input: { ctxUserId: GRACE.id, viewerUserId: GRACE.id } },
    ]);
    expect(w.lines).toEqual([]);
  });

  it('POST takes { installId } and nothing else: an unknown key, a missing, non-string or malformed id is a 400 before the domain; past the cap a 413', async () => {
    const w = world();
    const cases: Array<[string, unknown, Record<string, unknown>]> = [
      ['an unknown key', { installId: 'x', extra: 1 }, { error: 'invalid-body' }],
      ['an unknown key beside a good id, even one naming an agent', { installId: BOT_ID, agentId: 'agt_support' }, { error: 'invalid-body' }],
      ['not JSON', 'disconnect it', { error: 'invalid-body' }],
      ['an array', '[]', { error: 'invalid-body' }],
      ['null', 'null', { error: 'invalid-body' }],
      ['bytes that are not UTF-8', Buffer.from([0x7b, 0xff, 0x7d]), { error: 'invalid-body' }],
      ['no installId', {}, { error: 'invalid-install-id' }],
      ['a number', { installId: 42 }, { error: 'invalid-install-id' }],
      ['null for the id', { installId: null }, { error: 'invalid-install-id' }],
      ['an id too short', { installId: 'short' }, { error: 'invalid-install-id' }],
      ['an id one too long', { installId: `${BOT_ID}A` }, { error: 'invalid-install-id' }],
      ['an id with a character no install id has', { installId: `${'A'.repeat(21)}/` }, { error: 'invalid-install-id' }],
      ['an id with a space around it', { installId: ` ${BOT_ID}` }, { error: 'invalid-install-id' }],
    ];
    for (const [what, body, error] of cases) {
      expect(await w.disconnect(body), what).toEqual({ status: 400, body: error });
    }
    // http-server's maxBodyBytes refuses it first; the route's own check is the backstop.
    const big = Buffer.from(JSON.stringify({ installId: BOT_ID, pad: 'x'.repeat(ADMIN_BODY_MAX_BYTES) }));
    expect(await w.disconnect(big)).toEqual({ status: 413, body: { error: 'body-too-large' } });
    expect(w.bots.calls).toEqual([]);
    expect(w.lines).toEqual([]);
  });

  it('POST answers what the domain answers: 200 { appDeleted }, 409 no-bot', async () => {
    const w = world();
    expect(await w.disconnect({ installId: BOT_ID })).toEqual({ status: 200, body: { appDeleted: true } });
    w.bots.answers.disconnectForAdmin = { status: 200, body: { appDeleted: false } };
    expect(await w.disconnect({ installId: BOT_ID }, GRACE)).toEqual({ status: 200, body: { appDeleted: false } });
    // The shared app's id, one no install has, or a stale page's: the domain's 409, as it is.
    w.bots.answers.disconnectForAdmin = { status: 409, body: { error: 'no-bot' } };
    expect(await w.disconnect({ installId: 'A'.repeat(22) })).toEqual({ status: 409, body: { error: 'no-bot' } });
    // The domain is handed the id and nothing else: no person, no agent.
    expect(w.bots.calls).toEqual([
      { method: 'disconnectForAdmin', input: { installId: BOT_ID } },
      { method: 'disconnectForAdmin', input: { installId: BOT_ID } },
      { method: 'disconnectForAdmin', input: { installId: 'A'.repeat(22) } },
    ]);
  });

  it('Replace (TASK-1173) takes { installId, refreshToken } and nothing else: an unknown key, a malformed id or anything but a refresh token is a 400 before the domain; past the cap a 413', async () => {
    const w = world();
    const cases: Array<[string, unknown, Record<string, unknown>]> = [
      [
        'an unknown key beside a good id and token, even one naming an agent',
        { installId: BOT_ID, refreshToken: REFRESH, agentId: 'agt_support' },
        { error: 'invalid-body' },
      ],
      ['not JSON', 'replace it', { error: 'invalid-body' }],
      ['an array', JSON.stringify([BOT_ID, REFRESH]), { error: 'invalid-body' }],
      ['null', 'null', { error: 'invalid-body' }],
      ['bytes that are not UTF-8', Buffer.from([0x7b, 0xff, 0x7d]), { error: 'invalid-body' }],
      ['no body at all', Buffer.alloc(0), { error: 'invalid-body' }],
      ['no installId', { refreshToken: REFRESH }, { error: 'invalid-install-id' }],
      ['a number for the id', { installId: 42, refreshToken: REFRESH }, { error: 'invalid-install-id' }],
      ['an id of 21 characters', { installId: BOT_ID.slice(1), refreshToken: REFRESH }, { error: 'invalid-install-id' }],
      ['an id one too long', { installId: `${BOT_ID}A`, refreshToken: REFRESH }, { error: 'invalid-install-id' }],
      [
        'an id with a character no install id has',
        { installId: `${'A'.repeat(21)}/`, refreshToken: REFRESH },
        { error: 'invalid-install-id' },
      ],
      // The id comes first, so a bad one says so even with a bad token beside it.
      ['a bad id and a bad token', { installId: 'short', refreshToken: ACCESS }, { error: 'invalid-install-id' }],
      ['no refresh token', { installId: BOT_ID }, { error: 'invalid-refresh-token' }],
      ['an access token pasted into the refresh field', { installId: BOT_ID, refreshToken: ACCESS }, { error: 'invalid-refresh-token' }],
      ['a null refresh token', { installId: BOT_ID, refreshToken: null }, { error: 'invalid-refresh-token' }],
      ['a refresh token that is not text', { installId: BOT_ID, refreshToken: 42 }, { error: 'invalid-refresh-token' }],
      ['the prefix alone', { installId: BOT_ID, refreshToken: CONFIG_REFRESH_PREFIX }, { error: 'invalid-refresh-token' }],
      ['a refresh token with a space after it', { installId: BOT_ID, refreshToken: `${REFRESH} ` }, { error: 'invalid-refresh-token' }],
    ];
    for (const [what, body, error] of cases) {
      expect(await w.replace(body), what).toEqual({ status: 400, body: error });
    }
    // http-server's maxBodyBytes refuses it first; the route's own check is the backstop.
    const big = Buffer.from(JSON.stringify({ installId: BOT_ID, refreshToken: REFRESH, pad: 'x'.repeat(ADMIN_BODY_MAX_BYTES) }));
    expect(await w.replace(big)).toEqual({ status: 413, body: { error: 'body-too-large' } });
    // Nothing reached the domain, so no paste reached Slack; nothing was logged.
    expect(w.bots.calls).toEqual([]);
    expect(w.lines).toEqual([]);
  });

  it('Replace hands the domain the admin asking, the install id and the pasted refresh token, and nothing else; its answer is the route\'s', async () => {
    const w = world();
    expect(await w.replace({ installId: BOT_ID, refreshToken: REFRESH }, GRACE)).toEqual({ status: 200, body: {} });
    // Another admin's Replace is theirs: the domain compares the person with the bot's approver.
    expect(await w.replace({ installId: 'A'.repeat(22), refreshToken: REFRESH }, ADA)).toEqual({ status: 200, body: {} });
    expect(w.bots.calls).toEqual([
      { method: 'replaceTokenForAdmin', input: { actorUserId: GRACE.id, installId: BOT_ID, refreshToken: REFRESH } },
      { method: 'replaceTokenForAdmin', input: { actorUserId: ADA.id, installId: 'A'.repeat(22), refreshToken: REFRESH } },
    ]);
    // The domain's answer is the answer, whatever it is.
    for (const answer of [
      { status: 403, body: { error: 'not-approver' } },
      { status: 409, body: { error: 'no-bot' } },
      { status: 409, body: { error: 'not-live' } },
      { status: 409, body: { error: 'public-origin-not-https' } },
      { status: 502, body: { error: 'slack-refresh-token' } },
      { status: 502, body: { error: 'slack-not-app-manager' } },
      { status: 502, body: { error: 'slack-error' } },
      { status: 500, body: { error: 'internal' } },
    ]) {
      w.bots.answers.replaceTokenForAdmin = answer;
      expect(await w.replace({ installId: BOT_ID, refreshToken: REFRESH }), JSON.stringify(answer)).toEqual(answer);
    }
    expect(w.bots.calls).toHaveLength(10);
    expect(w.lines).toEqual([]);
  });

  it("a fault in the domain is a 500, logged with the route's stage and a code, never its message", async () => {
    const w = world();
    w.bots.state.fail = Object.assign(new Error(`relation gone near ${FAILURE_CANARY} ${BOT_ID} ${REFRESH}`), {
      code: 'ECONNRESET',
    });
    expect(await w.list()).toEqual({ status: 500, body: { error: 'internal' } });
    expect(await w.disconnect({ installId: BOT_ID })).toEqual({ status: 500, body: { error: 'internal' } });
    expect(await w.replace({ installId: BOT_ID, refreshToken: REFRESH })).toEqual({
      status: 500,
      body: { error: 'internal' },
    });
    expect(w.lines).toEqual([
      { level: 'error', msg: 'slack_admin_failed', fields: { stage: 'bots', code: 'ECONNRESET' } },
      { level: 'error', msg: 'slack_admin_failed', fields: { stage: 'bot-disconnect', code: 'ECONNRESET' } },
      { level: 'error', msg: 'slack_admin_failed', fields: { stage: 'bot-replace-token', code: 'ECONNRESET' } },
    ]);
    expect(JSON.stringify(w.lines)).not.toContain(FAILURE_CANARY);
    // Neither the pasted token nor any token-shaped text.
    expect(JSON.stringify(w.lines)).not.toContain(CONFIG_REFRESH_PREFIX);

    // A fault with no code of its own is logged as `unknown`, still never its message.
    const bare = world();
    bare.bots.state.fail = new Error(FAILURE_CANARY);
    expect(await bare.list()).toEqual({ status: 500, body: { error: 'internal' } });
    expect(bare.lines).toEqual([{ level: 'error', msg: 'slack_admin_failed', fields: { stage: 'bots', code: 'unknown' } }]);
  });

  it("nothing but these routes reaches the three domain methods that ask no one's manage rights", () => {
    // Their only such gate is this module's admin check: a second caller would
    // be a way around it. bots.ts and bot-changes.ts (TASK-1173's Replace)
    // define them; any other source naming them is one.
    const src = join(dirname(fileURLToPath(import.meta.url)), '..');
    const naming = readdirSync(src)
      .filter((f) => f.endsWith('.ts') && f !== 'bots.ts' && f !== 'bot-changes.ts')
      .filter((f) =>
        /\b(?:listForAdmin|disconnectForAdmin|replaceTokenForAdmin)\b/.test(readFileSync(join(src, f), 'utf8')),
      );
    expect(naming).toEqual(['admin-bot-routes.ts']);
  });
});
