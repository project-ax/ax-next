/**
 * RoutinesList — Phase D Task 11.
 *
 * Pinned behaviors:
 *   - Empty list renders the "No routines yet" empty state and links to
 *     the on-disk path docs.
 *   - Fires are lazy-loaded: the recent-fires GET only happens on first
 *     expand of a row, not on initial mount.
 *   - The lazy-fires cache is keyed by `agentId::path` so re-expanding
 *     the same row does NOT re-fetch.
 *   - Server-supplied strings (routine name, error) render via React's
 *     default text escaping — they never reach the DOM as live HTML.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RoutinesList } from '../components/routines/RoutinesList';

const fetchMock = vi.fn();
// Capture the platform fetch so afterEach can restore it — see
// fire-now-control.test.tsx for the rationale.
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = originalFetch;
});

function mockJsonOnce(status: number, body: unknown): void {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

const sampleRoutine = {
  agentId: 'agt_a',
  path: 'heartbeat.md',
  name: 'heartbeat',
  description: 'every 24h',
  trigger: { kind: 'interval', every: '24h' },
  conversation: 'shared',
  lastStatus: 'ok',
  lastError: null,
  lastRunAt: '2026-05-17T00:00:00.000Z',
};

describe('RoutinesList', () => {
  it('renders the empty state when the server returns an empty list', async () => {
    mockJsonOnce(200, { routines: [] });
    render(<RoutinesList onFired={() => {}} />);
    await waitFor(() => expect(screen.getByText(/No routines yet/i)).toBeTruthy());
  });

  it('renders one row per routine and does NOT fetch fires on mount', async () => {
    mockJsonOnce(200, { routines: [sampleRoutine] });
    render(<RoutinesList onFired={() => {}} />);
    await waitFor(() => expect(screen.getByText('heartbeat')).toBeTruthy());
    // Only the list call happened — no /fires call until a row is expanded.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('/settings/routines');
  });

  it('lazy-loads fires on first expand', async () => {
    mockJsonOnce(200, { routines: [sampleRoutine] });
    render(<RoutinesList onFired={() => {}} />);
    await waitFor(() => expect(screen.getByText('heartbeat')).toBeTruthy());

    mockJsonOnce(200, {
      fires: [
        {
          id: 1,
          agentId: 'agt_a',
          path: 'heartbeat.md',
          firedAt: '2026-05-17T01:00:00.000Z',
          triggerSource: 'tick',
          status: 'ok',
          error: null,
          conversationId: 'cnv',
          renderedPrompt: 'hello world',
        },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: /Expand heartbeat/i }));
    await waitFor(() => expect(screen.getByText(/hello world/)).toBeTruthy());

    // Second call: the recent-fires GET. URL contains the agentId and path.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firesUrl = fetchMock.mock.calls[1]![0] as string;
    expect(firesUrl).toContain('/settings/routines/agt_a/fires');
    expect(firesUrl).toContain('path=heartbeat.md');
  });

  it('does NOT re-fetch fires when the same row is re-expanded', async () => {
    mockJsonOnce(200, { routines: [sampleRoutine] });
    render(<RoutinesList onFired={() => {}} />);
    await waitFor(() => expect(screen.getByText('heartbeat')).toBeTruthy());

    mockJsonOnce(200, { fires: [] });
    fireEvent.click(screen.getByRole('button', { name: /Expand heartbeat/i }));
    await waitFor(() =>
      expect(screen.getByText(/No fires yet/i)).toBeTruthy(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Collapse.
    fireEvent.click(screen.getByRole('button', { name: /Collapse heartbeat/i }));

    // Re-expand: cached, so no additional fetch.
    fireEvent.click(screen.getByRole('button', { name: /Expand heartbeat/i }));
    await waitFor(() =>
      expect(screen.getByText(/No fires yet/i)).toBeTruthy(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('renders a server-supplied routine name as plain text', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    mockJsonOnce(200, { routines: [{ ...sampleRoutine, name: hostile }] });
    const { container } = render(<RoutinesList onFired={() => {}} />);
    await waitFor(() => expect(screen.getByText(hostile)).toBeTruthy());
    // The string lives in textContent only; no <img> reaches the DOM.
    expect(container.querySelector('img')).toBeNull();
  });

  it('surfaces a list-level error from the server', async () => {
    mockJsonOnce(500, { error: { message: 'boom' } });
    render(<RoutinesList onFired={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Error: boom/)).toBeTruthy());
  });
});
