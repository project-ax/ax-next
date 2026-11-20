/**
 * Admin › Slack's list of team agents' own bots and its Disconnect
 * (`lib/slack-bots-admin.ts`, TASK-1172), stubbed at `fetch` so the URLs,
 * methods, headers and bodies it really sends are what is asserted. The routes
 * are @ax/channel-slack's (`admin-bot-routes.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SlackAdminError } from '../slack-admin';
import { disconnectTeamBot, fetchSlackBots, teamBotGone } from '../slack-bots-admin';

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
};
const LIVE = {
  installId: ID_2,
  botName: 'Sales Desk',
  handle: 'salesdesk',
  approver: null,
  state: 'live',
  addedAt: '2026-11-18T10:00:00.000Z',
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
  it('GETs /admin/slack/bots with the session cookie and keeps only the six fields', async () => {
    answer = () => json(200, { bots: [{ ...PENDING, appId: 'A0SECRET', agentId: 'x' }, LIVE] });
    await expect(fetchSlackBots()).resolves.toEqual({ state: 'ready', bots: [PENDING, LIVE] });
    expect(calls[0]).toMatchObject({ url: '/admin/slack/bots', method: 'GET', credentials: 'include' });
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
  it('is true only for 409 no-bot', () => {
    expect(teamBotGone(new SlackAdminError(409, 'no-bot'))).toBe(true);
    expect(teamBotGone(new SlackAdminError(409, 'other'))).toBe(false);
    expect(teamBotGone(new SlackAdminError(403, 'no-bot'))).toBe(false);
    expect(teamBotGone(new SlackAdminError(500, 'internal'))).toBe(false);
    expect(teamBotGone(new Error('x'))).toBe(false);
  });
});
