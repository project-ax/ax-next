import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
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
    // Standalone Credentials entry removed (now lives inside admin Settings).
    expect(screen.queryByRole('menuitem', { name: 'Credentials' })).toBeNull();
    // TASK-110 — the redundant "My Skills" modal entry is retired; the Skills
    // settings tab is the sole entry.
    expect(screen.queryByRole('menuitem', { name: 'My Skills' })).toBeNull();
  });

  it('does NOT show a "My Skills" entry (retired in TASK-110)', () => {
    render(
      <UserProvider value={regularUser}>
        <UserMenu />
      </UserProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Alice/i }));
    // The modal entry is gone for every user — the Skills settings tab is the
    // single surface now (its content lived in the shared body that backed both
    // the old modal and the tab, so removing the modal entry lost nothing).
    expect(screen.queryByRole('menuitem', { name: 'My Skills' })).toBeNull();
    expect(screen.queryByText('My Skills')).toBeNull();
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

  it('regular user DOES see the Settings entry (TASK-42 — user Settings surface)', () => {
    render(
      <UserProvider value={regularUser}>
        <UserMenu />
      </UserProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Alice/i }));
    // Every user can now open Settings; admin-only TABS are gated in-shell.
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toBeTruthy();
    expect(screen.queryByText('Admin Settings')).toBeNull();
  });

  it('"Routines" menuitem is visible to regular users', () => {
    render(
      <UserProvider value={regularUser}>
        <UserMenu />
      </UserProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Alice/i }));
    expect(screen.getByRole('menuitem', { name: 'Routines' })).toBeTruthy();
  });

  it('"Routines" menuitem is visible to admin users', () => {
    render(
      <UserProvider value={adminUser}>
        <UserMenu />
      </UserProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Admin/i }));
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

  it('theme toggle offers Light, Dark, and System (TASK-119 — tri-toggle matches the auto-capable provider)', () => {
    render(
      <UserProvider value={regularUser}>
        <UserMenu />
      </UserProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Alice/i }));
    const group = screen.getByRole('radiogroup', { name: 'Theme' });
    // Three options, one per Theme mode the provider supports ('light' | 'dark' | 'auto').
    expect(within(group).getByRole('radio', { name: 'Light' })).toBeTruthy();
    expect(within(group).getByRole('radio', { name: 'Dark' })).toBeTruthy();
    expect(within(group).getByRole('radio', { name: 'System' })).toBeTruthy();
    expect(within(group).getAllByRole('radio')).toHaveLength(3);
  });

  it('selecting System clears the persisted theme (provider auto mode)', () => {
    render(
      <UserProvider value={regularUser}>
        <UserMenu />
      </UserProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Alice/i }));
    const group = screen.getByRole('radiogroup', { name: 'Theme' });
    // Pin dark first so there is something to clear.
    fireEvent.click(within(group).getByRole('radio', { name: 'Dark' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    fireEvent.click(within(group).getByRole('radio', { name: 'System' }));
    // 'auto' removes the attribute entirely so prefers-color-scheme takes over.
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
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
