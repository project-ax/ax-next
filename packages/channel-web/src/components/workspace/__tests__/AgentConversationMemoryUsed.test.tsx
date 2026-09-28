/**
 * The "Used N memories" chip is drawn under an answer — and only under an
 * answer that actually used some (TASK-628).
 */
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { AgentConversation } from '../AgentConversation';
import type { ThreadMessage, WorkspaceAgent } from '@/lib/workspace-api';
import type { MemoryUsed } from '@/lib/workspace-types';

const quill: WorkspaceAgent = {
  id: 'a1',
  name: 'Quill',
  state: 'resting',
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
};

function renderThread(thread: ThreadMessage[]): ReturnType<typeof render> {
  const props: ComponentProps<typeof AgentConversation> = {
    agent: quill,
    thread,
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
  };
  return render(<AgentConversation {...props} />);
}

const memoryUsed: MemoryUsed = {
  statements: [
    {
      id: 'm1',
      about: 'user:alice',
      aboutText: 'you',
      relation: 'lives_in',
      value: 'Boston',
      when: '2026-09-01T12:00:00.000Z',
    },
  ],
};

const agentMsg = (over: Record<string, unknown> = {}): ThreadMessage =>
  ({
    kind: 'agent',
    id: 'r1',
    text: 'You live in Boston.',
    at: '2026-09-17T16:12:00.000Z',
    ...over,
  }) as ThreadMessage;

const stepsMsg = (over: Record<string, unknown> = {}): ThreadMessage =>
  ({
    kind: 'steps',
    id: 't1',
    text: '',
    at: '2026-09-17T16:12:00.000Z',
    stepsLabel: '1 step',
    steps: [{ text: 'memory_recall', status: 'done' }],
    ...over,
  }) as ThreadMessage;

const chip = (c: HTMLElement) => c.querySelector('[data-testid="workspace-memory-used"]');

describe('AgentConversation — the memory-used chip', () => {
  it('is drawn under an answer that used memories', () => {
    const { container } = renderThread([agentMsg({ memoryUsed })]);
    expect(chip(container)?.textContent).toContain('Used 1 memory');
  });

  it('is absent when the answer used none', () => {
    const { container } = renderThread([
      agentMsg(),
      agentMsg({ id: 'r2', memoryUsed: { statements: [] } }),
    ]);
    expect(chip(container)).toBeNull();
  });

  it('sits after the step panel, even on a tool-only turn with no prose', () => {
    const { container } = renderThread([stepsMsg({ memoryUsed })]);
    const panel = container.querySelector('[data-testid="workspace-steps"]');
    const c = chip(container);
    expect(panel).not.toBeNull();
    expect(c).not.toBeNull();
    expect(panel!.compareDocumentPosition(c!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
