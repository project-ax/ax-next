/**
 * What a grant card can actually DRAW from a `PermissionRequest` off the wire
 * (TASK-388).
 *
 * Both grant renderers — chat's `PermissionCard.tsx` and the workspace's
 * `workspace/GrantRow.tsx` — iterate the same `hosts`/`slots` reach and read
 * the same per-slot fields. They do NOT get the same protection:
 *
 *   - The workspace's producer validates first (`isRenderableGrant` ->
 *     `hasIterableReach` in `workspace-grant-store.ts`): `hosts` must be an
 *     array of strings and `slots` an array of objects with a string `slot`.
 *   - Chat's producer (`lib/transport.ts`) truthiness-checks the frame and
 *     validates nothing at all.
 *
 * So the two surfaces need different amounts of help, but they need the SAME
 * ANSWERS — "is this host drawable?", "is this slot fillable?", "is this
 * account tag usable?" — which is why those answers live here rather than
 * being written twice. Same reasoning, and the same TASK-360 deadline, as
 * `grant-copy.ts` and `grant-destinations.ts`: chat's card is deleted, the
 * workspace's row is not, so the shared half has to outlive it.
 *
 * The rule these all follow is TASK-351/#557's: COALESCE OR DROP THE FIELD,
 * NEVER REFUSE THE CARD. A grant nobody can answer is a worse outcome than a
 * grant that reads a bit plainer, because the second one still gets asked.
 *
 * Deliberately self-contained — no relative imports — so it stays safe to pull
 * from either tree (and from the host, which needs `.js` specifiers on
 * relative imports; there are none to get wrong here).
 */

/**
 * The hosts a reach list can actually render as badges.
 *
 * `?? []` is not enough on the chat side: `hosts` typed `string[]` can arrive
 * as a bare string, whose `.length` is truthy and whose `.map` does not exist
 * (`TypeError: hosts.map is not a function`), or as an array carrying a
 * non-string element, which React then refuses as a child ("Objects are not
 * valid as a React child"). Both throw inside render, where the surface's
 * `ErrorBoundary` turns one bad grant into a blank conversation.
 */
export function usableHosts(hosts: unknown): string[] {
  if (!Array.isArray(hosts)) return [];
  return hosts.filter((h): h is string => typeof h === 'string' && h.trim().length > 0);
}

/**
 * The slots a card can actually draw a field for.
 *
 * Every vault destination is derived from the slot id, and the input is keyed
 * by it — so a slot without one cannot be labelled, filled, or written
 * anywhere meaningful, and `humanizeId`/`humanizeSlotLabel` throw on it
 * (`tokenize(undefined)` -> `undefined.replace(...)`).
 *
 * Dropping it rather than coalescing to `''` is deliberate: an empty slot id
 * would render a nameless password field whose value gets written to a vault
 * row derived from an empty id. Asking for a secret on behalf of nothing is
 * worse than not asking.
 *
 * Callers MUST use this one list everywhere — renderer, the "can Connect be
 * pressed yet" gate, and the submit handlers. Filtering only the renderer
 * leaves the gate counting a slot nobody can see, which disables Connect
 * forever behind a hint pointing at no field: an unanswerable card, the exact
 * failure this module exists to prevent.
 */
export function usableSlots<S extends { slot: string }>(slots: readonly S[] | undefined): S[] {
  if (!Array.isArray(slots)) return [];
  return slots.filter(
    (s) =>
      typeof s === 'object' && s !== null && typeof s.slot === 'string' && s.slot.trim().length > 0,
  );
}

/**
 * The slot's service tag, if it is one we can put in front of a person.
 *
 * `account` is optional and legitimately absent, so this COALESCES where
 * `usableSlots` drops: absent means "no service prefix", which both renderers
 * already handle. What neither handled is a present-but-not-a-string one —
 * `humanizeId(s.account ?? s.slot)` only falls back on null/undefined, so a
 * number, boolean, object or array sails through to `tokenize` and throws.
 * A blank string counts as absent for the same reason it does everywhere else
 * in this file: it renders as an empty badge, which tells the reader nothing.
 *
 * This one is shared for a concrete reason, not symmetry: the workspace's
 * producer validates `slot` but NOT `account`, so `GrantRow` had the identical
 * hole with no guard in front of it either.
 */
export function slotAccount(s: { account?: string }): string | undefined {
  return typeof s.account === 'string' && s.account.trim().length > 0 ? s.account : undefined;
}
