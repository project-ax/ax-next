/**
 * TASK-1203 — a team agent's chat says, under the composer, that its memory is
 * shared with the team. The line belongs to the composer: it is tied to the
 * field with `aria-describedby`, and it goes where the composer goes (a
 * read-only Slack thread has neither).
 */
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentConversation } from '../AgentConversation';
import { memorySharedWith } from '../memory-copy';
import type { WorkspaceAgent } from '@/lib/workspace-api';

const fern: WorkspaceAgent = {
  id: 'a-fern',
  name: 'Fern',
  state: 'resting',
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
};

function renderConversation(over: Partial<ComponentProps<typeof AgentConversation>> = {}) {
  return render(
    <AgentConversation
      agent={fern}
      thread={[]}
      conversationId="c1"
      decisions={[]}
      readOnly={false}
      onSend={vi.fn()}
      onApprove={vi.fn()}
      onDismiss={vi.fn()}
      onUndo={vi.fn()}
      approvalRead="ok"
      onRetryApprovals={vi.fn()}
      grants={[]}
      onGrantResolved={vi.fn()}
      onGranted={vi.fn(async () => true)}
      {...over}
    />,
  );
}

describe('memorySharedWith', () => {
  it('names the team, or says "its team" when the name is unknown', () => {
    expect(memorySharedWith('Fern', 'Support')).toBe("Fern's memory is shared with everyone on Support.");
    expect(memorySharedWith('Fern', undefined)).toBe(
      "Fern's memory is shared with everyone on its team.",
    );
  });
});

describe('AgentConversation — the composer note (TASK-1203)', () => {
  it("a team agent's chat says its memory is shared with the team, under the composer, and the field is described by it", () => {
    renderConversation({ composerNote: memorySharedWith('Fern', 'Support') });
    const line = screen.getByText("Fern's memory is shared with everyone on Support.");
    expect(line.id).not.toBe('');
    expect(screen.getByPlaceholderText('Message Fern').getAttribute('aria-describedby')).toBe(line.id);
    expect(line.className).toContain('text-muted-foreground');
  });

  it("without a team name it says 'its team'", () => {
    renderConversation({ composerNote: memorySharedWith('Fern', undefined) });
    expect(screen.getByText("Fern's memory is shared with everyone on its team.")).toBeTruthy();
  });

  it("a personal agent's chat has no such line", () => {
    renderConversation();
    expect(screen.queryByText(/memory is shared/)).toBeNull();
    expect(screen.getByPlaceholderText('Message Fern').getAttribute('aria-describedby')).toBeNull();
  });

  it('a read-only Slack conversation has no line', () => {
    renderConversation({
      readOnly: true,
      readOnlyNote: 'Reply in Slack.',
      composerNote: memorySharedWith('Fern', 'Support'),
    });
    expect(screen.queryByText(/memory is shared/)).toBeNull();
  });
});
