import { HookBus, PluginError, type Logger } from '@ax/core';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_BOT_REQUESTS_PATH,
  ADMIN_BOT_REQUEST_APPROVE_PATH,
  ADMIN_BOT_REQUEST_DECLINE_PATH,
  createBotRequestAdminRoutes,
} from '../bot-request-routes.js';
import type { AdminBotRequestList, BotRequests } from '../bot-requests.js';
import type { BotReply } from '../bots.js';
import type { RouteRequest, RouteResponse, RouteSpec } from '../http-types.js';
import { ADMIN_BODY_MAX_BYTES, ADMIN_CONNECT_BODY_MAX_BYTES } from '../limits.js';
import { pngBase64 } from './fake-png.js';
import { fakeBotToken, fakeConfigAccessToken, fakeConfigRefreshToken } from './fake-slack-tokens.js';

/*
  Admin › Slack's bot requests (TASK-1169), through their route handlers, with
  a stub domain (bot-requests.test.ts tests the domain itself). The point here
  is the gate and what the domain is handed: an AX admin only (401 signed out,
  403 not an admin, 500 for an auth fault), before anything else; a request id
  of any shape but ours is the same 404 as one that's gone, before the domain;
  Approve's body holds a refresh token (checked for its kind before it can
  reach Slack) and the picture, nothing else; Decline reads no body.
*/

// ── Fixtures ────────────────────────────────────────────────────────────────

interface TestUser {
  id: string;
  displayName: string | null;
  email: string | null;
  isAdmin: boolean;
}
const ADA: TestUser = { id: 'usr_ada', displayName: 'Ada Admin', email: 'ada@example.com', isAdmin: true };
const GRACE: TestUser = { id: 'usr_grace', displayName: 'Grace Hopper', email: 'grace@example.com', isAdmin: true };
const BOB: TestUser = { id: 'usr_bob', displayName: 'Bob', email: 'bob@example.com', isAdmin: false };
const USERS = [ADA, GRACE, BOB];

/** One of our own request ids: 22 base64url characters. */
const REQUEST = 'U3VwcG9ydEJvdEFzazAwMQ';
/** A refresh token an AX admin pastes into the Approve dialog, and one of the wrong kind. */
const REFRESH = fakeConfigRefreshToken('APPROVEROUTESECRET');
const ACCESS = fakeConfigAccessToken('APPROVEROUTEACCESS');

const LISTED: AdminBotRequestList = {
  requests: [
    {
      requestId: REQUEST,
      botName: 'Support Helper',
      agentName: 'Support',
      teamName: 'Customer Care',
      requestedBy: 'Ada Lovelace',
      requestedAt: '2026-11-13T12:00:00.000Z',
    },
  ],
  configTokenStored: true,
  truncated: false,
};
const INSTALL_LINK = { status: 200, body: { installUrl: 'https://slack.com/oauth/v2/authorize?state=approved', iconSet: true } };
const NOT_FOUND = { status: 404, body: { error: 'not-found' } };

// ── The domain, as a stub ───────────────────────────────────────────────────

/** bot-requests.ts behind the routes: each call recorded (its ctx as the person it acts for), answering what the test set. */
function stubRequests() {
  const calls: Array<{ method: 'list' | 'approve' | 'decline'; input: Record<string, unknown> }> = [];
  const answers: { list: AdminBotRequestList; approve: BotReply; decline: BotReply } = {
    list: LISTED,
    approve: INSTALL_LINK,
    decline: { status: 200, body: {} },
  };
  const state: { fail: unknown } = { fail: undefined };
  const enter = (method: (typeof calls)[number]['method'], input: object): void => {
    const { ctx, ...rest } = input as { ctx?: { userId: string } } & Record<string, unknown>;
    calls.push({ method, input: ctx === undefined ? rest : { ctxUserId: ctx.userId, ...rest } });
    if (state.fail !== undefined) throw state.fail;
  };
  const requests: Pick<BotRequests, 'list' | 'approve' | 'decline'> = {
    list: async (i) => {
      enter('list', i);
      return answers.list;
    },
    approve: async (i) => {
      enter('approve', i);
      return answers.approve;
    },
    decline: async (i) => {
      enter('decline', i);
      return answers.decline;
    },
  };
  return { requests, calls, answers, state };
}

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

  const domain = stubRequests();
  const routes = createBotRequestAdminRoutes({ bus, requests: domain.requests, logger });

  /** One route, by its pattern; `requestId` fills `:requestId`. */
  async function call(
    method: 'GET' | 'POST',
    pattern: string,
    r: { as: TestUser | null; requestId?: string; body?: unknown },
  ): Promise<{ status: number; body: unknown }> {
    const spec: RouteSpec | undefined = routes.find((x) => x.method === method && x.path === pattern);
    if (spec === undefined) throw new Error(`no route ${method} ${pattern}`);
    const requestId = r.requestId ?? REQUEST;
    const path = pattern.replace(':requestId', encodeURIComponent(requestId));
    const body =
      r.body === undefined
        ? Buffer.alloc(0)
        : Buffer.isBuffer(r.body)
          ? r.body
          : Buffer.from(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    const req: RouteRequest = {
      method,
      path,
      rawPath: path,
      params: pattern.includes(':requestId') ? { requestId } : {},
      query: {},
      headers: { 'content-type': 'application/json', ...(r.as !== null ? { 'x-test-user': r.as.id } : {}) },
      body,
    };
    const { res, answer } = fakeResponse();
    await spec.handler(req, res);
    if (answer.how !== 'json') throw new Error(`${method} ${path} answered with ${String(answer.how)}`);
    return { status: answer.status, body: answer.body };
  }

  return {
    routes,
    domain,
    lines,
    call,
    list: (as: TestUser | null = ADA) => call('GET', ADMIN_BOT_REQUESTS_PATH, { as }),
    approve: (body: unknown, o: { as?: TestUser | null; requestId?: string } = {}) =>
      call('POST', ADMIN_BOT_REQUEST_APPROVE_PATH, {
        as: o.as === undefined ? ADA : o.as,
        body,
        ...(o.requestId !== undefined ? { requestId: o.requestId } : {}),
      }),
    decline: (o: { as?: TestUser | null; requestId?: string; body?: unknown } = {}) =>
      call('POST', ADMIN_BOT_REQUEST_DECLINE_PATH, {
        as: o.as === undefined ? ADA : o.as,
        ...(o.body !== undefined ? { body: o.body } : {}),
        ...(o.requestId !== undefined ? { requestId: o.requestId } : {}),
      }),
  };
}

// ── The routes ──────────────────────────────────────────────────────────────

describe('the route table', () => {
  it("is exactly the three request routes; none bypasses CSRF; Approve has Connect's cap for the picture, Decline the plain one", () => {
    const { routes } = world();
    expect(ADMIN_BOT_REQUESTS_PATH).toBe('/admin/slack/bot-requests');
    expect(ADMIN_BOT_REQUEST_APPROVE_PATH).toBe('/admin/slack/bot-requests/:requestId/approve');
    expect(ADMIN_BOT_REQUEST_DECLINE_PATH).toBe('/admin/slack/bot-requests/:requestId/decline');
    expect(routes.map((r) => ({ method: r.method, path: r.path, maxBodyBytes: r.maxBodyBytes }))).toEqual([
      { method: 'GET', path: '/admin/slack/bot-requests', maxBodyBytes: undefined },
      { method: 'POST', path: '/admin/slack/bot-requests/:requestId/approve', maxBodyBytes: ADMIN_CONNECT_BODY_MAX_BYTES },
      { method: 'POST', path: '/admin/slack/bot-requests/:requestId/decline', maxBodyBytes: ADMIN_BODY_MAX_BYTES },
    ]);
    for (const r of routes) expect(r, r.path).not.toHaveProperty('bypassCsrf');
  });
});

describe('the gate', () => {
  it('every route: 401 signed out, 403 for a signed-in person who is not an AX admin, before the domain is asked', async () => {
    const w = world();
    for (const route of w.routes) {
      const r = { body: { refreshToken: REFRESH } };
      const what = `${route.method} ${route.path}`;
      expect(await w.call(route.method, route.path, { ...r, as: null }), what).toEqual({
        status: 401,
        body: { error: 'unauthenticated' },
      });
      expect(await w.call(route.method, route.path, { ...r, as: BOB }), what).toEqual({
        status: 403,
        body: { error: 'forbidden' },
      });
      // The gate comes first: a request id of the wrong shape changes nothing for them.
      expect(await w.call(route.method, route.path, { ...r, as: BOB, requestId: 'x' }), what).toMatchObject({ status: 403 });
    }
    expect(w.domain.calls).toEqual([]);
    expect(w.lines).toEqual([]);
  });

  it('every route: an auth:require-user fault is a 500, logged with a code only, and the domain never asked', async () => {
    const w = world({
      authFault: new PluginError({ code: 'session-store-down', plugin: '@ax/auth-better', message: `ada@example.com ${REFRESH}` }),
    });
    for (const route of w.routes) {
      expect(await w.call(route.method, route.path, { as: ADA, body: {} }), route.path).toEqual({
        status: 500,
        body: { error: 'internal' },
      });
    }
    expect(w.domain.calls).toEqual([]);
    expect(w.lines).toEqual(
      w.routes.map(() => ({ level: 'error', msg: 'slack_admin_failed', fields: { stage: 'auth', code: 'session-store-down' } })),
    );
  });

  it('a request id of any shape but ours is the same 404 as one that is gone, before the domain is asked', async () => {
    const w = world();
    const bad = [
      '',
      'short',
      `${REQUEST}A`,
      REQUEST.slice(1),
      `${REQUEST.slice(1)}.`,
      `${REQUEST.slice(1)}/`,
      `${REQUEST.slice(1)}=`,
      `${REQUEST.slice(1)} `,
      `../${REQUEST.slice(3)}`,
    ];
    for (const requestId of bad) {
      expect(await w.approve({}, { requestId }), JSON.stringify(requestId)).toEqual(NOT_FOUND);
      expect(await w.decline({ requestId }), JSON.stringify(requestId)).toEqual(NOT_FOUND);
    }
    expect(w.domain.calls).toEqual([]);
    // Ours, and the domain says it is gone: the very same answer.
    w.domain.answers.approve = NOT_FOUND;
    w.domain.answers.decline = NOT_FOUND;
    expect(await w.approve({})).toEqual(NOT_FOUND);
    expect(await w.decline()).toEqual(NOT_FOUND);
  });
});

describe('GET /admin/slack/bot-requests', () => {
  it('answers what the domain lists, for the AX admin asking', async () => {
    const w = world();
    expect(await w.list(GRACE)).toEqual({ status: 200, body: LISTED });
    expect(w.domain.calls).toEqual([{ method: 'list', input: { ctxUserId: GRACE.id, viewerUserId: GRACE.id } }]);
  });
});

describe('POST /admin/slack/bot-requests/:requestId/approve', () => {
  it('hands the domain the request in the path, the AX admin asking, and the body as it was checked', async () => {
    const w = world();
    const png = pngBase64(512, 512);

    // Her stored token: nothing pasted, no picture drawn.
    expect(await w.approve({}, { as: GRACE })).toEqual(INSTALL_LINK);
    // A pasted token and the picture.
    expect(await w.approve({ refreshToken: REFRESH, iconPng: png })).toEqual(INSTALL_LINK);

    expect(w.domain.calls).toEqual([
      {
        method: 'approve',
        input: { ctxUserId: GRACE.id, actorUserId: GRACE.id, requestId: REQUEST, refreshToken: null, icon: null },
      },
      {
        method: 'approve',
        input: {
          ctxUserId: ADA.id,
          actorUserId: ADA.id,
          requestId: REQUEST,
          refreshToken: REFRESH,
          icon: { ok: true, png: Buffer.from(png, 'base64') },
        },
      },
    ]);
  });

  it('an access token, or anything else that is not a configuration refresh token, in refreshToken is invalid-refresh-token, before the domain', async () => {
    const w = world();
    for (const refreshToken of [ACCESS, null, '', 7, `${REFRESH} `, `${REFRESH}\n`, fakeBotToken('NOTCONFIG')]) {
      expect(await w.approve({ refreshToken }), JSON.stringify(refreshToken)).toEqual({
        status: 400,
        body: { error: 'invalid-refresh-token' },
      });
    }
    expect(w.domain.calls).toEqual([]);
  });

  it('an unknown key, or a body that is not an object, is invalid-body, before the domain', async () => {
    const w = world();
    const bodies: Array<[string, unknown]> = [
      ['not JSON', 'approve it'],
      ['an array', JSON.stringify([REFRESH])],
      ['null', 'null'],
      ['an empty body', Buffer.alloc(0)],
      ['a new name: approving never renames', { botName: 'Another Name' }],
      ['another request', { requestId: 'U2FsZXNCb3RBc2swMDAwMg' }],
      ['an access token beside the refresh token', { refreshToken: REFRESH, accessToken: ACCESS }],
    ];
    for (const [what, body] of bodies) {
      expect(await w.approve(body), what).toEqual({ status: 400, body: { error: 'invalid-body' } });
    }
    expect(w.domain.calls).toEqual([]);
  });

  it('an unusable picture still reaches the domain as icon.ts read it, never a 400', async () => {
    const w = world();
    expect(await w.approve({ iconPng: 'not a picture' })).toEqual(INSTALL_LINK);
    expect(w.domain.calls[0]?.input['icon']).toEqual({ ok: false, code: 'icon-not-base64' });
  });

  it('a body past the cap is 413, before the domain (the route cap is the first line; this is the backstop)', async () => {
    const w = world();
    const big = Buffer.from(JSON.stringify({ iconPng: 'A'.repeat(ADMIN_CONNECT_BODY_MAX_BYTES) }));
    expect(await w.approve(big)).toEqual({ status: 413, body: { error: 'body-too-large' } });
    expect(w.domain.calls).toEqual([]);
  });

  it("answers exactly what the domain answers: its refusals and Slack's", async () => {
    const w = world();
    for (const answer of [
      { status: 409, body: { error: 'requester-not-admin' } },
      { status: 409, body: { error: 'agent-gone' } },
      { status: 409, body: { error: 'config-token-needed' } },
      { status: 502, body: { error: 'slack-config-token' } },
      NOT_FOUND,
    ]) {
      w.domain.answers.approve = answer;
      expect(await w.approve({}), JSON.stringify(answer)).toEqual(answer);
    }
  });
});

describe('POST /admin/slack/bot-requests/:requestId/decline', () => {
  it('hands the domain the request in the path, and never reads a body', async () => {
    const w = world();
    expect(await w.decline({ body: 'garbage' })).toEqual({ status: 200, body: {} });
    expect(await w.decline({ body: { requestId: 'U2FsZXNCb3RBc2swMDAwMg' }, as: GRACE })).toEqual({ status: 200, body: {} });
    expect(w.domain.calls).toEqual([
      { method: 'decline', input: { requestId: REQUEST } },
      { method: 'decline', input: { requestId: REQUEST } },
    ]);
  });
});

describe('faults', () => {
  it('a domain throw is a 500 with a code-only line naming the route', async () => {
    const w = world();
    w.domain.state.fail = Object.assign(new Error(`vault down holding ${REFRESH} for ${ADA.email}`), { code: 'ECONNRESET' });

    expect(await w.list()).toEqual({ status: 500, body: { error: 'internal' } });
    expect(await w.approve({ refreshToken: REFRESH })).toEqual({ status: 500, body: { error: 'internal' } });
    expect(await w.decline()).toEqual({ status: 500, body: { error: 'internal' } });

    expect(w.lines).toEqual([
      { level: 'error', msg: 'slack_admin_failed', fields: { stage: 'bot-requests', code: 'ECONNRESET' } },
      { level: 'error', msg: 'slack_admin_failed', fields: { stage: 'bot-request-approve', code: 'ECONNRESET' } },
      { level: 'error', msg: 'slack_admin_failed', fields: { stage: 'bot-request-decline', code: 'ECONNRESET' } },
    ]);
    const logged = JSON.stringify(w.lines);
    for (const text of [REFRESH, ADA.email!, ADA.id, REQUEST]) expect(logged, text).not.toContain(text);
  });
});
