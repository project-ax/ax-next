/**
 * Thread — assistant-ui Thread root + welcome empty state + message
 * styling per Tide (Task 18).
 *
 * Behaviors under test:
 *
 *   1. Empty state renders the Tide welcome copy ("One conversation. /
 *      Say anything.") when there are no messages. This is the
 *      `ThreadPrimitive.If empty` branch.
 *
 *   2. Structural markup includes both `.timeline` (the viewport that
 *      Tide's max-width + padding lives on) and `.composer` (the
 *      fixed-bottom field). Both class names are load-bearing — Tide's
 *      CSS hooks into them for layout and the sidebar-collapsed shift.
 *
 * We don't drive `appendMessage` directly here — assistant-ui's
 * `useLocalRuntime` doesn't expose a clean back-channel for that, and
 * the runtime-driven `UserMessage` / `AssistantMessage` rendering is
 * exercised via the edit/retry behavior in Task 19's tests.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
} from '@assistant-ui/react';
import type { ReactNode } from 'react';
import { Thread } from '../components/Thread';

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

describe('Thread', () => {
  it('shows the welcome empty state when there are no messages', () => {
    render(
      <StubRuntimeProvider>
        <Thread />
      </StubRuntimeProvider>,
    );
    expect(screen.getByText(/One conversation/i)).toBeTruthy();
    expect(screen.getByText(/Say anything/i)).toBeTruthy();
  });

  it('renders the .timeline and .composer wrappers', () => {
    const { container } = render(
      <StubRuntimeProvider>
        <Thread />
      </StubRuntimeProvider>,
    );
    expect(container.querySelector('.timeline')).toBeTruthy();
    expect(container.querySelector('.composer')).toBeTruthy();
  });
});
