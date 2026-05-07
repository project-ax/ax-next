import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UserMenu } from '../components/UserMenu';
import { UserProvider } from '../lib/user-context';

const adminUser = {
  id: 'u1',
  email: 'admin@local',
  name: 'Admin',
  role: 'admin' as const,
};
const regularUser = {
  id: 'u2',
  email: 'alice@local',
  name: 'Alice',
  role: 'user' as const,
};

describe('UserMenu', () => {
  it('admin sees single "Admin Settings" entry when menu is open', () => {
    render(
      <UserProvider value={adminUser}>
        <UserMenu />
      </UserProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Admin/i }));
    expect(screen.getByText('Admin Settings')).toBeTruthy();
    // Old per-view entries must be gone.
    expect(screen.queryByText(/Admin · Agents/)).toBeNull();
    expect(screen.queryByText(/Admin · MCP Servers/)).toBeNull();
    expect(screen.queryByText(/Admin · Teams/)).toBeNull();
    expect(screen.queryByText(/Admin · Credentials/)).toBeNull();
  });

  it('"Admin Settings" entry calls onOpenAdminSettings', () => {
    const onOpenAdminSettings = vi.fn();
    render(
      <UserProvider value={adminUser}>
        <UserMenu onOpenAdminSettings={onOpenAdminSettings} />
      </UserProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Admin/i }));
    fireEvent.click(screen.getByText('Admin Settings'));
    expect(onOpenAdminSettings).toHaveBeenCalledTimes(1);
  });

  it('regular user does not see admin entries', () => {
    render(
      <UserProvider value={regularUser}>
        <UserMenu />
      </UserProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Alice/i }));
    expect(screen.queryByText('Admin Settings')).toBeNull();
  });

  it('regular user sees "My credentials" entry', () => {
    render(
      <UserProvider value={regularUser}>
        <UserMenu />
      </UserProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Alice/i }));
    expect(screen.getByText(/My credentials/i)).toBeTruthy();
  });

  it('"My credentials" entry calls onOpenSettings', () => {
    const onOpenSettings = vi.fn();
    render(
      <UserProvider value={regularUser}>
        <UserMenu onOpenSettings={onOpenSettings} />
      </UserProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Alice/i }));
    fireEvent.click(screen.getByText(/My credentials/i));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it('outside click closes the menu', () => {
    render(
      <div>
        <UserProvider value={regularUser}>
          <UserMenu />
        </UserProvider>
        <button data-testid="outside">outside</button>
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Alice/i }));
    expect(screen.getByText('Sign out')).toBeTruthy();
    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(screen.queryByText('Sign out')).toBeNull();
  });
});
