import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pngHeader } from './fake-png.js';
import { BOT_PREFIX, fakeBotToken, fakeConfigAccessToken, fakeConfigRefreshToken } from './fake-slack-tokens.js';
import { SLACK_RESPONSE_CAP_BYTES } from '../limits.js';
import { BOT_SCOPES, buildAppManifest, slackUrls } from '../manifest.js';
import { SlackApiError, createSlackApi, type SlackApi, type SlackChannel } from '../slack-api.js';

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
/** The bot's picture, as Connect hands it over: a 512 px PNG's bytes. */
const PNG = pngHeader(512, 512);

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

/**
 * A public channel as conversations.info describes it:
 * Slack's own example (docs.slack.dev), plus `is_member` as the bot sees it.
 */
const GENERAL = {
  id: 'C012AB3CD',
  name: 'general',
  is_channel: true,
  is_group: false,
  is_im: false,
  is_mpim: false,
  is_private: false,
  created: 1654868334,
  is_archived: false,
  is_general: true,
  unlinked: 0,
  name_normalized: 'general',
  is_shared: false,
  is_frozen: false,
  is_org_shared: false,
  is_ext_shared: false,
  is_pending_ext_shared: false,
  pending_shared: [],
  context_team_id: 'T0TEAM',
  parent_conversation: null,
  creator: 'U0CREATOR',
  shared_team_ids: ['T0TEAM'],
  pending_connected_team_ids: [],
  is_member: true,
  topic: { value: 'For public discussion of generalities', creator: 'U0CREATOR', last_set: 1449709364 },
  purpose: { value: 'This part of the workspace is for fun.', creator: 'U0CREATOR', last_set: 1449709364 },
  previous_names: ['specifics', 'abstractions'],
};

/** GENERAL, narrowed: exactly these fields, nothing else Slack sent (its `is_private` included: TASK-1203). */
const GENERAL_OUT: SlackChannel = {
  id: 'C012AB3CD',
  name: 'general',
  isChannel: true,
  isArchived: false,
  isExtShared: false,
  isPendingExtShared: false,
};

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
  channel: GENERAL,
  channels: [GENERAL],
};

/** Every method, called with the secrets above. */
function everyMethod(api: SlackApi): Array<[string, () => Promise<unknown>]> {
  return [
    ['tooling.tokens.rotate', () => api.rotateConfigToken(REFRESH)],
    ['apps.manifest.create', () => api.createApp(CFG, { display_information: { name: 'ax' } })],
    ['apps.manifest.update', () => api.updateApp(CFG, 'A0APP', { display_information: { name: 'ax' } })],
    ['apps.manifest.delete', () => api.deleteApp(CFG, 'A0APP')],
    ['apps.icon.set', () => api.setAppIcon(CFG, 'A0APP', PNG)],
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
    ['users.lookupByEmail', () => api.usersLookupByEmail(BOT, 'ada@example.com')],
    [
      'chat.postMessage',
      () => api.postMessage(BOT, { channel: 'D1', threadTs: '1.2', markdownText: 'hi' }),
    ],
    [
      'chat.postMessage',
      () => api.postBlocks(BOT, { channel: 'D1', threadTs: '1.2', text: 'hi', blocks: [] }),
    ],
    ['chat.postMessage', () => api.postDirect(BOT, { user: 'U07ADA00001', text: 'hi' })],
    ['chat.update', () => api.updateMessage(BOT, { channel: 'D1', ts: '1.3', text: 'hi', blocks: [] })],
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
    ['reactions.add', () => api.addReaction(BOT, { channel: 'D1', ts: '1.2', name: 'eyes' })],
    ['reactions.remove', () => api.removeReaction(BOT, { channel: 'D1', ts: '1.2', name: 'eyes' })],
    ['conversations.info', () => api.conversationsInfo(BOT, 'C012AB3CD')],
  ];
}

const FORM_METHODS = [
  'tooling.tokens.rotate',
  'apps.manifest.create',
  'apps.manifest.update',
  'apps.manifest.delete',
  'oauth.v2.access',
  'users.info',
  'users.lookupByEmail',
  'conversations.info',
];
/** Methods that upload a file: `multipart/form-data`, its boundary written by fetch. */
const MULTIPART_METHODS = ['apps.icon.set'];

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
    // chat.postMessage answers a DM's channel id as a string (conversations.info's is an object).
    const slack = fakeSlack((req) =>
      okJson(req.method === 'chat.postMessage' ? { ...EVERY_FIELD, channel: 'D07ADA00001' } : EVERY_FIELD),
    );
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
      const multipart = MULTIPART_METHODS.includes(req.method);
      if (multipart) {
        // fetch writes the content type, with the boundary only it knows.
        expect(req.init.body, req.method).toBeInstanceOf(FormData);
        expect(req.headers.get('content-type'), req.method).toBeNull();
      } else if (FORM_METHODS.includes(req.method)) {
        expect(type, req.method).toMatch(/^application\/x-www-form-urlencoded/);
      } else {
        expect(req.method).toMatch(/^(chat|reactions)\./);
        expect(type, req.method).toMatch(/^application\/json/);
      }
      const auth = req.headers.get('authorization');
      if (req.method === 'tooling.tokens.rotate') expect(auth).toBeNull();
      else if (req.method === 'oauth.v2.access') expect(auth).toMatch(/^Basic /);
      else expect(auth, req.method).toBe(`Bearer ${req.method.startsWith('apps.') ? CFG : BOT}`);
      // Nothing but the content type (unless fetch writes it) and, maybe, the credential.
      expect([...req.headers.keys()].sort(), req.method).toStrictEqual(
        multipart ? ['authorization'] : auth === null ? ['content-type'] : ['authorization', 'content-type'],
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

  it("addReaction and removeReaction send Slack's own field names as JSON", async () => {
    const slack = fakeSlack(() => okJson({}));
    const api = createSlackApi({ fetchImpl: slack.fetchImpl });
    await api.addReaction(BOT, { channel: 'D1', ts: '1.2', name: 'eyes' });
    await api.removeReaction(BOT, { channel: 'D1', ts: '1.2', name: 'eyes' });
    expect(slack.sent.map((r) => r.url)).toStrictEqual([
      'https://slack.com/api/reactions.add',
      'https://slack.com/api/reactions.remove',
    ]);
    for (const r of slack.sent) {
      expect(JSON.parse(r.body)).toStrictEqual({ channel: 'D1', timestamp: '1.2', name: 'eyes' });
    }
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

  it('postBlocks sends exactly channel, thread_ts, text, blocks and no unfurling, and returns the ts', async () => {
    const slack = fakeSlack(() => okJson({ ts: '1700000000.000200' }));
    const blocks = [{ type: 'section', text: { type: 'plain_text', text: 'ok?' } }];
    const out = await createSlackApi({ fetchImpl: slack.fetchImpl }).postBlocks(BOT, {
      channel: 'D1',
      threadTs: '1.2',
      text: 'ok?',
      blocks,
    });
    expect(out).toStrictEqual({ ts: '1700000000.000200' });
    expect(slack.sent[0]!.url).toBe('https://slack.com/api/chat.postMessage');
    expect(slack.sent[0]!.headers.get('authorization')).toBe(`Bearer ${BOT}`);
    expect(slack.sent[0]!.body).not.toContain(BOT);
    expect(JSON.parse(slack.sent[0]!.body)).toStrictEqual({
      channel: 'D1',
      thread_ts: '1.2',
      text: 'ok?',
      blocks,
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  it('postBlocks without a usable ts is bad-response', async () => {
    for (const fields of [{}, { ts: 5 }, { ts: '' }]) {
      const api = createSlackApi({ fetchImpl: fakeSlack(() => okJson(fields)).fetchImpl });
      const err = await failure(api.postBlocks(BOT, { channel: 'D1', threadTs: '1.2', text: 'x', blocks: [] }));
      expect(err.code).toBe('bad-response');
    }
  });

  it('usersLookupByEmail sends the email as a form field and answers the user id', async () => {
    const slack = fakeSlack(() => okJson({ user: { id: 'U07ADA00001', profile: { email: 'ada@example.com' } } }));
    const id = await createSlackApi({ fetchImpl: slack.fetchImpl }).usersLookupByEmail(BOT, 'ada+x@example.com');

    expect(id).toBe('U07ADA00001');
    const [req] = slack.sent;
    expect(req!.url).toBe('https://slack.com/api/users.lookupByEmail');
    expect(req!.headers.get('content-type')).toMatch(/^application\/x-www-form-urlencoded/);
    expect(req!.headers.get('authorization')).toBe(`Bearer ${BOT}`);
    expect(req!.body).toBe('email=ada%2Bx%40example.com');
  });

  it('usersLookupByEmail: no usable id is bad-response; users_not_found keeps its code; the error never holds the address', async () => {
    for (const bad of [{}, { user: null }, { user: 'U1' }, { user: [] }, { user: {} }, { user: { id: 5 } }, { user: { id: '' } }]) {
      const api = createSlackApi({ fetchImpl: fakeSlack(() => okJson(bad)).fetchImpl });
      const err = await failure(api.usersLookupByEmail(BOT, 'ada@example.com'));
      expect(err.code).toBe('bad-response');
      expect(err.message).not.toContain('ada@example.com');
    }
    const missing = createSlackApi({
      fetchImpl: fakeSlack(() => okJson({ ok: false, error: 'users_not_found' })).fetchImpl,
    });
    const err = await failure(missing.usersLookupByEmail(BOT, 'ada@example.com'));
    expect(err.code).toBe('users_not_found');
    expect(err.message).toBe('slack users.lookupByEmail: users_not_found');
  });

  it('postDirect posts to the user id at the top level with unfurls off, and answers the DM channel and ts', async () => {
    const slack = fakeSlack(() => okJson({ channel: 'D07ADA00001', ts: '1700000000.000300' }));
    const api = createSlackApi({ fetchImpl: slack.fetchImpl });
    const blocks = [{ type: 'section', text: { type: 'plain_text', text: 'ok?' } }];

    const out = await api.postDirect(BOT, { user: 'U07ADA00001', text: 'ok?', blocks });
    expect(out).toStrictEqual({ channel: 'D07ADA00001', ts: '1700000000.000300' });
    expect(slack.sent[0]!.url).toBe('https://slack.com/api/chat.postMessage');
    expect(slack.sent[0]!.headers.get('authorization')).toBe(`Bearer ${BOT}`);
    expect(slack.sent[0]!.body).not.toContain(BOT);
    expect(JSON.parse(slack.sent[0]!.body)).toStrictEqual({
      channel: 'U07ADA00001',
      text: 'ok?',
      blocks,
      unfurl_links: false,
      unfurl_media: false,
    });

    await api.postDirect(BOT, { user: 'U07ADA00001', text: 'plain' });
    const plain = JSON.parse(slack.sent[1]!.body) as Record<string, unknown>;
    expect(plain).not.toHaveProperty('blocks');
    expect(plain).not.toHaveProperty('thread_ts');
  });

  it('postDirect: an answer missing the channel or the ts is bad-response', async () => {
    const goodTs = '1700000000.000300';
    for (const fields of [{}, { ts: goodTs }, { channel: 'D07ADA00001' }, { channel: GENERAL, ts: goodTs }, { channel: '', ts: goodTs }, { channel: 'D07ADA00001', ts: 5 }]) {
      const api = createSlackApi({ fetchImpl: fakeSlack(() => okJson(fields)).fetchImpl });
      const err = await failure(api.postDirect(BOT, { user: 'U07ADA00001', text: 'x' }));
      expect(err.code).toBe('bad-response');
    }
  });

  it('updateMessage sends exactly channel, ts, text, blocks to chat.update', async () => {
    const slack = fakeSlack(() => okJson());
    const blocks = [{ type: 'section', text: { type: 'plain_text', text: 'Allowed' } }];
    await createSlackApi({ fetchImpl: slack.fetchImpl }).updateMessage(BOT, {
      channel: 'D1',
      ts: '1.3',
      text: 'Allowed',
      blocks,
    });
    expect(slack.sent[0]!.url).toBe('https://slack.com/api/chat.update');
    expect(slack.sent[0]!.headers.get('authorization')).toBe(`Bearer ${BOT}`);
    expect(slack.sent[0]!.body).not.toContain(BOT);
    expect(JSON.parse(slack.sent[0]!.body)).toStrictEqual({
      channel: 'D1',
      ts: '1.3',
      text: 'Allowed',
      blocks,
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

  it('rotateConfigToken returns the access token, the refresh token Slack minted to replace the one sent, and expiresAt', async () => {
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
    expect(out).toStrictEqual({
      accessToken: NEW_ACCESS,
      refreshToken: MINTED_REFRESH,
      expiresAt: 1_800_000_000_000,
    });
  });

  it('rotateConfigToken without a usable token, refresh_token or exp → bad-response, and the error carries none of it', async () => {
    // Valid on every rule. Each case breaks exactly one field (an undefined
    // one is left out of the JSON), so it can only fail on that field's rule.
    const GOOD = { token: NEW_ACCESS, refresh_token: MINTED_REFRESH, exp: 1_800_000_000 };
    const broken: Array<Record<string, unknown>> = [
      { ...GOOD, token: undefined },
      { ...GOOD, token: 'has a space' },
      { ...GOOD, exp: undefined },
      { ...GOOD, exp: '1800000000' },
      { ...GOOD, exp: 1.5 },
      { ...GOOD, exp: 0 },
      { ...GOOD, refresh_token: undefined },
      { ...GOOD, refresh_token: '' },
      { ...GOOD, refresh_token: 'has a space' },
      { ...GOOD, refresh_token: 'r\r\nx-injected: 1' },
      { ...GOOD, refresh_token: 42 },
      { ...GOOD, refresh_token: null },
      { ...GOOD, refresh_token: 'r'.repeat(513) },
    ];
    for (const body of broken) {
      const label = JSON.stringify(body);
      const api = createSlackApi({ fetchImpl: fakeSlack(() => okJson(body)).fetchImpl });
      const err = await failure(api.rotateConfigToken(REFRESH));
      expect(err.code, label).toBe('bad-response');
      expect(err.message, label).toBe('slack tooling.tokens.rotate: bad-response');
      const dump = [err.message, String(err), err.stack ?? '', JSON.stringify(err), JSON.stringify(Object.entries(err))].join('\n');
      for (const secret of [NEW_ACCESS, MINTED_REFRESH, REFRESH]) expect(dump, label).not.toContain(secret);
    }
    // The longest refresh token the rule allows still goes through.
    const longest = createSlackApi({
      fetchImpl: fakeSlack(() => okJson({ ...GOOD, refresh_token: 'r'.repeat(512) })).fetchImpl,
    });
    expect((await longest.rotateConfigToken(REFRESH)).refreshToken).toHaveLength(512);
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

  it('deleteApp sends a form field with the config token', async () => {
    const slack = fakeSlack(() => okJson());
    await createSlackApi({ fetchImpl: slack.fetchImpl }).deleteApp(CFG, 'A0APP');
    expect(slack.sent.map((r) => [r.method, formOf(r), r.headers.get('authorization')])).toStrictEqual([
      ['apps.manifest.delete', { app_id: 'A0APP' }, `Bearer ${CFG}`],
    ]);
  });

  it('setAppIcon uploads the PNG as multipart "file" beside "app_id", with the config token and no hand-set content type', async () => {
    const slack = fakeSlack(() => okJson());
    await createSlackApi({ fetchImpl: slack.fetchImpl }).setAppIcon(CFG, 'A0APP', PNG);

    expect(slack.sent.map((r) => r.url)).toStrictEqual(['https://slack.com/api/apps.icon.set']);
    const [req] = slack.sent;
    expect(req!.headers.get('authorization')).toBe(`Bearer ${CFG}`);
    // fetch writes `multipart/form-data; boundary=…` itself; a hand-set one would lack the boundary.
    expect(req!.headers.get('content-type')).toBeNull();
    const form = req!.init.body;
    if (!(form instanceof FormData)) throw new Error('expected a FormData body');
    expect([...form.keys()].sort()).toStrictEqual(['app_id', 'file']);
    expect(form.getAll('app_id')).toStrictEqual(['A0APP']);
    expect(form.getAll('file')).toHaveLength(1);
    const file = form.get('file');
    if (!(file instanceof File)) throw new Error('expected "file" to be a File');
    expect(file.name).toBe('icon.png');
    expect(file.type).toBe('image/png');
    expect(Buffer.from(await file.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('updateApp sends the app id and the whole manifest as form fields with the config token', async () => {
    const slack = fakeSlack(() => okJson({ app_id: 'A0APP', permissions_updated: false }));
    const manifest = buildAppManifest('Ada Helper', slackUrls('https://ax.example', 'AAAAAAAAAAAAAAAAAAAAAA'));
    await createSlackApi({ fetchImpl: slack.fetchImpl }).updateApp(CFG, 'A0APP', manifest);

    expect(slack.sent.map((r) => [r.method, formOf(r), r.headers.get('authorization')])).toStrictEqual([
      ['apps.manifest.update', { app_id: 'A0APP', manifest: JSON.stringify(manifest) }, `Bearer ${CFG}`],
    ]);
    expect(JSON.parse(formOf(slack.sent[0]!)['manifest']!)).toEqual(manifest);
  });

  it('updateApp resolves whatever permissions_updated says, and rejects refusals code-only', async () => {
    const manifest = { display_information: { name: 'ax' } };
    for (const fields of [
      { app_id: 'A0APP', permissions_updated: true },
      { app_id: 'A0APP', permissions_updated: false },
      {},
    ]) {
      const api = createSlackApi({ fetchImpl: fakeSlack(() => okJson(fields)).fetchImpl });
      await expect(api.updateApp(CFG, 'A0APP', manifest), JSON.stringify(fields)).resolves.toBeUndefined();
    }

    for (const code of ['invalid_manifest', 'invalid_auth', 'token_revoked']) {
      const api = createSlackApi({ fetchImpl: fakeSlack(() => slackError(code)).fetchImpl });
      const err = await failure(api.updateApp(CFG, 'A0APP', manifest));
      expect(err.message).toBe(`slack apps.manifest.update: ${code}`);
      expect(err.method).toBe('apps.manifest.update');
      expect(err.code).toBe(code);
    }

    // Slack explains a refused manifest in `errors` (docs.slack.dev's own
    // example). None of Slack's text rides along on the error.
    const explained = {
      ok: false,
      error: 'invalid_manifest',
      errors: [
        {
          message: 'Event Subscription requires either Request URL or Socket Mode Enabled',
          pointer: '/settings/event_subscriptions',
        },
        { message: 'Interactivity requires a Request URL', pointer: '/settings/interactivity' },
      ],
    };
    const api = createSlackApi({
      fetchImpl: fakeSlack(() => new Response(JSON.stringify(explained), { status: 200 })).fetchImpl,
    });
    const err = await failure(api.updateApp(CFG, 'A0APP', manifest));
    expect(err.message).toBe('slack apps.manifest.update: invalid_manifest');
    const dump = [err.message, String(err), err.stack ?? '', JSON.stringify(err), JSON.stringify(Object.entries(err))].join('\n');
    for (const said of ['Request URL', '/settings/']) expect(dump, said).not.toContain(said);
  });
});

describe('conversations', () => {
  /** A Slack refusal as Slack sends it; `missing_scope` also names the scopes. */
  function refusal(code: string): Response {
    const scopes = code === 'missing_scope' ? { needed: 'channels:read', provided: 'chat:write,users:read' } : {};
    return new Response(JSON.stringify({ ok: false, error: code, ...scopes }), { status: 200 });
  }

  it('conversations.info sends the channel as a form with the bot token and returns only the narrowed fields', async () => {
    const slack = fakeSlack(() => okJson({ channel: GENERAL }));
    const out = await createSlackApi({ fetchImpl: slack.fetchImpl }).conversationsInfo(BOT, 'C012AB3CD');

    expect(out).toStrictEqual(GENERAL_OUT);
    const [req] = slack.sent;
    expect(req!.url).toBe('https://slack.com/api/conversations.info');
    expect(req!.headers.get('content-type')).toMatch(/^application\/x-www-form-urlencoded/);
    expect(req!.headers.get('authorization')).toBe(`Bearer ${BOT}`);
    expect(req!.body).toBe('channel=C012AB3CD');
  });

  it("Slack's refusals reject as SlackApiError with exactly `slack <method>: <code>`", async () => {
    const methods: Array<[string, (api: SlackApi) => Promise<unknown>]> = [
      ['conversations.info', (api) => api.conversationsInfo(BOT, 'C012AB3CD')],
    ];
    const codes = ['missing_scope', 'channel_not_found', 'is_archived', 'method_not_supported_for_channel_type'];
    for (const [method, run] of methods) {
      for (const code of codes) {
        const err = await failure(run(createSlackApi({ fetchImpl: fakeSlack(() => refusal(code)).fetchImpl })));
        expect(err.message, `${method} ${code}`).toBe(`slack ${method}: ${code}`);
        expect(err.method).toBe(method);
        expect(err.code).toBe(code);
      }
    }
  });

  it("missing_scope keeps the scopes Slack says the call needed as `needed` and the token's own as `provided`, never in the message; a refusal naming none has neither", async () => {
    const api = (code: string) => createSlackApi({ fetchImpl: fakeSlack(() => refusal(code)).fetchImpl });
    const scoped = await failure(api('missing_scope').conversationsInfo(BOT, 'C012AB3CD'));
    expect(scoped.code).toBe('missing_scope');
    expect(scoped.needed).toBe('channels:read');
    // What the token holds: channel-check.ts reads it to tell a token's missing scope from a channel's.
    expect(scoped.provided).toBe('chat:write,users:read');
    expect(scoped.message).toBe('slack conversations.info: missing_scope');
    expect(String(scoped) + (scoped.stack ?? '')).not.toContain('chat:write');

    const unscoped = await failure(api('channel_not_found').conversationsInfo(BOT, 'C012AB3CD'));
    expect('needed' in unscoped).toBe(false);
    expect('provided' in unscoped).toBe(false);
  });

  it('any refusal that names scopes keeps them, whatever its code: nothing checks for missing_scope first', async () => {
    const named = { ok: false, error: 'channel_not_found', needed: 'groups:read', provided: 'channels:read' };
    const api = createSlackApi({
      fetchImpl: fakeSlack(() => new Response(JSON.stringify(named), { status: 200 })).fetchImpl,
    });
    const err = await failure(api.conversationsInfo(BOT, 'C012AB3CD'));
    expect(err.code).toBe('channel_not_found');
    expect(err.needed).toBe('groups:read');
    expect(err.provided).toBe('channels:read');
  });

  it('a refusing flag (archived, Slack Connect) is set unless absent, null or false: one we cannot read fails closed', async () => {
    const flags = [
      ['is_archived', 'isArchived'],
      ['is_ext_shared', 'isExtShared'],
      ['is_pending_ext_shared', 'isPendingExtShared'],
    ] as const;
    // `undefined` is dropped by JSON.stringify: the field is absent.
    const cases: Array<[unknown, boolean]> = [
      [undefined, false],
      [null, false],
      [false, false],
      [true, true],
      ['true', true],
      ['false', true],
      [1, true],
      [0, true],
      ['', true],
      [{}, true],
    ];
    for (const [key, field] of flags) {
      for (const [value, set] of cases) {
        const channel = { ...GENERAL, [key]: value };
        const api = createSlackApi({ fetchImpl: fakeSlack(() => okJson({ channel })).fetchImpl });
        const out = await api.conversationsInfo(BOT, 'C012AB3CD');
        expect(out[field], `${key}: ${JSON.stringify(value)}`).toBe(set);
      }
    }
  });

  // TASK-1203 (design §4c): a private channel is answered in and remembered like any other, so nothing
  // reads Slack's `is_private`: one fewer untrusted flag narrowed (invariant 5).
  it("conversations.info's is_private is not read: a private channel narrows to the same SlackChannel as a public one (TASK-1203)", async () => {
    // `undefined` is dropped by JSON.stringify: the field is absent.
    for (const value of [true, false, undefined, null, 'false']) {
      const channel = { ...GENERAL, is_private: value };
      const api = createSlackApi({ fetchImpl: fakeSlack(() => okJson({ channel })).fetchImpl });
      const out = await api.conversationsInfo(BOT, 'C012AB3CD');
      expect(out, `is_private: ${JSON.stringify(value)}`).toStrictEqual(GENERAL_OUT);
    }
  });

  it('isChannel is true only when Slack says literally true', async () => {
    const fields = [['is_channel', 'isChannel']] as const;
    const cases: Array<[unknown, boolean]> = [
      [true, true],
      [undefined, false],
      [null, false],
      [false, false],
      ['true', false],
      [1, false],
      [{}, false],
    ];
    for (const [key, field] of fields) {
      for (const [value, want] of cases) {
        const channel = { ...GENERAL, [key]: value };
        const api = createSlackApi({ fetchImpl: fakeSlack(() => okJson({ channel })).fetchImpl });
        const out = await api.conversationsInfo(BOT, 'C012AB3CD');
        expect(out[field], `${key}: ${JSON.stringify(value)}`).toBe(want);
      }
    }
  });

  it('an info answer without a usable channel → bad-response', async () => {
    for (const body of [
      {},
      { channel: null },
      { channel: 'C012AB3CD' },
      { channel: [GENERAL] },
      { channel: { ...GENERAL, id: undefined } },
      { channel: { ...GENERAL, id: '' } },
      { channel: { ...GENERAL, id: 'C012 AB3CD' } },
      { channel: { ...GENERAL, id: 'C'.repeat(65) } },
      { channel: { ...GENERAL, id: 42 } },
      { channel: { ...GENERAL, name: undefined } },
      { channel: { ...GENERAL, name: null } },
      { channel: { ...GENERAL, name: ['general'] } },
    ]) {
      const api = createSlackApi({ fetchImpl: fakeSlack(() => okJson(body)).fetchImpl });
      expect((await failure(api.conversationsInfo(BOT, 'C012AB3CD'))).code, JSON.stringify(body)).toBe(
        'bad-response',
      );
    }
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

  it("Slack's `needed` is kept only when it reads as scope names: lowercase letters, _ - . : and commas, at most 200", async () => {
    const cases: Array<[unknown, string | null]> = [
      ['channels:read', 'channels:read'],
      ['incoming-webhook', 'incoming-webhook'],
      ['channels:read,groups:read', 'channels:read,groups:read'],
      ['users:read.email', 'users:read.email'],
      ['a'.repeat(200), 'a'.repeat(200)],
      ['a'.repeat(201), null],
      ['', null],
      ['Channels:read', null],
      ['channels:read groups:read', null],
      ['channels:read\n', null],
      ['channels:read2', null],
      ['<script>', null],
      [['channels:read'], null],
      [{ scope: 'channels:read' }, null],
      [42, null],
      [true, null],
      [null, null],
      [undefined, null],
    ];
    for (const [needed, kept] of cases) {
      const api = createSlackApi({
        fetchImpl: fakeSlack(() => new Response(JSON.stringify({ ok: false, error: 'missing_scope', needed }), { status: 200 }))
          .fetchImpl,
      });
      const err = await failure(api.conversationsInfo(BOT, 'C012AB3CD'));
      expect(err.code, JSON.stringify(needed)).toBe('missing_scope');
      expect(err.message).toBe('slack conversations.info: missing_scope');
      if (kept === null) expect('needed' in err, JSON.stringify(needed)).toBe(false);
      else expect(err.needed, JSON.stringify(needed)).toBe(kept);
    }
  });

  it("Slack's `provided` is kept when it reads as scope names (lowercase letters, _ - . : and commas, at most 1000); one Slack sent that doesn't is kept as ''", async () => {
    // Every scope the shared app's token holds, as Slack lists them.
    const shared = BOT_SCOPES.join(',');
    // '' marks a `provided` Slack sent in a form we can't read (TASK-1184): channel-check.ts reads it as unknown.
    const cases: Array<[unknown, string | null]> = [
      ['channels:read', 'channels:read'],
      [shared, shared],
      ['a'.repeat(1000), 'a'.repeat(1000)],
      // A hyphenated scope (incoming-webhook) is a scope name like any other.
      ['incoming-webhook,channels:read', 'incoming-webhook,channels:read'],
      ['a'.repeat(1001), ''],
      ['', ''],
      ['Channels:read', ''],
      ['chat:write, channels:read', ''],
      ['channels:read\n', ''],
      ['channels:read2', ''],
      ['<script>', ''],
      [['channels:read'], ''],
      [{ scope: 'channels:read' }, ''],
      [42, ''],
      [true, ''],
      [null, null],
      [undefined, null],
    ];
    for (const [provided, kept] of cases) {
      const api = createSlackApi({
        fetchImpl: fakeSlack(
          () =>
            new Response(JSON.stringify({ ok: false, error: 'missing_scope', needed: 'channels:read', provided }), {
              status: 200,
            }),
        ).fetchImpl,
      });
      const err = await failure(api.conversationsInfo(BOT, 'C012AB3CD'));
      expect(err.code, JSON.stringify(provided)).toBe('missing_scope');
      expect(err.message).toBe('slack conversations.info: missing_scope');
      // One unreadable list never costs the other.
      expect(err.needed, JSON.stringify(provided)).toBe('channels:read');
      if (kept === null) expect('provided' in err, JSON.stringify(provided)).toBe(false);
      else expect(err.provided, JSON.stringify(provided)).toBe(kept);
    }
  });

  it('a lowercase-hex secret Slack echoes as its `needed` or `provided` is never kept', async () => {
    for (const echoed of ['0a1b2c3d'.repeat(4), '8f742231b10e8888abcd99', 'c0ffee_1234']) {
      const api = createSlackApi({
        fetchImpl: fakeSlack(
          () =>
            new Response(JSON.stringify({ ok: false, error: 'missing_scope', needed: echoed, provided: echoed }), {
              status: 200,
            }),
        ).fetchImpl,
      });
      const err = await failure(api.conversationsInfo(BOT, 'C012AB3CD'));
      expect('needed' in err, echoed).toBe(false);
      // Sent but unreadable: kept as '' (never the echo itself).
      expect(err.provided, echoed).toBe('');
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
