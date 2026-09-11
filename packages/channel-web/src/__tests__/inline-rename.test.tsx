/**
 * Inline rename — gated off (TASK-337 / audit C2).
 *
 * This file used to hold five green tests for an inline rename that has never
 * worked. The row committed with `PATCH /api/chat/sessions/:id { title }`;
 * `routes-chat.ts` registers GET and DELETE on `/api/chat/conversations/:id`
 * and nothing else, so against the real server every rename 404'd, the row
 * restored the old title, and the user's edit vanished with only a
 * `console.warn` to show for it. `SessionHeader`'s TODO admitted as much.
 *
 * The tests passed because `fetchMock` answered a request the real backend
 * never would — which is exactly how half-wired code survives review: it looks
 * finished, and it has a full suite agreeing with it.
 *
 * So they are replaced, not adjusted. What is worth guarding now is that the
 * affordance is not offered at all, on either surface that had it — the row's
 * double-click AND its "Rename" menu item, plus the header's click-to-edit
 * (see `session-header.test.tsx`).
 *
 * Whether the PATCH endpoint gets built or the feature is formally parked is
 * **audit open question 4** — a human's decision, deliberately not made here.
 * `lib/conversation-rename.ts` is the one line to flip, and the deleted
 * behaviour tests should come back with it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { SessionList } from '../components/SessionList';
import { agentStoreActions } from '../lib/agent-store';

const fetchMock = vi.fn();

const seedAgents = () =>
  agentStoreActions.setAgents([
    {
      id: 'ax',
      owner_id: 't1',
      owner_type: 'team',
      name: 'ax',
      desc: '',
      color: '#7aa6c9',
      tag: 'work',
      allowed_tools: [],
      mcp_config_ids: [],
      model: '',
      created_at: 0,
      updated_at: 0,
    },
  ]);

const seedOneSession = (id = 's-1', title = 'old title') => {
  // The list endpoint is /api/chat/conversations and returns a flat
  // array of camelCase Conversation rows.
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => [
      {
        conversationId: id,
        userId: 'u2',
        agentId: 'ax',
        title,
        activeSessionId: null,
        activeReqId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
  });
};

/** Any request that would have been the rename. */
const renamePatches = () =>
  fetchMock.mock.calls.filter(
    (c) => (c[1] as RequestInit | undefined)?.method === 'PATCH',
  );

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  seedAgents();
});

describe('Inline rename is not offered while it cannot work', () => {
  it('double-clicking a row title does not open an editor or send anything', async () => {
    seedOneSession('s-1', 'old title');
    const { container } = render(<SessionList />);
    await waitFor(() => screen.getByText('old title'));

    const titleEl = container.querySelector('.session-row-title') as HTMLElement;
    expect(titleEl).toBeTruthy();

    act(() => {
      fireEvent.doubleClick(titleEl);
    });

    expect(titleEl.getAttribute('contenteditable')).toBeNull();
    expect(titleEl.textContent).toBe('old title');
    expect(renamePatches()).toHaveLength(0);
  });

  it('offers no Rename item in the row menu', async () => {
    seedOneSession('s-1', 'old title');
    const { container } = render(<SessionList />);
    await waitFor(() => screen.getByText('old title'));

    const menuBtn = container.querySelector(
      '[aria-label="more"]',
    ) as HTMLElement;
    expect(menuBtn).toBeTruthy();
    act(() => {
      fireEvent.click(menuBtn);
    });

    // The menu really did open — otherwise the assertion below is vacuous.
    expect(screen.getByTestId('row-menu-delete')).toBeTruthy();

    // Hidden rather than disabled: a greyed-out "Rename" only raises the
    // question we have no good answer to. Delete stays — it works.
    expect(screen.queryByTestId('row-menu-rename')).toBeNull();
  });
});
