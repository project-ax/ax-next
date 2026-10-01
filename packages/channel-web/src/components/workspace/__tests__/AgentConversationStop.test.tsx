/**
 * TASK-688 — the composer's Stop control, and the "you stopped this" note that
 * follows it.
 *
 * Scope is `AgentConversation` alone: WHEN the control exists and what it looks
 * like to the accessibility tree. The behaviour behind it (the POST, the
 * never-stuck fallback, the notice arriving at the right moment) is
 * `AgentViewStop.test.tsx`.
 *
 * jsdom has no layout, so "the layout does not jump" is asserted the only way
 * it can be here: Stop takes the SAME slot Send had (same parent, same index)
 * and carries the SAME shared-`Button` size classes.
 */
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AgentConversation } from '../AgentConversation';
import type { ThreadMessage, WorkspaceAgent } from '@/lib/workspace-api';
import { decisionFixture } from './decision-fixture';
import { STOPPED_NOTICE } from '../stop-copy';

const quill: WorkspaceAgent = {
  id: 'a-quill-stop',
  name: 'Quill',
  state: 'resting',
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
};

const STOPPED_SENTENCE = STOPPED_NOTICE;

function propsFor(
  over: Partial<ComponentProps<typeof AgentConversation>> = {},
): ComponentProps<typeof AgentConversation> {
  return {
    agent: quill,
    thread: [],
    conversationId: 'c1',
    decisions: [],
    readOnly: false,
    onSend: vi.fn(),
    onApprove: vi.fn(),
    onDismiss: vi.fn(),
    onUndo: vi.fn(),
    approvalRead: 'ok',
    onRetryApprovals: vi.fn(),
    grants: [],
    onGrantResolved: vi.fn(),
    onGranted: vi.fn(async () => true),
    ...over,
  };
}

function renderConversation(
  over: Partial<ComponentProps<typeof AgentConversation>> = {},
) {
  return render(<AgentConversation {...propsFor(over)} />);
}

const stopButton = () => screen.queryByRole('button', { name: /^stop/i });
const sendButton = () => screen.queryByRole('button', { name: 'Send' });
const announcer = () => screen.getByTestId('composer-announcer');

describe('AgentConversation — Stop is there exactly while a reply is running', () => {
  // WITHOUT THE CHANGE: there is no Stop control at all, so this passes for
  // the wrong reason on its own — its worth is the mutation that draws Stop
  // unconditionally, which flips it red.
  it('is absent while idle, and Send is the control', () => {
    renderConversation({ busy: false, onStop: vi.fn() });
    expect(stopButton()).toBeNull();
    expect(sendButton()).not.toBeNull();
  });

  // WITHOUT THE CHANGE: fails — `onStop` is not a prop, no Stop is drawn, and
  // Send stays on screen (disabled) for the whole reply.
  it('is present while busy, and takes Send’s place rather than sitting beside it', () => {
    renderConversation({ busy: true, onStop: vi.fn() });
    expect(stopButton()).not.toBeNull();
    expect(sendButton()).toBeNull();
  });

  // WITHOUT THE CHANGE: passes — that is the point. A caller that never wires
  // `onStop` (every other test file renders this component bare) keeps today's
  // composer byte for byte: Send, disabled, no Stop to click into a void.
  it('is absent while busy when no handler was given, and Send behaves exactly as before', () => {
    renderConversation({ busy: true });
    expect(stopButton()).toBeNull();
    expect(sendButton()).toBeDisabled();
  });

  it('is absent on a read-only past conversation, where the whole composer is gone', () => {
    renderConversation({ busy: true, readOnly: true, onStop: vi.fn() });
    expect(stopButton()).toBeNull();
    expect(sendButton()).toBeNull();
  });

  // The approval hold parks the turn server-side; that turn is still running
  // and still stoppable, and the hold must not take the way out with it.
  it('is offered while the turn is parked on an approval, when Send is held', () => {
    renderConversation({
      busy: true,
      onStop: vi.fn(),
      thread: [{ kind: 'approval', id: 'm-d-marcus', decisionId: 'd-marcus' }],
      decisions: [decisionFixture()],
    });
    // The hold really is on (Send would be quiet if it were shown) — otherwise
    // this test would be proving nothing about the hold.
    expect(screen.getByPlaceholderText('Message Quill')).toBeDisabled();
    expect(stopButton()).not.toBeNull();
    expect(stopButton()).not.toBeDisabled();
  });
});

describe('AgentConversation — Stop the control', () => {
  it('calls onStop once per click', () => {
    const onStop = vi.fn();
    renderConversation({ busy: true, onStop });
    fireEvent.click(stopButton()!);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('is a real, keyboard-reachable button named "Stop" (not a div, not out of the tab order)', () => {
    renderConversation({ busy: true, onStop: vi.fn() });
    const stop = screen.getByRole('button', { name: 'Stop' });
    expect(stop.tagName).toBe('BUTTON');
    expect(stop).toHaveAttribute('type', 'button');
    expect(stop).not.toHaveAttribute('tabindex', '-1');
    stop.focus();
    expect(document.activeElement).toBe(stop);
    // The visible focus ring is the shared Button's own; a one-off that
    // dropped it would show here.
    expect(stop.className).toContain('focus-visible:ring-2');
  });

  it('draws a decorative filled square, hidden from the accessibility tree', () => {
    renderConversation({ busy: true, onStop: vi.fn() });
    const icon = screen.getByRole('button', { name: 'Stop' }).querySelector('svg');
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(icon).toHaveAttribute('fill', 'currentColor');
  });

  it('sits in the very slot Send had, at the same size, so the row does not jump', () => {
    const { rerender } = renderConversation({ busy: false, onStop: vi.fn() });
    const send = sendButton()!;
    const row = send.parentElement!;
    const slot = Array.from(row.children).indexOf(send);
    const sendClasses = send.className;

    rerender(<AgentConversation {...propsFor({ busy: true, onStop: vi.fn() })} />);
    const stop = screen.getByRole('button', { name: 'Stop' });
    expect(stop.parentElement).toBe(row);
    expect(Array.from(row.children).indexOf(stop)).toBe(slot);
    // Same desktop square and 44px phone target, both.
    for (const cls of ['size-8', 'max-md:size-11']) {
      expect(sendClasses).toContain(cls);
      expect(stop.className).toContain(cls);
    }
  });

  it('uses only semantic colour tokens — no raw palette or hex value', () => {
    renderConversation({ busy: true, onStop: vi.fn() });
    const cls = screen.getByRole('button', { name: 'Stop' }).className;
    expect(cls).not.toMatch(/\b(bg|text|border)-(red|blue|green|gray|slate|zinc|black|white)\b/);
    expect(cls).not.toMatch(/#[0-9a-f]{3,8}/i);
  });
});

describe('AgentConversation — while a Stop is on its way', () => {
  it('goes quiet rather than absent: disabled, named "Stopping", and a second click does nothing', () => {
    const onStop = vi.fn();
    renderConversation({ busy: true, onStop, stopping: true });
    const stop = screen.getByRole('button', { name: 'Stopping' });
    expect(stop).toBeDisabled();
    fireEvent.click(stop);
    expect(onStop).not.toHaveBeenCalled();
  });

  it('says "Stopping." on the composer’s one announcer, not on a second live region', () => {
    renderConversation({ busy: true, onStop: vi.fn(), stopping: true });
    expect(announcer().textContent).toBe('Stopping.');
    // The announcer is still the only composer status node.
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('announces nothing extra when a Stop is not in flight', () => {
    renderConversation({ busy: true, onStop: vi.fn() });
    expect(announcer().textContent).toBe('');
  });
});

describe('AgentConversation — after a stop, the field comes back under the keyboard', () => {
  it('returns focus to the field when the turn ends and Stop was what held it', () => {
    const props = propsFor({ busy: true, onStop: vi.fn() });
    const { rerender } = render(<AgentConversation {...props} />);
    const stop = screen.getByRole('button', { name: 'Stop' });
    stop.focus();
    fireEvent.click(stop);

    rerender(<AgentConversation {...props} busy={false} />);
    expect(document.activeElement).toBe(screen.getByPlaceholderText('Message Quill'));
  });

  it('does not take focus from someone who has moved on', () => {
    const props = propsFor({ busy: true, onStop: vi.fn() });
    const { rerender } = render(
      <>
        <button type="button">elsewhere</button>
        <AgentConversation {...props} />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    const elsewhere = screen.getByRole('button', { name: 'elsewhere' });
    elsewhere.focus();

    rerender(
      <>
        <button type="button">elsewhere</button>
        <AgentConversation {...props} busy={false} />
      </>,
    );
    expect(document.activeElement).toBe(elsewhere);
  });

  it('does not steal focus when the turn ends on its own, Stop never clicked', () => {
    const props = propsFor({ busy: true, onStop: vi.fn() });
    const { rerender } = render(<AgentConversation {...props} />);
    rerender(<AgentConversation {...props} busy={false} />);
    expect(document.activeElement).toBe(document.body);
  });
});

describe('AgentConversation — the "you stopped this" note', () => {
  const stoppedRow: ThreadMessage = {
    kind: 'stopped',
    id: 'stopped-notice',
    text: STOPPED_SENTENCE,
  };

  // WITHOUT THE CHANGE: fails — `stopped` is not a kind the renderer knows, so
  // the row falls through to the agent-bubble arm: no `note` role anywhere.
  it('is drawn at the end of the thread, after the reply it is about', () => {
    renderConversation({
      thread: [
        { kind: 'user', id: 'u1', text: 'write me a poem' },
        { kind: 'agent', id: 'a1', text: 'Roses are', at: '' },
        stoppedRow,
      ],
    });
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(STOPPED_SENTENCE);
    const reply = screen.getByText(/Roses are/);
    expect(
      reply.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // A deliberate stop is not a failure, so it must not borrow the failure
  // register: no assertive `alert` role (the destructive strips carry it) and
  // no destructive tokens.
  it('is not an error: no assertive alert role, no destructive styling', () => {
    renderConversation({ thread: [stoppedRow] });
    expect(screen.queryByRole('alert')).toBeNull();
    const note = screen.getByRole('note');
    expect(note.className).not.toContain('destructive');
    expect(note.innerHTML).not.toContain('destructive');
  });

  it('is announced once, through the composer announcer, as "Stopped."', () => {
    renderConversation({ thread: [stoppedRow] });
    expect(announcer().textContent).toBe('Stopped.');
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  // Passes with or without the renderer (a kind that does not exist yet cannot
  // be indexed) — it is a guard on `thread-find`'s explicit `stopped` arm: index
  // the note's text there and this goes red, because the Find toggle appears
  // over a thread with nothing in it anyone said.
  it('is not counted by thread find (it is chrome, not something anyone said)', () => {
    renderConversation({ thread: [stoppedRow] });
    // A thread holding only the note has nothing to search, so the Find toggle
    // must not appear over it.
    expect(screen.queryByRole('button', { name: /find/i })).toBeNull();
  });
});
