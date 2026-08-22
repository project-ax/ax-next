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

  it('accepts an explicit null row — the decision is gone, which is news', async () => {
    // `decision: null` is a legitimate answer and must NOT be treated as a
    // broken response: the poll's caller handles it, and conflating the two
    // would turn "this row no longer exists" into "the server is broken".
    respondWith({ decision: null });
    await expect(workspaceApi.decision('d1')).resolves.toEqual({
      decision: null,
    });
  });
});
