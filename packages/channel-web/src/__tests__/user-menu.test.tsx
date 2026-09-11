import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent, within } from '@testing-library/react';
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

/**
 * TASK-338 — the menu is a Radix `DropdownMenu` now, and Radix triggers open on
 * **pointerdown**, not click. A `fireEvent.click` here leaves the menu shut,
 * silently and with no error, and every assertion below then fails with
 * "unable to find" rather than anything that points at the cause.
 *
 * `test-setup.ts` already aliases `PointerEvent` → `MouseEvent` for jsdom, so
 * `pointerDown` is all that is needed. `@testing-library/user-event` is not a
 * dependency of this package.
 */
const openMenu = (name: RegExp) =>
  fireEvent.pointerDown(screen.getByRole('button', { name }), {
    button: 0,
    ctrlKey: false,
  });

describe('UserMenu', () => {
  it('admin sees a single "Settings" entry when menu is open', () => {
    render(
      <UserProvider value={adminUser}>
        <UserMenu />
      </UserProvider>,
    );
    openMenu(/Admin/i);
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
    openMenu(/Alice/i);
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
    openMenu(/Admin/i);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }));
    expect(onOpenAdminSettings).toHaveBeenCalledTimes(1);
  });

  it('regular user DOES see the Settings entry (TASK-42 — user Settings surface)', () => {
    render(
      <UserProvider value={regularUser}>
        <UserMenu />
      </UserProvider>,
    );
    openMenu(/Alice/i);
    // Every user can now open Settings; admin-only TABS are gated in-shell.
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toBeTruthy();
    expect(screen.queryByText('Admin Settings')).toBeNull();
  });

  it('no longer shows a "Routines" menuitem (moved into the Settings tab)', () => {
    render(
      <UserProvider value={regularUser}>
        <UserMenu />
      </UserProvider>,
    );
    openMenu(/Alice/i);
    expect(screen.queryByRole('menuitem', { name: 'Routines' })).toBeNull();
    // Settings is still present — Routines lives inside it now.
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toBeTruthy();
  });

  it('theme toggle offers Light, Dark, and System (TASK-119 — tri-toggle matches the auto-capable provider)', () => {
    render(
      <UserProvider value={regularUser}>
        <UserMenu />
      </UserProvider>,
    );
    openMenu(/Alice/i);
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
    openMenu(/Alice/i);
    const group = screen.getByRole('radiogroup', { name: 'Theme' });
    // Pin dark first so there is something to clear.
    fireEvent.click(within(group).getByRole('radio', { name: 'Dark' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    fireEvent.click(within(group).getByRole('radio', { name: 'System' }));
    // 'auto' removes the attribute entirely so prefers-color-scheme takes over.
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
  });

  it('outside click closes the menu', async () => {
    render(
      <div>
        <UserProvider value={regularUser}>
          <UserMenu />
        </UserProvider>
        <button data-testid="outside">outside</button>
      </div>,
    );
    openMenu(/Alice/i);
    expect(screen.getByText('Sign out')).toBeTruthy();

    // Radix attaches its outside-pointerdown listener on a `setTimeout(0)`, so
    // that the very pointerdown which OPENED the menu cannot immediately close
    // it again. Without this tick the dismissal silently never happens.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    fireEvent.pointerDown(screen.getByTestId('outside'), { button: 0 });
    expect(screen.queryByText('Sign out')).toBeNull();
  });

  /**
   * TASK-338 / audit C4 — this is the behaviour the hand-rolled popover never
   * had. It listened for `mousedown` on `document` and nothing else, so Escape
   * did nothing and the menu could only be dismissed by clicking away. Getting
   * it from the primitive is the entire point of the swap.
   */
  it('closes on Escape, which the hand-rolled popover never did', () => {
    render(
      <UserProvider value={regularUser}>
        <UserMenu />
      </UserProvider>,
    );
    openMenu(/Alice/i);
    expect(screen.getByText('Sign out')).toBeTruthy();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByText('Sign out')).toBeNull();
  });

  it('labels each theme option in words, not just an icon', () => {
    render(
      <UserProvider value={regularUser}>
        <UserMenu />
      </UserProvider>,
    );
    openMenu(/Alice/i);
    const group = screen.getByRole('radiogroup', { name: 'Theme' });
    // Visible text, not a `title` attribute a mouse user has to hover to find
    // — "System" in particular is not guessable from a rectangle icon.
    for (const label of ['Light', 'Dark', 'System']) {
      expect(within(group).getByText(label)).toBeTruthy();
    }
  });
});
