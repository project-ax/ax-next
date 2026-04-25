/**
 * Inline rename — double-click title or row-menu "rename" puts the
 * `.session-row-title` into contenteditable mode. Enter / blur commit
 * via `PATCH /api/chat/sessions/:id { title }`. Esc cancels with no
 * PATCH, reverting to the original title.
 *
 * Three behaviors under test (Task 14):
 *
 *   1. Double-click title -> contenteditable + focus. Type, press Enter
 *      -> PATCH called with the new title. Row exits rename mode.
 *
 *   2. Esc cancels -- no PATCH, original title still shown.
 *
 *   3. Blur commits same as Enter.
 *
 * jsdom note: `contenteditable="plaintext-only"` is partially supported.
 * We assert via `getAttribute('contenteditable')` so either `"plaintext-only"`
 * or `"true"` would satisfy callers; the component picks whichever is
 * needed. We read the typed value via `textContent`, which is what the
 * commit handler also uses.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
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
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      sessions: [
        {
          id,
          title,
          agent_id: 'tide',
          updated_at: Date.now(),
          created_at: Date.now(),
          user_id: 'u2',
        },
      ],
    }),
  });
};

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  seedAgents();
});

describe('Inline rename', () => {
  it('double-click title -> contenteditable + Enter commits via PATCH', async () => {
    seedOneSession('s-1', 'old title');
    const { container } = render(<SessionList />);
    await waitFor(() => screen.getByText('old title'));

    const titleEl = container.querySelector(
      '.session-row-title',
    ) as HTMLElement;
    expect(titleEl).toBeTruthy();

    // Enter rename mode via double-click.
    act(() => {
      fireEvent.doubleClick(titleEl);
    });
    expect(titleEl.getAttribute('contenteditable')).toMatch(
      /plaintext-only|true/,
    );

    // Type the new title, press Enter.
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    // Subsequent sessions re-fetch (after bumpVersion) -- supply a stub.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        sessions: [
          {
            id: 's-1',
            title: 'new title',
            agent_id: 'tide',
            updated_at: Date.now(),
            created_at: Date.now(),
            user_id: 'u2',
          },
        ],
      }),
    });

    titleEl.textContent = 'new title';
    act(() => {
      fireEvent.keyDown(titleEl, { key: 'Enter' });
    });

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        (c) =>
          typeof c[0] === 'string' &&
          c[0] === '/api/chat/sessions/s-1' &&
          (c[1] as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(patchCall).toBeTruthy();
      const body = JSON.parse(
        (patchCall![1] as RequestInit).body as string,
      ) as { title: string };
      expect(body.title).toBe('new title');
    });

    // Row exits rename mode.
    await waitFor(() => {
      const t = container.querySelector('.session-row-title') as HTMLElement;
      expect(t.getAttribute('contenteditable')).toBeNull();
    });
  });

  it('Esc cancels without PATCH and restores original title', async () => {
    seedOneSession('s-1', 'old title');
    const { container } = render(<SessionList />);
    await waitFor(() => screen.getByText('old title'));

    const titleEl = container.querySelector(
      '.session-row-title',
    ) as HTMLElement;

    act(() => {
      fireEvent.doubleClick(titleEl);
    });
    expect(titleEl.getAttribute('contenteditable')).toMatch(
      /plaintext-only|true/,
    );

    titleEl.textContent = 'mid-edit garbage';
    act(() => {
      fireEvent.keyDown(titleEl, { key: 'Escape' });
    });

    // No PATCH after the initial GET fetch.
    const patchCall = fetchMock.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === 'PATCH',
    );
    expect(patchCall).toBeUndefined();

    // Title visually back to original.
    await waitFor(() => {
      const t = container.querySelector('.session-row-title') as HTMLElement;
      expect(t.getAttribute('contenteditable')).toBeNull();
      expect(t.textContent).toBe('old title');
    });
  });

  it('Blur commits same as Enter', async () => {
    seedOneSession('s-1', 'old title');
    const { container } = render(<SessionList />);
    await waitFor(() => screen.getByText('old title'));

    const titleEl = container.querySelector(
      '.session-row-title',
    ) as HTMLElement;

    act(() => {
      fireEvent.doubleClick(titleEl);
    });

    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        sessions: [
          {
            id: 's-1',
            title: 'blurred title',
            agent_id: 'tide',
            updated_at: Date.now(),
            created_at: Date.now(),
            user_id: 'u2',
          },
        ],
      }),
    });

    titleEl.textContent = 'blurred title';
    act(() => {
      fireEvent.blur(titleEl);
    });

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        (c) =>
          typeof c[0] === 'string' &&
          c[0] === '/api/chat/sessions/s-1' &&
          (c[1] as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(patchCall).toBeTruthy();
      const body = JSON.parse(
        (patchCall![1] as RequestInit).body as string,
      ) as { title: string };
      expect(body.title).toBe('blurred title');
    });
  });
});
