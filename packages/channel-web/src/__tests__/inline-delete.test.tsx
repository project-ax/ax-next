/**
 * Inline delete confirm — clicking "delete" in the row-menu replaces the
 * row's contents (in place, same 34px height) with a confirm UI: a
 * `delete this session?` label, a cancel button, and a delete button.
 *
 * Three behaviors under test (Task 14):
 *
 *   1. Open row menu, click delete -> row swaps to .confirming-delete
 *      with the right text + 2 buttons. Row still 34px. (CSS inline
 *      style on the row enforces height; jsdom won't compute heights,
 *      but we assert the row carries the .confirming-delete class which
 *      maps to the same height in the stylesheet.)
 *
 *   2. Click "delete" button -> DELETE called -> list re-fetches
 *      (verified by fetch-mock ordering).
 *
 *   3. 5s auto-revert: open confirm, advance fake timers 5000ms, the
 *      .confirming-delete state clears and the original row is back.
 *
 * To open the row-menu in tests we surface `data-testid="row-menu-rename"`
 * and `data-testid="row-menu-delete"` buttons when the menu is open. The
 * menu is opened by clicking the `.session-row-more` (`⋯`) button.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { SessionList } from '../components/SessionList';
import { agentStoreActions } from '../lib/agent-store';

const fetchMock = vi.fn();

const seedAgents = () =>
  agentStoreActions.setAgents([
    {
      id: 'tide',
      owner_id: 't1',
      owner_type: 'team',
      name: 'tide',
      desc: '',
      color: '#7aa6c9',
      tag: 'work',
      system_prompt: '',
      allowed_tools: [],
      mcp_config_ids: [],
      model: '',
      created_at: 0,
      updated_at: 0,
    },
  ]);

const seedOneSession = (id = 's-1', title = 'old title') => {
  // The list endpoint is /api/chat/conversations (Task 19) and returns
  // a flat array of camelCase Conversation rows.
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => [
      {
        conversationId: id,
        userId: 'u2',
        agentId: 'tide',
        title,
        activeSessionId: null,
        activeReqId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
  });
};

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  seedAgents();
});

afterEach(() => {
  // In case a test enabled fake timers, restore so the next setup
  // (and the global cleanup hook) sees real timers.
  vi.useRealTimers();
});

const openRowMenu = (container: HTMLElement) => {
  const more = container.querySelector('.session-row-more') as HTMLElement;
  expect(more).toBeTruthy();
  act(() => {
    fireEvent.click(more);
  });
};

describe('Inline delete confirm', () => {
  it('clicking delete in the row-menu swaps row to .confirming-delete', async () => {
    seedOneSession('s-1', 'old title');
    const { container } = render(<SessionList />);
    await waitFor(() => screen.getByText('old title'));

    openRowMenu(container);
    const deleteBtn = await screen.findByTestId('row-menu-delete');
    act(() => {
      fireEvent.click(deleteBtn);
    });

    const row = container.querySelector(
      '.session-row.confirming-delete',
    ) as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.dataset.sessionId).toBe('s-1');
    expect(
      row.querySelector('.session-row-confirm-text')?.textContent,
    ).toMatch(/delete this session\?/);
    expect(row.querySelector('.session-row-confirm-cancel')).toBeTruthy();
    expect(row.querySelector('.session-row-confirm-delete')).toBeTruthy();
  });

  it('clicking confirm "delete" issues DELETE and re-fetches the list', async () => {
    seedOneSession('s-1', 'old title');
    const { container } = render(<SessionList />);
    await waitFor(() => screen.getByText('old title'));

    openRowMenu(container);
    const menuDelete = await screen.findByTestId('row-menu-delete');
    act(() => {
      fireEvent.click(menuDelete);
    });

    // Now the confirm UI is up. Click confirm "delete" -> DELETE + re-fetch.
    fetchMock.mockResolvedValueOnce({ ok: true, status: 204 }); // DELETE
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    }); // GET /api/chat/conversations re-fetch

    const confirmDelete = container.querySelector(
      '.session-row-confirm-delete',
    ) as HTMLElement;
    expect(confirmDelete).toBeTruthy();
    act(() => {
      fireEvent.click(confirmDelete);
    });

    await waitFor(() => {
      const deleteCall = fetchMock.mock.calls.find(
        (c) =>
          typeof c[0] === 'string' &&
          c[0] === '/api/chat/conversations/s-1' &&
          (c[1] as RequestInit | undefined)?.method === 'DELETE',
      );
      expect(deleteCall).toBeTruthy();
    });

    // After DELETE, the list re-fetches (a second GET on
    // /api/chat/conversations is queued by the version bump).
    await waitFor(() => {
      const getCalls = fetchMock.mock.calls.filter(
        (c) =>
          typeof c[0] === 'string' &&
          c[0] === '/api/chat/conversations' &&
          (!(c[1] as RequestInit | undefined)?.method ||
            (c[1] as RequestInit | undefined)?.method === 'GET'),
      );
      expect(getCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('5s auto-revert clears .confirming-delete back to the normal row', async () => {
    seedOneSession('s-1', 'old title');
    const { container } = render(<SessionList />);
    // Wait for the initial fetch + render under real timers so React can
    // settle effects without fighting fake timers for microtasks.
    await waitFor(() =>
      expect(container.querySelector('.session-row-title')?.textContent).toBe(
        'old title',
      ),
    );

    openRowMenu(container);
    const menuDelete = (await screen.findByTestId(
      'row-menu-delete',
    )) as HTMLElement;

    // Switch to fake timers AFTER we have the menu element. The 5s
    // setTimeout is scheduled in a useEffect that fires in this act
    // block, then we advance past it.
    vi.useFakeTimers();
    try {
      act(() => {
        fireEvent.click(menuDelete);
      });
      expect(
        container.querySelector('.session-row.confirming-delete'),
      ).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(5000);
      });

      expect(
        container.querySelector('.session-row.confirming-delete'),
      ).toBeNull();
      // Original row is back, no DELETE was called.
      expect(container.querySelector('.session-row-title')?.textContent).toBe(
        'old title',
      );
      const deleteCall = fetchMock.mock.calls.find(
        (c) => (c[1] as RequestInit | undefined)?.method === 'DELETE',
      );
      expect(deleteCall).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
