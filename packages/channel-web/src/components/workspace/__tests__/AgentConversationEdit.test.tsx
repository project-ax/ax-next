import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { workspaceApi, type WorkspaceAgent } from '@/lib/workspace-api';
import { AgentConversation } from '../AgentConversation';
import { decisionFixture } from './decision-fixture';

const agent: WorkspaceAgent = {
  id: 'scheduler',
  name: 'Scheduler',
  state: 'waiting',
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
};
const decision = decisionFixture({
  preview: { meta: '', body: 'Original draft' },
});
function mount(readOnly = false, dismiss = vi.fn(async () => {})) {
  const send = vi.fn();
  const approve = vi.fn();
  render(
    <AgentConversation
      agent={agent}
      conversationId="c1"
      thread={[{ kind: 'approval', id: 'approval', decisionId: decision.id }]}
      decisions={[decision]}
      readOnly={readOnly}
      onSend={send}
      onApprove={approve}
      onDismiss={dismiss}
      onUndo={vi.fn()}
      approvalRead="ok"
      onRetryApprovals={vi.fn()}
      grants={[]}
      onGrantResolved={vi.fn()}
      onGranted={vi.fn(async () => true)}
    />,
  );
  return { send, approve, dismiss };
}
afterEach(() => vi.restoreAllMocks());

describe('Edit first keeps the approval boundary', () => {
  it('cancels the original and verifies cancellation before asking for the edited draft', async () => {
    const read = vi
      .spyOn(workspaceApi, 'decision')
      .mockResolvedValue({ decision: { ...decision, status: 'dismissed' } });
    const { send, approve, dismiss } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Edit first' }));
    expect(screen.getByLabelText('Draft')).toHaveValue('Original draft');
    fireEvent.change(screen.getByLabelText('Draft'), {
      target: { value: 'Revised draft' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Ask for this version' }),
    );
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        'Please prepare a revised draft using this text. Ask me before sending it:\n\nRevised draft',
      ),
    );
    expect(dismiss).toHaveBeenCalledWith(decision.id);
    expect(read).toHaveBeenCalledWith(decision.id);
    expect(dismiss.mock.invocationCallOrder[0]).toBeLessThan(
      read.mock.invocationCallOrder[0]!,
    );
    expect(read.mock.invocationCallOrder[0]).toBeLessThan(
      send.mock.invocationCallOrder[0]!,
    );
    expect(approve).not.toHaveBeenCalled();
  });

  it('does not send a new turn when the original is still pending', async () => {
    vi.spyOn(workspaceApi, 'decision').mockResolvedValue({ decision });
    const { send, approve } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Edit first' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Ask for this version' }),
    );
    expect(
      await screen.findByText(/couldn’t ask for that edit/),
    ).toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
  });

  it('keeps the draft unchanged when the edit dialog is cancelled', () => {
    const { send, approve, dismiss } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Edit first' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('does not offer an edit from a historical conversation', () => {
    mount(true);
    expect(screen.queryByRole('button', { name: 'Edit first' })).toBeNull();
  });
});
