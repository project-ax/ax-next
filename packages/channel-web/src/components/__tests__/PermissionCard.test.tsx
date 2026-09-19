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
import { render, screen } from '@testing-library/react';
import { PermissionCard } from '../PermissionCard';
import {
  permissionCardActions,
  type PermissionRequest,
} from '@/lib/permission-card-store';
import { setActiveConversationId } from '@/lib/use-conversation-id';
import { GRANT_REASSURANCE } from '@/lib/grant-copy';

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
});
