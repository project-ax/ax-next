/**
 * Wire-client tests for `lib/routines.ts` — Phase D Task 11.
 *
 * Mirrors the shape the server contracts in `@ax/routines-admin-routes`:
 *   - GET    /settings/routines                      → { routines: [...] }
 *   - GET    /settings/routines/:agentId/fires?path= → { fires: [...] }
 *   - POST   /settings/routines/:agentId/fire        → { fireId, status, conversationId }
 *
 * Pinned behaviors (the assertions are a contract):
 *   - `list()` hydrates server-supplied `lastRunAt: string | null` to Date.
 *   - `recentFires()` URL-encodes the agentId path segment.
 *   - `fireNow()` POSTs JSON; payload field is omitted when not provided.
 *   - Errors surface the server's `{ error: { message } }` body.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { routines } from '../lib/routines';

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;
afterEach(() => fetchMock.mockReset());

function mockJson(status: number, body: unknown): void {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

describe('lib/routines', () => {
  it('list hydrates lastRunAt to Date', async () => {
    mockJson(200, {
      routines: [
        {
          agentId: 'agt_a',
          path: 'p',
          name: 'r',
          description: 'd',
          trigger: { kind: 'interval', every: '24h' },
          conversation: 'shared',
          lastStatus: 'ok',
          lastError: null,
          lastRunAt: '2026-05-17T00:00:00.000Z',
        },
      ],
    });
    const out = await routines.list();
    expect(out[0]!.lastRunAt instanceof Date).toBe(true);
  });

  it('list keeps a null lastRunAt as null (never fired)', async () => {
    mockJson(200, {
      routines: [
        {
          agentId: 'agt_a',
          path: 'p',
          name: 'r',
          description: 'd',
          trigger: { kind: 'interval', every: '24h' },
          conversation: 'shared',
          lastStatus: null,
          lastError: null,
          lastRunAt: null,
        },
      ],
    });
    const out = await routines.list();
    expect(out[0]!.lastRunAt).toBeNull();
  });

  it('recentFires URL-encodes the agentId', async () => {
    mockJson(200, { fires: [] });
    await routines.recentFires({ agentId: 'agt:with/slash', path: 'p' });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('agt%3Awith%2Fslash');
  });

  it('recentFires sets the limit query param when provided', async () => {
    mockJson(200, { fires: [] });
    await routines.recentFires({ agentId: 'a', path: 'p', limit: 20 });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('limit=20');
  });

  it('recentFires hydrates firedAt to Date', async () => {
    mockJson(200, {
      fires: [
        {
          id: 1,
          agentId: 'a',
          path: 'p',
          firedAt: '2026-05-17T01:23:45.000Z',
          triggerSource: 'manual',
          status: 'ok',
          error: null,
          conversationId: 'cnv',
          renderedPrompt: 'hello',
        },
      ],
    });
    const out = await routines.recentFires({ agentId: 'a', path: 'p' });
    expect(out[0]!.firedAt instanceof Date).toBe(true);
  });

  it('fireNow posts payload when provided', async () => {
    mockJson(200, { fireId: 1, status: 'ok', conversationId: 'cnv' });
    await routines.fireNow({ agentId: 'a', path: 'p', payload: { x: 1 } });
    const body = JSON.parse(
      fetchMock.mock.calls[0]![1]!.body as string,
    ) as { payload?: unknown };
    expect(body.payload).toEqual({ x: 1 });
  });

  it('fireNow omits payload when undefined', async () => {
    mockJson(200, { fireId: 2, status: 'ok', conversationId: null });
    await routines.fireNow({ agentId: 'a', path: 'p' });
    const body = JSON.parse(
      fetchMock.mock.calls[0]![1]!.body as string,
    ) as Record<string, unknown>;
    expect('payload' in body).toBe(false);
    expect(body.path).toBe('p');
  });

  it('surfaces server error message', async () => {
    mockJson(403, { error: { message: 'forbidden' } });
    await expect(routines.list()).rejects.toThrow('forbidden');
  });

  it('falls back to HTTP <status> when error body is unparseable', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json');
      },
    } as unknown as Response);
    await expect(routines.list()).rejects.toThrow('HTTP 500');
  });
});
