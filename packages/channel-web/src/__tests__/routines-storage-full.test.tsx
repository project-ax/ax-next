/**
 * The routines screen, end to end, when a save or a delete is turned away
 * (TASK-719).
 *
 * `routines-client.test.ts` pins what `lib/routines` turns a failed response
 * into. This drives the REAL `RoutinesList` and the REAL `RoutineEditor` against
 * a stubbed `fetch`, to pin the thing a person actually reads: the words under
 * Update, and the words in the delete dialog. Neither component needed a change
 * for this, because both already print `err.message` verbatim; what was wrong
 * was the message they were handed ("HTTP 400", "HTTP 413").
 *
 * Every body below is what `@ax/routines-admin-routes` REALLY sends: a string
 * `error`, and for the storage limit `{ error: 'storage-full', message }`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// The create-mode agent picker is not on the edit path, but the editor imports it.
vi.mock('@/lib/agents', () => ({ listChatAgents: vi.fn() }));

import { RoutinesList } from '../components/routines/RoutinesList';

const SAVE_FULL =
  "We couldn't save that routine because your storage is full. An admin can make more room, then you can try again.";
const REMOVE_FULL =
  "We couldn't remove that routine because your storage is full. An admin can make more room, then you can try again.";

const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = originalFetch;
});

function reply(status: number, body: unknown): void {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

const heartbeat = {
  agentId: 'agt_a',
  path: '.ax/routines/heartbeat.md',
  name: 'heartbeat',
  description: 'every 24h',
  trigger: { kind: 'interval', every: '24h' },
  conversation: 'shared',
  lastStatus: 'ok',
  lastError: null,
  lastWarning: null,
  lastRunAt: '2026-05-17T00:00:00.000Z',
  promptBody: 'do the thing',
  activeHours: null,
  silenceToken: null,
  silenceMaxChars: 300,
};

async function openEditor(): Promise<void> {
  reply(200, { routines: [heartbeat] });
  render(<RoutinesList onFired={() => {}} />);
  await waitFor(() => expect(screen.getByText('heartbeat')).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Edit heartbeat' }));
  await screen.findByRole('button', { name: 'Save changes' });
}

function putCalls(): unknown[][] {
  return fetchMock.mock.calls.filter(
    (c) => (c[1] as RequestInit | undefined)?.method === 'PUT',
  );
}

describe('RoutinesList and RoutineEditor when a save is turned away', () => {
  it('shows the storage-full sentence under Update, and keeps the editor open', async () => {
    await openEditor();
    reply(413, { error: 'storage-full', message: SAVE_FULL });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText(SAVE_FULL)).toBeTruthy();
    // Nothing else is said: no status, no code, no path.
    expect(screen.queryByText(/HTTP 4\d\d/)).toBeNull();
    expect(screen.queryByText(/storage-full/)).toBeNull();
    // The editor is still there, so they keep what they typed and can try again.
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();
    expect(putCalls()).toHaveLength(1);
  });

  it('says the same sentence from our own words when the server sent none', async () => {
    await openEditor();
    reply(413, { error: 'storage-full' });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(SAVE_FULL)).toBeTruthy();
  });

  it("shows a validator's reason under Update, not a bare status (the older bug)", async () => {
    await openEditor();
    reply(400, { error: '.ax/routines/heartbeat.md: interval.every: minimum is 60s' });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(
      await screen.findByText('.ax/routines/heartbeat.md: interval.every: minimum is 60s'),
    ).toBeTruthy();
    expect(screen.queryByText(/HTTP 400/)).toBeNull();
    // And it is NOT told their storage is full: that is a different problem.
    expect(screen.queryByText(/storage is full/)).toBeNull();
  });
});

describe('RoutinesList when a delete is turned away', () => {
  async function confirmDelete(): Promise<void> {
    reply(200, { routines: [heartbeat] });
    render(<RoutinesList onFired={() => {}} />);
    await waitFor(() => expect(screen.getByText('heartbeat')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Delete heartbeat' }));
    await waitFor(() => expect(screen.getByText(/Delete routine\?/i)).toBeTruthy());
  }

  it('shows the storage-full sentence in the dialog, which stays open', async () => {
    await confirmDelete();
    reply(413, { error: 'storage-full', message: REMOVE_FULL });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText(REMOVE_FULL)).toBeTruthy();
    expect(screen.queryByText(/HTTP 4\d\d/)).toBeNull();
    // Still asking, so a person can cancel or try again once there is room.
    expect(screen.getByText(/Delete routine\?/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
  });

  it('says the REMOVE sentence, not the save one, when the server sent none', async () => {
    await confirmDelete();
    reply(413, { error: 'storage-full' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText(REMOVE_FULL)).toBeTruthy();
    expect(screen.queryByText(SAVE_FULL)).toBeNull();
  });

  it("shows a veto's reason in the dialog, not a bare status", async () => {
    await confirmDelete();
    reply(400, { error: 'a policy said no to removing this routine' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('a policy said no to removing this routine')).toBeTruthy();
    expect(screen.queryByText(/HTTP 400/)).toBeNull();
  });
});
