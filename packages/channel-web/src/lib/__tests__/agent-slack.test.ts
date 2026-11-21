/**
 * An agent's Slack wire client (`lib/agent-slack.ts`, TASK-1094), stubbed at
 * `fetch` so the URLs, methods, headers and bodies it really sends are what is
 * asserted. The routes are @ax/channel-slack's (`agent-routes.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_SLACK_BOT_CHANGE_COPY,
  AGENT_SLACK_COPY,
  AgentSlackError,
  agentSlackBotChangeErrorCopy,
  renameAgentSlackBot,
  setAgentSlackBotPicture,
  agentSlackBotErrorCopy,
  agentSlackBotStale,
  askSlackBotApproval,
  cancelSlackBotRequest,
  agentSlackErrorCopy,
  agentSlackStateChanged,
  agentSlackWriteStale,
  cancelSlackBot,
  connectSlackChannel,
  continueSlackBot,
  requestSlackBot,
  disconnectSlackBot,
  disconnectSlackChannel,
  fetchAgentSlack,
  fetchAvailableChannels,
  setSlackBotChannelRemember,
  setSlackChannelRemember,
} from '../agent-slack';
import { fakeConfigRefreshToken } from '../../test-utils/fake-slack-tokens';

interface Call {
  url: string;
  method: string;
  credentials: RequestCredentials | undefined;
  headers: Record<string, string>;
  body: unknown;
}

let calls: Call[];
let answer: (call: Call) => Response;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A bot's install id, as the server sends it to those who manage the agent: 22 base64url characters. */
const BOT_ID = 'Hb7Kq2Lw8vNc5Xr1Bm7KdA';
const NO_BOT = { state: 'none', configTokenStored: true };
const PENDING_BOT = { state: 'pending', botName: 'Quill', approver: 'Ada', canContinue: true, installId: BOT_ID };
const LIVE_BOT = { state: 'live', botName: 'Quill', handle: 'quill', approver: 'Ada', needsClaim: false, installId: BOT_ID };

const ROW = { channelId: 'C1', name: 'support', remember: false, connectedBy: 'Ada', needsReconnect: false, needsInvite: false };

beforeEach(() => {
  calls = [];
  answer = () => json(200, {});
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      credentials: init?.credentials,
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    };
    calls.push(call);
    return answer(call);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchAgentSlack', () => {
  it('GETs /settings/slack/:agentId with the session cookie and reads each state', async () => {
    answer = () => json(200, { state: 'ready', botName: 'canopy', workspaceName: 'Acme', canManage: true, channels: [ROW], bot: NO_BOT, extra: 1 });
    await expect(fetchAgentSlack('a/1')).resolves.toEqual({
      state: 'ready',
      botName: 'canopy',
      workspaceName: 'Acme',
      canManage: true,
      channels: [ROW],
      bot: NO_BOT,
    });
    expect(calls[0]).toMatchObject({ url: '/settings/slack/a%2F1', method: 'GET', credentials: 'include' });

    answer = () => json(200, { state: 'no-workspace', canManage: false, bot: NO_BOT });
    await expect(fetchAgentSlack('a1')).resolves.toEqual({ state: 'no-workspace', canManage: false, bot: NO_BOT });
    answer = () => json(200, { state: 'personal-agent', botName: 'canopy', answersDms: false });
    await expect(fetchAgentSlack('a1')).resolves.toEqual({ state: 'personal-agent', botName: 'canopy', answersDms: false });
    answer = () => json(200, { state: 'personal-agent', botName: 'canopy', answersDms: true });
    await expect(fetchAgentSlack('a1')).resolves.toEqual({ state: 'personal-agent', botName: 'canopy', answersDms: true });
  });

  it('an older host that omits answersDms is read as true; a wrong-typed one is a bad response', async () => {
    answer = () => json(200, { state: 'personal-agent', botName: 'canopy' });
    await expect(fetchAgentSlack('a1')).resolves.toEqual({ state: 'personal-agent', botName: 'canopy', answersDms: true });
    answer = () => json(200, { state: 'personal-agent', botName: 'canopy', answersDms: 'no' });
    await expect(fetchAgentSlack('a1')).rejects.toMatchObject({ code: 'bad-response' });
  });

  it("reads whether a row still needs the agent's own bot invited; an older host that omits it reads false; a wrong-typed one is a bad response", async () => {
    const ready = (row: unknown) => ({ state: 'ready', botName: 'canopy', workspaceName: 'Acme', canManage: true, channels: [row], bot: LIVE_BOT });
    answer = () => json(200, ready({ ...ROW, needsInvite: true }));
    await expect(fetchAgentSlack('a1')).resolves.toMatchObject({ channels: [{ ...ROW, needsInvite: true }] });
    const { needsInvite: _omit, ...older } = ROW;
    answer = () => json(200, ready(older));
    await expect(fetchAgentSlack('a1')).resolves.toMatchObject({ channels: [{ ...ROW, needsInvite: false }] });
    answer = () => json(200, ready({ ...ROW, needsInvite: 'yes' }));
    await expect(fetchAgentSlack('a1')).rejects.toMatchObject({ code: 'bad-response' });
  });

  it("reads the agent's own bot's channels on ready and no-workspace; an older host that omits them reads none; a malformed one is a bad response (TASK-1180)", async () => {
    const BOT_ROW = { channelId: 'C0BOTSUP01', name: 'help', remember: true };
    const ready = (extra: Record<string, unknown>) => ({ state: 'ready', botName: 'canopy', workspaceName: 'Acme', canManage: true, channels: [], bot: LIVE_BOT, ...extra });
    const noWorkspace = (extra: Record<string, unknown>) => ({ state: 'no-workspace', canManage: true, bot: LIVE_BOT, ...extra });

    for (const make of [ready, noWorkspace]) {
      // Absent: the key stays off the read, so an older host reads as none.
      answer = () => json(200, make({}));
      expect(await fetchAgentSlack('a1')).not.toHaveProperty('botChannels');
      answer = () => json(200, make({ botChannels: [] }));
      await expect(fetchAgentSlack('a1')).resolves.toMatchObject({ botChannels: [] });
      answer = () => json(200, make({ botChannels: [{ ...BOT_ROW, extra: 1 }] }));
      // toEqual, not toMatchObject: an unknown key must be stripped, not carried through.
      expect(((await fetchAgentSlack('a1')) as { botChannels?: unknown }).botChannels).toEqual([BOT_ROW]);
      answer = () => json(200, make({ botChannels: [{ ...BOT_ROW, remember: 'yes' }] }));
      await expect(fetchAgentSlack('a1')).rejects.toMatchObject({ code: 'bad-response' });
      answer = () => json(200, make({ botChannels: [{ channelId: 'C1', remember: true }] }));
      await expect(fetchAgentSlack('a1')).rejects.toMatchObject({ code: 'bad-response' });
      answer = () => json(200, make({ botChannels: {} }));
      await expect(fetchAgentSlack('a1')).rejects.toMatchObject({ code: 'bad-response' });
    }
  });

  it('a 404 or a page that is not JSON is unavailable', async () => {
    answer = () => json(404, { error: 'not-found' });
    await expect(fetchAgentSlack('a1')).resolves.toEqual({ state: 'unavailable' });
    answer = () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    await expect(fetchAgentSlack('a1')).resolves.toEqual({ state: 'unavailable' });
  });

  it('any other failure, or an answer of the wrong shape, throws', async () => {
    answer = () => json(500, { error: 'internal' });
    await expect(fetchAgentSlack('a1')).rejects.toThrow();
    answer = () => json(200, { state: 'ready', botName: 'x', workspaceName: 'y', canManage: 'yes', channels: [], bot: NO_BOT });
    await expect(fetchAgentSlack('a1')).rejects.toMatchObject({ code: 'bad-response' });
    answer = () => json(200, { state: 'ready', botName: 'x', workspaceName: 'y', canManage: true, channels: [{ channelId: 'C1' }], bot: NO_BOT });
    await expect(fetchAgentSlack('a1')).rejects.toMatchObject({ code: 'bad-response' });
  });

  it("reads the agent's own bot on both states: none, pending and live (a null handle stays null)", async () => {
    const ready = { state: 'ready', botName: 'canopy', workspaceName: 'Acme', canManage: true, channels: [] };
    for (const bot of [NO_BOT, PENDING_BOT, LIVE_BOT, { ...LIVE_BOT, handle: null, needsClaim: true }]) {
      answer = () => json(200, { ...ready, bot });
      await expect(fetchAgentSlack('a1')).resolves.toMatchObject({ state: 'ready', bot });
      answer = () => json(200, { state: 'no-workspace', canManage: true, bot });
      await expect(fetchAgentSlack('a1')).resolves.toEqual({ state: 'no-workspace', canManage: true, bot });
    }
  });

  it('parses a requested bot', async () => {
    const bot = { state: 'requested', botName: 'Quill Bot', requestedAt: '2026-11-20T10:00:00.000Z' };
    // A request reaches only those who manage the agent, so the server says they do (TASK-1172's `canManage`).
    answer = () => json(200, { state: 'no-workspace', canManage: true, bot });
    await expect(fetchAgentSlack('a1')).resolves.toEqual({ state: 'no-workspace', canManage: true, bot });
    answer = () => json(200, { state: 'ready', botName: 'canopy', workspaceName: 'Acme', canManage: true, channels: [], bot });
    await expect(fetchAgentSlack('a1')).resolves.toMatchObject({ state: 'ready', bot });
  });

  it('a requested bot without requestedAt is a bad response', async () => {
    for (const bot of [
      { state: 'requested', botName: 'Quill Bot' },
      { state: 'requested', botName: 'Quill Bot', requestedAt: 7 },
      { state: 'requested', requestedAt: '2026-11-20T10:00:00.000Z' },
    ]) {
      answer = () => json(200, { state: 'no-workspace', bot });
      await expect(fetchAgentSlack('a1')).rejects.toMatchObject({ code: 'bad-response' });
    }
  });

  it('a missing or malformed bot is a bad response, never a half-drawn section', async () => {
    const ready = { state: 'ready', botName: 'canopy', workspaceName: 'Acme', canManage: true, channels: [] };
    const bad: unknown[] = [
      undefined,
      null,
      'live',
      { state: 'weird' },
      { state: 'none' },
      { state: 'none', configTokenStored: 'yes' },
      { state: 'pending', botName: 'Quill', approver: 'Ada' },
      { state: 'live', botName: 'Quill', handle: 7, approver: 'Ada', needsClaim: false },
      { state: 'live', botName: 'Quill', handle: null, approver: 'Ada' },
      // An install id that isn't one: it would be posted back as the bot to disconnect.
      { ...LIVE_BOT, installId: 7 },
      { ...LIVE_BOT, installId: '' },
      { ...LIVE_BOT, installId: 'short' },
      { ...LIVE_BOT, installId: `${BOT_ID}A` },
      { ...LIVE_BOT, installId: `${'A'.repeat(21)}/` },
      { ...PENDING_BOT, installId: ` ${BOT_ID}` },
      { ...PENDING_BOT, installId: { id: BOT_ID } },
    ];
    for (const bot of bad) {
      answer = () => json(200, { ...ready, bot });
      await expect(fetchAgentSlack('a1')).rejects.toMatchObject({ code: 'bad-response' });
      answer = () => json(200, { state: 'no-workspace', canManage: true, bot });
      await expect(fetchAgentSlack('a1')).rejects.toMatchObject({ code: 'bad-response' });
    }
  });

  it("reads a bot's install id, the key its Disconnect takes: one only a manager gets, null for anyone else, and null from an older host that omits it", async () => {
    const ready = { state: 'ready', botName: 'canopy', workspaceName: 'Acme', canManage: true, channels: [] };
    for (const bot of [PENDING_BOT, LIVE_BOT]) {
      answer = () => json(200, { ...ready, bot });
      await expect(fetchAgentSlack('a1')).resolves.toMatchObject({ bot: { installId: BOT_ID } });
      answer = () => json(200, { ...ready, bot: { ...bot, installId: null } });
      await expect(fetchAgentSlack('a1')).resolves.toMatchObject({ bot: { installId: null } });
      const { installId: _omit, ...older } = bot;
      answer = () => json(200, { state: 'no-workspace', canManage: true, bot: older });
      await expect(fetchAgentSlack('a1')).resolves.toEqual({ state: 'no-workspace', canManage: true, bot: { ...bot, installId: null } });
    }
  });
});

describe('no-workspace canManage', () => {
  it('no-workspace carries canManage; an older host without it reads as before (true only for a pending bot); a non-boolean is a bad-response', async () => {
    answer = () => json(200, { state: 'no-workspace', canManage: true, bot: LIVE_BOT });
    await expect(fetchAgentSlack('a1')).resolves.toEqual({ state: 'no-workspace', canManage: true, bot: LIVE_BOT });
    answer = () => json(200, { state: 'no-workspace', canManage: false, bot: PENDING_BOT });
    await expect(fetchAgentSlack('a1')).resolves.toEqual({ state: 'no-workspace', canManage: false, bot: PENDING_BOT });

    for (const [bot, canManage] of [
      [PENDING_BOT, true],
      [LIVE_BOT, false],
      [NO_BOT, false],
    ] as const) {
      answer = () => json(200, { state: 'no-workspace', bot });
      await expect(fetchAgentSlack('a1')).resolves.toEqual({ state: 'no-workspace', canManage, bot });
    }

    answer = () => json(200, { state: 'no-workspace', canManage: 'yes', bot: LIVE_BOT });
    await expect(fetchAgentSlack('a1')).rejects.toMatchObject({ code: 'bad-response' });
    answer = () => json(200, { state: 'no-workspace', canManage: null, bot: LIVE_BOT });
    await expect(fetchAgentSlack('a1')).rejects.toMatchObject({ code: 'bad-response' });
  });
});

describe('fetchAvailableChannels', () => {
  it('GETs /available and returns the channels and the truncated flag', async () => {
    answer = () =>
      json(200, { channels: [{ channelId: 'C1', name: 'support', connected: null }, { channelId: 'C2', name: 'ops', connected: 'other-agent' }], truncated: true });
    await expect(fetchAvailableChannels('a1')).resolves.toEqual({
      channels: [
        { channelId: 'C1', name: 'support', connected: null },
        { channelId: 'C2', name: 'ops', connected: 'other-agent' },
      ],
      truncated: true,
    });
    expect(calls[0]).toMatchObject({ url: '/settings/slack/a1/available', method: 'GET' });
  });

  it('throws the route’s code and reason', async () => {
    answer = () => json(409, { error: 'needs-reconnect' });
    await expect(fetchAvailableChannels('a1')).rejects.toMatchObject({ status: 409, code: 'needs-reconnect', reason: null });
    answer = () => json(200, { channels: [{ channelId: 'C1', name: 'x', connected: 'nope' }], truncated: false });
    await expect(fetchAvailableChannels('a1')).rejects.toMatchObject({ code: 'bad-response' });
  });
});

describe('writes', () => {
  it('connect POSTs {channelId} with the CSRF header and returns the row', async () => {
    answer = () => json(200, { channel: ROW, reconnected: true });
    await expect(connectSlackChannel('a1', 'C1')).resolves.toEqual({ channel: ROW, reconnected: true });
    expect(calls[0]).toMatchObject({
      url: '/settings/slack/a1/connect',
      method: 'POST',
      credentials: 'include',
      body: { channelId: 'C1' },
    });
    expect(calls[0]?.headers['x-requested-with']).toBe('ax-admin');
    expect(calls[0]?.headers['content-type']).toBe('application/json');
  });

  it('connect reads a row without needsInvite as false', async () => {
    const { needsInvite: _omit, ...older } = ROW;
    answer = () => json(200, { channel: older, reconnected: false });
    await expect(connectSlackChannel('a1', 'C1')).resolves.toEqual({ channel: { ...ROW, needsInvite: false }, reconnected: false });
  });

  it('disconnect and remember send their own bodies', async () => {
    answer = () => json(200, { removed: true });
    await expect(disconnectSlackChannel('a1', 'C1')).resolves.toEqual({ removed: true });
    expect(calls[0]).toMatchObject({ url: '/settings/slack/a1/disconnect', body: { channelId: 'C1' } });
    answer = () => json(200, {});
    await setSlackChannelRemember('a1', 'C1', true);
    expect(calls[1]).toMatchObject({ url: '/settings/slack/a1/remember', body: { channelId: 'C1', remember: true } });
    expect(calls[1]?.headers['x-requested-with']).toBe('ax-admin');
  });

  it('setSlackBotChannelRemember POSTs {channelId, remember} to /settings/slack/:agentId/bot/remember with the write headers', async () => {
    answer = () => json(200, {});
    await setSlackBotChannelRemember('a/1', 'C0BOTSUP01', false);
    expect(calls[0]).toMatchObject({
      url: '/settings/slack/a%2F1/bot/remember',
      method: 'POST',
      credentials: 'include',
      body: { channelId: 'C0BOTSUP01', remember: false },
    });
    expect(calls[0]?.headers['x-requested-with']).toBe('ax-admin');
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    answer = () => json(409, { error: 'personal-agent' });
    await expect(setSlackBotChannelRemember('a1', 'C1', true)).rejects.toMatchObject({ status: 409, code: 'personal-agent' });
  });

  it('a refusal carries the status, the code and the reason, only when code-shaped', async () => {
    answer = () => json(422, { error: 'channel-not-allowed', reason: 'not-public' });
    await expect(connectSlackChannel('a1', 'C1')).rejects.toMatchObject({ status: 422, code: 'channel-not-allowed', reason: 'not-public' });
    answer = () => json(409, { error: 'Not A Code!', reason: '<b>x</b>' });
    await expect(connectSlackChannel('a1', 'C1')).rejects.toMatchObject({ code: 'unknown', reason: null });
    answer = () => json(200, { channel: { channelId: 'C1' }, reconnected: false });
    await expect(connectSlackChannel('a1', 'C1')).rejects.toMatchObject({ code: 'bad-response' });
  });
});

describe("the agent's own bot", () => {
  it('request POSTs {botName} with the CSRF header, and only the token and picture that are given', async () => {
    answer = () => json(200, { installUrl: 'https://slack.com/oauth/v2/authorize?x=1', iconSet: true });
    await expect(requestSlackBot('a/1', { botName: 'Quill' })).resolves.toEqual({
      installUrl: 'https://slack.com/oauth/v2/authorize?x=1',
      iconSet: true,
    });
    expect(calls[0]).toMatchObject({
      url: '/settings/slack/a%2F1/bot',
      method: 'POST',
      credentials: 'include',
      body: { botName: 'Quill' },
    });
    expect(Object.keys(calls[0]?.body as object)).toEqual(['botName']);
    expect(calls[0]?.headers['x-requested-with']).toBe('ax-admin');
    expect(calls[0]?.headers['content-type']).toBe('application/json');

    await requestSlackBot('a1', { botName: 'Quill', refreshToken: fakeConfigRefreshToken(), iconPng: 'AAAA' });
    expect(calls[1]?.body).toEqual({ botName: 'Quill', refreshToken: fakeConfigRefreshToken(), iconPng: 'AAAA' });
  });

  it('request, continue and cancel read their answers field by field', async () => {
    answer = () => json(200, { installUrl: '', iconSet: true });
    await expect(requestSlackBot('a1', { botName: 'Q' })).rejects.toMatchObject({ code: 'bad-response' });
    answer = () => json(200, { installUrl: 'https://slack.com/x' });
    await expect(requestSlackBot('a1', { botName: 'Q' })).rejects.toMatchObject({ code: 'bad-response' });

    answer = () => json(200, { installUrl: 'https://slack.com/oauth/v2/authorize?x=2' });
    await expect(continueSlackBot('a1')).resolves.toEqual({ installUrl: 'https://slack.com/oauth/v2/authorize?x=2' });
    expect(calls.at(-1)).toMatchObject({ url: '/settings/slack/a1/bot/install-url', method: 'POST' });
    expect(calls.at(-1)?.headers['x-requested-with']).toBe('ax-admin');
    answer = () => json(200, {});
    await expect(continueSlackBot('a1')).rejects.toMatchObject({ code: 'bad-response' });

    answer = () => json(200, { appDeleted: false });
    await expect(cancelSlackBot('a1')).resolves.toEqual({ appDeleted: false });
    expect(calls.at(-1)).toMatchObject({ url: '/settings/slack/a1/bot/cancel', method: 'POST' });
    expect(calls.at(-1)?.headers['x-requested-with']).toBe('ax-admin');
    answer = () => json(200, { appDeleted: 'yes' });
    await expect(cancelSlackBot('a1')).rejects.toMatchObject({ code: 'bad-response' });
  });

  it('askSlackBotApproval posts { botName } to /bot-request with the write headers', async () => {
    answer = () => json(200, {});
    await expect(askSlackBotApproval('a/1', { botName: 'Quill' })).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({
      url: '/settings/slack/a%2F1/bot-request',
      method: 'POST',
      credentials: 'include',
      body: { botName: 'Quill' },
    });
    expect(Object.keys(calls[0]?.body as object)).toEqual(['botName']);
    expect(calls[0]?.headers['x-requested-with']).toBe('ax-admin');
    expect(calls[0]?.headers['content-type']).toBe('application/json');
  });

  it('cancelSlackBotRequest posts {} to /bot-request/cancel', async () => {
    answer = () => json(200, {});
    await expect(cancelSlackBotRequest('a1')).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({ url: '/settings/slack/a1/bot-request/cancel', method: 'POST', body: {} });
    expect(calls[0]?.headers['x-requested-with']).toBe('ax-admin');
  });

  it('disconnectSlackBot POSTs /settings/slack/:agentId/bot/disconnect with the write headers and the install id of the bot the page showed, and reads appDeleted', async () => {
    answer = () => json(200, { appDeleted: false });
    await expect(disconnectSlackBot('a/1', BOT_ID)).resolves.toEqual({ appDeleted: false });
    expect(calls[0]).toMatchObject({
      url: '/settings/slack/a%2F1/bot/disconnect',
      method: 'POST',
      credentials: 'include',
      body: { installId: BOT_ID },
    });
    // The id and nothing else: the agent is the path's.
    expect(Object.keys(calls[0]?.body as object)).toEqual(['installId']);
    expect(calls[0]?.headers['x-requested-with']).toBe('ax-admin');
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    answer = () => json(200, { appDeleted: true, extra: 1 });
    await expect(disconnectSlackBot('a1', BOT_ID)).resolves.toEqual({ appDeleted: true });
  });

  it('disconnectSlackBot: an answer without a boolean appDeleted is a bad-response; a refusal is an AgentSlackError with its code', async () => {
    answer = () => json(200, {});
    await expect(disconnectSlackBot('a1', BOT_ID)).rejects.toMatchObject({ code: 'bad-response' });
    answer = () => json(200, { appDeleted: 'yes' });
    await expect(disconnectSlackBot('a1', BOT_ID)).rejects.toMatchObject({ code: 'bad-response' });
    answer = () => json(409, { error: 'no-bot' });
    const err = await disconnectSlackBot('a1', BOT_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentSlackError);
    expect(err).toMatchObject({ status: 409, code: 'no-bot' });
  });

  it('a refusal on the bot routes keeps its status, code and reason', async () => {
    answer = () => json(400, { error: 'invalid-bot-name', reason: 'too-long' });
    await expect(requestSlackBot('a1', { botName: 'Q' })).rejects.toMatchObject({
      status: 400,
      code: 'invalid-bot-name',
      reason: 'too-long',
    });
  });

  it('each refusal lands where the pinned copy says, and only a token refusal asks for the token', () => {
    const e = (code: string, reason: string | null = null) => new AgentSlackError(400, code, reason);
    expect(agentSlackBotErrorCopy(e('bot-name-taken'))).toEqual({
      field: 'botName',
      message: 'Another Slack bot here already uses that name. Pick another.',
      revealToken: false,
    });
    expect(agentSlackBotErrorCopy(e('invalid-bot-name', 'empty'))).toEqual({
      field: 'botName',
      message: 'Give the bot a name.',
      revealToken: false,
    });
    expect(agentSlackBotErrorCopy(e('invalid-bot-name', 'weird')).message).toBe("Slack can't use that name. Try another.");
    expect(agentSlackBotErrorCopy(e('slack-name'))).toMatchObject({ field: 'botName', revealToken: false });
    expect(agentSlackBotErrorCopy(e('invalid-refresh-token'))).toEqual({
      field: 'refreshToken',
      message: "That doesn't look like a refresh token. It starts with xoxe-.",
      revealToken: false,
    });
    expect(agentSlackBotErrorCopy(e('slack-refresh-token'))).toMatchObject({ field: 'refreshToken', revealToken: false });

    for (const code of ['slack-config-token', 'config-token-needed', 'slack-token']) {
      expect(agentSlackBotErrorCopy(e(code))).toMatchObject({ field: 'refreshToken', revealToken: true });
    }
    expect(agentSlackBotErrorCopy(e('slack-config-token')).message).toBe(
      "The configuration token we kept for you stopped working. Generate a new one on Slack's app settings and paste it below.",
    );
    expect(agentSlackBotErrorCopy(e('config-token-needed')).message).toBe('Paste a configuration token to continue.');
    expect(agentSlackBotErrorCopy(e('slack-token')).message).toBe(
      "Slack didn't accept the configuration token. Generate a new one and paste it below.",
    );

    expect(agentSlackBotErrorCopy(e('no-workspace'))).toEqual({
      field: null,
      message: "Slack isn't connected yet. An admin connects it first.",
      revealToken: false,
    });
    expect(agentSlackBotErrorCopy(e('not-approver')).message).toBe(
      'Only the person who set this up can continue it in Slack.',
    );
    for (const code of ['public-origin-not-https', 'slack-unconfirmed', 'slack-error', 'internal']) {
      const copy = agentSlackBotErrorCopy(e(code));
      expect(copy).toMatchObject({ field: null, revealToken: false });
      expect(copy.message).not.toBe('');
      expect(copy.message).not.toContain(code);
    }
    // Only Slack's own failure blames Slack; ours, or a dropped connection, is the plain line.
    expect(agentSlackBotErrorCopy(e('slack-error')).message).toBe(
      'Something went wrong talking to Slack. Try again in a minute.',
    );
    expect(agentSlackBotErrorCopy(new AgentSlackError(500, 'internal')).message).toBe(
      'Something went wrong. Try again in a minute.',
    );
    expect(agentSlackBotErrorCopy(new Error('boom')).message).toBe('Something went wrong. Try again in a minute.');
  });

  it('agentSlackBotStale: 409 no-bot reads the status again', () => {
    expect(agentSlackBotStale(new AgentSlackError(409, 'no-bot'))).toBe(true);
  });

  it('bot-exists, not-pending, a lost agent or no longer managing it mean the picture is stale; not-approver does not', () => {
    expect(agentSlackBotStale(new AgentSlackError(409, 'bot-exists'))).toBe(true);
    expect(agentSlackBotStale(new AgentSlackError(409, 'not-pending'))).toBe(true);
    expect(agentSlackBotStale(new AgentSlackError(409, 'personal-agent'))).toBe(true);
    expect(agentSlackBotStale(new AgentSlackError(403, 'forbidden'))).toBe(true);
    expect(agentSlackBotStale(new AgentSlackError(404, 'not-found'))).toBe(true);
    expect(agentSlackBotStale(new AgentSlackError(403, 'not-approver'))).toBe(false);
    expect(agentSlackBotStale(new AgentSlackError(409, 'bot-name-taken'))).toBe(false);
    expect(agentSlackBotStale(new AgentSlackError(409, 'no-workspace'))).toBe(false);
    expect(agentSlackBotStale(new Error('x'))).toBe(false);
  });

  it('bot-requested and not-requested are stale', () => {
    expect(agentSlackBotStale(new AgentSlackError(409, 'bot-requested'))).toBe(true);
    expect(agentSlackBotStale(new AgentSlackError(409, 'not-requested'))).toBe(true);
  });
});

describe('what an error says', () => {
  it('turns each refusal into its own sentence, never a code', () => {
    const e = (status: number, code: string, reason: string | null = null) => new AgentSlackError(status, code, reason);
    expect(agentSlackErrorCopy(e(409, 'needs-reconnect'))).toBe(AGENT_SLACK_COPY.needsReconnect);
    expect(agentSlackErrorCopy(e(409, 'channel-taken'))).toBe(AGENT_SLACK_COPY.channelTaken);
    expect(agentSlackErrorCopy(e(422, 'channel-not-allowed', 'not-public'))).toBe(AGENT_SLACK_COPY.notPublic);
    expect(agentSlackErrorCopy(e(422, 'channel-not-allowed', 'archived'))).toBe(AGENT_SLACK_COPY.archived);
    expect(agentSlackErrorCopy(e(422, 'channel-not-allowed', 'shared'))).toBe(AGENT_SLACK_COPY.shared);
    expect(agentSlackErrorCopy(e(422, 'channel-not-allowed', 'workspace-policy'))).toBe(AGENT_SLACK_COPY.workspacePolicy);
    expect(agentSlackErrorCopy(e(422, 'channel-not-allowed', 'weird'))).toBe(AGENT_SLACK_COPY.channelNotAllowed);
    expect(AGENT_SLACK_COPY.workspacePolicy).toMatch(/Slack admin/);
    expect(AGENT_SLACK_COPY.workspacePolicy).not.toMatch(/try again/i);
    expect(AGENT_SLACK_COPY.channelTaken).toMatch(/team admin of that agent's team can disconnect it/);
    expect(AGENT_SLACK_COPY.channelTaken).not.toMatch(/Disconnect it there first/);
    expect(agentSlackErrorCopy(e(502, 'slack-error'))).toBe(AGENT_SLACK_COPY.slackError);
    expect(agentSlackErrorCopy(e(400, 'invalid-body'))).toBe(AGENT_SLACK_COPY.generic);
    expect(agentSlackErrorCopy(new Error('boom'))).toBe(AGENT_SLACK_COPY.generic);
  });

  it('personal-agent and no-workspace refusals mean the picture is stale', () => {
    expect(agentSlackStateChanged(new AgentSlackError(409, 'personal-agent'))).toBe(true);
    expect(agentSlackStateChanged(new AgentSlackError(409, 'no-workspace'))).toBe(true);
    expect(agentSlackStateChanged(new AgentSlackError(409, 'own-bot'))).toBe(true);
    expect(agentSlackStateChanged(new AgentSlackError(409, 'channel-taken'))).toBe(false);
    expect(agentSlackStateChanged(new Error('x'))).toBe(false);
  });

  it("the moved-channel lines name the bot's @handle, or its name when Slack never said one", () => {
    const known = { botName: 'Quill', handle: 'quill' };
    const unknown = { botName: 'Quill', handle: null };
    expect(AGENT_SLACK_COPY.movedNotice(known)).toBe(
      'These channels still need @quill: run /invite @quill in each one. A channel leaves this list once @quill answers there.',
    );
    expect(AGENT_SLACK_COPY.movedNotice(unknown)).toBe(
      'These channels still need Quill: invite it to each one with /invite. A channel leaves this list once Quill answers there.',
    );
    expect(AGENT_SLACK_COPY.movedRow(known)).toBe('Run /invite @quill here.');
    expect(AGENT_SLACK_COPY.movedRow(unknown)).toBe('Invite Quill here with /invite.');
    expect(AGENT_SLACK_COPY.movedDisconnect('support')).toBe(
      "We'll take #support off this list. The agent answers there only after its own bot is invited.",
    );
  });

  it("the bot channel line names the bot's @handle, or its name when Slack never said one", () => {
    expect(AGENT_SLACK_COPY.botChannelsNotice({ botName: 'Quill', handle: 'quill' })).toBe('@quill has answered in these channels.');
    expect(AGENT_SLACK_COPY.botChannelsNotice({ botName: 'Quill', handle: null })).toBe('Quill has answered in these channels.');
  });

  it('a connect that is no longer allowed or no longer found means the picture is stale', () => {
    expect(agentSlackStateChanged(new AgentSlackError(403, 'forbidden'))).toBe(true);
    expect(agentSlackStateChanged(new AgentSlackError(404, 'not-found'))).toBe(true);
  });

  it('a write on a row the server no longer has (403, 404, 409) means the picture is stale; 5xx and network do not', () => {
    for (const status of [403, 404, 409]) {
      expect(agentSlackWriteStale(new AgentSlackError(status, 'not-connected'))).toBe(true);
    }
    expect(agentSlackWriteStale(new AgentSlackError(500, 'internal'))).toBe(false);
    expect(agentSlackWriteStale(new AgentSlackError(502, 'slack-error'))).toBe(false);
    expect(agentSlackWriteStale(new Error('network'))).toBe(false);
  });

  it('renameAgentSlackBot posts { botName } to /bot/rename with the write headers and reads back the name', async () => {
    answer = () => json(200, { botName: 'Quill 2' });
    await expect(renameAgentSlackBot('a 1', 'Quill 2')).resolves.toEqual({ botName: 'Quill 2' });
    expect(calls[0]).toMatchObject({
      url: '/settings/slack/a%201/bot/rename',
      method: 'POST',
      credentials: 'include',
      body: { botName: 'Quill 2' },
    });
    expect(calls[0]?.headers['x-requested-with']).toBe('ax-admin');
    answer = () => json(200, {});
    await expect(renameAgentSlackBot('a1', 'Q')).rejects.toMatchObject({ code: 'bad-response' });
    answer = () => json(200, { botName: '' });
    await expect(renameAgentSlackBot('a1', 'Q')).rejects.toMatchObject({ code: 'bad-response' });
    answer = () => json(409, { error: 'not-live' });
    const err = await renameAgentSlackBot('a1', 'Q').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentSlackError);
    expect(err).toMatchObject({ status: 409, code: 'not-live' });
  });

  it('setAgentSlackBotPicture posts { iconPng } to /bot/icon', async () => {
    answer = () => json(200, {});
    await expect(setAgentSlackBotPicture('a 1', 'B64')).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({ url: '/settings/slack/a%201/bot/icon', method: 'POST', body: { iconPng: 'B64' } });
    expect(calls[0]?.headers['x-requested-with']).toBe('ax-admin');
    answer = () => json(400, { error: 'invalid-icon', reason: 'icon-bad-size' });
    const err = await setAgentSlackBotPicture('a1', 'B64').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentSlackError);
    expect(err).toMatchObject({ status: 400, code: 'invalid-icon', reason: 'icon-bad-size' });
  });

  it('agentSlackBotChangeErrorCopy: every code has its sentence and its field', () => {
    const copy = (code: string, reason: string | null = null, who = 'Ada'): unknown =>
      agentSlackBotChangeErrorCopy(new AgentSlackError(400, code, reason), who);
    expect(copy('invalid-bot-name', 'empty')).toEqual({ field: 'botName', message: 'Give the bot a name.' });
    expect(copy('invalid-bot-name', 'nope')).toEqual({ field: 'botName', message: "Slack can't use that name. Try another." });
    expect(copy('bot-name-taken')).toEqual({
      field: 'botName',
      message: 'Another Slack bot here already uses that name. Pick another.',
    });
    expect(copy('slack-name')).toEqual({ field: 'botName', message: "Slack didn't accept that bot name. Try another." });
    expect(copy('invalid-icon')).toEqual({ field: null, message: "We couldn't use that picture. Try another image." });
    expect(copy('slack-config-token', null, 'Ada Lovelace')).toEqual({
      field: null,
      message: "This bot's Slack token needs replacing by Ada Lovelace.",
    });
    expect(copy('slack-config-token', null, 'A teammate')).toEqual({
      field: null,
      message: "This bot's Slack token needs replacing by A teammate.",
    });
    expect(copy('slack-app-gone')).toEqual({
      field: null,
      message: "Slack no longer has this bot's app. It may have been deleted on api.slack.com/apps.",
    });
    expect((copy('public-origin-not-https') as { message: string }).message).toMatch(/isn't https/);
    expect(copy('slack-error')).toEqual({ field: null, message: 'Something went wrong talking to Slack. Try again in a minute.' });
    expect(copy('internal')).toEqual({ field: null, message: AGENT_SLACK_COPY.generic });
    expect(agentSlackBotChangeErrorCopy(new TypeError('x'), 'Ada')).toEqual({ field: null, message: AGENT_SLACK_COPY.generic });
    expect(AGENT_SLACK_BOT_CHANGE_COPY.pictureChanged).toBe('Slack has the new picture.');
  });

  it('agentSlackBotStale: 409 not-live reads the status again; bot-name-taken does not', () => {
    expect(agentSlackBotStale(new AgentSlackError(409, 'not-live'))).toBe(true);
    expect(agentSlackBotStale(new AgentSlackError(409, 'bot-name-taken'))).toBe(false);
  });
});
