import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOT_PREFIX, fakeBotToken, fakeConfigAccessToken, fakeConfigRefreshToken } from './fake-slack-tokens.js';
import { SLACK_RESPONSE_CAP_BYTES } from '../limits.js';
import { SlackApiError, createSlackApi, type SlackApi } from '../slack-api.js';

// Distinctive secrets, so a leak into an error is easy to spot.
const BOT = fakeBotToken();
const CFG = fakeConfigAccessToken('CONFIGACCESSSECRET');
const REFRESH = fakeConfigRefreshToken('CONFIGREFRESHSECRET');
const NEW_ACCESS = fakeConfigAccessToken('NEWACCESS');
const MINTED_REFRESH = fakeConfigRefreshToken('MINTEDREFRESH');
const NEW_BOT = `${BOT_PREFIX}9-9-NEWBOT`;
const CLIENT_SECRET = 'CLIENTSECRET0123456789abcdef';
const SECRETS = [BOT, CFG, REFRESH, CLIENT_SECRET, 'SECRET'];
const REDIRECT = 'https://ax.example/admin/slack/oauth/callback';

/** One request the fake Slack received. */
interface Sent {
  url: string;
  /** The Slack method, from the path. */
  method: string;
  init: RequestInit;
  headers: Headers;
  body: string;
}

/**
 * A fake Slack behind an injected `fetchImpl`: every request is recorded,
 * then answered by `answer`. Nothing here reaches the network.
 */
function fakeSlack(answer: (req: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const req: Sent = {
      url,
      method: new URL(url).pathname.replace(/^\/api\//, ''),
      init: init ?? {},
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : '',
    };
    sent.push(req);
    return Promise.resolve().then(() => answer(req));
  }) as typeof fetch;
  return { fetchImpl, sent };
}

function okJson(fields: Record<string, unknown> = {}, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify({ ok: true, ...fields }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function slackError(error: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify({ ok: false, error }), { status: 200, ...init });
}

/** Enough fields for every method's success path. */
const EVERY_FIELD = {
  token: NEW_ACCESS,
  refresh_token: MINTED_REFRESH,
  exp: 1_800_000_000,
  app_id: 'A0APP',
  credentials: {
    client_id: '123.456',
    client_secret: 'cs0123',
    verification_token: 'vt0123',
    signing_secret: 'ss0123',
  },
  access_token: NEW_BOT,
  token_type: 'bot',
  bot_user_id: 'U0BOT',
  team: { id: 'T0TEAM', name: 'Acme' },
  is_enterprise_install: false,
  user: { id: 'U1' },
  ts: '1700000000.000100',
};

/** Every method, called with the secrets above. */
function everyMethod(api: SlackApi): Array<[string, () => Promise<unknown>]> {
  return [
    ['tooling.tokens.rotate', () => api.rotateConfigToken(REFRESH)],
    ['apps.manifest.create', () => api.createApp(CFG, { display_information: { name: 'ax' } })],
    ['apps.manifest.delete', () => api.deleteApp(CFG, 'A0APP')],
    [
      'apps.icon.set',
      () => api.setAppIcon(CFG, 'A0APP', 'https://ax.example/api/branding/logo/light'),
    ],
    [
      'oauth.v2.access',
      () =>
        api.oauthAccess({
          clientId: '123.456',
          clientSecret: CLIENT_SECRET,
          code: 'c0de',
          redirectUri: REDIRECT,
        }),
    ],
    ['users.info', () => api.usersInfo(BOT, 'U1')],
    [
      'chat.postMessage',
      () => api.postMessage(BOT, { channel: 'D1', threadTs: '1.2', markdownText: 'hi' }),
    ],
    ['chat.postEphemeral', () => api.postEphemeral(BOT, { channel: 'C1', user: 'U1', text: 'hi' })],
    [
      'chat.startStream',
      () =>
        api.startStream(BOT, {
          channel: 'D1',
          threadTs: '1.2',
          recipientUserId: 'U1',
          recipientTeamId: 'T0TEAM',
          chunks: [],
        }),
    ],
    ['chat.appendStream', () => api.appendStream(BOT, { channel: 'D1', ts: '1.3', chunks: [] })],
    ['chat.stopStream', () => api.stopStream(BOT, { channel: 'D1', ts: '1.3' })],
  ];
}

const FORM_METHODS = [
  'tooling.tokens.rotate',
  'apps.manifest.create',
  'apps.manifest.delete',
  'apps.icon.set',
  'oauth.v2.access',
  'users.info',
];

/** The SlackApiError a call rejects with; fails the test on anything else. */
async function failure(p: Promise<unknown>): Promise<SlackApiError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(SlackApiError);
    return err as SlackApiError;
  }
  throw new Error('expected the call to reject');
}

function formOf(req: Sent): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(req.body));
}

beforeEach(() => {
  // The client must only ever use the fetch it was given.
  vi.stubGlobal('fetch', () => {
    throw new Error('global fetch is off in these tests');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('requests', () => {
  it('every method POSTs to https://slack.com/api/<method> with redirect manual and a signal', async () => {
    const slack = fakeSlack(() => okJson(EVERY_FIELD));
    const api = createSlackApi({ fetchImpl: slack.fetchImpl });
    const methods = everyMethod(api);
    for (const [, run] of methods) await run();

    expect(slack.sent.map((r) => r.url)).toStrictEqual(
      methods.map(([method]) => `https://slack.com/api/${method}`),
    );
    for (const req of slack.sent) {
      expect(req.init.method).toBe('POST');
      expect(req.init.redirect).toBe('manual');
      expect(req.init.signal).toBeInstanceOf(AbortSignal);
      const type = req.headers.get('content-type') ?? '';
      if (FORM_METHODS.includes(req.method)) {
        expect(type, req.method).toMatch(/^application\/x-www-form-urlencoded/);
      } else {
        expect(req.method).toMatch(/^chat\./);
        expect(type, req.method).toMatch(/^application\/json/);
      }
      const auth = req.headers.get('authorization');
      if (req.method === 'tooling.tokens.rotate') expect(auth).toBeNull();
      else if (req.method === 'oauth.v2.access') expect(auth).toMatch(/^Basic /);
      else expect(auth, req.method).toBe(`Bearer ${req.method.startsWith('apps.') ? CFG : BOT}`);
      // Nothing but the content type and, maybe, the credential.
      expect([...req.headers.keys()].sort()).toStrictEqual(
        auth === null ? ['content-type'] : ['authorization', 'content-type'],
      );
    }
  });

  it('users.info sends a form body with a Bearer header', async () => {
    const slack = fakeSlack(() => okJson({ user: { id: 'U1' } }));
    await createSlackApi({ fetchImpl: slack.fetchImpl }).usersInfo(BOT, 'U1');

    const [req] = slack.sent;
    expect(req!.url).toBe('https://slack.com/api/users.info');
    expect(req!.init.method).toBe('POST');
    expect(req!.headers.get('content-type')).toMatch(/^application\/x-www-form-urlencoded/);
    expect(req!.headers.get('authorization')).toBe(`Bearer ${BOT}`);
    expect(req!.body).toBe('user=U1');
  });

  it('users.info returns the raw user object; no user → bad-response', async () => {
    const user = { id: 'U1', is_bot: false, profile: { email: 'ada@example.com' } };
    const api = createSlackApi({ fetchImpl: fakeSlack(() => okJson({ user })).fetchImpl });
    expect(await api.usersInfo(BOT, 'U1')).toStrictEqual(user);

    for (const bad of [{}, { user: null }, { user: 'U1' }, { user: [] }]) {
      const noUser = createSlackApi({ fetchImpl: fakeSlack(() => okJson(bad)).fetchImpl });
      expect((await failure(noUser.usersInfo(BOT, 'U1'))).code).toBe('bad-response');
    }
  });

  it('chat.startStream sends JSON in snake_case and returns the stream ts', async () => {
    const slack = fakeSlack(() => okJson({ ts: '1700000000.000100' }));
    const out = await createSlackApi({ fetchImpl: slack.fetchImpl }).startStream(BOT, {
      channel: 'D1',
      threadTs: '1699999999.000001',
      recipientUserId: 'U1',
      recipientTeamId: 'T0TEAM',
      chunks: [
        { type: 'markdown_text', text: 'Hello' },
        { type: 'task_update', id: 'status', title: 'Working', status: 'in_progress' },
      ],
    });

    expect(out).toStrictEqual({ ts: '1700000000.000100' });
    const [req] = slack.sent;
    expect(req!.headers.get('content-type')).toMatch(/^application\/json/);
    expect(req!.headers.get('authorization')).toBe(`Bearer ${BOT}`);
    expect(JSON.parse(req!.body)).toStrictEqual({
      channel: 'D1',
      thread_ts: '1699999999.000001',
      recipient_user_id: 'U1',
      recipient_team_id: 'T0TEAM',
      chunks: [
        { type: 'markdown_text', text: 'Hello' },
        { type: 'task_update', id: 'status', title: 'Working', status: 'in_progress' },
      ],
    });
  });

  it('a chunk carries only its own fields, whatever else the caller hands in', async () => {
    const slack = fakeSlack(() => okJson());
    const chunk = { type: 'markdown_text' as const, text: 'hi', botToken: BOT };
    await createSlackApi({ fetchImpl: slack.fetchImpl }).appendStream(BOT, {
      channel: 'D1',
      ts: '1.3',
      chunks: [chunk],
    });
    expect(JSON.parse(slack.sent[0]!.body)).toStrictEqual({
      channel: 'D1',
      ts: '1.3',
      chunks: [{ type: 'markdown_text', text: 'hi' }],
    });
  });

  it('chat.startStream without a ts in the answer → bad-response', async () => {
    const api = createSlackApi({ fetchImpl: fakeSlack(() => okJson()).fetchImpl });
    const err = await failure(
      api.startStream(BOT, {
        channel: 'D1',
        threadTs: '1.2',
        recipientUserId: 'U1',
        recipientTeamId: 'T1',
        chunks: [],
      }),
    );
    expect(err.code).toBe('bad-response');
  });

  it('chat.appendStream and chat.stopStream send JSON; stopStream omits chunks when given none', async () => {
    const slack = fakeSlack(() => okJson());
    const api = createSlackApi({ fetchImpl: slack.fetchImpl });
    const done = { type: 'task_update' as const, id: 'status', title: 'Done', status: 'complete' as const };
    await api.appendStream(BOT, { channel: 'D1', ts: '1.3', chunks: [{ type: 'markdown_text', text: 'more' }] });
    await api.stopStream(BOT, { channel: 'D1', ts: '1.3', chunks: [done] });
    await api.stopStream(BOT, { channel: 'D1', ts: '1.3' });

    expect(slack.sent.map((r) => [r.method, JSON.parse(r.body)])).toStrictEqual([
      ['chat.appendStream', { channel: 'D1', ts: '1.3', chunks: [{ type: 'markdown_text', text: 'more' }] }],
      ['chat.stopStream', { channel: 'D1', ts: '1.3', chunks: [done] }],
      ['chat.stopStream', { channel: 'D1', ts: '1.3' }],
    ]);
  });

  it('postMessage always disables unfurling', async () => {
    const slack = fakeSlack(() => okJson({ ts: '1.4' }));
    await createSlackApi({ fetchImpl: slack.fetchImpl }).postMessage(BOT, {
      channel: 'D1',
      threadTs: '1.2',
      markdownText: 'see https://example.com',
    });
    expect(JSON.parse(slack.sent[0]!.body)).toStrictEqual({
      channel: 'D1',
      thread_ts: '1.2',
      markdown_text: 'see https://example.com',
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  it('postEphemeral sends text, and thread_ts only when given', async () => {
    const slack = fakeSlack(() => okJson());
    const api = createSlackApi({ fetchImpl: slack.fetchImpl });
    await api.postEphemeral(BOT, { channel: 'C1', user: 'U1', text: 'DM me' });
    await api.postEphemeral(BOT, { channel: 'C1', user: 'U1', text: 'DM me', threadTs: '1.2' });
    expect(slack.sent.map((r) => JSON.parse(r.body))).toStrictEqual([
      { channel: 'C1', user: 'U1', text: 'DM me' },
      { channel: 'C1', user: 'U1', text: 'DM me', thread_ts: '1.2' },
    ]);
  });

  it('oauth.v2.access uses Basic auth and keeps the secret out of the body', async () => {
    const slack = fakeSlack(() =>
      okJson({
        access_token: NEW_BOT,
        token_type: 'bot',
        scope: 'chat:write',
        bot_user_id: 'U0BOT',
        app_id: 'A0APP',
        team: { id: 'T0TEAM', name: 'Acme' },
        enterprise: null,
        is_enterprise_install: false,
        authed_user: { id: 'U1' },
      }),
    );
    const out = await createSlackApi({ fetchImpl: slack.fetchImpl }).oauthAccess({
      clientId: '123.456',
      clientSecret: CLIENT_SECRET,
      code: 'c0de',
      redirectUri: REDIRECT,
    });

    expect(out).toStrictEqual({
      botToken: NEW_BOT,
      botUserId: 'U0BOT',
      appId: 'A0APP',
      teamId: 'T0TEAM',
      teamName: 'Acme',
      enterpriseInstall: false,
    });
    const [req] = slack.sent;
    expect(req!.headers.get('authorization')).toBe(
      `Basic ${Buffer.from(`123.456:${CLIENT_SECRET}`).toString('base64')}`,
    );
    expect(formOf(req!)).toStrictEqual({ code: 'c0de', redirect_uri: REDIRECT });
    expect(req!.body).not.toContain(CLIENT_SECRET);
    expect(req!.body).not.toContain('client_');
  });

  it('oauth.v2.access reports an enterprise install', async () => {
    const api = createSlackApi({
      fetchImpl: fakeSlack(() => okJson({ ...EVERY_FIELD, is_enterprise_install: true })).fetchImpl,
    });
    const out = await api.oauthAccess({
      clientId: '123.456',
      clientSecret: CLIENT_SECRET,
      code: 'c0de',
      redirectUri: REDIRECT,
    });
    expect(out.enterpriseInstall).toBe(true);
  });

  it('oauthAccess with token_type other than bot or a missing field → bad-response', async () => {
    const good = {
      access_token: NEW_BOT,
      token_type: 'bot',
      bot_user_id: 'U0BOT',
      app_id: 'A0APP',
      team: { id: 'T0TEAM', name: 'Acme' },
      is_enterprise_install: false,
    };
    const broken: Array<Record<string, unknown>> = [
      { ...good, token_type: 'user' },
      { ...good, token_type: undefined },
      { ...good, access_token: undefined },
      { ...good, access_token: '' },
      { ...good, bot_user_id: undefined },
      { ...good, app_id: undefined },
      { ...good, team: null },
      { ...good, team: { name: 'Acme' } },
      { ...good, team: { id: 'T0TEAM' } },
      { ...good, is_enterprise_install: undefined },
      { ...good, is_enterprise_install: 'false' },
    ];
    for (const body of broken) {
      const api = createSlackApi({ fetchImpl: fakeSlack(() => okJson(body)).fetchImpl });
      const err = await failure(
        api.oauthAccess({ clientId: '123.456', clientSecret: CLIENT_SECRET, code: 'c', redirectUri: REDIRECT }),
      );
      expect(err.code, JSON.stringify(body)).toBe('bad-response');
    }
  });

  it('rotateConfigToken sends only the refresh token, with no auth header', async () => {
    const slack = fakeSlack(() => okJson(EVERY_FIELD));
    await createSlackApi({ fetchImpl: slack.fetchImpl }).rotateConfigToken(REFRESH);
    const [req] = slack.sent;
    expect(req!.headers.get('authorization')).toBeNull();
    expect(formOf(req!)).toStrictEqual({ refresh_token: REFRESH });
  });

  it('rotateConfigToken returns only accessToken and expiresAt, never the minted refresh token', async () => {
    const slack = fakeSlack(() =>
      okJson({
        token: NEW_ACCESS,
        refresh_token: MINTED_REFRESH,
        team_id: 'T0TEAM',
        user_id: 'U1',
        iat: 1_799_956_800,
        exp: 1_800_000_000,
      }),
    );
    const out = await createSlackApi({ fetchImpl: slack.fetchImpl }).rotateConfigToken(REFRESH);
    expect(Object.keys(out).sort()).toStrictEqual(['accessToken', 'expiresAt']);
    expect(out).toStrictEqual({ accessToken: NEW_ACCESS, expiresAt: 1_800_000_000_000 });
    expect(JSON.stringify(out)).not.toContain('MINTEDREFRESH');
  });

  it('rotateConfigToken without a usable token or exp → bad-response', async () => {
    for (const body of [
      { exp: 1_800_000_000 },
      { token: NEW_ACCESS },
      { token: NEW_ACCESS, exp: '1800000000' },
      { token: NEW_ACCESS, exp: 1.5 },
      { token: 'has a space', exp: 1_800_000_000 },
    ]) {
      const api = createSlackApi({ fetchImpl: fakeSlack(() => okJson(body)).fetchImpl });
      expect((await failure(api.rotateConfigToken(REFRESH))).code, JSON.stringify(body)).toBe(
        'bad-response',
      );
    }
  });

  it('createApp sends the manifest as a JSON string in a form body, with the config token', async () => {
    const slack = fakeSlack(() => okJson(EVERY_FIELD));
    const manifest = { display_information: { name: 'ax', description: 'Talk to your AX agent.' } };
    const out = await createSlackApi({ fetchImpl: slack.fetchImpl }).createApp(CFG, manifest);

    expect(out).toStrictEqual({
      appId: 'A0APP',
      clientId: '123.456',
      clientSecret: 'cs0123',
      signingSecret: 'ss0123',
    });
    const [req] = slack.sent;
    expect(req!.headers.get('authorization')).toBe(`Bearer ${CFG}`);
    const form = formOf(req!);
    expect(Object.keys(form)).toStrictEqual(['manifest']);
    expect(JSON.parse(form['manifest']!)).toStrictEqual(manifest);
  });

  it('createApp with a missing app id or credential → bad-response', async () => {
    const creds = EVERY_FIELD.credentials;
    for (const body of [
      { credentials: creds },
      { app_id: 'A0APP' },
      { app_id: 'A0APP', credentials: { ...creds, client_id: undefined } },
      { app_id: 'A0APP', credentials: { ...creds, client_secret: undefined } },
      { app_id: 'A0APP', credentials: { ...creds, signing_secret: undefined } },
      { app_id: 'A0APP', credentials: 'nope' },
    ]) {
      const api = createSlackApi({ fetchImpl: fakeSlack(() => okJson(body)).fetchImpl });
      expect((await failure(api.createApp(CFG, {}))).code, JSON.stringify(body)).toBe('bad-response');
    }
  });

  it('narrows ids and secrets: an odd character, empty or too long → bad-response', async () => {
    for (const app_id of ['', 'A'.repeat(65), 'A0\nAPP', 'A0 APP', 42]) {
      const api = createSlackApi({ fetchImpl: fakeSlack(() => okJson({ ...EVERY_FIELD, app_id })).fetchImpl });
      expect((await failure(api.createApp(CFG, {}))).code, JSON.stringify(app_id)).toBe('bad-response');
    }
    for (const signing_secret of ['', 's'.repeat(513), 'ss\r\nx-injected: 1', 'ss 0123']) {
      const body = { ...EVERY_FIELD, credentials: { ...EVERY_FIELD.credentials, signing_secret } };
      const api = createSlackApi({ fetchImpl: fakeSlack(() => okJson(body)).fetchImpl });
      expect((await failure(api.createApp(CFG, {}))).code, JSON.stringify(signing_secret)).toBe(
        'bad-response',
      );
    }
    const longest = createSlackApi({
      fetchImpl: fakeSlack(() =>
        okJson({ ...EVERY_FIELD, app_id: 'A'.repeat(64), credentials: { ...EVERY_FIELD.credentials, signing_secret: 's'.repeat(512) } }),
      ).fetchImpl,
    });
    expect((await longest.createApp(CFG, {})).signingSecret).toHaveLength(512);
  });

  it('deleteApp and setAppIcon send form fields with the config token', async () => {
    const slack = fakeSlack(() => okJson());
    const api = createSlackApi({ fetchImpl: slack.fetchImpl });
    await api.deleteApp(CFG, 'A0APP');
    await api.setAppIcon(CFG, 'A0APP', 'https://ax.example/api/branding/logo/light');
    expect(slack.sent.map((r) => [r.method, formOf(r), r.headers.get('authorization')])).toStrictEqual([
      ['apps.manifest.delete', { app_id: 'A0APP' }, `Bearer ${CFG}`],
      [
        'apps.icon.set',
        { app_id: 'A0APP', url: 'https://ax.example/api/branding/logo/light' },
        `Bearer ${CFG}`,
      ],
    ]);
  });
});

describe('failures', () => {
  it("ok:false → SlackApiError with Slack's code when it is a plain code, else slack-error", async () => {
    const cases: Array<[unknown, string]> = [
      ['invalid_auth', 'invalid_auth'],
      ['msg_too_long', 'msg_too_long'],
      ['<script>', 'slack-error'],
      ['Invalid_Auth', 'slack-error'],
      ['invalid auth', 'slack-error'],
      ['a'.repeat(65), 'slack-error'],
      ['', 'slack-error'],
      [undefined, 'slack-error'],
      [{ code: 'invalid_auth' }, 'slack-error'],
    ];
    for (const [error, code] of cases) {
      const api = createSlackApi({ fetchImpl: fakeSlack(() => slackError(error)).fetchImpl });
      const err = await failure(api.usersInfo(BOT, 'U1'));
      expect(err.code, JSON.stringify(error)).toBe(code);
      expect(err.method).toBe('users.info');
      expect(err.message).toBe(`slack users.info: ${code}`);
      expect(err.retryAfterMs).toBeUndefined();
      expect('retryAfterMs' in err).toBe(false);
    }
  });

  it("a lowercase-hex secret Slack echoes as its error never becomes the code", async () => {
    // Slack's codes are lowercase words and underscores. A signing or client
    // secret is lowercase hex, which a [a-z0-9_] pattern would have let
    // through into SlackApiError.code, and from there into a log line.
    for (const echoed of ['0a1b2c3d'.repeat(4), '8f742231b10e8888abcd99', 'c0ffee_1234']) {
      const api = createSlackApi({ fetchImpl: fakeSlack(() => slackError(echoed)).fetchImpl });
      const err = await failure(api.usersInfo(BOT, 'U1'));
      expect(err.code, echoed).toBe('slack-error');
      expect(err.message).toBe('slack users.info: slack-error');
      expect(JSON.stringify(err) + String(err) + (err.stack ?? '')).not.toContain(echoed);
    }
  });

  it('429 → ratelimited with Retry-After in ms, capped at a minute, a second when missing', async () => {
    const cases: Array<[string | null, number]> = [
      ['5', 5_000],
      ['999', 60_000],
      [null, 1_000],
      ['0', 1_000],
      ['soon', 1_000],
      ['1.5', 1_000],
      ['-3', 1_000],
      ['9'.repeat(400), 60_000],
    ];
    for (const [retryAfter, ms] of cases) {
      const headers: Record<string, string> = retryAfter === null ? {} : { 'retry-after': retryAfter };
      const api = createSlackApi({
        fetchImpl: fakeSlack(() => new Response('{"ok":false,"error":"ratelimited"}', { status: 429, headers })).fetchImpl,
      });
      const err = await failure(api.appendStream(BOT, { channel: 'D1', ts: '1.3', chunks: [] }));
      expect(err.code).toBe('ratelimited');
      expect(err.retryAfterMs, String(retryAfter)).toBe(ms);
      expect(err.message).toBe('slack chat.appendStream: ratelimited');
    }
  });

  it('ok:false ratelimited on a 200 also carries retryAfterMs', async () => {
    const api = createSlackApi({
      fetchImpl: fakeSlack(() => slackError('ratelimited', { headers: { 'retry-after': '7' } })).fetchImpl,
    });
    const err = await failure(api.postMessage(BOT, { channel: 'D1', threadTs: '1.2', markdownText: 'x' }));
    expect(err.code).toBe('ratelimited');
    expect(err.retryAfterMs).toBe(7_000);
  });

  it('3xx → redirect, and the request used redirect: manual', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const slack = fakeSlack(
        () => new Response(null, { status, headers: { location: 'https://evil.example/api/users.info' } }),
      );
      const err = await failure(createSlackApi({ fetchImpl: slack.fetchImpl }).usersInfo(BOT, 'U1'));
      expect(err.code).toBe('redirect');
      expect(slack.sent).toHaveLength(1);
      expect(slack.sent[0]!.init.redirect).toBe('manual');
    }
  });

  it('a fetch that followed a redirect anyway → redirect', async () => {
    const followed = Object.defineProperty(okJson({ user: { id: 'U1' } }), 'redirected', { value: true });
    const api = createSlackApi({ fetchImpl: fakeSlack(() => followed).fetchImpl });
    expect((await failure(api.usersInfo(BOT, 'U1'))).code).toBe('redirect');
  });

  it('an opaque redirect (what redirect: manual yields in a browser fetch) → redirect', async () => {
    // A real one has status 0, no body and redirected:false; the second case
    // keeps a 200 and a good body, so only `type` can catch it.
    const opaque = (): Response =>
      Object.defineProperties(new Response(null, { status: 200 }), {
        type: { value: 'opaqueredirect' },
        status: { value: 0 },
      });
    const disguised = (): Response =>
      Object.defineProperty(okJson({ user: { id: 'U1' } }), 'type', { value: 'opaqueredirect' });
    for (const [label, answer] of [['opaque', opaque], ['200 with ok body', disguised]] as const) {
      const api = createSlackApi({ fetchImpl: fakeSlack(answer).fetchImpl });
      expect((await failure(api.usersInfo(BOT, 'U1'))).code, label).toBe('redirect');
    }
  });

  it('another non-2xx status → http-<status>', async () => {
    for (const status of [400, 404, 500, 503]) {
      const api = createSlackApi({
        fetchImpl: fakeSlack(() => new Response('{"ok":true,"user":{}}', { status })).fetchImpl,
      });
      expect((await failure(api.usersInfo(BOT, 'U1'))).code).toBe(`http-${status}`);
    }
  });

  it('body over 1 MiB → too-large, whether or not it says so up front', async () => {
    const big = `{"ok":true,"user":{"x":"${'a'.repeat(SLACK_RESPONSE_CAP_BYTES)}"}}`;
    const declared = createSlackApi({
      fetchImpl: fakeSlack(() => new Response(big, { status: 200, headers: { 'content-length': String(big.length) } })).fetchImpl,
    });
    expect((await failure(declared.usersInfo(BOT, 'U1'))).code).toBe('too-large');

    // No content-length: counted as it streams.
    const streamed = createSlackApi({
      fetchImpl: fakeSlack(() => new Response(new Blob([big]).stream(), { status: 200 })).fetchImpl,
    });
    expect((await failure(streamed.usersInfo(BOT, 'U1'))).code).toBe('too-large');
  });

  it('a body just under the cap is read', async () => {
    const pad = SLACK_RESPONSE_CAP_BYTES - '{"ok":true,"user":{"x":""}}'.length;
    const body = `{"ok":true,"user":{"x":"${'a'.repeat(pad)}"}}`;
    expect(body).toHaveLength(SLACK_RESPONSE_CAP_BYTES);
    const api = createSlackApi({ fetchImpl: fakeSlack(() => new Response(body, { status: 200 })).fetchImpl });
    expect(await api.usersInfo(BOT, 'U1')).toStrictEqual({ x: 'a'.repeat(pad) });
  });

  it('non-JSON, or JSON that is not a Slack answer → bad-response', async () => {
    for (const body of ['<html>oops</html>', '', '[1,2]', 'null', '"ok"', '{}', '{"ok":"true"}']) {
      const api = createSlackApi({ fetchImpl: fakeSlack(() => new Response(body, { status: 200 })).fetchImpl });
      expect((await failure(api.usersInfo(BOT, 'U1'))).code, body).toBe('bad-response');
    }
  });

  it('no response within timeoutMs → timeout, even from a fetch that ignores its signal', async () => {
    const api = createSlackApi({
      fetchImpl: fakeSlack(() => new Promise<Response>(() => {})).fetchImpl,
      timeoutMs: 50,
    });
    const started = Date.now();
    const err = await failure(api.usersInfo(BOT, 'U1'));
    expect(err.code).toBe('timeout');
    expect(err.message).toBe('slack users.info: timeout');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('the deadline aborts the request signal', async () => {
    let abortedWith: unknown = 'not aborted';
    const slack = fakeSlack(
      (req) =>
        new Promise<Response>((_resolve, reject) => {
          req.init.signal!.addEventListener('abort', () => {
            abortedWith = req.init.signal!.reason;
            reject(req.init.signal!.reason);
          });
        }),
    );
    const err = await failure(createSlackApi({ fetchImpl: slack.fetchImpl, timeoutMs: 50 }).usersInfo(BOT, 'U1'));
    expect(err.code).toBe('timeout');
    expect(abortedWith).not.toBe('not aborted');
  });

  it('a body that stalls past timeoutMs → timeout', async () => {
    const stalled = () => new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
    const api = createSlackApi({ fetchImpl: fakeSlack(stalled).fetchImpl, timeoutMs: 50 });
    expect((await failure(api.usersInfo(BOT, 'U1'))).code).toBe('timeout');
  });

  it('a finished call leaves no timer behind', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const api = createSlackApi({ fetchImpl: fakeSlack(() => okJson({ user: { id: 'U1' } })).fetchImpl });
    await api.usersInfo(BOT, 'U1');
    await failure(createSlackApi({ fetchImpl: fakeSlack(() => slackError('invalid_auth')).fetchImpl }).usersInfo(BOT, 'U1'));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fetch throws → network, whether it rejects or throws outright', async () => {
    const rejects = createSlackApi({
      fetchImpl: fakeSlack(() => Promise.reject(new TypeError('fetch failed'))).fetchImpl,
    });
    expect((await failure(rejects.usersInfo(BOT, 'U1'))).code).toBe('network');

    const throws = createSlackApi({
      fetchImpl: (() => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    expect((await failure(throws.usersInfo(BOT, 'U1'))).code).toBe('network');
  });

  it('refuses a timeoutMs that is not a positive integer', () => {
    const { fetchImpl } = fakeSlack(() => okJson());
    for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createSlackApi({ fetchImpl, timeoutMs }), String(timeoutMs)).toThrow(RangeError);
    }
  });

  it('an error message is "slack <method>: <code>" and never contains a token', async () => {
    const leaky: Array<[string, () => Response | Promise<Response>]> = [
      ['Slack echoes a token as its error', () => slackError(BOT)],
      ['fetch fails with a token in its message', () => Promise.reject(new Error(`ECONNRESET Bearer ${BOT} ${CFG}`))],
      ['a 500 whose body holds tokens', () => new Response(`${BOT} ${CFG} ${REFRESH}`, { status: 500 })],
      ['a non-JSON 200 holding tokens', () => new Response(`<html>${BOT} ${CLIENT_SECRET}</html>`, { status: 200 })],
      [
        'a redirect to a URL holding a token',
        () => new Response(null, { status: 302, headers: { location: `https://evil.example/?t=${BOT}` } }),
      ],
    ];
    for (const [label, answer] of leaky) {
      const api = createSlackApi({ fetchImpl: fakeSlack(answer).fetchImpl });
      for (const [method, run] of everyMethod(api)) {
        const err = await failure(run());
        expect(err.message, `${label}: ${method}`).toMatch(/^slack [A-Za-z0-9.]+: [a-z0-9_-]+$/);
        expect(err.message).toBe(`slack ${method}: ${err.code}`);
        expect(err.cause).toBeUndefined();
        const dump = [err.message, String(err), err.stack ?? '', JSON.stringify(err), JSON.stringify(Object.entries(err))].join('\n');
        for (const secret of SECRETS) expect(dump, `${label}: ${method}`).not.toContain(secret);
      }
    }
  });
});
