import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AdminShell } from '../AdminShell';
import { UserProvider } from '../../../lib/user-context';
import type { AuthUser } from '../../../lib/auth';

// ProvidersPanel and ModelConfigTab fetch on mount — stub to avoid leaking
// unhandled promise rejections.
const fetchMock = vi.fn();
function emptyResponse(url: string): Response {
  // ProvidersPanel (default tab) calls adminCredentials.list() which hits
  // /admin/credentials (no trailing path) and expects { credentials: [] }.
  // ModelConfigTab calls listProviders() → /admin/credentials/providers → { providers: [] }.
  if (/\/admin\/credentials(\?|$)/.test(url) || /\/settings\/credentials(\?|$)/.test(url)) {
    return new Response(JSON.stringify({ credentials: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  // ConnectionsTab (the default tab) calls listChatAgents() → /api/chat/agents,
  // which returns a bare array. An empty list is enough for the nav assertions.
  if (/\/api\/chat\/agents(\?|$)/.test(url)) {
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ providers: [], agents: [], teams: [], servers: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockImplementation((input: RequestInfo | URL) =>
    Promise.resolve(emptyResponse(String(input))),
  );
});

const fakeUser: AuthUser = {
  id: 'u1',
  email: 'ana@example.co',
  name: 'Ana K.',
  role: 'admin',
};

function renderShell(onClose = vi.fn(), isAdmin = true) {
  return render(
    <UserProvider value={fakeUser}>
      <AdminShell isAdmin={isAdmin} onClose={onClose} />
    </UserProvider>,
  );
}

describe('AdminShell', () => {
  it('renders the admin nav items plus the user tabs, with Connections active by default', () => {
    renderShell();
    // Scope to nav buttons — "Connections" also appears in the pane header.
    expect(screen.getByRole('button', { name: 'Connections' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keys' })).toBeTruthy();
    // Admin tabs (Admin section) — present for admins.
    expect(screen.getByRole('button', { name: 'Providers' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Model config' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Agents' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'MCP servers' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Teams' })).toBeTruthy();
    // Connections is the default active tab for everyone.
    expect(
      screen.getByRole('button', { name: 'Connections' }).getAttribute('data-active'),
    ).toBeTruthy();
  });

  it('hides admin tabs when isAdmin is false', () => {
    renderShell(vi.fn(), false);
    expect(screen.getByRole('button', { name: 'Connections' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Providers' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Teams' })).toBeNull();
  });

  it('clicking Model config makes it the active tab', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Model config' }));
    expect(
      screen.getByRole('button', { name: 'Model config' }).getAttribute('data-active'),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Connections' }).getAttribute('data-active'),
    ).toBeNull();
  });

  it('clicking ← chat calls onClose', () => {
    const onClose = vi.fn();
    renderShell(onClose);
    fireEvent.click(screen.getByRole('button', { name: /chat/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
