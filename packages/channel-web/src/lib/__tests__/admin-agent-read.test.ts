import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAdminAgent } from '../admin';
import { HttpError } from '../http';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
afterEach(() => fetchMock.mockReset());

describe('getAdminAgent', () => {
  // The sharing section tells "gone" (no Try again) from "try again" by the status.
  it.each([404, 500])('a %i throws an HttpError carrying the status', async (status) => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'x' }), { status }));
    const err = await getAdminAgent('agt_fern').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(status);
  });
});
