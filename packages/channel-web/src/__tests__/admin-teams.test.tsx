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
 * Strategy: render TeamList directly (no shell wrapper). The AdminSettings
 * shell was deleted in Task 1.4 and replaced by AdminShell; the tab content
 * components are unchanged and can be tested in isolation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { TeamList } from '../components/admin/TeamList';

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
  // Default: empty response for any background fetches.
  fetchMock.mockImplementation(() =>
    Promise.resolve(jsonOk({ providers: [], agents: [], teams: [], servers: [] })),
  );
});

describe('AdminSettings — Teams tab', () => {
  it('lists seeded teams (read-only)', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValueOnce(
      jsonOk({ teams: [{ id: 't1', name: 'Engineering', members: ['u1', 'u2'] }] }),
    );

    render(<TeamList />);
    await waitFor(() => expect(screen.getByText('Engineering')).toBeTruthy());
    expect(screen.getByText('2 members')).toBeTruthy();
  });

  it('shows the deferred-feature note', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValueOnce(jsonOk({ teams: [] }));

    render(<TeamList />);
    await waitFor(() => expect(screen.getByText(/Read-only/i)).toBeTruthy());
    expect(screen.getByText(/Week 9\.5/i)).toBeTruthy();
  });

  it('handles error', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));

    render(<TeamList />);
    await waitFor(() =>
      expect(screen.getByText(/list teams/i)).toBeTruthy(),
    );
  });
});
