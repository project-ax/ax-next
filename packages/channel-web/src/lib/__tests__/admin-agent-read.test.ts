import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAdminAgent } from '../admin';
import { HttpError } from '../http';
import { getSessionExpired, sessionExpiredActions } from '../session-expired-store';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
afterEach(() => {
  fetchMock.mockReset();
  sessionExpiredActions.reset();
});

describe('getAdminAgent', () => {
  // The sharing section tells "gone" (no Try again) from "try again" by the status.
  it.each([404, 500])('a %i throws an HttpError carrying the status', async (status) => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'x' }), { status }));
    const err = await getAdminAgent('agt_fern').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(status);
  });

  // Routed through httpFetch: a 401 ends the session like every other post-boot read.
  it('a 401 trips the session-expired latch', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }));
    const err = await getAdminAgent('agt_fern').catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(401);
    expect(getSessionExpired()).toBe(true);
  });
});
