/**
 * The step panel, drawn (TASK-352).
 *
 * The seam test (`src/__tests__/workspace-steps-seam.test.tsx`) proves the two
 * paths agree; this proves the thing they agree ON is actually drawable — the
 * disclosure opens and shuts, identical rows survive, and a tool-only turn
 * renders its panel without an empty bubble above it.
 */
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { AgentConversation } from '../AgentConversation';
import type { ThreadMessage, WorkspaceAgent } from '@/lib/workspace-api';

const quill: WorkspaceAgent = {
  id: 'a1',
  name: 'Quill',
  state: 'resting',
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
};

function renderThread(
  thread: ThreadMessage[],
): ReturnType<typeof render> {
  const props: ComponentProps<typeof AgentConversation> = {
    agent: quill,
    thread,
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
  };
  return render(<AgentConversation {...props} />);
}

const steps = (over: Partial<Extract<ThreadMessage, { kind: 'steps' }>> = {}) =>
  ({
    kind: 'steps',
    id: 't1',
    text: 'Done.',
    time: '4:12 PM',
    stepsLabel: '2 steps',
    steps: ['Bash', 'Bash'],
    ...over,
  }) as ThreadMessage;

function rows(container: HTMLElement): string[] {
  const panel = container.querySelector('[data-testid="workspace-steps"]');
  if (panel === null) throw new Error('no step panel');
  return [...panel.querySelectorAll('li')].map((li) => (li.textContent ?? '').trim());
}

describe('the step panel', () => {
  it('keeps two identical rows as two rows', () => {
    // An agent that ran the same tool twice did two things. Keying the list by
    // the sentence would make those a duplicate React key across siblings.
    const { container } = renderThread([steps()]);
    expect(rows(container)).toEqual(['Bash', 'Bash']);
  });

  it('opens by default and can be shut', () => {
    const { container } = renderThread([steps()]);
    expect(rows(container)).toHaveLength(2);
    const trigger = container.querySelector(
      '[data-testid="workspace-steps"] button',
    );
    fireEvent.click(trigger!);
    expect(
      container.querySelectorAll('[data-testid="workspace-steps"] li'),
    ).toHaveLength(0);
  });

  it('draws no empty bubble above a turn that only ran tools', () => {
    const { container } = renderThread([steps({ text: '' })]);
    expect(rows(container)).toHaveLength(2);
    // The prose bubble carries this class; with no prose it must not exist.
    expect(container.querySelector('.text-pretty')).toBeNull();
  });

  it('still draws the reply above the panel when there is one', () => {
    const { container } = renderThread([steps({ text: 'Done.' })]);
    expect(container.querySelector('.text-pretty')?.textContent).toContain('Done.');
  });
});
