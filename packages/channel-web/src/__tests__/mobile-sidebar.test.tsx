/**
 * Mobile sidebar — Task 27.
 *
 * jsdom doesn't honor CSS media queries for `getComputedStyle` in the way
 * the spec intends, so we don't try to assert media-query behavior here.
 * The contract we *do* care about is the state machine: clicking the
 * mobile toggle flips `body.sidebar-open`, and `setSidebarOpen` is
 * idempotent. CSS handles the actual show/hide visually.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SidebarMobileToggle } from '../components/SidebarMobileToggle';
import { setSidebarOpen } from '../lib/sidebar-collapse';

beforeEach(() => {
  document.body.classList.remove('sidebar-open');
});

describe('Mobile sidebar', () => {
  it('toggle adds and removes body.sidebar-open', () => {
    render(<SidebarMobileToggle />);
    fireEvent.click(screen.getByRole('button'));
    expect(document.body.classList.contains('sidebar-open')).toBe(true);
    fireEvent.click(screen.getByRole('button'));
    expect(document.body.classList.contains('sidebar-open')).toBe(false);
  });

  it('aria-expanded reflects state', () => {
    render(<SidebarMobileToggle />);
    const btn = screen.getByRole('button');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
  });

  it('setSidebarOpen(false) is idempotent', () => {
    setSidebarOpen(false);
    expect(document.body.classList.contains('sidebar-open')).toBe(false);
    setSidebarOpen(true);
    setSidebarOpen(false);
    expect(document.body.classList.contains('sidebar-open')).toBe(false);
  });
});
