/**
 * AgentStatus — slim status row above the composer.
 *
 * Behaviors under test:
 *
 *   1. Hidden by default (no `.visible` class) so the row reserves
 *      vertical space without showing.
 *
 *   2. `agentStatusActions.show("Thinking…")` reveals the row with the
 *      given label and a blue-dot (working) variant — i.e., no `.error`
 *      class.
 *
 *   3. `agentStatusActions.set(...)` updates the label.
 *
 *   4. `agentStatusActions.hide()` returns the row to the hidden state.
 *
 *   5. Error mode (`agentStatusActions.error`) flips on the `.error`
 *      class, exposes a "retry" button when a retry handler is set, and
 *      a "dismiss" button when only a dismiss handler is set.
 *
 *   6. Cancel handler — `onCancel(fn)` makes a "stop" button available;
 *      clicking it invokes the handler AND hides the row.
 *
 * The component depends on `<ThreadPrimitive.If running>` for its
 * auto-pump behavior; we mount it inside the same minimal-runtime stub
 * the composer test uses so the primitive resolves to "not running".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
} from '@assistant-ui/react';
import type { ReactNode } from 'react';
import { AgentStatus } from '../components/AgentStatus';
import {
  agentStatusActions,
} from '../lib/agent-status-store';

const StubRuntimeProvider = ({ children }: { children: ReactNode }) => {
  const runtime = useLocalRuntime({
    async run() {
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
};

describe('AgentStatus', () => {
  beforeEach(() => {
    agentStatusActions.reset();
  });
  afterEach(() => {
    agentStatusActions.reset();
  });

  it('starts hidden (no .visible class)', () => {
    const { container } = render(
      <StubRuntimeProvider>
        <AgentStatus />
      </StubRuntimeProvider>,
    );
    const row = container.querySelector('.agent-status');
    expect(row).toBeTruthy();
    expect(row?.classList.contains('visible')).toBe(false);
  });

  it('show("Thinking…") reveals the row with that label', () => {
    const { container } = render(
      <StubRuntimeProvider>
        <AgentStatus />
      </StubRuntimeProvider>,
    );
    act(() => agentStatusActions.show('Thinking…'));
    const row = container.querySelector('.agent-status');
    expect(row?.classList.contains('visible')).toBe(true);
    expect(row?.classList.contains('error')).toBe(false);
    expect(screen.getByText('Thinking…')).toBeTruthy();
  });

  it('set(...) swaps the label', () => {
    render(
      <StubRuntimeProvider>
        <AgentStatus />
      </StubRuntimeProvider>,
    );
    act(() => agentStatusActions.show('Thinking…'));
    act(() => agentStatusActions.set('Starting sandbox…'));
    expect(screen.getByText('Starting sandbox…')).toBeTruthy();
  });

  it('hide() removes the .visible class', () => {
    const { container } = render(
      <StubRuntimeProvider>
        <AgentStatus />
      </StubRuntimeProvider>,
    );
    act(() => agentStatusActions.show('Thinking…'));
    act(() => agentStatusActions.hide());
    const row = container.querySelector('.agent-status');
    expect(row?.classList.contains('visible')).toBe(false);
  });

  it('error mode adds .error class and shows a "retry" button when retry is set', () => {
    const { container } = render(
      <StubRuntimeProvider>
        <AgentStatus />
      </StubRuntimeProvider>,
    );
    act(() =>
      agentStatusActions.error('Connection lost — retrying in 5s', {
        retry: () => undefined,
      }),
    );
    const row = container.querySelector('.agent-status');
    expect(row?.classList.contains('visible')).toBe(true);
    expect(row?.classList.contains('error')).toBe(true);
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });

  it('error mode shows "dismiss" when only a dismiss handler is set', () => {
    render(
      <StubRuntimeProvider>
        <AgentStatus />
      </StubRuntimeProvider>,
    );
    act(() =>
      agentStatusActions.error('Sandbox crashed', {
        dismiss: () => undefined,
      }),
    );
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeTruthy();
  });

  it('clicking retry invokes the handler WITHOUT auto-hiding (handler decides)', () => {
    // Retry handlers commonly transition the row to a follow-up working
    // state ("Reconnecting…"). Auto-hiding right after retry() would
    // flash that follow-up label invisibly.
    let retried = 0;
    const { container } = render(
      <StubRuntimeProvider>
        <AgentStatus />
      </StubRuntimeProvider>,
    );
    act(() =>
      agentStatusActions.error('Connection lost', {
        retry: () => {
          retried += 1;
          // Simulate the typical retry flow: swap to a follow-up label.
          agentStatusActions.show('Reconnecting…');
        },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(retried).toBe(1);
    // Row stays visible because the retry handler showed a new label.
    const row = container.querySelector('.agent-status');
    expect(row?.classList.contains('visible')).toBe(true);
    expect(screen.getByText('Reconnecting…')).toBeTruthy();
  });

  it('clicking dismiss invokes the dismiss handler AND hides the row', () => {
    // Dismiss = "make this go away". Hiding is the right behavior.
    let dismissed = 0;
    const { container } = render(
      <StubRuntimeProvider>
        <AgentStatus />
      </StubRuntimeProvider>,
    );
    act(() =>
      agentStatusActions.error('Disconnected', {
        dismiss: () => {
          dismissed += 1;
        },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(dismissed).toBe(1);
    const row = container.querySelector('.agent-status');
    expect(row?.classList.contains('visible')).toBe(false);
  });

  it('cancel handler exposes a "stop" button which invokes + hides', () => {
    let cancelled = 0;
    const { container } = render(
      <StubRuntimeProvider>
        <AgentStatus />
      </StubRuntimeProvider>,
    );
    act(() => {
      agentStatusActions.show('Thinking…');
      agentStatusActions.onCancel(() => {
        cancelled += 1;
      });
    });
    fireEvent.click(screen.getByRole('button', { name: /stop/i }));
    expect(cancelled).toBe(1);
    const row = container.querySelector('.agent-status');
    expect(row?.classList.contains('visible')).toBe(false);
  });
});
