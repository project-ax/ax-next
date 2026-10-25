/**
 * `workspaceApi.task()` and `workspaceApi.clearTaskNotes()`: a task page's
 * read and its first write (TASK-910); `sendTaskReply()` (TASK-931); and
 * `completeTask()` and `reopenTask()`, Mark done, and Not yet or Reopen
 * (TASK-950). The last two describes (TASK-937) pin the deadline every task
 * request carries, and what the task page does with a read that never answers.
 *
 * The same boundary rule as `tasks()`: a 200 whose body is not the shape the
 * page draws from is a `WorkspaceShapeError`, thrown here, so the page's
 * "couldn't load" state shows instead of a render crash on a missing field.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHECK_IN_MISSES } from '@ax/routines-contract';
import { REQUEST_TIMEOUT_MS, RequestTimeoutError } from '../http';
import { TASK_POLL_INTERVAL_MS } from '../use-task-poll';
import { workspaceApi, WorkspaceApiError, WorkspaceShapeError } from '../workspace-api';
import { useTask } from '../workspace-task';
import type { TaskDetail, TaskDetailReport, TaskNoRecentUpdate, TaskStep, TaskUpdate } from '../workspace-types';

/**
 * Answers with `body` as it arrives off the wire: through JSON, so a fixture's
 * `x: undefined` means the key is absent, as a server leaving it out would
 * send it, not present-with-no-value (a shape JSON can't carry).
 */
function respondWith(body: unknown) {
  const wire: unknown = body === undefined ? undefined : JSON.parse(JSON.stringify(body));
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => wire,
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

const REPORT: TaskDetailReport = {
  status: 'needs-you',
  update: 'Two tickets need a refund decision',
  ask: 'Can I refund order 1182?',
  agentNotes: 'Ticket 1182 is waiting on finance.',
  reading: null,
  doneClaimed: false,
  reportedAt: '2026-10-22T12:00:00.000Z',
};

const UPDATE: TaskUpdate = {
  firedAt: '2026-10-22T12:00:00.000Z',
  status: 'ok',
  error: null,
  report: { status: 'needs-you', update: 'Two tickets need a refund decision', reading: null },
  conversationId: 'c1',
};

const MISS: TaskNoRecentUpdate = {
  inARow: 2,
  reason: 'brief-too-long',
  at: '2026-10-22T11:00:00.000Z',
  autoPaused: false,
};

const STEP: TaskStep = { id: 's1', text: 'Export every article', done: true, byAgent: true };

const DETAIL: TaskDetail = {
  agentName: 'Quill',
  name: 'Watch the support queue',
  kind: 'stay-on-top',
  enabled: true,
  revision: 'rev-1',
  permissions: { fire: true, stop: true, edit: true },
  schedule: 'every hour, 9:00 AM to 6:00 PM (America/New_York)',
  nextCheckAt: '2026-10-22T13:00:00.000Z',
  brief: { promptBody: 'Read new tickets.', goodWhen: 'No ticket waits a day.' },
  task: REPORT,
  steps: [],
  finishBy: null,
  noRecentUpdate: null,
  doneAt: null,
  updates: [
    UPDATE,
    { firedAt: '2026-10-22T11:00:00.000Z', status: 'error', error: 'The check-in ran out of time.', report: null, conversationId: null },
    { firedAt: '2026-10-22T10:00:00.000Z', status: 'silenced', error: null, report: { status: 'on-track', update: null, reading: null }, conversationId: 'c3' },
  ],
  replies: [],
};

describe('workspaceApi.task (TASK-910)', () => {
  it('reads one task from its own address', async () => {
    const fetchSpy = respondWith(DETAIL);
    await expect(workspaceApi.task('a/1', 't 1')).resolves.toEqual(DETAIL);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/api/workspace/tasks/a%2F1/t%201');
    expect((init as RequestInit).method).toBe('GET');
  });

  it('reads a task that has never reported, with nothing optional filled in', async () => {
    const body: TaskDetail = {
      ...DETAIL,
      enabled: false,
      permissions: { fire: false, stop: false, edit: false },
      schedule: null,
      nextCheckAt: null,
      brief: { promptBody: null, goodWhen: null },
      task: null,
      updates: [],
      replies: [],
    };
    respondWith(body);
    await expect(workspaceApi.task('a1', 't1')).resolves.toEqual(body);
  });

  it('reads a task’s replies', async () => {
    const body: TaskDetail = {
      ...DETAIL,
      replies: [
        { sentAt: '2026-10-22T12:30:00.000Z', text: 'Hi', byYou: true },
        { sentAt: '2026-10-22T12:00:00.000Z', text: null, byYou: false },
      ],
    };
    respondWith(body);
    await expect(workspaceApi.task('a1', 't1')).resolves.toEqual(body);
  });

  it('reads a get-done task’s kind and its steps, a step with no legible text included (TASK-948)', async () => {
    const body: TaskDetail = {
      ...DETAIL,
      kind: 'get-done',
      steps: [STEP, { id: 's2', text: null, done: false, byAgent: true }, { ...STEP, id: 's3', byAgent: false }],
    };
    respondWith(body);
    await expect(workspaceApi.task('a1', 't1')).resolves.toEqual(body);
  });

  it('reads a kind it doesn’t know as stay-on-top, as the server does, with its steps kept as a stay-on-top task’s are (TASK-948)', async () => {
    // A tab left open across a deploy that adds a kind still opens the task, under a kind it has words for.
    // The page draws steps for get-done only.
    for (const kind of ['track-number', 'repeat']) {
      for (const steps of [[], [STEP]]) {
        respondWith({ ...DETAIL, kind, steps });
        await expect(workspaceApi.task('a1', 't1')).resolves.toStrictEqual({ ...DETAIL, kind: 'stay-on-top', steps });
      }
    }
  });

  it('reads missed check-ins, for every reason the contract names', async () => {
    for (const reason of CHECK_IN_MISSES) {
      const body: TaskDetail = { ...DETAIL, noRecentUpdate: { ...MISS, reason, autoPaused: true } };
      respondWith(body);
      await expect(workspaceApi.task('a1', 't1')).resolves.toEqual(body);
    }
  });

  it('reads the agent’s reading on its report and on an update (TASK-952)', async () => {
    const reading = { label: 'Open tickets', value: 3 };
    const body: TaskDetail = {
      ...DETAIL,
      task: { ...REPORT, reading },
      updates: [{ ...UPDATE, report: { status: 'needs-you', update: 'Two tickets need a refund decision', reading } }],
    };
    respondWith(body);
    await expect(workspaceApi.task('a1', 't1')).resolves.toEqual(body);
  });

  it('reads a finish date, or none, and a count past the date (TASK-951)', async () => {
    for (const finishBy of [null, { date: '2026-11-14', daysLeft: -3 }]) {
      respondWith({ ...DETAIL, kind: 'get-done', finishBy });
      await expect(workspaceApi.task('a1', 't1')).resolves.toMatchObject({ finishBy });
    }
  });

  it('refuses a body without finishBy, and a finish date no calendar has or a count that isn’t whole (TASK-951)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { finishBy: _left, ...withoutFinishBy } = DETAIL;
    respondWith(withoutFinishBy);
    await expect(workspaceApi.task('a1', 't1')).rejects.toBeInstanceOf(WorkspaceShapeError);
    for (const finishBy of [
      { date: '2026-02-30', daysLeft: 1 },
      { date: '2026-11-14', daysLeft: 1.5 },
      { date: '2026-11-14' },
      { date: 20261114, daysLeft: 1 },
    ]) {
      respondWith({ ...DETAIL, finishBy });
      await expect(workspaceApi.task('a1', 't1')).rejects.toBeInstanceOf(WorkspaceShapeError);
    }
  });

  it('reads when a Done task was marked done, and a report’s claim (TASK-950)', async () => {
    const done: TaskDetail = {
      ...DETAIL,
      kind: 'get-done',
      enabled: false,
      nextCheckAt: null,
      doneAt: '2026-10-23T10:00:00.000Z',
    };
    respondWith(done);
    await expect(workspaceApi.task('a1', 't1')).resolves.toEqual(done);
    const claimed: TaskDetail = { ...DETAIL, kind: 'get-done', task: { ...REPORT, doneClaimed: true } };
    respondWith(claimed);
    await expect(workspaceApi.task('a1', 't1')).resolves.toEqual(claimed);
  });

  it('refuses an update with a status it doesn’t know', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    respondWith({ ...DETAIL, updates: [{ ...UPDATE, status: 'skipped' }] });
    await expect(workspaceApi.task('a1', 't1')).rejects.toBeInstanceOf(WorkspaceShapeError);
  });

  it('refuses a body without updates', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { updates: _left, ...withoutUpdates } = DETAIL;
    respondWith(withoutUpdates);
    await expect(workspaceApi.task('a1', 't1')).rejects.toBeInstanceOf(WorkspaceShapeError);
  });

  // Every field the page reads is checked, not only the two above: the page
  // reads them during render, so one missing object would crash it.
  it.each<[string, unknown]>([
    ['no agent name', { ...DETAIL, agentName: undefined }],
    ['a name that isn’t text', { ...DETAIL, name: 7 }],
    // TASK-948: `task()` doesn't fill in a kind or steps, so both must be there: a kind as text.
    ['no kind', { ...DETAIL, kind: undefined }],
    ['a kind that isn’t text', { ...DETAIL, kind: 7 }],
    ['a null kind', { ...DETAIL, kind: null }],
    ['no steps', { ...DETAIL, steps: undefined }],
    ['steps that aren’t a list', { ...DETAIL, steps: {} }],
    ['a kind it doesn’t know, with steps that aren’t a list', { ...DETAIL, kind: 'track-number', steps: {} }],
    ['a null step', { ...DETAIL, steps: [null] }],
    ['a step without byAgent', { ...DETAIL, steps: [{ id: 's1', text: 'Export every article', done: true }] }],
    ['a step whose text is a number', { ...DETAIL, steps: [{ ...STEP, text: 4 }] }],
    ['an enabled flag that isn’t true or false', { ...DETAIL, enabled: 'yes' }],
    ['no revision', { ...DETAIL, revision: undefined }],
    ['no permissions', { ...DETAIL, permissions: null }],
    ['permissions without edit', { ...DETAIL, permissions: { fire: true, stop: true } }],
    ['a schedule left out rather than null', { ...DETAIL, schedule: undefined }],
    ['a next check that isn’t a time string', { ...DETAIL, nextCheckAt: 1761138000000 }],
    ['no brief', { ...DETAIL, brief: undefined }],
    ['a brief without going-well-when', { ...DETAIL, brief: { promptBody: 'Read new tickets.' } }],
    ['a report with a status it doesn’t know', { ...DETAIL, task: { ...REPORT, status: 'stuck' } }],
    ['a report whose update isn’t text', { ...DETAIL, task: { ...REPORT, update: 5 } }],
    ['a report without an ask', { ...DETAIL, task: { ...REPORT, ask: undefined } }],
    ['a report without the agent’s notes', { ...DETAIL, task: { ...REPORT, agentNotes: undefined } }],
    ['a report without when it reported', { ...DETAIL, task: { ...REPORT, reportedAt: undefined } }],
    // The page draws the reading (TASK-952), so it must be present: null or a reading.
    ['a report without a reading', { ...DETAIL, task: { ...REPORT, reading: undefined } }],
    ['a report whose reading has no label', { ...DETAIL, task: { ...REPORT, reading: { value: 3 } } }],
    // TASK-950: `task()` doesn't fill in when the task was done or a report's claim, so both must be there.
    ['no doneAt key', { ...DETAIL, doneAt: undefined }],
    ['a doneAt that isn’t text', { ...DETAIL, doneAt: 7 }],
    ['a report without its claim', { ...DETAIL, task: { ...REPORT, doneClaimed: undefined } }],
    ['a report whose claim is text', { ...DETAIL, task: { ...REPORT, doneClaimed: 'yes' } }],
    ['no missed-check-ins key', { ...DETAIL, noRecentUpdate: undefined }],
    ['missed check-ins with a zero count', { ...DETAIL, noRecentUpdate: { ...MISS, inARow: 0 } }],
    ['missed check-ins with a fractional count', { ...DETAIL, noRecentUpdate: { ...MISS, inARow: 1.5 } }],
    ['missed check-ins with a count as text', { ...DETAIL, noRecentUpdate: { ...MISS, inARow: '2' } }],
    ['missed check-ins with a reason it doesn’t know', { ...DETAIL, noRecentUpdate: { ...MISS, reason: 'stuck' } }],
    ['missed check-ins with a time that isn’t text', { ...DETAIL, noRecentUpdate: { ...MISS, at: 1761138000000 } }],
    ['missed check-ins with autoPaused as text', { ...DETAIL, noRecentUpdate: { ...MISS, autoPaused: 'no' } }],
    ['no replies', { ...DETAIL, replies: undefined }],
    ['replies that aren’t a list', { ...DETAIL, replies: {} }],
    ['a null reply', { ...DETAIL, replies: [null] }],
    ['a reply without when it was sent', { ...DETAIL, replies: [{ text: 'Hi', byYou: true }] }],
    ['a reply whose text is left out', { ...DETAIL, replies: [{ sentAt: 'x', byYou: true }] }],
    ['a reply whose text isn’t text', { ...DETAIL, replies: [{ sentAt: 'x', text: 4, byYou: true }] }],
    ['a reply without byYou', { ...DETAIL, replies: [{ sentAt: 'x', text: 'Hi' }] }],
    ['updates that aren’t a list', { ...DETAIL, updates: {} }],
    ['a null update', { ...DETAIL, updates: [null] }],
    ['an update without when it started', { ...DETAIL, updates: [{ ...UPDATE, firedAt: undefined }] }],
    ['an update whose reason is left out', { ...DETAIL, updates: [{ ...UPDATE, error: undefined }] }],
    ['an update left without a report', { ...DETAIL, updates: [{ ...UPDATE, report: undefined }] }],
    ['an update whose conversation isn’t an id', { ...DETAIL, updates: [{ ...UPDATE, conversationId: 42 }] }],
    ['an update whose conversation is left out', { ...DETAIL, updates: [{ ...UPDATE, conversationId: undefined }] }],
    [
      'an update whose report has a status it doesn’t know',
      { ...DETAIL, updates: [{ ...UPDATE, report: { status: 'stuck', update: null, reading: null } }] },
    ],
    [
      'an update whose report’s text isn’t text',
      { ...DETAIL, updates: [{ ...UPDATE, report: { status: 'on-track', update: 3, reading: null } }] },
    ],
    [
      'an update whose report has no reading',
      { ...DETAIL, updates: [{ ...UPDATE, report: { status: 'on-track', update: null } }] },
    ],
    [
      'an update whose reading’s value is text',
      {
        ...DETAIL,
        updates: [
          { ...UPDATE, report: { status: 'on-track', update: null, reading: { label: 'Open tickets', value: '3' } } },
        ],
      },
    ],
  ])('refuses %s', async (_label, body) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    respondWith(body);
    await expect(workspaceApi.task('a1', 't1')).rejects.toBeInstanceOf(WorkspaceShapeError);
  });

  it('carries the status of a failed read', async () => {
    failWith(404);
    const err = await workspaceApi.task('a1', 't1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceApiError);
    expect((err as WorkspaceApiError).status).toBe(404);
  });
});

describe('workspaceApi.clearTaskNotes (TASK-910)', () => {
  it('clears notes with DELETE and the CSRF header', async () => {
    const fetchSpy = respondWith({ cleared: true });
    await expect(workspaceApi.clearTaskNotes('a/1', 't 1')).resolves.toEqual({ cleared: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/api/workspace/tasks/a%2F1/t%201/notes');
    expect((init as RequestInit).method).toBe('DELETE');
    expect(((init as RequestInit).headers as Record<string, string>)['x-requested-with']).toBe('ax-admin');
    expect((init as RequestInit).body).toBeUndefined();
  });

  // "Notes cleared." is a claim, so it rests on the server saying so.
  it('refuses an answer that doesn’t say the notes were cleared', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    respondWith({});
    await expect(workspaceApi.clearTaskNotes('a1', 't1')).rejects.toBeInstanceOf(WorkspaceShapeError);
  });

  it('carries the status of a failed clear', async () => {
    failWith(404);
    const err = await workspaceApi.clearTaskNotes('a1', 't1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceApiError);
    expect((err as WorkspaceApiError).status).toBe(404);
  });
});

describe('workspaceApi.sendTaskReply (TASK-931)', () => {
  it('sends a reply with POST, the CSRF header and only the text and request id', async () => {
    const fetchSpy = respondWith({ checkIn: 'started' });
    await expect(
      workspaceApi.sendTaskReply('a1', 't1', { text: 'Refunds under $100 are fine.', requestId: 'req-1' }),
    ).resolves.toEqual({ checkIn: 'started' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/api/workspace/tasks/a1/t1/replies');
    expect((init as RequestInit).method).toBe('POST');
    expect(((init as RequestInit).headers as Record<string, string>)['x-requested-with']).toBe('ax-admin');
    expect(JSON.parse((init as RequestInit).body as string)).toStrictEqual({
      text: 'Refunds under $100 are fine.',
      requestId: 'req-1',
    });
  });

  it('reads every answer the contract names', async () => {
    for (const checkIn of ['started', 'paused', 'not-allowed', 'replayed']) {
      respondWith({ checkIn });
      await expect(workspaceApi.sendTaskReply('a1', 't1', { text: 'Hi', requestId: 'r' })).resolves.toEqual({
        checkIn,
      });
    }
  });

  // "Sent." is a claim, so it rests on the server saying what it did.
  it.each<[string, unknown]>([
    ['a check-in outcome it doesn’t know', { checkIn: 'finished' }],
    ['no check-in outcome', {}],
    ['no object at all', null],
  ])('refuses an answer with %s', async (_label, body) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    respondWith(body);
    await expect(
      workspaceApi.sendTaskReply('a1', 't1', { text: 'Hi', requestId: 'r' }),
    ).rejects.toBeInstanceOf(WorkspaceShapeError);
  });

  it('carries the status of a failed send', async () => {
    failWith(503);
    const err = await workspaceApi
      .sendTaskReply('a1', 't1', { text: 'Hi', requestId: 'r' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceApiError);
    expect((err as WorkspaceApiError).status).toBe(503);
  });
});

describe('workspaceApi.completeTask (TASK-950)', () => {
  it('marks a task done with POST, the CSRF header and only the request id', async () => {
    const fetchSpy = respondWith({ done: true });
    await expect(workspaceApi.completeTask('a1', 't1', { requestId: 'req-1' })).resolves.toEqual({
      done: true,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/api/workspace/tasks/a1/t1/complete');
    expect((init as RequestInit).method).toBe('POST');
    expect(((init as RequestInit).headers as Record<string, string>)['x-requested-with']).toBe('ax-admin');
    expect(JSON.parse((init as RequestInit).body as string)).toStrictEqual({ requestId: 'req-1' });
  });

  // "Done." is a claim, so it rests on the server saying so.
  it.each<[string, unknown]>([
    ['done as false', { done: false }],
    ['done as text', { done: 'true' }],
    ['no done at all', {}],
    ['no object at all', null],
  ])('refuses an answer with %s', async (_label, body) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    respondWith(body);
    await expect(workspaceApi.completeTask('a1', 't1', { requestId: 'r' })).rejects.toBeInstanceOf(
      WorkspaceShapeError,
    );
  });

  it('carries the status of a failed press', async () => {
    failWith(403);
    const err = await workspaceApi.completeTask('a1', 't1', { requestId: 'r' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceApiError);
    expect((err as WorkspaceApiError).status).toBe(403);
  });
});

describe('workspaceApi.reopenTask (TASK-950)', () => {
  it('sends Not yet or Reopen with POST, the CSRF header and only the text and request id', async () => {
    const fetchSpy = respondWith({ checkIn: 'started' });
    await expect(
      workspaceApi.reopenTask('a1', 't1', { text: 'The billing page still needs a review.', requestId: 'req-2' }),
    ).resolves.toEqual({ checkIn: 'started' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/api/workspace/tasks/a1/t1/reopen');
    expect((init as RequestInit).method).toBe('POST');
    expect(((init as RequestInit).headers as Record<string, string>)['x-requested-with']).toBe('ax-admin');
    expect(JSON.parse((init as RequestInit).body as string)).toStrictEqual({
      text: 'The billing page still needs a review.',
      requestId: 'req-2',
    });
  });

  it('reads every answer the contract names', async () => {
    for (const checkIn of ['started', 'paused', 'not-allowed', 'replayed']) {
      respondWith({ checkIn });
      await expect(workspaceApi.reopenTask('a1', 't1', { text: 'Hi', requestId: 'r' })).resolves.toEqual({
        checkIn,
      });
    }
  });

  // "Sent." is a claim, so it rests on the server saying what it did.
  it.each<[string, unknown]>([
    ['a check-in outcome it doesn’t know', { checkIn: 'reopened' }],
    ['no check-in outcome', {}],
    ['no object at all', null],
  ])('refuses an answer with %s', async (_label, body) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    respondWith(body);
    await expect(
      workspaceApi.reopenTask('a1', 't1', { text: 'Hi', requestId: 'r' }),
    ).rejects.toBeInstanceOf(WorkspaceShapeError);
  });

  it('carries the status of a failed send', async () => {
    failWith(403);
    const err = await workspaceApi
      .reopenTask('a1', 't1', { text: 'Hi', requestId: 'r' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceApiError);
    expect((err as WorkspaceApiError).status).toBe(403);
  });
});

describe('workspaceApi.setTaskSteps (TASK-949)', () => {
  it('posts the request id and the changes to the task’s steps, with the write headers', async () => {
    const fetchSpy = respondWith({ steps: [STEP], skipped: 0 });
    await workspaceApi.setTaskSteps('a1', 't1', { requestId: 'req-1', ops: [{ op: 'tick', id: 's1' }] });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/api/workspace/tasks/a1/t1/steps');
    expect((init as RequestInit).method).toBe('POST');
    expect(((init as RequestInit).headers as Record<string, string>)['x-requested-with']).toBe('ax-admin');
    expect(JSON.parse((init as RequestInit).body as string)).toStrictEqual({
      requestId: 'req-1',
      ops: [{ op: 'tick', id: 's1' }],
    });
  });

  it('answers the steps and the count', async () => {
    respondWith({ steps: [STEP], skipped: 2 });
    await expect(
      workspaceApi.setTaskSteps('a1', 't1', { requestId: 'req-1', ops: [{ op: 'tick', id: 's1' }] }),
    ).resolves.toEqual({ steps: [STEP], skipped: 2 });
  });

  it.each<[string, unknown]>([
    ['a step with no text or flags', { steps: [{ id: 's1' }], skipped: 0 }],
    ['a negative count', { steps: [], skipped: -1 }],
    ['a fractional count', { steps: [], skipped: 1.5 }],
    ['no count', { steps: [] }],
    ['no steps', { skipped: 0 }],
    ['a list in place of the object', []],
    ['no object at all', null],
  ])('a 200 it can’t read is a WorkspaceShapeError: %s', async (_label, body) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    respondWith(body);
    await expect(
      workspaceApi.setTaskSteps('a1', 't1', { requestId: 'r', ops: [{ op: 'tick', id: 's1' }] }),
    ).rejects.toBeInstanceOf(WorkspaceShapeError);
  });

  it('a refusal carries its status', async () => {
    failWith(404);
    const err = await workspaceApi
      .setTaskSteps('a1', 't1', { requestId: 'r', ops: [{ op: 'tick', id: 's1' }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceApiError);
    expect((err as WorkspaceApiError).status).toBe(404);
  });
});

describe('workspaceApi.setTaskFinishBy (TASK-951)', () => {
  it('sends the date and the browser’s zone with PUT and the CSRF header, to the task’s own address', async () => {
    const answer = { finishBy: { date: '2026-11-14', daysLeft: 9 } };
    const fetchSpy = respondWith(answer);
    await expect(
      workspaceApi.setTaskFinishBy('a 1', 'r/1', '2026-11-14', 'America/Los_Angeles'),
    ).resolves.toEqual(answer);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/api/workspace/tasks/a%201/r%2F1/finish-by');
    expect((init as RequestInit).method).toBe('PUT');
    expect(((init as RequestInit).headers as Record<string, string>)['x-requested-with']).toBe('ax-admin');
    expect(JSON.parse((init as RequestInit).body as string)).toStrictEqual({
      finishBy: '2026-11-14',
      timeZone: 'America/Los_Angeles',
    });
  });

  it('leaves the zone out when the browser named none (TASK-955)', async () => {
    const fetchSpy = respondWith({ finishBy: { date: '2026-11-14', daysLeft: 9 } });
    await workspaceApi.setTaskFinishBy('a1', 't1', '2026-11-14', null);
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toStrictEqual({ finishBy: '2026-11-14' });
  });

  it('sends null to remove the date, and reads the null answer', async () => {
    const fetchSpy = respondWith({ finishBy: null });
    await expect(workspaceApi.setTaskFinishBy('a1', 't1', null, null)).resolves.toEqual({ finishBy: null });
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toStrictEqual({ finishBy: null });
  });

  // "Saved" is a claim, so it rests on the server saying what it saved.
  it.each<[string, unknown]>([
    ['no finishBy', {}],
    ['a date no calendar has', { finishBy: { date: '2026-02-30', daysLeft: 1 } }],
    ['no object at all', null],
  ])('refuses an answer with %s', async (_label, body) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    respondWith(body);
    await expect(
      workspaceApi.setTaskFinishBy('a1', 't1', '2026-11-14', 'America/Los_Angeles'),
    ).rejects.toBeInstanceOf(WorkspaceShapeError);
  });

  it('carries the status of a failed save', async () => {
    failWith(404);
    const err = await workspaceApi
      .setTaskFinishBy('a1', 't1', '2026-11-14', 'America/Los_Angeles')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceApiError);
    expect((err as WorkspaceApiError).status).toBe(404);
  });
});

describe('workspaceApi.duplicateTask (TASK-953)', () => {
  it('posts only the request id to the task’s duplicate route, with the write headers', async () => {
    const fetchSpy = respondWith({ routineId: 'rtn_2' });
    await workspaceApi.duplicateTask('a1', 't1', { requestId: 'req-1' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/api/workspace/tasks/a1/t1/duplicate');
    expect((init as RequestInit).method).toBe('POST');
    expect(((init as RequestInit).headers as Record<string, string>)['x-requested-with']).toBe('ax-admin');
    expect(JSON.parse((init as RequestInit).body as string)).toStrictEqual({ requestId: 'req-1' });
  });

  it('answers the copy’s id', async () => {
    respondWith({ routineId: 'rtn_2' });
    await expect(workspaceApi.duplicateTask('a1', 't1', { requestId: 'req-1' })).resolves.toEqual({
      routineId: 'rtn_2',
    });
  });

  it.each<[string, unknown]>([
    ['no id', {}],
    ['an empty id', { routineId: '' }],
    ['a number for an id', { routineId: 7 }],
    ['a list in place of the object', []],
    ['no object at all', null],
  ])('a 200 it can’t read is a WorkspaceShapeError: %s', async (_label, body) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    respondWith(body);
    await expect(workspaceApi.duplicateTask('a1', 't1', { requestId: 'r' })).rejects.toBeInstanceOf(
      WorkspaceShapeError,
    );
  });

  it('a refusal is a WorkspaceApiError carrying its status', async () => {
    failWith(403);
    const err = await workspaceApi.duplicateTask('a1', 't1', { requestId: 'r' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceApiError);
    expect((err as WorkspaceApiError).status).toBe(403);
  });
});

/** A fetch that never answers: the host went quiet mid-request. */
function hangForever() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => {}));
}

describe('a request to a task that never answers (TASK-937)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.useRealTimers());

  const calls: Array<[string, () => Promise<unknown>]> = [
    ['task', () => workspaceApi.task('a1', 't1')],
    ['taskCheckin', () => workspaceApi.taskCheckin('a1', 't1', 'c1')],
    ['clearTaskNotes', () => workspaceApi.clearTaskNotes('a1', 't1')],
    ['sendTaskReply', () => workspaceApi.sendTaskReply('a1', 't1', { text: 'Yes', requestId: 'r1' })],
    ['completeTask', () => workspaceApi.completeTask('a1', 't1', { requestId: 'r1' })],
    ['reopenTask', () => workspaceApi.reopenTask('a1', 't1', { text: 'Again', requestId: 'r1' })],
    ['setTaskSteps', () => workspaceApi.setTaskSteps('a1', 't1', { requestId: 'r1', ops: [] })],
    ['setTaskFinishBy', () => workspaceApi.setTaskFinishBy('a1', 't1', null, null)],
    ['duplicateTask', () => workspaceApi.duplicateTask('a1', 't1', { requestId: 'r1' })],
  ];

  it.each(calls)('%s gives up at the deadline, as a RequestTimeoutError, and drops its request', async (_name, call) => {
    const fetchSpy = hangForever();
    const result = call();
    const settled = vi.fn();
    result.then(settled, settled);
    const assertion = expect(result).rejects.toBeInstanceOf(RequestTimeoutError);

    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect((fetchSpy.mock.calls[0]![1] as RequestInit).signal?.aborted).toBe(true);
  });

  it('the tasks list gets no request deadline (its 15 s race lives in useTasks)', async () => {
    const fetchSpy = hangForever();
    const result = workspaceApi.tasks();
    const settled = vi.fn();
    result.then(settled, settled);

    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * 2);
    expect(settled).not.toHaveBeenCalled();
    expect((fetchSpy.mock.calls[0]![1] as RequestInit).signal).toBeUndefined();
  });
});

describe('useTask over a read that never answers (TASK-937)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.useRealTimers());

  /** The first read answers with DETAIL; every read after it hangs. */
  function answerOnceThenHang() {
    const wire: unknown = JSON.parse(JSON.stringify(DETAIL));
    return vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => wire } as unknown as Response)
      .mockImplementation(() => new Promise<Response>(() => {}));
  }

  async function mountReady() {
    const fetchSpy = answerOnceThenHang();
    const hook = renderHook(() => useTask('a1', 't1'));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(hook.result.current.state).toMatchObject({ kind: 'ready', refreshing: false, refreshFailed: false });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    return { ...hook, fetchSpy };
  }

  it('a refresh that never answers ends at the deadline: buttons back, the failure said, quiet re-reads read again', async () => {
    const { result, fetchSpy } = await mountReady();

    act(() => result.current.refresh());
    expect(result.current.state).toMatchObject({ kind: 'ready', refreshing: true });
    // A quiet re-read waits out an ordinary refresh in flight.
    act(() => result.current.refreshQuietly());
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    await act(async () => vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1));
    expect(result.current.state).toMatchObject({ kind: 'ready', refreshing: true });

    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(result.current.state).toMatchObject({ kind: 'ready', refreshing: false, refreshFailed: true });

    act(() => result.current.refreshQuietly());
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('quiet re-reads that never answer count as failed ones: the third in a row says so', async () => {
    const { result } = await mountReady();

    for (let round = 1; round <= 3; round++) {
      act(() => result.current.refreshQuietly());
      await act(async () => vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS));
      expect(result.current.state).toMatchObject({
        kind: 'ready',
        refreshFailed: round === 3,
      });
    }
  });

  it('the deadline is under the poll interval, so a hung re-read fails before the next one replaces it', () => {
    expect(REQUEST_TIMEOUT_MS).toBeLessThan(TASK_POLL_INTERVAL_MS);
  });
});
