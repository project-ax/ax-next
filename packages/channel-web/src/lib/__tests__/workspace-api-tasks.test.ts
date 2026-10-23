/**
 * `workspaceApi.tasks()` — the Tasks page's one read (TASK-909).
 *
 * The same boundary rule as `decisions()`: a 200 whose body is not the shape
 * the page draws from is a `WorkspaceShapeError`, thrown here, so the page's
 * "couldn't load" card shows instead of a render crash on a null row.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHECK_IN_MISSES } from '@ax/routines-contract';
import { workspaceApi, WorkspaceApiError, WorkspaceShapeError } from '../workspace-api';

function respondWith(body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response);
}

afterEach(() => vi.restoreAllMocks());

const ROW = {
  agentId: 'a-quill',
  agentName: 'Quill',
  routineId: 'r-1',
  name: 'Morning inbox sweep',
  enabled: true,
  task: { status: 'on-track', update: 'Filed 12 receipts', reportedAt: '2026-10-22T08:00:00.000Z' },
  noRecentUpdate: null,
};

const MISS = {
  inARow: 2,
  reason: 'brief-too-long',
  at: '2026-10-22T11:00:00.000Z',
  autoPaused: false,
};

describe('workspaceApi.tasks (TASK-909)', () => {
  it('reads the page from GET /api/workspace/tasks', async () => {
    const body = {
      tasks: [ROW, { ...ROW, routineId: 'r-2', task: null }],
      unavailableAgents: [{ agentId: 'a-ada', agentName: 'Ada' }],
    };
    const fetchSpy = respondWith(body);
    await expect(workspaceApi.tasks()).resolves.toEqual(body);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/api/workspace/tasks');
    expect((init as RequestInit).method).toBe('GET');
  });

  it('accepts a report whose update is null', async () => {
    const body = {
      tasks: [{ ...ROW, task: { ...ROW.task, update: null } }],
      unavailableAgents: [],
    };
    respondWith(body);
    await expect(workspaceApi.tasks()).resolves.toEqual(body);
  });

  it('reads a row with missed check-ins, for every reason the contract names', async () => {
    for (const reason of CHECK_IN_MISSES) {
      const body = {
        tasks: [{ ...ROW, noRecentUpdate: { ...MISS, reason, autoPaused: true } }],
        unavailableAgents: [],
      };
      respondWith(body);
      await expect(workspaceApi.tasks()).resolves.toEqual(body);
    }
  });

  it.each<[string, unknown]>([
    ['no missed-check-ins key', { ...ROW, noRecentUpdate: undefined }],
    ['a zero count', { ...ROW, noRecentUpdate: { ...MISS, inARow: 0 } }],
    ['a fractional count', { ...ROW, noRecentUpdate: { ...MISS, inARow: 1.5 } }],
    ['a count as text', { ...ROW, noRecentUpdate: { ...MISS, inARow: '2' } }],
    ['a reason it doesn’t know', { ...ROW, noRecentUpdate: { ...MISS, reason: 'stuck' } }],
    ['a time that isn’t text', { ...ROW, noRecentUpdate: { ...MISS, at: 1761138000000 } }],
    ['autoPaused as text', { ...ROW, noRecentUpdate: { ...MISS, autoPaused: 'no' } }],
  ])('refuses a row with %s', async (_label, row) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    respondWith({ tasks: [row], unavailableAgents: [] });
    await expect(workspaceApi.tasks()).rejects.toBeInstanceOf(WorkspaceShapeError);
  });

  it('refuses a body without unavailableAgents', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    respondWith({ tasks: [ROW] });
    await expect(workspaceApi.tasks()).rejects.toBeInstanceOf(WorkspaceShapeError);
  });

  it('refuses a null row', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    respondWith({ tasks: [null], unavailableAgents: [] });
    await expect(workspaceApi.tasks()).rejects.toBeInstanceOf(WorkspaceShapeError);
  });

  it('refuses a row whose status it does not know', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    respondWith({
      tasks: [{ ...ROW, task: { ...ROW.task, status: 'stuck' } }],
      unavailableAgents: [],
    });
    await expect(workspaceApi.tasks()).rejects.toBeInstanceOf(WorkspaceShapeError);
  });

  it('refuses an unavailable agent without a name', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    respondWith({ tasks: [], unavailableAgents: [{ agentId: 'a-ada' }] });
    await expect(workspaceApi.tasks()).rejects.toBeInstanceOf(WorkspaceShapeError);
  });

  it('carries the status of a failed read', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as unknown as Response);
    const err = await workspaceApi.tasks().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceApiError);
    expect((err as WorkspaceApiError).status).toBe(500);
  });
});
