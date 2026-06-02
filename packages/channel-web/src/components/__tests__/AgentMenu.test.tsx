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
});
