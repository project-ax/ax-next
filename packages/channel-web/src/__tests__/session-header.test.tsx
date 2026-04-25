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

  it('double-click enters rename mode; Enter commits via PATCH', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    render(<SessionHeader />);
    const title = screen.getByTestId('session-header-title');
    fireEvent.doubleClick(title);
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
    fireEvent.doubleClick(title);
    title.textContent = 'wont save';
    fireEvent.keyDown(title, { key: 'Escape' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders New Session button', () => {
    render(<SessionHeader />);
    expect(screen.getByLabelText(/new session/i)).toBeTruthy();
  });
});
