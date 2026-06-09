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

// Mock the shared editor so these tests focus on the list's create/edit/delete
// wiring, not the editor internals (covered by RoutineEditor.test.tsx).
vi.mock('@/components/routines/RoutineEditor', () => ({
  RoutineEditor: ({ onCancel }: { onCancel: () => void }) => (
    <div data-testid="routine-editor">
      <button onClick={onCancel}>Cancel editor</button>
    </div>
  ),
}));

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
  promptBody: 'do the thing',
  activeHours: null,
  silenceToken: null,
  silenceMaxChars: 300,
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

  const webhookRoutine = {
    agentId: 'agt-1',
    path: '.ax/routines/gh-webhook.md',
    name: 'gh-webhook',
    description: 'GitHub push webhook',
    trigger: {
      kind: 'webhook',
      path: '/gh',
      events: ['push'],
      hmac: {
        secretRef: 'routine:agt-1:.ax/routines/gh-webhook.md:hmac',
        header: 'X-Hub-Signature-256',
        algorithm: 'sha256',
      },
    },
    conversation: 'shared',
    lastStatus: 'ok',
    lastError: null,
    lastRunAt: '2026-05-17T00:00:00.000Z',
    promptBody: 'handle it',
    activeHours: null,
    silenceToken: null,
    silenceMaxChars: 300,
  };

  // Route fetches by URL — a webhook row triggers a routines list, a
  // webhook-token GET, and the CredentialSlotRow status check, in
  // non-deterministic order.
  function mockWebhookRow(token = 'wh-TOKEN'): void {
    const ok = (body: unknown): Response =>
      ({ ok: true, status: 200, json: async () => body }) as Response;
    fetchMock.mockImplementation((url: string) => {
      if (url === '/settings/routines') return Promise.resolve(ok({ routines: [webhookRoutine] }));
      if (url.includes('/webhook-token')) return Promise.resolve(ok({ token }));
      return Promise.resolve(ok({ credentials: [] })); // CredentialSlotRow
    });
  }

  it('shows an HMAC CredentialSlotRow for webhook-triggered routines', async () => {
    mockWebhookRow();
    render(<RoutinesList onFired={() => {}} />);

    // The HMAC label (slot label from CredentialSlotRow) should appear
    expect(await screen.findByText('HMAC', { selector: 'span' })).toBeInTheDocument();
    // The "Set credential" button from CredentialSlotRow should appear
    expect(await screen.findByRole('button', { name: /set credential/i })).toBeInTheDocument();
  });

  it('shows the webhook receiver URL with a copy button for a webhook routine', async () => {
    mockWebhookRow('wh-TOKEN');
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    render(<RoutinesList onFired={() => {}} />);

    // The full receiver URL ends with /webhooks/<token><routine-path>.
    const code = await screen.findByText(/\/webhooks\/wh-TOKEN\/gh$/);
    expect(code).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /copy webhook url/i }));
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('/webhooks/wh-TOKEN/gh'),
    );
  });

  it('does NOT show an HMAC CredentialSlotRow for interval-triggered routines', async () => {
    mockJsonOnce(200, { routines: [sampleRoutine] });

    render(<RoutinesList onFired={() => {}} />);

    // Wait for the routine name to appear
    await waitFor(() => expect(screen.getByText('heartbeat')).toBeTruthy());
    // No HMAC label for an interval routine
    expect(screen.queryByText(/HMAC/i)).toBeNull();
  });

  // ── create / edit / delete affordances ──────────────────────────────────

  it('clicking "New routine" opens the editor', async () => {
    mockJsonOnce(200, { routines: [] });
    render(<RoutinesList onFired={() => {}} />);
    await waitFor(() => expect(screen.getByText(/No routines yet/i)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /new routine/i }));
    expect(await screen.findByTestId('routine-editor')).toBeTruthy();
  });

  it('clicking a row\'s Edit opens the editor', async () => {
    mockJsonOnce(200, { routines: [sampleRoutine] });
    render(<RoutinesList onFired={() => {}} />);
    await waitFor(() => expect(screen.getByText('heartbeat')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Edit heartbeat' }));
    expect(await screen.findByTestId('routine-editor')).toBeTruthy();
  });

  it('clicking a row\'s Delete confirms, then DELETEs the routine file', async () => {
    mockJsonOnce(200, { routines: [sampleRoutine] }); // initial list
    render(<RoutinesList onFired={() => {}} />);
    await waitFor(() => expect(screen.getByText('heartbeat')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Delete heartbeat' }));
    await waitFor(() => expect(screen.getByText(/Delete routine\?/i)).toBeTruthy());

    // DELETE 204, then the list reloads (empty).
    fetchMock.mockResolvedValueOnce({ ok: true, status: 204 } as Response);
    mockJsonOnce(200, { routines: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      const del = fetchMock.mock.calls.find(
        (c) => (c[1] as RequestInit | undefined)?.method === 'DELETE',
      );
      expect(del).toBeDefined();
      expect(del![0] as string).toBe('/settings/routines/agt_a?path=heartbeat.md');
    });
  });

  it('does not double-submit when the delete confirm is clicked twice', async () => {
    mockJsonOnce(200, { routines: [sampleRoutine] }); // initial list
    render(<RoutinesList onFired={() => {}} />);
    await waitFor(() => expect(screen.getByText('heartbeat')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Delete heartbeat' }));
    await waitFor(() => expect(screen.getByText(/Delete routine\?/i)).toBeTruthy());

    // Hang the DELETE so the second click lands while the first is in flight —
    // models the double-dispatch observed in the kind walk.
    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
    const confirmBtn = screen.getByRole('button', { name: 'Delete' });
    fireEvent.click(confirmBtn);
    fireEvent.click(confirmBtn);

    // The re-entrancy guard must let exactly one DELETE through.
    const deleteCalls = fetchMock.mock.calls.filter(
      (c) => (c[1] as RequestInit | undefined)?.method === 'DELETE',
    );
    expect(deleteCalls).toHaveLength(1);
  });
});
