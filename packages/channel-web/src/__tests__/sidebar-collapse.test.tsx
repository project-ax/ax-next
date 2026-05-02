import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { App } from '../App';
import { SidebarCollapseToggle } from '../components/SidebarCollapseToggle';
import { hydrateSidebarCollapsed, setSidebarCollapsed } from '../lib/sidebar-collapse';

beforeEach(() => {
  localStorage.clear();
  document.body.classList.remove('sidebar-collapsed');
});

describe('Sidebar collapse', () => {
  it('toggle adds and removes body.sidebar-collapsed', () => {
    render(<SidebarCollapseToggle />);
    fireEvent.click(screen.getByRole('button'));
    expect(document.body.classList.contains('sidebar-collapsed')).toBe(true);
    fireEvent.click(screen.getByRole('button'));
    expect(document.body.classList.contains('sidebar-collapsed')).toBe(false);
  });

  it('persists to localStorage and hydrates on mount', () => {
    setSidebarCollapsed(true);
    expect(localStorage.getItem('tide-sidebar-collapsed')).toBe('1');
    setSidebarCollapsed(false);
    expect(localStorage.getItem('tide-sidebar-collapsed')).toBeNull();

    // simulate fresh page load with persisted state
    localStorage.setItem('tide-sidebar-collapsed', '1');
    hydrateSidebarCollapsed();
    expect(document.body.classList.contains('sidebar-collapsed')).toBe(true);
  });

  it('aria-expanded reflects state', () => {
    render(<SidebarCollapseToggle />);
    const btn = screen.getByRole('button');
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('⌘\\ keyboard shortcut toggles when App is mounted (authenticated)', async () => {
    // Auth gate (Task 20) hides the keyboard shortcuts behind an
    // authenticated state — mock the session fetch so AppContent mounts.
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        // BackendUser shape (from @ax/auth-oidc); lib/auth.ts maps to AuthUser.
        user: { id: 'u1', email: 'alice@local', displayName: 'Alice', isAdmin: false },
      }),
    });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ agents: [] }) });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { container } = render(<App />);
    // Wait for AppContent (and thus the keyboard handler) to mount.
    // waitFor confirms `aside.sidebar` is in the DOM, but AppContent's
    // useEffect — which `addEventListener('keydown', onKey)` — runs
    // AFTER the commit. On loaded CI runners the macrotask gap between
    // commit and effect can outlast waitFor's poll, leading to a
    // racy "fire keydown before listener attaches" miss. Yielding one
    // macrotask after waitFor lets the effect flush deterministically.
    await waitFor(() => {
      expect(container.querySelector('aside.sidebar')).toBeTruthy();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.body.classList.contains('sidebar-collapsed')).toBe(false);
    fireEvent.keyDown(document, { key: '\\', metaKey: true });
    expect(document.body.classList.contains('sidebar-collapsed')).toBe(true);
    fireEvent.keyDown(document, { key: '\\', ctrlKey: true });
    expect(document.body.classList.contains('sidebar-collapsed')).toBe(false);
  });
});
