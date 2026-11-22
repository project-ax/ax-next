/**
 * An agent's Slack wire client (`lib/agent-slack.ts`, TASK-1094), stubbed at
 * `fetch` so the URLs, methods, headers and bodies it really sends are what is
 * asserted. The routes are @ax/channel-slack's (`agent-routes.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_SLACK_BOT_CHANGE_COPY,
  AGENT_SLACK_CARD_COPY,
  AGENT_SLACK_COPY,
  AgentSlackError,
  agentSlackBotTokenDead,
  botWho,
  agentSlackBotChangeErrorCopy,
  agentSlackBotReplaceErrorCopy,
  agentSlackBotReplaceStale,
  claimAgentSlackBot,
  replaceAgentSlackBotToken,
  renameAgentSlackBot,
  setAgentSlackBotPicture,
  agentSlackBotErrorCopy,
  agentSlackBotStale,
  askSlackBotApproval,
  cancelSlackBotRequest,
  cancelSlackBot,
  continueSlackBot,
  requestSlackBot,
  disconnectSlackBot,
  fetchAgentSlack,
} from '../agent-slack';
import { slackCardWordsFound } from '../../test-utils/slack-card-words';
import { BOT_TOKEN_COPY } from '../slack-token-copy';
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
const LIVE_BOT = {
  state: 'live',
  botName: 'Quill',
  handle: 'quill',
  approver: 'Ada',
  needsClaim: false,
  approverGone: false,
  viewerIsApprover: false,
  installId: BOT_ID,
};
const PEOPLE = {
  botName: 'Quill Bot',
  handle: 'quill_bot' as string | null,
  approver: 'Ada Lovelace',
  approverGone: false,
  viewerIsApprover: false,
};

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
    answer = () => json(200, { state: 'ready', botName: 'canopy', workspaceName: 'Acme', canManage: true, bot: NO_BOT, extra: 1 });
    await expect(fetchAgentSlack('a/1')).resolves.toEqual({
      state: 'ready',
      botName: 'canopy',
      workspaceName: 'Acme',
      canManage: true,
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

  it('a ready answer without channels parses; a stray channels key is ignored (a host one deploy behind)', async () => {
    const ready = { state: 'ready', botName: 'canopy', workspaceName: 'Acme', canManage: true, bot: NO_BOT };
    answer = () => json(200, ready);
    const without = await fetchAgentSlack('a1');
    expect(without).toEqual(ready);
    answer = () => json(200, { ...ready, channels: [{ channelId: 'C1', name: 'support' }] });
    const stray = await fetchAgentSlack('a1');
    expect(stray).toEqual(without);
    expect(stray).not.toHaveProperty('channels');
    // Not even a malformed one: the key is nobody's to read now.
    answer = () => json(200, { ...ready, channels: 'nope' });
    await expect(fetchAgentSlack('a1')).resolves.toEqual(without);
  });

  it('parses agentTeamName on ready and no-workspace, and refuses a non-string one (TASK-1203)', async () => {
    const ready = { state: 'ready', botName: 'canopy', workspaceName: 'Acme', canManage: true, bot: NO_BOT };
    const noWorkspace = { state: 'no-workspace', canManage: true, bot: NO_BOT };
    for (const base of [ready, noWorkspace]) {
      answer = () => json(200, { ...base, agentTeamName: 'Support' });
      await expect(fetchAgentSlack('a1')).resolves.toMatchObject({ agentTeamName: 'Support' });
      // Absent: a personal agent, no teams service, or an older host. The key stays off the read.
      answer = () => json(200, base);
      expect(await fetchAgentSlack('a1')).not.toHaveProperty('agentTeamName');
      for (const bad of [7, null, true, {}, ['Support'], '']) {
        answer = () => json(200, { ...base, agentTeamName: bad });
        await expect(fetchAgentSlack('a1'), String(JSON.stringify(bad))).rejects.toMatchObject({ code: 'bad-response' });
      }
    }
  });

  it("reads the agent's own bot's channels on ready and no-workspace; an older host that omits them reads none; a malformed one is a bad response (TASK-1180)", async () => {
    const BOT_ROW = { channelId: 'C0BOTSUP01', name: 'help' };
    const ready = (extra: Record<string, unknown>) => ({ state: 'ready', botName: 'canopy', workspaceName: 'Acme', canManage: true, bot: LIVE_BOT, ...extra });
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
      // TASK-1202: the switch is gone. A row needs no `remember`, and one a host still sends is dropped, not carried or checked.
      answer = () => json(200, make({ botChannels: [{ ...BOT_ROW, remember: false }, { ...BOT_ROW, channelId: 'C2', remember: 'yes' }] }));
      expect(((await fetchAgentSlack('a1')) as { botChannels?: unknown }).botChannels).toEqual([
        BOT_ROW,
        { ...BOT_ROW, channelId: 'C2' },
      ]);
      // TASK-1203: a private channel is remembered like any other, so a row has no privacy. One a host still sends is dropped, not carried or checked.
      answer = () => json(200, make({ botChannels: [{ ...BOT_ROW, isPrivate: true }, { ...BOT_ROW, channelId: 'C2', isPrivate: 'yes' }] }));
      expect(((await fetchAgentSlack('a1')) as { botChannels?: unknown }).botChannels).toEqual([
        BOT_ROW,
        { ...BOT_ROW, channelId: 'C2' },
      ]);
      answer = () => json(200, make({ botChannels: [{ channelId: 'C1' }] }));
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
    answer = () => json(200, { state: 'ready', botName: 'x', workspaceName: 'y', canManage: 'yes', bot: NO_BOT });
    await expect(fetchAgentSlack('a1')).rejects.toMatchObject({ code: 'bad-response' });
    answer = () => json(200, { state: 'ready', botName: 'x', workspaceName: 'y', canManage: true });
    await expect(fetchAgentSlack('a1')).rejects.toMatchObject({ code: 'bad-response' });
  });

  it("reads the agent's own bot on both states: none, pending and live (a null handle stays null)", async () => {
    const ready = { state: 'ready', botName: 'canopy', workspaceName: 'Acme', canManage: true };
    for (const bot of [NO_BOT, PENDING_BOT, LIVE_BOT, { ...LIVE_BOT, handle: null, needsClaim: true }]) {
      answer = () => json(200, { ...ready, bot });
      await expect(fetchAgentSlack('a1')).resolves.toMatchObject({ state: 'ready', bot });
      answer = () => json(200, { state: 'no-workspace', canManage: true, bot });
      await expect(fetchAgentSlack('a1')).resolves.toEqual({ state: 'no-workspace', canManage: true, bot });
    }
  });

  it('a live bot without approverGone or viewerIsApprover (an older host) reads them as false; present, each must be a boolean', async () => {
    const ready = { state: 'ready', botName: 'canopy', workspaceName: 'Acme', canManage: true };
    const { approverGone: _g, viewerIsApprover: _v, ...older } = LIVE_BOT;
    answer = () => json(200, { ...ready, bot: older });
    await expect(fetchAgentSlack('a1')).resolves.toMatchObject({ state: 'ready', bot: LIVE_BOT });
    answer = () => json(200, { ...ready, bot: { ...LIVE_BOT, approverGone: true, viewerIsApprover: true } });
    await expect(fetchAgentSlack('a1')).resolves.toMatchObject({
      bot: { approverGone: true, viewerIsApprover: true },
    });
    for (const bad of [
      { ...LIVE_BOT, approverGone: 'yes' },
      { ...LIVE_BOT, approverGone: null },
      { ...LIVE_BOT, viewerIsApprover: 1 },
      { ...LIVE_BOT, viewerIsApprover: null },
    ]) {
      answer = () => json(200, { ...ready, bot: bad });
      await expect(fetchAgentSlack('a1')).rejects.toMatchObject({ code: 'bad-response' });
    }
  });

  it('parses a requested bot', async () => {
    const bot = { state: 'requested', botName: 'Quill Bot', requestedAt: '2026-11-20T10:00:00.000Z' };
    // A request reaches only those who manage the agent, so the server says they do (TASK-1172's `canManage`).
    answer = () => json(200, { state: 'no-workspace', canManage: true, bot });
    await expect(fetchAgentSlack('a1')).resolves.toEqual({ state: 'no-workspace', canManage: true, bot });
    answer = () => json(200, { state: 'ready', botName: 'canopy', workspaceName: 'Acme', canManage: true, bot });
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
    const ready = { state: 'ready', botName: 'canopy', workspaceName: 'Acme', canManage: true };
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
    const ready = { state: 'ready', botName: 'canopy', workspaceName: 'Acme', canManage: true };
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

describe('writes', () => {
  it('a refusal carries the status, the code and the reason, only when code-shaped; a non-code error reads as unknown', async () => {
    answer = () => json(422, { error: 'invalid-bot-name', reason: 'too-long' });
    await expect(renameAgentSlackBot('a1', 'Q')).rejects.toMatchObject({ status: 422, code: 'invalid-bot-name', reason: 'too-long' });
    answer = () => json(409, { error: 'Not A Code!', reason: '<b>x</b>' });
    await expect(renameAgentSlackBot('a1', 'Q')).rejects.toMatchObject({ code: 'unknown', reason: null });
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
    await expect(cancelSlackBot('a1', BOT_ID)).resolves.toEqual({ appDeleted: false });
    expect(calls.at(-1)).toMatchObject({
      url: '/settings/slack/a1/bot/cancel',
      method: 'POST',
      body: { installId: BOT_ID },
    });
    expect(calls.at(-1)?.headers['x-requested-with']).toBe('ax-admin');
    answer = () => json(200, { appDeleted: 'yes' });
    await expect(cancelSlackBot('a1', BOT_ID)).rejects.toMatchObject({ code: 'bad-response' });
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

describe("replacing, and claiming, an agent's own bot", () => {
  it('replaceAgentSlackBotToken posts { refreshToken } alone to /bot/replace-token with the write headers', async () => {
    const token = fakeConfigRefreshToken('replace');
    await expect(replaceAgentSlackBotToken('a/1', token)).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({
      url: '/settings/slack/a%2F1/bot/replace-token',
      method: 'POST',
      credentials: 'include',
      body: { refreshToken: token },
    });
    expect(Object.keys(calls[0]?.body as object)).toEqual(['refreshToken']);
    expect(calls[0]?.headers['x-requested-with']).toBe('ax-admin');
    expect(calls[0]?.headers['content-type']).toBe('application/json');
  });

  it('claimAgentSlackBot posts { installId } alone to /bot/claim with the write headers', async () => {
    await expect(claimAgentSlackBot('a/1', BOT_ID)).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({
      url: '/settings/slack/a%2F1/bot/claim',
      method: 'POST',
      credentials: 'include',
      body: { installId: BOT_ID },
    });
    expect(Object.keys(calls[0]?.body as object)).toEqual(['installId']);
    expect(calls[0]?.headers['x-requested-with']).toBe('ax-admin');
  });

  it("both throw an AgentSlackError with the answer's code", async () => {
    answer = () => json(403, { error: 'not-approver' });
    const refused = await replaceAgentSlackBotToken('a1', fakeConfigRefreshToken('x')).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(AgentSlackError);
    expect(refused).toMatchObject({ status: 403, code: 'not-approver' });
    answer = () => json(409, { error: 'claim-not-needed' });
    const notNeeded = await claimAgentSlackBot('a1', BOT_ID).catch((e: unknown) => e);
    expect(notNeeded).toBeInstanceOf(AgentSlackError);
    expect(notNeeded).toMatchObject({ status: 409, code: 'claim-not-needed' });
  });

  it('agentSlackBotStale: 409 claim-not-needed reads the status again', () => {
    expect(agentSlackBotStale(new AgentSlackError(409, 'claim-not-needed'))).toBe(true);
    expect(agentSlackBotStale(new AgentSlackError(403, 'not-approver'))).toBe(false);
  });

  it('agentSlackBotReplaceStale: what agentSlackBotStale says, and 403 not-approver (the bot was handed on)', () => {
    expect(agentSlackBotReplaceStale(new AgentSlackError(403, 'not-approver'))).toBe(true);
    expect(agentSlackBotReplaceStale(new AgentSlackError(409, 'not-live'))).toBe(true);
    expect(agentSlackBotReplaceStale(new AgentSlackError(409, 'no-bot'))).toBe(true);
    expect(agentSlackBotReplaceStale(new AgentSlackError(403, 'forbidden'))).toBe(true);
    expect(agentSlackBotReplaceStale(new AgentSlackError(404, 'not-found'))).toBe(true);
    expect(agentSlackBotReplaceStale(new AgentSlackError(502, 'slack-not-app-manager'))).toBe(false);
    expect(agentSlackBotReplaceStale(new AgentSlackError(400, 'invalid-refresh-token'))).toBe(false);
    expect(agentSlackBotReplaceStale(new Error('x'))).toBe(false);
  });

  it('agentSlackBotReplaceErrorCopy: every code has its sentence and its field', () => {
    const copy = (code: string): { field: string | null; message: string } =>
      agentSlackBotReplaceErrorCopy(new AgentSlackError(400, code));
    expect(copy('invalid-refresh-token')).toEqual({
      field: 'refreshToken',
      message: "That doesn't look like a refresh token. It starts with xoxe-.",
    });
    expect(copy('slack-refresh-token')).toEqual({
      field: 'refreshToken',
      message: "Slack didn't accept the refresh token. Generate a new token and try again.",
    });
    expect(copy('slack-not-app-manager')).toEqual({
      field: 'refreshToken',
      message:
        "Slack says that token can't manage this bot. Only the person who set a bot up can replace its token, with a new token of their own from this Slack workspace.",
    });
    expect(copy('public-origin-not-https').field).toBeNull();
    expect(copy('public-origin-not-https').message).toMatch(/isn't https/);
    expect(copy('slack-error')).toEqual({ field: null, message: 'Something went wrong talking to Slack. Try again in a minute.' });
    expect(copy('internal')).toEqual({ field: null, message: AGENT_SLACK_COPY.generic });
    expect(copy('something-new')).toEqual({ field: null, message: AGENT_SLACK_COPY.generic });
    expect(agentSlackBotReplaceErrorCopy(new TypeError('x'))).toEqual({ field: null, message: AGENT_SLACK_COPY.generic });
  });

  it('BOT_TOKEN_COPY words the refusal and the success', () => {
    expect(BOT_TOKEN_COPY['slack-not-app-manager']).toBe(
      "Slack says that token can't manage this bot. Only the person who set a bot up can replace its token, with a new token of their own from this Slack workspace.",
    );
    expect(BOT_TOKEN_COPY.replaced('Quill Bot')).toBe(
      "Token replaced. We now use it for Quill Bot and every other Slack app you set up here. Don't revoke the token you just pasted: it's the one we use now.",
    );
  });
});

describe('what an error says', () => {
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
      agentSlackBotChangeErrorCopy(new AgentSlackError(400, code, reason), { ...PEOPLE, approver: who });
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
      message: "Changes to @quill_bot can't reach Slack right now. Ask Ada Lovelace to reconnect it.",
    });
    expect(copy('slack-config-token', null, 'A teammate')).toEqual({
      field: null,
      message: "Changes to @quill_bot can't reach Slack right now. Ask A teammate to reconnect it.",
    });
    expect(copy('slack-app-gone')).toEqual({
      field: null,
      message: "Slack no longer has this bot's app. It may have been deleted on api.slack.com/apps.",
    });
    expect((copy('public-origin-not-https') as { message: string }).message).toMatch(/isn't https/);
    expect(copy('slack-error')).toEqual({ field: null, message: 'Something went wrong talking to Slack. Try again in a minute.' });
    expect(copy('internal')).toEqual({ field: null, message: AGENT_SLACK_COPY.generic });
    expect(agentSlackBotChangeErrorCopy(new TypeError('x'), PEOPLE)).toEqual({ field: null, message: AGENT_SLACK_COPY.generic });
    expect(AGENT_SLACK_BOT_CHANGE_COPY.pictureChanged).toBe('Slack has the new picture.');
  });

  it('agentSlackBotChangeErrorCopy: a dead token says what to do and who can: the viewer, nobody (the approver left), or the approver', () => {
    const dead = new AgentSlackError(502, 'slack-config-token');
    expect(agentSlackBotChangeErrorCopy(dead, { ...PEOPLE, viewerIsApprover: true })).toEqual({
      field: null,
      message: "Changes to @quill_bot can't reach Slack right now. Reconnect it, then try again.",
    });
    expect(agentSlackBotChangeErrorCopy(dead, { ...PEOPLE, approver: 'A teammate', approverGone: true })).toEqual({
      field: null,
      message: '@quill_bot needs to be set up again before it can be changed.',
    });
    expect(agentSlackBotChangeErrorCopy(dead, PEOPLE)).toEqual({
      field: null,
      message: "Changes to @quill_bot can't reach Slack right now. Ask Ada Lovelace to reconnect it.",
    });
    // The viewer being the approver wins: they can reconnect their own token.
    expect(agentSlackBotChangeErrorCopy(dead, { ...PEOPLE, approverGone: true, viewerIsApprover: true }).message).toBe(
      AGENT_SLACK_CARD_COPY.reconnectThenRetry('@quill_bot'),
    );
    // No handle: the bot's name.
    expect(agentSlackBotChangeErrorCopy(dead, { ...PEOPLE, handle: null }).message).toBe(
      "Changes to Quill Bot can't reach Slack right now. Ask Ada Lovelace to reconnect it.",
    );
  });

  it('agentSlackBotStale: 409 not-live reads the status again; bot-name-taken does not', () => {
    expect(agentSlackBotStale(new AgentSlackError(409, 'not-live'))).toBe(true);
    expect(agentSlackBotStale(new AgentSlackError(409, 'bot-name-taken'))).toBe(false);
  });
});

describe("the Slack card's words (TASK-1187)", () => {
  const who = '@quill';
  const agentName = 'Quill';
  const botName = 'Quill Bot';
  const approver = 'Ada Lovelace';
  const C = AGENT_SLACK_CARD_COPY;

  it('botWho names the @handle, else the bot name', () => {
    expect(botWho({ botName, handle: 'quill' })).toBe('@quill');
    expect(botWho({ botName, handle: null })).toBe('Quill Bot');
  });

  it('every card line, word for word', () => {
    expect(C.notInSlack(agentName)).toBe("Quill isn't in Slack yet");
    expect(C.addItLead).toBe('Add it to Slack, and people can mention it in channels.');
    expect(C.teamAdminCanAdd).toBe('A team admin can add it.');
    expect(C.adminWillApprove).toBe("We'll ask an admin to approve it.");
    expect(C.selfPathLink).toBe('I can install Slack apps myself');
    expect(C.adminPathLink).toBe('Ask an admin instead');
    expect(C.slackHasFinalSay).toBe(
      'Slack has the final say: only someone allowed to install apps in your Slack workspace can add it.',
    );
    expect(C.removedNotice(who)).toBe(
      "@quill was removed from Slack. Add it again below. It's a new bot in Slack, so invite it to each channel again.",
    );
    expect(C.waitingForAdmin(botName)).toBe('Waiting for an admin to approve Quill Bot');
    expect(C.askedOn('Nov 3', botName)).toBe(
      'Asked on Nov 3. Once an admin approves it, Quill Bot is ready to invite to channels.',
    );
    expect(C.finishInSlack(botName)).toBe('Almost there: finish adding Quill Bot in Slack');
    expect(C.waitingForPerson(approver, botName)).toBe('Waiting for Ada Lovelace to finish adding Quill Bot in Slack');
    expect(C.cancelling).toBe('Cancelling…');
    expect(C.inSlack(who)).toBe('@quill is in Slack');
    expect(C.inviteLead).toBe('In any Slack channel, type ');
    expect(C.inviteNoHandle).toBe('In any Slack channel, type /invite and pick it.');
    expect(C.channelsLead({ botName, handle: 'quill' })).toBe('@quill has answered in these channels.');
    expect(C.channelsLead({ botName, handle: null })).toBe('Quill Bot has answered in these channels.');
    // The agent's NAME, never its @handle (the ux pass), and the team's name when it's known.
    expect(C.memoryShared('Quill', 'Support')).toBe(
      'What Quill hears is shared with everyone on Support, and Quill may bring it up elsewhere.',
    );
    expect(C.memoryShared('Quill', undefined)).toBe(
      'What Quill hears is shared with everyone on its team, and Quill may bring it up elsewhere.',
    );
    expect(C.outsidersUseYourAccess).toBe(
      'When someone outside the team mentions it, it answers them with your access.',
    );
    expect(C.helpLine(who)).toBe(
      'When @quill needs an OK for something, it asks the person who mentioned it. For people outside the team, it asks the team admin who set @quill up.',
    );
    expect(C.setUpAgain(who)).toBe('@quill needs to be set up again. The person who added it to Slack has left.');
    expect(C.changesCantReach(who)).toBe("Changes to @quill can't reach Slack right now.");
    expect(C.askToReconnect(who, approver)).toBe(
      "Changes to @quill can't reach Slack right now. Ask Ada Lovelace to reconnect it.",
    );
    expect(C.outsidersCantUse(who)).toBe(
      "People outside the team can't use @quill right now, because the team admin who set it up isn't a team admin anymore.",
    );
    expect(C.teamAdminCanFix).toBe(' A team admin can fix this.');
    expect(C.onceSlackIsBack).toBe(' You can do this here once Slack is connected again.');
    expect(C.reconnectThenRetry(who)).toBe("Changes to @quill can't reach Slack right now. Reconnect it, then try again.");
    expect(C.setUpAgainFirst(who)).toBe('@quill needs to be set up again before it can be changed.');
  });

  it('agentSlackBotTokenDead: only a slack-config-token refusal', () => {
    expect(agentSlackBotTokenDead(new AgentSlackError(502, 'slack-config-token'))).toBe(true);
    expect(agentSlackBotTokenDead(new AgentSlackError(502, 'slack-token'))).toBe(false);
    expect(agentSlackBotTokenDead(new AgentSlackError(502, 'slack-error'))).toBe(false);
    expect(agentSlackBotTokenDead(new AgentSlackError(409, 'not-live'))).toBe(false);
    expect(agentSlackBotTokenDead(new TypeError('x'))).toBe(false);
  });

  it('no card line names a role, a plumbing word or the product', () => {
    for (const v of Object.values(C)) {
      const line = typeof v === 'function' ? (v as (...a: unknown[]) => string)(who, approver) : v;
      expect(slackCardWordsFound(line), line).toEqual([]);
    }
    expect(slackCardWordsFound(C.channelsLead({ botName, handle: 'quill' }))).toEqual([]);
    expect(slackCardWordsFound(C.memoryShared('Quill', 'Support'))).toEqual([]);
    expect(slackCardWordsFound(C.memoryShared('Quill', undefined))).toEqual([]);
  });
});
