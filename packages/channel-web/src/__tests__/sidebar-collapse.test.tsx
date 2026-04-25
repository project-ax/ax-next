import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

  it('⌘\\ keyboard shortcut toggles when App is mounted', () => {
    render(<App />);
    expect(document.body.classList.contains('sidebar-collapsed')).toBe(false);
    fireEvent.keyDown(document, { key: '\\', metaKey: true });
    expect(document.body.classList.contains('sidebar-collapsed')).toBe(true);
    fireEvent.keyDown(document, { key: '\\', ctrlKey: true });
    expect(document.body.classList.contains('sidebar-collapsed')).toBe(false);
  });
});
