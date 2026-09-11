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
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// ChainOfThought reads the message's parts (to count reasoning vs tool-call at
// its `indices`) via useMessage. Stub it so the component can render outside an
// assistant-ui runtime; the selector receives a fake message whose `content`
// the individual tests control.
let fakeContent: Array<{
  type: string;
  toolCallId?: string;
  isError?: boolean;
  status?: { type?: string };
}> = [];
vi.mock('@assistant-ui/react', () => ({
  useMessage: (sel: (m: unknown) => unknown) => sel({ content: fakeContent }),
}));

import { ChainOfThought, ReasoningText, chainOfThoughtLabel } from '../components/ChainOfThought';
import { clearToolHeld, rememberToolHeld } from '../lib/tool-held';

afterEach(() => clearToolHeld());

describe('chainOfThoughtLabel', () => {
  it('shows "Ran a command" for a single tool call, "Ran N commands" for more', () => {
    expect(chainOfThoughtLabel({ tools: 1, running: false }).text).toBe('Ran a command');
    expect(chainOfThoughtLabel({ tools: 3, running: false }).text).toBe('Ran 3 commands');
  });

  it('reads "Thought" for reasoning with no tools', () => {
    expect(chainOfThoughtLabel({ tools: 0, running: false }).text).toBe('Thought');
  });

  it('reads "Thinking…" while still streaming, regardless of tool count', () => {
    expect(chainOfThoughtLabel({ tools: 3, running: true }).text).toBe('Thinking…');
  });

  it('leaves the settled success labels muted', () => {
    expect(chainOfThoughtLabel({ tools: 1, running: false }).tone).toBe('muted');
    expect(chainOfThoughtLabel({ tools: 0, running: false }).tone).toBe('muted');
  });
});

/**
 * TASK-335 / audit A3 — the honesty fix, and a real defect rather than a copy nit.
 *
 * A step that FAILED still summarized as "Ran a command": the collapsed header
 * reported a success and the failure was only visible to someone who thought to
 * open the disclosure. Same for a step held for the reader's approval, which is
 * worse — that one is waiting on an action nobody was told about.
 */
describe('chainOfThoughtLabel — failure and holds do not read as success', () => {
  it('says a step failed rather than claiming it ran', () => {
    const s = chainOfThoughtLabel({ tools: 1, running: false, failed: 1 });
    expect(s.text).toBe("Couldn't finish a step");
    expect(s.tone).toBe('destructive');
  });

  it('says it is waiting on the reader when a step is held', () => {
    const s = chainOfThoughtLabel({ tools: 2, running: false, held: 1 });
    expect(s.text).toBe('Waiting for you');
    expect(s.tone).toBe('warning');
  });

  it('leads with the failure when a group has both', () => {
    // Both are surfaced elsewhere (the hold also shows on the composer and its
    // own card); the failure has nowhere else to appear, so it leads.
    const s = chainOfThoughtLabel({ tools: 3, running: false, failed: 1, held: 1 });
    expect(s.text).toBe("Couldn't finish a step");
    expect(s.tone).toBe('destructive');
  });

  it('still reads as streaming while the turn is live', () => {
    expect(chainOfThoughtLabel({ tools: 1, running: true, failed: 1 }).text).toBe(
      'Thinking…',
    );
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

  // TASK-335 / audit A3 — the header is the only thing most readers see, so a
  // failure that only appears once the disclosure is opened is a failure nobody
  // sees. These two drive the real component, through the real classifier.
  it('says a step failed, in the destructive tone, without being opened', () => {
    fakeContent = [{ type: 'tool-call', toolCallId: 'call-failed', isError: true }];
    render(
      <ChainOfThought indices={[0]}>
        <div>the failing detail</div>
      </ChainOfThought>,
    );
    const trigger = screen.getByRole('button', { name: /couldn't finish a step/i });
    expect(trigger.className).toContain('text-destructive');
    // Still collapsed — the header carries the bad news on its own.
    expect(screen.queryByText('the failing detail')).not.toBeInTheDocument();
    expect(screen.queryByText('Ran a command')).not.toBeInTheDocument();
  });

  it('says it is waiting on you when a step is held', () => {
    rememberToolHeld('call-held', true);
    fakeContent = [{ type: 'tool-call', toolCallId: 'call-held' }];
    render(
      <ChainOfThought indices={[0]}>
        <div>x</div>
      </ChainOfThought>,
    );
    const trigger = screen.getByRole('button', { name: /waiting for you/i });
    expect(trigger.className).toContain('text-warning');
    expect(screen.queryByText('Ran a command')).not.toBeInTheDocument();
  });
});
