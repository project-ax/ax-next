/**
 * `workspaceApi.task()` and `workspaceApi.clearTaskNotes()`: a task page's
 * read and its one write (TASK-910).
 *
 * The same boundary rule as `tasks()`: a 200 whose body is not the shape the
 * page draws from is a `WorkspaceShapeError`, thrown here, so the page's
 * "couldn't load" state shows instead of a render crash on a missing field.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHECK_IN_MISSES } from '@ax/routines-contract';
import { workspaceApi, WorkspaceApiError, WorkspaceShapeError } from '../workspace-api';
import type { TaskDetail, TaskDetailReport, TaskNoRecentUpdate, TaskUpdate } from '../workspace-types';

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

const REPORT: TaskDetailReport = {
  status: 'needs-you',
  update: 'Two tickets need a refund decision',
  ask: 'Can I refund order 1182?',
  agentNotes: 'Ticket 1182 is waiting on finance.',
  reportedAt: '2026-10-22T12:00:00.000Z',
};

const UPDATE: TaskUpdate = {
  firedAt: '2026-10-22T12:00:00.000Z',
  status: 'ok',
  error: null,
  report: { status: 'needs-you', update: 'Two tickets need a refund decision' },
  conversationId: 'c1',
};

const MISS: TaskNoRecentUpdate = {
  inARow: 2,
  reason: 'brief-too-long',
  at: '2026-10-22T11:00:00.000Z',
  autoPaused: false,
};

const DETAIL: TaskDetail = {
  agentName: 'Quill',
  name: 'Watch the support queue',
  enabled: true,
  revision: 'rev-1',
  permissions: { fire: true, stop: true, edit: true },
  schedule: 'every hour, 9:00 AM to 6:00 PM (America/New_York)',
  nextCheckAt: '2026-10-22T13:00:00.000Z',
  brief: { promptBody: 'Read new tickets.', goodWhen: 'No ticket waits a day.' },
  task: REPORT,
  noRecentUpdate: null,
  updates: [
    UPDATE,
    { firedAt: '2026-10-22T11:00:00.000Z', status: 'error', error: 'The check-in ran out of time.', report: null, conversationId: null },
    { firedAt: '2026-10-22T10:00:00.000Z', status: 'silenced', error: null, report: { status: 'on-track', update: null }, conversationId: 'c3' },
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

  it('reads missed check-ins, for every reason the contract names', async () => {
    for (const reason of CHECK_IN_MISSES) {
      const body: TaskDetail = { ...DETAIL, noRecentUpdate: { ...MISS, reason, autoPaused: true } };
      respondWith(body);
      await expect(workspaceApi.task('a1', 't1')).resolves.toEqual(body);
    }
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
      { ...DETAIL, updates: [{ ...UPDATE, report: { status: 'stuck', update: null } }] },
    ],
    [
      'an update whose report’s text isn’t text',
      { ...DETAIL, updates: [{ ...UPDATE, report: { status: 'on-track', update: 3 } }] },
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
