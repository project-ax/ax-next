/**
 * The workspace grant store (TASK-350).
 *
 * Chat's `permission-card-store` is a single slot, because chat shows one card
 * at a time above the composer. Today is a QUEUE — two grants can legitimately
 * be open at once — so this store is a list, and the interesting behaviour is
 * all about identity: one grant must be one row, however many times the frame
 * arrives.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  getWorkspaceGrantSnapshot,
  grantKey,
  isRenderableGrant,
  workspaceGrantActions,
} from '../lib/workspace-grant-store';
import {
  getGrantDraft,
  resetGrantDraftsForTest,
  setGrantDraftValue,
} from '../lib/workspace-grant-drafts';
import type { PermissionRequest } from '../server/types';

const skill = (skillId = 'linear'): PermissionRequest => ({
  kind: 'skill',
  skillId,
  description: 'File and read Linear issues',
  hosts: ['api.linear.app'],
  slots: [{ slot: 'api_key', kind: 'api-key' }],
});

const connector = (connectorId = 'linear'): PermissionRequest => ({
  kind: 'connector',
  connectorId,
  name: 'Linear',
  hosts: ['api.linear.app'],
  slots: [],
});

const host = (h = 'example.org', sessionId = 's-1'): PermissionRequest => ({
  kind: 'host',
  host: h,
  sessionId,
});

/**
 * Where a grant came from. Every test below raises from one agent unless it is
 * specifically about two, so the default keeps the interesting argument — the
 * request — the only one that varies.
 */
const from = (agentId = 'a-quill', conversationId: string | null = 'cnv-1') => ({
  conversationId,
  agentId,
});

afterEach(() => {
  resetGrantDraftsForTest();
});

beforeEach(() => {
  workspaceGrantActions.resetForTest();
});

describe('grantKey — identity per kind', () => {
  test('a grant is identified by its subject, not by the frame that carried it', () => {
    expect(grantKey(skill('linear'))).toBe('skill:linear');
    expect(grantKey(connector('linear'))).toBe('connector:linear');
    expect(grantKey(host('example.org'))).toBe('host:example.org');
  });

  test('the three kinds cannot collide on one subject name', () => {
    // A skill and a connector can share a slug — they are still two grants.
    const keys = new Set([
      grantKey(skill('linear')),
      grantKey(connector('linear')),
      grantKey(host('linear')),
    ]);
    expect(keys.size).toBe(3);
  });

  test("a host's key ignores the session it was raised on", () => {
    // The person is answering a question about a SITE. Two sessions blocked on
    // the same host is still one question; the newer session id wins for the
    // POST, which `raise` handles by replacing in place.
    expect(grantKey(host('example.org', 's-1'))).toBe(
      grantKey(host('example.org', 's-2')),
    );
  });
});

describe('raise — one grant, one row', () => {
  test('two different grants both appear, in arrival order', () => {
    workspaceGrantActions.raise(skill('linear'), from());
    workspaceGrantActions.raise(host('example.org'), from());

    expect(getWorkspaceGrantSnapshot().grants.map((g) => g.key)).toEqual([
      'skill:linear',
      'host:example.org',
    ]);
  });

  test('the same grant arriving twice produces one row, not two', () => {
    // The SSE buffer replays a pending card on reconnect (TASK-82), so this is
    // the ordinary case, not a rare one.
    workspaceGrantActions.raise(skill('linear'), from());
    workspaceGrantActions.raise(skill('linear'), from());

    expect(getWorkspaceGrantSnapshot().grants).toHaveLength(1);
  });

  test('a repeat replaces in place — it keeps its position and takes the newer payload', () => {
    workspaceGrantActions.raise(skill('linear'), from());
    workspaceGrantActions.raise(host('example.org', 's-1'), from());
    workspaceGrantActions.raise(skill('linear'), from());
    // Re-raised with a fresher session; the POST must target that one.
    workspaceGrantActions.raise(host('example.org', 's-2'), from());

    const grants = getWorkspaceGrantSnapshot().grants;
    expect(grants.map((g) => g.key)).toEqual(['skill:linear', 'host:example.org']);
    const raised = grants[1]?.request;
    expect(raised?.kind === 'host' && raised.sessionId).toBe('s-2');
  });
});

describe('raise — the origin rides along (TASK-351)', () => {
  test('the agent that asked is recorded, so presence can route the row', () => {
    workspaceGrantActions.raise(skill('linear'), from('a-quill'));

    expect(getWorkspaceGrantSnapshot().grants[0]?.agentId).toBe('a-quill');
  });

  test('two agents asking for the SAME subject is still one row', () => {
    // Identity is the subject, not the (subject, agent) pair. Keying on the
    // pair would put two rows in the queue for one question — which, with a
    // second render site added, is exactly the two live copies invariant 4
    // forbids. The newer origin wins, as the newer payload does.
    workspaceGrantActions.raise(connector('linear'), from('a-quill'));
    workspaceGrantActions.raise(connector('linear'), from('a-scout'));

    const grants = getWorkspaceGrantSnapshot().grants;
    expect(grants).toHaveLength(1);
    expect(grants[0]?.agentId).toBe('a-scout');
  });

  test('a re-raise cannot silently keep a stale origin', () => {
    // Both halves of the origin move together: the thread it routes to and
    // the conversation the answer POST targets came from the same producer,
    // and half-updating would answer the old turn from the new thread.
    workspaceGrantActions.raise(skill('linear'), from('a-quill', 'cnv-1'));
    workspaceGrantActions.raise(skill('linear'), from('a-scout', 'cnv-2'));

    const row = getWorkspaceGrantSnapshot().grants[0];
    expect(row?.agentId).toBe('a-scout');
    expect(row?.conversationId).toBe('cnv-2');
  });
});

describe('raise — a kind this build cannot draw', () => {
  /*
    `grantKey`'s switch is exhaustive over the union, so TypeScript is satisfied
    and NOTHING happens at runtime: a fourth kind falls off the end and the key
    comes back `undefined`. A row keyed `undefined` reaches `GrantRow`, which
    reads fields the unknown shape does not have, and the throw lands in the
    workspace `ErrorBoundary` — so the one row we could not read takes every
    grant and decision on the surface down with it.

    This is a version-skew case, not a corrupt-payload case: a server that adds
    a fourth `PermissionRequest` kind does exactly this to every client built
    before it. So the answer is to skip the row and keep the queue, not to fail.
  */

  /** A kind from a future server. Cast because the union deliberately excludes it. */
  const fromTheFuture = () =>
    ({ kind: 'device', deviceId: 'd-1' }) as unknown as PermissionRequest;

  test('it is refused rather than keyed `undefined`', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    workspaceGrantActions.raise(fromTheFuture(), from());

    expect(getWorkspaceGrantSnapshot().grants).toHaveLength(0);
    // Loud for whoever is debugging the skew, silent for the person: they
    // simply do not see a row they could not have answered anyway.
    //
    // The ARGUMENT is pinned, not just the call. The entire justification for
    // logging here is that the `kind` is what makes the warning actionable
    // during a version skew — `toHaveBeenCalled()` alone would stay green if
    // someone dropped it back to a bare message.
    expect(warn).toHaveBeenCalledWith(expect.any(String), { kind: 'device' });
    warn.mockRestore();
  });

  test('and it does not take the rest of the queue with it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    workspaceGrantActions.raise(skill('linear'), from());
    workspaceGrantActions.raise(fromTheFuture(), from());
    workspaceGrantActions.raise(host('example.org'), from());

    expect(getWorkspaceGrantSnapshot().grants.map((g) => g.key)).toEqual([
      'skill:linear',
      'host:example.org',
    ]);
    warn.mockRestore();
  });

  test('isRenderableGrant accepts the three kinds this build draws', () => {
    // The positive half, and it has to come first: every rejection below would
    // pass equally well against a predicate that refused everything, and a
    // guard that drops all grants is a worse bug than the one it fixes. Pinned
    // here, where the predicate lives, so a fourth kind added to `grantKey`
    // without adding it here reddens a test rather than silently dropping
    // every grant of that kind at both call sites.
    expect(isRenderableGrant(skill('linear'))).toBe(true);
    expect(isRenderableGrant(connector('linear'))).toBe(true);
    expect(isRenderableGrant(host('example.org'))).toBe(true);
  });

  test('isRenderableGrant refuses a kind it has never heard of', () => {
    expect(isRenderableGrant({ kind: 'device' })).toBe(false);
    expect(isRenderableGrant({})).toBe(false);
    expect(isRenderableGrant(null)).toBe(false);
    expect(isRenderableGrant('skill')).toBe(false);
    expect(isRenderableGrant([])).toBe(false);
  });

  test('isRenderableGrant refuses a right kind with a missing crash-surface field', () => {
    /*
      The discriminant alone was not enough. `GrantRow` ITERATES `hosts` and
      `slots` — `.length`, `.map`, and a `.filter` over the slot names — so a
      skill card that arrives without them throws exactly as hard as an unknown
      kind does, and buries the same surface. The id is checked because it
      BECOMES the key: `skill:undefined` is a row two different questions would
      share.
    */
    expect(isRenderableGrant({ kind: 'skill', skillId: 'linear' })).toBe(false);
    expect(
      isRenderableGrant({ kind: 'skill', skillId: 'linear', hosts: [] }),
    ).toBe(false);
    expect(
      isRenderableGrant({ kind: 'skill', hosts: [], slots: [] }),
    ).toBe(false);
    expect(
      isRenderableGrant({ kind: 'connector', connectorId: 'linear', hosts: [] }),
    ).toBe(false);
    // A slot the row cannot name is no better than no slots at all.
    expect(
      isRenderableGrant({
        kind: 'skill',
        skillId: 'linear',
        hosts: [],
        slots: [{ kind: 'api-key' }],
      }),
    ).toBe(false);
    expect(isRenderableGrant({ kind: 'host' })).toBe(false);
  });

  test('isRenderableGrant lets through what the ROW is known to tolerate', () => {
    /*
      `description`, `name`, `sessionId` and `packages` are not required here,
      on purpose: none of them decides whether the question can be ANSWERED, so
      refusing a grant over one would trade a plain-looking row for a question
      that silently never gets asked.

      THE FIRST VERSION OF THIS TEST WAS A LIE, and it is worth the paragraph.
      It said a missing `description` "renders a shabby row, never a throw" —
      but `GrantRow` was reading `description.length` unguarded, so it threw
      exactly as hard as a missing `hosts` and buried the same surface. Review
      caught it. The fix went to the RENDER SITE (`GrantRow.tsx`, with its own
      regression tests) rather than to this guard, which is what makes the
      sentence above true and keeps the answerable grant.

      A SECOND round of review then caught the same mistake on `name`, cleared
      because interpolation "cannot throw" — true, and the wrong test. It
      renders "Connect undefined" over a password field instead, which is
      quieter and worse.

      So these assertions are only meaningful next to the render-site tests: a
      guard may leave a field out ONLY if the renderer is known to tolerate its
      absence, where TOLERATE means "renders something a person can act on",
      not "does not throw". Verify it; never infer it from the field sounding
      decorative.
    */
    expect(
      isRenderableGrant({ kind: 'skill', skillId: 'linear', hosts: [], slots: [] }),
    ).toBe(true);
    // A connector with no `name`. Renderable on purpose — and `GrantRow` has a
    // real fallback for it (`humanizeId(connectorId)`), pinned over there in
    // `GrantRow.test.tsx`. Without that fallback this assertion was licensing
    // a card titled "Connect undefined" above a password field: the second
    // time this suite cleared a field on "it cannot throw" rather than on what
    // the person would actually see.
    expect(
      isRenderableGrant({
        kind: 'connector',
        connectorId: 'linear',
        hosts: [],
        slots: [],
      }),
    ).toBe(true);
    expect(isRenderableGrant({ kind: 'host', host: 'example.org' })).toBe(true);
  });
});

describe('raise — TASK-113: the wall does not speak over the connector card', () => {
  test('a host grant is dropped while a connector grant is open', () => {
    // On a warm turn the upfront connector card and a same-turn reactive egress
    // wall both fire. The connector card is the ROOT CAUSE — the wall is
    // downstream of the same missing connector — so a second row would point at
    // a cause the first row already names.
    workspaceGrantActions.raise(connector('linear'), from());
    workspaceGrantActions.raise(host('api.linear.app'), from());

    expect(getWorkspaceGrantSnapshot().grants.map((g) => g.key)).toEqual([
      'connector:linear',
    ]);
  });

  test('a connector grant still arrives while a host grant is open', () => {
    // Connector wins both directions.
    workspaceGrantActions.raise(host('api.linear.app'), from());
    workspaceGrantActions.raise(connector('linear'), from());

    expect(getWorkspaceGrantSnapshot().grants.map((g) => g.key)).toEqual([
      'host:api.linear.app',
      'connector:linear',
    ]);
  });

  test('a host grant is NOT dropped while only a skill grant is open', () => {
    // The guard is exactly one condition. A skill card is not the wall's cause.
    workspaceGrantActions.raise(skill('linear'), from());
    workspaceGrantActions.raise(host('example.org'), from());

    expect(getWorkspaceGrantSnapshot().grants).toHaveLength(2);
  });

  test('once the connector grant is resolved, the wall can be raised again', () => {
    workspaceGrantActions.raise(connector('linear'), from());
    workspaceGrantActions.raise(host('api.linear.app'), from());
    expect(getWorkspaceGrantSnapshot().grants).toHaveLength(1);

    workspaceGrantActions.resolve('connector:linear');
    workspaceGrantActions.raise(host('api.linear.app'), from());

    expect(getWorkspaceGrantSnapshot().grants.map((g) => g.key)).toEqual([
      'host:api.linear.app',
    ]);
  });
});

describe('resolve and reset', () => {
  test('resolving removes exactly that row', () => {
    workspaceGrantActions.raise(skill('linear'), from());
    workspaceGrantActions.raise(skill('github'), from());
    workspaceGrantActions.resolve('skill:linear');

    expect(getWorkspaceGrantSnapshot().grants.map((g) => g.key)).toEqual([
      'skill:github',
    ]);
  });

  test('resolving a key that is not there changes nothing and does not notify', () => {
    workspaceGrantActions.raise(skill('linear'), from());
    const before = getWorkspaceGrantSnapshot().grants;
    const hits = vi.fn();
    const unsub = workspaceGrantActions.subscribeForTest(hits);

    workspaceGrantActions.resolve('skill:nope');

    expect(getWorkspaceGrantSnapshot().grants).toBe(before); // same reference
    expect(hits).not.toHaveBeenCalled();
    unsub();
  });

  test('reset empties the queue — evidence from one agent cannot speak for another', () => {
    workspaceGrantActions.raise(skill('linear'), from());
    workspaceGrantActions.reset();

    expect(getWorkspaceGrantSnapshot().grants).toEqual([]);
  });

  /*
    BACKSTOP (TASK-389 review). `GrantRow` already clears its own draft at every
    exit it drives — these two tests are for a grant resolved SOME OTHER WAY,
    with no `GrantRow` in the loop: a future bulk-resolve, a server push. Without
    this, a typed-but-unsubmitted secret could sit in `workspace-grant-drafts.ts`
    indefinitely after the grant it belonged to is gone.
  */
  test('resolve clears the draft too, even for a key this snapshot never held', () => {
    setGrantDraftValue('skill:nope', 'api_key', 'lin_ghost');

    workspaceGrantActions.resolve('skill:nope');

    expect(getGrantDraft('skill:nope')).toEqual({});
  });

  test('reset clears every draft, not just the grants', () => {
    setGrantDraftValue('skill:linear', 'api_key', 'lin_1');
    setGrantDraftValue('skill:github', 'api_key', 'gh_1');

    workspaceGrantActions.reset();

    expect(getGrantDraft('skill:linear')).toEqual({});
    expect(getGrantDraft('skill:github')).toEqual({});
  });

  test('subscribers are notified on a change and released on unsubscribe', () => {
    const hits = vi.fn();
    const unsub = workspaceGrantActions.subscribeForTest(hits);

    workspaceGrantActions.raise(skill('linear'), from());
    expect(hits).toHaveBeenCalledTimes(1);

    unsub();
    workspaceGrantActions.raise(skill('github'), from());
    expect(hits).toHaveBeenCalledTimes(1);
  });
});
