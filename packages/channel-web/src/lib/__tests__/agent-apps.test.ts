/**
 * An agent's Apps wire client (`lib/agent-apps.ts`), stubbed at `fetch` so
 * the URLs, methods, headers and bodies it really sends are what is asserted.
 * The routes are @ax/apps-bridge's (`settings-routes.ts`); the shapes are
 * @ax/apps-bridge-contract's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentAppsError,
  agentAppsErrorCopy,
  agentAppsStale,
  approveApp,
  fetchAgentApps,
  fetchApprovalPrompt,
  mintLinkCode,
  removeGrant,
  revokeApproval,
  saveGrant,
  unlinkApp,
} from '../agent-apps';

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

const KEY = 'mcp.c0123456789.search_issues';
const GRANT = { connectorId: 'linear', connectorName: 'Linear', mode: 'builder', tools: [{ toolKey: KEY, name: 'search_issues' }] };
const LINK = { appId: 'app_01JDZ8M5Q4X7RT3VKF0N2C9H6B', appName: 'Sprint board', createdAt: '2026-11-21T10:00:00.000Z', grants: [GRANT] };
const APPROVAL = {
  appId: LINK.appId,
  appName: 'Sprint board',
  connectorId: 'linear',
  connectorName: 'Linear',
  createdAt: '2026-11-21T10:05:00.000Z',
};
const READ = { enabled: true, canManage: true, links: [LINK], approvals: [APPROVAL] };
const CODE = 'axl_abcdefghijklmnopqrstuvwxyz234567';
const PROMPT = {
  platformId: 'acme-apps',
  appId: LINK.appId,
  appName: 'Sprint board',
  connectorId: 'linear',
  connectorName: 'Linear',
  tools: ['search_issues'],
  agents: [{ agentId: 'a1', displayName: 'Quill' }],
  approvedAgentId: null,
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

describe('fetchAgentApps', () => {
  it('fetchAgentApps GETs /settings/apps/<id> and parses the answer', async () => {
    answer = () => json(200, READ);
    await expect(fetchAgentApps('a/1')).resolves.toEqual(READ);
    expect(calls[0]).toMatchObject({ url: '/settings/apps/a%2F1', method: 'GET', credentials: 'include' });

    answer = () => json(200, { enabled: false });
    await expect(fetchAgentApps('a1')).resolves.toEqual({ enabled: false });
  });

  it('a 404 or a non-JSON answer is unavailable', async () => {
    answer = () => json(404, { error: 'agent-not-found' });
    await expect(fetchAgentApps('a1')).resolves.toBe('unavailable');
    answer = () => new Response('<!doctype html><title>app</title>', { status: 200, headers: { 'content-type': 'text/html' } });
    await expect(fetchAgentApps('a1')).resolves.toBe('unavailable');
  });

  it('an answer off the schema is a bad response, and any other failure throws for a retry', async () => {
    answer = () => json(200, { ...READ, extra: 1 });
    await expect(fetchAgentApps('a1')).rejects.toMatchObject({ code: 'bad-response' });
    answer = () => json(200, { ...READ, links: [{ ...LINK, appId: 'not an id' }] });
    await expect(fetchAgentApps('a1')).rejects.toMatchObject({ code: 'bad-response' });
    answer = () => json(503, { error: 'unavailable' });
    await expect(fetchAgentApps('a1')).rejects.toMatchObject({ status: 503, code: 'unavailable' });
  });
});

describe('writes', () => {
  it('writes send x-requested-with: ax-admin and a JSON body; error bodies become codes', async () => {
    await unlinkApp('a1', LINK.appId);
    await removeGrant('a1', LINK.appId, 'linear');
    await revokeApproval('a1', LINK.appId, 'linear');
    answer = () => json(200, { grant: GRANT });
    await expect(
      saveGrant('a1', { appId: LINK.appId, connectorId: 'linear', mode: 'builder', toolKeys: [KEY] }),
    ).resolves.toEqual(GRANT);

    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['POST', '/settings/apps/a1/unlink', { appId: LINK.appId }],
      ['POST', '/settings/apps/a1/ungrant', { appId: LINK.appId, connectorId: 'linear' }],
      ['POST', '/settings/apps/a1/revoke', { appId: LINK.appId, connectorId: 'linear' }],
      ['POST', '/settings/apps/a1/grant', { appId: LINK.appId, connectorId: 'linear', mode: 'builder', toolKeys: [KEY] }],
    ]);
    for (const c of calls) {
      expect(c.headers['x-requested-with']).toBe('ax-admin');
      expect(c.headers['content-type']).toBe('application/json');
      expect(c.credentials).toBe('include');
    }

    answer = () => json(404, { error: 'not-linked' });
    const err = await unlinkApp('a1', LINK.appId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentAppsError);
    expect(err).toMatchObject({ status: 404, code: 'not-linked' });

    // A code the server never sends, or no body at all, is `unknown`.
    answer = () => json(400, { error: 'Some Prose <b>here</b>' });
    await expect(removeGrant('a1', LINK.appId, 'linear')).rejects.toMatchObject({ code: 'unknown' });
    answer = () => new Response('nope', { status: 500 });
    await expect(revokeApproval('a1', LINK.appId, 'linear')).rejects.toMatchObject({ status: 500, code: 'unknown' });

    // A saved grant off the schema is a bad response.
    answer = () => json(200, { grant: { ...GRANT, mode: 'everyone' } });
    await expect(
      saveGrant('a1', { appId: LINK.appId, connectorId: 'linear', mode: 'builder', toolKeys: [KEY] }),
    ).rejects.toMatchObject({ code: 'bad-response' });
  });

  it('mintLinkCode POSTs {} and returns the code and its expiry', async () => {
    answer = () => json(200, { code: CODE, expiresAt: '2026-11-21T10:15:00.000Z' });
    await expect(mintLinkCode('a1')).resolves.toEqual({ code: CODE, expiresAt: '2026-11-21T10:15:00.000Z' });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: '/settings/apps/a1/link-code',
      body: {},
      headers: { 'x-requested-with': 'ax-admin' },
    });

    answer = () => json(200, { code: 'not-a-code', expiresAt: '2026-11-21T10:15:00.000Z' });
    await expect(mintLinkCode('a1')).rejects.toMatchObject({ code: 'bad-response' });
    answer = () => json(403, { error: 'forbidden' });
    await expect(mintLinkCode('a1')).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });
});

describe('the approve page (Task 14)', () => {
  it('fetchApprovalPrompt GETs /settings/app-approval/<platform>/<app>/<connector> and parses the prompt', async () => {
    answer = () => json(200, PROMPT);
    await expect(fetchApprovalPrompt('acme-apps', LINK.appId, 'linear')).resolves.toEqual(PROMPT);
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: `/settings/app-approval/acme-apps/${LINK.appId}/linear`,
      credentials: 'include',
    });

    answer = () => json(200, { ...PROMPT, tools: 'search_issues' });
    await expect(fetchApprovalPrompt('acme-apps', LINK.appId, 'linear')).rejects.toMatchObject({ code: 'bad-response' });
    answer = () => json(404, { error: 'not-found' });
    await expect(fetchApprovalPrompt('acme-apps', LINK.appId, 'linear')).rejects.toMatchObject({ status: 404, code: 'not-found' });
  });

  it('approveApp POSTs { agentId, tools } with the CSRF header', async () => {
    await approveApp('acme-apps', LINK.appId, 'linear', 'a1', ['search_issues']);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `/settings/app-approval/acme-apps/${LINK.appId}/linear`,
      body: { agentId: 'a1', tools: ['search_issues'] },
      headers: { 'x-requested-with': 'ax-admin', 'content-type': 'application/json' },
    });

    answer = () => json(400, { error: 'agent-not-eligible' });
    await expect(approveApp('acme-apps', LINK.appId, 'linear', 'a2', ['search_issues'])).rejects.toMatchObject({
      code: 'agent-not-eligible',
    });
  });
});

describe('error copy', () => {
  it('says something a person can act on, and never the code itself', () => {
    for (const code of ['forbidden', 'not-linked', 'bridge-off', 'unknown', 'bad-response'] as const) {
      const text = agentAppsErrorCopy(new AgentAppsError(400, code));
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toContain(code);
    }
    expect(agentAppsErrorCopy(new Error('boom'))).toBe(agentAppsErrorCopy(new AgentAppsError(0, 'unknown')));
  });

  it('a refusal that means the page is out of date asks for a re-read', () => {
    expect(agentAppsStale(new AgentAppsError(404, 'not-linked'))).toBe(true);
    expect(agentAppsStale(new AgentAppsError(404, 'not-found'))).toBe(true);
    expect(agentAppsStale(new AgentAppsError(400, 'connector-not-on-agent'))).toBe(true);
    expect(agentAppsStale(new AgentAppsError(403, 'forbidden'))).toBe(false);
    expect(agentAppsStale(new Error('x'))).toBe(false);
  });
});
