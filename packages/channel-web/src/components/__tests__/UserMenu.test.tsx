import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { AuthUser } from '../../lib/auth';

// Mock the user-context module so we can drive role. Hoisted by vitest.
const userRef: { current: AuthUser } = {
  current: { id: 'u1', email: 'u@x.com', name: 'Uma', role: 'user' },
};
vi.mock('../../lib/user-context', () => ({
  useUser: () => userRef.current,
}));
// Theme + auth are touched on render — stub to keep the test hermetic.
vi.mock('../../lib/theme', () => ({
  useTheme: () => 'light',
  setTheme: vi.fn(),
}));
vi.mock('../../lib/auth', () => ({ signOut: vi.fn() }));

import { UserMenu } from '../UserMenu';
import { SETTINGS_OPENER_ATTR } from '../../lib/settings-return-focus';

describe('UserMenu Settings entry (TASK-42)', () => {
  beforeEach(() => {
    userRef.current = { id: 'u1', email: 'u@x.com', name: 'Uma', role: 'user' };
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows the Settings entry to NON-admin users', () => {
    const onOpen = vi.fn();
    render(<UserMenu onOpenAdminSettings={onOpen} />);
    // Open the popover (the avatar/user row button).
    fireEvent.pointerDown(screen.getByRole('button', { name: /Uma/ }), { button: 0, ctrlKey: false });
    const settings = screen.getByText('Settings');
    expect(settings).toBeInTheDocument();
    fireEvent.click(settings);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('still shows Settings to admins', () => {
    userRef.current = { id: 'u1', email: 'u@x.com', name: 'Uma', role: 'admin' };
    render(<UserMenu onOpenAdminSettings={vi.fn()} />);
    fireEvent.pointerDown(screen.getByRole('button', { name: /Uma/ }), { button: 0, ctrlKey: false });
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });
});

/**
 * TASK-443 — this trigger is the address focus comes back to when the Settings
 * pane closes.
 *
 * Settings is a pane swap, so the node a person clicked is destroyed while
 * they are in there; the restore finds this control's SUCCESSOR by attribute
 * instead (`lib/settings-return-focus.ts`). That makes the attribute a
 * contract between two files, and worth pinning on this side of it too.
 */
describe('UserMenu as the Settings opener (TASK-443)', () => {
  beforeEach(() => {
    userRef.current = { id: 'u1', email: 'u@x.com', name: 'Uma', role: 'user' };
  });
  afterEach(() => vi.restoreAllMocks());

  it('marks the trigger when the menu can really open Settings', () => {
    render(<UserMenu onOpenAdminSettings={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: /Uma/ });
    expect(trigger.hasAttribute(SETTINGS_OPENER_ATTR)).toBe(true);
  });

  it('does not mark a menu whose Settings entry goes nowhere', () => {
    // `UserMenu` renders the entry unconditionally and calls
    // `onOpenAdminSettings?.()` — that was TASK-340's dead control. Marking a
    // trigger here would hand the keyboard to a door that does not open.
    render(<UserMenu />);
    const trigger = screen.getByRole('button', { name: /Uma/ });
    expect(trigger.hasAttribute(SETTINGS_OPENER_ATTR)).toBe(false);
  });

  it('marks exactly one node, because the restore takes the first match', () => {
    render(<UserMenu onOpenAdminSettings={vi.fn()} />);
    expect(
      document.querySelectorAll('[' + SETTINGS_OPENER_ATTR + ']'),
    ).toHaveLength(1);
  });
});
