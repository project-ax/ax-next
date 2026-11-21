/**
 * Admin › Slack's list of team agents' own bots and its Disconnect
 * (`lib/slack-bots-admin.ts`, TASK-1172), stubbed at `fetch` so the URLs,
 * methods, headers and bodies it really sends are what is asserted. The routes
 * are @ax/channel-slack's (`admin-bot-routes.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REQUEST_TIMEOUT_MS, RequestTimeoutError } from '../http';
import { SlackAdminError } from '../slack-admin';
import {
  disconnectTeamBot,
  fetchSlackBots,
  replaceTeamBotToken,
  teamBotGone,
  teamBotReplaceErrorCopy,
  teamBotReplaceStale,
} from '../slack-bots-admin';
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

const ID_1 = 'U3VwcG9ydEJvdEluc3RhbG';
const ID_2 = 'U2FsZXNCb3RJbnN0YWxsMQ';
const PENDING = {
  installId: ID_1,
  botName: 'Support Bot',
  handle: null,
  approver: 'Grace Hopper',
  state: 'pending',
  addedAt: '2026-11-19T10:00:00.000Z',
  viewerIsApprover: false,
};
const LIVE = {
  installId: ID_2,
  botName: 'Sales Desk',
  handle: 'salesdesk',
  approver: null,
  state: 'live',
  addedAt: '2026-11-18T10:00:00.000Z',
  viewerIsApprover: false,
};

beforeEach(() => {
  calls = [];
  answer = () => json(200, { bots: [] });
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

describe('fetchSlackBots', () => {
  it('GETs /admin/slack/bots with the session cookie and keeps only the seven fields', async () => {
    answer = () => json(200, { bots: [{ ...PENDING, appId: 'A0SECRET', agentId: 'x' }, LIVE] });
    await expect(fetchSlackBots()).resolves.toEqual({ state: 'ready', bots: [PENDING, LIVE] });
    expect(calls[0]).toMatchObject({ url: '/admin/slack/bots', method: 'GET', credentials: 'include' });
  });

  it('viewerIsApprover: absent (an older host) reads as false, true stays true, anything else is a bad-response', async () => {
    const { viewerIsApprover: _v, ...older } = LIVE;
    answer = () => json(200, { bots: [older, { ...PENDING, viewerIsApprover: true }] });
    await expect(fetchSlackBots()).resolves.toEqual({
      state: 'ready',
      bots: [LIVE, { ...PENDING, viewerIsApprover: true }],
    });
    for (const bad of ['yes', 1, null]) {
      answer = () => json(200, { bots: [{ ...LIVE, viewerIsApprover: bad }] });
      await expect(fetchSlackBots()).rejects.toMatchObject({ name: 'SlackAdminError', code: 'bad-response' });
    }
  });

  it('a 404 or a page that is not JSON is unavailable; a missing list or a malformed item is a bad-response', async () => {
    answer = () => json(404, { error: 'not-found' });
    await expect(fetchSlackBots()).resolves.toEqual({ state: 'unavailable' });
    answer = () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    await expect(fetchSlackBots()).resolves.toEqual({ state: 'unavailable' });

    answer = () => json(500, { error: 'internal' });
    await expect(fetchSlackBots()).rejects.toThrow();

    const bad: unknown[] = [
      {},
      { bots: 'none' },
      { bots: [{ ...PENDING, installId: 'short' }] },
      { bots: [{ ...PENDING, installId: 'A'.repeat(21) + '/' }] },
      { bots: [{ ...PENDING, botName: '' }] },
      { bots: [{ ...PENDING, botName: 'x'.repeat(81) }] },
      { bots: [{ ...PENDING, handle: 7 }] },
      { bots: [{ ...PENDING, approver: 7 }] },
      // The server always sends the field (null for a former member); one that is absent is a malformed item.
      { bots: [{ ...PENDING, approver: undefined }] },
      { bots: [{ ...PENDING, state: 'gone' }] },
      { bots: [{ ...PENDING, addedAt: 7 }] },
      { bots: [PENDING, 'oops'] },
    ];
    for (const body of bad) {
      answer = () => json(200, body);
      await expect(fetchSlackBots()).rejects.toMatchObject({ name: 'SlackAdminError', code: 'bad-response' });
    }
  });
});

describe('fetchSlackBots deadline', () => {
  it('a read that never answers rejects with a RequestTimeoutError, and its request is dropped', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      vi.stubGlobal('fetch', (_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      });
      const pending = fetchSlackBots();
      const outcome = expect(pending).rejects.toBeInstanceOf(RequestTimeoutError);
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      await outcome;
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('disconnectTeamBot', () => {
  it('POSTs { installId } with the write headers and reads appDeleted; a refusal is a SlackAdminError with its code', async () => {
    answer = () => json(200, { appDeleted: false });
    await expect(disconnectTeamBot(ID_1)).resolves.toEqual({ appDeleted: false });
    expect(calls[0]).toMatchObject({
      url: '/admin/slack/bots/disconnect',
      method: 'POST',
      credentials: 'include',
      body: { installId: ID_1 },
    });
    expect(calls[0]?.headers['x-requested-with']).toBe('ax-admin');
    expect(calls[0]?.headers['content-type']).toBe('application/json');

    answer = () => json(200, {});
    await expect(disconnectTeamBot(ID_1)).rejects.toMatchObject({ code: 'bad-response' });
    answer = () => json(409, { error: 'no-bot' });
    const err = await disconnectTeamBot(ID_1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlackAdminError);
    expect(err).toMatchObject({ status: 409, code: 'no-bot' });
  });
});

describe('teamBotGone', () => {
  it('is true only for 409 no-bot and 409 not-live (the bot was reset or rebuilt)', () => {
    expect(teamBotGone(new SlackAdminError(409, 'no-bot'))).toBe(true);
    expect(teamBotGone(new SlackAdminError(409, 'not-live'))).toBe(true);
    expect(teamBotGone(new SlackAdminError(409, 'other'))).toBe(false);
    expect(teamBotGone(new SlackAdminError(403, 'no-bot'))).toBe(false);
    expect(teamBotGone(new SlackAdminError(500, 'internal'))).toBe(false);
    expect(teamBotGone(new Error('x'))).toBe(false);
  });
});

describe('replaceTeamBotToken', () => {
  it('POSTs { installId, refreshToken } alone with the write headers; a refusal is a SlackAdminError with its code', async () => {
    const token = fakeConfigRefreshToken('replace');
    answer = () => json(200, {});
    await expect(replaceTeamBotToken(ID_2, token)).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({
      url: '/admin/slack/bots/replace-token',
      method: 'POST',
      credentials: 'include',
      body: { installId: ID_2, refreshToken: token },
    });
    expect(Object.keys(calls[0]?.body as object).sort()).toEqual(['installId', 'refreshToken']);
    expect(calls[0]?.headers['x-requested-with']).toBe('ax-admin');
    expect(calls[0]?.headers['content-type']).toBe('application/json');

    answer = () => json(403, { error: 'not-approver' });
    const err = await replaceTeamBotToken(ID_2, token).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlackAdminError);
    expect(err).toMatchObject({ status: 403, code: 'not-approver' });
  });
});

describe('teamBotReplaceStale', () => {
  it('is true for what teamBotGone says and for 403 not-approver; a refused token is not stale', () => {
    expect(teamBotReplaceStale(new SlackAdminError(403, 'not-approver'))).toBe(true);
    expect(teamBotReplaceStale(new SlackAdminError(409, 'no-bot'))).toBe(true);
    expect(teamBotReplaceStale(new SlackAdminError(409, 'not-live'))).toBe(true);
    expect(teamBotReplaceStale(new SlackAdminError(502, 'slack-not-app-manager'))).toBe(false);
    expect(teamBotReplaceStale(new SlackAdminError(400, 'invalid-refresh-token'))).toBe(false);
    expect(teamBotReplaceStale(new SlackAdminError(403, 'forbidden'))).toBe(false);
    expect(teamBotReplaceStale(new Error('x'))).toBe(false);
  });
});

describe('teamBotReplaceErrorCopy', () => {
  const copy = (code: string): { field: string | null; message: string } =>
    teamBotReplaceErrorCopy(new SlackAdminError(400, code));

  it('every code has its sentence and its field', () => {
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
  });

  it('anything else, or a dropped connection, is the generic Slack line', () => {
    const generic = { field: null, message: 'Something went wrong talking to Slack. Try again in a minute.' };
    expect(copy('internal')).toEqual(generic);
    expect(copy('something-new')).toEqual(generic);
    expect(teamBotReplaceErrorCopy(new TypeError('x'))).toEqual(generic);
  });
});
