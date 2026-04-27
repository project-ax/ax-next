/**
 * Admin canary-deferred banner — Task 22 of the Week 10–12 plan.
 *
 * MVP ships without `@ax/scanner-canary` (per scope decision 7). The banner
 * is the operator-visible reminder until Week 13+ wires the scanner in.
 * The copy is locked by the plan; we assert key fragments are present so a
 * future copy edit fails this test loudly.
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
  // Every admin view fires at least one initial fetch on mount; return an
  // empty list so the panel settles without errors.
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ agents: [], servers: [], teams: [] }),
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

describe('AdminPanel — canary-deferred banner', () => {
  it('renders the canary warning on the agents view', async () => {
    render(
      <UserProvider value={adminUser}>
        <AdminPanel view="agents" onClose={() => {}} />
      </UserProvider>,
    );
    // Wait for the panel to mount and any initial fetch to settle.
    await waitFor(() => screen.getByText(/canary scanner/i));
    expect(screen.getByText(/canary scanner isn't wired in yet/i)).toBeTruthy();
    expect(
      screen.getByText(/no automated secret-leak veto/i),
    ).toBeTruthy();
    expect(screen.getByText(/no LLM-output redaction/i)).toBeTruthy();
    expect(screen.getByText(/Tracked for Week 13\+/i)).toBeTruthy();
  });

  it('renders the canary warning on the mcp-servers view', async () => {
    render(
      <UserProvider value={adminUser}>
        <AdminPanel view="mcp-servers" onClose={() => {}} />
      </UserProvider>,
    );
    await waitFor(() => screen.getByText(/canary scanner/i));
    expect(screen.getByText(/canary scanner isn't wired in yet/i)).toBeTruthy();
  });

  it('renders the canary warning on the teams view', async () => {
    render(
      <UserProvider value={adminUser}>
        <AdminPanel view="teams" onClose={() => {}} />
      </UserProvider>,
    );
    await waitFor(() => screen.getByText(/canary scanner/i));
    expect(screen.getByText(/canary scanner isn't wired in yet/i)).toBeTruthy();
  });
});
