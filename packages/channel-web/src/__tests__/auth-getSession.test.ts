/**
 * `getSession()` name-fallback contract.
 *
 * The backend's `User` type ships `displayName: string | null` and
 * `email: string | null`. In practice, both can also arrive as empty
 * strings (e.g., bootstrap admins minted with no body fields, or an
 * email like '@example.com' yielding an empty local-part). The UI
 * must NOT render a blank `name` — the avatar tile + user-menu row
 * derive from this string.
 *
 * Pinned behaviors:
 *   - non-empty displayName wins
 *   - empty displayName falls back to email's local-part
 *   - empty email local-part (e.g., '@example.com') falls back to a
 *     role-aware label
 *   - admin without identity → 'Administrator', non-admin → 'unnamed'
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getSession } from '../lib/auth';

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

function meOk(user: unknown): Response {
  return new Response(JSON.stringify({ user }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('getSession() — name-fallback contract', () => {
  it('non-empty displayName wins', async () => {
    fetchMock.mockResolvedValueOnce(
      meOk({ id: 'u1', email: 'a@b.c', displayName: 'Alice', isAdmin: false }),
    );
    const s = await getSession();
    expect(s?.user.name).toBe('Alice');
  });

  it('empty displayName falls back to email local-part', async () => {
    fetchMock.mockResolvedValueOnce(
      meOk({ id: 'u1', email: 'alice@example.com', displayName: '', isAdmin: false }),
    );
    const s = await getSession();
    expect(s?.user.name).toBe('alice');
  });

  it('whitespace-only displayName falls back to email local-part', async () => {
    fetchMock.mockResolvedValueOnce(
      meOk({ id: 'u1', email: 'alice@example.com', displayName: '   ', isAdmin: false }),
    );
    const s = await getSession();
    expect(s?.user.name).toBe('alice');
  });

  it('empty local-part (e.g., "@example.com") falls back to role label', async () => {
    fetchMock.mockResolvedValueOnce(
      meOk({ id: 'u1', email: '@example.com', displayName: null, isAdmin: true }),
    );
    const s = await getSession();
    expect(s?.user.name).toBe('Administrator');
  });

  it('admin with no identity → "Administrator"', async () => {
    fetchMock.mockResolvedValueOnce(
      meOk({ id: 'u1', email: null, displayName: null, isAdmin: true }),
    );
    const s = await getSession();
    expect(s?.user.name).toBe('Administrator');
  });

  it('non-admin with no identity → "unnamed"', async () => {
    fetchMock.mockResolvedValueOnce(
      meOk({ id: 'u1', email: null, displayName: null, isAdmin: false }),
    );
    const s = await getSession();
    expect(s?.user.name).toBe('unnamed');
  });
});
