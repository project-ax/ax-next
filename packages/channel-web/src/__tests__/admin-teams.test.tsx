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
import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AdminTeamWire } from '@ax/teams';
import { TeamList } from '../components/admin/TeamList';
import { freezeClock, thawClock } from '@/test-utils/time';

const fetchMock = vi.fn();

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  freezeClock();
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  // Default: empty response for any background fetches.
  fetchMock.mockImplementation(() =>
    Promise.resolve(jsonOk({ providers: [], agents: [], teams: [], servers: [] })),
  );
});

afterEach(() => thawClock());

describe('AdminSettings — Teams tab', () => {
  it('lists the caller\'s teams by their displayName (read-only)', async () => {
    // TASK-571: this fixture is the REAL route's shape, typed by the route's
    // own exported wire type — `@ax/teams` serializeTeam sends
    // `{ id, displayName, createdBy, createdAt }` and nothing else. The old
    // fixture here was `{ name, members }`, a shape no server ever sent, so
    // this test passed while the real Teams page showed a blank title and
    // then threw on `members.length`.
    const team: AdminTeamWire = {
      id: 'team_1',
      displayName: 'Engineering',
      createdBy: 'u1',
      createdAt: '2026-09-01T12:00:00.000Z',
    };
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValueOnce(jsonOk({ teams: [team] }));

    render(<TeamList />);
    await waitFor(() => expect(screen.getByText('Engineering')).toBeTruthy());
    // The list route carries no member list, so the card must not pretend to
    // count one.
    expect(screen.queryByText(/members?\b/i)).toBeNull();
    // Created 2026-09-01T12:00Z, read at the frozen "now" (Nov 26): a plain date, in the reader's own zone.
    expect(screen.getByText(`Created ${new Date('2026-09-01T12:00:00.000Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`)).toBeTruthy();
  });

  it('shows the deferred-feature note', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValueOnce(jsonOk({ teams: [] }));

    render(<TeamList />);
    await waitFor(() =>
      expect(screen.getByText(/Teams are view-only for now/i)).toBeTruthy(),
    );
    // (TASK-343/D6) Neither a path into our own repo nor our internal milestone
    // vocabulary belongs on a screen an operator reads. Both named things the
    // reader has no way to look up and no reason to care about.
    expect(screen.queryByText(/docs\/plans/)).toBeNull();
    expect(screen.queryByText(/Week 9\.5/i)).toBeNull();
  });

  it('handles error', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));

    render(<TeamList />);
    await waitFor(() =>
      expect(screen.getByText(/list teams/i)).toBeTruthy(),
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/list teams/i);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('Try again re-reads the list', async () => {
    const team: AdminTeamWire = {
      id: 'team_1',
      displayName: 'Engineering',
      createdBy: 'u1',
      createdAt: '2026-09-01T12:00:00.000Z',
    };
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    fetchMock.mockResolvedValueOnce(jsonOk({ teams: [team] }));

    render(<TeamList />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Engineering')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('announces the load as a busy status, then says there are no teams yet', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValueOnce(jsonOk({ teams: [] }));

    render(<TeamList />);
    const loading = screen.getByRole('status');
    expect(loading).toHaveAttribute('aria-busy', 'true');
    expect(loading).toHaveTextContent('Loading teams…');
    expect(await screen.findByText('No teams yet')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
