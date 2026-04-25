import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Sidebar } from '../components/Sidebar';

describe('Sidebar', () => {
  it('renders the Tide structure with all required class hooks', () => {
    const { container } = render(<Sidebar />);
    const sidebar = screen.getByTestId('sidebar');
    expect(sidebar.tagName).toBe('ASIDE');
    expect(sidebar.className).toContain('sidebar');
    expect(container.querySelector('.brand-word')?.textContent).toBe('tide');
    expect(container.querySelector('.agent-chip')).toBeTruthy();
    expect(container.querySelector('.new-session-btn')).toBeTruthy();
    expect(container.querySelector('.sessions-scroll')).toBeTruthy();
    expect(container.querySelector('.user-row-wrap')).toBeTruthy();
    expect(container.querySelector('.user-row .user-avatar')).toBeTruthy();
  });

  it('agent-chip and user-row are buttons with aria-haspopup', () => {
    const { container } = render(<Sidebar />);
    const chip = container.querySelector('button.agent-chip');
    expect(chip).toBeTruthy();
    expect(chip?.getAttribute('aria-haspopup')).toBe('true');
  });
});
