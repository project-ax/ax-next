/**
 * SessionList — day grouping, active row, agent color dot.
 *
 * Three behaviors under test (see Task 13 plan):
 *
 *   1. Sessions group into today / yesterday / earlier by local-TZ
 *      calendar comparison (not "within 24h" arithmetic).
 *
 *   2. The row whose id matches activeSessionId picks up `.active`,
 *      so the accent-bar + bg-deep CSS rules carry.
 *
 *   3. Each row's color dot picks up the matching agent's color (so
 *      the sidebar is scannable across multiple agents).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
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

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  seedAgents();
});

describe('SessionList', () => {
  it('groups sessions by today/yesterday/earlier', async () => {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const yesterdayMidday = new Date();
    yesterdayMidday.setDate(yesterdayMidday.getDate() - 1);
    yesterdayMidday.setHours(12, 0, 0, 0);
    const lastWeek = now - 8 * 24 * 60 * 60 * 1000;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          conversationId: 's-today',
          userId: 'u2',
          agentId: 'tide',
          title: 'today session',
          activeSessionId: null,
          activeReqId: null,
          createdAt: new Date(oneHourAgo).toISOString(),
          updatedAt: new Date(oneHourAgo).toISOString(),
        },
        {
          conversationId: 's-yesterday',
          userId: 'u2',
          agentId: 'tide',
          title: 'yesterday session',
          activeSessionId: null,
          activeReqId: null,
          createdAt: new Date(yesterdayMidday.getTime()).toISOString(),
          updatedAt: new Date(yesterdayMidday.getTime()).toISOString(),
        },
        {
          conversationId: 's-earlier',
          userId: 'u2',
          agentId: 'tide',
          title: 'earlier session',
          activeSessionId: null,
          activeReqId: null,
          createdAt: new Date(lastWeek).toISOString(),
          updatedAt: new Date(lastWeek).toISOString(),
        },
      ],
    });
    render(<SessionList />);
    await waitFor(() => {
      expect(screen.getByText(/today session/)).toBeTruthy();
    });
    expect(screen.getByText(/yesterday session/)).toBeTruthy();
    expect(screen.getByText(/earlier session/)).toBeTruthy();
    // labels present
    expect(screen.getByText('today')).toBeTruthy();
    expect(screen.getByText('yesterday')).toBeTruthy();
    expect(screen.getByText('earlier')).toBeTruthy();
  });

  it('row gets .active class when its id matches activeSessionId', async () => {
    const now = Date.now();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          conversationId: 's-1',
          userId: 'u2',
          agentId: 'tide',
          title: 'one',
          activeSessionId: null,
          activeReqId: null,
          createdAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
        },
        {
          conversationId: 's-2',
          userId: 'u2',
          agentId: 'tide',
          title: 'two',
          activeSessionId: null,
          activeReqId: null,
          createdAt: new Date(now - 1000).toISOString(),
          updatedAt: new Date(now - 1000).toISOString(),
        },
      ],
    });
    const { container } = render(<SessionList />);
    await waitFor(() => screen.getByText('one'));
    // Activate s-2 via the store action under test:
    const { sessionStoreActions } = await import('../lib/session-store');
    act(() => sessionStoreActions.setActiveSession('s-2', false));
    const rows = container.querySelectorAll('.session-row');
    expect(rows).toHaveLength(2);
    expect((rows[0] as HTMLElement).dataset.sessionId).toBe('s-1');
    // The active one must carry .active
    const active = container.querySelector('.session-row.active') as HTMLElement;
    expect(active.dataset.sessionId).toBe('s-2');
  });

  it('row dot uses the agent color', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          conversationId: 's-1',
          userId: 'u2',
          agentId: 'tide',
          title: 'one',
          activeSessionId: null,
          activeReqId: null,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    const { container } = render(<SessionList />);
    await waitFor(() => screen.getByText('one'));
    const dot = container.querySelector('.session-row-dot') as HTMLElement;
    // Inline style set; jsdom normalizes hex to rgb but the substring match is enough for our test.
    expect(dot.getAttribute('style') ?? dot.style.cssText).toMatch(
      /#7aa6c9|122,\s*166,\s*201/i,
    );
  });
});
