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

describe('UserMenu Settings entry (TASK-42)', () => {
  beforeEach(() => {
    userRef.current = { id: 'u1', email: 'u@x.com', name: 'Uma', role: 'user' };
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows the Settings entry to NON-admin users', () => {
    const onOpen = vi.fn();
    render(<UserMenu onOpenAdminSettings={onOpen} />);
    // Open the popover (the avatar/user row button).
    fireEvent.click(screen.getByRole('button', { name: /Uma/ }));
    const settings = screen.getByText('Settings');
    expect(settings).toBeInTheDocument();
    fireEvent.click(settings);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('still shows Settings to admins', () => {
    userRef.current = { id: 'u1', email: 'u@x.com', name: 'Uma', role: 'admin' };
    render(<UserMenu onOpenAdminSettings={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Uma/ }));
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });
});
