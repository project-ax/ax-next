import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { AdminShell } from '../AdminShell';
import { UserProvider } from '../../../lib/user-context';
import type { AuthUser } from '../../../lib/auth';

// ProviderKeysTab and ModelConfigTab fetch on mount — stub to avoid leaking
// unhandled promise rejections.
const fetchMock = vi.fn();
function emptyResponse(): Response {
  return new Response(JSON.stringify({ providers: [], agents: [], teams: [], servers: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockImplementation(() => Promise.resolve(emptyResponse()));
});

const fakeUser: AuthUser = {
  id: 'u1',
  email: 'ana@example.co',
  name: 'Ana K.',
  role: 'admin',
};

function renderShell(onClose = vi.fn()) {
  return render(
    <UserProvider value={fakeUser}>
      <AdminShell onClose={onClose} />
    </UserProvider>,
  );
}

describe('AdminShell', () => {
  it('renders all 5 nav items with provider-keys active by default', () => {
    renderShell();
    const nav = screen.getByRole('list');
    expect(within(nav).getByText('Provider keys')).toBeTruthy();
    expect(within(nav).getByText('Model config')).toBeTruthy();
    expect(within(nav).getByText('Agents')).toBeTruthy();
    expect(within(nav).getByText('MCP servers')).toBeTruthy();
    expect(within(nav).getByText('Teams')).toBeTruthy();
    const active = within(nav).getByRole('button', { name: 'Provider keys' });
    expect(active.getAttribute('data-active')).toBeTruthy();
  });

  it('clicking Model config makes it the active tab', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Model config' }));
    const nav = screen.getByRole('list');
    expect(
      within(nav).getByRole('button', { name: 'Model config' }).getAttribute('data-active'),
    ).toBeTruthy();
    expect(
      within(nav).getByRole('button', { name: 'Provider keys' }).getAttribute('data-active'),
    ).toBeNull();
  });

  it('clicking ← chat calls onClose', () => {
    const onClose = vi.fn();
    renderShell(onClose);
    fireEvent.click(screen.getByRole('button', { name: /chat/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

});
