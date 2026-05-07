/**
 * Admin teams placeholder — Task 24.
 *
 * The teams view is deliberately read-only for now. Team management (create,
 * invite, membership) lands with the Week 9.5 multi-tenant slice. This test
 * just pins three things:
 *
 *   - The placeholder still hits `GET /admin/teams` so we know the wire
 *     is alive.
 *   - The deferred-feature note is visible (so a curious admin doesn't think
 *     the panel is broken).
 *   - The shared error path renders when the API trips.
 *
 * Updated to use AdminSettings shell (renders via the Teams tab) after
 * AdminPanel was removed in Task 5 of the Admin Settings Redesign.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AdminSettings } from '../components/admin/AdminSettings';

const fetchMock = vi.fn();

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  // Default: providers empty for the initial ProviderKeysTab load.
  fetchMock.mockImplementation(() =>
    Promise.resolve(jsonOk({ providers: [], agents: [], teams: [], servers: [] })),
  );
});

describe('AdminSettings — Teams tab', () => {
  it('lists seeded teams (read-only)', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValueOnce(jsonOk({ providers: [] }));
    fetchMock.mockResolvedValueOnce(
      jsonOk({ teams: [{ id: 't1', name: 'Engineering', members: ['u1', 'u2'] }] }),
    );

    render(<AdminSettings onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: /^Teams$/i }));
    await waitFor(() => expect(screen.getByText('Engineering')).toBeTruthy());
    expect(screen.getByText('2 members')).toBeTruthy();
  });

  it('shows the deferred-feature note', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValueOnce(jsonOk({ providers: [] }));
    fetchMock.mockResolvedValueOnce(jsonOk({ teams: [] }));

    render(<AdminSettings onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: /^Teams$/i }));
    await waitFor(() => expect(screen.getByText(/Read-only/i)).toBeTruthy());
    expect(screen.getByText(/Week 9\.5/i)).toBeTruthy();
  });

  it('handles error', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValueOnce(jsonOk({ providers: [] }));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));

    render(<AdminSettings onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: /^Teams$/i }));
    await waitFor(() =>
      expect(screen.getByText(/list teams/i)).toBeTruthy(),
    );
  });
});
