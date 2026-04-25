/**
 * Golden-path acceptance — boots the full <App /> tree against a stubbed
 * backend and asserts the integration surface holds together: auth gate
 * resolves, sidebar mounts, runtime + provider establish, composer
 * renders, thread shows the empty welcome state.
 *
 * This is the "do all the wires actually connect?" test. Per-feature
 * coverage lives in the 31 sibling test files; this one only fails when
 * the integration boundary itself breaks (e.g., a context provider
 * disappears, the auth gate stops releasing, the runtime fails to
 * mount). It's the smallest test that would catch a wholesale
 * regression in App.tsx's composition.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { App } from '../App';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  // Default backend stub: Alice is signed in, no agents yet, no sessions.
  // The empty-state path is intentional — it means we don't have to
  // wrangle the streaming SSE protocol in jsdom, which has no real
  // ReadableStream story for fetch responses.
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
    if (url.includes('/api/auth/get-session')) {
      return new Response(
        JSON.stringify({
          user: { id: 'u2', email: 'alice@local', name: 'Alice', role: 'user' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/api/agents')) {
      return new Response(JSON.stringify({ agents: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/api/chat/sessions')) {
      return new Response(JSON.stringify({ sessions: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 404 });
  });
});

describe('golden-path acceptance', () => {
  it('mounts the full App tree against a mocked backend', async () => {
    const { container } = render(<App />);

    // Auth gate releases → sidebar mounts.
    await waitFor(() => {
      expect(container.querySelector('aside.sidebar')).toBeTruthy();
    });

    // Composer renders → runtime context is established. If the
    // AssistantRuntimeProvider failed to mount, the composer would
    // throw on its `useThreadRuntime()` calls.
    await waitFor(() => {
      expect(container.querySelector('.composer-field')).toBeTruthy();
    });

    // Empty conversation welcome copy → Thread renders without messages.
    await waitFor(() => {
      expect(screen.getByText(/One conversation/i)).toBeTruthy();
    });
  });
});
