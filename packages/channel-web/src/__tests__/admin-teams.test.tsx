/**
 * Admin teams placeholder — Task 24.
 *
 * The teams view is deliberately read-only for now. Team management (create,
 * invite, membership) lands with the Week 9.5 multi-tenant slice. This test
 * just pins three things:
 *
 *   - The placeholder still hits `GET /api/admin/teams` so we know the wire
 *     is alive.
 *   - The deferred-feature note is visible (so a curious admin doesn't think
 *     the panel is broken).
 *   - The shared error path renders when the API trips.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AdminPanel } from '../components/admin/AdminPanel';
import { UserProvider } from '../lib/user-context';

const adminUser = {
  id: 'u1',
  email: 'admin@local',
  name: 'Admin',
  role: 'admin' as const,
};
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

describe('AdminPanel — Teams', () => {
  it('lists seeded teams (read-only)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        teams: [{ id: 't1', name: 'Engineering', members: ['u1', 'u2'] }],
      }),
    });
    render(
      <UserProvider value={adminUser}>
        <AdminPanel view="teams" onClose={() => {}} />
      </UserProvider>,
    );
    await waitFor(() => expect(screen.getByText('Engineering')).toBeTruthy());
    expect(screen.getByText('2 members')).toBeTruthy();
  });

  it('shows the deferred-feature note', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ teams: [] }),
    });
    render(
      <UserProvider value={adminUser}>
        <AdminPanel view="teams" onClose={() => {}} />
      </UserProvider>,
    );
    await waitFor(() => expect(screen.getByText(/Read-only/i)).toBeTruthy());
    expect(screen.getByText(/Week 9\.5/i)).toBeTruthy();
  });

  it('handles error', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    render(
      <UserProvider value={adminUser}>
        <AdminPanel view="teams" onClose={() => {}} />
      </UserProvider>,
    );
    await waitFor(() =>
      expect(screen.getByText(/list teams/i)).toBeTruthy(),
    );
  });
});
