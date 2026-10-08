/**
 * Slice 3 — `workspaceApi.attachConnector`: the Add subview's one request.
 *
 * A per-agent key rides in the body as `keys: [{ slot, payloadB64 }]`; a
 * shared-key or no-auth Add sends NO `keys` field at all (an empty array is
 * "present" to the server and refused). A refusal names its code — only a
 * known one — and a transport failure never carries the key.
 *
 * Drives the REAL client against a stubbed global `fetch`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AttachConnectorError, workspaceApi } from '../workspace-api';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
afterEach(() => {
  fetchMock.mockReset();
  vi.restoreAllMocks();
});

const SECRET = 'zd_SECRET123';

async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

function ok() {
  return new Response(JSON.stringify({ attached: true, changed: true }), { status: 200 });
}

describe('workspaceApi.attachConnector', () => {
  it('without keys, POSTs only the connector — no keys field at all', async () => {
    fetchMock.mockResolvedValueOnce(ok());
    expect(await workspaceApi.attachConnector('a/1', 'stripe')).toEqual({ attached: true, changed: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/workspace/agents/a%2F1/connectors');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-requested-with']).toBe('ax-admin');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ connectorId: 'stripe' });
    expect('keys' in body).toBe(false);
  });

  it('with keys, sends each slot and its key as base64, in the same request', async () => {
    fetchMock.mockResolvedValueOnce(ok());
    await workspaceApi.attachConnector('a1', 'zendesk', [
      { slot: 'token', payload: SECRET },
      { slot: 'SUBDOMAIN', payload: 'acmé' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      connectorId: 'zendesk',
      keys: [
        { slot: 'token', payloadB64: btoa(SECRET) },
        { slot: 'SUBDOMAIN', payloadB64: btoa(String.fromCharCode(...new TextEncoder().encode('acmé'))) },
      ],
    });
  });

  it('a refusal carries its status and a known code; an unknown code is dropped', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'connector-needs-sign-in', message: 'x' }), { status: 409 }),
    );
    const known = await failure(workspaceApi.attachConnector('a1', 'notion'));
    expect(known).toBeInstanceOf(AttachConnectorError);
    expect((known as AttachConnectorError).status).toBe(409);
    expect((known as AttachConnectorError).code).toBe('connector-needs-sign-in');

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: '<b>odd</b>' }), { status: 400 }));
    const unknown = await failure(workspaceApi.attachConnector('a1', 'notion'));
    expect((unknown as AttachConnectorError).status).toBe(400);
    expect((unknown as AttachConnectorError).code).toBeUndefined();

    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 503 }));
    const garbled = await failure(workspaceApi.attachConnector('a1', 'notion'));
    expect((garbled as AttachConnectorError).status).toBe(503);
    expect((garbled as AttachConnectorError).code).toBeUndefined();
  });

  it('a transport failure is status 0 and never carries the key; nothing logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new TypeError(`Failed to fetch ${SECRET}`));
    const e = await failure(workspaceApi.attachConnector('a1', 'zendesk', [{ slot: 'token', payload: SECRET }]));
    expect(e).toBeInstanceOf(AttachConnectorError);
    expect((e as AttachConnectorError).status).toBe(0);
    expect(JSON.stringify(e)).not.toContain(SECRET);
    expect(String((e as Error).message)).not.toContain(SECRET);
    for (const spy of [warn, log, error]) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
      expect(JSON.stringify(spy.mock.calls)).not.toContain(btoa(SECRET));
    }
  });
});
