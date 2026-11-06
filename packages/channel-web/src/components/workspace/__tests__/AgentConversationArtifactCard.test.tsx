import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AgentConversation } from '../AgentConversation';
import type { ThreadMessage, WorkspaceAgent } from '@/lib/workspace-api';

const quill: WorkspaceAgent = {
  id: 'a1', name: 'Quill', state: 'resting', now: null, counter: null, startedAt: null, stoppedReason: null,
};

describe('AgentConversation artifact cards', () => {
  it('draws a card for a published artifact and Open hands its id to onOpenArtifact', () => {
    const onOpenArtifact = vi.fn();
    const thread = [{
      kind: 'agent', id: 'r1', text: 'Done.', at: '2026-09-17T16:12:00.000Z',
      artifacts: [{ artifactId: 'art-1', version: 1, title: 'Q3 report', kind: 'document', extension: 'PDF' }],
    }] as ThreadMessage[];
    const props: ComponentProps<typeof AgentConversation> = {
      agent: quill, thread, conversationId: 'c1', decisions: [], readOnly: false, onOpenArtifact,
      onSend: vi.fn(), onApprove: vi.fn(), onDismiss: vi.fn(), onUndo: vi.fn(), approvalRead: 'ok',
      onRetryApprovals: vi.fn(), grants: [], onGrantResolved: vi.fn(), onGranted: vi.fn(async () => true),
    };
    render(<AgentConversation {...props} />);
    expect(screen.getByText('Q3 report')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(onOpenArtifact).toHaveBeenCalledWith('art-1');
  });
});
