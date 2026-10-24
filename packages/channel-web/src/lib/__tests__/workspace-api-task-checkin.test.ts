/**
 * `workspaceApi.taskCheckin()`: a check-in page's read (TASK-911).
 *
 * The same boundary rule as `task()`: a 200 whose body is not the shape the
 * page draws from is a `WorkspaceShapeError`, thrown here, so the page's
 * "couldn't load" state shows instead of a render crash on a missing field.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workspaceApi, WorkspaceApiError, WorkspaceShapeError } from '../workspace-api';
import type { TaskCheckin } from '../workspace-types';

function respondWith(body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response);
}

function failWith(status: number) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: false,
    status,
    json: async () => ({}),
  } as unknown as Response);
}

afterEach(() => vi.restoreAllMocks());

const CHECKIN: TaskCheckin = {
  taskName: 'Watch the support queue',
  agentName: 'Quill',
  checkIn: {
    firedAt: '2026-10-22T12:00:00.000Z',
    status: 'ok',
    error: null,
    report: { status: 'needs-you', update: 'Two tickets need a refund decision', reading: null },
    conversationId: 'c1',
  },
  triggerSource: 'tick',
  thread: [{ kind: 'assistant', id: 'm1', text: 'Looked at the queue.' } as unknown as TaskCheckin['thread'][number]],
  decisions: { status: 'ok' },
};

describe('workspaceApi.taskCheckin (TASK-911)', () => {
  it('reads one check-in from its own address, each id encoded', async () => {
    const fetchSpy = respondWith(CHECKIN);
    await expect(workspaceApi.taskCheckin('a/1', 't 1', 'c?1')).resolves.toEqual(CHECKIN);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/api/workspace/tasks/a%2F1/t%201/checkins/c%3F1');
    expect((init as RequestInit).method).toBe('GET');
  });

  it('refuses a check-in that names a start it doesn’t know', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    respondWith({ ...CHECKIN, triggerSource: 'cron' });
    await expect(workspaceApi.taskCheckin('a1', 't1', 'c1')).rejects.toBeInstanceOf(WorkspaceShapeError);
  });

  it('refuses one without a transcript', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { thread: _left, ...withoutThread } = CHECKIN;
    respondWith(withoutThread);
    await expect(workspaceApi.taskCheckin('a1', 't1', 'c1')).rejects.toBeInstanceOf(WorkspaceShapeError);
  });

  it('refuses one whose check-in isn’t one', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    respondWith({ ...CHECKIN, checkIn: {} });
    await expect(workspaceApi.taskCheckin('a1', 't1', 'c1')).rejects.toBeInstanceOf(WorkspaceShapeError);
  });

  // Every field the page reads is checked, not only the three above.
  it.each<[string, unknown]>([
    ['no task name', { ...CHECKIN, taskName: undefined }],
    ['an agent name that isn’t text', { ...CHECKIN, agentName: 7 }],
    ['a transcript that isn’t a list', { ...CHECKIN, thread: {} }],
    ['a null row in the transcript', { ...CHECKIN, thread: [null] }],
    ['a row without a kind', { ...CHECKIN, thread: [{ id: 'm1' }] }],
    ['a row without an id', { ...CHECKIN, thread: [{ kind: 'assistant' }] }],
    ['no decisions', { ...CHECKIN, decisions: undefined }],
    ['a decisions status it doesn’t know', { ...CHECKIN, decisions: { status: 'stale' } }],
  ])('refuses %s', async (_label, body) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    respondWith(body);
    await expect(workspaceApi.taskCheckin('a1', 't1', 'c1')).rejects.toBeInstanceOf(WorkspaceShapeError);
  });

  it('reads an empty transcript', async () => {
    respondWith({ ...CHECKIN, thread: [], decisions: { status: 'unavailable' } });
    await expect(workspaceApi.taskCheckin('a1', 't1', 'c1')).resolves.toMatchObject({ thread: [] });
  });

  it('carries the status of a failed read', async () => {
    failWith(404);
    const err = await workspaceApi.taskCheckin('a1', 't1', 'c1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceApiError);
    expect((err as WorkspaceApiError).status).toBe(404);
  });
});
