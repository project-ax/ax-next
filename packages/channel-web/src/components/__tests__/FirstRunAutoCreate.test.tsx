import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { FirstRunAutoCreate } from '../onboard/FirstRunAutoCreate';
import * as autoCreate from '../../lib/auto-create-agent';
import * as hydrate from '../../lib/hydrate-agents';
import { agentStoreActions } from '../../lib/agent-store';

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
});
