/**
 * Golden-path acceptance — boots the full <App /> tree against a stubbed
 * backend and asserts the integration surface holds together: the boot and
 * auth gates release, the agent list hydrates past the first-run gate, and
 * the REAL workspace shell mounts, reads its board, and draws its rail (the
 * signed-in user's menu, the agent the board reported, the create-agent door)
 * around the Today view.
 *
 * This is the "do all the wires actually connect?" test. Per-feature coverage
 * lives in the sibling test files; this one only fails when the integration
 * boundary itself breaks (e.g., a context provider disappears, the auth gate
 * stops releasing, the workspace stops loading its board). It's the smallest
 * test that would catch a wholesale regression in App.tsx's composition.
 *
 * Nothing is module-mocked on purpose: every layer between `fetch` and the
 * DOM is the shipped code.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { App } from '../App';

const fetchMock = vi.fn();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  // Default backend stub: Alice is signed in with one existing agent. The
  // agent is required so AppContent's first-run gate resolves to the
  // workspace (an EMPTY agent list diverts to the first-run create flow,
  // <FirstRunAutoCreate> — see its dedicated suite).
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
    if (url.includes('/admin/me')) {
      // BackendUser shape (from @ax/auth-better); lib/auth.ts maps to AuthUser.
      return json({
        user: { id: 'u2', email: 'alice@local', displayName: 'Alice', isAdmin: false },
      });
    }
    if (url.includes('/api/chat/agents')) {
      return json([{ agentId: 'agt_alice', displayName: 'Alice Agent', visibility: 'personal' }]);
    }
    if (url.includes('/api/workspace/state')) {
      return json({
        agents: [
          {
            id: 'agt_alice',
            name: 'Scribe',
            state: 'resting',
            now: null,
            counter: null,
            startedAt: null,
            stoppedReason: null,
          },
        ],
      });
    }
    return new Response('{}', { status: 404 });
  });
});

describe('golden-path acceptance', () => {
  it('mounts the full App tree against a mocked backend', async () => {
    render(<App />);

    // Auth gate releases → the workspace rail draws the signed-in user's menu.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Alice/ })).toBeTruthy();
    });

    // The board was read and reached the rail: the agent's name is the one
    // `/api/workspace/state` sent, not the chat agent list's display name.
    expect(screen.getByRole('button', { name: /Scribe/ })).toBeTruthy();

    // App wired its create-agent door through to the shell.
    expect(screen.getByRole('button', { name: /New agent/ })).toBeTruthy();

    // `/` resolved to the Today view — the main pane, not just the rail.
    await waitFor(() => {
      expect(screen.getByRole('group', { name: 'Your queue' })).toBeTruthy();
    });

    // Neither the sign-in page nor a load failure is on screen.
    expect(screen.queryByText(/Sign in with Google/i)).toBeNull();
    expect(screen.queryByText(/We could not load your workspace/i)).toBeNull();
  });
});
