import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentMenu } from '../AgentMenu';

const agents = [
  { id: 'a1', name: 'Ada', desc: 'writer', color: '#7aa6c9' } as never,
];

describe('AgentMenu "+ New agent"', () => {
  it('renders a New agent row and calls onCreateNew', () => {
    const onCreateNew = vi.fn();
    render(<AgentMenu agents={agents} activeId="a1" onPick={() => {}} onCreateNew={onCreateNew} />);
    fireEvent.click(screen.getByRole('button', { name: /new agent/i }));
    expect(onCreateNew).toHaveBeenCalled();
  });

  it('omits the New agent row when onCreateNew is not provided', () => {
    render(<AgentMenu agents={agents} activeId="a1" onPick={() => {}} />);
    expect(screen.queryByRole('button', { name: /new agent/i })).toBeNull();
  });

  /**
   * Found by measuring this surface in a real browser, which is the only place
   * it shows: the footnote was `text-ink-ghost`, a token that renders ~2.0:1 in
   * dark mode and ~1.7:1 in light. That is a deliberate choice for the
   * decoration it was built for — section labels, the ⌘N hint, "⏎ send" — but
   * since TASK-336 this line carries the one sentence telling a reader what
   * pressing Enter will do, and instructional copy should not be decoration.
   */
  it('renders the footnote as readable copy, not as decoration', () => {
    render(<AgentMenu agents={agents} activeId="a1" onPick={() => {}} />);
    const foot = screen.getByText(/starts a fresh chat with this agent/i);
    expect(foot.className).toContain('text-muted-foreground');
    expect(foot.className).not.toContain('text-ink-ghost');
  });
});
