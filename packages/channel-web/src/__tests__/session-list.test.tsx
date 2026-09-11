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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { SessionList } from '../components/SessionList';
import { agentStoreActions } from '../lib/agent-store';

const fetchMock = vi.fn();

// Pin the wall clock to noon of a fixed day. The grouping test below builds
// "today" as `now - 1 hour`; without a fake clock that fixture lands on
// yesterday's calendar day whenever the suite runs between 00:00 and 01:00
// local time, and the assertions for the "today" label flake.
const FIXED_NOW = new Date('2026-05-03T12:00:00');

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

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  seedAgents();
  // shouldAdvanceTime keeps setTimeout-driven internals (waitFor polling,
  // act flushes) ticking; freezing it absolutely would deadlock those.
  vi.useFakeTimers({ now: FIXED_NOW.getTime(), shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
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
          agentId: 'ax',
          title: 'today session',
          activeSessionId: null,
          activeReqId: null,
          createdAt: new Date(oneHourAgo).toISOString(),
          updatedAt: new Date(oneHourAgo).toISOString(),
        },
        {
          conversationId: 's-yesterday',
          userId: 'u2',
          agentId: 'ax',
          title: 'yesterday session',
          activeSessionId: null,
          activeReqId: null,
          createdAt: new Date(yesterdayMidday.getTime()).toISOString(),
          updatedAt: new Date(yesterdayMidday.getTime()).toISOString(),
        },
        {
          conversationId: 's-earlier',
          userId: 'u2',
          agentId: 'ax',
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
          agentId: 'ax',
          title: 'one',
          activeSessionId: null,
          activeReqId: null,
          createdAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
        },
        {
          conversationId: 's-2',
          userId: 'u2',
          agentId: 'ax',
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
          agentId: 'ax',
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

/**
 * TASK-337 / audit C1 — an empty list is a CLAIM, and we were making it on no
 * evidence.
 *
 * A failed conversations fetch was swallowed (`if (!res.ok) return;` and a
 * `catch` that only reached `console.warn`), so the sidebar rendered exactly as
 * it does for someone who genuinely has no conversations. The workspace's own
 * H7 rule forbids that, and this is the one place on the surface that broke it.
 * Someone whose history failed to load was quietly told they had none.
 *
 * This is a defect, not a copy nit, so per the Bug Fix Policy it gets the test
 * that would have caught it.
 */
describe('SessionList — a failed fetch is not an empty list', () => {
  it('says the list could not be loaded instead of rendering as empty', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    render(<SessionList />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/couldn.t load your conversations/i);
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
  });

  it('says the same when the request never lands at all', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    render(<SessionList />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/couldn.t load your conversations/i);
  });

  it('recovers the list on Try again, and drops the error', async () => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    render(<SessionList />);
    await screen.findByRole('alert');

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          conversationId: 's-1',
          userId: 'u2',
          agentId: 'ax',
          title: 'recovered session',
          activeSessionId: null,
          activeReqId: null,
          createdAt: new Date(oneHourAgo).toISOString(),
          updatedAt: new Date(oneHourAgo).toISOString(),
        },
      ],
    });
    await act(async () => {
      screen.getByRole('button', { name: /try again/i }).click();
    });

    await waitFor(() => expect(screen.getByText(/recovered session/)).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
