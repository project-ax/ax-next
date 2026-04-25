import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Sidebar } from '../components/Sidebar';
import { UserProvider } from '../lib/user-context';

const testUser = {
  id: 'u1',
  email: 'alice@local',
  name: 'Alice',
  role: 'user' as const,
};

describe('Sidebar', () => {
  it('renders the Tide structure with all required class hooks', () => {
    const { container } = render(
      <UserProvider value={testUser}>
        <Sidebar />
      </UserProvider>,
    );
    const sidebar = screen.getByTestId('sidebar');
    expect(sidebar.tagName).toBe('ASIDE');
    expect(sidebar.className).toContain('sidebar');
    expect(container.querySelector('.brand-word')?.textContent).toBe('tide');
    expect(container.querySelector('.sidebar-collapse')).toBeTruthy();
    expect(container.querySelector('.new-session-btn')).toBeTruthy();
    expect(container.querySelector('.sessions-scroll')).toBeTruthy();
    expect(container.querySelector('.user-row-wrap')).toBeTruthy();
    expect(container.querySelector('.user-row .user-avatar')).toBeTruthy();
  });

  it('user-row is a button with aria-haspopup', () => {
    const { container } = render(
      <UserProvider value={testUser}>
        <Sidebar />
      </UserProvider>,
    );
    // AgentChip moved to SessionHeader per Tide Sessions.html layout.
    expect(container.querySelector('button.agent-chip')).toBeNull();

    const userRow = container.querySelector('button.user-row');
    expect(userRow).toBeTruthy();
    expect(userRow?.getAttribute('aria-haspopup')).toBe('true');
  });
});
