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
  it('admin sees a single "Settings" entry when menu is open', () => {
    render(
      <UserProvider value={adminUser}>
        <UserMenu />
      </UserProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Admin/i }));
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toBeTruthy();
    // Removed entries must be gone.
    expect(screen.queryByText('Admin Settings')).toBeNull();
    expect(screen.queryByText(/Account & billing/i)).toBeNull();
    // Old per-view entries must be gone.
    expect(screen.queryByText(/Admin · Agents/)).toBeNull();
    expect(screen.queryByText(/Admin · MCP Servers/)).toBeNull();
    expect(screen.queryByText(/Admin · Teams/)).toBeNull();
    expect(screen.queryByText(/Admin · Credentials/)).toBeNull();
  });

  it('"Settings" entry calls onOpenAdminSettings', () => {
    const onOpenAdminSettings = vi.fn();
    render(
      <UserProvider value={adminUser}>
        <UserMenu onOpenAdminSettings={onOpenAdminSettings} />
      </UserProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Admin/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }));
    expect(onOpenAdminSettings).toHaveBeenCalledTimes(1);
  });

  it('regular user does not see the Settings entry', () => {
    render(
      <UserProvider value={regularUser}>
        <UserMenu />
      </UserProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Alice/i }));
    expect(screen.queryByRole('menuitem', { name: 'Settings' })).toBeNull();
    expect(screen.queryByText('Admin Settings')).toBeNull();
  });

  it('regular user sees "Credentials" entry', () => {
    render(
      <UserProvider value={regularUser}>
        <UserMenu />
      </UserProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Alice/i }));
    expect(screen.getByRole('menuitem', { name: 'Credentials' })).toBeTruthy();
  });

  it('"Credentials" entry calls onOpenSettings', () => {
    const onOpenSettings = vi.fn();
    render(
      <UserProvider value={regularUser}>
        <UserMenu onOpenSettings={onOpenSettings} />
      </UserProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Alice/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Credentials' }));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it('"Routines" menuitem is visible to all users', () => {
    render(
      <UserProvider value={regularUser}>
        <UserMenu />
      </UserProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Alice/i }));
    expect(screen.getByRole('menuitem', { name: 'Routines' })).toBeTruthy();
  });

  it('"Routines" menuitem calls onOpenRoutines', () => {
    const onOpenRoutines = vi.fn();
    render(
      <UserProvider value={regularUser}>
        <UserMenu onOpenRoutines={onOpenRoutines} />
      </UserProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Alice/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Routines' }));
    expect(onOpenRoutines).toHaveBeenCalledTimes(1);
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
