/**
 * The workspace grant row (TASK-350).
 *
 * Three kinds, and — the thing the card body got wrong — TWO different POST
 * targets. A `skill` or `connector` grant goes to `/api/chat/permission-decision`;
 * a `host` grant goes to `/api/chat/allow-host`, because
 * `PermissionDecisionRequest` refines that exactly one of skillId/connectorId is
 * present and has no host arm at all. A row that posted all three to the same
 * place would 400 on a third of the work.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GrantRow } from '../GrantRow';
import { grantKey } from '@/lib/workspace-grant-store';
import { getGrantDraft, resetGrantDraftsForTest } from '@/lib/workspace-grant-drafts';
import { HTTP_SERVER_ERROR, HTTP_UNAVAILABLE } from '@/lib/http';
import {
  GRANT_NO_CONVERSATION,
  GRANT_REASSURANCE,
  GRANT_REJECT_HINT,
  GRANT_REJECT_LABEL,
  KEY_SAFETY,
  SLOT_HINT,
} from '@/lib/grant-copy';
import type { PermissionRequest } from '@/server/types';

function row(
  request: PermissionRequest,
  conversationId: string | null = 'cnv-1',
  /**
   * Did the agent start again (TASK-374)? Defaults to yes, because that is the
   * path every pre-existing case here was written against: the row resolves and
   * disappears. The `false` case gets its own describe block.
   */
  onGranted = vi.fn(async () => true),
) {
  const onResolved = vi.fn();
  const { unmount } = render(
    <GrantRow
      grant={{ key: grantKey(request), request, conversationId, agentId: 'a-quill' }}
      onResolved={onResolved}
      onGranted={onGranted}
    />,
  );
  return { onResolved, onGranted, unmount };
}

function okFetch() {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
}

const skillReq: PermissionRequest = {
  kind: 'skill',
  skillId: 'linear-issues',
  description: 'File and read Linear issues',
  hosts: ['api.linear.app'],
  slots: [{ slot: 'api_key', kind: 'api-key' }],
};

const connectorReq: PermissionRequest = {
  kind: 'connector',
  connectorId: 'linear',
  name: 'Linear',
  hosts: ['api.linear.app'],
  slots: [],
};

const hostReq: PermissionRequest = {
  kind: 'host',
  host: 'example.org',
  sessionId: 'sess-9',
};

afterEach(() => {
  vi.restoreAllMocks();
  resetGrantDraftsForTest();
});

describe('a payload the guard lets through but the row must survive', () => {
  /*
    `isRenderableGrant` deliberately does not require `description` or
    `packages`: neither decides whether the question can be ANSWERED, and
    refusing a grant over one would trade a plain-looking row for a question
    that silently never gets asked. That trade is only honest if the row
    actually tolerates their absence — and it did not.

    Both of these threw `TypeError` during render. The workspace
    `ErrorBoundary` catches the throw, which makes it look survivable, but it
    is scoped to the whole surface: ONE such row took every other legible grant
    AND every decision down with it. That is the exact failure the shape guard
    beside it exists to prevent, still reachable through the fields the guard
    was told it could skip.

    Caught in review, not by these tests — the first version of the guard's
    comment asserted "a missing description renders a shabby row, never a
    throw", which was simply false. The rule worth keeping: a guard may only
    leave a field out if the renderer is known to tolerate its absence. Check
    it; do not infer it from the field sounding decorative.
  */

  test('a skill with no description renders an answerable row, not the word "undefined"', () => {
    // `haveExisting` so Connect is genuinely ENABLED: the claim being pinned is
    // that the grant is still answerable, and an unfilled slot would disable
    // the button for an unrelated and correct reason, making the assertion say
    // less than it looks like it says.
    const noDescription = {
      kind: 'skill',
      skillId: 'linear-issues',
      hosts: ['api.linear.app'],
      slots: [{ slot: 'api_key', kind: 'api-key', haveExisting: true }],
    } as unknown as PermissionRequest;

    row(noDescription);

    expect(screen.getByText('Connect Linear issues')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^connect$/i })).toBeEnabled();
    expect(screen.getByText(GRANT_REASSURANCE)).toBeTruthy();
    // NOT merely "did not throw". `String(request.description)` would also not
    // throw — and would print a paragraph reading "undefined" at the person.
    // Absent is the only acceptable rendering of an absent description.
    expect(screen.queryByText('undefined')).toBeNull();
  });

  test('a non-string description is dropped rather than rendered', () => {
    /*
      This is what the `typeof` guard buys over a bare `?? ''`, and it had a
      four-line comment calling it load-bearing and no test at all — the same
      "asserted in prose, never verified" move that produced the two bugs this
      block exists for.

      `{ length: 5 }` is the shape that separates them: `?? ''` passes it
      through (it is not nullish), `.length > 0` is then true, and React throws
      on an object child. The `typeof` check drops it instead.
    */
    const objectDescription = {
      ...skillReq,
      description: { length: 5 },
    } as unknown as PermissionRequest;

    row(objectDescription);

    expect(screen.getByText('Connect Linear issues')).toBeTruthy();
    expect(screen.queryByText('undefined')).toBeNull();
  });

  test('a connector with no name is titled from its id, never "Connect undefined"', () => {
    /*
      THE MAJOR FROM THE SECOND REVIEW ROUND. `name` was excluded from
      `isRenderableGrant` on the grounds that interpolating it "cannot throw".
      True, and the wrong test — `Connect ${undefined}` renders the literal
      words "Connect undefined" above KEY_SAFETY copy and a `type="password"`
      input. A credential prompt whose subject is missing is worse than a crash,
      because a crash is loud and this just quietly asks for an API key on
      behalf of nobody.

      Excluding `name` from the guard is still right — a nameless connector is
      an answerable grant, and refusing it would cost the person the question.
      What was missing is the fallback, and `connectorId` is guarded, so it is
      always there.
    */
    const nameless = {
      kind: 'connector',
      connectorId: 'linear',
      hosts: ['api.linear.app'],
      slots: [],
    } as unknown as PermissionRequest;

    row(nameless);

    expect(screen.getByText('Connect Linear')).toBeTruthy();
    expect(screen.queryByText(/undefined/)).toBeNull();
  });

  test('an empty-string name falls back the same way', () => {
    // Absent and blank are the same thing to a reader, so they are the same
    // thing here. A `.trim()`-less check would have let this one through.
    const blankName = {
      ...connectorReq,
      name: '   ',
    } as unknown as PermissionRequest;

    row(blankName);

    expect(screen.getByText('Connect Linear')).toBeTruthy();
  });

  test('a real connector name still wins over the fallback', () => {
    // The positive control: the fallback must not have replaced the name.
    row({ ...connectorReq, name: 'Linear Issues' } as PermissionRequest);

    expect(screen.getByText('Connect Linear Issues')).toBeTruthy();
  });

  test('a half-filled packages list renders the row instead of throwing', () => {
    // `npm` and `pypi` are both required when `packages` is present, so this
    // is off-type — which is precisely why only the wire can produce it, and
    // why the type system was never going to catch it here.
    const halfPackages = {
      ...skillReq,
      packages: { pypi: ['requests'] },
    } as unknown as PermissionRequest;

    row(halfPackages);

    expect(screen.getByText('Connect Linear issues')).toBeTruthy();
    // The one list that IS there still counts: the line appears rather than
    // being quietly dropped along with the crash.
    expect(screen.getByTestId('grant-packages')).toBeTruthy();
  });

  test('a packages list with npm present and pypi absent renders too', () => {
    /*
      THE OTHER DIRECTION, and it was genuinely unpinned: the `{ pypi: [...] }`
      case above short-circuits on the first operand, so deleting the `pypi?.`
      guard left the whole suite green. `{ npm: [] }` is the fixture that
      reaches the second operand — `npm.length > 0` is false, so evaluation
      continues to `pypi`, which is not there.

      `{ npm: ['x'] }` would NOT do it: a truthy first operand short-circuits
      before `pypi` is ever touched. Two guards need two fixtures.
    */
    const npmOnly = {
      ...skillReq,
      packages: { npm: [] },
    } as unknown as PermissionRequest;

    row(npmOnly);

    expect(screen.getByText('Connect Linear issues')).toBeTruthy();
    // Both lists are empty-or-absent, so there is nothing to announce.
    expect(screen.queryByTestId('grant-packages')).toBeNull();
  });

  test('a non-string account does not crash the row (TASK-388)', () => {
    /*
      FOUND WHILE FIXING THE CHAT CARD, AND LIVE HERE TOO. `isRenderableGrant`
      requires a string `slot` on every element and says nothing about its
      sibling `account` — and `s.account ?? s.slot` only falls back on null and
      undefined, so an object/number/array `account` reached `humanizeId` ->
      `tokenize` -> `.replace(...)` and threw inside render, taking the whole
      surface down through the `ErrorBoundary` exactly as the two holes above
      did.

      "Our producer validates the slots" was the reassurance that hid this: it
      validates ONE FIELD of them. The fallback now lives in
      `lib/grant-shape.ts` so both renderers share it.
    */
    const objectAccount = {
      ...skillReq,
      slots: [{ slot: 'api_key', kind: 'api-key', haveExisting: true, account: {} }],
    } as unknown as PermissionRequest;

    row(objectAccount);

    // The slot is still offered, labelled off its own id — `account` decides
    // how the row READS, so it falls back rather than costing the person a row.
    expect(screen.getByText(/you already saved/)).toBeTruthy();
    expect(screen.queryByText('undefined')).toBeNull();
  });

  test('a real account still labels the slot with its service (TASK-388)', () => {
    // Positive control: the guard must not have flattened every slot to its id.
    row({
      ...skillReq,
      slots: [{ slot: 'api_key', kind: 'api-key', haveExisting: true, account: 'linear' }],
    } as PermissionRequest);

    expect(screen.getByText('Linear')).toBeTruthy();
  });

  test('an empty packages list still draws no packages line', () => {
    // The positive control for the case above: `(x?.length ?? 0) > 0` must not
    // become "packages is present, so say so".
    const emptyPackages = {
      ...skillReq,
      packages: { npm: [], pypi: [] },
    } as unknown as PermissionRequest;

    row(emptyPackages);

    expect(screen.queryByTestId('grant-packages')).toBeNull();
  });
});

describe('a skill grant', () => {
  test('asks in English, and says where the key goes before asking for it', async () => {
    row(skillReq);

    // The id is humanized — `linear-issues` is what the producer calls it, not
    // what a person would.
    expect(screen.getByText('Connect Linear issues')).toBeInTheDocument();
    expect(screen.getByText('File and read Linear issues')).toBeInTheDocument();
    expect(screen.getByText(/it needs to reach:/i)).toBeInTheDocument();
    expect(screen.getByText('api.linear.app')).toBeInTheDocument();
    expect(screen.getByText(KEY_SAFETY)).toBeInTheDocument();
    expect(screen.getByText(GRANT_REASSURANCE)).toBeInTheDocument();
  });

  test('cannot be connected until the key is there, and says why', () => {
    row(skillReq);

    expect(screen.getByRole('button', { name: /^connect$/i })).toBeDisabled();
    expect(screen.getByText(SLOT_HINT)).toBeInTheDocument();
  });

  test('writes the key, then posts the decision, then drops the row', async () => {
    const fetchMock = okFetch();
    const { onResolved } = row(skillReq);

    fireEvent.change(screen.getByLabelText('API key'), {
      target: { value: 'lin_test_123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    await waitFor(() => expect(onResolved).toHaveBeenCalledWith('skill:linear-issues'));

    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toContain('/settings/destinations/skill-slot/credential');
    expect(urls).toContain('/api/chat/permission-decision');

    // base64('lin_test_123') === 'bGluX3Rlc3RfMTIz' — the key is never sent raw.
    const cred = fetchMock.mock.calls.find(
      (c) => c[0] === '/settings/destinations/skill-slot/credential',
    );
    expect(cred?.[1]?.body).toContain('"payloadB64":"bGluX3Rlc3RfMTIz"');

    const decision = fetchMock.mock.calls.find(
      (c) => c[0] === '/api/chat/permission-decision',
    );
    expect(decision?.[1]?.body).toContain('"skillId":"linear-issues"');
    expect(decision?.[1]?.body).toContain('"conversationId":"cnv-1"');
    expect(decision?.[1]?.body).not.toContain('"connectorId"');
    // CSRF: the route is gated on this header, not on a token.
    expect(decision?.[1]?.headers).toMatchObject({ 'x-requested-with': 'ax-admin' });

    // THE PROPERTY THAT MATTERS: the secret went to the vault and nowhere else.
    // Asserting it is in the credential body proves it arrived; only this
    // proves it did not ALSO ride the decision, which is the request that gets
    // logged, replayed and correlated downstream. Both spellings, because
    // "it is base64 so it is fine" is not a thing.
    expect(decision?.[1]?.body).not.toContain('lin_test_123');
    expect(decision?.[1]?.body).not.toContain('bGluX3Rlc3RfMTIz');
  });
});

describe('a connector grant', () => {
  test('is titled by its display name, and posts connectorId, never skillId', async () => {
    const fetchMock = okFetch();
    const { onResolved } = row(connectorReq);

    expect(screen.getByText('Connect Linear')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    await waitFor(() => expect(onResolved).toHaveBeenCalledWith('connector:linear'));
    const decision = fetchMock.mock.calls.find(
      (c) => c[0] === '/api/chat/permission-decision',
    );
    expect(decision?.[1]?.body).toContain('"connectorId":"linear"');
    expect(decision?.[1]?.body).not.toContain('"skillId"');
  });
});

describe('a host grant', () => {
  test('posts to allow-host — NOT to the decision route, which has no host arm', async () => {
    const fetchMock = okFetch();
    const { onResolved } = row(hostReq);

    expect(screen.getByText('Allow access to example.org?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /just this once/i }));

    await waitFor(() => expect(onResolved).toHaveBeenCalledWith('host:example.org'));
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toContain('/api/chat/allow-host');
    expect(urls).not.toContain('/api/chat/permission-decision');
    expect(fetchMock.mock.calls[0]?.[1]?.body).toContain('"persist":false');
    expect(fetchMock.mock.calls[0]?.[1]?.body).toContain('"sessionId":"sess-9"');
  });

  test('"Always for this agent" is the durable answer — it persists', async () => {
    const fetchMock = okFetch();
    row(hostReq);

    fireEvent.click(screen.getByRole('button', { name: /always for this agent/i }));

    await waitFor(() =>
      expect(fetchMock.mock.calls[0]?.[1]?.body).toContain('"persist":true'),
    );
  });

  test('offers all three answers — once, always, and no', () => {
    row(hostReq);

    expect(screen.getByRole('button', { name: /just this once/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /always for this agent/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /not now/i })).toBeInTheDocument();
  });
});

describe('turning a grant down (TASK-444)', () => {
  /*
    THE CLAIM THIS BLOCK REPLACES was "turning a grant down is purely local —
    it drops the row and calls nothing". True of the code, wrong about the
    product. A `skill` or `connector` grant is pending ON THE SERVER:
    `pendingGrantsForUser` enumerates it on every workspace mount, so a refusal
    nobody recorded came straight back on the next reload and re-asked a
    question the person had already answered — and the only way to find that
    out was to reload and see it again.

    A `host` grant keeps the old path, and that is not an oversight. See the
    host case near the bottom of this block.
  */

  test('a skill grant is recorded as declined BEFORE the row goes', async () => {
    const fetchMock = okFetch();
    const { onResolved } = row(skillReq);

    fireEvent.click(screen.getByRole('button', { name: GRANT_REJECT_LABEL }));

    await waitFor(() => expect(onResolved).toHaveBeenCalledWith('skill:linear-issues'));

    const decline = fetchMock.mock.calls.find(
      (c) => c[0] === '/api/workspace/grants/decline',
    );
    expect(decline).toBeDefined();
    expect(decline?.[1]?.method).toBe('POST');
    // The WHOLE body, not a `toContain`: the point of this wire shape is that
    // no storage key crosses it (invariant 1), and only an exact match can say
    // that a `key`, a `prefix` or a client-supplied timestamp is ABSENT.
    expect(JSON.parse(String(decline?.[1]?.body))).toEqual({
      agentId: 'a-quill',
      kind: 'skill',
      subjectId: 'linear-issues',
    });
    // CSRF: this route is gated on the header, like every other workspace write.
    expect(decline?.[1]?.headers).toMatchObject({ 'x-requested-with': 'ax-admin' });
  });

  test('a connector grant declines as a connector, with its connectorId', async () => {
    // Not a duplicate of the case above: `kind` and `subjectId` are both
    // DERIVED from the request, and a version that hardcoded `'skill'` or read
    // `skillId` on every arm passes that test and declines the wrong thing here.
    const fetchMock = okFetch();
    const { onResolved } = row(connectorReq);

    fireEvent.click(screen.getByRole('button', { name: GRANT_REJECT_LABEL }));

    await waitFor(() => expect(onResolved).toHaveBeenCalledWith('connector:linear'));
    const decline = fetchMock.mock.calls.find(
      (c) => c[0] === '/api/workspace/grants/decline',
    );
    expect(JSON.parse(String(decline?.[1]?.body))).toEqual({
      agentId: 'a-quill',
      kind: 'connector',
      subjectId: 'linear',
    });
  });

  test('a decline the server never heard leaves the row where it was', async () => {
    /*
      503 is the answer when there is nowhere durable to write the refusal —
      and it is exactly the case where dropping the row would be a lie, because
      that grant is coming back on the next mount. So the row stays and says
      so. Resolving silently here would be the same false promise this card is
      about, one layer down.
    */
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));
    const { onResolved } = row(skillReq);

    fireEvent.click(screen.getByRole('button', { name: GRANT_REJECT_LABEL }));

    expect(await screen.findByText(HTTP_UNAVAILABLE)).toBeInTheDocument();
    expect(onResolved).not.toHaveBeenCalled();
    expect(screen.getByTestId('grant-skill:linear-issues')).toBeInTheDocument();
    // Still answerable — the way out came back rather than staying disabled.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: GRANT_REJECT_LABEL })).toBeEnabled(),
    );
    // No status code and no route name on screen.
    expect(screen.queryByText(/503/)).not.toBeInTheDocument();
    expect(screen.queryByText(/grants\/decline/)).not.toBeInTheDocument();
  });

  test('the half-typed key is gone the moment the decline lands', async () => {
    okFetch();
    const { onResolved } = row(skillReq);

    fireEvent.change(screen.getByLabelText('API key'), {
      target: { value: 'lin_partial' },
    });
    fireEvent.click(screen.getByRole('button', { name: GRANT_REJECT_LABEL }));

    // BOTH halves, because they are two different stores and only one of them
    // used to be cleared: `workspace-grant-drafts.ts` outlives the component
    // (TASK-389), and `values` is what THIS render is painting. A row that
    // clears the draft and goes on showing the secret has withdrawn nothing.
    expect(getGrantDraft(grantKey(skillReq))).toEqual({});
    expect(screen.getByLabelText('API key')).toHaveValue('');
    await waitFor(() => expect(onResolved).toHaveBeenCalled());
  });

  test('the half-typed key is gone even when the decline FAILS', async () => {
    // The person's intent is withdrawal. Whether we managed to tell the server
    // is our problem, not a reason to leave their key on screen — so the clear
    // is unconditional, and happens before the POST is even attempted.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));
    row(skillReq);

    fireEvent.change(screen.getByLabelText('API key'), {
      target: { value: 'lin_partial' },
    });
    fireEvent.click(screen.getByRole('button', { name: GRANT_REJECT_LABEL }));

    expect(getGrantDraft(grantKey(skillReq))).toEqual({});
    expect(screen.getByLabelText('API key')).toHaveValue('');
    expect(await screen.findByText(HTTP_UNAVAILABLE)).toBeInTheDocument();
  });

  test('a host grant stays purely local — nothing is sent, the row goes at once', () => {
    /*
      THE ARM THAT MUST NOT CHANGE, which is why this is a case of its own and
      not "the old test, kept". A host wall is turn-scoped and
      `chunk-buffer.ts`'s `pendingGrantsForUser` deliberately never enumerates
      it, so this refusal cannot come back on a reload — there is nothing to
      suppress. Recording it would be worse than useless: a later session that
      hits the same wall is a genuinely NEW need, and an old "not now" would
      answer it in the person's absence.

      So the obvious over-fix — make every "Not now" durable — fails here.
    */
    const fetchMock = okFetch();
    const { onResolved } = row(hostReq);

    fireEvent.click(screen.getByRole('button', { name: GRANT_REJECT_LABEL }));

    expect(onResolved).toHaveBeenCalledWith('host:example.org');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('the skill arm says what "Not now" actually means', () => {
    // "Not now" reads as permanent and it is not. The hint is what makes the
    // label honest — without it the copy promises a dismissal while the code
    // delivers a deferral.
    row(skillReq);

    expect(screen.getByText(GRANT_REJECT_HINT)).toBeInTheDocument();
  });

  test('the host arm says it too — it is true of both', () => {
    // A host "Not now" also only comes back when the agent hits that wall
    // again. Same sentence, different reason.
    row(hostReq);

    expect(screen.getByText(GRANT_REJECT_HINT)).toBeInTheDocument();
  });
});

describe('when the POST fails', () => {
  test('the row stays, says a sentence, and never shows the status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }));
    const { onResolved } = row(hostReq);

    fireEvent.click(screen.getByRole('button', { name: /just this once/i }));

    expect(await screen.findByText(HTTP_SERVER_ERROR)).toBeInTheDocument();
    // Not cleared: a silent clear would read as "granted" for something that
    // was not.
    expect(onResolved).not.toHaveBeenCalled();
    // The row is still answerable — the button came back.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /just this once/i })).toBeEnabled(),
    );
    // No status code, no route name, no reason code on screen.
    expect(screen.queryByText(/500/)).not.toBeInTheDocument();
    expect(screen.queryByText(/allow-host/)).not.toBeInTheDocument();
  });

  test('a failed credential write does not go on to grant the capability', async () => {
    // The key write is first. If it fails, the decision POST must not run —
    // otherwise the grant lands with no key behind it and the agent fails later
    // for a reason nobody can trace back to here.
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 500 }));
    const { onResolved } = row(skillReq);

    fireEvent.change(screen.getByLabelText('API key'), {
      target: { value: 'lin_test_123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    await screen.findByText(HTTP_SERVER_ERROR);
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).not.toContain('/api/chat/permission-decision');
    expect(onResolved).not.toHaveBeenCalled();
  });
});

describe('without a conversation', () => {
  test('the connect button is disabled, and says why', () => {
    // A SLOTLESS request on purpose. Using the skill fixture here proved
    // nothing: its unfilled `api_key` slot disables Connect on its own, so the
    // test passed with the conversation guard deleted. The connector fixture
    // has no slots, so the only thing that can disable this button is the
    // missing conversation.
    row(connectorReq, null);

    expect(screen.getByRole('button', { name: /^connect$/i })).toBeDisabled();
    // And it is not a dead control: the one disabled state a person cannot fix
    // by typing is the one that most needs a sentence.
    expect(screen.getByText(GRANT_NO_CONVERSATION)).toBeInTheDocument();
  });

  test('a filled slot is not enough on its own', () => {
    // The other half of the same guard: fill the key, still no conversation.
    row(skillReq, null);
    fireEvent.change(screen.getByLabelText('API key'), {
      target: { value: 'lin_test_123' },
    });

    expect(screen.getByRole('button', { name: /^connect$/i })).toBeDisabled();
    expect(screen.getByText(GRANT_NO_CONVERSATION)).toBeInTheDocument();
  });
});

describe('a half-typed value surviving the row leaving and re-entering the thread (TASK-389)', () => {
  /*
    THIS IS THE CORE ACCEPTANCE TEST, and it FAILS against pre-fix code: `values`
    was `useState<Record<string,string>>({})`, seeded fresh on every mount, so a
    row that unmounts (tab switch, route change — see `workspace-grant-drafts.ts`
    and TASK-389's plan for which of the card's three named paths actually
    reproduce) and remounts starts blank. Simulated here as unmount + a FRESH
    `GrantRow` instance for the same grant key, which is exactly what both real
    render sites (`TodayView`, `AgentConversation`) do: they don't keep the old
    component around, they stop rendering it and later render a brand new one.
  */
  test('a partially-typed key survives unmount and remount', () => {
    const { unmount } = render(
      <GrantRow
        grant={{ key: grantKey(skillReq), request: skillReq, conversationId: 'cnv-1', agentId: 'a-quill' }}
        onResolved={vi.fn()}
        onGranted={vi.fn(async () => true)}
      />,
    );

    fireEvent.change(screen.getByLabelText('API key'), {
      target: { value: 'lin_partial' },
    });
    expect(screen.getByLabelText('API key')).toHaveValue('lin_partial');

    unmount();

    render(
      <GrantRow
        grant={{ key: grantKey(skillReq), request: skillReq, conversationId: 'cnv-1', agentId: 'a-quill' }}
        onResolved={vi.fn()}
        onGranted={vi.fn(async () => true)}
      />,
    );

    expect(screen.getByLabelText('API key')).toHaveValue('lin_partial');
  });

  test('approving the grant clears the draft — a stale secret does not outlive its prompt', async () => {
    okFetch();
    row(skillReq);

    fireEvent.change(screen.getByLabelText('API key'), {
      target: { value: 'lin_partial' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    // The clear happens after the PERMISSION-DECISION post, not the earlier
    // credential write `okFetch` also satisfies — wait on the draft itself
    // rather than an intermediate fetch call, so this doesn't depend on
    // exactly which microtask ordering resolves first.
    await waitFor(() => expect(getGrantDraft(grantKey(skillReq))).toEqual({}));
  });

  test('turning the grant down clears the draft too', async () => {
    // `okFetch` because turning a skill grant down now POSTs the decline
    // (TASK-444). The clear itself is still SYNCHRONOUS — it happens before
    // the request, on purpose — so the assertion below is unchanged; the await
    // only lets the request this click started finish inside the test.
    const fetchMock = okFetch();
    row(skillReq);

    fireEvent.change(screen.getByLabelText('API key'), {
      target: { value: 'lin_partial' },
    });
    fireEvent.click(screen.getByRole('button', { name: /not now/i }));

    expect(getGrantDraft(grantKey(skillReq))).toEqual({});
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });
});
