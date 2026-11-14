/**
 * An agent's Slack wire client (`lib/agent-slack.ts`, TASK-1094), stubbed at
 * `fetch` so the URLs, methods, headers and bodies it really sends are what is
 * asserted. The routes are @ax/channel-slack's (`agent-routes.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_SLACK_COPY,
  AgentSlackError,
  agentSlackErrorCopy,
  agentSlackStateChanged,
  connectSlackChannel,
  disconnectSlackChannel,
  fetchAgentSlack,
  fetchAvailableChannels,
  setSlackChannelRemember,
} from '../agent-slack';

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

const ROW = { channelId: 'C1', name: 'support', remember: false, connectedBy: 'Ada', needsReconnect: false };

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
    answer = () => json(200, { state: 'ready', botName: 'canopy', workspaceName: 'Acme', canManage: true, channels: [ROW], extra: 1 });
    await expect(fetchAgentSlack('a/1')).resolves.toEqual({
      state: 'ready',
      botName: 'canopy',
      workspaceName: 'Acme',
      canManage: true,
      channels: [ROW],
    });
    expect(calls[0]).toMatchObject({ url: '/settings/slack/a%2F1', method: 'GET', credentials: 'include' });

    answer = () => json(200, { state: 'no-workspace' });
    await expect(fetchAgentSlack('a1')).resolves.toEqual({ state: 'no-workspace' });
    answer = () => json(200, { state: 'personal-agent', botName: 'canopy' });
    await expect(fetchAgentSlack('a1')).resolves.toEqual({ state: 'personal-agent', botName: 'canopy' });
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
    answer = () => json(200, { state: 'ready', botName: 'x', workspaceName: 'y', canManage: 'yes', channels: [] });
    await expect(fetchAgentSlack('a1')).rejects.toMatchObject({ code: 'bad-response' });
    answer = () => json(200, { state: 'ready', botName: 'x', workspaceName: 'y', canManage: true, channels: [{ channelId: 'C1' }] });
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

  it('disconnect and remember send their own bodies', async () => {
    answer = () => json(200, { removed: true });
    await expect(disconnectSlackChannel('a1', 'C1')).resolves.toEqual({ removed: true });
    expect(calls[0]).toMatchObject({ url: '/settings/slack/a1/disconnect', body: { channelId: 'C1' } });
    answer = () => json(200, {});
    await setSlackChannelRemember('a1', 'C1', true);
    expect(calls[1]).toMatchObject({ url: '/settings/slack/a1/remember', body: { channelId: 'C1', remember: true } });
    expect(calls[1]?.headers['x-requested-with']).toBe('ax-admin');
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

describe('what an error says', () => {
  it('turns each refusal into its own sentence, never a code', () => {
    const e = (status: number, code: string, reason: string | null = null) => new AgentSlackError(status, code, reason);
    expect(agentSlackErrorCopy(e(409, 'needs-reconnect'))).toBe(AGENT_SLACK_COPY.needsReconnect);
    expect(agentSlackErrorCopy(e(409, 'channel-taken'))).toBe(AGENT_SLACK_COPY.channelTaken);
    expect(agentSlackErrorCopy(e(422, 'channel-not-allowed', 'not-public'))).toBe(AGENT_SLACK_COPY.notPublic);
    expect(agentSlackErrorCopy(e(422, 'channel-not-allowed', 'archived'))).toBe(AGENT_SLACK_COPY.archived);
    expect(agentSlackErrorCopy(e(422, 'channel-not-allowed', 'shared'))).toBe(AGENT_SLACK_COPY.shared);
    expect(agentSlackErrorCopy(e(422, 'channel-not-allowed', 'weird'))).toBe(AGENT_SLACK_COPY.channelNotAllowed);
    expect(agentSlackErrorCopy(e(502, 'slack-error'))).toBe(AGENT_SLACK_COPY.slackError);
    expect(agentSlackErrorCopy(e(400, 'invalid-body'))).toBe(AGENT_SLACK_COPY.generic);
    expect(agentSlackErrorCopy(new Error('boom'))).toBe(AGENT_SLACK_COPY.generic);
  });

  it('personal-agent and no-workspace refusals mean the picture is stale', () => {
    expect(agentSlackStateChanged(new AgentSlackError(409, 'personal-agent'))).toBe(true);
    expect(agentSlackStateChanged(new AgentSlackError(409, 'no-workspace'))).toBe(true);
    expect(agentSlackStateChanged(new AgentSlackError(409, 'channel-taken'))).toBe(false);
    expect(agentSlackStateChanged(new Error('x'))).toBe(false);
  });
});
