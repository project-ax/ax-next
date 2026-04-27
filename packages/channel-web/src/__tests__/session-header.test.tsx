/**
 * SessionHeader — sticky top bar with title + actions (Task 16).
 *
 * Behaviors under test:
 *
 *   1. Renders the active session's title from `sessionStoreActions`.
 *
 *   2. Double-click the title -> contenteditable mode. Enter commits via
 *      `PATCH /api/chat/sessions/:id { title }`.
 *
 *   3. Esc cancels rename — no PATCH, original title restored.
 *
 *   4. The "new session" action button is rendered (the ⌘N affordance).
 *
 * jsdom note: `contenteditable="plaintext-only"` is partially supported,
 * mirroring the SessionRow rename — we set the attribute and read back
 * via `textContent`, which is what the commit handler also uses.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SessionHeader } from '../components/SessionHeader';
import { sessionStoreActions } from '../lib/session-store';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  // Default: agents fetch returns empty list; PATCH succeeds.
  // Default catch-all: empty agent list (matches both legacy
  // `/api/agents` shape AND the new `/api/chat/agents` shape — the
  // latter is a flat array, the former wraps it in `{ agents }`).
  fetchMock.mockResolvedValue({ ok: true, json: async () => [] });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  sessionStoreActions.setSessions([
    {
      id: 's-1',
      title: 'first thread',
      agent_id: 'tide',
      updated_at: 1,
      created_at: 1,
      user_id: 'u2',
    },
  ]);
  sessionStoreActions.setActiveSession('s-1', false);
});

describe('SessionHeader', () => {
  it('renders the active session title', () => {
    render(<SessionHeader />);
    expect(screen.getByTestId('session-header-title').textContent).toBe(
      'first thread',
    );
  });

  it('single-click enters rename mode; Enter commits via PATCH', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    render(<SessionHeader />);
    const title = screen.getByTestId('session-header-title');
    fireEvent.click(title);
    expect(title.getAttribute('contenteditable')).toMatch(
      /plaintext-only|true/,
    );
    title.textContent = 'renamed';
    fireEvent.keyDown(title, { key: 'Enter' });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/chat/sessions/s-1',
        expect.objectContaining({ method: 'PATCH' }),
      );
    });
  });

  it('Esc cancels rename — no PATCH', () => {
    render(<SessionHeader />);
    const title = screen.getByTestId('session-header-title');
    fireEvent.click(title);
    title.textContent = 'wont save';
    fireEvent.keyDown(title, { key: 'Escape' });
    // No PATCH should have fired — only the /api/agents hydration call.
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/chat/sessions/s-1',
      expect.anything(),
    );
  });

  it('renders the agent chip in the header-left slot', () => {
    const { container } = render(<SessionHeader />);
    // AgentChip moved from Sidebar to SessionHeader per Tide Sessions.html.
    expect(container.querySelector('.agent-chip')).toBeTruthy();
  });

  it('parent re-render during rename does not clobber typed text', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    render(<SessionHeader />);
    const title = screen.getByTestId('session-header-title');
    fireEvent.click(title);

    // User types into the contentEditable buffer.
    title.textContent = 'partially typed';

    // A parent re-render fires (e.g., session-store update from a
    // bumpVersion() on another row, or a /api/agents poll). Without the
    // fix, React reconciles `{title}` back into the text node and erases
    // the user's edit.
    sessionStoreActions.setSessions([
      {
        id: 's-1',
        title: 'first thread',
        agent_id: 'tide',
        updated_at: 2,
        created_at: 1,
        user_id: 'u2',
      },
    ]);

    // The typed text should still be there.
    expect(title.textContent).toBe('partially typed');

    // Confirm Enter still commits the typed text.
    fireEvent.keyDown(title, { key: 'Enter' });
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        ([, opts]) => (opts as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(patch).toBeTruthy();
      const body = JSON.parse((patch![1] as RequestInit).body as string) as {
        title: string;
      };
      expect(body.title).toBe('partially typed');
    });
  });
});
