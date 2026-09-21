/**
 * The chat permission card (TASK-388).
 *
 * TASK-351 (PR #557) found and fixed two unguarded `.length` reads on the
 * SAME `PermissionRequest` shape in the workspace's `GrantRow` — a missing
 * `description` and a half-filled `packages` object both threw
 * `TypeError: Cannot read properties of undefined (reading 'length')`. That
 * card's producer (`isRenderableGrant`) deliberately leaves both fields out
 * of its shape guard: they decide how the card READS, not whether the grant
 * can be ANSWERED, so the fix belongs at the render site, not the guard.
 *
 * `PermissionCard.tsx` renders the exact same union with the exact same two
 * reads and — per this card's brief — NO shape guard on its producer at all
 * (`transport.ts` only truthiness-checks the frame). This file pins the same
 * two render-site fallbacks here, mirroring
 * `workspace/__tests__/GrantRow.test.tsx`.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PermissionCard } from '../PermissionCard';
import {
  permissionCardActions,
  type PermissionRequest,
} from '@/lib/permission-card-store';
import { setActiveConversationId } from '@/lib/use-conversation-id';
import { GRANT_REASSURANCE, KEY_SAFETY, REACH_LEAD_IN, SLOT_HINT } from '@/lib/grant-copy';

const skillReq: PermissionRequest = {
  kind: 'skill',
  skillId: 'linear-issues',
  description: 'File and read Linear issues',
  hosts: ['api.linear.app'],
  slots: [{ slot: 'api_key', kind: 'api-key', haveExisting: true }],
};

const connectorReq: PermissionRequest = {
  kind: 'connector',
  connectorId: 'linear',
  name: 'Linear',
  hosts: ['api.linear.app'],
  slots: [],
};

function show(request: PermissionRequest) {
  setActiveConversationId('cnv-1');
  permissionCardActions.show(request);
  render(<PermissionCard />);
}

afterEach(() => {
  permissionCardActions.reset();
  setActiveConversationId(null);
  vi.restoreAllMocks();
});

describe('a payload the producer lets through with no shape guard at all', () => {
  test('a skill with no description renders an answerable card, not a crash', () => {
    // `haveExisting: true` so Connect is genuinely enabled — the claim being
    // pinned is that the card is still answerable, not merely that some
    // unrelated disabled button happens not to throw.
    const noDescription = {
      kind: 'skill',
      skillId: 'linear-issues',
      hosts: ['api.linear.app'],
      slots: [{ slot: 'api_key', kind: 'api-key', haveExisting: true }],
    } as unknown as PermissionRequest;

    show(noDescription);

    expect(screen.getByText('Connect Linear issues')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^connect$/i })).toBeEnabled();
    expect(screen.getByText(GRANT_REASSURANCE)).toBeTruthy();
    // Not merely "did not throw" — `String(request.description)` would also
    // survive and print the word "undefined" at the person.
    expect(screen.queryByText('undefined')).toBeNull();
  });

  test('a non-string description is dropped rather than rendered', () => {
    // `{ length: 5 }` is the shape that separates a `typeof` guard from a
    // bare `?? ''`: `?? ''` lets it through (it is not nullish), `.length > 0`
    // is then true, and React throws on an object child.
    const objectDescription = {
      ...skillReq,
      description: { length: 5 },
    } as unknown as PermissionRequest;

    show(objectDescription);

    expect(screen.getByText('Connect Linear issues')).toBeTruthy();
    expect(screen.queryByText('undefined')).toBeNull();
  });

  test('a half-filled packages list renders the card instead of throwing', () => {
    // `npm` and `pypi` are both required when `packages` is present, so this
    // is off-type — which is exactly why only the wire can produce it.
    const halfPackages = {
      ...skillReq,
      packages: { pypi: ['requests'] },
    } as unknown as PermissionRequest;

    show(halfPackages);

    expect(screen.getByText('Connect Linear issues')).toBeTruthy();
    // The list that IS there still counts — the line appears rather than
    // being silently dropped along with the crash.
    expect(screen.getByTestId('permission-packages')).toBeTruthy();
  });

  test('a packages list with npm present and pypi absent renders too', () => {
    // THE OTHER DIRECTION — genuinely unpinned by the case above. `{ pypi:
    // [...] }` short-circuits the `||` on its first operand, so deleting the
    // `pypi?.` guard alone would leave this whole suite green. `{ npm: [] }`
    // reaches the second operand (`npm.length > 0` is false), where `pypi`
    // is missing. Two guards need two fixtures.
    const npmOnly = {
      ...skillReq,
      packages: { npm: [] },
    } as unknown as PermissionRequest;

    show(npmOnly);

    expect(screen.getByText('Connect Linear issues')).toBeTruthy();
    expect(screen.queryByTestId('permission-packages')).toBeNull();
  });

  test('an empty packages list still draws no packages line', () => {
    // Positive control: `(x?.length ?? 0) > 0` must not become "packages is
    // present, so say so".
    const emptyPackages = {
      ...skillReq,
      packages: { npm: [], pypi: [] },
    } as unknown as PermissionRequest;

    show(emptyPackages);

    expect(screen.queryByTestId('permission-packages')).toBeNull();
  });

  test('a real description and a full packages list still render normally', () => {
    // The positive control for both fixes together: the fallbacks must not
    // have swallowed real data.
    show({
      ...skillReq,
      packages: { npm: ['left-pad'], pypi: [] },
    });

    expect(screen.getByText('File and read Linear issues')).toBeTruthy();
    expect(screen.getByTestId('permission-packages')).toBeTruthy();
  });

  /*
    THE FINDING FROM THE FIRST REVIEW ROUND. `description`/`packages` were
    not the only unguarded reads on this frame — `hosts`, `slots`, `skillId`
    and a connector's `name` are all read with no fallback either, and this
    producer validates none of them (unlike the workspace's `GrantRow`,
    where `isRenderableGrant` requires `skillId`/`connectorId` plus iterable
    `hosts`/`slots` before a row is ever created). Missing `hosts`/`slots`
    threw inside `renderReach`; a missing `skillId` threw inside
    `humanizeId` (`id.replace(...)` on `undefined`); a missing `slots` also
    threw earlier still, inside `allSlotsFilled`'s `.every`, before the card
    even reached JSX.
  */
  test('a skill with no hosts, slots, or id renders an answerable card, not a crash', () => {
    const bareMinimum = { kind: 'skill' } as unknown as PermissionRequest;

    show(bareMinimum);

    // No id to humanize -> plain English, not "Connect undefined" and not a
    // crash. No slots -> nothing to fill -> Connect is enabled.
    expect(screen.getByText('Connect this skill')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^connect$/i })).toBeEnabled();
    expect(screen.queryByText('undefined')).toBeNull();
  });

  test('a connector with no name or id renders an answerable card, not a crash', () => {
    const bareMinimum = { kind: 'connector' } as unknown as PermissionRequest;

    show(bareMinimum);

    expect(screen.getByText('Connect this connector')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^connect$/i })).toBeEnabled();
    expect(screen.queryByText(/undefined/)).toBeNull();
  });

  test('a connector with no name falls back to its humanized id, not "Connect undefined"', () => {
    // `name` absent but `connectorId` present is the case #557's own
    // review round found live on `GrantRow` — mirrored here since this
    // producer offers no more protection for `name` than that one did.
    const nameless = {
      kind: 'connector',
      connectorId: 'linear',
      hosts: ['api.linear.app'],
      slots: [],
    } as unknown as PermissionRequest;

    show(nameless);

    expect(screen.getByText('Connect Linear')).toBeTruthy();
    expect(screen.queryByText(/undefined/)).toBeNull();
  });

  test('an empty-string connector name falls back the same way', () => {
    const blankName = { ...connectorReq, name: '   ' } as unknown as PermissionRequest;

    show(blankName);

    expect(screen.getByText('Connect Linear')).toBeTruthy();
  });

  test('a real connector name still wins over the fallback', () => {
    show({ ...connectorReq, name: 'Linear Issues' });

    expect(screen.getByText('Connect Linear Issues')).toBeTruthy();
  });

  /*
    THE FINDING FROM THE SECOND REVIEW ROUND, one level deeper than the first.
    Guarding the slots ARRAY left each slot ELEMENT's `slot` id unguarded, and
    `humanizeId(s.account ?? s.slot)` / `humanizeSlotLabel(s.slot, ...)` reach
    `tokenize(undefined)` -> `undefined.replace(...)` -> `TypeError` inside
    render. This is the level at which porting `GrantRow`'s render-site fix is
    provably NOT enough on its own: `GrantRow` reads `s.slot` unguarded too and
    is safe only because `isRenderableGrant` -> `hasIterableReach` requires a
    string `slot` on every element before a row exists. This producer requires
    nothing.
  */
  test('a slot with no id is dropped rather than crashing the card', () => {
    const idlessSlot = {
      kind: 'skill',
      skillId: 'linear-issues',
      hosts: [],
      slots: [{ kind: 'api-key' }],
    } as unknown as PermissionRequest;

    show(idlessSlot);

    expect(screen.getByText('Connect Linear issues')).toBeTruthy();
    // No field to fill, so the card must be ANSWERABLE — this is the half of
    // the fix that filtering only the renderer would get wrong: `allSlotsFilled`
    // would still count the invisible slot and disable Connect forever behind a
    // hint pointing at no field.
    expect(screen.getByRole('button', { name: /^connect$/i })).toBeEnabled();
    expect(screen.queryByText(SLOT_HINT)).toBeNull();
    expect(screen.queryByText(KEY_SAFETY)).toBeNull();
  });

  test('an id-less haveExisting slot is dropped too', () => {
    // The OTHER arm of the `slots.map` ternary, and it crashes on a different
    // line (`humanizeId(s.account ?? s.slot)` in the Badge). One fixture per
    // branch — the input-branch case above never reaches this code.
    const idlessExisting = {
      ...skillReq,
      slots: [{ kind: 'api-key', haveExisting: true }],
    } as unknown as PermissionRequest;

    show(idlessExisting);

    expect(screen.getByText('Connect Linear issues')).toBeTruthy();
    expect(screen.queryByText(/you already saved/)).toBeNull();
  });

  test('a real slot alongside an id-less one still renders and still gates Connect', () => {
    // The positive control, and the one that proves the filter is a FILTER and
    // not a "give up on slots entirely": the good slot keeps its field, and
    // Connect stays disabled until it is filled.
    const mixed = {
      ...skillReq,
      slots: [{ kind: 'api-key' }, { slot: 'api_key', kind: 'api-key' }],
    } as unknown as PermissionRequest;

    show(mixed);

    expect(screen.getByLabelText(/api key/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^connect$/i })).toBeDisabled();
    expect(screen.getByText(SLOT_HINT)).toBeTruthy();
  });

  test('a host grant with no host names the site in English, not "undefined"', () => {
    const hostless = { kind: 'host', sessionId: 'sess-9' } as unknown as PermissionRequest;

    show(hostless);

    expect(screen.getByText('Allow access to this site?')).toBeTruthy();
    expect(screen.queryByText(/undefined/)).toBeNull();
  });

  test('an object-typed host does not crash the host card', () => {
    // An absent `host` degrades on its own (React drops the child), so THIS is
    // the fixture that separates the guard from no guard: React throws
    // "Objects are not valid as a React child" on an object.
    const objectHost = {
      kind: 'host',
      sessionId: 'sess-9',
      host: { hostname: 'example.org' },
    } as unknown as PermissionRequest;

    show(objectHost);

    expect(screen.getByText('Allow access to this site?')).toBeTruthy();
  });

  test('a real host still wins over the fallback', () => {
    show({ kind: 'host', host: 'example.org', sessionId: 'sess-9' });

    expect(screen.getByText('Allow access to example.org?')).toBeTruthy();
  });

  /*
    THE FINDING FROM THE THIRD REVIEW ROUND, and the reason this block keeps
    growing: each round's guard covered the field it was looking at and left
    its NEIGHBOUR on the same throw path. `usableSlots` vouches for `s.slot`
    and says nothing about `s.account`, which `s.account ?? s.slot` then hands
    to `humanizeId` — and `??` only falls back on null/undefined, so every
    other wrong type goes straight through to `tokenize(...).replace`. Same
    story for `hosts`: `?? []` catches an absent list and not a string one
    (truthy `.length`, no `.map`) nor a list with a non-string in it.
  */
  test('a non-string account on a haveExisting slot does not crash the card', () => {
    const objectAccount = {
      ...skillReq,
      slots: [{ slot: 'api_key', kind: 'api-key', haveExisting: true, account: {} }],
    } as unknown as PermissionRequest;

    show(objectAccount);

    // The slot is still OFFERED — `account` is a label detail, so it falls
    // back to the slot id rather than costing the person the row.
    expect(screen.getByText(/you already saved/)).toBeTruthy();
    expect(screen.queryByText('undefined')).toBeNull();
  });

  test('an array account on an input slot does not crash the card', () => {
    // The OTHER branch, and a different throw: `humanizeSlotLabel` only
    // reaches `tokenize(service)` when the service is non-empty, so an array
    // gets there where a number would have been stringified earlier.
    const arrayAccount = {
      ...skillReq,
      slots: [{ slot: 'api_key', kind: 'api-key', account: ['linear'] }],
    } as unknown as PermissionRequest;

    show(arrayAccount);

    expect(screen.getByLabelText(/api key/i)).toBeTruthy();
  });

  test('a blank account falls back to the slot id rather than an empty badge', () => {
    const blankAccount = {
      ...skillReq,
      slots: [{ slot: 'api_key', kind: 'api-key', haveExisting: true, account: '   ' }],
    } as unknown as PermissionRequest;

    show(blankAccount);

    // `humanizeId('api_key')` — the slot id, humanized — rather than the empty
    // badge a bare `?? ` fallback would have left behind.
    expect(screen.getByText('API key')).toBeTruthy();
  });

  test('a real account still labels the slot with its service', () => {
    // Positive control for all three above: the guard must not have flattened
    // every slot down to its raw id.
    show({
      ...skillReq,
      slots: [{ slot: 'api_key', kind: 'api-key', haveExisting: true, account: 'linear' }],
    });

    expect(screen.getByText('Linear')).toBeTruthy();
  });

  test('a string-typed hosts list does not crash the card', () => {
    // `"api.linear.app".length` is truthy, so `?? []` passes it through and
    // `.map` is not a function.
    const stringHosts = {
      ...skillReq,
      hosts: 'api.linear.app',
    } as unknown as PermissionRequest;

    show(stringHosts);

    expect(screen.getByText('Connect Linear issues')).toBeTruthy();
    // Nothing legible to list, so the reach line is dropped rather than
    // rendering the string character by character as badges.
    expect(screen.queryByText(REACH_LEAD_IN)).toBeNull();
  });

  test('a hosts list carrying a non-string drops that entry and keeps the rest', () => {
    const mixedHosts = {
      ...skillReq,
      hosts: ['api.linear.app', { hostname: 'evil.example' }],
    } as unknown as PermissionRequest;

    show(mixedHosts);

    expect(screen.getByText(REACH_LEAD_IN)).toBeTruthy();
    expect(screen.getByText('api.linear.app')).toBeTruthy();
    expect(screen.queryByText(/evil.example/)).toBeNull();
  });
});

describe('invalid caller-id credential floor', () => {
  test.each(['skill', 'connector'] as const)('keeps a malformed %s request local', async (kind) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const slots = [{ slot: 'api_key', kind: 'api-key' as const }];
    const request = (kind === 'skill'
      ? { ...skillReq, skillId: {}, slots }
      : { ...connectorReq, connectorId: {}, slots }) as unknown as PermissionRequest;
    show(request);
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'test-only-key' } });
    const connect = screen.getByRole('button', { name: /^connect$/i });
    expect(connect).toBeEnabled();
    fireEvent.click(connect);
    const error = await screen.findByRole('alert');
    expect(error.textContent?.trim()).not.toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^connect$/i })).toBeEnabled();
  });
});
