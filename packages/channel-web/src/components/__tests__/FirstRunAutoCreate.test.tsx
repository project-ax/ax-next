import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { FirstRunAutoCreate } from '../onboard/FirstRunAutoCreate';
import * as autoCreate from '../../lib/auto-create-agent';
import * as hydrate from '../../lib/hydrate-agents';
import { agentStoreActions, useAgentStore } from '../../lib/agent-store';

describe('FirstRunAutoCreate', () => {
  beforeEach(() => {
    agentStoreActions.resetForTest();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('auto-creates a bare agent with the given name, selects it, hydrates, then calls onDone', async () => {
    const create = vi
      .spyOn(autoCreate, 'autoCreateBareAgent')
      .mockResolvedValue({ agentId: 'a9', displayName: 'My agent', visibility: 'personal' });
    const hyd = vi.spyOn(hydrate, 'hydrateAgentsOnce').mockResolvedValue();
    const select = vi.spyOn(agentStoreActions, 'setSelectedAgent');
    const onDone = vi.fn();

    render(<FirstRunAutoCreate agentName="My agent" onDone={onDone} />);

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith('My agent');
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(onDone).toHaveBeenCalledWith('a9');
    expect(select).toHaveBeenCalledWith('a9');
    expect(hyd).toHaveBeenCalledTimes(1);
  });

  it('creates exactly once across a StrictMode-style double mount', async () => {
    const create = vi
      .spyOn(autoCreate, 'autoCreateBareAgent')
      .mockResolvedValue({ agentId: 'a9', displayName: 'My agent', visibility: 'personal' });
    vi.spyOn(hydrate, 'hydrateAgentsOnce').mockResolvedValue();

    const { rerender } = render(<FirstRunAutoCreate agentName="My agent" onDone={vi.fn()} />);
    rerender(<FirstRunAutoCreate agentName="My agent" onDone={vi.fn()} />);

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    // Give any stray second invocation a tick to (not) happen.
    await new Promise((r) => setTimeout(r, 10));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('shows a Try again affordance when create fails', async () => {
    vi.spyOn(autoCreate, 'autoCreateBareAgent').mockRejectedValue(new Error('boom'));
    render(<FirstRunAutoCreate agentName="My agent" onDone={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy(),
    );
  });

  it('does NOT call onDone when create fails', async () => {
    vi.spyOn(autoCreate, 'autoCreateBareAgent').mockRejectedValue(new Error('boom'));
    const onDone = vi.fn();
    render(<FirstRunAutoCreate agentName="My agent" onDone={onDone} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy(),
    );
    expect(onDone).not.toHaveBeenCalled();
  });

  /**
   * TASK-249 regression. `onDone` must survive this component being unmounted
   * BY the store write it just made.
   *
   * On first run the only thing holding App's bootstrap gate open is "the
   * agent list is empty". `hydrateAgentsOnce` fills it, App unmounts us, our
   * effect cleanup sets `cancelled = true` — and the old code's
   * `if (cancelled) return` in front of `onDone` then threw away the
   * completion of work that had fully succeeded. The agent existed and nobody
   * was told, so the bootstrap kickoff never fired and the new agent never
   * introduced itself.
   *
   * The unmount here is driven by the real signal rather than simulated: a
   * `hydrateAgentsOnce` stub that populates `agent-store` for real, and a
   * parent that unmounts this component the moment the list is non-empty —
   * which is exactly what `shouldShowAgentBootstrap` does.
   *
   * VACUITY: against the unfixed component this fails — `onDone` is called
   * zero times, which is what the probe measured before the fix. It cannot
   * pass either way, because the whole test is the unmount.
   */
  it('calls onDone even when the hydrate it triggers unmounts it', async () => {
    vi.spyOn(autoCreate, 'autoCreateBareAgent').mockResolvedValue({
      agentId: 'a9',
      displayName: 'My agent',
      visibility: 'personal',
    });
    // The real store write, so the parent below unmounts us for the real
    // reason. A `mockResolvedValue()` here would leave the list empty and the
    // component mounted, and the test would prove nothing.
    vi.spyOn(hydrate, 'hydrateAgentsOnce').mockImplementation(async () => {
      agentStoreActions.setAgents([
        {
          id: 'a9',
          owner_id: '',
          owner_type: 'user',
          name: 'My agent',
          tag: '',
          desc: '',
          color: '#888',
          allowed_tools: [],
          mcp_config_ids: [],
          model: '',
          created_at: 0,
          updated_at: 0,
        },
      ]);
    });

    const onDone = vi.fn();

    /** App's gate, reduced to the one arm that matters on first run. */
    function Gate() {
      const { agents } = useAgentStore();
      if (agents.length > 0) return <div>past the gate</div>;
      return <FirstRunAutoCreate agentName="My agent" onDone={onDone} />;
    }

    render(<Gate />);

    await waitFor(() => expect(screen.getByText('past the gate')).toBeTruthy());
    // The unmount happened. The completion must still have been reported.
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('a9'));
  });
});
