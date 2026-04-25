/**
 * Composer — fixed-bottom message composer (Task 17).
 *
 * Behaviors under test:
 *
 *   1. Renders attach button, textarea (with placeholder), and send button
 *      when the runtime isn't running.
 *
 *   2. Renders the .composer fixed-bottom container with .composer-field
 *      child markup that the Tide CSS hooks into. The CSS class names are
 *      load-bearing — the focus halo, send-when-ready accent, and
 *      sidebar-collapsed shift all key off them.
 *
 * The composer relies on assistant-ui's `ComposerPrimitive` which expects a
 * runtime context. We mount under a minimal `useLocalRuntime` provider so
 * the primitives have a runtime to talk to. Send behavior wiring is
 * verified end-to-end in Task 18+ when the composer is mounted in App.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
} from '@assistant-ui/react';
import type { ReactNode } from 'react';
import { Composer } from '../components/Composer';

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
    expect(screen.getByPlaceholderText('Message tide…')).toBeTruthy();
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
});
