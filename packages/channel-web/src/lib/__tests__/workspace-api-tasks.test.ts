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
  kind: 'stay-on-top',
  steps: null,
  finishBy: null,
  task: {
    status: 'on-track',
    update: 'Filed 12 receipts',
    ask: null,
    reading: null,
    doneClaimed: false,
    reportedAt: '2026-10-22T08:00:00.000Z',
  },
  noRecentUpdate: null,
  doneAt: null,
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

  it('reads a finish date on a row, and an older host’s row without one as none (TASK-951)', async () => {
    const dated = { ...ROW, kind: 'get-done', finishBy: { date: '2026-11-14', daysLeft: 9 } };
    const { finishBy: _left, ...older } = ROW;
    respondWith({ tasks: [dated, { ...older, routineId: 'r-2' }], unavailableAgents: [] });
    const page = await workspaceApi.tasks();
    expect(page.tasks[0]!.finishBy).toEqual({ date: '2026-11-14', daysLeft: 9 });
    expect(page.tasks[1]!.finishBy).toBeNull();
  });

  it('refuses a row whose finish date is malformed (TASK-951)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const finishBy of [
      { date: '2026-02-30', daysLeft: 1 },
      { date: '2026-11-14', daysLeft: 1.5 },
      'soon',
    ]) {
      respondWith({ tasks: [{ ...ROW, finishBy }], unavailableAgents: [] });
      await expect(workspaceApi.tasks()).rejects.toBeInstanceOf(WorkspaceShapeError);
    }
  });

  it('accepts a report whose update is null', async () => {
    const body = {
      tasks: [{ ...ROW, task: { ...ROW.task, update: null } }],
      unavailableAgents: [],
    };
    respondWith(body);
    await expect(workspaceApi.tasks()).resolves.toEqual(body);
  });

  it('accepts a report whose ask is text or null', async () => {
    for (const ask of ['Want me to draft a reply to #4410?', null]) {
      const body = {
        tasks: [{ ...ROW, task: { ...ROW.task, status: 'needs-you', ask } }],
        unavailableAgents: [],
      };
      respondWith(body);
      await expect(workspaceApi.tasks()).resolves.toEqual(body);
    }
  });

  it.each<[unknown]>([[42], [{}]])(
    'refuses a report whose ask is %s',
    async (ask) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      respondWith({ tasks: [{ ...ROW, task: { ...ROW.task, ask } }], unavailableAgents: [] });
      await expect(workspaceApi.tasks()).rejects.toBeInstanceOf(WorkspaceShapeError);
    },
  );

  it('reads a report with no ask key as ask: null (a host from before TASK-933)', async () => {
    // An SPA synced onto an older host (`make dev-fast`) must still load Tasks.
    const { ask: _gone, ...withoutAsk } = ROW.task;
    respondWith({
      tasks: [{ ...ROW, task: { ...withoutAsk, status: 'needs-you' } }, { ...ROW, routineId: 'r-2', task: null }],
      unavailableAgents: [],
    });
    await expect(workspaceApi.tasks()).resolves.toEqual({
      tasks: [
        { ...ROW, task: { ...withoutAsk, status: 'needs-you', ask: null } },
        { ...ROW, routineId: 'r-2', task: null },
      ],
      unavailableAgents: [],
    });
  });

  it('accepts a report whose reading is null, or a number with its label (TASK-952)', async () => {
    for (const reading of [null, { label: 'Open tickets', value: 3 }, { label: 'Balance', value: -2.5 }, { label: 'Top', value: 1e12 }, { label: 'Bottom', value: -1e12 }]) {
      const body = { tasks: [{ ...ROW, task: { ...ROW.task, reading } }], unavailableAgents: [] };
      respondWith(body);
      await expect(workspaceApi.tasks()).resolves.toEqual(body);
    }
  });

  it('reads a report with no reading key as reading: null (a host from before TASK-952)', async () => {
    // An SPA synced onto an older host (`make dev-fast`) must still load Tasks.
    const { reading: _gone, ...withoutReading } = ROW.task;
    respondWith({ tasks: [{ ...ROW, task: withoutReading }], unavailableAgents: [] });
    await expect(workspaceApi.tasks()).resolves.toEqual({
      tasks: [{ ...ROW, task: { ...withoutReading, reading: null } }],
      unavailableAgents: [],
    });
  });

  it.each<[string, unknown]>([
    ['a label that isn’t text', { label: 3, value: 3 }],
    ['a value that isn’t a number', { label: 'Open tickets', value: '3' }],
    ['no value', { label: 'Open tickets' }],
    ['a value that isn’t finite', { label: 'Open tickets', value: Number.POSITIVE_INFINITY }],
    ['a value past the bound', { label: 'Open tickets', value: 1e13 }],
    ['a value past the bound, negative', { label: 'Open tickets', value: -1e13 }],
  ])('refuses a report whose reading has %s (TASK-952)', async (_label, reading) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    respondWith({ tasks: [{ ...ROW, task: { ...ROW.task, reading } }], unavailableAgents: [] });
    await expect(workspaceApi.tasks()).rejects.toBeInstanceOf(WorkspaceShapeError);
  });

  it('accepts a get-done row with how many of its steps are done (TASK-948)', async () => {
    for (const steps of [{ done: 2, total: 5 }, { done: 0, total: 0 }]) {
      const body = { tasks: [{ ...ROW, kind: 'get-done', steps }], unavailableAgents: [] };
      respondWith(body);
      await expect(workspaceApi.tasks()).resolves.toEqual(body);
    }
  });

  it('reads a row with no kind and no steps key as stay-on-top with no steps (a host from before TASK-948)', async () => {
    // As for the ask: an SPA synced onto an older host (`make dev-fast`) must still load Tasks.
    const { kind: _kind, steps: _steps, ...older } = ROW;
    respondWith({ tasks: [older, { ...older, routineId: 'r-2', task: null }], unavailableAgents: [] });
    await expect(workspaceApi.tasks()).resolves.toStrictEqual({
      tasks: [
        { ...older, kind: 'stay-on-top', steps: null },
        { ...older, routineId: 'r-2', task: null, kind: 'stay-on-top', steps: null },
      ],
      unavailableAgents: [],
    });
  });

  it('reads a kind it doesn’t know as stay-on-top, as the server does, with its steps read as a stay-on-top row’s (TASK-948)', async () => {
    // A tab left open across a deploy that adds a kind must still load Tasks, Today and the badge. Steps
    // stay as they came, as on any stay-on-top row: the Tasks row draws counts for get-done only.
    for (const kind of ['track-number', 'repeat']) {
      for (const steps of [null, { done: 1, total: 3 }]) {
        respondWith({ tasks: [{ ...ROW, kind, steps }], unavailableAgents: [] });
        await expect(workspaceApi.tasks()).resolves.toStrictEqual({
          tasks: [{ ...ROW, kind: 'stay-on-top', steps }],
          unavailableAgents: [],
        });
      }
    }
  });

  it.each<[string, unknown]>([
    ['a kind that isn’t text', { ...ROW, kind: 7 }],
    ['a null kind', { ...ROW, kind: null }],
    ['a kind it doesn’t know, with steps as a list', { ...ROW, kind: 'track-number', steps: [] }],
    ['steps as a list', { ...ROW, kind: 'get-done', steps: [] }],
    ['more steps done than there are', { ...ROW, kind: 'get-done', steps: { done: 3, total: 2 } }],
    ['a fractional count of steps', { ...ROW, kind: 'get-done', steps: { done: 1.5, total: 2 } }],
    ['a negative count of steps', { ...ROW, kind: 'get-done', steps: { done: -1, total: 2 } }],
  ])('refuses a row with %s (TASK-948)', async (_label, row) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    respondWith({ tasks: [row], unavailableAgents: [] });
    await expect(workspaceApi.tasks()).rejects.toBeInstanceOf(WorkspaceShapeError);
  });

  it('reads a Done row’s time and a report’s claim (TASK-950)', async () => {
    const body = {
      tasks: [
        { ...ROW, kind: 'get-done', steps: { done: 3, total: 3 }, enabled: false, doneAt: '2026-10-23T10:00:00.000Z' },
        {
          ...ROW,
          routineId: 'r-2',
          kind: 'get-done',
          steps: { done: 1, total: 3 },
          task: { ...ROW.task, status: 'needs-you', doneClaimed: true },
        },
      ],
      unavailableAgents: [],
    };
    respondWith(body);
    await expect(workspaceApi.tasks()).resolves.toEqual(body);
  });

  it('reads a row with no doneAt key, and a report with no doneClaimed key, as not done and no claim (a host from before TASK-950)', async () => {
    // As for the ask: an SPA synced onto an older host (`make dev-fast`) must still load Tasks.
    const { doneAt: _doneAt, ...older } = ROW;
    const { doneClaimed: _doneClaimed, ...olderReport } = ROW.task;
    respondWith({
      tasks: [{ ...older, task: olderReport }, { ...older, routineId: 'r-2', task: null }],
      unavailableAgents: [],
    });
    await expect(workspaceApi.tasks()).resolves.toStrictEqual({
      tasks: [ROW, { ...ROW, routineId: 'r-2', task: null }],
      unavailableAgents: [],
    });
  });

  it.each<[string, unknown]>([
    ['a doneAt that is a number', { ...ROW, doneAt: 7 }],
    ['a report whose doneClaimed is text', { ...ROW, task: { ...ROW.task, doneClaimed: 'yes' } }],
  ])('refuses %s (TASK-950)', async (_label, row) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    respondWith({ tasks: [row], unavailableAgents: [] });
    await expect(workspaceApi.tasks()).rejects.toBeInstanceOf(WorkspaceShapeError);
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
