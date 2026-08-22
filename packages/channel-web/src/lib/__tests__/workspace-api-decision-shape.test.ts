/**
 * A 200 with the wrong body must not reach a renderer.
 *
 * Both decision READS feed `useDecisionQueue`, and both feed it code that
 * dereferences the result during React's RENDER phase: the list read lands in
 * state that `watchedKey` calls `.filter` on, and the single-row re-read goes
 * straight into `applyPolledRow`, which reads `row.id` inside a `setDecisions`
 * updater. So a malformed body did not degrade — it threw out of a hook, where
 * the poll's own `.catch` could never see it, and there is no ErrorBoundary in
 * this SPA. The whole chat surface unmounts.
 *
 * That was survivable while only the flag-gated `/workspace` mounted the queue.
 * TASK-261 puts it on the default `/` chat surface for every user on every page
 * load, and the poll runs once a second for anyone inside an undo window.
 *
 * The guard lives at the API boundary rather than in either caller precisely so
 * the two cannot drift: the first version of this fix covered the list read
 * only, and the poll went on crashing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workspaceApi, WorkspaceShapeError } from '../workspace-api';

function respondWith(body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response);
}

afterEach(() => vi.restoreAllMocks());

describe('what a shape failure is allowed to SAY', () => {
  /*
    `TodayView` renders `queue.error` verbatim in the alert, so this message is
    user-facing copy whether it was written as copy or not. The single-row
    re-read's path is `/decisions/dec_…`, so a message built from the path
    would put an internal decision id in front of a person — the same id
    TASK-260 spent a card removing from the transcript. Server-issued, so this
    is hygiene rather than injection; a person still cannot act on it.
  */
  it('carries no request path or decision id in its message', async () => {
    respondWith({});
    await expect(workspaceApi.decision('dec_abc123')).rejects.toSatisfy(
      (e: unknown) => {
        const msg = (e as Error).message;
        return (
          !msg.includes('dec_abc123') &&
          !msg.includes('/decisions') &&
          !msg.includes('/api/')
        );
      },
    );
  });

  it('keeps the path on the error for logs', async () => {
    respondWith({});
    await expect(workspaceApi.decision('dec_abc123')).rejects.toSatisfy(
      (e: unknown) => (e as WorkspaceShapeError).path.includes('dec_abc123'),
    );
  });
});

describe('the decisions list read', () => {
  it('rejects a 200 with no decisions array rather than reporting an empty queue', async () => {
    respondWith({});
    await expect(workspaceApi.decisions()).rejects.toBeInstanceOf(
      WorkspaceShapeError,
    );
  });

  it('rejects a 200 whose decisions field is not an array', async () => {
    respondWith({ decisions: null });
    await expect(workspaceApi.decisions()).rejects.toBeInstanceOf(
      WorkspaceShapeError,
    );
  });

  it('rejects a page containing a null row', async () => {
    // Every ELEMENT, not just the array: one bad row crashes render the same
    // way a missing array does — `undoSecondsLeft(d)` and `d.conversationId`
    // both dereference it.
    respondWith({ decisions: [null] });
    await expect(workspaceApi.decisions()).rejects.toBeInstanceOf(
      WorkspaceShapeError,
    );
  });

  it('accepts an honestly empty page', async () => {
    // The one body that IS allowed to mean "nothing is waiting on you".
    respondWith({ decisions: [] });
    await expect(workspaceApi.decisions()).resolves.toEqual({ decisions: [] });
  });
});

describe('the single-decision re-read (the undo-window poll)', () => {
  it('rejects a 200 with no decision key', async () => {
    respondWith({});
    await expect(workspaceApi.decision('d1')).rejects.toBeInstanceOf(
      WorkspaceShapeError,
    );
  });

  it('rejects an unrelated 200 body', async () => {
    respondWith({ error: 'something else entirely' });
    await expect(workspaceApi.decision('d1')).rejects.toBeInstanceOf(
      WorkspaceShapeError,
    );
  });

  /*
    The regression an earlier version of this file LAUNDERED as covered.

    It asserted that `{decision: null}` resolves, on the theory that a null row
    means "it is gone, which is news". That was false twice over. The server
    404s for a missing row rather than sending it — `resolvedOrGone` says so in
    its own comment: "404, never a 200 carrying `decision: null` … the client
    would apply it over the row the person is looking at". And the poll's only
    consumer hands the result straight to `applyPolledRow`, typed
    `(row: Decision)`, which reads `row.id` inside a `setDecisions` updater — so
    the null threw during render rather than being "handled".

    A green test asserting the wrong contract is worse than no test: it stops
    the next person looking.
  */
  it('rejects a null row rather than handing it to the poll to dereference', async () => {
    respondWith({ decision: null });
    await expect(workspaceApi.decision('d1')).rejects.toBeInstanceOf(
      WorkspaceShapeError,
    );
  });

  it('accepts a real row', async () => {
    const decision = { id: 'd1', status: 'executed' };
    respondWith({ decision });
    await expect(workspaceApi.decision('d1')).resolves.toEqual({ decision });
  });
});
