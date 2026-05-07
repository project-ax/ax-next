/**
 * AdminPanel — Credentials view (Task 4.4).
 *
 * Asserts the wiring that makes the Credentials tab reachable from the
 * running UI in the same PR (no half-wired components):
 *
 *   1. Opening AdminPanel with view='credentials' renders the
 *      CredentialsList (admin variant) — the list calls /admin/credentials.
 *   2. The Add menu is mounted alongside — clicking it triggers a
 *      /admin/credentials/kinds round-trip.
 *   3. The panel chrome shows the "Credentials" title.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import { AdminPanel } from '../components/admin/AdminPanel';
import { UserProvider } from '../lib/user-context';

const fetchMock = vi.fn();

const adminUser = {
  id: 'u1',
  email: 'admin@local',
  name: 'Admin',
  role: 'admin' as const,
};

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('AdminPanel — credentials', () => {
  it('renders the credentials title and lists existing credentials', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonOk({
        credentials: [
          {
            scope: 'global',
            ownerId: null,
            ref: 'anthropic',
            kind: 'api-key',
            createdAt: '2026-05-07T00:00:00.000Z',
          },
        ],
      }),
    );
    render(
      <UserProvider value={adminUser}>
        <AdminPanel view="credentials" onClose={() => {}} />
      </UserProvider>,
    );
    expect(screen.getByText(/Admin · Credentials/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText('anthropic')).toBeTruthy());
  });

  it('mounts the Add menu — clicking triggers /admin/credentials/kinds', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonOk({ credentials: [] }))
      .mockResolvedValueOnce(
        jsonOk({ kinds: [{ kind: 'api-key', flow: 'paste' }] }),
      );
    render(
      <UserProvider value={adminUser}>
        <AdminPanel view="credentials" onClose={() => {}} />
      </UserProvider>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /add credential/i }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => c[0] === '/admin/credentials/kinds')).toBe(
        true,
      ),
    );
  });
});
