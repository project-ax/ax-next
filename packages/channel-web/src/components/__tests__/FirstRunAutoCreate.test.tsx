import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FirstRunAutoCreate } from '../onboard/FirstRunAutoCreate';
import * as autoCreate from '../../lib/auto-create-agent';
import * as hydrate from '../../lib/hydrate-agents';
import { HttpError } from '../../lib/http';
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

    render(<FirstRunAutoCreate agentName="My agent" mode="first-run" onBack={vi.fn()} onDone={onDone} />);

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

    const { rerender } = render(<FirstRunAutoCreate agentName="My agent" mode="first-run" onBack={vi.fn()} onDone={vi.fn()} />);
    rerender(<FirstRunAutoCreate agentName="My agent" mode="first-run" onBack={vi.fn()} onDone={vi.fn()} />);

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    // Give any stray second invocation a tick to (not) happen.
    await new Promise((r) => setTimeout(r, 10));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('shows a Try again affordance when create fails', async () => {
    vi.spyOn(autoCreate, 'autoCreateBareAgent').mockRejectedValue(new Error('boom'));
    render(<FirstRunAutoCreate agentName="My agent" mode="first-run" onBack={vi.fn()} onDone={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy(),
    );
  });

  it('does NOT call onDone when create fails', async () => {
    vi.spyOn(autoCreate, 'autoCreateBareAgent').mockRejectedValue(new Error('boom'));
    const onDone = vi.fn();
    render(<FirstRunAutoCreate agentName="My agent" mode="first-run" onBack={vi.fn()} onDone={onDone} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy(),
    );
    expect(onDone).not.toHaveBeenCalled();
  });

  /*
    TASK-695. The person is told (the card above), but the `catch` used to
    swallow the error: someone debugging a real bootstrap failure had no console
    line to start from. `AgentView.send` leaves one through `logRequestFailure`;
    so does this.
  */
  describe('the operator breadcrumb when create fails (TASK-695)', () => {
    it('logs the request and status for an HTTP failure, and still tells the person', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(autoCreate, 'autoCreateBareAgent').mockRejectedValue(
        new HttpError('/api/agents/bootstrap', 500),
      );
      render(<FirstRunAutoCreate agentName="My agent" mode="first-run" onBack={vi.fn()} onDone={vi.fn()} />);
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy(),
      );
      expect(warn).toHaveBeenCalledWith('[agent-bootstrap] /api/agents/bootstrap → 500');
    });

    it('logs an unexpected (non-HTTP) failure with the error itself, so its stack survives', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const boom = new TypeError('Failed to fetch');
      vi.spyOn(autoCreate, 'autoCreateBareAgent').mockRejectedValue(boom);
      render(<FirstRunAutoCreate agentName="My agent" mode="add" onBack={vi.fn()} onDone={vi.fn()} />);
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy(),
      );
      expect(warn).toHaveBeenCalledWith('[agent-bootstrap] unexpected failure', boom);
    });

    it('logs even when the card was unmounted before the failure arrived', async () => {
      // The breadcrumb is for the operator, not for this component's state, so
      // it must not depend on whether anyone is still looking at the card.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      let fail!: (e: unknown) => void;
      vi.spyOn(autoCreate, 'autoCreateBareAgent').mockReturnValue(
        new Promise((_, reject) => {
          fail = reject;
        }),
      );
      const { unmount } = render(
        <FirstRunAutoCreate agentName="My agent" mode="first-run" onBack={vi.fn()} onDone={vi.fn()} />,
      );
      unmount();
      fail(new HttpError('/api/agents/bootstrap', 502));
      await waitFor(() =>
        expect(warn).toHaveBeenCalledWith('[agent-bootstrap] /api/agents/bootstrap → 502'),
      );
    });
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
      return <FirstRunAutoCreate agentName="My agent" mode="first-run" onBack={vi.fn()} onDone={onDone} />;
    }

    render(<Gate />);

    await waitFor(() => expect(screen.getByText('past the gate')).toBeTruthy());
    // The unmount happened. The completion must still have been reported.
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('a9'));
  });
});

/**
 * TASK-689 — the failure card.
 *
 * Found by forcing `POST /api/agents/bootstrap` to fail on the "+ New agent…"
 * path: the card said "We're setting up your FIRST agent" to someone who
 * already had agents, offered only "Try again", ignored Escape, and — because
 * `App.tsx`'s gate had REPLACED the workspace — the only way out was a page
 * reload. A card that can only retry is a trap the moment the failure is not a
 * blip.
 *
 * Each test says what it does against the OLD component.
 */
describe('FirstRunAutoCreate — a failure has a way out (TASK-689)', () => {
  beforeEach(() => {
    agentStoreActions.resetForTest();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const renderFailed = async (mode: 'first-run' | 'add') => {
    vi.spyOn(autoCreate, 'autoCreateBareAgent').mockRejectedValue(new Error('boom'));
    const onBack = vi.fn();
    render(
      <FirstRunAutoCreate agentName="Scout" mode={mode} onBack={onBack} onDone={vi.fn()} />,
    );
    await screen.findByRole('button', { name: /try again/i });
    return onBack;
  };

  it('first run: keeps the "first agent" framing and names the agent in the message', async () => {
    // OLD: the message said "your agent", never the name.
    await renderFailed('first-run');
    expect(screen.getByText("Let's get you started")).toBeTruthy();
    expect(
      screen.getByText("We're setting up your first agent so you can start chatting."),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "We couldn't set up Scout just now. That's on us, not you — give it another go.",
      ),
    ).toBeTruthy();
  });

  it('adding: never claims this is the first agent, and says which one failed', async () => {
    // OLD: the heading/description were first-run copy in EVERY mode, so an
    // existing user saw "We're setting up your first agent".
    await renderFailed('add');
    expect(screen.getByText('New agent')).toBeTruthy();
    expect(screen.getByText("We're setting up Scout.")).toBeTruthy();
    expect(
      screen.getByText(
        "We couldn't set up Scout just now. That's on us, not you — give it another go.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/first agent/i)).toBeNull();
    expect(screen.queryByText(/let's get you started/i)).toBeNull();
  });

  it('first run: "Change name" calls onBack, and there is no Cancel', async () => {
    // OLD: no second button at all.
    const onBack = await renderFailed('first-run');
    expect(screen.queryByRole('button', { name: /^cancel$/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /change name/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('adding: "Cancel" calls onBack, and there is no "Change name"', async () => {
    // OLD: no second button at all — the trap.
    const onBack = await renderFailed('add');
    expect(screen.queryByRole('button', { name: /change name/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('"Try again" retries with the SAME name, and finishes when it works', async () => {
    // Guards the retry the new buttons must not disturb. Passes on the old
    // component too — it is the control for the tests above.
    const create = vi
      .spyOn(autoCreate, 'autoCreateBareAgent')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ agentId: 'a9', displayName: 'Scout', visibility: 'personal' });
    vi.spyOn(hydrate, 'hydrateAgentsOnce').mockResolvedValue();
    const onDone = vi.fn();
    render(
      <FirstRunAutoCreate agentName="Scout" mode="add" onBack={vi.fn()} onDone={onDone} />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /try again/i }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith('a9'));
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenNthCalledWith(1, 'Scout');
    expect(create).toHaveBeenNthCalledWith(2, 'Scout');
  });

  it('adding: Escape on the failure card goes back', async () => {
    // OLD: Escape did nothing — the person had to reload the page.
    const onBack = await renderFailed('add');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('adding: Escape works the instant the failure card is on screen (TASK-772)', async () => {
    // OLD (passive useEffect): the card committed on a non-sync lane and the
    // keydown listener attached in a LATER task, so an Escape pressed in that
    // gap was silently dropped — 20/20 with this test, and the cause of the
    // CI flake in the test above. The MutationObserver callback is a microtask
    // right after React's DOM mutation, i.e. the earliest moment a person
    // could see Cancel; Escape must already work then.
    vi.spyOn(autoCreate, 'autoCreateBareAgent').mockRejectedValue(new Error('boom'));
    const onBack = vi.fn();
    let pressed = false;
    const observer = new MutationObserver(() => {
      if (pressed || !screen.queryByRole('button', { name: /cancel/i })) return;
      pressed = true;
      fireEvent.keyDown(document.body, { key: 'Escape' });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    try {
      render(
        <FirstRunAutoCreate agentName="Scout" mode="add" onBack={onBack} onDone={vi.fn()} />,
      );
      await waitFor(() => expect(pressed).toBe(true));
    } finally {
      observer.disconnect();
    }
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('first run: Escape on the failure card does nothing', async () => {
    // Passes on the old component; pins that the new listener is add-only.
    const onBack = await renderFailed('first-run');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onBack).not.toHaveBeenCalled();
  });

  it('adding: Escape while the create is still running does NOT go back', async () => {
    // Going back mid-create would abandon a POST that may still succeed and
    // leave an agent nobody was told about. Escape is an escape hatch from the
    // FAILURE card only. (Passes on the old component; pins the guard.)
    const create = vi
      .spyOn(autoCreate, 'autoCreateBareAgent')
      .mockReturnValue(new Promise(() => {}));
    const onBack = vi.fn();
    render(
      <FirstRunAutoCreate agentName="Scout" mode="add" onBack={onBack} onDone={vi.fn()} />,
    );
    await waitFor(() => expect(create).toHaveBeenCalled());
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onBack).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull();
  });
});
