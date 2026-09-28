/**
 * Every message the rail can point at carries its turn id (TASK-642).
 *
 * Measured on kind: only the person's bubble carried `data-turn-id`, so a
 * memory taken from the agent's reply had a source link that found nothing
 * and did nothing.
 */
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { AgentConversation } from '../AgentConversation';
import type { ThreadMessage, WorkspaceAgent } from '@/lib/workspace-api';
import { jumpToSource, MEMORY_SOURCE_ATTR, TURN_ID_ATTR } from '@/lib/thread-jump';

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

function byTurn(container: HTMLElement, id: string): Element | undefined {
  return [...container.querySelectorAll(`[${TURN_ID_ATTR}]`)].find(
    (el) => el.getAttribute(TURN_ID_ATTR) === id,
  );
}

afterEach(cleanup);

describe('AgentConversation — turn ids the rail can jump to', () => {
  it('tags the person’s message, the agent’s reply, and a tool-only turn', () => {
    const { container } = renderThread([
      { kind: 'user', id: 't1', text: 'Our go-live moved to Oct 14' },
      { kind: 'agent', id: 't2', text: 'Got it — Oct 14.', at: '2026-09-28T06:38:00.000Z' },
      {
        kind: 'steps',
        id: 't3',
        text: '',
        at: '2026-09-28T06:39:00.000Z',
        stepsLabel: '1 step',
        steps: [{ text: 'memory_note', status: 'done' }],
      } as ThreadMessage,
    ]);
    expect(byTurn(container, 't1')?.textContent).toContain('Our go-live');
    expect(byTurn(container, 't2')?.textContent).toContain('Got it');
    expect(byTurn(container, 't3')).toBeDefined();
  });

  it('a jump to the agent’s reply lands and highlights it', () => {
    const { container } = renderThread([
      { kind: 'agent', id: 't2', text: 'Got it — Oct 14.', at: '2026-09-28T06:38:00.000Z' },
    ]);
    expect(jumpToSource('t2')).toBe(true);
    expect(byTurn(container, 't2')?.getAttribute(MEMORY_SOURCE_ATTR)).toBe('flash');
  });
});
