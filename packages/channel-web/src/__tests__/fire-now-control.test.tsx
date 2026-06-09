/**
 * FireNowControl — per-row "Fire now" affordance (Phase D Task 11).
 *
 *   - interval/cron routines: clicking the button fires immediately via
 *     `routines.fireNow` (no nested form).
 *   - webhook routines: clicking reveals a JSON textarea; Submit parses
 *     the JSON and POSTs it as `payload`. Invalid JSON surfaces inline.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FireNowControl } from '../components/routines/FireNowControl';
import type { Routine } from '../lib/routines';

const fetchMock = vi.fn();
// Capture the platform fetch so afterEach can restore it. Without this
// the override leaks into adjacent test files when vitest reuses the
// same JSDOM context — any later test that hits real fetch would see
// our mock instead.
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = originalFetch;
});

function mockJson(status: number, body: unknown): void {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

const intervalRoutine: Routine = {
  agentId: 'agt_a',
  path: 'heartbeat.md',
  name: 'heartbeat',
  description: 'every 24h',
  trigger: { kind: 'interval', every: '24h' },
  conversation: 'shared',
  lastStatus: null,
  lastError: null,
  lastRunAt: null,
  promptBody: 'body',
  activeHours: null,
  silenceToken: null,
  silenceMaxChars: 300,
};

const webhookRoutine: Routine = {
  agentId: 'agt_b',
  path: 'on-ping.md',
  name: 'on-ping',
  description: 'webhook',
  trigger: { kind: 'webhook', path: '/hooks/ping' },
  conversation: 'per-fire',
  lastStatus: null,
  lastError: null,
  lastRunAt: null,
  promptBody: 'body',
  activeHours: null,
  silenceToken: null,
  silenceMaxChars: 300,
};

describe('FireNowControl — interval/cron', () => {
  it('clicking "Fire now" POSTs to /settings/routines/:agentId/fire (no payload)', async () => {
    mockJson(200, { fireId: 1, status: 'ok', conversationId: 'cnv' });
    const onFired = vi.fn();
    render(<FireNowControl routine={intervalRoutine} onFired={onFired} />);
    fireEvent.click(screen.getByRole('button', { name: /Fire now/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe('/settings/routines/agt_a/fire');
    const body = JSON.parse(call[1]!.body as string) as Record<string, unknown>;
    expect(body.path).toBe('heartbeat.md');
    expect('payload' in body).toBe(false);
    await waitFor(() => expect(onFired).toHaveBeenCalledTimes(1));
  });

  it('surfaces server error message inline', async () => {
    mockJson(403, { error: { message: 'forbidden' } });
    render(<FireNowControl routine={intervalRoutine} onFired={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Fire now/i }));
    await waitFor(() => expect(screen.getByText('forbidden')).toBeTruthy());
  });
});

describe('FireNowControl — webhook', () => {
  it('clicking "Fire now" reveals an inline JSON form (does NOT fire yet)', () => {
    render(<FireNowControl routine={webhookRoutine} onFired={() => {}} />);
    const trigger = screen.getByRole('button', { name: /Fire now/i });
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByRole('textbox')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Submit/i })).toBeTruthy();
    // No fetch happens yet — only the form opens.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Submit posts the parsed JSON as `payload`', async () => {
    mockJson(200, { fireId: 7, status: 'ok', conversationId: null });
    const onFired = vi.fn();
    render(<FireNowControl routine={webhookRoutine} onFired={onFired} />);
    fireEvent.click(screen.getByRole('button', { name: /Fire now/i }));
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: '{"x":1}' } });
    fireEvent.click(screen.getByRole('button', { name: /Submit/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(
      fetchMock.mock.calls[0]![1]!.body as string,
    ) as { payload?: unknown; path: string };
    expect(body.path).toBe('on-ping.md');
    expect(body.payload).toEqual({ x: 1 });
    await waitFor(() => expect(onFired).toHaveBeenCalledTimes(1));
  });

  it('invalid JSON surfaces an inline error and does NOT POST', () => {
    render(<FireNowControl routine={webhookRoutine} onFired={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Fire now/i }));
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'not json' } });
    fireEvent.click(screen.getByRole('button', { name: /Submit/i }));
    expect(screen.getByText(/Invalid JSON/i)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
