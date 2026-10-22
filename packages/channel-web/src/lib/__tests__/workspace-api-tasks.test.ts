/**
 * `workspaceApi.tasks()` — the Tasks page's one read (TASK-909).
 *
 * The same boundary rule as `decisions()`: a 200 whose body is not the shape
 * the page draws from is a `WorkspaceShapeError`, thrown here, so the page's
 * "couldn't load" card shows instead of a render crash on a null row.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
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
