/**
 * NewSessionButton — clicking it must drive assistant-ui to a fresh
 * thread so the visible chat clears (welcome empty state). Without
 * this the click only resets local store state and the previous
 * thread's history stays on screen — that was the reported bug.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { NewSessionButton } from '../components/NewSessionButton';
import { agentStoreActions } from '../lib/agent-store';

const switchToNewThread = vi.hoisted(() => vi.fn());
vi.mock('@assistant-ui/react', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@assistant-ui/react',
  );
  return {
    ...actual,
    useAui: () => ({
      threads: () => ({ switchToNewThread, switchToThread: vi.fn() }),
    }),
  };
});

beforeEach(() => {
  switchToNewThread.mockReset();
  agentStoreActions.setActiveSession(null, false);
  agentStoreActions.setSelectedAgent('ax');
  agentStoreActions.setAgents([
    {
      id: 'ax',
      owner_id: 't1',
      owner_type: 'team',
      name: 'ax',
      desc: '',
      color: '#7aa6c9',
      tag: 'work',
      allowed_tools: [],
      mcp_config_ids: [],
      model: '',
      created_at: 0,
      updated_at: 0,
    },
  ]);
});

describe('NewSessionButton', () => {
  it('clicking calls aui.threads().switchToNewThread() (regression)', () => {
    const { container } = render(<NewSessionButton />);
    const btn = container.querySelector('.new-session-btn');
    expect(btn).toBeTruthy();
    fireEvent.click(btn!);
    expect(switchToNewThread).toHaveBeenCalledTimes(1);
  });

  it('no-op when there is no active agent', () => {
    agentStoreActions.setSelectedAgent(null);
    agentStoreActions.setAgents([]);
    const { container } = render(<NewSessionButton />);
    const btn = container.querySelector('.new-session-btn');
    fireEvent.click(btn!);
    expect(switchToNewThread).not.toHaveBeenCalled();
  });
});
