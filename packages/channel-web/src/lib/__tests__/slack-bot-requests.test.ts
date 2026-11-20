/**
 * Admin › Slack's bot requests: the wire client and the words for its
 * failures (`lib/slack-bot-requests.ts`, TASK-1169), stubbed at `fetch` so the
 * URLs, methods, headers and bodies it really sends are what is asserted. The
 * routes are @ax/channel-slack's (`bot-request-routes.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SLACK_BOT_REQUEST_COPY,
  approveSlackBotRequest,
  declineSlackBotRequest,
  fetchSlackBotRequests,
  slackBotRequestErrorCopy,
  slackBotRequestStale,
} from '../slack-bot-requests';
import { AGENT_SLACK_BOT_COPY, AGENT_SLACK_COPY } from '../agent-slack';
import { SLACK_ERROR_COPY, SlackAdminError } from '../slack-admin';
import { SLACK_TOKEN_COPY } from '../slack-token-copy';
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

const ROW = {
  requestId: 'AAAAAAAAAAAAAAAAAAAAAA',
  botName: 'Quill Bot',
  agentName: 'Quill',
  teamName: 'Support',
  requestedBy: 'Ada Lovelace',
  requestedAt: '2026-11-20T10:00:00.000Z',
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

describe('fetchSlackBotRequests', () => {
  it('reads the list field by field, with the session cookie', async () => {
    answer = () =>
      json(200, {
        requests: [ROW, { ...ROW, requestId: 'BBBBBBBBBBBBBBBBBBBBBB', teamName: null, extra: 1 }],
        truncated: true,
        configTokenStored: true,
      });
    const list = await fetchSlackBotRequests();
    expect(calls[0]).toMatchObject({ url: '/admin/slack/bot-requests', method: 'GET', credentials: 'include' });
    expect(list).toEqual({
      requests: [ROW, { ...ROW, requestId: 'BBBBBBBBBBBBBBBBBBBBBB', teamName: null }],
      truncated: true,
      configTokenStored: true,
    });
  });

  it('a malformed row is a bad response, never a half-drawn row', async () => {
    const bad: unknown[] = [
      { ...ROW, botName: 7 },
      { ...ROW, teamName: undefined },
      { ...ROW, requestedAt: null },
      { ...ROW, requestId: undefined },
      'row',
      null,
    ];
    for (const row of bad) {
      answer = () => json(200, { requests: [row], truncated: false, configTokenStored: false });
      await expect(fetchSlackBotRequests()).rejects.toMatchObject({ code: 'bad-response' });
    }
    answer = () => json(200, { requests: [], truncated: false, configTokenStored: 'yes' });
    await expect(fetchSlackBotRequests()).rejects.toMatchObject({ code: 'bad-response' });
    // The server always says whether it cut the list: a missing or mistyped answer is a bad one.
    answer = () => json(200, { requests: [], configTokenStored: false });
    await expect(fetchSlackBotRequests()).rejects.toMatchObject({ code: 'bad-response' });
    answer = () => json(200, { requests: [], truncated: 'no', configTokenStored: false });
    await expect(fetchSlackBotRequests()).rejects.toMatchObject({ code: 'bad-response' });
    answer = () => json(200, { truncated: false, configTokenStored: false });
    await expect(fetchSlackBotRequests()).rejects.toMatchObject({ code: 'bad-response' });
  });

  it('a failed read throws with its status', async () => {
    answer = () => json(500, { error: 'internal' });
    await expect(fetchSlackBotRequests()).rejects.toMatchObject({ status: 500, code: 'unknown' });
  });
});

describe('approveSlackBotRequest', () => {
  it("posts only what it is given, with the write headers, to the request's own path", async () => {
    answer = () => json(200, { installUrl: 'https://slack.com/oauth/v2/authorize?x=1', iconSet: true });
    await expect(approveSlackBotRequest('A/B', {})).resolves.toEqual({
      installUrl: 'https://slack.com/oauth/v2/authorize?x=1',
    });
    expect(calls[0]).toMatchObject({
      url: '/admin/slack/bot-requests/A%2FB/approve',
      method: 'POST',
      credentials: 'include',
      body: {},
    });
    expect(calls[0]?.headers['x-requested-with']).toBe('ax-admin');
    expect(calls[0]?.headers['content-type']).toBe('application/json');

    await approveSlackBotRequest('R1', { refreshToken: fakeConfigRefreshToken(), iconPng: 'AAAA' });
    expect(calls[1]?.body).toEqual({ refreshToken: fakeConfigRefreshToken(), iconPng: 'AAAA' });
    await approveSlackBotRequest('R1', { iconPng: 'AAAA' });
    expect(calls[2]?.body).toEqual({ iconPng: 'AAAA' });
  });

  it('an answer without an install link is a bad response', async () => {
    answer = () => json(200, { installUrl: '', iconSet: false });
    await expect(approveSlackBotRequest('R1', {})).rejects.toMatchObject({ code: 'bad-response' });
    answer = () => json(200, {});
    await expect(approveSlackBotRequest('R1', {})).rejects.toMatchObject({ code: 'bad-response' });
  });

  it('a refusal keeps its status and code, and drops a code that is not code-shaped', async () => {
    answer = () => json(502, { error: 'slack-config-token' });
    await expect(approveSlackBotRequest('R1', {})).rejects.toMatchObject({ status: 502, code: 'slack-config-token' });
    answer = () => json(400, { error: 'Not A Code!' });
    await expect(approveSlackBotRequest('R1', {})).rejects.toMatchObject({ status: 400, code: 'unknown' });
  });
});

describe('declineSlackBotRequest', () => {
  it("posts to the request's own path", async () => {
    await expect(declineSlackBotRequest('R/1')).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({ url: '/admin/slack/bot-requests/R%2F1/decline', method: 'POST', body: {} });
    expect(calls[0]?.headers['x-requested-with']).toBe('ax-admin');
  });

  it('a refusal throws', async () => {
    answer = () => json(404, { error: 'not-found' });
    await expect(declineSlackBotRequest('R1')).rejects.toMatchObject({ status: 404, code: 'not-found' });
  });
});

describe('error copy and stale', () => {
  const e = (status: number, code: string) => new SlackAdminError(status, code);

  it('each code lands where the plan says', () => {
    for (const code of ['requester-not-admin', 'agent-gone', 'bot-name-taken', 'slack-name', 'no-workspace'] as const) {
      expect(slackBotRequestErrorCopy(e(409, code))).toEqual({
        field: null,
        message: SLACK_BOT_REQUEST_COPY[code],
        revealToken: false,
      });
    }
    for (const code of ['config-token-needed', 'slack-config-token', 'slack-token'] as const) {
      expect(slackBotRequestErrorCopy(e(502, code))).toEqual({
        field: 'refreshToken',
        message: AGENT_SLACK_BOT_COPY[code],
        revealToken: true,
      });
    }
    for (const code of ['invalid-refresh-token', 'slack-refresh-token'] as const) {
      expect(slackBotRequestErrorCopy(e(400, code))).toEqual({
        field: 'refreshToken',
        message: SLACK_TOKEN_COPY[code],
        revealToken: false,
      });
    }
    expect(slackBotRequestErrorCopy(e(409, 'public-origin-not-https')).message).toBe(
      SLACK_ERROR_COPY['public-origin-not-https'],
    );
    expect(slackBotRequestErrorCopy(e(502, 'slack-unconfirmed')).message).toBe(SLACK_TOKEN_COPY['slack-unconfirmed']);
    expect(slackBotRequestErrorCopy(e(502, 'slack-error')).message).toBe(SLACK_ERROR_COPY.generic);
    expect(slackBotRequestErrorCopy(e(500, 'internal')).message).toBe(AGENT_SLACK_COPY.generic);
    expect(slackBotRequestErrorCopy(new Error('boom'))).toEqual({
      field: null,
      message: AGENT_SLACK_COPY.generic,
      revealToken: false,
    });
  });

  it('says the sentences the plan fixed, and never a raw code', () => {
    expect(SLACK_BOT_REQUEST_COPY['requester-not-admin']).toBe(
      "The person who asked is no longer an admin of that agent's team, so this can't be approved. Decline it instead.",
    );
    expect(SLACK_BOT_REQUEST_COPY['agent-gone']).toBe(
      "That agent was deleted, so there's nothing to approve. Decline the request.",
    );
    expect(SLACK_BOT_REQUEST_COPY['no-workspace']).toBe("Slack isn't connected right now, so bots can't be approved.");
    expect(slackBotRequestErrorCopy(e(409, 'weird-new-code')).message).not.toContain('weird-new-code');
  });

  it('only a missing request or a bot that already exists is stale', () => {
    expect(slackBotRequestStale(e(404, 'not-found'))).toBe(true);
    expect(slackBotRequestStale(e(409, 'bot-exists'))).toBe(true);
    expect(slackBotRequestStale(e(409, 'agent-gone'))).toBe(false);
    expect(slackBotRequestStale(e(409, 'requester-not-admin'))).toBe(false);
    expect(slackBotRequestStale(e(502, 'slack-config-token'))).toBe(false);
    expect(slackBotRequestStale(new Error('x'))).toBe(false);
  });
});
