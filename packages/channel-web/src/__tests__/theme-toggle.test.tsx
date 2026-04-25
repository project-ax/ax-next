import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UserMenu } from '../components/UserMenu';
import { UserProvider } from '../lib/user-context';
import { hydrateTheme, setTheme } from '../lib/theme';

const user = {
  id: 'u2',
  email: 'alice@local',
  name: 'Alice',
  role: 'user' as const,
};

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('Theme toggle', () => {
  it('hydrate reads from localStorage and applies data-theme', () => {
    localStorage.setItem('tide-theme', 'dark');
    hydrateTheme();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('hydrate with no stored value clears data-theme (auto)', () => {
    document.documentElement.setAttribute('data-theme', 'dark'); // pretend stale
    hydrateTheme();
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
  });

  it('setTheme(light) sets attribute and persists', () => {
    setTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('tide-theme')).toBe('light');
  });

  it('setTheme(auto) removes attribute and clears localStorage', () => {
    setTheme('dark');
    setTheme('auto');
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
    expect(localStorage.getItem('tide-theme')).toBeNull();
  });

  it('clicking dark in the user menu wires through', () => {
    render(
      <UserProvider value={user}>
        <UserMenu />
      </UserProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Alice/i }));
    fireEvent.click(screen.getByRole('radio', { name: /dark/i }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('tide-theme')).toBe('dark');
  });
});
