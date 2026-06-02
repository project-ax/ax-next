import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentBootstrap } from '../onboard/AgentBootstrap';
import { agentStoreActions } from '../../lib/agent-store';

vi.mock('../../lib/agent-bootstrap', () => ({
  bootstrapAgent: vi.fn(async () => ({ agentId: 'a-new', displayName: 'Ada', visibility: 'personal' })),
}));
vi.mock('../../lib/hydrate-agents', () => ({ hydrateAgentsOnce: vi.fn(async () => {}) }));

import { bootstrapAgent } from '../../lib/agent-bootstrap';
import { hydrateAgentsOnce } from '../../lib/hydrate-agents';

beforeEach(() => agentStoreActions.resetForTest());
afterEach(() => vi.clearAllMocks());

describe('AgentBootstrap', () => {
  it('walks name → soul → purpose → done and creates the agent', async () => {
    const onDone = vi.fn();
    render(<AgentBootstrap onDone={onDone} />);

    // Step 1: name (Continue disabled until non-empty)
    const nameInput = screen.getByLabelText(/what should we call/i);
    fireEvent.change(nameInput, { target: { value: 'Ada' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    // Step 2: soul
    expect(screen.getByText(/give ada a personality/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/personality/i), { target: { value: 'Warm and patient.' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    // Step 3: purpose → create
    expect(screen.getByText(/here to help with/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/help with/i), { target: { value: 'help me write' } });
    fireEvent.click(screen.getByRole('button', { name: /create ada/i }));

    await waitFor(() => expect(bootstrapAgent).toHaveBeenCalledTimes(1));
    const arg = (bootstrapAgent as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as {
      displayName: string;
      systemPrompt: string;
    };
    expect(arg.displayName).toBe('Ada');
    expect(arg.systemPrompt).toContain('Warm and patient.');
    expect(arg.systemPrompt).toContain('Your job: help me write');

    // post-create: re-hydrate + select + done screen
    await waitFor(() => expect(hydrateAgentsOnce).toHaveBeenCalled());
    expect(screen.getByText(/ada is ready/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /start chatting/i }));
    expect(onDone).toHaveBeenCalled();
  });

  it('"Surprise me" fills a name so Continue enables', () => {
    render(<AgentBootstrap onDone={() => {}} />);
    const continueBtn = screen.getByRole('button', { name: /continue/i }) as HTMLButtonElement;
    expect(continueBtn.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /surprise me/i }));
    expect((screen.getByLabelText(/what should we call/i) as HTMLInputElement).value.length).toBeGreaterThan(0);
  });

  it('shows a Back-to-chat affordance only when canCancel is true', () => {
    const onCancel = vi.fn();
    const { rerender } = render(<AgentBootstrap onDone={() => {}} />);
    expect(screen.queryByRole('button', { name: /back to chat/i })).toBeNull();
    rerender(<AgentBootstrap onDone={() => {}} canCancel onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: /back to chat/i }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('surfaces a friendly error when create fails', async () => {
    (bootstrapAgent as unknown as { mockRejectedValueOnce: (e: unknown) => void }).mockRejectedValueOnce(
      new Error('bootstrap agent: 500'),
    );
    render(<AgentBootstrap onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText(/what should we call/i), { target: { value: 'Ada' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    fireEvent.click(screen.getByRole('button', { name: /continue/i })); // soul left default
    fireEvent.click(screen.getByRole('button', { name: /create ada/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  });
});
