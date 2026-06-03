/**
 * ChainOfThought — regression guard for the "thoughts render as visible chat
 * text" bug, plus the summarizing header.
 *
 * The model streams its reasoning as a native `reasoning` part; the chat folds
 * those (plus the tool calls made along the way) into THIS collapsed
 * disclosure. The bug was that thinking leaked into the visible reply — so the
 * load-bearing property is: the thought content is NOT in the DOM until the
 * user opens the disclosure (collapsed by default, Invariant J4). The header
 * summarizes the contents ("Thought and ran 3 commands") without opening it.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// ChainOfThought reads the message's parts (to count reasoning vs tool-call at
// its `indices`) via useMessage. Stub it so the component can render outside an
// assistant-ui runtime; the selector receives a fake message whose `content`
// the individual tests control.
let fakeContent: Array<{ type: string }> = [];
vi.mock('@assistant-ui/react', () => ({
  useMessage: (sel: (m: unknown) => unknown) => sel({ content: fakeContent }),
}));

import { ChainOfThought, ReasoningText, chainOfThoughtLabel } from '../components/ChainOfThought';

describe('chainOfThoughtLabel', () => {
  it('shows "Ran a command" for a single tool call, "Ran N commands" for more', () => {
    expect(chainOfThoughtLabel({ tools: 1, running: false })).toBe('Ran a command');
    expect(chainOfThoughtLabel({ tools: 3, running: false })).toBe('Ran 3 commands');
  });

  it('reads "Thought" for reasoning with no tools', () => {
    expect(chainOfThoughtLabel({ tools: 0, running: false })).toBe('Thought');
  });

  it('reads "Thinking…" while still streaming, regardless of tool count', () => {
    expect(chainOfThoughtLabel({ tools: 3, running: true })).toBe('Thinking…');
  });
});

describe('ChainOfThought', () => {
  it('is collapsed by default — the thought content is hidden until opened', () => {
    fakeContent = [{ type: 'reasoning' }];
    render(
      <ChainOfThought indices={[0]}>
        <div>secret thought</div>
      </ChainOfThought>,
    );
    // The header is always present...
    expect(screen.getByText('Thought')).toBeInTheDocument();
    // ...but the thought content is not rendered while collapsed (the bug was
    // that reasoning showed up as visible prose).
    expect(screen.queryByText('secret thought')).not.toBeInTheDocument();
    // Opening the disclosure reveals it on demand.
    fireEvent.click(screen.getByRole('button', { name: /thought/i }));
    expect(screen.getByText('secret thought')).toBeInTheDocument();
  });

  it('summarizes tool calls in the collapsed header (no "Thought" prefix)', () => {
    fakeContent = [
      { type: 'reasoning' },
      { type: 'tool-call' },
      { type: 'tool-call' },
      { type: 'tool-call' },
    ];
    render(
      <ChainOfThought indices={[0, 1, 2, 3]}>
        <div>steps</div>
      </ChainOfThought>,
    );
    expect(screen.getByText('Ran 3 commands')).toBeInTheDocument();
    expect(screen.queryByText(/Thought and ran/)).not.toBeInTheDocument();
  });

  it('reads "Thinking…" while the group is still streaming', () => {
    fakeContent = [{ type: 'reasoning' }];
    render(
      <ChainOfThought status={{ type: 'running' }} indices={[0]}>
        <div>x</div>
      </ChainOfThought>,
    );
    expect(screen.getByText('Thinking…')).toBeInTheDocument();
    expect(screen.queryByText('Thought')).not.toBeInTheDocument();
  });

  it('ReasoningText renders the thought prose', () => {
    render(<ReasoningText text="step one, step two" />);
    expect(screen.getByText('step one, step two')).toBeInTheDocument();
  });
});
