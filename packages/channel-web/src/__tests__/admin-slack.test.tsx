/**
 * Admin › Slack's wire client (`lib/slack-admin.ts`, TASK-1093), stubbed at
 * `fetch` so the URLs, methods, headers and bodies it really sends are what is
 * asserted. The routes are @ax/channel-slack's (`admin-routes.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SLACK_ERROR_COPY,
  SlackAdminError,
  connectSlack,
  disconnectSlack,
  fetchSlackStatus,
  goToSlack,
  resumeSlackInstall,
  slackErrorCopy,
  slackStateChanged,
} from '../lib/slack-admin';
import { CONFIG_ACCESS_PREFIX, CONFIG_REFRESH_PREFIX, fakeConfigAccessToken, fakeConfigRefreshToken } from '../test-utils/fake-slack-tokens';

const INSTALL_URL =
  'https://slack.com/oauth/v2/authorize?client_id=751.759&scope=chat%3Awrite&redirect_uri=https%3A%2F%2Fax.example%2Fadmin%2Fslack%2Foauth%2Fcallback&state=ab12';
// Shaped like Slack's configuration tokens, short enough that no scanner
// takes them for real ones.
const ACCESS = fakeConfigAccessToken('PASTEDACCESS');
const REFRESH = fakeConfigRefreshToken('PASTEDREFRESH');

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
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

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

describe('fetchSlackStatus', () => {
  it('GETs /admin/slack with the session cookie and returns each state, extra fields dropped', async () => {
    const states = [
      { state: 'not-connected', defaultBotName: 'canopy', canConnect: true },
      { state: 'pending', botName: 'canopy', connectedBy: 'Ada Admin', connectedAt: '2026-11-13T12:00:00.000Z' },
      {
        state: 'connected',
        botName: 'canopy',
        workspaceName: 'Canopy Works',
        connectedBy: 'Ada Admin',
        connectedAt: '2026-11-13T12:00:00.000Z',
      },
    ];
    for (const s of states) {
      answer = () => json(200, { ...s, installId: 'should-not-pass-through' });
      expect(await fetchSlackStatus()).toEqual(s);
    }
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c).toMatchObject({ url: '/admin/slack', method: 'GET', credentials: 'include' });
    }
  });

  it('a 404, or a page that is not JSON (the app shell), means Slack is unavailable here', async () => {
    answer = () => json(404, { error: 'not-found' });
    expect(await fetchSlackStatus()).toEqual({ state: 'unavailable' });
    answer = () =>
      new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    expect(await fetchSlackStatus()).toEqual({ state: 'unavailable' });
  });

  it('any other failure, or an answer we cannot read, is an error to retry', async () => {
    answer = () => json(500, { error: 'internal' });
    await expect(fetchSlackStatus()).rejects.toBeInstanceOf(Error);
    answer = () => json(200, { state: 'connected', botName: 'canopy' });
    await expect(fetchSlackStatus()).rejects.toMatchObject({ code: 'bad-response' });
    answer = () => json(200, { state: 'not-connected', defaultBotName: 'canopy', canConnect: 'yes' });
    await expect(fetchSlackStatus()).rejects.toMatchObject({ code: 'bad-response' });
    answer = () => json(200, ['not-connected']);
    await expect(fetchSlackStatus()).rejects.toMatchObject({ code: 'bad-response' });
  });
});

describe('the writes', () => {
  it('connectSlack POSTs exactly the three fields with the CSRF header and returns Slack’s install link', async () => {
    answer = () => json(200, { installUrl: INSTALL_URL, iconSet: false });
    const out = await connectSlack({ accessToken: ACCESS, refreshToken: REFRESH, botName: 'Canopy Bot' });
    expect(out).toEqual({ installUrl: INSTALL_URL });
    expect(calls).toEqual([
      {
        url: '/admin/slack/connect',
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' },
        body: { accessToken: ACCESS, refreshToken: REFRESH, botName: 'Canopy Bot' },
      },
    ]);
  });

  it('resumeSlackInstall and disconnectSlack POST with the CSRF header and read their answers', async () => {
    answer = (c) =>
      c.url === '/admin/slack/install-url' ? json(200, { installUrl: INSTALL_URL }) : json(200, { appDeleted: false });
    expect(await resumeSlackInstall()).toEqual({ installUrl: INSTALL_URL });
    expect(await disconnectSlack()).toEqual({ appDeleted: false });
    expect(calls.map((c) => [c.url, c.method, c.credentials, c.headers['x-requested-with']])).toEqual([
      ['/admin/slack/install-url', 'POST', 'include', 'ax-admin'],
      ['/admin/slack/disconnect', 'POST', 'include', 'ax-admin'],
    ]);
  });

  it('an install link that is not Slack’s Allow page is refused, never followed', async () => {
    for (const installUrl of [
      'https://evil.example/oauth/v2/authorize?state=x',
      'http://slack.com/oauth/v2/authorize?state=x',
      'https://slack.com.evil.example/oauth/v2/authorize',
      'https://slack.com/api/oauth.v2.access',
      'javascript:alert(1)',
      '/oauth/v2/authorize',
      42,
    ]) {
      answer = () => json(200, { installUrl });
      await expect(connectSlack({ accessToken: ACCESS, refreshToken: REFRESH, botName: 'x' })).rejects.toMatchObject({
        code: 'bad-response',
      });
      await expect(resumeSlackInstall()).rejects.toMatchObject({ code: 'bad-response' });
    }
  });

  it('a disconnect answer without a yes/no is refused', async () => {
    answer = () => json(200, { appDeleted: 'true' });
    await expect(disconnectSlack()).rejects.toMatchObject({ code: 'bad-response' });
  });

  it('a refusal carries the status, the server’s code and its reason, and nothing else from the body', async () => {
    answer = () => json(400, { error: 'invalid-bot-name', reason: 'reserved' });
    const err = await connectSlack({ accessToken: ACCESS, refreshToken: REFRESH, botName: 'slackbot' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SlackAdminError);
    expect(err).toMatchObject({ status: 400, code: 'invalid-bot-name', reason: 'reserved' });

    // A code that isn't code-shaped is not repeated.
    answer = () => json(502, { error: 'Slack said: <b>nope</b>' });
    await expect(disconnectSlack()).rejects.toMatchObject({ status: 502, code: 'unknown', reason: null });
    // Neither is a body that isn't JSON.
    answer = () => new Response('Bad gateway', { status: 502 });
    await expect(resumeSlackInstall()).rejects.toMatchObject({ status: 502, code: 'unknown' });
  });
});

describe('goToSlack', () => {
  let originalLocation: Location;
  beforeEach(() => {
    originalLocation = window.location;
    Object.defineProperty(window, 'location', { writable: true, value: { assign: vi.fn() } });
  });
  afterEach(() => {
    Object.defineProperty(window, 'location', { writable: true, value: originalLocation });
  });

  it('hands the whole page to Slack’s Allow page', () => {
    goToSlack(INSTALL_URL);
    expect(window.location.assign).toHaveBeenCalledWith(INSTALL_URL);
  });

  it('refuses to go anywhere else', () => {
    expect(() => goToSlack('https://evil.example/')).toThrow();
    expect(window.location.assign).not.toHaveBeenCalled();
  });
});

describe('what an error says', () => {
  const refusal = (status: number, code: string, reason: string | null = null) =>
    new SlackAdminError(status, code, reason);

  it.each([
    [refusal(400, 'invalid-access-token'), 'accessToken', `That doesn't look like an access token. It starts with ${CONFIG_ACCESS_PREFIX}.`],
    [refusal(400, 'invalid-refresh-token'), 'refreshToken', `That doesn't look like a refresh token. It starts with ${CONFIG_REFRESH_PREFIX}.`],
    [refusal(400, 'invalid-bot-name', 'empty'), 'botName', 'Give the bot a name.'],
    [refusal(400, 'invalid-bot-name', 'too-long'), 'botName', 'Keep the name to 35 characters or fewer.'],
    [refusal(400, 'invalid-bot-name', 'bad-characters'), 'botName', 'Use letters, numbers, spaces, dots, dashes or underscores.'],
    [refusal(400, 'invalid-bot-name', 'reserved'), 'botName', 'Slack keeps that name for itself. Pick another.'],
    [refusal(400, 'invalid-bot-name', 'something-new'), 'botName', "Slack can't use that name. Try another."],
    [refusal(502, 'slack-token'), null, "Slack didn't accept the access token. Generate a new pair and paste both again."],
    [refusal(502, 'slack-name'), 'botName', "Slack didn't accept that bot name. Try another."],
    [
      refusal(502, 'slack-unconfirmed'),
      null,
      "Slack didn't give us a clear answer, so a Slack app may have been created anyway. Check api.slack.com/apps and delete it before you try again.",
    ],
    [refusal(502, 'slack-error'), null, SLACK_ERROR_COPY.generic],
    [refusal(500, 'internal'), null, SLACK_ERROR_COPY.generic],
    [new TypeError('Failed to fetch'), null, SLACK_ERROR_COPY.generic],
  ] as const)('%o → %s: %s', (err, field, message) => {
    expect(slackErrorCopy(err)).toEqual({ field, message });
  });

  it('the generic sentence is the plan’s, and no message carries a raw code', () => {
    expect(SLACK_ERROR_COPY.generic).toBe('Something went wrong talking to Slack. Try again in a minute.');
    expect(slackErrorCopy(refusal(502, 'slack-error')).message).not.toContain('slack-error');
  });

  it('only a 409 for a state that moved on means "refresh and show what is there now"', () => {
    for (const code of ['already-connected', 'not-pending', 'not-connected', 'public-origin-not-https']) {
      expect(slackStateChanged(refusal(409, code)), code).toBe(true);
    }
    expect(slackStateChanged(refusal(400, 'not-connected'))).toBe(false);
    expect(slackStateChanged(refusal(409, 'something-else'))).toBe(false);
    expect(slackStateChanged(new Error('x'))).toBe(false);
  });
});
