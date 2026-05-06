/**
 * Composer — fixed-bottom message composer (Task 17).
 *
 * Behaviors under test:
 *
 *   1. Renders attach button, textarea (with placeholder), and send button
 *      when the runtime isn't running.
 *
 *   2. Renders the .composer fixed-bottom container with .composer-field
 *      child markup that the CSS hooks into. The CSS class names are
 *      load-bearing — the focus halo, send-when-ready accent, and
 *      sidebar-collapsed shift all key off them.
 *
 * The composer relies on assistant-ui's `ComposerPrimitive` which expects a
 * runtime context. We mount under a minimal `useLocalRuntime` provider so
 * the primitives have a runtime to talk to. Send behavior wiring is
 * verified end-to-end in Task 18+ when the composer is mounted in App.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
} from '@assistant-ui/react';
import type { ReactNode } from 'react';
import { Composer } from '../components/Composer';
import {
  agentStatusActions,
  getAgentStatusSnapshot,
} from '../lib/agent-status-store';
import { testTriggersInternals } from '../lib/agent-status-test-triggers';

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

describe('Composer', () => {
  it('renders attach, textarea, and send button when not running', () => {
    render(
      <StubRuntimeProvider>
        <Composer />
      </StubRuntimeProvider>,
    );
    expect(screen.getByLabelText('Attach')).toBeTruthy();
    expect(screen.getByPlaceholderText('Message ax…')).toBeTruthy();
    expect(screen.getByLabelText('Send')).toBeTruthy();
  });

  it('renders the .composer fixed-bottom container with .composer-field child', () => {
    const { container } = render(
      <StubRuntimeProvider>
        <Composer />
      </StubRuntimeProvider>,
    );
    expect(container.querySelector('.composer')).toBeTruthy();
    expect(container.querySelector('.composer-field')).toBeTruthy();
    expect(container.querySelector('.composer-input')).toBeTruthy();
  });

  it('renders the agent-status row inside .composer-inner (above the field)', () => {
    const { container } = render(
      <StubRuntimeProvider>
        <Composer />
      </StubRuntimeProvider>,
    );
    const inner = container.querySelector('.composer-inner');
    expect(inner).toBeTruthy();
    // Status row sits inside composer-inner so it's outside the timeline.
    expect(inner?.querySelector('.agent-status')).toBeTruthy();
  });

  describe('test triggers', () => {
    beforeEach(() => {
      agentStatusActions.reset();
    });
    afterEach(() => {
      testTriggersInternals.cancelPendingTimers();
      agentStatusActions.reset();
    });

    it('intercepts /status submission (does not send as a chat message)', () => {
      const { container } = render(
        <StubRuntimeProvider>
          <Composer />
        </StubRuntimeProvider>,
      );
      const input = container.querySelector(
        '.composer-input',
      ) as HTMLTextAreaElement;
      const form = container.querySelector('.composer-inner') as HTMLFormElement;
      fireEvent.change(input, { target: { value: '/status Building…' } });
      fireEvent.submit(form);
      // Status row is now visible with the custom label; the input is cleared.
      expect(getAgentStatusSnapshot().mode).toBe('working');
      expect(getAgentStatusSnapshot().text).toBe('Building…');
      expect(input.value).toBe('');
    });

    it('intercepts /error transient submission and flips into error mode', () => {
      const { container } = render(
        <StubRuntimeProvider>
          <Composer />
        </StubRuntimeProvider>,
      );
      const input = container.querySelector(
        '.composer-input',
      ) as HTMLTextAreaElement;
      const form = container.querySelector('.composer-inner') as HTMLFormElement;
      fireEvent.change(input, { target: { value: '/error transient' } });
      fireEvent.submit(form);
      expect(getAgentStatusSnapshot().mode).toBe('error');
    });

    it('passes regular text through (no interception)', () => {
      const { container } = render(
        <StubRuntimeProvider>
          <Composer />
        </StubRuntimeProvider>,
      );
      const input = container.querySelector(
        '.composer-input',
      ) as HTMLTextAreaElement;
      const form = container.querySelector('.composer-inner') as HTMLFormElement;
      fireEvent.change(input, { target: { value: 'hello agent' } });
      fireEvent.submit(form);
      // The status row should NOT have been flipped on by a trigger.
      expect(getAgentStatusSnapshot().mode).toBe('hidden');
    });
  });
});
