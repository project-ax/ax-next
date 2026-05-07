/**
 * SettingsPanel — My credentials (Task 5.1).
 *
 * Asserts the wiring that makes the user-facing "My credentials" panel
 * reachable from the running UI in the same PR (no half-wired
 * components):
 *
 *   1. Opening SettingsPanel renders the "My credentials" header and
 *      mounts CredentialsList in 'user' variant — the list calls
 *      /settings/credentials.
 *   2. The Add menu is mounted alongside.
 *   3. Closed state renders nothing (open=false → null).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { SettingsPanel } from '../components/settings/SettingsPanel';
import { UserProvider } from '../lib/user-context';

const fetchMock = vi.fn();

const regularUser = {
  id: 'u2',
  email: 'alice@local',
  name: 'Alice',
  role: 'user' as const,
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

describe('SettingsPanel — my credentials', () => {
  it('renders the "My credentials" heading and lists user credentials', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonOk({
        credentials: [
          {
            scope: 'user',
            ownerId: 'u2',
            ref: 'my-anthropic',
            kind: 'api-key',
            createdAt: '2026-05-07T00:00:00.000Z',
          },
        ],
      }),
    );
    render(
      <UserProvider value={regularUser}>
        <SettingsPanel open={true} onClose={() => {}} />
      </UserProvider>,
    );
    expect(screen.getByText(/My credentials/i)).toBeTruthy();
    await waitFor(() => expect(screen.getByText('my-anthropic')).toBeTruthy());
    // The user variant talks to /settings/credentials, not /admin/credentials.
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/settings/credentials');
  });

  it('mounts the Add menu (user variant)', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ credentials: [] }));
    render(
      <UserProvider value={regularUser}>
        <SettingsPanel open={true} onClose={() => {}} />
      </UserProvider>,
    );
    expect(
      screen.getByRole('button', { name: /add credential/i }),
    ).toBeTruthy();
  });

  it('renders nothing when open=false', () => {
    const { container } = render(
      <UserProvider value={regularUser}>
        <SettingsPanel open={false} onClose={() => {}} />
      </UserProvider>,
    );
    expect(container.firstChild).toBeNull();
  });
});
