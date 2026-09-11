/**
 * SessionHeader — sticky top bar with title + actions (Task 16).
 *
 * Behaviors under test:
 *
 *   1. Renders the active session's title from `sessionStoreActions`.
 *
 *   2. The title offers no rename — neither an editor nor a request — while
 *      the backend has no route to save one (TASK-337 / audit C2).
 *
 *   3. The agent chip renders in the header-left slot.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
      agent_id: 'ax',
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

  /**
   * TASK-337 / audit C2 — these replace the rename tests that used to live
   * here.
   *
   * They were green and they were testing a lie: `PATCH /api/chat/sessions/:id`
   * is not a route the server registers (`routes-chat.ts` has GET and DELETE on
   * `/api/chat/conversations/:id` and nothing else), so against the real backend
   * every rename 404'd, the component restored the old title, and the user's
   * edit vanished with no explanation. The old test passed because `fetchMock`
   * answered a request the real server never would.
   *
   * The affordance is gated until someone answers audit open question 4 — build
   * the endpoint, or park the feature. See `lib/conversation-rename.ts`.
   */
  it('does not offer a rename it cannot perform', () => {
    render(<SessionHeader />);
    const title = screen.getByTestId('session-header-title');
    fireEvent.click(title);

    // No edit mode...
    expect(title.getAttribute('contenteditable')).toBeNull();
    // ...and nothing that advertises the title as editable.
    expect(title.className).not.toContain('cursor-text');
    expect(title.className).not.toContain('hover:bg-muted');
  });

  it('issues no request when the gated title is clicked and typed into', () => {
    render(<SessionHeader />);
    const title = screen.getByTestId('session-header-title');
    fireEvent.click(title);
    title.textContent = 'wont save';
    fireEvent.keyDown(title, { key: 'Enter' });
    fireEvent.blur(title);

    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/chat/sessions/s-1',
      expect.anything(),
    );
  });

  it('renders the agent chip in the header-left slot', () => {
    const { container } = render(<SessionHeader />);
    // AgentChip moved from Sidebar to SessionHeader per the design (Tide Sessions.html).
    expect(container.querySelector('.agent-chip')).toBeTruthy();
  });

  /*
   * REMOVED with the gate: 'parent re-render during rename does not clobber
   * typed text'.
   *
   * It guarded something real and non-obvious — the `useEffect` that seeds the
   * contenteditable deliberately excludes `title` from its dep array, because
   * re-seeding on a parent-driven title change erases whatever the user is
   * halfway through typing. That subtlety is still in `SessionHeader`, behind
   * the gate.
   *
   * It is deleted rather than skipped because it can only pass against a
   * `fetchMock` answering a PATCH the real server does not route, and a green
   * test for an unreachable path is worse than no test. **Whoever ungates
   * rename (audit open question 4) should restore this test with it** — that is
   * the whole reason this note exists instead of a silent deletion.
   */
});
