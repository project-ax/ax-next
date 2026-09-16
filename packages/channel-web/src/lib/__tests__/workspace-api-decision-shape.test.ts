/**
 * A 200 with the wrong body must not reach a renderer.
 *
 * Both decision READS feed `useDecisionQueue`, and both feed it code that
 * dereferences the result during React's RENDER phase: the list read lands in
 * state that `watchedKey` calls `.filter` on, and the single-row re-read goes
 * straight into `applyPolledRow`, which reads `row.id` inside a `setDecisions`
 * updater. So a malformed body did not degrade — it threw out of a hook, where
 * the poll's own `.catch` could never see it, and before TASK-273's
 * per-surface boundaries the whole chat surface unmounted.
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
    `TodayView` used to render `queue.error` verbatim in the alert, which made
    this message user-facing copy whether it was written as copy or not.
    TASK-276 replaced that with authored copy, so it now reaches a
    `console.warn` instead — and the rule holds regardless. The single-row
    re-read's path is `/decisions/dec_…`, so a message built from the path
    carries an internal decision id, the same id TASK-260 spent a card removing
    from the transcript, into a string these surfaces have already once put in
    front of a person. Server-issued, so this is hygiene rather than injection;
    a person still cannot act on it.
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

describe('the grants read-back (TASK-373)', () => {
  /*
    Same boundary, same rule — with one difference worth spelling out. The
    decision reads dereference rows during RENDER; the grants read feeds
    `workspaceGrantActions.raise()`, which dereferences `request` (the subject
    key) and `conversationId` (what the answer POST targets) inside the
    shell's mount effect. A throw there does not hit a React boundary — it is
    an unhandled rejection nobody is watching — so the guard catches it here,
    where a malformed body fails loudly instead of being applied.
  */
  /*
    A row the product could actually DRAW. It used to stop at
    `{ kind: 'skill', skillId: 'linear' }`, which was never a real row: `hosts`
    and `slots` are what `GrantRow` iterates, and without them it throws. The
    fixture passed anyway because the guard only asked whether `request` was an
    object — so "accepts a real row" was, until TASK-351 widened the guard,
    accepting a row that would have taken the workspace down.
  */
  const realRow = {
    conversationId: 'cnv-1',
    agentId: 'a-quill',
    request: {
      kind: 'skill',
      skillId: 'linear',
      description: 'File and read Linear issues',
      hosts: ['api.linear.app'],
      slots: [{ slot: 'api_key', kind: 'api-key' }],
    },
  };

  it('rejects a 200 with no grants array', async () => {
    respondWith({});
    await expect(workspaceApi.grants()).rejects.toBeInstanceOf(
      WorkspaceShapeError,
    );
  });

  it('rejects a row whose request is missing — raise() dereferences it', async () => {
    respondWith({ grants: [{ conversationId: 'cnv-1', agentId: 'a-quill' }] });
    await expect(workspaceApi.grants()).rejects.toBeInstanceOf(
      WorkspaceShapeError,
    );
  });

  it('rejects a row with no conversationId — the answer POST targets it', async () => {
    respondWith({
      grants: [{ agentId: 'a-quill', request: { kind: 'skill', skillId: 'linear' } }],
    });
    await expect(workspaceApi.grants()).rejects.toBeInstanceOf(
      WorkspaceShapeError,
    );
  });

  it('rejects a row with no agentId — presence routes on it (TASK-351)', async () => {
    /*
      The one field whose absence used to be INVISIBLE. `PendingGrant.agentId`
      is typed `string`, so an `undefined` here type-checks its way into the
      store, matches no route, and quietly costs the grant its thread — a
      degradation with no error anywhere. It became load-bearing the moment
      presence started reading it, so it is checked like the other two.
    */
    respondWith({
      grants: [
        { conversationId: 'cnv-1', request: { kind: 'skill', skillId: 'linear' } },
      ],
    });
    await expect(workspaceApi.grants()).rejects.toBeInstanceOf(
      WorkspaceShapeError,
    );
  });

  it('rejects a row whose request has no kind we can draw', async () => {
    /*
      `request` being an object was never enough. `grantKey` switches on the
      DISCRIMINANT and its switch is exhaustive over the union, which means a
      `kind` from outside the union returns `undefined` at runtime with nothing
      complaining — and then `GrantRow` reaches for fields that shape has not
      got. The throw lands in the workspace `ErrorBoundary`, so ONE unreadable
      row buries every legible grant AND every decision beside it.

      Failing the read instead keeps the rest of the surface: the shell already
      knows how to say it could not check the grants without claiming the day
      was empty.
    */
    respondWith({
      grants: [
        {
          conversationId: 'cnv-1',
          agentId: 'a-quill',
          request: { kind: 'device', deviceId: 'd-1' },
        },
      ],
    });
    await expect(workspaceApi.grants()).rejects.toBeInstanceOf(
      WorkspaceShapeError,
    );
  });

  it('rejects a row whose request is an empty object', async () => {
    // The cheapest version of the same hole, and the one a half-written server
    // handler actually produces.
    respondWith({
      grants: [{ conversationId: 'cnv-1', agentId: 'a-quill', request: {} }],
    });
    await expect(workspaceApi.grants()).rejects.toBeInstanceOf(
      WorkspaceShapeError,
    );
  });

  it('rejects a right-kind row missing the fields the row iterates', async () => {
    // `kind: 'skill'` is not on its own enough to draw: `GrantRow` maps over
    // `hosts` and `slots`, so a row without them throws the same way an unknown
    // kind does, and takes the same surface with it.
    respondWith({
      grants: [
        {
          conversationId: 'cnv-1',
          agentId: 'a-quill',
          request: { kind: 'skill', skillId: 'linear', description: 'x' },
        },
      ],
    });
    await expect(workspaceApi.grants()).rejects.toBeInstanceOf(
      WorkspaceShapeError,
    );
  });

  it('accepts all three kinds it CAN draw', async () => {
    /*
      The positive control for the two rejections above: without it they would
      pass just as well against a guard that refused everything, and a grants
      read that always throws is a worse bug than the one being fixed.
    */
    const grants = [
      {
        conversationId: 'cnv-1',
        agentId: 'a-quill',
        request: { kind: 'skill', skillId: 'linear', description: '', hosts: [], slots: [] },
      },
      {
        conversationId: 'cnv-2',
        agentId: 'a-quill',
        request: { kind: 'connector', connectorId: 'linear', name: 'Linear', hosts: [], slots: [] },
      },
      {
        conversationId: 'cnv-3',
        agentId: 'a-scout',
        request: { kind: 'host', host: 'example.org', sessionId: 's-1' },
      },
    ];
    respondWith({ grants });
    await expect(workspaceApi.grants()).resolves.toEqual({ grants });
  });

  it('accepts an honestly empty page', async () => {
    respondWith({ grants: [] });
    await expect(workspaceApi.grants()).resolves.toEqual({ grants: [] });
  });

  it('accepts a real row', async () => {
    respondWith({ grants: [realRow] });
    await expect(workspaceApi.grants()).resolves.toEqual({ grants: [realRow] });
  });
});
